import test from 'node:test';
import assert from 'node:assert/strict';
import { impliedScore, americanToProb, probToAmerican, noVig, parseAmerican } from '../src/odds.js';

test('book-implied score: home favourite', () => {
  // BUF -6.5, total 48.5  ->  BUF 27.5, NE 21
  assert.deepEqual(impliedScore(48.5, -6.5), { home: 27.5, away: 21 });
});

test('book-implied score: away favourite (positive home spread)', () => {
  // PIT -2.5 at CLE, total 38.5 -> home spread +2.5 -> CLE 18, PIT 20.5
  assert.deepEqual(impliedScore(38.5, 2.5), { home: 18, away: 20.5 });
});

test('book-implied score sums to total and differs by spread', () => {
  for (const [t, s] of [[44, -3], [51.5, 7], [37, 0]]) {
    const r = impliedScore(t, s);
    assert.equal(Math.round((r.home + r.away) * 10) / 10, t);
    assert.equal(Math.round((r.away - r.home) * 10) / 10, s);
  }
});

test('implied score returns null on missing inputs (no fabricated line)', () => {
  assert.equal(impliedScore(null, -3), null);
  assert.equal(impliedScore(44, undefined), null);
});

test('American odds <-> probability', () => {
  assert.equal(americanToProb(-110).toFixed(4), '0.5238');
  assert.equal(americanToProb(+150).toFixed(4), '0.4000');
  assert.equal(americanToProb(100), 0.5);
  assert.equal(americanToProb(50), null); // invalid American price
  assert.equal(probToAmerican(0.6), -150);
  assert.equal(probToAmerican(0.4), 150);
  assert.equal(probToAmerican(0), null);
  assert.equal(probToAmerican(1), null);
  for (const p of [0.1, 0.33, 0.5, 0.77]) assert.ok(Math.abs(americanToProb(probToAmerican(p)) - p) < 0.003);
});

test('no-vig two-way market sums to 1 and reports overround', () => {
  const r = noVig(-290, 235);
  assert.ok(Math.abs(r.a + r.b - 1) < 1e-12);
  assert.ok(r.overround > 0 && r.overround < 0.1);
  assert.ok(r.a > 0.7 && r.a < 0.75);
  assert.equal(noVig(null, 120), null);
});

test('parseAmerican handles strings and EVEN', () => {
  assert.equal(parseAmerican('+235'), 235);
  assert.equal(parseAmerican('-290'), -290);
  assert.equal(parseAmerican('EVEN'), 100);
  assert.equal(parseAmerican(null), null);
});
