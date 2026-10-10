# Tycoon City — Game State Machine (Phase 1, final)

**Status:** final · **Rules:** v1 · **Snapshot schema:** v2 ·
Verified against the reducer on `main` (`engine/reducer.ts` and its surface
modules) as of the Phase 1 docs wrap-up. This document is the source of truth
for **state truth** — phases, transitions, the command registry, the event
catalog, debt/bankruptcy, and snapshot history. Rules values live in
`docs/RULES.md`; transport in `docs/MULTIPLAYER_CONTRACT.md`.

## 1. Phases

`GamePhase`: `LOBBY → PLAYING → GAME_OVER`.

Within `PLAYING`, `state.turnPhase` (the `TurnPhase` union) takes exactly these
values, and no others:

| TurnPhase | Meaning |
|---|---|
| `AWAITING_ROLL` | The active player must roll (or `HOLD`, or manage pending trade answers). |
| `RESOLVING_MOVE` | The roll's movement and landing resolution run — engine-side, within one command. |
| `BUY_DECISION` | The mover is on an unowned purchasable space: buy or pass to auction. |
| `AUCTION` | A declined-buy auction is open (inside the decliner's turn). |
| `ELIMINATION_AUCTIONS` | A bank-creditor estate is being sold sequentially. |
| `SETTLING_DEBT` | A payment came due and cash was short; the debtor must raise cash. |
| `TURN_MANAGEMENT` | Build/sell/mortgage/trade/surrender/end the turn. |

There are no implicit transitions: every legal `(turnPhase, command)` pair
appears in the table in §4, and every command the engine accepts is in the
registry in §3. `GAME_OVER` rejects every command with `GAME_IS_OVER` — the
reducer checks this before authorization.

## 2. State shape (per `GameState`)

- `version` — command-ordinal counter; every applied command increments it by
  exactly one and equals `stateVersion` in the snapshot. Rejections and
  idempotent replays change nothing.
- `round` — the current round ordinal (schema v2). `END_TURN` that passes play
  to the **first** seat of the next rotation increments it; the round cap is
  evaluated at that handover, so the over-cap round never begins (Blitz's 15
  is the last round that plays).
- `turn` — global turn ordinal across the whole game, monotonic.
- `activePlayerId`, `turnPhase`, `doublesCount` (0–3), `skipNextTurn` — turn
  machinery. The third consecutive doubles skips the turn via `skipNextTurn`
  (no movement on that roll), and the counter resets on any non-doubles roll,
  on the third-doubles penalty, and when the turn passes.
- `players[]` — `cash`, `position`, `heldTokens`, `bankrupt`; `currentRoundHoldsUsed`.
- `owners`, `upgrades`, `mortgaged` — space records (`mortgaged` entries are
  deleted, not false, when a flag is cleared).
- `debt` — the open debt (debtor, creditor, amount, cause) or `null`.
- `auction` — `null` or `{ reason: 'DECLINED' | 'BANK_ESTATE', spaceId, currentBid,
  highBidderId, passedPlayerIds }`.
- `estateSale` — `null` or `{ debtorId, pendingSpaceIds }` (schema v2) — the
  bank-creditor estate queue, persisted so the interrupted turn resumes
  exactly.
- `pendingTrade` — at most one offer: `{ offerId, proposerId, recipientId,
  terms, turnAnchor }`; `turnAnchor` is the proposer's turn counter at offer
  time — the pure, wall-clock-free expiry signal.
- `eventDeck` / `eventDiscard` — pile orders (ordinary state).
- `rngState` — the Mulberry32 word, advanced and persisted by every command.
- `processedCommandIds` — the idempotency ledger (ids only).
- `mode`, `seed`, `gameId`, `victory`, `logs[]` (capped ring).

## 3. Command registry (17 commands)

Shape validation rejects any other type. `HANDLERS` covers all 17 — no
`COMMAND_NOT_IMPLEMENTED` stubs remain in Phase 1.

| Command | Actor | Turn phase | Effect summary |
|---|---|---|---|
| `START_GAME` | any live player | LOBBY | Builds the play state from `{ seed, mode, players }`; shuffles the deck; emits `GAME_CREATED`, `TURN_STARTED`. |
| `SAVE_SNAPSHOT` | any live player | any phase (no phase gate; `GAME_OVER` rejects upstream) | Emits `SNAPSHOT_SAVED` (persistence itself is the sink/UI's job). |
| `ROLL` | active | AWAITING_ROLL | 2d6; doubles counter; movement + landing resolution; or third-doubles park skip. |
| `HOLD` | active | AWAITING_ROLL | Consumes a Hold token; skips the whole turn. |
| `BUY` | active | BUY_DECISION | Full-price purchase. |
| `PASS_TO_AUCTION` | active | BUY_DECISION | Opens a `DECLINED` auction. |
| `BID` | eligible bidder | AUCTION · ELIMINATION_AUCTIONS | Ascending cash-backed bid (+$10 steps, ≤ cash). |
| `PASS_BID` | eligible bidder | AUCTION · ELIMINATION_AUCTIONS | Binding pass; may resolve the auction. |
| `BUILD` | active | TURN_MANAGEMENT | +1 level (≤ landmark) on a complete-district space. |
| `SELL_UPGRADE` | active or debtor | TURN_MANAGEMENT · SETTLING_DEBT | −1 level; +50% of the price paid for that level. |
| `MORTGAGE` | active or debtor | TURN_MANAGEMENT · SETTLING_DEBT | +50% of list price; level 0 required; no rent while mortgaged. |
| `UNMORTGAGE` | active | TURN_MANAGEMENT | Pays 110% of list price. |
| `OFFER_TRADE` | active (or debtor) | TURN_MANAGEMENT · SETTLING_DEBT | Replaces any pending offer; anchors expiry. |
| `ANSWER_TRADE` | designated recipient | any PLAYING (offer pending) | ACCEPT (atomic transfer) · REJECT · COUNTER (roles swap, re-anchor). |
| `SETTLE_DEBT` | debtor | SETTLING_DEBT | One atomic payment; requires `cash ≥ due`. |
| `SURRENDER` | active (voluntary) or debtor | TURN_MANAGEMENT · SETTLING_DEBT | Voluntary or forced (hopeless) bankruptcy → waterfall. |
| `END_TURN` | active | TURN_MANAGEMENT | Expires the pending offer; victory check; doubles re-roll or next player. |

## 4. Transition table

| # | Phase | Command | Actor | Guard | Effects and events | Next |
|---|---|---|---|---|---|---|
| 1 | AWAITING_ROLL | ROLL | active | none | 2d6 drawn (meta carries the values); doubles counter +1 on doubles | RESOLVING_MOVE (same command continues) |
| 2 | AWAITING_ROLL | HOLD | active | holds a Hold token | token consumed; `TOKEN_CONSUMED` + `TURN_SKIPPED` + `TURN_ENDED`; victory check | next player's AWAITING_ROLL (or GAME_OVER) |
| 3 | RESOLVING_MOVE | *(automatic inside ROLL)* | system | — | token advances; **start bonus $250 on any forward pass or landing of Gateway Terminal** (never on backward movement); landed space resolves: rent (`RENT_PAID`), tax (`TAX_PAID`), service (`SERVICE_CHARGED`), or event (`CARD_DRAWN`/`CARD_EFFECT_APPLIED`); unowned purchasable → buy decision; short cash → debt entry (`DEBT_ENTERED`) | BUY_DECISION · SETTLING_DEBT · TURN_MANAGEMENT |
| 4 | RESOLVING_MOVE | *(automatic — third consecutive doubles)* | system | doublesCount reached 3 | **no movement**; token to the nearest park; `skipNextTurn` marked; counter resets | TURN_ENDED → next player's AWAITING_ROLL |
| 5 | BUY_DECISION | BUY | active | cash ≥ list price | `PROPERTY_PURCHASED` | TURN_MANAGEMENT |
| 6 | BUY_DECISION | PASS_TO_AUCTION | active | — | `AUCTION_OPENED` (reason `DECLINED`) | AUCTION |
| 7 | AUCTION | BID | eligible bidder | amount = current + $10k, ≤ cash | `AUCTION_BID` | AUCTION, or immediate resolution when one unpassed bidder remains |
| 8 | AUCTION | PASS_BID | eligible bidder | — | `AUCTION_PASS` (binding); may resolve per the auction rules | AUCTION · TURN_MANAGEMENT |
| 9 | TURN_MANAGEMENT | BUILD / SELL_UPGRADE / MORTGAGE / UNMORTGAGE | active | legality per `docs/RULES.md` | `UPGRADE_BUILT` / `UPGRADE_SOLD` / `MORTGAGE_TAKEN` / `MORTGAGE_LIFTED` | TURN_MANAGEMENT |
| 10 | TURN_MANAGEMENT | OFFER_TRADE / ANSWER_TRADE | proposer / recipient | §3 registry guards | `TRADE_OFFERED` / `TRADE_ANSWERED` (accept/reject/counter) | TURN_MANAGEMENT |
| 11 | TURN_MANAGEMENT | SURRENDER | active | none (voluntary) | the bankruptcy waterfall (§7) | elimination handling |
| 12 | TURN_MANAGEMENT | END_TURN | active | — | pending offer expiry (`TRADE_EXPIRED`); victory check; **doubles re-roll** (counter < 3 → same player) | AWAITING_ROLL (same or next player) · GAME_OVER |
| 13 | SETTLING_DEBT | SELL_UPGRADE / MORTGAGE | debtor | raises cash | liquidation events (unilateral, no consent) | SETTLING_DEBT until cash ≥ due |
| 14 | SETTLING_DEBT | OFFER_TRADE / ANSWER_TRADE | debtor proposes; anyone answers | consented by acceptance | ordinary trade events | SETTLING_DEBT |
| 15 | SETTLING_DEBT | SETTLE_DEBT | debtor | cash ≥ due | one atomic payment; `DEBT_SETTLED` | TURN_MANAGEMENT |
| 16 | SETTLING_DEBT | SURRENDER | debtor | optional; **mandatory when hopeless** (`DEBT_HOPELESS` rejects all else) | the waterfall (§7) | elimination handling |
| 17 | ELIMINATION_AUCTIONS | BID / PASS_BID | eligible bidders | reason `BANK_ESTATE` | per-property sequential auctions; unsold → bank unowned | after the last property: victory check, then the interrupted turn resumes at TURN_MANAGEMENT |
| 18 | any PLAYING | *(system)* | system | elimination or end condition | `VICTORY_DECIDED` / `GAME_ENDED` | GAME_OVER — all commands reject with `GAME_IS_OVER` |

**Doubles semantics:** doubles grant exactly one extra cycle (row 12); the
counter resets on any non-doubles roll, on the third-doubles penalty, and when
the turn passes. There is no unlimited re-roll chain.

**Card movement:** "move to" cards count as landing on the target (forward
moves grant the Gateway start bonus; backward moves never do) and can trigger
rent, debt, and the buy decision — all inside `RESOLVING_MOVE`.

**Pending offers:** survive turn boundaries; expire exactly when the
proposer's turn next ends (`turnAnchor` comparison — state-only, no timers) or
when a participant is eliminated/bankrupt (`TRADE_CANCELLED`). A counteroffer
replaces the pending offer and re-anchors expiry to the new proposer.

## 5. Event catalog (35 types)

Stamps: every event carries a gapless per-game `sequence`, the composite
`eventId = <gameId>-e<sequence>`, the producing `commandId`, and the current
`rulesVersion`. `meta` records draw **results** (dice values, card ids) —
never raw PRNG words.

| Family | Events |
|---|---|
| Lifecycle | `GAME_CREATED`, `TURN_STARTED`, `TURN_SKIPPED`, `TURN_ENDED`, `SNAPSHOT_SAVED`, `GAME_ENDED`, `VICTORY_DECIDED` |
| Movement | `DICE_ROLLED`, `PLAYER_MOVED`, `START_BONUS_PAID` |
| Ownership & money | `PROPERTY_PURCHASED`, `RENT_PAID`, `TAX_PAID`, `SERVICE_CHARGED` |
| Event deck | `CARD_DRAWN`, `CARD_EFFECT_APPLIED`, `TOKEN_CONSUMED` |
| Development | `UPGRADE_BUILT`, `UPGRADE_SOLD`, `MORTGAGE_TAKEN`, `MORTGAGE_LIFTED` |
| Auctions | `AUCTION_OPENED`, `AUCTION_BID`, `AUCTION_PASS`, `AUCTION_RESOLVED`, `AUCTION_CLOSED_UNSOLD` |
| Trading | `TRADE_OFFERED`, `TRADE_ANSWERED`, `TRADE_EXPIRED`, `TRADE_CANCELLED` |
| Debt & bankruptcy | `DEBT_ENTERED`, `DEBT_SETTLED`, `PLAYER_BANKRUPT`, `ASSETS_TRANSFERRED`, `PLAYER_ELIMINATED` |

Commands map many-to-many: `ROLL` may emit dice/move/bonus/rent/tax/card
events plus `DEBT_ENTERED`; `END_TURN` may emit `TURN_ENDED` +
`VICTORY_DECIDED` + `GAME_ENDED`; a skipped turn emits `TURN_SKIPPED` +
`TURN_ENDED`.

## 6. The §17.2 structural pin — settleable debt never emits bankruptcy

Per the approved spec's §17.2 amendment, the debt-settlement surfaces are
**structurally unable** to produce bankruptcy:

- Every engine surface declares its own event vocabulary
  (`EconomyEventInput`, `SettlementEventInput`, `AuctionEventInput`,
  `DevelopmentEventInput`, `TradeEventInput`). None of them contains
  `PLAYER_BANKRUPT`, `ASSETS_TRANSFERRED`, or `PLAYER_ELIMINATED` — only
  `EndgameEventInput` (the waterfall, estate sales, victory) declares those
  members, and only `SURRENDER` reaches it (pinned by type-level `Extract<…>`
  exclusivity tests and runtime negative tests in
  `tests/game/debt.test.ts`, `tests/game/auction.test.ts`,
  `tests/game/trading.test.ts`).
- **Hopeless detection is pure:** `isDebtHopeless` compares the due amount
  against cash + maximum liquidation (sell-backs at 50% of price paid,
  mortgages at 50% of list). When short, the reducer's veto rejects every
  command except `SURRENDER` with `DEBT_HOPELESS` — bankruptcy is forced
  immediately, never a stalemate and never a half-applied state.
- **History:** PR 5 shipped the transitional seam (typed `DEBT_UNRESOLVABLE`
  rejection; the game paused in `SETTLING_DEBT` instead of exhibiting partial
  bankruptcy). The endgame PR replaced that seam with the `DEBT_HOPELESS` veto
  plus the full waterfall, and acceptance tests exist on both sides of the
  replacement.

## 7. The bankruptcy waterfall (SURRENDER — voluntary or forced)

Each step is its own tested, replayable transition, emitted only by
`EndgameEventInput` handlers:

1. **Cash transfer** — the debtor's entire cash goes to the creditor (the
   bank when the bank is the creditor).
2. **Upgrade liquidation** — every level sells back at 50% of the price
   originally paid; proceeds go to the creditor (for a bank creditor, levels
   are removed with no payment).
3. **Property transfer** — to a **player** creditor: all owned spaces transfer
   **with mortgage flags intact** (the creditor may unmortgage later at 110%).
4. **Bank repossession (bank creditor)** — owned spaces return to the bank
   unowned, and their **mortgage flags are cleared** (the mortgage liability
   died with the ownership; repossessed spaces are clean for the next buyer).
   Pinned by test (`tests/game/endgame.test.ts`).
5. **Estate sale (bank creditor)** — each estate space is sold in one
   sequential `ELIMINATION_AUCTIONS` auction under the ordinary cash-backed
   auction rules; the queue persists in `estateSale.pendingSpaceIds`
   (schema v2) so the interrupted turn resumes exactly. Unsold spaces return
   to the bank unowned.
6. **Elimination** — the player is marked `bankrupt`, removed from turn order,
   tokens discarded (`PLAYER_ELIMINATED`); assets move via
   `ASSETS_TRANSFERRED`; `PLAYER_BANKRUPT` marks the waterfall's entry.
7. **Trade cancellation** — every open offer involving the eliminated player
   fires `TRADE_CANCELLED`.
8. **Victory evaluation** — immediately after elimination (last-solvent
   check), then the standard end conditions (§8).

Phase 1 debts arise only from `RESOLVING_MOVE` (the mover pays), so the
debtor is always the active player and their turn ends without a management
phase. Elimination auctions complete before play resumes. A future
non-active bankruptcy would resolve identically: elimination handling, then
the turn owner continues.

## 8. Victory

Evaluated (a) at every elimination, (b) at every `TURN_ENDED` against the
mode's net-worth target, and (c) at the round-cap handover — when a roll would
start a round beyond the cap, the richest player wins (ties share the
victory). The over-cap round never begins (`state.round` never exceeds the
cap; see the Blitz cap test). First condition reached ends the game:
`VICTORY_DECIDED` + `GAME_ENDED`, phase `GAME_OVER`.

## 9. Snapshot schema history

`GameSnapshot` = `{ schemaVersion, rulesVersion, gameId, seed, stateVersion,
state }`. Loading goes through `parseSnapshot`, which refuses anything it
cannot interpret with a typed reason — never a silent load.

| Schema version | Introduced | State shape |
|---|---|---|
| **v1** | Engine foundation (PR 2) | The original `GameState`: all base fields, **no** `round`, **no** `estateSale`. |
| **v2** | Bankruptcy waterfall (PR 9) — current | Adds **round tracking** (`state.round`) and the **persisted estate-sale queue** (`estateSale.pendingSpaceIds`), with the auction-reason ⇔ turn-phase cross-invariants (`AUCTION` ⇔ a `DECLINED` auction is open; `ELIMINATION_AUCTIONS` ⇔ a `BANK_ESTATE` auction is open). |

There is no migration path from v1: unknown `schemaVersion` (older or newer)
is refused with `UNKNOWN_SCHEMA_VERSION` and the UI offers a new game — a
deliberate rollback-safe gate, because an old build must never be handed a
state shape it cannot interpret. A regression test pins
`SNAPSHOT_SCHEMA_VERSION === 2` so a future version bump is a conscious,
reviewed change (`tests/game/endgame.test.ts`).

## 10. Invariants the engine guarantees

1. Every state change flows through `applyCommand`; the input state is never
   mutated (rejections included).
2. `state.version` counts applied commands; rejections and idempotent
   duplicates change nothing.
3. Event sequences are gapless; replay from `{ seed, ordered commands }`
   reproduces the state hash exactly.
4. Settleable-debt paths cannot emit bankruptcy events (§6).
5. Money is never created outside the named formulas (`docs/RULES.md`) —
   no credit, no negative cash after any applied command.
6. A debt is either settled or bankrupted before any victory evaluation —
   net worth is always evaluated on settled state.
