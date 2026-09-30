// ESPN public endpoints + parsers. Parsers are pure (tested against recorded fixtures).
import { fetchCached } from './fetcher.js';
import { LEAGUES } from './config.js';
import { parseAmerican } from './odds.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues';

export const url = {
  scoreboard: (lg, { week, season, seasontype = 2 } = {}) => {
    const L = LEAGUES[lg];
    const q = new URLSearchParams();
    if (L.groups) q.set('groups', L.groups);
    q.set('limit', '400');
    if (week != null) { q.set('week', week); q.set('seasontype', seasontype); if (season) q.set('dates', season); }
    return `${SITE}/${L.espn}/scoreboard?${q}`;
  },
  summary: (lg, id) => `${SITE}/${LEAGUES[lg].espn}/summary?event=${id}`,
  schedule: (lg, teamId, season) => `${SITE}/${LEAGUES[lg].espn}/teams/${teamId}/schedule?season=${season}`,
  roster: (lg, teamId) => `${SITE}/${LEAGUES[lg].espn}/teams/${teamId}/roster`,
  depth: (lg, teamId, season) => `${CORE}/${LEAGUES[lg].espn}/seasons/${season}/teams/${teamId}/depthcharts`,
  gamelog: (lg, athleteId, season) => `${WEB}/${LEAGUES[lg].espn}/athletes/${athleteId}/gamelog${season ? `?season=${season}` : ''}`,
  props: (lg, eventId, provider = 100) => `${CORE}/${LEAGUES[lg].espn}/events/${eventId}/competitions/${eventId}/odds/${provider}/propBets?limit=1000`,
};

// ---------- Scoreboard ----------
export async function getScoreboard(lg, opts) {
  const u = url.scoreboard(lg, opts);
  // Live/in-progress slates change quickly; completed weeks do not.
  return fetchCached(u, { ttl: 90, label: `${LEAGUES[lg].label} scoreboard` });
}

export function parseScoreboard(sb) {
  if (!sb) return { season: null, week: null, calendar: [], games: [] };
  const league = sb.leagues?.[0] || {};
  const calendar = (league.calendar || []).flatMap((c) =>
    (c.entries || []).map((e) => ({ seasontype: Number(c.value), week: Number(e.value), label: e.label, detail: e.detail, start: e.startDate, end: e.endDate })),
  );
  const games = (sb.events || []).map(parseEvent);
  return { season: sb.season?.year ?? null, seasontype: sb.season?.type ?? null, week: sb.week?.number ?? null, calendar, games };
}

export function parseEvent(e) {
  const c = e.competitions?.[0] || {};
  const comp = (side) => c.competitors?.find((x) => x.homeAway === side) || {};
  const team = (x) => ({
    id: x.team?.id, abbr: x.team?.abbreviation, name: x.team?.displayName, short: x.team?.shortDisplayName,
    logo: x.team?.logo, color: x.team?.color, score: x.score != null && x.score !== '' ? Number(x.score) : null,
    record: x.records?.[0]?.summary || null, rank: x.curatedRank?.current && x.curatedRank.current < 99 ? x.curatedRank.current : null,
  });
  return {
    id: e.id, name: e.name, shortName: e.shortName, date: e.date,
    week: e.week?.number ?? null, seasonType: e.season?.type ?? null, season: e.season?.year ?? null,
    status: { state: c.status?.type?.state || e.status?.type?.state, name: c.status?.type?.name || e.status?.type?.name, detail: c.status?.type?.shortDetail || e.status?.type?.shortDetail, completed: !!(c.status?.type?.completed ?? e.status?.type?.completed) },
    home: team(comp('home')), away: team(comp('away')),
    venue: c.venue ? { name: c.venue.fullName, city: c.venue.address?.city, state: c.venue.address?.state, country: c.venue.address?.country, indoor: !!c.venue.indoor } : null,
    neutral: !!c.neutralSite,
    weather: e.weather ? { text: e.weather.displayValue, tempF: e.weather.temperature ?? null } : null,
    odds: parseOddsObject(c.odds?.[0]),
    broadcast: c.broadcasts?.flatMap((b) => b.names || []).join(', ') || null,
  };
}

