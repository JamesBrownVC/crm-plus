// #/network — Tab 1 (multi-hop introduction chains) is DISABLED, see below.
// Tab 2: rank the network against an ICP profile by fit × how warm you are.
// Every probability here is hoverable: no naked numbers.
import { api } from '../api.js';
import {
  h, icon, fmtPct, fmtPct1, fmtNum, relTime, scoreChip, attachWhy, popContent,
  warmthComponentRows, emptyState, errorState, skeleton, modal, confirmModal,
  guard, toast, navigate, autocomplete, relLabel, deptLabel, SENIORITY,
} from '../app.js';

// Multi-hop intro paths are off by design, not unfinished.
//
// A chain like "you -> Nadia -> Théo" needs to know how OTHER people are related
// to each other (worked_with / advises / coinvestor / studied_with). Nothing can
// supply that today: a LinkedIn export contains only YOUR connections, and no
// enrichment provider is wired up. So in real use those edges stay empty and any
// chain the engine draws is a guess dressed as a probability.
//
// What survives on real data — direct warmth (earned from logged interactions)
// and same-company colleague links — is still shown. The engine, its tests and
// the API are untouched; flip this to true once a real source of person-to-person
// edges exists (public investor->company data, or a mailbox co-recipient graph).
const INTRO_PATHS_ENABLED = false;
const INTRO_DISABLED_WHY =
  'They need to know how other people are connected to each other, and nothing '
  + 'feeds the app that yet — a LinkedIn export only lists your own connections.';

// value = the engine's field path, label = what the user reads
const FIELDS = [
  // company.name and person.title are the ONLY fields a LinkedIn import fills, so
  // they are the only ones that can match across the network tier. Listed first.
  ['person.title', 'Person title'],
  ['company.name', 'Company name'],
  ['company.sector', 'Company sector'],
  ['company.stage', 'Company funding stage'],
  ['company.geography', 'Company geography'],
  ['company.kind', 'Company type'],
  ['person.seniority', 'Person seniority'],
  ['person.dept', 'Person team'],
  ['person.location', 'Person location'],
  ['company.tags', 'Company tags'],
  ['person.tags', 'Person tags'],
];
const OPS = [['in', 'is one of'], ['contains', 'contains the text'], ['overlap', 'shares a tag with']];
const fieldLabel = (f) => FIELDS.find(([v]) => v === f)?.[1] || String(f || '—').replace(/[._]/g, ' ');
const opLabel = (o) => OPS.find(([v]) => v === o)?.[1] || String(o || '—');
const relName = (k) => relLabel(k) || String(k || '—').replace(/_/g, ' ');
const STRENGTH = { weak: 'Weak', medium: 'Medium', strong: 'Strong' };
const strengthName = (s) => STRENGTH[s] || (s ? String(s) : '—');
const pctCls = (p) => (p >= 0.5 ? 'green' : p >= 0.2 ? '' : 'dim');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const people = (n) => (n === 1 ? '1 person' : `${n} people`);

/* ---------------- runtime config, so the copy never quotes a stale number ----
   The "no route" copy names the hop limit and the warm threshold. Both are
   editable in #/settings, so read them once instead of hard-coding 5 and 35%. */
let pcfg = null;
async function loadPathCfg() {
  if (pcfg) return pcfg;
  try { pcfg = await api.get('/api/settings/path'); } catch { pcfg = {}; }
  return pcfg;
}
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const hopLimit = () => num(pcfg?.max_hops, 5);
const warmTau = () => num(pcfg?.warm_tau, 0.35);

/* ---------------- shared path rendering (used by BOTH tabs) ---------------- */

function hopWhy(step) {
  const c = step.components || {};
  if (c.rel_type === 'warm_contact') {
    return {
      title: `Warm contact · p = ${fmtPct1(step.p)}`,
      rows: [
        { k: 'Edge type', v: 'warm contact (no stored relationship)' },
        { k: 'Warmth score', v: fmtPct1(c.warmth) },
        'sep',
        ...warmthComponentRows(c.warmth_components),
      ],
      note: `Warmth at or above ${fmtPct(warmTau())} beats any stored relationship, so p = warmth. You can ask directly.`,
    };
  }
  const rows = [
    { k: 'Relationship', v: relName(c.rel_type) },
    { k: 'Base chance for that type (base_p)', v: fmtNum(c.base_p) },
    { k: 'Strength', v: strengthName(c.strength) },
    { k: 'Seniority gap', v: fmtNum(c.gap, 0) },
    'sep',
    { k: 'Hop probability', v: fmtPct1(step.p), cls: 'pos' },
  ];
  if (c.implicit) rows.push({ k: 'Assumed edge', v: 'same small company — not a logged relationship' });
  if (c.failed) rows.push({ k: 'Marked failed', v: 'p → ε', cls: 'neg' });
  if (c.blast_radius_damped) rows.push({ k: 'Blast-radius damping', v: `× ${fmtNum(c.blast_radius_damped)}`, cls: 'neg' });
  return {
    title: `Hop p = ${fmtPct1(step.p)}`,
    rows,
    note: 'p = base_p × strength factor × (1 − penalty × seniority gap), clipped to [5%, 95%].',
  };
}

