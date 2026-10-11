# Testing Guide

How this repository is tested. The test runner is Node's built-in runner
(`node:test`) executed through `tsx`; everything is typechecked by
`tsc --noEmit`, and CI gates every PR with two jobs: `verify` (typecheck +
tests + build, plus the simulation smoke below) and `server` (the server
conformance suite, `tests/server/*.test.ts`). At the Phase 2 docs wrap-up the
suite is 42 files / 530 tests.

## Running the tests

```bash
npm test                      # the full suite (engine + harness)
npx tsc --noEmit              # typecheck (CI-enforced)
npm run build                 # production build (CI-enforced)
npm run sim -- --seeds=20     # simulation smoke matrix (CI-enforced)
```

## Layout

| Path | Covers |
|---|---|
| `tests/starter.test.ts` | The migrated starter test (Phase 0 baseline, kept as a CI canary) |
| `tests/game/*.test.ts` | Engine contracts: envelopes, idempotency, version conflicts, replay-hash equality, movement, economy, auctions, trades, development, bankruptcy, victory |
| `tests/game/ui-*.test.ts` | UI-adjacent pure logic: legal-command derivation (action dock), board layout, modal priority, save/resume persistence, presentation rules, trade composition |
| `tests/sim/harness.test.ts` | Balance-simulation harness: strategy profile contracts, seed derivation, a full micro-matrix with all §17.3 demonstration assertions, rerun determinism |
| `tests/server/*.test.ts` | The networked server (PRs 14–18): SQLite persistence, the wire gateway, authoritative rooms, redaction, rate limits, the §5 contract checklist (one test per item, `contract-checklist.test.ts`), durability across restarts, the deadline matrix (`deadlines.test.ts` — expiry paths, queue races, resume, broadcast), and the PR 18 wire suites: conformance probes, concurrency races, reconnect catch-up |
| `tests/transport/*.test.ts` | The client transport against the real gateway (no mocks): `networkSink.test.ts` — idempotent retries, version conflicts, forged identity claims, redaction-free acks, plus client-side ack-timeout and gapped-stream paths; `onlineClient.test.ts` — first-join session mint, token re-auth, catch-up, and room-refusal fault codes |
| `tests/ui/*.test.ts` | Presentation-only component logic: the `DeadlineBar` share math as a pure function of the broadcast |
| `tools/sim/**` | The harness itself (`npm run sim`) — not imported by the app |

## The multiplayer-contract demonstration (spec §17.3)

The engine's multiplayer contracts are **demonstrated, not just
unit-tested**. Phase 1 proved them in-process; since PR 18 the same probe
skeleton also runs over the wire (see "Probes over the wire" below). In the
in-process form, every game the balance simulation runs is a headless
multiplayer-contract demonstration. Simulated actors
(the strategy profiles in `tools/sim/profiles.ts`) drive the **production**
`LocalCommandSink` — the exact command path the hot-seat UI uses — and the
driver (`tools/sim/driver.ts`) interleaves three probes at every roll
decision point plus a full-game replay check:

1. **Actor authorization** — a non-active live player's `ROLL` is rejected
   (`NOT_AUTHORIZED`) and the state hash is unchanged. This is the
   `canAct(state, command)` pure function a Phase 2 server reuses.
2. **Optimistic concurrency** — a command composed against
   `expectedVersion = state.version − 1` is rejected (`VERSION_CONFLICT`),
   state unchanged.
3. **Idempotency** — resubmitting a processed `commandId` verbatim returns
   ok with `applied: false` and the stored events; state hash unchanged.
   A duplicate delivery applies exactly once.
4. **Replay** — after every completed game, the entire ordered submission
   log is refolded from the initial state; the refolded state hash must
   equal the live final hash and the applied-command count must match.

