// ESTIMATED OL / DL UNIT GRADES — transparent proxies from play-by-play, not individual
// blocking grades. Every input also reflects QB, RBs, scheme and opponents; that caveat is
// shown next to the grades.
//
// Scale: 50 = league-average unit (NFL: measured from every completed game this season before
// kickoff; college: configured priors, labelled). Each 15 points = one team-level standard
// deviation of that metric. Higher is ALWAYS better (for the unit being graded). Rates are shrunk
// toward the baseline by sample size before scoring. Missing inputs => grade unavailable (null),
// never 0.
import { fetchCached } from './fetcher.js';
import * as espn from './espn.js';
import { LEAGUES } from './config.js';
import { finishedBefore, gameEndTime } from './history.js';

// Metric definitions. `dir` = +1 if a higher raw rate is better for the unit being graded.
export const METRICS = {
  runSuccess: { label: 'Designed-run success rate', dir: +1, k: 80, unit: 'runs' },
  stuffRate: { label: 'Runs stuffed at/behind line', dir: -1, k: 80, unit: 'runs' },
  runYpc: { label: 'Yards per designed run', dir: +1, k: 80, unit: 'runs' },
  run10: { label: 'Designed runs of 10+ yards', dir: +1, k: 120, unit: 'runs' },
  sackRate: { label: 'Sack rate (sacks / dropbacks)', dir: -1, k: 150, unit: 'dropbacks' },
};
// Component recipes: [metric, weight]. For defensive units the direction flips (what is good for
// an offense is bad for the defense allowing it).
export const COMPONENTS = {
  olRun: { label: 'OL run blocking', side: 'off', parts: [['runSuccess', 0.4], ['stuffRate', 0.3], ['runYpc', 0.2], ['run10', 0.1]] },
  olPass: { label: 'OL pass protection', side: 'off', parts: [['sackRate', 1]] },
  dlRun: { label: 'DL run defense', side: 'def', parts: [['runSuccess', 0.4], ['stuffRate', 0.3], ['runYpc', 0.2], ['run10', 0.1]] },
  dlPass: { label: 'DL pass rush', side: 'def', parts: [['sackRate', 1]] },
};

// College priors (not measured league-wide — labelled as such in the UI).
export const CFB_PRIOR_BASELINE = {
  mean: { runSuccess: 0.42, stuffRate: 0.19, runYpc: 4.6, run10: 0.13, sackRate: 0.065 },
  sd: { runSuccess: 0.05, stuffRate: 0.04, runYpc: 0.7, run10: 0.03, sackRate: 0.025 },
};

function emptyLine() { return { runs: 0, succ: 0, succN: 0, stuff: 0, yds: 0, r10: 0, db: 0, sacks: 0 }; }

/** Aggregate designed runs (scrambles excluded) and dropbacks for one side of one game. */
export function lineAgg(plays, teamId, side, acc = emptyLine()) {
  const tid = String(teamId);
  for (const p of plays) {
    const mine = side === 'off' ? p.offenseId === tid : p.defenseId === tid;
    if (!mine) continue;
    if (p.kind === 'rush' && !p.scramble) {
      acc.runs++; acc.yds += p.yards;
      if (p.yards <= 0) acc.stuff++;
      if (p.yards >= 10) acc.r10++;
      if (p.down != null && p.distance != null) {
        const need = p.down === 1 ? 0.4 * p.distance : p.down === 2 ? 0.6 * p.distance : p.distance;
        acc.succN++; if (p.yards >= need) acc.succ++;
      }
    } else if (p.kind === 'pass' || p.kind === 'sack') {
      acc.db++; if (p.kind === 'sack') acc.sacks++;
    }
  }
  return acc;
}

export function rates(a) {
  const r = (x, n) => (n > 0 ? x / n : null);
  return {
    runSuccess: { v: r(a.succ, a.succN), n: a.succN },
    stuffRate: { v: r(a.stuff, a.runs), n: a.runs },
    runYpc: { v: r(a.yds, a.runs), n: a.runs },
    run10: { v: r(a.r10, a.runs), n: a.runs },
    sackRate: { v: r(a.sacks, a.db), n: a.db },
  };
}

