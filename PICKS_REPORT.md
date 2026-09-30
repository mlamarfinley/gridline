# Every pick, 2024–2026 NFL: predictions vs actual lines, why they missed, what was learned

**Batch #6**: market-blind, frozen `fbm-1.2.0` (params hash in the Ledger).

**Coverage:** every NFL regular-season game of 2024, 2025 and 2026 through week 3, predicted using **only games verified finished before kickoff**. Nothing about the game itself was used: no box score, no betting lines, no injuries or depth charts, no current rosters.

**Order of operations:** predictions and their reasoning were sealed **before** any result or line was fetched. Results and lines were attached afterward.

**Full list of every pick:** `reports/picks_2024_2026.csv` (55,718 rows). Each row has the projection and range, the actual main line (with prices where the book kept them), the model's side, the actual stat, WIN/LOSS/PUSH, and a brief reason for every loss or out-of-range result.

## Read this first

| Season | Status |
|---|---|
| **2024** | **The honest test.** No fitted constant used 2024 outcomes as a target. |
| **2025** | **In-sample.** The v1.2 constants were fitted on 2025 outcomes, so 2025 flatters the model. |
| **2026** | Weeks 2–3 were already inspected during development. |

**Lines:**
- They are what ESPN still serves today (DraftKings for 2026, ESPN BET for 2024–25; main line only, alternates ignored). They were retrieved **after** the games, and their timestamps can't prove they were pregame, so every win/loss below is an **unverified reconstruction**. No ROI is claimed.
- A pick = a prediction with a line. The model's side is OVER if the projection is above the line, UNDER if below.
- Break-even at typical −110 prices is **52.4%**.

## Results by season

| Season | Games | Predictions | Picks with a line | W–L–P | Win rate | Model MAE vs line MAE (same rows) | 10–90 coverage |
|---|---|---|---|---|---|---|---|
| 2024 | 256 | 26,172 | 8,626 | 4341–4069–1 | 51.6% | 13.16 vs **12.53** | 84.5% |
| 2025 | 256 | 26,240 | 7,671 | 3807–3663–0 | 51.0% | 11.46 vs **10.79** | 84.9% |
| 2026 | 32 | 3,306 | 1,476 | 659–766–0 | 46.2% | 11.12 vs **10.30** | 86.0% |

### OVER vs UNDER picks

| Season | OVER picks | UNDER picks |
|---|---|---|
| 2024 | 2477–2323 (51.6%) | 1864–1746 (51.6%) |
| 2025 | 2214–2323 (48.8%) | 1593–1340 (54.3%) |
| 2026 | 391–489 (44.4%) | 268–277 (49.2%) |

### Do bigger disagreements with the line win more?

Gap is measured in standard deviations of the model's own range.

| Season | gap 0–0.25 SD | gap 0.25–0.5 SD | gap 0.5–1 SD | gap 1–∞ SD |
|---|---|---|---|---|
| 2024 | 2322–2237 (50.9%) | 1308–1199 (52.2%) | 607–540 (52.9%) | 101–90 (52.9%) |
| 2025 | 2097–2022 (50.9%) | 1134–1107 (50.6%) | 508–465 (52.2%) | 67–67 (50.0%) |
| 2026 | 376–418 (47.4%) | 177–238 (42.7%) | 93–102 (47.7%) | 13–8 (61.9%) |

### By stat (all three seasons pooled)

| Pos · stat | Picks | W–L | Win rate | Model MAE | Line MAE |
|---|---|---|---|---|---|
| WR · rec_yds | 1568 | 771–766 | 50.2% | 28.00 | 26.38 |
| WR · long_rec | 1490 | 742–704 | 51.3% | 10.64 | 10.25 |
| WR · receptions | 1470 | 706–672 | 51.2% | 1.86 | 1.77 |
| RB · long_rush | 1339 | 663–639 | 50.9% | 7.85 | 7.63 |
| RB · rush_yds | 1329 | 658–659 | 50.0% | 25.99 | 24.63 |
| RB · carries | 1100 | 567–508 | 52.7% | 4.39 | 3.89 |
| RB · receptions | 1064 | 489–492 | 49.8% | 1.46 | 1.38 |
| RB · rec_yds | 841 | 421–413 | 50.5% | 14.44 | 13.81 |
| K · xp_made | 813 | 413–387 | 51.6% | 1.12 | 1.09 |
| QB · pass_yds | 799 | 399–399 | 50.0% | 59.61 | 55.80 |
| QB · pass_att | 743 | 360–371 | 49.2% | 6.86 | 6.28 |
| QB · completions | 739 | 347–382 | 47.6% | 4.94 | 4.47 |
| QB · long_cmp | 739 | 367–365 | 50.1% | 12.44 | 11.72 |
| QB · pass_td | 702 | 384–308 | 55.5% | 0.97 | 0.98 |
| K · fg_made | 602 | 298–293 | 50.4% | 1.02 | 1.02 |
| QB · rush_yds | 530 | 276–252 | 52.3% | 14.13 | 13.55 |
| TE · long_rec | 519 | 262–232 | 53.0% | 7.81 | 7.66 |
| TE · rec_yds | 517 | 253–259 | 49.4% | 21.67 | 20.76 |
| TE · receptions | 509 | 246–225 | 52.2% | 1.88 | 1.80 |
| QB · ints | 360 | 185–172 | 51.8% | 0.65 | 0.66 |

