// PLAYER SKILL RATINGS v2 (QB / RB / WR / TE), 0–100 per skill, as of the start of a given week.
//
// Every skill is a rate (numerator / sample) built game by game from nflverse play-by-play and NFL Next Gen Stats:
//   • Recency: each game is weighted λ^k, where k = how many of HIS games ago it was (0 = most recent), counting back
//     through last season. λ is learned per skill (scripts/fit_rating_decay.mjs → src/fitted_rating_decay.json): the
//     value that best predicted each player's next 4 games in 2024 and 2025.
//   • Opponent: each game's rate is corrected by what that defense allows on the same metric to the same position
//     (shrunk toward league), so a big game against a soft defense counts for less — where that improved prediction.
//   • Situation: success, explosive and EPA metrics are measured OVER EXPECTED for the play's down, distance and score
//     state (league-wide, same season), so garbage-time and protect-the-lead plays don't inflate or deflate a player.
//   • Supporting cast: per game, a back is compared with his team's OTHER backs (same line, same day) and a receiver
//     with the same QB's throws to OTHER targets; β × that teammate context is removed (β fitted per skill).
//   • The weighted rate is shrunk toward the position average by its effective sample, then scored against qualifying
//     players: rating = 100 × Φ(z) (50 = average, ~84 = one SD better). Lower-is-better metrics are flipped.
import fs from 'node:fs';
import { loadPlays, loadNgs, loadPlayerIds } from './pbp.js';
import { stateOf } from './volume.js';

const MIN_SAMPLE = { QB: 150, RB: 60, WR: 30, TE: 25 }; // ACTUAL dropbacks / carries / targets over this season + last
const DEF_K = { QB: 150, RB: 150, WR: 80, TE: 60 };     // shrink for a defense's allowance (in that metric's sample)

// [key, label, shrink k, higher-is-better, overall weight, opponent-adjustable]
export const SKILLS = {
  QB: [
    ['epa', 'Passing efficiency (EPA per dropback over expected)', 150, true, 0.30, true],
    ['cpoe', 'Accuracy (completion % over expected)', 150, true, 0.20, true],
    ['deep', 'Deep passing (EPA per 20+ yd throw)', 30, true, 0.12, true],
    ['sack', 'Pocket / sack avoidance (sack rate)', 150, false, 0.10, true],
    ['ints', 'Ball security (INT rate)', 300, false, 0.10, true],
    ['scramble', 'Scrambling (yards per dropback)', 150, true, 0.09, true],
    ['run', 'Designed running (yards per game)', 4, true, 0.09, false],
  ],
  RB: [
    ['load', 'Workload (carries + targets per team play)', 60, true, 0.22, false],
    ['ryoe', 'Creating yards (rush yds over expected / carry)', 80, true, 0.26, true],
    ['success', 'Rushing success over expected', 100, true, 0.14, true],
    ['explosive', 'Explosive runs over expected (10+ yd)', 100, true, 0.14, true],
    ['short', 'Short yardage (success over expected, ≤2 to go)', 25, true, 0.08, true],
    ['recv', 'Receiving (yards per target)', 25, true, 0.16, true],
  ],
  WR: [
    ['earn', 'Earning targets (share of team attempts)', 60, true, 0.25, false],
    ['sep', 'Separation (yards, NGS)', 40, true, 0.15, true],
    ['yac', 'YAC over expected (NGS)', 30, true, 0.15, true],
    ['hands', 'Catching (catch rate over expected)', 40, true, 0.15, true],
    ['deep', 'Deep threat (yards per 20+ yd target)', 12, true, 0.10, true],
    ['eff', 'Efficiency (EPA per target over expected)', 50, true, 0.20, true],
  ],
};
SKILLS.TE = SKILLS.WR;

let FIT = null;
try { FIT = JSON.parse(fs.readFileSync(new URL('./fitted_rating_decay.json', import.meta.url), 'utf8')); } catch { FIT = null; }
export const fitFor = (pos, key) => FIT?.byPos?.[pos]?.[key] || { lambda: 0.95, adjust: true, kScale: 1, beta: 0 };

