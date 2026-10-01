// MATCHUP ENGINE: player styles, defensive profiles by unit/zone, 0–100 unit ratings, and player-vs-defense fit.
// Built from nflverse play-by-play (src/pbp.js) as of a given week: current-season plays strictly before that
// week plus the previous season at reduced weight (PRIOR_W), all shrunk toward league averages.
//
// Free data has no coverage assignments (who covered whom), so "player vs player" is approximated by FIELD
// ZONE, which maps onto defensive position groups:
//   deep (air ≥ 15) middle/outside  ≈ safeties / CBs on vertical routes
//   short+intermediate outside      ≈ cornerbacks
//   short+intermediate middle       ≈ linebackers / nickel / safeties underneath
// plus who gets targeted (WR / TE / RB) and, from last season's FTN charting, man-vs-zone coverage.
import { loadPlays, loadParticipation, loadPlayerIds } from './pbp.js';

export const PRIOR_W = 0.25;            // a previous-season play counts as 1/4 of a current one
export const ZONES = ['deepOut', 'deepMid', 'interOut', 'interMid', 'shortOut', 'shortMid'];
export const ZONE_LABEL = { deepOut: 'deep outside', deepMid: 'deep middle', interOut: 'intermediate outside', interMid: 'intermediate middle', shortOut: 'short outside', shortMid: 'short middle' };
const K = { zone: 60, pos: 80, run: 120, rush: 300, cov: 150, playerShare: 15, playerRun: 40, playerExpl: 60, playerMZ: 25 };

export function zoneOf(p) {
  if (p.ay == null || !p.pl) return null;
  const mid = p.pl === 'middle';
  if (p.ay >= 15) return mid ? 'deepMid' : 'deepOut';
  if (p.ay >= 8) return mid ? 'interMid' : 'interOut';
  return mid ? 'shortMid' : 'shortOut';
}
// Inside = between the tackles (middle, guard or tackle gap); outside = to the edge (end).
export const runSideOf = (p) => (p.rl === 'middle' || p.rg === 'guard' || p.rg === 'tackle' ? 'inside' : p.rl ? 'outside' : null);
const shrink = (sum, n, prior, k) => (n + k > 0 ? (sum + k * prior) / (n + k) : prior);

// ---------------------------------------------------------------------------------------------------------
const cache = new Map();

/**
 * Everything the matchup engine knows going into `week` of `season` (no play from week >= `week` of `season`).
 * Returns { league, teams: {abbr: {off, def, ratings}}, players: Map(gsis -> profile), meta }.
 */
