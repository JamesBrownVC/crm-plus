// #/people — the capture surface (S1) plus a searchable/sortable/filterable table.
import { api, qs } from '../api.js';
import {
  h, icon, escName, relTime, modal, guard, toast, emptyState, navigate, autocomplete,
  warmthCell, errorState, SENIORITY, seniorityLabel, DEPTS, deptLabel,
  scoreChip, skeleton,
} from '../app.js';

const WARM_MIN = 0.35;        // same threshold the engines call "warm"
// The "Going quiet" tab must agree with the Today card, which is driven by
// GET /api/settings/quiet. Hardcoding the two numbers here made this tab show 0
// people while Today showed 6 — two screens contradicting each other in front of
// the partner. These are defaults only; render() replaces them with live config.
const quietCfg = { target_days: 45, min_warmth: 0.15 };
const SECTORS = ['technology', 'healthcare', 'education', 'manufacturing', 'services'];
const FUNDING_STAGES = ['', 'pre-seed', 'seed', 'series-a', 'series-b', 'growth', 'public'];

const COLS = [
  { key: 'name', label: 'Name', get: (p) => escName(p).toLowerCase() },
  { key: 'title', label: 'Title', get: (p) => (p.title || '').toLowerCase() },
  { key: 'company_name', label: 'Company', get: (p) => (p.company_name || '').toLowerCase() },
  { key: 'location', label: 'Location', get: (p) => (p.location || '').toLowerCase(), optional: true },
  { key: 'warmth', label: 'Warmth', get: (p) => p.warmth ?? 0, desc: true },
  { key: 'last_touch', label: 'Last touch', get: (p) => p.last_touch || null, desc: true, nullsLast: true },
  { key: 'created_at', label: 'Added', get: (p) => p.created_at || null, desc: true, nullsLast: true },
];

const olderThan = (ts, days) => {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) && Date.now() - t > days * 86400e3;
};

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'warm', label: 'Warm (≥35%)', test: (p) => (p.warmth ?? 0) >= WARM_MIN },
  {
    key: 'quiet',
    label: 'Going quiet',
    test: (p) => (p.touches ?? 0) >= 1
      && (p.warmth ?? 0) >= quietCfg.min_warmth
      && olderThan(p.last_touch, quietCfg.target_days),
  },
];

const peopleCount = (n) => (n === 1 ? '1 person' : `${n} people`);

