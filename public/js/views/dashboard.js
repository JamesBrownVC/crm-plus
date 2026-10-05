// #/today — the triage screen: promises, priority queue, people going quiet,
// weekly plan. Every row is actionable in place; every write refreshes the whole
// screen so no two panels can disagree.
import { api, qs } from '../api.js';
import {
  h, icon, state, stageChip, stageLabel, scoreChip, fmtPct, fmtNum, relTime,
  humanizeAction, warmthCell, quickLogModal, quickTaskModal, addPersonModal, errorState,
  emptyState, toast, guard, navigate,
} from '../app.js';

// local mirrors of app.js's date helpers (the promise reschedule pills need them,
// and the API takes plain YYYY-MM-DD)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

const STAGE_WEIGHT = { sourced: 0.6, contacted: 0.8, meeting: 1.0, diligence: 1.2, referred: 0.7 };

// A planned action, once done, is a touch of this kind. diligence_memo is desk
// work rather than a touch, so it has no kind and becomes a promise instead.
const KIND_FOR_ACTION = {
  follow_up_message: 'message',
  news_congrats_note: 'message',
  intro_request: 'intro',
  monthly_checkin: 'call',
  coffee_chat: 'meeting',
  deep_dive_call: 'call',
  attend_their_event: 'event',
};

// How many target gaps have passed, in words. One vocabulary for both cards:
// Going quiet passes its `overdue` ratio (the engine only emits rows at >= 1) and
// the priority queue passes its capped staleness, so the two panels can never
// call the same lateness by different names. The ratio stays in the why-popover.
const overdueWords = (o) => {
  const x = Number(o);
  if (!Number.isFinite(x)) return 'due now';
  return x >= 3 ? 'badly overdue' : x >= 2 ? 'well overdue' : x >= 1 ? 'due now' : 'due soon';
};

// The priority chip used to print the engine's raw 0–3.6 product, which has no
// unit and no stated range on a shared screen (PERSONA §4: internal names live in
// the popover). Same words as Going quiet, from the row's own fields.
const priorityWords = (p) => (Number(p.days_since) >= 999 ? 'never touched' : overdueWords(Math.min(Number(p.staleness), 3)));

