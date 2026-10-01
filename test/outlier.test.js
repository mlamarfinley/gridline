// OUTLIER PICK (fbm-1.5): a line likely to miss BIG, ranked by learned big-miss chance vs typical — not the
// model's raw gap. Real outliers only: no TD / longest-play props, no tiny lines, no coin-flip "sides".
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOutlier, scoreCandidate } from '../src/outlier.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const fresh = '2026-10-02T06:00Z';
// A rushing-yards line of 69.5: the big-miss threshold is max(30, 0.45 × 69.5) = 31.3 yards.
const bm = (o = {}) => ({ boom: 0.16, bust: 0.08, baseBoom: 0.16, baseBust: 0.08, x: [], ...o });
const base = (o = {}) => ({ playerId: 'p', name: 'Player', team: 'KC', pos: 'RB', stat: 'rush_yds', label: 'Rushing yards', short: 'Rush Yds', proj: 70, p10: 30, p50: 68, p90: 115, line: 69.5, probOver: 0.5, seasonAvg: 70, seasonGames: 4, last5: [50, 70, 65, 40, 80], lineUpdated: fresh, notes: [], expVolume: { carries: 15, targets: 3, attempts: null }, bigMiss: bm(), ...o });

test('UNDER: a line likely to miss big on the low side, model agrees and its range reaches the big miss', () => {
  const r = selectOutlier([base({ proj: 52, p10: 20, p90: 90, probOver: 0.3, bigMiss: bm({ bust: 0.22, boom: 0.1 }) }), base({ playerId: 'q' })], { now });
  assert.equal(r.pick.playerId, 'p');
  assert.equal(r.pick.direction, 'UNDER');
  assert.ok(r.pick.lift >= 2.5 && r.pick.bigProb === 0.22 && r.pick.againstProb === 0.1);
  assert.match(r.pick.bigText, /31 yds\+ under/);
});

test('OVER: a boom spot (e.g. a 70-yard line that ends at 120) qualifies when it is more likely our way', () => {
  const r = selectOutlier([base({ proj: 84, p90: 140, probOver: 0.62, bigMiss: bm({ boom: 0.34, bust: 0.07 }) })], { now });
  assert.equal(r.pick.direction, 'OVER');
  assert.ok(r.pick.lift > 2);
});

test('TD props are never outliers (a 0.5 TD line with the model at 1 is one side of a coin flip)', () => {
  const c = scoreCandidate(base({ pos: 'QB', stat: 'pass_td', label: 'Passing TDs', proj: 1.0, p10: 0, p90: 2, line: 0.5, probOver: 0.62, bigMiss: null }), now);
  assert.equal(c.eligible, false);
  assert.match(c.reason, /single play/);
});

test('tiny lines are never outliers (1.5 receptions vs a 0.9 projection is just the other side)', () => {
  const c = scoreCandidate(base({ pos: 'RB', stat: 'receptions', label: 'Receptions', proj: 0.9, p10: 0, p90: 2.5, line: 1.5, probOver: 0.3 }), now);
  assert.equal(c.eligible, false);
  assert.match(c.reason, /too low/);
});

test('volatile both ways is not a pick', () => {
  const c = scoreCandidate(base({ proj: 55, p10: 20, p90: 120, probOver: 0.4, bigMiss: bm({ bust: 0.2, boom: 0.24 }) }), now);
  assert.equal(c.qualifies, false);
});

test('the model\'s own projection on the other side of the line blocks the pick', () => {
  const c = scoreCandidate(base({ proj: 75, p10: 20, p90: 120, probOver: 0.55, bigMiss: bm({ bust: 0.24, boom: 0.1 }) }), now);
  assert.equal(c.direction, 'UNDER');
  assert.equal(c.qualifies, false);
  assert.match(c.reason, /other side/);
});