export async function render(el, { params } = {}) {
  let people = [];
  // the query the rows on screen came from: "no people yet" over a search that
  // simply missed reads as a wiped database (F10), and the two need different words
  let lastQ = '';
  // Home links straight at a filter ("See all" on the Going quiet card), so the
  // tab is part of the URL. Anything unrecognised falls back to All.
  const wanted = String(params?.get('filter') || '').toLowerCase();
  let filter = FILTERS.some((x) => x.key === wanted) ? wanted : 'all';
  // Going quiet is the "who did I drop" list, so it opens oldest-touch-first. Ranking
  // it by warmth put it in a visibly different order from the Today card that links
  // here — two screens disagreeing in front of the partner (S6). His own click on a
  // column header wins from then on, in every tab.
  const defaultSort = (fk) => (fk === 'quiet' ? { key: 'last_touch', dir: 1 } : { key: 'warmth', dir: -1 });
  let userSorted = false;
  let sort = defaultSort(filter);
  // Roster is the working set you chose; network is the bulk import. They are
  // deliberately separate lists, not one list with a filter, because the daily
  // screens only ever mean the roster.
  const wantedTier = String(params?.get('tier') || '').toLowerCase();
  let tier = ['roster', 'network', 'suggested'].includes(wantedTier) ? wantedTier : 'roster';

  const search = h('input', { type: 'text', placeholder: 'Filter people…', oninput: () => refetch(search.value.trim()) });
  const countEl = h('span', { class: 'sub' });
  const tierRow = h('div', { class: 'tabs', style: 'margin-bottom:12px' });
  const filterRow = h('div', { class: 'tabs', style: 'margin-bottom:14px' });
  const tableWrap = h('div', { class: 'card table-card' });

  el.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'People'),
      countEl,
      h('span', { class: 'spacer' }),
      search,
      h('button', { class: 'primary', onclick: () => addPersonModal(() => refetch(search.value.trim())) }, icon('plus'), 'Add person')),
    tierRow,
    filterRow,
    tableWrap);

  const TIERS = [
    ['roster', 'My roster', 'People you added or confirmed — everything on Today is about these.'],
    ['network', 'My network', 'Bulk-imported contacts. Kept and searchable, but out of the way.'],
    ['suggested', 'Suggested', 'Network contacts ranked by the optional starter profile.'],
  ];

  function drawTiers() {
    tierRow.innerHTML = '';
    for (const [key, label] of TIERS) {
      tierRow.append(h('button', {
        type: 'button', class: key === tier ? 'active' : '',
        onclick: () => {
          if (tier === key) return;
          tier = key;
          filterRow.classList.toggle('hidden', tier === 'suggested');
          drawTiers();
          refetch(search.value.trim());
        },
      }, label));
    }
    filterRow.classList.toggle('hidden', tier === 'suggested');
  }

  function drawFilters() {
    filterRow.innerHTML = '';
    for (const f of FILTERS) {
      filterRow.append(h('button', {
        type: 'button', class: f.key === filter ? 'active' : '',
        onclick: () => { filter = f.key; if (!userSorted) sort = defaultSort(filter); drawFilters(); draw(); },
      }, f.label));
    }
  }

  // keep the "Going quiet" tab on the same two numbers as the Today card; a
  // failure here is not worth an error state, the defaults above still apply
  api.get('/api/settings/quiet').then((cfg) => {
    if (Number(cfg?.target_days) > 0) quietCfg.target_days = Number(cfg.target_days);
    if (Number.isFinite(Number(cfg?.min_warmth))) quietCfg.min_warmth = Number(cfg.min_warmth);
    if (filter === 'quiet') draw();
  }).catch(() => {});

  let timer = null;
  function refetch(q) {
    clearTimeout(timer);
    // the debounce means a rejection here never reaches the router's catch:
    // handle it in place or the page renders a bare header (F10)
    timer = setTimeout(async () => {
      try {
        if (tier === 'suggested') { await drawSuggested(q); return; }
        people = await api.get('/api/people' + qs({ q, tier }));
        lastQ = q || '';
        draw();
      } catch (e) {
        if (e.status === 401) return;      // api.js already routed to login
        countEl.textContent = '';
        tableWrap.innerHTML = '';
        tableWrap.append(errorState(e, () => refetch(q)));
      }
    }, q ? 150 : 0);
  }

  // Optional suggestions use the configured scoring rules across the network.
  let minScore = 0;

  async function drawSuggested(q) {
    countEl.textContent = '';
    tableWrap.innerHTML = '';
    tableWrap.append(skeleton(3));
    let data;
    try {
      data = await api.get('/api/prospects' + qs({ min: minScore, limit: 50 }));
    } catch (e) {
      if (e.status === 401) return;
      tableWrap.innerHTML = '';
      tableWrap.append(errorState(e, () => refetch(q)));
      return;
    }
    const needle = String(q || '').toLowerCase();
    const rows = data.rows.filter((r) => !needle
      || `${r.person.name} ${r.person.title} ${r.person.company_name || ''}`.toLowerCase().includes(needle));

    tableWrap.innerHTML = '';
    countEl.textContent = `· ${data.total} of your network at ${Math.round(minScore * 100)}%+`;

    const threshold = h('select', {
      title: 'Minimum suggestion score',
      onchange: () => { minScore = Number(threshold.value); refetch(search.value.trim()); },
    }, ...[['0', 'All scores'], ['0.25', '25%+'], ['0.5', '50%+'], ['0.75', '75%+']]
      .map(([v, l]) => h('option', { value: v }, l)));
    threshold.value = String(minScore);
    tableWrap.append(h('div', { class: 'row', style: 'padding:12px 14px;gap:14px;flex-wrap:wrap;align-items:center' },
      h('span', { class: 'muted small' }, 'Optional starter profile. Review each contact; the score is a rule match, not a probability.'),
      h('span', { class: 'spacer' }),
      h('label', { class: 'row', style: 'gap:6px;align-items:center' },
        h('span', { class: 'muted small' }, 'Minimum score'), threshold)));

    if (!rows.length) {
      // Three different nothings, and a new user always hits the first one:
      // suggestions are drawn from the imported network, which does not exist yet.
      if (!needle && !data.total && !data.scanned_network) {
        tableWrap.append(emptyState('Import your network first',
          'Suggestions are drawn from your LinkedIn connections. Settings → Import from '
          + 'LinkedIn takes the .zip exactly as LinkedIn emails it.',
          h('button', { class: 'primary', onclick: () => navigate('#/settings') }, 'Go to import')));
      } else {
        tableWrap.append(emptyState(
          needle ? 'Nobody here matches that search' : 'Nothing at this score',
          needle ? 'Try a different name, or clear the filter.'
            : 'Lower the minimum score, or use Network → Find matches to define your own criteria.'));
      }
      return;
    }

    for (const row of rows) tableWrap.append(rowFor(row));
    return;
  }

  /** One triage row: name links out to LinkedIn, score explains itself, two verdicts. */
  function rowFor(r) {
    {
      const p = r.person;
      const chip = scoreChip(`${Math.round(r.score * 100)}% starter match`, () => ({
        title: `Starter rule score ${Math.round(r.score * 100)}%`,
        rows: [
          ...r.breakdown.map((b) => ({ k: b.label, v: `${b.points > 0 ? '+' : ''}${b.points}`, cls: b.points > 0 ? 'pos' : b.points < 0 ? 'neg' : '' })),
          'sep',
          { k: 'Total', v: `${r.points} of ${r.max}`, cls: 'pos' },
        ],
        note: 'Based on recorded title and company name only. This rule score is not a probability or a judgement of the person.',
      }), r.score >= 0.6 ? 'green' : '');

      // You cannot judge ICP from a job title alone — you go and look at the
      // profile. So the name IS the link out to LinkedIn, opening in a new tab
      // so the triage list keeps its place. Scheme-checked because the URL comes
      // from an imported file, not from us.
      const url = /^https?:\/\//i.test(String(p.linkedin_url || '')) ? p.linkedin_url : null;
      const nameEl = url
        ? h('a', {
          href: url, target: '_blank', rel: 'noreferrer noopener',
          style: 'font-weight:600', title: 'Open their LinkedIn profile in a new tab',
        }, p.name, icon('external'))
        : h('a', { href: `#/people/${p.id}`, style: 'font-weight:600' }, p.name);

      const row = h('div', { class: 'ti', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px' },
        h('div', { style: 'flex:1 1 220px;min-width:0' },
          nameEl,
          h('div', { class: 'muted small', style: 'overflow:hidden;text-overflow:ellipsis' },
            [p.title, p.company_name].filter(Boolean).join(' · ') || 'no title recorded')),
        chip,
        h('button', {
          class: 'tiny primary',
          onclick: async () => {
            await guard(async () => {
              await api.patch(`/api/people/${p.id}`, { status: 'roster' });
              await api.post('/api/icp-label', { person_id: p.id, label: 1 });
            }, `${p.name} added to your roster`);
            row.remove();
          },
        }, icon('plus'), 'Add to roster'),
        h('a', { class: 'tiny muted', href: `#/people/${p.id}`, title: 'Their record in CRM+' }, 'Details'),
        // A list you cannot clear shows you the same 169 people for ever. This
        // only hides them from suggestions — it passes no verdict on the person.
        h('button', {
          class: 'tiny icon-btn muted', title: 'Hide from suggestions',
          onclick: async () => {
            await guard(() => api.post('/api/icp-label', { person_id: p.id, label: 0 }), 'Hidden');
            row.remove();
          },
        }, icon('x')));
      return row;
    }
  }

  function compare(a, b) {
    const col = COLS.find((c) => c.key === sort.key) || COLS[0];
    const av = col.get(a), bv = col.get(b);
    if (col.nullsLast) {
      // nulls settle last in BOTH directions, so "quiet first" cannot be
      // hijacked by people who were never touched at all
      const an = av === null || av === undefined || av === '';
      const bn = bv === null || bv === undefined || bv === '';
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
    }
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
  }

  function draw() {
    const f = FILTERS.find((x) => x.key === filter) || FILTERS[0];
    const rows = people.filter(f.test).sort(compare);
    countEl.textContent = !people.length && lastQ
      ? `· no matches for “${lastQ}”`
      : rows.length === people.length
        ? `· ${peopleCount(people.length)}`
        : `· ${rows.length} of ${peopleCount(people.length)}`;
    tableWrap.innerHTML = '';
    if (!people.length) {
      const add = h('button', { class: 'primary', onclick: () => addPersonModal(() => refetch(search.value.trim())) }, icon('plus'), 'Add person');
      // an empty result under a live query is a MISS, not an empty CRM: say which
      // fields the API actually searches — it folds accents and covers company names
      // now — and offer the way back
      tableWrap.append(lastQ
        ? emptyState(`Nobody matches “${lastQ}”`,
          'Names, titles, emails, companies, notes and tags are searched — accents optional.',
          h('button', { onclick: () => { search.value = ''; refetch(''); } }, 'Clear search'), add)
        : emptyState('No people yet', 'Add someone, or import your LinkedIn connections in Settings.', add));
      return;
    }
    if (!rows.length) {
      const showAll = h('button', {
        onclick: () => { filter = 'all'; if (!userSorted) sort = defaultSort(filter); drawFilters(); draw(); },
      }, 'Show everyone');
      // the quiet copy reads off the live config: a hardcoded constant here threw
      // ReferenceError and left the card blank on any CRM with no quiet rows
      tableWrap.append(filter === 'quiet'
        ? emptyState('Nobody has gone quiet',
          `Everyone you've spoken to has been touched inside the last ${quietCfg.target_days} days.`, showAll)
        : emptyState('Nobody is warm yet', 'Log a few touches — warmth builds from recency, frequency and reciprocity.', showAll));
      return;
    }
    // Say what this tab is, rather than quietly ranking it the way Today does: the
    // Today card weighs warmth against how overdue the touch is, this table is a
    // plain sortable list of the same people (non-negotiable 4).
    if (filter === 'quiet') {
      // .table-card is padded 4px 6px, the cells 10px 12px: match the columns
      tableWrap.append(h('div', { class: 'muted small', style: 'padding:8px 12px 4px' },
        `Everyone you've spoken to who's past the ${quietCfg.target_days}-day gap.`
        + ' Today ranks these by warmth × how overdue they are;'
        + ' here you sort whichever column you want.'));
    }
    tableWrap.append(h('table', { class: 'list' },
      h('thead', null, h('tr', null, COLS.map((c) => h('th', {
        class: c.optional ? 'col-optional' : null,
        onclick: () => {
          userSorted = true;      // his ordering survives a tab switch from here on
          sort = sort.key === c.key ? { key: c.key, dir: -sort.dir } : { key: c.key, dir: c.desc ? -1 : 1 };
          draw();
        },
      }, c.label, sort.key === c.key ? h('span', { class: 'arrow' }, sort.dir < 0 ? ' ↓' : ' ↑') : null)))),
      h('tbody', null, rows.map((p) => h('tr', { onclick: () => navigate(`#/people/${p.id}`) },
        h('td', { class: 'cell-primary', 'data-label': 'Name', style: 'font-weight:600' }, escName(p)),
        h('td', { class: 'muted', 'data-label': 'Title' }, p.title || '—'),
        h('td', { 'data-label': 'Company' }, p.company_name || h('span', { class: 'muted' }, '—')),
        h('td', { class: 'muted col-optional', 'data-label': 'Location' }, p.location || '—'),
        h('td', { 'data-label': 'Warmth' },
          warmthCell(p.warmth ?? 0, p.touches, async () => (await api.get(`/api/people/${p.id}`)).warmth, escName(p))),
        h('td', { class: 'muted small', 'data-label': 'Last touch' }, relTime(p.last_touch)),
        h('td', { class: 'muted small', 'data-label': 'Added' }, relTime(p.created_at)),
      )))));
  }

  drawTiers();
  drawFilters();
  refetch('');
}

