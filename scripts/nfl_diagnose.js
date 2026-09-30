// NFL-only error diagnosis of a sealed blind batch. READ-ONLY: never writes predictions and never
// changes the model. Rebuilds each game deterministically (verifying it reproduces the sealed
// projections), then compares model internals to what actually happened.
// Usage: node --no-warnings scripts/nfl_diagnose.js [--batch 3]
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { openBlind, listSeasonGames, predictGame, makePositionsFor } from '../src/blind.js';
import { openLedger, evaluationRows } from '../src/ledger.js';
import * as espn from '../src/espn.js';
import { actualLinesFromSummary } from '../src/services.js';
import { actualValue } from '../src/ledger.js';
import { fetchCached } from '../src/fetcher.js';
import { parseCsv } from '../src/baselines.js';
import { normName } from '../src/snaps.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const batch = Number(arg('batch', 3));
const d = openBlind();
const stored = d.prepare("SELECT * FROM blind_predictions WHERE batch_id=? AND league='nfl'").all(batch);
const games = d.prepare("SELECT game_id, week FROM blind_manifests WHERE batch_id=? AND league='nfl' AND status='predicted' ORDER BY kickoff").all(batch);
const lines = d.prepare("SELECT * FROM blind_lines WHERE batch_id=?").all(batch);
const lineOf = new Map(lines.map((l) => [`${l.game_id}|${l.player_id}|${l.stat}`, l]));
const { season, games: all } = await listSeasonGames('nfl');

