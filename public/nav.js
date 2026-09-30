// In-app page history for the header Back/Forward buttons.
//
// Every in-app page is a hash URL, and every hash navigation creates one browser history
// entry. We tag each entry with history.state.glIdx (its position in our stack), so:
//   * an entry WITH glIdx is a traversal (browser back/forward, our buttons, or a reload);
//   * an entry WITHOUT it is a new navigation (link click, week change, typed deep link),
//     which truncates any forward entries (branching) and appends.
// The buttons only call history.back()/forward() when our stack has an entry in that
// direction, so they can never leave the app. The stack lives in sessionStorage (per tab),
// so it survives refresh but a fresh tab / deep link starts a new history at that page.

export const DEFAULT_HASH = '#/nfl';
const MAX = 200;

/** Pure reducer. nav = {stack:[{hash,title?}], idx}; ev = {hash, stateIdx}. */
export function navReduce(nav, ev) {
  const hash = normalizeHash(ev.hash);
  const stack = Array.isArray(nav?.stack) ? nav.stack.slice() : [];
  const idx = Number.isInteger(nav?.idx) ? nav.idx : -1;
  const s = ev.stateIdx;
  // Traversal to an entry we know, whose hash still matches -> just move the cursor.
  if (Number.isInteger(s) && s >= 0 && s < stack.length && stack[s].hash === hash) {
    return { nav: { stack, idx: s }, kind: 'traverse' };
  }
  // New navigation: drop forward entries (branch), then append.
  const base = stack.slice(0, Math.max(0, idx + 1));
  if (base.length && base[base.length - 1].hash === hash && !Number.isInteger(s)) {
    // Same page re-entered without a history entry (e.g. first load normalisation).
    return { nav: { stack: base, idx: base.length - 1 }, kind: 'same' };
  }
  base.push({ hash });
  const trimmed = base.length > MAX ? base.slice(base.length - MAX) : base;
  return { nav: { stack: trimmed, idx: trimmed.length - 1 }, kind: 'push' };
}

export const canBack = (nav) => nav.idx > 0;
export const canForward = (nav) => nav.idx >= 0 && nav.idx < nav.stack.length - 1;

export function normalizeHash(h) {
  if (!h || h === '#' || h === '#/') return DEFAULT_HASH;
  return h.startsWith('#') ? h : `#${h}`;
}

/** Human label for a page, used in button tooltips / aria labels. */
export function labelFor(entry) {
  if (!entry) return '';
  if (entry.title) return entry.title;
  const h = entry.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'ledger') return 'Ledger';
  const lg = parts[0] === 'cfb' ? 'College' : 'NFL';
  if (parts[1] === 'game') return `${lg} matchup`;
  const week = new URLSearchParams(qs || '').get('week');
  return `${lg} slate${week ? ` · week ${week}` : ''}`;
}

// ---------------- Browser binding ----------------
const KEY = 'gridline.nav.v1';
function load() {
  try { const v = JSON.parse(sessionStorage.getItem(KEY)); if (v && Array.isArray(v.stack)) return v; } catch { /* storage blocked */ }
  return { stack: [], idx: -1 };
}
function save(nav) { try { sessionStorage.setItem(KEY, JSON.stringify(nav)); } catch { /* storage blocked */ } }

let nav = { stack: [], idx: -1 };
let onChange = () => {};

/** Call at the start of every route. Returns the updated nav state. */
export function recordNavigation() {
  const stateIdx = history.state && Number.isInteger(history.state.glIdx) ? history.state.glIdx : undefined;
  const r = navReduce(nav, { hash: location.hash, stateIdx });
  nav = r.nav;
  const target = nav.stack[nav.idx].hash;
  // Tag the current browser entry with its stack position (no new entry, no event).
  if (history.state?.glIdx !== nav.idx || location.hash !== target) {
    history.replaceState({ ...(history.state || {}), glIdx: nav.idx }, '', target);
  }
  save(nav);
  onChange(nav);
  return nav;
}

export function setTitle(title) {
  if (nav.idx < 0) return;
  nav.stack[nav.idx].title = title;
  save(nav);
  onChange(nav);
}

export function goBack() { if (canBack(nav)) history.back(); }
export function goForward() { if (canForward(nav)) history.forward(); }

export function initNav(render) {
  nav = load();
  onChange = render;
}
export const current = () => nav;
