import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, DEFAULT_SETTINGS } from '../db.js';
import { scoreProspect } from '../engines/prospect.js';
import { APP_NAME } from '../packaging.js';

test('a new installation starts with no contact or evaluation data', () => {
  const db = openDb(':memory:');
  try {
    for (const table of ['people', 'companies', 'interactions', 'relationships', 'deals', 'tasks', 'icp_profiles', 'icp_labels', 'sessions']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} starts empty`);
    }
  } finally { db.close(); }
  assert.equal(APP_NAME, 'CRMPlus');
});

test('starter suggestions apply no employer, sector, or exclusion preferences', () => {
  const cfg = DEFAULT_SETTINGS.icp_scoring;
  assert.deepEqual(cfg.companies, []);
  assert.deepEqual(cfg.domains, []);
  assert.deepEqual(cfg.exclusions, []);
  const score = (title, company) => scoreProspect({ person: { title }, company: { name: company } }, cfg);
  const first = score('Founder', 'Example Company A');
  assert.deepEqual(first, score('Founder', 'Example Company B'));
  assert.equal(first.score, score('Founder in software', 'Example Company A').score);
  assert.ok(first.breakdown.every((entry) => entry.rule === 'role'));
});
