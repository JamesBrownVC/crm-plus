// #/companies/:id — company detail: deal card, Profile fits, people, notes.
import { api } from '../api.js';
import {
  h, icon, escName, initials, stageChip, stageLabel, stars, warmthCell, scoreChip,
  seniorityLabel, relTime, fmtPct, fmtNum, modal, guard, emptyState, errorState,
  confirmModal, quickTaskModal, navigate, tagList,
} from '../app.js';
import { addPersonModal } from './people.js';

const ALL_STAGES = ['sourced', 'contacted', 'meeting', 'diligence', 'referred', 'won', 'passed'];
// [label, extra class] — Seniority folds away on a phone (mobile contract)
const PEOPLE_COLS = [['Name', 'cell-primary'], ['Title', ''], ['Seniority', 'col-optional'], ['Warmth', ''], ['Last touch', '']];

export async function render(el, { id }) {
  let data;
  try {
    data = await api.get(`/api/companies/${id}`);
  } catch (e) {
    if (e.status === 401) return; // api.js already bounced us to the login view
    el.append(errorState(e, () => reload(el, id)));
    return;
  }
  const { company, people, deal, fits } = data;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const tags = tagList(company.tags);

  el.append(h('div', { class: 'detail-head' },
    h('div', { class: 'avatar-lg' }, initials(company.name)),
    h('div', { class: 'detail-main' },
      h('h1', null, company.name),
      h('div', { class: 'sub' },
        [company.kind, company.sector, company.stage, company.geography].filter(Boolean).join(' · ') || 'No details yet',
        company.domain ? [' · ', h('a', { class: 'link', href: `https://${company.domain}`, target: '_blank', rel: 'noopener' }, company.domain)] : null),
      h('div', { class: 'tags' }, tags.map(t => h('span', { class: 'tag' }, t)))),
    h('div', { class: 'row' },
      h('button', { onclick: () => editModal(company, () => reload(el, id)) }, icon('edit'), 'Edit'),
      h('button', { class: 'danger icon-btn', title: 'Delete company', onclick: () => del(company) }, icon('trash'))),
  ));

  const grid = h('div', { class: 'grid cols-2' });
  el.append(grid);

  // deal card
  const dealCard = h('div', { class: 'card' });
  grid.append(dealCard);
  drawDeal(dealCard, company, deal, () => reload(el, id));

  // Profile fits — `people` decides whether a contact-level criterion can be sent
  // anywhere, so the card gets the roster, not just the scores.
  const fitCard = h('div', { class: 'card' });
  grid.append(fitCard);
  await drawFits(fitCard, company, fits || [], people, () => reload(el, id));

  // promises — a task filed against the company (the weekly plan files them with
  // no person_id) used to appear on no detail page at all. It belongs above the
  // roster: what he owes them outranks who works there.
  const taskCard = h('div', { class: 'card', style: 'margin-top:16px' });
  el.append(taskCard);
  drawTasks(taskCard, company, tasks, () => reload(el, id));

  // people
  const peopleCard = h('div', { class: 'card', style: 'margin-top:16px' });
  el.append(peopleCard);
  const addPerson = () => addPersonModal(() => reload(el, id), { id: company.id, name: company.name });
  peopleCard.append(
    h('h2', null, 'People', h('span', { class: 'count' }, `· ${people.length}`), h('span', { class: 'spacer' }),
      h('button', { class: 'tiny', onclick: addPerson }, icon('plus'), 'Add person')),
    people.length
      ? h('table', { class: 'list' },
        h('thead', null, h('tr', null, PEOPLE_COLS.map(([label, cls]) =>
          h('th', { class: cls === 'col-optional' ? cls : null, style: 'cursor:default' }, label)))),
        h('tbody', null, people.map(p => h('tr', { onclick: () => navigate(`#/people/${p.id}`) },
          h('td', { class: 'cell-primary', dataset: { label: 'Name' }, style: 'font-weight:600' }, escName(p)),
          h('td', { class: 'muted', dataset: { label: 'Title' } }, p.title || '—'),
          h('td', { class: 'muted col-optional', dataset: { label: 'Seniority' } }, seniorityLabel(p.seniority) || '—'),
          h('td', { dataset: { label: 'Warmth' } },
            warmthCell(p.warmth, p.touches, async () => (await api.get(`/api/people/${p.id}`)).warmth, escName(p))),
          h('td', { class: 'muted', dataset: { label: 'Last touch' } }, relTime(p.last_touch)),
        ))))
      : emptyState('Nobody here yet', 'Add contacts — warmth and intro paths flow through people.',
        h('button', { class: 'primary', onclick: addPerson }, icon('plus'), 'Add person')));

  // notes
  const notes = h('textarea', { rows: '3', placeholder: 'Notes…' }, company.notes || '');
  el.append(h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', null, 'Notes', h('span', { class: 'spacer' }),
      h('button', { class: 'tiny', onclick: () => guard(() => api.patch(`/api/companies/${company.id}`, { notes: notes.value }), 'Notes saved').catch(() => {}) }, 'Save')),
    notes));
}

