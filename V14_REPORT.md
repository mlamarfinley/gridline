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
