// Builds the full matchup payload: header (odds/implied score), team context, injuries,
// role selection, player projections with explanations, and provenance.
import * as espn from './espn.js';
import { Provenance, fetchCached } from './fetcher.js';
import { LEAGUES, MODEL_VERSION, SHRINK, SIMS } from './config.js';
import { getBaselines } from './baselines.js';
import { loadTeamGames, teamContext, playerGameRows, STATES, normPos, finalizeDerived } from './history.js';
import { selectRoles, keyPlayers, contextWeights, availability } from './roles.js';
import { scenarioWeights, simulateTeam, simulateKicker, summarize, probOver, ratioSummary, shrink, clamp, seedFrom, makeRunDist, makeCatchDist } from './model.js';
import { impliedScore, noVig, probToAmerican, americanToProb } from './odds.js';
import { kickoffWeather } from './weather.js';
import { loadSnaps, snapsFor, normName } from './snaps.js';
import { oddsApiProps, cfbdLineYards } from './optional.js';
import { STAT_DEFS, STAT_LISTS, COMPACT } from './stats.js';
import { selectOutlier } from './outlier.js';
import { skeptic } from './skeptic.js';
import { buildContext, playerFit, unitEdges } from './profiles.js';
import { loadPlayerIds } from './pbp.js';
import { whyPick, edgeKeyFor } from './why.js';
import { bigMissProbs, oppUnitFor, BIG, topDrivers } from './bigmiss.js';
import { calibrationFor, calibrateSample } from './calibrate.js';
import { v14For, buildX, usageFromRows, applyV14 } from './v14.js';
import { FIT, loadPriorSeason, priorPoints, blendTeam } from './priors.js';
import { lineAgg, gradeTeam, leagueBaseline, METHOD as LINE_METHOD } from './linegrades.js';

const SCRIPT_LABEL = { blowTrail: 'Trailing big', trail: 'Trailing', close: 'Close', lead: 'Leading', blowLead: 'Leading big' };

async function findEvent(lg, eventId, dateISO, prov) {
  // Scoreboard carries venue.indoor + weather text that the summary lacks.
  const d = new Date(dateISO);
  const days = [0, -1, 1].map((off) => {
    const x = new Date(d.getTime() + off * 86400000 - 4 * 3600000);
    return x.toISOString().slice(0, 10).replace(/-/g, '');
  });
  for (const day of days) {
    const L = LEAGUES[lg];
    const u = `https://site.api.espn.com/apis/site/v2/sports/football/${L.espn}/scoreboard?dates=${day}&limit=400${L.groups ? `&groups=${L.groups}` : ''}`;
    const r = await fetchCached(u, { ttl: 300, label: 'Scoreboard (by date)' });
    const e = r.data?.events?.find((x) => x.id === String(eventId));
    if (e) { prov.add(r.meta); return espn.parseEvent(e); }
  }
  return null;
}

/**
 * opts.blind = { game, priorGames, positions } switches to MARKET-BLIND HISTORICAL mode:
 *   game       sanitized identity only: {id, season, week, kickoff, home:{id,abbr,name}, away:{...}}
 *   priorGames sanitized games (same shape) that FINISHED before kickoff — from the scheduler
 *   positions  optional Map<athleteId,pos> built only from as-of-week data (see blind.js)
 * In blind mode the target game's summary/box/plays/odds/props, current rosters, depth charts,
 * injuries, weather, snaps and optional APIs are never requested.
 */
