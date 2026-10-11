/**
 * The client's network transport (spec "Socket protocol"): NetworkCommandSink
 * submits commands as `game:command` with an ack + timeout; SocketEventSource
 * receives `game:event` broadcasts with a gapless client-side check and the
 * last-seen sequence the reconnect catch-up resumes from.
 *
 * Ack shape (inherited, documented deviation from the spec's first sketch):
 * a socket ack deliberately does NOT carry the reducer's full CommandResult —
 * its success `state` is server-side truth and would leak the §4 private
 * fields. Clients learn state from redacted `game:state` broadcasts (PR 15
 * documented this in protocol.ts). The submit METHOD shape matches CommandSink
 * exactly; the resolved result is the wire-safe projection WireCommandResult,
 * plus client-generated transport faults (`ACK_TIMEOUT`).
 */
import type { Socket as ClientSocket } from 'socket.io-client';
import type { GameCommand } from '../commands';
import type { AnyGameEvent } from '../events';
import type { RuleErrorCode } from '../engine/errors';
import type { Unsubscribe } from '../engine/transport';
import { SOCKET_EVENTS, type GatewayErrorCode, type WireCommandResult } from './protocol';

/** Codes a CLIENT can generate on its own side of the wire (never server-emitted). */
export type ClientTransportErrorCode = GatewayErrorCode | RuleErrorCode | 'ACK_TIMEOUT' | 'EVENT_GAP';

/** A client-observed fault: a server wire error or a client transport fault. */
export interface TransportFault {
  readonly code: ClientTransportErrorCode;
  readonly message: string;
}

/** The network sink's submit result — the wire ack, or a client-side fault. */
export type NetworkSubmitResult = WireCommandResult | { readonly ok: false; readonly error: TransportFault };

/** Default ack budget per command (spec: "emit with ack + timeout"). */
export const COMMAND_ACK_TIMEOUT_MS = 10_000;

/**
 * The online CommandSink. submit resolves (never rejects — the same contract
 * the local sink keeps) with the wire ack, or with `ACK_TIMEOUT` when the
 * server fails to answer in time. A timed-out command may still have applied
 * server-side; the next `game:state` broadcast reveals the truth. The sink
 * never resubmits on its own: the command ledger makes a deliberate retry
 * (same commandId) idempotent, and that choice belongs to the caller.
 */
export class NetworkCommandSink {
  constructor(
    private readonly socket: ClientSocket,
    private readonly timeoutMs: number = COMMAND_ACK_TIMEOUT_MS,
  ) {}

  submit(command: GameCommand): Promise<NetworkSubmitResult> {
    return new Promise<NetworkSubmitResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error: {
            code: 'ACK_TIMEOUT',
            message: `The server did not answer within ${Math.round(this.timeoutMs / 1000)}s. The command may still have applied — check the board.`,
          },
        });
      }, this.timeoutMs);
      this.socket.emit(SOCKET_EVENTS.command, command, (result: WireCommandResult) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }
}

/**
 * The gapless client-side event check (spec criterion 5/6): per game, the
 * first observed sequence must be followed by exactly sequence+1 — catch-up
 * streams arrive in stamped order, so any jump is a real gap (or a resend,
 * dropped). The source keeps the last seen sequence so the reconnect flow
 * can request `fromSeq = lastSeen + 1`.
 */
export class EventGapError extends Error {
  constructor(
    readonly gameId: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(`event gap in ${gameId}: expected sequence ${expected}, received ${received}`);
    this.name = 'EventGapError';
  }
}

export class SocketEventSource {
  private readonly listeners = new Set<(event: AnyGameEvent) => void>();
  private readonly lastSeenByGame = new Map<string, number>();

  constructor(
    private readonly socket: ClientSocket,
    /** Notified (and delivery SKIPPED for the gapped event) when order breaks. */
    private readonly onGap?: (error: EventGapError) => void,
  ) {
    socket.on(SOCKET_EVENTS.event, (event: AnyGameEvent) => this.deliver(event));
  }

  /** The last contiguously observed sequence for a game; 0 before any event. */
  lastSeenSeq(gameId: string): number {
    return this.lastSeenByGame.get(gameId) ?? 0;
  }

  /**
   * EventSource shape (transport.ts): deliver this game's events from
   * `fromSeq` on. Live broadcasts flow through the same listener; after a
   * reconnect the client re-joins with `lastSeenSeq + 1` and the server
   * streams the missed events into it — one subscription, one ordering.
   */
  subscribe(gameId: string, fromSeq: number, onEvent: (event: AnyGameEvent) => void): Unsubscribe {
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  /**
   * Receive every delivered event regardless of game — wired at construction
   * time (before any join), so create-time and join-time catch-up streams are
   * never missed by a late subscriber. The OnlineGameClient registers its
   * owner's `onEvent` callback here in its constructor.
   */
  subscribeAll(onEvent: (event: AnyGameEvent) => void): Unsubscribe {
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  private deliver(event: AnyGameEvent): void {
    const seen = this.lastSeenByGame.get(event.gameId) ?? 0;
    if (event.sequence <= seen) return; // stale catch-up replay of an owned event — drop
    if (event.sequence !== seen + 1) {
      // A true gap: surface it and skip the out-of-order event. The owner of
      // the subscription heals by re-joining from lastSeen + 1.
      this.onGap?.(new EventGapError(event.gameId, seen + 1, event.sequence));
      return;
    }
    this.lastSeenByGame.set(event.gameId, event.sequence);
    for (const listener of this.listeners) listener(event);
  }
}
