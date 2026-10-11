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
import type { GamePhase, PlayerId, PlayerState } from '../types';

/** Socket event names (spec "Socket protocol"). `create` is Phase 2's additive
 *  room-bootstrap event — the spec's protocol table names no creation message,
 *  so rooms are born over the same socket surface as every other interaction. */
export const SOCKET_EVENTS = {
  create: 'game:create',
  join: 'game:join',
  command: 'game:command',
  joined: 'game:joined',
  state: 'game:state',
  event: 'game:event',
  deadline: 'game:deadline',
  error: 'game:error',
} as const;

/** Server → client `game:deadline` payload (Phase 2, contract §3): the
 *  currently armed deadlines as absolute expiry timestamps on the server
 *  clock. Presentation-only — the UI's DeadlineBar renders the countdown;
 *  the server enforces the action when a window expires. A null field means
 *  that deadline is not armed (lobby, game over, or no open auction). */
export interface DeadlineBroadcast {
  readonly gameId: string;
  /** The turn-decision window (roll, buy decision, debt settlement, management). */
  readonly turnExpiresAtMs: number | null;
  /** The open auction's bid/pass window. */
  readonly auctionExpiresAtMs: number | null;
}

/** Codes the gateway itself emits; engine rejections reuse the closed RuleErrorCode set. */
export type GatewayErrorCode =
  | 'UNAUTHENTICATED'
  | 'RATE_LIMITED'
  | 'GAME_NOT_FOUND'
  | 'STATE_LOAD_FAILED'
  /** Room lifecycle (PR 15): unknown room code, game past its LOBBY, no free
   *  seat, a bad token on re-join, malformed create/join payload, or an
   *  unexpected server fault. */
  | 'ROOM_NOT_FOUND'
  | 'ROOM_IN_PROGRESS'
  | 'ROOM_FULL'
  | 'INVALID_SESSION'
  | 'INVALID_PAYLOAD'
  | 'INTERNAL';

/** One claimed seat, as the sessions table knows it. */
export interface RosterEntry {
  readonly actorId: PlayerId;
  readonly name: string;
}

/** The public room view broadcast as `game:joined` — no token, ever. */
export interface JoinedBroadcast {
  readonly gameId: string;
  readonly roomCode: string;
  readonly actorId: PlayerId;
  readonly name: string;
  readonly phase: GamePhase;
  /** All engine seats (claimed or not) — plain public PlayerState rows. */
  readonly players: readonly PlayerState[];
  /** Claimed seats with display names, in seat order. */
  readonly roster: readonly RosterEntry[];
}

/** The private ack of `game:create` / `game:join` — the broadcast plus the
 *  joiner's own session token (a credential: joiner-only, never broadcast). */
export interface SessionAck {
  readonly ok: true;
  readonly token: string;
  readonly gameId: string;
  readonly roomCode: string;
  readonly actorId: PlayerId;
  readonly phase: GamePhase;
  readonly players: readonly PlayerState[];
  readonly roster: readonly RosterEntry[];
}

/** Ack union for the room events: the SessionAck or a wire error. */
export type RoomAck = SessionAck | { readonly ok: false; readonly error: WireError };

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