const NGS_TEAM = { LAR: 'LA' }; // NGS team_abbr → nflverse play-by-play
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
    // League expectation by situation (down × distance bucket × score state), this season.
    const sit = (p) => `${p.dn ?? 0}|${p.tg == null ? 'x' : p.tg <= 2 ? 's' : p.tg <= 6 ? 'm' : p.tg <= 10 ? 'l' : 'xl'}|${stateOf(p.sd)}`;
    const EX = {}; const ex = (tbl, k, v) => { const a = ((EX[tbl] ||= {})[k] ||= [0, 0]); a[0] += v; a[1]++; };
    for (const p of plays) {
      if (p.t === 'R' && p.ru && !p.scr) { const s2 = succOf(p); if (s2 != null) ex('succ', sit(p), s2); ex('expl', sit(p), p.y >= 10 ? 1 : 0); }
      if (p.t === 'P' && !p.sk && p.rec && p.epa != null) ex('tgtEpa', sit(p), p.epa);
      if ((p.t === 'P' || p.scr) && p.epa != null) ex('dbEpa', sit(p), p.epa);
    }
    const E = (tbl, p) => { const a = EX[tbl]?.[sit(p)]; return a && a[1] >= 20 ? a[0] / a[1] : (() => { let n = 0, d = 0; for (const v of Object.values(EX[tbl] || {})) { n += v[0]; d += v[1]; } return d ? n / d : 0; })(); };
    const lgCatch = {}; for (const p of plays) if (p.t === 'P' && !p.sk && p.rec) { const b = bucket(p.ay); (lgCatch[b] ||= [0, 0]); lgCatch[b][0] += p.c; lgCatch[b][1]++; }
    const teamAtt = new Map(); for (const p of plays) if (p.t === 'P' && !p.sk) teamAtt.set(`${p.g}|${p.o}`, (teamAtt.get(`${p.g}|${p.o}`) || 0) + 1);
    const teamPlays = new Map(); for (const p of plays) if (p.t === 'P' || p.t === 'R') teamPlays.set(`${p.g}|${p.o}`, (teamPlays.get(`${p.g}|${p.o}`) || 0) + 1);
    const load = (r, p) => { if (!r.m.load) add(r, 'load', 0, teamPlays.get(`${p.g}|${p.o}`) || 0); add(r, 'load', 1, 0); }; // backs: share of ALL team plays
    const G = new Map(); // gsis|g → record
    const TEAMCTX = new Map(); // game|team|group → { skill: [num, den] } (all backs' runs / all targets that game)
    const teamAdd = (k, sk, num, den) => { const t = TEAMCTX.get(k) || TEAMCTX.set(k, {}).get(k); const a = (t[sk] ||= [0, 0]); a[0] += num; a[1] += den; };
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
          if (p.epa != null) add(r, 'epa', p.epa - E('dbEpa', p), 1);
          add(r, 'sack', p.sk ? 1 : 0, 1);
          if (!p.sk) { add(r, 'ints', p.int ? 1 : 0, 1); if (p.ay != null && p.ay >= 20) add(r, 'deep', p.epa ?? 0, 1); }
          add(r, 'scramble', 0, 1);
        }
        if (!p.sk && p.rec) {
          const pos = posOf(p.rec); if (!pos) continue;
          const r = rec(p.rec, p);
          if (pos === 'RB') { add(r, 'recv', p.y, 1); load(r, p); }
          else {
            const lc = lgCatch[bucket(p.ay)];
            add(r, 'hands', p.c - (lc ? lc[0] / lc[1] : 0.65), 1);
            if (p.epa != null) { const oe = p.epa - E('tgtEpa', p); add(r, 'eff', oe, 1); teamAdd(`${p.g}|${p.o}|tgt`, 'eff', oe, 1); }
            teamAdd(`${p.g}|${p.o}|tgt`, 'hands', p.c - (lc ? lc[0] / lc[1] : 0.65), 1);
            if (p.ay != null && p.ay >= 20) add(r, 'deep', p.y, 1);
            if (!r.m.earn) add(r, 'earn', 0, teamAtt.get(`${p.g}|${p.o}`) || 0);
            add(r, 'earn', 1, 0);
          }
        }
      } else if (p.ru) {
        const pos = posOf(p.ru); if (!pos) continue;
        const r = rec(p.ru, p);
        if (p.scr) { if (pos === 'QB') { add(r, 'scramble', p.y, 1); if (p.epa != null) add(r, 'epa', p.epa - E('dbEpa', p), 1); add(r, 'sack', 0, 1); } }
        else if (pos === 'QB') add(r, 'runYds', p.y, 0);
        else if (pos === 'RB') {
          load(r, p);
          const s = succOf(p);
          if (s != null) { const oe = s - E('succ', p); add(r, 'success', oe, 1); teamAdd(`${p.g}|${p.o}|run`, 'success', oe, 1); }
          const xo = (p.y >= 10 ? 1 : 0) - E('expl', p); add(r, 'explosive', xo, 1); teamAdd(`${p.g}|${p.o}|run`, 'explosive', xo, 1);
          if (p.tg != null && p.tg <= 2 && s != null) add(r, 'short', s - E('succ', p), 1); // vs league success in that exact situation (goal line, 3rd & 1 …)
        }
      }
    }
    for (const r of G.values()) {
      // Teammates' context this game = team total minus his own (backs: other backs' runs; receivers: other targets).
      const pos0 = posOf(r.gs);
      const grp = pos0 === 'RB' ? 'run' : pos0 === 'WR' || pos0 === 'TE' ? 'tgt' : null;
      if (grp) { const T = TEAMCTX.get(`${r.g}|${r.team}|${grp}`) || {}; r.ctx = {}; for (const [sk, [n, d]] of Object.entries(T)) { const own = r.m[sk] || [0, 0]; const dn = d - own[1]; if (dn > 0) r.ctx[sk] = [n - own[0], dn]; } }
      if (posOf(r.gs) === 'QB') { r.m.run = [r.m.runYds?.[0] || 0, 1]; delete r.m.runYds; }
      (R.get(r.gs) || R.set(r.gs, []).get(r.gs)).push(r);
    }
  }
  // Next Gen Stats per player-week → the matching game record (created if he had no pbp record that game).
  const attach = (rows, fn) => {
    for (const x of rows) {
      if (x.season_type !== 'REG' || x.week === '0' || !seasons.includes(+x.season)) continue;
      // NGS spells some teams differently from play-by-play (Rams: LAR vs LA) — without this, every Rams player's NGS
      // metrics were silently dropped.
      const tm = NGS_TEAM[x.team_abbr] || x.team_abbr;
      const gk = gameKey.get(`${x.season}|${+x.week}|${tm}`); if (!gk) continue;
      const list = R.get(x.player_gsis_id) || R.set(x.player_gsis_id, []).get(x.player_gsis_id);
      let r = list.find((z) => z.g === gk.g);
      if (!r) { r = { gs: x.player_gsis_id, season: +x.season, week: +x.week, g: gk.g, opp: gk.opp, team: tm, m: {} }; list.push(r); }
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
  const lam = opts.lambda || ((pos, k) => fitFor(pos, k).lambda), adj = opts.adjust || ((pos, k) => fitFor(pos, k).adjust), ks = opts.kScale || ((pos, k) => fitFor(pos, k).kScale ?? 1), bet = opts.beta || ((pos, k) => fitFor(pos, k).beta ?? 0);
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
        let num = 0, den = 0, raw = 0, w2 = 0;
        for (let i = games.length - 1, age = 0; i >= 0; i--, age++) {
          const r = games[i], m = r.m[k]; if (!m || !m[1]) continue;
          const w = Math.pow(l, age);
          let n = m[0];
          const b = bet(pos, k), cx = r.ctx?.[k];
          if (b && cx && cx[1] > 0) n -= b * m[1] * (cx[0] / (cx[1] + 10)); // teammates' rate this game (lightly shrunk to 0 = average)
          if (doAdj) {
            const key = `${pos}|${r.season}|${k}`, lg = L[key], da = D.get(`${r.opp}|${key}`);
            if (lg && lg[1] > 0 && da) { const lgRate = lg[0] / lg[1]; const dRate = (da[0] + DEF_K[pos] * lgRate) / (da[1] + DEF_K[pos]); n -= m[1] * (dRate - lgRate); }
          }
          num += w * n; den += w * m[1]; raw += m[1]; w2 += w * w * m[1];
        }
        // n = EFFECTIVE sample after recency weighting ((Σw·n)² / Σw²·n), so the shrink below is honest about decay.
        if (den > 0) vals[k] = { v: num / den, n: (den * den) / w2, raw };
      }
      // Qualify on ACTUAL plays (not recency-weighted ones), so a backup's few recent snaps can't make him a top-5 player.
      const sample = pos === 'QB' ? vals.epa?.raw : pos === 'RB' ? (vals.success?.raw ?? vals.explosive?.raw) : vals.eff?.raw ?? vals.hands?.raw;
      // Rookies (no games last season) qualify on PACE — MIN_SAMPLE is a this-season-plus-last total they could never have
      // reached by week 4. A thin sample isn't held against them: the shrink below pulls it to average (50), not down.
      const rookie = !list.some((r) => r.season < season);
      const need = MIN_SAMPLE[pos] * (opts.sampleScale ?? 1) * (rookie ? Math.min(1, (new Set(games.map((r) => r.g)).size) / 8) : 1);
      if ((sample || 0) >= need) cand.push({ gs, vals, sample, rookie, team: games[games.length - 1].team });
    }
    const out = cand.map((c) => ({ gsis: c.gs, team: c.team, pos, skills: {}, sample: Math.round(c.sample), rookie: c.rookie }));
    // EMPIRICAL-BAYES scale, per skill. Noise per play (s²) comes from how much each player's game-to-game values bounce
    // around his own average; true-talent spread (τ²) = spread between players − the part noise explains. Each player's
    // value is shrunk by his own reliability (K = s²/τ²), and the rating is that estimate in TRUE-TALENT standard
    // deviations — so a small or noisy sample lands near 50 instead of being stretched to 0 or 100 (the old scale divided
    // by the spread of already-shrunk values, which re-inflated every small-sample extreme). Players with no data in a
    // skill get the position average (50), flagged `noData`.
    for (const [k, label, , up] of SKILLS[pos]) {
      const present = cand.map((c) => c.vals[k]).filter(Boolean);
      if (present.length < 5) continue;
      const tot = present.reduce((s, x) => s + x.n, 0), mu = present.reduce((s, x) => s + x.v * x.n, 0) / tot;
      const s2 = noiseOf(R, cand, pos, k, season, week);
      const between = present.reduce((s, x) => s + (x.v - mu) ** 2, 0) / Math.max(1, present.length - 1);
      const sampling = present.reduce((s, x) => s + s2 / x.n, 0) / present.length;
      const tau2 = Math.max(between - sampling, 0.1 * between) * (opts.tauScale ?? 1), tau = Math.sqrt(tau2), K = s2 / tau2;
      cand.forEach((c, i) => {
        const x = c.vals[k];
        if (!x) { out[i].skills[k] = { rating: 50, value: null, est: round3(mu), n: 0, label, noData: true }; return; }
        const est = (x.v * x.n + mu * K) / (x.n + K);
        out[i].skills[k] = { rating: r100(phi(((up ? 1 : -1) * (est - mu)) / tau)), value: round3(x.v), est: round3(est), n: Math.round(x.raw), reliability: round3(x.n / (x.n + K)), label };
      });
    }
    // OVERALL: weighted sum of skill z-scores, re-standardized across the position so it spreads like a normal rating.
    const comp = out.map((o) => { let ws = 0, s = 0; for (const [k, , , , w] of SKILLS[pos]) { const r = o.skills[k]; if (!r || r.noData) continue; ws += w; s += w * zOf(r.rating); } return ws ? s / ws : null; });
    const cv = comp.filter((x) => x != null), cm = cv.reduce((a, b) => a + b, 0) / (cv.length || 1), csd = Math.sqrt(cv.reduce((a, b) => a + (b - cm) ** 2, 0) / Math.max(1, cv.length - 1)) || 1;
    out.forEach((o, i) => { o.overall = comp[i] == null ? null : r100(phi((comp[i] - cm) / csd)); players.set(o.gsis, o); });
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
export async function ratingsBoard(season, week, pos, { includeMadden = false } = {}) {
  const R = await buildRatings(season, week);
  const ids = await loadPlayerIds();
  const list = (R.byPos[pos] || []).map((x) => ({ ...x, name: ids.nameByGsis.get(x.gsis) || x.gsis }));
  const combined = includeMadden ? addCombined(pos, list) : null;
  const { playerRatingsFor } = await import('./playerRating.js');
  const PR = await playerRatingsFor(season, week).catch(() => null);
  for (const x of list) { const p = PR?.players?.[x.gsis]; x.playerRating = p ? p.rating : null; }
  list.sort((a, b) => (b.playerRating ?? -1) - (a.playerRating ?? -1) || (b.overall ?? 0) - (a.overall ?? 0));
  return { season, week, pos, method: R.method, combined, playerRatingWeights: PR?.weights?.[pos] || null, skills: SKILLS[pos].map(([key, label, , up, weight]) => ({ key, label, higherIsBetter: up, weight, lambda: fitFor(pos, key).lambda, adjusted: fitFor(pos, key).adjust })), players: list };
}

