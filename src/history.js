// Collects a team's completed games BEFORE a cutoff and derives team + player context.
// The cutoff is the single guard against future-data leakage: every game used must have
// kicked off before `cutoff` and be final.
import * as espn from './espn.js';
import { PRIORS } from './config.js';

export const STATES = ['blowTrail', 'trail', 'close', 'lead', 'blowLead'];

export function stateOf(margin, lg) {
  const B = PRIORS[lg].blowoutMargin;
  if (margin <= -B) return 'blowTrail';
  if (margin <= -8) return 'trail';
  if (margin < 8) return 'close';
  if (margin < B) return 'lead';
  return 'blowLead';
}

// A prior game only counts if it had FINISHED before the target kickoff. Kickoff + 4.5h is a
// conservative end time (NFL/FBS games rarely exceed 4h), which excludes overlapping games.
export const GAME_DURATION_BUFFER_MS = 4.5 * 3600e3;
export function finishedBefore(dateISO, cutoffISO) {
  return Date.parse(dateISO) + GAME_DURATION_BUFFER_MS <= Date.parse(cutoffISO);
}

// Blind mode does NOT rely on the buffer: a prior game is admitted only if its own summary shows
// an actual end time (latest play wallclock, normally the "End of Game" play) at/before kickoff.
// The minimum duration below only discards candidates that cannot possibly have finished.
export const MIN_GAME_DURATION_MS = 2.5 * 3600e3;
export function couldHaveFinished(kickoffISO, cutoffISO) {
  return Date.parse(kickoffISO) + MIN_GAME_DURATION_MS <= Date.parse(cutoffISO);
}
/** Actual end time of a finished game from its play wallclocks, or null if unverifiable. */
export function gameEndTime(sum) {
  let max = -Infinity, endOfGame = null;
  for (const d of sum?.drives?.previous || []) for (const p of d.plays || []) {
    const t = Date.parse(p.wallclock);
    if (!Number.isFinite(t)) continue;
    if (t > max) max = t;
    if (/End of Game/i.test(p.type?.text || '')) endOfGame = t;
  }
  const t = endOfGame ?? (Number.isFinite(max) ? max : null);
  return t == null ? null : { end: new Date(t).toISOString(), source: endOfGame != null ? 'End of Game play wallclock' : 'latest play wallclock (no End of Game play)' };
}

/** Strict pre-cutoff filter. Exported for tests. */
export function gamesBeforeCutoff(schedule, cutoffISO) {
  return schedule.filter((g) => g.completed && finishedBefore(g.date, cutoffISO));
}

export async function loadTeamGames(lg, teamId, season, cutoffISO, prov, { maxGames = 16, priorGames = null } = {}) {
  let past;
  const excluded = [];
  if (priorGames) {
    // Blind mode: the scheduler supplies sanitized prior games; no schedule payload (which would
    // carry the target game's result) is ever fetched here. Completion is verified below.
    past = priorGames
      .filter((g) => (String(g.home.id) === String(teamId) || String(g.away.id) === String(teamId)) && couldHaveFinished(g.kickoff, cutoffISO))
      .map((g) => ({ id: String(g.id), date: g.kickoff, week: g.week, seasonType: 2 }))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-maxGames);
  } else {
    const sch = await espn.getSchedule(lg, teamId, season);
    prov.add(sch.meta);
    past = gamesBeforeCutoff(espn.parseSchedule(sch.data), cutoffISO).slice(-maxGames);
  }
  const games = [];
  await Promise.all(past.map(async (g) => {
    const s = await espn.getSummary(lg, g.id, { final: true });
    prov.add(s.meta);
    if (!s.data) return;
    const t = espn.summaryTeams(s.data);
    if (!t.completed) { if (priorGames) excluded.push({ id: g.id, reason: 'not final in feed' }); return; }
    let endTime = null;
    if (priorGames) {
      const e = gameEndTime(s.data);
      if (!e) { excluded.push({ id: g.id, kickoff: g.date, reason: 'completion time unverifiable (no play wallclock) — excluded' }); return; }
      if (Date.parse(e.end) > Date.parse(cutoffISO)) { excluded.push({ id: g.id, kickoff: g.date, end: e.end, reason: `finished after target kickoff (${e.source} ${e.end})` }); return; }
      endTime = e;
    }
    const isHome = t.home.id === String(teamId);
    const me = isHome ? t.home : t.away;
    const opp = isHome ? t.away : t.home;
    games.push({
      eventId: g.id, date: g.date, week: g.week, seasonType: g.seasonType, isHome,
      teamId: String(teamId), teamAbbr: me.abbr, oppId: opp.id, oppAbbr: opp.abbr,
      pointsFor: me.score, pointsAgainst: opp.score,
      box: espn.parseBoxscore(s.data), plays: espn.extractPlays(s.data), summary: null, endTime,
    });
  }));
  games.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { games, excluded };
}

