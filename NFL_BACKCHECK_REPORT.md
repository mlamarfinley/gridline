# NFL backcheck: games, predictions, and why they missed

**Source:** sealed market-blind batch #3 (`fbm-1.1.0`, cutoff filter `cutoff-v2-wallclock-verified`). Each game was predicted using only games verified finished before its kickoff: no betting lines, no target-game data, no injuries or depth charts.

**Scope:** every NFL game the model could predict, i.e. weeks 2–3, 32 games, 3,306 player-stat predictions.
- Week 1 (16 games) can't be predicted: there's no current-season usage yet.
- Week 4 hasn't been played; its true pregame forecasts are stored and will be scored after the weekend.

**Caveat:** weeks 2–3 were already inspected while building v1.1, so this is a **diagnosis, not independent validation**.

**Reproducibility:** the 32 games were rebuilt and reproduced all 3,306 sealed projections exactly. Tools:
- `scripts/nfl_diagnose.js` → `data/nfl_diagnosis_rows_3.json`
- `scripts/nfl_analyze.mjs` (the analysis below)

## Headline

1. **Where it adds value:** it beats a naive "season average so far" baseline on every stat, most in week 2 (yardage MAE 26.3 vs 33.4).
2. **Where it falls short:** it is **worse than the book's opening lines** on every stat with a line, by roughly 10–20% MAE. Those lines are reconstructions retrieved after the games, but they are the fairest yardstick available.
3. **When it disagreed with the line, the line was usually closer.** Regressing (actual − line) on (model − line) gives β = −0.21 (t = −2.9, n = 927). Blending the projection toward the line improves MAE at every weight tested, and the line alone was best. **As built, the model's independent signal about a player-game is not better than the market's.**
4. **The biggest single failure is QB passing yards.** The projections have essentially **no ability to rank QBs**: correlation with actual ≈ 0.0, vs 0.41 for the line. The projection spread is only ±24 yds against a real spread of ±72.
5. **Ranges are roughly honest:** 10–90 coverage is 74–89% by stat, against 80% nominal. The problem is ranking and centering, not error bars.

## Why predictions went wrong (injuries and exits separated out)

**Outliers removed first:**
- **27 of 432 player-games** had no box-score row: inactive or injured, participation unverified.
- **14** had an in-game exit or benching, by a heuristic: QB with 10 or fewer attempts, or a skill player whose workload came in under 25% of projection. Examples: Jaxson Dart had only 5 attempts and Cooper Rush 17. The box score doesn't say why (injury, benching or blowout).
- **40 of 198 real producers** (8+ carries or 6+ targets) weren't on a card. Blind mode has no injury or depth news, so the reason is unknown. Examples: Alvin Kamara and TreVeyon Henderson in week 2.
- These are real but **outliers**. The live pregame mode reads the injury report and depth chart, which the blind test deliberately withholds.

**On the clean set:**

| Stat | n | Model MAE | Open line MAE | Corr(model, actual) | Corr(line, actual) | Bias | 10–90 cov |
|---|---|---|---|---|---|---|---|
| QB pass yds | 57 | 57.0 | **49.2** | **−0.01** | 0.41 | +6.1 | 81% |
| QB pass att | 57 | 6.7 | 6.2 | 0.14 | 0.32 | −0.6 | 77% |
| RB rush yds | 116 | 22.3 | **20.2** | 0.57 | 0.67 | −1.8 | 74% |
| RB carries | 116 | 3.8 | 3.5 | 0.72 | 0.71 | **−1.2** | 81% |
| RB rec yds | 116 | 12.6 | 12.1 | 0.24 | 0.38 | +1.7 | 76% |
| WR rec yds | 118 | 28.6 | **25.4** | 0.31 | 0.50 | −0.4 | 85% |
| WR receptions | 118 | 1.9 | 1.7 | 0.39 | 0.52 | 0.0 | 89% |
| TE rec yds | 36 | 23.8 | 21.5 | 0.28 | 0.35 | **+5.6** | 75% |

The line-MAE column uses only rows that have an open line (the n differs slightly).

### Root causes, ranked by how much error they explain