/** Per-play noise variance for a skill, pooled from each qualified player's game-to-game spread around his own mean. */
function noiseOf(R, cand, pos, k, season, week) {
  let ss = 0, df = 0;
  for (const c of cand) {
    const G = (R.get(c.gs) || []).filter((r) => (r.season === season - 1 || (r.season === season && r.week < week)) && r.m[k]?.[1] > 0);
    if (G.length < 2) continue;
    const n = G.reduce((a, r) => a + r.m[k][1], 0), m = G.reduce((a, r) => a + r.m[k][0], 0) / n;
    for (const r of G) ss += r.m[k][1] * (r.m[k][0] / r.m[k][1] - m) ** 2;
    df += G.length - 1;
  }
  return df ? ss / df : 1;
}
const r100 = (p) => Math.min(99, Math.max(1, Math.round(100 * p))); // 1–99 like a normal rating scale
const zOf = (r) => { const p = Math.min(0.999, Math.max(0.001, r / 100)); let lo = -4, hi = 4; for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (phi(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; };

function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

// ---------- COMBINED rating: our production rating blended with Madden (local only) ----------
// 2024 test (scripts/ratings_vs_madden_test.mjs): Madden predicted next-4-game production better than our production
// rating for QB/RB/WR; the best blend per position is in src/fitted_rating_blend.json (z-scores within position).
// Madden data is EA's (reports/madden_ratings.json, gitignored): combined ratings are built only when that local file
// exists, and are never exported to the public static site.
let BLEND = null;
try { BLEND = JSON.parse(fs.readFileSync(new URL('./fitted_rating_blend.json', import.meta.url), 'utf8')).byPos; } catch { BLEND = null; }
const normName = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’,]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const MPOS = { HB: 'RB', QB: 'QB', WR: 'WR', TE: 'TE' };
let MADDEN = undefined;
export function maddenIndex() {
  if (MADDEN !== undefined) return MADDEN;
  try {
    const d = JSON.parse(fs.readFileSync(new URL('../reports/madden_ratings.json', import.meta.url), 'utf8'));
    const m = new Map(); for (const p of d.players) { const pos = MPOS[p.pos]; if (!pos) continue; const k = `${normName(p.name)}|${pos}`; if (!m.has(k)) m.set(k, p); }
    MADDEN = { iteration: d.iteration, retrievedAt: d.retrievedAt, byKey: m };
  } catch { MADDEN = null; }
  return MADDEN;
}
/** Adds {madden, combined} to each player in a board (in place) when local Madden data and blend weights exist. */
export function addCombined(pos, players) {
  const MI = maddenIndex(); const wO = BLEND?.[pos]?.wOurs;
  if (!MI || wO == null) return null;
  for (const p of players) { const m = MI.byKey.get(`${normName(p.name)}|${pos}`); p.madden = m ? m.overall : null; }
  const M = players.filter((p) => p.madden != null && p.overall != null);
  const z = (f) => { const v = M.map(f), mu = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length) || 1; return (x) => (f(x) - mu) / sd; };
  const zo = z((p) => p.overall), zm = z((p) => p.madden);
  const s = (p) => wO * zo(p) + (1 - wO) * zm(p), zs = z(s);
  for (const p of players) p.combined = p.madden != null && p.overall != null ? r100(phi(zs(p))) : null;
  return { wOurs: wO, wMadden: +(1 - wO).toFixed(2), iteration: MI.iteration };
}
