// VOLUME ENGINE: context-aware run/pass tendencies (fbm-1.5). Built from nflverse play-by-play as of a given week
// (current-season plays before that week + previous season at PRIOR_W), so nothing after kickoff is used.
//
// The idea: "they ran 32 times" means nothing without the situation. A team that led all game SHOULD run a lot.
// So every play is compared with the league's pass rate in the SAME situation (score margin bucket × down × distance):
//   offPROE  — how much more/less a team passes than expected in the situations it was in (pass rate over expected)
//   defPROE  — how much more/less OPPONENTS passed against this defense than expected, after removing each
//              opponent's own tendency (so a defense isn't labeled "run on a lot" just because opponents led)
// A game's pass rate in each score state = league rate for that state + a·offPROE + b·defPROE(opponent), with
// a, b fitted walk-forward (scripts/volume_test.mjs). Game script then comes from the spread's state weights.
import { loadPlays } from './pbp.js';

export const PRIOR_W = 0.25;
export const STATES = ['blowTrail', 'trail', 'close', 'lead', 'blowLead'];
export function stateOf(sd, B = 17) {
  if (sd == null) return 'close';
  if (sd <= -B) return 'blowTrail';
  if (sd < -7.5) return 'trail';
  if (sd <= 7.5) return 'close';
  if (sd < B) return 'lead';
  return 'blowLead';
}
const sit = (p) => `${stateOf(p.sd)}|${p.dn ?? 0}|${p.tg == null ? 'm' : p.tg <= 3 ? 's' : p.tg <= 7 ? 'm' : 'l'}`;
const isDropback = (p) => p.t === 'P' || p.scr === 1;

const cache = new Map();
/** { leagueState: {state: passRate}, teams: {abbr: {offPROE, defPROE, offN, defN, playsPerGame, playsFacedPerGame}} } */
export async function buildVolume(season, week) {
  const key = `${season}|${week}`;
  if (cache.has(key)) return cache.get(key);
  const [cur, prev] = await Promise.all([loadPlays(season), loadPlays(season - 1).catch(() => [])]);
  const plays = [];
  for (const p of cur) if (!p.post && p.w < week && p.o && p.d) plays.push([p, 1]);
  for (const p of prev) if (p.o && p.d) plays.push([p, PRIOR_W]);

  // League pass rate by situation and by score state.
  const L = new Map(), LS = new Map();
  for (const [p, w] of plays) {
    const k = sit(p), s = stateOf(p.sd), db = isDropback(p) ? 1 : 0;
    const a = L.get(k) || L.set(k, [0, 0]).get(k); a[0] += w * db; a[1] += w;
    const b = LS.get(s) || LS.set(s, [0, 0]).get(s); b[0] += w * db; b[1] += w;
  }
  const lg = (p) => { const a = L.get(sit(p)); return a && a[1] >= 30 ? a[0] / a[1] : (LS.get(stateOf(p.sd))?.[0] || 0) / (LS.get(stateOf(p.sd))?.[1] || 1); };

  // Offense PROE (shrunk), then defense PROE net of each opponent's own tendency.
  const off = new Map(), games = new Map();
  for (const [p, w] of plays) {
    const a = off.get(p.o) || off.set(p.o, [0, 0]).get(p.o); a[0] += w * ((isDropback(p) ? 1 : 0) - lg(p)); a[1] += w;
    if (w === 1) { const g = games.get(p.o) || games.set(p.o, { off: new Set(), offPlays: 0, def: new Set(), defPlays: 0 }).get(p.o); g.off.add(p.g); g.offPlays++; }
    if (w === 1) { const g = games.get(p.d) || games.set(p.d, { off: new Set(), offPlays: 0, def: new Set(), defPlays: 0 }).get(p.d); g.def.add(p.g); g.defPlays++; }
  }
  const K_OFF = 200, K_DEF = 300;
  const offPROE = (t) => { const a = off.get(t); return a ? a[0] / (a[1] + K_OFF) : 0; };
  const def = new Map();
  for (const [p, w] of plays) { const a = def.get(p.d) || def.set(p.d, [0, 0]).get(p.d); a[0] += w * ((isDropback(p) ? 1 : 0) - lg(p) - offPROE(p.o)); a[1] += w; }
  const teams = {};
  for (const t of new Set([...off.keys(), ...def.keys()])) {
    const d = def.get(t), g = games.get(t);
    teams[t] = {
      offPROE: offPROE(t), defPROE: d ? d[0] / (d[1] + K_DEF) : 0, offN: off.get(t)?.[1] || 0, defN: d?.[1] || 0,
      playsPerGame: g?.off.size ? g.offPlays / g.off.size : null, playsFacedPerGame: g?.def.size ? g.defPlays / g.def.size : null,
    };
  }
  const leagueState = Object.fromEntries(STATES.map((s) => [s, LS.get(s) ? LS.get(s)[0] / LS.get(s)[1] : 0.58]));
  const out = { season, week, leagueState, teams };
  cache.set(key, out);
  return out;
}

/** Pass (dropback) rate per score state for one team vs one opponent, using fitted weights a, b. */
export function passRatesFor(vol, team, opp, { a = 1, b = 1 } = {}) {
  const T = vol.teams[team] || { offPROE: 0 }, O = vol.teams[opp] || { defPROE: 0 };
  return Object.fromEntries(STATES.map((s) => [s, Math.min(0.85, Math.max(0.2, vol.leagueState[s] + a * T.offPROE + b * O.defPROE))]));
}
