// CRM+ shell: hash router, sidebar, global search, shared UI helpers.
import { api, qs } from './api.js';
import { render as renderDashboard } from './views/dashboard.js';
// people.js imports back from app.js: the cycle is safe because every imported
// binding is read at render/click time, never during module evaluation.
import { render as renderPeople, addPersonModal } from './views/people.js';
// Re-exported so home and pipeline can offer "Add a contact" without importing
// across view groups (they import it from ../app.js like every other helper).
export { addPersonModal };
import { render as renderPerson } from './views/person.js';
import { render as renderCompanies } from './views/companies.js';
import { render as renderCompany } from './views/company.js';
import { render as renderNetwork } from './views/network.js';
import { render as renderSettings } from './views/settings.js';
import { render as renderLogin } from './views/login.js';

export const state = { authed: false, setup: false, me: null };

/* ---------- DOM builder ---------- */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'type' && k !== 'value' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* ---------- icons (inline SVG) ---------- */
const ICONS = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.4 3.3-5.5 6.5-5.5s5.8 2.1 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M17.7 14.9c2 .8 3.4 2.5 3.8 5.1"/>',
  pipeline: '<rect x="3" y="4" width="4.6" height="16" rx="1.2"/><rect x="9.7" y="4" width="4.6" height="11" rx="1.2"/><rect x="16.4" y="4" width="4.6" height="7" rx="1.2"/>',
  network: '<circle cx="5" cy="12" r="2.6"/><circle cx="18" cy="5.5" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M7.4 10.8l8.2-4M7.4 13.2l8.2 4"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  spark: '<path d="M12 2l2.2 6.8H21l-5.6 4.1 2.2 6.8L12 15.5l-5.6 4.2 2.2-6.8L3 8.8h6.8z"/>',
  undo: '<path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7"/>',
  // The three quick-capture buttons were three identical plus icons, and the only
  // differentiator (the label) is hidden on a phone — a user at 23:10 taps
  // the wrong one and lands in the wrong form. Each capture gets its own glyph.
  userplus: '<circle cx="10" cy="7.5" r="3.6"/><path d="M3 20c.6-3.5 3.3-5.6 7-5.6 1 0 1.9.15 2.7.44"/><path d="M18 13.5v6M15 16.5h6"/>',
  chat: '<path d="M4 5.5h16v10h-8l-4.5 3.5V15.5H4z"/>',
  flag: '<path d="M5.5 21V3.5"/><path d="M5.5 4.5h12l-2.2 3.9 2.2 3.9h-12z"/>',
};
export function icon(name) {
  const span = h('span', { style: 'display:inline-flex;line-height:0' });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

/* ---------- formatters ---------- */
export const fmtPct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
export const fmtPct1 = (x) => `${((Number(x) || 0) * 100).toFixed(1).replace(/\.0$/, '')}%`;
export const fmtNum = (x, d = 3) => Number.isFinite(Number(x)) ? Number(Number(x).toFixed(d)).toString() : '—';
export const fmtEur = (x) => '€' + Math.round(Number(x) || 0).toLocaleString('en-GB');
export function relTime(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return 'never';
  const d = Math.floor(ms / 86400e3);
  if (d < 0) return `in ${-d}d`;
  if (d === 0) { const hh = Math.floor(ms / 3600e3); return hh <= 0 ? 'just now' : `${hh}h ago`; }
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
export const initials = (name) => (name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
export const humanizeAction = (a) => ({
  diligence_memo: 'Prepare summary', deep_dive_call: 'Detailed discussion',
  coffee_chat: 'Meet in person', attend_their_event: 'Attend event',
  intro_request: 'Request introduction',
}[a] || (a || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
// Person rows come in two shapes: full rows (first_name/last_name) from
// /api/people|/api/companies/:id, and pre-joined `name` from /api/search.
export const escName = (p) => (p ? ([p.first_name, p.last_name].filter(Boolean).join(' ') || String(p.name || '')) : '');
// tags travel as a parsed array on the wire (JSON string only in the DB).
export const tagList = (v) => {
  if (Array.isArray(v)) return v.filter((t) => t !== null && t !== undefined).map(String);
  if (typeof v === 'string' && v.trim()) { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
  return [];
};

/* ---------- label maps: no raw enum codes in the primary UI ----------
   Every view imports these; nobody inlines their own. `SENIORITY` leads with
   "Not sure" -> OTHER so a contact captured in a hurry is never silently
   stored as an individual contributor (which would distort warmth, path
   probability and profile fit). */
export const SENIORITY = [
  ['OTHER', 'Not sure'], ['FOUNDER', 'Founder'], ['C', 'C-level'], ['PARTNER', 'Partner'],
  ['VP', 'VP'], ['DIR', 'Director'], ['MGR', 'Manager'], ['IC', 'Individual contributor'],
  ['ANGEL', 'Angel investor'],
];
const SENIORITY_MAP = Object.fromEntries(SENIORITY);
// unknown or OTHER prints nothing: "· Not sure" next to a name is noise
export const seniorityLabel = (code) => (!code || code === 'OTHER' ? '' : SENIORITY_MAP[code] ?? '');

export const DEPTS = [
  ['', '—'], ['eng', 'Engineering'], ['product', 'Product'], ['gtm', 'Go-to-market'],
  ['invest', 'Investing'], ['ops', 'Operations'], ['research', 'Research'], ['other', 'Other'],
];
const DEPT_MAP = Object.fromEntries(DEPTS);
export const deptLabel = (code) => (code ? DEPT_MAP[code] ?? code : '');

export const KIND_LABEL = { email: 'Email', call: 'Call', meeting: 'Meeting', message: 'Message', event: 'Event', intro: 'Intro', linkedin: 'LinkedIn' };
export const kindLabel = (k) => KIND_LABEL[k] ?? k;

export const REL_LABEL = {
  family: 'Family', close_friend: 'Close friend', worked_with: 'Worked together',
  advises: 'Advises', coinvestor: 'Co-investor', invested_in: 'Invested in',
  studied_with: 'Studied together', introduced: 'Introduced by me',
  colleague: 'Colleague', knows: 'Knows',
};
export const relLabel = (r) => REL_LABEL[r] ?? String(r ?? '').replace(/_/g, ' ');

export const STAGE_LABEL = {
  sourced: 'New', contacted: 'Contacted', meeting: 'Met', diligence: 'Evaluation',
  referred: 'Referred', won: 'Won', passed: 'Closed',
};
export const stageLabel = (s) => STAGE_LABEL[s] ?? s;

/* ---------- popover (the "why" behind every score) ---------- */
const popEl = document.getElementById('popover');
let popAnchor = null, popPinned = false, hideTimer = null;

function positionPop(anchor) {
  const r = anchor.getBoundingClientRect();
  popEl.style.left = '0px'; popEl.style.top = '0px';
  const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
  let x = r.left + window.scrollX;
  let y = r.bottom + window.scrollY + 7;
  if (x + pw > window.scrollX + window.innerWidth - 12) x = window.scrollX + window.innerWidth - pw - 12;
  if (r.bottom + ph + 14 > window.innerHeight && r.top - ph - 7 > 0) y = r.top + window.scrollY - ph - 7;
  popEl.style.left = `${Math.max(8, x)}px`;
  popEl.style.top = `${y}px`;
}
export function showPopover(anchor, content) {
  popEl.innerHTML = '';
  popEl.append(content);
  popEl.classList.remove('hidden');
  popAnchor = anchor;
  positionPop(anchor);
}
export function hidePopover() {
  popEl.classList.add('hidden');
  popAnchor = null; popPinned = false;
}
popEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
popEl.addEventListener('mouseleave', () => { if (!popPinned) hideTimer = setTimeout(hidePopover, 140); });
document.addEventListener('click', (e) => {
  if (!popEl.classList.contains('hidden') && !popEl.contains(e.target) && e.target !== popAnchor && !popAnchor?.contains(e.target)) hidePopover();
});
// One Escape does ONE thing: dismissing a stray why-popover must not also
// destroy the half-typed form behind it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!popEl.classList.contains('hidden')) { hidePopover(); return; }
  closeTopModal();
});

// build(): Node | Promise<Node>. Attaches hover + click-to-pin behavior.
export function attachWhy(el, build) {
  const open = async (pin) => {
    clearTimeout(hideTimer);
    let content;
    try { content = await build(); } catch { content = popContent('Details', [], 'could not load details'); }
    if (!content) return;
    showPopover(el, content);
    if (pin) popPinned = true;
  };
  el.addEventListener('mouseenter', () => open(false));
  el.addEventListener('mouseleave', () => { if (!popPinned) hideTimer = setTimeout(hidePopover, 140); });
  el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); popAnchor === el && popPinned ? hidePopover() : open(true); });
  return el;
}

// rows: [{k, v, cls?}]  -> popover content node
export function popContent(title, rows, note) {
  return h('div', null,
    h('div', { class: 'pop-title' }, title),
    rows.map(r => r === 'sep' ? h('div', { class: 'pop-sep' }) :
      h('div', { class: 'pop-row' }, h('span', { class: 'k' }, r.k), h('span', { class: 'v' + (r.cls ? ' ' + r.cls : '') }, r.v))),
    note ? h('div', { class: 'pop-note' }, note) : null,
  );
}

// A pill score with a mandatory explanation. buildRows: () => {title, rows, note} | Promise
export function scoreChip(text, buildRows, cls = '') {
  const el = h('span', { class: 'score ' + cls, tabindex: '0' }, text);
  attachWhy(el, async () => {
    const d = await buildRows();
    return popContent(d.title, d.rows, d.note);
  });
  return el;
}

export function warmthComponentRows(c) {
  if (!c) return [];
  return [
    { k: 'Recency of the last touch', v: fmtNum(c.recency_decay) },
    { k: 'Interactions, last 90d', v: fmtNum(c.freq_90d, 0) },
    { k: 'Reciprocity (2·min/total)', v: fmtNum(c.reciprocity) },
    { k: 'Seniority touch weight', v: fmtNum(c.seniority_touch) },
    { k: 'Channel diversity', v: fmtNum(c.channel_diversity) },
  ];
}

// Warmth bar + % chip. compProvider: components object OR async () => ({score, components})
export function warmthBar(score, compProvider, label = 'Warmth') {
  const s = Number(score) || 0;
  const el = h('span', { class: 'warmth' + (s < 0.35 ? ' cold' : ''), tabindex: '0' },
    h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${Math.round(s * 100)}%` })),
    h('span', { class: 'pct' }, fmtPct(s)),
  );
  attachWhy(el, async () => {
    let comps = compProvider, sc = s;
    if (typeof compProvider === 'function') {
      const r = await compProvider();
      comps = r.components; sc = r.score ?? s;
    }
    // "no interactions logged yet" is warmthCell's job — a missing components
    // payload only means the caller could not supply the breakdown.
    return popContent(`${label} ${fmtPct(sc)}`, warmthComponentRows(comps),
      comps ? WARMTH_FORMULA : 'components unavailable — open the person to see the breakdown');
  });
  return el;
}
// PERSONA §4: an engine identifier may appear only next to its plain meaning, so
// the decay term is named in words above and spelled out here.
const WARMTH_FORMULA = 'score = σ(a1·recency + a2·ln(1+freq) + a3·recip + a4·seniority + a5·diversity + bias), '
  + 'where recency = 2^(−days since the last touch / half-life)';

// The honest primitive: a person with zero touches has no warmth to report, so
// it says so instead of printing the σ(bias) floor as a confident 8%.
export function warmthCell(score, touches, compProvider, label = 'Warmth') {
  if (Number(touches) === 0) {
    const el = h('span', { class: 'warmth untouched', tabindex: '0' }, h('span', { class: 'never' }, 'Never touched'));
    attachWhy(el, () => popContent(label, [],
      'No interactions logged yet, so there is no warmth to report. Log a touch and the score starts from your first contact.'));
    return el;
  }
  return warmthBar(score, compProvider, label);
}

// raw stage stays in the class name (the colour rules key off it); the text is
// the user's word for the stage.
export function stageChip(stage) { return h('span', { class: `chip stage ${stage}` }, stageLabel(stage)); }
export function stars(n) {
  const el = h('span', { class: 'stars', title: `priority ${n}/5` });
  for (let i = 1; i <= 5; i++) el.append(h('span', { class: i <= n ? '' : 'off' }, '★'));
  return el;
}
export function emptyState(big, hint, ...actions) {
  return h('div', { class: 'empty' }, h('div', { class: 'big' }, big), h('div', { class: 'hint' }, hint),
    actions.length ? h('div', { class: 'row' }, actions) : null);
}

// A failed fetch must never read as data loss: name what happened and offer the
// retry. status 0 comes from api.js when fetch itself rejected.
export function errorState(e, retry) {
  const offline = e && e.status === 0;
  return emptyState(
    offline ? 'No connection to CRM+' : "That didn't load",
    offline ? "The app couldn't reach the server. Nothing you typed was lost — try again." : (e?.message || 'Unexpected error'),
    h('button', { class: 'primary', onclick: retry }, icon('undo'), 'Try again'),
  );
}

export function skeleton(rows = 3) {
  const el = h('div', { class: 'skel-wrap' });
  for (let i = 0; i < rows; i++) el.append(h('div', { class: 'skel' }));
  return el;
}

/* ---------- modal / toast ---------- */
const modalRoot = document.getElementById('modal-root');
const modalStack = [];
export const modalOpen = () => modalStack.length > 0;

/* The dirty guard only intercepted Escape, the backdrop and the X — so Cmd-W (or
   closing the laptop, the single most likely way a 23:28 capture session ends)
   threw away person 8 of 8 in silence. One counter of currently-dirty modals
   arms `beforeunload` while anything is half-typed and disarms it the moment
   nothing is, so a clean app never nags. */
let dirtyModals = 0;
const warnBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
function trackDirty(delta) {
  const was = dirtyModals;
  dirtyModals = Math.max(0, dirtyModals + delta);
  if (was === 0 && dirtyModals > 0) window.addEventListener('beforeunload', warnBeforeUnload);
  else if (was > 0 && dirtyModals === 0) window.removeEventListener('beforeunload', warnBeforeUnload);
}

const FOCUSABLE = 'a[href],button:not(:disabled),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* modal(title, body, opts)
   opts.focus   element to focus on open, or false for none (default: first field)
   opts.onClose called once, whenever the modal actually leaves the DOM
   handle: { close(force), el, markDirty(), markClean() }
   Dirtiness is tracked generically from one `input` listener on the box, so
   Escape or a stray backdrop click can never silently destroy typed work. A
   submit attempt clears the flag, so a view calling `close()` after a successful
   save closes straight away; typing again re-arms the guard. The box is a real
   dialog: Tab cycles inside it and the opener gets focus back on close. */
export function modal(title, body, opts = {}) {
  hidePopover();
  // whatever the user tabbed or clicked from gets the focus back on close
  const opener = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  let dirty = false, strip = null, lastField = null, gone = false;
  // one place owns the flag, so the module-level beforeunload counter can never
  // drift out of step with it
  const setDirty = (v) => { if (v === dirty) return; dirty = v; trackDirty(v ? 1 : -1); };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h3', null, title, h('button', { class: 'ghost icon-btn modal-x', type: 'button', onclick: () => close() }, icon('x'))),
    body);
  backdrop.append(box);
  box.addEventListener('input', () => setDirty(true));
  box.addEventListener('submit', () => setDirty(false), true);
  box.addEventListener('focusin', (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) lastField = e.target; });
  /* The nav links, the search box and the three quick-capture buttons all sit
     outside the modal and UNDER the z-index-200 backdrop, and #modal-root comes
     after #shell in the DOM — so an unbounded Tab walked out of the form into
     invisible controls. Tab cycles inside the box instead. */
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = Array.from(box.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    const cur = document.activeElement;
    const inside = box.contains(cur);
    if (e.shiftKey && (!inside || cur === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || cur === last)) { e.preventDefault(); first.focus(); }
  });
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  modalRoot.append(backdrop);
  const first = opts.focus === false ? null
    : (opts.focus instanceof Element ? opts.focus : box.querySelector('input, select, textarea'));
  if (first) setTimeout(() => first.focus(), 30);

  function destroy() {
    if (gone) return;
    gone = true;
    setDirty(false);
    backdrop.remove();
    const i = modalStack.indexOf(handle);
    if (i >= 0) modalStack.splice(i, 1);
    // a re-render may have replaced the opener; only refocus it if it survived
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
    opts.onClose?.();
  }
  function close(force) {
    if (dirty && !force) {
      if (strip) { destroy(); return; }   // asked once already -> this is the discard
      const s = h('div', { class: 'confirm-strip' },
        h('span', null, 'Discard what you typed?'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', onclick: () => { s.remove(); strip = null; (lastField || box.querySelector('input, select, textarea'))?.focus(); } }, 'Keep editing'),
        h('button', { class: 'danger', type: 'button', onclick: () => destroy() }, 'Discard'));
      strip = s;
      box.append(s);
      // the submit row is sticky, so the strip lands below it — a discard prompt
      // the user cannot see is the same as no prompt
      s.scrollIntoView({ block: 'nearest' });
      return;
    }
    destroy();
  }
  const handle = {
    close, el: box,
    markDirty: () => setDirty(true),
    markClean: () => setDirty(false),
  };
  modalStack.push(handle);
  return handle;
}
function closeTopModal() { modalStack[modalStack.length - 1]?.close(); }

// A yes/no prompt rendered in our own chrome. window.confirm on a shared screen
// (S6) is a defect, so nothing in the app may use it.
export async function confirmModal(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; m.close(true); resolve(v); };
    const okBtn = h('button', { class: 'primary', type: 'button', onclick: () => finish(true) }, confirmLabel);
    const body = h('div', null,
      h('div', { class: 'small muted', style: 'margin-bottom:4px' }, message),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => finish(false) }, 'Cancel'),
        okBtn));
    const m = modal(title, body, {
      focus: okBtn,
      onClose: () => { if (!settled) { settled = true; resolve(false); } },
    });
  });
}

export function toast(msg, isErr = false) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, h('span', null, msg));
  let timer = null;
  const kill = () => {
    clearTimeout(timer);
    t.style.opacity = '0'; t.style.transition = 'opacity 300ms';
    setTimeout(() => t.remove(), 320);
  };
  // errors need long enough to read and act on, plus a way out
  if (isErr) t.append(h('button', { class: 'ghost icon-btn toast-x', type: 'button', title: 'Dismiss', onclick: kill }, icon('x')));
  document.getElementById('toast-root').append(t);
  timer = setTimeout(kill, isErr ? 8000 : 2600);
  return t;
}
export async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) {
    if (e.status === 0) toast('Not saved — no connection. Nothing you typed was lost.', true);
    else if (e.status !== 401) toast(e.message || 'Something went wrong', true);
    throw e;
  }
}

/* ---------- person/company autocomplete over /api/search ----------
   opts.onCreate(typedText) — offered when the lookup finds nothing, so "log a
   touch for someone not in the CRM yet" stops being a dead end.
   opts.resolved()         — "the text in this field already stands for a chosen
   row", so refocusing a resolved field does not reopen the list.
   Returns a handle: { pick(i), highlighted(), hasList(), pending(), forceNow(),
   close(), setPicked(label) }. Additive — existing callers ignore it. */
export function autocomplete(input, { people = true, companies = false, onPick, onCreate, resolved } = {}) {
  // resolved per keystroke, not up front: callers wire this up while the input
  // is still detached, so an eager lookup would capture null
  const wrapOf = () => input.closest('.ac-wrap') || input.parentElement || input;
  let list = null, items = [], rows = [], sel = -1, timer = null, errNode = null;
  let inflight = 0, seqNo = 0, pickedLabel = null;

  const closeList = () => {
    list?.remove(); list = null; items = []; rows = []; sel = -1;
    errNode?.remove(); errNode = null;
  };
  const paint = () => rows.forEach((n, i) => n.classList.toggle('sel', i === sel));
  const mount = (node) => { const w = wrapOf(); w.style.position = 'relative'; w.append(node); };
  const isResolved = () => (typeof resolved === 'function'
    ? !!resolved()
    : pickedLabel !== null && pickedLabel === input.value.trim());

  const pick = (i) => {
    const it = items[i];
    closeList();
    if (!it) return;
    if (it.create) { onCreate?.(it.q); return; }
    pickedLabel = it.label;
    onPick?.(it);
  };

  /* Every rendered list pre-highlights row 0, because the row Enter will take has
     to be VISIBLE: an invisible default is how typing "so" + Enter filed a call
     on Claire Besson, and a mis-remembered conversation is undiscoverable months
     later. A list that has nothing to pick keeps sel = -1 and Enter does nothing. */
  function renderList(res, q) {
    closeList();
    items = [];
    if (people) for (const p of res.people || []) {
      items.push({
        type: 'person', id: p.id, label: escName(p), raw: p,
        sub: [p.title, p.company_name || p.company].filter(Boolean).join(' · '),
      });
    }
    if (companies) for (const c of res.companies || []) items.push({ type: 'company', id: c.id, label: c.name, sub: c.kind, raw: c });

    list = h('div', { class: 'ac-list' });
    rows = [];
    const addRow = (title, sub, i) => {
      const node = h('div', { class: 'ac-item', onmousedown: (e) => { e.preventDefault(); pick(i); } },
        h('div', null, title), h('div', { class: 'sub' }, sub));
      rows.push(node); list.append(node);
    };
    if (items.length) items.forEach((it, i) => addRow(it.label, it.sub || it.type, i));
    else if (onCreate) {
      // the inbound cold call is the most valuable capture there is, and it was
      // the one he could not make (non-negotiable 2)
      items.push({ create: true, q, label: q });
      addRow(`Nothing matches “${q}” — add them`, 'new person', 0);
    } else {
      // never render nothing: silence reads as "the app is broken"
      const noun = people ? (companies ? 'Nothing' : 'No one') : 'No company';
      list.append(h('div', { class: 'ac-item note-quiet' }, h('div', null, `${noun} matches “${q}”.`)));
    }
    sel = rows.length ? 0 : -1;
    paint();
    mount(list);
  }

  async function lookup(q) {
    clearTimeout(timer); timer = null;
    const seq = ++seqNo;                 // a stale response must never repaint
    if (!q) { closeList(); return; }
    inflight++;
    try {
      const res = await api.get('/api/search' + qs({ q }));
      if (seq === seqNo) renderList(res, q);
    } catch {
      // a dead lookup must say so; kept out of `rows` so the keyboard model never
      // has a selectable row with no item behind it
      if (seq === seqNo) {
        closeList();
        errNode = h('div', { class: 'ac-list' }, h('div', { class: 'ac-item note-quiet' }, "Couldn't search — try again."));
        mount(errNode);
      }
    } finally { inflight--; }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer); timer = null;
    const q = input.value.trim();
    if (pickedLabel !== null && q !== pickedLabel) pickedLabel = null;
    if (q.length < 1) { seqNo++; return closeList(); }
    timer = setTimeout(() => lookup(q), 160);
  });

  // The list only ever opened on `input`, so a field that looks filled but was
  // never resolved could only be rescued by adding and deleting a character.
  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (!q || list || isResolved()) return;
    clearTimeout(timer);
    timer = setTimeout(() => lookup(q), 160);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // one Escape does ONE thing: dismissing the dropdown must not also reach
      // the document handler and offer to discard the half-typed form behind it
      if (list || errNode) { e.stopPropagation(); closeList(); }
      return;
    }
    if (!list) return;
    if (e.key === 'ArrowDown') { if (!rows.length) return; sel = Math.min(sel + 1, rows.length - 1); }
    else if (e.key === 'ArrowUp') { if (!rows.length) return; sel = Math.max(sel - 1, 0); }
    else if (e.key === 'Enter') {
      // the highlighted row or nothing — never a silent row 0. With no selectable
      // row we also do not preventDefault, so the form's own Enter still works.
      if (sel >= 0 && sel < rows.length) { e.preventDefault(); pick(sel); }
      return;
    } else return;
    e.preventDefault();
    paint();
  });
  input.addEventListener('blur', () => setTimeout(closeList, 120));

  return {
    pick,
    highlighted: () => sel,
    hasList: () => !!list,
    pending: () => timer !== null || inflight > 0,
    forceNow: () => lookup(input.value.trim()),
    close: closeList,
    setPicked: (label) => { pickedLabel = label ?? null; },
  };
}

/* ---------- quick capture (F1 / F2: from any screen, few keystrokes) ---------- */
const LOG_KINDS = [['call', 'Call'], ['meeting', 'Meeting'], ['email', 'Email'], ['message', 'Message'], ['event', 'Event']];
const LOG_KINDS_MORE = [['intro', 'Intro'], ['linkedin', 'LinkedIn']];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
// midday LOCAL time: a demo day logged the next morning must keep the day the
// user picked, and no timezone offset can shift 12:00 across a date boundary.
const middayIso = (y, m, d) => new Date(y, m, d, 12, 0, 0).toISOString();

// single-select pill row(s) sharing one selection; add() returns a row node
function pillGroup(initial, onChange) {
  const btns = new Map();
  let cur = initial;
  const paint = () => { for (const [k, b] of btns) b.classList.toggle('on', k === cur); };
  const add = (pairs) => {
    const row = h('div', { class: 'toggle-row' });
    for (const [k, label] of pairs) {
      const b = h('button', { type: 'button', class: 'toggle' }, label);
      b.addEventListener('click', () => {
        cur = k; paint(); onChange?.(k);
        // a <button> fires neither input nor change, so the modal's dirty guard
        // never saw a channel/when/due choice: Escape discarded it in silence
        b.dispatchEvent(new Event('input', { bubbles: true }));
      });
      btns.set(k, b);
      row.append(b);
    }
    paint();
    return row;
  };
  return { add, get: () => cur, set: (k) => { cur = k; paint(); } };
}

/* quickLogModal(preset?) — the global quick-log (S4).
   preset: { person: {id, name}, companyId, companyName, kind, summary, onDone } */
export function quickLogModal(preset = {}) {
  let personId = preset.person?.id ?? null;
  let personName = preset.person?.name ?? '';
  let followTitleTouched = false;
  let m = null;                       // assigned below; setPerson arms its guard

  const whoInput = h('input', { type: 'text', placeholder: 'Who did you talk to?', autocomplete: 'off', spellcheck: 'false', value: personName });
  const pickList = h('div', { class: 'qa-picklist' });
  const sumInput = h('input', { type: 'text', placeholder: "One line — what was said, what's next", value: preset.summary || '' });
  // an instruction, not a statement: the dead end was that this said what was
  // wrong and offered no way out for a person who is not in the CRM yet
  const warn = h('div', { class: 'warn-strip hidden' }, "Pick who you spoke to from the list — or add them, if they're new.");
  // A touch saved with no sentence is a touch he cannot use in three months, so
  // the empty summary is questioned once — and only once: a fast Enter must
  // never cost the log.
  const sumWarn = h('div', { class: 'warn-strip hidden' },
    "Nothing written yet — one line is what you'll want in three months. Press Log it again to save it blank.");
  sumInput.addEventListener('input', () => { if (sumInput.value.trim()) sumWarn.classList.add('hidden'); });
  const followChk = h('input', { type: 'checkbox' });
  const followTitle = h('input', { type: 'text', placeholder: 'What will you do?' });
  followTitle.addEventListener('input', () => { followTitleTouched = true; });

  /* ---------- "where this leaves them" (S4: log it AND set the next step) ----- */
  const dealLab = h('div', { class: 'group-label' });
  const stageSel = h('select', null, Object.keys(STAGE_LABEL).map((s) => h('option', { value: s }, stageLabel(s))));
  // conviction is the third thing S4 asks for after the call ("log it, set the
  // next step, maybe bump conviction") and had no control anywhere in the log
  const priSel = h('select', null, [1, 2, 3, 4, 5].map((p) => h('option', { value: p }, `${p} ★`)));
  const nextInput = h('input', { type: 'text', placeholder: 'What happens next…' });
  const dealBlock = h('div', { class: 'sub-block hidden' },
    dealLab,
    h('div', { class: 'form-row' },
      h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Stage'), stageSel),
      h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Priority'), priSel)),
    nextInput);
  let deal = null, stage0 = '', next0 = '', pri0 = 3, dealCompany = '', dealSeq = 0;
  // Fetched per picked person, never blocking: if this fails the block simply
  // stays hidden and the touch still logs (the log is the thing that must land).
  async function loadDeal(id) {
    const seq = ++dealSeq;
    deal = null;
    dealBlock.classList.add('hidden');
    if (!id) return;
    let d;
    try { d = await api.get(`/api/people/${id}`); } catch { return; }
    if (seq !== dealSeq || !d?.deal) return;
    deal = d.deal;
    stage0 = deal.stage || 'sourced';
    next0 = deal.next_step || '';
    pri0 = Number(deal.priority || 3);
    dealCompany = d.company?.name || 'them';
    stageSel.value = stage0;
    nextInput.value = next0;
    priSel.value = String(deal.priority || 3);
    dealLab.textContent = `Where this leaves ${dealCompany}`;
    dealBlock.classList.remove('hidden');
  }

  // silent: an automatic preselect is not typed work, so it must not arm the
  // "Discard what you typed?" guard on a form the user has not touched yet.
  const setPerson = (id, name, { silent = false } = {}) => {
    personId = id;
    personName = name || '';
    whoInput.value = personName;
    warn.classList.add('hidden');
    if (!followTitleTouched) followTitle.value = personName ? `Follow up with ${personName}` : '';
    // whoInput must NOT get a synthetic `input` event (the autocomplete listens
    // there and would reopen the dropdown over the form), so the guard is armed
    // directly instead.
    if (!silent) m?.markDirty();
    loadDeal(id);
  };
  if (personName) followTitle.value = `Follow up with ${personName}`;

  const whoAc = autocomplete(whoInput, {
    people: true,
    resolved: () => personId !== null,
    onPick: (it) => { setPerson(it.id, it.label); sumInput.focus(); },
    onCreate: (typed) => addPersonModal((created, info) => {
      if (!created) return;
      setPerson(created.id, [created.first_name, created.last_name].filter(Boolean).join(' '));
      // "save & add another" keeps their form open — stealing focus back would
      // type the next person's name into the summary field
      if (!info?.keepOpen) sumInput.focus();
    }, null, { values: { name: typed }, focus: 'name' }),
  });
  /* Enter in Who never guesses. Already picked -> move on. A highlighted row ->
     take it. Still looking up (typing fast used to drop the person silently and
     bounce him at submit) -> run the lookup NOW and stay put; one more Enter
     commits. Nothing found -> leave the "add them" row on screen. */
  whoInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (personId) { sumInput.focus(); return; }
    const hi = whoAc.highlighted();
    if (hi >= 0) { whoAc.pick(hi); return; }
    if (whoAc.pending() || !whoAc.hasList()) { await whoAc.forceNow(); whoInput.focus(); }
  });
  // retyping the name invalidates the picked id rather than logging on the old one
  whoInput.addEventListener('input', () => {
    if (whoInput.value.trim() !== personName) { personId = null; loadDeal(null); }
  });

  // default Call, not email: the channel feeds channel_diversity, so a wrong
  // default silently mislabels the touch
  const kinds = pillGroup(KIND_LABEL[preset.kind] ? preset.kind : 'call');
  const kindRow = kinds.add(LOG_KINDS);
  const moreRow = kinds.add(LOG_KINDS_MORE);
  moreRow.classList.add('hidden');
  const moreBtn = h('button', { type: 'button', class: 'toggle more' }, 'More…');
  moreBtn.addEventListener('click', () => moreRow.classList.toggle('hidden'));
  kindRow.append(moreBtn);
  if (LOG_KINDS_MORE.some(([k]) => k === kinds.get())) moreRow.classList.remove('hidden');

  const dirs = pillGroup('outbound');
  const dirRow = dirs.add([['outbound', '→ I reached out'], ['inbound', '← They reached out']]);

  // a touch cannot have happened tomorrow: `max` blocks the picker, the strip
  // below catches a typed year, and the API rejects it as a third net
  const dateInput = h('input', { type: 'date', value: ymd(new Date()), max: ymd(new Date()) });
  const dateWarn = h('div', { class: 'warn-strip hidden', style: 'margin-top:6px' },
    "That date hasn't happened yet — pick the day you actually spoke.");
  const dateWrap = h('div', { class: 'hidden', style: 'margin-top:6px' }, dateInput, dateWarn);
  dateInput.addEventListener('input', () => dateWarn.classList.add('hidden'));
  const whens = pillGroup('today', (k) => {
    dateWrap.classList.toggle('hidden', k !== 'pick');
    if (k !== 'pick') dateWarn.classList.add('hidden');
    if (k === 'pick') setTimeout(() => dateInput.focus(), 10);
  });
  const whenRow = whens.add([['today', 'Today'], ['yesterday', 'Yesterday'], ['pick', 'Pick a date…']]);

  const dueDate = h('input', { type: 'date', value: ymd(daysFromNow(3)) });
  const dueWrap = h('div', { class: 'hidden', style: 'margin-top:6px' }, dueDate);
  const dues = pillGroup('d3', (k) => {
    dueWrap.classList.toggle('hidden', k !== 'pick');
    if (k === 'pick') setTimeout(() => dueDate.focus(), 10);
  });
  const dueRow = dues.add([['d3', 'In 3 days'], ['week', 'Next week'], ['pick', 'Pick…']]);
  const followBlock = h('div', { class: 'sub-block hidden' },
    h('label', { class: 'field' }, 'What you promised', followTitle),
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Due'), dueRow, dueWrap));
  followChk.addEventListener('change', () => {
    followBlock.classList.toggle('hidden', !followChk.checked);
    if (!followChk.checked) return;
    if (!followTitleTouched && personName) followTitle.value = `Follow up with ${personName}`;
    setTimeout(() => followTitle.focus(), 10);
  });

  // ISO day strings compare lexicographically, so no Date maths (and no timezone
  // edge) is needed to answer "is the picked day still in the future?"
  const futureDate = () => whens.get() === 'pick'
    && !!String(dateInput.value || '').trim()
    && String(dateInput.value).trim() > ymd(new Date());
  const tsFor = () => {
    const k = whens.get();
    if (k === 'today') return undefined;        // let the server stamp now
    if (k === 'yesterday') { const d = daysFromNow(-1); return middayIso(d.getFullYear(), d.getMonth(), d.getDate()); }
    if (futureDate()) return undefined;         // submit() blocks first; never send one
    const [y, mo, d] = String(dateInput.value || '').split('-').map(Number);
    return (y && mo && d) ? middayIso(y, mo - 1, d) : undefined;
  };
  const dueFor = () => {
    const k = dues.get();
    if (k === 'd3') return ymd(daysFromNow(3));
    if (k === 'week') return ymd(daysFromNow(7));
    return dueDate.value || undefined;
  };

  const submitBtn = h('button', { class: 'primary', type: 'submit' }, icon('check'), 'Log it');
  /* novalidate is load-bearing, not laziness: `max` on the date input makes a typed
     future value fail native constraint validation, and once the user switches When
     back to Today that input is display:none — an invalid field the browser cannot
     point at, so the form silently refuses to submit and the touch is lost with no
     message anywhere. Our own guard reads the date only when When = "pick a date". */
  const form = h('form', { onsubmit: submit, novalidate: '' },
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Who'),
      h('div', { class: 'ac-wrap' }, whoInput), pickList),
    warn,
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Channel'), kindRow, moreRow),
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Direction'), dirRow),
    h('label', { class: 'field' }, 'What happened', sumInput),
    sumWarn,
    dealBlock,
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'When'), whenRow, dateWrap),
    h('label', { class: 'check-row' }, followChk, 'Set a follow-up'),
    followBlock,
    h('div', { class: 'actions' }, submitBtn));

  m = modal('Log a touch', form, preset.person ? { focus: sumInput } : {});
  if (personId) loadDeal(personId);   // preset person: setPerson never ran

  // company preset: show who is at that company, warmest first, already open
  if (preset.companyId && !personId) {
    const where = preset.companyName || 'this company';
    api.get('/api/people' + qs({ company_id: preset.companyId })).then((rows) => {
      const list = (rows || []).slice().sort((a, b) => (Number(b.warmth) || 0) - (Number(a.warmth) || 0));
      if (!list.length) {
        pickList.append(h('div', { class: 'small muted' }, `No one is recorded at ${where} yet — search by name above, or add them first.`));
        return;
      }
      pickList.append(h('div', { class: 'group-label' }, `At ${where} — warmest first`));
      const hint = h('div', { class: 'small muted' });
      pickList.append(hint);
      const btns = [];
      for (const p of list) {
        const nm = escName(p);
        const b = h('button', { type: 'button', class: 'pick-row' },
          h('span', { class: 'nm' }, nm),
          h('span', { class: 'sub' }, [p.title, `last touch ${relTime(p.last_touch)}`].filter(Boolean).join(' · ')));
        b.addEventListener('click', () => {
          setPerson(p.id, nm);
          btns.forEach((x) => x.classList.toggle('on', x === b));
          sumInput.focus();
        });
        btns.push(b);
        pickList.append(b);
      }
      /* PRD §8 Flow 1 step 4: the modal preselects the company's warmest person.
         Without it every "Log touch" on a priority row cost four interactions
         before a word could be typed, which is what capped Monday triage. The
         pick stays visible in Who and in the highlighted row, so nothing is
         guessed silently. */
      if (!personId) {
        const nm0 = escName(list[0]);
        setPerson(list[0].id, nm0, { silent: true });
        btns[0].classList.add('on');
        hint.textContent = `Picked ${nm0} — tap another if it was someone else.`;
        setTimeout(() => sumInput.focus(), 40);
      }
    }).catch(() => {
      // never assert "no people here" off a failed fetch
      pickList.append(h('div', { class: 'warn-strip' }, `Couldn't load the people at ${where} — search for them by name instead.`));
    });
  }

  async function submit(e) {
    e?.preventDefault();
    if (!personId) {
      warn.classList.remove('hidden');
      m.markDirty();
      whoInput.focus();
      return;
    }
    if (futureDate()) {
      dateWarn.classList.remove('hidden');
      m.markDirty();
      dateInput.focus();
      return;
    }
    // asked once, then never again: the second press logs it blank
    if (!sumInput.value.trim() && sumWarn.classList.contains('hidden')) {
      sumWarn.classList.remove('hidden');
      m.markDirty();
      sumInput.focus();
      return;
    }
    submitBtn.disabled = true;
    try {
      const body = { person_id: personId, kind: kinds.get(), direction: dirs.get(), summary: sumInput.value.trim() };
      const ts = tsFor();
      if (ts) body.ts = ts;
      await guard(() => api.post('/api/interactions', body));
      /* The touch is the thing that must never be lost, so the deal moves only
         after it has landed — and if the move fails the toast says so instead of
         claiming a stage the pipeline never took (non-negotiable 3). */
      let moved = null;
      if (deal) {
        const patch = {};
        if (stageSel.value !== stage0) patch.stage = stageSel.value;
        const nx = nextInput.value.trim();
        if (nx !== next0) patch.next_step = nx;
        if (Number(priSel.value) !== pri0) patch.priority = Number(priSel.value);
        if (Object.keys(patch).length) {
          try { await api.patch(`/api/deals/${deal.id}`, patch); moved = patch; }
          catch { toast("Touch logged — but the opportunity didn't move. Change it on the company page.", true); }
        }
      }
      if (followChk.checked) {
        const title = followTitle.value.trim() || `Follow up with ${personName}`;
        const due = dueFor();
        try { await api.post('/api/tasks', { title, due, person_id: personId }); }
        catch { toast('Touch logged — but the follow-up promise did not save. Add it from Today.', true); }
      }
      toast(moved?.stage
        ? `Logged — ${personName} · ${dealCompany} now at ${stageLabel(moved.stage)}`
        : 'Logged — ' + personName);
      m.close(true);
      (preset.onDone || reroute)();
    } catch { submitBtn.disabled = false; }
  }
  return m;
}

