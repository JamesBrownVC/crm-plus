// api.js — every /api/* endpoint for CRM+ .
// handleApi(db, req, res, url) fully answers the request; handler errors become
// JSON {error} with a proper status and never kill the process.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting, nowIso, DEFAULT_SETTINGS } from './db.js';
import * as warmthEng from './engines/warmth.js';
import * as fitEng from './engines/fit.js';
import * as pathfinder from './engines/pathfinder.js';
import * as allocator from './engines/allocator.js';
import * as prospect from './engines/prospect.js';
import { extractLinkedinFiles } from './unzip.js';

const SETTING_KEYS = ['warmth', 'path', 'actions', 'uplifts', 'cadence', 'quiet', 'plan'];
const BODY_LIMIT = 5 * 1024 * 1024;
const COOKIE = 'crm_plus_sid';

class HttpErr extends Error { constructor(status, message) { super(message); this.status = status; } }
const err = (status, message) => { throw new HttpErr(status, message); };

// ---------- utils ----------
const str = (v) => (v == null ? '' : String(v));
const round4 = (n) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
// scores rounded to 4 decimals in API payloads — applied to every response.
const deepRound = (x) => {
  if (typeof x === 'number') return Number.isInteger(x) ? x : round4(x);
  if (Array.isArray(x)) return x.map(deepRound);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x)) o[k] = deepRound(x[k]);
    return o;
  }
  return x;
};
const safeParse = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };
const tagsIn = (v) => (Array.isArray(v) ? JSON.stringify(v)
  : (typeof v === 'string' && v.trim().startsWith('[')) ? v : '[]');
const tagsOut = (row) => (row ? { ...row, tags: safeParse(row.tags, []) } : row);
const personName = (p) => `${str(p.first_name)} ${str(p.last_name)}`.trim();
// "Kernel  Labs" and "Kernel Labs" are one company; whitespace is not identity.
// Legal suffixes (SAS, Ltd) are deliberately NOT stripped — too aggressive.
const normName = (s) => str(s).replace(/\s+/g, ' ').trim();
// Accents, ø and ß fold away so names can be found without entering every special character
// at 23:10, and a search that misses his own sponsor invites him to create a cold
// twin of her. NFD splits a letter from its diacritic; the explicit pairs cover the
// letters that carry no combining mark of their own.
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe')
  .replace(/[ßẞ]/g, 'ss').replace(/[đĐ]/g, 'd').replace(/[łŁ]/g, 'l')
  .toLowerCase();
const intId = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) err(404, 'not found');
  return n;
};

const q1 = (db, sql, ...p) => db.prepare(sql).get(...p);
const qa = (db, sql, ...p) => db.prepare(sql).all(...p);
const run = (db, sql, ...p) => db.prepare(sql).run(...p);

const cfgOf = (db, key) => getSetting(db, key, DEFAULT_SETTINGS[key]);
const meRow = (db) => q1(db, 'SELECT * FROM people WHERE is_me = 1 ORDER BY id LIMIT 1') ?? null;
const warmthMapOf = (db) => warmthEng.computeAll(db, cfgOf(db, 'warmth'));
const pathCfgs = (db) => ({ path: cfgOf(db, 'path'), warmth: cfgOf(db, 'warmth') });
const allocCfgs = (db) => ({ actions: cfgOf(db, 'actions'), uplifts: cfgOf(db, 'uplifts') });

// ---------- sessions / auth ----------
function cookieToken(req) {
  for (const part of str(req.headers.cookie).split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}
// CRM_PLUS_NO_AUTH=1 removes the password gate entirely: every request counts as
// signed in and a "me" person is created if missing. Only for a local demo on
// 127.0.0.1 — anything reachable by another machine must keep the gate on.
export const NO_AUTH = process.env.CRM_PLUS_NO_AUTH === '1';

const sessionOf = (db, req) => {
  if (NO_AUTH) return { token: 'no-auth' };
  const t = cookieToken(req);
  return t ? (q1(db, 'SELECT token FROM sessions WHERE token = ?', t) ?? null) : null;
};
const requireSession = (db, req) => { if (!sessionOf(db, req)) err(401, 'unauthorized'); };
// In no-auth mode nothing runs /api/auth/setup, so ensure the identity exists.
function ensureMe(db) {
  if (meRow(db)) return meRow(db);
  run(db, "INSERT INTO people (first_name, last_name, title, seniority, is_me, created_at, updated_at) VALUES (?, '', 'User', 'OTHER', 1, ?, ?)",
    str(process.env.CRM_PLUS_ME_NAME) || 'Me', nowIso(), nowIso());
  return meRow(db);
}
function issueCookie(db, res) {
  const token = randomBytes(32).toString('hex');
  run(db, 'INSERT INTO sessions (token, created_at) VALUES (?, ?)', token, nowIso());
  // a one-year Max-Age: the session must survive closing the browser,
  // otherwise every phone visit starts at the password screen.
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
}
function hashPassword(password, saltHex) {
  return scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
}

// ---------- body ----------
// A complete LinkedIn archive with rich media runs to tens of megabytes.
const ZIP_LIMIT = 200 * 1024 * 1024;

async function readBinary(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) err(413, 'that file is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) err(413, 'payload too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { err(400, 'invalid JSON body'); }
}

// ---------- generic row helpers ----------
function patchRow(db, table, id, body, cols, touchUpdated) {
  q1(db, `SELECT id FROM ${table} WHERE id = ?`, id) ?? err(404, 'not found');
  const sets = [], vals = [];
  for (const [col, conv] of Object.entries(cols)) {
    if (body && Object.prototype.hasOwnProperty.call(body, col)) { sets.push(`${col} = ?`); vals.push(conv(body[col])); }
  }
  if (sets.length) {
    if (touchUpdated) { sets.push('updated_at = ?'); vals.push(nowIso()); }
    run(db, `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  }
  return q1(db, `SELECT * FROM ${table} WHERE id = ?`, id);
}
function delRow(db, table, id) {
  const r = run(db, `DELETE FROM ${table} WHERE id = ?`, id);
  if (!Number(r.changes)) err(404, 'not found');
  return { ok: true };
}
const asText = (v) => str(v);
const asNullable = (v) => (v == null || v === '' ? null : String(v));
const asIdOrNull = (v) => (v == null || v === '' ? null : Number(v));
const asInt = (v) => Number(v) || 0;
const asBool01 = (v) => (v ? 1 : 0);

// Lookup on the normalised, case-folded name. SQLite has no regex replace, so the
// fast equality probe is backed by a JS pass for rows stored before normalisation.
function findCompanyByName(db, name) {
  const key = normName(name).toLowerCase();
  if (!key) return null;
  const ex = q1(db, 'SELECT id, name FROM companies WHERE lower(name) = ?', key);
  if (ex) return ex;
  for (const c of qa(db, 'SELECT id, name FROM companies ORDER BY id')) {
    if (normName(c.name).toLowerCase() === key) return c;
  }
  return null;
}

// 'corporate' is a real schema value but not offered here: a capture form cannot
// tell one from a startup, and 'other' asserts nothing (as importLinkedin does).
const COMPANY_KINDS = ['startup', 'fund', 'other'];

function resolveCompany(db, body) {
  if (body && body.company_id != null && body.company_id !== '') {
    const c = q1(db, 'SELECT id FROM companies WHERE id = ?', Number(body.company_id));
    if (!c) err(400, 'company not found');
    return c.id;
  }
  const nm = normName(body && body.company_name);
  if (!nm) return null;
  const ex = findCompanyByName(db, nm);
  if (ex) return ex.id; // an existing profile is never overwritten by a capture form
  const now = nowIso();
  // Capture writes the new company's profile in the SAME request. Without this the
  // client had to create the person, re-GET the company and PATCH sector/stage onto
  // it "if all three are empty" — always true for a company it just made, and also
  // true for a real empty company whose name was retyped, which is how a fabricated
  // thesis fit ended up on a partner's screen.
  const kind = COMPANY_KINDS.includes(str(body.company_kind)) ? str(body.company_kind) : 'other';
  return Number(run(db,
    `INSERT INTO companies (name, kind, sector, stage, geography, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    nm, kind, str(body.company_sector), str(body.company_stage), str(body.company_geography),
    now, now).lastInsertRowid);
}

// One ICP fit row. The score never travels alone: `coverage` and `missing` are what
// let a chip say "0% — sector, stage and geography not recorded" instead of asserting
// a confident zero over fields nobody filled in (non-negotiable 4).
const fitOut = (prof, f) => ({
  icp_id: prof.id, icp_name: prof.name, score: f.score,
  coverage: f.coverage, known_weight: f.known_weight, total_weight: f.total_weight,
  missing: f.missing,
});

// person_id -> {touches, last_touch}: the evidence behind every warmth number.
function touchStats(db) {
  const m = new Map();
  for (const r of qa(db, 'SELECT person_id, COUNT(*) AS n, MAX(ts) AS last FROM interactions GROUP BY person_id')) {
    m.set(r.person_id, { touches: Number(r.n), last_touch: r.last ?? null });
  }
  return m;
}

// Up to 90 characters of `notes` centred on the match, so a search result can say
// WHY it matched. Null unless the needle is in notes and not in the name/title.
function noteSnippet(notes, name, title, needle) {
  const text = str(notes);
  const q = str(needle).toLowerCase();
  if (!text || !q) return null;
  if (`${str(name)} ${str(title)}`.toLowerCase().includes(q)) return null;
  const at = text.toLowerCase().indexOf(q);
  if (at === -1) return null;
  const WIN = 90;
  if (text.length <= WIN) return text;
  let start = Math.round(at + q.length / 2 - WIN / 2);
  start = Math.max(0, Math.min(start, text.length - WIN));
  let out = text.slice(start, start + WIN);
  if (start > 0) out = `…${out}`;
  if (start + WIN < text.length) out = `${out}…`;
  return out;
}

// ---------- CSV (RFC-4180-tolerant: quoted fields, "" escapes, CRLF, multiline quotes) ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseConnectedOn(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(str(s).trim());
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo != null) return new Date(Date.UTC(+m[3], mo, +m[1])).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? nowIso() : new Date(t).toISOString();
}

