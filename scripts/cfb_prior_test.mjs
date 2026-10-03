// COLLEGE: how much should LAST SEASON (2024) inform this season (2025)? Walk-forward on ESPN box scores, next-game error:
//   carry share (backs) and target share (receivers): this season's recency-weighted share blended with last season's
//     same-team share worth k games (also tested: any-team share for transfers);
//   YPC and yards per target: player rate shrunk toward last season's rate (worth wPrev × his last-season volume) then
//     toward league.
// k / wPrev picked on weeks ≤ 7, scored on weeks ≥ 8.   node --no-warnings scripts/cfb_prior_test.mjs [--write]
import fs from 'node:fs';
const load = (s) => JSON.parse(fs.readFileSync(new URL(`../data/cfb_history_${s}.json`, import.meta.url), 'utf8'));
const G24 = load(2024), G25 = load(2025);
// last season per player: same-team and any-team shares, volumes
const P24 = new Map(); // pid → {team → {cs, ts, g}, car, yds, tgt?, rec, recYds}
for (const g of G24) for (const [ab, T] of Object.entries(g.teams)) {
  const teamTgt = Object.values(T.players).reduce((a, p) => a + (p.rec || 0), 0); // receptions as the target proxy (box has no targets)
  for (const [pid, p] of Object.entries(T.players)) { if (p.qb) continue; const a = P24.get(pid) || P24.set(pid, { teams: {}, car: 0, yds: 0, rec: 0, recYds: 0 }).get(pid); const t = (a.teams[ab] ||= { cs: 0, ts: 0, g: 0 });
    t.g++; if (T.rushAtt) t.cs += (p.car || 0) / T.rushAtt; if (teamTgt) t.ts += (p.rec || 0) / teamTgt; a.car += p.car || 0; a.yds += p.yds || 0; a.rec += p.rec || 0; a.recYds += p.recYds || 0; }
}
const lgYpc = 4.75, lgYpr = 11.5;
const byTeam = new Map(); for (const g of G25) for (const [ab, T] of Object.entries(g.teams)) if (T.rushAtt) (byTeam.get(ab) || byTeam.set(ab, []).get(ab)).push({ week: g.week, T, teamRec: Object.values(T.players).reduce((a, p) => a + (p.rec || 0), 0) });
const cases = { carry: [], target: [], ypc: [], ypr: [] };
for (const [ab, L] of byTeam) { L.sort((a, b) => a.week - b.week);
  for (let i = 0; i < L.length - 1; i++) { const H = L.slice(0, i + 1), nx = L[i + 1];
    const pids = new Set(H.flatMap((h) => Object.entries(h.T.players).filter(([, p]) => !p.qb && ((p.car || 0) + (p.rec || 0)) > 0).map(([id]) => id)));
    for (const pid of pids) { const prev = P24.get(pid), same = prev?.teams[ab], anyG = prev ? Object.values(prev.teams).reduce((a, t) => a + t.g, 0) : 0;
      const app = H.map((h, j) => ({ w: Math.pow(0.82, H.length - 1 - j), p: h.T.players[pid], h })).filter((x) => x.p);
      for (const kind of ['carry', 'target']) {
        let s = 0, w = 0; for (const x of app) { const v = kind === 'carry' ? (x.p.car || 0) / x.h.T.rushAtt : x.h.teamRec ? (x.p.rec || 0) / x.h.teamRec : 0; s += x.w * v; w += x.w; }
        const cur = w ? s / w : 0;
        const pS = same && same.g >= 4 ? (kind === 'carry' ? same.cs : same.ts) / same.g : null;
        const pA = prev && anyG >= 4 ? Object.values(prev.teams).reduce((a, t) => a + (kind === 'carry' ? t.cs : t.ts), 0) / anyG : null;
        const np = nx.T.players[pid]; const y = kind === 'carry' ? (np?.car || 0) / nx.T.rushAtt : nx.teamRec ? (np?.rec || 0) / nx.teamRec : 0;
        if (cur < 0.05 && (pS ?? 0) < 0.05) continue;
        cases[kind].push({ week: nx.week, n: app.length, cur, pS, pA, y });
      }
      // efficiency: next game YPC / yards per catch
      const C = app.reduce((a, x) => a + (x.p.car || 0), 0), Y = app.reduce((a, x) => a + (x.p.yds || 0), 0), R = app.reduce((a, x) => a + (x.p.rec || 0), 0), RY = app.reduce((a, x) => a + (x.p.recYds || 0), 0);
      const np = nx.T.players[pid];
      if (np?.car >= 5) cases.ypc.push({ week: nx.week, c: C, y: Y, pc: prev?.car || 0, py: prev?.yds || 0, act: np.yds / np.car, w: np.car });
      if (np?.rec >= 2) cases.ypr.push({ week: nx.week, c: R, y: RY, pc: prev?.rec || 0, py: prev?.recYds || 0, act: np.recYds / np.rec, w: np.rec });
    } } }
const out = {};
for (const kind of ['carry', 'target']) {
  const L = cases[kind], tr = L.filter((c) => c.week <= 7), te = L.filter((c) => c.week >= 8), early = L.filter((c) => c.n <= 3);
  const pred = (c, k, src) => { const p = src === 'any' ? c.pA ?? c.pS : c.pS; return p != null && k ? (c.n * c.cur + k * p) / (c.n + k) : c.cur; };
  const mae = (S, k, src) => S.reduce((a, c) => a + Math.abs(pred(c, k, src) - c.y), 0) / S.length;
  const grid = []; for (const src of ['same', 'any']) for (const k of [0, 0.5, 1, 2, 3]) grid.push({ src, k, tr: mae(tr, k, src), te: mae(te, k, src), early: mae(early, k, src) });
  const best = grid.reduce((b, g) => (g.tr < b.tr ? g : b)); out[kind] = { k: best.k, src: best.src, grid };
  console.log(`${kind} share (n ${L.length}; with a last-season prior ${L.filter((c) => c.pS != null).length}):`);
  for (const g of grid) console.log(`   ${g.src}-team k=${g.k}: train ${(g.tr * 100).toFixed(2)} | test ${(g.te * 100).toFixed(2)} | first 3 games ${(g.early * 100).toFixed(2)}${g === best ? '  ← picked' : ''}`);
}
for (const [kind, lgv, K] of [['ypc', lgYpc, 60], ['ypr', lgYpr, 25]]) {
  const L = cases[kind], tr = L.filter((c) => c.week <= 7), te = L.filter((c) => c.week >= 8);
  const pred = (c, wp) => { const prior = (c.py * wp + K * lgv) / (c.pc * wp + K); return (c.y + K * prior) / (c.c + K); };
  const err = (S, wp) => S.reduce((a, c) => a + c.w * (pred(c, wp) - c.act) ** 2, 0) / S.reduce((a, c) => a + c.w, 0);
  const grid = [0, 0.25, 0.5, 1].map((wp) => ({ wp, tr: err(tr, wp), te: err(te, wp) })); const best = grid.reduce((b, g) => (g.tr < b.tr ? g : b)); out[kind] = { wPrev: best.wp, grid };
  console.log(`${kind} (n ${L.length}): ` + grid.map((g) => `last season ×${g.wp}: train ${g.tr.toFixed(3)} | test ${g.te.toFixed(3)}${g === best ? ' ←' : ''}`).join(' · '));
}
if (process.argv.includes('--write')) fs.writeFileSync(new URL('../src/fitted_cfb_prior.json', import.meta.url), JSON.stringify({ learnedAt: new Date().toISOString(), data: 'ESPN FBS box scores 2024 → 2025', ...out }, null, 1));
