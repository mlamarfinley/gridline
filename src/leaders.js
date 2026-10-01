// STAT LEADERS: season top-10s for the NFL and college (FBS), from ESPN's public by-athlete statistics endpoint.
// One request per leaderboard, sorted by that stat. Counting stats include every player; rate stats (yards per
// carry, completion %, …) use ESPN's qualified list (minimum attempts per team game), so a 2-carry back can't lead.
// Scrimmage yards aren't sortable at ESPN: merged from the complete rushing and receiving lists (all pages).
import { fetchCached } from './fetcher.js';

const LG = { nfl: 'nfl', cfb: 'college-football' };
const BASE = (lg) => `https://site.web.api.espn.com/apis/common/v3/sports/football/${LG[lg]}/statistics/byathlete`;

// [section, key, label, ESPN category param, group.stat sort field, qualified-only?, decimals]
const BOARDS = [
  ['Passing', 'passYds', 'Passing yards', 'offense:passing', 'passing.passingYards', false, 0],
  ['Passing', 'passTd', 'Passing TDs', 'offense:passing', 'passing.passingTouchdowns', false, 0],
  ['Passing', 'ypa', 'Yards per attempt', 'offense:passing', 'passing.yardsPerPassAttempt', true, 1],
  ['Passing', 'cmpPct', 'Completion %', 'offense:passing', 'passing.completionPct', true, 1],
  ['Passing', 'rating', 'Passer rating', 'offense:passing', 'passing.QBRating', true, 1],
  ['Passing', 'ints', 'Interceptions thrown', 'offense:passing', 'passing.interceptions', false, 0],
  ['Rushing', 'rushYds', 'Rushing yards', 'offense:rushing', 'rushing.rushingYards', false, 0],
  ['Rushing', 'rushTd', 'Rushing TDs', 'offense:rushing', 'rushing.rushingTouchdowns', false, 0],
  ['Rushing', 'ypc', 'Yards per carry', 'offense:rushing', 'rushing.yardsPerRushAttempt', true, 1],
  ['Rushing', 'carries', 'Carries', 'offense:rushing', 'rushing.rushingAttempts', false, 0],
  ['Rushing', 'rushYpg', 'Rushing yards per game', 'offense:rushing', 'rushing.rushingYardsPerGame', true, 1],
  ['Rushing', 'longRush', 'Longest run', 'offense:rushing', 'rushing.longRushing', false, 0],
  ['Receiving', 'recYds', 'Receiving yards', 'offense:receiving', 'receiving.receivingYards', false, 0],
  ['Receiving', 'rec', 'Receptions', 'offense:receiving', 'receiving.receptions', false, 0],
  ['Receiving', 'recTd', 'Receiving TDs', 'offense:receiving', 'receiving.receivingTouchdowns', false, 0],
  ['Receiving', 'ypr', 'Yards per reception', 'offense:receiving', 'receiving.yardsPerReception', true, 1],
  ['Receiving', 'targets', 'Targets', 'offense:receiving', 'receiving.receivingTargets', false, 0],
  ['Receiving', 'yac', 'Yards after catch', 'offense:receiving', 'receiving.receivingYardsAfterCatch', false, 0],
  ['Scoring', 'tds', 'Total touchdowns', 'scoring', 'scoring.totalTouchdowns', false, 0],
  ['Scoring', 'points', 'Points', 'scoring', 'scoring.totalPoints', false, 0],
  ['Defense', 'tackles', 'Tackles', 'defense', 'defensive.totalTackles', false, 0],
  ['Defense', 'sacks', 'Sacks', 'defense', 'defensive.sacks', false, 1],
  ['Defense', 'tfl', 'Tackles for loss', 'defense', 'defensive.tacklesForLoss', false, 0],
  ['Defense', 'pd', 'Passes defended', 'defense', 'defensive.passesDefended', false, 0],
  ['Defense', 'defInt', 'Interceptions', 'defense', 'defensiveInterceptions.interceptions', false, 0],
  ['Kicking', 'fgm', 'Field goals made', 'specialTeams:kicking', 'kicking.fieldGoalsMade', false, 0],
  ['Kicking', 'fgPct', 'Field goal %', 'specialTeams:kicking', 'kicking.fieldGoalPct', true, 1],
];

