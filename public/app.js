// Gridline front end — vanilla ES modules, hash routing, hand-built SVG charts.
import { matchupTheme } from './theme.js';
import { initNav, recordNavigation, setTitle, goBack, goForward, canBack, canForward, labelFor } from './nav.js';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const state = { league: 'nfl', week: null, calendar: {}, slate: null, matchup: null, sel: {}, ledgerKind: 'pregame', ledgerModel: null, status: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ET = (d, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(new Date(d));
const etTime = (d) => `${ET(d, { hour: 'numeric', minute: '2-digit' })} ET`;
const etDay = (d) => ET(d, { weekday: 'long', month: 'short', day: 'numeric' });
const etStamp = (d) => (d ? `${ET(d, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET` : '—');
const am = (o) => (o == null ? '—' : o > 0 ? `+${Math.round(o)}` : `${Math.round(o)}`);
const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const f1 = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : (Math.round(x * 10) / 10).toString());
const f2 = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(2));
const sgn = (x) => (x == null ? '—' : x > 0 ? `+${x}` : `${x}`);

// Static (GitHub Pages) mode: the same UI reads pre-built JSON and never writes.
const STATIC = window.GRIDLINE_STATIC || null;
function staticPath(p) {
  const u = new URL(p, 'http://x');
  const q = u.searchParams;
  switch (u.pathname) {
    case '/api/status': return 'api/status.json';
    case '/api/slate': return `api/slate/${q.get('league') || 'nfl'}${q.get('week') ? `-w${q.get('week')}` : ''}.json`;
    case '/api/matchup': return `api/matchup/${q.get('league')}/${q.get('id')}.json`;
    case '/api/ledger': return `api/ledger/${q.get('kind') || 'pregame'}-${q.get('model') || ''}.json`;
    case '/api/blind': return `api/blind${q.get('batch') ? `-${q.get('batch')}` : ''}.json`;
    default: return null;
  }
}
async function api(path, opts) {
  if (STATIC) {
    if (opts?.method && opts.method !== 'GET') throw new Error('This is a read-only public snapshot — recording, settling and backtests run only in the local app.');
    const sp = staticPath(path);
    if (!sp) throw new Error('Not available in the read-only snapshot.');
    const r = await fetch(sp);
    if (!r.ok) throw new Error(r.status === 404 ? 'Not included in this read-only snapshot (only the current week and completed NFL weeks are pre-built).' : `HTTP ${r.status}`);
    return r.json();
  }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function loading(msg) { app.innerHTML = `<div class="loading">${esc(msg)}<div class="bar"></div></div>`; }
function fail(e) { app.innerHTML = `<div class="error">Could not load: ${esc(e.message.replace(/\.$/, ''))}.${window.GRIDLINE_STATIC ? '' : ' Cached data is used automatically when available; try again shortly.'}</div>`; }

// ---------------- Routing ----------------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  if (parts[0] === 'ledger') return { view: 'ledger' };
  const league = parts[0] === 'cfb' ? 'cfb' : 'nfl';
  if (parts[1] === 'game' && parts[2]) return { view: 'game', league, id: parts[2] };
  return { view: 'slate', league, week: q.get('week') ? Number(q.get('week')) : null };
}
// Header Back/Forward: follow in-app page history only; disabled at the boundaries.
function renderNav(nav) {
  const b = $('#navBack'), f = $('#navFwd');
  const back = canBack(nav), fwd = canForward(nav);
  b.disabled = !back; f.disabled = !fwd;
  const bl = back ? `Back to ${labelFor(nav.stack[nav.idx - 1])}` : 'Back (no earlier page in Gridline)';
  const fl = fwd ? `Forward to ${labelFor(nav.stack[nav.idx + 1])}` : 'Forward (no later page)';
  b.setAttribute('aria-label', bl); b.title = bl;
  f.setAttribute('aria-label', fl); f.title = fl;
}
initNav(renderNav);
$('#navBack').addEventListener('click', goBack);
$('#navFwd').addEventListener('click', goForward);

let routeSeq = 0;
async function route() {
  recordNavigation();
  const seq = ++routeSeq;
  state.routeSeq = seq;
  const r = parseHash();
  if (r.league) state.league = r.league;
  document.querySelectorAll('.league a').forEach((a) => a.classList.toggle('on', a.dataset.league === state.league && r.view !== 'ledger'));
  document.querySelectorAll('.views a').forEach((a) => a.classList.toggle('on', a.dataset.view === (r.view === 'ledger' ? 'ledger' : 'slate')));
  $('.views a[data-view=slate]').href = `#/${state.league}`;
  $('.week').style.visibility = r.view === 'slate' ? 'visible' : 'hidden';
  window.scrollTo(0, 0);
  if (r.view === 'ledger') return renderLedger();
  if (r.view === 'game') return renderGame(r.league, r.id);
  return renderSlate(r.league, r.week);
}
window.addEventListener('hashchange', route);
// Static mode: strip every control that would write (they have no backend there).
if (STATIC) {
  const strip = () => document.querySelectorAll('#snapbtn, #snapnfl, #snapcfb, #settle, #btl, #btw, #btgo, #blindrun').forEach((el) => el.remove());
  new MutationObserver(strip).observe(document.getElementById('app'), { childList: true, subtree: true });
  const b = document.createElement('div');
  b.className = 'staticbar';
  b.innerHTML = `Read-only public snapshot · data built ${new Date(STATIC.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET · refreshes about every 6 hours · projections are experimental, not betting advice`;
  document.body.insertBefore(b, document.querySelector('main'));
}
$('#week').addEventListener('change', (e) => { location.hash = `#/${state.league}?week=${e.target.value}`; });

async function loadStatus() {
  try { state.status = await api('/api/status'); } catch { /* optional */ }
}

// ---------------- Slate ----------------
async function renderSlate(lg, week) {
  const my = state.routeSeq;
  loading(`Loading ${lg === 'nfl' ? 'NFL' : 'college'} slate…`);
  let s;
  try { s = await api(`/api/slate?league=${lg}${week ? `&week=${week}` : ''}`); } catch (e) { if (my === state.routeSeq) fail(e); return; }
  if (my !== state.routeSeq) return; // user navigated away while loading
  setTitle(`${lg === 'nfl' ? 'NFL' : 'College'} slate · week ${s.week ?? '—'}`);
  state.slate = s;
  const sel = $('#week');
  const reg = s.calendar.filter((c) => c.seasontype === 2);
  sel.innerHTML = reg.map((c) => `<option value="${c.week}" ${c.week === s.week ? 'selected' : ''}>${esc(c.label)}${c.detail ? ` · ${esc(c.detail)}` : ''}</option>`).join('');
  setStatus(s.meta);
  const byDay = new Map();
  for (const g of s.games) { const k = etDay(g.date); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(g); }
  const team = (t, other) => `<div class="tm">${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : ''}<span class="ab">${esc(t.abbr)}</span>${t.rank ? `<span class="rk">#${t.rank}</span>` : ''}<span class="nm">${esc(t.name)}${t.record ? ` <span class="faint">${esc(t.record)}</span>` : ''}</span>${t.score != null && other ? `<span class="sc">${t.score}</span>` : ''}</div>`;
  app.innerHTML = `
    <div class="slate-head"><h1>${s.league === 'nfl' ? 'NFL' : 'College football'} · Week ${s.week ?? '—'}</h1>
      <span class="muted">${s.games.length} games · kickoff times Eastern · lines ${esc(s.games.find((g) => g.odds)?.odds?.provider || 'n/a')} via ESPN, retrieved ${etStamp(s.meta?.fetchedAt)}${s.meta?.stale ? ' <span class="tag warn">stale cache</span>' : ''}</span></div>
    ${s.league === 'cfb' ? '<p class="muted">FBS games only. College cards emphasise the running-back matchup (explosive-run upside).</p>' : ''}
    ${[...byDay].map(([day, games]) => `<section class="day"><h3>${esc(day)}</h3>
      ${games.map((g) => {
        const live = g.status.state === 'in';
        const o = g.odds;
        return `<a class="game" href="#/${lg}/game/${g.id}">
          <div class="time">${etTime(g.date)}</div>
          <div class="teams">${team(g.away, g.status.state !== 'pre')}${team(g.home, g.status.state !== 'pre')}</div>
          <div class="line-cell">${o ? `${esc(o.details || '—')} · O/U ${o.total ?? '—'}<small>ML ${esc(g.away.abbr)} ${am(o.awayML)} / ${esc(g.home.abbr)} ${am(o.homeML)}</small>` : '<span class="faint">No line posted</span>'}</div>
          <div class="line-cell hide-sm">${g.implied ? `${esc(g.away.abbr)} ${g.implied.away} – ${esc(g.home.abbr)} ${g.implied.home}<small>book-implied score</small>` : '<span class="faint">—</span>'}</div>
          <div class="state ${live ? 'live' : ''}">${esc(g.status.state === 'pre' ? 'Scheduled' : g.status.detail || '')}</div>
        </a>`;
      }).join('')}</section>`).join('') || '<p class="muted">No games found for this week.</p>'}`;
}

function setStatus(meta) {
  const el = $('#status');
  if (!meta) { el.textContent = ''; return; }
  el.innerHTML = `<span class="dot ${meta.stale ? 'stale' : ''}"></span>${meta.stale ? 'Stale cache' : 'Live'} · ${etStamp(meta.fetchedAt)}${state.status ? ` · model ${esc(state.status.modelVersion)}` : ''}`;
}

