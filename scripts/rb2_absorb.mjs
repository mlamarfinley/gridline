// When a team's lead RB misses a game, how much of his carry share does the RB2 absorb? nflverse pbp 2022–25.
// Lead/RB2 by carries over the team's previous 3 games (both played all 3). Share = player's carries / team RB+QB designed rushes.
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
const { posByGsis } = await loadPlayerIds();
const res = [];
for (const season of [2022, 2023, 2024, 2025]) {
  const plays = (await loadPlays(season)).filter((p) => !p.post && p.t === 'R' && !p.scr && p.ru);
  const G = new Map();
  for (const p of plays) { const t = G.get(p.o) || G.set(p.o, new Map()).get(p.o); const g = t.get(p.w) || t.set(p.w, { n: 0, c: new Map() }).get(p.w); g.n++; g.c.set(p.ru, (g.c.get(p.ru) || 0) + 1); }
  for (const [, t] of G) {
    const wk = [...t.keys()].sort((a, b) => a - b);
    for (let i = 3; i < wk.length; i++) {
      const prev = wk.slice(i - 3, i).map((w) => t.get(w)), g = t.get(wk[i]);
      const tot = new Map(); for (const x of prev) for (const [id, c] of x.c) if (posByGsis.get(id) === 'RB') tot.set(id, (tot.get(id) || 0) + c);
      const [a, b] = [...tot].sort((x, y) => y[1] - x[1]);
      if (!a || !b || a[1] < 30 || prev.some((x) => !x.c.get(a[0]))) continue;
      const sh = (id, x) => (x.c.get(id) || 0) / x.n;
      const shA = prev.reduce((s, x) => s + sh(a[0], x), 0) / 3, shB = prev.reduce((s, x) => s + sh(b[0], x), 0) / 3;
      if (g.c.get(a[0])) continue; // lead back played
      if (!g.c.get(b[0])) continue; // RB2 also missing
      res.push({ shA, shB, now: sh(b[0], g), absorbed: (sh(b[0], g) - shB) / shA, teamRushes: g.n });
    }
  }
}
const m = (k) => res.reduce((s, r) => s + r[k], 0) / res.length;
const med = (k) => { const v = res.map((r) => r[k]).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
console.log(`games where the lead RB sat and the RB2 played: ${res.length}`);
console.log(`lead RB's usual share ${(m('shA') * 100).toFixed(1)}%; RB2 usual ${(m('shB') * 100).toFixed(1)}% → ${(m('now') * 100).toFixed(1)}% with the lead out`);
console.log(`RB2 absorbed on average ${(m('absorbed') * 100).toFixed(0)}% of the lead's share (median ${(med('absorbed') * 100).toFixed(0)}%)`);