## Why picks lost (reason of every loss, by season)

| Season | Workload | Role/share | Team volume/game script | Game script | Efficiency | One big play | Touchdown variance | Workload collapsed | No recorded stats | Kicking volume follows team scoring | Longest play |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2024 | 167 (4.1%) | 956 (23.5%) | 363 (8.9%) | 216 (5.3%) | 679 (16.7%) | 324 (8.0%) | 145 (3.6%) | 167 (4.1%) | 0 (0.0%) | 313 (7.7%) | 906 (22.3%) |
| 2025 | 96 (2.6%) | 869 (23.7%) | 320 (8.7%) | 204 (5.6%) | 679 (18.5%) | 268 (7.3%) | 140 (3.8%) | 96 (2.6%) | 0 (0.0%) | 298 (8.1%) | 789 (21.5%) |
| 2026 | 41 (5.4%) | 149 (19.5%) | 91 (11.9%) | 50 (6.5%) | 140 (18.3%) | 50 (6.5%) | 22 (2.9%) | 41 (5.4%) | 0 (0.0%) | 69 (9.0%) | 154 (20.1%) |

## What was learned from every pick (walk-forward, so it can't grade itself)

Learned per position/stat: (1) a shrunk correction of the projection's centre, (2) a range-width multiplier targeting 80% coverage, (3) whether larger gaps to the line win more.

| Learned on → tested on | MAE | Bias | 10–90 coverage | Picks W–L | Model vs line MAE (line rows) |
|---|---|---|---|---|---|
| — (none) → 2025 | 6.65 | -0.27 | 84.9% | 3807–3663 (51.0%) | 11.46 vs 10.79 |
| **2024 → 2025** | 6.58 | -0.89 | 84.3% | 3844–3793 (50.3%) | 11.40 vs 10.79 |
| — (none) → 2026 | 6.42 | -0.07 | 86.0% | 659–766 (46.3%) | 11.12 vs 10.30 |
| **2024 → 2026** | 6.35 | -0.69 | 85.8% | 705–751 (48.4%) | 11.04 vs 10.30 |
| **2024+2025 → 2026** | 6.34 | -0.91 | 86.0% | 709–747 (48.7%) | 11.02 vs 10.30 |

### Learned pick rules: did they hold up on seasons they never saw?

| Rule (learned on) | Tested on | Record | Win rate |
|---|---|---|---|
| Only bet stats that beat 52.4% in training (2024: WR|long_rec, WR|rec_yds, RB|carries, QB|pass_td, TE|long_rec, TE|rec_yds, TE|receptions) | 2025 | 1254–1348 | **48.2%** |
| same rule (2024) | 2026 | 247–238 | 50.9% |
| Follow the model's side (2024 β = 0.118, t = 3.97) | 2025 | 3844–3793 | 50.3% |

Pooled over 2024+2025, the model's disagreement with the line carries almost no signal (β = 0.0229, t = 1.04, n = 16192). **No learned pick rule beat the 52.4% break-even on a season it wasn't learned from, so none is used.**

Learned corrections (final, 2024+2025), largest adjustments first:

| Pos · stat | n | centre shift (median residual) | range × | training win rate vs line |
|---|---|---|---|---|
| QB · pass_yds | 908 | -7.09 | 1.05 | 50.5% (742) |
| QB · long_cmp | 907 | -3.74 | 1.10 | 50.8% (675) |
| TE · rec_yds | 638 | -3.58 | 1.00 | 50.7% (477) |
| WR · rec_yds | 1806 | -3.42 | 1.00 | 50.5% (1416) |
| RB · rec_yds | 1881 | -3.33 | 1.00 | 50.7% (748) |
| QB · rush_yds | 908 | -1.72 | 1.25 | 51.7% (472) |
| QB · fumbles_lost | 908 | -0.12 | 0.50 | — |
| QB · rush_td | 908 | -0.11 | 0.50 | — |
| RB · rec_td | 1881 | -0.05 | 0.50 | — |
| RB · fumbles_lost | 1881 | -0.03 | 0.50 | — |
| RB · rush_yds | 1881 | +0.98 | 1.30 | 50.4% (1207) |
| RB · long_rush | 1881 | -1.76 | 1.10 | 51.9% (1209) |
| QB · pass_att | 908 | -0.67 | 1.30 | 49.5% (674) |
| RB · carries | 1881 | +0.59 | 1.30 | 53.1% (998) |
| WR · long_rec | 1806 | -2.05 | 1.00 | 51.5% (1329) |
| QB · completions | 908 | -1.05 | 1.20 | 48.4% (673) |
| WR · rec_td | 1806 | -0.24 | 1.35 | — |
| QB · fumbles | 908 | -0.22 | 1.30 | — |

