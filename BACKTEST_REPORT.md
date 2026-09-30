# BACKTEST_REPORT: market-blind historical evaluation (canonical: batch #3)

**Canonical run:** batch #3, 2026-09-30 19:40 UTC · **Model:** `fbm-1.1.0` in `market-blind` mode, **cutoff filter `cutoff-v2-wallclock-verified`** · **Frozen before predicting:** params hash `301f332387ef…`, code hash `8885bfef9d25…`

Raw output is in `data/blind_report_3.json`, and the Ledger page has a **Blind historical evaluation** section with a batch selector. To re-run: `npm run blind` or the Ledger button. Each run creates a new immutable batch.

| Batch | Cutoff filter | Status |
|---|---|---|
| #1 | v1 | 3-game pipeline smoke test (kept) |
| #2 | `cutoff-v1-kickoff+4.5h` | Preserved. It *assumed* a prior game had ended 4.5h after kickoff; that is not proof (overtime, weather delays), so batch #2 is **not** described as strictly cutoff-safe. |
| #3 | `cutoff-v2-wallclock-verified` | Same coefficients, re-run once after the audit fix. No model tuning between batches. |

## Cutoff fix (v2): completion verified, not assumed

- **Candidate rule:** kickoff + 2.5h ≤ target kickoff. This is a physical minimum used only to discard impossible candidates. Today's "completed" flag is necessary but not sufficient.
- **Proof of completion:** each candidate's **own summary** (a prior game, never the target) must show an end time at or before the target kickoff. The end time is the "End of Game" play wallclock, or the latest play wallclock if that play is missing.
- **Exclusions:** a game with no wallclock, or ending after kickoff, is excluded with a logged reason in the manifest. A team left with no verified prior game is skipped.
- **League OL/DL baseline:** its games get the same check.
- **Tests:**
  - A game kicking off 5h before the target but delayed so that it ends after kickoff is excluded.
  - A game verified finished before kickoff is included.
  - A game with no wallclock is excluded.
  - Excluded games leave projections byte-identical to a world where they don't exist.
  - The target is never requested. (`test/blind.test.js`, 8 tests.)

