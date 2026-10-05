// #/people/:id — the Uber brief (S2): where this stands, the context, the promises,
// then the timeline and the graph.
import { api } from '../api.js';
import {
  h, icon, escName, initials, fmtPct, relTime, tagList,
  stageChip, stars, scoreChip, modal, guard, toast, emptyState, navigate, autocomplete,
  warmthCell, quickLogModal, quickTaskModal, confirmModal,
  SENIORITY, seniorityLabel, DEPTS, deptLabel, kindLabel, relLabel, stageLabel,
} from '../app.js';
import { addPersonModal } from './people.js';

// raw enum values stay in the payload; every label on screen comes from app.js
const REL_TYPES = ['family', 'close_friend', 'worked_with', 'advises', 'coinvestor', 'invested_in', 'studied_with', 'introduced', 'colleague', 'knows'];
const KINDS = ['email', 'call', 'meeting', 'message', 'event', 'intro', 'linkedin'];
const STAGES = ['sourced', 'contacted', 'meeting', 'diligence', 'referred', 'won', 'passed'];
const STRENGTHS = ['weak', 'medium', 'strong'];

// SENIORITY / DEPTS are [code, label] pairs in app.js; tolerate plain code lists.
function optionPairs(src, labelFn) {
  const list = Array.isArray(src) ? src : (src && typeof src === 'object' ? Object.entries(src) : []);
  return list.map((o) => {
    const value = Array.isArray(o) ? String(o[0] ?? '') : (o && typeof o === 'object' ? String(o.value ?? o.code ?? '') : String(o ?? ''));
    const own = Array.isArray(o) ? o[1] : (o && typeof o === 'object' ? o.label : null);
    return { value, label: String(labelFn?.(value) || own || value || '—') };
  });
}
const optionNodes = (src, labelFn, current) => optionPairs(src, labelFn)
  .map((o) => h('option', { value: o.value, selected: o.value === String(current ?? '') }, o.label));
const labelOf = (src, code, labelFn) => optionPairs(src, labelFn).find((o) => o.value === String(code ?? ''))?.label ?? String(code ?? '');
const field = (label, input) => h('label', { class: 'field' }, label, input);
const warmthProvider = (personId) => async () => (await api.get(`/api/people/${personId}`)).warmth;

