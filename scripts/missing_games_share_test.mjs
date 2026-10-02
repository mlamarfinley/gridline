// Depth backs with gaps: a back who appeared in only SOME of his team's games — is his carry share better predicted from
// the games he appeared in (current model), or counting the team games he missed since his first appearance as zeros?
// Target: his share of team carries in the team's NEXT game (0 if he doesn't appear). nflverse weekly 2022–25, RBs,
// weeks 3–13, players with ≥1 appearance and ≥1 missed team game in the window. Shares recency-weighted 0.82^games ago.
//   node --no-warnings scripts/missing_games_share_test.mjs
import { loadWeekly } from '../src/situational.js';
const out = { a: [], b: [] };
const rows = [];
for (const s of [2022, 2023, 2024, 2025]) {
  const W = await loadWeekly(s);
  const teamCar = new Map(), teamWeeks = new Map();
  for (const r of W) { const k = `${r.team}|${+r.week}`; teamCar.set(k, (teamCar.get(k) || 0) + (+r.carries || 0)); (teamWeeks.get(r.team) || teamWeeks.set(r.team, new Set()).get(r.team)).add(+r.week); }
  const by = new Map(); for (const r of W) if (r.position === 'RB') (by.get(r.player_id) || by.set(r.player_id, []).get(r.player_id)).push(r);
  for (const [, G] of by) {
    const team = G[G.length - 1].team; if (G.some((g) => g.team !== team)) continue;
    const weeks = [...teamWeeks.get(team)].sort((a, b) => a - b);
    const app = new Map(G.map((g) => [+g.week, +g.carries || 0]));
    const first = Math.min(...app.keys());
    for (let i = 2; i < weeks.length - 1; i++) {
      const wk = weeks[i], nxt = weeks[i + 1]; if (nxt > 13 || wk < first) continue;
      const win = weeks.slice(0, i + 1).filter((w) => w >= first);
      const missed = win.filter((w) => !app.has(w)).length, appeared = win.length - missed;
      if (!appeared || !missed) continue;
      const share = (w) => (app.get(w) || 0) / (teamCar.get(`${team}|${w}`) || 1);
      let sa = 0, wa = 0, sb = 0, wb = 0;
      win.forEach((w, j) => { const r = Math.pow(0.82, win.length - 1 - j); if (app.has(w)) { sa += r * share(w); wa += r; } sb += r * share(w); wb += r; });
      const a = sa / wa, b = sb / wb, y = share(nxt);
      if (a < 0.02) continue;
      rows.push({ season: s, a, b, y, missedLast: !app.has(wk), missed, appeared, nextPlayed: app.has(nxt) });
    }
  }
}
const mae = (f, L) => L.reduce((s, r) => s + Math.abs(f(r) - r.y), 0) / L.length;
for (const [name, L] of [['all', rows], ['missed his LAST game', rows.filter((r) => r.missedLast)], ['appeared last game', rows.filter((r) => !r.missedLast)], ['held-out 2024–25', rows.filter((r) => r.season >= 2024)], ['missed last, PLAYED next', rows.filter((r) => r.missedLast && r.nextPlayed)], ['missed last, played next, 24–25', rows.filter((r) => r.missedLast && r.nextPlayed && r.season >= 2024)]]) {
  console.log(`${name.padEnd(22)} n=${String(L.length).padStart(4)} | appearances only ${(mae((r) => r.a, L) * 100).toFixed(2)} | zeros for missed games ${(mae((r) => r.b, L) * 100).toFixed(2)} | half-way ${(mae((r) => (r.a + r.b) / 2, L) * 100).toFixed(2)} pts`);
}