export async function buildContext(season, week) {
  const key = `${season}|${week}`;
  if (cache.has(key)) return cache.get(key);
  const [cur, prev, prevPart, ids] = await Promise.all([loadPlays(season), loadPlays(season - 1).catch(() => []), loadParticipation(season - 1).catch(() => null), loadPlayerIds()]);
  const pos = (g) => { const p = ids.posByGsis.get(g); return p === 'FB' ? 'RB' : p; };
  const plays = [];
  for (const p of cur) if (!p.post && p.w < week) plays.push([p, 1, null]);
  for (const p of prev) plays.push([p, PRIOR_W, prevPart?.get(`${p.g}|${p.p}`) || null]);

  // ---------- league + team accumulators ----------
  const acc = () => ({ n: 0, s: 0 });
  const add = (a, w, v) => { a.n += w; a.s += w * v; };
  const L = { zone: {}, pos: {}, run: { inside: acc(), outside: acc() }, expl: acc(), rush: acc(), dropEPA: acc(), rushEPA: acc(), mz: { man: acc(), zone: acc() }, manRate: acc() };
  for (const z of ZONES) L.zone[z] = acc();
  for (const ps of ['WR', 'TE', 'RB']) L.pos[ps] = acc();
  const T = {};
  const team = (abbr) => (T[abbr] ||= {
    def: { zone: Object.fromEntries(ZONES.map((z) => [z, acc()])), pos: { WR: acc(), TE: acc(), RB: acc() }, run: { inside: acc(), outside: acc() }, expl: acc(), rush: acc(), dropEPA: acc(), rushEPA: acc(), man: acc(), box: acc() },
    off: { zone: Object.fromEntries(ZONES.map((z) => [z, acc()])), pos: { WR: acc(), TE: acc(), RB: acc() }, run: { inside: acc(), outside: acc() }, expl: acc(), prot: acc(), dropEPA: acc(), rushEPA: acc() },
  });
  const P = new Map();
  const player = (g) => { if (!P.has(g)) P.set(g, { tg: acc(), zone: Object.fromEntries(ZONES.map((z) => [z, 0])), zn: 0, man: acc(), zoneCov: acc(), car: acc(), inside: 0, sideN: 0, expl: acc(), routes: {}, team: null, lastW: -1 }); return P.get(g); };

  for (const [p, w, part] of plays) {
    const D = team(p.d), O = team(p.o);
    if (p.t === 'P') {
      // Dropback-level: pass rush / protection and EPA.
      const pressured = p.sk || p.hit || (part?.pres === 1) ? 1 : 0;
      add(L.rush, w, pressured); add(D.def.rush, w, pressured); add(O.off.prot, w, pressured);
      if (p.epa != null) { add(L.dropEPA, w, p.epa); add(D.def.dropEPA, w, p.epa); add(O.off.dropEPA, w, p.epa); }
      if (part?.mz) { add(D.def.man, w, part.mz === 'man' ? 1 : 0); add(L.manRate, w, part.mz === 'man' ? 1 : 0); }
      if (!p.rec || p.sk) continue;
      // Target-level: yards per target (incompletions count as 0).
      const z = zoneOf(p), rp = pos(p.rec), y = p.y;
      if (z) { add(L.zone[z], w, y); add(D.def.zone[z], w, y); add(O.off.zone[z], w, y); }
      if (L.pos[rp]) { add(L.pos[rp], w, y); add(D.def.pos[rp], w, y); add(O.off.pos[rp], w, y); }
      if (part?.mz) add(L.mz[part.mz], w, y);
      const pl = player(p.rec);
      add(pl.tg, w, y);
      if (z) { pl.zone[z] += w; pl.zn += w; }
      if (part?.mz === 'man') add(pl.man, w, y); else if (part?.mz === 'zone') add(pl.zoneCov, w, y);
      if (part?.route) pl.routes[part.route] = (pl.routes[part.route] || 0) + w;
      if (w === 1 && p.w >= pl.lastW) { pl.team = p.o; pl.lastW = p.w; } else if (!pl.team) pl.team = p.o;
    } else if (p.ru && !p.scr) {
      const side = runSideOf(p), ex = p.y >= 10 ? 1 : 0;
      add(L.expl, w, ex); add(D.def.expl, w, ex); add(O.off.expl, w, ex);
      if (p.epa != null) { add(L.rushEPA, w, p.epa); add(D.def.rushEPA, w, p.epa); add(O.off.rushEPA, w, p.epa); }
      if (side) { add(L.run[side], w, p.y); add(D.def.run[side], w, p.y); add(O.off.run[side], w, p.y); }
      if (part?.box != null) add(D.def.box, w, part.box);
      const pl = player(p.ru);
      add(pl.car, w, p.y); add(pl.expl, w, ex);
      if (side) { pl.sideN += w; if (side === 'inside') pl.inside += w; }
      if (w === 1 && p.w >= pl.lastW) { pl.team = p.o; pl.lastW = p.w; } else if (!pl.team) pl.team = p.o;
    }
  }

  const lg = (a) => (a.n ? a.s / a.n : 0);
  const league = {
    zone: Object.fromEntries(ZONES.map((z) => [z, lg(L.zone[z])])), zoneShare: null,
    pos: { WR: lg(L.pos.WR), TE: lg(L.pos.TE), RB: lg(L.pos.RB) },
    run: { inside: lg(L.run.inside), outside: lg(L.run.outside) }, expl: lg(L.expl), rush: lg(L.rush),
    dropEPA: lg(L.dropEPA), rushEPA: lg(L.rushEPA), mz: { man: lg(L.mz.man), zone: lg(L.mz.zone) }, manRate: lg(L.manRate),
  };
  league.insideShare = L.run.inside.n + L.run.outside.n > 0 ? L.run.inside.n / (L.run.inside.n + L.run.outside.n) : 0.6;
  const zt = ZONES.reduce((s, z) => s + L.zone[z].n, 0);
  league.zoneShare = Object.fromEntries(ZONES.map((z) => [z, zt ? L.zone[z].n / zt : 1 / ZONES.length]));

  // ---------- team profiles (shrunk) ----------
  const teams = {};
  for (const [abbr, t] of Object.entries(T)) {
    const s = (a, prior, k) => shrink(a.s, a.n, prior, k);
    teams[abbr] = {
      def: {
        zone: Object.fromEntries(ZONES.map((z) => [z, s(t.def.zone[z], league.zone[z], K.zone)])),
        pos: Object.fromEntries(['WR', 'TE', 'RB'].map((q) => [q, s(t.def.pos[q], league.pos[q], K.pos)])),
        run: { inside: s(t.def.run.inside, league.run.inside, K.run), outside: s(t.def.run.outside, league.run.outside, K.run) },
        expl: s(t.def.expl, league.expl, K.run), rush: s(t.def.rush, league.rush, K.rush),
        dropEPA: s(t.def.dropEPA, league.dropEPA, K.rush), rushEPA: s(t.def.rushEPA, league.rushEPA, K.run),
        manRate: t.def.man.n ? s(t.def.man, league.manRate, K.cov) : null, box: t.def.box.n ? t.def.box.s / t.def.box.n : null,
        n: { targets: ZONES.reduce((q, z) => q + t.def.zone[z].n, 0), runs: t.def.run.inside.n + t.def.run.outside.n },
      },
      off: {
        zone: Object.fromEntries(ZONES.map((z) => [z, s(t.off.zone[z], league.zone[z], K.zone)])),
        pos: Object.fromEntries(['WR', 'TE', 'RB'].map((q) => [q, s(t.off.pos[q], league.pos[q], K.pos)])),
        run: { inside: s(t.off.run.inside, league.run.inside, K.run), outside: s(t.off.run.outside, league.run.outside, K.run) },
        expl: s(t.off.expl, league.expl, K.run), prot: s(t.off.prot, league.rush, K.rush),
        dropEPA: s(t.off.dropEPA, league.dropEPA, K.rush), rushEPA: s(t.off.rushEPA, league.rushEPA, K.run),
      },
    };
  }
  rateTeams(teams, league);

  // ---------- player profiles (shrunk toward league / position norms) ----------
  const players = new Map();
  for (const [g, p] of P) {
    const ps = pos(g);
    const share = {};
    for (const z of ZONES) share[z] = (p.zone[z] + K.playerShare * league.zoneShare[z]) / (p.zn + K.playerShare);
    const lgYPT = league.pos[ps] || lg(L.zone.shortOut);
    const manYPT = shrink(p.man.s, p.man.n, league.mz.man, K.playerMZ), zoneYPT = shrink(p.zoneCov.s, p.zoneCov.n, league.mz.zone, K.playerMZ);
    const insideShare = (p.inside + league.insideShare * 20) / (p.sideN + 20);
    const explRate = shrink(p.expl.s, p.expl.n, league.expl, K.playerExpl);
    const topRoutes = Object.entries(p.routes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => r);
    players.set(g, { gsis: g, pos: ps, team: p.team, targets: p.tg.n, carries: p.car.n, share, manYPT, zoneYPT, manEdge: (manYPT - zoneYPT) / (lgYPT || 7), insideShare, explRate, topRoutes,
      ypt: shrink(p.tg.s, p.tg.n, lgYPT, K.playerShare), ypc: shrink(p.car.s, p.car.n, (league.run.inside + league.run.outside) / 2, K.playerRun) });
  }
  for (const pl of players.values()) pl.style = styleTags(pl, league);

  const ctx = { season, week, league, teams, players, meta: { currentPlays: plays.filter(([, w]) => w === 1).length, priorSeasonWeight: PRIOR_W, coverageFrom: prevPart ? season - 1 : null } };
  cache.set(key, ctx);
  return ctx;
}