function newPl() {
  return { carries: {}, targets: {}, carriesAll: 0, targetsAll: 0, r10: 0, r20: 0, rec: 0, c20: 0, c40: 0 };
}

function emptyAgg() {
  return { rush: 0, rushYds: 0, db: 0, sacks: 0, att: 0, cmp: 0, passYds: 0, ints: 0, succ: 0, succN: 0, ed: 0, edPass: 0 };
}

function isSuccess(p) {
  if (p.down == null || p.distance == null) return null;
  const need = p.down === 1 ? 0.4 * p.distance : p.down === 2 ? 0.6 * p.distance : p.distance;
  return p.yards >= need;
}

/**
 * Per-game team aggregates from play-by-play, for the offense `teamId` (side='off') or the
 * offenses it faced (side='def'). `posOf(athleteId)` classifies ball carriers/targets.
 */
export function aggregatePlays(plays, teamId, side, lg, resolvers, posOf) {
  const byState = Object.fromEntries(STATES.map((s) => [s, emptyAgg()]));
  const all = emptyAgg();
  const players = {}; // athleteId -> {carries:{state:n}, targets:{state:n}}
  const expl = { rbRuns: 0, rb10: 0, rb20: 0, qbRuns: 0, qb10: 0, qb20: 0, runs: 0, run10: 0, run20: 0, passes: 0, p20: 0, p40: 0,
    tgt: { RB: 0, WR: 0, TE: 0 }, c20: { RB: 0, WR: 0, TE: 0 }, c40: { RB: 0, WR: 0, TE: 0 }, recYds: { RB: 0, WR: 0, TE: 0 }, rec: { RB: 0, WR: 0, TE: 0 },
    rbRushYds: 0, attributed: 0, attributable: 0 };
  let longCmpBy = {};
  for (const p of plays) {
    const mine = side === 'off' ? p.offenseId === String(teamId) : p.defenseId === String(teamId);
    if (!mine) continue;
    const st = stateOf(p.margin, lg);
    const A = [all, byState[st]];
    const resolve = resolvers[p.offenseId] || (() => null);
    const early = (p.down === 1 || p.down === 2) && st === 'close';
    if (p.kind === 'rush') {
      const id = resolve(p.rusher);
      expl.attributable++; if (id) expl.attributed++;
      for (const a of A) {
        a.rush++; a.rushYds += p.yards;
        const s = isSuccess(p); if (s != null) { a.succN++; if (s) a.succ++; }
        if (early) { a.ed++; }
      }
      const pos = id ? posOf(id) : null;
      expl.runs++; if (p.yards >= 10) expl.run10++; if (p.yards >= 20) expl.run20++;
      if (pos === 'QB') { expl.qbRuns++; if (p.yards >= 10) expl.qb10++; if (p.yards >= 20) expl.qb20++; }
      else if (pos === 'RB' || pos === 'FB') { expl.rbRuns++; expl.rbRushYds += p.yards; if (p.yards >= 10) expl.rb10++; if (p.yards >= 20) expl.rb20++; }
      if (id) {
        const pl = (players[id] = players[id] || newPl());
        pl.carries[st] = (pl.carries[st] || 0) + 1; pl.carriesAll++;
        if (p.yards >= 10) pl.r10++; if (p.yards >= 20) pl.r20++;
      }
    } else if (p.kind === 'sack' || p.kind === 'pass') {
      for (const a of A) {
        a.db++;
        if (p.kind === 'sack') a.sacks++;
        else { a.att++; if (p.complete) { a.cmp++; a.passYds += p.yards; } if (p.int) a.ints++; }
        if (early) { a.ed++; a.edPass++; }
      }
      if (p.kind === 'pass') {
        expl.passes++;
        if (p.complete && p.yards >= 20) expl.p20++;
        if (p.complete && p.yards >= 40) expl.p40++;
        if (p.target) {
          const id = resolve(p.target);
          expl.attributable++; if (id) expl.attributed++;
          const pos = id ? normPos(posOf(id)) : null;
          if (pos && expl.tgt[pos] != null) {
            expl.tgt[pos]++;
            if (p.complete) { expl.rec[pos]++; expl.recYds[pos] += p.yards; if (p.yards >= 20) expl.c20[pos]++; if (p.yards >= 40) expl.c40[pos]++; }
          }
          if (id) {
            const pl = (players[id] = players[id] || newPl());
            pl.targets[st] = (pl.targets[st] || 0) + 1; pl.targetsAll++;
            if (p.complete) { pl.rec++; if (p.yards >= 20) pl.c20++; if (p.yards >= 40) pl.c40++; }
          }
        }
        if (p.complete && p.passer) {
          const qid = resolve(p.passer);
          if (qid) longCmpBy[qid] = Math.max(longCmpBy[qid] || 0, p.yards);
        }
      }
    }
  }
  return { all, byState, players, expl, longCmpBy };
}