function pathWhy(path) {
  return {
    title: `Path success ${fmtPct1(path.P)}`,
    rows: [
      ...(path.steps || []).map((s) => ({ k: `${s.from} → ${s.to}`, v: fmtPct1(s.p) })),
      'sep',
      { k: 'Product of hops', v: fmtPct1(path.P), cls: 'pos' },
    ],
    note: 'P = Π p(hop) — every extra broker multiplies the risk, so short warm chains win.',
  };
}

function pnode(id, name, title, cls) {
  const inner = [h('span', { class: 'nm' }, name || '—'), h('span', { class: 'tt' }, title || (cls === 'me' ? 'you' : '—'))];
  // names ellipsise at .pnode's max-width, so the full one lives in the title
  const full = [name, title].filter(Boolean).join(' · ') || 'you';
  return cls === 'me'
    ? h('div', { class: 'pnode me', title: full }, inner)
    : h('a', { class: 'pnode' + (cls ? ' ' + cls : ''), href: `#/people/${id}`, title: full }, inner);
}

// The first ask, as a sentence (S5): a partner-legible instruction, not a
// probability. The % keeps its own popover, so it is still not a naked number.
function askSentence(targetName, path) {
  const steps = path.steps || [];
  if (!steps.length) return null;
  const pct = h('b', { tabindex: '0', style: 'cursor:help;border-bottom:1px dotted var(--border-bright)' }, fmtPct(path.P));
  attachWhy(pct, () => { const d = pathWhy(path); return popContent(d.title, d.rows, d.note); });
  const line = (...kids) => h('div', { class: 'best-path-preview' }, icon('right'), h('span', null, ...kids));
  const nm = (s) => h('b', null, s || 'them');
  if (steps.length === 1) {
    return line('Go straight to ', nm(targetName), ' — no broker needed, ', pct, ' chance this lands.');
  }
  if (steps.length === 2) {
    return line('Ask ', nm(steps[0].to), ' to introduce you to ', nm(targetName), ' — ', pct, ' chance this lands.');
  }
  return line('Ask ', nm(steps[0].to), ' to introduce you to ', nm(steps[1].to),
    ' — the full chain reaches ', nm(targetName), ' at ', pct, '.');
}

// One renderer for every chain on the page. onFail(step) => Promise (optional).
// opts.ask = target name -> the best card also states the first ask in words.
function pathCard(path, rank, onFail, opts = {}) {
  const steps = path.steps || [];
  const chain = h('div', { class: 'chain' });
  if (steps.length) chain.append(pnode(steps[0].from_id, steps[0].from, '', 'me'));
  steps.forEach((s, i) => {
    const pEl = h('span', { class: 'p' + (s.components?.failed ? ' failed' : ''), tabindex: '0' }, fmtPct1(s.p));
    attachWhy(pEl, () => { const d = hopWhy(s); return popContent(d.title, d.rows, d.note); });
    chain.append(h('div', { class: 'hop' },
      pEl,
      h('div', { class: 'arrow-line' }, h('span', { class: 'shaft' }), icon('right')),
      onFail
        ? h('button', {
          class: 'fail-btn', type: 'button',
          title: `Mark the intro ${s.from} → ${s.to} as failed and reroute`,
          onclick: () => onFail(s),
        }, 'intro failed')
        : null));
    chain.append(pnode(s.to_id, s.to, s.to_title, i === steps.length - 1 ? 'target' : ''));
  });
  return h('div', { class: 'card path-card' },
    h('div', { class: 'path-head', style: 'flex-wrap:wrap' },
      h('span', { class: 'plabel' }, rank === 0 ? 'Best path' : `Alt ${rank}`),
      scoreChip(fmtPct1(path.P), () => pathWhy(path), pctCls(path.P)),
      h('span', { class: 'chip' }, plural(path.hops, 'hop'))),
    chain,
    rank === 0 && opts.ask ? askSentence(opts.ask, path) : null);
}

async function drawFails(card, onChange) {
  card.innerHTML = '';
  let fails;
  try {
    fails = await api.get('/api/path/fails');
  } catch (e) {
    if (e.status === 401) { card.classList.add('hidden'); return; }
    // hiding the panel would quietly claim "no failed intros"
    card.classList.remove('hidden');
    card.append(h('h2', null, 'Failed intros'), errorState(e, () => drawFails(card, onChange)));
    return;
  }
  card.classList.toggle('hidden', !fails.length);
  if (!fails.length) return;
  card.append(
    h('h2', null, 'Failed intros', h('span', { class: 'count' }, `· ${fails.length}`)),
    h('div', { class: 'muted small', style: 'margin:-6px 0 10px' },
      'A failed intro collapses that hop to ε and damps the broker’s other intros — the solver reroutes around it.'),
    h('div', { class: 'failed-list' }, fails.map((f) => h('div', { class: 'fi', style: 'flex-wrap:wrap' },
      h('span', { style: 'flex:1;min-width:0' }, `${f.src_name || 'someone'} → ${f.dst_name || 'someone'}`),
      h('span', { class: 'muted small' }, relTime(f.created_at)),
      h('button', {
        class: 'tiny',
        onclick: async () => { await guard(() => api.del(`/api/path/fail/${f.id}`), 'Intro restored'); onChange(); },
      }, icon('undo'), 'Undo')))));
}

/* ---------------- tab 1: path to person ---------------- */

