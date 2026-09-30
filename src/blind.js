// BLIND HISTORICAL EVALUATION (market-blind).
//
// Stage 0  FREEZE     record model version + hash of all parameters AND model source code.
// Stage 1  SCHEDULE   enumerate completed games; each is immediately reduced to a sanitized
//                     identity {id, season, week, kickoff, home, away}. Scores/odds are dropped.
// Stage 2  PREDICT    buildMatchup(..., {blind}) per game with only prior games that FINISHED
//                     before kickoff. No target summary/box/plays/odds/props, no current rosters,
//                     depth charts, injuries, weather, snaps or news. Each game writes immutable
//                     predictions + an input manifest (URLs, timestamps, hash) BEFORE any scoring.
//                     The manifest is self-checked: any request touching the target game aborts it.
// Stage 3  SEAL       a 'predictions_frozen' event is appended; the batch accepts no more
//                     predictions, and the scorer refuses to run until it exists.
// Stage 4  SCORE      only now fetch target box scores (actuals) and retained historical prop
//                     lines. Lines are 'reconstructed' (retrieved after the game; ESPN timestamps
//                     are not a trustworthy clock), so no strict pregame market accuracy is claimed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR, MODEL_VERSION, PRIORS, SHRINK, SIMS, LEAGUES } from './config.js';
import { WORKLOAD_K, PLAYS_CV, PASS_RATE_SD } from './model.js';
import * as espn from './espn.js';
import { fetchCached } from './fetcher.js';
import { buildMatchup } from './matchup.js';
import { couldHaveFinished } from './history.js';
import { openLedger, actualValue } from './ledger.js';
import { actualLinesFromSummary } from './services.js';
import { parseCsv } from './baselines.js';
import { normName } from './snaps.js';

export const BLIND_MODE = 'market-blind';
// v1 (batch 2): prior games admitted if kickoff+4.5h <= target kickoff (assumption, not proof).
// v2: prior games admitted only if their own play wallclock shows they ENDED before kickoff.
export const CUTOFF_FILTER_VERSION = 'cutoff-v2-wallclock-verified';
// Weeks already inspected (tuning or earlier held-out review) — never "fresh" validation.
export const INSPECTED = { nfl: [2, 3], cfb: [4] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blind_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, mode TEXT NOT NULL,
  model_version TEXT NOT NULL, params_hash TEXT NOT NULL, code_hash TEXT NOT NULL, params_json TEXT, leagues TEXT
);
CREATE TABLE IF NOT EXISTS blind_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS blind_manifests (
  batch_id INTEGER NOT NULL, game_id TEXT NOT NULL, league TEXT, season INTEGER, week INTEGER, kickoff TEXT,
  home TEXT, away TEXT, status TEXT NOT NULL, skip_reason TEXT, created_at TEXT NOT NULL,
  manifest_json TEXT, manifest_hash TEXT, PRIMARY KEY (batch_id, game_id)
);
CREATE TABLE IF NOT EXISTS blind_predictions (
  batch_id INTEGER NOT NULL, game_id TEXT NOT NULL, league TEXT, season INTEGER, week INTEGER, kickoff TEXT,
  team TEXT, opponent TEXT, player_id TEXT NOT NULL, player_name TEXT, position TEXT, role TEXT, stat TEXT NOT NULL,
  projection REAL, p10 REAL, p50 REAL, p90 REAL, quantiles_json TEXT, created_at TEXT NOT NULL, manifest_hash TEXT,
  PRIMARY KEY (batch_id, game_id, player_id, stat)
);
CREATE TABLE IF NOT EXISTS blind_scores (
  batch_id INTEGER NOT NULL, game_id TEXT NOT NULL, player_id TEXT NOT NULL, stat TEXT NOT NULL,
  actual REAL, status TEXT NOT NULL, scored_at TEXT NOT NULL, PRIMARY KEY (batch_id, game_id, player_id, stat)
);
CREATE TABLE IF NOT EXISTS blind_lines (
  batch_id INTEGER NOT NULL, game_id TEXT NOT NULL, player_id TEXT NOT NULL, stat TEXT NOT NULL,
  line REAL, open_line REAL, line_updated TEXT, updated_before_kickoff INTEGER, source TEXT, retrieved_at TEXT,
  tier TEXT NOT NULL, PRIMARY KEY (batch_id, game_id, player_id, stat)
);
CREATE TABLE IF NOT EXISTS blind_line_coverage (
  batch_id INTEGER NOT NULL, game_id TEXT NOT NULL, league TEXT, status TEXT, lines INTEGER, retrieved_at TEXT, PRIMARY KEY (batch_id, game_id)
);
`;
const IMMUTABLE = ['blind_batches', 'blind_events', 'blind_manifests', 'blind_predictions', 'blind_scores', 'blind_lines', 'blind_line_coverage'];

export function openBlind(d = openLedger()) {
  d.exec(SCHEMA);
  for (const t of IMMUTABLE) {
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is immutable'); END;`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is immutable'); END;`);
  }
  // Once a batch is sealed, no prediction or manifest may be added to it.
  d.exec(`CREATE TRIGGER IF NOT EXISTS blind_pred_after_seal BEFORE INSERT ON blind_predictions
    WHEN EXISTS (SELECT 1 FROM blind_events WHERE batch_id = NEW.batch_id AND event = 'predictions_frozen')
    BEGIN SELECT RAISE(ABORT, 'batch is sealed: predictions are frozen'); END;`);
  d.exec(`CREATE TRIGGER IF NOT EXISTS blind_score_before_seal BEFORE INSERT ON blind_scores
    WHEN NOT EXISTS (SELECT 1 FROM blind_events WHERE batch_id = NEW.batch_id AND event = 'predictions_frozen')
    BEGIN SELECT RAISE(ABORT, 'scoring before predictions are frozen is not allowed'); END;`);
  d.exec(`CREATE TRIGGER IF NOT EXISTS blind_lines_before_seal BEFORE INSERT ON blind_lines
    WHEN NOT EXISTS (SELECT 1 FROM blind_events WHERE batch_id = NEW.batch_id AND event = 'predictions_frozen')
    BEGIN SELECT RAISE(ABORT, 'line retrieval before predictions are frozen is not allowed'); END;`);
  return d;
}
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const nowISO = () => new Date().toISOString();
const n = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));