/** Baseline (mean + team-level SD) from per-team offensive aggregates. Pure; tested. */
export function baselineFromTeams(teamAggs) {
  const mean = {}, sd = {};
  const list = teamAggs.map(rates);
  for (const m of Object.keys(METRICS)) {
    const vals = list.map((x) => x[m]).filter((x) => x.v != null && x.n >= 10);
    const tot = vals.reduce((s, x) => s + x.n, 0);
    mean[m] = tot ? vals.reduce((s, x) => s + x.v * x.n, 0) / tot : null;
    const mu = vals.length ? vals.reduce((s, x) => s + x.v, 0) / vals.length : null;
    sd[m] = vals.length >= 6 ? Math.sqrt(vals.reduce((s, x) => s + (x.v - mu) ** 2, 0) / (vals.length - 1)) : null;
  }
  return { mean, sd, teams: teamAggs.length };
}

export function letter(score) {
  if (score == null) return null;
  return score >= 75 ? 'A' : score >= 62 ? 'B' : score >= 45 ? 'C' : score >= 32 ? 'D' : 'F';
}

function confidence(n, unit) {
  const [lo, hi] = unit === 'dropbacks' ? [100, 220] : [70, 160];
  return n >= hi ? 'high' : n >= lo ? 'medium' : 'low';
}

/**
 * Grade one unit component. agg = team aggregate for the relevant side (off for OL, the
 * opponents' offense vs this defense for DL). Returns null score when inputs are missing.
 */
export function gradeComponent(key, agg, base) {
  const C = COMPONENTS[key];
  const rs = rates(agg);
  const inputs = [];
  let wsum = 0, zsum = 0, minN = Infinity;
  for (const [m, w] of C.parts) {
    const M = METRICS[m];
    const r = rs[m];
    const mu = base.mean[m], sd = base.sd[m];
    if (r.v == null || mu == null || !sd) { inputs.push({ metric: m, label: M.label, raw: r.v, n: r.n, unavailable: true }); continue; }
    const shrunk = (r.v * r.n + mu * M.k) / (r.n + M.k);
    // Offense: higher-is-better per M.dir. Defense: the same rate is what it ALLOWED, so flip.
    const good = C.side === 'off' ? M.dir : -M.dir;
    const z = (good * (shrunk - mu)) / sd;
    inputs.push({ metric: m, label: M.label, raw: r.v, shrunk, n: r.n, baseline: mu, z, weight: w });
    wsum += w; zsum += w * z; minN = Math.min(minN, r.n);
  }
  if (!wsum) return { key, label: C.label, score: null, letter: null, confidence: null, inputs, reason: 'inputs unavailable' };
  const z = zsum / wsum;
  const score = Math.max(0, Math.min(100, Math.round(50 + 15 * z)));
  const unit = C.parts.some(([m]) => m === 'sackRate') ? 'dropbacks' : 'runs';
  return { key, label: C.label, score, letter: letter(score), z, confidence: confidence(minN, unit), sample: minN, sampleUnit: unit, inputs, partial: wsum < 0.999 };
}

export function gradeTeam(offAgg, defAgg, base) {
  const g = {
    olRun: gradeComponent('olRun', offAgg, base), olPass: gradeComponent('olPass', offAgg, base),
    dlRun: gradeComponent('dlRun', defAgg, base), dlPass: gradeComponent('dlPass', defAgg, base),
  };
  const comp = (a, b, wa) => (a.score == null || b.score == null ? (a.score ?? b.score ?? null) : Math.round(wa * a.score + (1 - wa) * b.score));
  const worst = (a, b) => (['low', 'medium', 'high'].find((c) => c === a.confidence || c === b.confidence) || null);
  g.ol = { label: 'OL composite', score: comp(g.olRun, g.olPass, 0.55), confidence: worst(g.olRun, g.olPass) };
  g.dl = { label: 'DL composite', score: comp(g.dlRun, g.dlPass, 0.5), confidence: worst(g.dlRun, g.dlPass) };
  g.ol.letter = letter(g.ol.score); g.dl.letter = letter(g.dl.score);
  return g;
}

