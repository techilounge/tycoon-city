# Tycoon City — Architecture (Phase 1)

**Status:** final for Phase 1 · **Rules:** v1 (`RULES_VERSION = 1`) · **Snapshot schema:** v2 ·
Verified against `main` as of the Phase 1 docs wrap-up (base `fc84844`).

This document is the source of truth for **how the system is built** — module
boundaries, data flow, and the seams Phase 2 must fill without rework. Game
rules live in `docs/RULES.md`; state truth in `docs/GAME_STATE_MACHINE.md`;
transport truth in `docs/MULTIPLAYER_CONTRACT.md`; testing truth in
`docs/TESTING.md`; economy evidence in `docs/ECONOMY.md`.

## 1. The one-picture summary

Tycoon City Phase 1 is a local hot-seat game: a **pure deterministic TypeScript
engine** driven entirely by serializable commands, and a Next.js/React UI that
submits commands and renders the resulting events. There is no networking, no
server, no wall clock, and no ambient randomness anywhere in the engine — which
is precisely what makes the Phase 2 move to a server-authoritative multiplayer
system a wiring change rather than a rewrite: the exact same reducer runs
locally in Phase 1 and behind a server in Phase 2.

```
 React UI (src/app, src/components, src/lib/game/ui)
   submits GameCommand            renders projections of GameState + GameEvent[]
        │                                      ▲
        ▼                                      │
 LocalCommandSink  ──calls──▶  applyCommand(state, command, rng)   ← the ONLY entry point
 (engine/transport.ts)             │
        │                          ├─ 8-step validation pipeline (engine/reducer.ts)
        │                          ├─ handler registry → per-surface modules
        │                          └─ stamps GameEvent[] (gapless sequences)
        ▼
 InMemoryEventLog / SnapshotStore  ──▶  localStorage via LocalSnapshotStore (UI adapter)
```

## 2. Repository layout