/* quickTaskModal(preset?) — recording a promise (S7, S3).
   preset: { person: {id, name}, companyId, companyName, title, due, onDone } */
export function quickTaskModal(preset = {}) {
  let personId = preset.person?.id ?? null;
  let personName = preset.person?.name ?? '';
  const titleInput = h('input', { type: 'text', placeholder: 'e.g. Send the meeting follow-up', value: preset.title || '' });
  const whoInput = h('input', { type: 'text', placeholder: 'Who is it about? (optional)', autocomplete: 'off', value: personName });
  const warn = h('div', { class: 'warn-strip hidden' }, "Say what you promised in a few words — that's what you'll see on Today.");
  autocomplete(whoInput, { people: true, onPick: (it) => { personId = it.id; personName = it.label; whoInput.value = it.label; } });
  whoInput.addEventListener('input', () => { if (whoInput.value.trim() !== personName) personId = null; });

  const OFFSETS = { today: 0, tomorrow: 1, d3: 3, week: 7 };
  let presetDue = null, initialDue = 'd3';
  if (preset.due) {
    const hit = Object.keys(OFFSETS).find((k) => ymd(daysFromNow(OFFSETS[k])) === preset.due);
    if (hit) initialDue = hit; else { presetDue = preset.due; initialDue = 'preset'; }
  }
  const dues = pillGroup(initialDue);
  const dueRow = dues.add([['today', 'Today'], ['tomorrow', 'Tomorrow'], ['d3', 'In 3 days'], ['week', 'Next week'], ['none', 'No date']]);
  const dueFor = () => {
    const k = dues.get();
    if (k === 'none') return undefined;
    if (k === 'preset') return presetDue;
    return ymd(daysFromNow(OFFSETS[k]));
  };

  const submitBtn = h('button', { class: 'primary', type: 'submit' }, icon('check'), 'Save promise');
  const form = h('form', { onsubmit: submit },
    h('label', { class: 'field' }, 'What did you promise', titleInput),
    warn,
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'Who is it about'), h('div', { class: 'ac-wrap' }, whoInput)),
    h('div', { class: 'fieldset' }, h('span', { class: 'lab' }, 'When'), dueRow),
    h('div', { class: 'actions' }, submitBtn));
  const m = modal('New promise', form);

  async function submit(e) {
    e?.preventDefault();
    const title = titleInput.value.trim();
    if (!title) {
      warn.classList.remove('hidden');
      m.markDirty();
      titleInput.focus();
      return;
    }
    submitBtn.disabled = true;
    try {
      const body = { title };
      const due = dueFor();
      if (due) body.due = due;
      if (personId) body.person_id = personId;
      if (preset.companyId) body.company_id = preset.companyId;
      await guard(() => api.post('/api/tasks', body));
      toast("Saved — you'll see it on Today");
      m.close(true);
      (preset.onDone || reroute)();
    } catch { submitBtn.disabled = false; }
  }
  return m;
}

