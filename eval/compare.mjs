// Which ICP scoring system predicts best OUT OF SAMPLE?
//
//   node eval/compare.mjs [--repeats 400]
//
// Every system is fitted (where it has parameters) on the same random 80% and
// scored on the held-out 20%, repeated many times. Anything fitted on the test
// rows would flatter itself, which is the whole reason for the split.
//
// Zero dependencies: logistic regression and naive Bayes are implemented here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, DEFAULT_SETTINGS } from '../db.js';
import { scoreProspect, fold } from '../engines/prospect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPEATS = (() => { const i = process.argv.indexOf('--repeats'); return i === -1 ? 400 : Number(process.argv[i + 1]); })();

const sample = JSON.parse(readFileSync(join(HERE, 'sample.json'), 'utf8'));
const { labels } = JSON.parse(readFileSync(join(HERE, 'labels.json'), 'utf8'));
if (sample.length !== labels.length) throw new Error('sample/labels length mismatch');

const db = openDb();
const CFG = getSetting(db, 'icp_scoring', DEFAULT_SETTINGS.icp_scoring);
db.close();

const data = sample.map((s, i) => ({ ...s, y: labels[i], text: `${fold(s.title)} ${fold(s.company)}`.trim() }));

/* ---------------- feature builders ---------------- */
const tokens = (t) => t.split(/\s+/).filter((w) => w.length > 1);
// bigrams matter here: "founder associate" and "vice president" mean the
// opposite of the words they contain.
const grams = (t) => {
  const w = tokens(t); const out = [...w];
  for (let i = 0; i + 1 < w.length; i++) out.push(`${w[i]}_${w[i + 1]}`);
  return out;
};
/** Which hand-written rules fire — lets a model learn the point values. */
const ruleFeatures = (row) => {
  const r = scoreProspect({ person: { title: row.title }, company: { name: row.company } }, CFG);
  const f = {};
  for (const b of r.breakdown) f[`${b.rule}:${b.label}`] = 1;
  return f;
};

/* ---------------- learners ---------------- */
function logreg(trainX, trainY, { epochs = 300, lr = 0.5, l2 = 0.02 } = {}) {
  const w = new Map(); let b = 0;
  for (let e = 0; e < epochs; e++) {
    for (let i = 0; i < trainX.length; i++) {
      let z = b;
      for (const k of Object.keys(trainX[i])) z += (w.get(k) || 0) * trainX[i][k];
      const p = 1 / (1 + Math.exp(-z));
      const g = p - trainY[i];
      b -= lr * g;
      for (const k of Object.keys(trainX[i])) {
        w.set(k, (w.get(k) || 0) * (1 - lr * l2) - lr * g * trainX[i][k]);
      }
    }
  }
  return (x) => {
    let z = b;
    for (const k of Object.keys(x)) z += (w.get(k) || 0) * x[k];
    return 1 / (1 + Math.exp(-z));
  };
}

function naiveBayes(trainDocs, trainY) {
  const vocab = new Set();
  const count = [new Map(), new Map()]; const tot = [0, 0]; const docs = [0, 0];
  trainDocs.forEach((d, i) => {
    const c = trainY[i]; docs[c]++;
    for (const t of d) { vocab.add(t); count[c].set(t, (count[c].get(t) || 0) + 1); tot[c]++; }
  });
  const V = vocab.size || 1;
  const prior = [Math.log((docs[0] + 1) / (docs[0] + docs[1] + 2)), Math.log((docs[1] + 1) / (docs[0] + docs[1] + 2))];
  return (d) => {
    const lp = [prior[0], prior[1]];
    for (const t of d) {
      for (const c of [0, 1]) lp[c] += Math.log(((count[c].get(t) || 0) + 1) / (tot[c] + V));
    }
    const m = Math.max(lp[0], lp[1]);
    const e0 = Math.exp(lp[0] - m), e1 = Math.exp(lp[1] - m);
    return e1 / (e0 + e1);
  };
}

