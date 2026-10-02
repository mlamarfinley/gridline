// PLAYER SKILL RATINGS (QB / RB / WR / TE), 0–100 per skill, as of the start of a given week.
//
// Data (nflverse, all free): play-by-play (EPA, air yards, sacks, scrambles, down/distance) and NFL Next Gen Stats
// (completion % over expected, receiver separation, YAC over expected, rushing yards over expected). This season's
// games before the week count fully; last season counts half (skill is fairly stable and early samples are tiny).
//
// Each metric is shrunk toward the position average by its sample size (a 20-target receiver can't post a 99), then
// scored against qualifying players at the position: rating = 100 × Φ(z), so 50 = average, ~84 = one SD better,
// ~98 = two SD better. Lower-is-better metrics (sack rate, INT rate) are flipped. Overall = weighted blend of skills.
import { loadPlays, loadNgs, loadPlayerIds } from './pbp.js';

const PREV_W = 0.5;
const MIN_SAMPLE = { QB: 60, RB: 30, WR: 15, TE: 12 }; // dropbacks / carries / targets to be rated

// [key, label, sample field, shrink k, higher-is-better, overall weight]
export const SKILLS = {
  QB: [
    ['epa', 'Passing efficiency (EPA per dropback)', 'db', 150, true, 0.30],
    ['cpoe', 'Accuracy (completion % over expected)', 'att', 150, true, 0.20],
    ['deep', 'Deep passing (EPA per 20+ yd throw)', 'deepAtt', 30, true, 0.12],
    ['sack', 'Pocket / sack avoidance (sack rate)', 'db', 150, false, 0.10],
    ['ints', 'Ball security (INT rate)', 'att', 300, false, 0.10],
    ['scramble', 'Scrambling (yards per dropback)', 'db', 150, true, 0.09],
    ['run', 'Designed running (yards per game)', 'games', 4, true, 0.09],
  ],
  RB: [
    ['ryoe', 'Creating yards (rush yds over expected / carry)', 'ngsAtt', 80, true, 0.32],
    ['success', 'Rushing success rate', 'car', 100, true, 0.18],
    ['explosive', 'Explosive runs (10+ yd rate)', 'car', 100, true, 0.18],
    ['short', 'Short yardage (success, ≤2 to go)', 'shortCar', 25, true, 0.12],
    ['recv', 'Receiving (yards per target)', 'tgt', 25, true, 0.20],
  ],
  WR: [
    ['earn', 'Earning targets (share of team attempts)', 'tgt', 60, true, 0.25],
    ['sep', 'Separation (yards, NGS)', 'ngsTgt', 40, true, 0.15],
    ['yac', 'YAC over expected (NGS)', 'ngsRec', 30, true, 0.15],
    ['hands', 'Catching (catch rate over expected)', 'tgt', 40, true, 0.15],
    ['deep', 'Deep threat (yards per 20+ yd target)', 'deepTgt', 12, true, 0.10],
    ['eff', 'Efficiency (EPA per target)', 'tgt', 50, true, 0.20],
  ],
};
SKILLS.TE = SKILLS.WR;

const cache = new Map();
const acc = () => ({});
const add = (o, k, v, w = 1) => { o[k] = (o[k] || 0) + v * w; };

