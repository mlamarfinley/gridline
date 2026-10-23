# Player target explorer

Goal: let users adjust a target on every available player stat card and see model-derived chances of reaching it.

Design: a compact purple-accented target slider plus numeric input under the chart. Experimental scenario probability leads, baseline remains visible. Use >= target, explicitly distinguish from book over/push rules. Default target is rounded experimental projection (otherwise baseline), never a book price. Remember edits per game/player/stat during this visit. Existing forecasts and archived picks remain unchanged.

Implementation:
- Test distribution construction and target probability: ties, zero production, monotonicity, negative yards, absent data, market independence, experimental scaling.
- Export compact integer outcome histograms from final reconciled simulation samples for upcoming games. Experimental scenario scales samples by experimental projection / sample mean, preserves zero production, rounds to whole-stat outcomes. This is a sensitivity scenario, not a validated experimental distribution.
- Add isolated frontend rendering and event delegation; accessible slider and number input, mobile layout, unavailable state for historical games and missing samples. Explain game-level market context and participation assumption.
- Use half-count smoothing so finite simulations never assert certainty. Show >99.9% / <0.1% at extremes; high-model-probability badge, never guaranteed. High probability is not established calibration.
- Run tests, build one real matchup, check Chrome interactions/mobile, publish and verify deployment.
