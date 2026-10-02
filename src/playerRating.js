// PLAYER RATING = Madden overall + Production Monitor (src/productionMonitor.js), blended per position with the weights
// that best predicted real next-4-game production in a 2024 test (scripts/player_rating_fit.mjs →
// src/fitted_player_rating.json). Output: z-score within position and a 0–100 rating (100·Φ(z)).
//
// Madden data is EA's and stays local (reports/madden_ratings.json, gitignored). `refreshPlayerRatings` writes only the
// DERIVED ratings (no Madden numbers) to reports/player_ratings_live.json, which the projection model and the public
// site build read — so local and public projections match.
import fs from 'node:fs';
import { buildMonitor, productionScores } from './productionMonitor.js';
import { maddenIndex, onScale } from './playerRatings.js';
import { loadPlayerIds } from './pbp.js';

const FIT = (() => { try { return JSON.parse(fs.readFileSync(new URL('./fitted_player_rating.json', import.meta.url), 'utf8')).byPos; } catch { return null; } })();
const LIVE = new URL('../reports/player_ratings_live.json', import.meta.url);
const MIN_N = { QB: 100, RB: 40, WR: 30, TE: 30 }; // targets for receivers: TE ratings lean on production, which is noisy on few targets
const norm = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’,]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

/** Compute from Madden (local) + monitor; returns { season, week, players: {gsis: {...}} } or null without Madden. */
export async function computePlayerRatings(season, week) {
  const MI = maddenIndex(); if (!MI || !FIT) return null;
  const mon = await buildMonitor([season - 1, season], { season, beforeWeek: week });
  const ids = await loadPlayerIds();
  const players = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    // Rookies (no games last season) qualify on pace, and their production counts in proportion to how much of it there is
    // (reliability = touches / full sample): a thin rookie sample moves the rating toward Madden, never below it by default.
    const rookie = (s) => !mon.get(s.id)?.games.some((g) => g.season < season);
    const need = (s) => MIN_N[pos] * (rookie(s) ? Math.min(1, s.games / 8) : 1);
    const S = [...productionScores(mon, { lambda: FIT[pos].lambda }).values()].filter((s) => s.pos === pos && s.eff != null && s.games >= 2 && (s.effN || 0) >= need(s));
    const rel = (s) => Math.min(1, (s.effN || 0) / MIN_N[pos]);
    const L = S.map((s) => ({ s, m: MI.byKey.get(`${norm(s.name)}|${pos}`)?.overall ?? null })).filter((x) => x.m != null);
    if (L.length < 8) continue;
    const z = (f) => { const v = L.map(f), mu = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length) || 1; return (x) => (f(x) - mu) / sd; };
    const zm = z((x) => x.m), ze = z((x) => x.s.eff), zu = z((x) => x.s.usage ?? 0), b = FIT[pos].beta;
    const sc = (x) => b.madden * zm(x) + rel(x.s) * (b.efficiency * ze(x) + b.usage * zu(x)), zs = z(sc);
    for (const x of L) players[x.s.id] = { name: x.s.name, pos, z: +zs(x).toFixed(3), rating: onScale(pos, zs(x)), effPerTouch: +x.s.eff.toFixed(2), usageVsUsual: x.s.usage != null ? +x.s.usage.toFixed(3) : null, games: x.s.games, rookie: rookie(x.s) || undefined };
  }
  void ids;
  return { season, week, computedAt: new Date().toISOString(), weights: Object.fromEntries(Object.entries(FIT).map(([p, v]) => [p, v.share])), players };
}

/** Write the derived ratings for the projection model / public site (no Madden numbers in the file). */
export async function refreshPlayerRatings(season, week) {
  const r = await computePlayerRatings(season, week);
  if (r) fs.writeFileSync(LIVE, JSON.stringify(r));
  return r;
}

const memo = new Map();
/** Player Ratings for a game week: computed live when Madden is available locally, else the committed derived file. */
export async function playerRatingsFor(season, week) {
  const key = `${season}|${week}`; if (memo.has(key)) return memo.get(key);
  let r = null, file = null;
  try { file = JSON.parse(fs.readFileSync(LIVE, 'utf8')); if (file.season === season && file.week === week) r = file; } catch { /* none */ }
  if (!r) r = await computePlayerRatings(season, week).catch(() => null);
  // No local Madden (e.g. the GitHub site build) and the file is from an earlier week of this season: use it rather than
  // silently dropping player quality from the projections. Marked stale so the age is visible.
  if (!r && file && file.season === season && file.week < week) r = { ...file, staleFromWeek: file.week };
  memo.set(key, r);
  return r;
}
