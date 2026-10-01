// Projection engine.
//
// Structure (deliberately explicit so every number can be explained):
//   1. Game-script weights: from the book spread (or season margins if no line) we get a
//      distribution over five script states: blowTrail / trail / close / lead / blowLead.
//   2. Opportunity: team plays x state-specific pass rate x player's state-specific share
//      (carries, targets, dropbacks). Shares already account for teammate availability.
//   3. Efficiency: per-opportunity yardage distributions (player rate shrunk toward league,
//      scaled by opponent allowed rate, weather). Explosive-play tails (10+/20+ runs,
//      20+/40+ catches) are set from player + opponent explosive rates; the tail shapes the
//      range/upside while the mean stays anchored to the efficiency estimate.
//   4. A play-level Monte Carlo (seeded => reproducible snapshots) draws all of the above
//      jointly for a team, so QB and receiver outcomes are internally consistent.
import { PRIORS, SIMS } from './config.js';
import { STATES } from './history.js';
import { normCdf } from './odds.js';

// ---------- RNG ----------
export function seedFrom(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.normal = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = next();
    v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  next.gamma = (k) => { // Marsaglia–Tsang, mean k, scale 1
    if (k < 1) return next.gamma(k + 1) * Math.pow(next(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = next.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  next.poisson = (lam) => {
    if (lam <= 0) return 0;
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * next.normal()));
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  return next;
}

// ---------- Game script ----------
/**
 * Weights over script states for a team whose expected FINAL margin is `m` (positive = team
 * favored). The average in-game margin is narrower than the final margin, so we use a
 * compressed normal. This is an approximation, not a validated win-probability model.
 */
export function scenarioWeights(m, lg) {
  const P = PRIORS[lg];
  const mu = 0.6 * m;
  const sd = P.marginSd * P.stateSdFactor;
  const B = P.blowoutMargin;
  const c = (x) => normCdf((x - mu) / sd);
  const w = {
    blowTrail: c(-B),
    trail: c(-7.5) - c(-B),
    close: c(7.5) - c(-7.5),
    lead: c(B) - c(7.5),
    blowLead: 1 - c(B),
  };
  return w;
}

// ---------- Per-opportunity yardage draws ----------
/**
 * Yards on one carry. p10 = P(gain >= 10), p20 = P(gain >= 20); mean anchored to `ypc`.
 * Explosive part: 10 + Exp(theta) with P(>=20 | >=10) = p20/p10 = exp(-10/theta).
 */
export function makeRunDist(ypc, p10, p20) {
  p10 = clamp(p10, 0.02, 0.35);
  const q = clamp(p20 / p10, 0.06, 0.6);
  const theta = -10 / Math.log(q);
  const shortMean = clamp((ypc - p10 * (10 + theta)) / (1 - p10), -1, 6.5);
  return { kind: 'run', ypc, p10, p20: p10 * q, theta, shortMean, sd: 2.8, lo: -6, hi: 9 };
}
export function makeCatchDist(ypCatch, c20, c40) {
  c20 = clamp(c20, 0.01, 0.55);
  const q = clamp(c40 / c20, 0.03, 0.5);
  const theta = -20 / Math.log(q);
  const shortMean = clamp((ypCatch - c20 * (20 + theta)) / (1 - c20), 1, 16);
  return { kind: 'catch', ypCatch, c20, c40: c20 * q, theta, shortMean, sd: 4.5, lo: -3, hi: 19 };
}
function drawYards(d, R, tailProb, threshold) {
  if (R() < tailProb) return Math.round(threshold - d.theta * Math.log(1 - R()));
  const y = d.shortMean + d.sd * R.normal();
  return Math.round(clamp(y, d.lo, d.hi));
}
const drawRun = (d, R) => drawYards(d, R, d.p10, 10);
const drawCatch = (d, R) => drawYards(d, R, d.c20, 20);

// ---------- Team simulation ----------
// Variance knobs. Widened after the week-3 backtest showed RB carry ranges covering only ~59%.
export const WORKLOAD_K = { carry: 11, target: 22 }; // gamma shape => CV = 1/sqrt(k)
export const PLAYS_CV = 0.12;
export const PASS_RATE_SD = 0.04;
export const OPENING_CLOSE = 0.4; // share of each simulated game played in the 'close' state before the script applies
/**
 * team: { plays, passRate:{state}, sackRate, intRate, tdScale, blowFactor:{lead,trail},
 *         other:{run, catchRate, catch, rushTd, recTd} , fgPerGame, xpRate, qbFumblePerSack }
 * players: [{ id, pos, isCore, carryShare:{state}, targetShare:{state}, dropbackShare,
 *             run: dist, catchRate, catch: dist, rushTd, recTd, fumLost, dispersion }]
 * weights: script weights {state: w}
 */
export function simulateTeam(team, players, weights, { sims = SIMS, seed = 1, openingCloseShare = OPENING_CLOSE } = {}) {
  const R = rng(seed);
  const states = STATES;
  const cum = []; let acc = 0;
  for (const s of states) { acc += weights[s] || 0; cum.push(acc); }
  const pickState = () => { const u = R() * acc; for (let i = 0; i < cum.length; i++) if (u < cum[i]) return states[i]; return 'close'; };

  const out = {};
  for (const p of players) out[p.id] = { stats: {}, scripts: [] };
  const keys = ['pass_yds', 'completions', 'pass_att', 'pass_td', 'ints', 'long_cmp', 'rush_yds', 'carries', 'rush_td', 'long_rush', 'targets', 'receptions', 'rec_yds', 'rec_td', 'long_rec', 'fumbles', 'fumbles_lost', 'tds'];
  for (const p of players) for (const k of keys) out[p.id].stats[k] = new Float64Array(sims);
  const teamTds = new Float64Array(sims);
  const scriptOf = new Array(sims);

  const qb = players.find((p) => p.pos === 'QB' && p.dropbackShare > 0);
  const sharesFor = (field, state, mult) => {
    const arr = players.map((p, i) => {
      let s = p[field]?.[state] || 0;
      if (p.isCore && state === 'blowLead') s *= team.blowFactor.lead;
      if (p.isCore && state === 'blowTrail') s *= team.blowFactor.trail;
      return s * mult[i];
    });
    const tot = arr.reduce((a, b) => a + b, 0);
    if (tot > 0.98) { const k = 0.98 / tot; for (let i = 0; i < arr.length; i++) arr[i] *= k; }
    const cum2 = []; let a2 = 0;
    for (const v of arr) { a2 += v; cum2.push(a2); }
    return cum2; // remainder => "other"
  };
  const pickIdx = (cumArr) => { const u = R(); for (let i = 0; i < cumArr.length; i++) if (u < cumArr[i]) return i; return -1; };

  for (let s = 0; s < sims; s++) {
    const script = pickState();
    scriptOf[s] = script;
    // Per-sim workload noise: gamma multipliers with mean 1 (dispersion widens them). Carry
    // shares vary more game to game than target shares (backtest coverage, see BUILD_REPORT).
    const multC = players.map((p) => { const k = WORKLOAD_K.carry / (p.dispersion * p.dispersion); return R.gamma(k) / k; });
    const multT = players.map((p) => { const k = WORKLOAD_K.target / (p.dispersion * p.dispersion); return R.gamma(k) / k; });
    const plays = Math.max(35, Math.round(team.plays * (1 + PLAYS_CV * R.normal())));
    const prShift = PASS_RATE_SD * R.normal(); // game-level play-calling noise
    const openN = Math.round(plays * openingCloseShare);
    const cache = {};
    const getShares = (state) => (cache[state] ||= { c: sharesFor('carryShare', state, multC), t: sharesFor('targetShare', state, multT) });
    let tds = 0;
    for (let i = 0; i < plays; i++) {
      const state = i < openN ? 'close' : script;
      const sh = getShares(state);
      // In blowouts starters (incl. the QB) may be pulled: a share of snaps goes to backups.
      const qbIn = qb && !((state === 'blowLead' && R() > team.blowFactor.lead) || (state === 'blowTrail' && R() > team.blowFactor.trail));
      const QB = qbIn ? qb : null;
      if (R() < team.passRate[state] + prShift) {
        // Dropback
        if (R() < team.sackRate) {
          if (QB && R() < team.qbFumblePerSack) {
            const o = out[QB.id].stats; o.fumbles[s]++; if (R() < 0.45) o.fumbles_lost[s]++;
          }
          continue;
        }
        if (QB) out[QB.id].stats.pass_att[s]++;
        if (R() < team.intRate) { if (QB) out[QB.id].stats.ints[s]++; continue; }
        const ti = pickIdx(sh.t);
        const tp = ti >= 0 ? players[ti] : null;
        const catchRate = tp ? tp.catchRate : team.other.catchRate;
        if (tp) { out[tp.id].stats.targets[s]++; }
        if (R() < catchRate) {
          const d = tp ? tp.catch : team.other.catch;
          const y = drawCatch(d, R);
          const td = R() < (tp ? tp.recTd : team.other.recTd) * team.tdScale;
          if (tp) {
            const o = out[tp.id].stats;
            o.receptions[s]++; o.rec_yds[s] += y; if (y > o.long_rec[s]) o.long_rec[s] = y;
            if (td) { o.rec_td[s]++; o.tds[s]++; }
            if (R() < tp.fumLost) o.fumbles_lost[s]++;
          }
          if (QB) {
            const o = out[QB.id].stats;
            o.completions[s]++; o.pass_yds[s] += y; if (y > o.long_cmp[s]) o.long_cmp[s] = y;
            if (td) o.pass_td[s]++;
          }
          if (td) tds++;
        }
      } else {
        const ri = pickIdx(sh.c);
        const rp = ri >= 0 ? players[ri] : null;
        const d = rp ? rp.run : team.other.run;
        const y = drawRun(d, R);
        const td = R() < (rp ? rp.rushTd : team.other.rushTd) * team.tdScale;
        if (td) tds++;
        if (rp) {
          const o = out[rp.id].stats;
          o.carries[s]++; o.rush_yds[s] += y; if (y > o.long_rush[s]) o.long_rush[s] = y;
          if (td) { o.rush_td[s]++; o.tds[s]++; }
          if (R() < rp.fumLost) { o.fumbles[s]++; o.fumbles_lost[s]++; }
        }
      }
    }
    teamTds[s] = tds;
  }
  return { out, teamTds, scriptOf, sims };
}

/** Kicker outcomes from the team's simulated touchdowns. */
export function simulateKicker(teamTds, { fgPerGame, xpRate, seed = 7 }) {
  const R = rng(seed);
  const n = teamTds.length;
  const fg = new Float64Array(n), xp = new Float64Array(n), pts = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    let x = 0;
    for (let t = 0; t < teamTds[s]; t++) if (R() < xpRate) x++;
    const f = R.poisson(fgPerGame);
    fg[s] = f; xp[s] = x; pts[s] = 3 * f + x;
  }
  return { fg_made: fg, xp_made: xp, k_pts: pts };
}

// ---------- Summaries ----------
export function summarize(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const q = (p) => a[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const quantiles = [];
  for (let i = 0; i <= 40; i++) quantiles.push(q(i / 40));
  return { mean, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), quantiles };
}

/** P(X > line). For half-point lines this is P(X >= ceil(line)). */
export function probOver(arr, line) {
  if (line == null || !arr?.length) return null;
  let c = 0;
  for (const x of arr) if (x > line) c++;
  return c / arr.length;
}

/** Ratio-of-sums efficiency with a small-sample guard (used for ypc / ypr projections). */
export function ratioSummary(num, den) {
  let sn = 0, sd = 0; const vals = [];
  for (let i = 0; i < num.length; i++) { sn += num[i]; sd += den[i]; if (den[i] > 0) vals.push(num[i] / den[i]); }
  if (!vals.length) return null;
  const s = summarize(vals);
  s.mean = sd > 0 ? sn / sd : s.mean;
  return s;
}

export function shrink(x, n, prior, k) {
  if (x == null || !Number.isFinite(x) || !n) return prior;
  return (x * n + prior * k) / (n + k);
}
export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