function pathTab(root, targetId) {
  const input = h('input', { type: 'text', placeholder: 'Search a person to reach…' });
  const solveBtn = h('button', { class: 'primary', type: 'button', disabled: true, onclick: () => current && solve(current) },
    icon('network'), 'Find paths');
  const results = h('div');
  const failsCard = h('div', { class: 'card hidden', style: 'margin-top:16px' });
  let current = null;

  autocomplete(input, { people: true, onPick: (it) => { if (!it) return; input.value = it.label; solve(it.id); } });

  root.append(
    h('div', { class: 'card' },
      h('h2', null, 'Path to person'),
      h('div', { class: 'muted small', style: 'margin:-6px 0 12px' },
        'The warmest introduction chains from you, ranked by the probability the whole chain lands.'),
      h('form', { class: 'row', style: 'flex-wrap:wrap', onsubmit: (e) => { e.preventDefault(); if (current) solve(current); } },
        h('span', { class: 'ac-wrap', style: 'flex:1;min-width:200px' }, input),
        solveBtn)),
    results, failsCard);

  async function solve(id) {
    current = id;
    solveBtn.disabled = false;
    results.innerHTML = '';
    results.append(skeleton(2));
    let data;
    try {
      data = await api.post('/api/path/person', { target_person_id: id });
    } catch (e) {
      results.innerHTML = '';
      // a vanishing toast would leave the differentiator looking simply empty
      if (e.status !== 401) results.append(h('div', { class: 'card' }, errorState(e, () => solve(id))));
      return;
    }
    const t = data.target || {};
    if (t.name) input.value = t.name;
    const paths = data.paths || [];
    results.innerHTML = '';
    results.append(h('div', { class: 'page-head', style: 'margin:20px 0 12px' },
      h('div', null,
        h('h1', { style: 'font-size:17px' }, t.name || 'Target'),
        h('div', { class: 'sub' }, [t.title, t.company].filter(Boolean).join(' · ') || 'no title on file')),
      h('span', { class: 'spacer' }),
      paths.length
        ? h('span', { class: 'muted small' }, `${plural(paths.length, 'route')} · best ${fmtPct1(paths[0].P)} in ${plural(paths[0].hops, 'hop')}`)
        : null,
      t.id ? h('button', { onclick: () => navigate(`#/people/${t.id}`) }, 'Open person') : null));

    if (!paths.length) {
      results.append(h('div', { class: 'card' }, emptyState(
        `No route within ${plural(hopLimit(), 'hop')}`,
        `Nothing in your graph connects you to them yet. Log a relationship, or log a touch — warmth above ${fmtPct(warmTau())} creates its own route.`,
        t.id ? h('button', { class: 'primary', onclick: () => navigate(`#/people/${t.id}`) }, icon('plus'), `Open ${t.name || 'them'}`) : null,
        h('button', { onclick: () => navigate('#/settings') }, 'Tune pathfinding'))));
    } else {
      paths.forEach((p, i) => results.append(pathCard(p, i, async (s) => {
        await guard(() => api.post('/api/path/fail', { src_person: s.from_id, dst_person: s.to_id }),
          `${s.from} → ${s.to} marked failed — rerouting`);
        solve(current);
      }, { ask: t.name })));
    }
    await drawFails(failsCard, () => solve(current));
  }

  if (targetId) solve(targetId);
  else drawFails(failsCard, () => current && solve(current));
}

/* ---------------- tab 2: find ICP ---------------- */

// app.js's seniorityLabel prints nothing for OTHER; "what is on file" needs a
// word either way, so read the full list — inside the call, never at module
// evaluation: app.js imports this view, so its exports are still in the TDZ.
const senName = (s) => SENIORITY.find(([k]) => k === s)?.[1] || String(s ?? '—');
// company.kind and person.dept are the other enums a criterion can read; sectors,
// funding stages and titles are already the words the user typed (and stay in the
// same form the Companies views use, so 'series-a' means one thing app-wide).
const COMPANY_KIND = { startup: 'Startup', fund: 'Fund', corporate: 'Corporate', other: 'Other' };
const valueLabel = (field, v) => {
  const s = String(v);
  if (field === 'person.seniority') return senName(s);
  if (field === 'person.dept') return deptLabel(s) || s;
  if (field === 'company.kind') return COMPANY_KIND[s] || s;
  return s.replace(/_/g, ' ');
};
const actualText = (field, a) => {
  const arr = (Array.isArray(a) ? a : [a]).filter((x) => x !== null && x !== undefined && String(x).trim() !== '');
  const t = arr.map((x) => valueLabel(field, x)).join(', ').trim() || 'nothing on file';
  return t.length > 26 ? t.slice(0, 25) + '…' : t;
};

/* Non-negotiable 4 at the criterion level. fit.js used to collapse "nothing
   recorded" and "wrong value" into the same unmatched 0, so a LinkedIn-imported
   contact with no sector/stage/geography read as ✗ — three times: evidence
   against the person, when it is really an admission about the CRM. The engine
   now flags each row `known` and reports `coverage` (share of criterion weight
   it could actually read). Both are read defensively: a payload without them
   keeps the old two-state rendering, and the score itself is untouched, so the
   ranked list is identical apart from the labels. */