function middayIso(d) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  return x.toISOString();
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function render(el, { id }) {
  const data = await api.get(`/api/people/${id}`);
  const person = data.person;
  const company = data.company || null;
  const warmth = data.warmth || { score: 0, touches: 0, components: null };
  const interactions = data.interactions || [];
  const relationships = data.relationships || [];
  const openTasks = data.open_tasks || [];
  const deal = data.deal || null;
  const fits = data.fits || [];
  const colleagues = data.colleagues || [];
  const name = escName(person);
  const reload = () => reloadView(el, id);

  el.append(h('div', { class: 'detail-head' },
    h('div', { class: 'avatar-lg' }, initials(name)),
    h('div', { class: 'detail-main' },
      h('h1', null, name, person.is_me ? h('span', { class: 'chip', style: 'margin-left:8px' }, 'me') : null),
      h('div', { class: 'sub' },
        [person.title, seniorityLabel(person.seniority)].filter(Boolean).join(' · ') || 'No title yet',
        company ? [' at ', h('a', { class: 'link', href: `#/companies/${company.id}` }, company.name)] : null,
        person.location ? ` · ${person.location}` : ''),
      h('div', { class: 'tags' },
        tagList(person.tags).map((t) => h('span', { class: 'tag' }, t)),
        person.linkedin_url ? h('a', { class: 'chip', href: person.linkedin_url, target: '_blank', rel: 'noopener' }, icon('external'), 'LinkedIn') : null),
      // "Has the fund looked at them" is one of the five things S2 asks for, and
      // Where this stands is no longer the first card, so the state itself rides up
      // here next to warmth — read-only; the controls that change it stay on the card.
      h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' },
        warmthCell(warmth.score, warmth.touches, warmth.components, name),
        deal ? [stageChip(deal.stage), stars(deal.priority)]
          : company ? h('span', { class: 'chip' }, 'Not in the pipeline') : null)),
    // Your own row is reachable from any relationship pointing at you, and two of
    // these buttons must not exist there: the API refuses a touch logged on
    // yourself, and deleting the is_me row takes the pathfinder's source node and
    // the signed-in identity with it, with nothing in the app able to recreate it.
    h('div', { class: 'row', style: 'flex-wrap:wrap' },
      person.is_me ? null : h('button', { class: 'primary', onclick: () => quickLogModal({ person: { id: person.id, name }, onDone: reload }) }, icon('plus'), 'Log touch'),
      h('button', { onclick: () => quickTaskModal({ person: { id: person.id, name }, onDone: reload }) }, icon('check'), 'Promise'),
      // Multi-hop intro paths are off (see INTRO_PATHS_ENABLED in views/network.js):
      // they need person-to-person edges nothing can supply yet.
      person.is_me ? null : h('button', {
        disabled: 'disabled',
        title: 'Introduction paths are off — they need to know how other people are '
          + 'connected to each other, and nothing feeds the app that yet.',
      }, icon('network'), 'Path to them'),
      h('button', { onclick: () => editModal(person, company, reload) }, icon('edit'), 'Edit'),
      person.is_me ? null : h('button', { class: 'danger icon-btn', title: 'Delete person', onclick: () => del(person) }, icon('trash'))),
  ));

  const stack = h('div', { class: 'grid' });     // single column, 16px gaps
  el.append(stack);

  // Every card is attached in reading order BEFORE anything is awaited: the fit
  // chips need /api/icp for their popovers, and awaiting that here used to hold the
  // Context card — F3's "last conversation, zero clicks" — off the page behind it.
  // The reading order is now last conversation → what I owe them → what the fund
  // thinks: Where this stands led with 318px of a 844px phone fold, 119px of it write
  // controls the Uber brief never touches, and it pushed the open promises to y=936.
  const standsCard = h('div', { class: 'card' });
  stack.append(contextCard(person, company, interactions, reload));
  stack.append(promisesCard(person, name, openTasks, reload));
  stack.append(standsCard);

  const grid = h('div', { class: 'grid cols-2' });
  stack.append(grid);

  // left column first, so on a phone the timeline precedes the graph cards
  const tCard = h('div', { class: 'card' });
  grid.append(tCard);
  drawTimeline(tCard, person, interactions, reload);

  const right = h('div', { style: 'display:flex;flex-direction:column;gap:16px;min-width:0' });
  grid.append(right);
  const relCard = h('div', { class: 'card' });
  right.append(relCard);
  drawRelationships(relCard, person, relationships, reload);
  if (company) right.append(colleaguesCard(company, colleagues, data.colleagues_total, reload));

  await drawStands(standsCard, { person, company, deal, fits }, reload);
}

async function reloadView(el, id) { el.innerHTML = ''; await render(el, { id }); }

/* ---------- where this stands: the deal and the profile fit (S8) ---------- */

