/**
 * Room lifecycle (spec "Socket protocol" + criterion 5): create a room with a
 * 6-character unambiguous code, join by code + display name while the game is
 * in LOBBY, claim seats, and re-present a session token to reconnect. All
 * data-layer logic lives here; the gateway owns sockets and calls the pieces
 * — the join/reconnect critical section runs inside the game's queue via
 * `GameHost.runExclusive`, so a join can never interleave with an applied
 * command.
 *
 * Seat model: a room is created with a fixed 2–6 seat count; engine players
 * `p1..pN` are minted at creation (seat order = array order). A seat is
 * CLAIMED exactly when a session row names its actorId — claims are permanent
 * for the game's lifetime (an expired token loses authentication, never its
 * seat), and joining never requires every seat to be claimed before start.
 */
import type { Server } from 'socket.io';
import { MODES, type ModeId } from '../../src/lib/game/board-v1';
import type { AnyGameEvent } from '../../src/lib/game/events';
import type { PlayerId } from '../../src/lib/game/types';
import { MAX_PLAYERS, MIN_PLAYERS } from '../../src/lib/game/types';
import {
  gameRoomOf,
  type GatewayErrorCode,
  type JoinedBroadcast,
  type RosterEntry,
  type SessionAck,
} from '../../src/lib/game/transport/protocol';
import type { GameRow, SessionRow, TycoonDb } from '../db';
import { GameHost } from './gameHost';

/** A lifecycle refusal with its wire code — the gateway emits `game:error`. */
export class RoomLifecycleError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomLifecycleError';
  }
}

/** Display names: trimmed, 1–24 characters — enough to be personal, too short to abuse. */
const MAX_NAME_LENGTH = 24;

export interface CreateRoomInput {
  readonly mode: ModeId;
  readonly seatCount: number;
  readonly name: string;
}

export interface JoinRoomInput {
  readonly code: string;
  readonly name: string;
  /** When present: a re-presented session token (the reconnect flow). */
  readonly token?: string;
  /** When present: stream stored events with sequence ≥ fromSeq after the state.
   *  Absent → the full history from sequence 1, so every seat's stream stays
   *  gapless from the very first event (criterion 5). */
  readonly fromSeq?: number;
}

export interface CreateRoomResult {
  readonly host: GameHost;
  readonly gameId: string;
  readonly roomCode: string;
  readonly session: SessionRow;
  readonly ack: SessionAck;
}

export interface JoinPreparation {
  readonly session: SessionRow;
  /** True when an existing token was re-presented (no seat claimed, no roster change). */
  readonly reconnected: boolean;
  /** Missed events to stream (sequence ≥ fromSeq), in stamped order; empty when not requested. */
  readonly catchUpEvents: readonly AnyGameEvent[];
}

// ---------------------------------------------------------------------------
// Input validation — untrusted wire payloads, strict shapes.
// ---------------------------------------------------------------------------

export function parseCreateInput(raw: unknown): CreateRoomInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new RoomLifecycleError('INVALID_PAYLOAD', 'game:create needs a payload object.');
  }
  const { mode, seatCount, name } = raw as Record<string, unknown>;
  if (typeof mode !== 'string' || !(mode in MODES)) {
    throw new RoomLifecycleError('INVALID_PAYLOAD', `mode must be one of: ${Object.keys(MODES).join(', ')}.`);
  }
  if (typeof seatCount !== 'number' || !Number.isInteger(seatCount) || seatCount < MIN_PLAYERS || seatCount > MAX_PLAYERS) {
    throw new RoomLifecycleError('INVALID_PAYLOAD', `seatCount must be an integer from ${MIN_PLAYERS} to ${MAX_PLAYERS}.`);
  }
  return { mode: mode as ModeId, seatCount, name: parseName(name) };
}

