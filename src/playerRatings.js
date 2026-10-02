// PLAYER SKILL RATINGS v2 (QB / RB / WR / TE), 0–100 per skill, as of the start of a given week.
//
// Every skill is a rate (numerator / sample) built game by game from nflverse play-by-play and NFL Next Gen Stats:
//   • Recency: each game is weighted λ^k, where k = how many of HIS games ago it was (0 = most recent), counting back
//     through last season. λ is learned per skill (scripts/fit_rating_decay.mjs → src/fitted_rating_decay.json): the
//     value that best predicted each player's next 4 games in 2024 and 2025.
//   • Opponent: each game's rate is corrected by what that defense allows on the same metric to the same position
//     (shrunk toward league), so a big game against a soft defense counts for less — where that improved prediction.
//   • The weighted rate is shrunk toward the position average by its effective sample, then scored against qualifying
//     players: rating = 100 × Φ(z) (50 = average, ~84 = one SD better). Lower-is-better metrics are flipped.
import fs from 'node:fs';
import { loadPlays, loadNgs, loadPlayerIds } from './pbp.js';

const MIN_SAMPLE = { QB: 150, RB: 60, WR: 30, TE: 25 }; // ACTUAL dropbacks / carries / targets over this season + last
const DEF_K = { QB: 150, RB: 150, WR: 80, TE: 60 };     // shrink for a defense's allowance (in that metric's sample)

// [key, label, shrink k, higher-is-better, overall weight, opponent-adjustable]
export const SKILLS = {
  QB: [
    ['epa', 'Passing efficiency (EPA per dropback)', 150, true, 0.30, true],
    ['cpoe', 'Accuracy (completion % over expected)', 150, true, 0.20, true],
    ['deep', 'Deep passing (EPA per 20+ yd throw)', 30, true, 0.12, true],
    ['sack', 'Pocket / sack avoidance (sack rate)', 150, false, 0.10, true],
    ['ints', 'Ball security (INT rate)', 300, false, 0.10, true],
    ['scramble', 'Scrambling (yards per dropback)', 150, true, 0.09, true],
    ['run', 'Designed running (yards per game)', 4, true, 0.09, false],
  ],
  RB: [
    ['ryoe', 'Creating yards (rush yds over expected / carry)', 80, true, 0.32, true],
    ['success', 'Rushing success rate', 100, true, 0.18, true],
    ['explosive', 'Explosive runs (10+ yd rate)', 100, true, 0.18, true],
    ['short', 'Short yardage (success, ≤2 to go)', 25, true, 0.12, true],
    ['recv', 'Receiving (yards per target)', 25, true, 0.20, true],
  ],
  WR: [
    ['earn', 'Earning targets (share of team attempts)', 60, true, 0.25, false],
    ['sep', 'Separation (yards, NGS)', 40, true, 0.15, true],
    ['yac', 'YAC over expected (NGS)', 30, true, 0.15, true],
    ['hands', 'Catching (catch rate over expected)', 40, true, 0.15, true],
    ['deep', 'Deep threat (yards per 20+ yd target)', 12, true, 0.10, true],
    ['eff', 'Efficiency (EPA per target)', 50, true, 0.20, true],
  ],
};
SKILLS.TE = SKILLS.WR;

let FIT = null;
try { FIT = JSON.parse(fs.readFileSync(new URL('./fitted_rating_decay.json', import.meta.url), 'utf8')); } catch { FIT = null; }
export const fitFor = (pos, key) => FIT?.byPos?.[pos]?.[key] || { lambda: 0.95, adjust: true, kScale: 1 };

const bucket = (ay) => (ay == null ? 'na' : ay < 0 ? 'b' : ay < 5 ? 's' : ay < 10 ? 'm' : ay < 20 ? 'i' : 'd');
const succOf = (p) => (p.dn == null || p.tg == null ? null : p.y >= (p.dn === 1 ? 0.4 : p.dn === 2 ? 0.6 : 1) * p.tg ? 1 : 0);

