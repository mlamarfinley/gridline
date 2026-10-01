// Does a team change how much it runs/passes when its lead RB, WR1 or TE1 is missing? (nflverse pbp 2022–25)
// For each team-game: the lead player at a position = most carries (RB) / targets (WR, TE) over the team's previous 3 games.
// "Absent" = no carry and no target in this game. Effect = (this game − team's prior-game average), compared with
// the same difference in games where he played (controls for schedule and regression). Dropback rate is measured
// over expected for the score/down/distance situation, so trailing more without him doesn't masquerade as a tendency.
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
import { stateOf } from '../src/volume.js';
const { posByGsis } = await loadPlayerIds();
const sit = (p) => `${stateOf(p.sd)}|${p.dn ?? 0}|${p.tg == null ? 'm' : p.tg <= 3 ? 's' : p.tg <= 7 ? 'm' : 'l'}`;
const isDb = (p) => p.t === 'P' || p.scr === 1;
const res = { RB: { out: [], in: [] }, WR: { out: [], in: [] }, TE: { out: [], in: [] } };
for (const season of [2022, 2023, 2024, 2025]) {
  const plays = (await loadPlays(season)).filter((p) => !p.post);
  const L = new Map();
  for (const p of plays) { const a = L.get(sit(p)) || L.set(sit(p), [0, 0]).get(sit(p)); a[0] += isDb(p); a[1]++; }
  const exp = (p) => { const a = L.get(sit(p)); return a[0] / a[1]; };
  const games = new Map(); // team -> week -> agg
  for (const p of plays) {
    const t = games.get(p.o) || games.set(p.o, new Map()).get(p.o);
    const g = t.get(p.w) || t.set(p.w, { db: 0, exp: 0, n: 0, rush: 0, att: 0, ypa: 0, ryds: 0, rbRush: 0, car: new Map(), tgt: new Map() }).get(p.w);
    g.n++; g.db += isDb(p); g.exp += exp(p);
    if (p.t === 'R' && !p.scr) { g.rush++; g.ryds += p.y; if (p.ru) { g.car.set(p.ru, (g.car.get(p.ru) || 0) + 1); if (posByGsis.get(p.ru) === 'RB') g.rbRush++; } }
    if (p.t === 'P' && !p.sk) { g.att++; g.ypa += p.y; if (p.rec) g.tgt.set(p.rec, (g.tgt.get(p.rec) || 0) + 1); }
  }
  for (const [, t] of games) {
    const wk = [...t.keys()].sort((a, b) => a - b);
    for (let i = 3; i < wk.length; i++) {
      const prev = wk.slice(i - 3, i).map((w) => t.get(w)), g = t.get(wk[i]);
      const m = (f) => prev.reduce((a, x) => a + f(x), 0) / prev.length;
      for (const pos of ['RB', 'WR', 'TE']) {
        const tally = new Map();
        for (const x of prev) for (const [id, c] of (pos === 'RB' ? x.car : x.tgt)) if (posByGsis.get(id) === pos) tally.set(id, (tally.get(id) || 0) + c);
        const lead = [...tally].sort((a, b) => b[1] - a[1])[0];
        if (!lead || lead[1] < (pos === 'RB' ? 30 : pos === 'WR' ? 15 : 9)) continue;
        // must have played in all 3 prior games (a real starter, not a one-off)
        if (prev.some((x) => !(x.car.get(lead[0]) || x.tgt.get(lead[0])))) continue;
        const absent = !(g.car.get(lead[0]) || g.tgt.get(lead[0]));
        const d = {
          proe: (g.db - g.exp) / g.n - m((x) => (x.db - x.exp) / x.n),
          rush: g.rush - m((x) => x.rush), att: g.att - m((x) => x.att), plays: g.n - m((x) => x.n),
          ypc: g.ryds / Math.max(1, g.rush) - m((x) => x.ryds / Math.max(1, x.rush)),
          ypa: g.ypa / Math.max(1, g.att) - m((x) => x.ypa / Math.max(1, x.att)),
          rbRushShare: g.rbRush / Math.max(1, g.rush) - m((x) => x.rbRush / Math.max(1, x.rush)),
        };
        res[pos][absent ? 'out' : 'in'].push(d);
      }
    }
  }
}
const mean = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
const se = (a, k) => { const mu = mean(a, k); return Math.sqrt(a.reduce((s, x) => s + (x[k] - mu) ** 2, 0) / (a.length - 1) / a.length); };
for (const pos of Object.keys(res)) {
  const { out, in: inn } = res[pos];
  console.log(`\n${pos}1 absent: n=${out.length} (present n=${inn.length}) — difference vs team's prior 3 games, absent minus present`);
  for (const k of ['proe', 'rush', 'att', 'plays', 'ypc', 'ypa', 'rbRushShare']) {
    const diff = mean(out, k) - mean(inn, k), s = Math.sqrt(se(out, k) ** 2 + se(inn, k) ** 2);
    console.log(`  ${k.padEnd(12)} ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}  ±${s.toFixed(3)}  (z ${(diff / s).toFixed(1)})`);
  }
}
