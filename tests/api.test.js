// tests/api.test.js — end-to-end API flow against an in-memory DB.
// Top-level tests run serially (node:test default), sharing one server + cookie jar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createServer } from '../server.js';

let server;
let base;
let cookie = '';
const ids = {}; // me, acme, ada, deal, icp, task...

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();

test.before(async () => {
  const db = openDb(':memory:');
  server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('auth: status, guard, setup', async () => {
  let r = await api('GET', '/api/auth/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { app: 'crm-plus', setup: false, authed: false, me: null });

  r = await api('GET', '/api/people');
  assert.equal(r.status, 401);
  assert.deepEqual(r.data, { error: 'unauthorized' });

  r = await api('POST', '/api/auth/setup', { password: 'hunter2 secret', my_name: 'Alex Example' });
  assert.equal(r.status, 200);
  assert.ok(cookie.startsWith('crm_plus_sid='), 'setup returns session cookie');

  r = await api('POST', '/api/auth/setup', { password: 'again' });
  assert.equal(r.status, 409);

  r = await api('GET', '/api/auth/status');
  assert.equal(r.data.setup, true);
  assert.equal(r.data.authed, true);
  assert.equal(r.data.me.first_name, 'Alex');
  assert.equal(r.data.me.is_me, 1);
  ids.me = r.data.me.id;
});

test('auth: logout / login round-trip', async () => {
  let r = await api('POST', '/api/auth/logout');
  assert.equal(r.status, 200);
  r = await api('GET', '/api/auth/status');
  assert.equal(r.data.authed, false);
  r = await api('GET', '/api/people');
  assert.equal(r.status, 401);

  r = await api('POST', '/api/auth/login', { password: 'wrong' });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/auth/login', { password: 'hunter2 secret' });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/auth/status');
  assert.equal(r.data.authed, true);
});

test('companies, people, interactions -> warmth on list', async () => {
  let r = await api('POST', '/api/companies', {
    name: 'Acme AI', kind: 'startup', sector: 'ai infra', stage: 'seed', geography: 'Paris',
  });
  assert.equal(r.status, 201);
  ids.acme = r.data.id;

  r = await api('POST', '/api/people', {
    first_name: 'Ada', last_name: 'Lovelace', company_id: ids.acme,
    title: 'CTO', seniority: 'C', dept: 'eng', tags: ['founder-adjacent'],
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.tags, ['founder-adjacent']);
  ids.ada = r.data.id;

  // company auto-create by name
  r = await api('POST', '/api/people', { first_name: 'Linus', company_name: 'Kernel Labs' });
  assert.equal(r.status, 201);
  assert.ok(r.data.company_id, 'auto-created company id set');
  ids.linus = r.data.id;

  // create + delete throwaway person -> 404 after delete
  r = await api('POST', '/api/people', { first_name: 'Temp', last_name: 'Guy' });
  const tempId = r.data.id;
  r = await api('DELETE', `/api/people/${tempId}`);
  assert.equal(r.status, 200);
  r = await api('GET', `/api/people/${tempId}`);
  assert.equal(r.status, 404);

  r = await api('POST', '/api/interactions', {
    person_id: ids.ada, kind: 'email', direction: 'inbound', summary: 'intro thread',
  });
  assert.equal(r.status, 201);
  r = await api('POST', '/api/interactions', {
    person_id: ids.ada, kind: 'meeting', direction: 'outbound', summary: 'coffee', ts: daysAgo(5),
  });
  assert.equal(r.status, 201);

  r = await api('GET', '/api/people');
  assert.equal(r.status, 200);
  const ada = r.data.find((p) => p.id === ids.ada);
  assert.ok(ada, 'ada in list');
  assert.ok(ada.warmth > 0, 'warmth > 0 after interactions');
  assert.equal(ada.company_name, 'Acme AI');
  assert.ok(ada.last_touch, 'last_touch set');
  assert.equal(r.data[0].id, ids.ada, 'list sorted by warmth desc');
  assert.ok(!r.data.some((p) => p.id === ids.me), 'me excluded from people list');

  r = await api('GET', `/api/people/${ids.ada}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.warmth.score > 0);
  assert.ok('recency_decay' in r.data.warmth.components);
  assert.equal(r.data.interactions.length, 2);
  assert.equal(r.data.company.name, 'Acme AI');
});

test('relationships: create + duplicate 409', async () => {
  let r = await api('POST', '/api/relationships', {
    src_person: ids.me, dst_person: ids.ada, rel_type: 'worked_with',
  });
  assert.equal(r.status, 201);
  r = await api('POST', '/api/relationships', {
    src_person: ids.ada, dst_person: ids.me, rel_type: 'worked_with',
  });
  assert.equal(r.status, 409, 'reverse orientation same type is a duplicate');
  r = await api('GET', `/api/people/${ids.ada}`);
  const rel = r.data.relationships.find((x) => x.rel_type === 'worked_with');
  assert.ok(rel && rel.other && rel.other.name === 'Alex Example');
});

test('deal -> plan non-empty -> priorities', async () => {
  let r = await api('POST', '/api/deals', { company_id: ids.acme, stage: 'meeting', priority: 4 });
  assert.equal(r.status, 201);
  ids.deal = r.data.id;
  r = await api('POST', '/api/deals', { company_id: ids.acme });
  assert.equal(r.status, 409, 'one deal per company');

  r = await api('GET', '/api/deals');
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].company_name, 'Acme AI');

  r = await api('GET', '/api/plan?hours=6');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.plan) && r.data.plan.length >= 1, 'plan non-empty');
  assert.equal(r.data.budget.hours_budget, 6);
  assert.ok(r.data.budget.hours_used <= 6);
  const pick = r.data.plan[0];
  assert.equal(pick.company, 'Acme AI');
  assert.ok(pick.u > 0);
  assert.equal(pick.conviction, 4, 'conviction is the weight, not an invented euro value');
  assert.ok(!('u_eur' in pick) && !('value_eur' in pick), 'no fabricated money in the plan');
  assert.ok(pick.components && pick.components.warmth_bucket);

  r = await api('GET', '/api/priorities');
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 1);
  assert.equal(r.data[0].company, 'Acme AI');
  assert.ok('staleness' in r.data[0] && 'reason' in r.data[0]);
});

test('icp create -> path/icp ranked targets -> path/person', async () => {
  let r = await api('POST', '/api/icp', {
    name: 'CTO ICP',
    criteria: [{ id: 'c1', label: 'C-level', weight: 1, field: 'person.seniority', op: 'in', values: ['C'] }],
  });
  assert.equal(r.status, 201);
  ids.icp = r.data.id;

  r = await api('GET', '/api/icp');
  assert.equal(r.data.length, 1);
  assert.ok(Array.isArray(r.data[0].criteria), 'criteria parsed');

  r = await api('POST', '/api/path/icp', { icp_id: ids.icp });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.rows) && r.data.rows.length >= 1, 'ranked targets returned');
  assert.ok(r.data.scanned >= 1 && Array.isArray(r.data.coverage), 'scope context travels with the rows');
  const top = r.data.rows[0];
  assert.equal(top.person.id, ids.ada);
  const fitScore = typeof top.fit === 'number' ? top.fit : top.fit.score;
  assert.ok(fitScore > 0);
  assert.ok(top.rank_score > 0);
  assert.ok('reach' in top && 'reach_p' in top && 'direct_warmth' in top);

  r = await api('POST', '/api/path/icp', { criteria: [{ id: 'x', label: 'x', weight: 1, field: 'person.seniority', op: 'in', values: ['C'] }] });
  assert.equal(r.status, 200, 'inline criteria accepted');

  r = await api('POST', '/api/path/person', { target_person_id: ids.ada });
  assert.equal(r.status, 200);
  assert.equal(r.data.target.id, ids.ada);
  assert.ok(Array.isArray(r.data.paths) && r.data.paths.length >= 1, 'warm contact yields a path');
  assert.ok(r.data.paths[0].P > 0.3);
  assert.ok(r.data.paths[0].steps[0].from_id === ids.me);

  r = await api('POST', '/api/path/person', { target_person_id: 99999 });
  assert.equal(r.status, 404);
});

test('linkedin CSV import (Notes: preamble, quoted fields, CRLF)', async () => {
  const csv = [
    'Notes:',
    '"When exporting your connection data, you may notice that some emails are missing.',
    'You will only see emails for connections who allowed it."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Grace,Hopper,https://linkedin.example/in/gracehopper,grace@example.com,US Navy,"Rear Admiral, Computing",18 Mar 2024',
    'Alan,Turing,https://linkedin.example/in/alanturing,,Bletchley Park,Mathematician,05 Jan 2023',
    'Ada,Lovelace,https://linkedin.example/in/adalovelace,,Analytical Engines,Countess,01 Feb 2022',
  ].join('\r\n');

  let r = await api('POST', '/api/import/linkedin', { csv });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { created_people: 2, created_companies: 2, skipped: 1 });

  r = await api('GET', '/api/people?q=Hopper&tier=network');
  assert.equal(r.data.length, 1);
  const grace = r.data[0];
  assert.equal(grace.company_name, 'US Navy');
  assert.equal(grace.title, 'Rear Admiral, Computing');
  // An accepted connection request is not a conversation: the import must NOT
  // fabricate contact, or every imported person shows a confident sigmoid-floor
  // warmth. Zero touches means the UI reads "not scored yet" instead.
  assert.equal(grace.touches, 0);
  assert.equal(grace.last_touch, null);
  assert.ok(grace.created_at.startsWith('2024-03-18'), 'connection date kept on the person');

  r = await api('GET', `/api/people/${grace.id}`);
  assert.equal(r.data.interactions.length, 0);
  assert.ok(r.data.relationships.some((x) => x.rel_type === 'knows' && x.other && x.other.name === 'Alex Example'));
});


test('tasks lifecycle', async () => {
  let r = await api('POST', '/api/tasks', { title: 'Call Ada', person_id: ids.ada, due: daysAgo(1) });
  assert.equal(r.status, 201);
  ids.task = r.data.id;
  r = await api('GET', '/api/tasks?open=1');
  assert.equal(r.data.length, 1);
  r = await api('GET', `/api/people/${ids.ada}`);
  assert.equal(r.data.open_tasks.length, 1);
  r = await api('PATCH', `/api/tasks/${ids.task}`, { done: true });
  assert.equal(r.data.done, 1);
  r = await api('GET', '/api/tasks?open=1');
  assert.equal(r.data.length, 0);
});

test('overview counts, search, demo guard', async () => {
  let r = await api('GET', '/api/overview');
  assert.equal(r.status, 200);
  // Roster only: Ada and Linus were added by hand. Grace and Alan arrived in the
  // LinkedIn import, so they sit in the network tier and must not inflate the one
  // number on the home screen.
  assert.equal(r.data.counts.people, 2);
  assert.equal(r.data.counts.network, 2);
  // Acme AI and Kernel Labs. US Navy and Bletchley Park belong to imported
  // people only, so they are background too.
  assert.equal(r.data.counts.companies, 2);
  assert.equal(r.data.counts.active_deals, 1);
  assert.equal(r.data.counts.open_tasks, 0);
  assert.equal(r.data.pipeline.meeting, 1);
  assert.ok(Array.isArray(r.data.priorities));
  assert.ok(r.data.plan && Array.isArray(r.data.plan.plan));
  assert.equal(r.data.warm_contacts[0].id, ids.ada, 'ada is warmest contact');

  r = await api('GET', '/api/companies');
  assert.equal(r.data.length, 4);
  const acme = r.data.find((c) => c.id === ids.acme);
  assert.equal(acme.deal_stage, 'meeting');
  assert.equal(acme.deal_id, ids.deal);
  assert.ok(acme.max_warmth > 0);
  assert.equal(acme.people_count, 1);

  r = await api('GET', `/api/companies/${ids.acme}`);
  assert.equal(r.data.people.length, 1);
  assert.equal(r.data.deal.id, ids.deal);
  assert.ok(Array.isArray(r.data.fits) && r.data.fits.length >= 1);

  r = await api('GET', '/api/search?q=ada');
  assert.ok(r.data.people.length >= 1);
  r = await api('GET', '/api/search?q=acme');
  assert.ok(r.data.companies.length >= 1);

  r = await api('POST', '/api/demo');
  assert.equal(r.status, 404, 'the demo world is gone: no fictional data ships');
});

test('settings: get, put, unknown key', async () => {
  let r = await api('GET', '/api/settings/warmth');
  assert.equal(r.status, 200);
  assert.equal(r.data.coefficients.a1_recency, 2.2);
  assert.equal(r.data.half_life_days, 30);

  r = await api('GET', '/api/settings/nope');
  assert.equal(r.status, 400);
  r = await api('GET', '/api/settings/auth');
  assert.equal(r.status, 400, 'auth blob is not exposed via settings');

  r = await api('PUT', '/api/settings/plan', { weekly_hours: 8 });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/settings/plan');
  assert.equal(r.data.weekly_hours, 8);
});

// ---- P0: no score without its evidence ----

test('people and company lists carry touch evidence and a warmest person', async () => {
  let r = await api('GET', '/api/people');
  const ada = r.data.find((p) => p.id === ids.ada);
  assert.equal(ada.touches, 2, 'two logged interactions behind the score');
  const linus = r.data.find((p) => p.id === ids.linus);
  assert.equal(linus.touches, 0, 'never touched -> the score is the floor, not a measurement');
  assert.equal(linus.last_touch, null);

  r = await api('GET', `/api/people/${ids.ada}`);
  assert.equal(r.data.warmth.touches, 2, 'the person payload carries touches too');

  r = await api('POST', '/api/companies', { name: 'Empty Ventures', kind: 'fund' });
  const emptyId = r.data.id;

  r = await api('GET', '/api/companies');
  const acme = r.data.find((c) => c.id === ids.acme);
  assert.equal(acme.touches, 2);
  assert.ok(acme.last_touch, 'company last touch is the max over its people');
  assert.deepEqual(acme.warmest_person, { id: ids.ada, name: 'Ada Lovelace' });
  const empty = r.data.find((c) => c.id === emptyId);
  assert.equal(empty.touches, 0);
  assert.equal(empty.last_touch, null);
  assert.equal(empty.warmest_person, null, 'no people -> no warmest person');

  r = await api('GET', `/api/companies/${ids.acme}`);
  const adaRow = r.data.people.find((p) => p.id === ids.ada);
  assert.equal(adaRow.touches, 2);
  assert.ok(adaRow.last_touch);
});

test('tasks name the person and company they are about', async () => {
  let r = await api('POST', '/api/tasks', { title: 'Intro Ada to the partner', person_id: ids.ada });
  const withPerson = r.data.id;
  r = await api('POST', '/api/tasks', { title: 'Write the weekly digest', company_id: ids.acme });
  const withoutPerson = r.data.id;

  r = await api('GET', '/api/tasks?open=1');
  const t1 = r.data.find((t) => t.id === withPerson);
  assert.equal(t1.person_name, 'Ada Lovelace');
  assert.equal(t1.company_name, null);
  assert.equal(t1.person_id, ids.ada, 'existing columns preserved');
  assert.equal(t1.done, 0);
  const t2 = r.data.find((t) => t.id === withoutPerson);
  assert.equal(t2.person_name, null, 'a task with no person says null, not an empty name');
  assert.equal(t2.company_name, 'Acme AI');

  r = await api('GET', '/api/tasks');
  assert.equal(r.data.find((t) => t.id === withPerson).person_name, 'Ada Lovelace');
  assert.ok(r.data.some((t) => t.id === ids.task && t.done === 1), 'done tasks still listed unfiltered');
});

test('person page answers deal, fit and colleagues', async () => {
  let r = await api('POST', '/api/people', {
    first_name: 'Bob', last_name: 'Builder', company_id: ids.acme, title: 'VP Eng', seniority: 'VP',
  });
  assert.equal(r.status, 201);
  ids.bob = r.data.id;

  r = await api('GET', `/api/people/${ids.ada}`);
  assert.equal(r.data.deal.id, ids.deal, 'the fund has already looked at this company');
  assert.equal(r.data.deal.stage, 'meeting');
  assert.equal(r.data.deal.company_id, ids.acme);
  assert.equal(typeof r.data.deal.next_step, 'string');
  const cto = r.data.fits.find((f) => f.icp_id === ids.icp);
  assert.equal(cto.icp_name, 'CTO ICP');
  assert.equal(cto.score, 1, 'person.seniority resolves in the person-aware fit');
  assert.deepEqual(r.data.colleagues.map((c) => c.id), [ids.bob]);
  const bob = r.data.colleagues[0];
  assert.equal(bob.name, 'Bob Builder');
  assert.equal(bob.title, 'VP Eng');
  assert.equal(bob.touches, 0);
  assert.equal(bob.last_touch, null);
  assert.equal(typeof bob.warmth, 'number');

  r = await api('GET', `/api/people/${ids.bob}`);
  assert.deepEqual(r.data.colleagues.map((c) => c.id), [ids.ada], 'colleagues exclude the person themselves');

  r = await api('POST', '/api/people', { first_name: 'Solo', last_name: 'Founder' });
  r = await api('GET', `/api/people/${r.data.id}`);
  assert.equal(r.data.deal, null);
  assert.deepEqual(r.data.colleagues, [], 'no company -> no colleagues, not undefined');
  assert.ok(Array.isArray(r.data.fits));
});

test('quiet surfaces warm contacts that have gone silent', async () => {
  let r = await api('GET', '/api/settings/quiet');
  assert.equal(r.status, 200);
  assert.equal(r.data.target_days, 45);
  // 0.15, not 0.35: warmth already contains the recency term, so a contact who
  // is overdue has decayed in the same motion that made them overdue. At 0.35
  // the gate is empty by construction (0 people on the demo world) — see the
  // single-old-touch case below, which is the S7 shape the card exists for.
  assert.equal(r.data.min_warmth, 0.15);

  r = await api('POST', '/api/people', { first_name: 'Qi', last_name: 'Quiet', title: 'Founder', seniority: 'C' });
  const qi = r.data.id;
  for (const [days, kind, direction] of [[60, 'email', 'outbound'], [70, 'call', 'inbound'],
    [80, 'meeting', 'outbound'], [95, 'email', 'inbound']]) {
    r = await api('POST', '/api/interactions', { person_id: qi, kind, direction, ts: daysAgo(days) });
    assert.equal(r.status, 201);
  }

  r = await api('GET', '/api/quiet');
  assert.equal(r.status, 200);
  const row = r.data.people.find((p) => p.id === qi);
  assert.ok(row, 'a warm contact 60 days silent reaches the home screen without a deal');
  assert.equal(row.name, 'Qi Quiet');
  assert.equal(row.touches, 4);
  assert.equal(row.target_days, 45);
  assert.equal(row.company_id, null);
  assert.equal(row.company_name, null);
  assert.match(row.reason, /^\d+d since last touch \(target 45d\)$/);
  assert.ok(row.warmth >= 0.15 && row.overdue >= 1);
  assert.ok(!r.data.people.some((p) => p.id === ids.ada), 'ada was touched today');
  assert.ok(!r.data.people.some((p) => p.id === ids.bob), 'never-touched people have not gone quiet');

  // The S7 shape, and the case a 0.35 gate silently drops: ONE touch, months ago.
  // "Promised a founder an intro in April, never did it" leaves exactly one
  // interaction and a warmth around 0.18 — if this person cannot reach the card,
  // the card is decorative.
  r = await api('POST', '/api/people', { first_name: 'Una', last_name: 'Once', title: 'Founder', seniority: 'C' });
  const una = r.data.id;
  r = await api('POST', '/api/interactions', { person_id: una, kind: 'meeting', direction: 'outbound', ts: daysAgo(163) });
  assert.equal(r.status, 201);
  r = await api('GET', '/api/quiet?limit=25');
  const uRow = r.data.people.find((p) => p.id === una);
  assert.ok(uRow, 'a single touch 163 days ago reaches the going-quiet card');
  assert.equal(uRow.touches, 1);
  assert.equal(uRow.reason, '163d since last touch (target 45d)');
  assert.ok(uRow.warmth < 0.35, 'and its warmth is below the old 0.35 gate, which is why that gate flagged nobody');
  // the min(overdue, 3) cap bites at 163/45 = 3.62
  assert.equal(uRow.quiet_score, Number((uRow.warmth * 3).toFixed(4)));

  r = await api('GET', '/api/quiet?limit=1');
  assert.equal(r.data.people.length, 1);
  r = await api('GET', '/api/quiet?limit=0');
  assert.equal(r.status, 200, 'limit clamps instead of erroring');
  assert.ok(r.data.people.length >= 1);

  // the two numbers are live config, not constants
  r = await api('PUT', '/api/settings/quiet', { target_days: 200, min_warmth: 0.15 });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/quiet');
  assert.ok(!r.data.people.some((p) => p.id === qi), '60 days is not overdue against a 200-day target');
  await api('PUT', '/api/settings/quiet', { target_days: 45, min_warmth: 0.15 });
});

// ---- P1: the data stays usable at 400 people ----

test('company name variants resolve to one company', async () => {
  let r = await api('GET', `/api/people/${ids.linus}`);
  const kernelId = r.data.person.company_id;
  assert.ok(kernelId);

  r = await api('POST', '/api/people', { first_name: 'Linus', last_name: 'Two', company_name: 'Kernel  Labs' });
  assert.equal(r.status, 201);
  assert.equal(r.data.company_id, kernelId, 'a double space is not a second company');
  r = await api('POST', '/api/people', { first_name: 'Linus', last_name: 'Three', company_name: '  kernel labs ' });
  assert.equal(r.data.company_id, kernelId, 'nor is case or padding');
  r = await api('GET', '/api/companies?q=Kernel');
  assert.equal(r.data.length, 1);
});

test('people/dupes advises on capture without blocking it', async () => {
  let r = await api('GET', '/api/people/dupes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { candidates: [] }, 'no params is an empty answer, not a 400');

  r = await api('GET', '/api/people/dupes?first_name=Ad&last_name=lovelace');
  const hit = r.data.candidates.find((c) => c.id === ids.ada);
  assert.ok(hit, 'same last name + first-name prefix is a candidate');
  assert.equal(hit.name, 'Ada Lovelace');
  assert.equal(hit.company_name, 'Acme AI');
  assert.equal(hit.touches, 2);
  assert.ok(hit.last_touch);

  r = await api('GET', '/api/people/dupes?first_name=A&last_name=Lovelace');
  assert.deepEqual(r.data.candidates, [], 'a single initial is too weak to claim a duplicate');

  r = await api('GET', '/api/people/dupes?email=GRACE@EXAMPLE.COM');
  assert.ok(r.data.candidates.some((c) => c.name === 'Grace Hopper'), 'email match is case-insensitive');

  const url = encodeURIComponent('https://LINKEDIN.example/in/gracehopper');
  r = await api('GET', `/api/people/dupes?linkedin_url=${url}`);
  assert.ok(r.data.candidates.some((c) => c.name === 'Grace Hopper'));

  r = await api('GET', '/api/people/dupes?first_name=Nobody&last_name=Here');
  assert.deepEqual(r.data.candidates, []);

  r = await api('POST', '/api/people', { first_name: 'Ada', last_name: 'Lovelace' });
  assert.equal(r.status, 201, 'detection is advisory: capture always succeeds');
});

test('notes and tags are searchable, with a snippet saying why', async () => {
  const enc = (s) => encodeURIComponent(s);
  let r = await api('POST', '/api/people', {
    first_name: 'Nora', last_name: 'Notes', title: 'CEO',
    notes: 'Station F demo day - eval tooling', tags: ['demo-day-2026'],
  });
  const nora = r.data.id;

  for (const needle of ['Station F', 'eval tooling', 'demo-day-2026']) {
    r = await api('GET', `/api/search?q=${enc(needle)}`);
    assert.ok(r.data.people.some((p) => p.id === nora), `/api/search finds "${needle}"`);
    r = await api('GET', `/api/people?q=${enc(needle)}`);
    assert.ok(r.data.some((p) => p.id === nora), `/api/people finds "${needle}"`);
  }

  r = await api('GET', `/api/search?q=${enc('Station F')}`);
  assert.equal(r.data.people.find((p) => p.id === nora).snippet, 'Station F demo day - eval tooling');
  r = await api('GET', `/api/search?q=${enc('Nora')}`);
  assert.equal(r.data.people.find((p) => p.id === nora).snippet, null, 'a name match needs no snippet');
});

test('path/fail refuses unknown people (D-7)', async () => {
  let r = await api('POST', '/api/path/fail', { src_person: ids.me, dst_person: 99999 });
  assert.equal(r.status, 404);
  assert.deepEqual(r.data, { error: 'person not found' });
  r = await api('POST', '/api/path/fail', { src_person: 99999, dst_person: ids.ada });
  assert.equal(r.status, 404);
  r = await api('GET', '/api/path/fails');
  assert.equal(r.data.length, 0, 'failed_intros cannot be poisoned with junk ids');

  r = await api('POST', '/api/path/fail', { src_person: ids.me, dst_person: ids.ada });
  assert.equal(r.status, 201);
  r = await api('GET', '/api/path/fails');
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].dst_name, 'Ada Lovelace');
  r = await api('DELETE', `/api/path/fail/${r.data[0].id}`);
  assert.equal(r.status, 200);
});

// ---- P0: a name he can spell is a name he can find ----

test('search folds accents and reaches email and company name', async () => {
  let r = await api('POST', '/api/people', {
    first_name: 'Hélène', last_name: 'Garnier', title: 'General Partner',
    email: 'helene.garnier@example.com', company_name: 'Faubourg Capital',
  });
  assert.equal(r.status, 201);
  ids.helene = r.data.id;
  r = await api('POST', '/api/people', {
    first_name: 'Søren', last_name: 'Krüger', title: 'Operator angel', email: 'sk@velumtest.example',
  });
  assert.equal(r.status, 201);
  ids.soren = r.data.id;

  // the spelling he can actually type at 23:10
  for (const [needle, pid] of [['helene', ids.helene], ['garnier', ids.helene],
    ['soren', ids.soren], ['kruger', ids.soren]]) {
    r = await api('GET', `/api/search?q=${needle}`);
    const hit = r.data.people.find((p) => p.id === pid);
    assert.ok(hit, `"${needle}" finds the accented name`);
    assert.equal(hit.matched_on, 'name');
    assert.equal(typeof r.data.people_total, 'number');
    assert.equal(typeof r.data.companies_total, 'number');
  }

  // by email, when the name carries none of the needle
  r = await api('GET', '/api/search?q=velumtest');
  let hit = r.data.people.find((p) => p.id === ids.soren);
  assert.ok(hit, 'the email column is searchable');
  assert.equal(hit.matched_on, 'email');
  assert.equal(hit.email, 'sk@velumtest.example');

  // by where they work
  r = await api('GET', '/api/search?q=faubourg');
  hit = r.data.people.find((p) => p.id === ids.helene);
  assert.ok(hit, 'a person is findable by their company');
  assert.equal(hit.matched_on, 'company');
  assert.equal(hit.company_name, 'Faubourg Capital');
  assert.ok(r.data.companies.some((c) => c.name === 'Faubourg Capital'));
  assert.ok(r.data.people_total >= 1 && r.data.companies_total >= 1);

  // the People page filter and the global bar cannot disagree about who exists
  for (const needle of ['helene', 'kruger', 'velumtest', 'faubourg', 'ada']) {
    const g = await api('GET', `/api/search?q=${needle}`);
    const l = await api('GET', `/api/people?q=${needle}`);
    for (const p of g.data.people) {
      assert.ok(l.data.some((x) => x.id === p.id), `/api/people?q=${needle} also knows ${p.name}`);
    }
  }
});

test('people/dupes catches a one-name card and an unaccented spelling', async () => {
  let r = await api('GET', '/api/people/dupes?first_name=Ada');
  assert.ok(r.data.candidates.some((c) => c.id === ids.ada),
    'a business card with only a first name still finds the existing Ada');
  r = await api('GET', '/api/people/dupes?first_name=Ad');
  assert.deepEqual(r.data.candidates, [], 'with no surname to corroborate, a prefix is not a claim');
  r = await api('GET', '/api/people/dupes?first_name=A');
  assert.deepEqual(r.data.candidates, [], 'a single initial is still too weak');

  r = await api('GET', '/api/people/dupes?first_name=Helene&last_name=garnier');
  const helene = r.data.candidates.find((c) => c.id === ids.helene);
  assert.ok(helene, 'the unaccented spelling of an accented name is a candidate');
  assert.equal(helene.name, 'Hélène Garnier');
  assert.equal(helene.company_name, 'Faubourg Capital');
  r = await api('GET', '/api/people/dupes?first_name=soren');
  assert.ok(r.data.candidates.some((c) => c.id === ids.soren), 'ø folds to o on both sides');

  r = await api('POST', '/api/people', { first_name: 'Hélène', last_name: 'Garnier' });
  assert.equal(r.status, 201, 'detection stays advisory: capture always succeeds');
});

// ---- P1: one mistyped year must not file a founder as warm forever ----

test('interactions refuse a date in the future and a date that is not one', async () => {
  let r = await api('POST', '/api/people', { first_name: 'Fu', last_name: 'Ture', seniority: 'FOUNDER' });
  const fu = r.data.id;

  r = await api('POST', '/api/interactions', {
    person_id: fu, kind: 'call', ts: new Date(Date.now() + 365 * 86400e3).toISOString(),
  });
  assert.equal(r.status, 400);
  assert.deepEqual(r.data, { error: 'that date is in the future — pick the day you actually spoke' });

  r = await api('POST', '/api/interactions', { person_id: fu, kind: 'call', ts: 'last tuesday' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.data, { error: "that date didn't make sense — pick the day you spoke" });

  r = await api('GET', `/api/people/${fu}`);
  assert.equal(r.data.interactions.length, 0, 'a rejected date inserts nothing');

  r = await api('POST', '/api/interactions', { person_id: fu, kind: 'call', ts: daysAgo(3) });
  assert.equal(r.status, 201);
  assert.ok(Date.parse(r.data.ts) <= Date.now());
  r = await api('POST', '/api/interactions', { person_id: fu, kind: 'email' });
  assert.equal(r.status, 201, 'an omitted ts still defaults to now');

  r = await api('GET', `/api/people/${fu}`);
  assert.equal(r.data.interactions.length, 2);
  assert.ok(r.data.warmth.components.recency_decay <= 1, 'the decay factor stays a factor');
});

test('a company page carries its own open promises and its people\'s', async () => {
  let r = await api('POST', '/api/tasks', { title: 'Send Acme the thesis note', company_id: ids.acme });
  const companyTask = r.data.id;
  r = await api('POST', '/api/tasks', { title: 'Intro Ada to Hélène', person_id: ids.ada });
  const personTask = r.data.id;
  r = await api('POST', '/api/tasks', { title: 'Kept promise', company_id: ids.acme });
  const keptTask = r.data.id;
  await api('PATCH', `/api/tasks/${keptTask}`, { done: true });

  r = await api('GET', `/api/companies/${ids.acme}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.tasks));
  const got = r.data.tasks.map((t) => t.id);
  assert.ok(got.includes(companyTask), 'a promise attached to the company appears');
  assert.ok(got.includes(personTask), 'so does one about someone who works there');
  assert.ok(!got.includes(keptTask), 'kept promises drop off');
  const ct = r.data.tasks.find((t) => t.id === companyTask);
  assert.equal(ct.person_name, null, 'no person -> null, not an empty name');
  assert.equal(ct.company_id, ids.acme);
  assert.equal(ct.done, 0);
  assert.equal(ct.source, 'manual');
  assert.ok('due' in ct && 'created_at' in ct && 'person_id' in ct);
  assert.equal(r.data.tasks.find((t) => t.id === personTask).person_name, 'Ada Lovelace');

  // a company with nobody recorded still answers with a list, not undefined
  r = await api('GET', '/api/companies');
  const emptyId = r.data.find((c) => c.name === 'Empty Ventures').id;
  r = await api('GET', `/api/companies/${emptyId}`);
  assert.deepEqual(r.data.tasks, []);
});

test('a company fit defers person criteria instead of calling them blank', async () => {
  let r = await api('POST', '/api/icp', {
    name: 'AI infra founder (FR)',
    criteria: [
      { id: 'sec', label: 'AI infrastructure', weight: 3, field: 'company.sector', op: 'in', values: ['ai infra'] },
      { id: 'stg', label: 'Seed stage', weight: 2, field: 'company.stage', op: 'in', values: ['seed'] },
      { id: 'geo', label: 'Based in Paris', weight: 2, field: 'company.geography', op: 'in', values: ['Paris'] },
      { id: 'ttl', label: 'CTO title', weight: 2, field: 'person.title', op: 'contains', values: ['CTO'] },
      { id: 'sen', label: 'Founder', weight: 1, field: 'person.seniority', op: 'in', values: ['FOUNDER'] },
    ],
  });
  assert.equal(r.status, 201);
  const icpId = r.data.id;

  r = await api('GET', `/api/companies/${ids.acme}`);
  const fit = r.data.fits.find((f) => f.icp_id === icpId);
  assert.deepEqual(fit.needs_person, ['CTO title', 'Founder'],
    'the founder criteria are named as needing a person, not reported as blanks');
  assert.deepEqual(fit.missing, [], 'sector, stage and geography are all recorded on Acme');
  assert.equal(fit.company_coverage, 1, 'every criterion this page can judge is answerable');
  assert.equal(fit.score, 0.7, 'the score math is untouched: 7 of 10 weight matched');

  // the same profile on a company with nothing filled in
  r = await api('GET', '/api/companies');
  const emptyId = r.data.find((c) => c.name === 'Empty Ventures').id;
  r = await api('GET', `/api/companies/${emptyId}`);
  const blank = r.data.fits.find((f) => f.icp_id === icpId);
  assert.deepEqual(blank.missing, ['AI infrastructure', 'Seed stage', 'Based in Paris']);
  assert.deepEqual(blank.needs_person, ['CTO title', 'Founder']);
  assert.equal(blank.company_coverage, 0);

  // the person route is untouched — there, person.* criteria genuinely resolve
  r = await api('GET', `/api/people/${ids.ada}`);
  const pf = r.data.fits.find((f) => f.icp_id === icpId);
  assert.equal(pf.needs_person, undefined, 'nothing is deferred on a person page');
  assert.equal(pf.score, 0.9, 'Ada answers the CTO criterion the company page cannot');
});

test('plan items and priority rows say how many people are recorded', async () => {
  let r = await api('GET', '/api/plan?hours=6');
  assert.ok(r.data.plan.length >= 1);
  const pick = r.data.plan.find((c) => c.company_id === ids.acme);
  assert.ok(pick, 'Acme is still in the plan');
  assert.equal(pick.people_count, 2, 'Ada and Bob');
  assert.ok(!('people_count' in pick.components), 'components keeps its pinned shape');
  assert.ok(r.data.plan.every((c) => typeof c.people_count === 'number'));

  r = await api('GET', '/api/priorities');
  assert.equal(r.data.find((d) => d.company_id === ids.acme).people_count, 2);
  assert.ok(r.data.every((d) => typeof d.people_count === 'number'));

  r = await api('GET', '/api/overview');
  assert.ok(r.data.plan.plan.every((c) => typeof c.people_count === 'number'));
  assert.ok(r.data.priorities.every((d) => typeof d.people_count === 'number'));
});

test('linkedin messages.csv scores contacts (direction, dedupe, groups, drafts)', async () => {
  const H = '"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS","IS MESSAGE DRAFT","IS CONVERSATION DRAFT"';
  const ME = 'https://linkedin.example/in/alex-example';
  const HER = 'https://linkedin.example/in/marie-dubois';
  const row = (from, sUrl, to, rUrls, date, content, draft = '') =>
    `"c1","","${from}","${sUrl}","${to}","${rUrls}","${date}","","${content}","INBOX","","${draft}",""`;
  const messages = [H,
    row('Alex Example', ME, 'Marie Dubois', HER, '2026-07-01 09:00:00 UTC', 'Great to meet you'),
    row('Marie Dubois', HER, 'Alex Example', ME, '2026-07-02 10:00:00 UTC', 'Likewise!'),
    // a broadcast to several people is not a one-to-one relationship
    row('Alex Example', ME, 'Group', `${HER} https://linkedin.example/in/someone-else`, '2026-07-03 10:00:00 UTC', 'Hi all'),
    // never sent
    row('Alex Example', ME, 'Marie Dubois', HER, '2026-07-04 10:00:00 UTC', 'unsent', 'true'),
  ].join('\r\n');

  let r = await api('POST', '/api/import/linkedin', { messages });
  assert.equal(r.status, 200);
  const m = r.data.messages;
  assert.equal(m.messages_imported, 2);
  assert.equal(m.people_scored, 1);
  assert.equal(m.people_created, 1);          // Marie was not a connection
  assert.equal(m.skipped.group, 1);
  assert.equal(m.skipped.drafts, 1);

  r = await api('GET', '/api/people?q=Marie&tier=network');
  const marie = r.data[0];
  assert.equal(marie.touches, 2);
  assert.ok(marie.warmth > 0.3, 'a two-way exchange scores well above the floor');

  r = await api('GET', `/api/people/${marie.id}`);
  const kinds = r.data.interactions.map((i) => `${i.kind}:${i.direction}`).sort();
  assert.deepEqual(kinds, ['message:inbound', 'message:outbound'], 'direction is read from FROM');

  // Re-importing the same export must not inflate frequency.
  r = await api('POST', '/api/import/linkedin', { messages });
  assert.equal(r.data.messages.messages_imported, 0);
  assert.equal(r.data.messages.duplicates, 2);
  r = await api('GET', '/api/people?q=Marie&tier=network');
  assert.equal(r.data[0].touches, 2);
});

// Build a real (stored, uncompressed) zip so the upload path is tested end to
// end without depending on a personal export sitting on disk.
function makeZip(files) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = enc(name), data = enc(content);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 8);                       // method 0 = stored
    lfh.writeUInt32LE(0, 14);                      // crc (readers here ignore it)
    lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(n.length, 26); lfh.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(lfh, n, data);
    centrals.push(cd, n);
    offset += 30 + n.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

test('linkedin .zip uploads whole, finds its files in subfolders, and is idempotent', async () => {
  const conns = ['Notes:', '', 'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Zoe,Karras,https://linkedin.example/in/zoe-karras,,Helio,Founder,02 Feb 2025'].join('\r\n');
  const H = '"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS","IS MESSAGE DRAFT","IS CONVERSATION DRAFT"';
  const ME = 'https://linkedin.example/in/alex-example';
  const HER = 'https://linkedin.example/in/zoe-karras';
  const msgs = [H,
    `"c9","","Alex Example","${ME}","Zoe Karras","${HER}","2026-06-01 09:00:00 UTC","","hello","INBOX","","",""`,
    `"c9","","Zoe Karras","${HER}","Alex Example","${ME}","2026-06-02 09:00:00 UTC","","hi back","INBOX","","",""`,
  ].join('\r\n');
  // nested in a folder, as some re-zipped downloads arrive
  const zip = makeZip({ 'Export/Connections.csv': conns, 'Export/messages.csv': msgs });

  const send = async (buf) => {
    const res = await fetch(base + '/api/import/linkedin-zip', {
      method: 'POST', headers: { 'content-type': 'application/zip', ...(cookie ? { cookie } : {}) }, body: buf,
    });
    return { status: res.status, data: await res.json() };
  };

  let r = await send(zip);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.files_found, ['Connections.csv', 'messages.csv']);
  assert.equal(r.data.created_people, 1);
  assert.equal(r.data.messages.messages_imported, 2);
  assert.equal(r.data.messages.people_scored, 1);

  let list = await api('GET', '/api/people?q=Karras&tier=network');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].touches, 2, 'scored from the messages inside the zip');
  assert.equal(list.data[0].company_name, 'Helio', 'company came from Connections.csv');

  // Uploading the same export again must change nothing.
  r = await send(zip);
  assert.equal(r.data.created_people, 0);
  assert.equal(r.data.messages.messages_imported, 0);
  assert.equal(r.data.messages.duplicates, 2);
  list = await api('GET', '/api/people?q=Karras&tier=network');
  assert.equal(list.data[0].touches, 2);

  // Not a zip at all: a clean 400, never a crash.
  r = await send(Buffer.from('definitely not a zip'));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /could not read that \.zip/);
});

