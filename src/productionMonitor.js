// PRODUCTION MONITOR: for every game a player played, what he SHOULD have produced given that game — his usual role and
// efficiency, the team's actual volume that day, and what that opponent normally allows to his position — versus what
// he actually produced, split into OPPORTUNITY (did he get his usual share?) and EFFICIENCY (did he do more with each
// touch than this defense usually allows?). Plus how the game went (final score, time spent leading/trailing).
//
// Everything "expected" uses only games BEFORE the one being judged (his baseline, the defense's allowance), except the
// team's own volume that day, which is part of what happened in that game. Source: nflverse weekly stats + schedule.
import { loadWeekly } from './situational.js';
import { fetchCached } from './fetcher.js';
import { loadPlays } from './pbp.js';

const K_PLAYER = { ypc: 60, ypt: 30, ypa: 150, share: 0.5 }; // shrink: carries / targets / attempts / games (share: his own recent share dominates)
const K_DEF = { ypc: 80, ypt: 60, ypa: 150 };                // shrink a defense's allowance toward league
const POS = (p) => (p === 'FB' ? 'RB' : ['QB', 'RB', 'WR', 'TE'].includes(p) ? p : null);
const csv = (t) => { const L = t.trim().split('\n'); const H = L[0].split(','); return L.slice(1).map((l) => { const v = l.split(','); return Object.fromEntries(H.map((h, i) => [h, v[i]])); }); };

/** Game context: final margin and share of the team's plays spent leading / trailing by 8+. */
async function gameContext(seasons) {
  const g = await fetchCached('https://github.com/nflverse/nfldata/raw/master/data/games.csv', { ttl: 86400, as: 'text', label: 'nflverse games' });
  const G = new Map();
  for (const x of csv(g.data)) if (seasons.includes(+x.season)) G.set(x.game_id, { home: x.home_team, away: x.away_team, hs: x.home_score === '' ? null : +x.home_score, as: x.away_score === '' ? null : +x.away_score, spread: x.spread_line === '' ? null : +x.spread_line });
  const S = new Map(); // game|team → {n, lead, trail}
  for (const s of seasons) for (const p of await loadPlays(s)) {
    const k = `${p.g}|${p.o}`; const a = S.get(k) || S.set(k, { n: 0, lead: 0, trail: 0 }).get(k);
    a.n++; if (p.sd != null && p.sd >= 8) a.lead++; if (p.sd != null && p.sd <= -8) a.trail++;
  }
  return (gid, team) => {
    const x = G.get(gid); if (!x) return null;
    const home = x.home === team, pf = home ? x.hs : x.as, pa = home ? x.as : x.hs, s = S.get(`${gid}|${team}`);
    return { pf, pa, margin: pf != null && pa != null ? pf - pa : null, spread: x.spread == null ? null : home ? x.spread : -x.spread, leadShare: s?.n ? s.lead / s.n : null, trailShare: s?.n ? s.trail / s.n : null };
  };
}

/**
 * Per player: chronological game rows with expected vs actual. Returns Map(player_id → {name, pos, games:[…]}).
 * Seasons e.g. [2025, 2026]; rows for `season` only include weeks < beforeWeek when given.
 */
