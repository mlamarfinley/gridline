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

test('why: each reason says whether it supports or works against the pick (a soft matchup is AGAINST an UNDER)', async () => {
  const { whyPick } = await import('../src/why.js');
  const card = { opportunity: { targets: 7.5, targetShare: 0.24, teamPlays: 60, teamPassRate: 0.55 }, usageHistory: { games: 3, targets: 7.7 }, shareTrend: [], efficiency: { catchRate: { final: 0.58 } },
    matchup: { fit: { reasons: [{ kind: 'rec', effect: 1, text: '35% of his targets are short outside; this defense allows 6.9 yds/target there (league 5.5).' }] } }, notes: [], stats: { targets: { last5: [] } } };
  const w = whyPick({ direction: 'UNDER', stat: 'receptions', line: 5.5, proj: 4.2, card, team: 'JAX', opponent: 'CIN', expMargin: 11.5, scriptWeights: { lead: 0.33, blowLead: 0.15, trail: 0.06, blowTrail: 0.01 } });
  assert.equal(w.find((x) => /short outside/.test(x.text)).stance, 'against');
  assert.equal(w.find((x) => /Game script/.test(x.text)).stance, 'for'); // favored → throws less → supports the receiving UNDER
  assert.ok(w.some((x) => /doesn't shift targets/.test(x.text)));
});

test('partial games: an early exit (16% of snaps vs usual 71%) is detected; a normal game is not', async () => {
  const { partialGames } = await import('../src/matchup.js');
  const g = (week, carries) => ({ eventId: `e${week}`, week, oppAbbr: 'X', stats: { carries, targets: 2 } });
  const rows = [g(1, 15), g(2, 4), g(3, 15)];
  const bySnaps = partialGames(rows, [{ week: 1, pct: 0.71 }, { week: 2, pct: 0.16 }, { week: 3, pct: 0.72 }]);
  assert.deepEqual([...bySnaps.keys()], ['e2']);
  assert.match(bySnaps.get('e2').evidence, /16% of snaps vs his usual 71%/);
  const byTouches = partialGames(rows, null); // no snap data: 6 touches vs his usual 17
  assert.deepEqual([...byTouches.keys()], ['e2']);
  assert.equal(partialGames([g(1, 15), g(2, 13), g(3, 16)], null).size, 0);
});

test('why: injury context carries direction (questionable self = against an OVER; lead RB out raising pass rate helps a WR OVER)', async () => {
  const { whyPick } = await import('../src/why.js');
  const card = { opportunity: { targets: 8 }, usageHistory: { targets: 7, games: 3 }, notes: [
    'Listed Questionable (ankle): WRs listed questionable played 72% of the time in 2023–25 and got ~92% of their usual usage when active. Projection assumes he plays (props are void if he doesn\'t), at 92% usage; range widened.',
    'Team run/pass mix: lead RB X is out, so BAL\'s pass rate is raised 1.3 pts (teams without their lead RB ran 1.6 fewer times and threw 1.3 more, 2022–25).'] };
  const w = whyPick({ direction: 'OVER', stat: 'rec_yds', line: 60.5, card });
  assert.equal(w.find((x) => /^Injury: Listed/.test(x.text)).stance, 'against');
  assert.equal(w.find((x) => /run\/pass mix/.test(x.text)).stance, 'for');
});

test('why: a questionable QB whose usage is unchanged (props void if he sits) is context, not a reason', async () => {
  const { whyPick } = await import('../src/why.js');
  const card = { notes: ['Listed Questionable: QBs listed questionable played 43% of the time in 2023–25 and got ~100% of their usual usage when active. Projection assumes he plays (props are void if he doesn\'t), at 100% usage; range widened.'] };
  assert.equal(whyPick({ direction: 'UNDER', stat: 'rush_yds', line: 30.5, card }).find((x) => /^Injury/.test(x.text)).stance, 'info');
});