/* ---------- router ---------- */
const routes = [
  { re: /^\/login$/, view: renderLogin, login: true },
  { re: /^\/today$/, view: renderDashboard, nav: 'today' },
  { re: /^\/people$/, view: renderPeople, nav: 'people' },
  { re: /^\/people\/(\d+)$/, view: renderPerson, nav: 'people' },
  { re: /^\/companies$/, view: renderCompanies, nav: 'pipeline' },
  { re: /^\/companies\/(\d+)$/, view: renderCompany, nav: 'pipeline' },
  { re: /^\/network$/, view: renderNetwork, nav: 'network' },
  { re: /^\/settings$/, view: renderSettings, nav: 'settings' },
];
export const navigate = (hash) => { location.hash = hash; };
// re-render the current route after a write, from any view or modal
export function reroute() { return route(); }

const shellEl = document.getElementById('shell');
const loginRoot = document.getElementById('login-root');
const viewEl = document.getElementById('view');

function parseHash() {
  const raw = (location.hash || '#/today').slice(1);
  const [path, query = ''] = raw.split('?');
  return { path: path || '/today', params: new URLSearchParams(query) };
}

async function route() {
  hidePopover();
  const { path, params } = parseHash();
  const match = routes.map(r => ({ r, m: path.match(r.re) })).find(x => x.m);
  if (!match) { location.hash = '#/today'; return; }
  const { r, m } = match;
  if (!r.login && !state.authed) { location.hash = '#/login'; return; }
  if (r.login) {
    shellEl.classList.add('hidden');
    loginRoot.classList.remove('hidden');
    loginRoot.innerHTML = '';
    // render into a container that is attached up front: if a second route()
    // lands mid-render it clears this node instead of stacking a second card
    const lel = h('div');
    loginRoot.append(lel);
    await r.view(lel, { params });
    return;
  }
  loginRoot.classList.add('hidden');
  shellEl.classList.remove('hidden');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === r.nav));
  viewEl.innerHTML = '';
  viewEl.scrollTop = 0;
  const el = h('div', { class: 'view-inner' });
  viewEl.append(el);
  // a slow tap shows shimmer, never a blank rectangle
  const sk = skeleton();
  el.append(sk);
  try { await r.view(el, { id: m[1] ? Number(m[1]) : undefined, params }); }
  catch (e) { if (e.status !== 401) el.append(errorState(e, () => route())); }
  finally { sk.remove(); }
}

