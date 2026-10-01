// OUTLIER PICK: over/under selection, quality gates, no forced pick, projections untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOutlier, scoreCandidate, OUTLIER_RULES } from '../src/outlier.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const fresh = '2026-10-02T06:00Z';
const base = (o = {}) => ({ playerId: 'p', name: 'Player', team: 'KC', pos: 'RB', stat: 'rush_yds', label: 'Rushing yards', short: 'Rush Yds', proj: 60, p10: 30, p50: 58, p90: 92, line: 59.5, probOver: 0.5, seasonAvg: 62, seasonGames: 4, last5: [50, 70, 65, 40, 80], lineUpdated: fresh, notes: [], ...o });

test('UNDER pick for a low-performance expectation', () => {
  const r = selectOutlier([base({ proj: 38, p10: 18, p90: 60, probOver: 0.18, line: 59.5 }), base({ playerId: 'q', proj: 61 })], { now });
  assert.equal(r.pick.direction, 'UNDER');
  assert.equal(r.pick.playerId, 'p');
  assert.ok(r.pick.gap < 0 && r.pick.gapPct < 0);
  assert.equal(r.pick.sideProb, 1 - 0.18);
  assert.ok(r.pick.evidence.some((e) => /Cleared 59.5 in 3 of last 5/.test(e)));
});

test('OVER pick chosen by standardized gap across any stat with a posted line (incl. supporting player)', () => {
  const r = selectOutlier([
    base({ stat: 'receptions', label: 'Receptions', proj: 6.2, p10: 3, p90: 9, line: 3.5, probOver: 0.8, isDisplayed: false, role: 'Support' }),
    base({ proj: 75, p10: 30, p90: 120, line: 60.5, probOver: 0.64 }),
  ], { now });
  assert.equal(r.pick.stat, 'receptions');
  assert.equal(r.pick.direction, 'OVER');
  assert.equal(r.pick.isDisplayed, false);
});

test('no book line => not a candidate; nothing posted => no pick with reason', () => {
  const r = selectOutlier([base({ line: null }), base({ line: undefined, playerId: 'z' })], { now });
  assert.equal(r.pick, null);
  assert.match(r.noPickReason, /No player prop lines/);
});

test('no forced pick when every gap is small', () => {
  const r = selectOutlier([base({ proj: 61, probOver: 0.53 }), base({ playerId: 'b', proj: 57, probOver: 0.45 })], { now });
  assert.equal(r.pick, null);
  assert.match(r.noPickReason, /No credible disagreement/);
  assert.equal(r.shortlist.length, 2);
});

test('quality gates: tiny sample, out/doubtful and stale lines are ineligible; questionable is penalised', () => {
  assert.equal(scoreCandidate(base({ seasonGames: 1, proj: 20, probOver: 0.05 }), now).eligible, false);
  assert.equal(scoreCandidate(base({ injuryStatus: 'Doubtful', proj: 20, probOver: 0.05 }), now).eligible, false);
  assert.equal(scoreCandidate(base({ lineUpdated: '2026-09-27T00:00Z', proj: 20, probOver: 0.05 }), now).eligible, false);
  const q = scoreCandidate(base({ injuryStatus: 'Questionable', proj: 30, probOver: 0.1 }), now);
  const h = scoreCandidate(base({ proj: 30, probOver: 0.1 }), now);
  assert.ok(q.eligible && q.score < h.score && q.flags.some((f) => /Questionable/.test(f)));
});

test('discrete stats cannot produce a huge z from a zero-width range (SD floor)', () => {
  const c = scoreCandidate(base({ stat: 'pass_td', label: 'Passing TDs', proj: 1.9, p10: 2, p90: 2, line: 1.5, probOver: 0.62 }), now);
  assert.ok(c.sd >= OUTLIER_RULES.sdFloor.td);
  assert.ok(Math.abs(c.z) < 1.5);
});

test('selection never modifies projections', () => {
  const cands = [base({ proj: 38, p10: 18, p90: 60, probOver: 0.18 })];
  const before = JSON.stringify(cands);
  selectOutlier(cands, { now });
  assert.equal(JSON.stringify(cands), before);
});

