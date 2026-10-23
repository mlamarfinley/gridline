# Matchup readability

Goal: show key player numbers immediately and make deep analysis easy to find.
Design: retain Gridline typography and team identity; quieter panels, more whitespace, sentence-case headings. Overview defaults to a primary-stat comparison with baseline, experimental, sportsbook and actual values. Keyboard-accessible tabs separate Players, Game flow, Team tendencies, and Sources. Search filters the comparison; player names open their full card. Keep experimental values and charts visible. Collapse reference formulas, matchup history, ratings and long notes. Preserve all existing data and computations.

Implementation:
1. Add a small presentation module for the summary and accessible tab/search behavior, with data-integrity tests for missing/zero values and no mutation.
2. Group existing markup into panels, move secondary information into disclosures, and improve responsive spacing and type hierarchy.
3. Run regression tests, inspect desktop/mobile and completed/upcoming games, verify navigation and experimental numbers, then publish through the existing workflow.
