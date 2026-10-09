/** Envelope contract tests: command shape validation (spec §2.1 step 1). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCommand, makeGame, commandId, GAME_ID, PLAYER_IDS } from './helpers';
import { applyCommand } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { RuleError } from '../../src/lib/game/engine/errors';
import type { GameCommand } from '../../src/lib/game/commands';

function submit(command: GameCommand): ReturnType<typeof applyCommand> {
  const { state } = makeGame();
  return applyCommand(state, command, rngForState(state.rngState));
}

test('shape: non-object commands are rejected', () => {
  for (const bad of [null, undefined, 42, 'ROLL', [], true]) {
    const result = submit(bad as unknown as GameCommand);
    assert.equal(result.ok, false, `expected rejection of ${String(bad)}`);
    if (result.ok === false) {
      assert.ok(result.error instanceof RuleError);
      assert.equal(result.error.code, 'INVALID_SHAPE');
    }
  }
});

test('shape: missing envelope fields are rejected', () => {
  const base = makeCommand('START_GAME');
  for (const field of ['commandId', 'gameId', 'actorId', 'type', 'payload'] as const) {
    const broken = { ...base } as Record<string, unknown>;
    delete broken[field];
    const result = submit(broken as unknown as GameCommand);
    assert.equal(result.ok, false, `expected rejection when ${field} is missing`);
    if (result.ok === false) {
      assert.equal(result.error.code, 'INVALID_SHAPE');
      assert.equal((result.error.details as { field?: string }).field, field);
    }
  }
});

test('shape: unknown command type is rejected', () => {
  const result = submit({ ...makeCommand('START_GAME'), type: 'TELEPORT' } as unknown as GameCommand);
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, 'INVALID_SHAPE');
    assert.equal((result.error.details as { type?: string }).type, 'TELEPORT');
  }
});

test('shape: blank commandId is rejected', () => {
  const result = submit(makeCommand('START_GAME', { commandId: '   ' }));
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, 'INVALID_SHAPE');
    assert.equal((result.error.details as { field?: string }).field, 'commandId');
  }
});

test('shape: negative expectedVersion is rejected', () => {
  const result = submit(makeCommand('START_GAME', { expectedVersion: -1 }));
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.error.code, 'INVALID_SHAPE');
});

test('shape: payload field-type mismatches are rejected per command', () => {
  // START_GAME payload accepts only 'initialBalance' | 'startingCash'.
  const wrongKey = submit(makeCommand('START_GAME', { payload: { nope: true } as never }));
  assert.equal(wrongKey.ok, false);
  if (wrongKey.ok === false) assert.equal(wrongKey.error.code, 'INVALID_SHAPE');
  const wrongValue = submit(makeCommand('START_GAME', { payload: { initialBalance: 'all-cash-now' } as never }));
  assert.equal(wrongValue.ok, false);
  if (wrongValue.ok === false) assert.equal(wrongValue.error.code, 'INVALID_SHAPE');
  // ROLL payload accepts only 'normal' | 'hold'.
  const badRoll = submit(makeCommand('ROLL', { payload: { reason: 'bored' } as never }));
  assert.equal(badRoll.ok, false);
  if (badRoll.ok === false) assert.equal(badRoll.error.code, 'INVALID_SHAPE');
});

test('shape: valid envelope passes shape and reaches later pipeline steps', () => {
  // Valid shape but stale version — proves shape is not the rejecting step.
  const result = submit(makeCommand('START_GAME', { expectedVersion: 99 }));
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.error.code, 'VERSION_CONFLICT');
});

test('shape: existence — a stranger cannot act in the game', () => {
  const result = submit(makeCommand('START_GAME', { actorId: 'mallory' }));
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, 'UNKNOWN_PLAYER');
    assert.deepEqual((result.error.details as { actorId?: string }).actorId, 'mallory');
  }
});

test('shape: commands for a different gameId are rejected', () => {
  const result = submit(makeCommand('START_GAME', { gameId: 'someone-elses-game' }));
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.error.code, 'UNKNOWN_GAME');
});

test('shape: blank gameId in envelope is rejected', () => {
  const result = submit(makeCommand('START_GAME', { gameId: '' }));
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.error.code, 'INVALID_SHAPE');
});

test('shape: every player of a valid lobby passes existence checks', () => {
  for (const actorId of PLAYER_IDS) {
    const { state } = makeGame();
    const result = applyCommand(state, makeCommand('SAVE_SNAPSHOT', { actorId, commandId: commandId(), expectedVersion: state.version }), rngForState(state.rngState));
    assert.equal(result.ok, true, `expected ${actorId} to pass existence`);
  }
});

test('shape: command factory helper sanity', () => {
  // commandId() always yields fresh ids — the idempotency tests rely on it.
  assert.notEqual(commandId(), commandId());
  assert.match(makeCommand('START_GAME').commandId, /^cmd-\d{8}$/);
  assert.equal(makeCommand('START_GAME').gameId, GAME_ID);
});