export async function buildMonitor(seasons, { season = null, beforeWeek = null } = {}) {
  const rows = [];
  for (const s of seasons) for (const r of await loadWeekly(s)) {
    const pos = POS(r.position); if (!pos) continue;
    if (season != null && beforeWeek != null && +r.season === season && +r.week >= beforeWeek) continue;
    rows.push({ id: r.player_id, name: r.player_display_name, pos, season: +r.season, week: +r.week, gid: r.game_id, team: r.team, opp: r.opponent_team,
      car: +r.carries || 0, ry: +r.rushing_yards || 0, tgt: +r.targets || 0, rec: +r.receptions || 0, recy: +r.receiving_yards || 0, att: +r.attempts || 0, py: +r.passing_yards || 0, cmp: +r.completions || 0 });
  }
  rows.sort((a, b) => a.season - b.season || a.week - b.week);
  const ctx = await gameContext(seasons);
  // Team volume per game (carries incl. QB, targets, pass attempts).
  const TV = new Map(); for (const r of rows) { const k = `${r.gid}|${r.team}`; const t = TV.get(k) || TV.set(k, { car: 0, tgt: 0, att: 0 }).get(k); t.car += r.car; t.tgt += r.tgt; t.att += r.att; }
  // Walk forward in time, keeping season-to-date (and prior-season, half weight) baselines and defense allowances.
  const P = new Map(), D = new Map(), L = {};
  const out = new Map();
  const keyOf = (r) => `${r.season}|${r.week}`;
  const order = [...new Set(rows.map(keyOf))];
  const bump = (m, k, f) => { const a = m.get(k) || m.set(k, {}).get(k); f(a); };
  for (const sw of order) {
    const wk = rows.filter((r) => keyOf(r) === sw);
    const lgRate = (k, n, d) => (L[k] && L[k][d] ? L[k][n] / L[k][d] : null);
    for (const r of wk) {
      const p = P.get(r.id) || { ry: 0, car: 0, recy: 0, tgt: 0, py: 0, att: 0, shC: [], shT: [] };
      const tv = TV.get(`${r.gid}|${r.team}`) || { car: 0, tgt: 0, att: 0 };
      const dk = (k) => D.get(`${r.opp}|${r.pos}|${k}`);
      const shrink = (n, d, prior, k) => (d + k > 0 ? (n + k * prior) / (d + k) : prior);
      const g = { season: r.season, week: r.week, opp: r.opp, team: r.team, game: ctx(r.gid, r.team), actual: {}, expected: {}, parts: {} };
      if (r.pos === 'RB' || (r.pos === 'QB' && r.car > 0)) {
        const lg = lgRate(`${r.pos}|ypc`, 'y', 'n') ?? 4.2;
        const ypc = shrink(p.ry, p.car, lg, K_PLAYER.ypc), d = dk('ypc'), dYpc = d ? shrink(d.y, d.n, lg, K_DEF.ypc) : lg;
        const share = p.shC.length ? shrink(p.shC.reduce((a, b) => a + b, 0), p.shC.length, 0.3, K_PLAYER.share) : null;
        if (share != null && r.pos === 'RB') {
          const expCar = share * tv.car, expYpc = ypc * (dYpc / lg);
          g.expected.carries = expCar; g.expected.rush_yds = expCar * expYpc; g.actual.carries = r.car; g.actual.rush_yds = r.ry;
          g.parts.rush = { usualShare: share, teamCarries: tv.car, usualYpc: ypc, oppFactor: dYpc / lg, expYpc, actYpc: r.car ? r.ry / r.car : null,
            opportunity: (r.car - expCar) * expYpc, efficiency: r.car ? r.ry - r.car * expYpc : 0 };
        }
      }
      if ((r.pos === 'WR' || r.pos === 'TE' || r.pos === 'RB') && (p.shT.length || r.tgt)) {
        const lg = lgRate(`${r.pos}|ypt`, 'y', 'n') ?? 7.5;
        const ypt = shrink(p.recy, p.tgt, lg, K_PLAYER.ypt), d = dk('ypt'), dYpt = d ? shrink(d.y, d.n, lg, K_DEF.ypt) : lg;
        const share = p.shT.length ? shrink(p.shT.reduce((a, b) => a + b, 0), p.shT.length, 0.1, K_PLAYER.share) : null;
        if (share != null) {
          const expT = share * tv.tgt, expYpt = ypt * (dYpt / lg);
          g.expected.targets = expT; g.expected.rec_yds = expT * expYpt; g.actual.targets = r.tgt; g.actual.rec_yds = r.recy;
          g.parts.recv = { usualShare: share, teamTargets: tv.tgt, usualYpt: ypt, oppFactor: dYpt / lg, expYpt, actYpt: r.tgt ? r.recy / r.tgt : null,
            opportunity: (r.tgt - expT) * expYpt, efficiency: r.tgt ? r.recy - r.tgt * expYpt : 0 };
        }
      }
      if (r.pos === 'QB' && r.att >= 10) {
        const lg = lgRate('QB|ypa', 'y', 'n') ?? 6.8;
        const ypa = shrink(p.py, p.att, lg, K_PLAYER.ypa), d = dk('ypa'), dYpa = d ? shrink(d.y, d.n, lg, K_DEF.ypa) : lg;
        const expYpa = ypa * (dYpa / lg);
        g.expected.pass_yds = r.att * expYpa; g.actual.pass_yds = r.py;
        g.parts.pass = { attempts: r.att, usualYpa: ypa, oppFactor: dYpa / lg, expYpa, actYpa: r.py / r.att, efficiency: r.py - r.att * expYpa };
      }
      if (Object.keys(g.expected).length) (out.get(r.id) || out.set(r.id, { id: r.id, name: r.name, pos: r.pos, games: [] }).get(r.id)).games.push(g);
    }
    // update baselines after the week (prior season counts half)
    for (const r of wk) {
      const p = P.get(r.id) || P.set(r.id, { ry: 0, car: 0, recy: 0, tgt: 0, py: 0, att: 0, shC: [], shT: [], season: r.season }).get(r.id);
      if (p.season !== r.season) { for (const k of ['ry', 'car', 'recy', 'tgt', 'py', 'att']) p[k] *= 0.5; p.shC = p.shC.slice(-3); p.shT = p.shT.slice(-3); p.season = r.season; }
      const tv = TV.get(`${r.gid}|${r.team}`);
      p.ry += r.ry; p.car += r.car; p.recy += r.recy; p.tgt += r.tgt; p.py += r.py; p.att += r.att;
      if (tv?.car) p.shC.push(r.car / tv.car); if (tv?.tgt) p.shT.push(r.tgt / tv.tgt);
      if (p.shC.length > 8) p.shC.shift(); if (p.shT.length > 8) p.shT.shift();
      const addD = (k, y, n) => { if (!n) return; bump(D, `${r.opp}|${r.pos}|${k}`, (a) => { a.y = (a.y || 0) + y; a.n = (a.n || 0) + n; }); const l = (L[`${r.pos}|${k}`] ||= { y: 0, n: 0 }); l.y += y; l.n += n; };
      addD('ypc', r.ry, r.car); addD('ypt', r.recy, r.tgt); if (r.pos === 'QB') addD('ypa', r.py, r.att);
    }
    // defenses reset at the season boundary to half weight (handled implicitly: carry over; keeps early-season allowances sane)
  }
  return out;
}