const unknownCrit = (b) => b?.known === false;
const critRows = (fit) => (Array.isArray(fit?.breakdown) ? fit.breakdown : []);
const knownCrits = (bd) => bd.filter((b) => !unknownCrit(b)).length;
const coverageOf = (fit) => {
  const c = fit?.coverage;
  // a missing/blank/non-numeric field is "unknown", never 0 — Number('') is 0,
  // and reading that as "no data" would blank out a fit the engine did compute
  if (typeof c !== 'number' && !(typeof c === 'string' && c.trim() !== '')) return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
};
const partialFit = (fit) => { const c = coverageOf(fit); return c !== null && c < 1; };
// nothing readable at all: a percentage here would be a number nobody can defend
const blankFit = (fit) => coverageOf(fit) === 0;
// what the fit is worth saying inside a popover row
const fitRowValue = (fit) => {
  if (blankFit(fit)) return 'no data yet';
  const bd = fit?.breakdown || [];
  return partialFit(fit)
    ? `${fmtPct(fit.score)} · on ${knownCrits(bd)} of ${bd.length} criteria`
    : fmtPct(fit.score);
};

// fieldById maps criterion id -> engine field, so a raw enum in `actual`
// (FOUNDER, startup) can be printed in the user's words.
function fitWhy(fit, fieldById) {
  const bd = fit.breakdown || [];
  const crit = (b) => `${b.label || 'criterion'} (w ${fmtNum(b.weight, 2)})`;
  return {
    title: blankFit(fit) ? 'Profile fit — no data yet' : `Profile fit ${fmtPct(fit.score)}`,
    rows: bd.length
      ? bd.map((b) => (unknownCrit(b)
        // no pos/neg class: this is neither a match nor a mismatch
        ? { k: crit(b), v: 'no data yet' }
        : {
          k: crit(b),
          v: b.matched ? '✓ match' : `✗ ${actualText(fieldById?.get(b.id), b.actual)}`,
          cls: b.matched ? 'pos' : 'neg',
        }))
      : [{ k: 'No criteria', v: '—' }],
    note: partialFit(fit)
      ? `Scored on ${knownCrits(bd)} of ${bd.length} criteria — the rest have nothing recorded on this person yet.`
      : 'fit = Σ(weight × match) / Σ weight — a company-only field can never match a person criterion.',
  };
}

// Non-negotiable 4: with no path AND no logged contact, the engine's reach is
// the σ(bias) warmth floor — a number derived from nothing. Say so instead.
const noRoute = (t) => t.reach_p === 0 && t.direct_touches === 0 && !(t.paths || []).length;

function reachWhy(t) {
  const name = t.person?.name || 'this person';
  if (noRoute(t)) {
    return {
      title: `Reachability — ${name}`,
      rows: [
        { k: 'Best intro chain found', v: `none within ${plural(hopLimit(), 'hop')}` },
        { k: 'Direct contact logged', v: 'none' },
      ],
      note: 'Nothing to route through yet — log a relationship or a touch and solve again.',
    };
  }
  const touched = t.direct_touches !== 0;
  // Untouched but routable, and the ranking still took the higher number: that
  // number is the σ(bias) warmth floor, not evidence. It has to be named, or the
  // popover shows a reach above its own chain with nothing accounting for the gap.
  const floored = !touched && (t.reach || 0) > (t.reach_p || 0) + 1e-9;
  return {
    title: `Reach ${fmtPct1(t.reach)} — ${name}`,
    rows: [
      { k: 'Best intro chain (reach_p)', v: t.reach_p ? fmtPct1(t.reach_p) : `none within ${plural(hopLimit(), 'hop')}` },
      { k: 'Direct warmth', v: touched ? fmtPct1(t.direct_warmth) : 'never touched' },
      ...(floored ? [{ k: 'Baseline for a never-touched contact (σ(bias) floor)', v: fmtPct1(t.direct_warmth), cls: 'neg' }] : []),
      'sep',
      { k: 'reach = the better of the two', v: fmtPct1(t.reach), cls: 'pos' },
    ],
    note: floored
      ? 'The chain is weaker than the floor every unknown contact starts at, so the ranking used the floor — a placeholder, not a route. Treat the chain above as the real one.'
      : !touched
        ? 'The intro chain is the only route — you have never logged contact with them directly.'
        : (t.reach_p || 0) >= (t.direct_warmth || 0)
          ? 'The intro chain is the better route here — warmth alone would not carry the ask.'
          : 'You are already warm enough to reach them directly; no broker needed.',
  };
}

function rankWhy(t, fit) {
  if (noRoute(t)) {
    return {
      title: `Worth chasing ${fmtPct(t.rank_score)}`,
      rows: [
        { k: 'Profile fit', v: fitRowValue(fit) },
        { k: 'Route to them', v: 'none logged yet' },
        'sep',
        { k: 'Worth chasing', v: fmtPct(t.rank_score), cls: 'pos' },
        { k: 'rank_score (engine)', v: fmtNum(t.rank_score, 3) },
      ],
      note: 'ranked on profile fit alone — no route logged yet',
    };
  }
  return {
    title: `Worth chasing ${fmtPct(t.rank_score)}`,
    rows: [
      { k: 'Profile fit', v: fitRowValue(fit) },
      { k: 'Reach', v: fmtPct1(t.reach) },
      'sep',
      { k: 'fit × reach', v: fmtPct(t.rank_score), cls: 'pos' },
      { k: 'rank_score (engine)', v: fmtNum(t.rank_score, 3) },
    ],
    note: 'Profile fit × access: matching criteria and a recorded route both contribute to this ranking.',
  };
}

