# Skeptic: an independent logic audit

`src/skeptic.js` re-checks every finished matchup against football common sense and basic arithmetic. It doesn't trust the code that produced the numbers. It reads the outputs, flags anything that looks like a logic bug, and never changes a projection.

- **On the dashboard:** every matchup page has a "Skeptic check" panel.
- **For a whole slate:** run `npm run skeptic` (or `npm run skeptic -- nfl 5` for week 5; add `--all` to include notes). The command exits non-zero if it finds a likely logic error.
- **Outlier veto:** a player with a high-severity finding can't be the outlier pick.

## Checks

| Severity | Check | Example of what it catches |
|---|---|---|
| high | QB absorbs non-QB carries | Breece Hall out → Geno Smith given +25% carry share (the real bug that prompted this) |
| high | Receiver absorbs RB carries, QB absorbs targets | Usage redistributed to the wrong position |
| high | Carries/targets over-allocated | Displayed players projected for more carries than the team runs |
| high | OUT/IR player still projected | A ruled-out player with a real projection |
| high | Impossible arithmetic | Receptions > targets, completions > attempts, receiving > passing yards, broken or negative ranges |
| high | Starting-QB count ≠ 1, duplicate player | Two starting QBs, or one player on both teams |
| medium | Volume jump/drop with no stated reason | Projected far from **both** his season average and his last game |
| medium | Primary stat outside his recent range | Above or below every game this season (this season only; a no-stat game counts as 0) |
| medium | Big learned correction | v1.4 moved the projection by more than 35% of itself |
| medium | Doubtful player projected for a full role | |
| info | Explained changes, displayed share sums, model points vs book | |

Backups ("Support" role) skip the range and volume-drop checks, since they're expected not to play.

## Is it right? Checked against the 2024–26 blind backtest

Flagged projections really did miss worse:

| Flag | Flagged picks | Avg miss, flagged | Avg miss, not flagged | Season average closer |
|---|---|---|---|---|
| Pass-attempt jump | 38 | 18.7 | 9.4 | 61% |
| Target jump | 48 | 2.71 | 2.26 | 42% |
| Carry jump | 37 | 3.87 | 3.49 | 35% |
| Big learned correction (out of sample, 2024 → 2025) | 54 | 16.3 with v1.4 | 12.9 with v1.3 | |

Volume drops that are far from both the season average *and* the last game were rare (1 case each), so that check is a rare-event guard.

## What the first run found and fixed

1. **v1.4 extrapolating to unseen roles.**
   - Backup QBs (shown only as outlier candidates) were getting about +193 passing yards of learned correction, because v1.4 had only learned from starters.
   - **Fix:** v1.4 now applies only to roles it saw in training; any other role falls back to v1.3. Backtest accuracy is unchanged (7.681 / 7.388 / 7.380).
2. **QB absorbing an injured RB's carries.** Fixed in the previous release; the skeptic now guards it permanently, with a regression test.
3. **My own false alarms, corrected:**
   - Displayed share sums over 100% are a display artifact. Shares are measured over each player's own games, and the simulation renormalizes. That check is now informational.
   - A WR whose usage collapsed in his most recent game was flagged because the check only looked at his season average. It now also requires disagreement with his last game.
   - A TE was flagged using last season's games. The range check now uses this season only.
4. **Tried and rejected:** capping v1.4 corrections at 35%. It helped on the large-correction rows but hurt overall, because some large corrections are right (backup QBs who actually started). The skeptic flags these cases instead.