test('imported people land in the network tier and stay off the daily screens', async () => {
  // Everything above imported connections and messages; none of it should be
  // on the roster, and none of it should reach Today.
  const roster = (await api('GET', '/api/people?tier=roster')).data;
  const network = (await api('GET', '/api/people?tier=network')).data;
  assert.ok(network.length >= 3, 'imports populated the network tier');
  assert.ok(roster.every((p) => !network.some((n) => n.id === p.id)), 'the tiers are disjoint');
  assert.ok(!roster.some((p) => p.last_name === 'Hopper'), 'an imported connection is not on the roster');

  // Default tier is the roster: the People page must not open on a large imported network.
  const dflt = (await api('GET', '/api/people')).data;
  assert.equal(dflt.length, roster.length);

  // Going quiet is roster-scoped, so bulk imports cannot bury real relationships.
  const quiet = (await api('GET', '/api/quiet')).data;
  assert.ok(Array.isArray(quiet.people), 'quiet returns {people, total, target_days}');
  const quietIds = quiet.people.map((r) => r.person_id ?? r.id);
  assert.ok(quietIds.every((id) => !network.some((n) => n.id === id)), 'no network contact in Going quiet');

  // Search still spans everyone — you must be able to look anyone up.
  const found = (await api('GET', '/api/search?q=Hopper')).data;
  assert.ok(found.people.some((p) => /Hopper/.test(p.name)), 'search reaches the network tier');
});

