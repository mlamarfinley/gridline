# BUILD_REPORT: Gridline football dashboard

**Built:** 2026-09-30 · **Model version:** `fbm-1.1.0` (the earlier `fbm-1.0.0` runs are preserved in the ledger)

**Preview:** http://localhost:5317. It is running now, bound to 127.0.0.1 only; restart it with `npm start`.
- Slate: `#/nfl`, `#/cfb`
- Matchup: e.g. `#/nfl/game/401872971` (NE @ BUF, week 4)
- Ledger: `#/ledger`

## What was delivered

- **Weekly slate.** NFL and College (FBS) tabs, a week selector built from ESPN's calendar, all games with Eastern kickoff times and status, and the spread, total, moneyline and book-implied score for each game.
- **Matchup page.**
  - **Header:** spread/total/ML with prices where the feed has them, no-vig ML probabilities, the book-implied score, and the retrieval timestamp plus data cutoff.
  - **Game script:** a scenario spectrum for the two teams.
  - **Callouts:** a standout callout, shown only when the model–book gap is at least 0.3 SD; for college, an RB-upside callout.
  - **Availability:** the published injury report plus role notes.
  - **Players:** cards for each team, a compact kicker row, a team-context table (pace, down/distance tendency, explosives allowed by position, line proxies), and a disclosure list.
  - **Sources:** a full provenance table.
- **Player cards.**
  - **Compact view:** a stat selector drives the projection, the 10–90 range, the season average, the book line and price (price marked n/a when the feed lacks it), and a last-five SVG chart with values, opponent abbreviations, the line, and a projection whisker. Model P(over) and fair odds are labeled experimental.
  - **Details:** all spec stats, opportunity vs efficiency, simulated splits by script, with/without teammates, usage-share trend and snap share.
- **NFL stat sets per spec:**
  - QB: 10 stats.
  - RB: 11 stats.
  - WR/TE: 6 stats.
  - K: kicking points, XP made, FG made.
- **College stat sets:**
  - QB: passing yards, rushing yards, INTs.
  - RB: rushing yards, receiving yards, carries, TDs.
  - Receiver: receiving yards, TDs, targets. Targets are derived from play-by-play and disclosed as such.
- **Ledger.** Append-only SQLite with immutable snapshots enforced by triggers, pregame-only-before-kickoff enforcement, settlement, MAE/bias/coverage/Brier by week × position × stat, a reliability table, held-out vs in-sample separation, and descriptive miss explanations. Background jobs (snapshot, settle, backtest) can be run from the UI or the CLI.
- **Security.** The server binds 127.0.0.1. Requests with a non-local Host are rejected (403), and cross-origin POSTs are rejected (403). Verified with curl: bad Host → 403, cross-origin POST → 403, local GET → 200.

## Tests

**Result: 40/40 passing** (`npm test`, ~0.14 s, fully offline using recorded ESPN fixtures).

| Area | Tests |
|---|---|
| Score math | implied score for home and away favorites; sum = total and difference = spread (this caught and fixed a 0.1-rounding bug: 51.5/7 had produced 51.6); null on a missing line; American↔probability; no-vig; parsing |
| Scenario shifts | weights sum to 1, move with the spread and are symmetric; a trailing RB loses carries and gains targets per his splits; QB volume rises when trailing; college blowout pulls starters |
| Model | run-yardage mean anchored to efficiency while the explosive tail widens; seeded reproducibility; quantile/threshold probabilities |
| Data cutoff | only final games strictly before kickoff are used; a post-cutoff game's summary is **never requested** |
| Immutable snapshots | UPDATE/DELETE blocked by triggers; pregame refused after kickoff, in retro mode, or with post-kickoff inputs; a raw SQL insert is blocked; duplicates skipped; changed content appends a new run and the old row is unchanged; backtests kept separate |
| Missing data | college targets absent rather than 0; unknown targets not zero-filled at settlement; DNP excluded from metrics; ratio stats null when undefined; missing odds → null; no invented restriction evidence |
| Roster counts | NFL 1 QB / 2 RB / 2 WR-TE / 1 K plus one justified extra; college 1/2/1 with no K; Out/IR/off-roster excluded; no guessed zero-usage player; college roster gap flagged as unverified with no redistribution |
| Parsers | box score (real fixtures), play attribution ≥95%, rushing-TD extra-point regression, reused college jerseys, game-state margin |
| Security | Host and Origin guard |

## Backtest and ledger results (honest reading)

