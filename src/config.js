// Runtime configuration + model constants.
// Every constant in PRIORS is a *model prior* (a shrinkage target), not a measured fact about
// the current season. NFL priors are replaced at runtime by values measured from nflverse
// 2025 weekly data when that download succeeds (see src/baselines.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined && m[2] !== '') process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

export const PORT = Number(process.env.PORT || 5317);
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const DB_PATH = process.env.LEDGER_DB || path.join(DATA_DIR, 'ledger.sqlite');
export const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
export const CFBD_API_KEY = process.env.CFBD_API_KEY || '';

// Bump whenever projection logic changes. Snapshots are keyed by this so evaluation never
// silently mixes model generations.
// History: 1.0.0 initial; 1.1.0 wider workload variance, share floors, rushing-TD play fix;
// 1.2.0 NFL: prior-season team/QB/share priors + fitted shrinkage (src/fitted_v12.json).
// 1.3.0 NFL: output calibration learned walk-forward from every 2024+2025 pick (src/fitted_v13.json).
// 1.4.0 NFL: v1.4 correction learned from every miss (src/fitted_v14.json); partial-game exclusion.
// 1.4.1 NFL: questionable players (own usage, expected share to teammates, questionable-QB receiving yards) and
//            the run/pass mix shift when a lead RB / WR1 is missing — rates measured from 2022–25 nflverse data.
// 1.4.2 NFL: play-by-play name fix ("A.St. Brown"), game-state shares averaged with the simulator's real weights,
//            receiver matchup multipliers damped (oppRecExp); v1.3/v1.4/big-miss re-learned on blind batch 9.
// 1.4.3 NFL: learned season-average anchor (src/fitted_anchor.json, walk-forward both directions); a single RB
//            absorbs at most 55% of an absent lead back's share (measured 2022–25).
// 1.4.4 NFL: lead backs (RB1) get +0.78 carries on top of the pooled RB calibration — the pooled shift is learned
//            on RB1s and RB2s together and left RB1s ~0.8 carries short (walk-forward: 2026 MAE 4.48 → 4.36).
export const MODEL_VERSION = 'fbm-1.8.0';
// 1.7.0 NFL: Player Rating (Madden + Production Monitor) corrects RB carries / rushing yards (2024 held-out MAE
//            −1.3% / −2.5%); Production Monitor and Player Rating on every card.
// 1.6.0 NFL: run defense judged against the quality of backs it faced (each back vs his own normal YPC);
//            player skill ratings (src/playerRatings.js) on every card and a Ratings page.
// 1.5.6 NFL: opponent run-defense multiplier exponent 0.8 → 0.5 (raw batch 14 vs 13: RB rush yds MAE 23.91 → 23.85);
//            all layers re-learned on batch 14; player prop lines fetched only after projections are final.
// 1.5.5 NFL: team unit ratings use this season only from week 3 (user choice); player profiles keep last season.
// 1.5.4 NFL: matchup-engine unit ratings weight last season's plays 0.15 (was 0.25; scripts/def_prior_weight.mjs);
//            big-miss pick model refit on the new ratings.
// 1.5.3 NFL: OL/DL grades re-standardized across all teams (were compressed into ~40–60); team-runs history model
//            (all inputs weighed by OLS) shown beside the simulation; pass-rate rows show samples and fallbacks.
// 1.5.2 NFL: the game pick requires the gap from the line to clear the stat's significance bar (user rule; its
//            backtest is 77–85, 47.5% — shown on the page). Team run volume regression re-tested and kept.
// 1.5.1 NFL: every post-simulation layer re-learned on a RAW blind batch (13); blind runs now record raw simulation
//            only. Removes the RB1 carry shift (v1.4 handles role). Role-growth prior rule tested and rejected.
// 1.5.0 NFL: situational multiplier model (src/situational.js, learned 2022–25): baseline × learned multipliers for
//            spread / blowout / team total / opponent allowance / home / weather. Shown on every card; blended in for
//            QB completions, RB targets/receptions, TE receptions, WR targets (beat the model on 2025 wk 10–18).

// Weeks inspected while tuning each model version. Results on these weeks are IN-SAMPLE
// (development) and must never be presented as independent validation.
export const DEV_WEEKS = {
  'fbm-1.0.0': { nfl: [3] },
  'fbm-1.1.0': { nfl: [2, 3] },
  // v1.2 constants were fitted on 2024->2025 history, but weeks 2-3 of 2026 were inspected in the
  // diagnosis that motivated its design, so they stay in-sample.
  'fbm-1.2.0': { nfl: [2, 3], cfb: [4] },
  'fbm-1.3.0': { nfl: [2, 3], cfb: [4] },
  // v1.4 corrections were learned from every scored 2024+2025 pick; 2026 weeks 2-3 were inspected earlier.
  'fbm-1.4.0': { nfl: [2, 3], cfb: [4] },
  'fbm-1.4.1': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.4.2': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.4.3': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.4.4': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.0': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.1': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.2': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.3': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.4': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.5': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.5.6': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.6.0': { nfl: [2, 3, 4], cfb: [4] },
  'fbm-1.7.0': { nfl: [2, 3, 4], cfb: [4] },
};

