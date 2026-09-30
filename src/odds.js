// Betting math. Pure functions — covered by test/odds.test.js.

/** Book-implied final score from a total and the HOME spread (negative = home favored). */
export function impliedScore(total, homeSpread) {
  if (!isFiniteNum(total) || !isFiniteNum(homeSpread)) return null;
  const home = (total - homeSpread) / 2;
  const away = (total + homeSpread) / 2;
  // Two decimals: half-point totals/spreads produce exact quarter points (22.25), and rounding
  // each side to 0.1 would make the pair no longer sum to the total.
  return { home: round2(home), away: round2(away) };
}

/** American odds -> implied probability (includes the book's margin). */
export function americanToProb(odds) {
  const o = Number(odds);
  if (!isFiniteNum(o) || o === 0 || (o > -100 && o < 100)) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}

/** Probability -> fair American odds (no margin). */
export function probToAmerican(p) {
  if (!isFiniteNum(p) || p <= 0 || p >= 1) return null;
  const v = p >= 0.5 ? -(p / (1 - p)) * 100 : ((1 - p) / p) * 100;
  return Math.round(v);
}

/** Remove the vig from a two-way market. Returns [pA, pB, overround]. */
export function noVig(oddsA, oddsB) {
  const a = americanToProb(oddsA);
  const b = americanToProb(oddsB);
  if (a == null || b == null) return null;
  const s = a + b;
  return { a: a / s, b: b / s, overround: s - 1 };
}

export function formatAmerican(o) {
  if (o == null || !isFiniteNum(Number(o))) return '—';
  const n = Math.round(Number(o));
  return n > 0 ? `+${n}` : `${n}`;
}

export function parseAmerican(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const t = String(s).trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV') return 100;
  const n = Number(t.replace('+', ''));
  return isFiniteNum(n) ? n : null;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function round2(x) { return Math.round(x * 100) / 100; }