/* ---------- shell chrome ---------- */
function buildNav() {
  const items = [
    ['today', 'Today', '#/today'], ['people', 'People', '#/people'],
    ['pipeline', 'Pipeline', '#/companies'], ['network', 'Network', '#/network'],
    ['settings', 'Settings', '#/settings'],
  ];
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  // the label lives in its own span so the phone layout can drop it and keep the icon
  for (const [key, label, href] of items) nav.append(h('a', { href, dataset: { nav: key } }, icon(key), h('span', { class: 'nav-label' }, label)));
}

/* The quick-capture bar: F1 wants "add a person from any screen", F2 wants a
   logged interaction in <= 3 interactions from anywhere. */
function buildQuickActions() {
  const wrap = document.getElementById('quick-actions');
  if (!wrap) return;
  wrap.innerHTML = '';
  // On a phone `.qa-label` is hidden, so the glyph is the only differentiator —
  // three identical plus boxes are how a user lands in the wrong form.
  // The label stays hidden; `aria-label` carries it for screen readers.
  const btn = (label, title, iconName, onclick) => h('button', { class: 'qa-btn', type: 'button', title, 'aria-label': title, onclick },
    icon(iconName), h('span', { class: 'qa-label' }, label));
  wrap.append(
    btn('Person', 'Add a person (n)', 'userplus', () => addPersonModal(() => reroute())),
    btn('Log touch', 'Log a touch (l)', 'chat', () => quickLogModal()),
    btn('Promise', 'Record a promise (t)', 'flag', () => quickTaskModal()),
  );
}