function targetCard(t, onRerun, fieldById) {
  const p = t.person || {};
  const fit = t.fit || { score: 0, breakdown: [] };
  const paths = t.paths || [];
  const best = paths[0];
  const dead = noRoute(t);
  // no criterion could be read: say so on the chip and in the formula line, but
  // leave rank_score exactly as the engine ranked it
  const noFit = blankFit(fit);
  const fitText = noFit ? 'no fit data yet' : `fit ${fmtPct(fit.score)}`;

  const pathsBox = h('div', { class: 'target-paths hidden' });
  let toggle = null;
  if (INTRO_PATHS_ENABLED) {
    paths.forEach((pp, i) => pathsBox.append(pathCard(pp, i, async (s) => {
      await guard(() => api.post('/api/path/fail', { src_person: s.from_id, dst_person: s.to_id }),
        `${s.from} → ${s.to} marked failed — re-ranking`);
      onRerun();
    })));
    const label = () => (pathsBox.classList.contains('hidden') ? `Show ${plural(paths.length, 'path')}` : 'Hide paths');
    toggle = h('button', {
      class: 'tiny', disabled: !paths.length,
      onclick: () => { pathsBox.classList.toggle('hidden'); toggle.textContent = label(); },
    }, paths.length ? label() : 'No paths');
  }

  // With broker chains off, only say what real data supports: a direct
  // relationship you have earned, or nothing.
  const directOnly = !INTRO_PATHS_ENABLED;
  const unscored = directOnly && (Number(t.direct_touches) || 0) === 0;
  const preview = h('div', { class: 'best-path-preview' });
  if (directOnly) {
    const warm = Number(t.direct_warmth) || 0;
    if ((Number(t.direct_touches) || 0) > 0) {
      preview.append('You know them directly — warmth ',
        scoreChip(fmtPct(warm), () => reachWhy(t), pctCls(warm)));
    } else {
      // Never contacted, as far as the app knows — which is not the same as
      // distant. Silence on LinkedIn is not evidence. Ask instead of guessing,
      // and record the answer as a real dated touch so it decays like any other.
      preview.append(h('span', { class: 'muted' }, 'Not scored — when did you last speak?'));
      const last = [['0', 'This week'], ['21', 'This month'], ['120', 'A few months'], ['400', 'Over a year'], [null, 'Never']];
      for (const [days, label] of last) {
        preview.append(h('button', {
          class: 'tiny', style: 'margin-left:6px',
          onclick: async () => {
            if (days === null) { toast('Left unscored'); return; }
            const ts = new Date(Date.now() - Number(days) * 86400000).toISOString();
            await guard(() => api.post('/api/interactions', {
              person_id: t.person.id, kind: 'meeting', direction: 'outbound',
              ts, summary: 'Last spoke (recorded during profile review)',
            }), `${t.person.name} scored`);
            onRerun();
          },
        }, label));
      }
    }
  } else if (best && best.steps?.length) {
    preview.append('via ', h('b', null, best.steps[0].from));
    best.steps.forEach((s) => preview.append(' → ', h('b', null, s.to)));
    preview.append(scoreChip(fmtPct1(best.P), () => pathWhy(best), pctCls(best.P)));
  } else if (dead) {
    preview.append('No route yet — one relationship or one logged touch makes them reachable.');
  } else {
    preview.append('No broker chain — your own warmth is the route.');
  }

  return h('div', { class: 'card target-card hoverable' },
    h('div', { class: 'target-head' },
      h('div', { class: 'who' },
        h('a', { class: 'nm', href: `#/people/${p.id}` }, p.name || '—'),
        h('div', { class: 'sub' }, [p.title, p.company, p.location].filter(Boolean).join(' · ') || 'no details')),
      h('div', { class: 'target-scores' },
        noFit
          ? scoreChip('fit — no data', () => fitWhy(fit, fieldById), 'dim')
          : scoreChip(`fit ${fmtPct(fit.score)}`, () => fitWhy(fit, fieldById), fit.score >= 0.6 ? 'green' : fit.score >= 0.3 ? '' : 'dim'),
        // No warmth number without evidence: an unscored contact shows its state,
        // not a sigmoid floor dressed up as a measurement.
        unscored
          ? scoreChip('not scored yet', () => reachWhy(t), 'dim')
          : scoreChip(`warmth ${fmtPct1(t.reach)}`, () => reachWhy(t), 'blue'),
        unscored ? null : scoreChip(`worth chasing ${fmtPct(t.rank_score)}`, () => rankWhy(t, fit)),
        toggle),
      h('div', { class: 'rank-formula', style: 'flex-basis:100%' },
        unscored
          ? `${fitText} · no contact recorded yet`
          : noFit
            ? `${fitText} · warmth ${fmtPct1(t.reach)} · worth chasing ${fmtPct(t.rank_score)}`
            : `fit ${fmtPct(fit.score)} × warmth ${fmtPct1(t.reach)} = worth chasing ${fmtPct(t.rank_score)}`)),
    preview,
    INTRO_PATHS_ENABLED && best ? askSentence(p.name, best) : null,
    pathsBox);
}

