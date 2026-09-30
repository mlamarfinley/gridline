// Parsers against recorded real ESPN responses (test/fixtures), incl. missing-data handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as espn from '../src/espn.js';
import { actualValue } from '../src/ledger.js';
import { measureNfl } from '../src/baselines.js';

const fx = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const nfl = fx('nfl_summary_final.json');
const cfb = fx('cfb_summary_final.json');

test('NFL box score parses passing/rushing/receiving/fumbles/kicking incl. targets', () => {
  const box = espn.parseBoxscore(nfl);
  const herbert = box.get('4038941');
  assert.equal(herbert.stats.completions, 20);
  assert.equal(herbert.stats.pass_att, 34);
  assert.equal(herbert.stats.pass_yds, 226);
  assert.equal(herbert.stats.ints, 1);
  const harris = box.get('4686612');
  assert.equal(harris.stats.targets, 7);
  assert.equal(harris.stats.long_rec, 29);
  const dicker = box.get('4362081');
  assert.equal(dicker.stats.fg_made, 3); assert.equal(dicker.stats.fg_att, 4); assert.equal(dicker.stats.k_pts, 10);
});

test('College box score: targets are ABSENT (undefined), never silently zero', () => {
  const box = espn.parseBoxscore(cfb);
  const rec = [...box.values()].find((r) => r.stats.receptions != null);
  assert.equal(rec.stats.targets, undefined);
});

test('play-by-play: rushing TDs followed by extra-point text are kept (regression)', () => {
  const plays = espn.extractPlays(nfl);
  const tdRuns = plays.filter((p) => p.kind === 'rush' && p.td);
  assert.ok(tdRuns.length >= 3, `found ${tdRuns.length} rushing TDs`);
  assert.ok(!plays.some((p) => /kneels/.test(JSON.stringify(p))), 'kneels excluded');
  const perTeam = {};
  for (const p of plays) perTeam[p.offenseId] = (perTeam[p.offenseId] || 0) + 1;
  for (const n of Object.values(perTeam)) assert.ok(n > 50 && n < 80, `plays per team ${n}`);
});

test('play attribution resolves >= 95% of carries/targets from play text', () => {
  for (const sum of [nfl, cfb]) {
    const box = espn.parseBoxscore(sum);
    const byTeam = {};
    for (const r of box.values()) (byTeam[r.teamId] ||= []).push({ id: r.athleteId, name: r.name, jersey: r.jersey });
    let ok = 0, tot = 0;
    for (const p of espn.extractPlays(sum)) {
      const ref = p.kind === 'rush' ? p.rusher : p.kind === 'pass' ? p.target : null;
      if (!ref) continue;
      tot++; if (espn.makeResolver(byTeam[p.offenseId] || [])(ref)) ok++;
    }
    assert.ok(ok / tot >= 0.95, `${ok}/${tot}`);
  }
});

test('resolver: reused college jersey numbers are disambiguated by name', () => {
  const res = espn.makeResolver([
    { id: 'def3', name: 'Dante Moss', jersey: '3' },
    { id: 'wr3', name: 'Cataurus Hicks', jersey: '3' },
  ]);
  assert.equal(res({ jersey: '3', name: 'C.Hicks' }), 'wr3');
  assert.equal(res({ jersey: '3', name: 'Z.Unknown' }), null); // ambiguous -> unattributed, not guessed
});

test('game-state margin is computed from the score BEFORE each snap', () => {
  const plays = espn.extractPlays(nfl);
  assert.equal(plays[0].margin, 0);
  assert.ok(plays.some((p) => p.margin !== 0));
});

test('scoreboard odds: spread is the HOME line; moneylines parsed; missing odds -> null', () => {
  const sb = espn.parseScoreboard(fx('nfl_scoreboard.json'));
  const g = sb.games.find((x) => x.home.abbr === 'BUF');
  assert.equal(g.odds.homeSpread, -6.5);
  assert.equal(g.odds.homeML, -290);
  assert.equal(g.odds.awayML, 235);
  assert.equal(espn.parseOddsObject(undefined), null);
});

test('injury helpers: severity and restriction evidence (never invented)', () => {
  assert.equal(espn.injurySeverity('Out'), 'out');
  assert.equal(espn.injurySeverity('Injured Reserve'), 'out');
  assert.equal(espn.injurySeverity('Questionable'), 'questionable');
  assert.equal(espn.injurySeverity(null), null);
  assert.equal(espn.restrictionEvidence({ status: 'Questionable', detail: null }), null);
  assert.match(espn.restrictionEvidence({ longComment: 'Coach said he will be on a snap count Sunday.' }), /snap count/);
  const inj = espn.parseInjuries(nfl);
  assert.ok(inj.length > 0 && inj.every((i) => i.status));
});

test('actual values: DNP/missing handled, counting stats zero-filled, ratios null when undefined', () => {
  assert.equal(actualValue(null, 'rush_yds'), null);
  assert.equal(actualValue({ receptions: 3, rec_yds: 30 }, 'rush_yds'), 0);
  assert.equal(actualValue({ receptions: 0, rec_yds: 0 }, 'ypr'), null);
  assert.equal(actualValue({ carries: 10, rush_yds: 45 }, 'ypc'), 4.5);
  assert.equal(actualValue({ rush_td: 1 }, 'tds'), 1);
  // Unpublished targets (college box scores) are unknown, not zero.
  assert.equal(actualValue({ receptions: 4, rec_yds: 50 }, 'targets'), null);
});

test('college settlement derives targets from play-by-play and flags them', async () => {
  const { actualLinesFromSummary } = await import('../src/services.js');
  const lines = actualLinesFromSummary(cfb);
  const withRec = [...lines.values()].filter((s) => s.receptions > 0);
  assert.ok(withRec.length > 0);
  for (const s of withRec) if (s.targets != null) { assert.equal(s.targetsDerived, true); assert.ok(s.targets >= s.receptions); }
  assert.ok(withRec.filter((s) => s.targets != null).length / withRec.length >= 0.9);
});

test('nflverse baseline aggregation', () => {
  const rows = [
    { season_type: 'REG', position: 'RB', carries: '20', rushing_yards: '90', rushing_10: '2', rushing_20: '1', targets: '4', receptions: '3', receiving_yards: '24', receiving_20: '0', receiving_40: '0', rushing_tds: '1', receiving_tds: '0' },
    { season_type: 'POST', position: 'RB', carries: '99', rushing_yards: '0' },
  ];
  const m = measureNfl(rows);
  assert.equal(m.ypc.RB, 4.5);
  assert.equal(m.run10, 0.1);
  assert.equal(m.catchRate.RB, 0.75);
});
