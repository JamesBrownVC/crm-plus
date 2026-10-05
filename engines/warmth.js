// Warmth engine — port of Net-Work warmth.py, minus the a6/a7 LLM content terms.
// w = sigmoid(a1*recency_decay + a2*ln(1+freq_90d) + a3*reciprocity
//             + a4*seniority_touch + a5*channel_diversity + bias)

const DAY_MS = 86400e3;
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const toMs = (t) => (t instanceof Date ? t.getTime() : Date.parse(t));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export function components(person, interactions, now, cfg) {
  const list = interactions ?? [];
  const nowMs = toMs(now);
  let recency = 0;
  if (list.length) {
    let minDays = Infinity;
    for (const i of list) minDays = Math.min(minDays, (nowMs - toMs(i.ts)) / DAY_MS);
    // A touch cannot have happened in the future. Clamping the age at 0 keeps the decay
    // factor in [0,1] by construction, so a row stored with a mistyped year (before the
    // API rejected them) reads as "today" rather than printing a factor of 36.584.
    recency = 2 ** (-Math.max(0, minDays) / cfg.half_life_days);
  }
  const cutoff = nowMs - 90 * DAY_MS;
  let freq = 0, inbound = 0, outbound = 0;
  const kinds = new Set();
  for (const i of list) {
    if (toMs(i.ts) >= cutoff) freq++;
    if (i.direction === 'inbound') inbound++;
    else if (i.direction === 'outbound') outbound++;
    kinds.add(i.kind);
  }
  const total = inbound + outbound;
  return {
    recency_decay: round4(recency),
    freq_90d: freq,
    reciprocity: round4(total ? (2 * Math.min(inbound, outbound)) / total : 0),
    seniority_touch: list.length ? cfg.seniority_weights[person.seniority] ?? 0.2 : 0,
    channel_diversity: round4(Math.min(1, kinds.size / 5)),
  };
}

export function scorePerson(person, interactions, now, cfg) {
  const comp = components(person, interactions, now, cfg);
  const a = cfg.coefficients;
  const z =
    a.a1_recency * comp.recency_decay +
    a.a2_frequency * Math.log1p(comp.freq_90d) +
    a.a3_reciprocity * comp.reciprocity +
    a.a4_seniority_touch * comp.seniority_touch +
    a.a5_channel_diversity * comp.channel_diversity +
    a.bias;
  // `touches` sits OUTSIDE components (a stable API shape) so a
  // caller can tell the sigmoid(bias) floor apart from a real, low score.
  return { score: round4(sigmoid(z)), components: comp, touches: (interactions ?? []).length };
}

export function computeAll(db, cfg, now = new Date()) {
  const people = db.prepare('SELECT id, seniority FROM people WHERE is_me = 0').all();
  const byPerson = new Map();
  for (const r of db.prepare('SELECT person_id, ts, kind, direction FROM interactions').all()) {
    let list = byPerson.get(r.person_id);
    if (!list) byPerson.set(r.person_id, (list = []));
    list.push(r);
  }
  const map = new Map();
  for (const p of people) map.set(p.id, scorePerson(p, byPerson.get(p.id) ?? [], now, cfg));
  return map;
}

export function companyWarmth(warmthMap, peopleOfCompany) {
  let best = 0;
  for (const p of peopleOfCompany ?? []) {
    const id = p !== null && typeof p === 'object' ? p.id : p;
    const w = warmthMap.get(id);
    if (w && w.score > best) best = w.score;
  }
  return best;
}

// Evidence behind a company's warmth: total logged touches across its people.
// 0 means the company warmth is the sigmoid(bias) floor, not a measurement.
export function companyTouches(warmthMap, peopleOfCompany) {
  let n = 0;
  for (const p of peopleOfCompany ?? []) {
    const id = p !== null && typeof p === 'object' ? p.id : p;
    n += warmthMap.get(id)?.touches ?? 0;
  }
  return n;
}
