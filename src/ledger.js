// Durable, append-only prediction ledger (SQLite via node:sqlite).
//
// Guarantees (enforced by the database, not just the app):
//   * runs / snapshots cannot be UPDATEd or DELETEd (triggers abort).
//   * a 'pregame' run can only be written before kickoff, and its input cutoff must be <= kickoff.
//   * evaluation only ever reads snapshots; actual results live in separate tables.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DB_PATH, DEV_WEEKS } from './config.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pregame','backtest')),
  league TEXT NOT NULL, season INTEGER, week INTEGER,
  game_id TEXT NOT NULL, kickoff TEXT NOT NULL,
  home TEXT, away TEXT,
  model_version TEXT NOT NULL,
  input_cutoff TEXT NOT NULL,
  latest_input TEXT,
  content_hash TEXT NOT NULL,
  game_json TEXT,
  sources_json TEXT,
  CHECK (input_cutoff <= kickoff)
);
CREATE INDEX IF NOT EXISTS runs_game ON runs(game_id, model_version, kind);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  league TEXT NOT NULL, season INTEGER, week INTEGER,
  game_id TEXT NOT NULL, kickoff TEXT NOT NULL,
  team TEXT, opponent TEXT,
  player_id TEXT NOT NULL, player_name TEXT, position TEXT, role TEXT,
  stat TEXT NOT NULL,
  model_version TEXT NOT NULL,
  input_cutoff TEXT NOT NULL, latest_input TEXT,
  projection REAL, p10 REAL, p50 REAL, p90 REAL,
  threshold REAL, threshold_source TEXT, prob_over REAL, fair_over INTEGER,
  book_line REAL, book_over INTEGER, book_under INTEGER, book_source TEXT, book_updated TEXT,
  opportunity_json TEXT, efficiency_json TEXT,
  exp_margin REAL, implied_pts REAL,
  UNIQUE (run_id, player_id, stat)
);
CREATE INDEX IF NOT EXISTS snaps_game ON snapshots(game_id, player_id, stat);
CREATE TRIGGER IF NOT EXISTS runs_no_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'ledger runs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS runs_no_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'ledger runs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snaps_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'ledger snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snaps_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'ledger snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS pregame_before_kickoff BEFORE INSERT ON runs
  WHEN NEW.kind = 'pregame' AND NEW.created_at >= NEW.kickoff
  BEGIN SELECT RAISE(ABORT, 'pregame snapshot must be created before kickoff'); END;