export function parseJoinInput(raw: unknown): JoinRoomInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new RoomLifecycleError('INVALID_PAYLOAD', 'game:join needs a payload object.');
  }
  const { code, name, token, fromSeq } = raw as Record<string, unknown>;
  if (typeof code !== 'string') {
    throw new RoomLifecycleError('INVALID_PAYLOAD', 'code must be a string.');
  }
  const parsed: { code: string; name: string; token?: string; fromSeq?: number } = {
    code: code.trim().toUpperCase(),
    name: parseName(name),
  };
  if (token !== undefined) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new RoomLifecycleError('INVALID_SESSION', 'token, when presented, must be a non-empty string.');
    }
    parsed.token = token;
  }
  if (fromSeq !== undefined) {
    if (typeof fromSeq !== 'number' || !Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new RoomLifecycleError('INVALID_PAYLOAD', 'fromSeq must be a non-negative integer.');
    }
    parsed.fromSeq = fromSeq;
  }
  return parsed;
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new RoomLifecycleError('INVALID_PAYLOAD', 'name must be a string.');
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new RoomLifecycleError('INVALID_PAYLOAD', `name must be 1–${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

/** Engine player ids for a room's seats, in seat order — `p1..pN`. */
export function seatIdsFor(seatCount: number): PlayerId[] {
  return Array.from({ length: seatCount }, (_, seat) => `p${seat + 1}`);
}

// ---------------------------------------------------------------------------
// Create — room code, game, creator's session.
// ---------------------------------------------------------------------------

/**
 * Create the room: a server-side seed (crypto.randomBytes inside GameHost.create —
 * the online flow never accepts a client seed, spec decision 5), an unambiguous
 * room code, and the creator's session on seat one.
 */
export function createRoom(db: TycoonDb, io: Server, input: CreateRoomInput): CreateRoomResult {
  const { host, gameId, roomCode } = GameHost.create(db, io, {
    mode: input.mode,
    playerIds: seatIdsFor(input.seatCount),
  });
  const row = requireGameRow(db, gameId);
  const session = claimSeat(db, gameId, seatIdsFor(input.seatCount), input.name);
  return {
    host,
    gameId,
    roomCode,
    session,
    ack: sessionAckOf(roomCode, host, session, sessionRoster(db, gameId, host)),
  };
}

/** Resolve a room code to its game row, or refuse with ROOM_NOT_FOUND. */
export function resolveRoomCode(db: TycoonDb, code: string): GameRow {
  const row = db.getGameByRoomCode(code);
  if (row === null) throw new RoomLifecycleError('ROOM_NOT_FOUND', `No room has code ${code}.`);
  return row;
}

// ---------------------------------------------------------------------------
// Join — MUST run inside the game's serialization boundary.
// ---------------------------------------------------------------------------

/**
 * The join/reconnect critical section: phase gate (fresh joins only), seat
 * claim (fresh) or token re-authentication (reconnect), and catch-up event
 * resolution. The gateway performs the socket work (room admission, state +
 * catch-up emission) with the returned data while still inside the queue.
 */
export function prepareJoin(
  db: TycoonDb,
  host: GameHost,
  row: GameRow,
  input: JoinRoomInput,
  presented: SessionRow | null,
): JoinPreparation {
  if (presented !== null) {
    // Reconnect: valid through any phase (criterion 6) — refresh presence, no claim.
    db.touchSession(presented.token);
    return { session: presented, reconnected: true, catchUpEvents: catchUpEvents(db, row.gameId, input.fromSeq) };
  }

  // Fresh join: LOBBY-only (late join → ROOM_IN_PROGRESS, criterion 5).
  if (host.phase !== 'LOBBY') {
    throw new RoomLifecycleError('ROOM_IN_PROGRESS', 'This game has already started.');
  }
  const seatIds = seatIdsFor(host.clientState.players.length);
  const session = claimSeat(db, row.gameId, seatIds, input.name);
  return { session, reconnected: false, catchUpEvents: catchUpEvents(db, row.gameId, input.fromSeq) };
}

function catchUpEvents(db: TycoonDb, gameId: string, fromSeq: number | undefined) {
  // Full history by default (fresh joins and create-path joins): the events
  // are public (draw results, money derivations — never RNG state), so every
  // room member can hold the complete, gapless activity stream.
  return db.getEvents(gameId, fromSeq ?? 1);
}

/** Claim the lowest unclaimed seat; ROOM_FULL when none remain (criterion 5). */
function claimSeat(db: TycoonDb, gameId: string, seatIds: readonly PlayerId[], name: string): SessionRow {
  const claimed = new Set(db.listSessionsForGame(gameId).map((row) => row.actorId));
  const seat = seatIds.find((id) => !claimed.has(id));
  if (seat === undefined) throw new RoomLifecycleError('ROOM_FULL', 'Every seat in this room is claimed.');
  return db.createSession({ gameId, actorId: seat, name });
}

// ---------------------------------------------------------------------------
// Payloads — the ack (joiner-only token) and the room broadcast (no token).
// ---------------------------------------------------------------------------

export function sessionAckOf(roomCode: string, host: GameHost, session: SessionRow, roster: readonly RosterEntry[]): SessionAck {
  return {
    ok: true,
    token: session.token,
    gameId: host.gameId,
    roomCode,
    actorId: session.actorId,
    phase: host.phase,
    players: host.clientState.players,
    roster,
  };
}

export function broadcastOf(roomCode: string, host: GameHost, session: SessionRow, roster: readonly RosterEntry[]): JoinedBroadcast {
  const ack = sessionAckOf(roomCode, host, session, roster);
  return {
    gameId: ack.gameId,
    roomCode: ack.roomCode,
    actorId: ack.actorId,
    name: session.name,
    phase: ack.phase,
    players: ack.players,
    roster: ack.roster,
  };
}

/** Claimed seats with display names, in seat order — unclaimed seats omitted. */
export function sessionRoster(db: TycoonDb, gameId: string, host: GameHost): RosterEntry[] {
  const byActor = new Map(db.listSessionsForGame(gameId).map((row) => [row.actorId, row.name]));
  return host.clientState.players
    .filter((player) => byActor.has(player.id))
    .map((player) => ({ actorId: player.id, name: byActor.get(player.id) as string }));
}

function requireGameRow(db: TycoonDb, gameId: string): GameRow {
  const row = db.getGame(gameId);
  if (row === null) throw new RoomLifecycleError('INTERNAL', `game row missing after creation: ${gameId}`);
  return row;
}