export function normPos(p) {
  if (!p) return null;
  if (p === 'FB' || p === 'HB') return 'RB';
  if (p === 'QB' || p === 'RB' || p === 'WR' || p === 'TE') return p;
  return null;
}

/** Build team offense + defense context across a list of games. */
export function teamContext(lg, teamId, games, resolversFor, posOf) {
  const P = PRIORS[lg];
  const off = { games: 0, plays: 0, points: 0, byState: Object.fromEntries(STATES.map((s) => [s, emptyAgg()])), all: emptyAgg() };
  const def = { games: 0, plays: 0, points: 0, byState: Object.fromEntries(STATES.map((s) => [s, emptyAgg()])), all: emptyAgg(), expl: null };
  const perGame = [];
  const explSum = (a, b) => {
    if (!a) return JSON.parse(JSON.stringify(b));
    for (const k of Object.keys(b)) {
      if (typeof b[k] === 'number') a[k] += b[k];
      else for (const kk of Object.keys(b[k])) a[k][kk] += b[k][kk];
    }
    return a;
  };
  let offExpl = null;
  for (const g of games) {
    const res = resolversFor(g);
    const o = aggregatePlays(g.plays, teamId, 'off', lg, res, posOf);
    const d = aggregatePlays(g.plays, teamId, 'def', lg, res, posOf);
    const add = (dst, src) => { for (const k of Object.keys(src)) dst[k] += src[k]; };
    off.games++; off.points += g.pointsFor ?? 0; off.plays += o.all.rush + o.all.db; add(off.all, o.all);
    def.games++; def.points += g.pointsAgainst ?? 0; def.plays += d.all.rush + d.all.db; add(def.all, d.all);
    for (const s of STATES) { add(off.byState[s], o.byState[s]); add(def.byState[s], d.byState[s]); }
    def.expl = explSum(def.expl, d.expl);
    offExpl = explSum(offExpl, o.expl);
    perGame.push({ eventId: g.eventId, date: g.date, oppAbbr: g.oppAbbr, off: o, def: d, pointsFor: g.pointsFor, pointsAgainst: g.pointsAgainst });
  }
  off.expl = offExpl;

  const shrink = (x, n, prior, k) => (n > 0 ? (x * n + prior * k) / (n + k) : prior);
  const G = off.games;
  const rate = (a, b) => (b > 0 ? a / b : null);
  const passRates = {};
  for (const s of STATES) {
    const b = off.byState[s];
    const n = b.rush + b.db;
    passRates[s] = { raw: rate(b.db, n), n, shrunk: shrink(rate(b.db, n) ?? 0, n, P.passRate[s], 40) };
  }
  const ed = off.byState.close;
  const edRate = rate(ed.edPass, ed.ed);
  // Down/distance: early-down neutral pass rate is the cleanest play-calling signal.
  if (edRate != null) passRates.close.shrunk = 0.5 * passRates.close.shrunk + 0.5 * shrink(edRate, ed.ed, P.passRate.close, 40);

  const leagueYpc = P.ypc.RB;
  const dEx = def.expl || {};
  const summary = {
    games: G,
    offense: {
      playsPerGame: G ? off.plays / G : null,
      playsPerGameShrunk: shrink(G ? off.plays / G : 0, G, P.playsPerGame, 3),
      pointsPerGame: G ? off.points / G : null,
      pointsShrunk: shrink(G ? off.points / G : 0, G, P.pointsPerTeamGame, 3),
      passRates, earlyDownNeutralPassRate: edRate, earlyDownN: ed.ed,
      sackRate: rate(off.all.sacks, off.all.db), dropbacks: off.all.db,
      sackRateShrunk: shrink(rate(off.all.sacks, off.all.db) ?? 0, off.all.db, P.sackRate, 120),
      rushSuccess: rate(off.all.succ, off.all.succN), rushSuccessN: off.all.succN,
      ypc: rate(off.all.rushYds, off.all.rush), rushes: off.all.rush,
      intRate: rate(off.all.ints, off.all.att),
      explosive: offExpl,
    },
    defense: {
      playsFacedPerGame: G ? def.plays / G : null,
      playsFacedShrunk: shrink(G ? def.plays / G : 0, G, P.playsPerGame, 3),
      pointsAllowedPerGame: G ? def.points / G : null,
      pointsAllowedShrunk: shrink(G ? def.points / G : 0, G, P.pointsPerTeamGame, 3),
      rbYpcAllowed: rate(dEx.rbRushYds, dEx.rbRuns), rbRuns: dEx.rbRuns || 0,
      rbYpcAllowedShrunk: shrink(rate(dEx.rbRushYds, dEx.rbRuns) ?? 0, dEx.rbRuns || 0, leagueYpc, 80),
      ypcAllowed: rate(def.all.rushYds, def.all.rush),
      sackRate: rate(def.all.sacks, def.all.db), dropbacksFaced: def.all.db,
      sackRateShrunk: shrink(rate(def.all.sacks, def.all.db) ?? 0, def.all.db, P.sackRate, 120),
      intRateShrunk: shrink(rate(def.all.ints, def.all.att) ?? 0, def.all.att, P.intRate, 200),
      cmpAllowed: rate(def.all.cmp, def.all.att), attFaced: def.all.att,
      rushSuccessAllowed: rate(def.all.succ, def.all.succN), rushSuccessN: def.all.succN,
      explosive: dEx,
      byPos: Object.fromEntries(['RB', 'WR', 'TE'].map((pos) => {
        const t = dEx.tgt?.[pos] || 0, r = dEx.rec?.[pos] || 0, y = dEx.recYds?.[pos] || 0;
        return [pos, {
          targets: t, catchRate: rate(r, t), ypCatch: rate(y, r),
          catchRateShrunk: shrink(rate(r, t) ?? 0, t, P.catchRate[pos], 40),
          ypCatchShrunk: shrink(rate(y, r) ?? 0, r, P.yardsPerCatch[pos], 30),
          c20: rate(dEx.c20?.[pos] || 0, t), c40: rate(dEx.c40?.[pos] || 0, t),
        }];
      })),
    },
    perGame,
  };
  // Explosive plays allowed, shrunk toward league rates (sample-size aware).
  const ex = summary.defense.explosive;
  summary.defense.explosiveRates = {
    rbRun10: { raw: rate(ex.rb10, ex.rbRuns), n: ex.rbRuns || 0, shrunk: shrink(rate(ex.rb10, ex.rbRuns) ?? 0, ex.rbRuns || 0, P.run10, 80) },
    rbRun20: { raw: rate(ex.rb20, ex.rbRuns), n: ex.rbRuns || 0, shrunk: shrink(rate(ex.rb20, ex.rbRuns) ?? 0, ex.rbRuns || 0, P.run20, 120) },
    qbRun10: { raw: rate(ex.qb10, ex.qbRuns), n: ex.qbRuns || 0, shrunk: shrink(rate(ex.qb10, ex.qbRuns) ?? 0, ex.qbRuns || 0, P.qbRun10, 40) },
    qbRun20: { raw: rate(ex.qb20, ex.qbRuns), n: ex.qbRuns || 0, shrunk: shrink(rate(ex.qb20, ex.qbRuns) ?? 0, ex.qbRuns || 0, P.qbRun20, 60) },
    pass20: { raw: rate(ex.p20, ex.passes), n: ex.passes || 0 },
    pass40: { raw: rate(ex.p40, ex.passes), n: ex.passes || 0 },
    catch20: Object.fromEntries(['RB', 'WR', 'TE'].map((pos) => [pos, { raw: rate(ex.c20?.[pos] || 0, ex.rec?.[pos] || 0), n: ex.rec?.[pos] || 0, shrunk: shrink(rate(ex.c20?.[pos] || 0, ex.rec?.[pos] || 0) ?? 0, ex.rec?.[pos] || 0, P.catch20[pos], 40) }])),
    catch40: Object.fromEntries(['RB', 'WR', 'TE'].map((pos) => [pos, { raw: rate(ex.c40?.[pos] || 0, ex.rec?.[pos] || 0), n: ex.rec?.[pos] || 0, shrunk: shrink(rate(ex.c40?.[pos] || 0, ex.rec?.[pos] || 0) ?? 0, ex.rec?.[pos] || 0, P.catch40[pos], 60) }])),
    attribution: ex.attributable ? ex.attributed / ex.attributable : null,
  };
  return summary;
}