/** { season, week, players: Map(gsis → {gsis, name, team, pos, overall, skills:{key:{rating, value, n, label}}}), byPos } */
export async function buildRatings(season, week) {
  const key = `${season}|${week}`;
  if (cache.has(key)) return cache.get(key);
  const [cur, prev, ids, ngsP, ngsR, ngsRu] = await Promise.all([loadPlays(season), loadPlays(season - 1).catch(() => []), loadPlayerIds(), loadNgs('passing'), loadNgs('receiving'), loadNgs('rushing')]);
  const posOf = (g) => { const p = ids.posByGsis.get(g); return p === 'FB' ? 'RB' : p; };
  const P = new Map(); // gsis → raw accumulators
  const pl = (g) => P.get(g) || P.set(g, { g, games: new Set(), team: null, lastW: -1, a: acc() }).get(g);
  // League expected catch rate by air-yard bucket (for catch rate over expected), from the same window.
  const bucket = (ay) => (ay == null ? 'na' : ay < 0 ? 'b' : ay < 5 ? 's' : ay < 10 ? 'm' : ay < 20 ? 'i' : 'd');
  const lgCatch = {};
  const teamAtt = new Map(); // game|team → pass attempts
  const plays = [...cur.filter((p) => !p.post && p.w < week).map((p) => [p, 1]), ...prev.filter((p) => !p.post).map((p) => [p, PREV_W])];
  for (const [p, w] of plays) if (p.t === 'P' && !p.sk && p.rec) { const b = bucket(p.ay); (lgCatch[b] ||= [0, 0]); lgCatch[b][0] += w * p.c; lgCatch[b][1] += w; }
  for (const [p] of plays) if (p.t === 'P' && !p.sk) teamAtt.set(`${p.g}|${p.o}`, (teamAtt.get(`${p.g}|${p.o}`) || 0) + 1);
  const succ = (p) => (p.dn == null || p.tg == null ? null : p.y >= (p.dn === 1 ? 0.4 : p.dn === 2 ? 0.6 : 1) * p.tg ? 1 : 0);
  const seen = new Set(); // player|game|team for "share of team attempts in his games"
  for (const [p, w] of plays) {
    if (p.t === 'P') {
      if (p.qb) {
        const q = pl(p.qb), a = q.a; q.games.add(p.g); if (w === 1 && p.w >= q.lastW) { q.team = p.o; q.lastW = p.w; }
        add(a, 'db', 1, w); if (p.epa != null) add(a, 'epaSum', p.epa, w);
        if (p.sk) add(a, 'sacks', 1, w);
        else { add(a, 'att', 1, w); if (p.int) add(a, 'int', 1, w); if (p.ay != null && p.ay >= 20) { add(a, 'deepAtt', 1, w); if (p.epa != null) add(a, 'deepEpa', p.epa, w); } }
      }
      if (!p.sk && p.rec) {
        const r = pl(p.rec), a = r.a; r.games.add(p.g); if (w === 1 && p.w >= r.lastW) { r.team = p.o; r.lastW = p.w; }
        add(a, 'tgt', 1, w); add(a, 'recYds', p.y, w); add(a, 'catch', p.c, w);
        const lc = lgCatch[bucket(p.ay)]; add(a, 'xCatch', lc ? lc[0] / lc[1] : 0.65, w);
        if (p.epa != null) add(a, 'tgtEpa', p.epa, w);
        if (p.ay != null && p.ay >= 20) { add(a, 'deepTgt', 1, w); add(a, 'deepYds', p.y, w); }
        const sk = `${p.rec}|${p.g}`; if (!seen.has(sk)) { seen.add(sk); add(a, 'teamAtt', teamAtt.get(`${p.g}|${p.o}`) || 0, w); }
      }
    } else if (p.ru) {
      const r = pl(p.ru), a = r.a; r.games.add(p.g); if (w === 1 && p.w >= r.lastW) { r.team = p.o; r.lastW = p.w; }
      if (p.scr) { add(a, 'db', 1, w); add(a, 'scrYds', p.y, w); if (p.epa != null) add(a, 'epaSum', p.epa, w); }
      else {
        add(a, 'car', 1, w); add(a, 'rushYds', p.y, w); if (p.y >= 10) add(a, 'r10', 1, w);
        const s = succ(p); if (s != null) { add(a, 'succN', 1, w); add(a, 'succ', s, w); }
        if (p.tg != null && p.tg <= 2) { add(a, 'shortCar', 1, w); if (s != null) add(a, 'shortSucc', s, w); }
        add(a, 'desYds', p.y, w);
      }
    }
  }
  // Next Gen Stats: this season's weekly rows before the week, plus last season's totals (week 0) at half weight.
  const ngsRows = (rows) => rows.filter((r) => r.season_type === 'REG' && ((+r.season === season && +r.week >= 1 && +r.week < week) || (+r.season === season - 1 && r.week === '0')));
  for (const r of ngsRows(ngsP)) { const w = +r.season === season ? 1 : PREV_W, n = +r.attempts || 0, v = +r.completion_percentage_above_expectation; if (!n || !Number.isFinite(v)) continue; const a = pl(r.player_gsis_id).a; add(a, 'cpoeSum', v * n, w); add(a, 'cpoeN', n, w); }
  for (const r of ngsRows(ngsR)) { const w = +r.season === season ? 1 : PREV_W, t = +r.targets || 0, rc = +r.receptions || 0, sep = +r.avg_separation, yac = +r.avg_yac_above_expectation; const a = pl(r.player_gsis_id).a; if (t && Number.isFinite(sep)) { add(a, 'sepSum', sep * t, w); add(a, 'ngsTgt', t, w); } if (rc && Number.isFinite(yac)) { add(a, 'yacSum', yac * rc, w); add(a, 'ngsRec', rc, w); } }
  for (const r of ngsRows(ngsRu)) { const w = +r.season === season ? 1 : PREV_W, n = +r.rush_attempts || 0, v = +r.rush_yards_over_expected_per_att; if (!n || !Number.isFinite(v)) continue; const a = pl(r.player_gsis_id).a; add(a, 'ryoeSum', v * n, w); add(a, 'ngsAtt', n, w); }

  // Per-player metric values and samples.
  const metric = {
    QB: (a, x) => ({ epa: [a.epaSum / a.db, a.db], cpoe: [a.cpoeSum / a.cpoeN, a.cpoeN], deep: [a.deepEpa / a.deepAtt, a.deepAtt], sack: [(a.sacks || 0) / a.db, a.db], ints: [(a.int || 0) / a.att, a.att], scramble: [(a.scrYds || 0) / a.db, a.db], run: [(a.desYds || 0) / Math.max(1, x.games.size), x.games.size] }),
    RB: (a) => ({ ryoe: [a.ryoeSum / a.ngsAtt, a.ngsAtt], success: [a.succ / a.succN, a.succN], explosive: [(a.r10 || 0) / a.car, a.car], short: [a.shortSucc / a.shortCar, a.shortCar], recv: [(a.recYds || 0) / a.tgt, a.tgt] }),
    WR: (a) => ({ earn: [a.tgt / a.teamAtt, a.tgt], sep: [a.sepSum / a.ngsTgt, a.ngsTgt], yac: [a.yacSum / a.ngsRec, a.ngsRec], hands: [(a.catch - a.xCatch) / a.tgt, a.tgt], deep: [(a.deepYds || 0) / a.deepTgt, a.deepTgt], eff: [a.tgtEpa / a.tgt, a.tgt] }),
  };
  metric.TE = metric.WR;
  const sampleFor = { QB: (a) => a.db || 0, RB: (a) => a.car || 0, WR: (a) => a.tgt || 0, TE: (a) => a.tgt || 0 };
  const players = new Map(), byPos = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const list = [...P.values()].filter((x) => posOf(x.g) === pos && sampleFor[pos](x.a) >= MIN_SAMPLE[pos]);
    const raw = list.map((x) => ({ x, m: metric[pos](x.a, x) }));
    const out = list.map((x) => ({ gsis: x.g, team: x.team, pos, skills: {}, sample: sampleFor[pos](x.a) }));
    for (const [k, label, , K, up] of SKILLS[pos]) {
      const vals = raw.map(({ m }) => m[k]).filter(([v, n]) => Number.isFinite(v) && n > 0);
      const tot = vals.reduce((s, [, n]) => s + n, 0);
      const mu = tot ? vals.reduce((s, [v, n]) => s + v * n, 0) / tot : 0;
      const shr = raw.map(({ m }) => { const [v, n] = m[k]; return Number.isFinite(v) && n > 0 ? { v: (v * n + mu * K) / (n + K), raw: v, n } : null; });
      const sv = shr.filter(Boolean).map((z) => z.v), m = sv.reduce((s, v) => s + v, 0) / (sv.length || 1);
      const sd = Math.sqrt(sv.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, sv.length - 1)) || 1;
      shr.forEach((z, i) => { if (!z) return; const zs = ((up ? 1 : -1) * (z.v - m)) / sd; out[i].skills[k] = { rating: Math.round(100 * phi(zs)), value: round3(z.raw), n: Math.round(z.n), label }; });
    }
    for (const o of out) {
      let ws = 0, s = 0; for (const [k, , , , , w] of SKILLS[pos]) if (o.skills[k]) { ws += w; s += w * o.skills[k].rating; }
      o.overall = ws ? Math.round(s / ws) : null;
      players.set(o.gsis, o);
    }
    byPos[pos] = out.sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
  }
  const res = { season, week, prevSeasonWeight: PREV_W, players, byPos };
  cache.set(key, res);
  return res;
}

function phi(z) { // standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/** Leaderboard for one position, with names, for the Ratings page. */
export async function ratingsBoard(season, week, pos) {
  const R = await buildRatings(season, week);
  const ids = await loadPlayerIds();
  const list = (R.byPos[pos] || []).map((x) => ({ ...x, name: ids.nameByGsis.get(x.gsis) || x.gsis }));
  return { season, week, pos, prevSeasonWeight: R.prevSeasonWeight, skills: SKILLS[pos].map(([key, label, , , up, weight]) => ({ key, label, higherIsBetter: up, weight })), players: list };
}
