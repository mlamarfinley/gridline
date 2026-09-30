// League baselines. NFL: measured from nflverse weekly player stats for the most recent full
// regular season (downloaded, cached 30 days). College: configured priors only (no free
// league-wide per-play feed without an API key) — disclosed in the UI as such.
import { fetchCached } from './fetcher.js';
import { PRIORS } from './config.js';

const NFLVERSE = (season) => `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const v = splitCsvLine(l);
    const o = {};
    header.forEach((h, i) => { o[h] = v[i]; });
    return o;
  });
}
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Aggregate nflverse weekly rows into league rates. Pure; tested. */
export function measureNfl(rows) {
  const f = (r, k) => Number(r[k] || 0);
  const agg = {};
  for (const r of rows) {
    if (r.season_type !== 'REG') continue;
    const a = (agg[r.position] ||= {});
    for (const k of ['carries', 'rushing_yards', 'rushing_10', 'rushing_20', 'receptions', 'targets', 'receiving_yards', 'receiving_20', 'receiving_40', 'rushing_tds', 'receiving_tds', 'attempts', 'passing_interceptions', 'sacks_suffered', 'completions', 'rushing_fumbles_lost', 'receiving_fumbles_lost']) a[k] = (a[k] || 0) + f(r, k);
  }
  const d = (a, b) => (b > 0 ? a / b : null);
  const Q = agg.QB || {}, R = agg.RB || {}, W = agg.WR || {}, T = agg.TE || {};
  const pos = { RB: R, WR: W, TE: T };
  const m = {
    ypc: { QB: d(Q.rushing_yards, Q.carries), RB: d(R.rushing_yards, R.carries) },
    catchRate: {}, yardsPerCatch: {}, catch20: {}, catch40: {}, recTdPerCatch: {},
    run10: d(R.rushing_10, R.carries), run20: d(R.rushing_20, R.carries),
    qbRun10: d(Q.rushing_10, Q.carries), qbRun20: d(Q.rushing_20, Q.carries),
    rushTdPerCarry: { QB: d(Q.rushing_tds, Q.carries), RB: d(R.rushing_tds, R.carries) },
    intRate: d(Q.passing_interceptions, Q.attempts),
    sackRate: d(Q.sacks_suffered, (Q.attempts || 0) + (Q.sacks_suffered || 0)),
    fumbleLostPerTouch: d((R.rushing_fumbles_lost || 0) + (R.receiving_fumbles_lost || 0) + (W.receiving_fumbles_lost || 0), (R.carries || 0) + (R.receptions || 0) + (W.receptions || 0)),
  };
  for (const [p, a] of Object.entries(pos)) {
    m.catchRate[p] = d(a.receptions, a.targets);
    m.yardsPerCatch[p] = d(a.receiving_yards, a.receptions);
    m.catch20[p] = d(a.receiving_20, a.receptions);
    m.catch40[p] = d(a.receiving_40, a.receptions);
    m.recTdPerCatch[p] = d(a.receiving_tds, a.receptions);
  }
  return m;
}

// Merge measured values over priors, rejecting anything implausible or missing.
function mergeInto(base, measured, path = []) {
  for (const [k, v] of Object.entries(measured)) {
    if (v && typeof v === 'object') { base[k] = { ...(base[k] || {}) }; mergeInto(base[k], v, [...path, k]); }
    else if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 20) base[k] = v;
  }
  return base;
}

let cache = { nfl: null, cfb: null };
export async function getBaselines(lg, season, prov) {
  if (cache[lg] && cache[lg].season === season) return cache[lg].value;
  const base = JSON.parse(JSON.stringify(PRIORS[lg]));
  let value = { priors: base, source: 'Configured model priors (src/config.js) — not measured this season', measured: false };
  if (lg === 'nfl') {
    const prev = season - 1;
    const r = await fetchCached(NFLVERSE(prev), { ttl: 30 * 86400, as: 'text', label: `nflverse ${prev} weekly player stats (league baselines)` });
    prov?.add(r.meta);
    if (r.data) {
      try {
        const measured = measureNfl(parseCsv(r.data));
        value = { priors: mergeInto(base, measured), source: `Measured from nflverse ${prev} regular-season weekly player stats`, measured: true };
      } catch (e) { value.error = String(e.message || e); }
    }
  }
  cache[lg] = { season, value };
  return value;
}