| Path | Responsibility |
|---|---|
| `src/lib/game/` | The engine and its data — pure, deterministic, framework-free. Importable by the UI, the sim harness, and (in Phase 2) a server. |
| `src/lib/game/types.ts` | Base vocabulary: `GameState`, `GamePhase`/`TurnPhase`, `PlayerState`, `DebtState`, `AuctionState`, `EstateSaleState`, `PendingTradeState`, `BANK_ID`, `RULES_VERSION`, `SNAPSHOT_SCHEMA_VERSION`. |
| `src/lib/game/board-v1.ts` | Board data v1: the 32-space loop, 6 districts, the 18-card Event Deck catalog, mode configurations — pure serializable data. |
| `src/lib/game/rules-v1.ts` | Every economy formula, single-sourced (rent, upgrades, mortgages, hubs, services, assessments, auctions, net worth, card moves). `docs/RULES.md` mirrors these one test per row. |
| `src/lib/game/commands.ts` | The command envelope and per-type payload shape validation (17 command types). |
| `src/lib/game/events.ts` | The event envelope and the 35 Phase 1 event types; `stampEvents` (deterministic ids, gapless sequences); `validateEventEnvelope`. |
| `src/lib/game/rng.ts` | Mulberry32 `RandomSource` (`next`/`nextInt`/`shuffle`/`getState`) and `rngForState` — the canonical way to seed from a state's persisted word. |
| `src/lib/game/snapshot-schema.ts` | `GameSnapshot` (schema v2), `buildSnapshot`/`parseSnapshot` (typed refusals), and `validateGameStateShape` — the persistence boundary's structural validator. |
| `src/lib/game/engine/reducer.ts` | `createGame` + `applyCommand`: the 8-step pipeline, `canAct`, and the `HANDLERS` registry. The engine's only entry points. |
| `src/lib/game/engine/draft.ts` | `GameStateDraft` — the clone-before-write type handlers mutate; commit is all-or-nothing. |
| `src/lib/game/engine/movement.ts` | Pure movement mechanics: `moveForward`, `nearestParkIndex`. |
| `src/lib/game/engine/economy.ts` | Landing resolution: rent, hub rent, service charges, assessments, Event-Deck draws, the `chargePlayer` pay-or-enter-debt seam. |
| `src/lib/game/engine/debt.ts` | Debt settlement surface: debtor liquidation, `maxLiquidationValue`, `isDebtHopeless`. |
| `src/lib/game/engine/auctions.ts` | Cash-backed ascending-bid auctions, shared by declined-buy and bank-estate sales. |
| `src/lib/game/engine/development.ts` | `BUILD`/`SELL_UPGRADE`/`MORTGAGE`/`UNMORTGAGE` in turn management; the liquidation cores shared with debt. |
| `src/lib/game/engine/trading.ts` | Trade lifecycle: offers, answers, counters, state-only expiry, cancellation. |
| `src/lib/game/engine/endgame.ts` | The bankruptcy waterfall, elimination auctions, victory evaluation, and the shared turn handover (`concludeTurn`/`advanceToNextTurn`). |
| `src/lib/game/engine/replay.ts` | `replayCommands`/`replayFromSeed`, `canonicalJson`, and `stateHash` (two FNV-1a passes — a replay-equality fingerprint, not a security primitive). |
| `src/lib/game/engine/errors.ts` | `RuleError` and the closed set of `RuleErrorCode`s. |
| `src/lib/game/engine/transport.ts` | Transport-shaped seams: `CommandSink`, `EventSource`, `SnapshotStore` — with the Phase 1 `LocalCommandSink` and in-memory implementations. |
| `src/lib/game/ui/` | UI-adjacent pure logic: `persistence.ts` (the `localStorage` adapter), `actionDock.ts` (legal-command derivation), `boardLayout.ts`, `history.ts`, `modals.ts`, `tradeBuilder.ts`, `uiPlayer.ts`. |
| `src/app/` | Routes: `/` (home), `/lobby`, `/game` (the live game), `/demo` (the preserved pre-Phase-1 demo). |
| `src/components/` | React components: `Board`, `PlayerRail`, `ActionDock`, `TurnIndicator`, the six domain modals over a shared `Modal`, `HistoryPanel`, `DemoBoard`. |
| `tools/sim/` | The headless balance-simulation harness (`matrix`, `profiles`, `driver`, `metrics`, `report`, `run`) — not imported by the app. |
| `tests/` | Node's built-in runner (`node:test`) through `tsx`: `tests/game/*.test.ts` (engine + UI logic), `tests/sim/harness.test.ts`. |
| `.github/workflows/ci.yml` | CI gates every PR: `npm ci` → typecheck → tests → simulation smoke (20 seeds per cell) → production build. |

## 3. The command lifecycle

Every state change flows through `applyCommand(state, command, rng)` —
`createGame` is the only other producer of state. The pipeline, in enforced
order (see `engine/reducer.ts`):

1. **Shape** — full schema check of the raw envelope and payload
   (`validateCommandShape`); input is treated as untrusted.
2. **Existence** — the command targets this `gameId` and the actor is a player in it.
3. **Version** — `expectedVersion === state.version` or `VERSION_CONFLICT`.
   Idempotency-aware: a retry of an already-processed `commandId` carries its
   original version and is exempted, so legitimate retries reach step 4.
4. **Idempotency** — a processed `commandId` returns ok with `applied: false`
   and applies nothing. The transport layer (`LocalCommandSink`) owns the
   original events and returns them on retry.
5. **Game over** — checked *before* authorization (a finished game admits no
   actor): every command rejects with `GAME_IS_OVER`.
6. **Hopeless-debt veto** — while a debt is open and `isDebtHopeless` (cash +
   maximum liquidation < due), every command except `SURRENDER` rejects with
   `DEBT_HOPELESS`. SURRENDER passes through and runs the waterfall
   (`docs/GAME_STATE_MACHINE.md` §7).
