# fbm-1.4.0 — learned from every miss

**What changed:** for each position and stat, the model now learns how its own misses relate to what it knew before kickoff, and corrects for that. The learning set was every scored NFL pick from the blind 2024–2026 backtest (batch 6, about 52,000 scored picks).

## How it learns

- **Inputs it can use:** only information frozen before kickoff:
  - expected targets, carries and pass attempts, plus usage shares
  - per-touch efficiency
  - team plays and pass attempts
  - expected margin and team points
  - QB yards per attempt
  - role, plus the small-sample and role-change flags
  - **new:** recent-usage trend. This is last-game and last-3 targets, carries, opportunities and snap share, each compared with the season average, using only weeks before the game.
- **Book lines are never an input.**
- **Robust to one-off games:** it uses a Huber-loss ridge regression. An injury exit or a single 80-yard catch can only pull the fit a little.
- **Guardrail:** each correction must beat v1.3 on the latest third of the *training* weeks. If it doesn't, that stat keeps v1.3. Receiving yards, receptions and targets for WR/TE stayed on v1.3 this way.
- **Walk-forward:** it never sees the season it's graded on.

## Results (out of sample)

Average absolute miss on rows that had a book line, in yards/units:

| Learned on → tested on | v1.3 | **v1.4** | Book line | v1.4 closer than line |
|---|---|---|---|---|
| 2024 → 2025 | 11.40 | **11.35** | 10.79 | 47.3% (v1.3: 46.5%) |
| 2024 → 2026 | 11.04 | **10.98** | 10.30 | 46.6% (v1.3: 44.9%) |
| 2024–25 → 2026 (shipped) | 11.02 | **10.99** | 10.30 | 46.0% (v1.3: 45.3%) |

- **Across all picks:** v1.4 improved 2 of 3 tests (7.419 → 7.388 and 7.409 → 7.380). The third was flat (7.678 → 7.681).
- **Biggest gains:** QB passing yards (−0.8 yd in the 2024 → 2025 test) and QB completions. These come from the game-script inputs: expected margin and team points.
- **Small gains:** RB carries and receptions.
- **One regression:** the 2024-only fit made WR receiving yards slightly worse on 2025 (27.21 → 27.73). With 2024–25 data the guardrail kept WR yards on v1.3.

## What the misses taught it

- **About half of every yardage miss is volume:** how many targets or carries the player actually got. The other half is per-touch efficiency.
  - Receiving yards: 49% volume.
  - Rushing yards: 52% volume.
- **One-game target spikes mostly fade.** For RBs, the learned weight on "last-game targets vs season" is negative. The old projection chased those spikes a bit.
- **QB passing projections were too sure of themselves.** Wide ranges and favored teams (big expected lead) were over-projected, because leading teams run the clock.

## Where it stands, honestly

- The books are still more accurate. About 0.7 yd/unit separates v1.4 from the line.
- Pick win rate against lines is about 50%. That's below the ~54.5% break-even, so there is **no betting edge**, and none is claimed.
- The remaining gap is information the model doesn't have yet: injury and practice reports, depth-chart news, and late-week role announcements. Those explain the volume misses.

## Files

- **Learner:** `scripts/learn_v14.mjs`. Rerun with `node --no-warnings scripts/learn_v14.mjs 6 --write`.
- **Shared feature code:** `src/v14.js`. The learner and the live model build identical inputs from it. Live usage trends are built from the model's own pre-kickoff box scores; a spot check of 22 live players matched the nflverse training values exactly.
- **Fitted corrections:** `src/fitted_v14.json`.
- **Config:** `MODEL_VERSION` is `fbm-1.4.0`. 2026 weeks 2–3 stay labelled in-sample.
- **Cards:** every projection card now shows which calibration it used and the size of the v1.4 correction.

## Outlier pick: role-aware OVERs (added after review)

**Prompted by:** "Aaron Rodgers OVER 1.5 rushing yards", a pick that mostly depends on whether a pocket QB runs at all.

**What the 2024–26 backtest showed** (outlier-strength OVERs):
- Minor-role OVERs finished at 0 or less **36%** of the time, versus 3% for core-role OVERs.
- They didn't actually lose more often: 54.1% of 98 picks, a near coin flip. So they're high-variance, not proven losers.
- That's not the model's most credible kind of disagreement, so the rule now leans against them.

