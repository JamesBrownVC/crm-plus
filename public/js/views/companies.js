// #/companies — pipeline board (deal stages) + flat all-companies table.
import { api, qs } from '../api.js';
import {
  h, icon, stageChip, stageLabel, stars, warmthCell, fmtNum, modal, guard,
  emptyState, errorState, navigate, quickLogModal, toast, addPersonModal,
} from '../app.js';

const ACTIVE_STAGES = ['sourced', 'contacted', 'meeting', 'diligence', 'referred'];
const CLOSED_STAGES = ['won', 'passed'];
const ALL_STAGES = [...ACTIVE_STAGES, ...CLOSED_STAGES];
// same hints the contact form offers, so sector strings stay comparable
const SECTOR_HINTS = ['technology', 'healthcare', 'education', 'manufacturing', 'services'];

export async function render(el) {
  let mode = 'board';
  const body = h('div');
  const boardBtn = h('button', { class: 'active' }, 'Pipeline');
  const tableBtn = h('button', null, 'All companies');
  boardBtn.onclick = () => setMode('board');
  tableBtn.onclick = () => setMode('table');

  el.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'Pipeline'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'tabs', style: 'margin-bottom:0' }, boardBtn, tableBtn),
      h('button', { class: 'primary', onclick: () => addCompanyModal(refresh) }, icon('plus'), 'Add company')),
    body);

  function setMode(m2) {
    mode = m2;
    boardBtn.classList.toggle('active', m2 === 'board');
    tableBtn.classList.toggle('active', m2 === 'table');
    refresh();
  }

  // Each pass draws into its own pane, and clearing `body` detaches the previous
  // one. Toggling Pipeline/All companies twice used to leave both renders on
  // screen (each pass appended after its own await); now a superseded pass writes
  // into a node that is no longer in the document.
  async function refresh() {
    body.innerHTML = '';
    const pane = h('div');
    body.append(pane);
    try {
      if (mode === 'board') await drawBoard(pane, refresh);
      else await drawTable(pane);
    } catch (e) {
      if (e.status === 401) return; // api.js already bounced us to the login view
      pane.innerHTML = '';
      pane.append(h('div', { class: 'card' }, errorState(e, refresh)));
    }
  }
  await refresh();
}

// One warmth cell for a /api/companies row. The popover reads the warmest
// person's own components, so the number and its explanation cannot disagree;
// with zero touches warmthCell says so instead of printing the sigmoid floor.
function companyWarmth(c) {
  if (!c) return h('span', { class: 'muted small' }, '—');
  if (!(c.people_count > 0)) return h('span', { class: 'muted small' }, '— nobody here yet');
  return warmthCell(c.max_warmth, c.touches,
    c.warmest_person ? async () => (await api.get('/api/people/' + c.warmest_person.id)).warmth : null,
    c.warmest_person ? c.warmest_person.name + ' — your warmest thread at ' + c.name : 'Warmest at ' + c.name);
}

async function drawBoard(body, refresh) {
  // All three are full lists, not pages: /api/companies, /api/deals and
  // /api/priorities carry no LIMIT (only /api/overview slices priorities to 10).
  // So the per-column counts below are real totals and every card can show its
  // own days-since — nothing here is a page size printed as a total.
  const [companies, deals, priorities] = await Promise.all([
    api.get('/api/companies'), api.get('/api/deals'), api.get('/api/priorities').catch(() => []),
  ]);
  const compById = new Map(companies.map(c => [c.id, c]));
  const priByDeal = new Map(priorities.map(p => [p.deal_id, p]));

  if (!deals.length) {
    body.append(h('div', { class: 'card' }, emptyState('No opportunities tracked', 'Add a company with an opportunity to start the pipeline.',
      h('button', { class: 'primary', onclick: () => addCompanyModal(refresh) }, icon('plus'), 'Add company'))));
    return;
  }

  const board = h('div', { class: 'board' });
  for (const stage of ACTIVE_STAGES) {
    const col = h('div', { class: 'board-col' });
    const inStage = deals.filter(d => d.stage === stage);
    col.append(h('div', { class: 'col-head' }, stageChip(stage), h('span', { class: 'count' }, String(inStage.length))));
    for (const d of inStage) col.append(dealCard(d, compById.get(d.company_id), priByDeal.get(d.id), refresh));
    if (!inStage.length) col.append(h('div', { class: 'muted small', style: 'padding:6px 4px' }, 'nothing here yet'));
    board.append(col);
  }
  body.append(board);

  // collapsed won/passed
  const closed = deals.filter(d => CLOSED_STAGES.includes(d.stage));
  if (closed.length) {
    const details = h('details', { style: 'margin-top:14px' },
      h('summary', { class: 'muted small', style: 'cursor:pointer;user-select:none' }, `Closed — ${closed.length} (won / passed)`));
    const wrap = h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:stretch;margin-top:10px;gap:10px' });
    for (const d of closed) wrap.append(dealCard(d, compById.get(d.company_id), null, refresh, true));
    details.append(wrap);
    body.append(details);
  }
}