// ---------- 0–100 unit ratings (50 = league average, ±15 per SD across teams; higher = better for that unit) ----------
export const UNITS = {
  off: [
    ['passing', 'Passing offense', (t) => t.off.dropEPA, 1],
    ['rushing', 'Rushing offense', (t) => t.off.rushEPA, 1],
    ['protection', 'Pass protection', (t) => t.off.prot, -1],
    ['wr', 'WR production', (t) => t.off.pos.WR, 1],
    ['te', 'TE production', (t) => t.off.pos.TE, 1],
    ['rbRec', 'RB receiving', (t) => t.off.pos.RB, 1],
    ['deep', 'Deep passing', (t) => (t.off.zone.deepOut + t.off.zone.deepMid) / 2, 1],
    ['explosiveRun', 'Explosive running', (t) => t.off.expl, 1],
  ],
  def: [
    ['runD', 'Run defense', (t) => t.def.rushEPA, -1],
    ['runInside', 'Run defense — inside', (t) => t.def.run.inside, -1],
    ['runOutside', 'Run defense — outside', (t) => t.def.run.outside, -1],
    ['passRush', 'Pass rush', (t) => t.def.rush, 1],
    ['coverage', 'Pass defense overall', (t) => t.def.dropEPA, -1],
    ['safeties', 'Deep coverage (safeties)', (t) => (t.def.zone.deepMid * 0.6 + t.def.zone.deepOut * 0.4), -1],
    ['corners', 'Outside coverage (CBs)', (t) => (t.def.zone.shortOut + t.def.zone.interOut + t.def.zone.deepOut) / 3, -1],
    ['middle', 'Short-middle coverage (LB/nickel)', (t) => (t.def.zone.shortMid + t.def.zone.interMid) / 2, -1],
    ['vsTE', 'Coverage vs TEs', (t) => t.def.pos.TE, -1],
    ['vsRB', 'Coverage vs RBs', (t) => t.def.pos.RB, -1],
    ['explosiveRunD', 'Explosive runs allowed', (t) => t.def.expl, -1],
  ],
};
function rateTeams(teams, league) {
  const abbrs = Object.keys(teams);
  for (const side of ['off', 'def']) for (const [key, , f, dir] of UNITS[side]) {
    const v = abbrs.map((a) => f(teams[a]));
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) || 1;
    abbrs.forEach((a, i) => { (teams[a].ratings ||= { off: {}, def: {} })[side][key] = Math.round(Math.max(1, Math.min(99, 50 + 15 * dir * (v[i] - m) / sd))); });
  }
}

