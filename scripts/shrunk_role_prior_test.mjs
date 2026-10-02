// A back whose role SHRANK this season (current share, missed team games counted as zeros, < half of his same-team share
// last season): does last season's share still help predict his next game (live blend: k = 1 game of prior), or not?
//   node --no-warnings scripts/shrunk_role_prior_test.mjs
import { loadWeekly } from '../src/situational.js';
const res = { cur: 0, blend: 0, n: 0 };
for (const s of [2022, 2023, 2024, 2025]) {
  const cur = await loadWeekly(s), prev = await loadWeekly(s - 1);
  const tc = (W) => { const m = new Map(); for (const r of W) m.set(`${r.team}|${+r.week}`, (m.get(`${r.team}|${+r.week}`) || 0) + (+r.carries || 0)); return m; };
  const TC = tc(cur), PC = tc(prev);
  const prevShare = new Map(); for (const r of prev) if (r.position === 'RB') { const k = `${r.player_id}|${r.team}`; const a = prevShare.get(k) || prevShare.set(k, [0, 0]).get(k); a[0] += (+r.carries || 0) / (PC.get(`${r.team}|${+r.week}`) || 1); a[1]++; }
  const teamWeeks = new Map(); for (const r of cur) (teamWeeks.get(r.team) || teamWeeks.set(r.team, new Set()).get(r.team)).add(+r.week);
  const app = new Map(); for (const r of cur) if (r.position === 'RB') app.set(`${r.player_id}|${r.team}|${+r.week}`, +r.carries || 0);
  for (const [key, [sum, g]] of prevShare) {
    if (g < 4) continue; const [pid, team] = key.split('|'); const ps = sum / g; const weeks = [...(teamWeeks.get(team) || [])].sort((a, b) => a - b);
    for (let i = 2; i < weeks.length - 1 && weeks[i + 1] <= 13; i++) {
      const win = weeks.slice(0, i + 1); if (!win.some((w) => app.has(`${pid}|${team}|${w}`))) continue;
      const sh = win.map((w) => (app.get(`${pid}|${team}|${w}`) || 0) / (TC.get(`${team}|${w}`) || 1));
      const c = sh.reduce((a, b) => a + b, 0) / sh.length; if (c >= 0.5 * ps) continue;
      const y = (app.get(`${pid}|${team}|${weeks[i + 1]}`) || 0) / (TC.get(`${team}|${weeks[i + 1]}`) || 1);
      const n = win.length, blend = (n * c + 1 * ps) / (n + 1);
      res.cur += Math.abs(c - y); res.blend += Math.abs(blend - y); res.n++;
    }
  }
}
console.log(`backs whose role shrank to < half of last season: n=${res.n} | this season only ${(res.cur / res.n * 100).toFixed(2)} pts | with last-season prior ${(res.blend / res.n * 100).toFixed(2)} pts`);
