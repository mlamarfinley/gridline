// How spread out are college carries around expectation? For backs with ≥15% recent share (2025, after ≥2 games):
// expected carries = recency-weighted share × team's average rushes so far. Ratio actual / expected: quantiles, and how
// often the actual lands above 1.63× / below 0.47× expected (the live model's typical p90 / p10 band for a lead back).
//   node --no-warnings scripts/cfb_spread_test.mjs
import fs from 'node:fs';
const G = JSON.parse(fs.readFileSync(new URL('../data/cfb_history_2025.json', import.meta.url), 'utf8'));
const byTeam = new Map(); for (const g of G) for (const [ab, T] of Object.entries(g.teams)) if (T.rushAtt) (byTeam.get(ab) || byTeam.set(ab, []).get(ab)).push({ week: g.week, T });
const ratios = [];
for (const [, L] of byTeam) { L.sort((a, b) => a.week - b.week);
  for (let i = 1; i < L.length - 1; i++) { const H = L.slice(0, i + 1), nx = L[i + 1]; const teamAvg = H.reduce((a, h) => a + h.T.rushAtt, 0) / H.length;
    const pids = new Set(H.flatMap((h) => Object.entries(h.T.players).filter(([, p]) => p.car > 0 && !p.qb).map(([id]) => id)));
    for (const pid of pids) { let s = 0, w = 0; H.forEach((h, j) => { if (!h.T.players[pid]) return; const ww = Math.pow(0.82, H.length - 1 - j); s += ww * h.T.players[pid].car / h.T.rushAtt; w += ww; }); const sh = w ? s / w : 0; if (sh < 0.15) continue;
      const exp = sh * teamAvg, act = nx.T.players[pid]?.car || 0; if (!nx.T.players[pid]) continue; ratios.push(act / exp); } } }
ratios.sort((a, b) => a - b); const q = (p) => ratios[Math.floor(p * (ratios.length - 1))];
console.log(`college lead/rotation backs n=${ratios.length}: actual ÷ expected carries — p10 ${q(0.1).toFixed(2)}, p25 ${q(0.25).toFixed(2)}, median ${q(0.5).toFixed(2)}, p75 ${q(0.75).toFixed(2)}, p90 ${q(0.9).toFixed(2)}`);
console.log(`  above 1.63× expected: ${(ratios.filter((r) => r > 1.63).length / ratios.length * 100).toFixed(1)}% (a calibrated p90 would be 10%) · below 0.47×: ${(ratios.filter((r) => r < 0.47).length / ratios.length * 100).toFixed(1)}%`);
// Rushing yards: expected = expected carries × his shrunk YPC to date (toward 4.75 over 60 carries).
{
  const yr = [];
  for (const [, L] of byTeam) { L.sort((a, b) => a.week - b.week);
    for (let i = 1; i < L.length - 1; i++) { const H = L.slice(0, i + 1), nx = L[i + 1]; const teamAvg = H.reduce((a, h) => a + h.T.rushAtt, 0) / H.length;
      const pids = new Set(H.flatMap((h) => Object.entries(h.T.players).filter(([, p]) => p.car > 0 && !p.qb).map(([id]) => id)));
      for (const pid of pids) { let s = 0, w = 0, c = 0, y = 0; H.forEach((h, j) => { const p = h.T.players[pid]; if (!p) return; const ww = Math.pow(0.82, H.length - 1 - j); s += ww * p.car / h.T.rushAtt; w += ww; c += p.car; y += p.yds; }); const sh = w ? s / w : 0; if (sh < 0.15 || !nx.T.players[pid]) continue;
        const exp = sh * teamAvg * ((y + 60 * 4.75) / (c + 60)); yr.push(nx.T.players[pid].yds / exp); } } }
  yr.sort((a, b) => a - b); const q = (p) => yr[Math.floor(p * (yr.length - 1))];
  console.log(`rushing yards n=${yr.length}: actual ÷ expected — p10 ${q(0.1).toFixed(2)}, p25 ${q(0.25).toFixed(2)}, median ${q(0.5).toFixed(2)}, p75 ${q(0.75).toFixed(2)}, p90 ${q(0.9).toFixed(2)}, p95 ${q(0.95).toFixed(2)}`);
}
