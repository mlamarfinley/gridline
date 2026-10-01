// nflverse play-by-play (+ FTN/NGS participation charting) loader for the matchup engine (src/profiles.js).
// Files are downloaded once to data/cache/nflverse/, stream-parsed, and reduced to the few columns we use,
// cached as compact JSON in data/cache/derived/. Past seasons are permanent; the current season refreshes.
// Every consumer filters plays by week < the game being projected, so nothing after kickoff is ever used.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { CACHE_DIR } from './config.js';

const NV = 'https://github.com/nflverse/nflverse-data/releases/download';
const RAW = path.join(CACHE_DIR, 'nflverse');
const DERIVED = path.join(CACHE_DIR, 'derived');
const CURRENT_TTL_MS = 6 * 3600e3;

async function download(url, file, ttlMs) {
  try { const st = fs.statSync(file); if (ttlMs == null || Date.now() - st.mtimeMs < ttlMs) return file; } catch { /* fetch */ }
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'football-dashboard/1.0 (local research tool)' } });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; throw e; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
  return file;
}

function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function streamRows(file, gz, cols, onRow) {
  const input = fs.createReadStream(file);
  const rl = readline.createInterface({ input: gz ? input.pipe(zlib.createGunzip()) : input, crlfDelay: Infinity });
  let idx = null;
  for await (const line of rl) {
    if (!idx) { const h = splitLine(line); idx = cols.map((c) => h.indexOf(c)); continue; }
    if (!line) continue;
    const v = splitLine(line);
    onRow(idx.map((i) => (i >= 0 ? v[i] : '')));
  }
}

const num = (x) => (x === '' || x == null || x === 'NA' ? null : Number(x));
const isCurrent = (season) => season >= new Date().getUTCFullYear() - (new Date().getUTCMonth() < 2 ? 1 : 0);
const mem = new Map();

/** Compact play list for a season: pass & run plays only (regular season + post). */
export async function loadPlays(season) {
  const key = `plays${season}`;
  if (mem.has(key)) return mem.get(key);
  const derived = path.join(DERIVED, `plays_${season}.json`);
  const cur = isCurrent(season);
  try {
    const st = fs.statSync(derived);
    if (!cur || Date.now() - st.mtimeMs < CURRENT_TTL_MS) { const d = JSON.parse(fs.readFileSync(derived, 'utf8')); mem.set(key, d); return d; }
  } catch { /* build */ }
  const file = await download(`${NV}/pbp/play_by_play_${season}.csv.gz`, path.join(RAW, `play_by_play_${season}.csv.gz`), cur ? CURRENT_TTL_MS : null);
  const COLS = ['game_id', 'play_id', 'week', 'season_type', 'posteam', 'defteam', 'play_type', 'pass_location', 'air_yards', 'yards_after_catch', 'complete_pass', 'yards_gained',
    'receiver_player_id', 'rusher_player_id', 'passer_player_id', 'run_location', 'run_gap', 'sack', 'qb_hit', 'qb_scramble', 'interception', 'epa', 'down', 'ydstogo', 'two_point_attempt'];
  const plays = [];
  await streamRows(file, true, COLS, (r) => {
    const [gid, pid, week, st, pos, def, pt, ploc, air, yac, comp, yds, rec, rush, passer, rloc, rgap, sack, hit, scr, int, epa, down, togo, twopt] = r;
    if (pt !== 'pass' && pt !== 'run') return;
    if (twopt === '1') return;
    plays.push({ g: gid, p: Number(pid), w: Number(week), post: st === 'POST' ? 1 : 0, o: pos, d: def, t: pt === 'pass' ? 'P' : 'R',
      pl: ploc || null, ay: num(air), yac: num(yac), c: comp === '1' ? 1 : 0, y: num(yds) ?? 0, rec: rec || null, ru: rush || null, qb: passer || null,
      rl: rloc || null, rg: rgap || null, sk: sack === '1' ? 1 : 0, hit: hit === '1' ? 1 : 0, scr: scr === '1' ? 1 : 0, int: int === '1' ? 1 : 0, epa: num(epa), dn: num(down), tg: num(togo) });
  });
  fs.mkdirSync(DERIVED, { recursive: true });
  fs.writeFileSync(derived, JSON.stringify(plays));
  mem.set(key, plays);
  return plays;
}

/** Participation charting (route of the targeted receiver, coverage, box count, pressure) keyed by `${game}|${play}`. */
export async function loadParticipation(season) {
  const key = `part${season}`;
  if (mem.has(key)) return mem.get(key);
  const derived = path.join(DERIVED, `participation_${season}.json`);
  try { const d = new Map(JSON.parse(fs.readFileSync(derived, 'utf8'))); mem.set(key, d); return d; } catch { /* build */ }
  let file;
  try { file = await download(`${NV}/pbp_participation/pbp_participation_${season}.csv`, path.join(RAW, `pbp_participation_${season}.csv`), isCurrent(season) ? CURRENT_TTL_MS : null); }
  catch (e) { if (e.status === 404) { mem.set(key, null); return null; } throw e; }
  const out = new Map();
  await streamRows(file, false, ['nflverse_game_id', 'play_id', 'route', 'defense_man_zone_type', 'defense_coverage_type', 'defenders_in_box', 'was_pressure'], (r) => {
    const [g, p, route, mz, cov, box, pres] = r;
    if (!route && !mz && !box) return;
    out.set(`${g}|${p}`, { route: route || null, mz: mz === 'MAN_COVERAGE' ? 'man' : mz === 'ZONE_COVERAGE' ? 'zone' : null, cov: cov || null, box: num(box), pres: pres === 'TRUE' ? 1 : pres === 'FALSE' ? 0 : null });
  });
  fs.mkdirSync(DERIVED, { recursive: true });
  fs.writeFileSync(derived, JSON.stringify([...out]));
  mem.set(key, out);
  return out;
}

/** ESPN athlete id -> { gsis, pos } and gsis -> pos, from nflverse players.csv. */
export async function loadPlayerIds() {
  if (mem.has('ids')) return mem.get('ids');
  const file = await download(`${NV}/players/players.csv`, path.join(RAW, 'players.csv'), 7 * 86400e3);
  const byEspn = new Map(), posByGsis = new Map();
  await streamRows(file, false, ['gsis_id', 'espn_id', 'position'], ([g, e, pos]) => {
    if (g) posByGsis.set(g, pos);
    if (g && e) byEspn.set(String(e).replace(/\.0$/, ''), { gsis: g, pos });
  });
  const out = { byEspn, posByGsis };
  mem.set('ids', out);
  return out;
}