export async function buildMatchup(lg, eventId, { forceRetro = false, blind = null } = {}) {
  const prov = new Provenance();
  let sumR = null, sum = null, hdr, season, kickoff, ev, state, pregame, mode, home, away, odds, oddsMeta, implied, mlNoVig;
  if (blind) {
    const g = blind.game;
    if (String(g.id) !== String(eventId)) throw new Error('blind: event id mismatch');
    hdr = { completed: false };
    season = Number(g.season); kickoff = g.kickoff; state = 'blind'; pregame = false; mode = 'blind';
    ev = { week: g.week, venue: null };
    const t = (x) => ({ id: String(x.id), abbr: x.abbr, name: x.name, short: x.name, logo: null, color: null, alternateColor: null, score: null, record: null, rank: null });
    home = t(g.home); away = t(g.away);
    odds = null; implied = null; mlNoVig = null;
    oddsMeta = { source: 'none (market-blind)', retrievedAt: null, note: 'Market-blind: no spread/total/moneyline/props used' };
  } else {
    sumR = await espn.getSummary(lg, eventId);
    prov.add(sumR.meta);
    sum = sumR.data;
    if (!sum) throw Object.assign(new Error(`Game summary unavailable: ${sumR.meta.error}`), { status: 502 });
    hdr = espn.summaryTeams(sum);
    const comp = sum.header?.competitions?.[0] || {};
    season = Number(sum.header?.season?.year);
    kickoff = comp.date;
    ev = await findEvent(lg, eventId, kickoff, prov);
    state = comp.status?.type?.state || 'pre';
    pregame = state === 'pre' && Date.parse(kickoff) > Date.now() && !forceRetro;
    mode = pregame ? 'pregame' : 'retro';
    const side = (ha) => {
      const c = comp.competitors.find((x) => x.homeAway === ha);
      return { id: String(c.id), abbr: c.team.abbreviation, name: c.team.displayName, short: c.team.shortDisplayName, logo: c.team.logos?.[0]?.href || c.team.logo || null, color: c.team.color ? `#${c.team.color}` : null, alternateColor: c.team.alternateColor ? `#${c.team.alternateColor}` : null, score: c.score != null && c.score !== '' ? Number(c.score) : null, record: c.record?.[0]?.summary || null, rank: c.rank || null };
    };
    home = side('home'); away = side('away');
    const pick = (sum.pickcenter || [])[0];
    odds = espn.parseOddsObject(pick) || ev?.odds || null;
    oddsMeta = { source: odds?.provider ? `${odds.provider} via ESPN` : 'ESPN', retrievedAt: sumR.meta.fetchedAt, note: pregame ? 'Current line at retrieval time' : 'Line as retained by ESPN after kickoff (closing line; exact capture time not published)' };
    implied = odds && odds.total != null && odds.homeSpread != null ? impliedScore(odds.total, odds.homeSpread) : null;
    mlNoVig = odds && odds.homeML != null && odds.awayML != null ? noVig(odds.homeML, odds.awayML) : null;
  }
  const cutoff = kickoff; // strict: nothing from at/after kickoff enters the features
  const B = (await getBaselines(lg, season, prov));
  const P = B.priors;

  // ---------- History (pre-cutoff only) ----------
  const [H, A] = await Promise.all([home, away].map((t) => loadTeamGames(lg, t.id, season, cutoff, prov, blind ? { priorGames: blind.priorGames } : {})));
  const teamGames = { [home.id]: H.games, [away.id]: A.games };
  const blindAudit = blind ? {
    verifiedPriorGames: Object.fromEntries([home, away].map((t) => [t.abbr, teamGames[t.id].map((g) => ({ id: g.eventId, kickoff: g.date, end: g.endTime?.end, endSource: g.endTime?.source }))])),
    excludedPriorGames: Object.fromEntries([[home.abbr, H.excluded], [away.abbr, A.excluded]]),
  } : null;
  if (blind) for (const t of [home, away]) {
    if (!teamGames[t.id].length) throw Object.assign(new Error(`${t.abbr}: no prior game verified (play wallclock) as finished before kickoff`), { blindSkip: true, audit: blindAudit });
  }

  // Rosters: our two teams (current) + past opponents (positions for defensive splits).
  const oppIds = new Set([...H.games, ...A.games].map((g) => g.oppId));
  const rosterIds = [...new Set([home.id, away.id, ...oppIds])];
  const rosters = new Map();
  if (!blind) await Promise.all(rosterIds.map(async (tid) => {
    const r = await espn.getRoster(lg, tid);
    if (tid === home.id || tid === away.id) prov.add(r.meta);
    rosters.set(tid, espn.parseRoster(r.data));
  }));
  const posMap = new Map(), nameMap = new Map(), rosterById = new Map(), headshots = new Map();
  for (const [tid, list] of rosters) for (const p of list) {
    posMap.set(p.id, p.pos); nameMap.set(p.id, p.name); if (p.headshot) headshots.set(p.id, p.headshot);
    if (tid === home.id || tid === away.id) rosterById.set(p.id, { ...p, teamId: tid });
  }
  for (const g of [...H.games, ...A.games]) for (const r of g.box.values()) if (!nameMap.has(r.athleteId)) nameMap.set(r.athleteId, r.name);
  // Blind mode: positions come only from as-of-week data (never a current roster).
  if (blind) {
    const bp = blind.positionsFor ? blind.positionsFor([...H.games, ...A.games]) : (blind.positions || new Map());
    for (const [id, pos] of bp) posMap.set(id, pos);
  }
  const posOf = (id) => posMap.get(id) || null;
  const resolverCache = new Map();
  const resolversFor = (g) => {
    const out = {};
    for (const tid of [g.teamId, g.oppId]) {
      const key = `${g.eventId}|${tid}`;
      if (!resolverCache.has(key)) {
        const people = [...(rosters.get(tid) || []).map((p) => ({ id: p.id, name: p.name, jersey: p.jersey }))];
        for (const r of g.box.values()) if (r.teamId === tid && !people.find((p) => p.id === r.athleteId)) people.push({ id: r.athleteId, name: r.name, jersey: null });
        resolverCache.set(key, espn.makeResolver(people));
      }
      out[tid] = resolverCache.get(key);
    }
    return out;
  };

  const ctx = {}, prow = {};
  for (const t of [home, away]) {
    ctx[t.id] = teamContext(lg, t.id, teamGames[t.id], resolversFor, posOf);
    prow[t.id] = playerGameRows(t.id, teamGames[t.id], ctx[t.id]);
  }

  // ---------- Estimated OL/DL unit grades (pre-cutoff play-by-play only) ----------
  const lineBase = await leagueBaseline(lg, season, cutoff, ev?.week ?? null, prov, blind ? { gameIds: blind.priorGames.filter((g) => g.league !== 'x').map((g) => g.id) } : {});
  const lineGrades = {};
  for (const t of [home, away]) {
    // No prior games (e.g. week 1) => empty aggregates => grades "unavailable", never a crash or 0.
    const offA = teamGames[t.id].reduce((acc, g) => lineAgg(g.plays, t.id, 'off', acc), lineAgg([], t.id, 'off'));
    const defA = teamGames[t.id].reduce((acc, g) => lineAgg(g.plays, t.id, 'def', acc), lineAgg([], t.id, 'def'));
    lineGrades[t.id] = { ...gradeTeam(offA, defA, lineBase), games: teamGames[t.id].length };
  }

  // ---------- Injuries / depth ----------
  const injuries = new Map();
  let injuryNote;
  if (blind) {
    injuryNote = 'Market-blind historical mode: no injury report used (none archived as of kickoff).';
  } else if (pregame && lg === 'nfl') {
    for (const i of espn.parseInjuries(sum)) injuries.set(i.athleteId, i);
    for (const [id, r] of rosterById) {
      if (!injuries.has(id) && r.injuries?.length && r.injuries[0].status && !/active/i.test(r.injuries[0].status)) {
        injuries.set(id, { athleteId: id, name: r.name, pos: r.pos, teamId: r.teamId, status: r.injuries[0].status, date: r.injuries[0].date, source: 'roster' });
      }
    }
    injuryNote = `ESPN injury report (game summary), retrieved ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(sumR.meta.fetchedAt))} ET. Statuses shown as published; nothing inferred.`;
  } else if (!pregame) {
    injuryNote = 'Retrospective view: today\'s injury report is NOT applied to a past game (it would leak post-kickoff information).';
  } else {
    injuryNote = 'No public college injury report in the ESPN feed — availability unverified; ranges are not adjusted for injuries.';
  }
  const depth = {};
  if (lg === 'nfl' && pregame) {
    await Promise.all([home, away].map(async (t) => {
      const d = await espn.getDepth(lg, t.id, season);
      prov.add(d.meta);
      depth[t.id] = d.data ? espn.parseDepth(d.data) : null;
    }));
  }

  // ---------- Snap counts, weather, props ----------
  const snaps = lg === 'nfl' && !blind ? await loadSnaps(season, prov) : null;
  const venue = ev?.venue || (sum?.gameInfo?.venue ? { name: sum.gameInfo.venue.fullName, city: sum.gameInfo.venue.address?.city, state: sum.gameInfo.venue.address?.state, indoor: false } : null);
  const weather = pregame ? await kickoffWeather(venue, kickoff, prov) : { available: false, reason: 'Retrospective view — historical forecasts are not reconstructed' };
  const wx = weather.available && weather.effects ? weather.effects : { passEff: 1, catchRate: 1, passRate: 0, fumble: 1, dispersion: 1, notes: [] };
  let props = {}, propsMeta = { available: false, source: 'DraftKings lines via ESPN core API' };
  const pr = blind ? { data: null, meta: { error: 'market-blind: props not requested' } } : await espn.getProps(lg, eventId);
  if (!blind) prov.add(pr.meta);
  if (pr.data?.items) { props = espn.parseProps(pr.data); propsMeta = { available: Object.keys(props).length > 0, source: 'DraftKings lines via ESPN core API (line only — this feed carries no over/under prices)', retrievedAt: pr.meta.fetchedAt }; }
  else propsMeta.reason = pr.meta.status === 404 ? 'No player props posted for this game in the ESPN feed' : (pr.meta.error || 'unavailable');
  const oddsApi = pregame ? await oddsApiProps(lg, home, away, kickoff, prov) : { enabled: false };

  // ---------- fbm-1.2.0 NFL priors (prior season only; fitted constants in src/fitted_v12.json) ----------
  const V12 = lg === 'nfl';
  const prior = V12 ? await loadPriorSeason(season - 1, prov) : null;
  const priorPts = {};
  if (V12) for (const t of [home, away]) priorPts[t.id] = await priorPoints(t.id, season - 1, prov);

  // ---------- Per-team modelling ----------
  const teams = {};
  const flat = [];
  const expMarginHome = implied ? implied.home - implied.away : null;
  for (const t of [home, away]) {
    const opp = t.id === home.id ? away : home;
    const cx = ctx[t.id], ox = ctx[opp.id];
    const { rows, teamTotals } = prow[t.id];
    const injMap = new Map([...injuries].filter(([, i]) => !i.teamId || i.teamId === t.id));
    const rosterCheck = pregame;
    const teamRoster = new Map([...rosterById].filter(([, r]) => r.teamId === t.id));
    const roles = selectRoles({ lg, rows, teamTotals, rosterById: teamRoster, depth: depth[t.id] || null, injuries: injMap, rosterCheck, nameOf: nameMap, posOf });
    const keys = keyPlayers(rows, teamTotals);
    const lastGame = teamTotals[teamTotals.length - 1];
    const expectedPresent = (id) => {
      // College has no verified availability source (no injury feed): never infer an absence from a
      // missing roster entry or box-score line — treat as available and widen uncertainty instead.
      if (pregame && lg === 'cfb') return true;
      if (pregame) return availability(id, { injuries: injMap, roster: teamRoster, rosterCheck }).available;
      return lastGame ? lastGame.appeared.has(id) : true; // retro: best pre-kickoff evidence = last game
    };

    // Model set: core + extra + supporting skill players with recent usage (so "other" is small).
    const coreIds = [roles.qb, ...roles.rbs, ...roles.recs].filter(Boolean);
    const displayIds = [...coreIds, ...(roles.extra ? [roles.extra.id] : [])];
    const supporting = [...roles.usage.entries()]
      .filter(([id, u]) => !displayIds.includes(id) && u.touches > 0 && ['RB', 'WR', 'TE', 'QB'].includes(normPos(posOf(id))) && expectedPresent(id))
      .sort((a, b) => b[1].touches - a[1].touches).slice(0, 5).map(([id]) => id);
    const simIds = [...displayIds, ...supporting];

    // Implied points & script
    let teamPtsModel = 0.5 * (cx.offense.pointsShrunk + ox.defense.pointsAllowedShrunk);
    let oppPtsModel = 0.5 * (ox.offense.pointsShrunk + cx.defense.pointsAllowedShrunk);
    const v12 = {};
    if (V12 && prior) {
      // Points: current season blended with the REGRESSED prior season (fitted k/r), plus the
      // opponent's points-allowed estimate (fitted b). This restores a real team-strength signal.
      const F = FIT.team.pf, L = F.league;
      const off = (tm, n, ppg) => blendTeam('pf', ppg, n, priorPts[tm.id]?.pf, L);
      const def = (tm, n, papg) => blendTeam('pf', papg, n, priorPts[tm.id]?.pa, L);
      teamPtsModel = off(t, cx.games, cx.offense.pointsPerGame) + F.best.b * (def(opp, ox.games, ox.defense.pointsAllowedPerGame) - L);
      oppPtsModel = off(opp, ox.games, ox.offense.pointsPerGame) + F.best.b * (def(t, cx.games, cx.defense.pointsAllowedPerGame) - L);
      v12.points = { team: teamPtsModel, opp: oppPtsModel, priorPf: priorPts[t.id]?.pf, priorPaOpp: priorPts[opp.id]?.pa };
    }
    const impliedPts = implied ? (t.id === home.id ? implied.home : implied.away) : teamPtsModel;
    const expMargin = expMarginHome != null ? (t.id === home.id ? expMarginHome : -expMarginHome) : teamPtsModel - oppPtsModel;
    const weights = scenarioWeights(expMargin, lg);
    const scriptSource = implied ? 'Book spread' : 'Season scoring margins (no book line)';

    // Team parameters
    const pace = clamp(Math.pow(((odds?.total ?? (teamPtsModel + oppPtsModel)) / (2 * P.pointsPerTeamGame)), 0.25), 0.9, 1.1);
    // Offense controls most of its own snap volume; opponent pace contributes less.
    let plays = (0.65 * cx.offense.playsPerGameShrunk + 0.35 * ox.defense.playsFacedShrunk) * pace;
    let attTarget = null;
    if (V12 && prior) {
      // Volume: fitted estimators (history shows plays are near-unpredictable, so these stay close
      // to league average; attempts get a small prior-season + opponent signal).
      const Fp = FIT.team.plays, Fa = FIT.team.att;
      const offP = blendTeam('plays', cx.offense.playsPerGame, cx.games, prior.team(t.abbr, 'plays'), Fp.league);
      const defP = blendTeam('plays', ox.defense.playsFacedPerGame, ox.games, prior.allowed(opp.abbr, 'plays'), Fp.league);
      plays = offP + Fp.best.b * (defP - Fp.league);
      const curAtt = cx.games ? (cx.offense.dropbacks * (1 - (cx.offense.sackRate || 0))) / cx.games : null;
      const oppAtt = ox.games ? ox.defense.attFaced / ox.games : null;
      const offA = blendTeam('att', curAtt, cx.games, prior.team(t.abbr, 'att'), Fa.league);
      const defA = blendTeam('att', oppAtt, ox.games, prior.allowed(opp.abbr, 'att'), Fa.league);
      attTarget = offA + Fa.best.b * (defA - Fa.league);
      v12.volume = { plays, attTarget };
    }
    const passRate = {};
    for (const s of STATES) passRate[s] = clamp(cx.offense.passRates[s].shrunk + wx.passRate, 0.2, 0.85);
    const sackRate = Math.sqrt(cx.offense.sackRateShrunk * ox.defense.sackRateShrunk);
    const qbRow = rows.get(roles.qb) || [];
    const qbAtt = qbRow.reduce((s, r) => s + (r.stats.pass_att || 0), 0), qbInt = qbRow.reduce((s, r) => s + (r.stats.ints || 0), 0);
    const intRate = Math.sqrt(shrink(qbAtt ? qbInt / qbAtt : null, qbAtt, P.intRate, 200) * ox.defense.intRateShrunk);
    const kRows = roles.k ? rows.get(roles.k) || [] : [];
    const fgMade = kRows.reduce((s, r) => s + (r.stats.fg_made || 0), 0);
    const fgPerGame = shrink(kRows.length ? fgMade / kRows.length : null, kRows.length, P.fgMadePerGame, 4) * clamp(Math.sqrt(impliedPts / Math.max(10, cx.offense.pointsShrunk)), 0.75, 1.3);

    const other = {
      run: makeRunDist(P.ypc.RB, P.run10, P.run20), catchRate: 0.66, catch: makeCatchDist(11.2 * wx.passEff, 0.15, 0.022),
      rushTd: P.rushTdPerCarry.RB, recTd: 0.07,
    };
    if (attTarget != null) {
      // Scale script pass rates so expected attempts match the fitted attempts estimate.
      const eff = 0.4 * passRate.close + 0.6 * STATES.reduce((a, s2) => a + (weights[s2] || 0) * passRate[s2], 0);
      const f = clamp(attTarget / Math.max(1, plays * eff * (1 - sackRate)), 0.85, 1.15);
      for (const s2 of STATES) passRate[s2] = clamp(passRate[s2] * f, 0.2, 0.85);
      v12.passRateScale = f;
    }
    const team = { plays, passRate, sackRate, intRate, tdScale: 1, blowFactor: P.starterShareInBlowout, other, qbFumblePerSack: 0.1 * wx.fumble };

    // Vacated usage from unavailable key players (pregame only).
    // Workload is redistributed only for absences backed by a published injury report / roster
    // designation (NFL). Inferred absences never trigger redistribution.
    const outKeys = pregame && lg === 'nfl' ? [...keys].filter((k) => !expectedPresent(k) && (roles.usage.get(k)?.touches || 0) > 0) : [];
    // Share of team carries/targets held by regulars who are OUT this week (big-miss feature: volume freed up).
    // Questionable regulars, from 2023–25 injury reports: they played 68% (RB) / 72% (WR) / 75% (TE) / 43% (QB) of the
    // time and, when active, got 93% / 92% / 89% / 107% of their usual usage. Teammates absorb the expected vacated share.
    const Q_PLAY = { QB: 0.43, RB: 0.68, WR: 0.72, TE: 0.75 }, Q_USE = { QB: 1, RB: 0.93, WR: 0.92, TE: 0.89 };
    const isQ = (k) => pregame && lg === 'nfl' && availability(k, { injuries: injMap, roster: teamRoster, rosterCheck }).severity === 'questionable';
    const qKeys = pregame && lg === 'nfl' ? [...keys].filter((k) => expectedPresent(k) && isQ(k) && (roles.usage.get(k)?.touches || 0) > 0) : [];
    const vacate = new Map([...outKeys.map((k) => [k, 1]), ...qKeys.map((k) => { const ps = normPos(posOf(k)); return [k, 1 - (Q_PLAY[ps] ?? 0.7) * (Q_USE[ps] ?? 0.92)]; })]);
    const freedShare = { carry: [...vacate].reduce((a, [k, v]) => a + v * avgShare((rows.get(k) || []).slice(-3), 'carry'), 0), target: [...vacate].reduce((a, [k, v]) => a + v * avgShare((rows.get(k) || []).slice(-3), 'target'), 0) };
    // A questionable starting QB: backups averaged 9% fewer team passing yards (2023–25), so receivers' expected
    // yards scale by P(he plays) + P(he sits) × 0.911. His own props are void if he sits, so his projection is unchanged.
    const qbQ = roles.qb && isQ(roles.qb);
    const qbRecAdj = qbQ ? Q_PLAY.QB + (1 - Q_PLAY.QB) * 0.911 : 1;
    // Run/pass mix when a lead skill player is missing (scripts/absence_effects.mjs, nflverse 2022–25, situation-adjusted
    // pass rate vs the team's prior 3 games, minus the same change when he played): lead RB out → +1.3 pts pass rate
    // (−1.6 rushes, +1.3 attempts); WR1 out → −2.7 pts (they lean on the run). TE1 out wasn't significant, so it's ignored.
    // Weighted by the chance he's missing (1 if out, 1 − P(plays) × usage if questionable).
    const lead = (posK, kind) => [...keys].filter((k) => normPos(posOf(k)) === posK).map((k) => [k, avgShare((rows.get(k) || []).slice(-3), kind)]).sort((a, b) => b[1] - a[1])[0];
    const mixShift = [];
    if (pregame && lg === 'nfl') {
      for (const [posK, kind, eff, min] of [['RB', 'carry', 0.013, 0.35], ['WR', 'target', -0.027, 0.18]]) {
        const L = lead(posK, kind), w = L ? vacate.get(L[0]) || 0 : 0;
        if (L && L[1] >= min && w > 0) mixShift.push({ who: nameMap.get(L[0]) || posK + '1', pos: posK, delta: eff * w, weight: w });
      }
      const d = mixShift.reduce((a, m) => a + m.delta, 0);
      if (d) for (const s2 of STATES) passRate[s2] = clamp(passRate[s2] + d, 0.2, 0.85);
    }

    const players = [];
    const pInfo = {};
    for (const id of simIds) {
      const pos = normPos(posOf(id)) || 'WR';
      const r = rows.get(id) || [];
      const ww = contextWeights(id, teamTotals, keys, expectedPresent);
      const wOf = new Map(ww.map((x) => [x.eventId, x.w]));
      // Partial games (e.g. left early injured): unrepresentative of his role, so they barely count.
      const partial = partialGames(r, snaps ? snapsFor(snaps, t.abbr, nameMap.get(id)) : null);
      for (const [eid] of partial) if (wOf.has(eid)) wOf.set(eid, wOf.get(eid) * 0.05);
      const played = r.filter((x) => wOf.has(x.eventId));
      let sw = 0, sw2 = 0, wc = 0, wtc = 0, wt = 0, wtt = 0;
      const stC = {}, stT = {}, stTC = {}, stTT = {};
      for (const x of played) {
        const w = wOf.get(x.eventId);
        const tt = teamTotals.find((y) => y.eventId === x.eventId);
        sw += w; sw2 += w * w;
        wc += w * (x.stats.carries || 0); wtc += w * tt.teamCarries;
        wt += w * (x.stats.targets || 0); wtt += w * tt.teamTargets;
        for (const s of STATES) {
          stC[s] = (stC[s] || 0) + w * (x.state.carries[s] || 0); stTC[s] = (stTC[s] || 0) + w * tt.rushByState[s];
          stT[s] = (stT[s] || 0) + w * (x.state.targets[s] || 0); stTT[s] = (stTT[s] || 0) + w * tt.dbByState[s];
        }
      }
      const nEff = sw2 > 0 ? (sw * sw) / sw2 : 0;
      let carryShare = wtc > 0 ? wc / wtc : 0;
      let targetShare = wtt > 0 ? wt / wtt : 0;
      if (V12 && prior) {
        // Prior-season same-team share as a prior (fitted weight in games).
        const ps = prior.share(nameMap.get(id), t.abbr);
        if (ps.games >= 4) {
          const n = played.length;
          if (ps.target != null) targetShare = (n * targetShare + FIT.share.target.k * ps.target) / (n + FIT.share.target.k);
          if (ps.carry != null && pos === 'RB') carryShare = (n * carryShare + FIT.share.carry.k * ps.carry) / (n + FIT.share.carry.k);
        }
      }
      // Small floors: a rostered RB/receiver with no recent targets still has a non-zero chance
      // of one (the week-3 backtest showed 0–0 ranges were falsely certain). QBs get no targets.
      if (pos === 'RB') { carryShare = Math.max(carryShare, 0.03); targetShare = Math.max(targetShare, 0.025); }
      if (pos === 'WR' || pos === 'TE') targetShare = Math.max(targetShare, 0.03);
      if (pos === 'QB') targetShare = 0;
      const notes = [];
      for (const [, pg] of partial) notes.push(`Week ${pg.week} vs ${pg.opp} treated as a partial game (${pg.evidence}) — likely an early exit (injury); it barely counts toward his usage.`);
      const redistribution = []; // structured record of usage moved from absent teammates (audited by src/skeptic.js)
      // Redistribute usage vacated by unavailable key teammates (to the extent the sample does
      // not already reflect their absence).
      for (const [k, vw] of vacate) {
        if (k === id) continue;
        const kr = rows.get(k) || [];
        const kc = avgShare(kr.slice(-3), 'carry'), kt = avgShare(kr.slice(-3), 'target');
        const absentW = played.reduce((s, x) => s + (teamTotals.find((y) => y.eventId === x.eventId).appeared.has(k) ? 0 : wOf.get(x.eventId)), 0);
        const measured = sw > 0 ? absentW / sw : 0;
        const remaining = 1 - measured;
        const nm = nameMap.get(k) || 'teammate';
        if (remaining < 0.05) { notes.push(`Usage measured in games without ${nm} (${Math.round(measured * 100)}% of sample weight).`); continue; }
        const posK = normPos(posOf(k));
        // Who absorbs the absent player's carries: an absent RB's (or WR's) carries go to the other RBs only —
        // a QB's scrambles/designed runs don't rise because a back is out. An absent QB keeps the old QB+RB pool (×0.3).
        const carryPool = posK === 'QB' ? ['RB', 'QB'] : ['RB'];
        const groupC = simIds.filter((j) => j !== k && carryPool.includes(normPos(posOf(j))));
        const groupT = simIds.filter((j) => j !== k);
        const sumC = groupC.reduce((s, j) => s + avgShare((rows.get(j) || []).slice(-3), 'carry'), 0);
        const sumT = groupT.reduce((s, j) => s + avgShare((rows.get(j) || []).slice(-3), 'target'), 0);
        let addC = 0, addT = 0;
        if (kc > 0.03 && carryPool.includes(pos) && sumC > 0) addC = kc * remaining * (avgShare(r.slice(-3), 'carry') / sumC) * (posK === 'QB' ? 0.3 : 1);
        if (kt > 0.03 && sumT > 0) addT = kt * remaining * (avgShare(r.slice(-3), 'target') / sumT);
        addC *= vw; addT *= vw;
        if (addC + addT > 0.005) {
          carryShare += addC; targetShare += addT;
          redistribution.push({ fromId: k, from: nm, fromPos: posK, toPos: pos, addCarryShare: addC, addTargetShare: addT, questionable: vw < 1 || undefined });
          notes.push(vw < 1
            ? `+${fmtPct(addC)} carry / +${fmtPct(addT)} target share because ${nm} is questionable (${posK}s listed questionable sat ${Math.round((1 - (Q_PLAY[posK] ?? 0.7)) * 100)}% of the time in 2023–25 and played at ~${Math.round((Q_USE[posK] ?? 0.92) * 100)}% usage when active).`
            : `+${fmtPct(addC)} carry / +${fmtPct(addT)} target share from ${nm}'s absence (pro-rata redistribution; ${Math.round(measured * 100)}% of sample already without ${nm}).`);
        }
      }
      // State-specific shares, shrunk toward the overall share.
      const carryByState = {}, targetByState = {};
      for (const s of STATES) {
        const nC = stTC[s] || 0, nT = stTT[s] || 0;
        const rawC = nC > 0 ? stC[s] / nC : carryShare, rawT = nT > 0 ? stT[s] / nT : targetShare;
        // Keep the redistribution uplift: scale state rates by overall/baseline ratio.
        carryByState[s] = shrink(rawC, nC, carryShare, SHRINK.scenarioShare);
        targetByState[s] = shrink(rawT, nT, targetShare, SHRINK.scenarioShare);
      }
      // Normalize state shares so their script-weighted average equals the overall estimate.
      normalizeStates(carryByState, carryShare, weights); normalizeStates(targetByState, targetShare, weights);

      // Availability flags.
      const av = pregame ? availability(id, { injuries: injMap, roster: teamRoster, rosterCheck }) : { available: true, injury: null, severity: null };
      let dispersion = 1 * wx.dispersion;
      if (played.length <= 2) { dispersion *= 1.2; notes.push(`Small sample (${played.length} game${played.length === 1 ? '' : 's'} this season) — range widened.`); }
      if (av.severity === 'questionable') {
        dispersion *= 1.2;
        const use = lg === 'nfl' ? (Q_USE[pos] ?? 0.92) : 1;
        if (use < 1) { carryShare *= use; targetShare *= use; for (const s2 of STATES) { carryByState[s2] *= use; targetByState[s2] *= use; } }
        notes.push(lg === 'nfl' && Q_PLAY[pos] != null
          ? `Listed ${av.injury.status}${av.injury.type ? ` (${av.injury.type})` : ''}: ${pos}s listed questionable played ${Math.round(Q_PLAY[pos] * 100)}% of the time in 2023–25 and got ~${Math.round(Q_USE[pos] * 100)}% of their usual usage when active. Projection assumes he plays (props are void if he doesn't), at ${Math.round(use * 100)}% usage; range widened.`
          : `Listed ${av.injury.status}${av.injury.type ? ` (${av.injury.type})` : ''} — projection assumes he plays; range widened.`);
      }
      for (const m of mixShift) notes.push(`Team run/pass mix: lead ${m.pos} ${m.who} is ${m.weight >= 1 ? 'out' : 'questionable'}, so ${t.abbr}'s pass rate is ${m.delta > 0 ? 'raised' : 'lowered'} ${Math.abs(m.delta * 100).toFixed(1)} pts (teams without their ${m.pos === 'RB' ? 'lead RB ran 1.6 fewer times and threw 1.3 more' : 'WR1 passed 2.7 pts less than expected'}, 2022–25).`);
      if (qbQ && id !== roles.qb && lg === 'nfl') notes.push(`QB ${nameMap.get(roles.qb) || 'starter'} is questionable: QBs listed questionable played 43% of the time (2023–25), and backups averaged 9% fewer team passing yards, so his expected receiving yards are scaled ×${qbRecAdj.toFixed(3)}.`);
      const returning = lastGame && !lastGame.appeared.has(id) && played.length > 0 && expectedPresent(id);
      if (returning) {
        const ev2 = av.injury ? espn.restrictionEvidence(av.injury) : null;
        if (ev2) { carryShare *= 0.75; targetShare *= 0.75; for (const s of STATES) { carryByState[s] *= 0.75; targetByState[s] *= 0.75; } notes.push(`Returning from absence; workload reduced 25% on report evidence: "${ev2}"`); }
        else if (lg === 'cfb') { dispersion *= 1.3; notes.push('Not in the last game\'s box score — reason unknown (inferred from missing stats; no college injury feed). Treated as available with no workload cut; range widened.'); }
        else { dispersion *= 1.3; notes.push('Did not record a stat last game and is not ruled out on the current injury report. No public workload-restriction evidence, so no cut applied — range widened instead.'); }
      }
      const shareTrend = r.slice(-5).map((x) => ({ opp: x.oppAbbr, carry: x.share.carry, target: x.share.target, week: x.week, partial: partial.has(x.eventId) || undefined }));
      const rFull = r.filter((x) => !partial.has(x.eventId)); // role-change check ignores partial games
      if (rFull.length >= 3) {
        const last = rFull[rFull.length - 1], prev = rFull.slice(0, -1);
        const dC = (last.share.carry || 0) - avgShare(prev, 'carry'), dT = (last.share.target || 0) - avgShare(prev, 'target');
        const parts = [];
        if (Math.abs(dC) >= 0.15) parts.push(`${dC >= 0 ? '+' : ''}${fmtPct(dC)} carry share`);
        if (Math.abs(dT) >= 0.1) parts.push(`${dT >= 0 ? '+' : ''}${fmtPct(dT)} target share`);
        if (parts.length) { dispersion *= 1.1; notes.push(`Role change: last game ${parts.join(', ')} vs his earlier games — tracked, range widened slightly.`); }
      }

      // Efficiency (player → shrunk toward prior-season → league), then opponent + weather.
      const cur = sumStats(played.map((x) => x.stats));
      const pbp = played.reduce((a, x) => { if (x.pbp) for (const k of Object.keys(x.pbp)) a[k] = (a[k] || 0) + x.pbp[k]; return a; }, {});
      pInfo[id] = { pos, r, partial, played, cur, pbp, notes, redistribution, av, carryShare, targetShare, carryByState, targetByState, nEff, returning, shareTrend, dispersion };
      players.push({ id, pos, isCore: coreIds.includes(id), carryShare: carryByState, targetShare: targetByState, dropbackShare: id === roles.qb ? 1 : 0, dispersion });
    }

    // Prior-season logs for modeled players (efficiency priors + last-5 fill).
    const prevSeason = season - 1;
    const prevLogs = new Map();
    await Promise.all([...simIds, ...(roles.k ? [roles.k] : [])].map(async (id) => {
      const g = await espn.getGamelog(lg, id, prevSeason);
      if (displayIds.includes(id) || id === roles.k) prov.add(g.meta);
      prevLogs.set(id, espn.parseGamelog(g.data).filter((x) => /Regular|Postseason/i.test(x.seasonLabel || '') && Date.parse(x.date) < Date.parse(cutoff)));
    }));

    const effOut = {};
    for (const pl of players) {
      const info = pInfo[pl.id];
      const prev = sumStats((prevLogs.get(pl.id) || []).filter((x) => /Regular/i.test(x.seasonLabel)).map((x) => x.stats));
      const pos = info.pos;
      const lgYpc = pos === 'QB' ? P.ypc.QB : (P.ypc[pos] ?? P.ypc.RB);
      const kY = V12 ? FIT.eff.ypc.best.k : SHRINK.ypc, wPrev = V12 ? 1 : 0.5;
      const ypcPrior = shrink(prev.carries ? prev.rush_yds / prev.carries : null, (prev.carries || 0) * wPrev, lgYpc, kY);
      const ypcPlayer = shrink(info.cur.carries ? info.cur.rush_yds / info.cur.carries : null, info.cur.carries || 0, ypcPrior, kY);
      const oppYpcMult = clamp(ox.defense.rbYpcAllowedShrunk / P.ypc.RB, 0.8, 1.25);
      const ypcMult = Math.pow(oppYpcMult, pos === 'QB' ? 0.5 : 0.8);
      const ypc = ypcPlayer * ypcMult;
      const lgR10 = pos === 'QB' ? P.qbRun10 : P.run10, lgR20 = pos === 'QB' ? P.qbRun20 : P.run20;
      const r10p = shrink(info.pbp.carries ? info.pbp.r10 / info.pbp.carries : null, info.pbp.carries || 0, lgR10, SHRINK.explosiveRun);
      const r20p = shrink(info.pbp.carries ? info.pbp.r20 / info.pbp.carries : null, info.pbp.carries || 0, lgR20, SHRINK.explosiveRun * 1.5);
      const exR = ox.defense.explosiveRates;
      const m10 = clamp((pos === 'QB' ? exR.qbRun10.shrunk / P.qbRun10 : exR.rbRun10.shrunk / P.run10), 0.7, 1.45);
      const m20 = clamp((pos === 'QB' ? exR.qbRun20.shrunk / P.qbRun20 : exR.rbRun20.shrunk / P.run20), 0.6, 1.6);
      pl.run = makeRunDist(ypc, r10p * m10, r20p * m20);

      const cp = pos === 'QB' ? 'RB' : pos;
      // v1.2: yards/target shrinkage fitted at FIT.eff.ypt.best.k targets; split between catch rate
      // (targets) and yards/catch (≈ 65% of targets are catches).
      const kCr = V12 ? FIT.eff.ypt.best.k : SHRINK.catchRate, kYp = V12 ? FIT.eff.ypt.best.k * 0.65 : SHRINK.ypcatch, wP = V12 ? 1 : 0.5;
      const crPrior = shrink(prev.targets ? prev.receptions / prev.targets : null, (prev.targets || 0) * wP, P.catchRate[cp], kCr);
      const crPlayer = shrink(info.cur.targets ? info.cur.receptions / info.cur.targets : null, info.cur.targets || 0, crPrior, kCr);
      const oppPos = ox.defense.byPos[cp];
      const crMult = clamp(oppPos.catchRateShrunk / P.catchRate[cp], 0.88, 1.12) * wx.catchRate;
      pl.catchRate = clamp(crPlayer * crMult, 0.3, 0.95);
      const ypPrior = shrink(prev.receptions ? prev.rec_yds / prev.receptions : null, (prev.receptions || 0) * wP, P.yardsPerCatch[cp], kYp);
      const ypPlayer = shrink(info.cur.receptions ? info.cur.rec_yds / info.cur.receptions : null, info.cur.receptions || 0, ypPrior, kYp);
      const ypMult = Math.pow(clamp(oppPos.ypCatchShrunk / P.yardsPerCatch[cp], 0.8, 1.25), 0.8) * wx.passEff;
      const c20p = shrink(info.pbp.rec ? info.pbp.c20 / info.pbp.rec : null, info.pbp.rec || 0, P.catch20[cp], SHRINK.explosiveCatch);
      const c40p = shrink(info.pbp.rec ? info.pbp.c40 / info.pbp.rec : null, info.pbp.rec || 0, P.catch40[cp], SHRINK.explosiveCatch * 1.5);
      const mc20 = clamp(exR.catch20[cp].shrunk / P.catch20[cp], 0.7, 1.45), mc40 = clamp(exR.catch40[cp].shrunk / P.catch40[cp], 0.6, 1.6);
      pl.catch = makeCatchDist(ypPlayer * ypMult, c20p * mc20, c40p * mc40);
      pl.rushTd = shrink(info.cur.carries ? info.cur.rush_td / info.cur.carries : null, info.cur.carries || 0, P.rushTdPerCarry[pos === 'QB' ? 'QB' : 'RB'], SHRINK.tdRate);
      pl.recTd = shrink(info.cur.receptions ? info.cur.rec_td / info.cur.receptions : null, info.cur.receptions || 0, P.recTdPerCatch[cp], 40);
      const touches = (info.cur.carries || 0) + (info.cur.receptions || 0);
      pl.fumLost = shrink(touches ? (info.cur.fumbles_lost || 0) / touches : null, touches, P.fumbleLostPerTouch, 150) * wx.fumble;
      effOut[pl.id] = {
        ypc: { player: ypcPlayer, prior: ypcPrior, oppMult: ypcMult, final: ypc, sample: info.cur.carries || 0, prevSample: prev.carries || 0 },
        catchRate: { player: crPlayer, oppMult: crMult, final: pl.catchRate, sample: info.cur.targets || 0 },
        ypCatch: { player: ypPlayer, oppMult: ypMult, final: pl.catch.ypCatch, sample: info.cur.receptions || 0 },
        explosive: { run10: pl.run.p10, run20: pl.run.p20, catch20: pl.catch.c20, catch40: pl.catch.c40, oppRun10Mult: m10, oppRun20Mult: m20, oppCatch20Mult: mc20, oppCatch40Mult: mc40, playerRun10: r10p, playerCatch20: c20p },
      };
    }

    // Calibrate TD rates to the implied team total (pilot run), then full simulation.
    const seed = seedFrom(`${eventId}|${t.id}|${MODEL_VERSION}`);
    if (V12 && prior && roles.qb) {
      // QB efficiency anchor: team passing yards/attempt = QB YPA (prior season any team, heavily
      // shrunk; fitted m/k), blended 50/50 with the market-implied passing yards when a line exists.
      const Q = FIT.qbYpa, L = Q.league, qp = prior.qb(nameMap.get(roles.qb));
      const priorYpa = (qp.yds + Q.best.m * L) / (qp.att + Q.best.m);
      const qr = rows.get(roles.qb) || [];
      const ca = qr.reduce((a, r) => a + (r.stats.pass_att || 0), 0), cy = qr.reduce((a, r) => a + (r.stats.pass_yds || 0), 0);
      let ypaTarget = (cy + Q.best.k * priorYpa) / (ca + Q.best.k);
      if (implied && attTarget) {
        const M = FIT.market.passYds;
        const mktYds = M.atMean + M.perImpliedPoint * (impliedPts - M.meanImplied);
        ypaTarget = 0.5 * ypaTarget + 0.5 * (mktYds / attTarget);
      }
      const probe = simulateTeam(team, players, weights, { sims: 600, seed: seed ^ 0x5a5a });
      const qbOut = probe.out[roles.qb]?.stats;
      const simYpa = qbOut ? avg(qbOut.pass_yds) / Math.max(1, avg(qbOut.pass_att)) : null;
      if (simYpa) {
        const f = clamp(ypaTarget / simYpa, 0.75, 1.3);
        for (const pl of players) pl.catch = makeCatchDist(pl.catch.ypCatch * f, pl.catch.c20, pl.catch.c40);
        team.other.catch = makeCatchDist(team.other.catch.ypCatch * f, team.other.catch.c20, team.other.catch.c40);
        v12.qb = { priorAtt: qp.att, priorYpa: qp.att ? qp.yds / qp.att : null, curAtt: ca, ypaTarget, simYpaBefore: simYpa, scale: f };
      }
    }
    const pilot = simulateTeam(team, players, weights, { sims: 600, seed: seed ^ 0x9e37 });
    const pilotTd = avg(pilot.teamTds);
    const targetTd = Math.max(0.4, (impliedPts - 3 * fgPerGame) / 6.95);
    team.tdScale = clamp(pilotTd > 0 ? targetTd / pilotTd : 1, 0.4, 2.5);
    const sim = simulateTeam(team, players, weights, { sims: SIMS, seed });
    const kick = roles.k ? simulateKicker(sim.teamTds, { fgPerGame, xpRate: P.xpPerTd, seed: seed ^ 0x51 }) : null;

    // ---------- Assemble player cards ----------
    const cards = [];
    const mkCard = (id, role) => {
      const info = pInfo[id];
      const pos = id === roles.k ? 'K' : info.pos;
      const statKeys = STAT_LISTS[lg][pos] || STAT_LISTS[lg].WR;
      const simStats = id === roles.k ? kick : sim.out[id].stats;
      const rowsCur = id === roles.k ? kRows : info.r;
      const prevRows = prevLogs.get(id) || [];
      const nameN = nameMap.get(id);
      const propLines = props[id] || {};
      const oaLines = oddsApi.byName?.[normName(nameN)] || {};
      const stats = {};
      // fbm-1.4 pregame context — identical fields to the ledger's frozen blind_pred_context (src/blind.js).
      const isK = id === roles.k;
      const e14 = effOut[id];
      const ctx14 = {
        carries: isK ? null : avg(simStats.carries), targets: isK ? null : avg(simStats.targets), attempts: id === roles.qb ? avg(simStats.pass_att) : null,
        carryShare: isK ? null : info.carryShare, targetShare: isK ? null : info.targetShare, ypc: e14?.ypc?.final ?? null, catchRate: e14?.catchRate?.final ?? null, ypCatch: e14?.ypCatch?.final ?? null,
        teamPlays: team.plays, teamAtt: (V12 ? v12 : null)?.volume?.attTarget ?? null, expMargin, teamPts: impliedPts, qbYpa: (V12 ? v12 : null)?.qb?.ypaTarget ?? null, notes: isK ? [] : info.notes,
      };
      const usage14p = isK ? undefined : usageFromRows(info.r, ev?.week ?? null, snaps ? snapsFor(snaps, t.abbr, nameN) : null);
      const v14Applied = {};
      for (const k of statKeys) {
        let s;
        // v1.4: learned-from-every-miss correction where one beat v1.3 out of sample; otherwise v1.3 calibration.
        const m14 = simStats[k] && !STAT_DEFS[k].ratio ? v14For(lg, pos, k, role) : null;
        let arrK;
        if (m14) {
          const raw = summarize(simStats[k]);
          const r14 = applyV14(simStats[k], m14, buildX({ proj: raw.mean, p10: raw.p10, p90: raw.p90, week: ev?.week ?? null, role, ctx: ctx14, usage: usage14p }));
          arrK = r14.arr; v14Applied[k] = r14.correction;
        } else {
          const cal = calibrationFor(lg, pos, k);
          arrK = simStats[k] && !STAT_DEFS[k].ratio ? calibrateSample(simStats[k], cal) : simStats[k];
        }
        if (qbRecAdj < 1 && !isK && id !== roles.qb && k === 'rec_yds' && arrK?.length) arrK = Float64Array.from(arrK, (v) => v * qbRecAdj);
        if (k === 'ypc') s = ratioSummary(simStats.rush_yds, simStats.carries);
        else if (k === 'ypr') s = ratioSummary(simStats.rec_yds, simStats.receptions);
        else s = arrK ? summarize(arrK) : null;
        const hist = rowsCur.map((x) => x.stats[k]).filter((v) => v != null);
        const seasonAvg = STAT_DEFS[k].ratio ? ratioAvg(rowsCur, k) : (hist.length ? avg(hist) : null);
        const book = oaLines[k] || propLines[k] || null;
        const threshold = book?.line ?? (seasonAvg != null && !STAT_DEFS[k].ratio ? Math.floor(seasonAvg) + 0.5 : null);
        const arr = k === 'ypc' || k === 'ypr' ? null : arrK;
        const pOver = arr && threshold != null ? probOver(arr, threshold) : null;
        const bookImp = book?.overPrice != null ? { over: americanToProb(book.overPrice), under: americanToProb(book.underPrice), noVigOver: book.underPrice != null ? noVig(book.overPrice, book.underPrice)?.a : null } : null;
        // Raw (pre-calibration) simulation summary: the big-miss model was trained on raw projections/ranges.
        const rawS = simStats[k] && !STAT_DEFS[k].ratio ? summarize(simStats[k]) : null;
        stats[k] = {
          key: k, label: STAT_DEFS[k].label, short: STAT_DEFS[k].short,
          raw: rawS ? { proj: rawS.mean, p10: rawS.p10, p90: rawS.p90 } : null,
          proj: s ? round(s.mean, k) : null, p10: s?.p10 ?? null, p50: s?.p50 ?? null, p90: s?.p90 ?? null, quantiles: s?.quantiles || null,
          seasonAvg: seasonAvg != null ? round(seasonAvg, k) : null, seasonGames: rowsCur.length,
          last5: lastFive(rowsCur, prevRows, k, season),
          book: book ? { line: book.line, overPrice: book.overPrice ?? null, underPrice: book.underPrice ?? null, source: book.source, updated: book.updated || null, implied: bookImp } : null,
          threshold, thresholdSource: book ? 'book line' : threshold != null ? 'season average (no book line)' : null,
          probOver: pOver, fairOdds: pOver != null ? { over: probToAmerican(pOver), under: probToAmerican(1 - pOver) } : null,
          calibration: v14Applied[k] != null ? { version: 'fbm-1.4.0', correction: Math.round(v14Applied[k] * 100) / 100 } : 'fbm-1.3.0',
          available: s != null,
          unavailableReason: s == null ? 'Not modelled' : (k === 'targets' && lg === 'cfb' ? null : null),
        };
      }
      // Explanations
      const ex = explain({ lg, pos, id, info, eff: effOut[id], team, weights, sim, simStats, kick, fgPerGame, impliedPts, opp, cx, ox, wx, isK: id === roles.k });
      for (const k of Object.keys(stats)) stats[k].explain = ex[k] || ex._default || null;
      const byScript = id === roles.k ? null : scriptSplits(sim, id, pos);
      const withWithout = id === roles.k ? [] : splitsWithWithout(id, info.r, teamTotals, keys, nameMap, expectedPresent, statKeys[0], outKeys);
      const snapTrend = snaps ? (snapsFor(snaps, t.abbr, nameN) || []).slice(-5) : null;
      const av = id === roles.k ? (pregame ? availability(id, { injuries: injMap, roster: teamRoster, rosterCheck }) : { available: true }) : info.av;
      return {
        id, name: nameN, pos, role, team: t.abbr, headshot: headshots.get(id) || null, jersey: rosterById.get(id)?.jersey || null,
        primary: statKeys[0], statOrder: statKeys, compact: (COMPACT[pos] || statKeys).filter((k) => statKeys.includes(k)),
        stats, injury: av.injury ? { status: av.injury.status, type: av.injury.type, detail: av.injury.detail, date: av.injury.date, returnDate: av.injury.returnDate } : null,
        notes: id === roles.k ? [] : info.notes,
        opportunity: id === roles.k ? { fgPerGame, xpRate: P.xpPerTd, impliedPts } : {
          carries: avg(sim.out[id].stats.carries), targets: avg(sim.out[id].stats.targets), dropbacks: id === roles.qb ? avg(sim.out[id].stats.pass_att) : null,
          carryShare: info.carryShare, targetShare: info.targetShare, carryByState: info.carryByState, targetByState: info.targetByState,
          teamPlays: team.plays, teamPassRate: weighted(team.passRate, weights), effectiveGames: info.nEff,
        },
        efficiency: effOut[id] || null,
        byScript, withWithout, shareTrend: info?.shareTrend || null, snapTrend, usageTrend14: id === roles.k ? null : usage14p,
        redistribution: id === roles.k ? [] : info.redistribution,
        usageHistory: id === roles.k ? null : (() => { const g = (info.r || []).filter((x) => !info.partial?.has(x.eventId)); if (!g.length) return { games: 0 }; const a = (f) => g.reduce((s2, x) => s2 + (x.stats?.[f] || 0), 0) / g.length; const L = g[g.length - 1].stats || {}; return { games: g.length, partialGames: info.partial?.size || 0, carries: a('carries'), targets: a('targets'), passAtt: a('pass_att'), last: { carries: L.carries || 0, targets: L.targets || 0, passAtt: L.pass_att || 0 } }; })(),
        actual: null,
      };
    };
    const roleLabel = (id) => (id === roles.qb ? 'Starting QB' : roles.rbs.includes(id) ? `RB${roles.rbs.indexOf(id) + 1}` : roles.recs.includes(id) ? `Receiver ${roles.recs.indexOf(id) + 1}` : id === roles.extra?.id ? 'Additional' : 'Support');
    for (const id of displayIds) cards.push(mkCard(id, roleLabel(id)));
    const kCard = roles.k ? mkCard(roles.k, 'Kicker') : null;
    if (roles.extra) { const c = cards.find((x) => x.id === roles.extra.id); if (c) c.extraReason = roles.extra.reason; }

    teams[t.id] = {
      ...t, opponent: opp.abbr, impliedPts, expMargin, scriptWeights: weights, scriptSource,
      params: { plays: team.plays, passRate: team.passRate, sackRate: team.sackRate, intRate: team.intRate, tdScale: team.tdScale, pace, fgPerGame }, v12: V12 ? v12 : null,
      context: slimContext(cx), roles: { qbSource: roles.qbSource, notes: roles.notes, excluded: roles.excluded.map((e) => ({ ...e, name: nameMap.get(e.id) || e.id })) },
      cards, kicker: kCard, gamesUsed: teamTotals.map((g) => ({ eventId: g.eventId, date: g.date, opp: g.oppAbbr, week: g.week })),
      injuries: [...injMap.values()].filter((i) => (i.teamId || t.id) === t.id).map((i) => ({ ...i, severity: espn.injurySeverity(i.status), relevant: ['QB', 'RB', 'WR', 'TE', 'K', 'PK'].includes(i.pos) })),
    };
    // Supporting skill players are simulated anyway; build their cards so any of them with a posted
    // line can be considered for the OUTLIER PICK (they are only displayed if picked).
    teams[t.id]._support = supporting.map((id) => mkCard(id, 'Support'));
    teams[t.id]._ctx = { opp: opp.abbr, expMargin, impliedPts, freedShare };
    teams[t.id]._hist = teamTotals.length ? { targets: teamTotals.reduce((a, g) => a + (g.teamTargets || 0), 0) / teamTotals.length, carries: teamTotals.reduce((a, g) => a + (g.teamCarries || 0), 0) / teamTotals.length, passAtt: teamTotals.reduce((a, g) => a + (g.teamTargets || 0), 0) / teamTotals.length } : null;
  }

  // ---------- MATCHUP ENGINE (src/profiles.js): unit ratings, edges, player style + fit vs this defense ----------
  // Live NFL only: the blind harness may not read files that contain the target game.
  if (lg === 'nfl' && !blind && ev?.week != null) {
    try {
      const mctx = await buildContext(season, ev.week);
      const nvIds = await loadPlayerIds();
      const NV = { WSH: 'WAS', LAR: 'LA' };
      const nv = (a) => NV[a] || a;
      for (const t of Object.values(teams)) {
        const opp = Object.values(teams).find((x) => x !== t);
        const mine = mctx.teams[nv(t.abbr)], theirs = mctx.teams[nv(opp.abbr)];
        t.units = mine ? { ratings: mine.ratings, edges: unitEdges(mine, theirs), oppDef: theirs?.ratings?.def || null } : null;
        for (const c of [...t.cards, ...t._support, ...(t.kicker ? [t.kicker] : [])]) {
          const id = nvIds.byEspn.get(String(c.id));
          const pl = id ? mctx.players.get(id.gsis) : null;
          c.matchup = pl ? { style: pl.style, fit: theirs ? playerFit(pl, theirs.def, mctx.league) : null, explRel: pl.explRate / mctx.league.expl - 1, deepShare: pl.share.deepOut + pl.share.deepMid } : null;
        }
      }
    } catch (e) { for (const t of Object.values(teams)) t.units = { error: `matchup data unavailable: ${e.message}` }; }
  }

  // ---------- OUTLIER PICK (compares to posted lines; never alters projections) ----------
  const candidates = [];
  for (const t of Object.values(teams)) {
    for (const c of [...t.cards, ...t._support]) {
      for (const s of Object.values(c.stats)) {
        if (!s.available || !s.book || s.book.line == null) continue;
        candidates.push({
          playerId: c.id, name: c.name, team: t.abbr, opponent: t.opponent, pos: c.pos, role: c.role, stat: s.key, label: s.label, short: s.short,
          proj: s.proj, p10: s.p10, p50: s.p50, p90: s.p90, line: s.book.line, probOver: s.probOver, fairOdds: s.fairOdds,
          overPrice: s.book.overPrice, underPrice: s.book.underPrice, lineSource: s.book.source, lineUpdated: s.book.updated, lineOpen: null, retrievedAt: propsMeta.retrievedAt || null,
          seasonAvg: s.seasonAvg, seasonGames: s.seasonGames, last5: (s.last5 || []).map((x) => x.value),
          injuryStatus: c.injury?.status || null, returning: (c.notes || []).some((n) => /absence|last game's box score|Did not record a stat last game/i.test(n)),
          roleChange: (c.notes || []).some((n) => /^Role change/.test(n)),
          notes: (c.notes || []).filter((n) => !/^Small sample/.test(n)),
          opportunityText: c.opportunity?.carries != null ? `Projected opportunity: ${c.opportunity.carries.toFixed(1)} carries (${fmtPct(c.opportunity.carryShare)} share), ${c.opportunity.targets.toFixed(1)} targets (${fmtPct(c.opportunity.targetShare)} share)${c.opportunity.dropbacks != null ? `, ${c.opportunity.dropbacks.toFixed(1)} pass attempts` : ''}.` : null,
          bigMiss: BIG[s.key] ? bigMissProbs({ stat: s.key, line: s.book.line, proj: s.raw?.proj ?? s.proj, p10: s.raw?.p10 ?? s.p10, p90: s.raw?.p90 ?? s.p90,
            recent: (s.last5 || []).filter((x) => String(x.season) === String(season)).map((x) => x.value ?? 0),
            freed: /rush|carries/.test(s.key) ? t._ctx.freedShare?.carry : t._ctx.freedShare?.target,
            share: c.opportunity?.targetShare ?? c.opportunity?.carryShare ?? 0, expMargin: t._ctx.expMargin, teamPts: t._ctx.impliedPts,
            explRel: c.matchup?.explRel ?? 0, deepShare: c.matchup?.deepShare ?? 0, fit: c.matchup?.fit || null, oppUnit: oppUnitFor(s.key, c.pos, t.units?.oppDef) }) : null,
          expVolume: c.opportunity?.carries != null ? { carries: c.opportunity.carries, targets: c.opportunity.targets, attempts: c.opportunity.dropbacks } : null,
          explain: s.explain, isDisplayed: t.cards.includes(c),
        });
      }
    }
  }
  // SKEPTIC: independent sanity audit of every projected player (incl. supporting players). A high-severity
  // finding means a likely logic error, so that player can't be the OUTLIER PICK.
  const withSupport = (t) => ({ ...t, cards: [...t.cards, ...(t._support || [])] });
  const skepticReport = skeptic({ league: lg, season, home: withSupport(teams[home.id]), away: withSupport(teams[away.id]) });
  const vetoed = new Set(skepticReport.vetoed);
  const outlier = selectOutlier(candidates.map((c) => (vetoed.has(c.playerId) ? { ...c, skepticVeto: (skepticReport.findings.find((f) => f.playerId === c.playerId && f.severity === 'high') || {}).message } : c)));
  // WHY: the reasoning behind the pick (and the top of the shortlist), in plain English (src/why.js).
  const cardById = new Map(); for (const t of Object.values(teams)) for (const c of [...t.cards, ...t._support]) cardById.set(c.id, { card: c, team: t });
  const explainPick = (p) => {
    const ref = cardById.get(p.playerId); if (!ref) return [];
    const edge = (ref.team.units?.edges || []).find((e) => e.label === edgeKeyFor(p.pos, p.stat));
    const all = [...ref.team.cards, ...(ref.team._support || [])];
    const teamProj = { targets: all.reduce((a, x) => a + (x.opportunity?.targets || 0), 0), carries: all.reduce((a, x) => a + (x.opportunity?.carries || 0), 0) };
    teamProj.passAtt = teamProj.targets;
    return whyPick({ ...p, card: ref.card, teamHist: ref.team._hist, teamProj, expMargin: ref.team.expMargin, scriptWeights: ref.team.scriptWeights, impliedPts: ref.team.impliedPts, unitEdge: edge || null });
  };
  if (outlier.pick) {
    const p = outlier.pick, kind = p.direction === 'OVER' ? 'boom' : 'bust';
    const drivers = p.bigMiss ? topDrivers(kind, p.bigMiss.x, p.stat) : [];
    p.why = [
      { stance: 'info', text: `Why this is the backtested pick: ${Math.round(p.bigProb * 100)}% chance the line misses by ${p.bigText} — ${p.lift.toFixed(1)}× the usual ${Math.round(p.baseProb * 100)}% for ${p.label.toLowerCase()} lines. Chance it misses big the other way: ${Math.round(p.againstProb * 100)}%.${drivers.length ? ` Biggest drivers: ${drivers.join(', ')}.` : ''}` },
      ...explainPick(p),
    ];
  }
  for (const c of outlier.shortlist || []) c.why = explainPick(c);
  // Outliers are explained from the side of the GAP (model vs line), not the big-miss direction.
  for (const c of [...(outlier.outliers || []), ...(outlier.leans || [])]) c.why = explainPick({ ...c, direction: c.gapDir });
  if (outlier.pick) {
    outlier.pick.retrievedAt = propsMeta.retrievedAt || null;
    outlier.pick.mode = mode;
    // An eligible supporting player becomes an extra displayed card, clearly labelled.
    if (!outlier.pick.isDisplayed) {
      for (const t of Object.values(teams)) {
        const c = t._support.find((x) => x.id === outlier.pick.playerId);
        if (c) { c.role = 'Outlier pick'; c.extraReason = `Outlier pick: ${outlier.pick.direction} ${outlier.pick.line} ${outlier.pick.short}`; t.cards.push(c); }
      }
    }
  }

  // Ledger rows: every displayed card (incl. kicker and an outlier-pick card).
  for (const t of Object.values(teams)) {
    const { opp: oppAbbr, expMargin, impliedPts } = t._ctx;
    for (const c of [...t.cards, ...(t.kicker ? [t.kicker] : [])]) for (const s of Object.values(c.stats)) {
      if (!s.available) continue;
      flat.push({ playerId: c.id, playerName: c.name, team: t.abbr, opponent: oppAbbr, position: c.pos, role: c.role, stat: s.key, projection: s.proj, p10: s.p10, p50: s.p50, p90: s.p90, threshold: s.threshold, thresholdSource: s.thresholdSource, probOver: s.probOver, fairOver: s.fairOdds?.over ?? null, bookLine: s.book?.line ?? null, bookOver: s.book?.overPrice ?? null, bookUnder: s.book?.underPrice ?? null, bookSource: s.book?.source ?? null, bookUpdated: s.book?.updated ?? null, opportunity: c.opportunity, efficiency: c.efficiency ? { ypc: c.efficiency.ypc.final, catchRate: c.efficiency.catchRate.final, ypCatch: c.efficiency.ypCatch.final } : null, expMargin, impliedPts });
    }
    delete t._support; delete t._ctx; delete t._hist;
  }

  // College emphasis: RB matchup upside.
  let rbUpside = null;
  if (lg === 'cfb') {
    for (const t of Object.values(teams)) for (const c of t.cards) {
      if (c.pos !== 'RB') continue;
      const s = c.stats.rush_yds;
      const e = c.efficiency?.explosive;
      if (!s || !e) continue;
      const score = s.p90 * Math.sqrt(e.oppRun10Mult * e.oppRun20Mult);
      if (!rbUpside || score > rbUpside.score) rbUpside = { playerId: c.id, name: c.name, team: t.abbr, score, p90: s.p90, oppRun10Mult: e.oppRun10Mult, oppRun20Mult: e.oppRun20Mult };
    }
  }

  // Actual results for completed games (displayed alongside projections).
  if (hdr.completed) {
    const box = espn.parseBoxscore(sum);
    const plays = espn.extractPlays(sum);
    for (const t of Object.values(teams)) for (const c of [...t.cards, ...(t.kicker ? [t.kicker] : [])]) {
      const r = box.get(c.id);
      if (r) { const st = finalizeDerived({ ...r.stats }); c.actual = st; }
      else c.actual = { dnp: true };
    }
    void plays;
  }

  const lineProxy = {};
  for (const t of [home, away]) lineProxy[t.id] = lg === 'cfb' && !blind ? await cfbdLineYards(t.short || t.name, season, prov) : { enabled: false };

  return {
    league: lg, leagueLabel: LEAGUES[lg].label, eventId: String(eventId), season, week: ev?.week ?? sum?.header?.week ?? null,
    kickoff, status: { state, detail: blind ? 'market-blind historical' : (sum.header?.competitions?.[0]?.status?.type?.shortDetail || sum.header?.competitions?.[0]?.status?.type?.detail), completed: hdr.completed }, mode,
    modelVersion: MODEL_VERSION, generatedAt: new Date().toISOString(), cutoff,
    home: teams[home.id], away: teams[away.id],
    odds: odds ? { ...odds, meta: oddsMeta } : null, implied, mlNoVig,
    venue, weather, weatherEffects: wx.notes,
    props: propsMeta, oddsApi: { enabled: oddsApi.enabled, error: oddsApi.error || null },
    injuryNote, outlier, skeptic: skepticReport, rbUpside, lineProxy, blindAudit, lineBaseExcluded: lineBase.excludedUnverified ?? null,
    lineGrades: { away: lineGrades[away.id], home: lineGrades[home.id], baseline: { source: lineBase.source, measured: lineBase.measured, games: lineBase.games, teams: lineBase.teams, mean: lineBase.mean, sd: lineBase.sd }, method: LINE_METHOD },
    baselines: { source: B.source, measured: B.measured },
    disclosures: disclosures(lg, pregame, propsMeta, oddsApi, weather),
    sources: prov.list(), latestInput: prov.latest(),
    projections: flat, sims: SIMS,
  };
}

// ---------- helpers ----------
function avg(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; }
/**
 * Games that don't represent a player's role: he barely played (left early — usually an injury) or was a late
 * scratch-like cameo. Snap counts when available (nflverse/PFR): snap% < 50% of his median with a normal median
 * (>= 35%). Without snaps: touches < 40% of his median touches with a median of 8+. Returns Map eventId -> info.
 */
export function partialGames(rows, snapSeries) {
  const out = new Map();
  if (!rows || rows.length < 2) return out;
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor((b.length - 1) / 2)]; };
  if (snapSeries && snapSeries.length >= 2) {
    const byWeek = new Map(snapSeries.map((s) => [s.week, s.pct]));
    const pcts = rows.map((x) => byWeek.get(x.week)).filter((v) => v != null);
    if (pcts.length >= 2) {
      const m = med(pcts);
      if (m >= 0.35) for (const x of rows) { const p = byWeek.get(x.week); if (p != null && p < 0.5 * m) out.set(x.eventId, { week: x.week, opp: x.oppAbbr, evidence: `${Math.round(p * 100)}% of snaps vs his usual ${Math.round(m * 100)}%` }); }
      return out;
    }
  }
  const touches = (x) => (x.stats?.carries || 0) + (x.stats?.targets || 0) + (x.stats?.pass_att || 0);
  const m = med(rows.map(touches));
  if (m >= 8) for (const x of rows) if (touches(x) < 0.4 * m) out.set(x.eventId, { week: x.week, opp: x.oppAbbr, evidence: `${touches(x)} touches vs his usual ${m}` });
  return out;
}