/** Normalise an ESPN odds object (scoreboard `odds[0]` or summary `pickcenter[0]`). */
export function parseOddsObject(o) {
  if (!o) return null;
  const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  let homeML = n(o.homeTeamOdds?.moneyLine);
  let awayML = n(o.awayTeamOdds?.moneyLine);
  if (homeML == null && o.moneyline) {
    homeML = parseAmerican(o.moneyline.home?.close?.odds ?? o.moneyline.home?.open?.odds);
    awayML = parseAmerican(o.moneyline.away?.close?.odds ?? o.moneyline.away?.open?.odds);
  }
  let homeSpreadOdds = n(o.homeTeamOdds?.spreadOdds);
  let awaySpreadOdds = n(o.awayTeamOdds?.spreadOdds);
  if (homeSpreadOdds == null && o.pointSpread) {
    homeSpreadOdds = parseAmerican(o.pointSpread.home?.close?.odds);
    awaySpreadOdds = parseAmerican(o.pointSpread.away?.close?.odds);
  }
  let overOdds = n(o.overOdds), underOdds = n(o.underOdds);
  if (overOdds == null && o.total) {
    overOdds = parseAmerican(o.total.over?.close?.odds);
    underOdds = parseAmerican(o.total.under?.close?.odds);
  }
  return {
    provider: o.provider?.displayName || o.provider?.name || null,
    details: o.details || null,
    homeSpread: n(o.spread),
    total: n(o.overUnder),
    homeML, awayML, homeSpreadOdds, awaySpreadOdds, overOdds, underOdds,
  };
}

// ---------- Summary ----------
export async function getSummary(lg, id, { final = false } = {}) {
  return fetchCached(url.summary(lg, id), { ttl: final ? 3600 : 300, permanent: final, label: 'Game summary' });
}

export function summaryTeams(sum) {
  const comps = sum?.header?.competitions?.[0]?.competitors || [];
  const get = (side) => {
    const c = comps.find((x) => x.homeAway === side) || {};
    return { id: c.id || c.team?.id, abbr: c.team?.abbreviation, score: c.score != null && c.score !== '' ? Number(c.score) : null, winner: !!c.winner };
  };
  const comp = sum?.header?.competitions?.[0] || {};
  return { home: get('home'), away: get('away'), date: comp.date, completed: !!comp.status?.type?.completed, state: comp.status?.type?.state };
}

