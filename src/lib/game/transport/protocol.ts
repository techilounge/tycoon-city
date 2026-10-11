/**
 * Wire protocol types shared by the server gateway and (Phase 2 PR 16) the
 * client network transport. Pure serializable data — no Node, no DOM (spec
 * §2.1: commands, events, and envelopes are plain JSON).
 *
 * A socket ack deliberately does NOT carry the reducer's full CommandResult:
 * its success `state` is server-side truth and would leak the §4 private
 * fields (seed, RNG word, deck orders). Clients learn state from redacted
 * `game:state` broadcasts instead.
 */
import type { AnyGameEvent } from '../events';
import type { RuleErrorCode } from '../engine/errors';
import { RuleError } from '../engine/errors';

/** Socket event names (spec "Socket protocol"). */
export const SOCKET_EVENTS = {
  join: 'game:join',
  command: 'game:command',
  joined: 'game:joined',
  state: 'game:state',
  event: 'game:event',
  error: 'game:error',
} as const;

/** Codes the gateway itself emits; engine rejections reuse the closed RuleErrorCode set. */
export type GatewayErrorCode =
  | 'UNAUTHENTICATED'
  | 'RATE_LIMITED'
  | 'GAME_NOT_FOUND'
  | 'STATE_LOAD_FAILED';

/** The wire-safe error: a closed-set code plus a human message. */
export interface WireError {
  readonly code: GatewayErrorCode | RuleErrorCode;
  readonly message: string;
}

/** Server → client `game:error` event payload. */
export type GatewayError = WireError;

/** Ack for `game:command` — the CommandResult contract minus server state. */
export type WireCommandResult =
  | { readonly ok: true; readonly applied: boolean; readonly events: readonly AnyGameEvent[] }
  | { readonly ok: false; readonly error: WireError };

/** Serialize a RuleError for the wire (Error instances do not JSON-stringify usefully). */
export function toWireError(error: RuleError): WireError {
  return { code: error.code, message: error.message };
}

/** Socket.IO room name for a game — rooms map 1:1 to games (spec decision 1). */
export function gameRoomOf(gameId: string): string {
  return `game:${gameId}`;
}