## Examples of losing picks and why (2024, the out-of-sample season)

| Wk | Game | Player | Stat | Model (side) | Line | Actual | Why |
|---|---|---|---|---|---|---|---|
| 16 | PHI @ WSH | Jalen Hurts | pass_yds | 207.5 (OVER) | 199.5 | 11 | Workload collapsed: 4 pass attempts vs 26.4 projected — early exit, benching or in-game injury; team lost by 3 (model +3.7). |
| 8 | NYJ @ NE | Drake Maye | pass_yds | 212.1 (OVER) | 199.5 | 23 | Workload collapsed: 6 pass attempts vs 29.5 projected — early exit, benching or in-game injury; team won by 3 (model -3.7). |
| 4 | TEN @ MIA | Will Levis | pass_yds | 203.9 (OVER) | 199.5 | 25 | Workload collapsed: 4 pass attempts vs 29.7 projected — early exit, benching or in-game injury; team won by 19 (model -2.5). |
| 7 | LAC @ ARI | Justin Herbert | pass_yds | 198.3 (UNDER) | 199.5 | 349 | Role/share: 39 pass attempts vs 28.7 proj (+36%); 8.9 yds/att vs 6.9 proj — team ran 63 plays (60.4 proj), team lost by 2 (model +4.2). |
| 10 | CIN @ BAL | Ja'Marr Chase | rec_yds | 77.1 (UNDER) | 79.5 | 264 | Efficiency: 17 targets vs 9.1 proj (+87%); 24 yds/catch vs 12.7 proj — team ran 74 plays (60.5 proj), team lost by 1 (model -5.6). |
| 7 | HOU @ GB | C.J. Stroud | pass_yds | 268.6 (OVER) | 249.5 | 86 | Efficiency: 21 pass attempts vs 35.2 proj (-40%); 4.1 yds/att vs 7.6 proj — team ran 57 plays (63.1 proj), team lost by 2 (model -2). |
| 12 | PHI @ LAR | Saquon Barkley | rush_yds | 72.1 (UNDER) | 99.5 | 255 | Efficiency: 26 carries vs 15.7 proj (+65%); 9.8 yds/carry vs 4.6 proj — team ran 66 plays (62.8 proj), team won by 17 (model +4.5). |
| 5 | IND @ JAX | Trevor Lawrence | pass_yds | 223.2 (UNDER) | 224.5 | 371 | Efficiency: 34 pass attempts vs 33.1 proj (+3%); 10.9 yds/att vs 6.7 proj — team ran 56 plays (62.1 proj), team won by 3 (model -2.6). |
| 18 | WSH @ DAL | Jayden Daniels | pass_yds | 227 (OVER) | 224.5 | 38 | Team volume/game script: 12 pass attempts vs 30.2 proj (-60%); 3.2 yds/att vs 7.5 proj — team ran 53 plays (63.1 proj), team won by 4 (model +3.4). |
| 8 | TEN @ DET | Jared Goff | pass_yds | 249.7 (OVER) | 249.5 | 85 | Team volume/game script: 15 pass attempts vs 30.4 proj (-51%); 5.7 yds/att vs 8.2 proj — team ran 47 plays (61.3 proj), team won by 38 (model +7.6). |
| 10 | CIN @ BAL | Joe Burrow | pass_yds | 258.1 (UNDER) | 274.5 | 428 | Team volume/game script: 56 pass attempts vs 36 proj (+56%); 7.6 yds/att vs 7.2 proj — team ran 74 plays (60.5 proj), team lost by 1 (model -5.6). |
| 18 | LAC @ LV | Quentin Johnston | rec_yds | 38.6 (UNDER) | 39.5 | 186 | Team volume/game script: 14 targets vs 5.6 proj (+151%); 14.3 yds/catch vs 12 proj — team ran 70 plays (58.8 proj), team won by 14 (model +6.5). |
| 7 | BAL @ TB | Derrick Henry | rush_yds | 72.4 (UNDER) | 89.5 | 169 | One big play: a 81-yd gain decided it (without it: 88 vs line 89.5). |
| 13 | CLE @ DEN | Bo Nix | pass_yds | 206 (UNDER) | 224.5 | 294 | One big play: a 93-yd gain decided it (without it: 201 vs line 224.5). |
| 8 | TEN @ DET | Jahmyr Gibbs | rush_yds | 51.3 (UNDER) | 69.5 | 127 | One big play: a 70-yd gain decided it (without it: 57 vs line 69.5). |
| 15 | KC @ CLE | Jerome Ford | rush_yds | 28.6 (UNDER) | 29.5 | 84 | One big play: a 62-yd gain decided it (without it: 22 vs line 29.5). |

