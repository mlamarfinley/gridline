import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAllowed } from '../src/security.js';

const P = 5317;
test('GETs allowed only for local Host headers (DNS-rebinding guard)', () => {
  assert.ok(requestAllowed('GET', { host: 'localhost:5317' }, P));
  assert.ok(requestAllowed('GET', { host: '127.0.0.1:5317' }, P));
  assert.equal(requestAllowed('GET', { host: 'evil.example:5317' }, P), false);
  assert.equal(requestAllowed('GET', {}, P), false);
});

test('POSTs: same-origin or no-Origin allowed; cross-origin rejected', () => {
  assert.ok(requestAllowed('POST', { host: 'localhost:5317', origin: 'http://localhost:5317', 'sec-fetch-site': 'same-origin' }, P));
  assert.ok(requestAllowed('POST', { host: '127.0.0.1:5317' }, P)); // curl / CLI
  assert.equal(requestAllowed('POST', { host: 'localhost:5317', origin: 'https://evil.example' }, P), false);
  assert.equal(requestAllowed('POST', { host: 'localhost:5317', origin: 'http://localhost:9999' }, P), false);
  assert.equal(requestAllowed('POST', { host: 'localhost:5317', 'sec-fetch-site': 'cross-site' }, P), false);
});
