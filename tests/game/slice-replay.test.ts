import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import { BOARD_SPACES, isPurchasable } from '../../src/lib/game/board-v1';
import { replayCommands, replayFromSeed, stateHash } from '../../src/lib/game/engine/replay';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { buildSnapshot, parseSnapshot, serializeSnapshot } from '../../src/lib/game/snapshot-schema';
import { rngForState } from '../../src/lib/game/rng';
import type { GameState } from '../../src/lib/game/types';

/**
 * Slice acceptance: determinism replay of a scripted game (spec §12 PR 4).
 * The bot plays only commands the slice implements — ROLL, BUY/PASS in
 * BUY_DECISION, END_TURN — and the script is an honest inductive playthrough:
 * every command is composed against the state the bot just produced.
 */

function nextCommand(state: GameState, seq: number): GameCommand {
  const actor = state.activePlayerId ?? state.players[0].id;
  let type: CommandType;
  let payload: Record<string, unknown> = {};
  switch (state.turnPhase) {
    case 'AWAITING_ROLL':
      type = 'ROLL';
      break;
    case 'BUY_DECISION': {
      const player = state.players.find((p) => p.id === actor);
      assert.ok(player);
      const landed = BOARD_SPACES[player.position];
      type = isPurchasable(landed) && player.cash >= landed.listPrice ? 'BUY' : 'PASS_TO_AUCTION';
      // BUY takes an optional spaceId; PASS_TO_AUCTION's schema allows no keys.
      payload = type === 'BUY' ? { spaceId: landed.id } : {};
      break;
    }
    case 'TURN_MANAGEMENT':
      type = 'END_TURN';
      break;
    default:
      throw new Error(`bot: unexpected turn phase ${String(state.turnPhase)}`);
  }
  return {
    commandId: `bot-${seq}`,
    gameId: state.gameId,
    actorId: actor,
    expectedVersion: state.version,
    type,
    payload,
  } as GameCommand;
}

/** Play until the stop predicate fires; every command must apply cleanly. */
function playScriptedGame(
  playerCount: number,
  seed: number,
  stop: (state: GameState, rolls: number) => boolean,
): { state: GameState; commands: readonly GameCommand[]; rolls: number } {
  const playerIds = ['Ada', 'Grace', 'Lin', 'Hedy', 'Alan', 'Mary'].slice(0, playerCount);
  const gameId = 'g-scripted';
  const created = createGame({ gameId, seed, playerIds });
  assert.ok(created.ok);
  if (!created.ok) throw new Error('unreachable');

  const startCommand = {
    commandId: 'bot-start',
    gameId,
    actorId: playerIds[0],
    expectedVersion: created.state.version,
    type: 'START_GAME',
    payload: {},
  } as GameCommand;
  const startResult = applyCommand(created.state, startCommand, rngForState(created.state.rngState));
  assert.ok(startResult.ok);
  if (!startResult.ok) throw new Error('unreachable');

  const commands: GameCommand[] = [startCommand];
  let state = startResult.state;
  let rolls = 0;
  while (!stop(state, rolls) && commands.length < 5000) {
    const command = nextCommand(state, commands.length);
    const result = applyCommand(state, command, rngForState(state.rngState));
    assert.ok(result.ok, `${command.type} must apply at version ${state.version}: ${result.ok ? '' : result.error.message}`);
    commands.push(command);
    state = result.state;
    if (command.type === 'ROLL') rolls++;
  }
  assert.ok(commands.length < 5000, 'the script must terminate before the command cap');
  return { state, commands, rolls };
}

describe('slice replay — determinism (spec §12 PR 4)', () => {
  it('a scripted 100-roll game replays to an identical state hash', () => {
    const seed = 2026;
    const { state: live, commands } = playScriptedGame(3, seed, (_s, rolls) => rolls >= 100);
    assert.ok(live.version > 100, 'the script must have applied well over 100 commands');

    const replayed = replayFromSeed({ gameId: 'g-scripted', seed, playerIds: live.players.map((p) => p.id), commands });
    assert.deepEqual(replayed.rejected, [], 'replay must re-apply every scripted command without rejection');
    assert.equal(replayed.appliedCount, commands.length);
    assert.equal(stateHash(replayed.state), stateHash(live));
    assert.deepEqual(replayed.state, live, 'the replayed state must be identical, not merely hash-equal');
  });

  it('two live runs of the same script produce identical states (no ambient randomness)', () => {
    const first = playScriptedGame(3, 4242, (_s, rolls) => rolls >= 60);
    const second = playScriptedGame(3, 4242, (_s, rolls) => rolls >= 60);
    assert.equal(stateHash(second.state), stateHash(first.state));
    assert.deepEqual(second.commands, first.commands);
  });

  it('replay event sequences stay gapless across the whole scripted game', () => {
    const { state: live, commands } = playScriptedGame(3, 7, (_s, rolls) => rolls >= 40);
    const replayed = replayCommands(
      (() => {
        const created = createGame({ gameId: 'g-scripted', seed: 7, playerIds: live.players.map((p) => p.id) });
        assert.ok(created.ok);
        if (!created.ok) throw new Error('unreachable');
        return created.state;
      })(),
      commands,
    );
    replayed.events.forEach((event, index) => {
      // Gapless from wherever the log begins — createGame's GAME_CREATED is
      // sequence 1, so command events here start at 2. No holes allowed.
      const firstSequence = replayed.events[0]?.sequence ?? 1;
      assert.equal(event.sequence, firstSequence + index, `sequence must be gapless at ${index}`);
    });
  });

  it('the scripted mid-game state survives a snapshot round-trip', () => {
    const { state: live } = playScriptedGame(3, 33, (_s, rolls) => rolls >= 30);
    const raw = serializeSnapshot(buildSnapshot(live));
    const parsed = parseSnapshot(raw);
    assert.ok(parsed.ok, 'the mid-game snapshot must parse');
    if (!parsed.ok) throw new Error('unreachable');
    assert.equal(stateHash(parsed.snapshot.state), stateHash(live));
  });

  it('a 2-player scripted game reaches the start of round 11 (10 rounds completed)', () => {
    // Ten rounds = 20 turn ordinals in a 2-player game; the next TURN_STARTED
    // (turn 21) marks 10 completed rounds (spec §4 turn semantics).
    const { state, rolls } = playScriptedGame(2, 99, (s) => s.turn > 20);
    assert.ok(state.turn >= 21, `round 10 must complete (turn ${state.turn} after ${rolls} rolls)`);
    assert.equal(state.phase, 'PLAYING', 'the slice has no end conditions — the game continues');
  });
});
