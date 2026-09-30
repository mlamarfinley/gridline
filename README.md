# Gridline: NFL + college football projections ledger

Gridline is a local dashboard for weekly NFL and FBS slates. It shows book odds and a book-implied score for each game. For each team it picks role players from evidence, projects their stats with ranges, and gives an explained, experimental probability against a stated threshold. Every pregame forecast is written to an append-only SQLite ledger and scored after the game.

It uses no invented data. Anything the free sources don't provide is labeled unavailable, and nothing is filled in with made-up values.

## Setup

Requires **Node ≥ 22.13** (built with Node 24). There are **no npm dependencies**: the app uses `node:sqlite`, `node:http`, `fetch`, and `node:test`.

```bash
npm start          # http://localhost:5317  (binds 127.0.0.1 only)
npm test           # 40 offline tests (fixtures in test/fixtures)
npm run snapshot -- --league nfl [--week 4]     # immutable pregame snapshots for a slate
npm run settle [-- --all]                        # pull final box scores; --all re-settles (changes logged)
npm run backtest -- --league nfl --week 2,3      # rebuild finished games with a strict kickoff cutoff
```

Optional keys go in `.env` (see `.env.example`):
- `ODDS_API_KEY` adds over/under **prices** for NFL player props from The Odds API.
- `CFBD_API_KEY` adds CollegeFootballData "line yards" (a published OL/DL method).
- `AUTO_SNAPSHOT=0` turns off the automatic pregame snapshot taken on matchup view. That snapshot is limited to one every 6 hours per game, and identical content is skipped.

State lives in `data/`: `ledger.sqlite` (the ledger) and `cache/` (the HTTP cache). Delete `cache/` to force fresh pulls. **Never delete `ledger.sqlite`** if you want the track record.

## Navigation

- **Back/Forward buttons.** The header's ‹ › buttons follow Gridline's own page history: slates, selected weeks, matchups and the ledger, for both leagues. Each button's tooltip and aria-label name the page it goes to. Back is disabled on the first Gridline page in the tab, so the buttons never leave the app. Forward is disabled at the newest page.
- **Browser behavior.** Hash deep links (`#/nfl/game/<id>`, `#/cfb?week=4`, `#/ledger`), the browser's own Back/Forward, and refresh all keep working. Navigating somewhere new after going back discards the old forward pages, just like a browser does.
- **Implementation.** The logic lives in `public/nav.js` (tested in `test/nav.test.js`). The history is stored per tab in sessionStorage.

## Data sources