/** Head-to-head unit edges: offense rating − the defense rating it faces (positive = offense advantage). */
export const EDGES = [
  ['Run game', 'rushing', 'runD'], ['Pass protection vs pass rush', 'protection', 'passRush'], ['Passing vs pass defense', 'passing', 'coverage'],
  ['WRs vs outside coverage (CBs)', 'wr', 'corners'], ['Deep passing vs safeties', 'deep', 'safeties'], ['TEs vs TE coverage', 'te', 'vsTE'],
  ['RB receiving vs RB coverage', 'rbRec', 'vsRB'], ['Explosive runs vs explosive-run defense', 'explosiveRun', 'explosiveRunD'],
];
export function unitEdges(offTeam, defTeam) {
  const o = offTeam?.ratings?.off, d = defTeam?.ratings?.def;
  if (!o || !d) return [];
  return EDGES.map(([label, ok, dk]) => {
    // Defense ratings are "higher = better defense"; an offense edge is offense rating vs defense rating.
    const edge = o[ok] - d[dk];
    return { label, offense: o[ok], defense: d[dk], edge, verdict: edge >= 15 ? 'offense advantage' : edge <= -15 ? 'defense advantage' : 'even' };
  });
}

// ---------- player style tags ----------
function styleTags(p, league) {
  const tags = [];
  if (p.targets >= 8 && (p.pos === 'WR' || p.pos === 'TE')) {
    const deep = p.share.deepOut + p.share.deepMid, lgDeep = league.zoneShare.deepOut + league.zoneShare.deepMid;
    const mid = p.share.shortMid + p.share.interMid, lgMid = league.zoneShare.shortMid + league.zoneShare.interMid;
    if (deep > lgDeep * 1.35) tags.push('Deep threat');
    if (mid > lgMid * 1.3) tags.push('Middle-of-field target');
    if (p.share.shortOut + p.share.shortMid > 0.62 && deep < lgDeep * 0.7) tags.push('Underneath / short-area');
    const out = p.share.deepOut + p.share.interOut + p.share.shortOut, lgOut = league.zoneShare.deepOut + league.zoneShare.interOut + league.zoneShare.shortOut;
    if (out > lgOut + 0.08 && mid <= lgMid * 1.3) tags.push('Outside receiver');
    if (p.manEdge > 0.12) tags.push('Beats man coverage');
    if (p.manEdge < -0.12) tags.push('Better vs zone');
  }
  if (p.carries >= 15 && p.pos === 'RB') {
    if (p.insideShare > league.insideShare + 0.1) tags.push('Inside / between-the-tackles runner');
    else if (p.insideShare < league.insideShare - 0.12) tags.push('Outside / perimeter runner');
    if (p.explRate > league.expl * 1.25) tags.push('Explosive runner');
    if (p.explRate < league.expl * 0.8) tags.push('Grinder (few long runs)');
  }
  if (p.pos === 'RB' && p.targets >= 15 && p.targets > p.carries * 0.2) tags.push('Receiving back');
  return tags;
}