/**
 * Player per-game rows for one team from its games (box score + pbp attribution).
 * Returns Map<athleteId, [{eventId,date,oppAbbr,stats,share:{carry,target},state:{carries,targets}}]>
 * plus per-game team totals.
 */
export function playerGameRows(teamId, games, ctx) {
  const rows = new Map();
  const teamTotals = [];
  games.forEach((g, gi) => {
    const pg = ctx.perGame[gi];
    const off = pg.off;
    let teamCarries = 0, teamTargets = 0, teamRec = 0;
    for (const r of g.box.values()) {
      if (r.teamId !== String(teamId)) continue;
      teamCarries += r.stats.carries || 0;
      teamTargets += r.stats.targets || 0;
      teamRec += r.stats.receptions || 0;
    }
    const pbpTargets = Object.values(off.players).reduce((s, x) => s + x.targetsAll, 0);
    const totals = {
      eventId: g.eventId, date: g.date, oppAbbr: g.oppAbbr, teamCarries, teamTargets: teamTargets || pbpTargets, teamRec,
      rushByState: Object.fromEntries(STATES.map((s) => [s, off.byState[s].rush])),
      dbByState: Object.fromEntries(STATES.map((s) => [s, off.byState[s].db - off.byState[s].sacks])),
      appeared: new Set([...g.box.values()].filter((r) => r.teamId === String(teamId)).map((r) => r.athleteId)),
      margin: (g.pointsFor ?? 0) - (g.pointsAgainst ?? 0), pointsFor: g.pointsFor, isHome: g.isHome, week: g.week,
    };
    teamTotals.push(totals);
    for (const r of g.box.values()) {
      if (r.teamId !== String(teamId)) continue;
      const st = { ...r.stats };
      const pp = off.players[r.athleteId];
      // College box scores have no targets: use play-by-play attributed targets (disclosed).
      let targetsDerived = false;
      if (st.targets == null && pp) { st.targets = pp.targetsAll; targetsDerived = true; }
      if (st.targets == null && (st.receptions != null)) { st.targets = null; }
      if (off.longCmpBy[r.athleteId] != null && st.pass_att) st.long_cmp = off.longCmpBy[r.athleteId];
      finalizeDerived(st);
      const row = {
        eventId: g.eventId, date: g.date, week: g.week, oppAbbr: g.oppAbbr, isHome: g.isHome, season: 'current', stats: st, targetsDerived,
        share: {
          carry: totals.teamCarries ? (st.carries || 0) / totals.teamCarries : null,
          target: totals.teamTargets ? (st.targets || 0) / totals.teamTargets : null,
        },
        state: pp ? { carries: pp.carries, targets: pp.targets } : { carries: {}, targets: {} },
        pbp: pp ? { carries: pp.carriesAll, targets: pp.targetsAll, r10: pp.r10, r20: pp.r20, rec: pp.rec, c20: pp.c20, c40: pp.c40 } : null,
      };
      if (!rows.has(r.athleteId)) rows.set(r.athleteId, []);
      rows.get(r.athleteId).push(row);
    }
  });
  return { rows, teamTotals };
}

export function finalizeDerived(st) {
  if (st.carries) st.ypc = round2((st.rush_yds || 0) / st.carries);
  if (st.receptions) st.ypr = round2((st.rec_yds || 0) / st.receptions);
  if (st.rush_td != null || st.rec_td != null) st.tds = (st.rush_td || 0) + (st.rec_td || 0);
  return st;
}
function round2(x) { return Math.round(x * 100) / 100; }