| Need | Source | Notes |
|---|---|---|
| Schedule, status, kickoff, odds (spread/total/ML) | ESPN scoreboard + summary `pickcenter` | DraftKings via ESPN. Retrieval timestamp shown. After kickoff it shows the closing line. |
| Box scores (incl. NFL targets, fumbles, kicking) | ESPN game summary | Final games cached permanently. |
| Play-by-play (game state, down/distance, explosives, who carried/was targeted) | ESPN summary `drives` | Players are parsed from play text (college uses jersey # + name). Attribution coverage is shown per team. |
| Injury report | ESPN summary `injuries` + roster injury field (NFL) | Shown as published. **College: none available.** |
| Rosters | ESPN team roster | Current-roster check for pregame roles. |
| Depth chart (starting QB, K, RB fallback) | ESPN core API (NFL only) | Not published for college. |
| Player prop lines | ESPN core API `propBets` (DraftKings) | **Lines only, no prices.** Prices need `ODDS_API_KEY`. |
| Prior-season game logs | ESPN athlete gamelog | Efficiency priors and last-five fill (bars drawn with a dashed outline). |
| Snap share | nflverse `snap_counts_<season>.csv` (PFR) | NFL only. |
| NFL league baselines | nflverse `stats_player_week_<prev season>.csv` | Measured at runtime; falls back to the priors in `src/config.js`. |
| Weather | Open-Meteo geocoding + hourly forecast | Outdoor venues, kickoff within 14 days. |

Every response carries provenance (source, URL, fetch time, cache/stale/error) and is listed on the matchup page. If a source fails, the last cached copy is served and marked **stale cache**. If nothing is cached, that input is shown as unavailable.

## Model (version `fbm-1.1.0`)

1. **Roles.** The NFL starting QB and K come from the ESPN depth chart, cross-checked against the last game's leading passer; any mismatch is flagged. RBs are the top two by recent carries + targets, and receivers are the top two WR/TE by targets (college: QB, two RBs, one receiver). A player must be on the current roster and not Out/Doubtful/IR. One "additional" card appears only when a non-core player had at least 15% target share or 25% carry share last game, or a sharply rising role.
2. **Game script.** The book spread gives the expected margin. A compressed normal distribution over the in-game margin produces weights for five script states (trail big / trail / close / lead / lead big). Each simulated game spends its first ~40% of plays "close" and then follows one sampled script.
3. **Opportunity (kept separate from efficiency).** Team plays = 0.65 × own pace + 0.35 × the opponent's plays faced, scaled mildly by the game total. Pass rate per script state comes from the team's own play-by-play, shrunk toward league priors, with the close-state rate blended with the early-down neutral pass rate (the down/distance signal). Each player's carry and target shares per script state come from his own splits, shrunk toward his overall share. This is how a trailing dual-threat back loses carries and gains targets, and only to the degree his measured role shows it.
4. **Availability.** Game weights combine recency with a penalty (×0.4) for each key teammate whose presence in that game differs from this week's expectation. So "without X" games dominate when X is out, and "with X" games dominate when X returns.
   - **NFL:** usage vacated by a player ruled out on the report is redistributed pro-rata, but only to the extent the sample doesn't already reflect his absence. Both cases are stated on the card.
   - **Returning players:** no workload cut is applied unless the published injury text contains restriction language (snap count, limited, etc.), quoted on the card. Without that, the range is widened.
   - **College:** there is no injury feed. A missing roster entry or box-score line is **never** treated as a confirmed absence and never triggers redistribution. Such notes are labeled unverified, and the range is widened.
5. **Efficiency.** The player's rate is shrunk toward his prior-season rate, which is shrunk toward the league rate, then scaled by the opponent's allowed rate (itself shrunk by sample size), plus weather effects.
6. **Explosives.** Player 10+/20+ run and 20+/40+ catch rates are multiplied by the opponent's allowed explosive rates, split by position (QB vs RB runs; RB/WR/TE catches) and shrunk. These shape the **tail/range** of the per-play yardage distribution; the mean stays anchored to efficiency.
7. **Simulation.** A seeded, play-by-play Monte Carlo (3,000 games) runs per team, so QB and receiver lines are jointly consistent and snapshots are reproducible. TD rates are calibrated so simulated team TDs match the book-implied points. College blowouts pull starters (55% of snaps when leading big, 80% when trailing big).
8. **Outputs.** Each stat gets a mean, 10th/50th/90th percentiles, a season average, and the last five games.
   - **Model P(stat > threshold)** uses the book line as the threshold if one exists, otherwise the season average. The **fair odds** shown are the model's own no-margin price, displayed separately from book odds.
   - These probabilities are labeled **experimental / uncalibrated** everywhere.

### Unit context (OL/DL)

No free public source publishes OL/DL grades, so none are shown. The dashboard shows unit-level **proxies** computed from ESPN play-by-play instead:
- rush success rate (40% / 60% / 100% of the distance needed on 1st / 2nd / 3rd–4th down);
- sack rate;
- the same metrics allowed by the defense.

Each proxy shows its sample size (`n`). These reflect the whole offense, the scheme and the opponents faced, not linemen alone. With `CFBD_API_KEY`, CFBD line yards are added for college.

## Ledger

- **Tables.** `runs` and `snapshots` hold forecasts. Database triggers **abort any UPDATE or DELETE**, and a `pregame` run is rejected unless it is created before kickoff with an input cutoff no later than kickoff. Each snapshot row stores game, player, stat, model version, input cutoff, latest input timestamp, projection, range, threshold, model probability, fair price, book line/price/source/timestamp, and projected opportunity and efficiency.
- **Duplicates.** A new run is written only when projections change, so old forecasts are never overwritten.
- **Results.** `game_results` and `actual_lines` hold final box scores. A re-settle writes corrections to `actual_revisions` rather than overwriting silently. College targets at settlement are derived from play-by-play, the same way the projections define them. A target count that can't be determined stays unknown; it is not counted as zero.
- **Evaluation.** Accuracy is reported by week, position and stat: MAE, bias, 10–90 coverage (80% nominal), Brier score, and a reliability table. **Pregame** snapshots and **backtests** are always separate.
- **In-sample weeks.** Weeks used while tuning a model version are listed in `DEV_WEEKS` (`src/config.js`) and marked **in-sample** in the UI. They are never presented as validation.
- **Misses.** Projections that land outside the 10–90 range get a descriptive comparison: workload vs projected, efficiency vs projected, final margin vs expected. Each is labeled "not a causal attribution".

## Known limitations

- Probabilities are **not calibrated**. Held-out results show overconfidence at the extremes (see `BUILD_REPORT.md`).
- **NFL week 1 (and any team's first game) can't be projected.** Roles need current-season usage, and last season's rosters aren't used to guess them. Those runs are stored with 0 rows.
- Retrospective views and backtests don't apply injury reports, depth charts or weather; today's versions would leak post-kickoff information. Their book lines are closing lines.
- Play attribution relies on ESPN play text. The rare unattributed or ambiguous plays count in team totals but not in player splits.
- "With/without" uses box-score appearance as the proxy for playing. A player active with zero stats looks absent.
- Coaching changes are not tracked. Tendencies are measured from the current season only.
- Weather effects and some fumble constants are heuristic model priors (documented in code), not fitted coefficients.
- College league baselines are configured priors, not measured league-wide rates.
- There is no demo mode. Without network access or a cache, inputs show as unavailable rather than being replaced with sample data.

## Blind historical evaluation (market-blind)

`npm run blind` (or the Ledger button) re-predicts **every completed game this season** in an isolated mode:
- **Inputs:** only games that finished before kickoff.
- **Excluded:** market data (spread, total, props), the target game's data, current rosters, injuries, depth charts and weather.
- **Freeze and seal:** parameters and code are hashed and frozen first. Predictions and per-game input manifests are sealed before any result or historical line is fetched; SQLite triggers enforce the order.
- **Historical lines:** these are ESPN-retained reconstructions and are reported separately. The strict archived-pregame tier is empty. No ROI is computed.

Results are in `BACKTEST_REPORT.md`; isolation poison tests are in `test/blind.test.js`. Other tools: `npm run gapscan -- --league nfl` scans the current slate for model–book gaps, and UPDATE_REPORT.md covers the theme, side-by-side layout, OUTLIER PICK and OL/DL grades.

## Public read-only site (GitHub Pages)

- **What:** `.github/workflows/pages.yml` rebuilds a static, read-only copy about every 6 hours (and on every push to `main`). The slates and matchups are rebuilt from fresh ESPN data.
- **Ledger pages:** they show whatever was last exported locally. To publish ledger/backtest updates, run `npm run export:ledger` and commit `static-data/`.
- **Read-only:** the public copy has no write endpoints. Recording, settling and backtests only run in the local app (`npm start`).
- **Local preview:** run `npm run export:site`, then serve `site/`.