// LinkedIn writes "2026-08-04 16:27:32 UTC"; treat it as the UTC it says it is.
function parseMessageDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str(s).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const normUrl = (s) => str(s).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');

/** Find the header row of a LinkedIn CSV by a column it must contain. */
function linkedinTable(csv, marker) {
  const rows = parseCsv(csv);
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => str(c).trim().toLowerCase());
    if (cells.includes(marker)) {
      const idx = {};
      cells.forEach((c, j) => { if (!(c in idx)) idx[c] = j; });
      return { idx, rows: rows.slice(i + 1) };
    }
  }
  return null;
}

/**
 * messages.csv -> real interactions. This is the file that makes warmth mean
 * something: it carries a date and a direction per message, which is what
 * recency, frequency and (above all) reciprocity are computed from.
 *
 * Deliberately excluded: group threads (a broadcast is not a relationship) and
 * drafts (never sent). Re-importing is idempotent on (person, timestamp).
 */
function importLinkedinMessages(db, csv) {
  const t = linkedinTable(csv, 'conversation id');
  if (!t) err(400, 'no messages.csv header found (expected CONVERSATION ID, FROM, DATE, ...)');
  const { idx, rows } = t;
  const cell = (row, key) => { const j = idx[key]; return j == null ? '' : str(row[j]).trim(); };

  // Whose export is this? The account holder is the most frequent sender in
  // their own archive. Falls back cleanly if the DB's "me" has no profile URL.
  const me = meRow(db);
  const meUrl = normUrl(me?.linkedin_url);
  const tally = new Map();
  for (const r of rows) {
    const u = normUrl(cell(r, 'sender profile url'));
    if (u) tally.set(u, (tally.get(u) || 0) + 1);
  }
  let myUrl = meUrl && tally.has(meUrl) ? meUrl : '';
  if (!myUrl) myUrl = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  if (!myUrl) err(400, 'could not identify the account holder in messages.csv');

  let imported = 0, duplicates = 0, skipped_group = 0, skipped_draft = 0, skipped_other = 0;
  let people_created = 0, companies_created = 0;
  const partners = new Set();

  for (const row of rows) {
    if (str(cell(row, 'is message draft')).toLowerCase() === 'true') { skipped_draft++; continue; }
    const recipients = cell(row, 'recipient profile urls').split(/\s+/).map(normUrl).filter(Boolean);
    // A message to several people is a broadcast, not a one-to-one relationship.
    if (recipients.length > 1) { skipped_group++; continue; }
    const ts = parseMessageDate(cell(row, 'date'));
    if (!ts) { skipped_other++; continue; }

    const senderUrl = normUrl(cell(row, 'sender profile url'));
    const outbound = senderUrl === myUrl;
    const otherUrl = outbound ? recipients[0] : senderUrl;
    const otherName = outbound ? cell(row, 'to') : cell(row, 'from');
    if (!otherUrl || otherUrl === myUrl) { skipped_other++; continue; }

    let person = q1(db, 'SELECT * FROM people WHERE lower(linkedin_url) = ?', otherUrl);
    if (!person && otherName) {
      const sp = otherName.indexOf(' ');
      const first = sp === -1 ? otherName : otherName.slice(0, sp);
      const last = sp === -1 ? '' : otherName.slice(sp + 1);
      person = q1(db, 'SELECT * FROM people WHERE is_me = 0 AND lower(first_name) = lower(?) AND lower(last_name) = lower(?)', first, last);
      if (person && !person.linkedin_url) {
        run(db, 'UPDATE people SET linkedin_url = ? WHERE id = ?', otherUrl, person.id);
      }
    }
    if (!person) {
      // Someone spoken to but not connected to is still a contact worth keeping.
      if (!otherName) { skipped_other++; continue; }
      const sp = otherName.indexOf(' ');
      const now = nowIso();
      const pid = Number(run(db,
        `INSERT INTO people (first_name, last_name, linkedin_url, seniority, status, created_at, updated_at)
         VALUES (?, ?, ?, 'OTHER', 'network', ?, ?)`,
        sp === -1 ? otherName : otherName.slice(0, sp), sp === -1 ? '' : otherName.slice(sp + 1),
        otherUrl, now, now).lastInsertRowid);
      person = q1(db, 'SELECT * FROM people WHERE id = ?', pid);
      people_created++;
    }

    // Idempotent: the same message re-imported must not inflate frequency.
    if (q1(db, "SELECT id FROM interactions WHERE person_id = ? AND ts = ? AND kind = 'message'", person.id, ts)) {
      duplicates++; continue;
    }
    const subject = cell(row, 'subject');
    const content = cell(row, 'content').replace(/\s+/g, ' ').trim();
    run(db, "INSERT INTO interactions (person_id, ts, kind, direction, summary) VALUES (?, ?, 'message', ?, ?)",
      person.id, ts, outbound ? 'outbound' : 'inbound',
      (subject || content).slice(0, 200) || 'LinkedIn message');
    imported++;
    partners.add(person.id);
  }
  return {
    messages_imported: imported,
    people_scored: partners.size,
    people_created,
    companies_created,
    duplicates,
    skipped: { group: skipped_group, drafts: skipped_draft, other: skipped_other },
  };
}