function showKeyboardHelp() {
  const anchor = document.getElementById('quick-actions');
  if (!anchor) return;
  showPopover(anchor, popContent('Keyboard', [
    { k: '/', v: 'search' },
    { k: 'n', v: 'new person' },
    { k: 'l', v: 'log a touch' },
    { k: 't', v: 'new promise' },
    { k: 'Esc', v: 'close' },
  ]));
  popPinned = true;
}

export function refreshMeChip() {
  const chip = document.getElementById('me-chip');
  chip.innerHTML = '';
  const name = state.me ? escName(state.me) : 'Me';
  chip.append(h('span', { class: 'avatar' }, initials(name)), h('span', null, name));
  // no_auth mode has no password to lock behind, so offering "Lock workspace"
  // would strand the user on a login screen they can never pass.
  if (state.authed && !state.no_auth) {
    chip.append(h('button', {
      class: 'ghost icon-btn', title: 'Lock workspace', style: 'margin-left:auto',
      onclick: async () => {
        try { await api.post('/api/auth/logout'); } catch { /* session already gone */ }
        state.authed = false; state.me = null;
        refreshMeChip();
        if (location.hash === '#/login') route(); else location.hash = '#/login';
      },
    }, icon('logout')));
  }
}

function buildSearch() {
  document.getElementById('search-icon').append(icon('search'));
  const input = document.getElementById('global-search');
  const results = document.getElementById('search-results');
  let timer = null, flat = [], sel = -1, seq = 0;
  const closeR = () => { results.classList.add('hidden'); results.innerHTML = ''; flat = []; sel = -1; };
  const paintR = () => flat.forEach((o, i) => o.classList.toggle('sel', i === sel));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { seq++; return closeR(); }
    timer = setTimeout(async () => {
      const mine = ++seq;             // a stale response must never repaint
      let res;
      try { res = await api.get('/api/search' + qs({ q })); }
      catch {
        if (mine !== seq) return;
        // a search box that returns silence reads as data loss
        results.innerHTML = ''; flat = []; sel = -1;
        results.append(h('div', { class: 'sr-item note' }, h('span', null, 'Search failed — check the connection.')));
        results.classList.remove('hidden');
        return;
      }
      if (mine !== seq) return;
      results.innerHTML = ''; flat = []; sel = -1;
      // the API caps each group at 8, so a truncated list has to say so rather
      // than let 8 of 43 pass for the whole answer
      const addGroup = (label, arr, total, fn) => {
        if (!arr?.length) return;
        const n = Number(total);
        const more = Number.isFinite(n) && n > arr.length;
        results.append(h('div', { class: 'group-label' }, more ? `${label} · ${arr.length} of ${n}` : label));
        for (const it of arr) {
          const { title, sub, go } = fn(it);
          const item = h('div', { class: 'sr-item', onmousedown: (e) => { e.preventDefault(); closeR(); input.blur(); navigate(go); } },
            h('span', null, title), h('span', { class: 'sub' }, sub));
          results.append(item); flat.push(item);
        }
      };
      // `snippet` (when the backend returns one) is the matching note text, and a
      // hit on the sender address shows the address — either way the row answers
      // "why did this match?" better than title · company does
      addGroup('People', res.people, res.people_total, p => ({
        title: escName(p),
        sub: p.snippet ?? (p.matched_on === 'email' ? p.email : [p.title, p.company_name || p.company].filter(Boolean).join(' · ')),
        go: `#/people/${p.id}`,
      }));
      addGroup('Companies', res.companies, res.companies_total, c => ({ title: c.name, sub: [c.kind, c.sector].filter(Boolean).join(' · '), go: `#/companies/${c.id}` }));
      if (!flat.length) {
        const add = h('div', {
          class: 'sr-item',
          onmousedown: (e) => { e.preventDefault(); closeR(); input.blur(); addPersonModal(() => reroute()); },
        }, h('span', null, `Nothing matches “${q}” — add them`), h('span', { class: 'sub' }, 'new person'));
        results.append(add); flat.push(add);
      }
      // the row Enter will take has to be VISIBLE: an invisible default is how a
      // call gets filed on the wrong contact
      sel = flat.length ? 0 : -1;
      paintR();
      results.classList.remove('hidden');
    }, 160);
  });
  input.addEventListener('keydown', (e) => {
    if (results.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') sel = Math.min(sel + 1, flat.length - 1);
    else if (e.key === 'ArrowUp') sel = Math.max(sel - 1, 0);
    else if (e.key === 'Enter') {
      // the highlighted row or nothing — never a silent row 0
      if (sel >= 0 && flat[sel]) { e.preventDefault(); flat[sel].dispatchEvent(new Event('mousedown')); }
      return;
    }
    else if (e.key === 'Escape') { closeR(); input.blur(); return; }
    else return;
    e.preventDefault();
    paintR();
  });
  input.addEventListener('blur', () => setTimeout(closeR, 140));
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const ae = document.activeElement;
    const typing = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName || '') || ae?.isContentEditable === true;
    // capture keys only when the user is not typing and no modal owns the screen.
    // `/` is inside this guard too: it used to fire from a focused channel pill
    // (a button, so `typing` is false) and moved focus to the search box UNDER the
    // backdrop, where the contact's name went into an invisible field.
    if (typing || modalOpen() || !state.authed) return;
    if (e.key === '/') { e.preventDefault(); input.focus(); input.select(); return; }
    if (e.key === 'n') { e.preventDefault(); addPersonModal(() => reroute()); }
    else if (e.key === 'l') { e.preventDefault(); quickLogModal(); }
    else if (e.key === 't') { e.preventDefault(); quickTaskModal(); }
    else if (e.key === '?') { e.preventDefault(); showKeyboardHelp(); }
  });
}

export async function refreshAuth() {
  const st = await api.get('/api/auth/status');
  state.setup = st.setup; state.authed = st.authed; state.me = st.me; state.no_auth = !!st.no_auth;
  refreshMeChip();
  return st;
}

/* ---------- boot ---------- */
buildNav();
buildSearch();
buildQuickActions();
window.addEventListener('hashchange', route);
(async () => {
  try { await refreshAuth(); } catch { /* status endpoint should not 401 */ }
  const want = !state.authed ? '#/login'
    : (!location.hash || location.hash === '#/' || location.hash === '#') ? '#/today'
      : null;
  // assigning the hash fires hashchange, which routes: calling route() as well
  // would render the view twice
  if (want && location.hash !== want) location.hash = want;
  else route();
})();
