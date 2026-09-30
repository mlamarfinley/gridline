// Future-data leakage guard: nothing at/after kickoff (or unfinished) may enter features.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-cutoff-'));
const { gamesBeforeCutoff, loadTeamGames } = await import('../src/history.js');
const { setTransport, Provenance } = await import('../src/fetcher.js');

const sched = [
  { id: '1', date: '2026-09-10T17:00Z', completed: true },
  { id: '2', date: '2026-09-17T17:00Z', completed: true },
  { id: '3', date: '2026-09-24T17:00Z', completed: true },   // exactly at cutoff -> excluded
  { id: '4', date: '2026-10-01T17:00Z', completed: true },   // after cutoff -> excluded
  { id: '5', date: '2026-09-20T17:00Z', completed: false },  // not final -> excluded
];

test('gamesBeforeCutoff keeps only final games strictly before kickoff', () => {
  const ids = gamesBeforeCutoff(sched, '2026-09-24T17:00Z').map((g) => g.id);
  assert.deepEqual(ids, ['1', '2']);
});

test('loadTeamGames never even requests summaries of post-cutoff games', async () => {
  const nfl = JSON.parse(fs.readFileSync(new URL('./fixtures/nfl_summary_final.json', import.meta.url)));
  const requested = [];
  const ev = (id, date, completed) => ({ id, date, week: { number: 1 }, seasonType: { type: 2 }, competitions: [{ status: { type: { completed, state: completed ? 'post' : 'pre' } }, competitors: [{ id: '2', homeAway: 'home', team: { abbreviation: 'BUF' } }, { id: '24', homeAway: 'away', team: { abbreviation: 'LAC' } }] }] });
  setTransport(async (url) => {
    requested.push(url);
    if (url.includes('/schedule')) return { events: [ev('100', '2026-09-20T17:00Z', true), ev('200', '2026-10-04T17:00Z', true)] };
    if (url.includes('summary?event=100')) return nfl;
    throw new Error('unexpected ' + url);
  });
  const { games } = await loadTeamGames('nfl', '2', 2026, '2026-10-01T00:00Z', new Provenance());
  setTransport(null);
  assert.equal(games.length, 1);
  assert.ok(requested.some((u) => u.includes('event=100')));
  assert.ok(!requested.some((u) => u.includes('event=200')), 'post-cutoff game must not be fetched');
});
