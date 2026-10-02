// How much should last season count when rating a defense early in the year? nflverse pbp 2022–25.
// At week W (W−1 games played), estimate each defense's EPA/play allowed (and yards/play) for the REST of the season:
//   est = (cur·n + PW·prev·nPrev) / (n + PW·nPrev)   [per-play weight PW for last season's plays]
// then shrink toward league with K plays. Pick PW (and K) minimizing error, separately for weeks 4, 6, 9.
import { loadPlays } from '../src/pbp.js';
const S = {};
for (const s of [2021, 2022, 2023, 2024, 2025]) S[s] = (await loadPlays(s)).filter((p) => !p.post && p.d);
const agg = (plays, f) => { const m = new Map(); for (const p of plays) { const a = m.get(p.d) || m.set(p.d, [0, 0]).get(p.d); a[0] += f(p); a[1]++; } return m; };
for (const metric of ['epa', 'ypp']) {
  const f = metric === 'epa' ? (p) => p.epa || 0 : (p) => p.y;
  for (const W of [4, 6, 9]) {
    const grid = [];
    for (const PW of [0, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6]) for (const K of [0, 100, 200, 400]) {
      let se = 0, n = 0;
      for (const s of [2022, 2023, 2024, 2025]) {
        const cur = agg(S[s].filter((p) => p.w < W), f), rest = agg(S[s].filter((p) => p.w >= W), f), prev = agg(S[s - 1], f);
        const lg = [...cur.values()].reduce((a, x) => a + x[0], 0) / [...cur.values()].reduce((a, x) => a + x[1], 0);
        for (const [t, [cs, cn]] of cur) {
          const r = rest.get(t), pv = prev.get(t); if (!r || !pv) continue;
          const num = cs + PW * pv[0] + K * lg, den = cn + PW * pv[1] + K;
          se += (num / den - r[0] / r[1]) ** 2; n++;
        }
      }
      grid.push({ PW, K, rmse: Math.sqrt(se / n) });
    }
    grid.sort((a, b) => a.rmse - b.rmse);
    const cur = grid.find((g) => g.PW === 0.25 && g.K === 200) || grid.find((g) => g.PW === 0.25);
    const none = grid.filter((g) => g.PW === 0).sort((a, b) => a.rmse - b.rmse)[0];
    console.log(`${metric} at week ${W}: best last-season weight ${grid[0].PW} (shrink ${grid[0].K}) rmse ${grid[0].rmse.toFixed(4)} | current 0.25: ${cur.rmse.toFixed(4)} | this season only: ${none.rmse.toFixed(4)}`);
  }
}