function importLinkedin(db, csv) {
  const rows = parseCsv(csv);
  const norm = (s) => str(s).trim().toLowerCase();
  // LinkedIn prepends "Notes:" preamble lines; the real header carries these columns.
  let headerIdx = -1;
  const colIdx = {};
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(norm);
    if (cells.includes('first name') && cells.includes('last name')) {
      headerIdx = i;
      cells.forEach((cell, j) => { if (!(cell in colIdx)) colIdx[cell] = j; });
      break;
    }
  }
  if (headerIdx === -1) err(400, 'no LinkedIn header row found (expected First Name, Last Name, ...)');
  const col = (row, key) => { const j = colIdx[key]; return j == null ? '' : str(row[j]).trim(); };
  const me = meRow(db);
  let created_people = 0, created_companies = 0, skipped = 0;

  for (const row of rows.slice(headerIdx + 1)) {
    const first = col(row, 'first name');
    const last = col(row, 'last name');
    if (!first && !last) { skipped++; continue; }
    const url = col(row, 'url');
    const dupe = (url && q1(db, 'SELECT id FROM people WHERE linkedin_url = ?', url))
      || q1(db, 'SELECT id FROM people WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)', first, last);
    if (dupe) { skipped++; continue; }

    let companyId = null;
    const companyName = normName(col(row, 'company'));
    if (companyName) {
      const ex = findCompanyByName(db, companyName);
      if (ex) companyId = ex.id;
      else {
        const now = nowIso();
        companyId = Number(run(db, "INSERT INTO companies (name, kind, created_at, updated_at) VALUES (?, 'other', ?, ?)",
          companyName, now, now).lastInsertRowid);
        created_companies++;
      }
    }
    const now = nowIso();
    const pid = Number(run(db,
      // seniority 'OTHER' explicitly: the column default is 'IC', which would
      // silently file a whole LinkedIn export as individual contributors (S9).
      // status 'network': a bulk import is background, not a decision to target
      // someone. The prospect recommender is what promotes people from here.
      `INSERT INTO people (first_name, last_name, email, linkedin_url, company_id, title, seniority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OTHER', 'network', ?, ?)`,
      first, last, col(row, 'email address') || null, url || null, companyId, col(row, 'position'), now, now).lastInsertRowid);
    created_people++;
    if (me) {
      run(db, "INSERT OR IGNORE INTO relationships (src_person, dst_person, rel_type, strength) VALUES (?, ?, 'knows', 'medium')", me.id, pid);
    }
    // Deliberately NO interaction. Accepting a connection request is not a
    // conversation, and writing one here would fabricate the evidence warmth is
    // built on: every imported contact would show a confident ~10-17% (the
    // sigmoid floor) whether they are a stranger or someone you speak to weekly.
    // Zero touches instead, so the person reads as "not scored yet" until real
    // contact is recorded — from messages, or from the user saying so.
    // The connection date is kept on the person, not disguised as contact.
    const connectedOn = parseConnectedOn(col(row, 'connected on'));
    if (connectedOn) run(db, 'UPDATE people SET created_at = ? WHERE id = ?', connectedOn, pid);
  }
  return { created_people, created_companies, skipped };
}

// ---------- entry point ----------
export async function handleApi(db, req, res, url) {
  const ctx = {
    db, req, res,
    method: req.method,
    parts: url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean),
    q: url.searchParams,
    body: null,
    sent: false,
    send(status, payload) {
      this.sent = true;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(deepRound(payload)));
    },
  };
  try {
    if (['POST', 'PUT', 'PATCH'].includes(ctx.method)) {
      // A LinkedIn export arrives as binary and is far larger than a JSON body,
      // so it gets its own reader and its own ceiling.
      ctx.body = str(req.headers['content-type']).includes('application/zip')
        ? { zip: await readBinary(req, ZIP_LIMIT) }
        : await readJson(req);
    }
    await route(ctx);
    if (!ctx.sent) err(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpErr ? e.status : 500;
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: str(e && e.message) || 'server error' }));
    } else {
      try { res.end(); } catch { /* socket already gone */ }
    }
  }
}

