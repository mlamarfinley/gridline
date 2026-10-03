// COLLEGE carry shares: predict each ball-carrier's share of team rushes in the next game (2025, after ≥2 games) from
//  (a) this season's games (recency 0.82/game, appearance-only — like the live model),
//  (b) + LAST SEASON's same-team share as a prior worth k games,
//  (c) + blowout games (final margin ≥ 24) down-weighted ×wb.
// Error = |predicted − actual share| (pts), players with ≥10% share either this season or last. α chosen on weeks ≤ 7,
// checked on weeks ≥ 8.   node --no-warnings scripts/cfb_role_test.mjs [--write]
import fs from 'node:fs';
const load = (s) => JSON.parse(fs.readFileSync(new URL(`../data/cfb_history_${s}.json`, import.meta.url), 'utf8'));
const G24 = load(2024), G25 = load(2025);
const prior = new Map(); // team|pid → [sum share, games]
for (const g of G24) for (const [ab, T] of Object.entries(g.teams)) { if (!T.rushAtt) continue; for (const [pid, p] of Object.entries(T.players)) if (p.car > 0 && !p.qb) { const k = `${ab}|${pid}`; const a = prior.get(k) || prior.set(k, [0, 0]).get(k); a[0] += p.car / T.rushAtt; a[1]++; } }
const byTeam = new Map(); for (const g of G25) for (const [ab, T] of Object.entries(g.teams)) if (T.rushAtt) (byTeam.get(ab) || byTeam.set(ab, []).get(ab)).push({ week: g.week, margin: ab === g.home ? g.hs - g.as : g.as - g.hs, T });
const cases = [];
for (const [ab, L] of byTeam) {
  L.sort((a, b) => a.week - b.week);
  for (let i = 1; i < L.length - 1; i++) {
    const hist = L.slice(0, i + 1), nx = L[i + 1];
    const pids = new Set(hist.flatMap((h) => Object.entries(h.T.players).filter(([, p]) => p.car > 0 && !p.qb).map(([id]) => id)));
    for (const pid of pids) {
      const games = hist.map((h, j) => ({ age: hist.length - 1 - j, blow: Math.abs(h.margin) >= 24, app: !!h.T.players[pid], sh: (h.T.players[pid]?.car || 0) / h.T.rushAtt }));
      const pr = prior.get(`${ab}|${pid}`); const ps = pr && pr[1] >= 4 ? pr[0] / pr[1] : null;
      const y = (nx.T.players[pid]?.car || 0) / nx.T.rushAtt;
      cases.push({ week: nx.week, games, ps, y });
    }
  }
}
const pred = (c, k, wb) => { let s = 0, w = 0, n = 0; for (const g of c.games) { if (!g.app) continue; const ww = Math.pow(0.82, g.age) * (g.blow ? wb : 1); s += ww * g.sh; w += ww; n++; } const a = w ? s / w : 0; return c.ps != null && k ? (n * a + k * c.ps) / (n + k) : a; };
const keep = cases.filter((c) => { const a = pred(c, 0, 1); return a >= 0.1 || (c.ps ?? 0) >= 0.1; });
const tr = keep.filter((c) => c.week <= 7), te = keep.filter((c) => c.week >= 8);
const mae = (L, k, wb) => L.reduce((s, c) => s + Math.abs(pred(c, k, wb) - c.y), 0) / L.length;
const grid = []; for (const k of [0, 1, 2, 3, 5, 8]) for (const wb of [1, 0.5, 0.25]) grid.push({ k, wb, tr: mae(tr, k, wb), te: mae(te, k, wb), all: mae(keep, k, wb) });
const best = grid.reduce((b, g) => (g.tr < b.tr ? g : b));
console.log(`cases ${keep.length} (train wk≤7 ${tr.length}, test wk≥8 ${te.length}); with a last-season prior: ${keep.filter((c) => c.ps != null).length}`);
for (const g of grid) console.log(`  prior k=${g.k} blowout×${g.wb}: train ${(g.tr * 100).toFixed(2)} | test ${(g.te * 100).toFixed(2)} | all ${(g.all * 100).toFixed(2)}${g === best ? '  ← picked on train' : ''}`);
const early = keep.filter((c) => c.games.length <= 4);
console.log(`  early season (≤4 games): current-only ${(mae(early, 0, 1) * 100).toFixed(2)} vs picked ${(mae(early, best.k, best.wb) * 100).toFixed(2)} (n ${early.length})`);
if (process.argv.includes('--write')) fs.writeFileSync(new URL('../src/fitted_cfb_role.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), data: 'ESPN box scores, FBS 2024 (prior) → 2025', priorK: best.k, blowoutWeight: best.wb, blowoutMargin: 24, grid }, null, 1));