async function icpTab(root) {
  // Which population to sweep. The whole imported network is where a user finds
  // people they have never considered; the roster re-ranks the ones already chosen.
  const scopeSel = h('select', { title: 'Which people to score against the profile' },
    h('option', { value: 'all' }, 'Everyone'),
    h('option', { value: 'network' }, 'My LinkedIn network'),
    h('option', { value: 'roster' }, 'My roster only'));
  scopeSel.value = 'all';
  const sel = h('select', { style: 'flex:1;min-width:150px' });
  const rowsEl = h('div');
  const results = h('div');
  const dirtyHint = h('span', { class: 'muted small hidden' }, 'unsaved edits');
  let profiles = [], profilesErr = null, dirty = false, idSeq = 0;

  const addBtn = h('button', { class: 'tiny', type: 'button', onclick: () => { addRow(); markDirty(); } }, icon('plus'), 'Add criterion');
  const runBtn = h('button', { class: 'primary', type: 'button', onclick: () => run() }, icon('spark'), 'Run');
  const saveBtn = h('button', { type: 'button', onclick: saveAs }, 'Save as profile');
  const updBtn = h('button', { type: 'button', disabled: true, onclick: updateProfile }, 'Update profile');
  const delBtn = h('button', { class: 'danger icon-btn', type: 'button', disabled: true, title: 'Delete profile', onclick: delProfile }, icon('trash'));
  const retryBtn = h('button', { class: 'tiny hidden', type: 'button', onclick: () => firstView(true) }, icon('undo'), 'Retry');

  const hdr = (t) => h('span', { class: 'muted', style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.6px' }, t);
  // the shell collapses .crit-row to one column below 760px, where a column
  // header would read as four stray labels stacked above the first row — the
  // shell's own .col-optional (display:none inside that same media query) drops
  // it there, so no resize listener has to be kept alive per visit
  const headRow = h('div', { class: 'crit-row col-optional' }, hdr('field'), hdr('test'), hdr('values (comma separated)'), hdr('weight'), h('span'));

  root.append(
    h('div', { class: 'card' },
      h('h2', { style: 'flex-wrap:wrap' }, 'Find matches',
        h('span', { class: 'spacer' }),
        h('span', { class: 'row small muted', style: 'flex-wrap:wrap' },
          'Search', scopeSel, 'Profile', sel, retryBtn, delBtn)),
      h('div', { class: 'muted small', style: 'margin:-6px 0 12px' },
        'Score every person against your criteria, then rank by how warm you are with them.'),
      headRow,
      rowsEl,
      h('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' },
        addBtn, h('span', { class: 'spacer' }), dirtyHint, saveBtn, updBtn, runBtn)),
    results);

  function markDirty() { dirty = true; updateButtons(); }
  function updateButtons() {
    const hasSel = !!sel.value;
    updBtn.disabled = !hasSel || !dirty;
    delBtn.disabled = !hasSel;
    dirtyHint.classList.toggle('hidden', !(hasSel && dirty));
  }

  const autoLabel = (field, op, values) => `${fieldLabel(field)} ${opLabel(op)} ${values.join(' / ') || '—'}`;

  function addRow(cr) {
    const autoId = cr?.id ?? `c${++idSeq}`;
    const field = h('select', { 'aria-label': 'Field to test', title: 'Field to test' },
      FIELDS.map(([v, lb]) => h('option', { value: v, selected: v === (cr?.field || FIELDS[0][0]) }, lb)));
    const op = h('select', { 'aria-label': 'Test to apply', title: 'Test to apply' },
      OPS.map(([v, lb]) => h('option', { value: v, selected: v === (cr?.op || 'in') }, lb)));
    const values = h('input', { type: 'text', 'aria-label': 'Values, comma separated', title: 'Values, comma separated', placeholder: 'product, operations', value: (cr?.values || []).join(', ') });
    const weight = h('input', { type: 'number', min: '0', step: '0.5', 'aria-label': 'Weight', title: 'Weight — how much this criterion counts', value: String(cr?.weight ?? 1) });
    const row = h('div', { class: 'crit-row' }, field, op, values, weight,
      h('button', { class: 'ghost icon-btn', type: 'button', title: 'Remove criterion', onclick: () => { row.remove(); markDirty(); } }, icon('x')));
    row._read = () => {
      const vals = values.value.split(',').map((s) => s.trim()).filter(Boolean);
      const w = Number(weight.value);
      const same = cr && cr.field === field.value && cr.op === op.value && Number(cr.weight) === w
        && (cr.values || []).map(String).join('|').toLowerCase() === vals.join('|').toLowerCase();
      return {
        id: autoId,
        label: same && cr.label ? cr.label : autoLabel(field.value, op.value, vals),
        field: field.value, op: op.value, values: vals,
        weight: Number.isFinite(w) && w > 0 ? w : 1,
      };
    };
    rowsEl.append(row);
  }
  rowsEl.addEventListener('input', markDirty);
  rowsEl.addEventListener('change', markDirty);

  const read = () => [...rowsEl.children].map((r) => r._read()).filter((c) => c.values.length);

  sel.onchange = () => { loadSelected(); if (sel.value) run(); };

  function loadSelected() {
    const prof = profiles.find((p) => String(p.id) === sel.value);
    if (prof) {
      rowsEl.innerHTML = '';
      (prof.criteria || []).forEach(addRow);
    }
    if (!rowsEl.children.length) addRow();
    dirty = false;
    updateButtons();
  }

  async function loadProfiles(selectId) {
    profilesErr = null;
    try { profiles = await api.get('/api/icp'); }
    catch (e) { profiles = []; if (e.status !== 401) profilesErr = e; }
    sel.innerHTML = '';
    if (profilesErr) {
      // an empty select would claim "you have no profiles", which is not what happened
      sel.append(h('option', { value: '', disabled: true, selected: true }, 'Couldn’t load your saved profiles — try again'));
    } else {
      sel.append(h('option', { value: '' }, profiles.length ? '— ad-hoc criteria —' : '— no saved profiles —'));
      for (const p of profiles) sel.append(h('option', { value: String(p.id) }, p.name));
      sel.value = selectId != null && profiles.some((p) => p.id === selectId) ? String(selectId) : '';
    }
    retryBtn.classList.toggle('hidden', !profilesErr);
    loadSelected();
  }

  async function run() {
    const criteria = read();
    const selId = sel.value ? Number(sel.value) : null;
    const useProfile = selId && !dirty;
    if (!useProfile && !criteria.length) { toast('Give at least one criterion some values', true); return; }
    const used = useProfile ? (profiles.find((p) => p.id === selId)?.criteria || []) : criteria;
    const fieldById = new Map(used.map((c) => [c.id, c.field]));
    results.innerHTML = '';
    results.append(skeleton(2));
    let targets, res;
    try {
      // order='fit' with a generous limit: profile fit is computed from company and
      // title alone, so it works for people you have never spoken to. Ranking by
      // fit x warmth server-side would cut exactly those people before they ever
      // reach the client, and they are the point of an import.
      res = await api.post('/api/path/icp',
        { ...(useProfile ? { icp_id: selId } : { criteria }), limit: 60, order: 'fit', scope: scopeSel.value });
      targets = res.rows;
      scanned = res.scanned;
    } catch (e) {
      results.innerHTML = '';
      if (e.status !== 401) results.append(h('div', { class: 'card' }, errorState(e, () => run())));
      return;
    }
    results.innerHTML = '';
    // With broker chains off, the server's `reach` (= best of chain vs direct) would
    // still carry a multi-hop number we no longer show — leaving the headline figure
    // disagreeing with the "you know them directly" line underneath. Re-base reach on
    // direct warmth only, re-rank, and the card tells one story.
    if (!INTRO_PATHS_ENABLED) {
      targets = targets.map((t) => {
        const direct = Number(t.direct_warmth) || 0;
        const rank = Math.round((t.fit?.score || 0) * direct * 1e4) / 1e4;
        return { ...t, reach: direct, reach_p: 0, paths: [], rank_score: rank };
      });
    }
    if (!targets.length) {
      // A criterion nobody in scope has a value for is the usual cause, and it is
      // not the user's fault: a LinkedIn export carries no sector, stage or
      // geography, so those criteria can only ever match people typed in by hand.
      const blind = (res.coverage || []).filter((c) => c.known === 0);
      const detail = blind.length
        ? `Nothing in this scope has a value recorded for: ${blind.map((c) => c.label || c.field).join(', ')}. `
          + 'A LinkedIn import only carries job title and company name — sector, stage, geography '
          + 'and location are blank until you fill them in. Try "Person title contains" instead.'
        : `All ${res.scanned} people in scope scored zero fit. Relax it: drop a row, widen the values, `
          + 'or switch "is one of" to "contains the text" for titles.';
      results.append(h('div', { class: 'card' }, emptyState('Nobody matches this profile', detail,
        h('button', { onclick: () => addBtn.scrollIntoView({ block: 'center' }) }, 'Edit the criteria'))));
      return;
    }
    renderTargets(targets, fieldById);
  }

  // Fit and warmth are independent axes and are filtered independently: a perfect
  // profile match you have never met is a real lead (go meet them), and so is a
  // warm contact who half-matches. Collapsing them into one number hides both.
  const view = { sort: 'fit', show: 'all', minFit: 0 };
  // says how many people were actually scanned, so "3 matches" is never mistaken
  // for "3 people exist"
  let scanned = 0;
  const scopeLabel = () => {
    const what = scopeSel.value === 'roster' ? 'your roster'
      : scopeSel.value === 'network' ? 'your LinkedIn network' : 'everyone';
    return `${scanned} scanned in ${what}`;
  };

  function renderTargets(all, fieldById) {
    results.innerHTML = '';
    const scored = (t) => (Number(t.direct_touches) || 0) > 0;
    const pick = (label, key, options) => {
      const s = h('select', { onchange: () => { view[key] = s.value; draw(); } },
        ...options.map(([v, l]) => h('option', { value: v }, l)));
      s.value = String(view[key]);
      return h('label', { class: 'row', style: 'gap:6px;align-items:center' },
        h('span', { class: 'muted small' }, label), s);
    };

    const controls = h('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;margin:16px 0 4px' },
      pick('Sort by', 'sort', [['fit', 'Profile fit'], ['warmth', 'Warmth'], ['combined', 'Fit × warmth']]),
      pick('Show', 'show', [['all', 'Everyone'], ['scored', 'Contacted only'], ['pending', 'Not scored yet']]),
      pick('Min fit', 'minFit', [['0', 'Any fit'], ['0.25', '25%+'], ['0.5', '50%+'], ['0.75', '75%+']]));

    const head = h('div', { class: 'page-head', style: 'margin:8px 0 12px' });
    const list = h('div');
    results.append(controls, head, list);

    function draw() {
      const min = Number(view.minFit) || 0;
      const rows = all
        .filter((t) => (t.fit?.score || 0) >= min)
        .filter((t) => (view.show === 'all' ? true : view.show === 'scored' ? scored(t) : !scored(t)))
        .sort((a, b) => (view.sort === 'fit'
          ? (b.fit?.score || 0) - (a.fit?.score || 0) || b.rank_score - a.rank_score
          : view.sort === 'warmth'
            ? (b.direct_warmth || 0) - (a.direct_warmth || 0) || (b.fit?.score || 0) - (a.fit?.score || 0)
            : b.rank_score - a.rank_score)
          || a.person.id - b.person.id);

      const pendingCount = all.filter((t) => !scored(t)).length;
      head.innerHTML = '';
      head.append(h('div', null,
        h('h1', { style: 'font-size:17px' }, 'Profile matches'),
        h('div', { class: 'sub' },
          `${people(rows.length)} shown of ${all.length} matching, from ${scopeLabel()}`
          + (pendingCount ? ` · ${pendingCount} not scored yet` : ''))));

      list.innerHTML = '';
      if (!rows.length) {
        list.append(h('div', { class: 'card' }, emptyState('Nothing at these settings',
          'Lower the minimum fit, or switch "Show" back to everyone.',
          h('button', {
            onclick: () => { view.minFit = 0; view.show = 'all'; renderTargets(all, fieldById); },
          }, 'Reset filters'))));
        return;
      }
      for (const t of rows) list.append(targetCard(t, () => run(), fieldById));
    }
    draw();
  }

  function saveAs() {
    const criteria = read();
    if (!criteria.length) { toast('Give at least one criterion some values', true); return; }
    const nameIn = h('input', { type: 'text', placeholder: 'e.g. Regional product leaders' });
    const m = modal('Save Matching profile', h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const nm = nameIn.value.trim();
        if (!nm) { nameIn.focus(); return; }
        const prof = await guard(() => api.post('/api/icp', { name: nm, criteria }), 'Profile saved');
        m.close();
        await loadProfiles(prof?.id);
        run();
      },
    }, h('label', { class: 'field' }, 'Name', nameIn),
      h('div', { class: 'muted small' }, `${criteria.length === 1 ? '1 criterion' : `${criteria.length} criteria`} will be stored with this profile.`),
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  }

  async function updateProfile() {
    const prof = profiles.find((p) => String(p.id) === sel.value);
    if (!prof) return;
    await guard(() => api.patch(`/api/icp/${prof.id}`, { criteria: read() }), `${prof.name} updated`);
    await loadProfiles(prof.id);
    run();
  }

  async function delProfile() {
    const prof = profiles.find((p) => String(p.id) === sel.value);
    if (!prof) return;
    if (!await confirmModal(`Delete “${prof.name}”?`, 'The criteria go with it. Targets already found stay on screen until you run again.', 'Delete profile')) return;
    await guard(() => api.del(`/api/icp/${prof.id}`), 'Profile deleted');
    await loadProfiles(null);
  }

  async function firstView(reload) {
    if (reload) await loadProfiles(null);
    results.innerHTML = '';
    if (profilesErr) {
      results.append(h('div', { class: 'card' }, errorState(profilesErr, () => firstView(true))));
      return;
    }
    if (profiles.length) { sel.value = String(profiles[0].id); loadSelected(); run(); return; }
    results.append(h('div', { class: 'card' }, emptyState('No matching profiles yet',
      'Set your criteria above — one row per criterion — then hit Run. Person title and company name are the fields that work across imported contacts.',
      h('button', { class: 'primary', onclick: () => run() }, icon('spark'), 'Run these criteria'),
      h('button', { onclick: () => navigate('#/today') }, 'Go to Today'))));
  }

  await loadProfiles(null);
  firstView(false);
}