async function drawStands(card, ctx, reload) {
  const { person, company, deal, fits } = ctx;
  card.innerHTML = '';
  // The state rides ON the card title (the same pattern as the Promises header):
  // as its own row it cost 37px, and every row this card spends is a row the last
  // conversation loses at 390x844.
  const title = h('h2', { style: 'flex-wrap:wrap' }, 'Where this stands');
  card.append(title);
  const redraw = (updated) => drawStands(card, { ...ctx, deal: updated }, reload);

  if (deal) {
    const stageSel = h('select', null, STAGES.map((s) => h('option', { value: s, selected: s === deal.stage }, stageLabel(s))));
    const priSel = h('select', null, [1, 2, 3, 4, 5].map((p) => h('option', { value: p, selected: p === deal.priority }, `${p} ★`)));
    const nextStep = h('input', { type: 'text', value: deal.next_step || '', placeholder: 'What happens next…', style: 'flex:1;min-width:120px' });
    const patch = async (body, msg) => {
      let updated;
      try { updated = await guard(() => api.patch(`/api/deals/${deal.id}`, body), msg); }
      catch { return; }
      // re-render from the response: the chip and the control can never disagree
      await redraw(updated && updated.id ? updated : { ...deal, ...body });
    };
    stageSel.onchange = () => patch({ stage: stageSel.value }, `Stage → ${stageLabel(stageSel.value)}`);
    priSel.onchange = () => patch({ priority: Number(priSel.value) }, 'Priority saved');
    // .filter(Boolean) is load-bearing: Element.append(null) writes the text "null"
    title.append(...[
      stageChip(deal.stage), stars(deal.priority),
      deal.source ? h('span', { class: 'muted small' }, `from ${deal.source}`) : null,
      h('span', { class: 'spacer' }),
      company ? h('a', { class: 'muted small', href: `#/companies/${company.id}` }, company.name) : null,
    ].filter(Boolean));
    card.append(
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px' },
        field('Stage', stageSel), field('Priority', priSel)),
      field('Next step', h('div', { class: 'row' }, nextStep,
        h('button', { class: 'tiny', onclick: () => patch({ next_step: nextStep.value.trim() }, 'Next step saved') }, 'Save'))),
    );
  } else if (company) {
    card.append(h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px' },
      h('span', { class: 'muted' }, 'Not in the pipeline yet'),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'primary',
        onclick: async () => {
          let created;
          try { created = await guard(() => api.post('/api/deals', { company_id: company.id, stage: 'sourced', priority: 3 }), 'Tracking opportunity'); }
          catch (e) { if (e.status === 409) reload(); return; }
          await redraw(created);
        },
      }, icon('plus'), 'Track opportunity')));
  } else {
    card.append(h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px' },
      h('span', { class: 'muted' }, 'Add a company to track an opportunity with this contact.'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => editModal(person, null, reload, { focus: 'company_name' }) }, icon('edit'), 'Edit')));
  }

  await drawFits(card, person, company, fits || [], reload);
}

// Mirrors engines/fit.js for the popover only; the authoritative score is the
// API's person-aware `fits`, so person.* criteria resolve on this page.
function targetBreakdown(person, company, criteria) {
  const lc = (s) => String(s ?? '').toLowerCase();
  return (criteria || []).map((cr) => {
    const [scope, key] = String(cr.field ?? '').split('.');
    const obj = scope === 'person' ? person : scope === 'company' ? company : null;
    const raw = obj && obj[key] != null ? (key === 'tags' ? tagList(obj[key]) : obj[key]) : null;
    const arr = (Array.isArray(raw) ? raw : [raw]).map(lc).filter((a) => a.length > 0);
    const vals = (cr.values || []).map(String).filter((v) => v.length > 0);
    let matched = false;
    if (arr.length && vals.length) {
      if (cr.op === 'in' || cr.op === 'overlap') matched = arr.some((a) => vals.some((v) => lc(v) === a));
      else if (cr.op === 'contains') matched = arr.some((a) => vals.some((v) => a.includes(lc(v))));
    }
    let shown = Array.isArray(raw) ? (raw.join(', ') || '—') : (raw === null || raw === '' ? '—' : String(raw));
    if (cr.field === 'person.seniority' && raw) shown = labelOf(SENIORITY, raw, seniorityLabel);
    // hasData is engines/fit.js's `known`: a field with nothing in it was never
    // tested, so it is not a mismatch (non-negotiable 4).
    return { ...cr, scope, key, matched, actual: shown, hasData: arr.length > 0 };
  });
}

const critKey = (b) => String(b.label ?? b.field ?? '');
// coverage = the share of criterion weight that had any data behind it. A payload
// from before the field existed is read as fully covered, which is what this page
// assumed then.
const coverageOf = (f) => (Number.isFinite(Number(f?.coverage)) ? Number(f.coverage) : 1);
// "known" is the API's word: `missing` names the criteria it had nothing to test.
// Reading the target ourselves is the fallback for a payload without it.
function knownFlag(f) {
  const missing = new Set((f?.missing || []).map((m) => String(m).trim()));
  return (b) => (missing.size ? !missing.has(critKey(b)) : b.hasData);
}
// the person fields the edit modal below can land on
const EDITABLE = new Set(['title', 'seniority', 'dept', 'location', 'tags']);
const NO_DATA_NOTE = 'Nothing recorded on any of these criteria, so there is no fit to report. '
  + 'Fill in what you know and it scores itself.';

