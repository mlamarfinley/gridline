// Lead backs and game script, 2022–25 (nflverse). For every game a team's lead back played (lead = most RB carries
// over the team's previous 3 games, 30+), compare his carries and rushing yards with HIS OWN average coming in
// (season to date, ≥2 games). Three cuts:
//   1. final margin           — what winning big actually did (not knowable before kickoff)
//   2. share of plays leading — how long they were ahead
//   3. pregame spread         — the only one usable for a projection
// Team designed runs are reported too (do favorites run more as a team?).
import fs from 'node:fs';
import { loadPlays, loadPlayerIds } from '../src/pbp.js';
const { posByGsis } = await loadPlayerIds();
const games = (await (await fetch('https://github.com/nflverse/nfldata/raw/master/data/games.csv')).text()).trim().split('\n');
const H = games[0].split(','), gi = (k) => H.indexOf(k);
const spread = new Map(); // game_id -> home expected margin
for (const l of games.slice(1)) { const v = l.split(','); if (+v[gi('season')] >= 2022) spread.set(v[gi('game_id')], { home: v[gi('home_team')], sl: v[gi('spread_line')] === '' ? null : +v[gi('spread_line')], res: +v[gi('result')] }); }
const NV = { LA: 'LA' };
const rows = [];
for (const season of [2022, 2023, 2024, 2025]) {
  const plays = (await loadPlays(season)).filter((p) => !p.post);
  const byTeam = new Map();
  for (const p of plays) { const t = byTeam.get(p.o) || byTeam.set(p.o, new Map()).get(p.o); const g = t.get(p.w) || t.set(p.w, { g: p.g, plays: [] }).get(p.w); g.plays.push(p); }
  for (const [team, t] of byTeam) {
    const wk = [...t.keys()].sort((a, b) => a - b);
    const hist = new Map(); // player -> [{c,y}]
    for (let i = 0; i < wk.length; i++) {
      const g = t.get(wk[i]);
      const runs = g.plays.filter((p) => p.t === 'R' && !p.scr && p.ru);
      const per = new Map(); for (const p of runs) { const x = per.get(p.ru) || per.set(p.ru, { c: 0, y: 0 }).get(p.ru); x.c++; x.y += p.y; }
      if (i >= 3) {
        const tally = new Map();
        for (const w of wk.slice(i - 3, i)) for (const p of t.get(w).plays) if (p.t === 'R' && !p.scr && p.ru && posByGsis.get(p.ru) === 'RB') tally.set(p.ru, (tally.get(p.ru) || 0) + 1);
        const lead = [...tally].sort((a, b) => b[1] - a[1])[0];
        const h = lead ? (hist.get(lead[0]) || []) : [];
        if (lead && lead[1] >= 30 && per.has(lead[0]) && h.length >= 2) {
          const s = spread.get(g.g); const isHome = s?.home === team;
          const exp = s?.sl == null ? null : isHome ? s.sl : -s.sl, fin = s ? (isHome ? s.res : -s.res) : null;
          const leadFrac = g.plays.filter((p) => (p.sd ?? 0) > 0).length / g.plays.length;
          rows.push({ season, c: per.get(lead[0]).c, y: per.get(lead[0]).y, avgC: h.reduce((a, x) => a + x.c, 0) / h.length, avgY: h.reduce((a, x) => a + x.y, 0) / h.length, exp, fin, leadFrac, teamRuns: runs.length });
        }
      }
      for (const [id, x] of per) (hist.get(id) || hist.set(id, []).get(id)).push(x);
    }
  }
}
const show = (title, key, buckets) => {
  console.log(`\n${title}`);
  for (const [label, f] of buckets) {
    const R = rows.filter((r) => r[key] != null && f(r[key])); if (R.length < 30) continue;
    const m = (k) => R.reduce((a, r) => a + r[k], 0) / R.length;
    console.log(`  ${label.padEnd(18)} n ${String(R.length).padStart(4)} | carries ${m('c').toFixed(1)} vs his avg ${m('avgC').toFixed(1)} (${(m('c') - m('avgC') >= 0 ? '+' : '')}${(m('c') - m('avgC')).toFixed(1)}) | rush yds ${m('y').toFixed(0)} vs avg ${m('avgY').toFixed(0)} (${(m('y') - m('avgY') >= 0 ? '+' : '')}${(m('y') - m('avgY')).toFixed(0)}) | team runs ${m('teamRuns').toFixed(1)}`);
  }
};
console.log(`lead-back games: ${rows.length}`);
show('1. By FINAL margin (his team)', 'fin', [['lost by 15+', (v) => v <= -15], ['lost by 8–14', (v) => v <= -8 && v > -15], ['within 7', (v) => v > -8 && v < 8], ['won by 8–14', (v) => v >= 8 && v < 15], ['won by 15+', (v) => v >= 15]]);
show('2. By share of snaps spent LEADING', 'leadFrac', [['led <20%', (v) => v < 0.2], ['led 20–50%', (v) => v >= 0.2 && v < 0.5], ['led 50–80%', (v) => v >= 0.5 && v < 0.8], ['led 80%+', (v) => v >= 0.8]]);
show('3. By PREGAME spread (his team)', 'exp', [['dog by 7+', (v) => v <= -7], ['dog by 3–6.5', (v) => v <= -3 && v > -7], ['pick / <3', (v) => v > -3 && v < 3], ['fav by 3–6.5', (v) => v >= 3 && v < 7], ['fav by 7+', (v) => v >= 7]]);
fs.writeFileSync(new URL('../reports/leadback_script.json', import.meta.url), JSON.stringify(rows));
