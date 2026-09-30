// Blind historical evaluation: isolation (poison tests), cutoff rules, sealed immutable batches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-blind-'));
const { setTransport } = await import('../src/fetcher.js');
const { predictGame, makePositionsFor, inferPosition, isolationViolations, openBlind } = await import('../src/blind.js');
const { openLedger, closeLedger } = await import('../src/ledger.js');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/nfl_summary_final.json', import.meta.url)));
const team = (id, abbr) => ({ id, abbr, name: abbr });
const BUF = team('2', 'BUF'), LAC = team('24', 'LAC'), MIA = team('15', 'MIA');
const prior = { id: '401872953', league: 'nfl', season: 2026, week: 3, kickoff: '2026-09-27T17:00:00.000Z', completed: true, home: BUF, away: LAC };
const target = { id: '999', league: 'nfl', season: 2026, week: 4, kickoff: '2026-10-04T17:00:00.000Z', completed: true, home: BUF, away: LAC };
const overlapping = { id: '1001', league: 'nfl', season: 2026, week: 4, kickoff: '2026-10-04T14:00:00.000Z', completed: true, home: MIA, away: LAC }; // finished after kickoff
const future = { id: '1000', league: 'nfl', season: 2026, week: 5, kickoff: '2026-10-11T17:00:00.000Z', completed: true, home: BUF, away: MIA };

// Absurd payload used to poison everything the predictor must never see.
const absurd = () => {
  const j = JSON.parse(JSON.stringify(fixture));
  for (const t of j.boxscore.players) for (const c of t.statistics) for (const a of c.athletes) a.stats = a.stats.map(() => '999');
  j.header.competitions[0].competitors.forEach((c) => { c.score = '999'; });
  j.pickcenter = [{ spread: -99, overUnder: 999 }];
  return j;
};

function world({ poison }) {
  const requested = [];
  setTransport(async (url) => {
    requested.push(url);
    if (url.includes('summary?event=401872953')) return fixture;
    if (url.includes('/gamelog')) return {};
    if (poison) {
      // Overlapping game: kicked off 3h before the target; its real wallclocks end after kickoff.
      if (url.includes('event=1001')) return shiftWallclocks(absurd(), 7 * 24 - 3);
      if (/event=(999|1000)|\/events\/999\//.test(url)) return absurd();
      if (/roster|depthcharts|propBets|scoreboard|injuries/.test(url)) return { items: [], athletes: [], events: [] };
    }
    if (/event=(999|1000|1001)/.test(url)) return fixture; // unpoisoned world: target looks normal
    throw new Error(`offline in test: ${url}`);
  });
  return requested;
}

async function predict(all, poison) {
  const requested = world({ poison });
  const r = await predictGame('nfl', target, all, { positionsFor: makePositionsFor('nfl', 2026, 4, null) });
  setTransport(null);
  return { r, requested };
}

test('poison test: absurd target results/lines, rosters and future/overlapping games do not change forecasts', async () => {
  const clean = await predict([prior, target], false);
  const poisoned = await predict([prior, target, overlapping, future], true);
  assert.ok(!clean.r.skipped, clean.r.reason);
  assert.ok(!poisoned.r.skipped, poisoned.r.reason);
  assert.ok(clean.r.m.projections.length > 20);
  assert.deepEqual(poisoned.r.m.projections, clean.r.m.projections);
  for (const u of poisoned.requested) {
    assert.ok(!/event=(999|1000)/.test(u), `requested target/future game: ${u}`);
    assert.ok(!/roster|depthcharts|propBets|scoreboard|injuries|open-meteo|snap_counts/.test(u), `requested forbidden source: ${u}`);
  }
  assert.equal(poisoned.r.m.odds, null);
  assert.equal(poisoned.r.m.mode, 'blind');
  assert.ok(!poisoned.r.prior.some((g) => g.id === '1000'), 'future game is not even a candidate');
  assert.deepEqual(poisoned.r.m.blindAudit.verifiedPriorGames.LAC.map((g) => g.id), ['401872953']);
  assert.match(poisoned.r.m.blindAudit.excludedPriorGames.LAC.find((e) => e.id === '1001').reason, /finished after target kickoff/);
});

test('changing a future game never alters outputs', async () => {
  const a = await predict([prior, target, future], true);
  const b = await predict([prior, target, { ...future, kickoff: '2026-10-05T17:00:00.000Z', home: LAC, away: BUF }], true);
  assert.deepEqual(a.r.m.projections, b.r.m.projections);
});

test('teams without a completed prior game are skipped with a logged reason (week 1)', async () => {
  const wk1 = { ...target, id: '998', week: 1, kickoff: '2026-09-10T00:00:00.000Z' };
  const requested = world({ poison: true });
  const r = await predictGame('nfl', wk1, [prior, wk1], { positionsFor: makePositionsFor('nfl', 2026, 1, null) });
  setTransport(null);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no current-season game completed before kickoff/);
  assert.equal(requested.length, 0);
});

test('isolation self-check flags any target-game or forbidden request', () => {
  assert.equal(isolationViolations([{ url: 'https://x/summary?event=401872953' }], '999').length, 0);
  assert.equal(isolationViolations([{ url: 'https://x/summary?event=999' }], '999').length, 1);
  assert.equal(isolationViolations([{ url: 'https://x/teams/2/roster' }], '999').length, 1);
  assert.equal(isolationViolations([{ url: 'https://x/events/999/competitions/999/odds/100/propBets' }], '999').length, 2);
});