function dealCard(deal, comp, pri, refresh, closed = false) {
  const name = deal.company_name || comp?.name || 'Untitled company';
  const daysSince = pri ? (pri.days_since >= 999 ? 'never touched' : `${fmtNum(pri.days_since, 0)}d since touch`) : null;
  const idx = ALL_STAGES.indexOf(deal.stage);
  const prev = idx > 0 ? ALL_STAGES[idx - 1] : null;
  const next = idx >= 0 && idx < ALL_STAGES.length - 1 ? ALL_STAGES[idx + 1] : null;
  const move = async (to) => {
    if (!to) return;
    try { await guard(() => api.patch(`/api/deals/${deal.id}`, { stage: to }), `Moved to ${stageLabel(to)}`); }
    catch { return; } // guard already surfaced it; leave the board untouched
    refresh();
  };
  return h('div', {
    // closed cards live in a wrapping row, so they flex instead of clipping at 390px
    class: 'card deal-card hoverable', style: closed ? 'min-width:0;flex:1 1 190px' : '',
    onclick: () => navigate(`#/companies/${deal.company_id}`),
  },
  h('div', { class: 'name' }, name),
  h('div', { class: 'meta' },
    stars(deal.priority),
    companyWarmth(comp),
  ),
  h('div', { class: 'meta', style: 'margin-top:4px' },
    closed ? stageChip(deal.stage) : null,
    daysSince ? h('span', null, daysSince) : null,
    deal.next_step ? h('span', { title: deal.next_step }, `next: ${deal.next_step.slice(0, 26)}${deal.next_step.length > 26 ? '…' : ''}`) : null),
  h('div', { class: 'movers', style: 'flex-wrap:wrap', onclick: (e) => e.stopPropagation() },
    prev ? h('button', { class: 'tiny', title: `Move to ${stageLabel(prev)}`, onclick: () => move(prev) }, `← ${stageLabel(prev)}`) : null,
    next ? h('button', { class: 'tiny', title: `Move to ${stageLabel(next)}`, onclick: () => move(next) }, `${stageLabel(next)} →`) : null,
    h('button', {
      class: 'tiny', title: `Log a touch at ${name}`,
      onclick: () => quickLogModal({ companyId: deal.company_id, companyName: name, onDone: refresh }),
    }, 'Log touch')),
  );
}

// [label, extra class] — Sector and Geo fold away on a phone (mobile contract)
const TABLE_COLS = [
  ['Name', 'cell-primary'], ['Kind', ''], ['Sector', 'col-optional'], ['Stage', ''],
  ['Geo', 'col-optional'], ['People', ''], ['Warmth', ''], ['Opportunity', ''],
];

async function drawTable(body) {
  const search = h('input', { type: 'text', placeholder: 'Filter companies…' });
  const kindSel = h('select', null, ['', 'startup', 'fund', 'corporate', 'other'].map(k => h('option', { value: k }, k || 'all kinds')));
  const tableWrap = h('div', { class: 'card table-card', style: 'margin-top:12px' });
  body.append(h('div', { class: 'row' }, search, kindSel), tableWrap);

  const clearFilters = () => { search.value = ''; kindSel.value = ''; return refetch(); };

  // seq: the table is only cleared once a response is in (no flicker while he
  // types), so an earlier query resolving late would otherwise overwrite the
  // newer one and show results that do not match what is in the box.
  let timer = null, seq = 0;
  async function refetch() {
    const my = ++seq;
    let companies;
    try {
      companies = await api.get('/api/companies' + qs({ q: search.value.trim(), kind: kindSel.value }));
    } catch (e) {
      if (e.status === 401 || my !== seq) return;
      tableWrap.innerHTML = '';
      tableWrap.append(errorState(e, refetch));
      return;
    }
    if (my !== seq) return;
    tableWrap.innerHTML = '';
    if (!companies.length) {
      tableWrap.append(emptyState('No companies match', 'Clear the filter, or add the one you just met.',
        h('button', { onclick: clearFilters }, 'Clear filter'),
        h('button', { class: 'primary', onclick: () => addCompanyModal(clearFilters) }, icon('plus'), 'Add company')));
      return;
    }
    tableWrap.append(h('table', { class: 'list' },
      h('thead', null, h('tr', null, TABLE_COLS.map(([label, cls]) =>
        h('th', { class: cls === 'col-optional' ? cls : null, style: 'cursor:default' }, label)))),
      h('tbody', null, companies.map(c => h('tr', { onclick: () => navigate(`#/companies/${c.id}`) },
        h('td', { class: 'cell-primary', dataset: { label: 'Name' }, style: 'font-weight:600' }, c.name),
        h('td', { dataset: { label: 'Kind' } }, h('span', { class: 'tag' }, c.kind)),
        h('td', { class: 'muted col-optional', dataset: { label: 'Sector' } }, c.sector || '—'),
        h('td', { class: 'muted', dataset: { label: 'Stage' } }, c.stage || '—'),
        h('td', { class: 'muted col-optional', dataset: { label: 'Geo' } }, c.geography || '—'),
        h('td', { class: 'muted', dataset: { label: 'People' } }, String(c.people_count ?? 0)),
        h('td', { dataset: { label: 'Warmth' } }, companyWarmth(c)),
        h('td', { dataset: { label: 'Opportunity' } }, c.deal_stage ? stageChip(c.deal_stage) : h('span', { class: 'muted' }, 'not tracked')),
      )))));
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refetch, 150); });
  kindSel.addEventListener('change', refetch);
  await refetch();
}

