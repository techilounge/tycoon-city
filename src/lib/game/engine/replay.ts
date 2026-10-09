/**
 * Replay and state hashing (spec §3).
 *
 * Replay refolds an ordered command log through the same applyCommand live
 * play uses — never a reinterpretation. The contract: identical initial state
 * plus identical ordered history must produce an identical state hash.
 * Duplicates and rejections fold to no-ops exactly as they did live, because
 * replay replays the command log, not a curated success list.
 */
import type { GameCommand } from '../commands';
import type { AnyGameEvent } from '../events';
import { rngForState } from '../rng';
import type { GameState, PlayerId } from '../types';
import { applyCommand, createGame } from './reducer';
import type { RuleError } from './errors';

export interface RejectionRecord {
  readonly index: number;
  readonly error: RuleError;
}

export interface ReplayOutcome {
  readonly state: GameState;
  readonly events: readonly AnyGameEvent[];
  /** Commands that applied; idempotent duplicates and rejections do not count. */
  readonly appliedCount: number;
  readonly rejected: readonly RejectionRecord[];
}

/**
 * Fold an ordered command log over an existing state (typically a loaded
 * snapshot's state). Deterministic by construction: the RNG for each command
 * is derived from the state's own persisted word.
 */
export function replayCommands(initial: GameState, commands: readonly GameCommand[]): ReplayOutcome {
  let state = initial;
  const events: AnyGameEvent[] = [];
  const rejected: RejectionRecord[] = [];
  let appliedCount = 0;
  commands.forEach((command, index) => {
    const result = applyCommand(state, command, rngForState(state.rngState));
    if (result.ok) {
      state = result.state;
      events.push(...result.events);
      if (result.applied) appliedCount += 1;
    } else {
      rejected.push({ index, error: result.error });
    }
  });
  return { state, events, appliedCount, rejected };
}

export interface ReplayFromSeedInput {
  readonly gameId: string;
  readonly seed: number;
  readonly playerIds: readonly PlayerId[];
  readonly commands: readonly GameCommand[];
}

/**
 * Replay a whole game from { seed, commands }. Throws the RuleError from
 * createGame when the inputs cannot form a game — a caller bug, since the
 * commands were composed against a game that cannot exist.
 */
export function replayFromSeed(input: ReplayFromSeedInput): ReplayOutcome {
  const created = createGame({ gameId: input.gameId, seed: input.seed, playerIds: input.playerIds });
  if (!created.ok) throw created.error;
  return replayCommands(created.state, input.commands);
}

/**
 * Canonical JSON: object keys sorted recursively, so identical data always
 * serializes identically. The engine never produces NaN or Infinity; a
 * non-finite number here is a bug and throws.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

function fnv1a(input: string, basis: number): number {
  let hash = basis | 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 64-bit change-detector hash: two FNV-1a passes with different bases over
 * the canonical JSON. Deterministic and dependency-free by design — this is
 * a replay-equality fingerprint, NOT a security primitive.
 */
export function stateHash(state: GameState): string {
  const json = canonicalJson(state);
  return `${fnv1a(json, 0x811c9dc5).toString(16).padStart(8, '0')}${fnv1a(json, 0x01000193).toString(16).padStart(8, '0')}`;
}
