/**
 * The reducer: createGame and applyCommand — the engine's only entry points
 * (spec §2.1, §2.3).
 *
 * PR 2 is the foundation skeleton: the full 8-step validation pipeline,
 * idempotency, optimistic-concurrency versioning, authorization, purity, and
 * event stamping. Game-rule handlers arrive with PRs 4–8 and plug into the
 * HANDLERS registry; until then every game command rejects with
 * COMMAND_NOT_IMPLEMENTED so no half-built rule can run.
 *
 * Purity is structural: applyCommand clones the state before any handler
 * runs, so the input state is never mutated — rejections and successes alike
 * leave it deep-equal untouched. There is no wall-clock and no ambient
 * randomness here; the only randomness is the injected RandomSource whose
 * state word is persisted back into GameState.
 */
import { validateCommandShape, type CommandType, type GameCommand } from '../commands';
import { stampEvents, type AnyEventInput, type AnyGameEvent } from '../events';
import { rngForState, type RandomSource } from '../rng';
import { MAX_PLAYERS, MIN_PLAYERS, RULES_VERSION, type GameState, type PlayerId } from '../types';
import { RuleError } from './errors';

/** Success carries the new state, the stamped events, and whether the command
 *  applied (false for idempotent duplicates, which apply nothing). Failure
 *  carries the typed RuleError; the previous state is never mutated. */
export type CommandResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly AnyGameEvent[]; readonly applied: boolean }
  | { readonly ok: false; readonly error: RuleError };

export type CreateGameResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly AnyGameEvent[] }
  | { readonly ok: false; readonly error: RuleError };

export interface CreateGameInput {
  readonly gameId: string;
  readonly seed: number;
  readonly playerIds: readonly PlayerId[];
}

/**
 * The engine's randomness contract: the caller supplies the source; the
 * reducer draws from it during the command and persists its resulting word
 * into state.rngState. Canonical wiring is rngForState(state.rngState), so
 * live play, replay, and post-snapshot continuation draw identically (spec §3).
 */
export function applyCommand(state: GameState, command: GameCommand, rng: RandomSource): CommandResult {
  // (1) shape — full schema check of the raw envelope and payload.
  const shapeError = validateCommandShape(command);
  if (shapeError) return err(shapeError);

  // (2) existence — the game, and the actor as a player in it.
  if (command.gameId !== state.gameId) {
    return err(new RuleError('UNKNOWN_GAME', `command targets game ${command.gameId}, but this game is ${state.gameId}`, {
      expected: state.gameId,
      received: command.gameId,
    }));
  }
  if (!state.players.some((player) => player.id === command.actorId)) {
    return err(new RuleError('UNKNOWN_PLAYER', `actor ${command.actorId} is not a player in this game`, { actorId: command.actorId }));
  }

  // (4, pre-read) idempotency ledger membership. Computed here so the version
  // check below can be idempotency-aware.
  const alreadyProcessed = state.processedCommandIds.includes(command.commandId);

  // (3) version — optimistic concurrency. A retry of an already-processed
  // command carries its ORIGINAL expectedVersion, so the check must exempt
  // processed ids; otherwise every legitimate retry would fail with
  // VERSION_CONFLICT before step 4 could return the idempotent result.
  if (!alreadyProcessed && command.expectedVersion !== state.version) {
    return err(new RuleError('VERSION_CONFLICT', `command was composed against version ${command.expectedVersion}, but the game is at version ${state.version}`, {
      expectedVersion: command.expectedVersion,
      currentVersion: state.version,
    }));
  }

  // (4) idempotency — a processed commandId is a successful retry: return the
  // current state, apply nothing. (The transport layer owns the original
  // events and returns them to the caller; see LocalCommandSink.)
  if (alreadyProcessed) {
    return { ok: true, state, events: [], applied: false };
  }

  // (6a) game over — row 17 of the phase table: every command is rejected.
  // Checked before authorization because a finished game admits no actor.
  if (state.phase === 'GAME_OVER') {
    return err(new RuleError('GAME_IS_OVER', 'the game is over; no commands are accepted'));
  }

  // (5) authorization — pure predicate reused verbatim by the Phase 2 server.
  if (!canAct(state, command)) {
    return err(new RuleError('NOT_AUTHORIZED', `player ${command.actorId} may not issue ${command.type} now`, {
      actorId: command.actorId,
      type: command.type,
      activePlayerId: state.activePlayerId,
    }));
  }

  const handler = HANDLERS[command.type];
  if (!handler) {
    return err(new RuleError('COMMAND_NOT_IMPLEMENTED', `command ${command.type} is not implemented by this rules build; its PR has not landed`, {
      type: command.type,
    }));
  }

  // (6b/7/8) phase, resources, and rule constraints live inside the handler.
  // Handlers may throw RuleError for rule outcomes; the throw aborts before
  // the draft below is committed, so purity holds. Any other error is a bug
  // and is rethrown — never swallowed.
  const draft = structuredClone(state) as GameStateDraft;
  let eventDrafts: readonly AnyEventInput[];
  try {
    eventDrafts = handler(draft, command, rng);
  } catch (caught) {
    if (caught instanceof RuleError) return err(caught);
    throw caught;
  }

  const events = stampEvents(state.gameId, state.lastEventSequence + 1, eventDrafts, state.rulesVersion, command.commandId);

  // Commit — bookkeeping on the private draft only.
  draft.version = state.version + 1;
  draft.processedCommandIds = [...state.processedCommandIds, command.commandId];
  draft.lastEventSequence = state.lastEventSequence + events.length;
  draft.rngState = rng.getState() >>> 0;

  return { ok: true, state: draft, events, applied: true };
}

