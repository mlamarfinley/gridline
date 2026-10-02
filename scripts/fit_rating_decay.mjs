// Fit the rating recency decay λ (per position × skill) and whether opponent adjustment helps.
//   node --no-warnings scripts/fit_rating_decay.mjs [--write]
// For ratings as of weeks 4, 7, 10, 13 of 2024 and 2025 (using only earlier games, incl. the prior season), compare each
// player's shrunk skill estimate with his actual rate over his next 4 games (sample-weighted squared error).
import fs from 'node:fs';
import { buildRecords, ratingsFrom, SKILLS } from '../src/playerRatings.js';
const recs = await buildRecords([2023, 2024, 2025]);  // ratings use HISTORY=1 past season (scripts/rating_history_test.mjs)
const LAMBDAS = [0.6, 0.75, 0.9, 0.95, 1.0];
const KS = [1]; // shrink is now empirical-Bayes per skill (src/playerRatings.js); kScale no longer applies
const BETAS = [0, 0.5, 1];
const points = [];
for (const S of [2024, 2025]) for (const W of [4, 7, 10, 13]) points.push([S, W]);
// actual next-4-game rate per player/skill
const target = (gs, k, S, W) => { const L = recs.R.get(gs) || []; let n = 0, d = 0; for (const r of L) if (r.season === S && r.week >= W && r.week < W + 4 && r.m[k]) { n += r.m[k][0]; d += r.m[k][1]; } return d > 0 ? [n / d, d] : null; };
const err = {}; // pos|k|lambda|adj → [sse, w]
for (const [S, W] of points) {
  for (const lam of LAMBDAS) for (const kx of KS) for (const adj of [false, true]) for (const bt of BETAS) {
    const res = ratingsFrom(recs, S, W, { lambda: () => lam, adjust: () => adj, kScale: () => kx, beta: () => bt, sampleScale: 0.5 });
    for (const pos of ['QB', 'RB', 'WR', 'TE']) for (const p of res.byPos[pos]) for (const [k] of SKILLS[pos]) {
      const sk = p.skills[k]; if (!sk || sk.est == null) continue;
      const t = target(p.gsis, k, S, W); if (!t) continue;
      const key = `${pos}|${k}|${lam}|${kx}|${adj}|${bt}`; const e = (err[key] ||= [0, 0]); e[0] += t[1] * (sk.est - t[0]) ** 2; e[1] += t[1];
    }
  }
  process.stdout.write(`done ${S} wk${W}\n`);
}
const out = { learnedAt: new Date().toISOString(), method: 'λ^(games ago) per skill; opponent adjustment kept only where it lowered next-4-game error', evalPoints: points, byPos: {} };
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  out.byPos[pos] = {};
  for (const [k, label, , , , canAdj] of SKILLS[pos]) {
    const opts = []; for (const lam of LAMBDAS) for (const kx of KS) for (const adj of canAdj ? [false, true] : [false]) for (const bt of BETAS) { const e = err[`${pos}|${k}|${lam}|${kx}|${adj}|${bt}`]; if (e && e[1]) opts.push({ lam, kx, adj, bt, mse: e[0] / e[1] }); }
    opts.sort((a, b) => a.mse - b.mse);
    const best = opts[0], flat = opts.filter((o) => o.lam === 1 && o.adj === false && o.bt === 0).sort((a, b) => a.mse - b.mse)[0], bestNoAdj = opts.filter((o) => !o.adj && o.bt === 0)[0];
    out.byPos[pos][k] = { lambda: best.lam, kScale: best.kx, adjust: best.adj, beta: best.bt, mse: best.mse, mseFlatNoAdj: flat?.mse, mseBestNoAdj: bestNoAdj?.mse };
    console.log(`${pos} ${k.padEnd(9)} λ=${best.lam} shrink×${best.kx} opp-adj=${best.adj} cast β=${best.bt}  error ${best.mse.toPrecision(4)} | no decay (best shrink), no adj ${flat?.mse.toPrecision(4)} | best without adj ${bestNoAdj?.mse.toPrecision(4)} (λ ${bestNoAdj?.lam})  — ${label}`);
  }
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_rating_decay.json', import.meta.url), JSON.stringify(out, null, 1)); console.log('wrote src/fitted_rating_decay.json'); }
