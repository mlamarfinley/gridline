# NFL v1.2: improvement plan implemented, and every miss explained

**Live site:** https://mlamarfinley.github.io/gridline/ (read-only; rebuilt about every 6 hours, now running `fbm-1.2.0`)

**Evaluation:** sealed market-blind batch **#4** (`fbm-1.2.0`, cutoff `cutoff-v2-wallclock-verified`), frozen before any result was fetched. It is compared with batch **#3** (`fbm-1.1.0`) on the **identical 32 NFL games** (weeks 2–3, 3,014 scored player-stats).

**Caveat:** these weeks were inspected during the diagnosis, so they remain labeled **in-sample**. No v1.2 constant was fitted on them. Every constant was fitted on **2024 → 2025 history** (`scripts/fit_v12.js` → `src/fitted_v12.json`). The first clean test is week 4 onward.

## What was implemented (from IMPROVEMENT_PLAN.md)

| Plan item | Implemented as | Fitted on 2025 (walk-forward, 2024 prior) |
|---|---|---|
| P1 team strength | Points for/against = current season blended with last season (regressed 40%), plus opponent adjustment → expected margin and script | k = 12 games, r = 0.4, b = 1.0; RMSE 9.47 vs 9.60 old method, 9.99 league-only |
| P1 team volume | Plays and pass attempts from fitted estimators; script pass rates rescaled to hit the attempt estimate | Plays: k = 12, r = 0 (**last season doesn't help**); attempts: k = 8, r = 0.25, b = 0.75 |
| P1 market mode | Implied team total scales team passing yards (5.37 yds per implied point, fit on 2024–25 closing lines) | 1,088 team-games |
| P2 QB efficiency | QB yards-per-attempt anchor (last season, any team, heavily shrunk) rescales every receiver's catch yardage so team YPA matches the QB | prior weight m = 800 att, current k = 200 att |
| P3 shares | Last season's same-team target/carry share as a prior (players with 4+ games) | target k = 3 games, carry k = 1 game (small gains) |
| P4 efficiency shrinkage | ypc shrinkage 60 → **400 carries**; yards/target → **100 targets** (was ~25–30) | weighted RMSE minimized |

**Also found while fitting:** even the market can't predict team play volume. Closing-line implied points correlate only **0.13** with plays and **0.05** with pass attempts (2025). A large part of the volume error is irreducible for anyone.

**Not done yet (planned):**
- Snap-share priors.
- An opponent pass-defense adjustment to QB YPA.
- Refitting workload variance.
- Kicker simplification.
- RB carry-leak audit: RB carries are still −1.1 per back.

## Results: v1.1 → v1.2 (same games, same frozen protocol)

| Stat | n | MAE v1.1 → v1.2 | Corr with actual | Bias | 10–90 coverage | Open-line MAE (rows with a line) |
|---|---|---|---|---|---|---|
| QB pass yds | 58 | 59.4 → **56.1** | 0.03 → **0.14** | +9.5 → **+3.5** | 79% → 85% | 51.7 |
| QB pass att | 58 | 6.98 → 6.90 | 0.17 → 0.20 | ≈0 | 76% → 74% | 6.53 |
| RB rush yds | 119 | 22.7 → **22.1** | 0.56 → 0.57 | −0.9 → −1.4 | 72% → 75% | 20.3 |
| RB carries | 119 | 3.91 → **3.74** | 0.70 → 0.72 | −1.0 → −1.1 | 79% → 81% | 3.62 |
| RB rec yds | 119 | 12.6 → **11.3** | 0.23 → **0.37** | +2.0 → +0.6 | 76% → 80% | 12.2 |
| WR rec yds | 126 | 29.4 → **27.9** | 0.31 → **0.39** | +2.2 → −2.1 | 82% → 81% | 25.7 |
| WR receptions | 126 | 1.96 → **1.83** | 0.38 → **0.50** | +0.2 → 0.0 | 87% → 88% | 1.74 |
| TE rec yds | 38 | 23.3 → **20.9** | 0.29 → **0.38** | +6.1 → **+0.2** | 76% → 84% | 20.9 |

**Honest bottom line:**
- v1.2 is better than v1.1 on **every** tracked NFL stat, and the TE and QB biases largely disappeared.
- It is **still behind the book's opening lines**, which are post-game reconstructions, though the gap narrowed. On the rows that have a line, the gap on WR receiving yards went from 3.7 to 2.2 yds, and on TE receiving yards from 3.2 to 0.7 yds (21.6 vs 20.9).
- When the model disagrees with the line, it still isn't right more often (β = −0.28). The OUTLIER PICK should keep being read as "worth checking", not as an edge.

## Which ones were wrong, and why

- **Scope:** 562 yardage predictions (QB passing, rushing, receiving) in 32 games. **149 (27%) fell outside the model's 10–90 range**, against 20% expected.
- **Direction:** 58 above, 47 below, and 44 with no recorded stats.
- **How causes are assigned:** by fixed rules, not judgment. Primary cause = the largest of: availability; one big play; efficiency (yards per touch); team volume/script (team off by 10+ plays, or the QB by 8+ attempts, or the margin miss was 17+); otherwise the player's share of team volume.
- These labels are descriptive, **not causal proof**.

| Cause | Misses | Share of misses | Fixable by a model? |
|---|---|---|---|
| **Availability** (no box-score row, or workload collapsed to under 25% of projection) | 54 | 36% | Outliers in blind mode. Live mode uses the injury report; the rest are in-game injuries or benchings. |
| **Efficiency** (yards per touch) | 32 | 21% | Mostly no. Per-touch yardage is close to random week to week (RB ypc corr ≈ 0.25). |
| **Team volume / game script** | 29 | 19% | Partly. Blowouts and shootouts are hard to forecast; even the market predicts volume weakly. |
| **Single big play** (one play of 30+ yds turned an in-range game into a miss) | 17 | 11% | No. It's the tail the ranges are meant to allow for. |
| **Player share / role** | 17 | 11% | **Yes. This is where better role data (snaps, routes, depth changes) helps most.** |

**By position:**
- **RBs** missed most on volume/script (19) and efficiency (15).
- **WRs** missed on efficiency (9) and big plays (8), and very rarely on share (2).
- **QBs** missed on availability (14) and efficiency (7).

**Patterns worth knowing:**
- **Script blowups:**
  - Mahomes (47 att, 382 yds) and Stafford (55 att, 390 yds) threw far more than any pregame estimate; their teams ran 79–80 plays.
  - Cooper Rush threw 17 times in a 31-point loss.
- **Efficiency spikes:**
  - Drake London (194 yds on 10 targets) and Davante Adams (195 on 10) were projected about right on targets and missed on yards per target (19.4 vs about 7).
  - Jacoby Brissett was the reverse: 3.4 yds per attempt.
- **Big plays:** Stroud, St. Brown, Tre Tucker and James Cook each had one 34–42-yd play that decided the miss.
- **Role:** Dalton Kincaid (29% target share vs 17% projected) and Josh Allen as a runner (14 carries vs 6.6) are the kind of misses better role inputs could reduce.

### Full list of misses (with reasons)

#### Team volume / game script (29)

| Wk | Team | Player | Stat | Proj (10–90) | Actual | Why it missed |
|---|---|---|---|---|---|---|
| 2 | KC | Patrick Mahomes | pass yds | 231 (140–330) | 382 | 47 attempts vs 32.4 proj; team ran 79 plays (62 proj), final margin +3 (model +2.6) |
| 3 | LAR | Matthew Stafford | pass yds | 243 (156–332) | 390 | 55 attempts vs 31.9 proj; team ran 80 plays (61 proj), final margin -4 (model +2.8) |
| 2 | ATL | Cooper Rush | pass yds | 210 (125–301) | 86 | 17 attempts vs 30.4 proj; team ran 67 plays (62 proj), final margin -31 (model +1.6) |
| 2 | HOU | Dalton Schultz | rec yds | 40 (10–77) | 140 | 14 targets vs 6.3 proj; team ran 76 plays (63 proj), final margin -14 (model +3.2) |
| 2 | KC | Travis Kelce | rec yds | 37 (7–75) | 101 | 11 targets vs 5.0 proj; team ran 79 plays (62 proj), final margin +3 (model +2.6) |
| 2 | MIN | Aaron Jones Sr. | rush yds | 41 (14–73) | 105 | 23 carries vs 9.9 proj; team ran 50 plays (62 proj), final margin +6 (model -0.7) |
| 2 | PHI | Saquon Barkley | rush yds | 67 (29–110) | 9 | 4 carries vs 15.7 proj; team ran 72 plays (61 proj), final margin +4 (model +6.5) |
| 3 | ARI | Jeremiyah Love | rush yds | 35 (11–64) | 90 | 21 carries vs 8.7 proj; team ran 81 plays (61 proj), final margin -6 (model -7.9) |
| 2 | HOU | David Montgomery | rush yds | 62 (26–105) | 10 | 6 carries vs 14.1 proj; team ran 76 plays (63 proj), final margin -14 (model +3.2) |
| 2 | ARI | Kendrick Bourne | rec yds | 58 (16–107) | 11 | 3 targets vs 6.9 proj; team ran 47 plays (63 proj), final margin -24 (model -6.3) |
| 2 | GB | MarShawn Lloyd | rush yds | 66 (26–110) | 20 | 6 carries vs 15.3 proj; team ran 50 plays (62 proj), final margin +3 (model +2.8) |
| 2 | ATL | Bijan Robinson | rec yds | 54 (16–98) | 9 | 4 targets vs 7.9 proj; team ran 67 plays (62 proj), final margin -31 (model +1.6) |
| 3 | KC | Kenneth Walker III | rec yds | 46 (12–86) | 3 | 2 targets vs 6.9 proj; team ran 49 plays (63 proj), final margin +14 (model +6.5) |
| 3 | DAL | Javonte Williams | rush yds | 56 (22–95) | 98 | 19 carries vs 13.1 proj; team ran 71 plays (61 proj), final margin -3 (model -1.5) |
| 3 | NE | Hunter Henry | rec yds | 44 (11–83) | 5 | 2 targets vs 5.2 proj; team ran 60 plays (61 proj), final margin -29 (model +0.4) |
| 3 | PHI | Saquon Barkley | rush yds | 44 (13–81) | 82 | 15 carries vs 10.5 proj; team ran 47 plays (62 proj), final margin -20 (model -0.1) |
| 3 | SF | Christian McCaffrey | rush yds | 40 (13–71) | 75 | 15 carries vs 9.8 proj; team ran 49 plays (61 proj), final margin +6 (model +7.9) |
| 2 | PHI | Dallas Goedert | rec yds | 39 (8–78) | 4 | 3 targets vs 5.9 proj; team ran 72 plays (61 proj), final margin +4 (model +6.5) |
| 3 | ARI | Tyler Allgeier | rush yds | 34 (10–63) | -1 | 2 carries vs 8.7 proj; team ran 81 plays (61 proj), final margin -6 (model -7.9) |
| 3 | GB | MarShawn Lloyd | rush yds | 45 (15–80) | 11 | 4 carries vs 11.2 proj; team ran 62 plays (61 proj), final margin -21 (model +3.3) |
| 2 | ARI | Tyler Allgeier | rush yds | 42 (14–77) | 10 | 5 carries vs 11.1 proj; team ran 47 plays (63 proj), final margin -24 (model -6.3) |
| 3 | LAR | Blake Corum | rush yds | 47 (16–83) | 15 | 6 carries vs 9.3 proj; team ran 80 plays (61 proj), final margin -4 (model +2.8) |
| 2 | NE | Corey Kiner | rush yds | 22 (3–46) | 0 | 2 carries vs 5.2 proj; team ran 51 plays (62 proj), final margin +17 (model +2.7) |
| 2 | CIN | Joe Burrow | rush yds | 19 (0–43) | -1 | 1 carries vs 4.3 proj; team ran 58 plays (62 proj), final margin +14 (model -3.2) |
| 2 | HOU | Woody Marks | rec yds | 9 (0–24) | 27 | 6 targets vs 1.7 proj; team ran 76 plays (63 proj), final margin -14 (model +3.2) |
| 2 | PHI | Will Shipley | rush yds | 7 (0–19) | 24 | 7 carries vs 1.6 proj; team ran 72 plays (61 proj), final margin +4 (model +6.5) |
| 3 | JAX | Trevor Lawrence | rush yds | 8 (0–22) | 25 | 4 carries vs 1.9 proj; team ran 59 plays (61 proj), final margin +29 (model -0.4) |
| 2 | ATL | Brian Robinson Jr. | rec yds | 3 (0–10) | 16 | 2 targets vs 0.6 proj; team ran 67 plays (62 proj), final margin -31 (model +1.6) |
| 2 | GB | Chris Brooks | rec yds | 5 (0–13) | 15 | 2 targets vs 0.9 proj; team ran 50 plays (62 proj), final margin +3 (model +2.8) |

#### Efficiency (32)

| Wk | Team | Player | Stat | Proj (10–90) | Actual | Why it missed |
|---|---|---|---|---|---|---|
| 2 | ARI | Jacoby Brissett | pass yds | 250 (159–344) | 95 | 3.4 yds/attempt vs 7.2 proj (on 28 attempts; 34.9 proj) — per-touch yardage was the larger part of the miss |
| 3 | ATL | Drake London | rec yds | 48 (12–91) | 194 | 19.4 yds/target vs 7.5 proj (on 10 targets; 6.3 proj) — per-touch yardage was the larger part of the miss |
| 2 | LAR | Davante Adams | rec yds | 50 (12–95) | 195 | 19.5 yds/target vs 6.7 proj (on 10 targets; 7.4 proj) — per-touch yardage was the larger part of the miss |
| 3 | ATL | Bijan Robinson | rush yds | 59 (23–101) | 194 | 6.7 yds/carry vs 4.1 proj (on 29 carries; 14.4 proj) — per-touch yardage was the larger part of the miss |
| 2 | GB | Jordan Love | pass yds | 250 (158–348) | 145 | 5.0 yds/attempt vs 7.7 proj (on 29 attempts; 32.4 proj) — per-touch yardage was the larger part of the miss |
| 2 | CHI | Caleb Williams | pass yds | 237 (139–346) | 138 | 5.3 yds/attempt vs 7.4 proj (on 26 attempts; 32.1 proj) — per-touch yardage was the larger part of the miss |
| 2 | DAL | CeeDee Lamb | rec yds | 59 (14–114) | 153 | 17.0 yds/target vs 7.9 proj (on 9 targets; 7.5 proj) — per-touch yardage was the larger part of the miss |
| 3 | BUF | James Cook III | rush yds | 63 (26–106) | 154 | 6.4 yds/carry vs 4.3 proj (on 24 carries; 14.8 proj) — per-touch yardage was the larger part of the miss |
| 3 | PIT | Jaylen Warren | rush yds | 45 (16–79) | 127 | 7.5 yds/carry vs 4.1 proj (on 17 carries; 10.9 proj) — per-touch yardage was the larger part of the miss |
| 3 | DEN | Jaylen Waddle | rec yds | 75 (23–133) | 10 | 1.4 yds/target vs 8.7 proj (on 7 targets; 8.6 proj) — per-touch yardage was the larger part of the miss |
| 2 | NYG | Malik Nabers | rec yds | 63 (20–114) | 1 | 0.3 yds/target vs 8.3 proj (on 4 targets; 7.6 proj) — per-touch yardage was the larger part of the miss |
| 3 | LAR | Kyren Williams | rec yds | 16 (0–38) | 70 | 10.0 yds/target vs 5.8 proj (on 7 targets; 2.8 proj) — per-touch yardage was the larger part of the miss |
| 2 | WSH | Jayden Daniels | rush yds | 17 (0–40) | 69 | 9.9 yds/carry vs 4.4 proj (on 7 carries; 3.9 proj) — per-touch yardage was the larger part of the miss |
| 3 | CAR | Tetairoa McMillan | rec yds | 66 (19–121) | 17 | 3.4 yds/target vs 8.8 proj (on 5 targets; 7.5 proj) — per-touch yardage was the larger part of the miss |
| 2 | LAR | Blake Corum | rush yds | 36 (11–66) | 79 | 6.6 yds/carry vs 4.5 proj (on 12 carries; 8.0 proj) — per-touch yardage was the larger part of the miss |
| 2 | LAC | Quentin Johnston | rec yds | 45 (9–90) | 7 | 1.4 yds/target vs 7.6 proj (on 5 targets; 5.9 proj) — per-touch yardage was the larger part of the miss |
| 3 | CLE | KC Concepcion | rec yds | 46 (10–91) | 9 | 1.0 yds/target vs 8.6 proj (on 9 targets; 5.4 proj) — per-touch yardage was the larger part of the miss |
| 3 | NYG | Isaiah Likely | rec yds | 48 (15–87) | 13 | 2.6 yds/target vs 6.6 proj (on 5 targets; 7.3 proj) — per-touch yardage was the larger part of the miss |
| 3 | LAC | Keaton Mitchell | rush yds | 19 (2–39) | 52 | 6.5 yds/carry vs 4.3 proj (on 8 carries; 4.3 proj) — per-touch yardage was the larger part of the miss |
| 2 | IND | Keenan Allen | rec yds | 38 (7–77) | 5 | 1.0 yds/target vs 6.5 proj (on 5 targets; 5.8 proj) — per-touch yardage was the larger part of the miss |
| 2 | TB | Bucky Irving | rec yds | 26 (2–57) | 1 | 0.3 yds/target vs 6.0 proj (on 4 targets; 4.4 proj) — per-touch yardage was the larger part of the miss |
| 2 | HOU | C.J. Stroud | rush yds | 6 (0–19) | 29 | 9.7 yds/carry vs 4.4 proj (on 3 carries; 1.5 proj) — per-touch yardage was the larger part of the miss |
| 3 | BAL | Justice Hill | rush yds | 12 (0–28) | 33 | 6.6 yds/carry vs 4.3 proj (on 5 carries; 2.7 proj) — per-touch yardage was the larger part of the miss |
| 2 | ATL | Cooper Rush | rush yds | 0 (0–0) | 20 | 10.0 yds/carry vs 4.7 proj (on 2 carries; 0.0 proj) — per-touch yardage was the larger part of the miss |
| 3 | PHI | Saquon Barkley | rec yds | 17 (0–41) | -2 | -1.0 yds/target vs 6.1 proj (on 2 targets; 2.7 proj) — per-touch yardage was the larger part of the miss |
| 3 | TB | Kenny Gainwell | rush yds | 14 (0–31) | -4 | -1.3 yds/carry vs 4.0 proj (on 3 carries; 3.4 proj) — per-touch yardage was the larger part of the miss |
| 2 | CAR | Jonathon Brooks | rec yds | 12 (0–30) | -5 | -5.0 yds/target vs 5.8 proj (on 1 targets; 2.0 proj) — per-touch yardage was the larger part of the miss |
| 2 | LAC | Keaton Mitchell | rec yds | 4 (0–12) | 15 | 15.0 yds/target vs 5.9 proj (on 1 targets; 0.7 proj) — per-touch yardage was the larger part of the miss |
| 2 | LAR | Blake Corum | rec yds | 4 (0–11) | 13 | 13.0 yds/target vs 5.5 proj (on 1 targets; 0.7 proj) — per-touch yardage was the larger part of the miss |
| 3 | LAC | Keaton Mitchell | rec yds | 4 (0–13) | -5 | -1.7 yds/target vs 5.8 proj (on 3 targets; 0.7 proj) — per-touch yardage was the larger part of the miss |
| 2 | JAX | Bhayshul Tuten | rec yds | 6 (0–19) | -3 | -1.5 yds/target vs 6.7 proj (on 2 targets; 0.9 proj) — per-touch yardage was the larger part of the miss |
| 2 | LAR | Matthew Stafford | rush yds | 6 (0–19) | -1 | -0.3 yds/carry vs 4.0 proj (on 4 carries; 1.5 proj) — per-touch yardage was the larger part of the miss |

#### Player share / role (17)

| Wk | Team | Player | Stat | Proj (10–90) | Actual | Why it missed |
|---|---|---|---|---|---|---|
| 2 | WSH | Jayden Daniels | pass yds | 211 (128–300) | 96 | 17 attempts vs 31.3 proj while team volume was near projection (share of team dropbacks, not team volume) |
| 2 | BUF | Dalton Kincaid | rec yds | 45 (9–86) | 95 | 8 targets vs 5.0 proj while team volume was near projection (target share 29% vs 17% proj) |
| 3 | BUF | Khalil Shakir | rec yds | 56 (13–109) | 6 | 3 targets vs 6.5 proj while team volume was near projection (target share 12% vs 21% proj) |
| 2 | BUF | Josh Allen | rush yds | 29 (5–59) | 69 | 14 carries vs 6.6 proj while team volume was near projection (carry share 39% vs 29% proj) |
| 3 | MIA | Malik Willis | rush yds | 19 (2–41) | 56 | 9 carries vs 4.1 proj while team volume was near projection (carry share 29% vs 16% proj) |
| 2 | DET | Jahmyr Gibbs | rec yds | 27 (4–56) | 61 | 8 targets vs 4.7 proj while team volume was near projection (target share 21% vs 15% proj) |
| 3 | DET | Jahmyr Gibbs | rec yds | 31 (6–62) | 65 | 8 targets vs 5.1 proj while team volume was near projection (target share 26% vs 17% proj) |
| 2 | DEN | Pat Bryant | rec yds | 33 (2–71) | 0 | 1 targets vs 4.6 proj while team volume was near projection (target share 3% vs 14% proj) |
| 2 | WSH | Rachaad White | rec yds | 9 (0–23) | 40 | 6 targets vs 1.9 proj while team volume was near projection (target share 18% vs 7% proj) |
| 2 | MIA | Malik Willis | rush yds | 37 (9–72) | 6 | 2 carries vs 8.3 proj while team volume was near projection (carry share 7% vs 33% proj) |
| 3 | MIA | Ollie Gordon II | rush yds | 11 (0–28) | 41 | 17 carries vs 2.8 proj while team volume was near projection (carry share 55% vs 13% proj) |
| 3 | NO | Travis Etienne Jr. | rush yds | 29 (6–55) | 57 | 13 carries vs 6.5 proj while team volume was near projection (carry share 46% vs 30% proj) |
| 3 | CLE | Raheim Sanders | rec yds | 9 (0–23) | 34 | 5 targets vs 1.4 proj while team volume was near projection (target share 17% vs 5% proj) |
| 2 | LAC | Justin Herbert | rush yds | 26 (4–52) | 2 | 3 carries vs 5.6 proj while team volume was near projection (carry share 9% vs 24% proj) |
| 3 | MIN | Aaron Jones Sr. | rec yds | 11 (0–29) | 34 | 6 targets vs 2.1 proj while team volume was near projection (target share 24% vs 9% proj) |
| 3 | DET | Sione Vaki | rush yds | 4 (0–12) | 26 | 6 carries vs 1.0 proj while team volume was near projection (carry share 20% vs 4% proj) |
| 3 | MIA | Ollie Gordon II | rec yds | 4 (0–13) | 14 | 3 targets vs 0.6 proj while team volume was near projection (target share 9% vs 3% proj) |

#### Single big play (17)

| Wk | Team | Player | Stat | Proj (10–90) | Actual | Why it missed |
|---|---|---|---|---|---|---|
| 2 | HOU | C.J. Stroud | pass yds | 236 (144–329) | 353 | one 35-yd play; without it 318 yds would have been inside the range |
| 2 | DET | Amon-Ra St. Brown | rec yds | 63 (12–124) | 142 | one 34-yd play; without it 108 yds would have been inside the range |
| 2 | LV | Tre Tucker | rec yds | 41 (7–83) | 119 | one 42-yd play; without it 77 yds would have been inside the range |
| 2 | BUF | James Cook III | rush yds | 65 (28–107) | 135 | one 35-yd play; without it 100 yds would have been inside the range |
| 3 | LAR | Davante Adams | rec yds | 71 (21–130) | 137 | one 49-yd play; without it 88 yds would have been inside the range |
| 3 | GB | Matthew Golden | rec yds | 43 (4–93) | 100 | one 45-yd play; without it 55 yds would have been inside the range |
| 2 | CLE | Denzel Boston | rec yds | 43 (8–87) | 95 | one 55-yd play; without it 40 yds would have been inside the range |
| 3 | DET | Isaac TeSlaa | rec yds | 14 (0–38) | 66 | one 49-yd play; without it 17 yds would have been inside the range |
| 3 | MIN | Jordan Addison | rec yds | 41 (7–85) | 90 | one 41-yd play; without it 49 yds would have been inside the range |
| 2 | NYJ | Breece Hall | rec yds | 16 (0–39) | 63 | one 43-yd play; without it 20 yds would have been inside the range |
| 2 | CHI | D'Andre Swift | rec yds | 11 (0–28) | 54 | one 32-yd play; without it 22 yds would have been inside the range |
| 2 | TB | Bucky Irving | rush yds | 50 (18–86) | 89 | one 38-yd play; without it 51 yds would have been inside the range |
| 3 | PIT | Roman Wilson | rec yds | 23 (0–54) | 60 | one 38-yd play; without it 22 yds would have been inside the range |
| 3 | LV | Mike Washington Jr. | rush yds | 18 (2–37) | 54 | one 36-yd play; without it 18 yds would have been inside the range |
| 3 | PIT | Jaylen Warren | rec yds | 21 (0–48) | 49 | one 30-yd play; without it 19 yds would have been inside the range |
| 3 | NYG | Cam Skattebo | rec yds | 15 (0–35) | 40 | one 30-yd play; without it 10 yds would have been inside the range |
| 3 | SF | Brock Purdy | rush yds | 14 (0–33) | 34 | one 35-yd play; without it -1 yds would have been inside the range |

#### Availability (54)

| Wk | Team | Player | Stat | Proj (10–90) | Actual | Why it missed |
|---|---|---|---|---|---|---|
| 3 | CHI | Caleb Williams | pass yds | 222 (136–315) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | SEA | Drew Lock | pass yds | 222 (128–324) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | NYG | Jaxson Dart | pass yds | 221 (134–314) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | WSH | Jayden Daniels | pass yds | 215 (133–303) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | ATL | Cooper Rush | pass yds | 213 (134–301) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | NYG | Jaxson Dart | pass yds | 232 (150–319) | 20 | workload collapsed (5 att vs 32 proj) — early exit, benching or injury |
| 3 | MIN | Carson Wentz | pass yds | 210 (130–299) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | LAR | Puka Nacua | rec yds | 86 (30–152) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | BAL | Zay Flowers | rec yds | 80 (24–146) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | BUF | DJ Moore | rec yds | 73 (18–140) | 0 | workload collapsed (1 car + 0 tgt vs 8.2 proj) — early exit, benching or injury |
| 2 | HOU | Nico Collins | rec yds | 67 (21–122) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | NYJ | Adonai Mitchell | rec yds | 61 (11–124) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | MIA | De'Von Achane | rush yds | 70 (33–112) | 17 | workload collapsed (3 car + 1 tgt vs 20.9 proj) — early exit, benching or injury |
| 2 | MIN | Jordan Mason | rush yds | 47 (16–83) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | JAX | Brian Thomas Jr. | rec yds | 49 (11–97) | 8 | workload collapsed (0 car + 1 tgt vs 6.7 proj) — early exit, benching or injury |
| 3 | MIA | Caleb Douglas | rec yds | 41 (7–84) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | CLE | Jerry Jeudy | rec yds | 40 (7–84) | 0 | workload collapsed (0 car + 1 tgt vs 5.7 proj) — early exit, benching or injury |
| 3 | MIA | De'Von Achane | rec yds | 39 (11–73) | 0 | workload collapsed (3 car + 1 tgt vs 20.9 proj) — early exit, benching or injury |
| 3 | MIN | Jordan Mason | rush yds | 37 (11–69) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | CIN | Mike Gesicki | rec yds | 33 (4–68) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | NYG | Jaxson Dart | rush yds | 33 (6–63) | 0 | workload collapsed (5 att vs 32 proj) — early exit, benching or injury |
| 2 | NO | Noah Fant | rec yds | 32 (6–64) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | DEN | Jonah Coleman | rush yds | 31 (8–60) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | NE | A.J. Brown | rec yds | 31 (0–67) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | WSH | Dyami Brown | rec yds | 31 (3–65) | 0 | workload collapsed (0 car + 1 tgt vs 4.8 proj) — early exit, benching or injury |
| 2 | NO | Kendre Miller | rush yds | 30 (6–58) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | PIT | Rico Dowdle | rush yds | 29 (7–56) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | PHI | Tank Bigsby | rush yds | 27 (6–52) | 0 | workload collapsed (0 car + 1 tgt vs 6.8 proj) — early exit, benching or injury |
| 3 | MIA | DJ Herman | rec yds | 26 (3–54) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | BAL | Ja'Kobi Lane | rec yds | 25 (0–58) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | CAR | Jonathon Brooks | rush yds | 25 (5–50) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | CHI | Caleb Williams | rush yds | 24 (2–49) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | LAC | Charlie Kolar | rec yds | 23 (0–49) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | WSH | Jayden Daniels | rush yds | 23 (1–50) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | DEN | RJ Harvey | rush yds | 23 (4–46) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | DEN | RJ Harvey | rec yds | 21 (1–46) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | GB | Chris Brooks | rush yds | 19 (3–40) | 0 | workload collapsed (0 car + 1 tgt vs 5.9 proj) — early exit, benching or injury |
| 3 | NYG | Devin Singletary | rush yds | 17 (2–37) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | PIT | Rico Dowdle | rec yds | 13 (0–33) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | DEN | Jonah Coleman | rec yds | 13 (0–30) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | DAL | Emari Demercado | rush yds | 12 (0–30) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | NYG | Jaxson Dart | rush yds | 12 (0–29) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | MIN | Carson Wentz | rush yds | 10 (0–26) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | CAR | Jonathon Brooks | rec yds | 8 (0–23) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | NYG | Devin Singletary | rec yds | 7 (0–20) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | ATL | Cooper Rush | rush yds | 5 (0–16) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | MIN | Jordan Mason | rec yds | 5 (0–14) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | BUF | Ray Davis | rush yds | 4 (0–12) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | MIN | Jordan Mason | rec yds | 4 (0–12) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | DAL | Emari Demercado | rec yds | 3 (0–10) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 2 | NO | Kendre Miller | rec yds | 3 (0–11) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | BUF | Ray Davis | rec yds | 3 (0–10) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | SEA | Drew Lock | rush yds | 3 (-1–13) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |
| 3 | MIA | DJ Herman | rush yds | 3 (0–10) | no stats | no box-score row (inactive/injured — participation unverified; blind mode has no injury report) |

## Game-by-game (v1.2, weeks 2–3)

How to read the table:
- **Final:** actual score, with the model's blind expected points in parentheses.
- **Projection columns:** "proj → actual".
- **In range:** share of the game's yardage props that landed within the 10–90 range.
- **Misses:** each out-of-range miss, with its cause.

| Wk | Game (ID) | Final (model exp.) | QBs pass yds proj→act | RB1 rush yds | Top receiver rec yds | Yardage MAE | In range | Out-of-range misses (cause) |
|---|---|---|---|---|---|---|---|---|
| 2 | DET @ BUF (401872932) | 31–41 (26–27) | Goff 236→327; Allen 264→248 | Gibbs 86→52; Cook 65→135 | Brown 63→142; Kincaid 45→95 | 31.6 | 67% | Allen rush (player share / role); Cook rush (single big play); Moore rec (availability); Kincaid rec (player share / role); Gibbs rec (player share / role); Brown rec (single big play) |
| 2 | CAR @ ATL (401872933) | 34–3 (22–24) | Young 242→287; Rush 210→86 | Hubbard 42→53; Robinson 91→72 | McMillan 59→101; London 60→51 | 25.9 | 71% | Rush pass (team volume / game script); Rush rush (efficiency); Robinson rec (team volume / game script); Robinson rec (team volume / game script); Brooks rec (efficiency) |
| 2 | CIN @ HOU (401872934) | 20–6 (23–26) | Burrow 239→207; Stroud 236→353 | Brown 60→80; Montgomery 62→10 | Higgins 49→95; Schultz 40→140 | 32.1 | 63% | Stroud pass (single big play); Stroud rush (efficiency); Montgomery rush (team volume / game script); Marks rec (team volume / game script); Collins rec (availability); Schultz rec (team volume / game script); Burrow rush (team volume / game script); Gesicki rec (availability) |
| 2 | CLE @ TB (401872935) | 23–19 (21–24) | Watson 233→238; Mayfield 221→182 | Judkins 52→21; Irving 50→89 | Boston 43→95; Otton 32→38 | 20.1 | 78% | Irving rush (single big play); Irving rec (efficiency); Boston rec (single big play); Jeudy rec (availability) |
| 2 | GB @ NYJ (401872936) | 20–17 (24–22) | Love 250→145; Smith 219→247 | Lloyd 66→20; Hall 64→29 | Golden 43→58; Mitchell 40→63 | 23.1 | 78% | Hall rec (single big play); Love pass (efficiency); Lloyd rush (team volume / game script); Brooks rec (team volume / game script) |
| 2 | MIN @ CHI (401872937) | 9–3 (25–26) | Wentz 226→143; Williams 237→138 | Mason 47→no stats; Swift 54→45 | Jefferson 79→55; Raymond 74→40 | 26.9 | 81% | Williams pass (efficiency); Swift rec (single big play); Mason rush (availability); Mason rec (availability); Jones rush (team volume / game script) |
| 2 | NO @ BAL (401872938) | 24–17 (22–26) | Shough 257→252; Jackson 242→235 | Etienne 38→25; Henry 87→68 | Olave 74→86; Andrews 37→49 | 11.4 | 100% | Flowers rec (availability); Lane rec (availability); Miller rush (availability); Miller rec (availability); Fant rec (availability) |
| 2 | PHI @ TEN (401872939) | 24–20 (25–18) | Hurts 220→264; Ward 209→183 | Barkley 67→9; Pollard 56→64 | Smith 63→117; Tate 47→27 | 23.5 | 83% | Barkley rush (team volume / game script); Shipley rush (team volume / game script); Goedert rec (team volume / game script) |
| 2 | JAX @ DEN (401872940) | 13–20 (25–20) | Lawrence 241→189; Nix 213→288 | Tuten 41→65; Dobbins 49→36 | Washington 53→98; Engram 28→17 | 21.0 | 88% | Harvey rush (availability); Harvey rec (availability); Bryant rec (player share / role); Tuten rec (efficiency) |
| 2 | LV @ LAC (401872941) | 26–14 (19–22) | Cousins 214→253; Herbert 225→192 | Jeanty 65→48; Hampton 56→94 | Mayer 33→23; Harris 28→53 | 22.9 | 78% | Herbert rush (player share / role); Mitchell rec (efficiency); Johnston rec (efficiency); Tucker rec (single big play) |
| 2 | MIA @ SF (401872942) | 13–35 (20–25) | Willis 228→197; Purdy 232→287 | Achane 67→74; McCaffrey 48→23 | Washington 36→43; Evans 48→54 | 19.1 | 94% | Willis rush (player share / role) |
| 2 | SEA @ ARI (401872943) | 31–7 (26–19) | Lock 224→235; Brissett 250→95 | Price 51→52; Allgeier 42→10 | Smith-Njigba 103→155; McBride 68→41 | 23.5 | 83% | Brissett pass (efficiency); Allgeier rush (team volume / game script); Bourne rec (team volume / game script) |
| 2 | WSH @ DAL (401872944) | 20–37 (25–26) | Daniels 211→96; Prescott 233→279 | Croskey-Merritt 51→43; Williams 64→30 | Diggs 67→47; Lamb 59→153 | 26.5 | 78% | Lamb rec (efficiency); Daniels pass (player share / role); Daniels rush (efficiency); White rec (player share / role) |
| 2 | IND @ KC (401872945) | 30–33 (22–25) | Jones 224→210; Mahomes 231→382 | Taylor 94→92; Walker 70→117 | Pierce 47→11; Kelce 37→101 | 26.8 | 82% | Mahomes pass (team volume / game script); Kelce rec (team volume / game script); Allen rec (efficiency) |
| 2 | PIT @ NE (401872946) | 3–20 (21–23) | Rodgers 220→187; Maye 234→208 | Warren 53→43; Stevenson 51→43 | Wilson 25→28; Hollins 38→18 | 14.9 | 94% | Kiner rush (team volume / game script); Brown rec (availability) |
| 2 | NYG @ LAR (401872947) | 6–28 (22–25) | Dart 232→20; Stafford 238→327 | Skattebo 46→36; Williams 51→85 | Likely 54→33; Adams 50→195 | 43.9 | 56% | Stafford rush (efficiency); Corum rush (efficiency); Corum rec (efficiency); Nacua rec (availability); Adams rec (efficiency); Dart pass (availability); Dart rush (availability); Nabers rec (efficiency) |
| 3 | ATL @ GB (401872948) | 35–14 (20–23) | Rush 213→no stats; Love 242→312 | Robinson 59→194; Lloyd 45→11 | London 48→194; Golden 43→100 | 34.6 | 71% | Lloyd rush (team volume / game script); Brooks rush (availability); Golden rec (single big play); Rush pass (availability); Rush rush (availability); Robinson rush (efficiency); London rec (efficiency) |
| 3 | CAR @ CLE (401872949) | 18–21 (23–21) | Young 238→291; Watson 232→144 | Hubbard 52→82; Judkins 59→70 | Coker 53→18; Boston 53→41 | 26.6 | 80% | Sanders rec (player share / role); Concepcion rec (efficiency); Brooks rush (availability); Brooks rec (availability); McMillan rec (efficiency) |
| 3 | CIN @ PIT (401872950) | 27–30 (23–23) | Burrow 231→282; Rodgers 221→292 | Brown 72→61; Warren 45→127 | Chase 71→98; Wilson 23→60 | 27.9 | 80% | Warren rush (efficiency); Warren rec (single big play); Dowdle rush (availability); Dowdle rec (availability); Wilson rec (single big play) |
| 3 | HOU @ IND (401872951) | 17–19 (25–24) | Stroud 260→167; Jones 225→235 | Montgomery 46→33; Taylor 83→68 | Hutchinson 42→51; Downs 48→77 | 17.4 | 100% | — |
| 3 | KC @ MIA (401872952) | 24–10 (26–19) | Mahomes 234→246; Willis 220→210 | Walker 83→70; Achane 70→17 | Kelce 49→59; Washington 36→56 | 21.0 | 60% | Willis rush (player share / role); Achane rush (availability); Achane rec (availability); Gordon rush (player share / role); Gordon rec (player share / role); Douglas rec (availability); Herman rush (availability); Herman rec (availability); Walker rec (team volume / game script) |
| 3 | LAC @ BUF (401872953) | 16–24 (22–26) | Herbert 231→226; Allen 255→204 | Hampton 64→56; Cook 63→154 | McConkey 42→66; Kincaid 53→38 | 22.4 | 73% | Cook rush (efficiency); Davis rush (availability); Davis rec (availability); Shakir rec (player share / role); Mitchell rush (efficiency); Mitchell rec (efficiency); Kolar rec (availability) |
| 3 | NYJ @ DET (401872954) | 24–31 (23–27) | Smith 235→321; Goff 244→269 | Hall 64→32; Gibbs 81→99 | Wilson 73→107; LaPorta 50→44 | 22.8 | 82% | Gibbs rec (player share / role); Vaki rush (player share / role); TeSlaa rec (single big play); Mitchell rec (availability) |
| 3 | SEA @ WSH (401872955) | 31–33 (27–18) | Lock 222→no stats; Daniels 215→no stats | Price 42→15; Croskey-Merritt 42→36 | Smith-Njigba 102→128; McLaurin 50→77 | 15.8 | 92% | Daniels pass (availability); Daniels rush (availability); Brown rec (availability); Lock pass (availability); Lock rush (availability) |
| 3 | TEN @ NYG (401872956) | 7–12 (21–24) | Ward 208→181; Dart 221→no stats | Pollard 56→74; Skattebo 46→60 | Tate 47→58; Nabers 53→26 | 18.9 | 86% | Dart pass (availability); Dart rush (availability); Skattebo rec (single big play); Singletary rush (availability); Singletary rec (availability); Likely rec (efficiency) |
| 3 | NE @ JAX (401872957) | 6–35 (22–21) | Maye 234→199; Lawrence 230→182 | Stevenson 32→22; Tuten 44→73 | Douglas 27→38; Washington 64→40 | 19.0 | 82% | Lawrence rush (team volume / game script); Thomas rec (availability); Henry rec (team volume / game script) |
| 3 | ARI @ SF (401872958) | 30–36 (19–27) | Brissett 220→280; Purdy 234→297 | Love 35→90; McCaffrey 40→75 | Wilson 46→89; Samuel 44→80 | 25.9 | 76% | Purdy rush (single big play); McCaffrey rush (team volume / game script); Love rush (team volume / game script); Allgeier rush (team volume / game script) |
| 3 | MIN @ TB (401872959) | 23–16 (23–20) | Wentz 210→no stats; Mayfield 219→217 | Jones 53→58; Irving 53→46 | Jefferson 68→32; Egbuka 46→62 | 16.5 | 79% | Gainwell rush (efficiency); Wentz pass (availability); Wentz rush (availability); Jones rec (player share / role); Mason rush (availability); Mason rec (availability); Addison rec (single big play) |
| 3 | BAL @ DAL (401872960) | 34–31 (27–26) | Jackson 241→186; Prescott 244→276 | Henry 84→89; Williams 56→98 | Bateman 45→37; Lamb 68→112 | 21.8 | 87% | Williams rush (team volume / game script); Demercado rush (availability); Demercado rec (availability); Hill rush (efficiency) |
| 3 | LV @ NO (401872961) | 35–27 (20–21) | Cousins 208→248; Shough 250→255 | Jeanty 72→56; Etienne 29→57 | Tucker 46→43; Olave 75→107 | 13.6 | 88% | Etienne rush (player share / role); Washington rush (single big play) |
| 3 | LAR @ DEN (401872962) | 26–30 (23–20) | Stafford 243→390; Nix 227→186 | Williams 57→88; Dobbins 44→49 | Adams 71→137; Sutton 36→46 | 33.0 | 67% | Coleman rush (availability); Coleman rec (availability); Waddle rec (efficiency); Stafford pass (team volume / game script); Williams rec (efficiency); Corum rush (team volume / game script); Adams rec (single big play) |
| 3 | PHI @ CHI (401872963) | 7–27 (23–24) | Hurts 222→153; Williams 222→no stats | Barkley 44→82; Swift 55→84 | Smith 65→65; Raymond 53→90 | 19.8 | 79% | Williams pass (availability); Williams rush (availability); Barkley rush (team volume / game script); Barkley rec (efficiency); Bigsby rush (availability) |

**Best-predicted games:** NO @ BAL (yardage MAE 11.4), LV @ NO (13.6), PIT @ NE (14.9).
**Worst:** NYG @ LAR (43.9), ATL @ GB (34.6), LAR @ DEN (33.0).

## Reproduce

```bash
node --no-warnings scripts/fit_v12.js
```

```bash
npm run blind -- --leagues nfl
```

```bash
node --no-warnings scripts/compare_batches.mjs 3 4
```

```bash
node --no-warnings scripts/nfl_diagnose.js --batch 4
```

```bash
node --no-warnings scripts/nfl_misses.mjs 4
```

```bash
node --no-warnings scripts/nfl_games_table.mjs 4
```

What each step does:
1. Fits the v1.2 constants on 2024→2025 history.
2. Freezes, predicts, seals and scores a new blind batch.
3. Compares batches #3 and #4 on identical rows.
4. Rebuilds the batch (it reproduces the sealed predictions exactly).
5. Classifies every out-of-range miss.
6. Builds the game-by-game table.