async function route(ctx) {
  const { db, req, res, method, parts, q, body, send } = ctx;
  const S = send.bind(ctx);
  const [a, b] = parts;

  // ---- /api/auth/* (no session required) ----
  if (a === 'auth') {
    if (b === 'status' && method === 'GET') {
      // no-auth: report a finished setup and an open session so the shell renders
      // straight away instead of routing to #/login.
      if (NO_AUTH) {
        const me = ensureMe(db);
        return S(200, { app: 'crm-plus', setup: true, authed: true, no_auth: true, me: me ? tagsOut(me) : null });
      }
      const me = meRow(db);
      return S(200, { app: 'crm-plus', setup: !!getSetting(db, 'auth', null), authed: !!sessionOf(db, req), me: me ? tagsOut(me) : null });
    }
    if (b === 'setup' && method === 'POST') {
      if (getSetting(db, 'auth', null)) err(409, 'already set up');
      const password = str(body && body.password);
      if (!password) err(400, 'password required');
      const salt = randomBytes(16).toString('hex');
      setSetting(db, 'auth', { salt, hash: hashPassword(password, salt).toString('hex') });
      if (!meRow(db)) {
        const nm = str(body && body.my_name).trim() || 'Me';
        const sp = nm.indexOf(' ');
        const now = nowIso();
        run(db, "INSERT INTO people (first_name, last_name, title, seniority, is_me, created_at, updated_at) VALUES (?, ?, '', 'OTHER', 1, ?, ?)",
          sp === -1 ? nm : nm.slice(0, sp), sp === -1 ? '' : nm.slice(sp + 1).trim(), now, now);
      }
      issueCookie(db, res);
      return S(200, { ok: true });
    }
    if (b === 'login' && method === 'POST') {
      const auth = getSetting(db, 'auth', null);
      if (!auth) err(401, 'not set up');
      const hash = hashPassword(str(body && body.password), auth.salt);
      const stored = Buffer.from(auth.hash, 'hex');
      if (hash.length !== stored.length || !timingSafeEqual(hash, stored)) err(401, 'invalid password');
      issueCookie(db, res);
      return S(200, { ok: true });
    }
    if (b === 'logout' && method === 'POST') {
      const t = cookieToken(req);
      if (t) run(db, 'DELETE FROM sessions WHERE token = ?', t);
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return S(200, { ok: true });
    }
    err(404, 'not found');
  }

  requireSession(db, req);

  // ---- people ----
  if (a === 'people' && parts.length === 1) {
    if (method === 'GET') {
      const nq = fold(str(q.get('q')).trim());
      const companyId = q.get('company_id');
      let sql = 'SELECT p.*, c.name AS company_name FROM people p LEFT JOIN companies c ON c.id = p.company_id WHERE p.is_me = 0';
      const ps = [];
      // tier=roster (default) | network | all. The People page defaults to the
      // working set; the network tier is opt-in, because it is ~a large imported network.
      const tier = str(q.get('tier') || 'roster');
      if (tier === 'roster' || tier === 'network') { sql += ' AND p.status = ?'; ps.push(tier); }
      if (companyId != null && companyId !== '') { sql += ' AND p.company_id = ?'; ps.push(Number(companyId)); }
      // The needle is folded in JS with the SAME helper /api/search uses, so the People
      // page filter and the global bar can never disagree about who exists. notes, tags
      // and the company are searchable: the context line typed at 23:10 is the whole
      // point of capture and must still be findable in three months.
      const hit = (p) => !nq
        || fold(`${str(p.first_name)} ${str(p.last_name)}`).includes(nq)
        || fold(p.title).includes(nq) || fold(p.email).includes(nq)
        || fold(p.notes).includes(nq) || fold(p.tags).includes(nq)
        || fold(p.company_name).includes(nq);
      const wm = warmthMapOf(db);
      const touch = new Map(qa(db, 'SELECT person_id, MAX(ts) AS last FROM interactions GROUP BY person_id').map((r) => [r.person_id, r.last]));
      const out = qa(db, sql, ...ps)
        .filter(hit)
        .map((p) => ({
          ...tagsOut(p),
          warmth: wm.get(p.id)?.score ?? 0,
          touches: wm.get(p.id)?.touches ?? 0,
          last_touch: touch.get(p.id) ?? null,
        }))
        .sort((x, y) => y.warmth - x.warmth);
      return S(200, out);
    }
    if (method === 'POST') {
      const first = str(body && body.first_name).trim();
      if (!first) err(400, 'first_name required');
      const companyId = resolveCompany(db, body);
      const now = nowIso();
      const r = run(db,
        `INSERT INTO people (first_name, last_name, email, linkedin_url, company_id, title, seniority, dept, location, tags, notes, is_me, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        first, str(body.last_name), asNullable(body.email), asNullable(body.linkedin_url), companyId,
        // 'OTHER' not 'IC': an omitted seniority is unknown, and filing it as
        // "Individual contributor" makes the person page print that under a
        // founder's name. OTHER and IC carry the same warmth weight (0.2), so
        // this changes no score — only stops the UI asserting something untrue.
        str(body.title), str(body.seniority) || 'OTHER', str(body.dept), str(body.location),
        tagsIn(body.tags), str(body.notes), now, now);
      return S(201, tagsOut(q1(db, 'SELECT * FROM people WHERE id = ?', Number(r.lastInsertRowid))));
    }
  }
  // advisory duplicate detection for manual capture — POST /api/people still
  // creates unconditionally; general record merging is not implemented.
  if (a === 'people' && b === 'dupes' && parts.length === 2 && method === 'GET') {
    // Both sides fold: "Helene Garnier" typed off a business card must find the
    // Hélène already in the CRM, or the advisory is silent exactly when it matters.
    const first = fold(str(q.get('first_name')).trim());
    const last = fold(str(q.get('last_name')).trim());
    const email = fold(str(q.get('email')).trim());
    const li = fold(str(q.get('linkedin_url')).trim());
    if (!first && !last && !email && !li) return S(200, { candidates: [] });
    const stats = touchStats(db);
    const hit = (p) => {
      if (li && fold(str(p.linkedin_url).trim()) === li) return true;
      if (email && fold(str(p.email).trim()) === email) return true;
      const pf = fold(str(p.first_name).trim());
      const pl = fold(str(p.last_name).trim());
      if (last) {
        return !!(pl === last && first.length >= 2 && pf.length >= 2
          && (pf.startsWith(first) || first.startsWith(pf)));
      }
      // A business card often carries one name. With no surname to corroborate, only an
      // EXACT first name counts — a prefix would flag half the address book.
      return !!(first.length >= 2 && pf === first);
    };
    const candidates = qa(db, `SELECT p.*, c.name AS company_name FROM people p
                               LEFT JOIN companies c ON c.id = p.company_id
                               WHERE p.is_me = 0 ORDER BY p.id`)
      .filter(hit)
      .map((p) => ({
        id: p.id, name: personName(p), title: str(p.title), company_name: p.company_name ?? null,
        touches: stats.get(p.id)?.touches ?? 0, last_touch: stats.get(p.id)?.last_touch ?? null,
      }))
      .sort((x, y) => y.touches - x.touches || x.id - y.id)
      .slice(0, 5);
    return S(200, { candidates });
  }
  if (a === 'people' && parts.length === 2) {
    const id = intId(b);
    if (method === 'GET') {
      const person = q1(db, 'SELECT * FROM people WHERE id = ?', id) ?? err(404, 'not found');
      const company = person.company_id ? q1(db, 'SELECT * FROM companies WHERE id = ?', person.company_id) : null;
      const interactions = qa(db, 'SELECT * FROM interactions WHERE person_id = ? ORDER BY ts DESC, id DESC', id);
      const w = warmthEng.scorePerson(person, interactions, new Date(), cfgOf(db, 'warmth'));
      const rels = qa(db, 'SELECT * FROM relationships WHERE src_person = ? OR dst_person = ?', id, id);
      const otherIds = [...new Set(rels.map((r) => (r.src_person === id ? r.dst_person : r.src_person)))];
      const others = new Map(otherIds.length
        ? qa(db, `SELECT p.id, p.first_name, p.last_name, p.title, c.name AS company_name
                  FROM people p LEFT JOIN companies c ON c.id = p.company_id
                  WHERE p.id IN (${otherIds.map(() => '?').join(',')})`, ...otherIds).map((o) => [o.id, o])
        : []);
      const relationships = rels.map((r) => {
        const o = others.get(r.src_person === id ? r.dst_person : r.src_person);
        return {
          id: r.id,
          other: o ? { id: o.id, name: personName(o), title: o.title, company_name: o.company_name } : null,
          rel_type: r.rel_type, strength: r.strength, notes: r.notes,
        };
      });
      const open_tasks = qa(db, 'SELECT * FROM tasks WHERE person_id = ? AND done = 0 ORDER BY due IS NULL, due, id', id);
      // "has the fund already looked at them?" — won/passed deals included on purpose.
      const dealRow = person.company_id
        ? q1(db, 'SELECT * FROM deals WHERE company_id = ? ORDER BY id DESC LIMIT 1', person.company_id)
        : null;
      const deal = dealRow ? {
        id: dealRow.id, company_id: dealRow.company_id, stage: dealRow.stage,
        priority: dealRow.priority, next_step: str(dealRow.next_step), source: str(dealRow.source),
      } : null;
      // person-aware fit: person.seniority / person.title criteria resolve here.
      // coverage/missing travel with the score: a 0% on three unrecorded fields is
      // an absence of data, not a verdict (non-negotiable 4).
      const fits = qa(db, 'SELECT * FROM icp_profiles ORDER BY id').map((prof) => fitOut(prof,
        fitEng.scoreTarget({ person, company }, safeParse(prof.criteria, []))));
      let colleagues = [];
      let colleagues_total = 0;
      if (person.company_id) {
        const wm = warmthMapOf(db);
        const stats = touchStats(db);
        const all = qa(db, 'SELECT * FROM people WHERE company_id = ? AND id != ? AND is_me = 0 ORDER BY id',
          person.company_id, id)
          .map((cp) => ({
            id: cp.id, name: personName(cp), title: str(cp.title), seniority: str(cp.seniority),
            warmth: wm.get(cp.id)?.score ?? 0,
            touches: stats.get(cp.id)?.touches ?? 0,
            last_touch: stats.get(cp.id)?.last_touch ?? null,
          }))
          .sort((x, y) => y.warmth - x.warmth || x.id - y.id);
        // the set size, not the page size: "who else do I know there" must not
        // silently stop at 8 with no way to see the ninth (S2).
        colleagues_total = all.length;
        colleagues = all.slice(0, 8);
      }
      return S(200, {
        person: tagsOut(person), company: company ? tagsOut(company) : null,
        warmth: w, interactions, relationships, open_tasks, deal, fits, colleagues, colleagues_total,
      });
    }
    if (method === 'PATCH') {
      if (body && body.company_id != null && body.company_id !== ''
        && !q1(db, 'SELECT id FROM companies WHERE id = ?', Number(body.company_id))) err(400, 'company not found');
      const row = patchRow(db, 'people', id, body, {
        first_name: asText, last_name: asText, email: asNullable, linkedin_url: asNullable,
        company_id: asIdOrNull, title: asText, seniority: asText, dept: asText,
        location: asText, tags: tagsIn, notes: asText,
        // promote to the roster / send back to the network tier
        status: (v) => (str(v) === 'network' ? 'network' : 'roster'),
      }, true);
      return S(200, tagsOut(row));
    }
    if (method === 'DELETE') return S(200, delRow(db, 'people', id));
  }

  // ---- companies ----
  if (a === 'companies' && parts.length === 1) {
    if (method === 'GET') {
      const needle = str(q.get('q')).trim();
      const kind = str(q.get('kind')).trim();
      let sql = 'SELECT * FROM companies WHERE 1=1';
      const ps = [];
      if (needle) { sql += ' AND name LIKE ?'; ps.push(`%${needle}%`); }
      if (kind) { sql += ' AND kind = ?'; ps.push(kind); }
      sql += ' ORDER BY name COLLATE NOCASE';
      const wm = warmthMapOf(db);
      const byCompany = new Map();
      for (const p of qa(db, 'SELECT * FROM people WHERE company_id IS NOT NULL')) {
        if (!byCompany.has(p.company_id)) byCompany.set(p.company_id, []);
        byCompany.get(p.company_id).push(p);
      }
      const dealBy = new Map(qa(db, 'SELECT * FROM deals ORDER BY id').map((d) => [d.company_id, d]));
      const stats = touchStats(db);
      const out = qa(db, sql, ...ps).map((cRow) => {
        const ppl = byCompany.get(cRow.id) ?? [];
        const d = dealBy.get(cRow.id);
        const max_warmth = warmthEng.companyWarmth(wm, ppl);
        // the person max_warmth actually came from, so the pipeline card can open a
        // truthful breakdown instead of a company-level number with no owner.
        let warmest = null;
        for (const p of ppl) {
          const s = wm.get(p.id)?.score ?? 0;
          if (!warmest || s > warmest.s) warmest = { s, p };
        }
        let last_touch = null;
        for (const p of ppl) {
          const lt = stats.get(p.id)?.last_touch ?? null;
          if (lt && (last_touch === null || lt > last_touch)) last_touch = lt;
        }
        return {
          ...tagsOut(cRow), people_count: ppl.length,
          max_warmth,
          touches: warmthEng.companyTouches(wm, ppl),
          last_touch,
          warmest_person: warmest ? { id: warmest.p.id, name: personName(warmest.p) } : null,
          deal_stage: d ? d.stage : null, deal_id: d ? d.id : null,
        };
      });
      return S(200, out);
    }
    if (method === 'POST') {
      const nm = normName(body && body.name);
      if (!nm) err(400, 'name required');
      // POST /api/people already dedupes on the name; this endpoint used to fork the
      // company, and both the person-edit and add-company paths post here — so fixing
      // someone's employer by hand split the deal, max_warmth and the implicit
      // colleague edges across an empty twin (S9). An existing row is handed BACK
      // untouched (no field updates): an add form must not silently edit a profile.
      const ex = findCompanyByName(db, nm);
      if (ex) return S(200, { ...tagsOut(q1(db, 'SELECT * FROM companies WHERE id = ?', ex.id)), existing: true });
      const now = nowIso();
      const r = run(db,
        `INSERT INTO companies (name, domain, kind, sector, stage, geography, tags, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nm, asNullable(body.domain), str(body.kind) || 'startup', str(body.sector), str(body.stage),
        str(body.geography), tagsIn(body.tags), str(body.notes), now, now);
      return S(201, { ...tagsOut(q1(db, 'SELECT * FROM companies WHERE id = ?', Number(r.lastInsertRowid))), existing: false });
    }
  }
  if (a === 'companies' && parts.length === 2) {
    const id = intId(b);
    if (method === 'GET') {
      const company = q1(db, 'SELECT * FROM companies WHERE id = ?', id) ?? err(404, 'not found');
      const wm = warmthMapOf(db);
      const stats = touchStats(db);
      const people = qa(db, 'SELECT * FROM people WHERE company_id = ?', id)
        .map((p) => ({
          ...tagsOut(p),
          warmth: wm.get(p.id)?.score ?? 0,
          touches: stats.get(p.id)?.touches ?? 0,
          last_touch: stats.get(p.id)?.last_touch ?? null,
        }))
        .sort((x, y) => y.warmth - x.warmth);
      const deal = q1(db, 'SELECT * FROM deals WHERE company_id = ? ORDER BY id DESC LIMIT 1', id) ?? null;
      // A criterion about the founder is not a blank the user can fill on THIS page, so
      // it must never appear in `missing` — the card was asserting "Still blank: Founder,
      // CTO title" above a table listing two founders and a CTO. It appears in
      // `needs_person`, which the UI turns into "score this on a person" instead.
      const fits = qa(db, 'SELECT * FROM icp_profiles ORDER BY id').map((prof) => {
        const crit = safeParse(prof.criteria, []);
        const res = fitEng.scoreTarget({ company }, crit);
        const out = fitOut(prof, res);
        out.needs_person = [...new Set(crit
          .filter((c) => String(c.field ?? '').startsWith('person.'))
          .map((c) => String(c.label || c.field || ''))
          .filter(Boolean))];
        out.missing = (out.missing || []).filter((l) => !out.needs_person.includes(l));
        // coverage over the criteria this page can actually judge
        let compW = 0, compKnownW = 0;
        res.breakdown.forEach((bd, i) => {
          if (String(crit[i]?.field ?? '').startsWith('company.')) {
            compW += bd.weight;
            if (bd.known) compKnownW += bd.weight;
          }
        });
        out.company_coverage = compW > 0 ? Math.round((compKnownW / compW) * 1e4) / 1e4 : 0;
        return out;
      });
      // A promise the weekly plan created against a company (dashboard "Schedule" posts
      // company_id with no person_id) appeared on no detail page at all. Open promises
      // for the company OR anyone at it belong here.
      const pids = people.map((p) => p.id);
      const tasks = qa(db,
        `SELECT t.*, CASE WHEN p.id IS NULL THEN NULL
                          ELSE trim(p.first_name || ' ' || coalesce(p.last_name, '')) END AS person_name
           FROM tasks t LEFT JOIN people p ON p.id = t.person_id
          WHERE t.done = 0 AND (t.company_id = ?${pids.length ? ` OR t.person_id IN (${pids.map(() => '?').join(',')})` : ''})
          ORDER BY t.due IS NULL, t.due, t.id`, id, ...pids);
      return S(200, { company: tagsOut(company), people, deal, fits, tasks });
    }
    if (method === 'PATCH') {
      const row = patchRow(db, 'companies', id, body, {
        name: normName, domain: asNullable, kind: asText, sector: asText, stage: asText,
        geography: asText, tags: tagsIn, notes: asText,
      }, true);
      return S(200, tagsOut(row));
    }
    if (method === 'DELETE') return S(200, delRow(db, 'companies', id));
  }

  // ---- interactions ----
  if (a === 'interactions' && parts.length === 1 && method === 'POST') {
    const pid = Number(body && body.person_id);
    if (!Number.isInteger(pid)) err(400, 'person_id required');
    const who = q1(db, 'SELECT id, is_me FROM people WHERE id = ?', pid) ?? err(404, 'person not found');
    // A touch on yourself scores nothing, but it lands on your own timeline and feeds
    // the company last-touch aggregate priorities uses (which joins every person with
    // a company_id, me included) — resetting the staleness clock on your own firm's deal.
    if (who.is_me) err(400, "that's you — log the touch on the other person");
    const kind = str(body.kind).trim();
    if (!kind) err(400, 'kind required');
    const direction = body.direction === 'inbound' ? 'inbound' : 'outbound';
    // One mistyped year ("2027-03-04") filed a founder at 100% warm forever and printed
    // a decay factor of 36.584 in the why-popover. An hour of slack absorbs clock skew
    // between the phone that logged it and this process.
    const tsRaw = str(body.ts).trim();
    let ts = nowIso();
    if (tsRaw) {
      const t = Date.parse(tsRaw);
      if (!Number.isFinite(t)) err(400, "that date didn't make sense — pick the day you spoke");
      if (t > Date.now() + 36e5) err(400, 'that date is in the future — pick the day you actually spoke');
      ts = new Date(t).toISOString();
    }
    const r = run(db, 'INSERT INTO interactions (person_id, ts, kind, direction, summary) VALUES (?, ?, ?, ?, ?)',
      pid, ts, kind, direction, str(body.summary));
    return S(201, q1(db, 'SELECT * FROM interactions WHERE id = ?', Number(r.lastInsertRowid)));
  }
  if (a === 'interactions' && parts.length === 2 && method === 'DELETE') {
    return S(200, delRow(db, 'interactions', intId(b)));
  }

  // ---- relationships ----
  if (a === 'relationships' && parts.length === 1 && method === 'POST') {
    const src = Number(body && body.src_person), dst = Number(body && body.dst_person);
    if (!Number.isInteger(src) || !Number.isInteger(dst)) err(400, 'src_person and dst_person required');
    if (src === dst) err(400, 'src_person and dst_person must differ');
    const rel_type = str(body.rel_type).trim();
    if (!rel_type) err(400, 'rel_type required');
    q1(db, 'SELECT id FROM people WHERE id = ?', src) ?? err(404, 'src person not found');
    q1(db, 'SELECT id FROM people WHERE id = ?', dst) ?? err(404, 'dst person not found');
    // stored once, undirected: either orientation with the same type is a duplicate
    if (q1(db, `SELECT id FROM relationships WHERE rel_type = ?
                AND ((src_person = ? AND dst_person = ?) OR (src_person = ? AND dst_person = ?))`,
      rel_type, src, dst, dst, src)) err(409, 'duplicate relationship');
    const r = run(db, 'INSERT INTO relationships (src_person, dst_person, rel_type, strength, notes) VALUES (?, ?, ?, ?, ?)',
      src, dst, rel_type, str(body.strength) || 'medium', str(body.notes));
    return S(201, q1(db, 'SELECT * FROM relationships WHERE id = ?', Number(r.lastInsertRowid)));
  }
  if (a === 'relationships' && parts.length === 2 && method === 'DELETE') {
    return S(200, delRow(db, 'relationships', intId(b)));
  }

  // ---- deals ----
  if (a === 'deals' && parts.length === 1) {
    if (method === 'GET') {
      return S(200, qa(db, 'SELECT d.*, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id ORDER BY d.id'));
    }
    if (method === 'POST') {
      const cid = Number(body && body.company_id);
      if (!Number.isInteger(cid)) err(400, 'company_id required');
      q1(db, 'SELECT id FROM companies WHERE id = ?', cid) ?? err(404, 'company not found');
      if (q1(db, 'SELECT id FROM deals WHERE company_id = ?', cid)) err(409, 'company already has a deal');
      const now = nowIso();
      const r = run(db, 'INSERT INTO deals (company_id, stage, priority, source, next_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        cid, str(body.stage) || 'sourced', Number(body.priority) || 3, str(body.source), str(body.next_step), now, now);
      return S(201, q1(db, 'SELECT * FROM deals WHERE id = ?', Number(r.lastInsertRowid)));
    }
  }
  if (a === 'deals' && parts.length === 2) {
    const id = intId(b);
    if (method === 'PATCH') {
      return S(200, patchRow(db, 'deals', id, body, {
        stage: asText, priority: asInt, source: asText, next_step: asText,
      }, true));
    }
    if (method === 'DELETE') return S(200, delRow(db, 'deals', id));
  }

  // ---- tasks ----
  if (a === 'tasks' && parts.length === 1) {
    if (method === 'GET') {
      const open = q.get('open');
      // a promise the user made is about a PERSON; the list must be able to name them.
      const cols = `SELECT t.*,
             CASE WHEN p.id IS NULL THEN NULL
                  ELSE trim(p.first_name || ' ' || coalesce(p.last_name, '')) END AS person_name,
             c.name AS company_name
        FROM tasks t
        LEFT JOIN people p ON p.id = t.person_id
        LEFT JOIN companies c ON c.id = t.company_id`;
      const sql = open === '1'
        ? `${cols} WHERE t.done = 0 ORDER BY t.due IS NULL, t.due, t.id`
        : `${cols} ORDER BY t.done, t.due IS NULL, t.due, t.id`;
      return S(200, qa(db, sql));
    }
    if (method === 'POST') {
      const title = str(body && body.title).trim();
      if (!title) err(400, 'title required');
      if (body.person_id != null && body.person_id !== ''
        && !q1(db, 'SELECT id FROM people WHERE id = ?', Number(body.person_id))) err(400, 'person not found');
      if (body.company_id != null && body.company_id !== ''
        && !q1(db, 'SELECT id FROM companies WHERE id = ?', Number(body.company_id))) err(400, 'company not found');
      const r = run(db, 'INSERT INTO tasks (title, due, done, person_id, company_id, source, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
        title, asNullable(body.due), asIdOrNull(body.person_id), asIdOrNull(body.company_id),
        str(body.source) || 'manual', nowIso());
      return S(201, q1(db, 'SELECT * FROM tasks WHERE id = ?', Number(r.lastInsertRowid)));
    }
  }
  if (a === 'tasks' && parts.length === 2) {
    const id = intId(b);
    if (method === 'PATCH') {
      return S(200, patchRow(db, 'tasks', id, body, {
        title: asText, due: asNullable, done: asBool01, person_id: asIdOrNull, company_id: asIdOrNull, source: asText,
      }, false));
    }
    if (method === 'DELETE') return S(200, delRow(db, 'tasks', id));
  }

  // ---- icp profiles ----
  if (a === 'icp' && parts.length === 1) {
    if (method === 'GET') {
      return S(200, qa(db, 'SELECT * FROM icp_profiles ORDER BY id').map((r) => ({
        id: r.id, name: r.name, criteria: safeParse(r.criteria, []), created_at: r.created_at,
      })));
    }
    if (method === 'POST') {
      const nm = str(body && body.name).trim();
      if (!nm) err(400, 'name required');
      if (body.criteria !== undefined && !Array.isArray(body.criteria)) err(400, 'criteria must be an array');
      const r = run(db, 'INSERT INTO icp_profiles (name, criteria, created_at) VALUES (?, ?, ?)',
        nm, JSON.stringify(body.criteria ?? []), nowIso());
      const row = q1(db, 'SELECT * FROM icp_profiles WHERE id = ?', Number(r.lastInsertRowid));
      return S(201, { id: row.id, name: row.name, criteria: safeParse(row.criteria, []), created_at: row.created_at });
    }
  }
  if (a === 'icp' && parts.length === 2) {
    const id = intId(b);
    if (method === 'PATCH') {
      if (body && body.criteria !== undefined && !Array.isArray(body.criteria)) err(400, 'criteria must be an array');
      const row = patchRow(db, 'icp_profiles', id, body, {
        name: asText, criteria: (v) => JSON.stringify(Array.isArray(v) ? v : []),
      }, false);
      return S(200, { id: row.id, name: row.name, criteria: safeParse(row.criteria, []), created_at: row.created_at });
    }
    if (method === 'DELETE') return S(200, delRow(db, 'icp_profiles', id));
  }

  // ---- overview / plan / priorities ----
  if (a === 'overview' && parts.length === 1 && method === 'GET') {
    const wm = warmthMapOf(db);
    // Today is about the working set. Counting bulk-imported connections here
    // would make the one number on the home screen meaningless.
    const counts = {
      people: q1(db, "SELECT COUNT(*) AS n FROM people WHERE is_me = 0 AND status = 'roster'").n,
      network: q1(db, "SELECT COUNT(*) AS n FROM people WHERE is_me = 0 AND status = 'network'").n,
      companies: q1(db, `SELECT COUNT(*) AS n FROM companies c WHERE EXISTS
        (SELECT 1 FROM people p WHERE p.company_id = c.id AND p.status = 'roster')
        OR EXISTS (SELECT 1 FROM deals d WHERE d.company_id = c.id)`).n,
      active_deals: q1(db, "SELECT COUNT(*) AS n FROM deals WHERE stage NOT IN ('won','passed')").n,
      open_tasks: q1(db, 'SELECT COUNT(*) AS n FROM tasks WHERE done = 0').n,
    };
    const pipeline = {};
    for (const r of qa(db, 'SELECT stage, COUNT(*) AS n FROM deals GROUP BY stage')) pipeline[r.stage] = r.n;
    const allPriorities = allocator.priorities(db, { cadence: cfgOf(db, 'cadence'), uplifts: cfgOf(db, 'uplifts') }, wm);
    // the set size, not the page size: home shows 10 and must be able to say so.
    const priorities = allPriorities.slice(0, 10);
    const plan = allocator.weeklyPlan(db, allocCfgs(db), wm, Number(cfgOf(db, 'plan')?.weekly_hours) || 6);
    // roster only, for the same reason as the counts above
    const rosterIds = new Set(qa(db, "SELECT id FROM people WHERE is_me = 0 AND status = 'roster'").map((r) => r.id));
    const warm_contacts = [...wm.entries()]
      .filter(([pid]) => rosterIds.has(pid))
      .sort((x, y) => y[1].score - x[1].score).slice(0, 5)
      .map(([pid, wv]) => {
        const p = q1(db, `SELECT p.id, p.first_name, p.last_name, p.title, c.name AS company_name
                          FROM people p LEFT JOIN companies c ON c.id = p.company_id WHERE p.id = ?`, pid);
        return p ? { id: p.id, name: personName(p), title: p.title, company_name: p.company_name, warmth: wv.score } : null;
      }).filter(Boolean);
    return S(200, { counts, pipeline, priorities, priorities_total: allPriorities.length, plan, warm_contacts });
  }
  if (a === 'plan' && parts.length === 1 && method === 'GET') {
    let hours = Number(q.get('hours'));
    if (!Number.isFinite(hours) || hours <= 0) hours = Number(cfgOf(db, 'plan')?.weekly_hours) || 6;
    return S(200, allocator.weeklyPlan(db, allocCfgs(db), warmthMapOf(db), hours));
  }
  if (a === 'priorities' && parts.length === 1 && method === 'GET') {
    return S(200, allocator.priorities(db, { cadence: cfgOf(db, 'cadence'), uplifts: cfgOf(db, 'uplifts') }, warmthMapOf(db)));
  }
  if (a === 'quiet' && parts.length === 1 && method === 'GET') {
    const raw = q.get('limit');
    let limit = 6;
    if (raw != null && raw !== '') {
      const n = Math.floor(Number(raw));
      if (Number.isFinite(n)) limit = Math.max(1, Math.min(25, n));
    }
    const cfgs = { quiet: cfgOf(db, 'quiet') };
    // "Going quiet · 6" was the page size: 11 people qualified and the card offered no
    // route to the other 5. `total` is the whole qualifying set, `target_days` the
    // number the engine actually used (so the card can label itself when empty).
    const all = allocator.goingQuietAll(db, cfgs, warmthMapOf(db), new Date());
    return S(200, {
      people: all.slice(0, limit),
      total: all.length,
      target_days: allocator.quietTargetDays(cfgs),
    });
  }

  // ---- pathfinding ----
  if (a === 'path' && b === 'person' && method === 'POST') {
    const tid = Number(body && body.target_person_id);
    if (!Number.isInteger(tid)) err(400, 'target_person_id required');
    q1(db, 'SELECT id FROM people WHERE id = ?', tid) ?? err(404, 'person not found');
    return S(200, pathfinder.pathsToPerson(db, tid, pathCfgs(db)));
  }
  if (a === 'path' && b === 'icp' && method === 'POST') {
    let criteria;
    if (body && body.icp_id != null) {
      const prof = q1(db, 'SELECT * FROM icp_profiles WHERE id = ?', Number(body.icp_id)) ?? err(404, 'icp profile not found');
      criteria = safeParse(prof.criteria, []);
    } else if (body && Array.isArray(body.criteria)) {
      criteria = body.criteria;
    } else {
      err(400, 'icp_id or criteria required');
    }
    // order='fit' returns the best thesis matches regardless of how warm they
    // are, so the client can sort and filter fit and warmth independently. The
    // default rank order would cut high-fit people you have not spoken to yet —
    // exactly the ones an import is supposed to surface.
    const limit = Math.min(Math.max(Number(body && body.limit) || 8, 1), 200);
    const order = str(body && body.order) === 'fit' ? 'fit' : 'rank';
    // scope: roster (your working set) | network (the bulk import) | all
    const scope = ['roster', 'network', 'all'].includes(str(body && body.scope)) ? str(body.scope) : 'all';
    return S(200, pathfinder.findICP(db, criteria, pathCfgs(db), { limit, order, scope }));
  }
  if (a === 'path' && b === 'fails' && method === 'GET') {
    const rows = qa(db, `SELECT f.*, s.first_name AS sf, s.last_name AS sl, d.first_name AS df, d.last_name AS dl
                         FROM failed_intros f
                         LEFT JOIN people s ON s.id = f.src_person
                         LEFT JOIN people d ON d.id = f.dst_person
                         ORDER BY f.id DESC`);
    return S(200, rows.map((r) => ({
      id: r.id, src_person: r.src_person, dst_person: r.dst_person, created_at: r.created_at,
      src_name: `${str(r.sf)} ${str(r.sl)}`.trim() || null,
      dst_name: `${str(r.df)} ${str(r.dl)}`.trim() || null,
    })));
  }
  if (a === 'path' && b === 'fail' && parts.length === 2 && method === 'POST') {
    const src = Number(body && body.src_person), dst = Number(body && body.dst_person);
    if (!Number.isInteger(src) || !Number.isInteger(dst)) err(400, 'src_person and dst_person required');
    // failed_intros has no foreign keys: junk ids would silently degrade every solve.
    q1(db, 'SELECT id FROM people WHERE id = ?', src) ?? err(404, 'person not found');
    q1(db, 'SELECT id FROM people WHERE id = ?', dst) ?? err(404, 'person not found');
    const r = run(db, 'INSERT INTO failed_intros (src_person, dst_person, created_at) VALUES (?, ?, ?)', src, dst, nowIso());
    return S(201, q1(db, 'SELECT * FROM failed_intros WHERE id = ?', Number(r.lastInsertRowid)));
  }
  if (a === 'path' && b === 'fail' && parts.length === 3 && method === 'DELETE') {
    return S(200, delRow(db, 'failed_intros', intId(parts[2])));
  }

  // ---- settings ----
  if (a === 'settings' && parts.length === 2) {
    if (!SETTING_KEYS.includes(b)) err(400, 'unknown settings key');
    if (method === 'GET') return S(200, cfgOf(db, b));
    if (method === 'PUT') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) err(400, 'body must be an object');
      setSetting(db, b, body);
      return S(200, body);
    }
  }

  // ---- import / demo / search ----
  // ---- icp labels: the user's verdict, the only ground truth there is ----
  if (a === 'icp-label' && parts.length === 1 && method === 'POST') {
    const pid = intId(body && body.person_id);
    if (!q1(db, 'SELECT id FROM people WHERE id = ?', pid)) err(404, 'person not found');
    const label = Number(body && body.label) === 1 ? 1 : 0;
    const cfg = getSetting(db, 'icp_scoring', DEFAULT_SETTINGS.icp_scoring);
    const row = q1(db, `SELECT p.*, c.name AS company_name FROM people p
                        LEFT JOIN companies c ON c.id = p.company_id WHERE p.id = ?`, pid);
    // Store what the model said WHEN the label was given: retuning the weights
    // later must not silently rewrite the history it is being judged against.
    const scored = prospect.scoreProspect({ person: row, company: { name: row.company_name } }, cfg);
    run(db, `INSERT INTO icp_labels (person_id, label, score_at_label, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(person_id) DO UPDATE SET label = excluded.label,
               score_at_label = excluded.score_at_label, created_at = excluded.created_at`,
    pid, label, scored.score, nowIso());
    const counts = q1(db, 'SELECT SUM(label) AS pos, COUNT(*) AS n FROM icp_labels');
    return S(200, { ok: true, labelled: counts.n, positives: counts.pos ?? 0 });
  }

  // ---- prospects: who in the network tier looks worth promoting ----
  if (a === 'prospects' && parts.length === 1 && method === 'GET') {
    const cfg = getSetting(db, 'icp_scoring', DEFAULT_SETTINGS.icp_scoring);
    const min = q.get('min') != null ? Number(q.get('min')) : 0.35;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);
    // sample=spread: a balanced set for MEASURING the score. The default ranking
    // is for using it, and produces almost no negatives to measure against.
    const spread = str(q.get('sample')) === 'spread';
    const roleClass = ['founder', 'builder'].includes(str(q.get('class'))) ? str(q.get('class')) : null;
    const { total, rows } = spread
      ? prospect.spreadSample(db, cfg, { limit })
      : prospect.rankProspects(db, cfg, { min, limit, offset, roleClass });
    const wm = warmthMapOf(db);
    return S(200, {
      total,
      min,
      labelled: q1(db, 'SELECT COUNT(*) AS n FROM icp_labels').n,
      // lets the UI tell "nothing above the threshold" apart from "no network
      // imported yet", which is what every new install actually hits
      scanned_network: q1(db, "SELECT COUNT(*) AS n FROM people WHERE is_me = 0 AND status = 'network'").n,
      // Judged from a job title and a company name — the only two things a
      // LinkedIn export knows about someone. Said plainly so the number is not
      // mistaken for a verdict on the person.
      basis: 'job title and company name only',
      rows: rows.map((r) => ({
        person: {
          id: r.person.id, name: personName(r.person), title: str(r.person.title),
          company_name: r.person.company_name ?? null, linkedin_url: r.person.linkedin_url ?? null,
        },
        score: r.score, points: r.points, max: r.max, breakdown: r.breakdown,
        role_class: r.role_class,
        warmth: wm.get(r.person.id)?.score ?? 0,
        touches: wm.get(r.person.id)?.touches ?? 0,
      })),
    });
  }

  // Drop the whole export in as it was downloaded: find the files, unzip them,
  // and run the same importers. No manual extraction, no picking files out.
  if (a === 'import' && b === 'linkedin-zip' && method === 'POST') {
    const zip = body && body.zip;
    if (!Buffer.isBuffer(zip) || !zip.length) err(400, 'send the .zip file as the request body');
    let files;
    try {
      files = extractLinkedinFiles(zip);
    } catch (e) {
      err(400, `could not read that .zip (${str(e.message)})`);
    }
    if (!files.csv && !files.messages) {
      err(400, 'no Connections.csv or messages.csv inside that .zip — is it the LinkedIn export?');
    }
    const out = files.csv
      ? importLinkedin(db, files.csv)
      : { created_people: 0, created_companies: 0, skipped: 0 };
    if (files.messages) out.messages = importLinkedinMessages(db, files.messages);
    out.files_found = Object.keys(files).map((k) => (k === 'csv' ? 'Connections.csv' : 'messages.csv'));
    return S(200, out);
  }
  if (a === 'import' && b === 'linkedin' && method === 'POST') {
    // Either or both files. Connections runs first so message partners already
    // exist as people (with their company and title) before being scored.
    const csv = body && body.csv;
    const messages = body && body.messages;
    const hasCsv = typeof csv === 'string' && csv.trim();
    const hasMsg = typeof messages === 'string' && messages.trim();
    if (!hasCsv && !hasMsg) err(400, 'csv or messages required');
    const out = hasCsv ? importLinkedin(db, csv) : { created_people: 0, created_companies: 0, skipped: 0 };
    if (hasMsg) out.messages = importLinkedinMessages(db, messages);
    return S(200, out);
  }
  if (a === 'search' && parts.length === 1 && method === 'GET') {
    const needle = str(q.get('q')).trim();
    const nq = fold(needle);
    if (!nq) return S(200, { people: [], companies: [], people_total: 0, companies_total: 0 });
    // Rank BEFORE truncating. An alphabetical ORDER BY under LIMIT 8 sorted the match
    // the user was actually typing to the bottom and then cut it off: q="so" put
    // Claire Besson (a notes hit) first and Sofia Lindqvist last, and q="ma" evicted 4
    // of 10 people whose NAME contains it in favour of title/notes hits (S8/S4).
    // Tier 0 = a name half or the full name starts with q, 1 = the full name contains
    // it, 2 = the title, 3 = the company, 4 = the email, 5 = notes/tags only. Then the
    // evidence decides: more touches, more recent.
    // The whole predicate lives in JS so it can fold: SQL LIKE could not see past an
    // accent, and "helene" returning nothing then invited the user to add a second
    // Hélène. One user's CRM is hundreds of rows — a full scan is the honest tool.
    const foldCmp = (x, y) => {
      const l = fold(x), r = fold(y);
      return l < r ? -1 : l > r ? 1 : 0;
    };
    const tsDesc = (x, y) => (x === y ? 0 : x == null ? 1 : y == null ? -1 : (x < y ? 1 : -1));
    // what the sub-line under a result says it matched on, indexed by tier
    const MATCHED_ON = ['name', 'name', 'title', 'company', 'email', 'notes'];
    // is_me excluded, as on /api/people and /api/people/dupes: finding himself here is
    // how a touch got logged on his own row.
    const rankedPeople = qa(db,
      `SELECT p.id, p.first_name, p.last_name, p.title, p.notes, p.tags, p.email,
              c.name AS company_name, t.n AS touches, t.last AS last_touch
         FROM people p
         LEFT JOIN companies c ON c.id = p.company_id
         LEFT JOIN (SELECT person_id, COUNT(*) AS n, MAX(ts) AS last
                      FROM interactions GROUP BY person_id) t ON t.person_id = p.id
        WHERE p.is_me = 0`)
      .map((p) => {
        const name = personName(p);
        const first = fold(p.first_name), last = fold(p.last_name);
        const full = `${first} ${last}`.trim();
        const tier = (first.startsWith(nq) || last.startsWith(nq) || full.startsWith(nq)) ? 0
          : full.includes(nq) ? 1
            : fold(p.title).includes(nq) ? 2
              : fold(p.company_name).includes(nq) ? 3
                : fold(p.email).includes(nq) ? 4
                  : (fold(p.notes).includes(nq) || fold(p.tags).includes(nq)) ? 5 : -1;
        return {
          tier, row: p,
          out: {
            id: p.id, name, title: p.title, company_name: p.company_name,
            email: p.email ?? null,
            snippet: noteSnippet(p.notes, name, p.title, needle),
            matched_on: MATCHED_ON[tier] ?? 'notes',
            touches: Number(p.touches ?? 0), last_touch: p.last_touch ?? null,
          },
        };
      })
      .filter((r) => r.tier >= 0)
      .sort((x, y) => x.tier - y.tier
        || y.out.touches - x.out.touches
        || tsDesc(x.out.last_touch, y.out.last_touch)
        || foldCmp(x.row.last_name, y.row.last_name)
        || foldCmp(x.row.first_name, y.row.first_name));
    const rankedCompanies = qa(db,
      'SELECT id, name, kind, sector, stage, domain, notes, tags FROM companies')
      .map((c) => {
        const nm = fold(c.name);
        const tier = nm.startsWith(nq) ? 0 : nm.includes(nq) ? 1
          : fold(c.domain).includes(nq) ? 2
            : fold(c.sector).includes(nq) ? 3
              : (fold(c.notes).includes(nq) || fold(c.tags).includes(nq)) ? 4 : -1;
        return { tier, name: c.name, out: { id: c.id, name: c.name, kind: c.kind, sector: c.sector, stage: c.stage } };
      })
      .filter((r) => r.tier >= 0)
      .sort((x, y) => x.tier - y.tier || foldCmp(x.name, y.name));
    // the totals are the uncapped match counts, so the UI can say "the 8 closest of 13"
    // instead of implying that 8 is all there is.
    return S(200, {
      people: rankedPeople.slice(0, 8).map((r) => r.out),
      companies: rankedCompanies.slice(0, 8).map((r) => r.out),
      people_total: rankedPeople.length,
      companies_total: rankedCompanies.length,
    });
  }

  err(404, 'not found');
}
