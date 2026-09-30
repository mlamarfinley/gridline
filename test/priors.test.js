// fbm-1.2.0 priors: fitted constants come from 2024->2025 history and behave as shrinkage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIT, blendTeam } from '../src/priors.js';

test('fitted constants exist and were fit on history only', () => {
  assert.match(FIT.fitSet, /2025/);
  assert.match(FIT.fitSet, /No 2026 data/);
  for (const k of ['plays', 'att', 'pf']) assert.ok(FIT.team[k].best.k > 0);
  assert.ok(FIT.qbYpa.best.k > 0 && FIT.eff.ypc.best.k > 0);
});

test('blendTeam: no current games => regressed prior; many games => current mean dominates', () => {
  const L = FIT.team.pf.league, r = FIT.team.pf.best.r;
  assert.ok(Math.abs(blendTeam('pf', null, 0, 30, L) - (L + r * (30 - L))) < 1e-9);
  const many = blendTeam('pf', 35, 1000, 15, L);
  assert.ok(Math.abs(many - 35) < 0.5);
  assert.equal(blendTeam('pf', null, 0, null, L), L, 'missing prior falls back to league, never 0');
});
