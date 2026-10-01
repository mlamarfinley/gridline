// SKEPTIC: independent sanity audit catches logic errors (and doesn't cry wolf on explained changes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { skeptic } from '../src/skeptic.js';
import { selectOutlier } from '../src/outlier.js';

const stat = (o = {}) => ({ label: 'Stat', proj: 10, p10: 5, p50: 10, p90: 15, last5: [], ...o });
const card = (o = {}) => ({
  id: 'x', name: 'Player', pos: 'RB', role: 'RB1', primary: 'rush_yds', notes: [], redistribution: [],
  opportunity: { carries: 12, targets: 3, dropbacks: null, carryShare: 0.5, targetShare: 0.1, teamPlays: 62, teamPassRate: 0.55 },
  usageHistory: { games: 3, carries: 12, targets: 3, passAtt: 0, last: { carries: 12, targets: 3, passAtt: 0 } },
  stats: { rush_yds: stat({ label: 'Rushing yards', proj: 55, p10: 20, p50: 52, p90: 90 }) },
  ...o,
});
const qb = (o = {}) => card({ id: 'qb', name: 'QB', pos: 'QB', role: 'Starting QB', primary: 'pass_yds',
  opportunity: { carries: 3, targets: 0, dropbacks: 34, carryShare: 0.1, targetShare: 0, teamPlays: 62, teamPassRate: 0.55 },
  usageHistory: { games: 3, carries: 3, targets: 0, passAtt: 34, last: { carries: 3, targets: 0, passAtt: 34 } },
  stats: { pass_yds: stat({ label: 'Passing yards', proj: 240, p10: 170, p50: 238, p90: 310 }), completions: stat({ proj: 22 }), pass_att: stat({ proj: 34 }) }, ...o });
const team = (cards, o = {}) => ({ abbr: 'NYJ', cards, kicker: { id: 'k' }, injuries: [], ...o });
const match = (home, away = team([qb({ id: 'qb2' })], { abbr: 'CHI', kicker: { id: 'k2' } })) => ({ league: 'nfl', season: 2026, home, away });
const checks = (r) => r.findings.map((f) => f.check);

test('QB given an absent RB\'s carries is a high-severity logic error and vetoes him as the outlier pick', () => {
  const geno = qb({ redistribution: [{ from: 'Breece Hall', fromPos: 'RB', toPos: 'QB', addCarryShare: 0.249, addTargetShare: 0 }] });
  const r = skeptic(match(team([geno, card()])));
  assert.ok(checks(r).includes('qb-absorbs-non-qb-carries'));
  assert.ok(r.vetoed.includes('qb'));
  const o = selectOutlier([{ playerId: 'qb', name: 'QB', stat: 'rush_yds', label: 'Rush', proj: 40, p10: 20, p50: 38, p90: 70, line: 11.5, probOver: 0.9, seasonGames: 3, lineUpdated: new Date().toISOString(), skepticVeto: 'QB absorbed RB carries' }]);
  assert.equal(o.pick, null);
});

test('an RB absorbing an absent RB\'s carries is normal and not flagged', () => {
  const r = skeptic(match(team([qb(), card({ redistribution: [{ from: 'RB1', fromPos: 'RB', toPos: 'RB', addCarryShare: 0.2, addTargetShare: 0.02 }], notes: ['+20% carry share from RB1\'s absence'] })])));
  assert.ok(!r.findings.some((f) => f.severity === 'high'));
});

test('team over-allocation, OUT player still projected, and impossible stat arithmetic are caught', () => {
  const greedy = card({ id: 'a', opportunity: { carries: 30, targets: 1, carryShare: 0.6, targetShare: 0.05, teamPlays: 62, teamPassRate: 0.55 } });
  const greedy2 = card({ id: 'b', opportunity: { carries: 20, targets: 1, carryShare: 0.4, targetShare: 0.05, teamPlays: 62, teamPassRate: 0.55 } });
  const hurt = card({ id: 'c', injury: { status: 'Out' } });
  const bad = card({ id: 'd', pos: 'WR', role: 'Receiver 1', primary: 'rec_yds', stats: { rec_yds: stat({ proj: 60 }), receptions: stat({ proj: 7 }), targets: stat({ proj: 5 }) } });
  const r = skeptic(match(team([qb(), greedy, greedy2, hurt, bad])));
  for (const c of ['carries-over-allocated', 'out-player-projected', 'receptions-exceed-targets']) assert.ok(checks(r).includes(c), c);
});

test('a usage drop that matches his most recent game is the model following evidence, not flagged', () => {
  const wr = card({ id: 'w', pos: 'WR', role: 'Support', primary: 'rec_yds',
    opportunity: { carries: 0, targets: 1.7, carryShare: 0, targetShare: 0.06, teamPlays: 62, teamPassRate: 0.55 },
    usageHistory: { games: 2, carries: 0, targets: 4.5, passAtt: 0, last: { carries: 0, targets: 1, passAtt: 0 } },
    stats: { rec_yds: stat({ proj: 12, last5: [{ season: '2026', value: 35 }, { season: '2026', value: 14 }] }) } });
  const r = skeptic(match(team([qb(), wr])));
  assert.ok(!checks(r).some((c) => c.startsWith('volume-')));
});

test('an unexplained volume jump vs both season average and last game is flagged medium', () => {
  const rb = card({ opportunity: { carries: 16, targets: 2, carryShare: 0.6, targetShare: 0.05, teamPlays: 62, teamPassRate: 0.55 },
    usageHistory: { games: 3, carries: 6, targets: 2, passAtt: 0, last: { carries: 7, targets: 2, passAtt: 0 } } });
  const r = skeptic(match(team([qb(), rb])));
  const f = r.findings.find((x) => x.check === 'volume-jump-carries');
  assert.ok(f && f.severity === 'medium');
});

test('a backup QB projected not to play is not flagged for being below his past starts', () => {
  const backup = qb({ id: 'b', role: 'Support', stats: { pass_yds: stat({ proj: 0, p10: 0, p50: 0, p90: 0, last5: [{ season: '2026', value: 236 }, { season: '2026', value: 313 }, { season: '2026', value: 144 }] }) },
    opportunity: { carries: 0, targets: 0, dropbacks: 0, carryShare: 0, targetShare: 0, teamPlays: 62, teamPassRate: 0.55 } });
  const r = skeptic(match(team([qb(), backup])));
  assert.ok(!r.findings.some((f) => f.playerId === 'b'));
});