**Rule** (src/outlier.js, `roleMin`, `minorRolePenalty`):
- An OVER needs the stat to be part of the player's job: at least 4 expected carries for rushing, 3 targets for receiving, 15 attempts for passing.
- **Under half of that minimum** (e.g. a WR's rushing yards): ineligible for an OVER.
- **Minor role:** score × 0.6.
- **Real zero-game chance** (10th percentile = 0, non-TD stats): score × 0.6. This stacks with the minor-role penalty.
- **UNDERs are unchanged:** minor-role UNDERs won 55.8% of 274.

**Bug fixed in the same release:** when an RB was out, his carries were spread over RBs *and QBs*. In week 4 that gave Geno Smith +25% carry share (39.7 projected rushing yards; 15.3 after the fix). An absent RB's carries now go to the other RBs only. Blind backtests don't redistribute for absences, so the backtest and v1.4 learning are unaffected.

## fbm-1.4.1 — injuries, questionable players, run/pass mix (2026-10-01)

Measured from nflverse 2022–25, then built in:

| Situation | Measured | What the model now does |
|---|---|---|
| Player listed questionable | Played: QB 43%, RB 68%, WR 72%, TE 75%. Usage when active: 107% / 93% / 92% / 89% | His own projection assumes he plays (props are void otherwise), at that usage. Teammates absorb the expected vacated share (1 − P(play) × usage). |
| Starting QB questionable | Backup QB games: team pass yds ×0.911, attempts ≈ same, carries ×0.985 | Teammates' receiving yards ×(0.43 + 0.57 × 0.911) ≈ 0.949. |
| Lead RB out | −1.6 team rushes, +1.3 attempts, +1.3 pts pass rate over expected (z≈1.4–2.0) | Team pass rate +1.3 pts (× chance he's missing). The backup's own YPC already carries his lower efficiency. |
| WR1 out | −2.7 pts pass rate over expected (z 2.9), YPA −0.43 | Team pass rate −2.7 pts (× chance he's missing). |
| TE1 out | Not significant | Ignored. |

`scripts/absence_effects.mjs` reproduces the absence table.

**Tested and not shipped:**
- **Context-aware run/pass engine.** `src/volume.js` builds situation-adjusted pass rate over expected, opponent-adjusted defensive pass rate, and a clock/plays model where run-heavy teams hold the ball longer. Its team-volume misses were no smaller than the current estimator's: rushes 5.66 → 5.72 and 5.50 → 5.49, attempts about equal. The plays coefficients flipped between folds.
- **Carries bias by role × game-script bucket for backups on big favorites.** Walk-forward miss improved only 4.074 → 4.064, so it wasn't shipped. The game-script model already captures favorites running more; favorites' rush bias was about 0.

## fbm-1.4.2: two real bugs, a matchup test, and recalibration (2026-10-01)

Every change below was validated on market-blind batches over every 2024–26 NFL game.

| Batch | Change | Result vs previous | Shipped |
|---|---|---|---|
| 7 | Play-by-play name fix: "A.St. Brown" was parsed as "A.St", so he had zero play-by-play targets. Game-state shares are now averaged with the simulator's real weights (the first 40% of every game is "close"). | Better on 10 of 11 stats vs batch 6. QB passing-yards miss 61.4 → 58.5; model-vs-line information β 0.15 → 0.30 (t = 11.9). | yes |
| 8 | When team shares sum above 100%, take the excess from part-timers first | Tie, within noise | no |
| 9 | Receiver matchup multipliers damped (exponent 0.4) | Receiving misses better: WR yds 27.44 → 27.39, TE yds 21.44 → 21.30; QB completions slightly worse | yes |
| 10 | Heavier recency weighting for rising roles (share up 3 straight games) | Worse on the affected players: WR targets 2.44 → 2.69, RB rush yds 24.2 → 24.7. Rising roles fall back partway. | no |

**Matchup and volume** (`scripts/matchup_volume_test.mjs`, 7,603 receiver-games, 2022–25):
- Defenses that allow more to a position, or to a receiver's usual zones, do not give him more targets. Slope ≈ 0, walk-forward change 0.00%.
- They do give more yards per target: about 0.15 yd/target per 1 yd/target the defense allows.
- RB YPC carries over 20–43% of a run defense's deviation.

**Recalibration on batch 9:**
- v1.3 calibration: 2026 out-of-sample miss 6.30 → 6.25.
- v1.4: only QB completions keeps a learned correction. The old corrections were largely compensating for the bugs above.
- Outlier gap tiers now win 53.6–53.8% at 1–2× significance and 54–55% for UNDERs (they were ~51%).
- The backtested pick rule went **147–123 (54.4%)**. It was 143–108 (57%) on the old model, so its edge is thinner after the fixes.

**Guards added:**
- No calibration shift and no v1.4 correction for a player with no simulated opportunity. Backup QBs had been getting 0.3 completions.

## fbm-1.4.3: re-examining the running-back logic (2026-10-01)

The question: are lead backs under-projected, especially on favorites? Every test below is out of sample (blind batch 9).

| Idea | Evidence | Shipped |
|---|---|---|
| Push favorites' team run/pass mix toward the run (team carries were 2.1 short for 3–7 pt favorites) | Correcting it made accuracy worse: RB carries miss 3.77 → 3.81, QB pass yds 58.5 → 60.1. Carry outcomes are right-skewed, so the typical game sits below the average. | no |
| Blend carries toward the back's own season average | Backs averaging 20+ carries got 18.5 next game; the model said 18.1. A 40% blend: 5.45 → 5.73 (worse). Heavy workloads regress. | no |
| Blend yards / receiving toward the player's own season average (`scripts/learn_anchor.mjs`) | Helped in both directions (2024→2025 and 2025→2024). Weights: RB rush yds 0.3, RB rec yds 0.2, WR targets / receptions / rec yds 0.3, TE targets 0.4, QB rush yds 0.5. | yes |
| One back absorbing all of an absent lead back's share | The RB2 absorbed 48% on average (median 55%) of the lead's share, 2022–25 (`scripts/rb2_absorb.mjs`). Capped at 55%. | yes |
| Require the game pick to have a big gap | On the new rerun, big-gap picks won 51.6% vs 56–58% for small/lean gaps | no; renamed to "Game pick" (not an outlier) |

**Explanations:**
- Every pick now cites what the last 5 players in the same slot (RB1, WR1, …) did against this defense, compared with the line.
- The backup-carries-in-blowouts note appears only when the blowout-lead chance is ≥ 12%.

## fbm-1.4.4: lead-back carries (2026-10-01)

Lead backs' projected carries fell from 15.2 to 13.7 (week 4 average) between fbm-1.4.1 and 1.4.3. The blowout logic was not the cause. Two calibration changes were:
- the old v1.4 corrections (+1 to +2 carries) did not survive re-learning on the fixed model;
- the pooled RB calibration shift moved from +0.59 to −0.29.

**Blowout check** (`scripts/blowout_share.mjs`, 2022–25): a lead back's share of designed runs vs his share in close play of the same games.

| Team's situation | Share ratio |
|---|---|
| Leading by 17+ | 0.63 |
| Leading by 8–16 | 0.95 |
| Trailing by 8–16 | 0.96 |
| Trailing by 17+ | 0.75 |

The model's 0.85 blowout cut is milder than reality, so it was kept.

**Fix:** the pooled shift is learned on RB1s and RB2s together and leaves RB1s about 0.8 carries short. An RB1-only +0.78 was tested walk-forward:

| Learned on → tested on | Miss (MAE) |
|---|---|
| 2024 → 2025–26 | 4.264 → 4.249 |
| 2025 → 2024 | 4.633 → 4.641 |
| 2024–25 → 2026 | 4.48 → 4.36 |

The same shift for RB2s was worse, so it applies to lead backs only. Week 4 RB1 average: 13.7 → 14.5 carries.

Also fixed: the displayed team pass rate (and the skeptic's team-rush estimate) now uses the simulator's effective game-state weights.

## fbm-1.5.0: situational multiplier model (2026-10-01)

**The idea:** effects are percentages of the player's own number, not fixed additions. A 10% boost is +1.5 carries on a 15-carry back and +2.0 on a 20-carry back.

`src/situational.js` (fit with `scripts/learn_situational.mjs` on nflverse 2022–25):

    expected stat = baseline × exp(β · x)          (Poisson regression, log(baseline) offset)

- **baseline:** his average this season, padded with 2 games' worth of last season's average.
- **x:** points favored, points underdog, blowout terms beyond 7, implied team points, what this defense allows to his position (log, shrunk), home, wind 15+ mph, cold.
- The learner and the live model share the same state and feature code, so training and live inputs match.

**Fitted multipliers.** Test = fit on 2022–24, scored on 2025, against the player's baseline alone:

| Stat | 2025 test: baseline → model | per 7 pts fav | per 7 pts dog | blowout fav (beyond 7) | blowout dog (beyond 7) | +7 team pts | opp allowance (log) | home | wind 15+ | cold |
|---|---|---|---|---|---|---|---|---|---|---|
| RB|carries | 4.16 → 4.172 (no gain) | ×0.99 | ×0.95 | ×1.01 | ×1.11 | ×0.98 | ×1.80 | ×1.03 | ×1.02 | ×1.00 |
| RB|rush_yds | 25.043 → 25.073 (no gain) | ×0.97 | ×0.96 | ×1.01 | ×1.14 | ×1.03 | ×1.97 | ×1.03 | ×1.01 | ×1.04 |
| RB|targets | 1.638 → 1.606 | ×0.92 | ×1.06 | ×1.05 | ×0.92 | ×1.08 | ×1.44 | ×1.06 | ×0.98 | ×1.05 |
| RB|receptions | 1.354 → 1.324 | ×0.90 | ×1.05 | ×1.11 | ×0.93 | ×1.08 | ×1.54 | ×1.07 | ×0.99 | ×1.08 |
| RB|rec_yds | 13.699 → 13.171 | ×0.86 | ×1.09 | ×1.02 | ×0.86 | ×1.22 | ×1.24 | ×1.03 | ×1.04 | ×1.06 |
| WR|targets | 2.298 → 2.273 | ×0.97 | ×1.05 | ×0.99 | ×0.98 | ×1.05 | ×1.34 | ×1.00 | ×0.96 | ×0.93 |
| WR|receptions | 1.692 → 1.683 | ×0.97 | ×1.07 | ×1.01 | ×0.98 | ×1.07 | ×1.28 | ×1.02 | ×0.94 | ×0.95 |
| WR|rec_yds | 25.449 → 25.195 | ×1.00 | ×1.08 | ×0.99 | ×0.88 | ×1.04 | ×1.37 | ×1.04 | ×0.89 | ×0.96 |
| TE|targets | 1.9 → 1.913 (no gain) | ×0.97 | ×1.00 | ×1.06 | ×0.95 | ×1.01 | ×1.42 | ×1.01 | ×0.96 | ×0.98 |
| TE|receptions | 1.568 → 1.583 (no gain) | ×0.97 | ×1.00 | ×1.02 | ×1.00 | ×1.02 | ×1.34 | ×1.02 | ×0.95 | ×0.99 |
| TE|rec_yds | 18.698 → 18.878 (no gain) | ×0.97 | ×0.95 | ×0.96 | ×1.09 | ×1.05 | ×1.43 | ×1.02 | ×0.89 | ×0.98 |
| QB|pass_att | 7.69 → 7.586 | ×0.94 | ×1.01 | ×1.07 | ×1.01 | ×1.06 | ×1.49 | ×1.02 | ×0.94 | ×0.96 |
| QB|pass_yds | 62.443 → 60.486 | ×0.95 | ×0.99 | ×1.03 | ×1.00 | ×1.06 | ×1.77 | ×1.06 | ×0.90 | ×0.98 |
| QB|completions | 5.392 → 5.28 | ×0.95 | ×1.01 | ×1.06 | ×1.03 | ×1.05 | ×1.72 | ×1.05 | ×0.91 | ×0.97 |
| QB|rush_yds | 13.445 → 13.691 (no gain) | ×0.86 | ×0.90 | ×1.17 | ×1.57 | ×1.02 | ×1.20 | ×1.02 | ×1.12 | ×0.87 |
| QB|carries | 1.935 → 1.934 | ×0.90 | ×0.96 | ×1.09 | ×1.46 | ×1.04 | ×1.20 | ×1.01 | ×1.08 | ×0.94 |

**Readings:**
- Relative to a back's own baseline, being favored doesn't add carries (×0.99 per 7). The baseline already holds his usual game script, and pregame spreads don't know who will actually lead.
- Big underdogs bounce back a little (×1.11 per 7 beyond 7).
- Opponent allowance is the biggest carries effect.
- Favorites throw less to backs (×0.86–0.92 per 7) and pass less overall (QB ×0.94–0.95).
- Wind 15+ mph: QB passing yards ×0.90, WR yards ×0.89.

**Against the full model** (2025, blend weight learned on weeks 2–9, tested on weeks 10–18; `scripts/situational_vs_model.mjs`):
- The full model beats the multiplier model on RB carries (4.15 vs 4.37) and rushing yards.
- A blend helps a little, and is shipped, for TE receptions (60%), WR targets (60%), RB targets (50%), RB receptions (20%) and QB completions (10%).
- Not blended: QB passing yards (fewer misses, but its record vs lines got worse), TE yards, WR yards / receptions.
- Every other stat shows the multiplier math on the card as a reference.

**Guards:**
- No blend onto a zero projection, and QB stats blend only for the starter.
- Receptions are capped at 0.9 × simulated targets.
- No baseline-driven layer for a stat whose share rose 1.5+ points from a teammate's absence.

## fbm-1.5.1: correction to fbm-1.4.2–1.5.0, plus re-learning on raw output (2026-10-01)

**What was wrong:** the market-blind harness applied whatever calibration layers existed at the time.
- Batch 6 was raw. Batches 7–11 were calibrated with the then-current v1.3 / v1.4 files.
- In fbm-1.4.2 I re-learned v1.3 / v1.4 on batch 9's already-calibrated projections, then applied the result to raw simulation output.

**Consequences:**
- Most of the drop in lead-back carries (week 4 RB1 average 15.2 → 13.7) came from this, not from the model's logic. The "+0.78 RB1 shift" in fbm-1.4.4 was a patch over it.
- The claim that "the old v1.4 corrections were compensating for bugs" was wrong. On raw output they are learned again: RB carries / rush yds / receptions / targets and QB completions / attempts / pass yds.
- The batch 6 → 7 comparison mixed raw against calibrated output. The St. Brown name-parsing bug and the game-state weighting bug were still real bugs, but the size of that "improvement" is not a clean measurement.
- Learning steps that ran on calibrated batches (anchor, RB1 shift, situational blend, big-miss model, tier records) are re-done below.

**Fixes:**
1. Blind runs now record raw simulation only. `src/matchup.js` skips v1.3 / v1.4 / anchor / situational blend when `blind`. Verified: batch 12 RB1 projections equal simulated volume.
2. Every layer is re-learned on raw batch 13, through one shared offline pipeline (`scripts/lib/pipeline.mjs`) that reproduces the live calibrated projection.

| Layer | Result on raw batch 13 |
|---|---|
| v1.3 calibration | 2026 miss 6.39 → 6.31 |
| v1.4 corrections | kept for RB carries, rush yds, receptions, targets, long rush; QB completions, attempts, pass yds, long completion |
| Live vs raw, 2025–26 | QB pass yds 61.1 → 59.4; RB carries 3.83 → 3.75; RB rush yds 23.5 → 23.3; WR rec yds 27.2 → 26.8 |
| RB1 carries | live 14.00 vs actual 14.37 (was 1.4 short raw); separate RB1 shift removed |
| Season anchor | QB rush yds 0.5, TE targets 0.4, WR targets / receptions / rec yds 0.3, RB rush yds 0.2, WR long 0.1 |
| Situational blend (wk 10–18 test; also requires no worse record vs lines) | RB carries 0.1, RB receptions 0.2, RB targets 0.6, TE receptions 0.4, WR targets 0.6 |
| Game pick (refit) | 141–119 (54.2%) out of sample |
| Outlier tiers | 1–1.5× 54.3% (UNDER 55.2%), 1.5–2× 51.0%, 2×+ 51.6% (partly in-sample for v1.4) |

**Role-growth prior rule:** stop blending last season's share when this season's is 10+ points higher for carries or 6+ for targets. Tested raw vs raw (batch 12 on, batch 13 off) and rejected. On affected rows: RB carries 4.10 → 4.12, RB rush yds 22.3 → 22.5, WR targets 2.50 → 2.65, TE yds 20.7 → 22.1. Early role jumps regress, matching batch 10.

**Team consistency:** independently calibrated players could add up to more catches or receiving yards than their QB's completions or passing yards. Both sides now meet in the middle. Whole distributions are rescaled, and P(over) is recomputed from the quantiles.

## fbm-1.5.2: game-pick significance rule; team run volume re-tested (2026-10-01)

**Game pick must clear the significance bar** (user rule: no "edge" on 4.2 vs a 4.5 catch line). Backtest on raw batch 13 (`bigmiss.mjs 13 --rerun --minsig X`):

| Required gap | Record | Big misses our way / against |
|---|---|---|
| none (previous rule) | 141–119 (54.2%) | 33 / 40 |
| ≥ 0.6× bar | 109–101 (51.9%) | 25 / 33 |
| ≥ 1× bar (shipped) | **77–85 (47.5%)** | 13 / 32 |

Shipped at the user's request, with its real record shown on the page. The data says the pick's value came from volatile lines, not from model-vs-book gaps. Reverting is `OUTLIER_RULES.minSig = 0` in `src/outlier.js`.

**Team run volume** (Bijan, Swift; `scripts/team_runs_test.mjs`): predicting a team's rushing attempts in its next game. Grid fit on 2022–24, tested on 2025:

| Estimator | 2025 MAE | Early weeks |
|---|---|---|
| Current (k 12 pseudo-games toward league) | **5.86** | **4.72** |
| Best lighter regression (k 6) | 5.92 | 4.80 |
| With spread | 5.96 | 4.93 |

Not changed. Three games of team run volume are mostly game script.

## fbm-1.5.3: team runs, line grades, pass-rate display (2026-10-01)

**Team run volume as one model.** All inputs weighed together by OLS on 2022–24 team-games (`scripts/team_runs_test.mjs` → `src/fitted_team_runs.json`):

    runs ≈ L + 0.49·(n/(n+3))·(team this season − L) + 0.30·(team last season − L)
             + 0.23·(nD/(nD+3))·(opp allowed this season − L) + 0.23·(opp allowed last season − L)
             + 0.14·spread − 0.10·(total − 44)

- 2025 MAE 5.88, vs 5.86 for the current shrinkage estimator: a tie. The "pull toward league average" is simply what remains after these inputs.
- Not used by the simulation; shown on each game page as a second opinion.
- Like-for-like: simulated runs include QB scrambles but not kneel-downs. Box-score carries are about 0.8 per team-game higher (nflverse 2025).
- Week 4: the simulation averages about 1 run above the history model.
  - ATL: sim 29.4, history 28.6. Team volume is not what keeps Bijan below his average.
  - CHI: history +1.9, because the NYJ defense faces few runs.

**OL / DL grades:**
- Before: a shrunk team rate was divided by the SD of raw team rates, and composites averaged two 0–100 scores. Nearly every unit landed between 40 and 60.
- Now: components and composites are re-standardized against the spread of the same shrunk score across all teams, so 15 points = one real team-level SD.
- Week 4 range: DL 15 (NYG) to 88 (MIN); OL 20–89. Display only; projections unchanged.

**Pass rate by game state:** NO has no plays this season while leading by 8+. The model uses the league rate for that state (47%), scaled to NO's overall passing volume (51% in the simulation). The page now shows each state's sample size and labels the fallback.

## fbm-1.5.4: defense ratings lean less on last season (2026-10-02)

**Trigger:** IND is the worst defense by yards/play (6.64) and yards/game (418) through week 3, yet rated only 6th–9th worst. With last season's plays at 0.25 weight each, 2025 still made up ~57% of every early-season rating.

**Test** (`scripts/def_prior_weight.mjs`, 2022–25): predict a defense's rest-of-season EPA/play allowed from what was known at week W.

| Week | Weight 0.25 (old) | Best | This season only |
|---|---|---|---|
| Wk 4 | 0.0799 | 0.0752 at 0.15 | 0.0763 |
| Wk 6 | 0.0796 | 0.0753 at 0.10 | 0.0756 |

Shipped weight: 0.15.

**IND now ranks from worst:** run D 4th, CBs 3rd, short-middle 1st, overall pass D 7th (EPA/dropback includes sacks and INTs).

**Big-miss model** refit on the new ratings. Game pick with the significance rule: 74–84 (46.8%). Without the rule: 139–117 (54.3%).

## fbm-1.5.5: team ratings from this season only (2026-10-02)

User choice: from week 3 on, team unit ratings (run D, coverage, pass rush, zones, etc.) use 2026 plays only. In the 2022–25 test, "this season only" scored 0.0763 vs 0.0752 for the 0.15 blend, so it costs almost nothing.

Still blended with last season (PRIOR_W 0.15):
- weeks 1–2 (too few plays yet);
- player profiles (styles, target zones);
- man/zone coverage tendencies (no public 2026 charting).

**IND now ranks from worst:** CBs 1st, short-middle 1st, run D 2nd, pass rush 3rd, overall pass D 7th.

**Big-miss model refit.** Game pick: without the gap rule 145–118 (55.1%); with it 74–85 (46.5%, live).

## Line-blind verification + "Model only" view (2026-10-02)

**Question:** do the projections lean on sportsbook player lines?

**Check:** `buildMatchup(…, { noPlayerLines: true })` never fetches player props (ESPN or Odds API). Game lines (spread, total) are still used. `scripts/line_blind_check.mjs` builds every game both ways and compares every projected number, including the p10 / p90 range.

**Week 4 NFL result:** 1,492 projected stats across 16 games, 639 of them with a book line. **0 differ** (max abs diff 0).

This holds by construction. Prop lines are attached only after a stat's distribution is final, for the over/under threshold, P(over), outliers and the game pick. Every learned layer (v1.3, v1.4, anchor, situational, team runs) was fit on market-blind batches that never saw a player line.

**UI:** a "Model only" switch on each game page hides every sportsbook player line: the line and price rows, the chart's line, P(over), outliers, the game pick, and line references in the head-to-head and same-slot blocks. It is remembered per browser. The verification result is shown next to the switch (`/api/lineblind`, also exported to the static site).

## fbm-1.5.6: run-defense pass-through, RB quality test, structural line isolation (2026-10-02)

**Run-defense multiplier.**
- 2022–25: about 21% of an early-season run defense's raw RB-YPC edge carries to the next opponent. The exponent 0.8 applied about 31% (e.g. WSH: 2.49 YPC allowed on 51 runs → ×0.865).
- Exponent changed to 0.5 (`SHRINK.oppRunExp`). Raw batch 14 vs 13: RB rush yds MAE 23.91 → 23.85, corr 0.541 → 0.544; every other stat unchanged.
- All layers re-learned on batch 14:
  - v1.3: 2026 miss 6.40 → 6.33.
  - v1.4 kept: RB carries / receptions / targets / long rush; QB completions / attempts / pass yds / long; K.
  - Anchor: QB rush yds 0.5, TE targets 0.4, RB rush yds 0.3, WR targets / receptions / rec yds 0.3, RB rec yds 0.1, WR long 0.1.
  - Situational blend: RB carries, RB targets, TE receptions, WR targets.
  - Game pick: 142–118 (54.6%) without the gap rule; 77–88 (46.7%) with it (live).
  - Tiers: 1–1.5× 54.8% (UNDER 56.1%).

**Do better backs lose less to good run defenses?** (`scripts/rb_quality_vs_defense.mjs`, 2022–25)
- Quality = prior YPC: interaction −0.035 ± 0.025 (not significant); no held-out gain.
- Quality = NGS RYOE per carry, last season: the opposite. Defense effect shows up 9% / 11% / 30% for low / mid / high RYOE backs (interaction +0.149, z 4.3). Elite backs lose more of their breakaway yards to good run defenses.
- Neither version improved held-out YPC error, so no interaction was added. Player quality stays in through each back's own shrunk YPC.

**Line isolation is now structural.** Player prop lines are fetched only after every projection, and the team consistency pass, are final (LINE ATTACHMENT stage in `src/matchup.js`). The projection stage cannot read them. `scripts/line_blind_check.mjs` still finds 0 of 1,492 projected numbers differ with lines removed.
