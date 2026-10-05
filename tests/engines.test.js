import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as warmth from '../engines/warmth.js';
import { scoreTarget } from '../engines/fit.js';
import { buildGraph, kShortestPaths, applyFailures, pathsToPerson, findICP } from '../engines/pathfinder.js';
import { buildCandidates, weeklyPlan, priorities, goingQuiet, goingQuietAll, quietTargetDays } from '../engines/allocator.js';

// Independent schema fixture for engine tests.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT,
  kind TEXT NOT NULL DEFAULT 'startup',
  sector TEXT DEFAULT '',
  stage TEXT DEFAULT '',
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
  seniority TEXT NOT NULL DEFAULT 'IC',
  dept TEXT DEFAULT '',
  location TEXT DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT DEFAULT '',
  is_me INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'roster',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  summary TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  dst_person INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  rel_type TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT 'medium',
  notes TEXT DEFAULT '',
  UNIQUE(src_person, dst_person, rel_type)
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'sourced',
  priority INTEGER NOT NULL DEFAULT 3,
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
CREATE TABLE IF NOT EXISTS failed_intros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_person INTEGER NOT NULL,
  dst_person INTEGER NOT NULL,
  created_at TEXT
);
`;

// Independent settings fixture for engine tests.
const WARMTH_CFG = {
  coefficients: { a1_recency: 2.2, a2_frequency: 0.9, a3_reciprocity: 1.4,
                  a4_seniority_touch: 0.8, a5_channel_diversity: 0.7, bias: -2.5 },
  half_life_days: 30,
  seniority_weights: { IC: 0.2, MGR: 0.4, DIR: 0.6, VP: 0.8, C: 1.0,
                       FOUNDER: 1.0, PARTNER: 1.0, ANGEL: 0.8, OTHER: 0.2 },
};
const PATH_CFG = {
  base_p: { family: 0.9, close_friend: 0.85, worked_with: 0.75, advises: 0.7,
            coinvestor: 0.7, invested_in: 0.65, studied_with: 0.6,
            introduced: 0.55, colleague: 0.5, knows: 0.45 },
  strength_factor: { weak: 0.7, medium: 1.0, strong: 1.2 },
  seniority_gap_penalty: 0.06,
  p_min: 0.05, p_max: 0.95,
  warm_tau: 0.35,
  k_paths: 3, max_hops: 5,
  epsilon_failed: 0.01, blast_radius_alpha: 0.5,
  colleague_company_cap: 25,
};
const ACTIONS = {
  follow_up_message:   { hours: 0.25 },
  news_congrats_note:  { hours: 0.25 },
  intro_request:       { hours: 0.5  },
  monthly_checkin:     { hours: 0.5  },
  coffee_chat:         { hours: 1.5  },
  deep_dive_call:      { hours: 1.0  },
  attend_their_event:  { hours: 3.0  },
  diligence_memo:      { hours: 4.0  },
};
const UPLIFTS = {
  default: 0.01,
  table: {
    follow_up_message:  { cold: { low: 0.03, mid: 0.04, high: 0.05 }, warm: { low: 0.02, mid: 0.03, high: 0.03 }, hot: { low: 0.01, mid: 0.01, high: 0.01 } },
    news_congrats_note: { cold: { low: 0.02, mid: 0.03, high: 0.03 }, warm: { low: 0.02, mid: 0.02, high: 0.03 }, hot: { low: 0.01, mid: 0.01, high: 0.01 } },
    intro_request:      { cold: { low: 0.01, mid: 0.01, high: 0.01 }, warm: { low: 0.03, mid: 0.04, high: 0.05 }, hot: { low: 0.05, mid: 0.06, high: 0.08 } },
    monthly_checkin:    { cold: { low: 0.03, mid: 0.04, high: 0.05 }, warm: { low: 0.02, mid: 0.03, high: 0.04 }, hot: { low: 0.01, mid: 0.01, high: 0.02 } },
    coffee_chat:        { cold: { low: 0.04, mid: 0.05, high: 0.06 }, warm: { low: 0.05, mid: 0.06, high: 0.07 }, hot: { low: 0.02, mid: 0.03, high: 0.04 } },
    deep_dive_call:     { cold: { low: -0.02, mid: -0.01, high: -0.01 }, warm: { low: 0.04, mid: 0.05, high: 0.07 }, hot: { low: 0.05, mid: 0.06, high: 0.08 } },
    attend_their_event: { cold: { low: 0.02, mid: 0.03, high: 0.04 }, warm: { low: 0.03, mid: 0.04, high: 0.06 }, hot: { low: 0.02, mid: 0.03, high: 0.05 } },
    diligence_memo:     { cold: { low: -0.03, mid: -0.02, high: 0.0 }, warm: { low: 0.02, mid: 0.04, high: 0.06 }, hot: { low: 0.04, mid: 0.06, high: 0.09 } },
  },
  buckets: { warmth: { cold: 0.35, warm: 0.70 } },
};
const CADENCE = { sourced: 21, contacted: 10, meeting: 7, diligence: 4, referred: 14 };

const NOW = new Date('2026-01-30T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400e3).toISOString();
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function openMem() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------- warmth ----------

test('warmth: hand-computed sigmoid on a fixed fixture', () => {
  const person = { id: 1, seniority: 'C' };
  const interactions = [
    { ts: daysAgo(10), kind: 'email', direction: 'outbound' },
    { ts: daysAgo(40), kind: 'call', direction: 'inbound' },
  ];
  const { score, components } = warmth.scorePerson(person, interactions, NOW, WARMTH_CFG);
  const rec = r4(2 ** (-10 / 30));
  assert.equal(components.recency_decay, rec);
  assert.equal(components.freq_90d, 2);
  assert.equal(components.reciprocity, 1);
  assert.equal(components.seniority_touch, 1.0);
  assert.equal(components.channel_diversity, 0.4);
  const z = 2.2 * rec + 0.9 * Math.log1p(2) + 1.4 * 1 + 0.8 * 1.0 + 0.7 * 0.4 + -2.5;
  assert.equal(score, r4(1 / (1 + Math.exp(-z))));
});

test('warmth: no interactions -> zeroed components, baseline sigmoid(bias)', () => {
  const { score, components } = warmth.scorePerson({ id: 1, seniority: 'C' }, [], NOW, WARMTH_CFG);
  assert.deepEqual(components, {
    recency_decay: 0, freq_90d: 0, reciprocity: 0, seniority_touch: 0, channel_diversity: 0,
  });
  assert.equal(score, r4(1 / (1 + Math.exp(2.5))));
});

test('warmth: monotonicity — more recent and reciprocal score higher', () => {
  const p = { id: 1, seniority: 'VP' };
  const one = (d) => [{ ts: daysAgo(d), kind: 'email', direction: 'outbound' }];
  assert.ok(warmth.scorePerson(p, one(3), NOW, WARMTH_CFG).score >
            warmth.scorePerson(p, one(60), NOW, WARMTH_CFG).score);
  const oneWay = [
    { ts: daysAgo(5), kind: 'email', direction: 'outbound' },
    { ts: daysAgo(6), kind: 'email', direction: 'outbound' },
  ];
  const reciprocal = [
    { ts: daysAgo(5), kind: 'email', direction: 'outbound' },
    { ts: daysAgo(6), kind: 'email', direction: 'inbound' },
  ];
  assert.ok(warmth.scorePerson(p, reciprocal, NOW, WARMTH_CFG).score >
            warmth.scorePerson(p, oneWay, NOW, WARMTH_CFG).score);
});

test('warmth: a touch dated in the future cannot decay past 1', () => {
  const person = { id: 1, seniority: 'C' };
  const future = [{ ts: new Date(NOW.getTime() + 300 * 86400e3).toISOString(), kind: 'email', direction: 'outbound' }];
  const { score, components } = warmth.scorePerson(person, future, NOW, WARMTH_CFG);
  // the age is clamped at 0, so the factor stays in [0,1] instead of printing 1096
  assert.equal(components.recency_decay, 1);
  assert.ok(score > 0 && score < 1);
  // and a future touch is worth no more than one logged today
  assert.equal(warmth.scorePerson(person, [{ ts: daysAgo(0), kind: 'email', direction: 'outbound' }],
    NOW, WARMTH_CFG).components.recency_decay, 1);
});

test('warmth: computeAll skips me, companyWarmth takes the max', () => {
  const db = openMem();
  db.prepare("INSERT INTO people (id, first_name, is_me) VALUES (1, 'Me', 1)").run();
  db.prepare("INSERT INTO people (id, first_name, seniority) VALUES (2, 'Ada', 'C')").run();
  db.prepare("INSERT INTO people (id, first_name, seniority) VALUES (3, 'Bob', 'IC')").run();
  db.prepare('INSERT INTO interactions (person_id, ts, kind, direction) VALUES (2, ?, ?, ?)')
    .run(daysAgo(2), 'call', 'inbound');
  const map = warmth.computeAll(db, WARMTH_CFG, NOW);
  assert.ok(!map.has(1));
  assert.ok(map.get(2).score > map.get(3).score);
  assert.ok(map.get(2).components.freq_90d === 1);
  assert.equal(warmth.companyWarmth(map, [{ id: 2 }, { id: 3 }]), map.get(2).score);
  assert.equal(warmth.companyWarmth(map, []), 0);
});

test('warmth: touches reports the evidence behind the score', () => {
  const person = { id: 1, seniority: 'C' };
  assert.equal(warmth.scorePerson(person, [], NOW, WARMTH_CFG).touches, 0);
  const three = [
    { ts: daysAgo(1), kind: 'email', direction: 'outbound' },
    { ts: daysAgo(4), kind: 'call', direction: 'inbound' },
    { ts: daysAgo(9), kind: 'meeting', direction: 'outbound' },
  ];
  assert.equal(warmth.scorePerson(person, three, NOW, WARMTH_CFG).touches, 3);

  const map = new Map([
    [2, { score: 0.9, components: {}, touches: 4 }],
    [3, { score: 0.2, components: {}, touches: 1 }],
  ]);
  assert.equal(warmth.companyTouches(map, [{ id: 2 }, { id: 3 }]), 5);
  assert.equal(warmth.companyTouches(map, []), 0);
  // fixtures built without `touches` must count as no evidence, not crash
  assert.equal(warmth.companyTouches(new Map([[9, { score: 0.5, components: {} }]]), [{ id: 9 }]), 0);
});

// ---------- fit ----------

test('fit: breakdown weights sum, in/contains/overlap ops', () => {
  const criteria = [
    { id: 'c1', label: 'Sector', weight: 2, field: 'company.sector', op: 'in', values: ['Fintech'] },
    { id: 'c2', label: 'AI tag', weight: 1, field: 'company.tags', op: 'overlap', values: ['ai'] },
    { id: 'c3', label: 'Founder title', weight: 1, field: 'person.title', op: 'contains', values: ['founder'] },
    { id: 'c4', label: 'Geo', weight: 4, field: 'company.geography', op: 'in', values: ['Paris'] },
  ];
  const target = {
    person: { title: 'Co-Founder & CEO' },
    company: { sector: 'FinTech', tags: '["AI","B2B"]', geography: 'Berlin' },
  };
  const { score, breakdown } = scoreTarget(target, criteria);
  assert.equal(breakdown.length, 4);
  const totalW = breakdown.reduce((s, b) => s + b.weight, 0);
  assert.equal(totalW, 8);
  const matchedW = breakdown.reduce((s, b) => s + (b.matched ? b.weight : 0), 0);
  assert.equal(matchedW, 4); // c1 + c2 + c3 match, c4 (Berlin != Paris) does not
  assert.equal(score, r4(matchedW / totalW));
  assert.deepEqual(breakdown.map((b) => b.matched), [true, true, true, false]);
  assert.deepEqual(breakdown.find((b) => b.id === 'c2').actual, ['AI', 'B2B']);
});

test('fit: person.* criterion on company-only target is unmatched; empty fields fail', () => {
  const criteria = [
    { id: 'p1', label: 'Seniority', weight: 1, field: 'person.seniority', op: 'in', values: ['FOUNDER'] },
    { id: 'k1', label: 'Kind', weight: 1, field: 'company.kind', op: 'in', values: ['startup'] },
    { id: 'g1', label: 'Geo', weight: 2, field: 'company.geography', op: 'in', values: ['Paris'] },
  ];
  const { score, breakdown } = scoreTarget({ company: { kind: 'startup', geography: '' } }, criteria);
  assert.equal(breakdown.find((b) => b.id === 'p1').matched, false);
  assert.equal(breakdown.find((b) => b.id === 'k1').matched, true);
  assert.equal(breakdown.find((b) => b.id === 'g1').matched, false); // empty actual
  assert.equal(score, 0.25); // 1 of weight-4 total
});

test('fit: no criteria -> score 0, empty breakdown', () => {
  const f = scoreTarget({ company: { sector: 'x' } }, []);
  assert.equal(f.score, 0);
  assert.deepEqual(f.breakdown, []);
  assert.equal(f.coverage, 0);
  assert.equal(f.total_weight, 0);
  assert.deepEqual(f.missing, []);
});

test('fit: an unrecorded field is `known: false`, not a mismatch', () => {
  const criteria = [
    { id: 'c1', label: 'Sector', weight: 1, field: 'company.sector', op: 'in', values: ['fintech'] },
    { id: 'c2', label: 'Stage', weight: 1, field: 'company.stage', op: 'in', values: ['seed'] },
    { id: 'c3', label: 'Geography', weight: 1, field: 'company.geography', op: 'in', values: ['FR'] },
  ];
  // c1 matches, c2 has a real value that does not match, c3 has nothing to test
  const f = scoreTarget({ company: { sector: 'Fintech', stage: 'series-b', geography: '   ' } }, criteria);
  assert.equal(f.score, r4(1 / 3), 'score is untouched by the new fields');
  assert.deepEqual(f.breakdown.map((b) => [b.matched, b.known]),
    [[true, true], [false, true], [false, false]]);
  assert.equal(f.total_weight, 3);
  assert.equal(f.known_weight, 2);
  assert.equal(f.coverage, r4(2 / 3));
  assert.deepEqual(f.missing, ['Geography']);

  // a tags array counts as known only when a non-empty entry survives
  const tagCrit = [{ id: 't', label: 'Tags', weight: 1, field: 'company.tags', op: 'overlap', values: ['ai'] }];
  assert.equal(scoreTarget({ company: { tags: '[]' } }, tagCrit).breakdown[0].known, false);
  assert.equal(scoreTarget({ company: { tags: '["  "]' } }, tagCrit).breakdown[0].known, false);
  assert.equal(scoreTarget({ company: { tags: '["b2b"]' } }, tagCrit).breakdown[0].known, true);

  // nothing recorded at all: 0% over a coverage of 0 is an absence, not a verdict
  const blank = scoreTarget({ company: { sector: '', stage: '', geography: null } }, criteria);
  assert.equal(blank.score, 0);
  assert.equal(blank.coverage, 0);
  assert.deepEqual(blank.missing, ['Sector', 'Stage', 'Geography']);
  // criteria with no label fall back to the field name so `missing` is never blank
  assert.deepEqual(scoreTarget({}, [{ id: 'x', weight: 1, field: 'company.sector', op: 'in', values: ['x'] }]).missing,
    ['company.sector']);
});

// ---------- pathfinder ----------

// Toy 6-node undirected graph; me = 1, target = 6.
// Best paths: [1,2,6] P=.72, [1,3,6] P=.595, [1,2,5,6] P=.486, [1,4,5,6] P=.459.
function toyGraph() {
  const nodes = new Map();
  const adj = new Map();
  for (let id = 1; id <= 6; id++) {
    nodes.set(id, { id, name: `N${id}`, title: '', company: '', is_me: id === 1 });
    adj.set(id, new Map());
  }
  const und = (u, v, p) => {
    adj.get(u).set(v, { p, components: { rel_type: 'knows', p } });
    adj.get(v).set(u, { p, components: { rel_type: 'knows', p } });
  };
  und(1, 2, 0.9); und(2, 6, 0.8);
  und(1, 3, 0.85); und(3, 6, 0.7);
  und(1, 4, 0.6); und(4, 5, 0.85); und(5, 6, 0.9);
  und(2, 5, 0.6);
  return { nodes, adj, meId: 1 };
}

test('pathfinder: kShortestPaths order and P values on the toy graph', () => {
  const paths = kShortestPaths(toyGraph(), 1, 6, 3, 5);
  assert.equal(paths.length, 3);
  assert.deepEqual(paths[0].nodeIds, [1, 2, 6]);
  assert.deepEqual(paths[1].nodeIds, [1, 3, 6]);
  assert.deepEqual(paths[2].nodeIds, [1, 2, 5, 6]);
  assert.equal(r4(paths[0].P), 0.72);
  assert.equal(r4(paths[1].P), 0.595);
  assert.equal(r4(paths[2].P), 0.486);
  assert.ok(paths[0].P >= paths[1].P && paths[1].P >= paths[2].P);
});

test('pathfinder: maxHops caps edge count per path', () => {
  const paths = kShortestPaths(toyGraph(), 1, 6, 3, 2);
  assert.equal(paths.length, 2); // 3-hop paths excluded
  assert.deepEqual(paths.map((p) => p.nodeIds), [[1, 2, 6], [1, 3, 6]]);
});

test('pathfinder: applyFailures drops the edge, damps siblings, reroutes', () => {
  const g = toyGraph();
  applyFailures(g, [{ src_person: 2, dst_person: 6 }],
    { epsilon_failed: 0.01, blast_radius_alpha: 0.5 });
  assert.equal(g.adj.get(2).get(6).p, 0.01);
  assert.equal(g.adj.get(2).get(6).components.failed, true);
  assert.equal(r4(g.adj.get(2).get(5).p), 0.3); // sibling 0.6 * 0.5
  assert.equal(g.adj.get(2).get(5).components.blast_radius_damped, 0.5);
  assert.equal(r4(g.adj.get(2).get(1).p), 0.45);
  assert.equal(g.adj.get(1).get(2).p, 0.9); // reverse direction untouched
  const paths = kShortestPaths(g, 1, 6, 3, 5);
  assert.deepEqual(paths[0].nodeIds, [1, 3, 6]); // rerouted around the failure
  assert.equal(r4(paths[0].P), 0.595);
  assert.deepEqual(paths[1].nodeIds, [1, 4, 5, 6]);
  assert.equal(r4(paths[1].P), 0.459);
});

// DB world: me(1, OTHER) -- warm --> Ada(2, C) -- worked_with/strong --> Tara(3, FOUNDER);
// alt route me -knows- Ivan(4, IC) -knows- Tara.
function seedPathWorld() {
  const db = openMem();
  db.prepare("INSERT INTO companies (id, name) VALUES (10, 'AlphaCo'), (11, 'BetaCo'), (12, 'GammaCo')").run();
  const person = db.prepare(
    'INSERT INTO people (id, first_name, last_name, title, seniority, company_id, is_me) VALUES (?,?,?,?,?,?,?)');
  person.run(1, 'Alex', 'Example', 'User', 'OTHER', null, 1);
  person.run(2, 'Ada', 'Warm', 'CTO', 'C', 10, 0);
  person.run(3, 'Tara', 'Target', 'Founder', 'FOUNDER', 11, 0);
  person.run(4, 'Ivan', 'Cold', 'Engineer', 'IC', 12, 0);
  const inter = db.prepare('INSERT INTO interactions (person_id, ts, kind, direction) VALUES (2, ?, ?, ?)');
  inter.run(daysAgo(1), 'email', 'inbound');
  inter.run(daysAgo(2), 'call', 'outbound');
  inter.run(daysAgo(5), 'meeting', 'inbound');
  inter.run(daysAgo(10), 'email', 'outbound');
  const rel = db.prepare('INSERT INTO relationships (src_person, dst_person, rel_type, strength) VALUES (?,?,?,?)');
  rel.run(2, 3, 'worked_with', 'strong');
  rel.run(1, 4, 'knows', 'medium');
  rel.run(4, 3, 'knows', 'medium');
  return db;
}

test('pathfinder: pathsToPerson uses warm_contact edge, then a failed intro reroutes', () => {
  const db = seedPathWorld();
  const cfgs = { path: PATH_CFG, warmth: WARMTH_CFG };
  const wmap = warmth.computeAll(db, WARMTH_CFG, NOW);
  assert.ok(wmap.get(2).score >= PATH_CFG.warm_tau);

  const res = pathsToPerson(db, 3, cfgs, NOW);
  assert.deepEqual(res.target, { id: 3, name: 'Tara Target', title: 'Founder', company: 'BetaCo' });
  assert.equal(res.paths.length, 2);
  const best = res.paths[0];
  assert.deepEqual(best.steps.map((s) => [s.from_id, s.to_id]), [[1, 2], [2, 3]]);
  assert.equal(best.steps[0].components.rel_type, 'warm_contact');
  assert.equal(best.steps[0].p, wmap.get(2).score);
  assert.equal(best.steps[1].components.rel_type, 'worked_with');
  // worked_with .75 * strong 1.2 * no gap (C vs FOUNDER both rank 4) = .9
  assert.equal(best.steps[1].p, 0.9);
  assert.equal(best.P, r4(wmap.get(2).score * 0.9));
  assert.equal(best.hops, 2);
  // alt path me -> Ivan (knows .45) -> Tara (knows .45 * (1 - .06*4) = .342)
  assert.deepEqual(res.paths[1].steps.map((s) => s.to_id), [4, 3]);
  assert.equal(res.paths[1].P, r4(0.45 * 0.342));

  // persist a failed intro Ada -> Tara: best route must now go through Ivan
  db.prepare('INSERT INTO failed_intros (src_person, dst_person) VALUES (2, 3)').run();
  const after = pathsToPerson(db, 3, cfgs, NOW);
  assert.deepEqual(after.paths[0].steps.map((s) => s.to_id), [4, 3]);
  assert.equal(after.paths[0].P, r4(0.45 * 0.342));
  const failedPath = after.paths.find((p) => p.steps.some((s) => s.components.failed));
  assert.ok(failedPath);
  assert.equal(failedPath.steps[1].p, 0.01);
});

test('pathfinder: buildGraph adds implicit colleague edges under the cap', () => {
  const db = openMem();
  db.prepare("INSERT INTO companies (id, name) VALUES (20, 'SmallCo')").run();
  const person = db.prepare(
    'INSERT INTO people (id, first_name, seniority, company_id, is_me) VALUES (?,?,?,?,?)');
  person.run(1, 'Me', 'OTHER', null, 1);
  person.run(5, 'Eve', 'IC', 20, 0);
  person.run(6, 'Finn', 'IC', 20, 0);
  const g = buildGraph(db, PATH_CFG, new Map());
  const e = g.adj.get(5).get(6);
  assert.equal(e.components.rel_type, 'colleague');
  assert.equal(e.p, 0.5); // colleague .5 * medium 1.0, no gap
  assert.ok(g.adj.get(6).has(5));
  assert.ok(!g.adj.get(1).has(5)); // never touches me
  // cap: with colleague_company_cap 1 no implicit edges appear
  const g2 = buildGraph(db, { ...PATH_CFG, colleague_company_cap: 1 }, new Map());
  assert.ok(!g2.adj.get(5).has(6));
  // explicit edge wins over implicit colleague
  db.prepare("INSERT INTO relationships (src_person, dst_person, rel_type, strength) VALUES (5, 6, 'close_friend', 'strong')").run();
  const g3 = buildGraph(db, PATH_CFG, new Map());
  assert.equal(g3.adj.get(5).get(6).components.rel_type, 'close_friend');
  assert.equal(g3.adj.get(5).get(6).p, 0.95); // .85*1.2 = 1.02 clipped to p_max
});

test('pathfinder: findICP ranks by fit * reach with full explainability', () => {
  const db = seedPathWorld();
  const cfgs = { path: PATH_CFG, warmth: WARMTH_CFG };
  const criteria = [
    { id: 't1', label: 'Founder', weight: 1, field: 'person.seniority', op: 'in', values: ['FOUNDER'] },
  ];
  const out = findICP(db, criteria, cfgs, { limit: 8 }, NOW).rows;
  assert.equal(out.length, 1); // only Tara matches (score > 0 filter)
  const hit = out[0];
  assert.equal(hit.person.id, 3);
  assert.equal(hit.person.company, 'BetaCo');
  assert.equal(hit.fit.score, 1);
  assert.equal(hit.fit.breakdown.length, 1);
  const wmap = warmth.computeAll(db, WARMTH_CFG, NOW);
  const bestP = r4(wmap.get(2).score * 0.9);
  assert.equal(hit.reach_p, bestP);
  assert.equal(hit.direct_warmth, wmap.get(3).score);
  assert.equal(hit.reach, Math.max(bestP, wmap.get(3).score));
  assert.equal(hit.rank_score, r4(1 * hit.reach));
  assert.ok(hit.paths.length >= 1);
  assert.equal(hit.paths[0].steps[0].components.rel_type, 'warm_contact');
});

test('pathfinder: findICP reports direct_touches so the 8% floor cannot pose as reach', () => {
  const out = findICP(seedPathWorld(),
    [{ id: 's', label: 'Senior', weight: 1, field: 'person.seniority', op: 'in', values: ['FOUNDER', 'C'] }],
    { path: PATH_CFG, warmth: WARMTH_CFG }, { limit: 8 }, NOW).rows;
  assert.equal(out.find((r) => r.person.id === 3).direct_touches, 0); // Tara: never contacted
  assert.equal(out.find((r) => r.person.id === 2).direct_touches, 4); // Ada: 4 logged touches
});

test("pathfinder: findICP order='fit' keeps high-fit strangers that rank order would cut", () => {
  const db = seedPathWorld();
  const cfgs = { path: PATH_CFG, warmth: WARMTH_CFG };
  // Tara fits perfectly but has never been contacted; Ada half-fits and is warm.
  const criteria = [
    { id: 'f', label: 'Founder', weight: 3, field: 'person.seniority', op: 'in', values: ['FOUNDER'] },
    { id: 'c', label: 'Senior', weight: 1, field: 'person.seniority', op: 'in', values: ['FOUNDER', 'C'] },
  ];
  const byFit = findICP(db, criteria, cfgs, { limit: 8, order: 'fit' }, NOW).rows;
  const byRank = findICP(db, criteria, cfgs, { limit: 8, order: 'rank' }, NOW).rows;
  assert.ok(byFit.length > 1 && byRank.length === byFit.length);
  // Each order is monotonic in its own key, so the client can rank on fit and on
  // warmth independently instead of only on the blended product.
  for (let i = 1; i < byFit.length; i++) {
    assert.ok(byFit[i - 1].fit.score >= byFit[i].fit.score, 'fit order is non-increasing in fit');
  }
  for (let i = 1; i < byRank.length; i++) {
    assert.ok(byRank[i - 1].rank_score >= byRank[i].rank_score, 'rank order is non-increasing in rank');
  }
  assert.equal(byFit[0].fit.score, Math.max(...byFit.map((r) => r.fit.score)));
  // Truncating on fit keeps the best thesis match even when it is not the best
  // rank: the never-contacted founder an import exists to surface.
  const top1 = findICP(db, criteria, cfgs, { limit: 1, order: 'fit' }, NOW).rows;
  assert.equal(top1[0].fit.score, 1);
});

// ---------- allocator ----------

function seedAllocWorld() {
  const db = openMem();
  db.prepare("INSERT INTO companies (id, name) VALUES (30, 'Alpha'), (31, 'Beta'), (32, 'WonCo')").run();
  db.prepare("INSERT INTO people (id, first_name, seniority, company_id) VALUES (40, 'Ada', 'C', 30)").run();
  const deal = db.prepare('INSERT INTO deals (id, company_id, stage, priority) VALUES (?,?,?,?)');
  deal.run(50, 30, 'meeting', 5);
  deal.run(51, 31, 'sourced', 1);
  deal.run(52, 32, 'won', 4);
  return db;
}
const ALLOC_CFGS = { actions: ACTIONS, uplifts: UPLIFTS, cadence: CADENCE };
const WMAP = new Map([[40, { score: 0.8, components: {} }]]);

test('allocator: buildCandidates buckets warmth/value and keeps components', () => {
  const candidates = buildCandidates(seedAllocWorld(), ALLOC_CFGS, WMAP);
  assert.equal(candidates.length, 16); // 2 active deals x 8 actions; won deal excluded
  assert.ok(!candidates.some((c) => c.company_id === 32));
  const intro = candidates.find((c) => c.company_id === 30 && c.action === 'intro_request');
  assert.deepEqual(intro.components,
    { warmth: 0.8, warmth_touches: 0, warmth_bucket: 'hot', conviction_tier: 'high', delta_p: 0.08, conviction: 5, hours: 0.5 });
  assert.equal(intro.u, 0.4); // 0.08 uplift x 5 conviction — unitless, not euros
  assert.equal(intro.deal_id, 50);
  // people_count sits at the TOP level (components' shape is pinned above): a company
  // with nobody recorded has no one to act against, and the card must be able to say so
  assert.equal(intro.people_count, 1);
  const memo = candidates.find((c) => c.company_id === 31 && c.action === 'diligence_memo');
  assert.equal(memo.components.warmth_bucket, 'cold');
  assert.equal(memo.components.conviction_tier, 'low');
  assert.equal(memo.delta_p, -0.03); // negative uplifts surface in candidates...
  assert.equal(memo.people_count, 0, 'Beta has a deal and nobody recorded at it');
  assert.ok(candidates.every((c) => typeof c.people_count === 'number'));
});

test('allocator: weeklyPlan respects budget, one per company, u/hour order, no negatives', () => {
  const db = seedAllocWorld();
  const { plan, budget } = weeklyPlan(db, ALLOC_CFGS, WMAP, 6);
  assert.equal(plan.length, 2);
  // hot/high intro_request has the best u/hour (40000); cold/low follow_up leads Beta (1200)
  assert.deepEqual(plan.map((c) => [c.company, c.action]),
    [['Alpha', 'intro_request'], ['Beta', 'follow_up_message']]);
  assert.equal(budget.hours_used, 0.75);
  assert.equal(budget.hours_budget, 6);
  const ids = plan.map((c) => c.company_id);
  assert.equal(new Set(ids).size, ids.length); // at most one action per company
  assert.ok(plan.every((c) => c.u > 0));   // ...but never get planned
  const ratio = (c) => c.u / Math.max(c.hours, 0.1);
  for (let i = 0; i + 1 < plan.length; i++) assert.ok(ratio(plan[i]) >= ratio(plan[i + 1]));

  const tight = weeklyPlan(db, ALLOC_CFGS, WMAP, 0.5);
  assert.deepEqual(tight.plan.map((c) => c.action), ['intro_request']);
  assert.equal(tight.budget.hours_used, 0.5);
});

test('allocator: goingQuiet ranks warm overdue contacts and excludes never-touched', () => {
  const db = openMem();
  db.prepare("INSERT INTO companies (id, name) VALUES (60, 'Quietco')").run();
  const person = db.prepare(
    'INSERT INTO people (id, first_name, last_name, title, seniority, company_id, is_me) VALUES (?,?,?,?,?,?,?)');
  person.run(1, 'Alex', 'Example', 'User', 'OTHER', null, 1);
  person.run(2, 'Nadia', 'Overdue', 'Partner', 'C', 60, 0);   // warm, 60d silent
  person.run(3, 'Remy', 'Recent', 'Founder', 'C', 60, 0);     // warm, touched 3d ago
  person.run(4, 'Nora', 'Newcard', 'Founder', 'C', null, 0);  // never touched
  person.run(5, 'Colin', 'Cold', 'Engineer', 'IC', null, 0);  // cold, 100d silent
  const inter = db.prepare('INSERT INTO interactions (person_id, ts, kind, direction) VALUES (?, ?, ?, ?)');
  const warmHistory = (pid, base) => {
    inter.run(pid, daysAgo(base), 'email', 'outbound');
    inter.run(pid, daysAgo(base + 10), 'call', 'inbound');
    inter.run(pid, daysAgo(base + 20), 'meeting', 'outbound');
    inter.run(pid, daysAgo(base + 35), 'email', 'inbound');
  };
  warmHistory(2, 60);
  warmHistory(3, 3);
  inter.run(5, daysAgo(100), 'email', 'outbound');

  const cfgs = { quiet: { target_days: 45, min_warmth: 0.35 } };
  const wmap = warmth.computeAll(db, WARMTH_CFG, NOW);
  const out = goingQuiet(db, cfgs, wmap, NOW, { limit: 6 });
  assert.deepEqual(out.map((r) => r.id), [2]); // recent, never-touched and cold all excluded
  const nadia = out[0];
  assert.equal(nadia.name, 'Nadia Overdue');
  assert.equal(nadia.company_name, 'Quietco');
  assert.equal(nadia.touches, 4);
  assert.equal(nadia.days_since, 60);
  assert.equal(nadia.target_days, 45);
  assert.equal(nadia.overdue, r4(60 / 45));
  assert.equal(nadia.quiet_score, r4(nadia.warmth * Math.min(60 / 45, 3)));
  assert.equal(nadia.reason, '60d since last touch (target 45d)');
  assert.ok(nadia.warmth >= 0.35);

  // a never-touched person has not "gone quiet" even with the warmth gate open
  const open = goingQuiet(db, { quiet: { target_days: 45, min_warmth: 0 } }, wmap, NOW, { limit: 25 });
  assert.ok(!open.some((r) => r.id === 4));
  assert.ok(open.some((r) => r.id === 5)); // the cold contact was only held back by min_warmth

  // the cap bites: 200d silent cannot outrank on neglect alone beyond 3x target
  person.run(6, 'Zoe', 'Ancient', 'CEO', 'C', 60, 0);
  warmHistory(6, 200);
  const capped = goingQuiet(db, cfgs, warmth.computeAll(db, WARMTH_CFG, NOW), NOW, { limit: 6 });
  const zoe = capped.find((r) => r.id === 6);
  assert.equal(zoe.overdue, r4(200 / 45));            // reported honestly...
  assert.equal(zoe.quiet_score, r4(zoe.warmth * 3));  // ...but scored at the cap
  assert.deepEqual(capped.map((r) => r.id), [6, 2]);  // sorted by quiet_score desc
});

test('allocator: priorities scores staleness against cadence per stage', () => {
  const db = seedAllocWorld();
  db.prepare('INSERT INTO interactions (person_id, ts, kind, direction) VALUES (40, ?, ?, ?)')
    .run(daysAgo(12), 'email', 'outbound');
  const out = priorities(db, ALLOC_CFGS, new Map(), NOW);
  assert.equal(out.length, 2); // won deal excluded
  const alpha = out.find((d) => d.company === 'Alpha');
  assert.equal(alpha.days_since, 12);
  assert.equal(alpha.staleness, r4(12 / 7));
  assert.equal(alpha.score, r4((5 / 5) * 1.0 * Math.min(12 / 7, 3)));
  assert.equal(alpha.reason, '12d since last touch (target 7d) at meeting stage');
  assert.equal(alpha.people_count, 1);
  const beta = out.find((d) => d.company === 'Beta');
  assert.equal(beta.days_since, 999);
  assert.equal(beta.score, r4((1 / 5) * 0.6 * 3)); // staleness capped at 3
  assert.equal(beta.reason, 'never touched (target 21d) at sourced stage');
  assert.equal(beta.people_count, 0, 'top of the queue with nobody to log a touch against');
  assert.deepEqual(out.map((d) => d.company), ['Alpha', 'Beta']); // sorted by score desc
});