/**
 * Per player-game records for the given seasons: Map(gsis → [{season, week, g, opp, team, m: {skill: [num, den]}}]).
 * Positions from nflverse players.csv. NGS rows are attached to the matching team-week game.
 */
export async function buildRecords(seasons) {
  const ids = await loadPlayerIds();
  const posOf = (g) => { const p = ids.posByGsis.get(g); return p === 'FB' ? 'RB' : ['QB', 'RB', 'WR', 'TE'].includes(p) ? p : null; };
  const [ngsP, ngsR, ngsRu] = await Promise.all([loadNgs('passing'), loadNgs('receiving'), loadNgs('rushing')]);
  const R = new Map();
  const gameKey = new Map(); // season|week|team → {g, opp}
  for (const season of seasons) {
    const plays = (await loadPlays(season)).filter((p) => !p.post);
    const lgCatch = {}; for (const p of plays) if (p.t === 'P' && !p.sk && p.rec) { const b = bucket(p.ay); (lgCatch[b] ||= [0, 0]); lgCatch[b][0] += p.c; lgCatch[b][1]++; }
    const teamAtt = new Map(); for (const p of plays) if (p.t === 'P' && !p.sk) teamAtt.set(`${p.g}|${p.o}`, (teamAtt.get(`${p.g}|${p.o}`) || 0) + 1);
    const G = new Map(); // gsis|g → record
    const rec = (gs, p) => {
      const k = `${gs}|${p.g}`; let r = G.get(k);
      if (!r) { r = { gs, season, week: p.w, g: p.g, opp: p.d, team: p.o, m: {} }; G.set(k, r); }
      return r;
    };
    const add = (r, key, num, den) => { const a = (r.m[key] ||= [0, 0]); a[0] += num; a[1] += den; };
    for (const p of plays) {
      gameKey.set(`${season}|${p.w}|${p.o}`, { g: p.g, opp: p.d });
      if (p.t === 'P') {
        if (p.qb && posOf(p.qb) === 'QB') {
          const r = rec(p.qb, p);
          if (p.epa != null) add(r, 'epa', p.epa, 1);
          add(r, 'sack', p.sk ? 1 : 0, 1);
          if (!p.sk) { add(r, 'ints', p.int ? 1 : 0, 1); if (p.ay != null && p.ay >= 20) add(r, 'deep', p.epa ?? 0, 1); }
          add(r, 'scramble', 0, 1);
        }
        if (!p.sk && p.rec) {
          const pos = posOf(p.rec); if (!pos) continue;
          const r = rec(p.rec, p);
          if (pos === 'RB') add(r, 'recv', p.y, 1);
          else {
            const lc = lgCatch[bucket(p.ay)];
            add(r, 'hands', p.c - (lc ? lc[0] / lc[1] : 0.65), 1);
            if (p.epa != null) add(r, 'eff', p.epa, 1);
            if (p.ay != null && p.ay >= 20) add(r, 'deep', p.y, 1);
            if (!r.m.earn) add(r, 'earn', 0, teamAtt.get(`${p.g}|${p.o}`) || 0);
            add(r, 'earn', 1, 0);
          }
        }
      } else if (p.ru) {
        const pos = posOf(p.ru); if (!pos) continue;
        const r = rec(p.ru, p);
        if (p.scr) { if (pos === 'QB') { add(r, 'scramble', p.y, 1); if (p.epa != null) add(r, 'epa', p.epa, 1); add(r, 'sack', 0, 1); } }
        else if (pos === 'QB') add(r, 'runYds', p.y, 0);
        else if (pos === 'RB') {
          const s = succOf(p);
          if (s != null) add(r, 'success', s, 1);
          add(r, 'explosive', p.y >= 10 ? 1 : 0, 1);
          if (p.tg != null && p.tg <= 2 && s != null) add(r, 'short', s, 1);
        }
      }
    }
    for (const r of G.values()) {
      if (posOf(r.gs) === 'QB') { r.m.run = [r.m.runYds?.[0] || 0, 1]; delete r.m.runYds; }
      (R.get(r.gs) || R.set(r.gs, []).get(r.gs)).push(r);
    }
  }
  // Next Gen Stats per player-week → the matching game record (created if he had no pbp record that game).
  const attach = (rows, fn) => {
    for (const x of rows) {
      if (x.season_type !== 'REG' || x.week === '0' || !seasons.includes(+x.season)) continue;
      const gk = gameKey.get(`${x.season}|${+x.week}|${x.team_abbr}`); if (!gk) continue;
      const list = R.get(x.player_gsis_id) || R.set(x.player_gsis_id, []).get(x.player_gsis_id);
      let r = list.find((z) => z.g === gk.g);
      if (!r) { r = { gs: x.player_gsis_id, season: +x.season, week: +x.week, g: gk.g, opp: gk.opp, team: x.team_abbr, m: {} }; list.push(r); }
      fn(r, x);
    }
  };
  attach(ngsP, (r, x) => { const n = +x.attempts, v = +x.completion_percentage_above_expectation; if (n && Number.isFinite(v)) r.m.cpoe = [v * n, n]; });
  attach(ngsR, (r, x) => { const t = +x.targets, c = +x.receptions, s = +x.avg_separation, y = +x.avg_yac_above_expectation; if (t && Number.isFinite(s)) r.m.sep = [s * t, t]; if (c && Number.isFinite(y)) r.m.yac = [y * c, c]; });
  attach(ngsRu, (r, x) => { const n = +x.rush_attempts, v = +x.rush_yards_over_expected_per_att; if (n && Number.isFinite(v)) r.m.ryoe = [v * n, n]; });
  for (const list of R.values()) list.sort((a, b) => a.season - b.season || a.week - b.week);
  return { R, posOf };
}

