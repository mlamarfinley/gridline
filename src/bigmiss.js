// BIG-MISS model: the chance the BOOK line misses big (a real outlier), learned walk-forward from every 2024–26
// NFL pick with a line (scripts/bigmiss.mjs -> src/fitted_bigmiss.json). Shared by the learner and the live model.
//   BOOM: actual ≥ line + max(abs, rel·line)       BUST: actual ≤ line − max(abs, rel·line)
// Only stats where a big miss is meaningful; TDs and longest-play props are excluded (one play decides them).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const BIG = { pass_yds: { abs: 75, rel: 0.3 }, rush_yds: { abs: 30, rel: 0.45 }, rec_yds: { abs: 30, rel: 0.5 }, receptions: { abs: 3, rel: 0.5 }, carries: { abs: 6, rel: 0.4 }, completions: { abs: 6, rel: 0.3 } };
// Lines this low can't produce a real outlier (e.g. 1.5 receptions): excluded from picks.
export const MIN_LINE = { pass_yds: 150, rush_yds: 25, rec_yds: 20, receptions: 2.5, carries: 7.5, completions: 12.5 };
export const STAT_KEYS = ['pass_yds', 'rush_yds', 'rec_yds', 'receptions', 'carries', 'completions'];
export const FEATS = [...STAT_KEYS.map((k) => `stat is ${k}`), 'teammate out: freed share', 'model gap / line', 'model gap / threshold', 'line vs his recent avg', 'line vs his best recent', 'last-game vs line', 'projected usage share', 'expected margin', 'team implied pts', 'explosive runner', 'deep-target share', 'zone fit', 'position fit', 'run fit', 'explosive fit', 'man/zone fit', 'opp unit rating (rel)', 'small sample', 'range width / line'];
export const threshold = (stat, line) => Math.max(BIG[stat].abs, BIG[stat].rel * line);

/** In: { stat, line, proj, p10, p90, recent:[this season, oldest→newest], freed, share, expMargin, teamPts, explRel, deepShare, fit, oppUnit } */
export function bigMissX(f) {
  const T = threshold(f.stat, f.line), L = Math.max(f.line, 1);
  const recent = (f.recent || []).slice(-4);
  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : f.line;
  const best = recent.length ? Math.max(...recent) : f.line, last = recent.length ? recent[recent.length - 1] : f.line;
  const fit = f.fit || {};
  return [
    ...STAT_KEYS.map((k) => (f.stat === k ? 1 : 0)), f.freed || 0, (f.proj - f.line) / L, (f.proj - f.line) / T, (avg - f.line) / L, (best - f.line) / T, (last - f.line) / T,
    f.share ?? 0, f.expMargin ?? 0, f.teamPts ?? 0, f.explRel ?? 0, f.deepShare ?? 0,
    fit.zoneFit ?? 0, fit.posFit ?? 0, fit.runFit ?? 0, fit.explFit ?? 0, fit.covFit ?? 0,
    f.oppUnit != null ? (50 - f.oppUnit) / 15 : 0, (f.recent || []).length < 4 ? 1 : 0, (f.p90 - f.p10) / L,
  ];
}

/** Which defensive unit rating matters for this stat/position. */
export function oppUnitFor(stat, pos, defRatings) {
  if (!defRatings) return null;
  if (stat === 'pass_yds' || stat === 'completions') return defRatings.coverage;
  if (/rush|carries/.test(stat)) return defRatings.runD;
  return pos === 'TE' ? defRatings.vsTE : pos === 'RB' ? defRatings.vsRB : defRatings.corners;
}

export const predictLogit = (m, x) => 1 / (1 + Math.exp(-(m.b[0] + x.reduce((s, v, j) => s + (m.sd[j] ? ((v - m.mu[j]) / m.sd[j]) * m.b[j + 1] : 0), 0))));

let FIT = null;
try { FIT = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'fitted_bigmiss.json'), 'utf8')); } catch { FIT = null; }
export const bigMissModel = () => FIT;

/** { boom, bust, baseBoom, baseBust, x } or null. */
export function bigMissProbs(f) {
  if (!FIT || !BIG[f.stat]) return null;
  const x = bigMissX(f);
  return { boom: predictLogit(FIT.boom, x), bust: predictLogit(FIT.bust, x), baseBoom: FIT.baseRates?.[f.stat]?.boom ?? null, baseBust: FIT.baseRates?.[f.stat]?.bust ?? null, x };
}

/** The 3 features pushing this probability up the most (plain English), for the "why". */
export function topDrivers(kind, x) {
  if (!FIT) return [];
  const m = FIT[kind];
  return x.map((v, j) => [FEATS[j], m.sd[j] ? ((v - m.mu[j]) / m.sd[j]) * m.b[j + 1] : 0]).filter(([f, c]) => c > 0.08 && !f.startsWith('stat is')).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
}