test('prospects rank the network tier and promotion moves someone to the roster', async () => {
  let r = await api('GET', '/api/prospects?min=0&limit=100');
  assert.equal(r.status, 200);
  assert.match(r.data.basis, /title and company/i);
  assert.ok(r.data.rows.length > 0);
  // scores are ordered and every one is attributable
  for (let i = 1; i < r.data.rows.length; i++) {
    assert.ok(r.data.rows[i - 1].score >= r.data.rows[i].score, 'ranked by score');
  }
  const top = r.data.rows[0];
  assert.ok(Array.isArray(top.breakdown) && top.breakdown.length, 'the score explains itself');
  assert.ok(top.points <= top.max);

  // Promote, and it leaves the suggestions and joins the roster.
  const before = (await api('GET', '/api/people?tier=roster')).data.length;
  await api('PATCH', `/api/people/${top.person.id}`, { status: 'roster' });
  const after = (await api('GET', '/api/people?tier=roster')).data;
  assert.equal(after.length, before + 1);
  assert.ok(after.some((p) => p.id === top.person.id));
  r = await api('GET', '/api/prospects?min=0&limit=100');
  assert.ok(!r.data.rows.some((x) => x.person.id === top.person.id), 'promoted people leave the suggestions');
});

test('icp labels record the verdict and drop the person from suggestions', async () => {
  let r = await api('GET', '/api/prospects?min=0&limit=100');
  const before = r.data.rows.length;
  assert.ok(before > 1);
  const target = r.data.rows[0];

  // "Not ICP" is a label too: the negatives are what make an AUC meaningful.
  r = await api('POST', '/api/icp-label', { person_id: target.person.id, label: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.labelled, 1);
  assert.equal(r.data.positives, 0);

  r = await api('GET', '/api/prospects?min=0&limit=100');
  assert.equal(r.data.rows.length, before - 1, 'a judged person leaves the queue');
  assert.ok(!r.data.rows.some((x) => x.person.id === target.person.id));
  assert.equal(r.data.labelled, 1);

  // Re-labelling the same person updates rather than duplicating.
  r = await api('POST', '/api/icp-label', { person_id: target.person.id, label: 1 });
  assert.equal(r.data.labelled, 1);
  assert.equal(r.data.positives, 1);

  r = await api('POST', '/api/icp-label', { person_id: 999999, label: 1 });
  assert.equal(r.status, 404);
});

test('icp sweep scope: roster / network / everyone, and coverage explains an empty result', async () => {
  const criteria = [{ id: 'c', label: 'Any title', weight: 1, field: 'person.title', op: 'contains', values: ['a', 'e', 'i', 'o', 'u'] }];
  const scoped = async (scope) => (await api('POST', '/api/path/icp', { criteria, scope, limit: 60, order: 'fit' })).data;

  const all = await scoped('all');
  const roster = await scoped('roster');
  const network = await scoped('network');
  assert.equal(all.scope, 'all');
  assert.equal(roster.scope, 'roster');
  // the two tiers partition the population
  assert.equal(roster.scanned + network.scanned, all.scanned);
  assert.ok(network.scanned > 0, 'imports gave us a network tier to sweep');
  const rosterIds = new Set(roster.rows.map((r) => r.person.id));
  assert.ok(network.rows.every((r) => !rosterIds.has(r.person.id)), 'scopes do not overlap');

  // A field the imports never fill: coverage must report zero rather than the UI
  // implying nobody in the network matches the thesis.
  const sector = [{ id: 's', label: 'Company sector', weight: 1, field: 'company.sector', op: 'in', values: ['fintech'] }];
  const r = (await api('POST', '/api/path/icp', { criteria: sector, scope: 'network', limit: 20 })).data;
  const cov = r.coverage.find((c) => c.id === 's');
  assert.ok(cov, 'coverage reports per criterion');
  assert.equal(cov.known, 0, 'no imported company has a sector recorded');
  assert.equal(r.rows.length, 0);
});

test('prospects carry a role class so founders can be listed apart from builders', async () => {
  const r = await api('GET', '/api/prospects?min=0&limit=100');
  assert.equal(r.status, 200);
  assert.ok(r.data.rows.length > 0);
  for (const row of r.data.rows) {
    assert.ok(['founder', 'builder', 'none'].includes(row.role_class), `role_class present: ${row.role_class}`);
  }
  // A founder title must classify as founder, and outrank a builder title, since
  // "runs the company" is the primary criterion.
  const founders = r.data.rows.filter((x) => x.role_class === 'founder');
  const builders = r.data.rows.filter((x) => x.role_class === 'builder');
  if (founders.length && builders.length) {
    assert.ok(Math.max(...founders.map((f) => f.score)) >= Math.max(...builders.map((b) => b.score)),
      'the best founder scores at least as high as the best builder');
  }
});