/** Every player in a category (all pages), for merges like scrimmage yards. */
async function allRows(lg, season, cat, sort) {
  const first = await board(lg, season, cat, sort, false, 1000, 1);
  const rows = [...first.rows];
  for (let pg = 2; pg <= Math.min(first.pages, 5); pg++) rows.push(...(await board(lg, season, cat, sort, false, 1000, pg)).rows);
  return { rows };
}
async function board(lg, season, cat, sort, qualified, limit = 10, page = 1) {
  const u = `${BASE(lg)}?season=${season}&seasontype=2&limit=${limit}${page > 1 ? `&page=${page}` : ''}&category=${encodeURIComponent(cat)}&sort=${sort}:desc${qualified ? '' : '&isqualified=false'}`;
  const r = await fetchCached(u, { ttl: 3600, label: `ESPN ${lg.toUpperCase()} stat leaders` });
  const d = r.data || {};
  const [g, f] = sort.split('.');
  // ESPN sorts by camelCase groups (defensiveInterceptions) but returns lowercase ones (defensiveinterceptions).
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  const idx = (grp, name) => (d.categories?.find((c) => same(c.name, grp))?.names || []).indexOf(name);
  const val = (a, grp, name) => { const i = idx(grp, name); const c = a.categories?.find((x) => same(x.name, grp)); return i >= 0 && c ? c.values?.[i] ?? null : null; };
  const gp = (a) => val(a, 'general', 'gamesPlayed');
  return { meta: r.meta, pages: d.pagination?.pages || 1, rows: (d.athletes || []).map((a) => ({ id: a.athlete?.id, name: a.athlete?.displayName, team: a.athlete?.teamShortName || '', pos: a.athlete?.position?.abbreviation || '', games: gp(a), value: val(a, g, f), a })), val };
}

/** { league, season, retrievedAt, sections: [{ title, boards: [{ key, label, qualified, decimals, rows: [{rank,name,team,pos,games,value}] }] }] } */
export async function statLeaders(lg, season) {
  const sections = new Map();
  let retrievedAt = null;
  const add = (sec, b) => { if (!sections.has(sec)) sections.set(sec, []); sections.get(sec).push(b); };
  await Promise.all(BOARDS.map(async ([sec, key, label, cat, sort, qualified, decimals], order) => {
    try {
      const b = await board(lg, season, cat, sort, qualified);
      retrievedAt = b.meta?.fetchedAt > (retrievedAt || '') ? b.meta.fetchedAt : retrievedAt;
      const rows = b.rows.filter((x) => x.value != null && x.value > 0).slice(0, 10).map(({ a, ...x }, i) => ({ rank: i + 1, ...x }));
      add(sec, { order, key, label, qualified, decimals, rows });
    } catch (e) { add(sec, { order, key, label, qualified, decimals, rows: [], error: e.message }); }
  }));
  // Scrimmage yards = rushing + receiving, merged across both complete lists.
  try {
    const [ru, re] = await Promise.all([allRows(lg, season, 'offense:rushing', 'rushing.rushingYards'), allRows(lg, season, 'offense:receiving', 'receiving.receivingYards')]);
    const m = new Map();
    for (const x of ru.rows) m.set(x.id, { id: x.id, name: x.name, team: x.team, pos: x.pos, games: x.games, rush: x.value || 0, rec: null });
    for (const x of re.rows) { const p = m.get(x.id) || m.set(x.id, { id: x.id, name: x.name, team: x.team, pos: x.pos, games: x.games, rush: null, rec: 0 }).get(x.id); p.rec = x.value || 0; }
    const part = (v, w) => `${v ?? 0} ${w}`;
    const rows = [...m.values()].map((p) => ({ ...p, value: (p.rush || 0) + (p.rec || 0), sub: `${part(p.rush, 'rush')} · ${part(p.rec, 'rec')}` })).sort((a, b) => b.value - a.value).slice(0, 10).map((x, i) => ({ rank: i + 1, ...x }));
    add('Scoring', { order: -1, key: 'scrim', label: 'Scrimmage yards (rush + receiving)', qualified: false, decimals: 0, rows });
  } catch (e) { add('Scoring', { order: -1, key: 'scrim', label: 'Scrimmage yards', rows: [], error: e.message }); }
  const ORDER = ['Passing', 'Rushing', 'Receiving', 'Scoring', 'Defense', 'Kicking'];
  return {
    league: lg, season, retrievedAt, source: 'ESPN public statistics (by athlete)',
    sections: ORDER.filter((s) => sections.has(s)).map((title) => ({ title, boards: sections.get(title).sort((a, b) => a.order - b.order).filter((b) => b.rows.length || b.error) })),
  };
}