async function drawFits(card, person, company, fits, reload) {
  card.append(h('div', { class: 'divider' }));
  if (!fits.length) {
    card.append(h('div', { class: 'muted small' }, 'No profile saved yet — define one in Network → Find matches and their fit shows up here.'));
    return;
  }
  let profiles = [];
  try { profiles = await api.get('/api/icp'); } catch { /* the popover degrades, the score stands */ }
  const byId = new Map(profiles.map((p) => [p.id, p]));
  // the label rides IN the chip row: at 390px every line this card spends pushes the
  // last conversation below the fold, which is the one thing F3 will not allow
  const wrap = h('div', { class: 'row', style: 'flex-wrap:wrap' },
    h('span', { class: 'muted small' }, 'Profile fit'));
  for (const ft of fits) {
    const cov = coverageOf(ft);
    // coverage 0 = nothing recorded on any criterion. A percentage there is an
    // absence of data wearing a number, so the score never reaches the screen.
    const nothing = cov === 0;
    /* Partial coverage is the common case here and it used to print a bare "0%"
       under a contact's name — the untested criteria are counted as misses, so the
       number is a FLOOR, not a verdict (non-negotiable 4). fit = matchedW/totalW
       with totalW fixed, so filling a blank can only move it up: "≥30%" is exact.
       A floor already past the green threshold is unambiguously a strong match, so
       that one keeps its colour. */
    const partial = !nothing && cov < 1;
    const known = knownFlag(ft);
    const label = nothing ? `${ft.icp_name} — no data`
      : `${ft.icp_name} ${partial ? '≥' : ''}${fmtPct(ft.score)}`;
    const cls = nothing ? 'dim' : ft.score >= 0.6 ? 'green' : partial ? 'dim' : ft.score >= 0.3 ? '' : 'dim';
    wrap.append(scoreChip(label, () => {
      const title = nothing ? `${ft.icp_name} — can't score this yet`
        : `${ft.icp_name} — fit ${partial ? 'at least ' : ''}${fmtPct(ft.score)}`;
      const prof = byId.get(ft.icp_id);
      if (!prof) return { title, rows: [], note: nothing ? NO_DATA_NOTE : 'criteria unavailable — check the connection' };
      const bd = targetBreakdown(person, company, prof.criteria || []);
      const rows = bd.map((b) => {
        const k = `${b.label || b.field} (weight ${b.weight})`;
        // an unrecorded field is not a mismatch: "✗ —" claims we measured it
        if (nothing || !known(b)) return { k, v: 'no data yet' };
        return { k, v: b.matched ? '✓ match' : `✗ ${String(b.actual).slice(0, 24)}`, cls: b.matched ? 'pos' : 'neg' };
      });
      let note;
      if (nothing) note = NO_DATA_NOTE;
      else if (partial) {
        note = `Scored on ${bd.filter(known).length} of ${bd.length} criteria — the rest have nothing`
          + ` recorded, so ${fmtPct(ft.score)} is a floor, not a verdict. Filling them in can only raise it.`;
      } else note = 'fit = weighted share of matched criteria · person-level criteria are included on this page';
      return { title, rows, note };
    }, cls));
  }
  card.append(wrap);

  // Naming the gap without offering the form is a dead end (PERSONA §5.2). A
  // person-aware profile reads both halves, so the button goes where the blank
  // actually lives: person fields in the edit modal, company fields on the company.
  const blanks = [];
  for (const ft of fits) {
    if (coverageOf(ft) >= 1) continue;
    const known = knownFlag(ft);
    for (const b of targetBreakdown(person, company, byId.get(ft.icp_id)?.criteria || [])) {
      const lab = b.label || b.field;
      if (known(b) || blanks.some((x) => x.label === lab)) continue;
      blanks.push({ label: lab, scope: b.scope, key: b.key });
    }
  }
  if (!blanks.length) return;
  const mine = blanks.find((b) => b.scope === 'person' && EDITABLE.has(b.key));
  const fill = mine
    ? h('button', { class: 'tiny', onclick: () => editModal(person, company, reload, { focus: mine.key }) }, icon('edit'), 'Fill these in')
    : company
      ? h('button', { class: 'tiny', onclick: () => navigate(`#/companies/${company.id}`) }, icon('right'), `Fill these in on ${company.name}`)
      : h('button', { class: 'tiny', onclick: () => editModal(person, company, reload, { focus: 'company_name' }) }, icon('edit'), 'Add their company');
  // three names and a count, never the whole list: six wrapped onto three lines and
  // cost the fold. The per-profile popover above still enumerates every one of them.
  const named = blanks.slice(0, 3).map((b) => b.label).join(', ');
  const rest = blanks.length - 3;
  card.append(h('div', { class: 'row small', style: 'flex-wrap:wrap;margin-top:8px' },
    h('span', { class: 'muted' }, `Still blank: ${named}${rest > 0 ? ` +${rest} more` : ''}`), fill));
}