/* ---------- capture ---------- */

// SENIORITY / DEPTS are [code, label] pairs in app.js; tolerate plain code lists.
function optionPairs(src, labelFn) {
  const list = Array.isArray(src) ? src : (src && typeof src === 'object' ? Object.entries(src) : []);
  return list.map((o) => {
    const value = Array.isArray(o) ? String(o[0] ?? '') : (o && typeof o === 'object' ? String(o.value ?? o.code ?? '') : String(o ?? ''));
    const own = Array.isArray(o) ? o[1] : (o && typeof o === 'object' ? o.label : null);
    return { value, label: String(labelFn?.(value) || own || value || '—') };
  });
}
const optionNodes = (src, labelFn) => optionPairs(src, labelFn).map((o) => h('option', { value: o.value }, o.label));
const splitTags = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const field = (label, input) => h('label', { class: 'field' }, label, input);
const fieldset = (label, ...nodes) => h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, label), nodes);

// A name arrives as one string on a phone; /api/auth/setup already splits on the
// FIRST space, so capture uses the same rule and the halves stay correctable in
// person.js's Edit modal.
const splitName = (full) => {
  const s = String(full || '').trim();
  const i = s.indexOf(' ');
  return { first_name: i === -1 ? s : s.slice(0, i), last_name: i === -1 ? '' : s.slice(i + 1).trim() };
};

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
// midday LOCAL time, same as app.js: a demo day entered the next morning keeps
// the day he picked, and no timezone offset can shift 12:00 across a date line.
const middayIso = (y, m, d) => new Date(y, m, d, 12, 0, 0).toISOString();