// ---------- player × defense fit ----------
/**
 * How well this player's style fits this defense, relative to an average defense. Returns log-multipliers
 * (0 = neutral) and plain-English reasons. The model only uses them with backtest-fitted strengths.
 *   zoneFit : receivers — his target mix weighted by how this defense does in each zone
 *   posFit  : receivers — this defense vs his position (WR/TE/RB targets)
 *   covFit  : receivers — man/zone tendency of the defense × his man-vs-zone edge (prior-season charting)
 *   runFit  : RBs — his inside/outside mix vs this defense inside/outside
 *   explFit : RBs — his explosiveness × this defense's explosive-run rate
 */
export function playerFit(pl, def, league) {
  if (!pl || !def) return null;
  const out = { zoneFit: 0, posFit: 0, covFit: 0, runFit: 0, explFit: 0, reasons: [] };
  if (pl.targets >= 3) {
    let num = 0, den = 0;
    for (const z of ZONES) { num += pl.share[z] * def.zone[z]; den += pl.share[z] * league.zone[z]; }
    out.zoneFit = den > 0 ? Math.log(num / den) : 0;
    if (league.pos[pl.pos] && def.pos[pl.pos]) out.posFit = Math.log(def.pos[pl.pos] / league.pos[pl.pos]);
    if (def.manRate != null) out.covFit = (def.manRate - league.manRate) * pl.manEdge;
    const top = ZONES.slice().sort((a, b) => pl.share[b] - pl.share[a]).slice(0, 2);
    for (const z of top) {
      const r = def.zone[z] / league.zone[z];
      if (Math.abs(r - 1) >= 0.12) out.reasons.push(`${Math.round(pl.share[z] * 100)}% of his targets are ${ZONE_LABEL[z]}; this defense allows ${(def.zone[z]).toFixed(1)} yds/target there (league ${league.zone[z].toFixed(1)}).`);
    }
    if (Math.abs(out.posFit) >= 0.1) out.reasons.push(`This defense allows ${def.pos[pl.pos].toFixed(1)} yds/target to ${pl.pos}s (league ${league.pos[pl.pos].toFixed(1)}).`);
    if (Math.abs(out.covFit) >= 0.02) out.reasons.push(`Defense plays man ${Math.round(def.manRate * 100)}% (league ${Math.round(league.manRate * 100)}%) and he is ${pl.manEdge > 0 ? 'better vs man' : 'better vs zone'} (last season's charting).`);
  }
  if (pl.carries >= 5 && pl.pos !== 'QB') {
    const lgSide = pl.insideShare * league.run.inside + (1 - pl.insideShare) * league.run.outside;
    const dSide = pl.insideShare * def.run.inside + (1 - pl.insideShare) * def.run.outside;
    out.runFit = Math.log(dSide / lgSide);
    out.explFit = Math.log(pl.explRate / league.expl) * Math.log(def.expl / league.expl);
    if (Math.abs(out.runFit) >= 0.06) out.reasons.push(`Runs ${Math.round(pl.insideShare * 100)}% inside; this defense allows ${def.run.inside.toFixed(1)} yds/carry inside and ${def.run.outside.toFixed(1)} outside (league ${league.run.inside.toFixed(1)} / ${league.run.outside.toFixed(1)}).`);
    if (def.expl / league.expl > 1.15 && pl.explRate / league.expl > 1.15) out.reasons.push(`Explosive runner vs a defense that gives up 10+ yard runs ${Math.round(def.expl * 100)}% of the time (league ${Math.round(league.expl * 100)}%).`);
  }
  return out;
}