/* ---------- context: why you care + the last conversation (F3) ---------- */

function contextCard(person, company, interactions, reload) {
  const card = h('div', { class: 'card' }, h('h2', null, 'Context'));
  const label = (t) => h('div', { class: 'muted small', style: 'font-weight:600;margin-bottom:6px' }, t);
  const last = interactions[0];
  const notes = (person.notes || '').trim();
  const meta = (it) => h('div', { class: 'muted small', style: 'margin-bottom:4px' },
    [kindLabel(it.kind), it.direction === 'inbound' ? 'they reached out' : 'you reached out', relTime(it.ts)].join(' · '));

  /* Capture writes the auto "first met" touch FROM the notes, so for anyone added
     tonight both halves of this card hold the same sentence 40px apart — on the one
     screen S2 and S6 are scored on. Identical text collapses to a single block. */
  if (last && notes && String(last.summary || '').trim() === notes) {
    card.append(label('Why you care · what was said'),
      meta(last),
      h('div', { style: 'white-space:pre-wrap' }, notes));
    return card;
  }

  /* Otherwise last conversation leads. F3 wants the last interaction summary readable
     with zero clicks, and at 390x844 a two-line "why you care" above it was enough to
     push it past the fold — the one measurement S2 is scored on. */
  card.append(label('Last conversation'));
  card.append(last
    ? h('div', null,
      meta(last),
      h('div', null, last.summary || h('span', { class: 'muted' }, 'no summary written')))
    : h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('span', { class: 'muted' }, 'Nothing logged yet'),
      h('button', {
        class: 'tiny',
        onclick: () => quickLogModal({ person: { id: person.id, name: escName(person) }, onDone: reload }),
      }, 'Log the first touch')));

  card.append(h('div', { class: 'divider' }), label('Why you care'));
  card.append(notes
    ? h('div', { style: 'white-space:pre-wrap' }, notes)
    : h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('span', { class: 'muted' }, 'No context yet'),
      h('button', { class: 'tiny', onclick: () => editModal(person, company, reload, { focus: 'notes' }) }, 'Add context')));
  return card;
}

/* ---------- promises ---------- */

function promisesCard(person, name, tasks, reload) {
  const card = h('div', { class: 'card' });
  const addBtn = (cls) => h('button', {
    class: cls, title: 'Add a promise',
    onclick: () => quickTaskModal({ person: { id: person.id, name }, onDone: reload }),
  }, icon('plus'), cls === 'tiny' ? null : 'Add a promise');
  card.append(h('h2', null, 'Promises', h('span', { class: 'count' }, `· ${tasks.length} open`),
    h('span', { class: 'spacer' }), addBtn('tiny')));
  if (!tasks.length) {
    card.append(emptyState('No open promises', 'Note what you owe them — it shows up on Today until it is done.', addBtn('primary')));
    return card;
  }
  const now = Date.now();
  for (const t of tasks) {
    const overdue = t.due && new Date(t.due).getTime() < now;
    const row = h('div', { class: 'task-item' },
      h('input', {
        type: 'checkbox',
        onchange: async (e) => {
          const done = e.target.checked ? 1 : 0;
          try { await guard(() => api.patch(`/api/tasks/${t.id}`, { done }), done ? 'Kept' : 'Reopened'); }
          catch { e.target.checked = !done; return; }
          row.classList.toggle('done', !!done);
        },
      }),
      h('span', { class: 't', style: 'flex:1' }, t.title),
      h('span', { class: 'due muted' + (overdue ? ' overdue' : '') },
        t.due ? (overdue ? `overdue · ${relTime(t.due)}` : relTime(t.due)) : 'no date'));
    card.append(row);
  }
  return card;
}

