# Achronal Chess: Design Requirements v0.2

**Audience:** LLM coding agents implementing the engine, tests, and UI.
**Date:** 2026-10-29
**Status:** Rules are settled except where tagged **[A]** (assumed default, awaiting the designer's confirmation). Section 11 lists every assumption and open item.

---

## 0. Conventions

- MUST, MUST NOT, SHOULD have their usual meaning.
- **[D]** marks a rule the designer decided. If code contradicts a [D] rule, the code is wrong. Do not "improve" a [D] rule.
- **[A]** marks a proposed default. Implement it, keep it isolated in one function or config value, and report anything that looks wrong.
- Several rules look odd on purpose (free rewrites, interrupts that cannot be dodged, a frozen present). They are marked **Intentional.** Do not add safeguards for them.
- "Turn" means one player's turn (one half-move, or **ply**) unless stated otherwise. The engine is deterministic, headless, and uses integer arithmetic only.

---

## 1. Overview

Achronal Chess is chess with **one editable timeline** (not branching, not 5D). A player may move in the present, and may also change one of their own earlier moves. A change creates a **timewave** that travels forward through the timeline, recomputing each later position. If a recorded later move is no longer legal, its owner must replace it. Changing the past costs **chrono-energy**.

Design goals:

1. Standard chess rules apply to every board in the timeline.
2. The finished game is always a legal chess game, possibly an unusual one.
3. Time travel is a resource game. Running the opponent out of chrono-energy is part of the strategy.
4. Core emergent play: seeing what the opponent will do, you rewrite your own past with few edits, and the waves invalidate several of their moves, so they must pay to answer each.
5. All information is public. The skill is forecasting and planning one step ahead (including the opponent's forced responses).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Ply | One player's turn. White plays even indices (0, 2, 4...), Black odd. |
| Turn / full move | A turn is one ply. "Turns back" always counts the acting player's **own** turns. |
| Board / state S[i] | The pair **(position, recorded move)** at index i. |
| Present index n | Index of the newest state. Its recorded move is null until played. |
| Owner of S[i] | The side to move in position[i]. |
| Edit | A player replaces the recorded move of one of their own past states. |
| Timewave | The recomputation that travels forward from an edit. |
| Front | The index a wave has recomputed up to. |
| Step | A wave recomputes position[front+1], then checks the move recorded there. |
| Invalid state | Recorded move is non-null and illegal in its position. |
| Response | The owner replaces the move of an invalid state. |
| Interrupt | A response demanded mid-resolution (see 4.4). |
| Deferred response | A response owed on the owner's next turn (see 4.4). |
| Terminal state | The owner has no legal move (checkmate if in check, else stalemate). |
| Draw state | Threefold repetition, fifty-move rule, or insufficient material holds at a board. |
| Mark | A terminal or draw condition recorded on a board. |
| Freeze | The present stops moving while any mark exists (see 4.6). |
| Tick | One action or pass during a freeze, followed by wave resolution. |
| Chrono-energy | Per-player resource spent on edits and responses. |

---

## 3. Data model

```
Position   { board, side_to_move, castling, en_passant, halfmove_clock, hash }
BoardState { index, position, move }     # (piece position, recorded move)
Timeline   { states: [BoardState] }      # states[n] is the present; move == null
Wave       { id, origin, front, halted }
Player     { color, energy }             # integer units, never negative
Mark       { index, kind }               # kind: checkmate | stalemate | threefold | fifty_move | insufficient
ActionLog  [ { actor, action, tick, config_hash } ]   # append-only, enables exact replay
```

- `position[i+1] = apply(move[i], position[i])`, computed by waves and by present moves.
- A state is **valid** if its move is null (present only) or legal in its position, **invalid** if the move is illegal in its position.
- The timeline stores only current moves. The ActionLog keeps every overwritten move.
- Positions carry the halfmove clock and a hash so repetition and the fifty-move rule can be recomputed along the current timeline whenever a wave changes a board.

---

## 4. Rules

### 4.1 Chess

Full standard chess legality on every board: check, pins, castling, en passant, promotion. Use an established chess library for move generation, legality, FEN/SAN, and perft-verified correctness. Do not hand-write chess rules.

**King capture never occurs.** Every applied move is legal, and a legal move never leaves the mover's king attacked. No legal move while in check is checkmate, no legal move while not in check is stalemate.

### 4.2 Edits

An **edit** replaces the recorded move at a past index k < n.

- **[D]** A player may edit **only plies of their own color**. White edits even indices, Black odd. Error: `ERR_NOT_YOUR_PLY`.
- The new move MUST be legal in position[k] **as currently computed** (the "now" view, see 4.7), MUST differ from the current move, and MUST be at an index below the frozen board when a freeze is active.
- **[A]** A state with an unanswered pending response cannot be edited. Its response is the way to change it.
- **[D]** An edit is allowed if and only if `energy >= cost`. Nothing else is checked, including consequences. Error: `ERR_INSUFFICIENT_ENERGY`. **Intentional:** an edit may invalidate the editor's own later moves. Those responses cost `min(energy, cost)`, so once the editor is at zero they are free. Do not add a "predicted consequences" check.
- An edit creates `Wave{origin=k, front=k}`. The recorded move is replaced immediately, but nothing downstream changes until waves arrive.
- **[D]** At most **one** edit per player per turn (or per tick in a freeze).

### 4.3 Turn structure

At the **start** of a turn: regeneration (see 5.2). Then the player may, in **any order**:

- **[D]** make at most one optional edit, and
- **[D]** answer **every** owed (deferred) response, earliest index first **[A]**,

and then **[D]** make exactly one **present move** at position[n], which ends the turn. The present move is always last. It is refused with `ERR_RESPONSES_OWED` while any response is owed. If a clock is ever added, it keeps running on the player the engine is waiting for. The engine exposes `pending_actor`.

A present move is checked for legality against the **now** view of the present position. **[D]** A move legal now may be invalidated when waves arrive. That is intended, and then its owner owes a response.

### 4.4 Turn resolution (waves)

**[D]** `WAVE_STEPS_PER_TURN = 3`, a fixed constant, not configurable. Reasons: at speed 1 a wave never reaches the present, since the present also advances 1 per turn, and at speed 5 waves arrive too fast. The speed MUST also be odd. Because it is odd and actors alternate, the state reached on a wave's third step always belongs to the **next actor** (see invariants).

When a present move (or a freeze tick) ends, the turn counter has **not** advanced yet. The engine resolves waves first:

```
for each wave in flight (front < n), leading wave (highest front) first, skipping halted waves:
    repeat up to 3 times:
        recompute position[front+1] from move[front]; front += 1
        evaluate marks on the new position (terminal / draw)
        if state[front].owner has no legal move:        # terminal
            halt this wave; stop its steps
        elif state[front].move != null and is illegal:    # invalid
            if the wave has steps left in this resolution:
                INTERRUPT: owner must respond now
            else:
                owe a DEFERRED response (owner = next actor)
                stop this wave's steps
        if front == n: wave has arrived; stop
after all waves: apply marks; advance the turn counter; next actor acts
```

- **[D] Interrupt:** the owner must respond immediately, before the opponent's turn. They pay `min(energy, cost)` from their energy **before** regeneration. They may take no other action, so they cannot spend energy on an optional edit first. **Intentional.** To arrive at zero before an interrupt, a player must plan one turn earlier.
- **[D] Deferred:** an invalid state found on a wave's final step is owed on the owner's next turn.
- **[D]** A response never spawns a wave. The wave simply continues with the replacement move.
- **[D]** Waves never merge. Any number may be in flight, they step independently, and each reads the current positions and moves. Editing an index twice just starts a second wave behind the first.
- **[D]** A wave whose step changes nothing (a "null wave", for example a move-order swap that converges) keeps running to the present. Consistency over optimization.
- A halted wave resumes from its front when the terminal condition at that board is removed by another wave. Trailing waves MUST be allowed to step onto a halted board and recompute it.
- Wave arrival: when a wave reaches a board, that board's **now** view is updated. The present's now view is the fully adjusted board.

### 4.5 Responses

- **[D]** Compulsory. The present move is blocked until every owed response is made.
- **[D]** A response costs `min(energy, cost)`. If the player has enough energy they MUST pay the full cost. If not, they pay all they have, drop to zero, and the response still goes through. **Intentional.**
- A drained player can still respond. They cannot afford to **edit**. "Cannot respond properly" means "cannot afford a counter-edit".
- The replacement MUST be a legal move in the invalid state's position and differ from the invalid move.
- A response may make later states invalid. Waves discover them in order.

### 4.6 Terminal states, draw states, and the freeze

**Marks.** After every present move and every wave step, evaluate the new position for: checkmate, stalemate (no legal move for the owner), threefold repetition, the fifty-move rule, and insufficient material. **[D]** Draws are draw states handled like stalemate. Repetition counts and the clock are recomputed along the current timeline up to that board. A mark is removed when the board is recomputed and the condition no longer holds.

**Freeze. [D]** While any mark exists, the present is **frozen**:

- The **frozen board** is the **earliest index** with a mark.
- No present moves. The turn counter does not advance. No regeneration.
- Players act in **strict alternation**, starting with the next actor in normal alternation. The first actor may be the opponent of the frozen board's owner, who then must act even earlier in the past, since players can only edit their own plies.
- Each action is a **tick**: one optional edit (below the frozen board) or a **pass**, then the usual wave resolution (including interrupts and deferred responses). Payments, including the transfer fraction, work as usual. Edit costs use the frozen n.
- A player owing a deferred response cannot pass.

**Pass and forcing rules. [D]**

- **Checkmate:** the mated player (owner of the frozen board) MUST make an edit if they can afford one. They may pass only while a wave with front below the frozen board is still in flight, since it may remove the mate. The other player may pass or edit freely.
- **Stalemate / draw states:** nobody is forced. Either player may pass.

**Becoming final. [D]**

- **Checkmate** is final when no wave with front below the frozen board remains **and** the mated player cannot afford any legal edit below the frozen board. The mated player loses.
- **Stalemate / draw states** are final when **both players pass in succession** and no wave remains that can affect the board.
- When final, the game ends at that board. The record is S[0..j], and everything after j is "fantasy". The UI may show those states greyed out and labelled, but they are not part of the result.

**Lifting the freeze. [A]** When no mark remains, the freeze lifts at the first tick boundary where the next actor is the side to move at the present. If the lifting tick leaves the wrong player next (the other side), that player takes one extra tick (edit or pass, no present move, no regeneration) before normal turns resume. This keeps strict alternation and the wave parity. **This is the least certain rule in the document. See 11.**

Because nothing regenerates and every payment destroys energy, a freeze is bounded.

### 4.7 Information and views

**[D]** All information is public: the full timeline (including stale states ahead of a wavefront), all waves, owed responses, marks, and both energy balances.

Every board has two views:

- **Now:** the position as currently computed.
- **Projected:** the position once every wave not yet at that board has arrived.

**[D]** A move (present or edit) is made on the pieces where they are now, for the benefit of where things will be once the altered past catches up. Legality is checked against the **now** view only. A move illegal now but legal on the projection is rejected.

`BoardView { now, projected, status }`, where status is:

- `certain`: the projection is exact.
- `blocked_at_j`: exact up to the first invalid state j. Beyond j it depends on a response not yet chosen.
- `approximate`: the **ghost** view beyond a stall.

**[D]** The ghost view shows things as if every stall resolved, and the UI MUST label it an approximation. **[A]** Implementation: apply each recorded move geometrically ignoring legality. Where two pieces land on one square show both and flag the square. If a move's piece is not on its origin square, treat the move as doing nothing and mark it.

The ghost view and the projection are information only. No rule, cost, or result may depend on them.

---

## 5. Chrono-energy

### 5.1 Units

**[A]** Integer fixed-point. `ENERGY_SCALE = 100` units per displayed energy point. No floats anywhere in the engine.

### 5.2 Regeneration

- **[D]** Regeneration is 1 point per turn, and it continues even when both players are at zero. Energy above the cap is wasted.
- **[A]** It is applied at the start of the owner's turn, before any action, and clamped to the cap. There is none during a freeze.
- **[D]** Interrupt payments use the energy before this regeneration.

### 5.3 Cost

**[D]** An edit (or response) costs the number of the actor's **own turns** back: undoing your last move costs 1, six of your own turns back costs 6.

`cost(j, n) = ceil((n - j) / 2) x cost_per_turn_back` **[A]** (the `ceil` only matters for a player's own just-made move seen mid-resolution, where n - j is odd). Put it behind a `CostModel` interface. The same function prices edits and responses.

Design property to preserve and test: because a wave closes on the present at 2 plies per turn, an edit d plies back reaches the present in about d / 2 turns, which equals its cost in turns. An edit costs as much energy as the number of turns before it lands.

### 5.4 Payment and transfer

- **Edit:** requires `energy >= cost`, deducts `cost`.
- **Response/interrupt:** deducts `min(energy, cost)`.
- **[D]** A configurable percentage of what a player pays goes to the opponent. Initial testing is 0, and about 25% is expected later.
- **[A]** It applies to edits and responses alike, to the amount **actually deducted** (so a free response sends nothing), immediately, and is `floor(paid x transfer_pct / 100)`. The recipient is clamped to their cap. The rest (rounding remainder and cap overflow) is destroyed. Make `transfer_pct_edit` and `transfer_pct_response` separate settings with the same default.
- Accounting identity: for every payment `p`, payer -p, recipient +t, destroyed = p - t.

### 5.5 Strategy notes (for tests and self-play, not extra rules)

- Free rewrites: an edit that spends your last energy and invalidates your own later moves lets you answer them for nothing and choose the replacements, which then invalidate the opponent's moves, so they pay.
- Burn-then-free only works for deferred responses, since interrupts come before any edit.
- The cheapest edit costs about what you regenerate, so players at the cap lose nothing by using it. Use it or lose it.
- Probes and deliberate self-blocks (for example blocking your own pawn) are expected to be central play. Treat that as a hypothesis for the self-play sweep, not a rule.

---

## 6. Configuration

One `BalanceConfig`, loaded from a file, per color where relevant. A hash of it is written to the ActionLog header.

| Setting | Default | Notes |
|---|---|---|
| `WAVE_STEPS_PER_TURN` | 3 | **Constant**, not config. |
| `ENERGY_SCALE` | 100 | |
| `regen_per_turn` | 100 | Both colors. |
| `start_energy` | White 0, Black 100 | **[D]** Black has 2 points on its first turn, White 1. |
| `max_energy` | White 600, Black 700 | **[D]** Initial values, tunable. |
| `cost_per_turn_back` | 100 | |
| `transfer_pct_edit` | 0 | Test later at about 25. |
| `transfer_pct_response` | 0 | Same. |

The cost of acting in the past and of replying to it is the game's balance point. Keep all cost, regen, cap, start, and transfer values tunable.

---

## 7. Architecture and API

Modules, with no cyclic dependencies:

1. `chess_core`: positions, move generation, legality, mate/draw detection, FEN/SAN (library-backed).
2. `timeline`: states, edits, waves, resolution, marks, freeze.
3. `economy`: energy, `CostModel`, regeneration, transfer.
4. `game`: turn order, action validation, end of game, `pending_actor`.
5. `ui` / `net`: presentation and transport only. No rules in the UI.

**Actions:** `PresentMove`, `PastEdit(index, move)`, `Respond(index, move)`, `Pass` (freeze only).
**Events:** `WaveStepped`, `Interrupt`, `ResponseOwed`, `EnergyChanged`, `MarkAdded`, `MarkRemoved`, `FreezeStarted`, `FreezeLifted`, `GameOver`.
**Read-only queries** (never affect legality, cost, or results):

- `BoardView(index)`.
- `Forecast`: positions the waves will produce, up to the first invalid state, plus each wave's ETA (about ceil(gap / 2) turns without stalls) and first stall point.
- `PreviewEdit(index, move)`: which states the edit would invalidate, their owners, projected response costs, and energy at that time.
- `LegalResponses(index)`.

**Errors:** `ERR_NOT_YOUR_TURN`, `ERR_NOT_YOUR_PLY`, `ERR_ILLEGAL_MOVE`, `ERR_INSUFFICIENT_ENERGY`, `ERR_EDIT_LIMIT`, `ERR_RESPONSES_OWED`, `ERR_EDIT_PENDING_INDEX`, `ERR_EDIT_AT_OR_AFTER_FROZEN`, `ERR_PASS_NOT_ALLOWED`.

State MUST serialise to JSON and replay exactly from the ActionLog.

---

## 8. Invariants (property-test after every action)

1. After all waves resolve, every recorded move is legal in its position.
2. The final record is a legal chess game from S[0], ending at the final board.
3. A player only ever edits plies of their own color.
4. A wave takes exactly 3 steps per resolution unless it arrives, halts, or has nothing left to do.
5. **Wave and turn parity:** the state reached on a wave's final step in a resolution always belongs to the next actor.
6. **Strict alternation** of actors, in normal turns and in freezes, with passes counting as actions.
7. A move that is still legal after a wave passes is never changed by the wave.
8. Energy is never negative. Accounting identity in 5.4 holds for every payment.
9. At most one edit per player per turn or tick.
10. No turn ends with an owned, answerable invalid state.
11. Interrupt responses never follow an optional edit in the same turn.
12. No `PresentMove` is accepted while a mark exists.
13. The frozen board is always the earliest marked index.
14. Forecast and BoardView never mutate the timeline.
15. Serialise, deserialise, replay: identical state.

---

## 9. Tests

**Unit/property:** per module. `chess_core` against known perft counts. Random action sequences checking section 8 after every step, including freezes.

**Scenario tests (hand-built):**

1. Clean wave: an edit that invalidates nothing reaches the present.
2. The worked example in Appendix A (invalid at 5 interrupts, invalid at 7 deferred).
3. A wave invalidates the editor's own move at step 2, and the editor answers immediately.
4. Energy: edit with cost > energy rejected, with no state change. Edit with cost = energy leaves 0. Response with cost > energy drains to 0 and succeeds. A response at zero is free and sends no transfer.
5. **Chain rewrite:** an edit spending all energy invalidates five of the editor's own later moves. The editor answers them at zero cost, and the replacements invalidate the opponent's moves, who pay.
6. Burn-then-free: edit first, then deferred response, at zero.
7. Interrupt cannot be preceded by an edit.
8. Concurrent waves: a counter-edit while an earlier wave is in flight. Waves stay independent.
9. A trailing wave changes a board after its owner already responded, forcing a second paid response.
10. Null wave runs to the present and changes nothing.
11. Present move legal now but invalidated on arrival, producing an owed response.
12. Present move illegal now but legal on the projection is rejected.
13. Mate at the present, mated player can edit: freeze, rescue wave removes the mate, freeze lifts.
14. Mate at the present, mated player cannot afford: game ends immediately.
15. Mate in the past whose owner is not next to act: the other player acts first.
16. Self-stalemate by the losing side: the winner needs a rescue edit on an earlier own ply, at the right cost. With and without enough energy.
17. Two marks at once: only the earlier freezes the game, and resolving it removes the later one.
18. Double pass with a wave in flight does not end a draw. After the wave has passed it does.
19. Threefold, fifty-move, and insufficient material in the past are draw states, recomputed correctly after an edit changes history.
20. Freeze lifting after an odd number of ticks (the extra-tick rule, 4.6).
21. Cost/arrival property from 5.3.
22. Transfer: payment accounting at 0 and 25%, cap clamp, rounding.

**Self-play harness:** scripted bots with limits (edits only within a few turns back, one-reply lookahead) so it finishes. Sweep `BalanceConfig` and report win rate by color (needs a large sample, since plain chess already has a color skew), game length, edits per game, average chain-rewrite length, freeze frequency, and energy at game end.

---

## 10. Out of scope for v0.2

Resequencing or moving individual pieces through time (planned later), branching timelines, accounts, matchmaking, ratings, and chess clocks (design the API so they can be added).

---

## 11. Decisions log, assumptions, open items

**Decided by the designer [D]** (summary): single timeline; own-color edits only; one optional edit per turn; present move last; responses compulsory, `min(energy, cost)`; edit affordability checks only its own cost; wave speed fixed at 3; interrupts and deferred responses as in 4.4; waves never merge; null waves run on; all information public with now/projected views; ghost view labelled approximate; cost counts own turns; regeneration 1 per turn and continues at zero; cap, start energy, and transfer percentage tunable; Black starts with 1, caps 6/7; terminal and draw states freeze the present with the rules in 4.6; draw rules in the past use the same freeze.

**Assumed [A]** (confirm or correct):

1. **Lifting the freeze (4.6):** extra tick when the lifting tick leaves the wrong player next. This is a real parity gap that my own analysis found, not something the designer specified.
2. Cost uses `ceil((n - j) / 2)` for odd differences.
3. Regeneration timing: start of the owner's turn.
4. Transfer applies to edits and responses, based on the amount actually paid, with overflow and rounding destroyed.
5. Owed responses are answered earliest index first.
6. A state with a pending response cannot be edited.
7. In a freeze, edits are only allowed below the frozen board.
8. Ghost view implementation details (4.7).
9. `ENERGY_SCALE = 100` integer units.

**Open:** none blocking. The assumptions above are the only items needing a decision.

---

## Appendix A: worked example (wave and interrupts)

White edits ply 4 (an even index, White's own), then plays its present move. Turn resolution begins with front = 4.

- **Step 1:** recompute position[5], check Black's move 5. Suppose it is invalid. Steps remain, so it is an **interrupt**: Black must answer now, paid from pre-regeneration energy. Black cannot make an edit first.
- **Step 2:** recompute position[6], check White's own move 6. If invalid, White answers immediately (interrupt).
- **Step 3:** recompute position[7], check Black's move 7. This is the wave's last step, so an invalid move 7 is **deferred**: Black answers in its next turn, in any order with its optional edit, before its present move.

The wave is at 7 when Black's turn begins. The state reached on step 3 belongs to the player about to move, which is the parity invariant.

## Appendix B: worked example (chain rewrite)

White's first five moves push the same bishop pawn. White spends all its energy to edit turn 1 into a knight move. Every later White move is now invalid, so as the waves reach them White answers each at zero cost and chooses the replacements. The replacements change the board under Black's recorded replies, so Black's moves become invalid and Black must answer each one at full price, and a configured fraction of that goes back to White.
