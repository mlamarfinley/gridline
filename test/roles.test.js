// Role selection: roster counts, availability gating, no guessed assignments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRoles, contextWeights, keyPlayers } from '../src/roles.js';

const POS = { qb1: 'QB', qb2: 'QB', rb1: 'RB', rb2: 'RB', rb3: 'RB', rb0: 'RB', wr1: 'WR', wr2: 'WR', wr3: 'WR', te1: 'TE', k1: 'PK' };
const games = ['e1', 'e2', 'e3'];
function row(eid, stats, teamCarries = 26, teamTargets = 32) {
  return { eventId: eid, stats, share: { carry: (stats.carries || 0) / teamCarries, target: (stats.targets || 0) / teamTargets }, state: { carries: {}, targets: {} } };
}
function fixture() {
  const rows = new Map();
  const add = (id, f) => rows.set(id, games.map((g) => row(g, f(g))));
  add('qb1', () => ({ pass_att: 33, completions: 21, carries: 4 }));
  add('rb1', () => ({ carries: 16, targets: 3 }));
  add('rb2', () => ({ carries: 7, targets: 2 }));
  add('rb3', () => ({ carries: 1, targets: 0 }));
  add('wr1', () => ({ targets: 9, receptions: 6, rec_yds: 80 }));
  add('wr2', () => ({ targets: 7, receptions: 4, rec_yds: 50 }));
  add('te1', () => ({ targets: 5, receptions: 4, rec_yds: 40 }));
  add('wr3', (g) => ({ targets: g === 'e3' ? 8 : 1, receptions: 1, rec_yds: 10 })); // rising role
  add('k1', () => ({ fg_made: 2, fg_att: 2, xp_att: 3, xp_made: 3, k_pts: 9 }));
  const teamTotals = games.map((g) => ({ eventId: g, teamCarries: 26, teamTargets: 32, appeared: new Set(rows.keys()) }));
  return { rows, teamTotals };
}
const base = (over = {}) => {
  const { rows, teamTotals } = fixture();
  const roster = new Map(Object.keys(POS).map((id) => [id, { id, group: 'offense' }]));
  return { lg: 'nfl', rows, teamTotals, rosterById: roster, depth: { qb: ['qb1', 'qb2'], rb: ['rb1', 'rb2', 'rb3'], pk: ['k1'] }, injuries: new Map(), rosterCheck: true, nameOf: new Map(Object.keys(POS).map((k) => [k, k.toUpperCase()])), posOf: (id) => POS[id], ...over };
};

test('NFL roster counts: 1 QB, 2 RB, 2 WR/TE, 1 K (+ at most one justified extra)', () => {
  const r = selectRoles(base());
  assert.equal(r.qb, 'qb1');
  assert.deepEqual(r.rbs, ['rb1', 'rb2']);
  assert.deepEqual(r.recs, ['wr1', 'wr2']);
  assert.equal(r.k, 'k1');
  assert.equal(r.qbSource, 'ESPN depth chart');
  assert.equal(r.extra?.id, 'wr3'); // 25% target share last game
  assert.match(r.extra.reason, /target share/);
});

test('College roster counts: 1 QB, 2 RB, 1 receiver, no kicker; limitation disclosed', () => {
  const r = selectRoles(base({ lg: 'cfb', depth: null, rosterCheck: true }));
  assert.equal(r.qb, 'qb1');
  assert.equal(r.rbs.length, 2);
  assert.equal(r.recs.length, 1);
  assert.equal(r.k, null);
  assert.equal(r.qbSource, 'Recent pass attempts (box scores)');
  assert.ok(r.notes.some((n) => n.kind === 'cfb-roles'));
});

test('Out / IR / off-roster players are excluded and the next evidence-backed player is used', () => {
  const injuries = new Map([['rb1', { status: 'Out' }], ['qb1', { status: 'Doubtful' }]]);
  const roster = new Map(Object.keys(POS).filter((id) => id !== 'wr1').map((id) => [id, { id, group: id === 'te1' ? 'injuredReserveOrOut' : 'offense' }]));
  const r = selectRoles(base({ injuries, rosterById: roster }));
  assert.equal(r.qb, 'qb2');
  assert.ok(r.notes.some((n) => n.kind === 'qb-change'));
  assert.deepEqual(r.rbs, ['rb2', 'rb3']);
  assert.ok(!r.recs.includes('wr1') && !r.recs.includes('te1'));
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.id, e.reason]));
  assert.equal(reasons.rb1, 'Out'); assert.equal(reasons.wr1, 'Not on current roster'); assert.match(reasons.te1, /reserve/);
});

test('College: a heavy-usage player missing from the roster is flagged as UNVERIFIED, never a confirmed absence', () => {
  const roster = new Map(Object.keys(POS).filter((id) => id !== 'rb1').map((id) => [id, { id, group: 'offense' }]));
  const r = selectRoles(base({ lg: 'cfb', depth: null, rosterById: roster }));
  const n = r.notes.find((x) => x.ids?.includes('rb1'));
  assert.equal(n.kind, 'absence-unverified');
  assert.match(n.text, /Unverified/);
  assert.match(n.text, /no workload redistributed/);
  assert.ok(!r.notes.some((x) => x.kind === 'absence'));
});

test('No guessed assignments: a zero-usage back without depth-chart evidence is never picked', () => {
  const r = selectRoles(base({ depth: null }));
  assert.ok(!r.rbs.includes('rb0'));
});

test('context weights down-weight games that do not match this week\'s availability', () => {
  const { rows, teamTotals } = fixture();
  teamTotals[0].appeared = new Set([...teamTotals[0].appeared].filter((x) => x !== 'rb1')); // rb1 missed e1
  const keys = keyPlayers(rows, teamTotals);
  assert.ok(keys.has('rb1'));
  // rb1 is OUT this week -> the game he missed (e1) is the best match for rb2's usage.
  const w = contextWeights('rb2', teamTotals, keys, (id) => id !== 'rb1');
  const byId = Object.fromEntries(w.map((x) => [x.eventId, x.w]));
  assert.ok(byId.e1 > byId.e2, 'game without rb1 weighted up despite recency');
  // rb1 returning -> games without him are down-weighted.
  const w2 = contextWeights('rb2', teamTotals, keys, () => true);
  assert.ok(Object.fromEntries(w2.map((x) => [x.eventId, x.w])).e1 < 0.3);
});