async function reload(el, id) { el.innerHTML = ''; await render(el, { id }); }

function drawDeal(card, company, deal, onChange) {
  card.append(h('h2', null, 'Opportunity'));
  if (!deal) {
    card.append(emptyState('Not in the pipeline', 'Track an opportunity with this company to get plan and priority coverage.',
      h('button', {
        class: 'primary', onclick: async () => {
          try { await guard(() => api.post('/api/deals', { company_id: company.id, stage: 'sourced', priority: 3 }), 'Opportunity created'); }
          catch { return; }
          onChange();
        },
      }, icon('plus'), 'Track opportunity')));
    return;
  }
  // Every write redraws the whole card from the row the server returned, so the
  // chip, the stars and the selects can never disagree with the stored deal.
  // stale: a torn-down card must not still write. busy: the Save button's click
  // lands after the input's blur, which would otherwise PATCH the same edit twice.
  let stale = false, busy = false;
  const redraw = (row) => { stale = true; card.innerHTML = ''; drawDeal(card, company, row || deal, onChange); };
  const patchDeal = async (patch, okMsg) => {
    if (stale || busy) return;
    busy = true;
    let updated;
    try { updated = await guard(() => api.patch(`/api/deals/${deal.id}`, patch), okMsg); }
    catch { busy = false; redraw(deal); return; } // snap the controls back to what is stored
    busy = false;
    redraw(updated);
  };

  const stageSel = h('select', null, ALL_STAGES.map(s => h('option', { value: s, selected: s === deal.stage }, stageLabel(s))));
  const priSel = h('select', null, [1, 2, 3, 4, 5].map(p => h('option', { value: p, selected: p === deal.priority }, `${p} ★`)));
  // flex:1;min-width:0 — .row is not a form-row, so the input keeps its default
  // intrinsic width otherwise: short of the card on a laptop, and unshrinkable
  // next to Save at 390px.
  const nextStep = h('input', { type: 'text', value: deal.next_step || '', placeholder: 'Next step…', style: 'flex:1;min-width:0' });
  stageSel.onchange = () => patchDeal({ stage: stageSel.value }, `Moved to ${stageLabel(stageSel.value)}`);
  priSel.onchange = () => patchDeal({ priority: Number(priSel.value) }, 'Priority saved');
  const saveNext = () => {
    const v = nextStep.value.trim();
    if (v === (deal.next_step || '')) return; // nothing typed: no write, no toast
    patchDeal({ next_step: v }, 'Next step saved');
  };
  nextStep.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveNext(); } };
  nextStep.onblur = saveNext;

  card.append(
    h('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:10px' }, stageChip(deal.stage), stars(deal.priority),
      deal.source ? h('span', { class: 'muted small' }, `Source: ${deal.source}`) : null),
    // styles.css only grids .form-row inside a modal, so this pair needs its own
    // grid — and an inline one outranks the 560px collapse rule. auto-fit does the
    // collapsing itself: two columns wide, one when 2×150px no longer fits.
    h('div', { class: 'form-row', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:10px' },
      h('label', { class: 'field' }, 'Stage', stageSel),
      h('label', { class: 'field' }, 'Priority', priSel)),
    h('label', { class: 'field' }, 'Next step',
      h('div', { class: 'row' }, nextStep,
        h('button', { class: 'tiny', onclick: saveNext }, 'Save'))),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', {
        class: 'tiny', title: 'Note something you promised them',
        onclick: () => quickTaskModal({ companyId: company.id, companyName: company.name, onDone: onChange }),
      }, icon('check'), 'Add promise')),
    h('div', { class: 'muted small', style: 'margin-top:10px' },
      'Higher priority gives an opportunity more weight in the weekly plan.'),
  );
}

