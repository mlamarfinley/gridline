// Quality-adjusted run defense: does judging a defense by how far it held each back below HIS OWN expected YPC predict
// the next back's YPC better than raw YPC allowed? nflverse weekly 2021–25 (RB rows: carries, rushing_yards, opponent).
// Expected YPC of a back for a game vs D = (his yards + K·league) / (his carries + K) over his OTHER games before
// this week this season, plus 0.5× last season — never including the game itself or any later game.
import { loadWeekly } from '../src/situational.js';
const K = 60;
const out = [];
let prevSeason = null;
for (const s of [2021, 2022, 2023, 2024, 2025]) {
  const rows = (await loadWeekly(s)).filter((r) => (r.position === 'RB' || r.position === 'FB') && +r.carries > 0).map((r) => ({ w: +r.week, p: r.player_id, d: r.opponent_team, c: +r.carries, y: +r.rushing_yards }));
  const prevP = new Map(); if (prevSeason) for (const r of prevSeason) { const a = prevP.get(r.p) || prevP.set(r.p, { c: 0, y: 0 }).get(r.p); a.c += r.c; a.y += r.y; }
  if (s >= 2022) for (const w of [...new Set(rows.map((r) => r.w))].sort((a, b) => a - b)) {
    const before = rows.filter((r) => r.w < w); if (before.length < 50) continue;
    const lg = before.reduce((a, r) => a + r.y, 0) / before.reduce((a, r) => a + r.c, 0);
    const pStats = new Map(); for (const r of before) { const a = pStats.get(r.p) || pStats.set(r.p, { c: 0, y: 0 }).get(r.p); a.c += r.c; a.y += r.y; }
    const expFor = (r) => { const a = pStats.get(r.p) || { c: 0, y: 0 }, pv = prevP.get(r.p) || { c: 0, y: 0 }; const c = a.c - r.c + 0.5 * pv.c, y = a.y - r.y + 0.5 * pv.y; return (y + K * lg) / (c + K); };
    const D = new Map(); for (const r of before) { const d = D.get(r.d) || D.set(r.d, { c: 0, y: 0, ey: 0 }).get(r.d); d.c += r.c; d.y += r.y; d.ey += r.c * expFor(r); }
    for (const r of rows.filter((x) => x.w === w && x.c >= 8)) {
      const d = D.get(r.d); if (!d || d.c < 25) continue;
      const a = pStats.get(r.p) || { c: 0, y: 0 }, pv = prevP.get(r.p) || { c: 0, y: 0 }; const pc = a.c + 0.5 * pv.c; if (pc < 30) continue;
      const own = (a.y + 0.5 * pv.y + K * lg) / (pc + K);
      out.push({ s, c: r.c, resid: r.y / r.c - own, raw: d.y / d.c - lg, adj: (d.y - d.ey) / d.c, faced: d.ey / d.c - lg });
    }
  }
  prevSeason = rows;
}
const fit1 = (R, k) => { let sw = 0, mx = 0, my = 0; for (const r of R) { sw += r.c; mx += r.c * r[k]; my += r.c * r.resid; } mx /= sw; my /= sw; let sxy = 0, sxx = 0; for (const r of R) { sxy += r.c * (r[k] - mx) * (r.resid - my); sxx += r.c * (r[k] - mx) ** 2; } const b = sxy / sxx; return { a: my - b * mx, b }; };
console.log(`RB-games: ${out.length}`);
console.log(`quality of backs each defense faced (avg |expected − league| YPC): ${(out.reduce((a, r) => a + Math.abs(r.faced), 0) / out.length).toFixed(2)}`);
for (const k of ['raw', 'adj']) { const f = fit1(out, k); console.log(`${k === 'raw' ? 'raw YPC allowed      ' : 'quality-adjusted     '} slope ${f.b.toFixed(3)} (share of the defense's number that shows up next game)`); }
for (const test of [2023, 2024, 2025]) {
  const tr = out.filter((r) => r.s < test), te = out.filter((r) => r.s === test);
  const e = (k) => { const f = fit1(tr, k); return te.reduce((a, r) => a + r.c * Math.abs(r.resid - (f.a + f.b * r[k])), 0) / te.reduce((a, r) => a + r.c, 0); };
  const e0 = te.reduce((a, r) => a + r.c * Math.abs(r.resid), 0) / te.reduce((a, r) => a + r.c, 0);
  console.log(`walk-forward ${test}: YPC error — no defense adj ${e0.toFixed(4)} · raw defense ${e('raw').toFixed(4)} · quality-adjusted defense ${e('adj').toFixed(4)}`);
}