test('the model\'s range must reach a big miss', () => {
  const c = scoreCandidate(base({ proj: 60, p10: 45, p90: 80, probOver: 0.35, bigMiss: bm({ bust: 0.24, boom: 0.1 }) }), now);
  assert.equal(c.qualifies, false);
  assert.match(c.reason, /range doesn't reach/);
});

test('no forced pick: a weak big-miss signal gives "no real outlier" with the reason', () => {
  const r = selectOutlier([base({ proj: 60, probOver: 0.4, bigMiss: bm({ bust: 0.1 }) }), base({ playerId: 'b' })], { now });
  assert.equal(r.pick, null);
  assert.match(r.noPickReason, /No real outlier/);
});

test('quality gates: tiny sample, out/doubtful and stale lines are ineligible; questionable is flagged, not folded into the score', () => {
  const strong = { proj: 52, p10: 20, p90: 90, probOver: 0.3, bigMiss: bm({ bust: 0.22, boom: 0.1 }) };
  assert.equal(scoreCandidate(base({ ...strong, seasonGames: 1 }), now).eligible, false);
  assert.equal(scoreCandidate(base({ ...strong, injuryStatus: 'Doubtful' }), now).eligible, false);
  assert.equal(scoreCandidate(base({ ...strong, lineUpdated: '2026-09-27T00:00Z' }), now).eligible, false);
  const q = scoreCandidate(base({ ...strong, injuryStatus: 'Questionable' }), now), h = scoreCandidate(base(strong), now);
  assert.ok(q.flags.some((f) => /Questionable/.test(f)) && q.score === h.score);
});

test('selection never modifies projections', () => {
  const cands = [base({ proj: 52, p10: 20, p90: 90, bigMiss: bm({ bust: 0.22 }) })];
  const before = JSON.stringify(cands);
  selectOutlier(cands, { now });
  assert.equal(JSON.stringify(cands), before);
});

test('zero-role projection vs a posted line is a role conflict, never an outlier pick', () => {
  const r = selectOutlier([base({ pos: 'QB', stat: 'pass_yds', label: 'Passing yards', proj: 0, p10: 0, p50: 0, p90: 0, line: 213.5, probOver: 0 }), base({ proj: 61, probOver: 0.53 })], { now });
  assert.equal(r.pick, null);
  assert.equal(r.roleConflicts.length, 1);
});

test('a role conflict on one stat excludes all of that player\'s stats', () => {
  const r = selectOutlier([
    base({ playerId: 'm', pos: 'QB', stat: 'pass_yds', proj: 0, p10: 0, p50: 0, p90: 0, line: 213.5, probOver: 0 }),
    base({ playerId: 'm', pos: 'QB', stat: 'rush_yds', proj: 8, p10: 0, p90: 20, line: 26.5, probOver: 0.05, bigMiss: bm({ bust: 0.3 }) }),
  ], { now });
  assert.equal(r.pick, null);
  assert.equal(r.shortlist.length, 0);
});

test('impossible line timestamp (after retrieval) is flagged, never treated as fresh', () => {
  const c = scoreCandidate(base({ lineUpdated: '2026-10-02T22:08Z', retrievedAt: '2026-10-02T19:25Z' }), now);
  assert.ok(c.eligible && c.flags.some((f) => /impossible/.test(f)));
});

test('minor-role OVER (pocket QB rushing) is penalized below the bar; a running QB with the same signal qualifies', () => {
  const sig = { proj: 38, p10: 0, p50: 30, p90: 75, line: 25.5, probOver: 0.65, bigMiss: bm({ boom: 0.3, bust: 0.07 }) };
  const pocket = scoreCandidate(base({ pos: 'QB', ...sig, expVolume: { carries: 2.9, targets: 0, attempts: 34 } }), now);
  assert.equal(pocket.qualifies, false);
  assert.ok(pocket.flags.some((f) => /minor role/.test(f)));
  const runner = scoreCandidate(base({ pos: 'QB', ...sig, p10: 12, expVolume: { carries: 9, targets: 0, attempts: 30 } }), now);
  assert.equal(runner.qualifies, true);
});

test('OVER on a stat that is not the player\'s role (WR rushing) is ineligible', () => {
  const wr = scoreCandidate(base({ pos: 'WR', proj: 40, p10: 5, p90: 80, line: 25.5, probOver: 0.6, expVolume: { carries: 0.6, targets: 7, attempts: null }, bigMiss: bm({ boom: 0.3, bust: 0.05 }) }), now);
  assert.equal(wr.eligible, false);
  assert.match(wr.reason, /not his role/);
});

test('outliers: a significant gap is stat-specific (10 rush yds on 97.5 yes; 10 pass yds on 239 no; 6 vs 6.5 catches no)', async () => {
  const { sigStrengthOf } = await import('../src/outlier.js');
  const strength = sigStrengthOf;
  assert.ok(strength('rush_yds', 32.5, 40) >= 1); // 7.5 yds is under 9, but 23% of the line → outlier (OR rule)
  assert.ok(strength('rush_yds', 97.5, 86.8) >= 1);
  assert.ok(strength('pass_yds', 239.5, 249) < 1);
  assert.ok(strength('receptions', 6.5, 6.0) < 1);
  assert.ok(strength('rec_yds', 50.5, 34.5) >= 1.5);
  const r = selectOutlier([base({ proj: 86.8, line: 97.5, p10: 40, p90: 130, probOver: 0.38 }), base({ playerId: 'q', proj: 70.5, line: 69.5 })], { now });
  assert.equal(r.outliers.length, 1);
  assert.equal(r.outliers[0].gapDir, 'UNDER');
  assert.ok(r.outliers[0].tierRecord);
});