A failing assertion throws immediately — a red probe cannot be hidden in
an aggregate count. The counts per cell are reported in
[the economy report](ECONOMY.md#multiplayer-contract-demonstration-spec-173)
(`(a)–(d)` columns); all four assertions were green for every simulated
game in the committed report.

## Probes over the wire (PR 18)

The §17.3 probe skeleton also runs against the **network transport**: a
complete game driven through real sockets against the real gateway, probes
interleaved live (`tests/server/conformance.test.ts`):

1. **Actor authorization** — a forged actor is re-stamped from the session and
   rejected (`NOT_AUTHORIZED`); the state hash is unchanged.
2. **Optimistic concurrency** — a stale `expectedVersion` rejects
   (`VERSION_CONFLICT`), state unchanged.
3. **Idempotency** — a duplicate `commandId` returns ok with `applied: false`
   and **the stored events of the original application** from the durable
   ledger — including across a server restart (the restart leg lives in
   `tests/server/durability.test.ts`).
4. **Replay** — the ledger refolds from `{ seed, ordered commands }` to the
   server's authoritative state hash at the end of the game.

Two companion suites cover the wiring around the probes:

- **Concurrency** (`tests/server/concurrency.test.ts`) — N clients race
  submissions on one room: exactly one application per version bump, racing
  duplicates apply once with the same stored events on every racing ack, and
  every seat observes the identical, gapless event stream.
- **Reconnect** (`tests/server/reconnect.test.ts`) — a client killed mid-turn
  and an eligible bidder killed mid-auction rejoin with their token, receive
  the snapshot plus the missed events from `fromSeq`, and end up hash-equal
  to the server with no duplicated and no missing events — verified against
  an always-on witness client's reference stream.

## The simulation smoke in CI

CI runs `npm run sim -- --seeds=20 --no-json`: the {Classic, Quick,
Blitz} × {2, 3, 4, 6} matrix at 20 seeds per cell (240 complete games,
roughly 30 s), each game ending with a replay-hash check. This keeps the
demonstration and the engine's determinism under continuous regression
pressure without the cost of the full 500-seed matrix.

## Deadline enforcement (PR 16)

Deadlines are server timers that act like players: on expiry the host
submits an **ordinary command** through the same per-game queue as player
commands (`server/game/deadlines.ts`), so every deadline action crosses the
identical 8-step pipeline, lands in the durable ledger, and replays. The
matrix in `tests/server/deadlines.test.ts` covers four layers:

1. **Pure composition** — each decision phase maps to its timeout command
   with the expired player (or the bank, for `VOID_BID`) stamped as the
   actor; quiet states compose nothing.
2. **The scheduler under fake timers** — fires at the window boundary,
   one-shot only, and re-arms a full fresh window after every applied
   command and on resume.
3. **GameHost integration through SQLite** — all three expiry paths apply
   and ledger as `server-auto-…` commands; a bidless-auction expiry passes
   bindingly until the sale closes unsold; a resumed host re-arms from the
   snapshot and acts.
4. **Queue races** — an expiry queued first applies (a later player command
   gets `VERSION_CONFLICT`); a player command queued first refreshes its
   window and the stale expiry is dropped. The engine itself is never
   touched by the clock: `tests/game/void-bid.test.ts` pins the additive
   `VOID_BID` behavior (void → auction continues; no eligible bidders →
   unsold close; replay covers deadline commands) with fake timers only.

### Dev servers do not hot-reload server logic

`npm run dev` runs the custom server (`server.ts`) through tsx, and **Next
dev hot-reload covers pages and components only** — a change under `server/`
(gateway, deadlines, GameHost) is picked up only by a full restart of
`npm run dev`; a long-lived dev server silently runs stale server logic. This
is a testing-ops note, not an engine property: deadline enforcement itself is
verified working on a fresh server (a 2-player CLASSIC probe at `3e31525`
recorded the server-auto `ROLL` firing at the 90 s turn window with the
`game:deadline` broadcast re-arming).

## Determinism and reproducibility

- The engine is deterministic end to end (seeded Mulberry32, gapless event
  log, no wall clock in the reducer). Replaying a game's command log
  reproduces the identical state hash — asserted per game by the harness
  and by the engine contract tests.
- Simulation seeds are pure functions of `(mode, playerCount, gameIndex)`
  (`seedForGame` in `tools/sim/matrix.ts`), so the report in `docs/ECONOMY.md`
  regenerates byte-for-byte from a seed count alone:

  ```bash
  npm run sim -- --seeds=500 --md=docs/ECONOMY.md
  ```

- `tests/sim/harness.test.ts` asserts rerun determinism directly: the same
  cell run twice must produce byte-identical summaries.
- Snapshot compatibility is schema-gated (`schemaVersion`, currently **v2**).
  Loading an unknown snapshot version refuses with a typed error
  (`UNKNOWN_SCHEMA_VERSION`) rather than guessing; the persistence tests
  (`tests/game/ui-persistence.test.ts`, `tests/game/snapshot.test.ts`) pin the
  round-trip, the refusal of older **and newer** versions, and the refusal of
  malformed or tampered payloads. Schema history — v1 (engine foundation) →
  v2 (round tracking + persisted estate-sale queue) — is specified in
  [`GAME_STATE_MACHINE.md` §9](GAME_STATE_MACHINE.md#9-snapshot-schema-history).
  There is no migration from v1: unsupported saves offer a new game, never a
  silent load.