1. **No team-strength or game-script signal in blind mode.** This is the dominant cause.
   - Expected margin vs actual margin: **corr 0.02**. The model's expected margins average ±2.5 points; real margins average ±10.8.
   - Team points projection: corr −0.07. Team plays projection: **corr 0.00**.
   - After 1–2 games, team scoring is shrunk almost entirely to league average (3 pseudo-games of prior). Every game therefore looks like a coin flip, and the script weights carry no information.
   - The book spread isn't strong either (corr 0.33), but it is not zero.
   - QB attempt errors track **team play-volume errors (corr 0.73)**. When the model misses how many snaps a team runs, every player on that offense misses together.
2. **QB passing efficiency is not modeled at the QB level.**
   - Passing yards are assembled from the receivers' simulated catch distributions: team plays × pass rate × target shares × each receiver's catch rate and yards per catch.
   - Nothing represents QB skill: yards per attempt, completion % over expected, depth of target, sack avoidance. Mahomes, Stafford and a backup project nearly the same efficiency.
   - Result: QB pass-yard projections cluster around 230–270 yds regardless of QB (e.g. Stafford proj 227 → 390, Mahomes 233 → 382, Jordan Love 270 → 145).
3. **Opportunity (workload) error is the largest player-level component.** It accounts for about 60% of squared error for RB rushing, TE and QB passing (47% for WR).
   - RB carry shares are decent (corr 0.70), but carries are under-projected by 1.2 per RB. Likely causes: share floors plus the "other" bucket, and the model spreading carries across 3+ backs.
   - WR target share is weak (corr 0.28). One or two games of target share is noisy, and last season's target share on the same team is not used as a prior at all.
4. **Efficiency is mostly week-to-week noise.**
   - RB yards per carry: projected vs actual corr 0.25, actual SD 1.36 ypc.
   - This caps accuracy for everyone, but the model *reacts* to it. For rushing yards the coefficient on model-vs-line deviation is −0.52 (t = −2.7): where the model moved off the line, it moved the wrong way. This points to over-reaction to small samples (the explosive-run and ypc terms).
5. **Market information barely propagates into yardage.** The market-informed backtest (same games, using the spread and total) scored almost identically to blind: QB pass yds 58.4 vs 59.4. Today the spread and total only set script weights, TD rates and a ±10% pace nudge. They don't scale team passing and rushing volume, which is where the information is.
6. **Smaller systematic biases:**
   - TE receiving yds +5.6 (over-projected).
   - RB carries −1.2.
   - Kicker points have no rank signal: slope ≤ 0. Only the ranges are fine (89% coverage).

## Game-by-game (weeks 2–3)

How to read the table:
- **Final:** the actual score, with the model's blind expected points in parentheses.
- **Projection columns:** "proj → actual"; "n/r" = no recorded stats.
- **vs open line:** win/loss of the model's side against the reconstructed ESPN opening line, across all yardage props in the game.