const num = (v) => {
  if (v == null || v === '' || v === '--') return null;
  const x = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
};
const split = (v) => {
  const m = String(v || '').match(/^(\d+)\s*\/\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
};

/**
 * Box score -> Map<athleteId, row> for one game. Each row holds the raw per-game stat line in
 * our canonical keys. Missing categories stay undefined (not zero) unless the player appears in
 * that game's box score at all, in which case absent counting stats are 0 for that game.
 */
export function parseBoxscore(sum) {
  const out = new Map();
  for (const t of sum?.boxscore?.players || []) {
    const teamId = t.team?.id;
    const teamAbbr = t.team?.abbreviation;
    for (const cat of t.statistics || []) {
      const labels = cat.labels || [];
      const idx = (l) => labels.indexOf(l);
      for (const a of cat.athletes || []) {
        const id = a.athlete?.id;
        if (!id) continue;
        const s = a.stats || [];
        const g = (l) => (idx(l) >= 0 ? s[idx(l)] : undefined);
        let r = out.get(id);
        if (!r) {
          r = { athleteId: id, name: a.athlete.displayName, short: a.athlete.shortName, jersey: a.athlete.jersey, teamId, teamAbbr, stats: {} };
          out.set(id, r);
        }
        const st = r.stats;
        switch (cat.name) {
          case 'passing': {
            const [c, att] = split(g('C/ATT'));
            st.completions = c; st.pass_att = att; st.pass_yds = num(g('YDS')); st.pass_td = num(g('TD')); st.ints = num(g('INT'));
            const sk = String(g('SACKS') || '').split('-');
            st.sacks = num(sk[0]);
            break;
          }
          case 'rushing':
            st.carries = num(g('CAR')); st.rush_yds = num(g('YDS')); st.rush_td = num(g('TD')); st.long_rush = num(g('LONG'));
            break;
          case 'receiving':
            st.receptions = num(g('REC')); st.rec_yds = num(g('YDS')); st.rec_td = num(g('TD')); st.long_rec = num(g('LONG'));
            if (idx('TGTS') >= 0) st.targets = num(g('TGTS'));
            break;
          case 'fumbles':
            st.fumbles = num(g('FUM')); st.fumbles_lost = num(g('LOST'));
            break;
          case 'kicking': {
            const [fgm, fga] = split(g('FG'));
            const [xpm, xpa] = split(g('XP'));
            st.fg_made = fgm; st.fg_att = fga; st.xp_made = xpm; st.xp_att = xpa; st.k_pts = num(g('PTS'));
            break;
          }
          default: break;
        }
      }
    }
  }
  // Fill zeros for categories a player *could* have had: if he appears in the box score at all,
  // absent counting stats in a category he participates in are true zeros.
  for (const r of out.values()) {
    const st = r.stats;
    if (st.carries != null || st.receptions != null || st.pass_att != null) {
      for (const k of ['fumbles', 'fumbles_lost']) if (st[k] == null) st[k] = 0;
    }
  }
  return out;
}

// ---------- Play-by-play ----------
const NAME = "[A-Z][A-Za-z'\\-]*\\.\\s?[A-Z][A-Za-z'\\-]*(?:\\s(?:St\\.|Jr\\.|II|III|IV|[A-Z][a-z]+))?";
const RE_PASS = new RegExp(`(?:#(\\d+)\\s)?(${NAME})\\s(?:pass|sacked)(?:[^.]*?\\sto\\s(?:#(\\d+)\\s)?(${NAME}))?`);
const RE_RUSH = new RegExp(`(?:#(\\d+)\\s)?(${NAME})\\s(?:up the middle|left|right|rush|run|scrambles|kneels|middle)`);

/** Classify one ESPN play into a football action with attributed names (text-parsed). */
export function classifyPlay(p) {
  // Drop the trailing try/extra-point description so "…TOUCHDOWN. T.Bass extra point is GOOD" still
  // classifies as the scoring run/pass it is.
  const text = (p.text || '').replace(/\.?\s*(?:\(?\S+\s+)?(?:extra point|two-point conversion|two point conversion|TWO-POINT CONVERSION ATTEMPT)\b.*$/i, '');
  const type = p.type?.text || '';
  if (!text || /no play/i.test(text) || /^(Timeout|End |Official Timeout|Two-minute|Kickoff|Punt|Field Goal|Extra Point|PAT|Coin Toss|End Period|End of|Two-Point|2pt)/i.test(type)) return null;
  if (/kicks|punts|field goal/i.test(text) && !/ pass | rush | run |scrambles/i.test(text)) return null;
  const yards = Number.isFinite(p.statYardage) ? p.statYardage : 0;
  const isSack = /sacked/i.test(text) || /Sack/.test(type);
  const isPass = isSack || /\spass\s/i.test(text);
  if (isPass) {
    const m = text.match(RE_PASS);
    const complete = /Pass Reception|Passing Touchdown/i.test(type) || (/ pass (complete|short|deep)/i.test(text) && !/incomplete|intercept/i.test(text) && !isSack);
    return {
      kind: isSack ? 'sack' : 'pass',
      passer: m ? { jersey: m[1] || null, name: m[2] } : null,
      target: !isSack && m && m[4] ? { jersey: m[3] || null, name: m[4] } : null,
      complete: !isSack && complete,
      int: /intercept/i.test(text) || /Interception/i.test(type),
      yards, td: /touchdown/i.test(text) && !/intercept/i.test(text),
      scramble: false,
    };
  }
  if (/kneels/i.test(text)) return null;
  if (/Rush|Rushing/i.test(type) || / (up the middle|left end|right end|left tackle|right tackle|left guard|right guard|rush|run|scrambles) /i.test(text)) {
    const m = text.match(RE_RUSH);
    return { kind: 'rush', rusher: m ? { jersey: m[1] || null, name: m[2] } : null, yards, td: /touchdown/i.test(text), scramble: /scrambles/i.test(text) };
  }
  return null;
}

/**
 * Flatten drives into offensive plays with game-state (score margin BEFORE the snap from the
 * offense's perspective) and down/distance.
 */
export function extractPlays(sum) {
  const teams = summaryTeams(sum);
  const plays = [];
  let prevHome = 0, prevAway = 0;
  for (const d of sum?.drives?.previous || []) {
    const offId = d.team?.id;
    for (const p of d.plays || []) {
      const cls = classifyPlay(p);
      if (cls) {
        const offIsHome = offId === teams.home.id;
        const margin = offIsHome ? prevHome - prevAway : prevAway - prevHome;
        plays.push({
          ...cls, offenseId: offId, defenseId: offIsHome ? teams.away.id : teams.home.id,
          margin, down: p.start?.down ?? null, distance: p.start?.distance ?? null, period: p.period?.number ?? null,
        });
      }
      if (Number.isFinite(p.homeScore)) prevHome = p.homeScore;
      if (Number.isFinite(p.awayScore)) prevAway = p.awayScore;
    }
  }
  return plays;
}

/** Name key used in play-by-play text: "J.Cook", "A.St. Brown" → normalized. */
export function playNameKey(name) {
  return String(name || '').replace(/\s+/g, '').replace(/[^A-Za-z.]/g, '').toLowerCase();
}
export function nameKeysFor(displayName) {
  const parts = String(displayName || '').replace(/\b(Jr\.?|Sr\.?|II|III|IV|V)$/i, '').trim().split(/\s+/);
  if (parts.length < 2) return [];
  const first = parts[0];
  const last = parts.slice(1).join('');
  const keys = new Set();
  keys.add(playNameKey(`${first[0]}.${last}`));
  keys.add(playNameKey(`${first.slice(0, 2)}.${last}`));
  keys.add(playNameKey(`${first.slice(0, 3)}.${last}`));
  // "Amon-Ra St. Brown" -> "A.St.Brown"
  keys.add(playNameKey(`${first[0]}.${parts.slice(1).join(' ')}`));
  return [...keys];
}

/** Build a resolver mapping play-text names/jerseys to athlete ids for one team. */
export function makeResolver(players) {
  const byKey = new Map();
  const byJersey = new Map(); // jersey -> [{id, keys}] (college rosters reuse numbers on O and D)
  const collisions = new Set();
  for (const p of players) {
    const keys = nameKeysFor(p.name);
    for (const k of keys) {
      if (byKey.has(k) && byKey.get(k) !== p.id) collisions.add(k);
      else byKey.set(k, p.id);
    }
    if (p.jersey) {
      const j = String(p.jersey);
      if (!byJersey.has(j)) byJersey.set(j, []);
      byJersey.get(j).push({ id: p.id, keys });
    }
  }
  return (ref) => {
    if (!ref) return null;
    const k = playNameKey(ref.name);
    if (ref.jersey && byJersey.has(ref.jersey)) {
      const c = byJersey.get(ref.jersey);
      const named = c.filter((x) => x.keys.includes(k));
      if (named.length === 1) return named[0].id;
      if (c.length === 1 && !byKey.has(k)) return c[0].id;
    }
    if (collisions.has(k)) return null;
    return byKey.get(k) || null;
  };
}

// ---------- Injuries ----------
export function parseInjuries(sum) {
  const out = [];
  for (const t of sum?.injuries || []) {
    for (const i of t.injuries || []) {
      out.push({
        teamId: t.team?.id, teamAbbr: t.team?.abbreviation,
        athleteId: i.athlete?.id, name: i.athlete?.displayName, pos: i.athlete?.position?.abbreviation,
        status: i.status || i.type?.description || null,
        type: i.details?.type || null, detail: i.details?.detail && i.details.detail !== 'Not Specified' ? i.details.detail : null,
        side: i.details?.side && i.details.side !== 'Not Specified' ? i.details.side : null,
        returnDate: i.details?.returnDate || null, date: i.date || null,
        shortComment: i.shortComment || null, longComment: i.longComment || null,
      });
    }
  }
  return out;
}

export function injurySeverity(status) {
  const s = String(status || '').toLowerCase();
  if (/out|injured reserve|ir\b|suspend|pup|nfi/.test(s)) return 'out';
  if (/doubtful/.test(s)) return 'doubtful';
  if (/questionable|game-time/.test(s)) return 'questionable';
  if (/probable/.test(s)) return 'probable';
  return s ? 'listed' : null;
}

/** Evidence of a workload restriction in the injury text (ESPN comments). */
export function restrictionEvidence(inj) {
  const text = [inj?.shortComment, inj?.longComment, inj?.detail].filter(Boolean).join(' ');
  const m = text.match(/[^.]*\b(snap count|pitch count|limited (workload|snaps|role)|workload (will be )?(managed|limited|restricted)|restriction|ease (him|back) in|won't play a full)\b[^.]*\./i);
  return m ? m[0].trim() : null;
}

// ---------- Roster / depth ----------
export async function getRoster(lg, teamId) {
  return fetchCached(url.roster(lg, teamId), { ttl: 6 * 3600, label: 'Team roster' });
}
export function parseRoster(r) {
  const out = [];
  for (const g of r?.athletes || []) {
    const group = g.position; // offense | defense | specialTeam | injuredReserveOrOut | practiceSquad | ...
    for (const a of g.items || []) {
      out.push({
        id: a.id, name: a.displayName, short: a.shortName, jersey: a.jersey, pos: a.position?.abbreviation,
        group, status: a.status?.name || null,
        injuries: (a.injuries || []).map((i) => ({ status: i.status, date: i.date })),
        headshot: a.headshot?.href || null, experience: a.experience?.years ?? null,
      });
    }
  }
  // College rosters are flat (no group) — keep as-is.
  if (!out.length && Array.isArray(r?.athletes)) {
    for (const a of r.athletes) if (a.id) out.push({ id: a.id, name: a.displayName, jersey: a.jersey, pos: a.position?.abbreviation, group: null, status: a.status?.name || null, injuries: [] });
  }
  return out;
}

export async function getDepth(lg, teamId, season) {
  if (lg !== 'nfl') return { data: null, meta: { url: 'n/a', source: 'ESPN core API', fetchedAt: null, error: 'Depth charts not published for college by ESPN' } };
  return fetchCached(url.depth(lg, teamId, season), { ttl: 6 * 3600, label: 'Depth chart' });
}
export function parseDepth(d) {
  const out = {};
  for (const item of d?.items || []) {
    for (const [pos, v] of Object.entries(item.positions || {})) {
      const ids = (v.athletes || [])
        .slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map((a) => (a.athlete?.$ref || '').match(/athletes\/(\d+)/)?.[1]).filter(Boolean);
      if (!out[pos]) out[pos] = ids;
    }
  }
  return out; // { qb:[ids...], rb:[...], wr:[...], te:[...], pk:[...] }
}

// ---------- Schedule ----------
export async function getSchedule(lg, teamId, season) {
  return fetchCached(url.schedule(lg, teamId, season), { ttl: 1800, label: 'Team schedule' });
}
export function parseSchedule(s) {
  return (s?.events || []).map((e) => {
    const c = e.competitions?.[0] || {};
    return {
      id: e.id, date: e.date, week: e.week?.number ?? null, seasonType: e.seasonType?.type ?? null,
      completed: !!c.status?.type?.completed, state: c.status?.type?.state,
      competitors: (c.competitors || []).map((x) => ({ id: x.id || x.team?.id, abbr: x.team?.abbreviation, homeAway: x.homeAway, score: x.score?.value ?? (x.score?.displayValue != null ? Number(x.score.displayValue) : null) })),
    };
  });
}

// ---------- Player game logs (prior-season history + fields missing from box scores) ----------
export async function getGamelog(lg, athleteId, season) {
  return fetchCached(url.gamelog(lg, athleteId, season), { ttl: 6 * 3600, label: `Game log ${season || ''}`.trim() });
}

const GAMELOG_MAP = {
  completions: 'completions', passingAttempts: 'pass_att', passingYards: 'pass_yds', passingTouchdowns: 'pass_td',
  interceptions: 'ints', longPassing: 'long_cmp', sacks: 'sacks',
  rushingAttempts: 'carries', rushingYards: 'rush_yds', rushingTouchdowns: 'rush_td', longRushing: 'long_rush',
  receptions: 'receptions', receivingTargets: 'targets', receivingYards: 'rec_yds', receivingTouchdowns: 'rec_td', longReception: 'long_rec',
  fumbles: 'fumbles', fumblesLost: 'fumbles_lost', totalKickingPoints: 'k_pts',
};

/** Returns [{eventId, date, opp, atVs, seasonLabel, stats:{...}}] for regular + postseason. */
export function parseGamelog(g) {
  if (!g?.names) return [];
  const names = g.names;
  const rows = new Map();
  for (const st of g.seasonTypes || []) {
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const meta = g.events?.[ev.eventId] || {};
        let r = rows.get(ev.eventId);
        if (!r) {
          r = { eventId: ev.eventId, date: meta.gameDate, opp: meta.opponent?.abbreviation || null, atVs: meta.atVs || null, result: meta.gameResult || null, team: meta.team?.abbreviation || null, seasonLabel: st.displayName, stats: {} };
          rows.set(ev.eventId, r);
        }
        (ev.stats || []).forEach((v, i) => {
          const name = names[i];
          if (GAMELOG_MAP[name]) r.stats[GAMELOG_MAP[name]] = num(v);
          if (name === 'fieldGoalsMade-fieldGoalAttempts') { const [m, a] = split(v); r.stats.fg_made = m; r.stats.fg_att = a; }
          if (name === 'extraPointsMade-extraPointAttempts') { const [m, a] = split(v); r.stats.xp_made = m; r.stats.xp_att = a; }
        });
      }
    }
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// ---------- Player props (ESPN relays DraftKings lines; no prices in this feed) ----------
const PROP_TYPES = {
  8: 'pass_yds', 9: 'completions', 10: 'pass_td', 11: 'carries', 12: 'rush_yds', 13: 'rec_yds', 14: 'receptions', 15: 'ints', 16: 'pass_att',
};
export async function getProps(lg, eventId) {
  return fetchCached(url.props(lg, eventId), { ttl: 600, label: 'Player prop lines' });
}
export function parseProps(p) {
  const out = {};
  for (const it of p?.items || []) {
    const stat = PROP_TYPES[it.type?.id];
    const aid = (it.athlete?.$ref || '').match(/athletes\/(\d+)/)?.[1];
    const line = it.current?.target?.value;
    if (!stat || !aid || line == null) continue;
    out[aid] = out[aid] || {};
    // Feed repeats each line once per side; prices are not included.
    out[aid][stat] = { line: Number(line), open: it.open?.target?.value ?? null, overPrice: it.current?.over?.american ?? null, underPrice: it.current?.under?.american ?? null, updated: it.lastUpdated || null, source: 'DraftKings via ESPN' };
  }
  return out;
}