**What the fix changed (measured, batch #3):**
- **Team prior games:** all 856 used for predictions had a verified end time before their target kickoff; 849 came from the End of Game wallclock and 7 from the latest play. None were excluded, and the tightest margin was 99.5 hours.
- **League baseline:** 28 candidate games (summed over all predictions) were excluded as unverified or ended after kickoff. The baseline only drives the OL/DL grades.
- **Result:** all **9,633 projections are identical** to batch #2 (0 changed), so every metric below is the same for both batches. The difference is that batch #3's cutoff safety is now *verified*, not assumed.

## Protocol

1. **Freeze.** Record the model version, a hash of every model parameter, and a hash of the model source code as a `parameters_frozen` event.
2. **Schedule.** Enumerate every regular-season game from ESPN weekly scoreboards. Each game is immediately reduced to a sanitized identity (id, week, kickoff, home/away id and abbreviation). Scores and odds are dropped before the predictor sees anything.
3. **Predict.** Each game is predicted using only prior games **verified by their own final-play wallclock** as finished before its kickoff. This also excludes overlapping or delayed same-day games.
   - **Not used:** the target game's summary, box score, plays or participants; the spread, total, moneyline or props; current rosters; depth charts; injuries; weather; snap counts; news.
   - **Positions:** taken only from nflverse weekly rows *before* the target week (NFL) or inferred from pre-kickoff box-score usage (college).
   - **League OL/DL baseline:** built from prior games only.
   - **Output:** each game writes immutable predictions plus an input manifest (every URL and fetch time, prior game ids, a SHA-256 hash).
   - **Self-check:** any request touching the target game or a forbidden source aborts that game.
4. **Seal.** A `predictions_frozen` event is written. SQLite triggers then reject any new prediction for the batch, and reject any score or line insert that comes *before* the seal.
5. **Score.** Only after the seal: target box scores provide actuals, and ESPN-retained DraftKings prop lines are fetched.
6. **Report.** Accuracy by week × position × stat, with untouched and previously inspected weeks kept separate.

**Tests.** `test/blind.test.js`, 8 tests, all pass (77 in the whole suite).
- **Poison test:** absurd target results, absurd lines, poisoned rosters and scoreboards, a future game and an overlapping game give **byte-identical** projections, and none of those URLs is requested.
- **Future-game test:** changing a future game changes nothing.
- **Other checks:** week-1 teams are skipped with a reason; the isolation self-check fires; sealed batches reject writes.

**Fidelity caveat.** This is a *reconstruction*. Prior-game data was retrieved today, not taken from archived as-of snapshots. Stat corrections made after a game would already be baked in. There was no archived pregame information (injuries, depth charts, news), so the blind model runs without it.

**Code-hash disclosure.**
- **Batch #2** was frozen at code hash `084ae65fbbea…`. After it ran I changed only report/display code (the impossible-timestamp classification and outlier metadata) and then the cutoff filter.
- **Batch #3** was frozen *after* those changes, at code hash `8885bfef9d25…` / params hash `301f332387ef…`, which includes `cutoffFilter: cutoff-v2-wallclock-verified`. It was run once.
- No projection coefficient changed between batches; that is confirmed by the 0 changed projections.
- The only change after batch #3 ran is report wording (this file and the Ledger labels).

## Coverage (denominators)

| | NFL | College (FBS) | Total |
|---|---|---|---|
| Completed games | 48 | 331 | 379 |
| Predicted | 32 | 187 | 219 |
| Skipped (logged, reason given) | 16 (all of week 1) | 144 | 160 |

All 160 skips share one reason: a team had **no current-season game finished before kickoff**, so there was no role history. On the college side this covers week-1 games and games against FCS opponents, whose other games are not in ESPN's FBS schedule feed. No game failed with an error or an isolation violation.

Predictions: **9,633** · scored **8,689** · **no recorded stats 870** · **unknown 74** (e.g. targets not published and not derivable) · unscored 0.

"No recorded stats" means the player is absent from the final box score. Participation is **unverified**: he may have been inactive, or active with zero stats. It is not a proven DNP. These rows are excluded from the error metrics.

## Stat accuracy

**Untouched vs previously inspected weeks** (all stats pooled; MAE mixes units, so compare within a stat below):

| Set | Weeks | Scored | No recorded stats | MAE | RMSE | Bias | 10–90 coverage |
|---|---|---|---|---|---|---|---|
| **College, untouched** | 1–3 | 3,705 | 380 | 15.93 | 32.34 | +3.21 | **79.7%** |
| College, inspected earlier (not independent) | 4 | 1,970 | 249 | 15.78 | 32.78 | +1.60 | 79.8% |
| NFL, inspected/tuned (not independent) | 2–3 | 3,014 | 241 | 6.73 | 16.29 | +0.48 | 84.2% |

The only untouched data is college weeks 1–3; every NFL game that could be predicted falls in a tuned week. So **there is no independent NFL validation yet**. The NFL week-4 pregame snapshots, scored after this weekend, will be the first.

**Key stats** (bias = projection − actual):

| Stat | n | MAE | Bias | Coverage | Untouched only |
|---|---|---|---|---|---|
| CFB QB pass yds | 351 | 74.7 | **+31.7** | 72% | n=230, bias +33.6, cov 73% |
| CFB QB rush yds | 351 | 23.3 | +3.9 | **62%** | cov 62% |
| CFB RB rush yds | 694 | 28.7 | **−6.7** | 71% | bias −4.6, cov 71% |
| CFB RB carries | 694 | 4.2 | −1.3 | 73% | |
| CFB WR rec yds | 623 | 35.6 | +9.2 | 75% | bias +10.7, cov 74% |
| CFB WR targets (play-by-play derived) | 600 | 3.2 | +1.4 | 74% | |
| NFL QB pass yds (in-sample) | 58 | 59.4 | +9.5 | 79% | — |
| NFL RB rush yds (in-sample) | 119 | 22.7 | −0.9 | 72% | — |
| NFL WR rec yds (in-sample) | 126 | 29.4 | +2.2 | 82% | — |
| NFL TE rec yds (in-sample) | 38 | 23.3 | +6.1 | 76% | — |
| NFL K points (in-sample) | 64 | 3.0 | −0.1 | 89% | — |

College coverage by week: wk1 88% (n=58) · wk2 79.7% · wk3 79.4% · wk4 79.8%.

**Honest reading:**
- The ranges are roughly right in aggregate: 81% overall coverage against 80% nominal.
- College QB passing is **over-projected by about 30 yards** and QB rushing ranges are too narrow.
- College RB rushing is under-projected.
- Per the rules of this run, these are reported, not tuned away.

## Over/under vs historical lines (unverified reconstruction, excluded from strict market accuracy)

| Tier | Record (W–L–P) | Win rate |
|---|---|---|
| **Strict archived pregame lines** | **n = 0** | none available free |
| ESPN-retained "current" line | 454–569–0 (20 with no side) | 44.4% |
| …of which the feed timestamp precedes kickoff | 188–247–0 | 43.2% |
| ESPN-retained opening line | 474–549–0 | 46.3% |

**Line coverage:** 1,057 of 9,633 predictions (11%) had a retained line, all NFL. The college prop feed returned "none posted" for all 187 predicted games.

**Why these lines are unverified:**
- Lines were retrieved *after* the games.
- 603 of 1,057 "current" lines carry a `lastUpdated` after kickoff, so they may include in-game movement.
- ESPN's `lastUpdated` has been observed later than our own retrieval time. Impossible timestamps (update later than retrieval) would be excluded from the pre-kickoff subset; none occurred in this batch.
- **No ROI is computed:** no archived prices exist.

**Reading:** in the blind mode the model's side lost to these lines, at 44–46% on n ≈ 1,000.
- The model leaned **OVER** on 649 of 1,037 comparisons; receiving yards were OVER on 179 of 248, winning 42%. This matches the positive receiving bias above.
- **Interceptions artifact:** the pre-declared side rule compares the projected *mean* to the line. For a skewed count like interceptions, a mean of about 0.7 against a 0.5 line always reads OVER (58 of 58), even though the median outcome is 0. I left the rule as declared rather than change it after seeing results.
- None of this shows the books are wrong or right in general. It says this market-blind model has not beaten these reconstructed lines.

## What would make this stronger

1. Score the frozen **pregame** NFL week-4 snapshots (true forecasts, untouched) after the games.
2. Archive prop lines *before* kickoff going forward. The pregame snapshots already store book line and timestamp at capture time; a strict market tier can be built from those alone.
3. Any fix for the college QB-passing bias must be a new model version evaluated on weeks it wasn't tuned on.