// ---------------- Matchup ----------------
// Home-perspective script states. Away-leading states take the away color, home-leading the home color.
const SCRIPT = [
  ['blowTrail', 'Trail big', 'var(--away)', 'var(--away-accent-ink)', 1],
  ['trail', 'Trail', 'var(--away)', 'var(--away-accent-ink)', 0.55],
  ['close', 'Close', 'var(--rule-2)', 'var(--ink)', 1],
  ['lead', 'Lead', 'var(--home)', 'var(--home-accent-ink)', 0.55],
  ['blowLead', 'Lead big', 'var(--home)', 'var(--home-accent-ink)', 1],
];

async function renderGame(lg, id) {
  loading('Building matchup: schedules, box scores, play-by-play, rosters, injuries, props, weather — then simulating…');
  const my = state.routeSeq;
  let m;
  try { m = await api(`/api/matchup?league=${lg}&id=${id}`); } catch (e) { if (my === state.routeSeq) fail(e); return; }
  if (my !== state.routeSeq) return; // user navigated away while loading
  setTitle(`${m.away.abbr} @ ${m.home.abbr} (${lg === 'nfl' ? 'NFL' : 'College'} wk ${m.week ?? '—'})`);
  state.matchup = m;
  const summ = m.sources.find((s) => s.label === 'Game summary');
  setStatus(summ);
  const o = m.odds;
  const A = m.away, H = m.home;
  const done = m.status.completed;
  const snap = m.snapshot;
  const th = matchupTheme(A, H, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0c0f13');
  state.theme = th;
  const vars = ['away', 'home'].map((k) => `--${k}:${th[k].accent};--${k}-fill:${th[k].fill};--${k}-ink:${th[k].ink};--${k}-accent-ink:${th[k].accentInk}`).join(';');
  app.innerHTML = `<div class="matchup" style="${vars}">
    <a class="back" href="#/${lg}${m.week ? `?week=${m.week}` : ''}">← ${esc(m.leagueLabel)} week ${m.week ?? ''} slate</a>
    <section class="mh">
      <div class="side away">${A.logo ? `<img src="${esc(A.logo)}" alt="">` : ''}<div><div class="abbr">${esc(A.abbr)}</div><div class="full">${esc(A.name)}${A.record ? ` · ${esc(A.record)}` : ''}</div></div>${A.score != null && m.status.state !== 'pre' ? `<div class="score">${A.score}</div>` : ''}</div>
      <div class="mid"><div class="ko">${esc(ET(m.kickoff, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${etTime(m.kickoff)}</div>
        <div>${esc(m.status.detail || '')}</div><div>${esc(m.venue?.name || '')}${m.venue?.city ? ` · ${esc(m.venue.city)}${m.venue.state ? `, ${esc(m.venue.state)}` : ''}` : ''}</div>
        <div>${weatherText(m.weather)}</div></div>
      <div class="side home">${H.score != null && m.status.state !== 'pre' ? `<div class="score">${H.score}</div>` : ''}<div><div class="abbr">${esc(H.abbr)}</div><div class="full">${esc(H.name)}${H.record ? ` · ${esc(H.record)}` : ''}</div></div>${H.logo ? `<img src="${esc(H.logo)}" alt="">` : ''}</div>
    </section>
    <section class="oddsbar">
      <div><div class="k">Spread</div><div class="v">${o?.homeSpread != null ? `${esc(H.abbr)} ${sgn(o.homeSpread)}` : '—'}</div><div class="s">${o?.homeSpreadOdds != null ? `${am(o.homeSpreadOdds)} / ${am(o.awaySpreadOdds)}` : 'price n/a'}</div></div>
      <div><div class="k">Total</div><div class="v">${o?.total ?? '—'}</div><div class="s">${o?.overOdds != null ? `O ${am(o.overOdds)} / U ${am(o.underOdds)}` : 'price n/a'}</div></div>
      <div><div class="k">Moneyline</div><div class="v">${o?.awayML != null ? `${am(o.awayML)} / ${am(o.homeML)}` : '—'}</div><div class="s">${m.mlNoVig ? `no-vig ${esc(A.abbr)} ${pct(m.mlNoVig.b)} · ${esc(H.abbr)} ${pct(m.mlNoVig.a)}` : ''}</div></div>
      <div><div class="k">Book-implied score</div><div class="v">${m.implied ? `${m.implied.away} – ${m.implied.home}` : '—'}</div><div class="s">(total ∓ spread) ÷ 2</div></div>
      <div><div class="k">Model version</div><div class="v" style="font-size:14px">${esc(m.modelVersion)}</div><div class="s">${esc(m.sims)} sims · ${m.mode === 'pregame' ? 'pregame' : 'retrospective'}</div></div>
    </section>
    <div class="provline">
      <span>Lines: ${esc(o?.meta?.source || 'no line')} · retrieved ${etStamp(o?.meta?.retrievedAt)} — ${esc(o?.meta?.note || '')}</span>
      <span>Data cutoff: ${etStamp(m.cutoff)} (kickoff) · latest input ${etStamp(m.latestInput)}</span>
      ${snap ? `<span>${snap.ok ? `Ledger: pregame snapshot run #${snap.runId}${snap.existing ? ' (recorded earlier)' : snap.duplicate ? ' (unchanged)' : ' recorded'} ${etStamp(snap.createdAt)}` : `Ledger: ${esc(snap.reason)}`}</span>` : ''}
      ${m.mode === 'pregame' ? `<button class="btn" id="snapbtn">Record new snapshot</button>` : ''}
    </div>
    ${m.mode !== 'pregame' ? `<div class="banner">Retrospective view. Projections are rebuilt using only games completed before kickoff; injury reports, depth charts and weather are <b>not</b> applied because today's versions would leak post-kickoff information.${done ? ' Actual results are shown beside each projection.' : ''}</div>` : ''}
    ${scriptBlock(A, H)}
    ${outlierBlock(m)}
    ${outliersBlock(m)}
    ${skepticBlock(m)}
    ${m.rbUpside ? `<div class="callout"><div class="k">RB matchup upside</div>${esc(m.rbUpside.name)} (${esc(m.rbUpside.team)}) — 90th-percentile outcome ${m.rbUpside.p90} rush yds; opponent allows explosive RB runs at ×${f2(m.rbUpside.oppRun10Mult)} (10+) / ×${f2(m.rbUpside.oppRun20Mult)} (20+) the baseline rate after sample shrinkage. Upside, not a prediction of a big play.</div>` : ''}
    ${injuryBlock(m)}
    <h2 class="sec">Players — side by side · projection, 10th–90th range, last five</h2>
    ${pairedPlayers(m)}
    ${gradesBlock(m)}
    ${contextBlock(m)}
    <h2 class="sec">Disclosures &amp; unavailable inputs</h2>
    <ul class="disc">${m.disclosures.map((d) => `<li>${esc(d)}</li>`).join('')}<li>League baselines: ${esc(m.baselines.source)}.</li>${m.weatherEffects?.length ? `<li>Weather adjustments applied: ${esc(m.weatherEffects.join('; '))}</li>` : ''}</ul>
    <h2 class="sec">Sources (${m.sources.length})</h2>
    <div class="scroll"><table class="src"><tbody>${m.sources.map((s) => `<tr><td>${esc(s.label || '')}</td><td>${esc(s.source)}</td><td>${etStamp(s.fetchedAt)}</td><td>${s.error ? `<span class="tag ${s.stale ? 'warn' : 'bad'}">${s.stale ? 'stale cache' : 'error'}: ${esc(s.error)}</span>` : s.fromCache ? 'cache' : 'fresh'}</td><td class="u">${esc(s.url)}</td></tr>`).join('')}</tbody></table></div></div>`;
  wireCards();
  wireSideToggle();
  const sb = $('#snapbtn');
  if (sb) sb.onclick = async () => {
    sb.disabled = true; sb.textContent = 'Recording…';
    try { const r = await api(`/api/snapshot?league=${lg}&id=${id}`, { method: 'POST' }); sb.textContent = r.ok ? (r.duplicate ? `Unchanged (run #${r.runId})` : `Recorded run #${r.runId}`) : r.reason; }
    catch (e) { sb.textContent = e.message; }
  };
}

function weatherText(w) {
  if (!w) return '';
  if (!w.available) return `<span class="faint">Weather: ${esc(w.reason)}</span>`;
  if (w.indoor) return 'Indoor / roof';
  return `${f1(w.tempF)}°F · wind ${f1(w.windMph)} mph (gusts ${f1(w.gustMph)}) · precip ${w.precipIn ?? 0}" <span class="faint">Open-Meteo</span>`;
}

function scriptBlock(A, H) {
  const w = H.scriptWeights;
  const segs = SCRIPT.map(([k, label, c, ink, a]) => ({ k, label, c, ink, a, w: w[k] || 0 }));
  return `<section class="script"><h2 class="sec" style="margin-top:0">Game-script scenarios · ${esc(H.abbr)} perspective</h2>
    <div class="ends"><span style="color:var(--away)">◀ ${esc(A.abbr)} leading</span><span style="color:var(--home)">${esc(H.abbr)} leading ▶</span></div>
    <div class="spectrum" role="img" aria-label="Scenario weights">${segs.map((s) => `<div style="flex:${Math.max(s.w, 0.0001)};background:color-mix(in srgb, ${s.c} ${Math.round(s.a * 100)}%, var(--bg));color:${s.a === 1 ? s.ink : 'var(--ink)'}" title="${s.label} ${pct(s.w)}">${s.w > 0.07 ? `${s.label} ${pct(s.w)}` : ''}</div>`).join('')}</div>
    <p>Weights from ${esc(H.scriptSource.toLowerCase())}: expected ${esc(H.abbr)} margin ${sgn(Math.round(H.expMargin * 10) / 10)}. Each simulated game opens close (first ~40% of plays) and then follows one script; pass rates and each player's carry/target shares change by script using that team's measured splits (shrunk toward its overall rates). Approximation — not a validated win-probability model.</p></section>`;
}

function injuryBlock(m) {
  const side = (t) => {
    const list = (t.injuries || []).filter((i) => i.relevant).sort((a, b) => rankSev(a.severity) - rankSev(b.severity));
    const ex = t.roles.excluded || [];
    return `<div><h4>${esc(t.abbr)}</h4>${list.length ? `<ul>${list.map((i) => `<li><span class="pos">${esc(i.pos || '')}</span><span class="who">${esc(i.name)}</span><span class="faint">${esc([i.type, i.detail].filter(Boolean).join(' · '))}</span><span class="st tag ${i.severity === 'out' || i.severity === 'doubtful' ? 'bad' : 'warn'}">${esc(i.status)}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:4px 0">No skill-position players on the report.</p>'}
      ${ex.length ? `<p class="muted" style="font-size:12px">Excluded from roles: ${ex.map((e) => `${esc(e.name)} (${esc(e.reason)})`).join(', ')}</p>` : ''}
      ${t.roles.notes.map((n) => `<p class="muted" style="font-size:12px;margin:4px 0">${esc(n.text)}</p>`).join('')}</div>`;
  };
  return `<h2 class="sec">Availability</h2><p class="muted" style="font-size:12px;margin-top:-4px">${esc(m.injuryNote)}</p><section class="inj">${side(m.away)}${side(m.home)}</section>`;
}
const rankSev = (s) => ({ out: 0, doubtful: 1, questionable: 2, probable: 3 }[s] ?? 4);

const SLOTS = [
  ['QB', (c) => c.role === 'Starting QB'],
  ['RB1', (c) => c.role === 'RB1'],
  ['RB2', (c) => c.role === 'RB2'],
  ['Receiver 1', (c) => c.role === 'Receiver 1'],
  ['Receiver 2', (c) => c.role === 'Receiver 2'],
  ['Additional', (c) => c.role === 'Additional'],
  ['Outlier pick', (c) => c.role === 'Outlier pick'],
];

// Teams side by side: one team per column, one row per role so corresponding players line up.
function pairedPlayers(m) {
  const A = m.away, H = m.home;
  const hl = m.outlier?.pick?.playerId;
  const cell = (t, side, c, label) => `<div class="cell ${side}">${c ? card(m, c, c.id === hl) : `<div class="empty">${esc(t.abbr)}: no ${esc(label.toLowerCase())} ${label === 'Additional' ? 'met the usage threshold' : label === 'Outlier pick' ? 'on this side' : 'with usage before kickoff'}</div>`}</div>`;
  const rows = SLOTS.map(([label, f]) => {
    const a = A.cards.find(f), h = H.cards.find(f);
    if (!a && !h) return '';
    return `<div class="pair" data-slot="${esc(label)}"><div class="slot">${esc(label)}</div>${cell(A, 'away', a, label)}${cell(H, 'home', h, label)}</div>`;
  }).join('');
  const kick = A.kicker || H.kicker ? `<div class="pair kickrow"><div class="slot">Kicker</div><div class="cell away">${A.kicker ? kicker(m, A.kicker) : '<div class="empty">—</div>'}</div><div class="cell home">${H.kicker ? kicker(m, H.kicker) : '<div class="empty">—</div>'}</div></div>` : '';
  const head = (t, side) => `<div class="teamhead ${side}">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : ''}<div><div class="tn">${esc(t.name)}</div><div class="ti">implied ${f1(t.impliedPts)} pts · ${f1(t.params.plays)} plays${t.roles.qbSource ? ` · QB: ${esc(t.roles.qbSource)}` : ''}</div></div></div>`;
  return `<div class="sidetoggle" role="radiogroup" aria-label="Teams shown">
      <button role="radio" aria-checked="true" data-show="both">Both</button>
      <button role="radio" aria-checked="false" data-show="away">${esc(A.abbr)}</button>
      <button role="radio" aria-checked="false" data-show="home">${esc(H.abbr)}</button>
    </div>
    <div class="pairs" data-show="both">
      <div class="pair heads"><div class="slot"></div>${head(A, 'away')}${head(H, 'home')}</div>
      ${rows || '<p class="muted">No players with usage before kickoff.</p>'}
      ${kick}
    </div>`;
}

function wireSideToggle() {
  const box = document.querySelector('.pairs');
  document.querySelectorAll('.sidetoggle button').forEach((b) => b.addEventListener('click', () => {
    box.dataset.show = b.dataset.show;
    document.querySelectorAll('.sidetoggle button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));
}

function skepticBlock(m) {
  const k = m.skeptic;
  if (!k) return '';
  const main = k.findings.filter((f) => f.severity !== 'info');
  const info = k.findings.filter((f) => f.severity === 'info');
  const head = main.length
    ? `${k.counts.high ? `<b class="sk-high">${k.counts.high} likely logic error${k.counts.high > 1 ? 's' : ''}</b>` : ''}${k.counts.high && k.counts.medium ? ' · ' : ''}${k.counts.medium ? `<b class="sk-med">${k.counts.medium} worth a look</b>` : ''}`
    : 'No logic problems found in this matchup.';
  return `<section class="skeptic ${k.counts.high ? 'has-high' : ''}"><div class="k">Skeptic check</div>
    <p class="sk-head">${head}</p>
    ${main.length ? `<ul class="sk-list">${main.map((f) => `<li class="sk-${f.severity}">${esc(f.message)}</li>`).join('')}</ul>` : ''}
    ${k.counts.high ? '<p class="exp">Players with a likely logic error are excluded from the outlier pick.</p>' : ''}
    ${info.length ? `<details class="why"><summary>${info.length} explained / informational note${info.length > 1 ? 's' : ''}</summary><ul class="sk-list">${info.map((f) => `<li>${esc(f.message)}</li>`).join('')}</ul></details>` : ''}
  </section>`;
}

const STANCE = { for: 'Supports', against: 'Against', info: '' };
function whyList(items) {
  return `<ul class="whylist">${items.map((w) => (typeof w === 'string' ? { text: w, stance: 'info' } : w)).map((w) => `<li class="st-${w.stance}">${w.stance !== 'info' ? `<b class="stance">${STANCE[w.stance]}</b> ` : ''}${esc(w.text)}</li>`).join('')}</ul>`;
}
function outliersBlock(m) {
  const o = m.outlier;
  if (!o || (!o.outliers?.length && !o.leans?.length)) return `<section class="outliers"><div class="k">Outliers · model vs book line</div><p class="faint">No player's projection differs from his line by a significant amount for that stat.</p></section>`;
  const row = (c) => `<details class="orow"><summary><span class="dir ${c.gapDir === 'OVER' ? 'over' : 'under'}">${c.gapDir}</span> <b>${esc(c.name)}</b> <span class="faint">${esc(c.team)} ${esc(c.pos)}</span> · ${esc(c.label)} · line <b class="b">${c.line}</b> · model <b class="m">${f1(c.proj)}</b> · gap ${sgn(Math.round(c.gap * 10) / 10)} <span class="faint">(${f2(c.sigStrength)}× the ${f1(c.sigThreshold)} bar${c.tierRecord ? ` · gaps this size: ${pct(c.tierRecord[1])} of ${c.tierRecord[0]}` : ''})</span></summary>${c.why?.length ? whyList(c.why) : ''}</details>`;
  return `<section class="outliers"><div class="k">Outliers · model vs book line, biggest first</div>
    <p class="exp">A gap counts as an outlier when it clears a per-stat bar: about 9 rushing or receiving yards (10–12% of the line), 20 passing yards, 1 reception, 2.5 carries. Honest record: in 2024–25, gaps of every size won about 50% against the line (UNDERs 52%, OVERs 46–50%). The backtested pick above has the better record.</p>
    ${o.outliers.map(row).join('') || '<p class="faint">No full outliers this game.</p>'}
    ${o.leans?.length ? `<h5 class="leanh">Leans (0.6–1× the bar)</h5>${o.leans.map(row).join('')}` : ''}
  </section>`;
}

function outlierBlock(m) {
  const o = m.outlier;
  if (!o) return '';
  const p = o.pick;
  const sideVar = (team) => (team === m.away.abbr ? 'var(--away)' : 'var(--home)');
  const shortlist = o.shortlist?.length ? `<details class="why"><summary>Ranked candidates (${o.counted.eligible} eligible of ${o.counted.withLines} with posted lines)</summary>
      <div class="scroll"><table class="mini"><thead><tr><th>Player</th><th>Stat</th><th>Side</th><th>Proj</th><th>Line</th><th>Gap</th><th>z</th><th>Adj.</th><th>Model P(side)</th><th>Status</th></tr></thead><tbody>
      ${o.shortlist.map((c) => `<tr><td>${esc(c.name)} <span class="faint">${esc(c.team)}</span></td><td>${esc(c.short)}</td><td>${c.direction}</td><td class="m">${f1(c.proj)}</td><td class="b">${c.line}</td><td>${sgn(Math.round(c.gap * 10) / 10)} (${sgn(Math.round(c.gapPct * 100))}%)</td><td>${f2(c.z)}</td><td>${f2(c.score)}</td><td>${pct(c.sideProb)}</td><td>${c.qualifies ? 'qualifies' : esc(c.reason || '')}</td></tr>`).join('')}
      </tbody></table></div></details>` : '';
  const conflicts = o.roleConflicts?.length ? `<p class="conflict">Role conflict${o.roleConflicts.length > 1 ? 's' : ''} to verify (excluded from picks): ${[...new Map(o.roleConflicts.map((r) => [r.playerId, r])).values()].map((r) => `${esc(r.name)} (${esc(r.team)} ${esc(r.pos)}) has book lines, e.g. ${esc(r.label)} ${r.line}, but the model gives him no role for it — check depth chart / injury news.`).join(' ')}</p>` : '';
  if (!p) return `<section class="outlier none"><div class="k">Outlier pick</div><p>No pick. ${esc(o.noPickReason || '')}</p>${conflicts}${shortlist}<p class="exp">experimental · uncalibrated · a gap is disagreement with the book, not evidence the book is wrong</p></section>`;
  const gap = Math.round(p.gap * 10) / 10;
  return `<section class="outlier" style="--tc:${sideVar(p.team)}">
    <div class="k">Backtested pick · a line likely to miss big</div>
    <div class="ohead"><span class="dir ${p.direction === 'OVER' ? 'over' : 'under'}">${p.direction}</span>
      <span class="who">${esc(p.name)} <span class="faint">${esc(p.team)} ${esc(p.pos)}</span></span>
      <span class="what">${esc(p.label)} ${p.direction === 'OVER' ? '&gt;' : '&lt;'} <b class="b">${p.line}</b></span></div>
    <dl class="ostats">
      <div><dt>Book line</dt><dd class="b">${p.line}</dd></div>
      <div><dt>Model projection</dt><dd class="m">${f1(p.proj)}</dd></div>
      <div><dt>Gap</dt><dd>${sgn(gap)} (${sgn(Math.round(p.gapPct * 100))}%)</dd></div>
      <div><dt>Model 10–90 range</dt><dd>${f1(p.p10)}–${f1(p.p90)}</dd></div>
      <div><dt>Chance of a big miss our way</dt><dd>${pct(p.bigProb)} <span class="faint">(${esc(p.bigText)}; usually ${pct(p.baseProb)})</span></dd></div>
      <div><dt>Chance of a big miss the other way</dt><dd>${pct(p.againstProb)}</dd></div>
      <div><dt>Model P(${p.direction.toLowerCase()})</dt><dd>${pct(p.sideProb)} · fair ${am(p.direction === 'OVER' ? p.fairOdds?.over : p.fairOdds?.under)}</dd></div>
    </dl>
    <p class="fresh">Line: ${esc(p.lineSource || 'book')} · line updated ${etStamp(p.lineUpdated)} · retrieved ${etStamp(p.retrievedAt)} · price ${p.overPrice != null ? `O ${am(p.overPrice)} / U ${am(p.underPrice)}` : 'not in feed'}${p.mode !== 'pregame' ? ' · <b>retrospective (closing line)</b>' : ''}</p>
    ${p.why?.length ? `<div class="owhy"><h5>Why</h5>${whyList(p.why)}</div>` : ''}
    <div class="ocols"><div><h5>Evidence</h5><ul>${p.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>
      <div><h5>Uncertainty</h5><ul>${(p.flags.length ? p.flags : ['no quality flags raised']).map((f) => `<li>${esc(f)}</li>`).join('')}<li>Model probabilities are uncalibrated simulation outputs; held-out backtests showed overconfidence at the extremes.</li></ul></div></div>
    <details class="why"><summary>Model reasoning for this stat</summary><p>${esc(p.explain || '')}</p></details>
    ${conflicts}${shortlist}
    <p class="exp">experimental · out of sample (2024↔2025) picks made this way won 55% of the time against the line (break-even ≈ 52%) — suggestive, not proven; big misses also go the other way</p>
  </section>`;
}

function card(m, c, highlight) {
  const key = state.sel[c.id] || c.primary;
  const s = c.stats[key];
  const inj = c.injury ? `<span class="tag ${/out|doubt/i.test(c.injury.status) ? 'bad' : 'warn'}">${esc(c.injury.status)}${c.injury.type ? ` · ${esc(c.injury.type)}` : ''}</span>` : '';
  return `<article class="card ${highlight ? 'hl' : ''}" data-id="${esc(c.id)}" data-team="${esc(c.team)}">
    <div class="top"><span class="name">${esc(c.name)}</span><span class="role">${esc(c.pos)} · ${esc(c.role)}${c.jersey ? ` · #${esc(c.jersey)}` : ''}</span>
      <span class="tags">${inj}${c.extraReason ? `<span class="tag model">${esc(c.extraReason)}</span>` : ''}${c.actual?.dnp ? '<span class="tag">did not record a stat</span>' : ''}</span></div>
    <div class="statsel" role="tablist">${c.compact.map((k) => `<button data-stat="${k}" class="${k === key ? 'on' : ''}">${esc(c.stats[k].short)}</button>`).join('')}</div>
    <div class="body">${cardBody(m, c, key)}</div>
    <details class="more"><summary>Details — all stats, opportunity vs efficiency, scripts, with/without</summary>${details(m, c, key)}</details>
  </article>`;
}

function cardBody(m, c, key) {
  const s = c.stats[key];
  if (!s || !s.available) return `<p class="muted">Not modelled.</p>`;
  const actual = c.actual && !c.actual.dnp ? actualOf(c.actual, key) : null;
  const hit = actual != null && s.p10 != null ? (actual >= s.p10 && actual <= s.p90 ? 'hit' : 'miss') : '';
  const bk = s.book;
  return `<div class="core">
    <div class="proj">
      <div class="big">${f1(s.proj)}</div>
      <div class="rng">range ${f1(s.p10)}–${f1(s.p90)} · median ${f1(s.p50)}</div>
      <dl>
        <dt>Season avg</dt><dd>${f1(s.seasonAvg)} <span class="faint">(${s.seasonGames}g)</span></dd>
        <dt>Book line</dt><dd class="book">${bk ? `${bk.line}` : '<span class="faint">none</span>'}</dd>
        <dt>Book price</dt><dd class="book">${bk?.overPrice != null ? `O ${am(bk.overPrice)} / U ${am(bk.underPrice)}` : bk ? '<span class="faint" title="The free ESPN feed publishes lines without prices">n/a</span>' : '—'}</dd>
        ${actual != null ? `<dt>Actual</dt><dd class="actual ${hit}">${f1(actual)}</dd>` : ''}
      </dl>
      ${s.probOver != null ? `<div class="prob">Model P(&gt; ${s.threshold}) <span class="p">${pct(s.probOver)}</span> · fair ${am(s.fairOdds?.over)}<br><span class="faint">threshold = ${esc(s.thresholdSource)}</span>${bk?.implied?.noVigOver != null ? `<br>Book no-vig P(over) ${pct(bk.implied.noVigOver)}` : ''}<br><span class="exp">experimental · uncalibrated</span></div>` : ''}
    </div>
    <div class="chart">${last5Chart(s)}</div>
  </div>
  ${s.explain ? `<details class="why"><summary>Why this projection</summary><div class="expl">${esc(s.explain)}</div></details>` : ''}
  ${c.notes?.length ? `<ul class="notes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
}

function actualOf(a, k) {
  if (k === 'ypc') return a.carries ? a.rush_yds / a.carries : null;
  if (k === 'ypr') return a.receptions ? a.rec_yds / a.receptions : null;
  if (k === 'tds') return (a.rush_td || 0) + (a.rec_td || 0);
  return a[k] ?? 0;
}

function last5Chart(s) {
  const games = s.last5 || [];
  const W = 340, Hh = 150, top = 18, bottom = 34, left = 4;
  const n = games.length + 1;
  const bw = (W - left) / n;
  const vals = games.map((g) => g.value ?? 0);
  const maxV = Math.max(1, ...vals, s.p90 ?? 0, s.book?.line ?? 0) * 1.08;
  const y = (v) => top + (Hh - top - bottom) * (1 - v / maxV);
  const base = y(0);
  let svg = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Last ${games.length} games, ${esc(s.label)}">`;
  svg += `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--rule-2)"/>`;
  games.forEach((g, i) => {
    const x = left + i * bw + bw * 0.18, w = bw * 0.64;
    const v = g.value;
    const prev = g.season !== games[games.length - 1]?.season;
    if (v != null) svg += `<rect x="${x}" y="${Math.min(y(v), base - 1)}" width="${w}" height="${Math.max(1, base - y(v))}" fill="${prev ? 'none' : 'var(--tc, var(--muted))'}" stroke="${prev ? 'var(--tc, var(--faint))' : 'none'}" stroke-dasharray="${prev ? '3 2' : ''}" opacity="${prev ? .7 : .8}"><title>${prev ? 'Prior season' : 'This season'}</title></rect>`;
    svg += `<text class="val" x="${x + w / 2}" y="${(v != null ? y(v) : base) - 4}" text-anchor="middle">${v == null ? '—' : f1(v)}</text>`;
    svg += `<text class="opp" x="${x + w / 2}" y="${base + 13}" text-anchor="middle">${esc(g.atVs === '@' ? '@' : '')}${esc(g.opp || '?')}</text>`;
    svg += `<text x="${x + w / 2}" y="${base + 25}" text-anchor="middle">${prev ? `'${String(g.season).slice(2)}` : ET(g.date, { month: 'numeric', day: 'numeric' })}</text>`;
  });
  // Projection column with 10–90 whisker
  const i = games.length, x = left + i * bw + bw * 0.18, w = bw * 0.64, cx = x + w / 2;
  if (s.proj != null) {
    svg += `<line x1="${cx}" x2="${cx}" y1="${y(s.p90)}" y2="${y(s.p10)}" stroke="var(--model)" stroke-width="1.5"/>`;
    svg += `<line x1="${cx - 6}" x2="${cx + 6}" y1="${y(s.p90)}" y2="${y(s.p90)}" stroke="var(--model)"/><line x1="${cx - 6}" x2="${cx + 6}" y1="${y(s.p10)}" y2="${y(s.p10)}" stroke="var(--model)"/>`;
    svg += `<rect x="${x + w * 0.2}" y="${y(s.proj) - 2}" width="${w * 0.6}" height="4" fill="var(--model)"/>`;
    svg += `<text class="val" x="${cx}" y="${y(s.p90) - 5}" text-anchor="middle" style="fill:var(--model)">${f1(s.proj)}</text>`;
    svg += `<text class="opp" x="${cx}" y="${base + 13}" text-anchor="middle" style="fill:var(--model)">PROJ</text>`;
  }
  if (s.book?.line != null) {
    svg += `<line x1="0" x2="${W}" y1="${y(s.book.line)}" y2="${y(s.book.line)}" stroke="var(--book)" stroke-dasharray="4 3"/>`;
    svg += `<text x="2" y="${y(s.book.line) - 3}" text-anchor="start" class="halo" style="fill:var(--book)">line ${s.book.line}</text>`;
  }
  if (!games.length) svg += `<text x="${W / 2}" y="${Hh / 2}" text-anchor="middle">No prior games in feed</text>`;
  return svg + '</svg>';
}

function details(m, c, key) {
  const rows = c.statOrder.map((k) => {
    const s = c.stats[k];
    const a = c.actual && !c.actual.dnp ? actualOf(c.actual, k) : null;
    return `<tr class="${k === key ? 'sel' : ''}"><td>${esc(s.label)}</td><td class="m">${f1(s.proj)}</td><td>${f1(s.p10)}–${f1(s.p90)}</td><td>${f1(s.seasonAvg)}</td><td class="b">${s.book ? s.book.line : '—'}</td><td>${s.probOver != null ? `${pct(s.probOver)} @${s.threshold}` : '—'}</td><td>${s.fairOdds ? am(s.fairOdds.over) : '—'}</td>${c.actual ? `<td>${a == null ? '—' : f1(a)}</td>` : ''}</tr>`;
  }).join('');
  const op = c.opportunity || {};
  const ef = c.efficiency;
  const bs = c.byScript ? Object.values(c.byScript) : [];
  const ww = c.withWithout || [];
  const st = c.shareTrend || [];
  const sn = c.snapTrend;
  return `<div class="detail">
    <div class="scroll"><table class="mini"><thead><tr><th>Stat</th><th>Proj</th><th>10–90</th><th>Avg</th><th>Line</th><th>Model P(over)</th><th>Fair</th>${c.actual ? '<th>Actual</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
    <p class="exp" style="margin:4px 0 0">Model probabilities are experimental simulation outputs — not calibrated. Fair odds are the model's no-margin price, distinct from book odds.</p></div>
    ${ef ? `<div><h5>Opportunity vs efficiency</h5><table class="mini"><tbody>
      <tr><td>Carries · share</td><td>${f1(op.carries)}</td><td>${pct(op.carryShare, 1)}</td></tr>
      <tr><td>Targets · share</td><td>${f1(op.targets)}</td><td>${pct(op.targetShare, 1)}</td></tr>
      ${op.dropbacks != null ? `<tr><td>Pass attempts</td><td>${f1(op.dropbacks)}</td><td>team pass rate ${pct(op.teamPassRate)}</td></tr>` : ''}
      <tr><td>Yards / carry</td><td>${f2(ef.ypc.final)}</td><td>player ${f2(ef.ypc.player)} (n=${ef.ypc.sample}) · opp ×${f2(ef.ypc.oppMult)}</td></tr>
      <tr><td>Catch rate</td><td>${pct(ef.catchRate.final)}</td><td>player ${pct(ef.catchRate.player)} (n=${ef.catchRate.sample}) · opp ×${f2(ef.catchRate.oppMult)}</td></tr>
      <tr><td>Yards / catch</td><td>${f1(ef.ypCatch.final)}</td><td>player ${f1(ef.ypCatch.player)} (n=${ef.ypCatch.sample}) · opp ×${f2(ef.ypCatch.oppMult)}</td></tr>
      <tr><td>Explosive run 10+/20+</td><td>${pct(ef.explosive.run10, 1)} / ${pct(ef.explosive.run20, 1)}</td><td>opp allowed ×${f2(ef.explosive.oppRun10Mult)} / ×${f2(ef.explosive.oppRun20Mult)}</td></tr>
      <tr><td>Explosive catch 20+/40+</td><td>${pct(ef.explosive.catch20, 1)} / ${pct(ef.explosive.catch40, 1)}</td><td>opp allowed ×${f2(ef.explosive.oppCatch20Mult)} / ×${f2(ef.explosive.oppCatch40Mult)}</td></tr>
    </tbody></table></div>` : c.pos === 'K' ? `<div><h5>Inputs</h5><p class="muted" style="font-size:12px">${f2(op.fgPerGame)} FG/game expected · XP rate ${pct(op.xpRate)} · implied team points ${f1(op.impliedPts)}</p></div>` : ''}
    ${bs.length ? `<div><h5>By game script (simulated means)</h5><table class="mini"><thead><tr><th>Script</th><th>Freq</th><th>Carries</th><th>Targets</th><th>Rush yds</th><th>Rec yds</th></tr></thead><tbody>${bs.map((b) => `<tr><td>${esc(b.label)}</td><td>${pct(b.share)}</td><td>${f1(b.carries)}</td><td>${f1(b.targets)}</td><td>${f1(b.rush_yds)}</td><td>${f1(b.rec_yds)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${ww.length ? `<div><h5>With / without teammates (this season)</h5><table class="mini"><thead><tr><th>Teammate</th><th>This week</th><th>With: n · ${esc(c.stats[c.primary]?.short)} · car% · tgt%</th><th>Without</th></tr></thead><tbody>${ww.map((w) => `<tr><td>${esc(w.teammate)}</td><td>${w.isOut ? '<span class="tag bad">out</span>' : esc(w.statusThisWeek)}</td><td>${sp(w.with)}</td><td>${w.without.n ? sp(w.without) : '<span class="faint">no games yet</span>'}</td></tr>`).join('')}</tbody></table><p class="faint" style="font-size:11px;margin:4px 0 0">"With" = teammate appeared in the box score. Small samples — descriptive only.</p></div>` : ''}
    ${st.length ? `<div><h5>Usage share trend</h5><table class="mini"><thead><tr><th>Game</th>${st.map((x) => `<th>${esc(x.opp)}</th>`).join('')}</tr></thead><tbody>
      <tr><td>Carry share</td>${st.map((x) => `<td>${pct(x.carry)}</td>`).join('')}</tr>
      <tr><td>Target share</td>${st.map((x) => `<td>${pct(x.target)}</td>`).join('')}</tr>
      ${sn ? `<tr><td>Snap share</td>${st.map((x) => { const z = sn.find((q) => q.week === x.week); return `<td>${z ? pct(z.pct) : '—'}</td>`; }).join('')}</tr>` : ''}
    </tbody></table><p class="faint" style="font-size:11px;margin:4px 0 0">${sn ? 'Snap share: nflverse (PFR snap counts).' : m.league === 'cfb' ? 'Snap counts unavailable for college.' : 'Snap counts unavailable.'}</p></div>` : ''}
  </div>`;
}
const sp = (x) => (x.n ? `${x.n} · ${f1(x.primary)} · ${pct(x.carryShare)} · ${pct(x.targetShare)}` : '—');

function kicker(m, c) {
  const s = c.stats;
  const a = c.actual && !c.actual.dnp ? c.actual : null;
  return `<div class="kick"><span class="name">${esc(c.name)}</span><span class="muted">K</span>
    ${['k_pts', 'fg_made', 'xp_made'].map((k) => `<span>${esc(s[k].short)} <span class="v">${f1(s[k].proj)}</span> <span class="faint">${f1(s[k].p10)}–${f1(s[k].p90)} · avg ${f1(s[k].seasonAvg)}${a ? ` · actual ${f1(a[k] ?? 0)}` : ''}</span></span>`).join('')}
    ${c.injury ? `<span class="tag warn">${esc(c.injury.status)}</span>` : ''}</div>`;
}

function gradesBlock(m) {
  const G = m.lineGrades;
  if (!G) return '';
  const A = m.away, H = m.home;
  const fmtRate = (metric, v) => (v == null ? '—' : metric === 'runYpc' ? f2(v) : pct(v, 1));
  const row = (g) => {
    if (!g) return '';
    const sc = g.score;
    return `<div class="grow"><div class="gl">${esc(g.label)}</div>
      <div class="gbar" role="img" aria-label="${esc(g.label)} ${sc == null ? 'unavailable' : `${sc} of 100`}"><span style="width:${sc ?? 0}%"></span><i></i></div>
      <div class="gv">${sc == null ? '<span class="faint">unavailable</span>' : `<b>${sc}</b> <span class="gletter">${g.letter}</span>`}</div>
      <div class="gc">${g.confidence ? `<span class="tag ${g.confidence === 'low' ? 'warn' : ''}">${g.confidence}${g.sample != null && Number.isFinite(g.sample) ? ` · n=${g.sample}` : ''}</span>` : ''}</div></div>`;
  };
  const inputs = (g) => g?.inputs?.length ? g.inputs.map((i) => `<tr><td>${esc(g.label)}: ${esc(i.label)}</td><td>${i.unavailable ? 'unavailable' : fmtRate(i.metric, i.raw)}</td><td>${fmtRate(i.metric, i.shrunk)}</td><td>${fmtRate(i.metric, i.baseline)}</td><td>${i.n ?? 0}</td><td>${i.z == null ? '—' : f2(i.z)}</td></tr>`).join('') : '';
  const col = (t, g, side) => `<div class="gcol ${side}"><div class="teamhead ${side}">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : ''}<div><div class="tn">${esc(t.abbr)} lines</div><div class="ti">${g.games} games before kickoff</div></div></div>
    <h5>Offensive line (unit estimate)</h5>${row(g.olRun)}${row(g.olPass)}${row(g.ol)}
    <h5>Defensive front (unit estimate)</h5>${row(g.dlRun)}${row(g.dlPass)}${row(g.dl)}
    <details class="why"><summary>Inputs (raw → shrunk vs baseline)</summary><div class="scroll"><table class="mini"><thead><tr><th>Input</th><th>Raw</th><th>Shrunk</th><th>Baseline</th><th>n</th><th>z (good+)</th></tr></thead><tbody>${[g.olRun, g.olPass, g.dlRun, g.dlPass].map(inputs).join('')}</tbody></table></div></details></div>`;
  const edge = (label, off, def, oAbbr, dAbbr) => {
    if (off?.score == null || def?.score == null) return `<li>${esc(label)}: unavailable</li>`;
    const d = off.score - def.score;
    return `<li>${esc(label)}: <b>${esc(oAbbr)}</b> ${off.score} vs <b>${esc(dAbbr)}</b> ${def.score} → ${Math.abs(d) < 8 ? 'no clear edge' : `edge ${d > 0 ? esc(oAbbr) + ' offense' : esc(dAbbr) + ' defense'} (${d > 0 ? '+' : ''}${d})`}</li>`;
  };
  return `<h2 class="sec">Estimated OL / DL unit grades</h2>
  <p class="muted" style="font-size:12px;margin-top:-4px">Team-unit estimates from play-by-play proxies — <b>not</b> grades of individual linemen, and not free of QB, running-back, scheme and opponent effects. 50 = ${G.baseline.measured ? 'measured league-average unit' : 'prior baseline (not a measured league average)'}; higher is always better for the unit graded. No percentile or rank is implied.</p>
  <div class="gpair">${col(A, G.away, 'away')}${col(H, G.home, 'home')}</div>
  <ul class="edges">
    ${edge(`${A.abbr} run game`, G.away.olRun, G.home.dlRun, A.abbr, H.abbr)}
    ${edge(`${A.abbr} pass protection`, G.away.olPass, G.home.dlPass, A.abbr, H.abbr)}
    ${edge(`${H.abbr} run game`, G.home.olRun, G.away.dlRun, H.abbr, A.abbr)}
    ${edge(`${H.abbr} pass protection`, G.home.olPass, G.away.dlPass, H.abbr, A.abbr)}
  </ul>
  <details class="why"><summary>Grading method &amp; baseline</summary><ul class="disc">${G.method.map((x) => `<li>${esc(x)}</li>`).join('')}<li>Baseline: ${esc(G.baseline.source)}.</li><li>Grades are descriptive context; the projection model uses its own opponent adjustments (run yards allowed, sack rates) and does not read these grades.</li></ul></details>`;
}

function contextBlock(m) {
  const A = m.away, H = m.home;
  const r = (label, fa, fh, note = '') => `<tr><td>${label}${note ? ` <small>${note}</small>` : ''}</td><td>${fa(A)}</td><td>${fh(H)}</td></tr>`;
  const o = (t) => t.context.offense, d = (t) => t.context.defense;
  const n = (v, cnt) => `${v}<small>n=${cnt ?? 0}</small>`;
  const both = (fn) => [fn, fn];
  const row = (label, fn, note) => r(label, ...both(fn), note);
  const lp = m.lineProxy || {};
  return `<h2 class="sec">Team context · games before kickoff only</h2>
  <div class="scroll"><table class="ctx"><thead><tr><th>Metric</th><th>${esc(A.abbr)}</th><th>${esc(H.abbr)}</th></tr></thead><tbody>
    ${row('Games in sample', (t) => t.context.games)}
    ${row('Offensive plays / game', (t) => f1(o(t).playsPerGame), 'pace')}
    ${row('Early-down neutral pass rate', (t) => n(pct(o(t).earlyDownNeutralPassRate), o(t).earlyDownN), 'down/distance tendency')}
    ${row('Pass rate trailing / close / leading', (t) => `${pct(o(t).passRates.trail.raw)} / ${pct(o(t).passRates.close.raw)} / ${pct(o(t).passRates.lead.raw)}`, 'raw')}
    ${row('Offense rush success rate', (t) => n(pct(o(t).rushSuccess), o(t).rushSuccessN), 'run-blocking proxy')}
    ${row('Offense sack rate', (t) => n(pct(o(t).sackRate, 1), o(t).dropbacks), 'pass-pro proxy')}
    ${row('Defense rush success allowed', (t) => n(pct(d(t).rushSuccessAllowed), d(t).rushSuccessN), 'run-D proxy')}
    ${row('Defense sack rate', (t) => n(pct(d(t).sackRate, 1), d(t).dropbacksFaced), 'pass-rush proxy')}
    ${row('RB yds/carry allowed', (t) => n(f2(d(t).rbYpcAllowed), d(t).rbRuns))}
    ${row('RB runs allowed 10+ / 20+', (t) => n(`${pct(d(t).explosiveRates.rbRun10.raw, 1)} / ${pct(d(t).explosiveRates.rbRun20.raw, 1)}`, d(t).explosiveRates.rbRun10.n), 'raw; model shrinks')}
    ${row('QB runs allowed 10+ / 20+', (t) => n(`${pct(d(t).explosiveRates.qbRun10.raw, 1)} / ${pct(d(t).explosiveRates.qbRun20.raw, 1)}`, d(t).explosiveRates.qbRun10.n))}
    ${row('Passes allowed 20+ / 40+ (per att)', (t) => n(`${pct(d(t).explosiveRates.pass20.raw, 1)} / ${pct(d(t).explosiveRates.pass40.raw, 1)}`, d(t).explosiveRates.pass20.n))}
    ${['RB', 'WR', 'TE'].map((p) => row(`${p} catches allowed 20+ / 40+`, (t) => n(`${pct(d(t).explosiveRates.catch20[p].raw, 1)} / ${pct(d(t).explosiveRates.catch40[p].raw, 1)}`, d(t).explosiveRates.catch20[p].n), 'per reception')).join('')}
    ${row('Play-attribution coverage', (t) => pct(d(t).explosiveRates.attribution), 'plays mapped to a player')}
    ${m.league === 'cfb' ? row('CFBD line yards off / def', (t) => (lp[t.id]?.enabled ? (lp[t.id].offense ? `${f2(lp[t.id].offense.lineYards)} / ${f2(lp[t.id].defense.lineYards)}` : esc(lp[t.id].error || '—')) : '<span class="faint">set CFBD_API_KEY</span>')) : ''}
  </tbody></table></div>
  <p class="faint" style="font-size:12px">OL/DL grades are not available from any free public source; the "proxy" rows are unit-level rates computed from ESPN play-by-play (success = 40%/60%/100% of distance on 1st/2nd/3rd–4th down). They reflect offense + scheme + opponents, not linemen alone.</p>`;
}

function setCardStat(el, stat) {
  const id = el.dataset.id;
  const c = [...state.matchup.away.cards, ...state.matchup.home.cards].find((x) => String(x.id) === id);
  if (!c || !c.stats[stat]) return;
  state.sel[id] = stat;
  el.querySelectorAll('.statsel button').forEach((x) => x.classList.toggle('on', x.dataset.stat === stat));
  el.querySelector('.body').innerHTML = cardBody(state.matchup, c, stat);
  const d = el.querySelector('details.more');
  const open = d.open;
  d.outerHTML = `<details class="more" ${open ? 'open' : ''}><summary>Details — all stats, opportunity vs efficiency, scripts, with/without</summary>${details(state.matchup, c, stat)}</details>`;
}

// Selecting a stat also switches the opposing player in the same role row (if he has that stat),
// so corresponding players stay directly comparable.
function wireCards() {
  document.querySelectorAll('.card').forEach((el) => {
    el.querySelectorAll('.statsel button').forEach((b) => b.addEventListener('click', () => {
      const pair = el.closest('.pair');
      const targets = pair ? [...pair.querySelectorAll('.card')] : [el];
      for (const t of targets) if (t === el || t.querySelector(`.statsel button[data-stat="${b.dataset.stat}"]`)) setCardStat(t, b.dataset.stat);
    }));
  });
}

// ---------------- Ledger ----------------
async function renderLedger() {
  const my = state.routeSeq;
  loading('Loading ledger…');
  await loadStatus();
  if (my !== state.routeSeq) return;
  const model = state.ledgerModel || state.status?.modelVersion || '';
  let L;
  try { L = await api(`/api/ledger?kind=${state.ledgerKind}&model=${encodeURIComponent(model)}`); } catch (e) { if (my === state.routeSeq) fail(e); return; }
  if (my !== state.routeSeq) return;
  setTitle('Ledger');
  const s = L.summary, o = s.overall || {};
  const versions = [...new Set([state.status?.modelVersion, ...L.versions.map((v) => v.model_version)].filter(Boolean))];
  const inSampleAll = s.groups.length && s.groups.every((g) => g.inSample);
  app.innerHTML = `
    <div class="slate-head"><h1>Prediction ledger</h1><span class="muted">Append-only SQLite · ${esc(state.status?.db || '')} · runs and snapshots cannot be edited or deleted (database triggers)</span></div>
    <div class="controls">
      <select id="lk"><option value="pregame" ${state.ledgerKind === 'pregame' ? 'selected' : ''}>Pregame snapshots (true forecasts)</option><option value="backtest" ${state.ledgerKind === 'backtest' ? 'selected' : ''}>Backtests (rebuilt after the fact)</option></select>
      <select id="lm">${versions.map((v) => `<option ${v === model ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <span class="muted">·</span>
      <button class="btn primary" id="snapnfl">Snapshot NFL week</button>
      <button class="btn" id="snapcfb">Snapshot college week</button>
      <button class="btn" id="settle">Settle finished games (${L.pending} pending)</button>
      <span class="muted">Backtest</span><select id="btl"><option value="nfl">NFL</option><option value="cfb">College</option></select><input id="btw" type="number" min="1" max="18" placeholder="wk"><button class="btn" id="btgo">Run</button>
    </div>
    <div id="job"></div>
    ${state.ledgerKind === 'backtest' ? `<div class="banner">Backtests are rebuilt after the games using only data from before each kickoff, but lines are closing lines and injuries/depth charts are not reconstructed. They are stored separately from pregame snapshots and are never mixed into pregame accuracy.${L.devWeeks?.length ? ` <b>In-sample for ${esc(model)}: ${esc(L.devWeeks.join('; '))}</b> — these weeks were inspected while tuning this model version, so they are development results, not independent validation.` : ''}</div>` : ''}
    ${inSampleAll ? '<div class="banner">Every week shown is in-sample (development) for this model version.</div>' : ''}
    <section class="tiles">
      <div><div class="k">Scored projections</div><div class="v">${o.n || 0}</div><div class="s">${s.dnp} with no box-score row excluded (participation unverified)</div></div>
      <div><div class="k">MAE (all stats)</div><div class="v">${f2(o.mae)}</div><div class="s">mixed units — see table</div></div>
      <div><div class="k">Bias (proj − actual)</div><div class="v">${f2(o.bias)}</div><div class="s">+ = over-projected</div></div>
      <div><div class="k">10–90 coverage</div><div class="v">${pct(o.coverage)}</div><div class="s">nominal 80%</div></div>
      <div><div class="k">Brier (P over)</div><div class="v">${f2(o.brier)}</div><div class="s">n=${o.brierN || 0} · 0.25 = coin flip</div></div>
      <div><div class="k">Runs</div><div class="v">${L.runs.length}</div><div class="s">${L.counts.map((c) => `${c.kind} ${c.games}g`).join(' · ') || 'none yet'}</div></div>
    </section>
    <p class="muted" style="font-size:12px">Tiles above pool every week shown${L.devWeeks?.length ? ', including in-sample (development) weeks' : ''}. <b>Held-out only</b> (weeks not inspected while tuning ${esc(model)}): n=${s.heldOut?.n || 0} · MAE ${f2(s.heldOut?.mae)} · bias ${f2(s.heldOut?.bias)} · 10–90 coverage ${pct(s.heldOut?.coverage)} · Brier ${f2(s.heldOut?.brier)}. MAE mixes stat units; compare within a stat in the table.</p>
    <h2 class="sec">Probability reliability · experimental</h2>
    <p class="muted" style="font-size:12px;margin-top:-4px">Predicted P(over threshold) bucket vs realized frequency. Small buckets are noise; this is not a calibration claim.</p>
    <div class="scroll"><table class="ctx"><thead><tr><th>Bucket</th><th>n</th><th>Mean predicted</th><th>Realized</th></tr></thead><tbody>${s.calibration.map((c) => `<tr><td>${pct(c.lo)}–${pct(c.hi)}</td><td>${c.n}</td><td>${pct(c.meanPred)}</td><td>${pct(c.realized)}${c.n < 50 ? '<small>small n</small>' : ''}</td></tr>`).join('')}</tbody></table></div>
    <h2 class="sec">Accuracy by week · position · stat</h2>
    <div class="scroll"><table class="ctx"><thead><tr><th>Week</th><th>Pos</th><th>Stat</th><th>n</th><th>MAE</th><th>Bias</th><th>Coverage</th><th>Brier</th></tr></thead><tbody>
      ${s.groups.map((g) => `<tr><td>${esc(g.league.toUpperCase())} ${g.week}${g.inSample ? ' <small>in-sample</small>' : ''}</td><td>${esc(g.position)}</td><td>${esc(g.stat)}</td><td>${g.n}</td><td>${f2(g.mae)}</td><td>${f2(g.bias)}</td><td>${pct(g.coverage)}</td><td>${f2(g.brier)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No settled snapshots yet. Record snapshots before kickoff, then settle after the games.</td></tr>'}
    </tbody></table></div>
    <h2 class="sec">Largest misses (outside the 10–90 range)</h2>
    ${L.misses.length ? `<div class="scroll"><table class="ctx"><thead><tr><th>Player</th><th>Stat</th><th>Proj (10–90)</th><th>Actual</th><th style="text-align:left">Descriptive explanation</th></tr></thead><tbody>${L.misses.map((x) => `<tr><td>${esc(x.player)} <small>${esc(x.team)} wk${x.week}</small></td><td>${esc(x.stat)}</td><td>${f1(x.projection)} (${f1(x.p10)}–${f1(x.p90)})</td><td>${f1(x.actual)}</td><td style="text-align:left;font-family:var(--font);color:var(--muted);white-space:normal">${esc(x.why)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None yet.</p>'}
    <h2 class="sec">Recent runs</h2>
    <div class="scroll"><table class="ctx"><thead><tr><th>Run</th><th>Kind</th><th>Game</th><th>Model</th><th>Created</th><th>Kickoff</th><th>Rows</th></tr></thead><tbody>${L.runs.slice(0, 60).map((r) => `<tr><td>#${r.id}</td><td>${esc(r.kind)}</td><td>${esc(r.league.toUpperCase())} wk${r.week} ${esc(r.away)} @ ${esc(r.home)}</td><td>${esc(r.model_version)}</td><td>${etStamp(r.created_at)}</td><td>${etStamp(r.kickoff)}</td><td>${r.rows}</td></tr>`).join('')}</tbody></table></div>`;
  app.insertAdjacentHTML('beforeend', '<section id="blind"><h2 class="sec">Blind historical evaluation</h2><p class="muted">Loading…</p></section>');
  renderBlind(my);
  $('#lk').onchange = (e) => { state.ledgerKind = e.target.value; renderLedger(); };
  $('#lm').onchange = (e) => { state.ledgerModel = e.target.value; renderLedger(); };
  $('#snapnfl').onclick = () => job('/api/snapshot-slate?league=nfl');
  $('#snapcfb').onclick = () => job('/api/snapshot-slate?league=cfb');
  $('#settle').onclick = () => job('/api/settle');
  $('#btgo').onclick = () => { const w = $('#btw').value; if (w) job(`/api/backtest?league=${$('#btl').value}&week=${w}`); };
}

async function renderBlind(my) {
  let B;
  try { B = await api(`/api/blind${state.blindBatch ? `?batch=${state.blindBatch}` : ''}`); } catch (e) { return; }
  if (my !== state.routeSeq) return;
  const el = document.querySelector('#blind');
  if (!el) return;
  const R = B.report;
  const tbl = (head, rows) => `<div class="scroll"><table class="ctx"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const ou = (x) => (x ? `${x.wins}–${x.losses}–${x.pushes}${x.winRate != null ? ` (${pct(x.winRate)})` : ''}` : '—');
  const batchRows = B.batches.map((b) => `<tr><td>#${b.id}</td><td>${etStamp(b.created_at)}</td><td>${esc(b.model_version)}</td><td class="u">${esc(b.params_hash.slice(0, 12))}</td><td>${b.predicted}/${b.games}</td><td style="text-align:left;font-family:var(--font)">${esc(b.events || '')}</td></tr>`);
  const controls = `<div class="controls"><button class="btn" id="blindrun">Run blind evaluation over all completed games</button><span class="muted">CLI: <code>npm run blind</code> · takes several minutes · each run is a new immutable batch</span></div><div id="blindjob"></div>`;
  if (!R) { el.innerHTML = `<h2 class="sec">Blind historical evaluation</h2>${controls}<p class="muted">No scored batch yet.</p>`; wireBlindRun(); return; }
  const split = Object.entries(R.bySplit).map(([k, v]) => { const [lg, sp] = k.split(':'); return `<tr><td>${lg.toUpperCase()} ${sp === 'inspected' ? '<small>inspected before — NOT independent</small>' : '<small>untouched</small>'}</td><td>${esc(v.weeks.join(', '))}</td><td>${v.predictions}</td><td>${v.scored}</td><td>${v.noRecordedStats}</td><td>${v.unknown}</td><td>${f2(v.mae)}</td><td>${f2(v.rmse)}</td><td>${f2(v.bias)}</td><td>${pct(v.coverage)}</td></tr>`; });
  const keyStats = R.byStat.filter((x) => ['pass_yds', 'rush_yds', 'rec_yds', 'receptions', 'carries', 'targets', 'completions', 'pass_att', 'k_pts'].includes(x.stat) && x.n >= 10)
    .sort((a, b) => a.league.localeCompare(b.league) || a.position.localeCompare(b.position) || a.stat.localeCompare(b.stat))
    .map((x) => `<tr><td>${x.league.toUpperCase()} ${esc(x.position)}</td><td>${esc(x.stat)}</td><td>${x.n}</td><td>${f2(x.mae)}</td><td>${f2(x.rmse)}</td><td>${f2(x.bias)}</td><td>${pct(x.coverage)}</td><td>${x.untouched?.n ? `${x.untouched.n} · MAE ${f2(x.untouched.mae)} · cov ${pct(x.untouched.coverage)}` : '—'}</td></tr>`);
  const M = R.market;
  const groups = R.byGroup.filter((g) => g.n).map((g) => `<tr><td>${g.league.toUpperCase()} ${g.week}${g.inspected ? ' <small>inspected</small>' : ''}</td><td>${esc(g.position)}</td><td>${esc(g.stat)}</td><td>${g.predictions}</td><td>${g.n}</td><td>${g.noRecordedStats}</td><td>${f2(g.mae)}</td><td>${f2(g.rmse)}</td><td>${f2(g.bias)}</td><td>${pct(g.coverage)}</td></tr>`);
  el.innerHTML = `<h2 class="sec">Blind historical evaluation · batch #${R.batch.id} · market-blind</h2>
    <div class="banner"><b>What this is:</b> every completed game this season re-predicted using only games that finished before its kickoff — no spread/total/moneyline or props, no target-game data, no current rosters, injuries, depth charts or weather. Parameters frozen before predicting (hash ${esc(R.batch.params_hash.slice(0, 12))}; cutoff filter ${esc(R.cutoffFilter || '')}); predictions and input manifests were sealed before any result or line was fetched. <b>Not an archive:</b> ${esc(R.fidelity)}</div>
    ${controls}
    <div class="controls"><span class="muted">Batch</span><select id="blindbatch">${B.batches.filter((b) => /scored/.test(b.events || '')).map((b) => `<option value="${b.id}" ${b.id === R.batch.id ? 'selected' : ''}>#${b.id} · ${b.predicted}/${b.games} games · ${etStamp(b.created_at)}</option>`).join('')}</select></div>
    <section class="tiles">
      <div><div class="k">Games predicted</div><div class="v">${R.games.predicted}</div><div class="s">of ${R.games.total} completed · ${R.games.skipped} skipped</div></div>
      <div><div class="k">Predictions</div><div class="v">${R.counts.predictions}</div><div class="s">${R.counts.scored} scored · ${R.counts.noRecordedStats} no recorded stats · ${R.counts.unknown} unknown</div></div>
      <div><div class="k">10–90 coverage</div><div class="v">${pct(R.overall.coverage)}</div><div class="s">nominal 80%</div></div>
      <div><div class="k">Bias (all stats)</div><div class="v">${f2(R.overall.bias)}</div><div class="s">mixed units</div></div>
      <div><div class="k">Lines matched</div><div class="v">${M.coverage.predictionsWithLine}</div><div class="s">of ${M.coverage.predictions} predictions</div></div>
      <div><div class="k">Strict pregame odds</div><div class="v">0</div><div class="s">no archived evidence</div></div>
    </section>
    <p class="muted" style="font-size:12px">Prior-game cutoff filter for this batch: <b>${esc(R.cutoffFilter || '')}</b>. *No stats = player absent from the final box score: no recorded stats, participation unverified (not proven DNP); excluded from error metrics.</p>
    <h2 class="sec">Untouched vs previously inspected weeks</h2>
    ${tbl(['Set', 'Weeks', 'Pred', 'Scored', 'No stats*', 'Unknown', 'MAE', 'RMSE', 'Bias', 'Coverage'], split)}
    <h2 class="sec">Key stats (all weeks · untouched subset)</h2>
    ${tbl(['League/pos', 'Stat', 'n', 'MAE', 'RMSE', 'Bias', 'Coverage', 'Untouched only'], keyStats)}
    <h2 class="sec">Over/under vs historical lines · unverified reconstruction</h2>
    <p class="muted" style="font-size:12px">${esc(M.strictPregameVerified.note)} Records below compare the model's side (projection vs line) with the result; they are <b>excluded from strict market accuracy</b>. No ROI: no archived prices.</p>
    ${tbl(['Tier', 'W–L–P', 'No side', 'Note'], [
      `<tr><td>Strict archived pregame</td><td>—</td><td>—</td><td style="text-align:left;font-family:var(--font)">n = 0</td></tr>`,
      `<tr><td>Retained "current" line</td><td>${ou(M.reconstructedCurrent)}</td><td>${M.reconstructedCurrent.noSide}</td><td style="text-align:left;font-family:var(--font)">${esc(M.reconstructedCurrent.note)}</td></tr>`,
      `<tr><td>…feed timestamp before kickoff</td><td>${ou(M.reconstructedCurrentTimestampBeforeKickoff)}</td><td>${M.reconstructedCurrentTimestampBeforeKickoff.noSide}</td><td style="text-align:left;font-family:var(--font)">${esc(M.reconstructedCurrentTimestampBeforeKickoff.note)}${M.reconstructedCurrentTimestampBeforeKickoff.impossibleTimestampsExcluded != null ? ` ${M.reconstructedCurrentTimestampBeforeKickoff.impossibleTimestampsExcluded} impossible timestamps excluded.` : ''}</td></tr>`,
      `<tr><td>Retained opening line</td><td>${ou(M.reconstructedOpen)}</td><td>${M.reconstructedOpen.noSide}</td><td style="text-align:left;font-family:var(--font)">${esc(M.reconstructedOpen.note)}</td></tr>`,
    ])}
    <p class="muted" style="font-size:12px">Line coverage by league: ${M.coverage.perLeague.map((c) => `${esc(c.league.toUpperCase())} ${esc(c.status)}: ${c.games} games / ${c.lines ?? 0} lines`).join(' · ')}</p>
    <details class="why"><summary>Accuracy by week · position · stat (${groups.length} groups)</summary>${tbl(['Week', 'Pos', 'Stat', 'Pred', 'Scored', 'No stats*', 'MAE', 'RMSE', 'Bias', 'Coverage'], groups)}</details>
    <details class="why"><summary>Skipped games (${R.skipped.length}) — ${esc(Object.entries(R.skipReasons).map(([k, v]) => `${v}× ${k}`).join('; '))}</summary>${tbl(['League', 'Week', 'Game', 'Reason'], R.skipped.map((x) => `<tr><td>${esc(x.league.toUpperCase())}</td><td>${x.week}</td><td>${esc(x.matchup)} <small>${esc(x.game)}</small></td><td style="text-align:left;font-family:var(--font)">${esc(x.reason)}</td></tr>`))}</details>
    <details class="why"><summary>Batches (${B.batches.length}) and audit trail</summary>${tbl(['Batch', 'Created', 'Model', 'Params hash', 'Predicted/games', 'Events'], batchRows)}</details>`;
  wireBlindRun();
}
function wireBlindRun() {
  const sel = document.querySelector('#blindbatch');
  if (sel) sel.onchange = () => { state.blindBatch = Number(sel.value); renderBlind(state.routeSeq); };
  const b = document.querySelector('#blindrun');
  if (b) b.onclick = async () => { b.disabled = true; const j = await api('/api/blind-run', { method: 'POST' }); const box = document.querySelector('#blindjob'); const poll = async () => { const x = await api(`/api/jobs/${j.id}`); box.innerHTML = `<div class="banner">${esc(x.label)} — ${esc(x.status)}<div class="joblog">${esc(x.log.slice(-12).join('\n'))}</div></div>`; if (x.status === 'running') setTimeout(poll, 3000); }; poll(); };
}

async function job(path) {
  const box = $('#job');
  let j;
  try { j = await api(path, { method: 'POST' }); } catch (e) { box.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  const poll = async () => {
    const x = await api(`/api/jobs/${j.id}`);
    box.innerHTML = `<div class="banner">${esc(x.label)} — ${esc(x.status)}${x.error ? `: ${esc(x.error)}` : ''}<div class="joblog">${esc(x.log.join('\n'))}</div></div>`;
    if (x.status === 'running') setTimeout(poll, 1500); else setTimeout(() => { if (location.hash.startsWith('#/ledger')) renderLedger(); }, 1200);
  };
  poll();
}

// Sticky team headers sit just below the (sometimes two-row) top bar.
const syncTopbar = () => document.documentElement.style.setProperty('--topbar-h', `${document.querySelector('.topbar').offsetHeight}px`);
window.addEventListener('resize', syncTopbar);
syncTopbar();

loadStatus().then(route);
