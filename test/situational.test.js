// SITUATIONAL MULTIPLIER MODEL: effects are percentages of the player's own baseline, never fixed additions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { situationX, situationMultiplier, baselineOf, oppAllowLog, FEATS } from '../src/situational.js';

test('multiplier scales with the baseline (a 10% effect is +1.5 on 15 and +2.0 on 20)', () => {
  const m = { beta: [0, Math.log(1.1), 0, 0, 0, 0, 0, 0, 0, 0] }; // ×1.10 per 7 pts favored
  const x = situationX({ spread: 7 });
  const { mult } = situationMultiplier(m, x);
  assert.ok(Math.abs(15 * mult - 16.5) < 1e-9 && Math.abs(20 * mult - 22) < 1e-9);
});

test('features: favored and underdog are separate; blowout terms only beyond 7; outdoor-only weather', () => {
  const fav = situationX({ spread: 10.5 }), dog = situationX({ spread: -3.5 });
  assert.deepEqual(fav.slice(0, 4).map((v) => +v.toFixed(3)), [1.5, 0, 0.5, 0]);
  assert.deepEqual(dog.slice(0, 4).map((v) => +v.toFixed(3)), [0, 0.5, 0, 0]);
  assert.equal(situationX({ wind: 20, outdoors: false })[FEATS.indexOf('wind15')], 0);
  assert.equal(situationX({ wind: 20, outdoors: true })[FEATS.indexOf('wind15')], 1);
});

test('baseline pads early-season averages with last season; opponent allowance is shrunk toward league', () => {
  assert.equal(baselineOf([20, 22, 24], 15), (66 + 30) / 5);
  assert.equal(baselineOf([20, 22], null), 21);
  assert.ok(Math.abs(oppAllowLog(30, 0, 25)) < 1e-12); // no games → league
  assert.ok(oppAllowLog(30, 12, 25) > oppAllowLog(30, 2, 25)); // more games → trusted more
});
