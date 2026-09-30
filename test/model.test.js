import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioWeights, simulateTeam, makeRunDist, makeCatchDist, rng, summarize, probOver } from '../src/model.js';
import { STATES } from '../src/history.js';

const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);

test('scenario weights sum to 1 and move with the spread', () => {
  const fav = scenarioWeights(7, 'nfl');
  const dog = scenarioWeights(-7, 'nfl');
  const even = scenarioWeights(0, 'nfl');
  for (const w of [fav, dog, even]) assert.ok(Math.abs(sum(w) - 1) < 1e-9);
  assert.ok(fav.lead + fav.blowLead > dog.lead + dog.blowLead);
  assert.ok(dog.trail + dog.blowTrail > fav.trail + fav.blowTrail);
  // symmetry
  assert.ok(Math.abs(fav.lead - dog.trail) < 1e-9 && Math.abs(fav.blowLead - dog.blowTrail) < 1e-9);
  assert.ok(Math.abs(even.lead - even.trail) < 1e-9);
  // college uses a wider margin distribution: a 7-pt college favourite is less often "close"
  assert.ok(scenarioWeights(7, 'cfb').close < fav.close);
});

function team(passRate) {
  return {
    plays: 64, passRate, sackRate: 0.06, intRate: 0.02, tdScale: 1,
    blowFactor: { lead: 1, trail: 1 },
    other: { run: makeRunDist(4.3, 0.1, 0.022), catchRate: 0.65, catch: makeCatchDist(11, 0.15, 0.02), rushTd: 0.03, recTd: 0.06 },
    qbFumblePerSack: 0.1,
  };
}
const flat = (v) => Object.fromEntries(STATES.map((s) => [s, v]));
const rb = (carry, target) => ({
  id: 'rb', pos: 'RB', isCore: true, dropbackShare: 0, dispersion: 1,
  carryShare: carry, targetShare: target,
  run: makeRunDist(4.5, 0.11, 0.025), catchRate: 0.78, catch: makeCatchDist(7.5, 0.06, 0.01), rushTd: 0.03, recTd: 0.04, fumLost: 0.004,
});
const qb = { id: 'qb', pos: 'QB', isCore: true, dropbackShare: 1, dispersion: 1, carryShare: flat(0.1), targetShare: flat(0), run: makeRunDist(4.5, 0.15, 0.03), catchRate: 0.7, catch: makeCatchDist(7, 0.05, 0.01), rushTd: 0.05, recTd: 0, fumLost: 0.004 };
const mean = (a) => Array.from(a).reduce((x, y) => x + y, 0) / a.length;

test('scenario shift: trailing dual-threat RB loses carries and gains targets per his own splits', () => {
  // This back's measured role: more carries when leading, more targets when trailing.
  const carry = { blowTrail: 0.3, trail: 0.38, close: 0.5, lead: 0.58, blowLead: 0.6 };
  const target = { blowTrail: 0.2, trail: 0.17, close: 0.12, lead: 0.08, blowLead: 0.07 };
  const passRate = { blowTrail: 0.7, trail: 0.64, close: 0.57, lead: 0.47, blowLead: 0.4 };
  const players = [qb, rb(carry, target)];
  const asFav = simulateTeam(team(passRate), players, scenarioWeights(10, 'nfl'), { sims: 1500, seed: 11 });
  const asDog = simulateTeam(team(passRate), players, scenarioWeights(-10, 'nfl'), { sims: 1500, seed: 11 });
  const cF = mean(asFav.out.rb.stats.carries), cD = mean(asDog.out.rb.stats.carries);
  const tF = mean(asFav.out.rb.stats.targets), tD = mean(asDog.out.rb.stats.targets);
  assert.ok(cF > cD + 2, `carries fav ${cF} vs dog ${cD}`);
  assert.ok(tD > tF + 0.5, `targets dog ${tD} vs fav ${tF}`);
  // and QB passing volume rises when trailing
  assert.ok(mean(asDog.out.qb.stats.pass_att) > mean(asFav.out.qb.stats.pass_att));
});

test('college blowout substitution reduces starter workload', () => {
  const players = [qb, rb(flat(0.5), flat(0.1))];
  const pr = flat(0.5);
  const full = { ...team(pr), blowFactor: { lead: 1, trail: 1 } };
  const pulled = { ...team(pr), blowFactor: { lead: 0.55, trail: 0.8 } };
  const w = scenarioWeights(24, 'cfb'); // heavy favourite -> lots of blowLead
  const a = simulateTeam(full, players, w, { sims: 1200, seed: 5 });
  const b = simulateTeam(pulled, players, w, { sims: 1200, seed: 5 });
  assert.ok(mean(b.out.rb.stats.carries) < mean(a.out.rb.stats.carries) - 1);
  assert.ok(mean(b.out.qb.stats.pass_att) < mean(a.out.qb.stats.pass_att) - 1);
});

test('run distribution: mean anchored to efficiency; explosive tail shapes range only', () => {
  const R = rng(42);
  const draw = (d) => { let s = 0, n = 20000, big = 0; for (let i = 0; i < n; i++) { const y = R() < d.p10 ? Math.round(10 - d.theta * Math.log(1 - R())) : Math.round(Math.max(d.lo, Math.min(d.hi, d.shortMean + d.sd * R.normal()))); s += y; if (y >= 20) big++; } return { mean: s / n, p20: big / n }; };
  const calm = draw(makeRunDist(4.4, 0.08, 0.015));
  const boom = draw(makeRunDist(4.4, 0.16, 0.05));
  assert.ok(Math.abs(calm.mean - 4.4) < 0.35, `calm mean ${calm.mean}`);
  assert.ok(Math.abs(boom.mean - 4.4) < 0.35, `boom mean ${boom.mean}`);
  assert.ok(boom.p20 > calm.p20 * 2, 'higher explosive rate => fatter 20+ tail');
});

test('simulation is reproducible for a fixed seed (snapshot reproducibility)', () => {
  const p = [qb, rb(flat(0.45), flat(0.1))];
  const a = simulateTeam(team(flat(0.55)), p, scenarioWeights(3, 'nfl'), { sims: 300, seed: 99 });
  const b = simulateTeam(team(flat(0.55)), p, scenarioWeights(3, 'nfl'), { sims: 300, seed: 99 });
  assert.deepEqual(Array.from(a.out.rb.stats.rush_yds), Array.from(b.out.rb.stats.rush_yds));
});

test('summaries and explicit-threshold probabilities', () => {
  const arr = Float64Array.from({ length: 101 }, (_, i) => i);
  const s = summarize(arr);
  assert.equal(s.p10, 10); assert.equal(s.p50, 50); assert.equal(s.p90, 90); assert.equal(s.mean, 50);
  assert.equal(probOver(arr, 49.5), 51 / 101); // values 50..100 exceed 49.5
  assert.equal(probOver(arr, null), null);
});
