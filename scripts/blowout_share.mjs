// Do lead backs keep their carries when their team is way ahead (or behind)? nflverse pbp 2022–25.
// Lead back = most RB carries in the team's previous 3 games. His share of the team's designed runs, by score state
// (from the offense's view), compared with his share in close games of the SAME game (so game-level effects cancel).
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
import { stateOf } from '../src/volume.js';
const { posByGsis } = await loadPlayerIds();
const agg = {};
for (const season of [2022, 2023, 2024, 2025]) {
  const plays = (await loadPlays(season)).filter((p) => !p.post && p.t === 'R' && !p.scr && p.ru);
  const T = new Map();
  for (const p of plays) { const t = T.get(p.o) || T.set(p.o, new Map()).get(p.o); (t.get(p.w) || t.set(p.w, []).get(p.w)).push(p); }
  for (const [, t] of T) {
    const wk = [...t.keys()].sort((a, b) => a - b);
    for (let i = 3; i < wk.length; i++) {
      const tally = new Map();
      for (const w of wk.slice(i - 3, i)) for (const p of t.get(w)) if (posByGsis.get(p.ru) === 'RB') tally.set(p.ru, (tally.get(p.ru) || 0) + 1);
      const lead = [...tally].sort((a, b) => b[1] - a[1])[0];
      if (!lead || lead[1] < 30) continue;
      const g = t.get(wk[i]);
      if (!g.some((p) => p.ru === lead[0])) continue; // he played
      const by = {};
      for (const p of g) { const s = stateOf(p.sd); const x = by[s] ||= [0, 0]; x[0]++; if (p.ru === lead[0]) x[1]++; }
      const close = by.close;
      if (!close || close[0] < 8) continue;
      for (const [s, [n, k]] of Object.entries(by)) { const a = agg[s] ||= { runs: 0, his: 0, closeRuns: 0, closeHis: 0 }; a.runs += n; a.his += k; a.closeRuns += close[0]; a.closeHis += close[1]; }
    }
  }
}
for (const s of ['blowTrail', 'trail', 'close', 'lead', 'blowLead']) { const a = agg[s]; if (!a) continue; const sh = a.his / a.runs, base = a.closeHis / a.closeRuns; console.log(`${s.padEnd(10)} runs ${String(a.runs).padStart(6)}  lead-back share ${(sh * 100).toFixed(1)}%  vs ${(base * 100).toFixed(1)}% in close play of the same games  → ratio ${(sh / base).toFixed(2)}`); }
