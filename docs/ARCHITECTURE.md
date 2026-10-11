# Tycoon City — Architecture

**Status:** final (Phase 1 + Phase 2) · **Rules:** v1 (`RULES_VERSION = 1`) · **Snapshot schema:** v2 ·
Verified against `main` as of the Phase 2 docs wrap-up (base `3e31525`).

This document is the source of truth for **how the system is built** — module
boundaries, data flow, and the seams Phase 2 must fill without rework. Game
rules live in `docs/RULES.md`; state truth in `docs/GAME_STATE_MACHINE.md`;
transport truth in `docs/MULTIPLAYER_CONTRACT.md`; testing truth in
`docs/TESTING.md`; economy evidence in `docs/ECONOMY.md`.

## 1. The one-picture summary

Tycoon City is a **pure deterministic TypeScript engine** driven entirely by
serializable commands, and a Next.js/React UI that submits commands and
renders the resulting events. Since Phase 2 (PRs #14–#18) the same reducer
runs in two places — in the browser for local hot-seat, and inside the Node
server for online multiplayer — a wiring change, not a rewrite: there is no
wall clock and no ambient randomness anywhere in the engine, and every state
change in either mode flows through the identical `applyCommand`.

```
 Local mode (one trusted device)
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

 Online mode (server-authoritative)
   React UI                                    Node process (one port, e.g. 3000)
     NetworkCommandSink ──game:command──▶   server.ts → server/start.ts
     SocketEventSource  ◀─game:event─────     ├─ Next handler (app + /demo)
          ▲   │   game:state                  ├─ Socket.IO gateway (auth, rate limits, rooms)
          └───┴── game:deadline               └─ GameHost per game (server/game/gameHost.ts)
                                                    ├─ per-game submit queue (game/queue.ts)
                                                    ├─ applyCommand — verbatim, the only transition
                                                    ├─ SQLite: events + ledger + snapshot, one tx
                                                    ├─ DeadlineScheduler (game/deadlines.ts)
                                                    └─ projectClientState (game/redact.ts) → broadcast
```

## 2. Repository layout

| Path | Responsibility |
|---|---|
| `src/lib/game/` | The engine and its data — pure, deterministic, framework-free. Importable by the UI, the sim harness, and (in Phase 2) a server. |
| `src/lib/game/types.ts` | Base vocabulary: `GameState`, `GamePhase`/`TurnPhase`, `PlayerState`, `DebtState`, `AuctionState`, `EstateSaleState`, `PendingTradeState`, `BANK_ID`, `RULES_VERSION`, `SNAPSHOT_SCHEMA_VERSION`. |
| `src/lib/game/board-v1.ts` | Board data v1: the 32-space loop, 6 districts, the 18-card Event Deck catalog, mode configurations — pure serializable data. |
| `src/lib/game/rules-v1.ts` | Every economy formula, single-sourced (rent, upgrades, mortgages, hubs, services, assessments, auctions, net worth, card moves). `docs/RULES.md` mirrors these one test per row. |
| `src/lib/game/commands.ts` | The command envelope and per-type payload shape validation (18 command types — the Phase 2 addition is the bank-acted `VOID_BID`). |
| `src/lib/game/events.ts` | The event envelope and the 36 event types (Phase 2 adds `AUCTION_BID_VOIDED`); `stampEvents` (deterministic ids, gapless sequences); `validateEventEnvelope`. |
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
| `server/` | The Phase 2 server: `start.ts` (one Node process — Next handler + Socket.IO + SQLite opened before listen), `gateway.ts` (the socket surface: session auth, rate limits, room create/join, the command funnel), `db.ts` (SQLite via `better-sqlite3`: games, events, command ledger, sessions), `sessions.ts` (opaque tokens bound to `(gameId, actorId)`, 7-day expiry), `rateLimit.ts` (per-connection token buckets), `game/queue.ts` (the per-game submit queue), `game/gameHost.ts` (the authoritative per-game service, §11), `game/deadlines.ts` (§12), `game/redact.ts` (`projectClientState`, §11). |
| `src/lib/game/transport/` | The client transport: `protocol.ts` (socket event names and wire payload types), `createCommandSink.ts` (mode selection — local sink for hot-seat, network bundle for online), `networkSink.ts` (`NetworkCommandSink`/`SocketEventSource`: idempotent retries, version conflicts, ack timeout, gap detection), `onlineClient.ts` (connection lifecycle: join/reconnect, session persistence, `ConnectionState`), `clientState.ts` (`ClientGameState` — the redacted public shape). |
| `src/app/` | Routes: `/` (home), `/lobby` (seats and the mode picker — Local or Online), `/game` (the live game — local or `OnlineGameScreen`), `/demo` (the preserved pre-Phase-1 demo). |
| `src/components/` | React components: `Board`, `PlayerRail`, `ActionDock`, `TurnIndicator`, the six domain modals over a shared `Modal`, `HistoryPanel`, `DemoBoard` — plus the online surfaces `RoomPanel` (seats, connection dots), `ConnectionBadge` (live/reconnecting/offline), `DeadlineBar` (renders the server-broadcast deadline), and `ErrorToasts` (wire-fault surfacing). |
| `tools/sim/` | The headless balance-simulation harness (`matrix`, `profiles`, `driver`, `metrics`, `report`, `run`) — not imported by the app. |
| `tests/` | Node's built-in runner (`node:test`) through `tsx`: `tests/game/*.test.ts` (engine + UI logic), `tests/server/*.test.ts` (the networked server), `tests/transport/*.test.ts` (the client transport against the real gateway), `tests/ui/*.test.ts`, `tests/sim/harness.test.ts`. |
| `.github/workflows/ci.yml` | CI gates every PR with two jobs — `verify` (`npm ci` → typecheck → tests → simulation smoke (20 seeds per cell) → production build) and `server` (`npm ci` → typecheck → the server conformance suite `tests/server/*.test.ts`). |

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
   commands (`START_GAME`, `SAVE_SNAPSHOT`); the bank (`BANK_ID`) for
   `VOID_BID` — the one command whose legal actor is the bank, composed only
   by the server's deadline service (§12). The server reuses this function
   verbatim and stamps `actorId` from the authenticated session before
   validation — a client's claimed identity is never trusted.
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
- **Online:** the page asks `createCommandSink` for the transport by mode;
  online, commands travel over Socket.IO (`NetworkCommandSink`), state arrives
  as the redacted `ClientGameState` broadcast, and events append to the same
  history UI — the render path never learns whether the sink was local or
  remote.
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

- **Routes:** `/` (home), `/lobby` (seats and the mode picker; custom seeds
  via `crypto.getRandomValues` remain a **hot-seat-only** feature — online
  games take the server-minted seed), `/game` (the live game — local or
  online), `/demo` (the preserved pre-Phase-1 demo, untouched).
- **Components** (`src/components/`): `Board` (perimeter layout from
  `boardLayout.ts`), `PlayerRail`, `ActionDock` (context-sensitive legal
  commands), `TurnIndicator`, `HistoryPanel` (the rendered event log), and the
  modals — `AuctionModal`, `TradeModal`, `EventModal`, `DebtModal`,
  `BankruptcyModal`, `VictoryModal` over a shared `Modal`, prioritized so the
  most urgent surface wins.
- **Hot-seat privacy:** when the active player changes, a full-screen handoff
  hides the board until the next player takes over — a presentation concern
  only; the engine has no notion of visibility.
- **Online mode:** `/game?mode=online&code=…` renders `OnlineGameScreen`,
  whose state comes from the server broadcasts. `RoomPanel` shows seats with
  connection dots, `ConnectionBadge` shows live/reconnecting/offline, and
  `ErrorToasts` surfaces wire faults (rate limits, room refusals).
  `DeadlineBar` is the presentation-only countdown — **its binding to the
  `game:deadline` broadcast is not yet landed** (the prop is currently `null`
  and the bar renders nothing); deadline enforcement is entirely server-side
  (§12).
- **Presentation constraints:** premium navy/teal/gold, responsive with no
  page-level horizontal overflow at 360 px, visible focus, and
  `prefers-reduced-motion` respected for the dice/token animations.

## 10. The invariants the server preserves

The server owns `applyCommand`, the seed, and all secrets; clients submit
commands and render projections, and never become authoritative. The seams
that made that a wiring change — `CommandSink`, `EventSource`,
`SnapshotStore`, `canAct`, `expectedVersion` optimistic concurrency, the
idempotency ledger, gapless event sequences, and replay — are implemented;
`docs/MULTIPLAYER_CONTRACT.md` tracks the evidence per contract. Nothing in
the engine reads the clock, the DOM, or ambient randomness, so the same
reducer runs on either side of that line — in the browser and in the
`GameHost`.

## 11. The server — one process, one port, one authority

`server.ts` boots one Node process (`server/start.ts`) serving the Next.js
app (including `/demo`) and the game sockets on a single HTTP port; SQLite is
opened **before** listen, so a bad DB path fails fast rather than
half-booting. Dev mode (`npm run dev`) wraps the same compiler as `next dev`;
production (`npm start`) serves the `next build` output. Next dev hot-reload
covers pages and components only — a change under `server/` requires a full
restart of `npm run dev` (see `docs/TESTING.md`).

- **Gateway** (`server/gateway.ts`): the Socket.IO surface. Every command
  presents a session token; the gateway stamps `command.actorId` from the
  session — a forged identity claim never reaches `canAct` — and enforces
  per-connection token-bucket rate limits (20 commands per 10 s, joins
  5/min per IP) **before** the queue: an over-budget submission gets
  `game:error { code: 'RATE_LIMITED' }`, never a disconnect.
- **Rooms** (`server/game/rooms.ts`): create/join by a 6-character room code
  (unambiguous alphabet — no `0/O/1/I`); joining is allowed only in the LOBBY
  phase (`ROOM_IN_PROGRESS` otherwise); seats cap at 6.
- **GameHost** (`server/game/gameHost.ts`): the authoritative per-game
  service. All submissions — player commands and deadline actions — enter one
  per-game queue (`server/game/queue.ts`), so `applyCommand` never sees
  concurrent state; `expectedVersion` remains the client-facing
  optimistic-concurrency guard on top. After every applied command the host
  writes three things in one SQLite transaction — the event batch, the same
  batch keyed by `commandId` (the idempotency ledger), and the serialized
  snapshot — then broadcasts the events, the redacted state, and the deadline
  broadcast. `GameHost.resume` reloads the latest snapshot, so a server
  restart resumes the room; idempotent retries across restarts read the
  `commands` ledger.
- **Redaction** (`server/game/redact.ts` + `transport/clientState.ts`): the
  public/private boundary is the type `ClientGameState` (`Omit<GameState, …>`
  dropping `rngState` and the deck orders), enforced twice — a type-level pin
  and a runtime scan of every emitted `game:state` payload for the forbidden
  keys (`tests/server/redaction.test.ts`). A redaction leak fails CI, not a
  player's trust.
- **SQLite** (`server/db.ts`, file `./data/tycoon.db`): four tables — `games`
  (room code, mode, phase, the serialized state snapshot), `events` (the
  gapless log, `(game_id, sequence)` primary key), `commands` (the
  applied-command ledger: stored events per `command_id`), and `sessions`
  (tokens bound to `(game_id, actor_id)`, `expires_at` 7 days after
  creation). Replay stays a test/audit tool; runtime recovery reads the
  snapshot and the ledger.

## 12. Server-enforced deadlines — timers that act like players

The server owns the clock (contract §3): `server/game/deadlines.ts` defines
the `DeadlinePolicy` per mode (turn windows: Classic 90 s / Quick 60 s /
Blitz 45 s; auction bid window: 30 s — tunable constants) and the
`DeadlineScheduler` arms one window per pending decision, re-armed from the
current state after every applied command and on resume — every state change
grants a full fresh window ("decision idle timeout", not a shared budget).

On expiry the scheduler invents no engine semantics: the host composes an
**ordinary command** — the pending turn decision's timeout action for the
expired player (`ROLL` / `PASS_TO_AUCTION` / `SURRENDER` / `END_TURN`), the
bank's `VOID_BID` for a standing timed-out high bid, or a binding `PASS_BID`
for an AFK bidless auction — and submits it through the **same per-game
queue** as player commands, under a `server-auto-…` command id, so it crosses
the identical 8-step pipeline, is ledgered, and replays exactly like any
other submission. Composition and application are one queue task: a player
command can never interleave between them, so a deadline either applies
(winning the version race over later submissions) or is dropped by the
scheduler's generation check when a state change already resolved it. The
engine stays wall-clock-free — the timers live entirely server-side; clients
learn the current windows only from the `game:deadline` broadcast —
`DeadlineBar` is built to render them presentation-only, though its
broadcast-to-prop binding is not yet landed (§9).