function avgShare(rows, k) { const v = rows.map((x) => x.share?.[k]).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
function fmtPct(x) { return x == null ? '—' : `${Math.round(x * 1000) / 10}%`; }
function weighted(obj, w) { let s = 0, t = 0; for (const k of Object.keys(w)) { s += (obj[k] ?? 0) * w[k]; t += w[k]; } return t ? s / t : null; }
function round(x, k) { if (x == null) return null; const d = STAT_DEFS[k]?.ratio || ['pass_td', 'rush_td', 'rec_td', 'ints', 'fumbles', 'fumbles_lost', 'tds', 'fg_made', 'xp_made'].includes(k) ? 100 : 10; return Math.round(x * d) / d; }
function ratioAvg(rows, k) {
  const [n, d] = k === 'ypc' ? ['rush_yds', 'carries'] : ['rec_yds', 'receptions'];
  let a = 0, b = 0; for (const r of rows) { a += r.stats[n] || 0; b += r.stats[d] || 0; }
  return b ? a / b : null;
}
function sumStats(list) {
  const o = {};
  for (const s of list) for (const [k, v] of Object.entries(s)) if (typeof v === 'number') o[k] = (o[k] || 0) + v;
  return o;
}
function normalizeStates(byState, overall, weights) {
  const w = weighted(byState, weights);
  if (!w || !overall) return;
  const k = overall / w;
  for (const s of Object.keys(byState)) byState[s] *= k;
}
function lastFive(cur, prev, k, season) {
  const pick = (r, tag) => {
    let v = r.stats[k];
    if (k === 'ypc') v = r.stats.carries ? r.stats.rush_yds / r.stats.carries : null;
    if (k === 'ypr') v = r.stats.receptions ? r.stats.rec_yds / r.stats.receptions : null;
    if (k === 'tds') v = r.stats.rush_td != null || r.stats.rec_td != null ? (r.stats.rush_td || 0) + (r.stats.rec_td || 0) : null;
    return { date: r.date, opp: r.oppAbbr || r.opp, value: v == null ? null : Math.round(v * 10) / 10, season: tag, atVs: r.atVs || (r.isHome === false ? '@' : r.isHome ? 'vs' : null) };
  };
  const out = cur.slice(-5).map((r) => pick(r, String(season)));
  if (out.length < 5) {
    const need = 5 - out.length;
    out.unshift(...prev.slice(-need).map((r) => pick(r, String(season - 1))));
  }
  return out;
}
function scriptSplits(sim, id, pos) {
  const acc = {};
  const st = sim.out[id].stats;
  const prim = pos === 'QB' ? 'pass_yds' : pos === 'RB' ? 'rush_yds' : 'rec_yds';
  for (let i = 0; i < sim.sims; i++) {
    const s = sim.scriptOf[i];
    const a = (acc[s] ||= { n: 0, carries: 0, targets: 0, primary: 0, rush_yds: 0, rec_yds: 0 });
    a.n++; a.carries += st.carries[i]; a.targets += st.targets[i]; a.primary += st[prim][i]; a.rush_yds += st.rush_yds[i]; a.rec_yds += st.rec_yds[i];
  }
  const out = {};
  for (const s of STATES) {
    const a = acc[s];
    if (!a || a.n / sim.sims < 0.03) continue;
    out[s] = { label: SCRIPT_LABEL[s], share: a.n / sim.sims, carries: a.carries / a.n, targets: a.targets / a.n, primary: a.primary / a.n, rush_yds: a.rush_yds / a.n, rec_yds: a.rec_yds / a.n };
  }
  return out;
}
function splitsWithWithout(id, rows, teamTotals, keys, nameMap, expectedPresent, primary, outKeys) {
  const res = [];
  for (const k of keys) {
    if (k === id) continue;
    const withG = [], withoutG = [];
    for (const r of rows) {
      const t = teamTotals.find((x) => x.eventId === r.eventId);
      (t.appeared.has(k) ? withG : withoutG).push(r);
    }
    const statusThisWeek = expectedPresent(k) ? 'expected active' : 'OUT/unavailable';
    const relevant = withoutG.length > 0 || !expectedPresent(k);
    if (!relevant) continue;
    const m = (arr) => (arr.length ? {
      n: arr.length, primary: avg(arr.map((r) => r.stats[primary] || 0)),
      carryShare: avg(arr.map((r) => r.share.carry || 0)), targetShare: avg(arr.map((r) => r.share.target || 0)),
    } : { n: 0 });
    res.push({ teammateId: k, teammate: nameMap.get(k) || k, statusThisWeek, isOut: outKeys.includes(k), with: m(withG), without: m(withoutG), stat: primary });
  }
  return res;
}
function slimContext(c) {
  const o = c.offense, d = c.defense;
  return {
    games: c.games,
    offense: { playsPerGame: o.playsPerGame, pointsPerGame: o.pointsPerGame, passRates: Object.fromEntries(Object.entries(o.passRates).map(([k, v]) => [k, { raw: v.raw, n: v.n, shrunk: v.shrunk }])), earlyDownNeutralPassRate: o.earlyDownNeutralPassRate, earlyDownN: o.earlyDownN, sackRate: o.sackRate, dropbacks: o.dropbacks, rushSuccess: o.rushSuccess, rushSuccessN: o.rushSuccessN, ypc: o.ypc, rushes: o.rushes },
    defense: { playsFacedPerGame: d.playsFacedPerGame, pointsAllowedPerGame: d.pointsAllowedPerGame, rbYpcAllowed: d.rbYpcAllowed, rbRuns: d.rbRuns, sackRate: d.sackRate, dropbacksFaced: d.dropbacksFaced, rushSuccessAllowed: d.rushSuccessAllowed, rushSuccessN: d.rushSuccessN, cmpAllowed: d.cmpAllowed, attFaced: d.attFaced, byPos: d.byPos, explosiveRates: d.explosiveRates },
  };
}

function explain({ lg, pos, id, info, eff, team, weights, sim, simStats, kick, fgPerGame, impliedPts, opp, cx, ox, wx, isK }) {
  const scriptTxt = Object.entries(weights).filter(([, w]) => w >= 0.05).map(([s, w]) => `${SCRIPT_LABEL[s].toLowerCase()} ${Math.round(w * 100)}%`).join(', ');
  const wxTxt = wx.notes.length ? ` Weather: ${wx.notes.join('; ')}.` : '';
  if (isK) {
    const tds = avg(sim.teamTds);
    const t = `Book-implied ${impliedPts.toFixed(1)} team points → ${tds.toFixed(1)} TDs simulated × XP rate; ${fgPerGame.toFixed(2)} FG/game (kicker's season rate shrunk to league, scaled by implied points).`;
    return { _default: t };
  }
  const car = avg(simStats.carries), tgt = avg(simStats.targets);
  const e = eff;
  const oppAbbr = opp.abbr;
  const rush = `Opportunity: ${car.toFixed(1)} carries (${fmtPct(info.carryShare)} share of ~${(team.plays * (1 - weighted(team.passRate, weights))).toFixed(0)} team rushes). Efficiency: ${e.ypc.final.toFixed(2)} YPC (player ${e.ypc.player.toFixed(2)} after shrinkage on ${e.ypc.sample} carries; ${oppAbbr} run D ×${e.ypc.oppMult.toFixed(2)}). Script mix: ${scriptTxt}. Explosive 10+/20+ per carry ${fmtPct(e.explosive.run10)}/${fmtPct(e.explosive.run20)} (opp. allowed ×${e.explosive.oppRun10Mult.toFixed(2)}/×${e.explosive.oppRun20Mult.toFixed(2)} — shapes the range, not the mean).`;
  const rec = `Opportunity: ${tgt.toFixed(1)} targets (${fmtPct(info.targetShare)} target share). Efficiency: ${fmtPct(e.catchRate.final)} catch rate, ${e.ypCatch.final.toFixed(1)} yds/catch (player ${e.ypCatch.player.toFixed(1)} shrunk on ${e.ypCatch.sample} catches; ${oppAbbr} vs ${pos === 'QB' ? 'RB' : pos} ×${e.ypCatch.oppMult.toFixed(2)}). 20+/40+ per catch ${fmtPct(e.explosive.catch20)}/${fmtPct(e.explosive.catch40)}. Script mix: ${scriptTxt}.${wxTxt}`;
  if (pos === 'QB') {
    const att = avg(simStats.pass_att);
    const pass = `Opportunity: ${att.toFixed(1)} attempts = ${team.plays.toFixed(0)} plays × ${fmtPct(weighted(team.passRate, weights))} pass rate (script-weighted) × (1 − ${fmtPct(team.sackRate)} sack rate). Efficiency comes from the simulated receivers (catch rates × yds/catch vs ${oppAbbr}); INT rate ${fmtPct(team.intRate)} per attempt. Script mix: ${scriptTxt}.${wxTxt}`;
    return { pass_yds: pass, completions: pass, pass_att: pass, pass_td: `${pass} TD rates calibrated so simulated team TDs match the book-implied ${impliedPts.toFixed(1)} points.`, ints: pass, long_cmp: pass, rush_yds: rush, rush_td: rush, fumbles: `Sack-fumble (model prior 10%/sack) and carry fumble rates; ${fmtPct(team.sackRate)} sack rate vs ${oppAbbr}.`, fumbles_lost: 'Fumble rates shrunk to league; ~45% of QB fumbles lost (model prior).' };
  }
  return { rush_yds: rush, carries: rush, long_rush: rush, ypc: rush, rush_td: `${rush} TD rate calibrated to implied ${impliedPts.toFixed(1)} team points.`, rec_yds: rec, targets: rec, receptions: rec, long_rec: rec, ypr: rec, rec_td: `${rec} TD rate calibrated to implied team points.`, tds: `Rush + receiving TDs; team TD rate calibrated to implied ${impliedPts.toFixed(1)} points.`, fumbles_lost: 'Per-touch fumble-lost rate shrunk heavily toward league average.' };
}

function disclosures(lg, pregame, propsMeta, oddsApi, weather) {
  const d = [
    'OL/DL: shown as ESTIMATED UNIT GRADES from play-by-play proxies (method on page). Individual lineman grades and pressure data are not available from free sources.',
    'Coaching changes are not tracked automatically; play-calling tendencies are measured from current-season play-by-play only.',
    'Model probabilities are simulation outputs, NOT validated/calibrated probabilities. See the Ledger tab for realized accuracy.',
    'Play attribution (who carried/was targeted) is parsed from ESPN play text; attribution coverage is shown per defense.',
  ];
  if (lg === 'cfb') {
    d.push('College targets are derived from play-by-play text (ESPN college box scores do not publish targets).');
    d.push('College: no depth chart or injury report is available from ESPN; roles and availability are inferred from box-score usage.');
    d.push('College league baselines are configured priors, not measured league-wide rates.');
  }
  if (!propsMeta.available) d.push(`Player prop lines: ${propsMeta.reason || 'unavailable'}.`);
  else if (!oddsApi.enabled) d.push('Player prop PRICES unavailable: the free ESPN feed publishes lines only. Set ODDS_API_KEY to add prices.');
  if (!weather.available) d.push(`Weather: ${weather.reason}.`);
  if (!pregame) d.push('Retrospective view: projections are rebuilt with a strict pre-kickoff data cutoff, but injury reports/depth charts are unavailable historically and are not used.');
  return d;
}
