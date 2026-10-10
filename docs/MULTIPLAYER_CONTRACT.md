# Tycoon City — Multiplayer Contract (Phase 2 readiness)

**Status:** final for Phase 1 · Companion to spec §10.

Phase 1 ships no networking. This document is the contract that makes Phase 2
a **wiring change, not a contract change**: the guarantees a Phase 2
server-authoritative system must preserve, which of them are already running
code demonstrated over complete games, and which are documented-only until the
server exists. The production WebSocket server itself is explicitly out of
Phase 1 scope.

## 1. The load-bearing principle

The exact same reducer (`applyCommand`) runs locally in Phase 1 and behind a
server in Phase 2, because all game truth lives in serializable commands,
events, and snapshots — no DOM, no wall clock, no ambient randomness inside
the engine. In Phase 2 the server owns `applyCommand`, the seed, and all
secrets; **the client submits commands and renders projections only, and never
becomes authoritative.**

## 2. Contracts already in code (Phase 1 demonstrates them)

### 2.1 Command submission — `CommandSink`

```ts
interface CommandSink { submit(command: GameCommand): Promise<CommandResult>; }
```

Phase 1: `LocalCommandSink` (`src/lib/game/engine/transport.ts`) calls
`applyCommand` in-process, owns the state, the event log, and the stored
events per `commandId`. Phase 2: a WebSocket RPC sink backed by the server —
same interface, same `GameCommand` envelope, same `CommandResult` shapes.

### 2.2 Actor authorization — `canAct`

```ts
function canAct(state: GameState, command: GameCommand): boolean
```

A pure predicate exported from `engine/reducer.ts`, covering the active-player
default, eligible auction bidders (declined-buy **and** bank-estate auctions),
and the designated trade recipient. The Phase 2 server reuses it verbatim,
server-side — it is not duplicated logic.

**Demonstrated:** every simulated game drives a non-active live player's
`ROLL` through the production sink; it must reject with `NOT_AUTHORIZED` and
leave the state hash unchanged (`tools/sim/driver.ts`, §17.3(a)). Across the
committed 6,000-game report: 630,158 rejections, all clean
(`docs/ECONOMY.md`, "Multiplayer-contract demonstration").

### 2.3 Optimistic concurrency — `expectedVersion`

Every command carries `expectedVersion = state.version` it was composed
against; a mismatch rejects with `VERSION_CONFLICT` and applies nothing.
Phase 1 rejects stale hot-seat input; Phase 2 applies the identical check to
every client submission for free.

**Demonstrated:** stale-version probes at every roll decision point
(§17.3(b)) — 630,158 rejections, state hash unchanged after each.

### 2.4 Command idempotency — the `commandId` ledger