7. **Authorization** — the pure `canAct(state, command)` predicate: the active
   player for turn-scoped commands; eligible auction bidders (`BID`,
   `PASS_BID`, in `AUCTION` or `ELIMINATION_AUCTIONS`); the designated trade
   recipient (`ANSWER_TRADE`); any live player for the hot-seat machinery
   commands (`START_GAME`, `SAVE_SNAPSHOT`). Phase 2's server reuses this
   function verbatim.
8. **Phase / resources / rule constraints** — inside the handler, which may
   throw `RuleError`; the reducer converts that into a returned error before
   the draft is committed.

Purity is structural: the reducer deep-clones the state (`structuredClone`)
before any handler runs, so the input state is never mutated — rejections and
successes alike leave it untouched. A success carries `{ state, events,
applied: true }`; the reducer stamps events with gapless sequences, composite
eventIds (`<gameId>-e<sequence>`), the producing `commandId`, and the current
`rulesVersion`, then persists the RNG word back into `state.rngState`.

## 4. Data flow

- **Commands in:** the UI derives the legal commands from state
  (`src/lib/game/ui/actionDock.ts`) so only currently-legal controls render,
  wraps them in `GameCommand` envelopes, and submits through the
  `LocalCommandSink` (in-process `applyCommand`). Simulated actors drive the
  same class (`tools/sim/driver.ts`) — there is exactly one command path.
- **Events out:** every applied command returns its `GameEvent[]`; the UI
  appends them to an in-memory history (and a capped companion log in
  `localStorage`) and renders explanations from the event payloads themselves —
  for example `RENT_PAID.detail` carries the worked rent arithmetic, so the UI
  never re-runs a formula.
- **State:** the UI holds the sink's state as the render source of truth.
  Projections (legal commands, derived board layout, explanations) are pure
  functions of state — no UI-owned game truth exists.
- **Persistence:** `SAVE_SNAPSHOT` (and autosave after each applied command)
  builds a schema-stamped `GameSnapshot` and writes it via
  `LocalSnapshotStore` (keys `tycoon-city:save:v2` and the capped
  `tycoon-city:log:v2` companion). Loading goes through `parseSnapshot`: any
  unknown schema or rules version, malformed JSON, or header/state mismatch is
  refused with a typed reason and a new-game offer — never silently loaded.

## 5. Determinism and randomness

- Mulberry32 carries a single 32-bit word; every draw advances it and the
  reducer persists the word into `state.rngState` after each command — RNG
  position survives save/resume and replay with zero bookkeeping.
- The Event Deck's draw/discard orders are ordinary state produced by
  `rng.shuffle`; an empty draw pile reshuffles the discard pile (or the catalog,
  before the first draw) with the same seeded source.
- `stateHash` canonicalizes state to JSON (recursively key-sorted) and hashes
  it with two FNV-1a passes — a deterministic change-detector for the
  replay-equality contract, explicitly not a security primitive.
- The engine's randomness contract: callers supply the `RandomSource`;
  canonical wiring is `rngForState(state.rngState)`, so live play, replay, and
  post-snapshot continuation draw identically. Mulberry32 is not
  cryptographically secure (disclosed in `rng.ts`); Phase 2 keeps seeds and
  PRNG state server-private.

## 6. Snapshots and versioning

`GameSnapshot` = `{ schemaVersion, rulesVersion, gameId, seed, stateVersion,
state }`. `schemaVersion` is independent of `rulesVersion`; the current schema
is **v2**. Schema history:

- **v1** (engine foundation): the original state shape.
- **v2** (bankruptcy waterfall): added **round tracking** (`state.round`) and
  the **persisted estate-sale queue** (`state.estateSale.pendingSpaceIds`),
  plus the auction-reason/turn-phase cross-invariants
  (`AUCTION` ⇔ `DECLINED` auction open, `ELIMINATION_AUCTIONS` ⇔
  `BANK_ESTATE` auction open).

There is no migration path from v1: `parseSnapshot` refuses any version other
than the current one with `UNKNOWN_SCHEMA_VERSION` and the UI offers a new
game — a rollback-safe gate, since old builds cannot be handed a shape they
cannot interpret.