/* ---------------- systems under test ---------------- */
const SYSTEMS = {
  // zero-parameter baseline: does the title say "founder"?
  'baseline: title says founder': {
    fit: () => (row) => (/\b(founder|cofounder|co founder|founding|fondateur|cofondateur)\b/.test(fold(row.title)) ? 1 : 0),
  },
  'hand-written rules (shipping)': {
    fit: () => (row) => scoreProspect({ person: { title: row.title }, company: { name: row.company } }, CFG).score,
  },
  'logreg on rule firings': {
    fit: (tr) => {
      const f = logreg(tr.map(ruleFeatures), tr.map((r) => r.y));
      return (row) => f(ruleFeatures(row));
    },
  },
  'logreg on words+bigrams': {
    fit: (tr) => {
      const vec = (row) => Object.fromEntries(grams(row.text).map((g) => [g, 1]));
      const f = logreg(tr.map(vec), tr.map((r) => r.y));
      return (row) => f(vec(row));
    },
  },
  'naive bayes on words+bigrams': {
    fit: (tr) => {
      const f = naiveBayes(tr.map((r) => grams(r.text)), tr.map((r) => r.y));
      return (row) => f(grams(row.text));
    },
  },
};

/* ---------------- evaluation ---------------- */
function auc(ys, ps) {
  const pos = ps.filter((_, i) => ys[i] === 1), neg = ps.filter((_, i) => ys[i] === 0);
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
let seed = 20260805;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// Stratified split helps keep both label classes represented across folds.
function split() {
  const pos = data.filter((d) => d.y === 1), neg = data.filter((d) => d.y === 0);
  const cut = (arr) => { const s = [...arr].sort(() => rnd() - 0.5); const k = Math.floor(s.length * 0.8); return [s.slice(0, k), s.slice(k)]; };
  const [ptr, pte] = cut(pos), [ntr, nte] = cut(neg);
  return [[...ptr, ...ntr], [...pte, ...nte]];
}

console.log(`${data.length} labelled (${data.filter((d) => d.y).length} ICP, ${data.filter((d) => !d.y).length} not)`);
console.log(`${REPEATS} stratified 80/20 splits\n`);
console.log('system'.padEnd(32) + 'AUC    90% band       acc@best  prec@10');
const results = [];
for (const [name, sys] of Object.entries(SYSTEMS)) {
  const aucs = [], accs = [], precs = [];
  for (let r = 0; r < REPEATS; r++) {
    const [tr, te] = split();
    const f = sys.fit(tr);
    const ps = te.map(f), ys = te.map((d) => d.y);
    const a = auc(ys, ps);
    if (a !== null) aucs.push(a);
    // accuracy at the threshold that is best ON TRAIN, applied to test
    const trp = tr.map(f), try_ = tr.map((d) => d.y);
    let bestT = 0.5, bestAcc = -1;
    for (const t of [...new Set(trp)].sort((x, y) => x - y)) {
      const acc = mean(try_.map((y, i) => ((trp[i] >= t ? 1 : 0) === y ? 1 : 0)));
      if (acc > bestAcc) { bestAcc = acc; bestT = t; }
    }
    accs.push(mean(ys.map((y, i) => ((ps[i] >= bestT ? 1 : 0) === y ? 1 : 0))));
    const top = ys.map((y, i) => ({ y, p: ps[i] })).sort((x, y) => y.p - x.p).slice(0, 10);
    precs.push(mean(top.map((t) => t.y)));
  }
  aucs.sort((a, b) => a - b);
  const lo = aucs[Math.floor(aucs.length * 0.05)], hi = aucs[Math.floor(aucs.length * 0.95)];
  results.push({ name, auc: mean(aucs), lo, hi, acc: mean(accs), prec: mean(precs) });
  console.log(`${name.padEnd(32)}${mean(aucs).toFixed(3)}  ${lo.toFixed(2)}-${hi.toFixed(2)} (+/-${((hi - lo) / 2 * 100).toFixed(0)})   ${(mean(accs) * 100).toFixed(1)}%     ${(mean(precs) * 100).toFixed(0)}%`);
}
const best = [...results].sort((a, b) => b.auc - a.auc)[0];
const shipping = results.find((r) => r.name.includes('shipping'));
console.log(`\nbest: ${best.name} (AUC ${best.auc.toFixed(3)})`);
if (best.name !== shipping.name) {
  const gap = best.auc - shipping.auc;
  const overlap = best.lo <= shipping.hi;
  console.log(`shipping system trails by ${gap.toFixed(3)} AUC; confidence bands ${overlap ? 'OVERLAP -> not a distinguishable difference' : 'are separated -> a real difference'}`);
}
