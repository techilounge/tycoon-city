# Tycoon City — Game State Machine (Phase 1, first pass)

**Status:** first pass shipped with the PR 4 vertical slice; finalizes at PR 12 (spec §13).
This document is the source of truth for **state and phase truth**. Rules formulas live in `docs/RULES.md`; transport contracts in `docs/MULTIPLAYER_CONTRACT.md` (PR 12).

## Game phases

```
LOBBY ──START_GAME──▶ PLAYING ──(victory, PR 8)──▶ GAME_OVER
```

- `LOBBY` — players seated, nothing owned; only `START_GAME` is legal.
- `PLAYING` — the whole turn loop below. All slice gameplay happens here.
- `GAME_OVER` — terminal; every command is rejected with `GAME_IS_OVER` (victory evaluation lands with PR 8).

## Turn phases inside PLAYING

Implemented in the slice (spec §4 rows 1–6 and 12):

```
              ┌────────────────────────────────────────────────┐
              │                AWAITING_ROLL                   │
              │  ROLL (row 1) · HOLD (row 2, needs a token)    │
              └───────┬────────────────────────────┬───────────┘
                 ROLL │                         HOLD │ (consumes token)
              ┌───────▼────────────┐                │
              │   RESOLVING_MOVE   │  (automatic;   │
              │  dice move, start  │   no movement) │
              │  bonus, land rule  │                │
              └───────┬────────────┘                │
        unowned       │                             │
        purchasable   ├──────────────────┐          │
        ┌─────────────▼─────┐   ┌────────▼──────────┐
        │   BUY_DECISION    │   │ TURN_MANAGEMENT   │
        │ BUY (row 5) ·     │──▶│ END_TURN (row 12) │
        │ PASS_TO_AUCTION   │   └────────┬──────────┘
        │ (row 6, trans.)   │            │
        └───────────────────┘            │
                    ┌────────────────────┤
                    ▼                    ▼
        same player (doubles:        next player's
        one extra cycle)             AWAITING_ROLL
```

## Transition rows implemented by the slice

| # | Phase | Command | Guard | Effects | Next |
|---|---|---|---|---|---|
| 1 | `AWAITING_ROLL` | `ROLL` | active player | 2d6 drawn (tracked RNG); doubles counter +1 on doubles | `RESOLVING_MOVE` |
| 2 | `AWAITING_ROLL` | `HOLD` | holds a Hold token | token consumed; `TURN_SKIPPED` + `TURN_ENDED`; no roll, no movement | next player's `AWAITING_ROLL` |
| 3 | `RESOLVING_MOVE` | *(automatic)* | — | token advances forward; **$250 start bonus** on any forward pass or landing of Gateway Terminal (never on backward movement — backward moves arrive with the Event Deck, PR 5); landed space resolves | `BUY_DECISION` if unowned purchasable, else `TURN_MANAGEMENT` |
| 4 | `RESOLVING_MOVE` | *(automatic — third doubles)* | doubles counter reached 3 | **no dice movement**; token relocates to the nearest park (no bonus); skip-next-turn marked; counter resets | `TURN_ENDED` → next player's `AWAITING_ROLL` |
| 5 | `BUY_DECISION` | `BUY` | cash ≥ list price | `PROPERTY_PURCHASED` (via `DIRECT`), full-price payment to the bank | `TURN_MANAGEMENT` |
| 6 | `BUY_DECISION` | `PASS_TO_AUCTION` | — | transitional decline in the slice — the auction itself opens with PR 6 (spec §5) | `TURN_MANAGEMENT` |
| 12 | `TURN_MANAGEMENT` | `END_TURN` | — | pending-offer expiry runs on the turn pass (spec §6); victory check seam (PR 8); **doubles grant one extra cycle** | same player's `AWAITING_ROLL` (doubles) · next player's `AWAITING_ROLL` · `GAME_OVER` (PR 8) |
| 10 | `TURN_MANAGEMENT` | `OFFER_TRADE` / `ANSWER_TRADE` (as recipient, any phase while pending) | active player proposes; only the designated recipient answers (spec §6) | `TRADE_OFFERED` / `TRADE_ANSWERED` (accept is atomic; counter reverses roles and replaces the offer) | `TURN_MANAGEMENT` |
| 13 | `SETTLING_DEBT` | `OFFER_TRADE` / `ANSWER_TRADE` | debtor (proposals) + recipient (answers) — Decision D-6 | raises cash toward the due amount by consent | `SETTLING_DEBT` until `SETTLE_DEBT` settles |