## 7. Surface vocabularies — the §17.2 structural pin

Each engine surface declares its own event vocabulary as a union of
`EventInput<...>` members, and the reducer registry dispatches by phase where
one command serves two surfaces (`SELL_UPGRADE`, `MORTGAGE`, `BID`, `PASS_BID`):

| Surface | Union | Bankruptcy member? |
|---|---|---|
| Economy (landing resolution) | `EconomyEventInput` | none |
| Debt settlement | `SettlementEventInput` | none |
| Auctions | `AuctionEventInput` | none |
| Development | `DevelopmentEventInput` | none |
| Trading | `TradeEventInput` | none |
| Endgame (waterfall, estate sales, victory) | `EndgameEventInput` | owns `PLAYER_BANKRUPT`, `ASSETS_TRANSFERRED`, `PLAYER_ELIMINATED` |

The settlement and auction unions have no bankruptcy member at all, so no
settleable-debt or auction path can emit a bankruptcy event — pinned by
type-level tests (`Extract<...>` exclusivity) and runtime negative tests in
`tests/game/debt.test.ts`, `tests/game/auction.test.ts`,
`tests/game/trading.test.ts`. This is the §17.2 amendment's structural
guarantee: PR 5's transitional `DEBT_UNRESOLVABLE` rejection seam was replaced
in the endgame PR by the `DEBT_HOPELESS` veto plus the full waterfall, with
acceptance tests on both sides of the replacement.

## 8. The simulation harness

`tools/sim/` is a headless harness with zero app imports: strategy profiles
(`profiles.ts`) choose commands; the driver (`driver.ts`) runs complete games
through the production `LocalCommandSink`, interleaving the §17.3
multiplayer-contract probes ((a) unauthorized rejection, (b) stale-version
rejection, (c) idempotent duplicate no-op, (d) full-game replay to an identical
state hash) at every roll decision point; `metrics.ts` collects the §8 economy
metrics; `report.ts` renders `docs/ECONOMY.md`. Seeds are pure functions of
`(mode, playerCount, gameIndex)` — `seedForGame` — so the committed report
regenerates byte-for-byte. CI runs a 20-seed-per-cell smoke; the full 500-seed
matrix is a local/scripted job.

## 9. UI layer

- **Routes:** `/` (home), `/lobby` (seat players, pick mode, generate or
  override the seed via `crypto.getRandomValues`), `/game` (the live game),
  `/demo` (the preserved pre-Phase-1 demo, untouched).
- **Components** (`src/components/`): `Board` (perimeter layout from
  `boardLayout.ts`), `PlayerRail`, `ActionDock` (context-sensitive legal
  commands), `TurnIndicator`, `HistoryPanel` (the rendered event log), and the
  modals — `AuctionModal`, `TradeModal`, `EventModal`, `DebtModal`,
  `BankruptcyModal`, `VictoryModal` over a shared `Modal`, prioritized so the
  most urgent surface wins.
- **Hot-seat privacy:** when the active player changes, a full-screen handoff
  hides the board until the next player takes over — a presentation concern
  only; the engine has no notion of visibility.
- **Presentation constraints:** premium navy/teal/gold, responsive with no
  page-level horizontal overflow at 360 px, visible focus, and
  `prefers-reduced-motion` respected for the dice/token animations.

## 10. What Phase 2 must not break

The Phase 2 server owns `applyCommand`, the seed, and all secrets; clients
submit commands and render projections, and never become authoritative. The
seams that make that a wiring change — `CommandSink`, `EventSource`,
`SnapshotStore`, `canAct`, `expectedVersion` optimistic concurrency, the
idempotency ledger, gapless event sequences, and replay — are specified in
`docs/MULTIPLAYER_CONTRACT.md`, including which of them are already code
versus documented contract. Nothing in the engine reads the clock, the DOM, or
ambient randomness, so the same reducer can run on either side of that line.
