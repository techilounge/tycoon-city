# Testing Guide (Phase 1)

How this repository is tested. The test runner is Node's built-in runner
(`node:test`) executed through `tsx`; everything is typechecked by
`tsc --noEmit` and CI gates every PR on typecheck + tests + build
(+ the simulation smoke, below).

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
| `tools/sim/**` | The harness itself (`npm run sim`) — not imported by the app |

## The multiplayer-contract demonstration (spec §17.3)

Phase 1 ships no networking, but the engine's multiplayer contracts are
**demonstrated, not just unit-tested**: every game the balance simulation
runs is a headless multiplayer-contract demonstration. Simulated actors
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

## The simulation smoke in CI

CI runs `npm run sim -- --seeds=20 --no-json`: the {Classic, Quick,
Blitz} × {2, 3, 4, 6} matrix at 20 seeds per cell (240 complete games,
roughly 30 s), each game ending with a replay-hash check. This keeps the
demonstration and the engine's determinism under continuous regression
pressure without the cost of the full 500-seed matrix.

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
