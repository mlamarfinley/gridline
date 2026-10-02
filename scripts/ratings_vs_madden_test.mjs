// Which rating predicts real production best: ours, Madden's, or a blend? 2024 (Madden 25 weekly releases).
// At weeks 4/7/10/13 of 2024: our overall (games before that week, this season + last) vs Madden's release for that
// week. Target = the player's RAW production over his next 4 games (QB EPA/dropback, RB yards/carry, WR/TE yards/target).
// Blend = w·z(ours) + (1−w)·z(Madden), z within position at that week. Score = target-weighted correlation.
//   node --no-warnings scripts/ratings_vs_madden_test.mjs [--write]
import fs from 'node:fs';
import { buildRecords, ratingsFrom } from '../src/playerRatings.js';
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
const M = JSON.parse(fs.readFileSync(new URL('../reports/madden25_iterations.json', import.meta.url), 'utf8'));
const norm = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’,]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const ids = await loadPlayerIds();
const recs = await buildRecords([2023, 2024]);
const plays = (await loadPlays(2024)).filter((p) => !p.post);
// raw future production per player: weeks [W, W+4)
const fut = (gs, pos, W) => { let n = 0, d = 0; for (const p of plays) { if (p.w < W || p.w >= W + 4) continue;
  if (pos === 'QB' && ((p.t === 'P' && p.qb === gs) || (p.scr && p.ru === gs)) && p.epa != null) { n += p.epa; d++; }
  else if (pos === 'RB' && p.t === 'R' && !p.scr && p.ru === gs) { n += p.y; d++; }
  else if ((pos === 'WR' || pos === 'TE') && p.t === 'P' && !p.sk && p.rec === gs) { n += p.y; d++; } }
  return d >= ({ QB: 40, RB: 15, WR: 8, TE: 6 })[pos] ? [n / d, d] : null; };
const rows = { QB: [], RB: [], WR: [], TE: [] };
for (const W of [4, 7, 10, 13]) {
  const mad = new Map(); const dup = new Set();
  for (const x of M[W]) { const k = norm(x.name); if (mad.has(k)) dup.add(k); mad.set(k, x.overall); }
  const res = ratingsFrom(recs, 2024, W);
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const L = [];
    for (const p of res.byPos[pos]) {
      const nm = norm(ids.nameByGsis.get(p.gsis) || ''); if (!nm || dup.has(nm) || !mad.has(nm)) continue;
      const f = fut(p.gsis, pos, W); if (!f) continue;
      L.push({ W, ours: p.overall, madden: mad.get(nm), y: f[0], w: f[1] });
    }
    const z = (k) => { const m = L.reduce((a, r) => a + r[k], 0) / L.length, sd = Math.sqrt(L.reduce((a, r) => a + (r[k] - m) ** 2, 0) / L.length) || 1; for (const r of L) r['z_' + k] = (r[k] - m) / sd; };
    z('ours'); z('madden'); rows[pos].push(...L);
  }
}
const wcorr = (L, f) => { const W = L.reduce((a, r) => a + r.w, 0), mx = L.reduce((a, r) => a + r.w * f(r), 0) / W, my = L.reduce((a, r) => a + r.w * r.y, 0) / W; let sxy = 0, sxx = 0, syy = 0; for (const r of L) { const dx = f(r) - mx, dy = r.y - my; sxy += r.w * dx * dy; sxx += r.w * dx * dx; syy += r.w * dy * dy; } return sxy / Math.sqrt(sxx * syy); };
const out = { season: 2024, weeks: [4, 7, 10, 13], target: { QB: 'EPA/dropback', RB: 'yards/carry', WR: 'yards/target', TE: 'yards/target' }, byPos: {} };
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const L = rows[pos]; if (!L.length) continue;
  const grid = []; for (let w = 0; w <= 1.0001; w += 0.1) grid.push({ w: +w.toFixed(1), r: wcorr(L, (r) => w * r.z_ours + (1 - w) * r.z_madden) });
  const best = grid.reduce((a, b) => (b.r > a.r ? b : a));
  // stability: best weight in the first half of the season vs the second half
  const half = (ws) => { const H = L.filter((r) => ws.includes(r.W)); const g = []; for (let w = 0; w <= 1.0001; w += 0.1) g.push({ w: +w.toFixed(1), r: wcorr(H, (r) => w * r.z_ours + (1 - w) * r.z_madden) }); return g.reduce((a, b) => (b.r > a.r ? b : a)); };
  const h1 = half([4, 7]), h2 = half([10, 13]);
  out.byPos[pos] = { n: L.length, ours: grid[10].r, madden: grid[0].r, bestBlend: best, firstHalfBest: h1, secondHalfBest: h2, grid };
  console.log(`${pos} (n ${L.length}, target ${out.target[pos]}): ours r=${grid[10].r.toFixed(3)} | Madden r=${grid[0].r.toFixed(3)} | best blend ${Math.round(best.w * 100)}% ours / ${Math.round((1 - best.w) * 100)}% Madden r=${best.r.toFixed(3)} | best weight wk4–7: ${h1.w} (r ${h1.r.toFixed(3)}), wk10–13: ${h2.w} (r ${h2.r.toFixed(3)})`);
}
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../reports/ratings_vs_madden_2024.json', import.meta.url), JSON.stringify(out, null, 1)); console.log('wrote reports/ratings_vs_madden_2024.json'); }
