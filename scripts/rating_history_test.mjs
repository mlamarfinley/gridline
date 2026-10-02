// How many PAST SEASONS should the skill ratings use? Each player's rating estimate at weeks 4/7/10/13 of 2024 and 2025
// vs his actual rate over his next 4 games (sample-weighted squared error), with 1, 2 or 3 prior seasons (recency decay
// per game still applies, so older seasons count less). Also: how well each window's OVERALL ranks players by their
// rest-of-season production (Spearman vs yards per touch over expected).
//   node --no-warnings scripts/rating_history_test.mjs
import { buildRecords, ratingsFrom, SKILLS } from '../src/playerRatings.js';
const recs = await buildRecords([2021, 2022, 2023, 2024, 2025]);
const target = (gs, k, S, W) => { let n = 0, d = 0; for (const r of recs.R.get(gs) || []) if (r.season === S && r.week >= W && r.week < W + 4 && r.m[k]) { n += r.m[k][0]; d += r.m[k][1]; } return d > 0 ? [n / d, d] : null; };
const err = {};
for (const S of [2024, 2025]) for (const W of [4, 7, 10, 13]) for (const H of [1, 2, 3]) {
  const res = ratingsFrom(recs, S, W, { history: H });
  for (const pos of ['QB', 'RB', 'WR', 'TE']) for (const p of res.byPos[pos]) for (const [k] of SKILLS[pos]) {
    const sk = p.skills[k]; if (!sk || sk.noData) continue;
    // only players rated under EVERY window are compared, so the sets match
    const t = target(p.gsis, k, S, W); if (!t) continue;
    const e = (err[`${pos}|${k}|${H}`] ||= { sse: 0, w: 0, ids: new Set() }); e.sse += t[1] * (sk.est - t[0]) ** 2; e.w += t[1];
  }
}
for (const pos of ['QB', 'RB', 'WR', 'TE']) for (const [k] of SKILLS[pos]) {
  const m = [1, 2, 3].map((H) => err[`${pos}|${k}|${H}`]).map((e) => (e ? e.sse / e.w : null));
  const best = m.indexOf(Math.min(...m.filter((x) => x != null))) + 1;
  console.log(`${pos} ${k.padEnd(9)} 1 season ${m[0]?.toPrecision(4)} | 2 seasons ${m[1]?.toPrecision(4)} (${(((m[1] - m[0]) / m[0]) * 100).toFixed(1)}%) | 3 seasons ${m[2]?.toPrecision(4)} (${(((m[2] - m[0]) / m[0]) * 100).toFixed(1)}%) → best ${best}`);
}
