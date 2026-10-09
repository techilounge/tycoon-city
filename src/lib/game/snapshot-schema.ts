/**
 * Versioned, schema-validated snapshots (spec §2.4).
 *
 * Save/resume (Phase 1 UI) and reconnection (Phase 2) both consume
 * GameSnapshot through parseSnapshot: an unknown schemaVersion is REFUSED
 * with a clear typed reason and an offer of a new game — never silently
 * loaded (spec §11). Rollback of any PR stays safe for saves because the
 * schemaVersion gates deserialization.
 */
import type { GameState } from './types';
import { GAME_PHASES, RULES_VERSION, SNAPSHOT_SCHEMA_VERSION, TURN_PHASES, isUint32 } from './types';
import { canonicalJson } from './engine/replay';

export interface GameSnapshot {
  /** Snapshot format version — independent of rules version. */
  readonly schemaVersion: number;
  /** RULES_VERSION the state was produced under. */
  readonly rulesVersion: number;
  readonly gameId: string;
  readonly seed: number;
  /** == count of applied commands; equals the state's own version. */
  readonly stateVersion: number;
  /** Authoritative state, including rngState and processedCommandIds. */
  readonly state: GameState;
}

export type SnapshotParseResult =
  | { readonly ok: true; readonly snapshot: GameSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'MALFORMED' | 'UNKNOWN_SCHEMA_VERSION' | 'UNSUPPORTED_RULES_VERSION' | 'INCONSISTENT';
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

/** Stamp the current state as a schema-versioned snapshot. */
export function buildSnapshot(state: GameState): GameSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    rulesVersion: state.rulesVersion,
    gameId: state.gameId,
    seed: state.seed,
    stateVersion: state.version,
    state,
  };
}

/** Canonical serialization — byte-stable for identical snapshots. */
export function serializeSnapshot(snapshot: GameSnapshot): string {
  return canonicalJson(snapshot);
}

/**
 * Deserialize and validate. Every failure is a typed refusal; no path loads
 * data this build cannot interpret exactly.
 */
export function parseSnapshot(raw: string): SnapshotParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot is not valid JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot must be a JSON object' };
  }
  const record = data as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot is missing an integer schemaVersion' };
  }
  if (schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'UNKNOWN_SCHEMA_VERSION',
      message: `snapshot schema version ${schemaVersion} is not supported by this build (expected ${SNAPSHOT_SCHEMA_VERSION}); start a new game instead of loading this save`,
      details: { found: schemaVersion, supported: SNAPSHOT_SCHEMA_VERSION },
    };
  }

  if (record.rulesVersion !== RULES_VERSION) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_RULES_VERSION',
      message: `snapshot was produced under rules version ${String(record.rulesVersion)}, which this build does not support (expected ${RULES_VERSION})`,
      details: { found: record.rulesVersion, supported: RULES_VERSION },
    };
  }

  if (typeof record.gameId !== 'string' || record.gameId.length === 0) {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot is missing a gameId' };
  }
  if (!isUint32(record.seed)) {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot is missing a uint32 seed' };
  }
  if (typeof record.stateVersion !== 'number' || !Number.isInteger(record.stateVersion) || record.stateVersion < 0) {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot is missing a non-negative integer stateVersion' };
  }
  if (typeof record.state !== 'object' || record.state === null || Array.isArray(record.state)) {
    return { ok: false, reason: 'MALFORMED', message: 'snapshot is missing a state object' };
  }
  if (!validateGameStateShape(record.state)) {
    return { ok: false, reason: 'INCONSISTENT', message: 'snapshot state failed shape validation' };
  }
  const state = record.state as GameState;
  if (record.stateVersion !== state.version) {
    return {
      ok: false,
      reason: 'INCONSISTENT',
      message: 'snapshot stateVersion does not match the state it wraps',
      details: { stateVersion: record.stateVersion, stateVersionInState: state.version },
    };
  }
  if (record.gameId !== state.gameId || record.seed !== state.seed) {
    return {
      ok: false,
      reason: 'INCONSISTENT',
      message: 'snapshot header does not match the state it wraps',
      details: { gameId: record.gameId, gameIdInState: state.gameId },
    };
  }
  return { ok: true, snapshot: record as unknown as GameSnapshot };
}

/**
 * Shape validation of a deserialized GameState — every field, structurally.
 * Business rules are NOT checked here (that is the reducer's job); this
 * guards the persistence boundary against structurally impossible states.
 */
export function validateGameStateShape(state: unknown): boolean {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return false;
  const s = state as Record<string, unknown>;

  if (typeof s.gameId !== 'string' || s.gameId.length === 0) return false;
  if (typeof s.version !== 'number' || !Number.isInteger(s.version) || s.version < 0) return false;
  if (typeof s.phase !== 'string' || !GAME_PHASES.includes(s.phase as GameState['phase'])) return false;
  if (s.turnPhase !== null && (typeof s.turnPhase !== 'string' || !TURN_PHASES.includes(s.turnPhase as never))) return false;
  if (typeof s.rulesVersion !== 'number' || !Number.isInteger(s.rulesVersion) || s.rulesVersion < 1) return false;
  if (!isUint32(s.seed)) return false;
  if (!isUint32(s.rngState)) return false;
  if (typeof s.turn !== 'number' || !Number.isInteger(s.turn) || s.turn < 0) return false;
  if (typeof s.lastEventSequence !== 'number' || !Number.isInteger(s.lastEventSequence) || s.lastEventSequence < 0) return false;

  if (!Array.isArray(s.players)) return false;
  const seenIds = new Set<string>();
  for (const player of s.players) {
    if (typeof player !== 'object' || player === null) return false;
    const p = player as Record<string, unknown>;
    if (typeof p.id !== 'string' || p.id.length === 0) return false;
    if (seenIds.has(p.id)) return false;
    seenIds.add(p.id);
    if (typeof p.seat !== 'number' || !Number.isInteger(p.seat) || p.seat < 0) return false;
    if (typeof p.eliminated !== 'boolean') return false;
  }
  if (s.activePlayerId !== null && (typeof s.activePlayerId !== 'string' || !seenIds.has(s.activePlayerId))) return false;

  if (!Array.isArray(s.processedCommandIds)) return false;
  const seenCommandIds = new Set<string>();
  for (const id of s.processedCommandIds) {
    if (typeof id !== 'string' || id.length === 0 || seenCommandIds.has(id)) return false;
    seenCommandIds.add(id);
  }
  return true;
}
