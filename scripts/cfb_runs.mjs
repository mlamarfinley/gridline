// Every college run from cached ESPN play-by-play (FBS 2024–25): data/cfb_runs_<season>.json =
//   [{ g, week, team, pid, qb, y, sd }]  (sd = offense score minus defense score before the play; pid via jersey match)
//   node --no-warnings scripts/cfb_runs.mjs 2024 2025
import fs from 'node:fs';
import { fetchCached } from '../src/fetcher.js';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
for (const season of process.argv.slice(2).map(Number)) {
  const games = JSON.parse(fs.readFileSync(new URL(`../data/cfb_history_${season}.json`, import.meta.url), 'utf8'));
  const out = [];
  for (const gm of games) {
    const r = await fetchCached(`${BASE}/summary?event=${gm.id}`, { ttl: 365 * 86400, permanent: true, as: 'json', label: 'cfb history summary' });
    const s = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const comp = s.header?.competitions?.[0]; if (!comp) continue;
    const idOf = {}; for (const c of comp.competitors) idOf[c.id] = { abbr: c.team.abbreviation, home: c.homeAway === 'home' };
    const jersey = {}; // teamAbbr|jersey → {pid, qb}
    for (const t of s.boxscore?.players || []) for (const cat of t.statistics) for (const a of cat.athletes) if (a.athlete?.jersey) jersey[`${t.team.abbreviation}|${a.athlete.jersey}`] ||= { pid: a.athlete.id, qb: false };
    for (const t of s.boxscore?.players || []) { const pa = t.statistics.find((x) => x.name === 'passing'); for (const a of pa?.athletes || []) { const k = `${t.team.abbreviation}|${a.athlete.jersey}`; if (jersey[k]) jersey[k].qb = true; } }
    let prevH = 0, prevA = 0;
    for (const d of s.drives?.previous || []) for (const p of d.plays || []) {
      const off = p.teamParticipants?.find((x) => x.type === 'offense')?.id;
      if (p.type?.abbreviation === 'RUSH' && off && idOf[off]) {
        const m = /#(\d+)\s+[A-Z][\w.'-]*\s+(?:rush|run)/i.exec(p.text || ''); const y = Number(p.statYardage);
        if (m && Number.isFinite(y)) {
          const T = idOf[off], j = jersey[`${T.abbr}|${m[1]}`];
          if (j) out.push({ g: gm.id, week: gm.week, team: T.abbr, pid: j.pid, qb: j.qb, y, sd: T.home ? prevH - prevA : prevA - prevH });
        }
      }
      prevH = p.homeScore ?? prevH; prevA = p.awayScore ?? prevA;
    }
  }
  fs.writeFileSync(new URL(`../data/cfb_runs_${season}.json`, import.meta.url), JSON.stringify(out));
  const rb = out.filter((x) => !x.qb), c = rb.length;
  console.log(`${season}: ${out.length} runs (${c} non-QB) · non-QB 10+ ${(rb.filter((x) => x.y >= 10).length / c * 100).toFixed(1)}% · 20+ ${(rb.filter((x) => x.y >= 20).length / c * 100).toFixed(1)}% · 40+ ${(rb.filter((x) => x.y >= 40).length / c * 100).toFixed(2)}% · YPC ${(rb.reduce((a, x) => a + x.y, 0) / c).toFixed(2)}`);
}