/**
 * Production score per player: recency-weighted average of per-game performance vs expectation, per touch:
 *   efficiency = (actual − expected yards given his actual touches) / touches     (yards per touch over expectation)
 *   usage      = (actual − expected touches) / expected touches                     (share of usual role he got)
 * Older games weigh λ^(games ago). Returns Map(id → {name, pos, games, eff, usage, n}).
 */
export function productionScores(mon, { lambda = 0.9, before = null } = {}) {
  const out = new Map();
  for (const [id, p] of mon) {
    let ew = 0, en = 0, uw = 0, un = 0;
    const G = before ? p.games.filter((g) => g.season < before.season || (g.season === before.season && g.week < before.week)) : p.games;
    for (let i = G.length - 1, age = 0; i >= 0; i--, age++) {
      const g = G[i], w = Math.pow(lambda, age);
      const part = p.pos === 'QB' ? g.parts.pass : p.pos === 'RB' ? g.parts.rush : g.parts.recv;
      if (!part) continue;
      const touches = p.pos === 'QB' ? part.attempts : p.pos === 'RB' ? g.actual.carries : g.actual.targets;
      const expT = p.pos === 'QB' ? part.attempts : p.pos === 'RB' ? g.expected.carries : g.expected.targets;
      if (touches > 0) { ew += w * part.efficiency; en += w * touches; }
      if (expT > 0) { uw += w * (touches - expT); un += w * expT; }
    }
    out.set(id, { id, name: p.name, pos: p.pos, games: G.length, eff: en ? ew / en : null, effN: en, usage: un ? uw / un : null });
  }
  return out;
}

const monCache = new Map();
/** Cached monitor for a live game week (this season before `week` + last season). */
export async function monitorFor(season, week) {
  const k = `${season}|${week}`;
  if (!monCache.has(k)) monCache.set(k, buildMonitor([season - 1, season], { season, beforeWeek: week }));
  return monCache.get(k);
}
