// Immutable ledger: append-only, pregame-only snapshots, evaluation + miss explanations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, recordSnapshot, recordResult, evaluationRows, summarizeEvaluation, explainMiss, closeLedger } from '../src/ledger.js';

const future = new Date(Date.now() + 3 * 86400e3).toISOString();
function matchup(overrides = {}, proj = 60) {
  return {
    league: 'nfl', season: 2026, week: 5, eventId: 'g1', kickoff: future, cutoff: future, latestInput: new Date().toISOString(),
    mode: 'pregame', modelVersion: 'test-1', home: { abbr: 'BUF' }, away: { abbr: 'NE' }, odds: null, implied: null, status: {}, weather: null, disclosures: [], sources: [],
    projections: [
      { playerId: 'p1', playerName: 'Test Back', team: 'BUF', opponent: 'NE', position: 'RB', role: 'RB1', stat: 'rush_yds', projection: proj, p10: 30, p50: 58, p90: 95, threshold: 55.5, thresholdSource: 'book line', probOver: 0.55, fairOver: -122, bookLine: 55.5, opportunity: { carries: 15 }, efficiency: { ypc: 4.2 }, expMargin: 6.5, impliedPts: 27 },
      { playerId: 'p2', playerName: 'Test Wideout', team: 'BUF', opponent: 'NE', position: 'WR', role: 'Receiver 1', stat: 'rec_yds', projection: 55, p10: 20, p50: 52, p90: 95, threshold: 49.5, thresholdSource: 'book line', probOver: 0.56, fairOver: -127, bookLine: 49.5, opportunity: { targets: 7 }, efficiency: { ypCatch: 12 }, expMargin: 6.5, impliedPts: 27 },
    ],
    ...overrides,
  };
}

test('pregame snapshot is recorded before kickoff; identical content is not duplicated', () => {
  const d = openLedger(':memory:');
  const r1 = recordSnapshot(matchup(), {}, d);
  assert.ok(r1.ok && r1.rows === 2);
  const r2 = recordSnapshot(matchup(), {}, d);
  assert.ok(r2.ok && r2.duplicate && r2.runId === r1.runId);
  const r3 = recordSnapshot(matchup({}, 66), {}, d); // changed projection -> new run appended
  assert.ok(r3.ok && !r3.duplicate && r3.runId !== r1.runId);
  const old = d.prepare('SELECT projection FROM snapshots WHERE run_id=? AND player_id=?').get(r1.runId, 'p1');
  assert.equal(old.projection, 60, 'old forecast untouched');
  closeLedger();
});

test('snapshots and runs cannot be updated or deleted (database triggers)', () => {
  const d = openLedger(':memory:');
  recordSnapshot(matchup(), {}, d);
  assert.throws(() => d.exec('UPDATE snapshots SET projection = 999'), /immutable/);
  assert.throws(() => d.exec('DELETE FROM snapshots'), /immutable/);
  assert.throws(() => d.exec("UPDATE runs SET kind='backtest'"), /immutable/);
  assert.throws(() => d.exec('DELETE FROM runs'), /immutable/);
  closeLedger();
});

test('pregame snapshots are refused at/after kickoff and with post-kickoff inputs', () => {
  const d = openLedger(':memory:');
  const past = new Date(Date.now() - 3600e3).toISOString();
  assert.equal(recordSnapshot(matchup({ kickoff: past, cutoff: past }), {}, d).ok, false);
  assert.equal(recordSnapshot(matchup({ mode: 'retro' }), {}, d).ok, false);
  assert.equal(recordSnapshot(matchup({ latestInput: new Date(Date.now() + 5 * 86400e3).toISOString() }), {}, d).ok, false);
  assert.equal(recordSnapshot(matchup({ cutoff: new Date(Date.now() + 9 * 86400e3).toISOString() }), {}, d).ok, false);
  // Even a raw INSERT bypassing the app is blocked by the trigger.
  assert.throws(() => d.prepare(`INSERT INTO runs (created_at, kind, league, game_id, kickoff, model_version, input_cutoff, content_hash) VALUES (?,?,?,?,?,?,?,?)`)
    .run('2026-10-05T00:00:00.000Z', 'pregame', 'nfl', 'gx', '2026-10-04T17:00:00.000Z', 'v', '2026-10-04T17:00:00.000Z', 'h'), /before kickoff/);
  closeLedger();
});

test('settlement, evaluation metrics (MAE/bias/coverage) and descriptive miss explanations', () => {
  const d = openLedger(':memory:');
  recordSnapshot(matchup(), {}, d);
  const lines = new Map([
    ['p1', { carries: 8, rush_yds: 20, rush_td: 0 }],            // below range, light workload
    ['p2', { targets: 7, receptions: 5, rec_yds: 60 }],           // inside range
  ]);
  recordResult({ gameId: 'g1', league: 'nfl', season: 2026, week: 5, home: 'BUF', away: 'NE', homeScore: 10, awayScore: 24, lines, source: 'test' }, d);
  const rows = evaluationRows({ league: 'nfl', kind: 'pregame' }, d);
  assert.equal(rows.length, 2);
  const s = summarizeEvaluation(rows);
  assert.equal(s.scored, 2);
  assert.equal(s.overall.mae, (40 + 5) / 2);
  assert.equal(s.overall.bias, (40 - 5) / 2);
  assert.equal(s.overall.coverage, 0.5);
  const miss = explainMiss(rows.find((r) => r.player_id === 'p1'));
  assert.match(miss, /Below range/);
  assert.match(miss, /8 carries vs 15 projected/);
  assert.match(miss, /lost by 14 \(expected \+6\.5\)/);
  assert.match(miss, /not a causal attribution/);
  assert.equal(explainMiss(rows.find((r) => r.player_id === 'p2')), null);
  closeLedger();
});

test('players absent from the final box score are DNP and excluded from error metrics', () => {
  const d = openLedger(':memory:');
  recordSnapshot(matchup(), {}, d);
  recordResult({ gameId: 'g1', league: 'nfl', season: 2026, week: 5, home: 'BUF', away: 'NE', homeScore: 20, awayScore: 17, lines: new Map([['p2', { targets: 4, receptions: 2, rec_yds: 18 }]]), source: 'test' }, d);
  const s = summarizeEvaluation(evaluationRows({ kind: 'pregame' }, d));
  assert.equal(s.dnp, 1);
  assert.equal(s.scored, 1);
  closeLedger();
});

test('backtests are stored separately and never counted as pregame accuracy', () => {
  const d = openLedger(':memory:');
  const past = new Date(Date.now() - 86400e3).toISOString();
  const r = recordSnapshot(matchup({ kickoff: past, cutoff: past, mode: 'retro' }), { kind: 'backtest' }, d);
  assert.ok(r.ok);
  recordResult({ gameId: 'g1', league: 'nfl', season: 2026, week: 5, home: 'BUF', away: 'NE', homeScore: 20, awayScore: 17, lines: new Map(), source: 'test' }, d);
  assert.equal(evaluationRows({ kind: 'pregame' }, d).length, 0);
  assert.equal(evaluationRows({ kind: 'backtest' }, d).length, 2);
  closeLedger();
});