/* ---------------- shell ---------------- */

export async function render(el, { params } = {}) {
  const targetId = Number(params?.get('target')) || null;
  const defs = [['path', 'Path to person'], ['icp', 'Find matches']];
  const panels = { path: h('div'), icp: h('div', { class: 'hidden' }) };
  const tabsEl = h('div', { class: 'tabs' });
  let icpReady = false;

  const show = (key) => {
    if (key === 'path' && !INTRO_PATHS_ENABLED) key = 'icp';
    for (const [k] of defs) panels[k].classList.toggle('hidden', k !== key);
    [...tabsEl.children].forEach((b, i) => b.classList.toggle('active', defs[i][0] === key));
    if (key === 'icp' && !icpReady) { icpReady = true; icpTab(panels.icp); }
  };
  for (const [k, label] of defs) {
    const off = k === 'path' && !INTRO_PATHS_ENABLED;
    tabsEl.append(h('button', {
      type: 'button',
      class: off ? 'disabled' : '',
      disabled: off ? 'disabled' : null,
      title: off ? INTRO_DISABLED_WHY : null,
      onclick: off ? null : () => show(k),
    }, label, off ? h('span', { class: 'count' }, '· off') : null));
  }

  el.append(
    h('div', { class: 'page-head' }, h('div', null,
      h('h1', null, 'Network'),
      h('div', { class: 'sub' }, INTRO_PATHS_ENABLED
        ? 'Explore introduction paths and contacts that match your criteria.'
        : 'Find contacts that match your criteria.'))),
    tabsEl,
    INTRO_PATHS_ENABLED ? null : h('div', { class: 'section-note', style: 'margin:0 0 4px' },
      `Multi-hop introduction paths are turned off. ${INTRO_DISABLED_WHY}`),
    panels.path, panels.icp);

  pcfg = null; // re-read per visit: the hop limit is editable in #/settings
  await loadPathCfg();
  if (INTRO_PATHS_ENABLED) {
    pathTab(panels.path, targetId);
    show('path');
  } else {
    show('icp');
  }
}
