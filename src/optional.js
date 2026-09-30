// Optional, key-gated sources. Both are off unless the env var is set; the UI says so.
import { fetchCached } from './fetcher.js';
import { ODDS_API_KEY, CFBD_API_KEY } from './config.js';
import { normName } from './snaps.js';

const ODDS_MARKETS = {
  player_pass_yds: 'pass_yds', player_pass_completions: 'completions', player_pass_attempts: 'pass_att', player_pass_tds: 'pass_td',
  player_pass_interceptions: 'ints', player_rush_yds: 'rush_yds', player_rush_attempts: 'carries', player_reception_yds: 'rec_yds', player_receptions: 'receptions',
};

/** Player-prop PRICES from The Odds API. Returns {byName: {normName: {stat: {line, overPrice, underPrice, book, updated}}}} */
export async function oddsApiProps(lg, home, away, kickoff, prov) {
  if (!ODDS_API_KEY) return { enabled: false };
  const sport = lg === 'nfl' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';
  const ev = await fetchCached(`https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${ODDS_API_KEY}`, { ttl: 1800, label: 'The Odds API events' });
  prov.add(ev.meta);
  if (!Array.isArray(ev.data)) return { enabled: true, error: ev.meta.error || 'no events' };
  const t0 = Date.parse(kickoff);
  const match = ev.data.find((e) => Math.abs(Date.parse(e.commence_time) - t0) < 6 * 3600e3 && nameHit(e.home_team, home.name) && nameHit(e.away_team, away.name));
  if (!match) return { enabled: true, error: 'event not matched' };
  const r = await fetchCached(`https://api.the-odds-api.com/v4/sports/${sport}/events/${match.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&oddsFormat=american&markets=${Object.keys(ODDS_MARKETS).join(',')}`, { ttl: 1800, label: 'The Odds API player props' });
  prov.add(r.meta);
  const byName = {};
  const books = r.data?.bookmakers || [];
  const book = books.find((b) => b.key === 'draftkings') || books[0];
  for (const m of book?.markets || []) {
    const stat = ODDS_MARKETS[m.key];
    if (!stat) continue;
    for (const o of m.outcomes || []) {
      const k = normName(o.description);
      byName[k] = byName[k] || {};
      const e = (byName[k][stat] = byName[k][stat] || { line: o.point, book: book.title, updated: m.last_update, source: `${book.title} via The Odds API` });
      if (o.name === 'Over') e.overPrice = o.price;
      if (o.name === 'Under') e.underPrice = o.price;
    }
  }
  return { enabled: true, byName };
}
function nameHit(a, b) { return normName(a) === normName(b) || normName(a).includes(normName(b)) || normName(b).includes(normName(a)); }

/** CFBD season advanced stats → published "line yards" metrics for OL/DL context. */
export async function cfbdLineYards(team, season, prov) {
  if (!CFBD_API_KEY) return { enabled: false };
  const r = await fetchCached(`https://api.collegefootballdata.com/stats/season/advanced?year=${season}&team=${encodeURIComponent(team)}`, { ttl: 12 * 3600, headers: { Authorization: `Bearer ${CFBD_API_KEY}` }, label: 'CFBD advanced season stats' });
  prov.add(r.meta);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row) return { enabled: true, error: r.meta.error || 'team not found' };
  return {
    enabled: true,
    offense: { lineYards: row.offense?.lineYards ?? null, secondLevelYards: row.offense?.secondLevelYards ?? null, openFieldYards: row.offense?.openFieldYards ?? null, stuffRate: row.offense?.stuffRate ?? null },
    defense: { lineYards: row.defense?.lineYards ?? null, secondLevelYards: row.defense?.secondLevelYards ?? null, openFieldYards: row.defense?.openFieldYards ?? null, stuffRate: row.defense?.stuffRate ?? null },
  };
}
