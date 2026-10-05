// evaluate-icp.mjs — how good is the prospect score, measured rather than argued.
//
//   node evaluate-icp.mjs [--repeats 200]
//
// Uses the labels produced by triage (Add to roster = 1, Not ICP = 0). Labels
// come from the user; the score comes from the model; the two are independent,
// which is the only reason this measures anything at all.
//
// Reports, per scoring method:
//   AUC on a held-out 20%, averaged over many random splits, with a percentile
//   confidence band. Tuning on the same people you score is how a keyword model
//   flatters itself, so the split is the point.
import { openDb, getSetting, DEFAULT_SETTINGS } from './db.js';
import { scoreProspect } from './engines/prospect.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const REPEATS = arg('repeats', 200);

const db = openDb();
const cfg = getSetting(db, 'icp_scoring', DEFAULT_SETTINGS.icp_scoring);

const rows = db.prepare(`SELECT l.label, p.title, c.name AS company_name
                         FROM icp_labels l
                         JOIN people p ON p.id = l.person_id
                         LEFT JOIN companies c ON c.id = p.company_id`).all();
const pos = rows.filter((r) => r.label === 1).length;
const neg = rows.length - pos;
console.log(`labelled: ${rows.length}  (${pos} ICP, ${neg} not)`);
if (rows.length < 20 || pos < 5 || neg < 5) {
  console.log('\nNot enough labels yet to measure anything honestly.');
  console.log('Open People -> Suggested and judge people with "Add to roster" / "Hide".');
  console.log('Aim for ~60 judgements with at least 10 of each verdict.');
  db.close();
  process.exit(0);
}

/** Probability a random ICP outranks a random non-ICP. 0.5 = coin flip. */
function auc(scored) {
  const p = scored.filter((s) => s.label === 1).map((s) => s.score);
  const n = scored.filter((s) => s.label === 0).map((s) => s.score);
  if (!p.length || !n.length) return null;
  let wins = 0;
  for (const a of p) for (const b of n) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (p.length * n.length);
}

// Deterministic RNG so a reported number can be reproduced exactly.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const METHODS = {
  'full (role + company + domain + penalties)': cfg,
  'role only': { ...cfg, companies: [], domains: [], exclusions: [] },
  'role + penalties': { ...cfg, companies: [], domains: [] },
  'role + company': { ...cfg, domains: [], exclusions: [] },
  'company only': { ...cfg, roles: [], domains: [], exclusions: [] },
};

console.log(`\nheld-out AUC over ${REPEATS} random 80/20 splits`);
console.log('method'.padEnd(44) + 'AUC   90% band        test n');
for (const [name, c] of Object.entries(METHODS)) {
  const scored = rows.map((r) => ({
    label: r.label,
    score: scoreProspect({ person: { title: r.title }, company: { name: r.company_name } }, c).score,
  }));
  const aucs = [];
  for (let i = 0; i < REPEATS; i++) {
    const shuffled = [...scored].sort(() => rand() - 0.5);
    const cut = Math.floor(shuffled.length * 0.8);
    const a = auc(shuffled.slice(cut));          // the held-out fifth
    if (a !== null) aucs.push(a);
  }
  aucs.sort((x, y) => x - y);
  const mid = aucs.reduce((s, x) => s + x, 0) / aucs.length;
  const lo = aucs[Math.floor(aucs.length * 0.05)];
  const hi = aucs[Math.floor(aucs.length * 0.95)];
  const band = ((hi - lo) / 2 * 100).toFixed(0);
  console.log(`${name.padEnd(44)}${mid.toFixed(3)}  ${lo.toFixed(2)}-${hi.toFixed(2)} (+/-${band})   ${Math.ceil(rows.length * 0.2)}`);
}

// Calibration: within a score band, what share are actually ICP? A score that
// ranks well can still be badly scaled, and the threshold is chosen off this.
console.log('\ncalibration on all labels (is 60% actually ~60% likely to be ICP?)');
const scoredAll = rows.map((r) => ({
  label: r.label,
  score: scoreProspect({ person: { title: r.title }, company: { name: r.company_name } }, cfg).score,
}));
for (const [lo, hi] of [[0, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 0.75], [0.75, 1.01]]) {
  const band = scoredAll.filter((s) => s.score >= lo && s.score < hi);
  if (!band.length) continue;
  const rate = band.filter((s) => s.label === 1).length / band.length;
  console.log(`  ${(lo * 100).toFixed(0).padStart(3)}-${(hi * 100).toFixed(0).padEnd(3)}%  n=${String(band.length).padStart(3)}  actually ICP: ${(rate * 100).toFixed(0)}%`);
}
console.log('\nA threshold is well chosen when the band just above it is mostly ICP');
console.log('and the band just below it is mostly not.');
db.close();