// Mirrors engines/fit.js scoreTarget for a company-only target, purely for the
// explanation popover (authoritative score comes from the API `fits`).
// `hasData` is the fallback-only reading of "was anything recorded here" — the
// payload's own verdict wins, see knownFlag().
function companyBreakdown(company, criteria) {
  const lc = (s) => String(s ?? '').toLowerCase();
  const tags = tagList(company.tags);
  return criteria.map(cr => {
    let matched = false, actual = '—', hasData = false, personScope = false;
    if (cr.field?.startsWith('company.')) {
      const key = cr.field.slice(8);
      const val = key === 'tags' ? tags : company[key];
      hasData = key === 'tags' ? tags.length > 0 : !!String(val ?? '').trim();
      actual = key === 'tags' ? (tags.join(', ') || '—') : (val || '—');
      const values = (cr.values || []).map(lc);
      if (cr.op === 'in') matched = values.includes(lc(val));
      else if (cr.op === 'contains') matched = !!val && values.some(v => lc(val).includes(v));
      else if (cr.op === 'overlap') matched = tags.some(t => values.includes(lc(t)));
    } else {
      personScope = true;
      actual = 'person-level criterion';
    }
    return { ...cr, matched, actual, hasData, personScope };
  });
}

const critKey = (b) => String(b.label ?? b.field ?? '');

// coverage = the share of criterion weight that had any data behind it. A
// payload from before the field existed is read as fully covered, which is
// exactly what this page assumed then.
const coverageOf = (f) => (Number.isFinite(Number(f.coverage)) ? Number(f.coverage) : 1);

// Coverage over the criteria THIS page can judge. `coverage` counts person-level
// criteria as unknown, which is true but useless here — no amount of editing the
// company can ever move them, so they must not read as a company blank. An older
// payload without the field falls back to the whole-profile coverage.
const companyCoverageOf = (f) => (Number.isFinite(Number(f.company_coverage))
  ? Number(f.company_coverage)
  : coverageOf(f));

// The criteria that are about a person and can only ever score on a person's page.
const needsPersonOf = (f) => (Array.isArray(f.needs_person)
  ? f.needs_person.map((m) => String(m).trim()).filter(Boolean)
  : []);

// "known" is the API's word, not ours: it lists the criteria it had nothing for
// (`missing`) and flags each row when it ships a breakdown. Reading the fields
// ourselves is the last resort, for a payload with no coverage at all.
function knownFlag(f) {
  const rows = Array.isArray(f.breakdown) ? f.breakdown : null;
  const flags = rows ? new Map(rows.map(r => [critKey(r), !!r.known])) : null;
  const missing = new Set((f.missing || []).map(m => String(m).trim()));
  return (b) => {
    // a person.* criterion has nothing behind it at company scope whatever the
    // payload says about it, so it can never count as scored on this page
    if (b.personScope) return false;
    const k = critKey(b);
    if (flags && flags.has(k)) return flags.get(k);
    if (missing.size) return !missing.has(k);
    return b.hasData;
  };
}