test('zero-role projection vs a posted line is a role conflict, never an outlier pick', () => {
  const r = selectOutlier([base({ pos: 'QB', stat: 'pass_yds', label: 'Passing yards', proj: 0, p10: 0, p50: 0, p90: 0, line: 213.5, probOver: 0 }), base({ proj: 61, probOver: 0.53 })], { now });
  assert.equal(r.pick, null);
  assert.equal(r.roleConflicts.length, 1);
  assert.equal(r.roleConflicts[0].stat, 'pass_yds');
});

test('a role conflict on one stat excludes all of that player\'s stats', () => {
  const r = selectOutlier([
    base({ playerId: 'm', pos: 'QB', stat: 'pass_yds', proj: 0, p10: 0, p50: 0, p90: 0, line: 213.5, probOver: 0 }),
    base({ playerId: 'm', pos: 'QB', stat: 'rush_yds', proj: 8, p10: 0, p90: 20, line: 26.5, probOver: 0.05 }),
  ], { now });
  assert.equal(r.pick, null);
  assert.equal(r.shortlist.length, 0);
});

test('impossible line timestamp (after retrieval) is never treated as fresh', () => {
  const c = scoreCandidate(base({ lineUpdated: '2026-10-02T22:08Z', retrievedAt: '2026-10-02T19:25Z', proj: 30, probOver: 0.1 }), now);
  assert.ok(c.eligible);
  assert.ok(c.flags.some((f) => /impossible/.test(f)));
  assert.ok(c.quality < 1);
  const ok = scoreCandidate(base({ lineUpdated: '2026-10-02T18:00Z', retrievedAt: '2026-10-02T19:25Z', proj: 30, probOver: 0.1 }), now);
  assert.ok(!ok.flags.some((f) => /impossible/.test(f)));
});

test('minor-role OVER (pocket QB rushing) is penalized below the bar; a running QB with the same gap still qualifies', () => {
  const pocket = base({ pos: 'QB', stat: 'rush_yds', proj: 13.1, p10: 0, p50: 7.3, p90: 34.8, line: 1.5, probOver: 0.65, expVolume: { carries: 2.9, targets: 0, attempts: 34 } });
  const s = scoreCandidate(pocket, now);
  assert.equal(s.eligible, true);
  assert.equal(s.qualifies, false);
  assert.ok(s.flags.some((f) => /minor role/.test(f)));
  const runner = scoreCandidate(base({ pos: 'QB', stat: 'rush_yds', proj: 62, p10: 30, p50: 60, p90: 95, line: 44.5, probOver: 0.7, expVolume: { carries: 9, targets: 0, attempts: 30 } }), now);
  assert.equal(runner.qualifies, true);
  assert.equal(runner.quality, 1);
});

test('OVER on a stat that is not the player\'s role (WR rushing) is ineligible; UNDER is not affected', () => {
  const wr = scoreCandidate(base({ pos: 'WR', stat: 'rush_yds', proj: 9, p10: 0, p50: 3, p90: 22, line: 1.5, probOver: 0.6, expVolume: { carries: 0.6, targets: 7, attempts: null } }), now);
  assert.equal(wr.eligible, false);
  assert.match(wr.reason, /not his role/);
  const under = scoreCandidate(base({ pos: 'QB', stat: 'rush_yds', proj: 3, p10: 0, p50: 1, p90: 10, line: 14.5, probOver: 0.2, expVolume: { carries: 2.5, targets: 0, attempts: 33 } }), now);
  assert.equal(under.direction, 'UNDER');
  assert.equal(under.quality, 1);
  assert.equal(under.qualifies, true);
});

test('TD OVERs are exempt from the zero-game penalty (TDs are naturally zero most games)', () => {
  const td = scoreCandidate(base({ pos: 'QB', stat: 'pass_td', proj: 2.4, p10: 0, p50: 2, p90: 4, line: 1.5, probOver: 0.62, expVolume: { carries: 3, targets: 0, attempts: 34 } }), now);
  assert.equal(td.quality, 1);
});
