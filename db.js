// db.js — CRM+ data layer: schema, connection, settings.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_PACKAGED, userDataDir } from './packaging.js';

// Empty once bundled to CommonJS for the packaged build; that path never needs
// it, because a packaged database lives in the user data directory instead.
const HERE = import.meta.url ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
// Packaged: each user's database lives in their own OS data directory, because
// the executable itself may sit somewhere read-only. Source checkout: data/.
// CRM_PLUS_DB_PATH overrides both (useful for a second workspace or a test copy).
export const DEFAULT_DB_PATH = process.env.CRM_PLUS_DB_PATH
  || (IS_PACKAGED ? join(userDataDir(), 'crm.db') : join(HERE, 'data', 'crm.db'));

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT,
  kind TEXT NOT NULL DEFAULT 'startup',      -- startup|fund|corporate|other
  sector TEXT DEFAULT '',
  stage TEXT DEFAULT '',                     -- ''|pre-seed|seed|series-a|series-b|growth|public
  geography TEXT DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  linkedin_url TEXT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  title TEXT DEFAULT '',
  seniority TEXT NOT NULL DEFAULT 'IC',      -- IC|MGR|DIR|VP|C|FOUNDER|PARTNER|ANGEL|OTHER
  dept TEXT DEFAULT '',                      -- eng|product|gtm|invest|ops|research|other
  location TEXT DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT DEFAULT '',
  is_me INTEGER NOT NULL DEFAULT 0,
  -- roster  = someone you deliberately added or confirmed: your working set.
  -- network = bulk-imported background: searchable and available to the
  --           suggestion engine, without crowding the daily screens.
  -- Deliberate has to be stated, not derived: a status computed from warmth or
  -- fit would silently drop someone the moment their score decayed.
  status TEXT NOT NULL DEFAULT 'roster',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- email|call|meeting|message|event|intro|linkedin
  direction TEXT NOT NULL DEFAULT 'outbound',-- inbound|outbound
  summary TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  dst_person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  rel_type TEXT NOT NULL,                    -- keys of path.base_p
  strength TEXT NOT NULL DEFAULT 'medium',   -- weak|medium|strong
  notes TEXT DEFAULT '',
  UNIQUE(src_person, dst_person, rel_type)
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'sourced',     -- sourced|contacted|meeting|diligence|referred|won|passed
  priority INTEGER NOT NULL DEFAULT 3,       -- 1..5 conviction
  source TEXT DEFAULT '',
  next_step TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS icp_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '[]',
  created_at TEXT
);
-- Ground truth for the prospect scorer, produced as a by-product of triage:
-- "Add to roster" is a 1, "Not ICP" is a 0. Labels must come from the user,
-- never from the model, or measuring the model against them proves nothing.
CREATE TABLE IF NOT EXISTS icp_labels (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  label INTEGER NOT NULL,                    -- 1 = ICP, 0 = not
  score_at_label REAL,                       -- what the model said at the time
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS failed_intros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_person INTEGER NOT NULL,
  dst_person INTEGER NOT NULL,
  created_at TEXT
);
`;

export const DEFAULT_SETTINGS = {
  warmth: {
    coefficients: { a1_recency: 2.2, a2_frequency: 0.9, a3_reciprocity: 1.4,
                    a4_seniority_touch: 0.8, a5_channel_diversity: 0.7, bias: -2.5 },
    half_life_days: 30,
    seniority_weights: { IC: 0.2, MGR: 0.4, DIR: 0.6, VP: 0.8, C: 1.0,
                         FOUNDER: 1.0, PARTNER: 1.0, ANGEL: 0.8, OTHER: 0.2 }
  },
  path: {
    base_p: { family: 0.9, close_friend: 0.85, worked_with: 0.75, advises: 0.7,
              coinvestor: 0.7, invested_in: 0.65, studied_with: 0.6,
              introduced: 0.55, colleague: 0.5, knows: 0.45 },
    strength_factor: { weak: 0.7, medium: 1.0, strong: 1.2 },
    seniority_gap_penalty: 0.06,
    p_min: 0.05, p_max: 0.95,
    warm_tau: 0.35,
    k_paths: 3, max_hops: 5,
    epsilon_failed: 0.01, blast_radius_alpha: 0.5,
    colleague_company_cap: 25
  },
  actions: {
    follow_up_message:   { hours: 0.25 },
    news_congrats_note:  { hours: 0.25 },
    intro_request:       { hours: 0.5  },
    monthly_checkin:     { hours: 0.5  },
    coffee_chat:         { hours: 1.5  },
    deep_dive_call:      { hours: 1.0  },
    attend_their_event:  { hours: 3.0  },
    diligence_memo:      { hours: 4.0  }
  },
  uplifts: {
    default: 0.01,
    table: {
      follow_up_message:  { cold: { low: 0.03, mid: 0.04, high: 0.05 }, warm: { low: 0.02, mid: 0.03, high: 0.03 }, hot: { low: 0.01, mid: 0.01, high: 0.01 } },
      news_congrats_note: { cold: { low: 0.02, mid: 0.03, high: 0.03 }, warm: { low: 0.02, mid: 0.02, high: 0.03 }, hot: { low: 0.01, mid: 0.01, high: 0.01 } },
      intro_request:      { cold: { low: 0.01, mid: 0.01, high: 0.01 }, warm: { low: 0.03, mid: 0.04, high: 0.05 }, hot: { low: 0.05, mid: 0.06, high: 0.08 } },
      monthly_checkin:    { cold: { low: 0.03, mid: 0.04, high: 0.05 }, warm: { low: 0.02, mid: 0.03, high: 0.04 }, hot: { low: 0.01, mid: 0.01, high: 0.02 } },
      coffee_chat:        { cold: { low: 0.04, mid: 0.05, high: 0.06 }, warm: { low: 0.05, mid: 0.06, high: 0.07 }, hot: { low: 0.02, mid: 0.03, high: 0.04 } },
      deep_dive_call:     { cold: { low: -0.02, mid: -0.01, high: -0.01 }, warm: { low: 0.04, mid: 0.05, high: 0.07 }, hot: { low: 0.05, mid: 0.06, high: 0.08 } },
      attend_their_event: { cold: { low: 0.02, mid: 0.03, high: 0.04 }, warm: { low: 0.03, mid: 0.04, high: 0.06 }, hot: { low: 0.02, mid: 0.03, high: 0.05 } },
      diligence_memo:     { cold: { low: -0.03, mid: -0.02, high: 0.0 }, warm: { low: 0.02, mid: 0.04, high: 0.06 }, hot: { low: 0.04, mid: 0.06, high: 0.09 } }
    },
    buckets: { warmth: { cold: 0.35, warm: 0.70 } }
  },
  cadence: { sourced: 21, contacted: 10, meeting: 7, diligence: 4, referred: 14 },
  // Follow-up reminders include previously contacted people whose warmth has
  // decayed. A logged touch is required; untouched imports are excluded.
  quiet: { target_days: 45, min_warmth: 0.15 },
  plan: { weekly_hours: 6 },

  // Optional title-based starter profile for the network suggestions view.
  // These are editable heuristics, not probabilities or a measure of a person.
  // No employer, school, sector, geography, or exclusion preferences ship.
  icp_scoring: {
    version: 6,
    company_requires_role: true,
    company_role_min_points: 40,
    max_points: 100,
    // First matching band wins, so order matters: most specific first.
    roles: [
      { label: 'Founder', points: 55, class: 'founder',
        match: ['founder', 'co founder', 'cofounder', 'founding', 'fondateur', 'cofondateur', 'founder ceo', 'ceo founder'],
        exclude: ['founding member', 'aspiring', 'future founder', 'wannabe'] },
      { label: 'CEO or owner', points: 46, class: 'founder',
        match: ['ceo', 'chief executive', 'directeur general', 'owner', 'gerant'],
        exclude: ['vice president', 'vice presidente', 'deputy', 'assistant', 'adjoint', 'former', 'ex ceo'] },
      { label: 'Technical leader', points: 40, class: 'builder',
        match: ['cto', 'chief technology', 'chief technical', 'vp engineering', 'head of engineering', 'chief scientist', 'chief architect'] },
      { label: 'Other C-level', points: 26, class: 'builder',
        match: ['cpo', 'coo', 'cfo', 'cmo', 'ciso', 'cro', 'chief product', 'chief operating', 'chief financial', 'chief marketing', 'chief revenue', 'chief data'] },
      { label: 'Head or VP', points: 18, class: 'builder',
        match: ['vp', 'vice president', 'head of', 'lead', 'principal engineer', 'staff engineer'] },
      { label: 'Builder', points: 12, class: 'builder',
        match: ['engineer', 'developer', 'developpeur', 'ingenieur', 'scientist', 'researcher', 'chercheur', 'product manager', 'designer'] },
      { label: 'Student or early career', points: 8, class: 'builder',
        match: ['student', 'etudiant', 'intern', 'stagiaire', 'apprentice', 'alternant', 'trainee', 'graduate'] }
    ],
    companies: [],
    domains: [],
    exclusions: []
  }
};

export function nowIso() {
  return new Date().toISOString();
}

export function openDb(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA_SQL);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) ins.run(key, JSON.stringify(value));
  refreshVersionedSettings(db);
  return db;
}

/**
 * INSERT OR IGNORE never updates an existing row, so a database created before a
 * defaults change keeps the old values for ever — which can preserve outdated
 * scoring rules. Any default carrying a `version` is replaced when the
 * stored copy is older.
 *
 * This DOES overwrite hand edits to those keys. Acceptable while nothing in the
 * UI edits them; the day Settings can, this needs to merge rather than replace.
 */
function refreshVersionedSettings(db) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (value == null || typeof value !== 'object' || !('version' in value)) continue;
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    let stored = null;
    try { stored = row ? JSON.parse(row.value) : null; } catch { stored = null; }
    if (!stored || Number(stored.version || 0) < Number(value.version)) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(value), key);
    }
  }
}

/** Additive schema changes for databases created by an earlier version. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(people)').all().map((c) => c.name);
  if (!cols.includes('status')) {
    db.exec("ALTER TABLE people ADD COLUMN status TEXT NOT NULL DEFAULT 'roster'");
    // Everyone already here predates the split, so guess who was bulk-imported:
    // they carry a LinkedIn URL and none of the marks of deliberate capture.
    // A URL alone is NOT enough — the messages importer backfills one onto people
    // who were typed in by hand. Anything with a note, a tag, a deal, or a logged
    // interaction that is not a LinkedIn message stays on the roster.
    db.exec(`UPDATE people SET status = 'network'
      WHERE is_me = 0
        AND linkedin_url IS NOT NULL AND linkedin_url <> ''
        AND (notes IS NULL OR notes = '')
        AND (tags IS NULL OR tags = '' OR tags = '[]')
        AND NOT EXISTS (SELECT 1 FROM interactions i
                        WHERE i.person_id = people.id AND i.kind <> 'message')
        AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.company_id = people.company_id)`);
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(db, key, valueObj) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(valueObj));
}
