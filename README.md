# Achronal Chess

Chess with one editable timeline, Achron-style timewaves and chrono-energy. Rules: [achronal-chess-design-v0.2.md](achronal-chess-design-v0.2.md).

**Play:** open `index.html` (GitHub Pages: Settings, Pages, deploy from `main` / root). Static files only, no build step. Hot-seat for two players.

## Files
- `engine.js` headless rules engine (waves, interrupts, deferred responses, energy, freeze, replay log). Chess legality via vendored `chess.js` 0.13.4.
- `index.html` UI: timeline strip, **Now** and **Projected** boards, energy bars, event log.
- `test.js` scenario + random-play invariant check: `node test.js`.

## UI
Select a ply in the timeline, then move on the Now board. The newest ply is the present move. Your own earlier plies (dashed outline) are edits, costing your turns back. Red plies are owed or interrupt responses, purple plies are terminal/draw marks (freeze), and a wave marker shows where each timewave's front is. Red board squares show where Now and Projected differ.

## Not yet implemented
Position evaluator, balance-config UI, ghost-view square flags, Forecast/PreviewEdit queries, full scenario test suite, self-play sweep, AI opponent. Promotion is always to a queen.