/* ---------- interactions ---------- */

function drawTimeline(card, person, interactions, onChange) {
  const sumInput = h('input', { type: 'text', placeholder: 'What happened?', style: 'flex:1;min-width:160px' });
  const kindSel = h('select', null, KINDS.map((k) => h('option', { value: k, selected: k === 'call' }, kindLabel(k))));
  const dirSel = h('select', null,
    h('option', { value: 'outbound' }, 'you reached out'),
    h('option', { value: 'inbound' }, 'they reached out'));
  // A conversation cannot be in the future, and a slipped year ("2062") would pin
  // them at 100% warm forever — so they never surface as going quiet again.
  const dateInput = h('input', { type: 'date', max: ymd(new Date()), style: 'display:none' });
  const whenRow = h('span', { class: 'tabs', style: 'margin-bottom:0;flex-wrap:wrap' });
  const WHENS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['pick', 'Pick…']];
  let when = 'today';
  function drawWhen() {
    whenRow.innerHTML = '';
    for (const [key, label] of WHENS) {
      whenRow.append(h('button', {
        type: 'button', class: when === key ? 'active' : '', style: 'padding:6px 10px',
        onclick: () => {
          when = key;
          dateInput.style.display = key === 'pick' ? '' : 'none';
          drawWhen();
          if (key === 'pick') dateInput.focus();
        },
      }, label));
    }
  }
  drawWhen();

  card.append(
    h('h2', null, 'Interactions', h('span', { class: 'count' }, `· ${interactions.length}`)),
    h('form', {
      class: 'row', style: 'margin-bottom:12px;flex-wrap:wrap',
      onsubmit: async (e) => {
        e.preventDefault();
        if (when === 'pick' && !dateInput.value) { toast('Pick a date, or choose Today', true); dateInput.focus(); return; }
        // `max` is advice a typed year walks straight past; the API rejects it too
        if (when === 'pick' && dateInput.value > ymd(new Date())) {
          toast(`That date hasn't happened yet — pick the day you spoke`, true);
          dateInput.focus();
          return;
        }
        const body = { person_id: person.id, kind: kindSel.value, direction: dirSel.value, summary: sumInput.value.trim() };
        if (when === 'yesterday') body.ts = middayIso(new Date(Date.now() - 86400e3));
        else if (when === 'pick') body.ts = middayIso(new Date(`${dateInput.value}T12:00:00`));
        try { await guard(() => api.post('/api/interactions', body), 'Touch logged'); }
        catch { return; }
        onChange();
      },
    }, sumInput, kindSel, dirSel, h('span', { class: 'row' }, whenRow, dateInput),
    h('button', { class: 'primary', type: 'submit' }, icon('plus'), 'Log')),
    interactions.length
      ? h('div', { class: 'timeline' }, interactions.map((it) => {
        const row = h('div', { class: 'ti' },
          h('span', { class: 'kind' }, h('span', { class: 'chip' }, kindLabel(it.kind))),
          h('span', { class: `dir ${it.direction}` }, it.direction === 'inbound' ? '← from them' : '→ to them'),
          h('span', { class: 'sum' }, it.summary || h('span', { class: 'muted' }, '—')),
          h('span', { class: 'when', title: it.ts }, relTime(it.ts)),
          h('button', {
            class: 'ghost icon-btn del', title: 'Delete interaction',
            // warmth, the touch count and the "Last conversation" card all read off
            // this row, so the page is re-read rather than patched in place — and a
            // rejected delete must not leave an unhandled rejection behind
            onclick: async () => {
              try { await guard(() => api.del(`/api/interactions/${it.id}`), 'Touch deleted'); }
              catch { return; }
              onChange();
            },
          }, icon('x')));
        return row;
      }))
      : emptyState('Nothing logged yet', 'Warmth starts at zero until you log a touch — use the line above.'));
}