// as-of-week position tables (same as the batch)
const tbl = async (s) => { const r = await fetchCached(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${s}.csv`, { ttl: 6 * 3600, as: 'text' }); return { rows: parseCsv(r.data).map((x) => ({ key: `${x.team}|${normName(x.player_display_name || x.player_name)}`, week: Number(x.week), pos: x.position })) }; };
const nflTables = { cur: await tbl(season), prev: await tbl(season - 1) };

const rows = [];       // player-stat rows
const teamRows = [];   // team-game rows
const roleRows = [];   // role coverage per team-game
let reproduced = 0, mismatched = 0;

for (const g of games) {
  const game = all.find((x) => x.id === g.game_id);
  const res = await predictGame('nfl', game, all, { positionsFor: makePositionsFor('nfl', season, game.week, nflTables) });
  if (res.skipped) { console.error('rebuild skipped', g.game_id, res.reason); continue; }
  const m = res.m;
  // Determinism check against the sealed rows.
  for (const p of m.projections) {
    const s = stored.find((x) => x.game_id === g.game_id && x.player_id === p.playerId && x.stat === p.stat);
    if (s && Math.abs(s.projection - p.projection) < 1e-9) reproduced++; else mismatched++;
  }
  const sum = (await espn.getSummary('nfl', g.game_id, { final: true })).data;
  const box = actualLinesFromSummary(sum);
  const plays = espn.extractPlays(sum);
  const hdr = espn.summaryTeams(sum);
  for (const t of [m.home, m.away]) {
    const tid = t.id;
    const off = plays.filter((p) => p.offenseId === tid);
    const rushes = off.filter((p) => p.kind === 'rush').length, db = off.filter((p) => p.kind !== 'rush').length;
    const me = tid === hdr.home.id ? hdr.home : hdr.away, op = tid === hdr.home.id ? hdr.away : hdr.home;
    const w = t.scriptWeights, pr = t.params.passRate;
    const projPassRate = Object.keys(w).reduce((a, k) => a + w[k] * pr[k], 0);
    const teamBox = [...espn.parseBoxscore(sum).values()].filter((r) => r.teamId === tid);
    const teamCar = teamBox.reduce((a, r) => a + (r.stats.carries || 0), 0), teamTgt = teamBox.reduce((a, r) => a + (r.stats.targets || 0), 0);
    teamRows.push({ game: g.game_id, week: g.week, team: t.abbr, projPlays: t.params.plays, actPlays: rushes + db, projPassRate, actPassRate: db / Math.max(1, rushes + db), expMargin: t.expMargin, actMargin: me.score - op.score, projPts: t.impliedPts, actPts: me.score });
    // Role coverage: did our cards include the real producers?
    const cardIds = new Set(t.cards.map((c) => c.id));
    const topRush = teamBox.filter((r) => (r.stats.carries || 0) >= 8).map((r) => r.athleteId);
    const topTgt = teamBox.filter((r) => (r.stats.targets || 0) >= 6).map((r) => r.athleteId);
    const missed = [...new Set([...topRush, ...topTgt])].filter((id) => !cardIds.has(id));
    const phantom = t.cards.filter((c) => !box.get(c.id)).map((c) => c.name);
    roleRows.push({ game: g.game_id, week: g.week, team: t.abbr, producers: new Set([...topRush, ...topTgt]).size, missed: missed.length, missedNames: missed.map((id) => teamBox.find((r) => r.athleteId === id)?.name), phantom });
    for (const c of [...t.cards, ...(t.kicker ? [t.kicker] : [])]) {
      const a = box.get(c.id);
      for (const s of Object.values(c.stats)) {
        if (!s.available || s.proj == null) continue;
        const actual = a ? actualValue(a, s.key) : null;
        const L = lineOf.get(`${g.game_id}|${c.id}|${s.key}`);
        rows.push({
          game: g.game_id, week: g.week, team: t.abbr, player: c.name, id: c.id, pos: c.pos, role: c.role, stat: s.key,
          proj: s.proj, p10: s.p10, p90: s.p90, seasonAvg: s.seasonAvg, seasonGames: s.seasonGames, actual, noRow: !a,
          line: L?.line ?? null, openLine: L?.open_line ?? null,
          projCar: c.opportunity?.carries, projTgt: c.opportunity?.targets, projAtt: c.opportunity?.dropbacks,
          projCarShare: c.opportunity?.carryShare, projTgtShare: c.opportunity?.targetShare,
          effYpc: c.efficiency?.ypc?.final, effCatch: c.efficiency?.catchRate?.final, effYpCatch: c.efficiency?.ypCatch?.final,
          actCar: a?.carries ?? 0, actTgt: a?.targets ?? null, actRec: a?.receptions ?? 0, actRushYds: a?.rush_yds ?? 0, actRecYds: a?.rec_yds ?? 0, actAtt: a?.pass_att ?? 0, actPassYds: a?.pass_yds ?? 0,
          actCarShare: teamCar ? (a?.carries || 0) / teamCar : null, actTgtShare: teamTgt ? (a?.targets || 0) / teamTgt : null,
          teamActPlays: rushes + db, teamProjPlays: t.params.plays, actLongRush: a?.long_rush ?? null, actLongRec: a?.long_rec ?? null, actLongCmp: a?.long_cmp ?? null,
          teamExpMargin: t.expMargin, teamActMargin: me.score - op.score, teamProjAtt: t.v12?.volume?.attTarget ?? null, teamActAtt: off.filter((p) => p.kind === 'pass').length,
        });
      }
    }
  }
  console.error(`rebuilt ${g.game_id} (wk${g.week})`);
}

// Market-informed backtest (same games) for comparison.
const mi = evaluationRows({ league: 'nfl', kind: 'backtest', modelVersion: 'fbm-1.1.0' }, openLedger());
const miMap = new Map(mi.filter((r) => r.actual != null).map((r) => [`${r.game_id}|${r.player_id}|${r.stat}`, r.projection]));

const out = { batch, generatedAt: new Date().toISOString(), determinism: { reproduced, mismatched }, rows, teamRows, roleRows, marketInformed: [...miMap].length };
fs.writeFileSync(path.join(DATA_DIR, `nfl_diagnosis_rows_${batch}.json`), JSON.stringify({ ...out, miMap: Object.fromEntries(miMap) }));
console.log(JSON.stringify({ games: games.length, rows: rows.length, teamRows: teamRows.length, determinism: out.determinism }));
