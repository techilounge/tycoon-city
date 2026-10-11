/**
 * Redaction pins (spec criterion 11): the §4 public/private boundary — the
 * seed and RNG word together predict every future draw, and `eventDeck` is
 * the shuffled order itself. Three layers:
 *
 *   1. type-level pin — `ClientGameState` is exactly GameState minus the
 *      private keys, and GameState stays assignable to it (one UI projection
 *      set renders both hot-seat and online state);
 *   2. runtime projection scan — canonical JSON of `projectClientState` over
 *      real mid-game states never contains a private key, and neither do
 *      event payloads (the seed must not ride the event log either);
 *   3. the wire-level scan of every broadcast `game:state`/`game:event`
 *      payload lives in integration.test.ts — this file pins the boundary
 *      itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GameCommand } from '../../src/lib/game/commands';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { canonicalJson } from '../../src/lib/game/engine/replay';
import { rngForState } from '../../src/lib/game/rng';
import type { GameState } from '../../src/lib/game/types';
import { PRIVATE_STATE_KEYS, projectClientState } from '../../server/game/redact';
// The detector the wire-level scan runs over live broadcasts (integration.test.ts).
import { hasKeyDeep as wireScanHasKeyDeep } from './helpers';

// ---------------------------------------------------------------------------
// 1. Type-level pin — compile-time, mirrored at runtime below.
// ---------------------------------------------------------------------------

/** Asserts a type is exactly `true`. */
type AssertTrue<T extends true> = T;

/** No private key survives in the client projection. */
type ClientProjection = ReturnType<typeof projectClientState>;
type PrivateKeysAbsent = AssertTrue<
  'seed' extends keyof ClientProjection
    ? false
    : 'rngState' extends keyof ClientProjection
      ? false
      : 'eventDeck' extends keyof ClientProjection
        ? false
        : true
>;

/** GameState remains structurally assignable to the client projection (spec: one UI projection set). */
type GameStateFitsClientState = AssertTrue<GameState extends ClientProjection ? true : false>;

// The pins fail compilation (and the runtime mirrors below fail the test) if
// the private keys leak into the client projection or drift out of the Omit.
const privateKeysAbsent: PrivateKeysAbsent = true;
const gameStateFitsClientState: GameStateFitsClientState = true;

describe('redaction — the §4 boundary (criterion 11)', () => {
  it('pins the private keys at the type level', () => {
    assert.equal(privateKeysAbsent, true);
    assert.equal(gameStateFitsClientState, true);
    // The pin and the projection must agree on WHICH keys are private.
    assert.deepEqual([...PRIVATE_STATE_KEYS].sort(), ['eventDeck', 'rngState', 'seed']);
  });

  it('omits every private key from the canonical JSON of redacted states (fresh + mid-game)', () => {
    const created = createGame({ gameId: 'g-redact', seed: 0x5eed1234, playerIds: ['p1', 'p2', 'p3'], mode: 'CLASSIC' });
    assert.ok(created.ok);
    const states: GameState[] = [created.state];

    // Walk a few real commands so the scan covers mid-game shapes (dice meta,
    // ownership changes) — not just the pristine LOBBY state.
    let state = created.state;
    const started = applyCommand(state, makeCommand(state, 'START_GAME', 'ui-start'), rngForState(state.rngState));
    assert.ok(started.ok);
    state = started.state;
    states.push(state);
    const rolled = applyCommand(state, makeCommand(state, 'ROLL', 'ui-roll'), rngForState(state.rngState));
    assert.ok(rolled.ok);
    states.push(rolled.state);

    for (const full of states) {
      const redacted = projectClientState(full);
      const parsed: unknown = JSON.parse(canonicalJson(redacted));
      for (const key of PRIVATE_STATE_KEYS) {
        assert.equal(hasKeyDeep(parsed, key), false, `private key "${key}" leaked into a redacted state`);
      }
      // The raw full state, by contrast, HAS them (the scan is not vacuous).
      assert.equal(PRIVATE_STATE_KEYS.every((key) => hasKeyDeep(full, key)), true);
    }
  });

  it('keeps private keys out of event payloads (the boundary is at state, events stay public)', () => {
    const created = createGame({ gameId: 'g-redact-ev', seed: 0x5eed1234, playerIds: ['p1', 'p2'], mode: 'BLITZ' });
    assert.ok(created.ok);
    const started = applyCommand(created.state, makeCommand(created.state, 'START_GAME', 'ui-start'), rngForState(created.state.rngState));
    assert.ok(started.ok);
    const rolled = applyCommand(
      started.state,
      makeCommand(started.state, 'ROLL', 'ui-roll'),
      rngForState(started.state.rngState),
    );
    assert.ok(rolled.ok);
    for (const event of [...created.events, ...started.events, ...rolled.events]) {
      const parsed: unknown = JSON.parse(canonicalJson(event));
      for (const key of PRIVATE_STATE_KEYS) {
        assert.equal(hasKeyDeep(parsed, key), false, `private key "${key}" leaked into event ${event.type}`);
      }
    }
  });

  it('rejects an injected private payload — a leak cannot pass the scan silently (guard non-vacuity)', () => {
    // A buggy projection or a compromised server could emit a plausible
    // client state with private state planted at depth. The SAME detector
    // the wire-level broadcast scan runs must fire on it — this test is the
    // proof that the guard fails loudly instead of passing vacuously.
    const forged = {
      gameId: 'g-inject',
      version: 7,
      phase: 'PLAYING',
      players: [
        { id: 'p1', cash: 100, rngState: '0x9e3779b9' },
        { id: 'p2', cash: 200 },
      ],
      nested: { deep: { history: [{ eventDeck: ['card-a', 'card-b'] }] } },
      seed: 0x5eed1234,
    };
    const parsed: unknown = JSON.parse(canonicalJson(forged));
    for (const key of PRIVATE_STATE_KEYS) {
      assert.equal(wireScanHasKeyDeep(parsed, key), true, `the scan FAILED to detect an injected "${key}" — the guard is vacuous`);
    }
  });
});

// ---------------------------------------------------------------------------
// Local helpers.
// ---------------------------------------------------------------------------

let commandSeq = 0;
function makeCommand(state: GameState, type: GameCommand['type'], commandId: string): GameCommand {
  return {
    commandId: `${commandId}-${++commandSeq}`,
    gameId: state.gameId,
    actorId: state.activePlayerId ?? state.players[0].id,
    expectedVersion: state.version,
    type,
    payload: {},
  } as GameCommand;
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}
