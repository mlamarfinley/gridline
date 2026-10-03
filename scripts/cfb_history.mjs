// Build a college (FBS) game history from ESPN box scores, for testing the college model:
//   data/cfb_history_<season>.json = [{ id, season, week, date, home, away, hs, as, spread (home), total,
//     teams: { ABBR: { sacksTaken, passAtt, rushAtt, players: { id: {name, pos?, car, yds, long, td, rec, recYds} } } } }]
//   node --no-warnings scripts/cfb_history.mjs 2024 2025
import fs from 'node:fs';
import { fetchCached } from '../src/fetcher.js';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const n = (v) => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
for (const season of process.argv.slice(2).map(Number)) {
  const games = [];
  for (let week = 1; week <= 15; week++) {
    const sb = await fetchCached(`${BASE}/scoreboard?dates=${season}&seasontype=2&week=${week}&groups=80&limit=400`, { ttl: 30 * 86400, permanent: true, as: 'json', label: 'cfb history scoreboard' });
    const d = typeof sb.data === 'string' ? JSON.parse(sb.data) : sb.data;
    const ev = (d?.events || []).filter((e) => e.competitions?.[0]?.status?.type?.completed);
    for (let i = 0; i < ev.length; i += 8) {
      await Promise.all(ev.slice(i, i + 8).map(async (e) => {
        try {
          const r = await fetchCached(`${BASE}/summary?event=${e.id}`, { ttl: 365 * 86400, permanent: true, as: 'json', label: 'cfb history summary' });
          const s = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
          const comp = s.header?.competitions?.[0]; const side = (h) => comp?.competitors?.find((c) => c.homeAway === h);
          const H = side('home'), A = side('away'); if (!H || !A) return;
          const pc = (s.pickcenter || [])[0];
          const g = { id: e.id, season, week, date: comp.date, home: H.team.abbreviation, away: A.team.abbreviation, hs: n(H.score), as: n(A.score), spread: pc?.spread ?? null, total: pc?.overUnder ?? null, teams: {} };
          const box = s.boxscore || {};
          for (const t of box.players || []) {
            const ab = t.team.abbreviation, T = (g.teams[ab] = { sacksTaken: 0, passAtt: 0, rushAtt: 0, players: {} });
            const cat = (nm) => t.statistics.find((x) => x.name === nm);
            const ru = cat('rushing'), re = cat('receiving'), pa = cat('passing');
            if (ru) { const L = ru.labels; for (const a of ru.athletes) { const v = Object.fromEntries(L.map((l, j) => [l, a.stats[j]])); T.players[a.athlete.id] = { name: a.athlete.displayName, car: n(v.CAR), yds: n(v.YDS), long: n(v.LONG), td: n(v.TD) }; } }
            if (re) { const L = re.labels; for (const a of re.athletes) { const v = Object.fromEntries(L.map((l, j) => [l, a.stats[j]])); const p = (T.players[a.athlete.id] ||= { name: a.athlete.displayName, car: 0, yds: 0, long: 0, td: 0 }); p.rec = n(v.REC); p.recYds = n(v.YDS); } }
            if (pa) for (const a of pa.athletes) { const ca = String(a.stats[0] || '').split('/'); T.passAtt += n(ca[1]); const p = (T.players[a.athlete.id] ||= { name: a.athlete.displayName, car: 0, yds: 0, long: 0, td: 0 }); p.qb = true; }
          }
          // sacks taken = opponent defenders' sacks
          for (const t of box.players || []) { const def = t.statistics.find((x) => x.name === 'defensive'); if (!def) continue; const j = def.labels.indexOf('SACKS'); const sk = def.athletes.reduce((a, x) => a + n(x.stats[j]), 0); const opp = Object.keys(g.teams).find((k) => k !== t.team.abbreviation); if (opp) g.teams[opp].sacksTaken = sk; }
          for (const t of box.teams || []) { const T = g.teams[t.team.abbreviation]; if (T) T.rushAtt = n(t.statistics.find((x) => x.name === 'rushingAttempts')?.displayValue); }
          games.push(g);
        } catch { /* skip */ }
      }));
    }
    process.stdout.write(`${season} wk${week}: ${games.length} games\n`);
  }
  fs.writeFileSync(new URL(`../data/cfb_history_${season}.json`, import.meta.url), JSON.stringify(games));
}
