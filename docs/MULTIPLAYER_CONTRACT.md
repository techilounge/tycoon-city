# Tycoon City — Multiplayer Contract

**Status:** implemented (Phase 2, PRs #14–#18) · Companion to spec §10.

Phase 1 shipped no networking; this document is the contract that made Phase 2
a **wiring change, not a contract change** — and Phase 2 landed on it exactly
that way (PRs #14–#18). It remains the statement of the guarantees the
server-authoritative system must preserve, which of them are running code
demonstrated over complete games, and which are documented-only deferrals.
The §3 status column tracks the implementation; everything promised below is
now enforced server-side except the two deferrals named there.

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
events per `commandId`. **Landed (Phase 2):** `NetworkCommandSink`
(`src/lib/game/transport/networkSink.ts`) submits over Socket.IO
(`game:command`) and the ack carries the server's `CommandResult` verbatim —
same interface, same `GameCommand` envelope, same `CommandResult` shapes;
`createCommandSink` (`transport/createCommandSink.ts`) selects the local sink
for hot-seat and the network sink for online, so both modes share exactly one
command path in the game page.

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
first, then live listeners). **Landed (Phase 2):** the gateway fans out
`game:event` to the room in stamped order and streams the durable log from
`fromSeq` on join/reconnect (`server/gateway.ts`); the online client
(`transport/onlineClient.ts`) tracks the last seen sequence and drives
catch-up, with `SocketEventSource` (`transport/networkSink.ts`) guarding
against gapped streams (`EVENT_GAP`).

### 2.6 Snapshots — `SnapshotStore`

```ts
interface SnapshotStore {
  save(snapshot: GameSnapshot): void;
  load(gameId: string): GameSnapshot | null;
}
```

Phase 1: in-memory store, with the UI's `LocalSnapshotStore` as the
`localStorage` adapter (schema-validated, refusal on any unknown version).
**Landed (Phase 2):** SQLite (`better-sqlite3`) serves reconnection payloads —
`server/db.ts` persists a serialized snapshot with every applied command and
serves it on join, same interface.

### 2.7 Replay — the state-hash contract

Identical initial state plus identical ordered command history must produce an
identical state hash (`stateHash` over canonical JSON). Replay refolds the
**actual submission log** — rejections and idempotent duplicates included, as
they happened live. This is what makes server reconciliation, spectator
catch-up, and dispute audits possible without new engine code.

**Demonstrated:** every completed simulated game refolds its full ordered log
(probes included) from `{ seed, mode, players }` to the live final state hash
(§17.3(d)) — 6,000/6,000 identical in the committed report. **Landed
(Phase 2):** replay remains a test-and-audit tool, not a runtime dependency —
the server answers idempotent retries from the durable command ledger instead
(`server/db.ts`), and the wire conformance suite refolds the ledger to the
server's authoritative hash (`tests/server/conformance.test.ts`).

## 3. Phase 2 contracts — specified in Phase 1, implemented as Phase 2 lands

These were specified in Phase 1 so the Phase 2 design could not quietly break
them. They were **not** in the Phase 1 codebase as runtime interfaces —
deviating from the original "every interface ships as code in PR 2"
expectation — because no local behavior could exercise them meaningfully. The
status column tracks the Phase 2 implementation: sessions shipped with the
server foundation (PR 14) and reconnection catch-up with the authoritative
game service (PR 15); the deadline rows shipped with PR 16; the online client
transport with PR 17; and since PR 18 the §17.3 probe skeleton also runs
**over the wire** against the real gateway (`tests/server/conformance.test.ts`).
AI substitution and spectator projections remain specified-only.

| Contract | Phase 2 shape | Phase 1 status | Phase 2 status |
|---|---|---|---|
| Reconnection | Load snapshot, stream missed events `fromSeq` → now; gapless sequences make catch-up exact | n/a (single device); the `fromSeq` subscription already exists | **Implemented** (PR 15): token re-auth + snapshot + catch-up from the last seen sequence |
| Turn & auction deadlines | Server-enforced `DeadlinePolicy` — auto-pass on expiry, void-bid on disqualification | none in code; the UI timer is cosmetic and the engine is wall-clock-free by design | **Implemented** (PR 16): `server/game/deadlines.ts` arms per-mode windows and submits ordinary, ledgered `server-auto-…` commands through the per-game queue (`tests/server/deadlines.test.ts`); the engine stays wall-clock-free — no `Date.now()` entered the reducer |
| Async-bid void-and-reopen | A high bidder who becomes ineligible (timeout) is voided; the auction continues without them; with no bids remaining it closes unsold | impossible in Phase 1 (no payment can occur while an auction is open, so a winning bid is always payable) | **Implemented** (PR 16): the additive `VOID_BID` command (bank-acted) + `AUCTION_BID_VOIDED` event void a timed-out high bid — bidding restarts at the opening minimum, and with no eligible bidders left the sale closes unsold via the existing end path (`tests/game/void-bid.test.ts`) |
| AI substitution | `AutoPlayerStrategy` fills disconnected seats | interface stub not implemented (documented, spec §10) | Not yet — specified-only |
| Spectator projections | `projectPublicState(state, viewerId)` redacts server secrets and private info | identity in hot-seat (all state is on one trusted device) | Not yet — specified-only (player-facing redaction ships first) |

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

Every item is pinned by a test — one per item, over the wire where the
guarantee is a server guarantee (`tests/server/contract-checklist.test.ts`,
§5.1–§5.8).

## 6. Evidence

The four demonstrated guarantees (§2.2–§2.5 above) are re-proven on every CI
run by the 20-seed-per-cell simulation smoke, and in full by the committed
6,000-game report — see `docs/ECONOMY.md`
("Multiplayer-contract demonstration") and `docs/TESTING.md` ("The
multiplayer-contract demonstration"), which reference the same evidence
rather than restating it. Since PR 18 they are re-proven **over the wire** on
every CI run: a complete game driven through real sockets with probes
(a)–(d) interleaved, plus the concurrency, reconnect, and
restart-durability suites (`tests/server/`).
