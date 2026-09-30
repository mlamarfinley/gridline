// Estimated OL/DL unit grades: direction, shrinkage, missing inputs, baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lineAgg, rates, baselineFromTeams, gradeComponent, gradeTeam, letter } from '../src/linegrades.js';
import { extractPlays, summaryTeams } from '../src/espn.js';

const base = { mean: { runSuccess: 0.45, stuffRate: 0.18, runYpc: 4.2, run10: 0.1, sackRate: 0.065 }, sd: { runSuccess: 0.05, stuffRate: 0.04, runYpc: 0.6, run10: 0.03, sackRate: 0.02 } };
const agg = (o) => ({ runs: 100, succ: 45, succN: 100, stuff: 18, yds: 420, r10: 10, db: 200, sacks: 13, ...o });

test('baseline-level unit grades 50 (C)', () => {
  const g = gradeComponent('olRun', agg({}), base);
  assert.equal(g.score, 50); assert.equal(g.letter, 'C');
});

test('higher is always better: OL gets credit for success, DL for preventing it', () => {
  const good = agg({ succ: 58, stuff: 10, yds: 520, r10: 15 });
  assert.ok(gradeComponent('olRun', good, base).score > 60, 'offense that runs well => high OL run grade');
  assert.ok(gradeComponent('dlRun', good, base).score < 40, 'defense that allows it => low DL run grade');
  assert.ok(gradeComponent('olPass', agg({ sacks: 4 }), base).score > 55, 'few sacks allowed => good pass pro');
  assert.ok(gradeComponent('dlPass', agg({ sacks: 22 }), base).score > 60, 'many sacks generated => good pass rush');
});

test('shrinkage: the same raw rate on a small sample stays closer to 50', () => {
  const big = gradeComponent('olRun', agg({ runs: 300, succN: 300, succ: 174, stuff: 30, yds: 1500, r10: 45 }), base);
  const small = gradeComponent('olRun', agg({ runs: 20, succN: 20, succ: 12, stuff: 2, yds: 100, r10: 3 }), base);
  assert.ok(big.score > small.score && small.score > 50);
  assert.equal(small.confidence, 'low');
  assert.equal(big.confidence, 'high');
});

test('missing inputs => unavailable, never 0', () => {
  const g = gradeComponent('olPass', agg({ db: 0, sacks: 0 }), base);
  assert.equal(g.score, null); assert.equal(g.letter, null);
  const t = gradeTeam(agg({ runs: 0, succN: 0, succ: 0, stuff: 0, yds: 0, r10: 0, db: 0, sacks: 0 }), agg({}), base);
  assert.equal(t.ol.score, null);
  assert.equal(t.dl.score, 50);
});

test('scores are clipped to 0–100 and letters map monotonically', () => {
  const hi = gradeComponent('olPass', agg({ db: 5000, sacks: 0 }), base).score; assert.ok(hi >= 95 && hi <= 100);
  assert.equal(gradeComponent('olPass', agg({ db: 5000, sacks: 0 }), { ...base, sd: { ...base.sd, sackRate: 0.001 } }).score, 100);
  assert.deepEqual([80, 65, 50, 35, 10].map(letter), ['A', 'B', 'C', 'D', 'F']);
});

test('real play-by-play: scrambles excluded from designed runs; baseline needs spread', () => {
  const sum = JSON.parse(fs.readFileSync(new URL('./fixtures/nfl_summary_final.json', import.meta.url)));
  const plays = extractPlays(sum);
  const t = summaryTeams(sum);
  const a = lineAgg(plays, t.home.id, 'off');
  const allRushes = plays.filter((p) => p.offenseId === t.home.id && p.kind === 'rush').length;
  const scr = plays.filter((p) => p.offenseId === t.home.id && p.kind === 'rush' && p.scramble).length;
  assert.equal(a.runs, allRushes - scr);
  assert.ok(a.db > 20);
  const r = rates(a);
  assert.ok(r.sackRate.v >= 0 && r.sackRate.v < 0.3);
  const b = baselineFromTeams([a, lineAgg(plays, t.away.id, 'off')]);
  assert.equal(b.sd.runSuccess, null, 'two teams is not enough to estimate a league spread');
});

test('a team with no prior games gets unavailable grades (week 1), not a crash', () => {
  const empty = lineAgg([], '1', 'off');
  const g = gradeTeam(empty, lineAgg([], '1', 'def'), base);
  for (const k of ['olRun', 'olPass', 'dlRun', 'dlPass', 'ol', 'dl']) assert.equal(g[k].score, null);
});
