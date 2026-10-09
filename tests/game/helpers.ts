/** Shared contract-test helpers: a fixed player set and command factories. */
import { createGame } from '../../src/lib/game/engine/reducer';
import type { AnyGameEvent } from '../../src/lib/game/events';
import type { GameState, PlayerId } from '../../src/lib/game/types';
import type { GameCommand, CommandType } from '../../src/lib/game/commands';

export const SEED = 0x5eed1234;

export const PLAYER_IDS: readonly PlayerId[] = ['alice', 'bob', 'carol'];

export const GAME_ID = 'game-contract';

export interface CreatedGame {
  readonly state: GameState;
  /** The creation ledger: GAME_CREATED stamped at sequence 1. */
  readonly events: readonly AnyGameEvent[];
}

export function makeGame(): CreatedGame {
  const result = createGame({ gameId: GAME_ID, seed: SEED, playerIds: PLAYER_IDS });
  if (!result.ok) throw result.error;
  return { state: result.state, events: result.events };
}

let nextCommandId = 0;

/** Fresh unique commandId on every call. */
export function commandId(): string {
  nextCommandId += 1;
  return `cmd-${String(nextCommandId).padStart(8, '0')}`;
}

export function makeCommand(type: CommandType, overrides: Partial<GameCommand> = {}): GameCommand {
  const command = {
    commandId: commandId(),
    gameId: GAME_ID,
    actorId: PLAYER_IDS[0],
    expectedVersion: 0,
    type,
    payload: {},
  } as GameCommand;
  return { ...command, ...overrides };
}

export function assertUnreachable(value: never): never {
  throw new Error(`unreachable: ${String(value)}`);
}