## Prices: can these win rates make money?

The retained lines also carry the book's over/under prices. These are the prices ESPN kept after the game, **not archived pregame prices**, so what follows is a hypothetical check, **not a claimed ROI**.

| Picks | Seasons | Model win rate | Win rate the prices required | Hypothetical result per 1-unit pick |
|---|---|---|---|---|
| QB passing TDs | 2024 | 56.9% (332) | 57.1% | +0.009 (break-even) |
| QB passing TDs | 2025 | 53.5% (282) | 57.9% | −0.069 |
| All other stats | 2024 | 51.5% (7,627) | 54.5% | −0.054 |
| All other stats | 2025 | 51.2% (6,882) | 54.2% | −0.057 |

The only stat that looked strong on raw win rate is passing TDs (57.4% / 52.7% / 58.9% by season). Those props are usually priced well away from even money, so the higher hit rate is roughly what the book already charges for. That pattern was also spotted **after** seeing all three seasons, so it is a hypothesis for the 2026 week-4+ pregame snapshots, not a finding.

## What was learned from every pick

1. **The book was more accurate than the model in every season** (MAE 12.5 vs 13.2 in 2024, 10.8 vs 11.5 in 2025, 10.3 vs 11.1 in 2026). The model's disagreements with the line carry at most a faint signal. The best case was 2024 on its own (β = +0.12), and it vanished when 2025 was added. **Model-vs-line gaps should be treated as "look closer", never as bets.**
2. **Bigger gaps don't win more.** Every gap bucket sits at 50–53%. There is no confidence threshold to exploit.
3. **Role/share is the #1 reason picks lose (about 23%).** The model misjudged how much of the team's work a player would get. The clearest pattern is **players on new teams early in the season.**
   - Example: Derrick Henry, 2024 week 2, projected 9.9 carries vs a 17.5 line; he got 18.
   - Cause: v1.2 only uses last season's share **on the same team**, so a veteran who moved had no usable prior.
   - Fix (next version): use last season's role on *any* team, scaled by the new team's depth at the position.
4. **Longest-play props are about 21% of losses.** Longest rush, catch or completion is a single-play outcome. The model is no better than the line there (about 50–51%). **Don't take sides on "longest" props.**
5. **Efficiency (yards per touch) is about 17% of losses and mostly noise.** v1.2 already shrinks it heavily. The learned calibration trims it slightly more.
6. **Team volume and game script are about 14% of losses.** As found earlier, even the market predicts play volume weakly (r = 0.13).
7. **Kicking props (about 8%) follow team scoring,** which the blind model can't see beyond season form.
8. **Ranges were slightly too wide** (84–86% coverage vs 80% target). Calibration fixes the centre and keeps coverage at or above 80%.
9. **Early season is hardest:** week 2 has one prior game. Every per-season table above includes it; these are the picks where last-season priors matter most.

**Shipped as `fbm-1.3.0`:** only the output calibration (centre shift plus range width per position/stat), learned on 2024+2025. It improved accuracy out of sample: MAE 6.65 → 6.58 on 2025 when learned on 2024 alone, and 6.43 → 6.34 on 2026. Coverage stayed at or above 80%.

**Not shipped, because they failed out of sample:** the stat filter (48.2% on 2025) and follow/fade rules.

**Next model change:** any-team role priors for players who changed teams (lesson 3). It can only be judged on games after it's built: the 2026 week-4+ pregame snapshots, which are already being recorded.

## Files

- `reports/picks_2024_2026.csv`: every prediction (49,240 scored plus no-stats and unknown rows) with its line, prices, side, result and reason.
- `reports/picks_2024_2026_summary.json`: the per-season, per-stat numbers behind the tables.
- `src/fitted_v13.json`: the learned calibration and walk-forward results.
- Scripts: `scripts/picks_report.mjs`, `scripts/learn_v13.mjs`, `scripts/picks_markdown.mjs`.