export function addCompanyModal(onDone) {
  const hints = h('datalist', { id: 'company-sector-hints' }, SECTOR_HINTS.map(s => h('option', { value: s })));
  const f = {
    name: h('input', { type: 'text', placeholder: 'Company name *' }),
    domain: h('input', { type: 'text', placeholder: 'example.com' }),
    kind: h('select', null, ['other', 'corporate', 'startup', 'fund'].map(k => h('option', { value: k }, k))),
    sector: h('input', { type: 'text', placeholder: 'e.g. services', list: 'company-sector-hints' }),
    stage: h('select', null, ['', 'pre-seed', 'seed', 'series-a', 'series-b', 'growth', 'public'].map(s => h('option', { value: s }, s || '—'))),
    geography: h('input', { type: 'text', placeholder: 'City or region' }),
    notes: h('textarea', { rows: '2', placeholder: 'The one line you will want to read in three months' }),
    withDeal: h('input', { type: 'checkbox', checked: true }),
    dealStage: h('select', null, ACTIVE_STAGES.map(s => h('option', { value: s }, stageLabel(s)))),
    priority: h('select', null, [1, 2, 3, 4, 5].map(p => h('option', { value: p, selected: p === 3 }, `${p} — ${'★'.repeat(p)}`))),
  };
  const m = modal('Add company', h('form', { onsubmit: submit },
    hints,
    h('label', { class: 'field' }, 'Name', f.name),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Kind', f.kind), h('label', { class: 'field' }, 'Domain', f.domain)),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Sector', f.sector), h('label', { class: 'field' }, 'Funding stage', f.stage)),
    h('label', { class: 'field' }, 'Geography', f.geography),
    h('label', { class: 'field' }, 'Why you care', f.notes),
    h('div', { class: 'divider' }),
    h('div', { class: 'row' }, f.withDeal, h('span', { class: 'small' }, 'Track opportunity')),
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, 'Opportunity stage', f.dealStage), h('label', { class: 'field' }, 'Priority', f.priority)),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Create')),
  ));
  async function submit(e) {
    e.preventDefault();
    if (!f.name.value.trim()) { f.name.focus(); return; }
    const typedName = f.name.value.trim();
    let company;
    try {
      // no okMsg: whether this was a creation is the response's call, not ours
      company = await guard(() => api.post('/api/companies', {
        name: typedName, domain: f.domain.value.trim() || undefined, kind: f.kind.value,
        sector: f.sector.value.trim(), stage: f.stage.value, geography: f.geography.value.trim(),
        notes: f.notes.value.trim(),
      }));
    } catch { return; } // keep the form open with everything typed still in it
    // POST /api/companies is dedupe-safe: a name that already exists comes back
    // as the stored row with `existing: true` and none of the typed fields
    // applied. Announcing a creation would be a lie, and hanging the deal off a
    // row he has not seen is how the empty-twin company got made (S9) — so open
    // the real one and let him fix it there.
    if (company?.existing) {
      toast(`${company.name || typedName} is already in your CRM — opening it`);
      m.close();
      navigate(`#/companies/${company.id}`);
      return;
    }
    const name = company?.name || typedName;
    // "Track opportunity" ships checked, so the default new company is a deal with
    // nobody recorded at it: it can top the weekly plan with a confident euro
    // figure whose "Do it" button has no one to act on, and company warmth reads
    // "nobody here yet" forever. Creation therefore runs straight into capture
    // rather than ending at a company with no contact.
    const needsFounder = !!company?.id && !(Number(company.people_count) > 0);
    if (!needsFounder) toast(`${name} created`);
    if (f.withDeal.checked && company?.id) {
      try {
        await guard(() => api.post('/api/deals', {
          company_id: company.id, stage: f.dealStage.value, priority: Number(f.priority.value),
        }));
      } catch { /* company landed; the deal can be added from its page */ }
    }
    m.close();
    if (needsFounder) {
      toast(`Added ${name} — who is the contact?`);
      onDone?.(company); // the board behind updates even if he closes capture without saving
      addPersonModal(onDone, { id: company.id, name });
      return;
    }
    onDone?.(company);
  }
}
