// Application services shared by the HTTP server and CLI scripts.
import * as espn from './espn.js';
import { buildMatchup } from './matchup.js';
import { impliedScore, noVig } from './odds.js';
import { openLedger, recordSnapshot, pendingGames, recordResult, ledgerOverview } from './ledger.js';
import { finalizeDerived } from './history.js';

const memo = new Map(); // key -> {at, promise}
const MEMO_MS = 5 * 60 * 1000;

export async function getSlate(lg, { week, seasontype } = {}) {
  let r = await espn.getScoreboard(lg, {});
  let sb = espn.parseScoreboard(r.data);
  if (week != null && Number(week) !== sb.week) {
    r = await espn.getScoreboard(lg, { week, seasontype: seasontype || 2, season: sb.season });
    const cal = sb.calendar;
    sb = { ...espn.parseScoreboard(r.data), calendar: cal };
  }
  for (const g of sb.games) {
    g.implied = g.odds && g.odds.total != null && g.odds.homeSpread != null ? impliedScore(g.odds.total, g.odds.homeSpread) : null;
    g.mlNoVig = g.odds && g.odds.homeML != null && g.odds.awayML != null ? noVig(g.odds.homeML, g.odds.awayML) : null;
  }
  sb.games.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { ...sb, league: lg, meta: r.meta };
}

export async function getMatchup(lg, id, { fresh = false, autoSnapshot = process.env.AUTO_SNAPSHOT !== '0' } = {}) {
  const key = `${lg}|${id}`;
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
  const promise = buildMatchup(lg, id).then((m) => {
    if (autoSnapshot && m.mode === 'pregame') {
      try { m.snapshot = maybeAutoSnapshot(m); } catch (e) { m.snapshot = { ok: false, reason: e.message }; }
    }
    return m;
  });
  memo.set(key, { at: Date.now(), promise });
  promise.catch(() => memo.delete(key));
  return promise;
}

// Auto-record at most one pregame snapshot per game per 6 hours (content-identical ones are skipped).
function maybeAutoSnapshot(m) {
  const d = openLedger();
  const last = d.prepare("SELECT id, created_at FROM runs WHERE game_id=? AND model_version=? AND kind='pregame' ORDER BY id DESC LIMIT 1").get(m.eventId, m.modelVersion);
  if (last && Date.now() - Date.parse(last.created_at) < 6 * 3600e3) return { ok: true, runId: last.id, existing: true, createdAt: last.created_at };
  const r = recordSnapshot(m, { kind: 'pregame' });
  return { ...r, createdAt: new Date().toISOString(), auto: true };
}

export async function snapshotGame(lg, id) {
  const m = await getMatchup(lg, id, { fresh: true, autoSnapshot: false });
  return { game: `${m.away.abbr} @ ${m.home.abbr}`, ...recordSnapshot(m, { kind: 'pregame' }) };
}

export async function snapshotSlate(lg, week, log = () => {}) {
  const sl = await getSlate(lg, { week });
  const out = [];
  for (const g of sl.games) {
    if (g.status.state !== 'pre' || Date.parse(g.date) <= Date.now()) { out.push({ game: g.shortName, ok: false, reason: 'not pregame' }); continue; }
    try { const r = await snapshotGame(lg, g.id); out.push(r); log(`${g.shortName}: ${r.ok ? (r.duplicate ? 'unchanged' : `run ${r.runId}`) : r.reason}`); }
    catch (e) { out.push({ game: g.shortName, ok: false, reason: e.message }); log(`${g.shortName}: ERROR ${e.message}`); }
  }
  return out;
}

/** Backtest: rebuild completed games with a strict kickoff cutoff and store as kind='backtest'. */
export async function backtestWeek(lg, week, log = () => {}, { limit = 999 } = {}) {
  const sl = await getSlate(lg, { week });
  const out = [];
  for (const g of sl.games.filter((x) => x.status.completed).slice(0, limit)) {
    try {
      const m = await buildMatchup(lg, g.id, { forceRetro: true });
      const r = recordSnapshot(m, { kind: 'backtest' });
      out.push({ game: g.shortName, ...r });
      log(`${g.shortName}: ${r.ok ? (r.duplicate ? 'exists' : `run ${r.runId} (${r.rows} rows)`) : r.reason}`);
    } catch (e) { out.push({ game: g.shortName, ok: false, reason: e.message }); log(`${g.shortName}: ERROR ${e.message}`); }
  }
  return out;
}

export function actualLinesFromSummary(sum) {
  const box = espn.parseBoxscore(sum);
  const plays = espn.extractPlays(sum);
  const lines = new Map();
  for (const [id, r] of box) lines.set(id, finalizeDerived({ ...r.stats }));
  // Longest completion per passer from play-by-play (box score omits it).
  const byTeam = {};
  for (const r of box.values()) (byTeam[r.teamId] ||= []).push({ id: r.athleteId, name: r.name, jersey: r.jersey });
  const res = Object.fromEntries(Object.entries(byTeam).map(([t, ps]) => [t, espn.makeResolver(ps)]));
  const hasTargets = [...box.values()].some((r) => r.stats.targets != null);
  const pbpTargets = new Map();
  for (const p of plays) {
    if (p.kind !== 'pass') continue;
    if (!hasTargets && p.target) { const tid = res[p.offenseId]?.(p.target); if (tid) pbpTargets.set(tid, (pbpTargets.get(tid) || 0) + 1); }
    if (!p.complete || !p.passer) continue;
    const id = res[p.offenseId]?.(p.passer);
    if (id && lines.has(id)) lines.get(id).long_cmp = Math.max(lines.get(id).long_cmp || 0, p.yards);
  }
  // College: box scores omit targets; use play-by-play-derived targets (same definition the
  // projections use), flagged. Players with no attributed target keep 0 only if they caught a pass
  // or were otherwise targeted — otherwise the value stays unknown.
  if (!hasTargets) for (const [id, st] of lines) {
    if (pbpTargets.has(id)) { st.targets = pbpTargets.get(id); st.targetsDerived = true; }
    else if (st.receptions == null) { st.targets = 0; st.targetsDerived = true; }
  }
  for (const st of lines.values()) if (st.pass_att && st.long_cmp == null) st.long_cmp = 0;
  return lines;
}

export async function settle(log = () => {}, { all = false } = {}) {
  const d = openLedger();
  const out = [];
  // `all` re-fetches already-settled games too; any change is logged in actual_revisions.
  const games = all ? d.prepare('SELECT DISTINCT game_id, league, season, week FROM runs').all() : pendingGames();
  for (const g of games) {
    const s = await espn.getSummary(g.league, g.game_id);
    const t = s.data ? espn.summaryTeams(s.data) : null;
    if (!t || !t.completed) { out.push({ game: g.game_id, settled: false, reason: t ? 'not final' : s.meta.error }); continue; }
    const lines = actualLinesFromSummary(s.data);
    const r = recordResult({ gameId: g.game_id, league: g.league, season: g.season, week: g.week, home: t.home.abbr, away: t.away.abbr, homeScore: t.home.score, awayScore: t.away.score, lines, source: 'ESPN box score' });
    out.push({ game: `${t.away.abbr} @ ${t.home.abbr}`, settled: r.ok, players: r.players });
    log(`${t.away.abbr} @ ${t.home.abbr}: settled ${r.players} players`);
  }
  return out;
}

export function ledger(opts) { return ledgerOverview(opts); }
