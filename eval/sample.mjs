// Draw a reproducible, stratified sample of the network tier for labelling.
// Stratified by current score band so both classes are represented: sampling
// the top only yields almost no negatives and no measurable AUC.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, DEFAULT_SETTINGS } from '../db.js';
import { scoreProspect } from '../engines/prospect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2]) || 200;

const db = openDb();
const cfg = getSetting(db, 'icp_scoring', DEFAULT_SETTINGS.icp_scoring);

const rows = db.prepare(`SELECT p.id, p.first_name, p.last_name, p.title, p.linkedin_url,
                                c.name AS company_name
                         FROM people p LEFT JOIN companies c ON c.id = p.company_id
                         WHERE p.is_me = 0 AND p.status = 'network'
                         ORDER BY p.id`).all();

const scored = rows.map((r) => ({
  ...r,
  score: scoreProspect({ person: r, company: { name: r.company_name } }, cfg).score,
}));

const BANDS = [[0, 0.15], [0.15, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 1.01]];
const per = Math.ceil(N / BANDS.length);
const out = [];
for (const [lo, hi] of BANDS) {
  const band = scored.filter((s) => s.score >= lo && s.score < hi);
  const stride = Math.max(1, Math.floor(band.length / per));   // even stride = deterministic
  for (let i = 0, taken = 0; i < band.length && taken < per; i += stride, taken++) out.push(band[i]);
}
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, 'sample.json'), JSON.stringify(out.map((o) => ({
  id: o.id, title: o.title || '', company: o.company_name || '', score: o.score,
})), null, 1));
out.forEach((o, i) => console.log(`${String(i).padStart(3)}|${(o.title || '—').slice(0, 46)} @ ${(o.company_name || '—').slice(0, 30)}`));
console.error(`\n${out.length} sampled from ${scored.length}; written to eval/sample.json`);
db.close();