/* ---------- relationships + who else you know there ---------- */

function drawRelationships(card, person, relationships, onChange) {
  const acInput = h('input', { type: 'text', placeholder: 'Link to person…', style: 'flex:1' });
  const relSel = h('select', null, REL_TYPES.map((r) => h('option', { value: r, selected: r === 'knows' }, relLabel(r))));
  const strSel = h('select', null, STRENGTHS.map((s) => h('option', { value: s, selected: s === 'medium' }, s)));
  let picked = null;
  autocomplete(acInput, { people: true, onPick: (it) => { picked = it; acInput.value = it.label; } });
  card.append(
    h('h2', null, 'Relationships', h('span', { class: 'count' }, `· ${relationships.length}`)),
    h('form', {
      class: 'row', style: 'margin-bottom:10px;flex-wrap:wrap',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!picked) { toast('Pick a person from the list', true); return; }
        if (picked.id === person.id) { toast('Cannot link a person to themselves', true); return; }
        try {
          await guard(() => api.post('/api/relationships', {
            src_person: person.id, dst_person: picked.id, rel_type: relSel.value, strength: strSel.value,
          }), 'Relationship added');
        } catch { return; }
        onChange();
      },
    }, h('span', { class: 'ac-wrap', style: 'flex:1;min-width:150px' }, acInput), relSel, strSel,
    h('button', { class: 'primary', type: 'submit' }, icon('plus'))));
  // Element.append() takes Nodes and strings — a bare ARRAY of rows was stringified
  // to "[object HTMLDivElement]" and every edge on the page vanished behind it. Only
  // h() flattens arrays; anything appended directly is appended one node at a time.
  if (!relationships.length) {
    card.append(emptyState('No relationships', 'Edges power the pathfinder — link people you both know.'));
    return;
  }
  for (const r of relationships) {
    card.append(h('div', { class: 'rel-item' },
      h('div', { class: 'who' },
        h('a', { class: 'link', href: `#/people/${r.other?.id}`, style: 'color:var(--text);font-weight:600' }, r.other?.name || 'unknown'),
        h('div', { class: 'sub' }, [r.other?.title, r.other?.company_name].filter(Boolean).join(' · '))),
      h('span', { class: 'chip' }, relLabel(r.rel_type)),
      h('span', { class: 'tag' }, r.strength),
      h('button', {
        class: 'ghost icon-btn', title: 'Remove relationship',
        onclick: async () => {
          try { await guard(() => api.del(`/api/relationships/${r.id}`), 'Relationship removed'); }
          catch { return; }
          onChange();     // the header count and the pathfinder both move with it
        },
      }, icon('x'))));
  }
}

function colleaguesCard(company, colleagues, total, reload) {
  const shown = colleagues.length;
  // the API pages this at 8 and reports the real size: printing the page size as
  // the count told him two people worked there when fourteen did (S2)
  const count = Number.isFinite(Number(total)) ? Math.max(Number(total), shown) : shown;
  const card = h('div', { class: 'card' },
    h('h2', null, `Also at ${company.name}`, h('span', { class: 'count' }, `· ${count}`)));
  const addBtn = (cls) => h('button', {
    class: cls,
    onclick: () => addPersonModal(reload, { id: company.id, name: company.name }),
  }, icon('plus'), cls === 'tiny' ? null : 'Add person');
  if (!colleagues.length) {
    card.append(emptyState(`Nobody else recorded at ${company.name}`,
      'A second thread into the same company is often the warmer route.', addBtn('primary')));
    return card;
  }
  card.querySelector('h2').append(h('span', { class: 'spacer' }), addBtn('tiny'));
  for (const c of colleagues) {
    card.append(h('div', { class: 'rel-item' },
      h('div', { class: 'who' },
        h('a', { class: 'link', href: `#/people/${c.id}`, style: 'color:var(--text);font-weight:600' }, c.name),
        h('div', { class: 'sub' }, [c.title, seniorityLabel(c.seniority)].filter(Boolean).join(' · '))),
      warmthCell(c.warmth ?? 0, c.touches, warmthProvider(c.id), c.name)));
  }
  if (count > shown) {
    card.append(h('div', { class: 'row small', style: 'margin-top:8px' },
      h('span', { class: 'muted' }, `Showing the ${shown} warmest`),
      h('span', { class: 'spacer' }),
      h('a', { class: 'link', href: `#/companies/${company.id}` }, `See all ${count}`)));
  }
  return card;
}