/**
 * Pure authorization predicate (spec §10) — shipped now and reused verbatim
 * by the Phase 2 server. PR 2 covers the machinery commands; the remaining
 * actor classes join as their rules land: eligible auction bidders (PR 6),
 * designated trade recipients (PR 7), and the debtor in SETTLING_DEBT (PR 5).
 */
export function canAct(state: GameState, command: GameCommand): boolean {
  const actor = state.players.find((player) => player.id === command.actorId);
  if (!actor || actor.eliminated) return false;
  switch (command.type) {
    case 'START_GAME':
    case 'SAVE_SNAPSHOT':
      // Hot-seat device actions: any live player at the controls.
      return true;
    default:
      // Turn-scoped commands default to the active player (spec §10).
      return state.activePlayerId === command.actorId;
  }
}

/** Mutable view of GameState inside a command application; the reducer clones
 *  before any handler runs, so mutation here never escapes uncommitted. */
export type GameStateDraft = { -readonly [K in keyof GameState]: GameState[K] };

type CommandHandler = (draft: GameStateDraft, command: GameCommand, rng: RandomSource) => readonly AnyEventInput[];

function startGameHandler(draft: GameStateDraft): readonly AnyEventInput[] {
  if (draft.phase !== 'LOBBY') {
    throw new RuleError('INVALID_PHASE', `START_GAME is only valid in LOBBY, not ${draft.phase}`, { phase: draft.phase });
  }
  const first = draft.players[0];
  draft.phase = 'PLAYING';
  draft.turnPhase = 'AWAITING_ROLL';
  draft.turn = 1;
  draft.activePlayerId = first.id;
  return [{ type: 'TURN_STARTED', payload: { playerId: first.id, turn: 1 } }];
}

function saveSnapshotHandler(draft: GameStateDraft): readonly AnyEventInput[] {
  // stateVersion is the version this command produces (pre-increment view).
  return [{ type: 'SNAPSHOT_SAVED', payload: { stateVersion: draft.version + 1 } }];
}

/** Rules PRs (4–8) add handlers here; the pipeline itself is closed. */
const HANDLERS: { [T in CommandType]?: CommandHandler } = {
  START_GAME: startGameHandler,
  SAVE_SNAPSHOT: saveSnapshotHandler,
};

/**
 * The initial fold entry: build a LOBBY state from a lobby-generated seed and
 * a fixed player order, emitting GAME_CREATED as sequence 1. The seed is the
 * initial RNG word (spec §3). Not a command — the Phase 2 server calls this
 * exactly like the local lobby does.
 */
export function createGame(input: CreateGameInput): CreateGameResult {
  const { gameId, seed, playerIds } = input;
  if (typeof gameId !== 'string' || gameId.length === 0) {
    return { ok: false, error: new RuleError('INVALID_SHAPE', 'gameId must be a non-empty string', { field: 'gameId' }) };
  }
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return { ok: false, error: new RuleError('INVALID_SHAPE', 'seed must be a uint32', { field: 'seed' }) };
  }
  if (
    !Array.isArray(playerIds) ||
    playerIds.length < MIN_PLAYERS ||
    playerIds.length > MAX_PLAYERS ||
    new Set(playerIds).size !== playerIds.length ||
    playerIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return {
      ok: false,
      error: new RuleError('INVALID_SHAPE', `playerIds must be ${MIN_PLAYERS}–${MAX_PLAYERS} unique non-empty strings`, {
        field: 'playerIds',
        count: Array.isArray(playerIds) ? playerIds.length : 'not-an-array',
      }),
    };
  }

  const state = {
    gameId,
    version: 0,
    phase: 'LOBBY',
    turnPhase: null,
    rulesVersion: RULES_VERSION,
    seed,
    rngState: seed >>> 0,
    players: playerIds.map((id, seat) => ({ id, seat, eliminated: false })),
    activePlayerId: null,
    turn: 0,
    lastEventSequence: 0,
    processedCommandIds: [],
  } as GameState;
  const events = stampEvents(gameId, 1, [{ type: 'GAME_CREATED', payload: { playerIds: [...playerIds] } }]);
  return { ok: true, state: { ...state, lastEventSequence: 1 }, events };
}

function err(error: RuleError): CommandResult {
  return { ok: false, error };
}