// ---------- League baseline (NFL: measured) ----------
const mem = new Map();
export async function leagueBaseline(lg, season, cutoffISO, currentWeek, prov, { gameIds = null } = {}) {
  if (lg !== 'nfl') return { ...CFB_PRIOR_BASELINE, source: 'Configured college priors (not a measured FBS-wide baseline)', measured: false, teams: null, games: null };
  // Keyed by the exact cutoff: a baseline must never include games that finished after kickoff.
  const key = `${lg}|${season}|${new Date(cutoffISO).toISOString()}|${gameIds ? 'blind' : 'live'}`;
  if (mem.has(key)) return mem.get(key);
  let ids = [];
  if (gameIds) ids = [...gameIds]; // blind: sanitized prior ids from the scheduler (already finished before kickoff)
  else {
    for (let w = 1; w <= Math.max(1, currentWeek || 18); w++) {
      const r = await fetchCached(espn.url.scoreboard(lg, { week: w, seasontype: 2, season }), { ttl: 3600, label: `League scoreboard wk ${w}` });
      const games = espn.parseScoreboard(r.data).games.filter((g) => g.status.completed && finishedBefore(g.date, cutoffISO));
      if (!games.length && w > 1) break;
      ids.push(...games.map((g) => g.id));
    }
  }
  const off = new Map();
  let unverified = 0;
  await Promise.all(ids.map(async (id) => {
    const s = await espn.getSummary(lg, id, { final: true });
    if (!s.data) return;
    if (gameIds) { // blind: admit only games whose own play wallclock shows they ended before kickoff
      const e = gameEndTime(s.data);
      if (!e || Date.parse(e.end) > Date.parse(cutoffISO)) { unverified++; return; }
    }
    const plays = espn.extractPlays(s.data);
    const t = espn.summaryTeams(s.data);
    for (const tid of [t.home.id, t.away.id]) off.set(tid, lineAgg(plays, tid, 'off', off.get(tid) || emptyLine()));
  }));
  const b = baselineFromTeams([...off.values()]);
  const out = { ...b, excludedUnverified: unverified, source: `Measured from ${ids.length - unverified} completed ${LEAGUES[lg].label} games this season before kickoff (${b.teams} teams)`, measured: true, games: ids.length };
  if (ids.length) prov?.add({ url: `derived:league-line-baseline:${key}`, source: 'ESPN public API (derived)', label: 'League OL/DL baseline', fetchedAt: new Date().toISOString(), fromCache: true, stale: false, error: null });
  if (!ids.length || Object.values(b.sd).some((x) => x == null)) {
    // Too early in the season to measure spread: fall back to priors for SD, labelled.
    out.sd = { ...CFB_PRIOR_BASELINE.sd, ...Object.fromEntries(Object.entries(b.sd).filter(([, v]) => v != null)) };
    out.source += ' — team-level SD partly from priors (insufficient games)';
  }
  mem.set(key, out);
  return out;
}

export const METHOD = [
  'Unit proxies from ESPN play-by-play: designed runs (QB scrambles excluded), dropbacks and sacks.',
  'OL run blocking = 40% designed-run success (gain ≥40%/60%/100% of distance on 1st/2nd/3rd–4th down) + 30% stuff rate avoided (runs for ≤0 yds) + 20% yards per designed run + 10% 10+ yd run rate.',
  'OL pass protection = sack rate avoided. Pressure data is not available free; sack rate is strongly influenced by the QB (hold time, scrambling) and play-calling.',
  'DL run defense uses the same run metrics allowed by the defense; DL pass rush = sack rate generated.',
  'Each rate is shrunk toward the baseline (80 runs / 150 dropbacks of prior weight) before scoring: 50 = baseline unit, ±15 points per team-level SD, clipped 0–100. Letters: A ≥75, B ≥62, C ≥45, D ≥32, F below.',
  'Not schedule-adjusted beyond shrinkage: rates reflect the opponents faced so far. These are team-unit estimates, not grades of individual linemen.',
];
