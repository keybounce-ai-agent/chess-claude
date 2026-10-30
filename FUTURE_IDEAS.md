# Future ideas (parked, not implemented)

Current focus: get the game and interface solid enough for other chess players to playtest (hot-seat shared over Zoom/Discord/Twitch is fine for now).

## Opening-balance ideas
- **One-use Black cap bonus.** Black's +1 max energy would be a one-time bonus (one extra chance to offset going second), after which both sides are equal. Variants considered: cap falls to 6 on Black's first spend; cap falls after a fixed turn; a separate non-regenerating reserve point outside the cap (edits only).
- **Double-edit marker** (backgammon doubling-cube inspired). Black starts holding it. The owner may make two past edits in one turn (two waves); doing so passes the marker to the other player. Open rules: no editing the same ply twice in one turn; marker moves immediately; whether it works during a freeze; one-edit-per-turn rule [D] becomes "two for the holder". Knob if too cheap: second edit costs +1.
- **Pie / swap rule.** One player sets the opening package, the other chooses a side. Candidate package: Black's starting energy (0 to 3, quarter-point steps, since energy is stored x100) plus who holds the marker. Handles the case where we do not know whether a feature is an asset or a burden.

## Later
- Sending pieces into the past (after the play-order concept is solid). Always one timeline only.
- Self-play sweep and position evaluator (see README "Not yet implemented").