| Wk | Game (ID) | Final (model exp.) | QBs pass yds proj→act | RB1 rush yds | Top receiver rec yds | Yardage MAE | 10–90 cov | vs open line (W-L) | Largest out-of-range miss |
|---|---|---|---|---|---|---|---|---|---|
| 2 | DET @ BUF (401872932) | 31–41 (25–25) | Goff 247→327; Allen 294→248 | Gibbs 113→52; Cook 71→135 | Brown 68→142; Kincaid 70→95 | 33.4 | 67% | 5-11 | DJ Moore rec 87→0 |
| 2 | CAR @ ATL (401872933) | 34–3 (24–26) | Young 263→287; Rush 233→86 | Hubbard 44→53; Robinson 100→72 | McMillan 57→101; London 54→51 | 29.3 | 65% | 6-10 | Cooper Rush pass 233→86 |
| 2 | CIN @ HOU (401872934) | 20–6 (26–24) | Burrow 246→207; Stroud 257→353 | Brown 62→80; Montgomery 64→10 | Higgins 51→95; Schultz 44→140 | 32.5 | 56% | 9-7 | Dalton Schultz rec 44→140 |
| 2 | CLE @ TB (401872935) | 23–19 (22–25) | Watson 219→238; Mayfield 243→182 | Judkins 47→21; Irving 41→89 | Boston 42→95; Otton 36→38 | 23.6 | 78% | 9-8 | Denzel Boston rec 42→95 |
| 2 | GB @ NYJ (401872936) | 20–17 (21–25) | Love 270→145; Smith 206→247 | Lloyd 54→20; Hall 65→29 | Golden 72→58; Mitchell 30→63 | 26.0 | 83% | 6-11 | Jordan Love pass 270→145 |
| 2 | MIN @ CHI (401872937) | 9–3 (26–27) | Wentz 238→143; Williams 269→138 | Mason 51→n/r; Swift 69→45 | Jefferson 101→55; Raymond 93→40 | 35.1 | 75% | 6-10 | Caleb Williams pass 269→138 |
| 2 | NO @ BAL (401872938) | 24–17 (24–26) | Shough 285→252; Jackson 244→235 | Etienne 35→25; Henry 93→68 | Olave 85→86; Andrews 49→49 | 12.3 | 100% | 9-4 | — |
| 2 | PHI @ TEN (401872939) | 24–20 (23–21) | Hurts 240→264; Ward 216→183 | Barkley 65→9; Pollard 47→64 | Smith 72→117; Tate 52→27 | 23.7 | 72% | 8-8 | Saquon Barkley rush 65→9 |
| 2 | JAX @ DEN (401872940) | 13–20 (25–19) | Lawrence 249→189; Nix 227→288 | Tuten 50→65; Dobbins 47→36 | Washington 78→98; Engram 37→17 | 19.3 | 88% | 8-5 | Pat Bryant rec 52→0 |
| 2 | LV @ LAC (401872941) | 26–14 (24–20) | Cousins 219→253; Herbert 220→192 | Jeanty 61→48; Hampton 54→94 | Mayer 44→23; Harris 43→53 | 23.4 | 72% | 6-9 | Tre Tucker rec 33→119 |
| 2 | MIA @ SF (401872942) | 13–35 (19–24) | Willis 211→197; Purdy 222→287 | Achane 68→74; McCaffrey 37→23 | Washington 52→43; Evans 46→54 | 18.5 | 88% | 7-7 | George Kittle rec 34→80 |
| 2 | SEA @ ARI (401872943) | 31–7 (20–21) | Lock 229→235; Brissett 242→95 | Price 46→52; Allgeier 42→10 | Smith-Njigba 118→155; McBride 75→41 | 22.8 | 83% | 7-9 | Jacoby Brissett pass 242→95 |
| 2 | WSH @ DAL (401872944) | 20–37 (23–22) | Daniels 239→96; Prescott 230→279 | Croskey-Merritt 57→43; Williams 66→30 | Diggs 79→47; Lamb 61→153 | 29.6 | 78% | 8-8 | Jayden Daniels pass 239→96 |
| 2 | IND @ KC (401872945) | 30–33 (21–26) | Jones 219→210; Mahomes 233→382 | Taylor 95→92; Walker 89→117 | Pierce 54→11; Kelce 45→101 | 25.3 | 76% | 11-5 | Patrick Mahomes pass 233→382 |
| 2 | PIT @ NE (401872946) | 3–20 (21–20) | Rodgers 235→187; Maye 227→208 | Warren 45→43; Stevenson 56→43 | Wilson 37→28; Hollins 37→18 | 16.3 | 88% | 7-7 | Rhamondre Stevenson rec 41→3 |
| 2 | NYG @ LAR (401872947) | 6–28 (24–20) | Dart 221→20; Stafford 211→327 | Skattebo 58→36; Williams 45→85 | Likely 56→33; Adams 40→195 | 48.5 | 38% | 1-15 | Jaxson Dart pass 221→20 |
| 3 | ATL @ GB (401872948) | 35–14 (21–23) | Rush 197→n/r; Love 260→312 | Robinson 63→194; Lloyd 39→11 | London 36→194; Golden 63→100 | 31.7 | 76% | 9-5 | Drake London rec 36→194 |
| 3 | CAR @ CLE (401872949) | 18–21 (26–23) | Young 295→291; Watson 235→144 | Hubbard 49→82; Judkins 48→70 | Coker 89→18; Boston 62→41 | 29.1 | 67% | 6-9 | Deshaun Watson pass 235→144 |
| 3 | CIN @ PIT (401872950) | 27–30 (22–19) | Burrow 230→282; Rodgers 224→292 | Brown 71→61; Warren 44→127 | Chase 60→98; Wilson 32→60 | 26.1 | 93% | 8-6 | Jaylen Warren rush 44→127 |
| 3 | HOU @ IND (401872951) | 17–19 (25–24) | Stroud 301→167; Jones 226→235 | Montgomery 46→33; Taylor 90→68 | Hutchinson 52→51; Downs 55→77 | 21.3 | 94% | 7-9 | C.J. Stroud pass 301→167 |
| 3 | KC @ MIA (401872952) | 24–10 (26–20) | Mahomes 259→246; Willis 186→210 | Walker 94→70; Achane 70→17 | Kelce 67→59; Washington 39→56 | 23.2 | 60% | 6-8 | De'Von Achane rush 70→17 |
| 3 | LAC @ BUF (401872953) | 16–24 (23–26) | Herbert 222→226; Allen 284→204 | Hampton 70→56; Cook 68→154 | McConkey 41→66; Kincaid 82→38 | 26.6 | 73% | 6-8 | James Cook III rush 68→154 |
| 3 | NYJ @ DET (401872954) | 24–31 (25–23) | Smith 258→321; Goff 211→269 | Hall 65→32; Gibbs 96→99 | Wilson 68→107; LaPorta 43→44 | 22.7 | 82% | 10-5 | Isaac TeSlaa rec 15→66 |
| 3 | SEA @ WSH (401872955) | 31–33 (24–19) | Lock 253→n/r; Daniels 205→n/r | Price 40→15; Croskey-Merritt 40→36 | Smith-Njigba 133→128; McLaurin 46→77 | 14.8 | 100% | 4-7 | — |
| 3 | TEN @ NYG (401872956) | 7–12 (21–22) | Ward 215→181; Dart 209→n/r | Pollard 54→74; Skattebo 51→60 | Tate 53→58; Nabers 39→26 | 18.9 | 86% | 5-9 | Isaiah Likely rec 51→13 |
| 3 | NE @ JAX (401872957) | 6–35 (20–20) | Maye 230→199; Lawrence 220→182 | Stevenson 28→22; Tuten 49→73 | Douglas 29→38; Washington 86→40 | 19.7 | 82% | 7-9 | Brian Thomas Jr. rec 50→8 |
| 3 | ARI @ SF (401872958) | 30–36 (19–24) | Brissett 228→280; Purdy 224→297 | Love 33→90; McCaffrey 33→75 | Wilson 50→89; Samuel 41→80 | 26.1 | 76% | 8-8 | Jeremiyah Love rush 33→90 |
| 3 | MIN @ TB (401872959) | 23–16 (24–21) | Wentz 192→n/r; Mayfield 233→217 | Jones 58→58; Irving 52→46 | Jefferson 65→32; Egbuka 44→62 | 18.3 | 79% | 8-6 | Jordan Addison rec 37→90 |
| 3 | BAL @ DAL (401872960) | 34–31 (24–24) | Jackson 229→186; Prescott 245→276 | Henry 86→89; Williams 54→98 | Bateman 57→37; Lamb 77→112 | 22.3 | 87% | 5-9 | Javonte Williams rush 54→98 |
| 3 | LV @ NO (401872961) | 35–27 (24–22) | Cousins 213→248; Shough 266→255 | Jeanty 64→56; Etienne 28→57 | Tucker 51→43; Olave 89→107 | 14.2 | 81% | 11-4 | Mike Washington Jr. rush 18→54 |
| 3 | LAR @ DEN (401872962) | 26–30 (21–20) | Stafford 227→390; Nix 217→186 | Williams 54→88; Dobbins 38→49 | Adams 80→137; Sutton 29→46 | 36.2 | 67% | 6-8 | Matthew Stafford pass 227→390 |
| 3 | PHI @ CHI (401872963) | 7–27 (23–24) | Hurts 240→153; Williams 241→n/r | Barkley 35→82; Swift 61→84 | Smith 82→65; Raymond 60→90 | 22.2 | 79% | 4-9 | Saquon Barkley rush 35→82 |
**Best-predicted games** (lowest yardage MAE): NO @ BAL 12.3 · LV @ NO 14.2 · SEA @ WSH 14.8.

**Worst:**
- **NYG @ LAR, 48.5:** Stafford threw 55 times for 390; Dart had only 5 attempts.
- **LAR @ DEN, 36.2**
- **MIN @ CHI, 35.1**

The worst games share a pattern: one team threw far more or far less than the model's near-neutral script assumed. In a few, a QB had a very short game (cause not recorded in the data).

See `IMPROVEMENT_PLAN.md` for the fixes and how they will be tested without reusing these weeks.