// "Not this week — Friday" is the decision a 20-minute triage actually produces,
// and it is not the same decision as ticking the promise done.
const PUSH_OPTIONS = [['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7], ['Take the date off', null]];

const QUIET_PAGE = 6;
const QUIET_MAX = 25; // the API's own cap on /api/quiet?limit

export async function render(el) {
  const overview = await api.get('/api/overview');
  const c = overview.counts || {};
  const isEmpty = (c.people ?? 0) <= 1 && (c.companies ?? 0) === 0;

  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = state.me ? state.me.first_name : 'Me';
  el.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h1', null, `${hello}, ${first}`),
      h('div', { class: 'sub' }, new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))),
  ));

  if (isEmpty) {
    el.append(h('div', { class: 'card' }, emptyState(
      'Start your working roster',
      'Add people you work with, or review imported contacts in People → Suggested and add them to your roster.',
      h('button', { class: 'primary', onclick: () => navigate('#/people') }, icon('plus'), 'Open People'),
    )));
    return;
  }

  // Left column first on a phone (the shell collapses .grid.cols-2 to one
  // column), so the phone order is promises → going quiet → priority queue →
  // weekly plan: the two things he OWES people and the people slipping away come
  // first, because only he can pay those debts and both go stale in silence. The
  // queue and the plan are browse surfaces — they are still there after a scroll.
  const statsEl = h('div', { class: 'stats' });
  const promisesCard = h('div', { class: 'card' });
  const priCard = h('div', { class: 'card' });
  const quietCard = h('div', { class: 'card' });
  const planCard = h('div', { class: 'card' });
  const colStyle = 'display:flex;flex-direction:column;gap:16px;min-width:0';
  el.append(statsEl, h('div', { class: 'grid cols-2' },
    h('div', { style: colStyle }, promisesCard, quietCard),
    h('div', { style: colStyle }, priCard, planCard)));

  const cards = [promisesCard, priCard, quietCard, planCard];
  let hours = overview.plan?.budget?.hours_budget ?? 6;
  // The plan footer has to name how many companies the allocator had to choose
  // between (it takes one action per company), and that count lives on
  // /api/overview next to the stat row's — so both read the same payload.
  let activeDeals = Number(c.active_deals) || 0;
  // The "going quiet" tile counts a set /api/quiet owns, which lands after the
  // first paint — so keep the last counts payload to redraw the row against
  // rather than refetching /api/overview for a number it does not carry.
  let lastCounts = c;
  let quietTotal = null;
  let quietLimit = QUIET_PAGE;

  /* ---------- one refresh for the whole screen ---------- */
  // Any write can move any number on this screen (a logged touch changes the
  // priority queue, the quiet list, the plan and the stat row at once), so
  // every write redraws all of it rather than the panel it happened in.
  async function refreshAll() {
    for (const card of cards) card.classList.add('is-loading');
    try {
      const ov = api.get('/api/overview');
      await Promise.all([
        ov.then((o) => {
          drawStats(o.counts || {});
          drawPriorities(o.priorities || [], o.priorities_total);
        }).catch((e) => cardError(priCard, 'Priority queue', e, refreshAll)),
        refreshPromises(),
        refreshQuiet(),
        // same fetch, so the footer's deal count can never disagree with the stat row
        refreshPlan(hours, ov.then(
          (o) => { const v = Number(o?.counts?.active_deals); return Number.isFinite(v) ? v : activeDeals; },
          () => activeDeals)),
      ]);
    } finally {
      for (const card of cards) card.classList.remove('is-loading');
    }
  }

  function cardError(card, title, e, retry) {
    if (e && e.status === 401) return; // api.js already routed to login
    card.innerHTML = '';
    card.append(h('h2', null, title), errorState(e, retry));
  }

  // first paint only: a card that is about to be filled says so rather than
  // sitting there as an empty panel (F10)
  function cardLoading(card, title) {
    card.innerHTML = '';
    card.append(h('h2', null, title), h('div', { class: 'muted small', style: 'padding:6px 0' }, 'Loading…'));
  }

  /* ---------- stat row ---------- */
  function drawStats(counts) {
    lastCounts = counts;
    activeDeals = Number(counts.active_deals) || 0;
    statsEl.innerHTML = '';
    statsEl.append(
      stat(counts.people ?? 0, 'people', () => navigate('#/people')),
      stat(counts.active_deals ?? 0, 'active opportunities', () => navigate('#/companies')),
      stat(counts.open_tasks ?? 0, 'promises open', () => promisesCard.scrollIntoView({ behavior: 'smooth', block: 'start' })),
      // S7 has to be discoverable from the top of the home screen: Pipeline is one
      // nav click away, but "who is slipping away" was a phone-scroll down. Dash
      // until /api/quiet answers — a 0 there would be a lie for a second.
      stat(quietTotal ?? '—', 'going quiet', () => quietCard.scrollIntoView({ behavior: 'smooth', block: 'start' })),
    );
  }

  /* ---------- promises (things I said I would do) ---------- */
  async function refreshPromises() {
    try { drawPromises(await api.get('/api/tasks?open=1')); }
    catch (e) { cardError(promisesCard, 'Promises', e, refreshPromises); }
  }

  function drawPromises(tasks) {
    promisesCard.innerHTML = '';
    let open = tasks.length;
    const countEl = h('span', { class: 'count' }, `· ${open}`);
    promisesCard.append(h('h2', null, 'Promises', countEl, h('span', { class: 'spacer' }),
      h('button', {
        class: 'tiny', title: 'Add a promise', 'aria-label': 'Add a promise',
        onclick: () => quickTaskModal({ onDone: refreshAll }),
      }, icon('plus'))));

    if (!tasks.length) {
      promisesCard.append(emptyState(
        'Nothing outstanding',
        'When you promise someone an intro or a document, write it down here — it stays on this screen until it is done.',
        h('button', { class: 'primary', onclick: () => quickTaskModal({ onDone: refreshAll }) }, icon('plus'), 'Add a promise'),
      ));
      return;
    }

    const now = Date.now();
    promisesCard.append(h('div', { class: 'muted small', style: 'margin:-8px 0 10px' }, 'Overdue and oldest first.'));

    for (const t of sortPromises(tasks, now)) {
      const dueMs = t.due ? new Date(t.due).getTime() : NaN;
      const hasDue = Number.isFinite(dueMs);
      const overdue = hasDue && dueMs < now;
      const about = t.person_id && t.person_name
        ? h('a', { class: 'link', href: `#/people/${t.person_id}` }, t.person_name)
        : (t.company_id && t.company_name
          ? h('a', { class: 'link', href: `#/companies/${t.company_id}` }, t.company_name)
          : null);
      const box = h('input', { type: 'checkbox', 'aria-label': `Mark done: ${t.title}` });
      const titleEl = h('span', {
        class: 't', style: 'cursor:text', title: 'Click to reword this promise', tabindex: '0',
      }, t.title);
      titleEl.addEventListener('click', () => editTitle(t, titleEl));
      titleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); editTitle(t, titleEl); }
      });
      // An undated promise is not dateless news: "I said this 3 months ago"
      // is the whole of S7, so its age is the urgency it has (never red — it
      // is old, not late).
      const dueEl = hasDue
        ? h('span', { class: 'due' + (overdue ? ' overdue' : '') }, overdue ? `overdue · ${relTime(t.due)}` : relTime(t.due))
        : h('span', { class: 'due muted' }, t.created_at ? `promised ${relTime(t.created_at)}` : 'no date');
      // wraps rather than clipping the two new controls at 390px (F8)
      const row = h('div', { class: 'task-item', style: 'flex-wrap:wrap' },
        box,
        titleEl,
        about ? h('span', { class: 'small about' }, about) : null,
        dueEl,
        h('button', {
          class: 'tiny', title: `Move the date on: ${t.title}`,
          onclick: () => reschedule(t, dueEl),
        }, 'Reschedule'),
      );
      box.addEventListener('change', async () => {
        if (!box.checked) return; // reopening lives on the person page
        box.disabled = true;
        try { await guard(() => api.patch(`/api/tasks/${t.id}`, { done: 1 }), 'Promise kept'); }
        catch { box.checked = false; box.disabled = false; return; }
        row.classList.add('done');
        open = Math.max(0, open - 1);
        countEl.textContent = `· ${open}`;
        setTimeout(() => { row.remove(); refreshAll(); }, 600);
      });
      promisesCard.append(row);
    }
  }

  // Pushing a promise out is the other half of triage: without it the one thing
  // Monday produces ("not this week — Friday") cannot be recorded, so an overdue
  // promise he has already decided about stays red on Thursday's shared screen.
  function reschedule(t, dueEl) {
    if (!dueEl.isConnected) return; // already picking
    const pills = h('div', { class: 'toggle-row', style: 'flex:1 1 100%;margin-top:2px' });
    const lock = (on) => { for (const b of pills.querySelectorAll('button')) b.disabled = on; };
    for (const [label, days] of PUSH_OPTIONS) {
      pills.append(h('button', {
        class: 'toggle', type: 'button',
        onclick: async () => {
          lock(true);
          const due = days == null ? null : ymd(daysFromNow(days));
          try {
            await guard(() => api.patch(`/api/tasks/${t.id}`, { due }),
              days == null ? 'Date removed' : `Moved to ${label.toLowerCase()}`);
          } catch { lock(false); return; }
          await refreshAll();
        },
      }, label));
    }
    pills.append(h('button', { class: 'toggle', type: 'button', onclick: () => pills.replaceWith(dueEl) }, 'Cancel'));
    dueEl.replaceWith(pills);
    pills.querySelector('button').focus();
  }

  // Rewording is the same class of decision as rescheduling — "requested introduction"
  // becomes "intro to a colleague" and the promise is still the promise.
  function editTitle(t, titleEl) {
    if (!titleEl.isConnected) return; // already editing
    const input = h('input', { type: 'text', value: t.title || '', 'aria-label': 'Promise', style: 'flex:1;min-width:0' });
    const form = h('form', { style: 'display:flex;align-items:center;gap:6px;flex:1 1 100%', onsubmit: save },
      input,
      h('button', { class: 'tiny primary', type: 'submit' }, 'Save'),
      h('button', { class: 'tiny', type: 'button', onclick: cancel }, 'Cancel'));
    titleEl.replaceWith(form);
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    });
    function cancel() { form.replaceWith(titleEl); }
    async function save(e) {
      e.preventDefault();
      const v = input.value.trim();
      // an emptied promise is a mis-click, not an edit: a titleless row would say
      // nothing on Today. Unchanged text is not a write either.
      if (!v || v === t.title) return cancel();
      try { await guard(() => api.patch(`/api/tasks/${t.id}`, { title: v }), 'Promise updated'); }
      catch { return; }
      await refreshAll();
    }
  }

  /* ---------- priority queue (stale deals) ---------- */
  function drawPriorities(priorities, total) {
    priCard.innerHTML = '';
    // the API caps this list at 10, so the count has to say "of 14" rather than
    // let a truncated page pass for the whole queue
    const n = Number(total);
    const hidden = Number.isFinite(n) && n > priorities.length;
    priCard.append(h('h2', null, 'Priority queue',
      h('span', { class: 'count' }, hidden ? `· ${priorities.length} of ${n}` : `· ${priorities.length}`),
      hidden ? h('span', { class: 'spacer' }) : null,
      hidden ? h('button', { class: 'tiny', onclick: () => navigate('#/companies') }, 'See the pipeline') : null));
    if (!priorities.length) {
      priCard.append(emptyState(
        'Nothing needs a touch',
        'Add opportunities in Pipeline and log interactions — stale ones surface here.',
        h('button', { onclick: () => navigate('#/companies') }, 'Open pipeline'),
      ));
      return;
    }
    // the chip says "#3 of 14", so the popover's rank has to count the whole
    // queue, not the page
    const rankOf = hidden ? n : priorities.length;
    for (const [i, p] of priorities.entries()) {
      // A deal with no recorded contact has nobody to log a touch against, and
      // "Log touch" then opens a modal with an empty Who. Say so on the row.
      const noPeople = Number(p.people_count) === 0;
      const reason = h('div', { class: 'reason' }, p.reason
        + (p.next_step ? ` — next: ${p.next_step}` : '')
        + (noPeople ? ' · nobody recorded here yet' : ''));
      const who = h('div', { class: 'who' },
        h('div', { class: 'row' },
          h('a', { class: 'name', href: `#/companies/${p.company_id}` }, p.company),
          stageChip(p.stage)),
        reason);
      priCard.append(h('div', { class: 'pri-item', style: 'flex-wrap:wrap' },
        who,
        scoreChip(priorityWords(p), () => priorityRows(p, i, rankOf)),
        noPeople
          ? h('button', {
            class: 'tiny',
            onclick: () => addPersonModal(refreshAll, { id: p.company_id, name: p.company }),
          }, 'Add a contact')
          : h('button', {
            class: 'tiny',
            onclick: () => quickLogModal({ companyId: p.company_id, companyName: p.company, onDone: refreshAll }),
          }, 'Log touch'),
        // the next step is a property of the deal, not of a person, so it stays
        // available even with nobody recorded
        h('button', { class: 'tiny', onclick: () => editNextStep(p, reason) }, 'Next step'),
      ));
    }
  }

  // The two decisions a user makes while a call is still warm — what happens
  // next, and logging it — both belong on this row.
  function editNextStep(p, reason) {
    if (!reason.isConnected) return; // already editing
    const input = h('input', {
      type: 'text', value: p.next_step || '', placeholder: 'What happens next?',
      style: 'flex:1;min-width:0',
    });
    const form = h('form', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px', onsubmit: save },
      input,
      h('button', { class: 'tiny primary', type: 'submit' }, 'Save'),
      h('button', { class: 'tiny', type: 'button', onclick: cancel }, 'Cancel'));
    reason.replaceWith(form);
    input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    });
    function cancel() { form.replaceWith(reason); }
    async function save(e) {
      e.preventDefault();
      try { await guard(() => api.patch(`/api/deals/${p.deal_id}`, { next_step: input.value.trim() }), 'Next step saved'); }
      catch { return; }
      await refreshAll();
    }
  }

  /* ---------- going quiet (person-level decay, deal or no deal) ---------- */
  // `limit` is optional so refreshAll() keeps whatever the card is showing. It is
  // also wired as the error-state retry, which calls it with a click event —
  // hence the finite-number guard rather than a default parameter.
  async function refreshQuiet(limit) {
    const want = Math.floor(Number(limit));
    if (Number.isFinite(want) && want > 0) quietLimit = Math.min(want, QUIET_MAX);
    try {
      const r = await api.get('/api/quiet' + qs({ limit: quietLimit }));
      drawQuiet(r.people || [], r.total);
    } catch (e) { cardError(quietCard, 'Going quiet', e, () => refreshQuiet()); }
  }

  function drawQuiet(people, total) {
    quietCard.innerHTML = '';
    // S7 only counts if the app surfaces the whole set unasked: six rows called
    // "6" would hide the other five once-met contacts behind a page size.
    const n = Number(total);
    const hidden = Number.isFinite(n) && n > people.length;
    quietTotal = Number.isFinite(n) ? n : people.length;
    drawStats(lastCounts); // the tile that points here can only fill in from this payload
    // Expand in place rather than sending him to #/people?filter=quiet: that list
    // re-ranks the same people by warmth (this card's #1 landed 4th), drops the
    // overdue column and has no per-row actions — two screens naming a different
    // person as most at risk, and F6 inverted for exactly the people who need it.
    const canExpand = hidden && quietLimit < QUIET_MAX;
    quietCard.append(h('h2', null, 'Going quiet',
      h('span', { class: 'count' }, hidden ? `· ${people.length} of ${n}` : `· ${people.length}`),
      canExpand || quietLimit > QUIET_PAGE ? h('span', { class: 'spacer' }) : null,
      canExpand
        ? h('button', { class: 'tiny', onclick: () => refreshQuiet(QUIET_MAX) }, `Show all ${n}`)
        : (quietLimit > QUIET_PAGE
          ? h('button', { class: 'tiny', onclick: () => refreshQuiet(QUIET_PAGE) }, 'Show fewer')
          : null)));
    if (!people.length) {
      quietCard.append(emptyState(
        'Nobody is going quiet',
        'Everyone warm has been touched inside their target window.',
        h('button', { onclick: () => navigate('#/people') }, 'Browse people'),
      ));
      return;
    }
    // This card selects on "longer than the gap you wanted", not on "still
    // warm" — the rows it picks read 18-20% BECAUSE warmth decays, so the
    // subtitle has to say that or the numbers look like they contradict the
    // heading on a shared screen (S6, non-negotiable 5).
    quietCard.append(h('div', { class: 'muted small', style: 'margin:-8px 0 10px' },
      "You've talked before — and it's been longer than the gap you wanted. Warmth decays, which is why these read low."));
    for (const p of people) {
      const nm = String(p.name || '').trim() || 'Unnamed contact';
      const sub = [p.title, p.company_name].filter(Boolean).join(' · ');
      quietCard.append(h('div', { class: 'pri-item', style: 'flex-wrap:wrap;padding:7px 4px' },
        h('div', { class: 'who' },
          h('a', { class: 'name', href: `#/people/${p.id}` }, nm),
          h('div', { class: 'row', style: 'gap:8px' },
            sub ? h('span', { class: 'reason' }, sub) : null,
            warmthCell(p.warmth, p.touches, async () => (await api.get('/api/people/' + p.id)).warmth, nm))),
        h('span', { class: 'muted small' }, relTime(p.last_touch)),
        // "0.56" next to a name tells him nothing he can act on, and he cannot
        // tell whether it is bad without opening the popover — so the chip says
        // how late this person is, and the engine's number stays inside the why.
        scoreChip(overdueWords(p.overdue), () => ({
          title: 'Going quiet — ' + nm,
          rows: [
            { k: 'Warmth now', v: fmtPct(p.warmth) },
            { k: 'Days since last touch', v: fmtNum(p.days_since, 0) },
            { k: 'Target gap between touches', v: Number.isFinite(Number(p.target_days)) ? `${p.target_days}d` : '—' },
            { k: 'Gaps overdue (capped at 3)', v: fmtNum(Math.min(p.overdue, 3), 2) },
            { k: 'Quiet score (internal)', v: fmtNum(p.quiet_score, 2) },
          ],
          note: 'score = warmth × how many target gaps have passed (capped at 3)',
        })),
        h('button', {
          class: 'tiny',
          onclick: () => quickLogModal({ person: { id: p.id, name: nm }, onDone: refreshAll }),
        }, 'Log touch'),
        h('button', {
          class: 'tiny',
          onclick: () => quickTaskModal({ person: { id: p.id, name: nm }, title: 'Reconnect with ' + nm, onDone: refreshAll }),
        }, 'Promise'),
      ));
    }
  }

  /* ---------- weekly action plan ---------- */
  async function refreshPlan(hrs, deals) {
    try {
      const [plan, n] = await Promise.all([api.get('/api/plan' + qs({ hours: hrs })), deals ?? activeDeals]);
      drawPlan(plan, n);
    } catch (e) { cardError(planCard, 'Weekly action plan', e, () => refreshPlan(hours)); }
  }

  function drawPlan(plan, deals) {
    planCard.innerHTML = '';
    const out = h('output', null, `${hours}h`);
    const slider = h('input', {
      type: 'range', min: '2', max: '12', step: '1', value: String(hours),
      'aria-label': 'Hours available this week',
      oninput: () => { out.textContent = `${slider.value}h`; },
      onchange: () => { hours = Number(slider.value); refreshPlan(hours); },
    });
    const listEl = h('div');
    planCard.append(
      h('h2', null, 'Weekly action plan', h('span', { class: 'spacer' }),
        h('span', { class: 'slider-row' }, 'budget', slider, out)),
      listEl);

    const picks = plan?.plan || [];
    if (!picks.length) {
      listEl.append(emptyState(
        'No plan yet',
        'Track active opportunities in Pipeline — the allocator picks the highest-odds touches you can afford this week.',
        h('button', { onclick: () => navigate('#/companies') }, 'Open pipeline'),
      ));
      return;
    }

    for (const it of picks) {
      const comp = it.components || {};
      const kind = KIND_FOR_ACTION[it.action];
      // The default state of a newly added company: a deal and
      // nobody to act on. "Do it" would open a log with an empty Who, so the top
      // pick's action becomes the thing that has to happen first.
      const noPeople = Number(it.people_count) === 0;
      const primary = noPeople
        ? h('button', {
          class: 'tiny primary',
          onclick: () => addPersonModal(refreshAll, { id: it.company_id, name: it.company }),
        }, 'Add a contact')
        : (kind
          ? h('button', {
            class: 'tiny primary',
            onclick: () => quickLogModal({ companyId: it.company_id, companyName: it.company, kind, onDone: refreshAll }),
          }, 'Do it')
          : h('button', {
            class: 'tiny primary',
            onclick: () => quickTaskModal({
              companyId: it.company_id, companyName: it.company,
              title: 'Prepare summary — ' + it.company, due: 'week', onDone: refreshAll,
            }),
          }, 'Add as promise'));
      listEl.append(h('div', { class: 'plan-item', style: 'flex-wrap:wrap;padding:8px 4px' },
        h('div', { class: 'row', style: 'flex:1 1 190px;min-width:0;gap:8px' },
          h('span', { style: 'font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, humanizeAction(it.action)),
          h('a', { class: 'muted small', href: `#/companies/${it.company_id}`, style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, it.company),
          h('span', { class: 'muted small' }, `${it.hours}h`)),
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-left:auto' },
          scoreChip(`+${Math.round((Number(it.delta_p) || 0) * 100)}% odds`, () => ({
            title: `${humanizeAction(it.action)} — uplift`,
            rows: [
              // warmth 8% on a company nobody has ever touched is the floor of
              // the sigmoid, not a measurement — say so instead (PRD P6).
              comp.warmth_touches === 0
                ? { k: 'Company warmth', v: 'never touched' }
                : { k: 'Company warmth', v: fmtPct(comp.warmth ?? 0) },
              { k: 'Warmth bucket', v: comp.warmth_bucket ?? '—' },
              { k: 'Priority', v: `${comp.conviction ?? it.conviction}/5 stars` },
              { k: 'Δp (lift in odds, from the uplift table)', v: fmtNum(comp.delta_p ?? it.delta_p, 3) },
            ],
            note: 'Looked up by action × warmth × priority. A hand-set prior, '
              + 'not a measured rate — it ranks this week\'s actions against each other.',
          }), 'blue'),
          // Priority, not a euro forecast. The old chip multiplied the uplift by
          // a made-up deal value and printed it in green as if it were money.
          noPeople
            ? scoreChip('nobody to act on', () => ({
              title: 'No contact recorded here',
              rows: [{ k: 'People recorded at this company', v: 'none' }],
              note: 'Add someone at the company and this action becomes actionable.',
            }), 'dim')
            : h('span', { class: 'stars', title: `priority ${it.conviction}/5` },
              ...Array.from({ length: 5 }, (_, i) => h('span', { class: i < it.conviction ? '' : 'off' }, '★'))),
          primary,
          h('button', {
            class: 'tiny',
            onclick: () => quickTaskModal({
              companyId: it.company_id, companyName: it.company,
              title: `${humanizeAction(it.action)} — ${it.company}`, due: '3d', onDone: refreshAll,
            }),
          }, 'Schedule'),
        ),
      ));
    }

    // The allocator takes the single best action per company, so with 8 active
    // deals the cheap follow-ups claim every company long before the budget runs
    // out — from 4h up the plan is identical. "2.5h of 12h allocated" reads as a
    // broken slider; say what the limit actually is and what to do about it.
    const b = plan?.budget;
    if (!b) return;
    const used = Number(b.hours_used) || 0;
    const budget = Number(b.hours_budget) || 0;
    const n = Number(deals);
    const foot = h('div', { class: 'muted small', style: 'padding-top:10px' });
    if (used >= budget - 1e-9) {
      foot.append(`Uses all ${fmtNum(budget, 2)}h — slide up to see what else is worth doing.`);
    } else {
      foot.append(`Fills ${fmtNum(used, 2)}h of the ${fmtNum(budget, 2)}h you have. `
        + 'The plan takes the single best next action for each company'
        + (Number.isFinite(n) && n > 0 ? `, and you have ${n} active opportunity${n === 1 ? '' : 's'}` : '')
        + ' — add opportunities in Pipeline to spend more of the week.',
      h('div', { style: 'margin-top:8px' },
        h('button', { onclick: () => navigate('#/companies') }, 'Open pipeline')));
    }
    listEl.append(foot);
  }

  /* ---------- first paint ---------- */
  drawStats(c);
  drawPriorities(overview.priorities || [], overview.priorities_total);
  cardLoading(promisesCard, 'Promises');
  cardLoading(quietCard, 'Going quiet');
  if (overview.plan?.plan) drawPlan(overview.plan, activeDeals); else cardLoading(planCard, 'Weekly action plan');
  await Promise.all([
    refreshPromises(),
    refreshQuiet(),
    overview.plan?.plan ? Promise.resolve() : refreshPlan(hours),
  ]);
}

function stat(n, label, action) {
  return h('div', {
    class: 'card stat' + (action ? ' hoverable' : ''),
    style: action ? 'cursor:pointer' : '',
    tabindex: action ? '0' : null,
    onclick: action || null,
    onkeydown: action ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } } : null,
  }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, label));
}