/* ---------- edit / delete ---------- */

function editModal(person, company, onDone, opts = {}) {
  const f = {
    first_name: h('input', { type: 'text', value: person.first_name }),
    last_name: h('input', { type: 'text', value: person.last_name || '' }),
    title: h('input', { type: 'text', value: person.title || '' }),
    company_name: h('input', { type: 'text', value: company?.name || '', placeholder: 'Company' }),
    email: h('input', { type: 'text', value: person.email || '' }),
    linkedin_url: h('input', { type: 'text', value: person.linkedin_url || '' }),
    location: h('input', { type: 'text', value: person.location || '' }),
    seniority: h('select', null, optionNodes(SENIORITY, seniorityLabel, person.seniority)),
    dept: h('select', null, optionNodes(DEPTS, deptLabel, person.dept || '')),
    tags: h('input', { type: 'text', value: tagList(person.tags).join(', '), placeholder: 'comma, separated' }),
    notes: h('textarea', { rows: '3' }, person.notes || ''),
  };
  let companyId = person.company_id ?? null;
  autocomplete(f.company_name, {
    people: false, companies: true,
    onPick: (it) => { companyId = it.id; f.company_name.value = it.label; },
  });
  f.company_name.addEventListener('input', () => { companyId = null; });

  const m = modal(`Edit ${escName(person)}`, h('form', { onsubmit: submit },
    h('div', { class: 'form-row' }, field('First name', f.first_name), field('Last name', f.last_name)),
    h('div', { class: 'form-row' }, field('Title', f.title), field('Location', f.location)),
    h('label', { class: 'field' }, 'Company', h('span', { class: 'ac-wrap', style: 'display:block' }, f.company_name)),
    h('div', { class: 'form-row' }, field('Seniority', f.seniority), field('Dept', f.dept)),
    h('div', { class: 'form-row' }, field('Email', f.email), field('LinkedIn', f.linkedin_url)),
    field('Tags', f.tags),
    field('Why you care', f.notes),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save')),
  ));
  if (opts.focus && f[opts.focus]) setTimeout(() => f[opts.focus].focus(), 40);

  async function submit(e) {
    e.preventDefault();
    if (!f.first_name.value.trim()) { toast('A first name is the one thing I need', true); f.first_name.focus(); return; }
    const typed = f.company_name.value.trim();
    const body = {
      first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(),
      title: f.title.value.trim(), email: f.email.value.trim(), linkedin_url: f.linkedin_url.value.trim(),
      location: f.location.value.trim(), seniority: f.seniority.value, dept: f.dept.value,
      tags: f.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
      notes: f.notes.value,
    };
    try {
      if (!typed) body.company_id = null;
      else if (companyId) body.company_id = companyId;
      else if (typed.toLowerCase() !== (company?.name || '').toLowerCase()) {
        // typed a name nobody picked: create it rather than dead-ending the edit
        const created = await guard(() => api.post('/api/companies', { name: typed }), `${typed} created`);
        body.company_id = created?.id ?? null;
      }
      await guard(() => api.patch(`/api/people/${person.id}`, body), 'Saved');
    } catch { m.markDirty(); return; }      // keep the edits AND the unsaved guard
    m.close();
    onDone();
  }
}

async function del(person) {
  const ok = await confirmModal(`Delete ${escName(person)}?`,
    'Their interactions and relationships go with them. This cannot be undone.', 'Delete person');
  if (!ok) return;
  try { await guard(() => api.del(`/api/people/${person.id}`), 'Deleted'); }
  catch { return; }
  navigate('#/people');
}