A `commandId` applies exactly once. Retries of a processed command return ok
with `applied: false` and the **stored events of the original application**
(sourced from the sink's command log — state keeps only the ids). Phase 2
transport layers get duplicate delivery as a fact of life; the contract makes
it a no-op rather than a double effect.

**Demonstrated:** duplicate-submission probes at every roll decision point
(§17.3(c)) — 630,158 no-op replays.

### 2.5 Event log — gapless sequences and `EventSource`

```ts
interface EventSource {
  subscribe(gameId: string, fromSeq: number, onEvent: (e: GameEvent) => void): Unsubscribe;
}
```

Sequences are monotonic and gapless per game; `eventId` is the composite
`<gameId>-e<sequence>`, so replay reproduces the log byte-for-byte. Phase 1:
`InMemoryEventLog`/`InMemoryEventSource` replay from the local log (catch-up
first, then live listeners). Phase 2: server fan-out over WebSocket, same
subscription shape.

### 2.6 Snapshots — `SnapshotStore`

```ts
interface SnapshotStore {
  save(snapshot: GameSnapshot): void;
  load(gameId: string): GameSnapshot | null;
}
```

Phase 1: in-memory store, with the UI's `LocalSnapshotStore` as the
`localStorage` adapter (schema-validated, refusal on any unknown version).
Phase 2: a server DB serving reconnection payloads — same interface.

### 2.7 Replay — the state-hash contract

Identical initial state plus identical ordered command history must produce an
identical state hash (`stateHash` over canonical JSON). Replay refolds the
**actual submission log** — rejections and idempotent duplicates included, as
they happened live. This is what makes server reconciliation, spectator
catch-up, and dispute audits possible without new engine code.

**Demonstrated:** every completed simulated game refolds its full ordered log
(probes included) from `{ seed, mode, players }` to the live final state hash
(§17.3(d)) — 6,000/6,000 identical in the committed report.

## 3. Contracts documented-only until Phase 2 (no Phase 2 code exists)

These are specified now so the Phase 2 design cannot quietly break them. They
are **not** in the Phase 1 codebase as runtime interfaces — deviating from the
original "every interface ships as code in PR 2" expectation — because no
local behavior could exercise them meaningfully; they are noted here plainly.

| Contract | Phase 2 shape | Phase 1 status |
|---|---|---|
| Reconnection | Load snapshot, stream missed events `fromSeq` → now; gapless sequences make catch-up exact | n/a (single device); the `fromSeq` subscription already exists |
| Turn & auction deadlines | Server-enforced `DeadlinePolicy` — auto-pass on expiry, void-bid on disqualification | none in code; the UI timer is cosmetic and the engine is wall-clock-free by design |
| Async-bid void-and-reopen | A high bidder who becomes ineligible (timeout) is voided; the auction continues without them; with no bids remaining it closes unsold | impossible in Phase 1 (no payment can occur while an auction is open, so a winning bid is always payable) |
| AI substitution | `AutoPlayerStrategy` fills disconnected seats | interface stub not implemented (documented, spec §10) |
| Spectator projections | `projectPublicState(state, viewerId)` redacts server secrets and private info | identity in hot-seat (all state is on one trusted device) |

## 4. The public/private boundary

In Phase 1, `rngState` and the Event-Deck pile orders are ordinary client-side
state — the whole point of hot-seat. In Phase 2 they become **server-private**:

- The server generates the seed (uniform `uint32`) and never reveals it; event
  `meta` already carries only draw **results** (dice values, card ids), never
  raw PRNG words, so the event log leaks nothing a client could use to predict
  future draws.
- The `RandomSource` interface is the seam where a server swaps in a different
  (or cryptographically strong) generator without touching the engine
  contract. Mulberry32 is explicitly **not** cryptographically secure
  (disclosed in `src/lib/game/rng.ts`) — it must never guard secrets.
- Dice, money, ownership, auctions, trades, and deadlines are all
  server-controlled in Phase 2. The engine's validation pipeline (shape →
  existence → version → idempotency → game-over → hopeless-debt veto →
  authorization → phase/resources/rules) is exactly the server's trust
  boundary; nothing about it assumes a trusted client.

## 5. What a Phase 2 server must preserve (checklist)

1. Every state change flows through `applyCommand` — no direct state writes.
2. `canAct` is the authorization function — reused, not reimplemented.
3. `expectedVersion` is checked on every submission (idempotent retries exempt).
4. `commandId` applies exactly once; duplicates return the stored events.
5. Event sequences stay gapless; `meta` carries results, never PRNG words.
6. Snapshots are schema-gated; unknown versions refuse cleanly.
7. Replay from `{ seed, ordered commands }` reproduces the state hash.
8. The engine stays free of wall-clock, DOM, and ambient randomness.

## 6. Evidence

The four demonstrated guarantees (§2.2–§2.5 above) are re-proven on every CI
run by the 20-seed-per-cell simulation smoke, and in full by the committed
6,000-game report — see `docs/ECONOMY.md`
("Multiplayer-contract demonstration") and `docs/TESTING.md` ("The
multiplayer-contract demonstration"), which reference the same evidence
rather than restating it.