// Four buckets a user can say out loud, in this order: (0) late, (1) promised
// so long ago it has been forgotten, (2) still ahead, (3) promised recently.
// An undated promise older than a month is a real debt, so it outranks anything
// not yet due — that is exactly the April intro of S7, which otherwise sinks to
// the bottom of the card forever.
const UNDATED_STALE_DAYS = 30;
function promiseBucket(t, now) {
  const dueMs = t.due ? new Date(t.due).getTime() : NaN;
  if (Number.isFinite(dueMs)) return dueMs < now ? 0 : 2;
  const ageDays = (now - Date.parse(t.created_at ?? '')) / 86400e3;
  return ageDays > UNDATED_STALE_DAYS ? 1 : 3;
}

function sortPromises(tasks, now) {
  // buckets 0/2 order by due date, 1/3 by age — both ascending, so the longest
  // debt and the nearest deadline sit nearest the top. Unknown age sorts last
  // (Infinity − Infinity is NaN, which falls through to the id tie-break).
  const keyed = tasks.map((t) => {
    const b = promiseBucket(t, now);
    const ts = (b === 0 || b === 2) ? new Date(t.due).getTime() : Date.parse(t.created_at ?? '');
    return { t, b, ts: Number.isFinite(ts) ? ts : Infinity };
  });
  keyed.sort((x, y) => x.b - y.b || x.ts - y.ts || (x.t.id ?? 0) - (y.t.id ?? 0));
  return keyed.map((x) => x.t);
}

function priorityRows(p, i, total) {
  const sw = STAGE_WEIGHT[p.stage] ?? 0.6;
  return {
    title: `Priority score ${fmtNum(p.score, 2)}`,
    rows: [
      // the chip now reads "well overdue", which does not say whether anything is
      // worse — the rank is what "why is this one first?" is actually asking
      { k: 'Rank in the queue', v: `#${i + 1} of ${total}` },
      { k: 'Priority (priority/5)', v: `${p.priority}/5 = ${fmtNum(p.priority / 5, 2)}` },
      { k: `Stage weight (${stageLabel(p.stage)})`, v: fmtNum(sw, 2) },
      { k: 'Days since last touch', v: p.days_since >= 999 ? 'never' : fmtNum(p.days_since, 1) },
      { k: 'Staleness (days/target, cap 3)', v: fmtNum(Math.min(p.staleness, 3), 2) },
    ],
    note: 'score = priority × stage weight × min(staleness, 3)',
  };
}
