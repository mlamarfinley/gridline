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