// ---------- Freeze ----------
const CODE_FILES = ['model.js', 'matchup.js', 'history.js', 'roles.js', 'espn.js', 'linegrades.js', 'baselines.js', 'blind.js', 'config.js', 'stats.js'];
export function freezeParams() {
  const params = { MODEL_VERSION, mode: BLIND_MODE, cutoffFilter: CUTOFF_FILTER_VERSION, PRIORS, SHRINK, SIMS, WORKLOAD_K, PLAYS_CV, PASS_RATE_SD };
  const code = CODE_FILES.map((f) => { try { return fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'); } catch { return ''; } }).join('\n/*--*/\n');
  return { params, paramsHash: sha(params), codeHash: sha(code) };
}

// ---------- Schedule (sanitize immediately) ----------
export function sanitizeEvent(e, lg) {
  const g = espn.parseEvent(e);
  return { id: String(g.id), league: lg, season: g.season, week: g.week, kickoff: new Date(g.date).toISOString(), completed: g.status.completed,
    home: { id: String(g.home.id), abbr: g.home.abbr, name: g.home.name }, away: { id: String(g.away.id), abbr: g.away.abbr, name: g.away.name } };
}
export async function listSeasonGames(lg, log = () => {}) {
  const cur = espn.parseScoreboard((await espn.getScoreboard(lg, {})).data);
  const season = cur.season;
  const weeks = cur.calendar.filter((c) => c.seasontype === 2).map((c) => c.week);
  const out = [];
  for (const w of weeks) {
    const r = await fetchCached(espn.url.scoreboard(lg, { week: w, seasontype: 2, season }), { ttl: 3600, label: `Schedule wk ${w}` });
    const evs = r.data?.events || [];
    if (!evs.length && w > (cur.week || 1)) break;
    for (const e of evs) { const g = sanitizeEvent(e, lg); g.week = g.week ?? w; out.push(g); }
  }
  log(`${lg}: ${out.length} scheduled regular-season games listed (season ${season})`);
  const seen = new Set();
  return { season, games: out.filter((g) => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)) };
}

// ---------- As-of-week positions (no current rosters) ----------
const TEAM_MAP = { WSH: 'WAS', LAR: 'LA' };
const nflPosCache = new Map();
async function nflPositionTable(season) {
  if (nflPosCache.has(season)) return nflPosCache.get(season);
  const r = await fetchCached(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`, { ttl: 6 * 3600, as: 'text', label: `nflverse ${season} weekly (positions as of each week)` });
  const rows = r.data ? parseCsv(r.data) : [];
  const t = rows.map((x) => ({ key: `${x.team}|${normName(x.player_display_name || x.player_name)}`, week: Number(x.week), pos: x.position }));
  const out = { rows: t, meta: r.meta };
  nflPosCache.set(season, out);
  return out;
}
/** Infer a position from pre-kickoff box-score usage only (college, or no nflverse match). */
export function inferPosition(u) {
  if ((u.kicks || 0) > 0) return 'PK';
  if ((u.pass_att || 0) >= 5 || ((u.pass_att || 0) > 2 && (u.pass_att || 0) >= (u.carries || 0))) return 'QB';
  if ((u.carries || 0) >= 3 && (u.carries || 0) >= 1.5 * (u.receptions || 0)) return 'RB';
  if ((u.receptions || 0) > 0 || (u.targets || 0) > 0) return 'WR';
  if ((u.carries || 0) > 0) return 'RB';
  return null;
}
export function makePositionsFor(lg, season, week, nflTables) {
  return (games) => {
    const usage = new Map();
    for (const g of games) for (const r of g.box.values()) {
      const u = usage.get(r.athleteId) || { name: r.name, team: r.teamAbbr };
      for (const k of ['pass_att', 'carries', 'receptions', 'targets']) u[k] = (u[k] || 0) + (r.stats[k] || 0);
      u.kicks = (u.kicks || 0) + (r.stats.fg_att || 0) + (r.stats.xp_att || 0);
      usage.set(r.athleteId, u);
    }
    const out = new Map(), source = { nflverse: 0, inferred: 0, none: 0 };
    for (const [id, u] of usage) {
      let pos = null;
      if (lg === 'nfl' && nflTables) {
        const key = `${TEAM_MAP[u.team] || u.team}|${normName(u.name)}`;
        const cur = nflTables.cur.rows.filter((x) => x.key === key && x.week < week).sort((a, b) => b.week - a.week)[0];
        const prev = cur ? null : nflTables.prev.rows.filter((x) => x.key.endsWith(`|${normName(u.name)}`)).sort((a, b) => b.week - a.week)[0];
        pos = cur?.pos || prev?.pos || null;
        if (pos === 'K') pos = 'PK';
        if (pos === 'FB') pos = 'RB';
      }
      if (pos) source.nflverse++;
      else { pos = inferPosition(u); if (pos) source.inferred++; else source.none++; }
      if (pos) out.set(id, pos);
    }
    out.source = source;
    return out;
  };
}

// ---------- Predict ----------
export function isolationViolations(sources, gameId) {
  const id = String(gameId);
  const bad = [];
  for (const s of sources) {
    const u = String(s.url || '');
    if (u.includes(`event=${id}`) || u.includes(`/events/${id}/`) || u.includes(`/events/${id}?`)) bad.push(`target game requested: ${u}`);
    if (/\/roster\b|depthcharts|propBets|\/odds\b|injuries|open-meteo|snap_counts|the-odds-api|collegefootballdata/.test(u)) bad.push(`forbidden source in blind mode: ${u}`);
  }
  return bad;
}

export async function predictGame(lg, game, allGames, { positionsFor }) {
  // Candidates only: "completed" is today's flag and kickoff+2.5h is a physical minimum. Each
  // candidate's actual end time is verified from its own summary inside buildMatchup.
  const prior = allGames.filter((g) => g.id !== game.id && g.completed && couldHaveFinished(g.kickoff, game.kickoff));
  const priorFor = (tid) => prior.filter((g) => g.home.id === tid || g.away.id === tid);
  for (const t of [game.home, game.away]) {
    if (!priorFor(t.id).length) return { skipped: true, reason: `${t.abbr} has no current-season game completed before kickoff (no role history)` };
  }
  let m;
  try { m = await buildMatchup(lg, game.id, { blind: { game, priorGames: prior, positionsFor } }); }
  catch (e) { if (e.blindSkip) return { skipped: true, reason: e.message, audit: e.audit }; throw e; }
  const violations = isolationViolations(m.sources, game.id);
  if (violations.length) return { skipped: true, reason: `isolation violation — ${violations[0]}` };
  return { m, prior };
}

export async function runBlindPredictions({ leagues = ['nfl', 'cfb'], log = () => {}, limit = Infinity, d = openBlind() } = {}) {
  const fr = freezeParams();
  const created = nowISO();
  const batchId = Number(d.prepare('INSERT INTO blind_batches (created_at, mode, model_version, params_hash, code_hash, params_json, leagues) VALUES (?,?,?,?,?,?,?)')
    .run(created, BLIND_MODE, MODEL_VERSION, fr.paramsHash, fr.codeHash, JSON.stringify(fr.params), leagues.join(',')).lastInsertRowid);
  d.prepare('INSERT INTO blind_events (batch_id, event, at, detail) VALUES (?,?,?,?)').run(batchId, 'parameters_frozen', created, `params ${fr.paramsHash.slice(0, 12)} code ${fr.codeHash.slice(0, 12)}`);
  log(`batch ${batchId}: parameters frozen (params ${fr.paramsHash.slice(0, 12)}, code ${fr.codeHash.slice(0, 12)})`);
  const insM = d.prepare('INSERT INTO blind_manifests (batch_id, game_id, league, season, week, kickoff, home, away, status, skip_reason, created_at, manifest_json, manifest_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insP = d.prepare(`INSERT INTO blind_predictions (batch_id, game_id, league, season, week, kickoff, team, opponent, player_id, player_name, position, role, stat, projection, p10, p50, p90, quantiles_json, created_at, manifest_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let done = 0;
  for (const lg of leagues) {
    const { season, games } = await listSeasonGames(lg, log);
    const completed = games.filter((g) => g.completed);
    const nflTables = lg === 'nfl' ? { cur: await nflPositionTable(season), prev: await nflPositionTable(season - 1) } : null;
    for (const game of completed) {
      if (done >= limit) break;
      const t0 = nowISO();
      let res;
      try { res = await predictGame(lg, game, games, { positionsFor: makePositionsFor(lg, season, game.week, nflTables) }); }
      catch (e) { res = { skipped: true, reason: `error: ${e.message}` }; }
      if (res.skipped) {
        insM.run(batchId, game.id, lg, season, game.week, game.kickoff, game.home.abbr, game.away.abbr, 'skipped', res.reason, t0, JSON.stringify({ game, audit: res.audit || null }), sha({ game, reason: res.reason }));
        log(`${lg} wk${game.week} ${game.away.abbr}@${game.home.abbr}: SKIPPED — ${res.reason}`);
        continue;
      }
      const { m, prior } = res;
      const manifest = {
        batchId, mode: BLIND_MODE, modelVersion: MODEL_VERSION, paramsHash: fr.paramsHash, codeHash: fr.codeHash, createdAt: t0,
        game, priorGameIds: { [game.home.abbr]: prior.filter((g) => g.home.id === game.home.id || g.away.id === game.home.id).map((g) => g.id), [game.away.abbr]: prior.filter((g) => g.home.id === game.away.id || g.away.id === game.away.id).map((g) => g.id) },
        leagueBaselineCandidates: prior.length, leagueBaselineExcludedUnverified: m.lineBaseExcluded,
        cutoffFilter: CUTOFF_FILTER_VERSION, priorGameVerification: m.blindAudit,
        sources: m.sources.map((s) => ({ url: s.url, label: s.label, fetchedAt: s.fetchedAt, fromCache: s.fromCache, error: s.error })),
        fidelity: 'Historical stats reconstructed from ESPN/nflverse data retrieved today (not archived as-of snapshots). Only games finished before kickoff; positions from as-of-week nflverse rows or pre-kickoff usage.',
      };
      const mh = sha(manifest);
      d.exec('BEGIN');
      try {
        insM.run(batchId, game.id, lg, season, game.week, game.kickoff, game.home.abbr, game.away.abbr, 'predicted', null, t0, JSON.stringify(manifest), mh);
        for (const p of m.projections) {
          const card = [...m.home.cards, ...m.away.cards, m.home.kicker, m.away.kicker].find((c) => c && c.id === p.playerId);
          const q = card?.stats?.[p.stat]?.quantiles || null;
          insP.run(batchId, game.id, lg, season, game.week, game.kickoff, p.team, p.opponent, p.playerId, p.playerName, p.position, p.role, p.stat, n(p.projection), n(p.p10), n(p.p50), n(p.p90), q ? JSON.stringify(q) : null, t0, mh);
        }
        d.exec('COMMIT');
      } catch (e) { d.exec('ROLLBACK'); log(`${game.id}: insert failed ${e.message}`); continue; }
      done++;
      log(`${lg} wk${game.week} ${game.away.abbr}@${game.home.abbr}: ${m.projections.length} predictions (manifest ${mh.slice(0, 10)})`);
    }
  }
  d.prepare('INSERT INTO blind_events (batch_id, event, at, detail) VALUES (?,?,?,?)').run(batchId, 'predictions_frozen', nowISO(), `${done} games predicted`);
  log(`batch ${batchId}: predictions frozen (${done} games). Scoring may now begin.`);
  return batchId;
}

// ---------- Score (only after seal) ----------
export async function scoreBlind(batchId, { log = () => {}, d = openBlind() } = {}) {
  const sealed = d.prepare("SELECT 1 FROM blind_events WHERE batch_id=? AND event='predictions_frozen'").get(batchId);
  if (!sealed) throw new Error('refusing to score: predictions are not frozen');
  d.prepare('INSERT INTO blind_events (batch_id, event, at, detail) VALUES (?,?,?,?)').run(batchId, 'scoring_started', nowISO(), null);
  const games = d.prepare("SELECT * FROM blind_manifests WHERE batch_id=? AND status='predicted'").all(batchId);
  const insS = d.prepare('INSERT OR IGNORE INTO blind_scores (batch_id, game_id, player_id, stat, actual, status, scored_at) VALUES (?,?,?,?,?,?,?)');
  const insL = d.prepare('INSERT OR IGNORE INTO blind_lines (batch_id, game_id, player_id, stat, line, open_line, line_updated, updated_before_kickoff, source, retrieved_at, tier) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insC = d.prepare('INSERT OR IGNORE INTO blind_line_coverage (batch_id, game_id, league, status, lines, retrieved_at) VALUES (?,?,?,?,?,?)');
  for (const g of games) {
    const preds = d.prepare('SELECT player_id, stat FROM blind_predictions WHERE batch_id=? AND game_id=?').all(batchId, g.game_id);
    const s = await espn.getSummary(g.league, g.game_id, { final: true });
    const at = nowISO();
    const lines = s.data ? actualLinesFromSummary(s.data) : null;
    for (const p of preds) {
      if (!lines) { insS.run(batchId, g.game_id, p.player_id, p.stat, null, 'unavailable', at); continue; }
      const st = lines.get(p.player_id);
      if (!st) { insS.run(batchId, g.game_id, p.player_id, p.stat, null, 'no_box_row', at); continue; }
      const v = actualValue(st, p.stat);
      insS.run(batchId, g.game_id, p.player_id, p.stat, n(v), v == null ? 'unknown' : 'scored', at);
    }
    // Historical prop lines (retained by ESPN after the game).
    const pr = await espn.getProps(g.league, g.game_id);
    const props = pr.data?.items ? espn.parseProps(pr.data) : null;
    insC.run(batchId, g.game_id, g.league, props ? 'retrieved' : (pr.meta.status === 404 ? 'none posted in feed' : `error: ${pr.meta.error}`), props ? Object.values(props).reduce((a, x) => a + Object.keys(x).length, 0) : 0, pr.meta.fetchedAt || at);
    if (props) for (const p of preds) {
      const L = props[p.player_id]?.[p.stat];
      if (!L) continue;
      const before = L.updated ? (Date.parse(L.updated) < Date.parse(g.kickoff) ? 1 : 0) : null;
      insL.run(batchId, g.game_id, p.player_id, p.stat, L.line, n(L.open), L.updated, before, 'DraftKings via ESPN core API (retained post-game)', pr.meta.fetchedAt, 'reconstructed');
    }
    log(`scored ${g.league} ${g.away}@${g.home}: ${preds.length} predictions, ${props ? 'lines retrieved' : 'no lines'}`);
  }
  d.prepare('INSERT INTO blind_events (batch_id, event, at, detail) VALUES (?,?,?,?)').run(batchId, 'scored', nowISO(), `${games.length} games`);
}

// ---------- Report ----------
function metricSet(rows) {
  const s = rows.filter((r) => r.actual != null && r.projection != null);
  if (!s.length) return { n: 0 };
  let ae = 0, se = 0, e = 0, cov = 0;
  for (const r of s) { const x = r.projection - r.actual; ae += Math.abs(x); se += x * x; e += x; if (r.p10 != null && r.actual >= r.p10 && r.actual <= r.p90) cov++; }
  return { n: s.length, mae: ae / s.length, rmse: Math.sqrt(se / s.length), bias: e / s.length, coverage: cov / s.length };
}
function ouRecord(rows, lineKey) {
  let w = 0, l = 0, p = 0, noSide = 0;
  for (const r of rows) {
    const line = r[lineKey];
    if (line == null || r.actual == null || r.projection == null) continue;
    if (r.projection === line) { noSide++; continue; }
    const side = r.projection > line ? 1 : -1;
    const res = r.actual > line ? 1 : r.actual < line ? -1 : 0;
    if (res === 0) p++; else if (res === side) w++; else l++;
  }
  return { wins: w, losses: l, pushes: p, noSide, n: w + l + p, winRate: w + l ? w / (w + l) : null };
}
export function blindReport(batchId, d = openBlind()) {
  const batch = d.prepare('SELECT * FROM blind_batches WHERE id=?').get(batchId);
  if (!batch) return null;
  const events = d.prepare('SELECT event, at, detail FROM blind_events WHERE batch_id=? ORDER BY id').all(batchId);
  const manifests = d.prepare('SELECT game_id, league, week, home, away, status, skip_reason, manifest_hash FROM blind_manifests WHERE batch_id=?').all(batchId);
  const rows = d.prepare(`SELECT p.*, s.actual, s.status AS score_status, l.line, l.open_line, l.updated_before_kickoff, l.line_updated, l.retrieved_at
    FROM blind_predictions p LEFT JOIN blind_scores s ON s.batch_id=p.batch_id AND s.game_id=p.game_id AND s.player_id=p.player_id AND s.stat=p.stat
    LEFT JOIN blind_lines l ON l.batch_id=p.batch_id AND l.game_id=p.game_id AND l.player_id=p.player_id AND l.stat=p.stat
    WHERE p.batch_id=?`).all(batchId);
  const cov = d.prepare('SELECT league, status, COUNT(*) games, SUM(lines) lines FROM blind_line_coverage WHERE batch_id=? GROUP BY league, status').all(batchId);
  const inspected = (r) => (INSPECTED[r.league] || []).includes(r.week);
  const count = (list) => ({
    predictions: list.length,
    scored: list.filter((r) => r.score_status === 'scored').length,
    noRecordedStats: list.filter((r) => r.score_status === 'dnp' || r.score_status === 'no_box_row').length, // absent from box score: participation unverified, NOT proven DNP
    unknown: list.filter((r) => r.score_status === 'unknown').length,
    unscored: list.filter((r) => !r.score_status || r.score_status === 'unavailable').length,
  });
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.league}|${r.week}|${r.position}|${r.stat}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const byGroup = [...groups].map(([k, list]) => { const [league, week, position, stat] = k.split('|'); return { league, week: Number(week), position, stat, inspected: inspected(list[0]), ...count(list), ...metricSet(list) }; })
    .sort((a, b) => a.league.localeCompare(b.league) || a.week - b.week || a.position.localeCompare(b.position) || a.stat.localeCompare(b.stat));
  const bySplit = {};
  for (const lg of ['nfl', 'cfb']) for (const split of ['untouched', 'inspected']) {
    const list = rows.filter((r) => r.league === lg && (split === 'inspected') === inspected(r));
    if (list.length) bySplit[`${lg}:${split}`] = { ...count(list), ...metricSet(list), weeks: [...new Set(list.map((r) => r.week))].sort((a, b) => a - b) };
  }
  // Key stats per league/position (pooled over weeks) for readability.
  const keyStats = {};
  for (const r of rows) { const k = `${r.league}|${r.position}|${r.stat}`; (keyStats[k] ||= []).push(r); }
  const byStat = Object.entries(keyStats).map(([k, list]) => { const [league, position, stat] = k.split('|'); return { league, position, stat, ...count(list), ...metricSet(list), untouched: metricSet(list.filter((r) => !inspected(r))) }; });
  const withLine = rows.filter((r) => r.line != null);
  // Feed timestamps later than our retrieval time are impossible: never treat them as pregame.
  const tsValid = (r) => r.line_updated && r.retrieved_at && Date.parse(r.line_updated) <= Date.parse(r.retrieved_at);
  const impossibleTs = withLine.filter((r) => r.line_updated && !tsValid(r)).length;
  const market = {
    strictPregameVerified: { n: 0, note: 'No archived, provably pregame lines are available free. ESPN retains lines after the game with a lastUpdated field that is not a trustworthy clock (observed timestamps later than retrieval), so strict market accuracy is not claimed.' },
    reconstructedCurrent: { ...ouRecord(withLine, 'line'), note: 'Final "current" line retained by ESPN, retrieved after the game (unverified reconstruction).' },
    reconstructedCurrentTimestampBeforeKickoff: { ...ouRecord(withLine.filter((r) => r.updated_before_kickoff === 1 && tsValid(r)), 'line'), impossibleTimestampsExcluded: impossibleTs, note: 'Subset whose feed timestamp precedes kickoff (impossible timestamps later than retrieval excluded) — still unverified, not archived evidence.' },
    reconstructedOpen: { ...ouRecord(withLine, 'open_line'), note: 'Opening line as retained by ESPN (unverified reconstruction).' },
    coverage: { predictionsWithLine: withLine.length, predictions: rows.length, perLeague: cov },
    roi: 'Not computed: no archived prices.',
  };
  const skipped = manifests.filter((m) => m.status === 'skipped').map((m) => ({ game: m.game_id, league: m.league, week: m.week, matchup: `${m.away}@${m.home}`, reason: m.skip_reason }));
  const skipReasons = {};
  for (const s of skipped) { const k = s.reason.replace(/^[A-Z0-9&]+:\s*/, 'team: ').replace(/^[A-Z0-9&]+ has/, 'team has').replace(/\s*\(.*$/, '').replace(/ — .*$/, '').trim(); skipReasons[k] = (skipReasons[k] || 0) + 1; }
  return {
    batch, events, inspectedWeeks: INSPECTED,
    games: { total: manifests.length, predicted: manifests.filter((m) => m.status === 'predicted').length, skipped: skipped.length, byLeague: ['nfl', 'cfb'].map((lg) => ({ league: lg, total: manifests.filter((m) => m.league === lg).length, predicted: manifests.filter((m) => m.league === lg && m.status === 'predicted').length })) },
    counts: count(rows), overall: metricSet(rows), bySplit, byStat, byGroup, market, skipped, skipReasons,
    cutoffFilter: batch.params_json ? (JSON.parse(batch.params_json).cutoffFilter || 'cutoff-v1-kickoff+4.5h (assumed, not verified)') : null,
    fidelity: 'Reconstruction: prior-game stats were retrieved today from ESPN/nflverse, not archived as-of snapshots. Prior games admitted per the batch cutoff filter (v2: only games whose own final-play wallclock precedes kickoff); no target-game data, market data, current rosters, injuries, depth charts or weather entered any prediction.',
  };
}

export function latestBatch(d = openBlind()) {
  return d.prepare("SELECT b.id FROM blind_batches b WHERE EXISTS (SELECT 1 FROM blind_events e WHERE e.batch_id=b.id AND e.event='scored') ORDER BY b.id DESC LIMIT 1").get()?.id || null;
}

export function saveReport(batchId, d = openBlind()) {
  const r = blindReport(batchId, d);
  const file = path.join(DATA_DIR, `blind_report_${batchId}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 1));
  return { file, report: r };
}
export { LEAGUES };
