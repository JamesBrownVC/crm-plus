// #/settings — the dials behind every score: warmth coefficients, pathfinding,
// action economics, Matching profiles, LinkedIn import.
import { api } from '../api.js';
import {
  h, icon, fmtPct, fmtPct1, fmtNum, humanizeAction,
  scoreChip, attachWhy, popContent, guard, toast, emptyState, errorState,
  confirmModal, navigate, relLabel, stageLabel, SENIORITY,
} from '../app.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const REL_ORDER = ['family', 'close_friend', 'worked_with', 'advises', 'coinvestor', 'invested_in', 'studied_with', 'introduced', 'colleague', 'knows'];
const CADENCE_STAGES = ['sourced', 'contacted', 'meeting', 'diligence', 'referred'];
// engine keys never reach a label on their own: they go in the why-popover next
// to the plain-language name (PERSONA §4).
const relName = (k) => relLabel(k) || String(k || '—').replace(/_/g, ' ');
const stageName = (s) => stageLabel(s) || String(s || '—');
// app.js's seniorityLabel deliberately prints nothing for OTHER; a weight in a
// settings grid still needs a name, so read the full list instead — inside the
// call, never at module evaluation: app.js imports this view, so its exports are
// still in the temporal dead zone while this module body runs.
const senName = (s) => SENIORITY.find(([k]) => k === s)?.[1] || String(s ?? '—');
const keyRow = (path) => [{ k: 'Engine key', v: path }];
const titleCase = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
// ICP criteria are authored in Network; here they are only summarised
const OP_LABEL = { in: 'is one of', contains: 'contains the text', overlap: 'shares a tag with' };
const opName = (o) => OP_LABEL[o] || String(o || '—');
const fieldName = (f) => titleCase(String(f || 'criterion').replace(/[._]/g, ' '));
const BUCKETS = ['cold', 'warm', 'hot'];
const TIERS = ['low', 'mid', 'high'];
const ordered = (obj, pref) => [...pref.filter(k => k in obj), ...Object.keys(obj).filter(k => !pref.includes(k))];

