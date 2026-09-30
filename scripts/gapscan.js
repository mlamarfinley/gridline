// Scan a slate for the largest model-vs-book prop gaps (both directions) using fresh data.
// Usage: npm run gapscan -- --league nfl [--week 4]
// Read-only: builds matchups without recording ledger snapshots.
import { getSlate } from '../src/services.js';
import { buildMatchup } from '../src/matchup.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const lg = arg('league', 'nfl');
const sl = await getSlate(lg, { week: arg('week') ? Number(arg('week')) : undefined });
const rows = [];
const absZ = [], absPct = []; let nOver = 0, nUnder = 0, conflicts = [];
const picks = [];
for (const g of sl.games.filter((x) => x.status.state === 'pre')) {
  const m = await buildMatchup(lg, g.id);
  const o = m.outlier;
  absZ.push(...o.gapStats.absZ); absPct.push(...o.gapStats.absGapPct); nOver += o.gapStats.over; nUnder += o.gapStats.under; conflicts.push(...o.roleConflicts.map((r) => ({ game: g.id, ...r })));
  if (o.pick) picks.push({ game: g.id, matchup: g.shortName, name: o.pick.name, stat: o.pick.stat, dir: o.pick.direction, proj: o.pick.proj, line: o.pick.line, z: o.pick.z, score: o.pick.score });
  for (const c of [...o.topOver, ...o.topUnder]) rows.push({ game: g.id, matchup: g.shortName, kickoff: g.date, name: c.name, team: c.team, stat: c.stat, dir: c.direction, proj: c.proj, line: c.line, gap: Math.round(c.gap * 10) / 10, gapPct: Math.round(c.gapPct * 100), z: +c.z.toFixed(2), adj: +c.score.toFixed(2), pSide: c.sideProb != null ? +c.sideProb.toFixed(2) : null, qualifies: c.qualifies, flags: c.flags.join('; '), lineUpdated: c.lineUpdated, retrieved: m.props.retrievedAt });
  console.error(`${g.shortName}: ${o.counted.withLines} lines, pick ${o.pick ? `${o.pick.direction} ${o.pick.name} ${o.pick.stat}` : 'none'}`);
}
const top = (dir) => rows.filter((r) => r.dir === dir).sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj)).slice(0, 6);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(p * (b.length - 1))] : null; };
const dist = { eligibleLines: absZ.length, modelAboveLine: nOver, modelBelowLine: nUnder, medianAbsZ: q(absZ, 0.5), p90AbsZ: q(absZ, 0.9), shareAbsZUnder05: absZ.filter((z) => z < 0.5).length / (absZ.length || 1), medianAbsGapPct: q(absPct, 0.5) };
console.log(JSON.stringify({ dist, conflicts, generatedAt: new Date().toISOString(), league: lg, week: sl.week, games: sl.games.length, picks, topOver: top('OVER'), topUnder: top('UNDER') }, null, 1));
