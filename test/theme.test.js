// Team color theming: readable accents, fallbacks, distinct colors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchupTheme, contrast, parseHex, readableAccent, inkOn, FALLBACK } from '../public/theme.js';

const DARK = '#0c0f13', LIGHT = '#f5f4ef';
const c = (a, b) => contrast(parseHex(a), parseHex(b));

test('black primary (Raiders) is replaced by a readable accent on the dark page', () => {
  const t = matchupTheme({ color: 'e31837', alternateColor: 'ffb612' }, { color: '000000', alternateColor: 'a5acaf' }, DARK);
  assert.ok(c(t.home.accent, DARK) >= 3, `home accent ${t.home.accent}`);
  assert.ok(c(t.away.accent, DARK) >= 3, `away accent ${t.away.accent}`);
  assert.notEqual(t.home.accent, '#000000');
});

test('accents stay readable on the light theme too', () => {
  const t = matchupTheme({ color: 'ffb612' }, { color: 'a5acaf' }, LIGHT);
  assert.ok(c(t.away.accent, LIGHT) >= 3 && c(t.home.accent, LIGHT) >= 3);
});

test('text on a solid team fill always has >= 4.5:1 contrast', () => {
  for (const hex of ['#003594', '#ffb81c', '#e31837', '#000000', '#a5acaf', '#6a2c3e']) {
    const ink = inkOn(hex);
    assert.ok(c(ink, hex) >= 4.5, `${ink} on ${hex}`);
  }
});

test('missing / invalid ESPN colors fall back safely', () => {
  const t = matchupTheme({ color: null }, { color: 'zzz' }, DARK);
  assert.equal(t.away.source, 'fallback'); assert.equal(t.home.source, 'fallback');
  assert.equal(t.away.accent, FALLBACK.away);
});

test('near-identical team colors are made distinguishable', () => {
  const t = matchupTheme({ color: '002244' }, { color: '002a4e' }, DARK); // two navy teams, no alternates
  const d = Math.hypot(...parseHex(t.away.accent).map((v, i) => v - parseHex(t.home.accent)[i]));
  assert.ok(d >= 60, `accents ${t.away.accent} vs ${t.home.accent}`);
});

test('readableAccent leaves already-readable colors unchanged', () => {
  assert.equal(readableAccent('#ffb612', DARK).shifted, 0);
});