export const LEAGUES = {
  nfl: { key: 'nfl', espn: 'nfl', label: 'NFL', groups: null },
  cfb: { key: 'cfb', espn: 'college-football', label: 'College (FBS)', groups: '80' },
};

export const SIMS = 3000;

export const PRIORS = {
  nfl: {
    playsPerGame: 62,          // offensive rushes + dropbacks per team-game
    passRate: { blowTrail: 0.70, trail: 0.64, close: 0.57, lead: 0.47, blowLead: 0.40 },
    sackRate: 0.068,           // sacks per dropback
    ypc: { QB: 4.4, RB: 4.35, WR: 5.4, TE: 2.5 },
    catchRate: { RB: 0.78, WR: 0.62, TE: 0.72 },
    yardsPerCatch: { RB: 7.4, WR: 12.7, TE: 10.1 },
    intRate: 0.022,            // per attempt
    run10: 0.10, run20: 0.022, // share of RB carries gaining 10+/20+
    qbRun10: 0.15, qbRun20: 0.026,
    catch20: { RB: 0.06, WR: 0.18, TE: 0.11 },   // share of RECEPTIONS gaining 20+
    catch40: { RB: 0.012, WR: 0.03, TE: 0.007 },
    rushTdPerCarry: { QB: 0.048, RB: 0.032 }, recTdPerCatch: { RB: 0.044, WR: 0.079, TE: 0.080 },
    fumbleLostPerTouch: 0.004,
    fgMadePerGame: 1.6, xpPerTd: 0.955,
    pointsPerTeamGame: 22.5,
    marginSd: 13.5,            // sd of final margin around the spread
    stateSdFactor: 0.72,       // average in-game margin is narrower than the final margin
    blowoutMargin: 17,
    starterShareInBlowout: { lead: 0.85, trail: 0.95 },
  },
  cfb: {
    playsPerGame: 70,
    passRate: { blowTrail: 0.66, trail: 0.60, close: 0.50, lead: 0.40, blowLead: 0.34 },
    sackRate: 0.065,
    ypc: { QB: 5.0, RB: 5.0, WR: 7.0, TE: 4.5 },
    catchRate: { RB: 0.74, WR: 0.62, TE: 0.68 },
    yardsPerCatch: { RB: 8.5, WR: 13.5, TE: 11.5 },
    intRate: 0.024,
    run10: 0.14, run20: 0.05,
    qbRun10: 0.18, qbRun20: 0.05,
    catch20: { RB: 0.07, WR: 0.22, TE: 0.15 },
    catch40: { RB: 0.015, WR: 0.06, TE: 0.03 },
    rushTdPerCarry: { QB: 0.05, RB: 0.04 }, recTdPerCatch: { RB: 0.06, WR: 0.09, TE: 0.09 },
    fumbleLostPerTouch: 0.006,
    fgMadePerGame: 1.3, xpPerTd: 0.97,
    pointsPerTeamGame: 28,
    marginSd: 16.5,
    stateSdFactor: 0.75,
    blowoutMargin: 21,
    // College starters come out of lopsided games; the trailing side keeps them a bit longer.
    starterShareInBlowout: { lead: 0.55, trail: 0.8 },
  },
};

// Shrinkage strengths (pseudo-observations of the prior).
export const SHRINK = {
  ypc: 60,           // carries
  catchRate: 30,     // targets
  ypcatch: 25,       // catches
  explosiveRun: 80,  // carries
  explosiveCatch: 40,
  share: 3,          // games
  teamRate: 3,       // games
  defense: 3,        // games (opponent context)
  tdRate: 80,
  scenarioShare: 18, // team plays in a game-state bucket
  // Exponent on the opponent's receiving-efficiency multipliers (catch rate, yds/catch). 2022–25 data: only ~15% of a
  // defense's yds/target deviation shows up in the next receiver's (scripts/matchup_volume_test.mjs).
  oppRecExp: 0.4,
  // Exponent on the opponent's RB yards-per-carry multiplier. 2022–25: ~21% of an early-season run defense's raw YPC
  // edge carries over (scripts/…/ypc_pass); 0.8 applied ~31%. 0.5 applies ~20%.
  oppRunExp: 0.5,
};
