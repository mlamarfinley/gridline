// In-app Back/Forward history (public/nav.js reducer; DOM binding verified in the preview).
import test from 'node:test';
import assert from 'node:assert/strict';
import { navReduce, canBack, canForward, labelFor, normalizeHash } from '../public/nav.js';

const go = (nav, hash, stateIdx) => navReduce(nav, { hash, stateIdx }).nav;
const empty = { stack: [], idx: -1 };

test('fresh deep link starts a one-page history: both buttons disabled', () => {
  const n = go(empty, '#/nfl/game/401872971');
  assert.equal(n.idx, 0);
  assert.equal(canBack(n), false);
  assert.equal(canForward(n), false);
});

test('slate -> matchup -> back -> forward', () => {
  let n = go(empty, '#/nfl');
  n = go(n, '#/nfl/game/1');
  assert.ok(canBack(n) && !canForward(n));
  n = go(n, '#/nfl', 0);            // browser/app back (entry tagged glIdx 0)
  assert.equal(n.idx, 0);
  assert.ok(!canBack(n) && canForward(n));
  n = go(n, '#/nfl/game/1', 1);     // forward
  assert.equal(n.idx, 1);
  assert.ok(canBack(n) && !canForward(n));
});

test('refresh keeps position (tagged entry, same hash)', () => {
  let n = go(go(go(empty, '#/nfl'), '#/cfb'), '#/ledger');
  n = go(n, '#/cfb', 1); // back
  const r = navReduce(n, { hash: '#/cfb', stateIdx: 1 }); // reload re-runs the route
  assert.equal(r.kind, 'traverse');
  assert.equal(r.nav.idx, 1);
  assert.ok(canForward(r.nav));
});

test('branching after back discards forward entries', () => {
  let n = go(go(go(empty, '#/nfl'), '#/nfl?week=3'), '#/nfl/game/9');
  n = go(n, '#/nfl?week=3', 1);   // back
  n = go(n, '#/cfb');             // new navigation (untagged) -> branch
  assert.deepEqual(n.stack.map((e) => e.hash), ['#/nfl', '#/nfl?week=3', '#/cfb']);
  assert.equal(n.idx, 2);
  assert.equal(canForward(n), false);
});

test('switching leagues and weeks each create entries', () => {
  let n = go(empty, '#/nfl');
  for (const h of ['#/nfl?week=3', '#/cfb', '#/cfb?week=4', '#/ledger']) n = go(n, h);
  assert.equal(n.stack.length, 5);
  assert.equal(labelFor(n.stack[1]), 'NFL slate · week 3');
  assert.equal(labelFor(n.stack[3]), 'College slate · week 4');
  assert.equal(labelFor(n.stack[4]), 'Ledger');
});

test('stale/mismatched state tag is treated as a new navigation, never a jump', () => {
  const n = go(go(empty, '#/nfl'), '#/cfb');
  const r = navReduce(n, { hash: '#/ledger', stateIdx: 0 }); // tag says 0 but hash differs
  assert.equal(r.kind, 'push');
  assert.equal(r.nav.idx, 2);
});

test('empty hash normalises to the NFL slate', () => {
  assert.equal(normalizeHash(''), '#/nfl');
  assert.equal(go(empty, '').stack[0].hash, '#/nfl');
});
