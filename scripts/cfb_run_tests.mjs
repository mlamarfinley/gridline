// College run-level tests on 2025 play-by-play (ESPN; data/cfb_runs_2025.json):
//  B. garbage time: a ball-carrier's share of team runs measured on ALL runs vs only runs with |score diff| < B, predicting
//     his share of the team's non-blowout runs next game (weeks ≥ 3). B ∈ {17, 21, 28}.
//  T. explosive tails: league 10+/20+ rates for non-QB runs, and the shrink K for a player's own rates (calibration error
//     vs his next game), using only earlier games.
//  M. average: does a back's 10+ rate predict his next-game YPC beyond his YPC (as in the NFL)?
//   node --no-warnings scripts/cfb_run_tests.mjs [--write]
import fs from 'node:fs';
const R = JSON.parse(fs.readFileSync(new URL('../data/cfb_runs_2025.json', import.meta.url), 'utf8'));
const byTeam = new Map(); for (const r of R) { const t = byTeam.get(r.team) || byTeam.set(r.team, new Map()).get(r.team); (t.get(r.g) || t.set(r.g, { week: r.week, runs: [] }).get(r.g)).runs.push(r); }
const out = {};
// ---- B ----
for (const B of [17, 21, 28]) {
  let eA = 0, eN = 0, n = 0, eAd = 0, eNd = 0, nd = 0;
  for (const [, T] of byTeam) {
    const G = [...T.values()].sort((a, b) => a.week - b.week);
    for (let i = 1; i < G.length - 1; i++) {
      const hist = G.slice(0, i + 1), nx = G[i + 1]; const nxNB = nx.runs.filter((r) => Math.abs(r.sd) < B); if (nxNB.length < 10) continue;
      const pids = new Set(hist.flatMap((h) => h.runs.filter((r) => !r.qb).map((r) => r.pid)));
      for (const pid of pids) {
        let a = 0, at = 0, b = 0, bt = 0;
        hist.forEach((h, j) => { const w = Math.pow(0.82, hist.length - 1 - j); const nb = h.runs.filter((r) => Math.abs(r.sd) < B); a += w * h.runs.filter((r) => r.pid === pid).length; at += w * h.runs.length; b += w * nb.filter((r) => r.pid === pid).length; bt += w * nb.length; });
        const sA = at ? a / at : 0, sN = bt ? b / bt : sA, y = nxNB.filter((r) => r.pid === pid).length / nxNB.length;
        if (sA < 0.03 && sN < 0.03) continue;
        eA += Math.abs(sA - y); eN += Math.abs(sN - y); n++;
        if (sN >= 0.2) { eAd += Math.abs(sA - y); eNd += Math.abs(sN - y); nd++; }
      }
    }
  }
  console.log(`B. garbage time |sd|<${B}: all backs n=${n} all-runs ${(eA / n * 100).toFixed(2)} vs non-blowout ${(eN / n * 100).toFixed(2)} pts | lead backs (≥20%) n=${nd} ${(eAd / nd * 100).toFixed(2)} vs ${(eNd / nd * 100).toFixed(2)}`);
  out[`garbage_${B}`] = { n, all: eA / n, nonBlowout: eN / n, lead: { n: nd, all: eAd / nd, nonBlowout: eNd / nd } };
}
// ---- T & M ----
const nq = R.filter((r) => !r.qb); const lg10 = nq.filter((r) => r.y >= 10).length / nq.length, lg20 = nq.filter((r) => r.y >= 20).length / nq.length, lgY = nq.reduce((a, r) => a + r.y, 0) / nq.length;
console.log(`T. league (non-QB): 10+ ${(lg10 * 100).toFixed(1)}% · 20+ ${(lg20 * 100).toFixed(1)}% · YPC ${lgY.toFixed(2)}`);
const pg = new Map(); for (const r of nq) { const k = `${r.pid}|${r.g}`; const a = pg.get(k) || pg.set(k, { pid: r.pid, week: r.week, c: 0, y: 0, t10: 0, t20: 0 }).get(k); a.c++; a.y += r.y; if (r.y >= 10) a.t10++; if (r.y >= 20) a.t20++; }
const byP = new Map(); for (const v of pg.values()) (byP.get(v.pid) || byP.set(v.pid, []).get(v.pid)).push(v);
const ex = [];
for (const [, L] of byP) { L.sort((a, b) => a.week - b.week); let c = 0, y = 0, t10 = 0, t20 = 0; for (const g of L) { if (c >= 20 && g.c >= 5) ex.push({ c, y, t10, t20, a10: g.t10 / g.c, a20: g.t20 / g.c, ay: g.y / g.c, w: g.c, week: g.week }); c += g.c; y += g.y; t10 += g.t10; t20 += g.t20; } }
for (const [nm, nk, lk, ak] of [['10+', 't10', lg10, 'a10'], ['20+', 't20', lg20, 'a20']]) {
  const res = [40, 80, 150, 250, 400, 700].map((K) => { let e = 0, w = 0; for (const r of ex) { const p = (r[nk] + K * lk) / (r.c + K); e += r.w * (p - r[ak]) ** 2; w += r.w; } return [K, e / w]; });
  const best = res.reduce((b, x) => (x[1] < b[1] ? x : b)); out[`k${nm}`] = best[0];
  console.log(`   ${nm} shrink K: ` + res.map(([K, e]) => `${K}: ${(e * 1e4).toFixed(2)}`).join(' · ') + ` → best ${best[0]}`);
}
{ // M: next-game YPC ~ shrunk YPC + coef·(10+ rate shrunk over 80 − league); fit weeks ≤ 7, test ≥ 8
  const mk = (r) => ({ base: (r.y + 60 * lgY) / (r.c + 60), x: (r.t10 + 80 * lg10) / (r.c + 80) - lg10, yy: r.ay, w: r.w, week: r.week });
  const L = ex.map(mk), tr = L.filter((r) => r.week <= 7), te = L.filter((r) => r.week >= 8);
  const fitc = (S) => { let a = 0, b = 0, c0 = 0, sw = 0, sx = 0, sy = 0; for (const r of S) { sw += r.w; sx += r.w * r.x; sy += r.w * (r.yy - r.base); } const mx = sx / sw, my = sy / sw; for (const r of S) { a += r.w * (r.x - mx) * (r.yy - r.base - my); b += r.w * (r.x - mx) ** 2; } c0 = a / b; return { coef: c0, icpt: my - c0 * mx }; };
  const f = fitc(tr), err = (S, g) => S.reduce((s, r) => s + r.w * (r.base + (g ? g.icpt + g.coef * r.x : 0) - r.yy) ** 2, 0) / S.reduce((s, r) => s + r.w, 0);
  const f0 = { coef: 0, icpt: fitc(tr).icpt + 0 }; f0.icpt = tr.reduce((s, r) => s + r.w * (r.yy - r.base), 0) / tr.reduce((s, r) => s + r.w, 0);
  console.log(`M. YPC on 10+ rate: test (wk ≥ 8) error YPC only ${err(te, f0).toFixed(3)} → + explosive ${err(te, f).toFixed(3)} (coef ${f.coef.toFixed(2)}; all-data ${fitc(L).coef.toFixed(2)})`);
  out.meanCoef = fitc(L).coef; out.meanHelps = err(te, f) < err(te, f0);
}
out.lg10 = lg10; out.lg20 = lg20; out.lgYpc = lgY;
if (process.argv.includes('--write')) { fs.writeFileSync(new URL('../src/fitted_cfb_runs.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), data: 'ESPN play-by-play, FBS 2025 (games with pbp)', ...out }, null, 1)); console.log('wrote src/fitted_cfb_runs.json'); }
