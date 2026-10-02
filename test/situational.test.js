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

test('ratings: NGS metrics attach for every team (Rams are "LAR" in NGS, "LA" in play-by-play)', async () => {
  const { buildRecords } = await import('../src/playerRatings.js');
  const { R } = await buildRecords([2025]);
  const teams = new Set(); for (const list of R.values()) for (const r of list) if (r.m.ryoe || r.m.cpoe || r.m.sep) teams.add(r.team);
  assert.ok(teams.has('LA'), 'Rams NGS rows attached');
  assert.equal(teams.size, 32);
});

test('ratings: reliability-scaled (1–99, no small-sample extremes), every skill present, rookies qualify on pace', async () => {
  const { buildRecords, ratingsFrom, SKILLS } = await import('../src/playerRatings.js');
  const res = ratingsFrom(await buildRecords([2024, 2025]), 2025, 4);
  let rookies = 0;
  for (const pos of ['QB', 'RB', 'WR', 'TE']) for (const p of res.byPos[pos]) {
    if (p.rookie) rookies++;
    for (const [k] of SKILLS[pos]) {
      assert.ok(p.skills[k], `${pos} ${p.gsis} missing ${k}`);
      const r = p.skills[k].rating; assert.ok(r >= 1 && r <= 99, `${k} ${r}`);
      if (!p.skills[k].noData && p.skills[k].reliability < 0.25) assert.ok(r >= 3 && r <= 97, `${pos} ${k} reliability ${p.skills[k].reliability} rated ${r}: unreliable sample stretched to an extreme`);
    }
  }
  assert.ok(rookies >= 5, `only ${rookies} rookies rated at week 4`);
});