CREATE TABLE IF NOT EXISTS game_results (
  game_id TEXT PRIMARY KEY, league TEXT, season INTEGER, week INTEGER,
  home TEXT, away TEXT, home_score INTEGER, away_score INTEGER, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS actual_lines (
  game_id TEXT NOT NULL, player_id TEXT NOT NULL, team TEXT,
  dnp INTEGER NOT NULL DEFAULT 0, stats_json TEXT, fetched_at TEXT NOT NULL, source TEXT,
  PRIMARY KEY (game_id, player_id)
);
-- Stat corrections after settlement are appended here rather than silently overwritten.
CREATE TABLE IF NOT EXISTS actual_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, player_id TEXT, old_json TEXT, new_json TEXT, fetched_at TEXT
);
`;

let db = null;
export function openLedger(file = DB_PATH) {
  if (db && db.__file === file) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.__file = file;
  return db;
}
export function closeLedger() { if (db) { db.close(); db = null; } }

function hashProjections(m) {
  const core = m.projections.map((p) => [p.playerId, p.stat, p.projection, p.p10, p.p90, p.bookLine]).sort();
  return crypto.createHash('sha1').update(JSON.stringify(core)).digest('hex');
}

/**
 * Record an immutable snapshot of a built matchup.
 * kind 'pregame' is refused at/after kickoff (also enforced by trigger).
 * Duplicate content for the same game/model/kind is skipped (returns existing run).
 */
export function recordSnapshot(m0, { kind = 'pregame', now = new Date() } = {}, d = openLedger()) {
  const createdAt = now.toISOString();
  // Normalise every timestamp to full ISO-8601 so string comparisons (and the SQL CHECK/trigger) are exact.
  const iso = (x) => (x ? new Date(x).toISOString() : null);
  const m = { ...m0, kickoff: iso(m0.kickoff), cutoff: iso(m0.cutoff), latestInput: iso(m0.latestInput) };
  if (kind === 'pregame' && !(createdAt < m.kickoff)) return { ok: false, reason: 'Kickoff has passed — pregame snapshots can only be recorded before kickoff.' };
  if (kind === 'pregame' && m.mode !== 'pregame') return { ok: false, reason: 'Matchup was built in retrospective mode; not a valid pregame snapshot.' };
  if (m.cutoff > m.kickoff) return { ok: false, reason: 'Input cutoff after kickoff — refusing (future-data leakage).' };
  if (kind === 'pregame' && m.latestInput && m.latestInput >= m.kickoff) return { ok: false, reason: 'An input was retrieved after kickoff — refusing pregame snapshot.' };
  const hash = hashProjections(m);
  const prev = d.prepare('SELECT id, content_hash FROM runs WHERE game_id=? AND model_version=? AND kind=? ORDER BY id DESC LIMIT 1').get(m.eventId, m.modelVersion, kind);
  if (prev && (prev.content_hash === hash || kind === 'backtest')) return { ok: true, runId: prev.id, duplicate: true };
  const game = {
    odds: m.odds, implied: m.implied, status: m.status, mode: m.mode,
    teams: [m.away, m.home].map((t) => ({ abbr: t.abbr, impliedPts: t.impliedPts, expMargin: t.expMargin, scriptWeights: t.scriptWeights, params: t.params })),
    weather: m.weather, disclosures: m.disclosures,
  };
  d.exec('BEGIN');
  try {
    const runStmt = d.prepare(`INSERT INTO runs (created_at, kind, league, season, week, game_id, kickoff, home, away, model_version, input_cutoff, latest_input, content_hash, game_json, sources_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const r = insRun(runStmt, createdAt, kind, m.league, m.season, m.week, m.eventId, m.kickoff, m.home.abbr, m.away.abbr, m.modelVersion, m.cutoff, m.latestInput, hash, JSON.stringify(game), JSON.stringify(m.sources));
    const runId = Number(r.lastInsertRowid);
    const ins = d.prepare(`INSERT INTO snapshots (run_id, created_at, kind, league, season, week, game_id, kickoff, team, opponent, player_id, player_name, position, role, stat, model_version, input_cutoff, latest_input,
      projection, p10, p50, p90, threshold, threshold_source, prob_over, fair_over, book_line, book_over, book_under, book_source, book_updated, opportunity_json, efficiency_json, exp_margin, implied_pts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const p of m.projections) {
      insRun(ins, runId, createdAt, kind, m.league, m.season, m.week, m.eventId, m.kickoff, p.team, p.opponent, p.playerId, p.playerName, p.position, p.role, p.stat, m.modelVersion, m.cutoff, m.latestInput,
        n(p.projection), n(p.p10), n(p.p50), n(p.p90), n(p.threshold), p.thresholdSource, n(p.probOver), n(p.fairOver), n(p.bookLine), n(p.bookOver), n(p.bookUnder), p.bookSource, p.bookUpdated,
        JSON.stringify(slimOpp(p.opportunity)), JSON.stringify(p.efficiency), n(p.expMargin), n(p.impliedPts));
    }
    d.exec('COMMIT');
    return { ok: true, runId, rows: m.projections.length };
  } catch (e) {
    d.exec('ROLLBACK');
    return { ok: false, reason: e.message };
  }
}
// node:sqlite cannot bind `undefined`; store missing values as SQL NULL.
function insRun(stmt, ...args) { return stmt.run(...args.map((v) => (v === undefined ? null : v))); }
function slimOpp(o) {
  if (!o) return null;
  return { carries: o.carries, targets: o.targets, dropbacks: o.dropbacks, carryShare: o.carryShare, targetShare: o.targetShare, teamPlays: o.teamPlays, fgPerGame: o.fgPerGame, impliedPts: o.impliedPts };
}
const n = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));

// ---------- Actuals ----------
export function pendingGames(d = openLedger()) {
  return d.prepare(`SELECT DISTINCT r.game_id, r.league, r.season, r.week, r.home, r.away, r.kickoff FROM runs r
    LEFT JOIN game_results g ON g.game_id = r.game_id WHERE g.game_id IS NULL`).all();
}

export function recordResult({ gameId, league, season, week, home, away, homeScore, awayScore, lines, source }, d = openLedger()) {
  const now = new Date().toISOString();
  d.exec('BEGIN');
  try {
    const players = d.prepare('SELECT DISTINCT player_id, team FROM snapshots WHERE game_id=?').all(gameId);
    const get = d.prepare('SELECT stats_json, dnp FROM actual_lines WHERE game_id=? AND player_id=?');
    const ins = d.prepare('INSERT INTO actual_lines (game_id, player_id, team, dnp, stats_json, fetched_at, source) VALUES (?,?,?,?,?,?,?) ON CONFLICT(game_id, player_id) DO UPDATE SET dnp=excluded.dnp, stats_json=excluded.stats_json, fetched_at=excluded.fetched_at');
    const rev = d.prepare('INSERT INTO actual_revisions (game_id, player_id, old_json, new_json, fetched_at) VALUES (?,?,?,?,?)');
    for (const p of players) {
      const st = lines.get(p.player_id);
      const json = st ? JSON.stringify(st) : null;
      const old = get.get(gameId, p.player_id);
      if (old && old.stats_json !== json) rev.run(gameId, p.player_id, old.stats_json, json, now);
      ins.run(gameId, p.player_id, p.team, st ? 0 : 1, json, now, source);
    }
    d.prepare('INSERT OR REPLACE INTO game_results (game_id, league, season, week, home, away, home_score, away_score, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(gameId, league, season, week, home, away, homeScore, awayScore, now);
    d.exec('COMMIT');
    return { ok: true, players: players.length };
  } catch (e) { d.exec('ROLLBACK'); return { ok: false, reason: e.message }; }
}

// ---------- Evaluation ----------
export function actualValue(stats, stat) {
  if (!stats) return null;
  if (stat === 'ypc') return stats.carries ? stats.rush_yds / stats.carries : null;
  if (stat === 'ypr') return stats.receptions ? stats.rec_yds / stats.receptions : null;
  if (stat === 'tds') return (stats.rush_td || 0) + (stats.rec_td || 0);
  const v = stats[stat];
  if (v == null) {
    // Counting stats absent from a box score line are zero for a player who appeared.
    // `targets` is deliberately NOT zero-filled: college box scores do not publish it, so a
    // missing value means "unknown", not zero.
    if (['rush_yds', 'carries', 'rush_td', 'long_rush', 'receptions', 'rec_yds', 'rec_td', 'long_rec', 'fumbles', 'fumbles_lost', 'pass_yds', 'completions', 'pass_att', 'pass_td', 'ints', 'xp_made', 'fg_made', 'k_pts'].includes(stat)) return 0;
    return null;
  }
  return v;
}

/** Latest run per game/model/kind (for pregame: the last one before kickoff by construction). */
export function evaluationRows({ league, kind = 'pregame', modelVersion } = {}, d = openLedger()) {
  const where = ['s.kind = ?'];
  const args = [kind];
  if (league) { where.push('s.league = ?'); args.push(league); }
  if (modelVersion) { where.push('s.model_version = ?'); args.push(modelVersion); }
  const rows = d.prepare(`
    SELECT s.*, a.dnp, a.stats_json, g.home, g.away, g.home_score, g.away_score, r.home AS r_home
    FROM snapshots s
    JOIN runs r ON r.id = s.run_id
    JOIN (SELECT game_id, model_version, kind, MAX(id) AS id FROM runs GROUP BY game_id, model_version, kind) latest ON latest.id = s.run_id
    JOIN game_results g ON g.game_id = s.game_id
    LEFT JOIN actual_lines a ON a.game_id = s.game_id AND a.player_id = s.player_id
    WHERE ${where.join(' AND ')}`).all(...args);
  return rows.map((r) => {
    const stats = r.stats_json ? JSON.parse(r.stats_json) : null;
    const actual = r.dnp ? null : actualValue(stats, r.stat);
    const teamIsHome = r.team === r.home;
    const margin = r.home_score != null ? (teamIsHome ? r.home_score - r.away_score : r.away_score - r.home_score) : null;
    return { ...r, stats, actual, finalMargin: margin, opportunity: r.opportunity_json ? JSON.parse(r.opportunity_json) : null, efficiency: r.efficiency_json ? JSON.parse(r.efficiency_json) : null };
  });
}

export function summarizeEvaluation(rows) {
  const groups = new Map();
  const add = (key, r) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  };
  const scored = rows.filter((r) => r.actual != null && r.projection != null);
  for (const r of scored) {
    add(`${r.league}|${r.week}|${r.position}|${r.stat}`, r);
  }
  const out = [];
  for (const [k, list] of groups) {
    const [league, week, position, stat] = k.split('|');
    out.push({ league, week: Number(week), position, stat, ...metrics(list) });
  }
  out.sort((a, b) => a.league.localeCompare(b.league) || b.week - a.week || a.position.localeCompare(b.position) || a.stat.localeCompare(b.stat));
  const overall = metrics(scored);
  const dnp = rows.filter((r) => r.dnp).length;
  return { groups: out, overall, dnp, total: rows.length, scored: scored.length, calibration: calibration(scored) };
}

export function metrics(list) {
  const nn = list.length;
  if (!nn) return { n: 0 };
  let ae = 0, err = 0, cov = 0, covN = 0, brier = 0, bN = 0, overHits = 0;
  for (const r of list) {
    const e = r.projection - r.actual;
    ae += Math.abs(e); err += e;
    if (r.p10 != null && r.p90 != null) { covN++; if (r.actual >= r.p10 && r.actual <= r.p90) cov++; }
    if (r.prob_over != null && r.threshold != null) { const o = r.actual > r.threshold ? 1 : 0; brier += (r.prob_over - o) ** 2; bN++; overHits += o; }
  }
  return { n: nn, mae: ae / nn, bias: err / nn, coverage: covN ? cov / covN : null, coverageN: covN, brier: bN ? brier / bN : null, brierN: bN, overRate: bN ? overHits / bN : null };
}

/** Reliability table: predicted P(over) buckets vs realized frequency. */
export function calibration(list) {
  const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
  return buckets.map(([lo, hi]) => {
    const b = list.filter((r) => r.prob_over != null && r.threshold != null && r.prob_over >= lo && r.prob_over < hi);
    const hits = b.filter((r) => r.actual > r.threshold).length;
    return { lo, hi: Math.min(1, hi), n: b.length, meanPred: b.length ? b.reduce((s, r) => s + r.prob_over, 0) / b.length : null, realized: b.length ? hits / b.length : null };
  });
}

const OPP_STAT = {
  rush_yds: ['carries', 'ypc'], carries: ['carries', null], long_rush: ['carries', null], rush_td: ['carries', null], ypc: ['carries', 'ypc'],
  rec_yds: ['targets', 'ypCatch'], receptions: ['targets', 'catchRate'], targets: ['targets', null], long_rec: ['targets', null], rec_td: ['targets', null], ypr: ['targets', 'ypCatch'],
  pass_yds: ['dropbacks', null], completions: ['dropbacks', null], pass_att: ['dropbacks', null], pass_td: ['dropbacks', null], ints: ['dropbacks', null], long_cmp: ['dropbacks', null],
};

/**
 * Descriptive explanation for a projection that landed outside its 10–90 range. Compares
 * projected vs actual workload, efficiency and game script. Deliberately non-causal.
 */
export function explainMiss(r) {
  if (r.actual == null || r.p10 == null || r.p90 == null) return null;
  if (r.actual >= r.p10 && r.actual <= r.p90) return null;
  const dir = r.actual > r.p90 ? 'Above' : 'Below';
  const parts = [`${dir} range: actual ${fmt(r.actual)} vs projected ${fmt(r.projection)} (10–90%: ${fmt(r.p10)}–${fmt(r.p90)}).`];
  const [oppKey, effKey] = OPP_STAT[r.stat] || [null, null];
  const s = r.stats || {};
  const o = r.opportunity || {};
  if (oppKey === 'carries' && o.carries != null) parts.push(`Workload: ${s.carries ?? 0} carries vs ${fmt(o.carries)} projected (${pct((s.carries ?? 0) / Math.max(0.1, o.carries) - 1)}).`);
  if (oppKey === 'targets' && o.targets != null) {
    if (s.targets != null) parts.push(`Workload: ${s.targets} targets vs ${fmt(o.targets)} projected (${pct(s.targets / Math.max(0.1, o.targets) - 1)}).`);
    else parts.push(`Workload: targets not published in this box score; ${s.receptions ?? 0} receptions.`);
  }
  if (oppKey === 'dropbacks' && o.dropbacks != null) parts.push(`Volume: ${s.pass_att ?? 0} attempts vs ${fmt(o.dropbacks)} projected (${pct((s.pass_att ?? 0) / Math.max(0.1, o.dropbacks) - 1)}).`);
  const e = r.efficiency || {};
  if (effKey === 'ypc' && s.carries) parts.push(`Efficiency: ${(s.rush_yds / s.carries).toFixed(1)} YPC vs ${fmt(e.ypc)} projected.`);
  if (effKey === 'ypCatch' && s.receptions) parts.push(`Efficiency: ${(s.rec_yds / s.receptions).toFixed(1)} yds/catch vs ${fmt(e.ypCatch)} projected.`);
  if (effKey === 'catchRate' && s.targets) parts.push(`Catch rate ${pct(s.receptions / s.targets, false)} vs ${pct(e.catchRate, false)} projected.`);
  if (oppKey === 'dropbacks' && s.pass_att) parts.push(`Efficiency: ${(s.pass_yds / s.pass_att).toFixed(1)} yds/att.`);
  if (r.finalMargin != null && r.exp_margin != null) {
    const res = r.finalMargin > 0 ? `won by ${r.finalMargin}` : r.finalMargin < 0 ? `lost by ${-r.finalMargin}` : 'tied';
    parts.push(`Game script: team ${res} (expected ${r.exp_margin >= 0 ? '+' : ''}${r.exp_margin.toFixed(1)}).`);
  }
  if ((r.stat === 'long_rush' || r.stat === 'long_rec' || r.stat === 'long_cmp') || (dir === 'Above' && ((s.long_rush || 0) >= 20 || (s.long_rec || 0) >= 30))) {
    const big = Math.max(s.long_rush || 0, s.long_rec || 0);
    if (big) parts.push(`Longest play: ${big} yds.`);
  }
  parts.push('Descriptive comparison only — not a causal attribution.');
  return parts.join(' ');
}
const fmt = (x) => (x == null ? '—' : Math.round(x * 10) / 10);
const pct = (x, signed = true) => (x == null || !Number.isFinite(x) ? '—' : `${signed && x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);

export function ledgerOverview({ league, kind, modelVersion } = {}, d = openLedger()) {
  const runs = d.prepare(`SELECT id, created_at, kind, league, season, week, game_id, kickoff, home, away, model_version, input_cutoff, latest_input,
    (SELECT COUNT(*) FROM snapshots s WHERE s.run_id = runs.id) AS rows FROM runs ${league ? 'WHERE league = ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(league ? [league] : []));
  const versions = d.prepare('SELECT model_version, kind, COUNT(*) AS runs FROM runs GROUP BY model_version, kind ORDER BY model_version DESC').all();
  const rows = evaluationRows({ league, kind, modelVersion }, d);
  const summary = summarizeEvaluation(rows);
  const misses = rows.map((r) => ({ r, why: explainMiss(r) })).filter((x) => x.why)
    .sort((a, b) => Math.abs(b.r.actual - b.r.projection) / Math.max(1, b.r.p90 - b.r.p10) - Math.abs(a.r.actual - a.r.projection) / Math.max(1, a.r.p90 - a.r.p10))
    .slice(0, 60)
    .map(({ r, why }) => ({ week: r.week, league: r.league, game: `${r.opponent} / ${r.team}`, player: r.player_name, team: r.team, position: r.position, stat: r.stat, projection: r.projection, p10: r.p10, p90: r.p90, actual: r.actual, why }));
  const counts = d.prepare('SELECT kind, COUNT(*) AS runs, COUNT(DISTINCT game_id) AS games FROM runs GROUP BY kind').all();
  const pending = pendingGames(d).length;
  const dev = DEV_WEEKS[modelVersion] || {};
  for (const g of summary.groups) g.inSample = (dev[g.league] || []).includes(g.week);
  const held = rows.filter((r) => r.actual != null && r.projection != null && !(dev[r.league] || []).includes(r.week));
  summary.heldOut = { ...metrics(held), calibration: calibration(held) };
  const devWeeks = Object.entries(dev).map(([lg, w]) => `${lg.toUpperCase()} week ${w.join(', ')}`);
  return { runs, summary, misses, counts, pending, versions, modelVersion: modelVersion || null, kind, devWeeks };
}