/* ---------- validated numeric input (inline error, never a silent bad PUT) ---------- */
function numField(label, value, opts = {}) {
  const input = h('input', { type: 'number', step: opts.step || 'any', value: value === undefined || value === null ? '' : String(value) });
  const errEl = h('div', { class: 'small', style: 'color:var(--red);text-align:right;display:none' });
  const k = h('span', { class: 'k' }, label);
  if (opts.hint) {
    k.style.cursor = 'help';
    k.style.borderBottom = '1px dotted var(--border-bright)';
    attachWhy(k, () => popContent(label, opts.rows || [], opts.hint));
  }
  const el = h('div', null, h('div', { class: 'kv-edit' }, k, input), errEl);
  const clear = () => { errEl.style.display = 'none'; input.style.borderColor = ''; };
  const bad = (m) => { errEl.textContent = m; errEl.style.display = 'block'; input.style.borderColor = 'var(--red)'; return NaN; };
  input.addEventListener('input', clear);
  return {
    el, input, err: bad,
    raw: (d) => { const v = Number(input.value); return Number.isFinite(v) ? v : d; },
    read() {
      if (String(input.value).trim() === '') return bad('required');
      const v = Number(input.value);
      if (!Number.isFinite(v)) return bad('not a number');
      if (opts.int && !Number.isInteger(v)) return bad('whole number');
      if (opts.min !== undefined && v < opts.min) return bad(`min ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) return bad(`max ${opts.max}`);
      clear();
      return v;
    },
  };
}
// -> plain object of validated numbers, or null if any field is invalid
function readAll(map) {
  let ok = true;
  const out = {};
  for (const [key, f] of Object.entries(map)) {
    const v = f.read();
    if (Number.isNaN(v)) ok = false; else out[key] = v;
  }
  return ok ? out : null;
}
const badFields = () => { toast('Fix the highlighted fields', true); return null; };
const saveRow = (onSave, label = 'Save') => h('div', { class: 'row', style: 'margin-top:14px' },
  h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: onSave }, icon('check'), label));
const subHead = (t) => h('div', { class: 'small', style: 'font-weight:600;margin-bottom:8px' }, t);

/* ---------- shell ---------- */
export async function render(el) {
  el.append(h('div', { class: 'page-head' },
    h('h1', null, 'Settings'),
    h('div', { class: 'sub' }, 'Every number here feeds a score — hover a dotted label to see what it does.')));
  const sections = [scoringSection, pathSection, actionsSection, quietSection, icpSection, importSection];
  const boxes = sections.map(() => h('div', { class: 'section' }));
  boxes.forEach(b => el.append(b));
  await Promise.all(sections.map((fn, i) => section(boxes[i], fn)));
}

async function section(box, fn) {
  const reload = async () => {
    box.innerHTML = '';
    try { await fn(box, reload); }
    catch (e) { if (e.status !== 401) box.append(h('div', { class: 'card' }, errorState(e, reload))); }
  };
  await reload();
}

/* ---------- 1. scoring (warmth) ---------- */
const COEFS = [
  ['a1_recency', 'a1 · recency', 'Multiplies the recency term 2^(−days/half-life). Raise it and one fresh touch dominates the score; lower it and going quiet costs you less.'],
  ['a2_frequency', 'a2 · frequency', 'Multiplies ln(1 + touches in the last 90 days) — sustained contact with diminishing returns, so the 10th email adds far less than the 2nd.'],
  ['a3_reciprocity', 'a3 · reciprocity', 'Multiplies 2·min(inbound, outbound)/total. Raise it to punish one-sided monologues and reward people who actually write back.'],
  ['a4_seniority_touch', 'a4 · seniority', 'Multiplies the seniority weight below (which is 0 until you log a touch). Raise it to give more weight to the role weights configured below.'],
  ['a5_channel_diversity', 'a5 · channels', 'Multiplies distinct channels used / 5. Raise it to prefer a real mix (email + call + met in person) over the same channel repeated.'],
  ['bias', 'bias', 'The baseline before any evidence. Negative keeps strangers cold — σ(−2.5) ≈ 7%. Raise it to warm your whole book, lower it to be stricter.'],
];

async function scoringSection(box, reload) {
  const cfg = await api.get('/api/settings/warmth');
  const co = cfg.coefficients || {}, sw = cfg.seniority_weights || {};
  const fields = {};
  for (const [key, label, hint] of COEFS) fields[key] = numField(label, co[key], { hint, rows: keyRow(`warmth.coefficients.${key}`) });
  const hl = numField('Half-life (days)', cfg.half_life_days, {
    min: 0.5, max: 3650, rows: keyRow('warmth.half_life_days'),
    hint: 'Days for the recency term to halve. At 30, a touch 30 days ago counts half as much as one today, 60 days ago a quarter.',
  });
  const senFields = {};
  for (const key of Object.keys(sw)) {
    senFields[key] = numField(senName(key), sw[key], {
      min: 0, max: 1, rows: keyRow(`warmth.seniority_weights.${key}`),
      hint: `Seniority weight for "${senName(key)}" contacts, feeding a4. 0..1 — how much a logged touch with this level of person is worth.`,
    });
  }

  // live worked example so the coefficients are never abstract
  const preview = h('span');
  const redraw = () => {
    const rec = Math.pow(2, -3 / Math.max(hl.raw(30), 0.5));
    const senW = senFields.OTHER ? senFields.OTHER.raw(0.2) : 0.2;
    const terms = [
      ['a1 · recency (3d ago)', fields.a1_recency.raw(0) * rec],
      ['a2 · ln(1+6 touches)', fields.a2_frequency.raw(0) * Math.log(7)],
      ['a3 · reciprocity 0.8', fields.a3_reciprocity.raw(0) * 0.8],
      ['a4 · seniority (other)', fields.a4_seniority_touch.raw(0) * senW],
      ['a5 · channels 3/5', fields.a5_channel_diversity.raw(0) * 0.6],
      ['bias', fields.bias.raw(0)],
    ];
    const z = terms.reduce((s, t) => s + t[1], 0), score = sigmoid(z);
    preview.innerHTML = '';
    preview.append(scoreChip(`worked example ${fmtPct(score)}`, () => ({
      title: `Sample warmth ${fmtPct(score)}`,
      rows: [...terms.map(([k, v]) => ({ k, v: fmtNum(v), cls: v >= 0 ? 'pos' : 'neg' })), 'sep', { k: 'z (sum)', v: fmtNum(z) }],
      note: 'Hypothetical contact: met 3 days ago, 6 touches in 90d, reciprocity 0.8, 3 of 5 channels. score = σ(z) = 1/(1+e^−z).',
    }), score >= 0.7 ? 'green' : score < 0.35 ? 'dim' : ''));
  };
  [...Object.values(fields), hl, ...Object.values(senFields)].forEach(f => f.input.addEventListener('input', redraw));
  redraw();

  const save = async () => {
    const coefficients = readAll(fields), half_life_days = hl.read(), seniority_weights = readAll(senFields);
    if (!coefficients || Number.isNaN(half_life_days) || !seniority_weights) return badFields();
    await guard(() => api.put('/api/settings/warmth', { ...cfg, coefficients, half_life_days, seniority_weights }), 'Scoring saved');
    reload();
  };

  box.append(h('div', { class: 'card' },
    h('h2', null, 'Scoring — warmth', h('span', { class: 'spacer' }), preview),
    h('div', { class: 'section-note' }, 'warmth = σ(a1·recency + a2·ln(1+freq₉₀) + a3·reciprocity + a4·seniority + a5·channels + bias). Coefficients are log-odds weights: +1 roughly doubles-and-a-half the odds of a contact reading as warm.'),
    h('div', { class: 'settings-grid' }, Object.values(fields).map(f => f.el), hl.el),
    h('div', { class: 'divider' }),
    subHead('Seniority weights (feed a4 · 0..1)'),
    h('div', { class: 'settings-grid' }, Object.values(senFields).map(f => f.el)),
    saveRow(save)));
}

/* ---------- 2. pathfinding ---------- */
async function pathSection(box, reload) {
  const cfg = await api.get('/api/settings/path');
  const base = cfg.base_p || {}, strength = cfg.strength_factor || {};
  const bp = {};
  for (const key of ordered(base, REL_ORDER)) {
    bp[key] = numField(relName(key), base[key], {
      min: 0, max: 1, rows: keyRow(`path.base_p.${key}`),
      hint: `Base probability that a "${relName(key)}" edge actually delivers an intro, before strength and seniority-gap adjustments.`,
    });
  }
  const sf = {};
  for (const s of ordered(strength, ['weak', 'medium', 'strong'])) {
    sf[s] = numField(titleCase(s), strength[s], {
      min: 0, max: 3, rows: keyRow(`path.strength_factor.${s}`),
      hint: `Multiplier on the base probability when you rated the edge "${s}". Above 1 boosts, below 1 discounts.`,
    });
  }
  const sc = {
    seniority_gap_penalty: numField('Seniority-gap penalty', cfg.seniority_gap_penalty, { min: 0, max: 1, rows: keyRow('path.seniority_gap_penalty'), hint: 'A hop loses this much chance per step of seniority gap: an individual contributor introducing a senior executive is a longer shot than a peer-to-peer ask.' }),
    p_min: numField('Minimum hop chance', cfg.p_min, { min: 0, max: 1, rows: keyRow('path.p_min'), hint: 'Floor on any single hop probability — no edge is treated as hopeless.' }),
    p_max: numField('Maximum hop chance', cfg.p_max, { min: 0, max: 1, rows: keyRow('path.p_max'), hint: 'Ceiling on any single hop probability — never claim certainty about a human favour.' }),
    warm_tau: numField('Warm enough to ask', cfg.warm_tau, { min: 0, max: 1, rows: keyRow('path.warm_tau'), hint: 'Warmth at or above this connects you to a person directly, even with no relationship row — earned contact beats declared contact. It is also the line the whole app calls "warm".' }),
    k_paths: numField('Routes per target', cfg.k_paths, { min: 1, max: 10, int: true, step: '1', rows: keyRow('path.k_paths'), hint: 'How many distinct routes the K-best search (Yen\'s algorithm) returns per target.' }),
    max_hops: numField('Longest chain (hops)', cfg.max_hops, { min: 1, max: 8, int: true, step: '1', rows: keyRow('path.max_hops'), hint: 'Longest chain considered. Each hop multiplies probability, so deep paths rarely beat short ones.' }),
    epsilon_failed: numField('After a failed intro', cfg.epsilon_failed, { min: 0, max: 1, rows: keyRow('path.epsilon_failed'), hint: 'What a hop\'s probability collapses to once you mark that intro failed — near zero, not zero, so it can still be a last resort.' }),
    blast_radius_alpha: numField('Damping on their others', cfg.blast_radius_alpha, { min: 0, max: 1, rows: keyRow('path.blast_radius_alpha'), hint: 'A failed intro also damps that person\'s other outgoing intros by this factor: one burnt ask costs goodwill with their neighbours too.' }),
    colleague_company_cap: numField('Colleague cap (people)', cfg.colleague_company_cap, { min: 0, max: 5000, int: true, step: '1', rows: keyRow('path.colleague_company_cap'), hint: 'Colleague edges are only assumed inside companies with at most this many people — everyone knows everyone at 12, nobody does at 12,000.' }),
  };
  const save = async () => {
    const base_p = readAll(bp), strength_factor = readAll(sf), rest = readAll(sc);
    if (!base_p || !strength_factor || !rest) return badFields();
    if (rest.p_min > rest.p_max) { sc.p_max.err('must be ≥ the minimum'); toast('Maximum hop chance must be at least the minimum', true); return; }
    await guard(() => api.put('/api/settings/path', { ...cfg, base_p, strength_factor, ...rest }), 'Pathfinding saved');
    reload();
  };

  box.append(h('div', { class: 'card' },
    h('h2', null, 'Pathfinding'),
    h('div', { class: 'section-note' }, 'hop p = clip(base_p × strength × (1 − gap_penalty · |rank gap|), p_min, p_max); a route\'s P is the product of its hops, so every extra hand-off costs you.'),
    subHead('Base probability per relationship type'),
    h('div', { class: 'settings-grid' }, Object.values(bp).map(f => f.el)),
    h('div', { class: 'divider' }),
    subHead('Strength multipliers'),
    h('div', { class: 'settings-grid' }, Object.values(sf).map(f => f.el)),
    h('div', { class: 'divider' }),
    subHead('Search, thresholds & failure damping'),
    h('div', { class: 'settings-grid' }, Object.values(sc).map(f => f.el)),
    saveRow(save)));
}

/* ---------- 3. actions, cadence, budget, uplifts ---------- */
async function actionsSection(box, reload) {
  const [actions, cadence, plan, uplifts] = await Promise.all([
    api.get('/api/settings/actions'), api.get('/api/settings/cadence'), api.get('/api/settings/plan'),
    api.get('/api/settings/uplifts'),
  ]);

  // hours per action
  const hf = {};
  for (const key of Object.keys(actions)) {
    hf[key] = numField(humanizeAction(key), actions[key]?.hours, {
      min: 0.05, max: 40, step: '0.25', rows: keyRow(`actions.${key}.hours`),
      hint: `Your time cost for one ${humanizeAction(key).toLowerCase()}. The allocator ranks picks by uplift × priority per hour, so this directly decides what makes the weekly plan.`,
    });
  }
  const saveHours = async () => {
    const got = readAll(hf);
    if (!got) return badFields();
    const next = { ...actions };
    for (const key of Object.keys(hf)) next[key] = { ...(actions[key] || {}), hours: got[key] };
    await guard(() => api.put('/api/settings/actions', next), 'Action hours saved');
    reload();
  };

  // cadence per stage + weekly budget
  const cf = {};
  for (const s of ordered(cadence, CADENCE_STAGES)) {
    cf[s] = numField(stageName(s), cadence[s], {
      min: 1, max: 365, int: true, step: '1', rows: keyRow(`cadence.${s}`),
      hint: `Target days between touches while an opportunity sits at "${stageName(s)}". Overdue-ness = days since last touch ÷ this, capped at 3× — it drives the priority queue.`,
    });
  }
  const wh = numField('Hours per week', plan.weekly_hours, {
    min: 0.5, max: 80, step: '0.5', rows: keyRow('plan.weekly_hours'),
    hint: 'Default hours per week the allocator may spend. The Today page slider overrides it for one view; this is the saved budget.',
  });
  const saveCadence = async () => {
    const got = readAll(cf), hours = wh.read();
    if (!got || Number.isNaN(hours)) return badFields();
    await guard(async () => {
      await api.put('/api/settings/cadence', { ...cadence, ...got });
      await api.put('/api/settings/plan', { ...plan, weekly_hours: hours });
    }, 'Cadence & budget saved');
    reload();
  };

  const bw = uplifts.buckets?.warmth || { cold: 0.35, warm: 0.7 };
  const cellsOf = (a) => BUCKETS.flatMap(b => TIERS.map(t => ({ b, t, v: uplifts.table?.[a]?.[b]?.[t] ?? uplifts.default })));
  const upliftTable = h('table', { class: 'uplift-grid' },
    h('thead', null, h('tr', null, h('th', { style: 'text-align:left' }, 'action'),
      BUCKETS.map(b => TIERS.map(t => h('th', null, `${b}·${t}`))))),
    h('tbody', null, Object.keys(uplifts.table || {}).map(a => {
      const cells = cellsOf(a);
      const best = cells.reduce((x, y) => (y.v > x.v ? y : x), cells[0]);
      return h('tr', null,
        h('td', { style: 'text-align:left;white-space:nowrap' }, scoreChip(humanizeAction(a), () => ({
          title: humanizeAction(a),
          rows: [
            { k: 'Hours', v: fmtNum(actions[a]?.hours) },
            { k: 'Best cell', v: `${best.b} · ${best.t} → ${fmtPct1(best.v)}` },
            { k: 'Δp range', v: `${fmtPct1(Math.min(...cells.map(c => c.v)))} … ${fmtPct1(Math.max(...cells.map(c => c.v)))}` },
          ],
          note: 'Δp is a hand-set prior for how much this action lifts the opportunity\'s odds — it ranks this week\'s actions against each other, it is not a measured rate. Edit hours above, not the table.',
        }), 'dim')),
        cells.map(c => h('td', {
          class: c.v < 0 ? 'neg' : c.v > 0 ? 'pos' : '',
          title: `${humanizeAction(a)} · ${c.b} contact · ${c.t} value → Δp ${fmtPct1(c.v)}`,
        }, fmtNum(c.v, 3))));
    })));

  box.append(h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' },
      h('h2', null, 'Actions — hours per touch'),
      h('div', { class: 'section-note' }, 'The only cost side of the plan. Greedy allocation sorts by Δp × priority ÷ hours and takes at most one action per company.'),
      h('div', { class: 'settings-grid' }, Object.values(hf).map(f => f.el)),
      saveRow(saveHours, 'Save hours')),
    h('div', { class: 'card' },
      h('h2', null, 'Cadence & weekly budget'),
      h('div', { class: 'section-note' }, 'Target days between touches per pipeline stage, plus how many hours a week you can actually spend.'),
      h('div', { class: 'settings-grid' }, Object.values(cf).map(f => f.el)),
      h('div', { class: 'divider' }),
      h('div', { class: 'settings-grid' }, wh.el),
      saveRow(saveCadence, 'Save cadence')),
  ));
  box.append(h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', null, 'Priority tiers'),
    h('div', { class: 'section-note' }, 'Priority (1–5 ★) on an opportunity picks which uplift column below an action reads: 1–2 ★ low, 3 ★ mid, 4–5 ★ high. Nothing to tune here — it is a fixed mapping, shown so the uplift table below makes sense.')));
  box.append(h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', null, 'Action uplifts', h('span', { class: 'count' }, '· read-only')),
    h('div', { class: 'section-note' }, `Δp per action × contact warmth (cold < ${fmtPct(bw.cold)} ≤ warm < ${fmtPct(bw.warm)} ≤ hot) × priority tier. Missing cell falls back to ${fmtNum(uplifts.default)}. Negative cells are real: a detailed review with a new contact loses ground.`),
    h('div', { style: 'overflow-x:auto' }, upliftTable)));
}

/* ---------- 4. going quiet (drives the Today "going quiet" card) ---------- */
async function quietSection(box, reload) {
  // the warm line lives in path.warm_tau and is editable two cards up, so read it
  // rather than quoting 35% at a user who may have moved it — but a failure there
  // must not take this card down with it, it only decides one gloss
  const [cfg, pathCfg] = await Promise.all([
    api.get('/api/settings/quiet'),
    api.get('/api/settings/path').catch(() => ({})),
  ]);
  // Fallbacks match what the engine itself falls back to when a key is missing
  // (allocator.quietTargetDays / goingQuietAll), so this card can never show a
  // number the Today card would not have used.
  const days = Number(cfg.target_days ?? 45);
  const floor = Number(cfg.min_warmth ?? 0.35);
  const warmTau = Number.isFinite(Number(pathCfg?.warm_tau)) ? Number(pathCfg.warm_tau) : 0.35;
  const f = {
    target_days: numField('Target days between touches', cfg.target_days ?? 45, {
      min: 1, max: 365, int: true, step: '1', rows: keyRow('quiet.target_days'),
      hint: 'Someone you have spoken to before, whose last touch is older than this many days, shows up on Today as going quiet. The pipeline has its own per-stage cadence above; this one is about people rather than opportunities.',
    }),
    min_warmth: numField('Only flag people warmer than', cfg.min_warmth ?? 0.35, {
      min: 0, max: 1, step: '0.05', rows: keyRow('quiet.min_warmth'),
      hint: 'A warmth floor on the list, between 0 and 1: below it you never really had the relationship, so silence is not news. 0 flags everyone you have ever touched, 1 flags nobody.',
    }),
  };
  f.min_warmth.el.append(h('div', { class: 'muted small', style: 'text-align:right' },
    floor >= warmTau
      ? `${fmtPct(floor)} — the same line the app calls “warm” everywhere. Warmth falls while someone is quiet, so this flags only the ones still warm today.`
      : `${fmtPct(floor)} — under the ${fmtPct(warmTau)} line the app calls “warm”. Warmth falls while someone is quiet, so a floor below “warm” is what keeps a decayed old friend on the list.`));

  const save = async () => {
    const got = readAll(f);
    if (!got) return badFields();
    await guard(() => api.put('/api/settings/quiet', { ...cfg, ...got }), 'Going quiet saved');
    reload();
  };

  box.append(h('div', { class: 'card' },
    h('h2', null, 'Going quiet'),
    h('div', { class: 'section-note' },
      `How long a warm contact can go untouched before Today flags them: more than ${fmtNum(days, 0)} days since the last touch, and warmer than ${fmtPct(floor)}. Only people you have actually spoken to can go quiet — a name you have never contacted is not silence, it is a stranger.`),
    h('div', { class: 'settings-grid' }, f.target_days.el, f.min_warmth.el),
    saveRow(save, 'Save going quiet')));
}

/* ---------- 5. Matching profiles ---------- */
async function icpSection(box, reload) {
  const profiles = await api.get('/api/icp');
  const card = h('div', { class: 'card' },
    h('h2', null, 'Matching profiles', h('span', { class: 'count' }, `· ${profiles.length}`), h('span', { class: 'spacer' }),
      h('button', { class: 'tiny', onclick: () => navigate('#/network') }, icon('network'), 'Build one in Network')),
    h('div', { class: 'section-note' }, 'Criteria are edited in Network → Find matches, where you can test a profile against your graph as you type. Rename or retire them here.'));
  if (!profiles.length) {
    card.append(emptyState('No matching profiles yet', 'A profile is a weighted list of criteria — it produces a fit score on every person and company.',
      h('button', { class: 'primary', onclick: () => navigate('#/network') }, icon('network'), 'Open Network')));
  }
  for (const p of profiles) {
    const nameInput = h('input', { type: 'text', value: p.name, style: 'width:100%' });
    const crit = Array.isArray(p.criteria) ? p.criteria : [];
    const wSum = crit.reduce((s, c) => s + (Number(c.weight) || 0), 0);
    card.append(h('div', { class: 'rel-item', style: 'flex-wrap:wrap' },
      // basis, not a fixed floor: on a phone the row wraps and the rename field
      // then takes the whole line instead of a 150px slot next to the chip
      h('div', { class: 'who', style: 'flex:1 1 200px;min-width:150px' }, nameInput),
      scoreChip(crit.length === 1 ? '1 criterion' : `${crit.length} criteria`, () => ({
        title: p.name,
        rows: crit.length
          ? crit.map(c => ({ k: `${c.label || fieldName(c.field)} (w ${fmtNum(c.weight)})`, v: `${opName(c.op)} ${(c.values || []).slice(0, 3).join(' / ') || '—'}` }))
          : [{ k: 'empty', v: 'no criteria' }],
        note: `fit = Σ(weight · matched) ÷ Σ weight, Σ weight = ${fmtNum(wSum)}. Fit is half the matching rank; reach (best path P) is the other half.`,
      }), crit.length ? 'dim' : ''),
      h('button', {
        class: 'tiny', onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) { toast('Name cannot be empty', true); nameInput.focus(); return; }
          if (name === p.name) { toast('Name unchanged'); return; }
          await guard(() => api.patch(`/api/icp/${p.id}`, { name }), 'Renamed');
          reload();
        },
      }, icon('edit'), 'Rename'),
      h('button', {
        class: 'tiny danger', title: 'Delete profile', onclick: async () => {
          if (!await confirmModal(`Delete “${p.name}”?`, 'Its criteria go with it. Nothing else in the CRM changes — people and companies stay.', 'Delete profile')) return;
          await guard(() => api.del(`/api/icp/${p.id}`), 'Deleted');
          reload();
        },
      }, icon('trash'))));
  }
  box.append(card);
}

/* ---------- 6. LinkedIn import ---------- */
async function importSection(box) {
  // Both files at once, identified by their own headers rather than by filename,
  // so it does not matter which order they are picked in or how they are named.
  const picked = { csv: '', messages: '' };
  const out = h('div', { class: 'small muted', style: 'margin-top:10px' });
  const ta = h('textarea', { rows: '4', placeholder: 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAlex,Example,https://linkedin.example/in/alex,,Example Company,Manager,18 Mar 2024' });
  let zipFile = null;   // the whole export, unzipped by the server
  const file = h('input', {
    type: 'file', accept: '.zip,.csv,text/csv,application/zip', multiple: 'multiple',
    style: 'font:13px var(--font);color:var(--muted)',
  });

  const describe = () => {
    const bits = [];
    if (zipFile) bits.push(`${zipFile.name} (${(zipFile.size / 1024 / 1024).toFixed(1)} MB)`);
    if (picked.csv) bits.push('Connections.csv');
    if (picked.messages) bits.push('messages.csv');
    out.style.color = '';
    out.textContent = bits.length ? `Ready: ${bits.join(' + ')} — press Import.` : '';
  };

  file.addEventListener('change', async () => {
    picked.csv = ''; picked.messages = ''; zipFile = null;
    const unknown = [];
    for (const f of [...(file.files || [])]) {
      // The export as downloaded: hand the whole thing over, the server opens it.
      if (/\.zip$/i.test(f.name)) { zipFile = f; continue; }
      let text = '';
      try { text = await f.text(); } catch { continue; }
      const head = text.slice(0, 4000).toLowerCase();
      if (head.includes('conversation id')) picked.messages = text;
      else if (head.includes('first name') && head.includes('connected on')) picked.csv = text;
      else unknown.push(f.name);
    }
    describe();
    if (unknown.length) {
      out.style.color = 'var(--red)';
      out.textContent += ` Ignored (not a LinkedIn export file): ${unknown.join(', ')}.`;
    }
  });

  const report = (r) => {
    out.style.color = 'var(--text)';
    const parts = [];
    if (r.files_found) parts.push(`found ${r.files_found.join(' + ')}`);
    if (r.created_people || r.created_companies || r.skipped) {
      parts.push(`${r.created_people} people, ${r.created_companies} companies, ${r.skipped} already known`);
    }
    if (r.messages) {
      parts.push(`${r.messages.messages_imported} messages scored ${r.messages.people_scored} contacts`
        + (r.messages.people_created ? ` (+${r.messages.people_created} you had messaged but never connected with)` : ''));
    }
    out.textContent = parts.join(' · ') || 'Nothing new to import.';
  };

  const doImport = async () => {
    const csv = (ta.value.trim() || picked.csv).trim();
    if (!zipFile && !csv && !picked.messages) {
      toast('Pick your LinkedIn .zip (or the CSVs inside it) first', true); return;
    }
    try {
      if (zipFile) {
        out.style.color = '';
        out.textContent = `Opening ${zipFile.name}…`;
        // Sent as raw bytes: base64 in JSON would inflate a large export by a third.
        const r = await guard(() => api.postBinary('/api/import/linkedin-zip', zipFile), 'Import done');
        report(r);
        return;
      }
      const payload = {};
      if (csv) payload.csv = csv;
      if (picked.messages) payload.messages = picked.messages;
      report(await guard(() => api.post('/api/import/linkedin', payload), 'Import done'));
    } catch { /* guard already surfaced the error */ }
  };

  box.append(h('div', { class: 'card' },
    h('h2', null, 'Import from LinkedIn'),
    h('div', { class: 'section-note' }, 'LinkedIn → Settings & Privacy → Data privacy → Get a copy of your data → pick the larger archive. They email you a .zip: drop it in below exactly as it downloaded, no unzipping.'),
    h('div', { class: 'row', style: 'margin-bottom:10px;flex-wrap:wrap' }, file,
      h('span', { class: 'muted small' }, 'the .zip itself — or the CSVs from inside it')),
    ta,
    h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' },
      h('span', { class: 'muted small', style: 'flex:1;min-width:200px' },
        'Connections give you the person, their company and title — but no warmth: accepting a request is not a conversation, so they arrive "not scored yet". '
        + 'messages.csv is what scores them, because it carries a date and a direction per message. Group threads and drafts are ignored, and re-importing never double-counts.'),
      h('button', { class: 'primary', onclick: doImport }, icon('plus'), 'Import')),
    out));
}

/* ---------- 7. demo world ---------- */