Ledger contents at the time of writing:
- 152 runs and 8,871 snapshot rows.
- 17 **pregame** runs: all 16 NFL week-4 games plus 1 college game. These are the first true forecasts; they will be scored after this weekend (`npm run settle`).
- 570 actual-value revisions, logged when college targets were re-derived; the old values are preserved.

**Backtests** rebuild completed games using only pre-kickoff game data. They use closing lines and apply no injury, depth-chart or weather inputs. They are stored separately from pregame snapshots.

| Set | Status | n scored | 10–90 coverage (80% nominal) | Brier | Notes |
|---|---|---|---|---|---|
| NFL wk 3, `fbm-1.0.0` | **in-sample** (inspected to find bugs) | 1,447 | 82% | 0.231 | RB rush-yds coverage 59%, bias −5.8 |
| NFL wk 2–3, `fbm-1.1.0` | **in-sample / development**: used to choose the v1.1 variance and share-floor changes | 3,033 | 85% | 0.215 | RB rush yds: coverage 74%, bias −1.0 |
| College wk 4, `fbm-1.1.0` | **held-out** (run after v1.1 was frozen) | 2,005 | 81% | 0.228 | QB pass yds bias **+22.7** (over-projected); RB rush yds bias **−8.5**, coverage 73% |
| NFL wk 1 | not projectable | 0 | — | — | no current-season usage exists before week 1 |

**Probabilities are not calibrated.** On the held-out college week, the reliability table shows overconfidence:

| Predicted P(over) | Realized frequency |
|---|---|
| ≈ 0.68 | 0.50 |
| ≈ 0.90 | 0.53 |

The in-sample NFL weeks show the same pattern: 0.68 predicted → 0.50 realized, and 0.88 → 0.69. One held-out week is far too small to fit a calibration map, so none was applied. The UI labels every model probability "experimental · uncalibrated".

Per the admin checkpoint, model tuning stopped at v1.1. The weeks used for tuning are recorded in `DEV_WEEKS` and flagged "in-sample" in the Ledger UI. The Ledger's "held-out only" summary excludes them.

## Bugs found and fixed during the build

1. Rushing TDs were being dropped from play-by-play whenever the text also mentioned the extra point. This understated team plays and attempts. Fixed, with a regression test.
2. College rosters reuse jersey numbers across offense and defense, and the resolver trusted the jersey alone, which misattributed targets. It now disambiguates by name, and ambiguous cases are left unattributed.
3. College settlement zero-filled unpublished targets, which produced 5% "coverage". Targets are now play-by-play-derived and flagged, unknowns stay null, and the games were re-settled with revisions logged.
4. Implied-score rounding broke the invariant that the two scores sum to the total.
5. `node:sqlite` rejected `undefined` bindings; missing values are now stored as NULL.

## Limitations and unavailable inputs

- **OL/DL grades:** unavailable from any free source. Only play-by-play unit proxies are shown, and they are labeled as proxies.
- **Player-prop prices:** ESPN publishes DraftKings **lines only**. Prices need `ODDS_API_KEY`; that code path is written but **untested without a key**. The same applies to `CFBD_API_KEY`.
- **College:** no injury report, depth chart or targets from ESPN. Roles are inferred from usage and absences are marked unverified. League baselines are priors.
- **Retrospective views and backtests:** no injury, depth-chart or weather inputs (to avoid leakage). Book lines are closing lines.
- **Heuristics:** weather effects, the QB sack-fumble rate and the blowout-substitution shares are heuristic priors.
- **Game-script weights:** an approximation, not a validated win-probability model.
- **Not tracked:** coaching changes.
- **Early-week latency:** a matchup build takes about 3–4 s on first load (roughly 30–60 requests, cached afterwards).

## Files

- `server.js`: HTTP server, API, local-only guard.
- `src/`:
  - `espn.js`: ESPN fetchers and parsers.
  - `history.js`: pre-cutoff games, team context, player rows.
  - `roles.js`: role selection and availability.
  - `model.js`: scenarios and Monte Carlo.
  - `matchup.js`: orchestration and explanations.
  - `ledger.js`: SQLite ledger and evaluation.
  - `services.js`: slate, matchup, snapshot, backtest, settle.
  - `baselines.js`, `snaps.js`, `weather.js`, `optional.js`, `odds.js`, `security.js`, `fetcher.js`, `config.js`, `stats.js`.
- `public/`: UI (`index.html`, `app.js`, `styles.css`).
- `scripts/`: `snapshot.js`, `settle.js`, `backtest.js`.
- `test/`: 7 test files plus real ESPN fixtures.