test('positions come from pre-kickoff usage when no as-of-week table is available', () => {
  assert.equal(inferPosition({ pass_att: 30, carries: 4 }), 'QB');
  assert.equal(inferPosition({ carries: 15, receptions: 3 }), 'RB');
  assert.equal(inferPosition({ receptions: 5, targets: 7 }), 'WR');
  assert.equal(inferPosition({ kicks: 4 }), 'PK');
  assert.equal(inferPosition({}), null);
});

test('sealed batches: immutable, no predictions after seal, no scoring before seal', () => {
  const d = openBlind(openLedger(':memory:'));
  d.prepare("INSERT INTO blind_batches (created_at, mode, model_version, params_hash, code_hash) VALUES ('t','m','v','p','c')").run();
  const ins = () => d.prepare("INSERT INTO blind_predictions (batch_id, game_id, player_id, stat, created_at) VALUES (1, 'g', ?, 'rush_yds', 't')");
  const score = () => d.prepare("INSERT INTO blind_scores (batch_id, game_id, player_id, stat, status, scored_at) VALUES (1,'g','p1','rush_yds','scored','t')").run();
  ins().run('p1');
  assert.throws(score, /before predictions are frozen/);
  d.prepare("INSERT INTO blind_events (batch_id, event, at) VALUES (1,'predictions_frozen','t')").run();
  assert.throws(() => ins().run('p2'), /sealed/);
  score();
  assert.throws(() => d.exec('UPDATE blind_predictions SET projection = 1'), /immutable/);
  assert.throws(() => d.exec('DELETE FROM blind_scores'), /immutable/);
  closeLedger();
});

// ---- Completion verification (cutoff-v2): wallclock proof, not kickoff+buffer ----
function shiftWallclocks(j, hours) {
  const c = JSON.parse(JSON.stringify(j));
  for (const d of c.drives.previous) for (const p of d.plays) if (p.wallclock) p.wallclock = new Date(Date.parse(p.wallclock) + hours * 3600e3).toISOString();
  return c;
}
function stripWallclocks(j) {
  const c = JSON.parse(JSON.stringify(j));
  for (const d of c.drives.previous) for (const p of d.plays) delete p.wallclock;
  return c;
}

test('delayed game that started 5h before kickoff but ended after it is excluded; verified-finished game included', async () => {
  const lateTarget = { ...target, id: '997', kickoff: '2026-09-27T22:00:00.000Z' }; // 5h after the prior kickoffs
  const delayed = { ...prior, id: '555' };   // same 17:00Z kickoff, but an 8h weather delay
  const noClock = { ...prior, id: '556' };   // no wallclock at all -> unverifiable
  const requested = [];
  setTransport(async (url) => {
    requested.push(url);
    if (url.includes('summary?event=401872953')) return fixture;             // ends 20:11Z -> before 22:00Z
    if (url.includes('summary?event=555')) return shiftWallclocks(fixture, 8); // ends 04:11Z next day
    if (url.includes('summary?event=556')) return stripWallclocks(fixture);
    if (url.includes('/gamelog')) return {};
    if (url.includes('event=997')) throw new Error('TARGET REQUESTED');
    throw new Error(`offline in test: ${url}`);
  });
  const r = await predictGame('nfl', lateTarget, [prior, delayed, noClock, lateTarget], { positionsFor: makePositionsFor('nfl', 2026, 3, null) });
  setTransport(null);
  assert.ok(!r.skipped, r.reason);
  const audit = r.m.blindAudit;
  assert.deepEqual(audit.verifiedPriorGames.BUF.map((g) => g.id), ['401872953']);
  const ex = Object.fromEntries(audit.excludedPriorGames.BUF.map((e) => [e.id, e.reason]));
  assert.match(ex['555'], /finished after target kickoff/);
  assert.match(ex['556'], /unverifiable/);
  assert.ok(!requested.some((u) => u.includes('997')), 'target never requested');
  // Excluded games contribute nothing: identical to a world where only the finished game exists.
  setTransport(async (url) => { if (url.includes('summary?event=401872953')) return fixture; if (url.includes('/gamelog')) return {}; throw new Error('offline'); });
  const only = await predictGame('nfl', lateTarget, [prior, lateTarget], { positionsFor: makePositionsFor('nfl', 2026, 3, null) });
  setTransport(null);
  assert.deepEqual(r.m.projections, only.m.projections);
});

test('a team whose only prior game cannot be verified as finished is skipped with a reason', async () => {
  const lateTarget = { ...target, id: '996', kickoff: '2026-09-27T22:00:00.000Z' };
  setTransport(async (url) => { if (url.includes('summary?event=555')) return shiftWallclocks(fixture, 8); if (url.includes('/gamelog')) return {}; throw new Error('offline'); });
  const r = await predictGame('nfl', lateTarget, [{ ...prior, id: '555' }, lateTarget], { positionsFor: makePositionsFor('nfl', 2026, 3, null) });
  setTransport(null);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no prior game verified \(play wallclock\) as finished before kickoff/);
});