/** What each defense allowed per skill (position-specific), from records strictly before (season, week). */
function defenseAllowance(R, posOf, season, week) {
  const D = new Map(), L = {};
  for (const [gs, list] of R) {
    const pos = posOf(gs); if (!pos) continue;
    for (const r of list) {
      if (!(r.season < season || (r.season === season && r.week < week))) continue;
      for (const [k, [n, d]] of Object.entries(r.m)) {
        const key = `${pos}|${r.season}|${k}`;
        const a = (D.get(`${r.opp}|${key}`) || D.set(`${r.opp}|${key}`, [0, 0]).get(`${r.opp}|${key}`)); a[0] += n; a[1] += d;
        (L[key] ||= [0, 0]); L[key][0] += n; L[key][1] += d;
      }
    }
  }
  return { D, L };
}

/** Ratings at (season, week) from records. opts.lambda(pos,key) / opts.adjust(pos,key) override the fitted values. */
export function ratingsFrom({ R, posOf }, season, week, opts = {}) {
  const lam = opts.lambda || ((pos, k) => fitFor(pos, k).lambda), adj = opts.adjust || ((pos, k) => fitFor(pos, k).adjust), ks = opts.kScale || ((pos, k) => fitFor(pos, k).kScale ?? 1);
  const { D, L } = defenseAllowance(R, posOf, season, week);
  const players = new Map(), byPos = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const cand = [];
    for (const [gs, list] of R) {
      if (posOf(gs) !== pos) continue;
      const games = list.filter((r) => r.season === season - 1 || (r.season === season && r.week < week));
      if (!games.length) continue;
      const vals = {};
      for (const [k, , , , , canAdj] of SKILLS[pos]) {
        const l = lam(pos, k), doAdj = canAdj && adj(pos, k);
        let num = 0, den = 0, raw = 0;
        for (let i = games.length - 1, age = 0; i >= 0; i--, age++) {
          const r = games[i], m = r.m[k]; if (!m || !m[1]) continue;
          const w = Math.pow(l, age);
          let n = m[0];
          if (doAdj) {
            const key = `${pos}|${r.season}|${k}`, lg = L[key], da = D.get(`${r.opp}|${key}`);
            if (lg && lg[1] > 0 && da) { const lgRate = lg[0] / lg[1]; const dRate = (da[0] + DEF_K[pos] * lgRate) / (da[1] + DEF_K[pos]); n -= m[1] * (dRate - lgRate); }
          }
          num += w * n; den += w * m[1]; raw += m[1];
        }
        if (den > 0) vals[k] = { v: num / den, n: den, raw };
      }
      // Qualify on ACTUAL plays (not recency-weighted ones), so a backup's few recent snaps can't make him a top-5 player.
      const sample = pos === 'QB' ? vals.epa?.raw : pos === 'RB' ? (vals.success?.raw ?? vals.explosive?.raw) : vals.eff?.raw ?? vals.hands?.raw;
      if ((sample || 0) >= MIN_SAMPLE[pos] * (opts.sampleScale ?? 1)) cand.push({ gs, vals, sample, team: games[games.length - 1].team });
    }
    const out = cand.map((c) => ({ gsis: c.gs, team: c.team, pos, skills: {}, sample: Math.round(c.sample) }));
    for (const [k, label, K0, up] of SKILLS[pos]) {
      const K = K0 * ks(pos, k);
      const present = cand.map((c) => c.vals[k]).filter(Boolean);
      const tot = present.reduce((s, x) => s + x.n, 0), mu = tot ? present.reduce((s, x) => s + x.v * x.n, 0) / tot : 0;
      const shr = cand.map((c) => (c.vals[k] ? (c.vals[k].v * c.vals[k].n + mu * K) / (c.vals[k].n + K) : null));
      const sv = shr.filter((x) => x != null), m = sv.reduce((s, v) => s + v, 0) / (sv.length || 1);
      const sd = Math.sqrt(sv.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, sv.length - 1)) || 1;
      shr.forEach((v, i) => { if (v == null) return; out[i].skills[k] = { rating: Math.round(100 * phi(((up ? 1 : -1) * (v - m)) / sd)), value: round3(cand[i].vals[k].v), est: round3(v), n: Math.round(cand[i].vals[k].raw), label }; });
    }
    for (const o of out) {
      let ws = 0, s = 0; for (const [k, , , , w] of SKILLS[pos]) if (o.skills[k]) { ws += w; s += w * o.skills[k].rating; }
      o.overall = ws ? Math.round(s / ws) : null;
      players.set(o.gsis, o);
    }
    byPos[pos] = out.sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
  }
  return { season, week, players, byPos };
}

const cache = new Map();
/** Live entry point: ratings before `week` of `season`, from this season and last. */
export async function buildRatings(season, week) {
  const key = `${season}|${week}`;
  if (cache.has(key)) return cache.get(key);
  const recs = await buildRecords([season - 1, season]);
  const res = ratingsFrom(recs, season, week);
  res.method = { decay: 'λ^(games ago), per skill', opponentAdjusted: true, fitted: FIT ? FIT.learnedAt : null };
  cache.set(key, res);
  return res;
}

/** Leaderboard for one position, with names, for the Ratings page. */
export async function ratingsBoard(season, week, pos) {
  const R = await buildRatings(season, week);
  const ids = await loadPlayerIds();
  const list = (R.byPos[pos] || []).map((x) => ({ ...x, name: ids.nameByGsis.get(x.gsis) || x.gsis }));
  return { season, week, pos, method: R.method, skills: SKILLS[pos].map(([key, label, , up, weight]) => ({ key, label, higherIsBetter: up, weight, lambda: fitFor(pos, key).lambda, adjusted: fitFor(pos, key).adjust })), players: list };
}

function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
