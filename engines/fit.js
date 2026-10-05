// ICP / thesis fit scoring. score = sum(w_i * m_i) / sum(w_i) in [0,1].
// Every criterion reports {matched, known, actual} so the UI can explain the score.

const round4 = (x) => Math.round(x * 1e4) / 1e4;
const lc = (s) => String(s).toLowerCase();

function actualValue(target, field) {
  const [scope, key] = String(field ?? '').split('.');
  const obj = scope === 'person' ? target.person : scope === 'company' ? target.company : null;
  if (!obj || obj[key] == null) return null;
  let v = obj[key];
  if (key === 'tags' && typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = []; }
  }
  return v;
}

function matches(actual, op, values) {
  const vals = (values ?? []).map(String).filter((v) => v.length > 0);
  const arr = (Array.isArray(actual) ? actual : [actual]).map(lc).filter((a) => a.length > 0);
  if (!arr.length || !vals.length) return false;
  // 'in' and 'overlap' are equality matches (overlap over tag arrays);
  // 'contains' is a case-insensitive substring test.
  if (op === 'in' || op === 'overlap') return arr.some((a) => vals.some((v) => lc(v) === a));
  if (op === 'contains') return arr.some((a) => vals.some((v) => a.includes(lc(v))));
  return false;
}

// "Wrong sector" and "no sector recorded" are both matched=false, which is how a
// founder with an empty profile renders a confident 0% (non-negotiable 4). `known`
// separates them: a criterion is known only when there was a real value to test.
function isKnown(actual) {
  if (actual == null) return false;
  if (Array.isArray(actual)) return actual.some((v) => v != null && String(v).trim() !== '');
  return String(actual).trim() !== '';
}

export function scoreTarget(target = {}, criteria) {
  const list = Array.isArray(criteria) ? criteria : [];
  const breakdown = [];
  const missing = [];
  let totalW = 0, matchedW = 0, knownW = 0;
  for (const c of list) {
    const weight = Number(c.weight) || 0;
    const actual = actualValue(target, c.field);
    const matched = actual != null && matches(actual, c.op, c.values);
    const known = isKnown(actual);
    breakdown.push({ id: c.id, label: c.label, weight, matched, known, actual });
    totalW += weight;
    if (matched) matchedW += weight;
    if (known) knownW += weight;
    else missing.push(String(c.label || c.field || ''));
  }
  // `score` is deliberately unchanged (matchedW/totalW): rankings, the ICP sweep and
  // every stored expectation stay put. `coverage` is what says how much of the
  // thesis was actually testable, so the UI can print "0% of 1 of 3 criteria known".
  return {
    score: totalW > 0 ? round4(matchedW / totalW) : 0,
    breakdown,
    total_weight: totalW,
    known_weight: knownW,
    coverage: totalW > 0 ? round4(knownW / totalW) : 0,
    missing,
  };
}
