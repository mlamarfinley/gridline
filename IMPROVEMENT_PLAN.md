# IMPROVEMENT_PLAN: NFL projections (from the week 2–3 backcheck)

**Goal:** close the gap to the market (open-line MAE is currently 10–20% lower than the model's), restore real ranking power on QB passing, and keep the honest ranges.

The evidence for each item is in `NFL_BACKCHECK_REPORT.md`. Injuries and in-game exits are treated as outliers here. They're handled in live mode by the injury report and are not what's driving the systematic error.

## Ground rules (so the fix isn't fooling itself)

- **Build and tune on the 2025 season only.** Use nflverse weekly stats and play-by-play plus 2025 ESPN summaries, which is fully historical data. Do **not** tune on 2026 weeks 2–3; they're already inspected.
- **Freeze as `fbm-1.2.0`.** Evaluate on data the build never saw:
  - 2026 week-4+ **pregame snapshots** (true forecasts with lines captured before kickoff);
  - a new blind batch per completed week.
- **Pre-registered acceptance criteria** (NFL, clean set, versus captured pregame lines):

  | Metric | Target |
  |---|---|
  | QB pass-yds correlation with actual | ≥ 0.30 (now ≈ 0.0) |
  | Team plays correlation | ≥ 0.25 (now 0.0) |
  | Yardage MAE vs pregame line MAE | within 5% |
  | β on (model − line) deviation | not negative (now −0.21) |
  | 10–90 coverage | 78–85% |

## Priority 1: a team-level offense model (fixes the biggest error source)

**Problem:** the expected margin, team points and team plays have ~0 correlation with outcomes. After 1–2 games everything is shrunk to league average, so every game is a coin flip and every player on an offense misses together (QB attempt error ↔ team play error, corr 0.73).

**Plan:**
1. **Team ratings with a real prior.** Build per-team offense and defense ratings: EPA/play, success rate, pace, neutral pass rate. Start from the **2025 season** (nflverse play-by-play), regressed about 50% toward the mean for the offseason. Update with 2026 games using a Bayesian weight *fitted on 2025* (how fast week-N data should overtake the prior) instead of today's hand-set "3 pseudo-games".
2. **Project team totals first.** Estimate plays, pass attempts, team passing yards and team rushing yards from both teams' ratings (offense vs opposing defense). Then **allocate** them to players by share. Player lines then sum to a coherent team line.
3. **Market-informed mode.** Let the implied team total and spread directly scale team pass and rush volume and yards. Today they only touch script weights, TD rates and a ±10% pace nudge, which is why market-informed barely beat blind (58.4 vs 59.4 QB MAE). Fit the scaling on 2025 box scores vs 2025 closing totals (if available) or team-strength proxies.
4. **Wider script distribution.** Actual |margin| averages 10.8 vs 2.5 projected. The margin SD and the "opening close share" should be fitted on 2025 outcomes, so trailing and leading scripts get realistic weight.

## Priority 2: a QB efficiency module

**Problem:** QB pass-yard projections have no rank signal (spread ±24 yds vs ±72 real). Passing efficiency is currently only the sum of receivers' catch distributions; QB skill isn't an input.

**Plan:**
1. Add a QB rating: yards per attempt, CPOE, air yards per attempt, sack rate and INT rate from nflverse (`passing_cpoe`, `passing_air_yards` are in the weekly file). Use a **prior-season prior** (same QB, any team) plus current-season shrinkage fitted on 2025.
2. Make the **QB drive team passing efficiency**. Receivers then get *shares* of the QB's yards (target share × their yards-per-target relative to teammates) instead of independently drawn efficiency.
3. **Backup/replacement QBs:** use their own career prior when one exists, otherwise a replacement-level prior. Never the starter's numbers.

## Priority 3: better opportunity (share) estimates

**Problem:** workload is ~60% of squared error. WR target share correlation is only 0.28, and RB carries are under-projected by 1.2.

**Plan:**
1. **Prior-season shares** as the prior for players on the same team, adjusted for departures and arrivals (who left or joined is knowable pregame from the roster history).
2. **Snap share and route participation as leading indicators.** nflverse snap counts for weeks *before* the target are already allowed in blind mode (as-of-week).
3. **RB carries:** audit the "other" bucket and the share floors, which leak about 1.2 carries per RB. Concentrate on the top two backs using the historical distribution of RB1/RB2 carry splits.
4. **Fit shrinkage strengths** (`SHRINK.share`, `scenarioShare`) on 2025 week-by-week data instead of hand-set values.

## Priority 4: stop over-reacting to small-sample efficiency

**Problem:** efficiency is mostly noise (RB ypc corr 0.25). For rushing yards, the model's deviations from the line point the wrong way (β = −0.52, t = −2.7).

**Plan:** fit the efficiency shrinkage constants on 2025: the ypc and yards/catch shrinkage, and the explosive-rate prior weights. Expect **heavier** shrinkage. Drop the opponent run-defense multiplier if it doesn't earn its keep out of sample.

## Priority 5: variance and small models

- Keep the current range methodology; coverage is fine.
- RB rushing yards (74%) and QB attempts (77%) need slightly wider tails. Refit the gamma workload shapes on 2025.
- Kicker points have no rank signal: replace them with a simple team-implied-points model and show only a range.
- Fix the TE receiving yards bias (+5.6) by making TE target and efficiency priors position-specific, fitted on 2025.

## Priority 6: how predictions are presented

- Until the acceptance criteria are met, show a **market-anchored projection** next to the model when a pregame line exists. Treat model-vs-line gaps as *prompts to investigate* (role change, injury news), not edges.
- Tighten OUTLIER PICK: require either a documented role or availability reason, or a stat where the model has demonstrated a non-negative β out of sample.

## Availability (live mode only; outliers in the blind test)

- Pull ESPN's pregame **inactives** (~90 min before kickoff) and re-snapshot. Record whether a pick changed after inactives.
- Keep "no recorded stats / participation unverified" separate in every evaluation, so availability misses never masquerade as model error.

## Sequence and effort

| Step | Work | Validates on |
|---|---|---|
| 1 | 2025 data loader: nflverse weekly and pbp, ESPN 2025 summaries | — |
| 2 | Team ratings + team-total model (P1) | 2025 walk-forward (weeks 2–18) |
| 3 | QB efficiency module (P2) | 2025 walk-forward |
| 4 | Share priors + fitted shrinkage (P3, P4) | 2025 walk-forward |
| 5 | Refit variance, kicker, TE (P5) | 2025 walk-forward |
| 6 | Freeze `fbm-1.2.0`; run the blind batch on 2026 weeks 2–3 for comparability only (still labeled in-sample) | — |
| 7 | **Real test:** 2026 week 4+ pregame snapshots and new blind batches, scored against the pre-registered criteria | 2026 week 4 onward |

Nothing in this plan tunes against the 2026 weeks already inspected. If `fbm-1.2.0` misses the criteria on week 4+, the report says so. Weeks are not re-cut to make it pass.

## Status (2026-09-30)

- **Done in `fbm-1.2.0`:** P1 (team strength and volume from fitted estimators, market scaling of passing yards), P2 (QB YPA anchor), P3 (prior-season share priors), P4 (fitted efficiency shrinkage). All constants were fitted on 2024→2025 history (`src/fitted_v12.json`).
- **Results:** see `NFL_V12_REPORT.md`. v1.2 beats v1.1 on every NFL stat, on the same in-sample weeks. It does not yet match the opening lines, and β is still negative.
- **Still to do:** snap-share priors, opponent pass-defense adjustment on QB YPA, variance refit, kicker simplification, RB carry-leak audit. The acceptance test is still 2026 week 4+ pregame snapshots.