// Every COMPANY criterion the API reported nothing for, deduped in payload order.
// `missing` already excludes person-level criteria; the needs_person filter is
// belt and braces for a payload sent before that split existed.
function blankLabels(fits) {
  const out = [];
  for (const f of fits) {
    if (companyCoverageOf(f) >= 1) continue;
    const person = needsPersonOf(f);
    for (const m of (f.missing || [])) {
      const s = String(m).trim();
      if (s && !person.includes(s) && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

// Every contact-level criterion across the profiles, deduped in payload order.
function personLabels(fits) {
  const out = [];
  for (const f of fits) for (const m of needsPersonOf(f)) if (!out.includes(m)) out.push(m);
  return out;
}

const THESIS_FIELDS = ['sector', 'stage', 'geography'];
const isBlankField = (company, key) => (key === 'tags'
  ? tagList(company.tags).length === 0
  : !String(company[key] ?? '').trim());

// Which fields of the edit form those blank labels actually point at: the saved
// criteria say which company fields a profile reads. With no profiles loaded,
// fall back to the three the profiles always read.
function blankFields(company, fits, byId) {
  const keys = [];
  for (const f of fits) {
    if (companyCoverageOf(f) >= 1) continue;
    for (const cr of (byId.get(f.icp_id)?.criteria || [])) {
      const field = String(cr.field ?? '');
      if (!field.startsWith('company.')) continue;
      const key = field.slice(8);
      if (isBlankField(company, key) && !keys.includes(key)) keys.push(key);
    }
  }
  if (!keys.length) for (const k of THESIS_FIELDS) if (isBlankField(company, k)) keys.push(k);
  return keys;
}

const NO_DATA_NOTE = 'Nothing recorded on any of these, so there is no fit to report. '
  + 'Add the sector, stage and geography and it scores itself.';
const NO_COMPANY_DATA_NOTE = 'Nothing is recorded on the company side either — '
  + 'add the sector, stage and geography and that half scores itself.';

async function drawFits(card, company, fits, people, onEdit) {
  const roster = Array.isArray(people) ? people : [];
  card.append(h('h2', null, 'Profile fit'));
  if (!fits.length) {
    card.append(emptyState('No matching profiles', 'Define a profile in Network → Find matches; fit scores appear here.'));
    return;
  }
  let profiles = [];
  try { profiles = await api.get('/api/icp'); } catch { /* the chip still shows the score; the popover says why it cannot break it down */ }
  const byId = new Map(profiles.map(p => [p.id, p]));
  const wrap = h('div', { class: 'row', style: 'flex-wrap:wrap' });
  for (const f of fits) {
    const needsPerson = needsPersonOf(f);
    const compCov = companyCoverageOf(f);
    const known = knownFlag(f);
    // company coverage 0 = nothing recorded on any criterion this page can judge.
    // A percentage there is an absence of data wearing a number (PERSONA §5.4),
    // so the chip says so and the score never reaches the screen.
    const nothing = compCov === 0;
    /* Untested criteria count as misses, so any profile with a contact-level
       criterion — or a company blank — yields a FLOOR, not a verdict
       (non-negotiable 4). Σw is fixed, so filling a blank can only move it up:
       "≥70%" is exact where a flat "70%" was a quiet lie. Same rule person.js
       applies to the same case. */
    const floor = needsPerson.length > 0 || compCov < 1;
    const label = nothing
      ? `${f.icp_name} — ${needsPerson.length ? 'needs a contact' : 'no data'}`
      : `${f.icp_name} ${floor ? '≥' : ''}${fmtPct(f.score)}`;
    // a floor already past the green threshold is unambiguously a strong match,
    // so that one keeps its colour
    const cls = nothing ? 'dim' : f.score >= 0.6 ? 'green' : floor ? 'dim' : f.score >= 0.3 ? '' : 'dim';
    wrap.append(scoreChip(label, () => {
      const title = nothing ? `${f.icp_name} — can't score this yet`
        : `${f.icp_name} — fit ${floor ? 'at least ' : ''}${fmtPct(f.score)}`;
      const prof = byId.get(f.icp_id);
      if (!prof) return { title, rows: [], note: nothing ? NO_DATA_NOTE : 'criteria unavailable — check the connection' };
      const bd = companyBreakdown(company, prof.criteria || []);
      const rows = bd.map(b => {
        const k = `${b.label || b.field} (w ${b.weight})`;
        // person.* criteria resolve on the person page, not here — that is not a
        // miss either, so it keeps its own words.
        if (b.personScope) return { k, v: 'person-level criterion' };
        // an unrecorded field is not a mismatch: "✗ —" claims we measured it
        if (nothing || !known(b)) return { k, v: 'no data yet' };
        return {
          k,
          v: b.matched ? '✓ match' : `✗ ${String(b.actual).slice(0, 24)}`,
          cls: b.matched ? 'pos' : 'neg',
        };
      });
      // judgeable = the criteria this page can actually decide, so "x of y" is
      // not measured against a denominator that includes the contact's title.
      const judgeable = bd.filter(b => !b.personScope);
      const notes = [];
      if (needsPerson.length) {
        // the demo profiles carry exactly one contact criterion, so the singular is
        // the common case, not the edge case
        notes.push(`${needsPerson.length} of these criteria ${needsPerson.length === 1 ? 'is' : 'are'} about`
          + ' the contact, not the company — they score on a person\'s page, so'
          + ` ${fmtPct(f.score)} is a floor here, not a verdict.`);
      }
      if (nothing) {
        if (judgeable.length) notes.push(needsPerson.length ? NO_COMPANY_DATA_NOTE : NO_DATA_NOTE);
      } else if (compCov < 1) {
        notes.push(`Scored on ${judgeable.filter(known).length} of ${judgeable.length} criteria this page can judge`
          + ' — the rest have nothing recorded yet.');
      } else {
        notes.push(`fit = Σ(w·match) / Σw = ${fmtNum(f.score)}`
          + (needsPerson.length ? '' : ' · every criterion here is about the company, so this is the whole verdict.'));
      }
      return { title, rows, note: notes.join(' ') };
    }, cls));
  }
  card.append(wrap);

  // Naming the gap without offering the form would be a dead end, and this page
  // is exactly where he can close it (PERSONA §5.2). Two different gaps, two
  // different next actions — and the button only appears when the form it opens
  // actually has one of those fields in it.
  const blanks = blankLabels(fits);
  if (blanks.length) {
    const fields = blankFields(company, fits, byId);
    card.append(h('div', { class: 'row small', style: 'flex-wrap:wrap;margin-top:8px' },
      h('span', { class: 'muted' }, `Still blank on ${company.name}: ${blanks.join(', ')}`),
      fields.length
        ? h('button', {
          class: 'tiny', onclick: () => editModal(company, onEdit, { focus: fields }),
        }, icon('edit'), 'Fill these in')
        : null));
  }

  const founderCrit = personLabels(fits);
  if (founderCrit.length) {
    const row = h('div', { class: 'row small', style: 'flex-wrap:wrap;margin-top:8px' },
      h('span', { class: 'muted' }, `About the contact, not the company: ${founderCrit.join(', ')}`));
    // roster arrives warmest first, so the first three are the three worth opening
    if (roster.length) {
      for (const p of roster.slice(0, 3)) {
        row.append(h('button', {
          class: 'tiny', title: `Score this profile on ${escName(p)}`,
          onclick: () => navigate(`#/people/${p.id}`),
        }, `Score on ${escName(p)}`));
      }
    } else {
      row.append(h('button', {
        class: 'tiny', onclick: () => addPersonModal(onEdit, { id: company.id, name: company.name }),
      }, icon('plus'), 'Add contact'));
    }
    card.append(row);
  }

  card.append(h('div', { class: 'muted small', style: 'margin-top:10px' },
    'How well this company matches each saved profile.'));
}

// Open promises filed against the company or anyone at it. The weekly plan's
// "Schedule" and "Add as promise" both POST a company_id with no person_id, so
// this card is the only page those ever land on.
function drawTasks(card, company, tasks, onChange) {
  const addPromise = () => quickTaskModal({ companyId: company.id, companyName: company.name, onDone: onChange });
  card.append(h('h2', null, 'Promises',
    h('span', { class: 'count' }, `· ${tasks.length} open`), h('span', { class: 'spacer' }),
    h('button', {
      class: 'tiny', title: 'Add a promise', 'aria-label': 'Add a promise', onclick: addPromise,
    }, icon('plus'))));

  if (!tasks.length) {
    card.append(emptyState('Nothing promised here',
      'When you owe this company or its contacts something, write it down — it stays on Today until it is done.',
      h('button', { class: 'primary', onclick: addPromise }, icon('plus'), 'Add a promise')));
    return;
  }

  const now = Date.now();
  for (const t of tasks) {
    const dueMs = t.due ? new Date(t.due).getTime() : NaN;
    const hasDue = Number.isFinite(dueMs);
    const overdue = hasDue && dueMs < now;
    const box = h('input', { type: 'checkbox', 'aria-label': `Mark done: ${t.title}` });
    const row = h('div', { class: 'task-item' },
      box,
      h('span', { class: 't' }, t.title),
      t.person_id && t.person_name
        ? h('span', { class: 'small about' }, h('a', { class: 'link', href: `#/people/${t.person_id}` }, t.person_name))
        : h('span', { class: 'small about muted' }, 'about the company'),
      // An undated promise is not dateless news: "I said this 3 months ago" is
      // the whole of S7, so its age is the urgency it has (never red — it is old,
      // not late). Same wording as Today.
      hasDue
        ? h('span', { class: 'due' + (overdue ? ' overdue' : '') }, overdue ? `overdue · ${relTime(t.due)}` : relTime(t.due))
        : h('span', { class: 'due muted' }, t.created_at ? `promised ${relTime(t.created_at)}` : 'no date'));
    box.addEventListener('change', async () => {
      if (!box.checked) return; // reopening lives on the person page
      box.disabled = true;
      // a failed write must leave the promise on screen, unticked: it is still owed
      try { await guard(() => api.patch(`/api/tasks/${t.id}`, { done: 1 }), 'Promise kept'); }
      catch { box.checked = false; box.disabled = false; return; }
      row.classList.add('done');
      setTimeout(onChange, 600); // let the strike-through land before the redraw
    });
    card.append(row);
  }
}

const FIELD_LABEL = {
  name: 'Name', domain: 'Domain', kind: 'Kind', sector: 'Sector',
  stage: 'Funding stage', geography: 'Geography', tags: 'Tags',
};

// opts.focus: company field keys to land on, in order — the profile blanks
// arriving from the fit card, so "Fill these in" opens on the field it named.
function editModal(company, onDone, opts = {}) {
  const f = {
    name: h('input', { type: 'text', value: company.name }),
    domain: h('input', { type: 'text', value: company.domain || '' }),
    kind: h('select', null, ['other', 'corporate', 'startup', 'fund'].map(k => h('option', { value: k, selected: k === company.kind }, k))),
    sector: h('input', { type: 'text', value: company.sector || '' }),
    stage: h('select', null, ['', 'pre-seed', 'seed', 'series-a', 'series-b', 'growth', 'public'].map(s => h('option', { value: s, selected: s === (company.stage || '') }, s || '—'))),
    geography: h('input', { type: 'text', value: company.geography || '' }),
    tags: h('input', { type: 'text', value: tagList(company.tags).join(', ') }),
  };
  const wanted = (opts.focus || []).filter(k => f[k]);
  const m = modal(`Edit ${company.name}`, h('form', { onsubmit: submit },
    wanted.length
      ? h('div', { class: 'muted small', style: 'margin-bottom:10px' },
        `Your profiles read these and they are still empty: ${wanted.map(k => FIELD_LABEL[k] || k).join(', ')}.`)
      : null,
    h('label', { class: 'field' }, 'Name', f.name),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Kind', f.kind), h('label', { class: 'field' }, 'Domain', f.domain)),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Sector', f.sector), h('label', { class: 'field' }, 'Funding stage', f.stage)),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Geography', f.geography), h('label', { class: 'field' }, 'Tags', f.tags)),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save')),
  ), wanted.length ? { focus: f[wanted[0]] } : {});
  async function submit(e) {
    e.preventDefault();
    if (!f.name.value.trim()) { f.name.focus(); return; }
    try {
      await guard(() => api.patch(`/api/companies/${company.id}`, {
        name: f.name.value.trim(), domain: f.domain.value.trim(), kind: f.kind.value,
        sector: f.sector.value.trim(), stage: f.stage.value, geography: f.geography.value.trim(),
        tags: f.tags.value.split(',').map(s => s.trim()).filter(Boolean),
      }), 'Saved');
    } catch { return; } // keep the form open so nothing typed is lost
    m.close();
    onDone();
  }
}

async function del(company) {
  const ok = await confirmModal(`Delete ${company.name}?`,
    'Its deal goes too. People are kept but unlinked from the company.', 'Delete company');
  if (!ok) return;
  try { await guard(() => api.del(`/api/companies/${company.id}`), 'Deleted'); }
  catch { return; }
  navigate('#/companies');
}