/* Single-select pill row in the same style as the quick-log pills. app.js keeps
   its pillGroup private, so capture carries this tiny version: one selection,
   nullable (nothing preselected), and resettable between batch entries. */
function pillRow(pairs, { initial = null, onPick } = {}) {
  const row = h('div', { class: 'toggle-row' });
  const btns = new Map();
  let cur = initial;
  const paint = () => { for (const [k, b] of btns) b.classList.toggle('on', k === cur); };
  for (const [key, label] of pairs) {
    const b = h('button', { type: 'button', class: 'toggle' }, label);
    b.addEventListener('click', () => { cur = key; paint(); onPick?.(key); });
    btns.set(key, b);
    row.append(b);
  }
  paint();
  return { row, get: () => cur, set: (k) => { cur = k; paint(); } };
}

// onDone(created, { keepOpen }) fires after every save so the list behind refreshes.
// opts: { values?: {field: value}, focus?: fieldName } — prefill for callers.
export function addPersonModal(onDone, presetCompany, opts = {}) {
  const dlId = `sector-list-${Math.random().toString(36).slice(2, 8)}`;
  const f = {
    name: h('input', { type: 'text', placeholder: 'Full name' }),
    company_name: h('input', { type: 'text', placeholder: 'Company', value: presetCompany?.name || '' }),
    sector: h('input', { type: 'text', list: dlId, placeholder: 'Sector' }),
    stage: h('select', null, FUNDING_STAGES.map((s) => h('option', { value: s }, s || '—'))),
    geography: h('input', { type: 'text', placeholder: 'City or region' }),
    notes: h('textarea', { rows: '2', placeholder: 'Met at an event — send the requested information next week.' }),
    tags: h('input', { type: 'text', placeholder: 'event, follow-up' }),
    title: h('input', { type: 'text', placeholder: 'Title' }),
    email: h('input', { type: 'text', placeholder: 'Email' }),
    linkedin_url: h('input', { type: 'text', placeholder: 'LinkedIn URL' }),
    location: h('input', { type: 'text', placeholder: 'Location' }),
    dept: h('select', null, optionNodes(DEPTS, deptLabel)),
  };

  // ---- company: pick an existing one, or describe a new one well enough to score
  let companyId = presetCompany?.id || null;
  const coChip = h('span', { class: 'chip', style: 'display:none;margin-top:6px' }, icon('check'), 'Existing company');
  const kind = pillRow([['other', 'Other'], ['corporate', 'Company'], ['startup', 'Startup'], ['fund', 'Fund']]);
  const newCoBlock = h('div', { style: 'display:none;flex-direction:column;gap:10px' },
    h('div', { class: 'muted small' }, 'New to your CRM — these make it matchable to your criteria.'),
    fieldset('Kind', kind.row, h('span', { class: 'muted small' }, 'Only used if this company is new to your CRM.')),
    h('div', { class: 'form-row' }, field('Sector', f.sector), field('Funding stage', f.stage)),
    field('Geography', f.geography),
    h('datalist', { id: dlId }, SECTORS.map((s) => h('option', { value: s }))));
  const freeCompany = () => !companyId && !!f.company_name.value.trim();
  function syncCompany() {
    coChip.style.display = companyId ? 'inline-flex' : 'none';
    newCoBlock.style.display = freeCompany() ? 'flex' : 'none';
  }
  autocomplete(f.company_name, {
    people: false, companies: true,
    onPick: (it) => { companyId = it.id; f.company_name.value = it.label; syncCompany(); },
  });
  f.company_name.addEventListener('input', () => { companyId = null; syncCompany(); });

  // ---- when and how they met: capture must RECORD the meeting, not just the
  // person. With no touch at all the allocator drops a zero-touch person from
  // Going quiet forever, so tonight's contacts would never be nagged about again.
  // A met date can only be in the past. Without the cap a slipped year ("2062")
  // pins the contact at 100% warm forever and he never gets nagged again.
  const metDate = h('input', { type: 'date', max: ymd(new Date()) });
  const metDateWrap = h('div', { class: 'hidden', style: 'margin-top:6px' }, metDate);
  const how = pillRow([['meeting', 'Met in person'], ['call', 'Call'], ['email', 'Email'], ['intro', 'Intro'], ['linkedin', 'LinkedIn']],
    { initial: 'meeting' });
  const howFs = fieldset('How', how.row);
  const met = pillRow([['today', 'Today'], ['yesterday', 'Yesterday'], ['pick', 'Earlier…'], ['never', 'Not yet met']], {
    initial: 'today',
    onPick: (k) => {
      metDateWrap.classList.toggle('hidden', k !== 'pick');
      howFs.classList.toggle('hidden', k === 'never');
      if (k === 'pick') setTimeout(() => metDate.focus(), 10);
    },
  });
  const firstMetTs = () => {
    const k = met.get();
    if (k === 'today') return undefined;               // let the server stamp now
    if (k === 'yesterday') { const d = daysFromNow(-1); return middayIso(d.getFullYear(), d.getMonth(), d.getDate()); }
    const [y, mo, d] = String(metDate.value || '').split('-').map(Number);
    return (y && mo && d) ? middayIso(y, mo - 1, d) : undefined;
  };

  // ---- seniority: nothing preselected, so nobody is silently filed as an IC
  let seniority = null;
  const senSel = h('select', { style: 'display:none;margin-top:6px' }, optionNodes(SENIORITY, seniorityLabel));
  senSel.onchange = () => { seniority = senSel.value || 'OTHER'; };
  const sen = pillRow([['IC', 'Contributor'], ['MGR', 'Manager'], ['other', 'Other…']], {
    onPick: (key) => {
      if (key === 'other') { senSel.style.display = ''; seniority = senSel.value || 'OTHER'; senSel.focus(); return; }
      senSel.style.display = 'none';
      seniority = key;
      // the last field of the fast path: put the next Enter on the save button
      saveAddBtn.focus();
    },
  });

  // ---- the promise he made them, recorded here instead of costing a re-find
  const promiseChk = h('input', { type: 'checkbox' });
  const promiseTitle = h('input', { type: 'text', placeholder: 'What did you promise?' });
  let promiseTitleTouched = false;
  promiseTitle.addEventListener('input', () => { promiseTitleTouched = true; });
  const due = pillRow([['d3', 'In 3 days'], ['week', 'Next week'], ['none', 'No date']], { initial: 'd3' });
  const promiseBlock = h('div', { class: 'sub-block hidden' },
    h('label', { class: 'field' }, 'What you promised', promiseTitle),
    fieldset('Due', due.row));
  const suggestPromise = () => {
    if (promiseTitleTouched) return;
    const nm = f.name.value.trim();
    promiseTitle.value = nm ? `Follow up with ${nm}` : '';
  };
  f.name.addEventListener('input', suggestPromise);
  promiseChk.addEventListener('change', () => {
    promiseBlock.classList.toggle('hidden', !promiseChk.checked);
    if (!promiseChk.checked) return;
    suggestPromise();
    setTimeout(() => promiseTitle.focus(), 10);
  });
  const promiseDue = () => {
    const k = due.get();
    if (k === 'none') return undefined;
    return ymd(daysFromNow(k === 'week' ? 7 : 3));
  };

  // ---- duplicate advisory (S9) — never blocks the save
  const warnStrip = h('div', { class: 'warn-strip', style: 'display:none' });
  function drawDupes(candidates) {
    warnStrip.innerHTML = '';
    if (!candidates.length) { warnStrip.style.display = 'none'; return; }
    warnStrip.style.display = '';
    warnStrip.append(h('div', { class: 'small', style: 'font-weight:600;margin-bottom:6px' }, 'Might already be in here:'));
    for (const c of candidates) {
      warnStrip.append(h('div', { class: 'row small', style: 'flex-wrap:wrap' },
        h('div', { style: 'min-width:0' },
          h('a', { class: 'link', href: `#/people/${c.id}` },
            `${c.name} — ${c.company_name || 'no company'}, last touched ${relTime(c.last_touch)}`),
          // say the cost here, in the strip: a modal prompt over a page he cannot
          // see was how "Open instead" used to dead-end
          h('div', { class: 'muted small' }, '— opens their page, drops what you typed here')),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'tiny', type: 'button',
          onclick: () => { m.close(true); navigate(`#/people/${c.id}`); },
        }, 'Open instead')));
    }
  }
  async function checkDupes() {
    const { first_name: first, last_name: last } = splitName(f.name.value);
    const email = f.email.value.trim(), linkedin_url = f.linkedin_url.value.trim();
    // A first name alone is enough to ask now — the endpoint answers first-name-only
    // queries, and a user may enter a first name with no surname. One
    // character is noise, so it does not count as a name.
    if (first.length < 2 && !email && !linkedin_url) { drawDupes([]); return; }
    try {
      const res = await api.get('/api/people/dupes' + qs({ first_name: first, last_name: last, email, linkedin_url }));
      drawDupes(res?.candidates || []);
    } catch { /* advisory only */ }
  }
  // Enter in the Name field submits without ever blurring it, so blur alone meant
  // the fastest capture path never asked. Typing asks, 400ms behind the keystrokes;
  // it stays advisory and never delays or blocks the save.
  let dupeTimer = null;
  const checkDupesSoon = () => { clearTimeout(dupeTimer); dupeTimer = setTimeout(checkDupes, 400); };
  f.name.addEventListener('input', checkDupesSoon);
  f.name.addEventListener('blur', checkDupes);
  f.email.addEventListener('blur', checkDupes);
  f.linkedin_url.addEventListener('blur', checkDupes);

  // ---- batch strip: the proof-of-work for an 8-person dump
  const batch = [];
  const batchStrip = h('div', { class: 'batch-strip', style: 'display:none' });
  function drawBatch() {
    batchStrip.innerHTML = '';
    if (!batch.length) { batchStrip.style.display = 'none'; return; }
    batchStrip.style.display = '';
    batchStrip.append(h('span', { class: 'small muted' }, `${batch.length} added tonight:`), ' ');
    batch.forEach((p, i) => {
      if (i) batchStrip.append(h('span', { class: 'muted small' }, ' · '));
      batchStrip.append(h('a', { class: 'link small', href: `#/people/${p.id}` }, p.name));
    });
  }

  // Enter must keep the dump going, so "Save & add another" is the submit button.
  const saveAddBtn = h('button', { class: 'primary', type: 'submit' }, 'Save & add another');
  const form = h('form', { onsubmit: (e) => submit(e, true) },
    batchStrip,
    field('Name *', f.name),
    h('label', { class: 'field' }, 'Company', h('span', { class: 'ac-wrap', style: 'display:block' }, f.company_name), coChip),
    field('Why you care', f.notes),
    fieldset('First met', met.row, metDateWrap),
    howFs,
    newCoBlock,
    field('Tags', f.tags),
    h('div', { class: 'form-row' },
      field('Title', f.title),
      h('div', null,
        h('div', { class: 'muted small', style: 'font-weight:500;margin-bottom:5px' }, 'Seniority'),
        sen.row, senSel)),
    h('div', { class: 'muted small' }, 'Feeds warmth, reachability and profile fit.'),
    h('details', null,
      h('summary', { class: 'muted small', style: 'cursor:pointer' }, 'More…'),
      h('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:10px' },
        h('div', { class: 'form-row' }, field('Email', f.email), field('LinkedIn', f.linkedin_url)),
        h('div', { class: 'form-row' }, field('Location', f.location), field('Dept', f.dept)))),
    h('label', { class: 'check-row' }, promiseChk, 'Also promised them something'),
    promiseBlock,
    warnStrip,
    h('div', { class: 'actions', style: 'flex-wrap:wrap' },
      h('span', { class: 'muted small', style: 'flex-basis:100%' },
        `Enter saves and starts the next one · Esc when you're done.`),
      h('button', { type: 'button', onclick: (e) => submit(e, false) }, 'Save & close'),
      saveAddBtn),
  );
  // Ctrl/Cmd+Enter keeps the dump going from anywhere in the form — including the
  // "Why you care" textarea, the last field of the fast path, where plain Enter is a
  // newline so this is the only way out. Wired to Save & CLOSE it ended the batch the
  // modal exists for and cost a reopen per person. submit() marks the form clean on a
  // successful save, so Esc still closes without a discard prompt.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    submit(e, true);
  });
  const m = modal('Add person', form);

  if (opts.values) {
    // callers still speak first/last; capture has one field, so fold them together
    const parts = ['name', 'first_name', 'last_name'].map((k) => opts.values[k]).filter((v) => v != null && String(v).trim());
    if (parts.length) f.name.value = parts.map((v) => String(v).trim()).join(' ');
    for (const [k, v] of Object.entries(opts.values)) {
      if (k === 'name' || k === 'first_name' || k === 'last_name') continue;
      if (f[k] && v != null) f[k].value = String(v);
    }
    suggestPromise();
  }
  const focusName = opts.focus === 'name' || opts.focus === 'first_name' || opts.focus === 'last_name';
  if (focusName) setTimeout(() => f.name.focus(), 40);
  else if (opts.focus && f[opts.focus]) setTimeout(() => f[opts.focus].focus(), 40);
  syncCompany();

  let busy = false;
  async function submit(e, again) {
    e?.preventDefault();
    if (busy) return;
    const { first_name, last_name } = splitName(f.name.value);
    if (!first_name) { toast('A name is the one thing I need', true); f.name.focus(); return; }
    if (met.get() === 'pick' && !metDate.value) { toast('Pick the date you met them, or choose Today', true); metDate.focus(); return; }
    // `max` on the input is advice a typed year walks straight past, and the touch
    // that follows would date from the future. Same rejection the API now sends.
    if (met.get() === 'pick' && metDate.value > ymd(new Date())) {
      toast(`That date hasn't happened yet — pick the day you met them`, true);
      metDate.focus();
      return;
    }
    const typedCompany = freeCompany();
    const body = {
      first_name,
      last_name,
      title: f.title.value.trim(),
      notes: f.notes.value.trim(),
      tags: splitTags(f.tags.value),
      seniority: seniority || 'OTHER',
      dept: f.dept.value,
      location: f.location.value.trim(),
    };
    const email = f.email.value.trim();
    if (email) body.email = email;
    const linkedin = f.linkedin_url.value.trim();
    if (linkedin) body.linkedin_url = linkedin;
    if (companyId) body.company_id = companyId;
    else if (typedCompany) {
      body.company_name = f.company_name.value.trim();
      // The server applies these ONLY when it creates the company from the typed
      // name, so a company he retyped can never be relabelled behind his back —
      // which could otherwise copy the previous company's sector into this one.
      body.company_kind = kind.get() || 'other';
      const sector = f.sector.value.trim(), stage = f.stage.value, geography = f.geography.value.trim();
      if (sector) body.company_sector = sector;
      if (stage) body.company_stage = stage;
      if (geography) body.company_geography = geography;
    }

    busy = true;
    let created;
    try { created = await guard(() => api.post('/api/people', body), 'Person added'); }
    catch { busy = false; m.markDirty(); return; }   // keep the form AND the unsaved guard
    busy = false;
    const savedName = [first_name, last_name].filter(Boolean).join(' ');

    // One meeting today scores 78% warmth and 46% at day 45 — above the quiet
    // gate and one target gap overdue, so the person surfaces on Today by
    // themselves. A failed touch never rolls back the person and never blocks
    // the batch: he is told, and can log it from their page.
    if (met.get() !== 'never' && created?.id) {
      const touch = {
        person_id: created.id, kind: how.get(), direction: 'outbound',
        summary: body.notes.slice(0, 180) || 'First met',
      };
      const ts = firstMetTs();
      if (ts) touch.ts = ts;
      try { await api.post('/api/interactions', touch); }
      catch { toast(`Saved ${savedName} — but the meeting didn't record. Log it from their page.`, true); }
    }
    if (promiseChk.checked && created?.id) {
      const t = { title: promiseTitle.value.trim() || `Follow up with ${savedName}`, person_id: created.id };
      const dueOn = promiseDue();
      if (dueOn) t.due = dueOn;
      try { await api.post('/api/tasks', t); }
      catch { toast(`Saved ${savedName} — the promise didn't. Add it from Today.`, true); }
    }

    if (!again) {
      m.close(true);
      onDone?.(created);
      return;
    }
    batch.push({ id: created.id, name: savedName });
    drawBatch();
    m.markClean();          // everything typed is saved: closing now loses nothing
    // the company now exists — link the rest of the batch by id, never by name again
    if (typedCompany && created?.company_id) { companyId = created.company_id; syncCompany(); }
    // Reset everything except the company identity. An unreset sector/stage wrote
    // the previous company's profile onto the next one, and an unreset pill filed
    // the next contact under the last one's seniority (non-negotiable 4).
    for (const k of ['name', 'title', 'notes', 'tags', 'email', 'linkedin_url', 'sector', 'geography', 'location']) f[k].value = '';
    f.stage.value = '';
    f.dept.value = '';
    kind.set(null);
    sen.set(null); seniority = null; senSel.style.display = 'none';
    met.set('today'); metDate.value = ''; metDateWrap.classList.add('hidden'); howFs.classList.remove('hidden');
    how.set('meeting');
    promiseChk.checked = false; promiseBlock.classList.add('hidden');
    promiseTitleTouched = false; promiseTitle.value = ''; due.set('d3');
    clearTimeout(dupeTimer);      // an in-flight check would repaint the strip we just cleared
    drawDupes([]);
    f.name.focus();
    onDone?.(created, { keepOpen: true });
  }
}