Rows 7–9, 11, 14–17 (auction decisions, surrender, non-trade debt rows, elimination auctions, system transitions) land with PRs 6–8 and will be appended here as they are implemented; rows 10 and 13 (trading, spec §6) landed with PR 7.

## Trades (spec §6, PR 7)

- **One pending offer at a time.** `state.trade` holds the single offer awaiting its recipient's answer; a proposal while one pends is rejected.
- **Initiation:** the active player, in `TURN_MANAGEMENT` — or in `SETTLING_DEBT`, where the debtor proposes and answers trades by consent (Decision D-6).
- **Answers:** only the designated recipient, in **any phase while pending** — answering never disturbs the active player's turn.
- **Counter:** reverses proposer/recipient and replaces the pending offer under a fresh id; it is anchored to the new proposer's NEXT turn (its ordinal is stamped when that `TURN_STARTED` fires).
- **Expiry — no wall clock:** an offer stores the turn ordinal whose end kills it; the shared turn-pass path (`advanceToNextTurn`, rows 2/4/12) compares that counter against `state.turn` and emits `TRADE_EXPIRED`. A doubles extra cycle is the same ordinal — an offer survives it.
- **Acceptance is atomic:** both sides are re-validated against current state (ownership of every named space, cash capacity, solvency), then cash and ownership move in one all-or-nothing transition — no credit, cash ≥ 0 both sides after transfer. Mortgaged spaces and built levels ride with the space; the transferee pays the 110% unlock later (spec §6, §8).

## Exact semantics pinned by tests

- **Doubles grant exactly one extra turn-cycle.** After `TURN_MANAGEMENT` of a doubles roll, the same player returns to `AWAITING_ROLL` with the same turn ordinal (`TURN_STARTED` does not re-fire). The consecutive-doubles counter **resets** on any non-doubles roll, on the third-doubles penalty, and when the turn passes to the next player.
- **Third consecutive doubles:** the roll does not move the token by its dice; the token walks to the nearest park (wrapping forward if already on a park), the player's **next** turn is skipped (consumed at the following handover as `TURN_SKIPPED` + `TURN_ENDED` with reason `THIRD_DOUBLES`), and the counter resets. The relocation itself never pays the Gateway bonus.
- **Hold token:** consumed by the holder's own `HOLD` command in `AWAITING_ROLL`; the entire turn is skipped — no roll, no movement, no management phase. End-of-turn victory evaluation (PR 8) still runs.
- **Start bonus:** $250, paid on any *forward* pass or landing of Gateway Terminal — dice moves and (from PR 5) card moves; never on backward movement, never on token placement at game start, never on the third-doubles park relocation.
- **Buy at list price:** `BUY` requires `cash ≥ listPrice` and pays the bank in the same transition; the property's ownership is set atomically with the payment.
- **Hot-seat privacy:** the UI gates the board behind a pass-device screen whenever the active player changes (spec §11) — a presentation concern; the engine has no notion of visibility.

## Commands and their phases (slice)

| Command | Legal phases | Handler |
|---|---|---|
| `START_GAME` | `LOBBY` | seats tokens at Gateway Terminal, first `TURN_STARTED` |
| `ROLL` | `AWAITING_ROLL` | row 1 + row 3/4 resolution |
| `HOLD` | `AWAITING_ROLL` | row 2 |
| `BUY` | `BUY_DECISION` | row 5 |
| `PASS_TO_AUCTION` | `BUY_DECISION` | row 6 (transitional; real auctions in PR 6) |
| `SETTLE_DEBT` | `SETTLING_DEBT` | row 14 (PR 5) |
| `SELL_UPGRADE` / `MORTGAGE` | `SETTLING_DEBT` | debtor liquidation rows (PR 5) |
| `OFFER_TRADE` | `TURN_MANAGEMENT`, `SETTLING_DEBT` | rows 10 and 13 (PR 7) |
| `ANSWER_TRADE` | any phase while an offer is pending | row 10 (PR 7) |
| `END_TURN` | `TURN_MANAGEMENT` | row 12 |
| `SAVE_SNAPSHOT` | any phase | snapshot persistence seam (PR 2) |

All other Phase 1 commands (`BUILD`, `UNMORTGAGE`, `SURRENDER`) still reject with `COMMAND_NOT_IMPLEMENTED` until PR 8 lands.
