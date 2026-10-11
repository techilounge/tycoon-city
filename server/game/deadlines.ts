/**
 * Server-enforced deadlines (spec "Deadlines — timers that act like players";
 * contract §3): per-mode turn windows and the fixed auction-bid window.
 *
 * The engine is wall-clock-free by design — every deadline here ends as an
 * ORDINARY command composed by this scheduler and submitted through the
 * GameHost's per-game queue, so it passes the same 8-step pipeline, is
 * ledgered with a `server-auto-…` commandId, and is replay-covered exactly
 * like a player command.
 *
 * Expiry mappings (all ordinary commands; every type hits canAct's default
 * active-player branch, per the spec's "canAct default allows"):
 *
 *   turn window      AWAITING_ROLL    → ROLL             (the expired active player rolls)
 *                    BUY_DECISION     → PASS_TO_AUCTION  (the conservative decline)
 *                    SETTLING_DEBT    → SURRENDER        (the debtor IS the active player)
 *                    TURN_MANAGEMENT  → END_TURN
 *   auction window   standing bid     → VOID_BID         (actorId = BANK_ID — server identity)
 *                    no standing bid  → PASS_BID         (first eligible unpassed bidder)
 *
 * The no-standing-bid branch completes the same deadline with existing
 * commands: an auction where every remaining bidder has gone quiet would
 * otherwise stall the game forever — each window expiry bindingly passes one
 * eligible player until the sale closes unsold via the existing end path.
 * No new engine semantics; flagged in the PR body.
 *
 * Stale-timer safety: a window that expires while an intervening command
 * re-armed its slot is dropped (the generation check inside the runner task)
 * — a timer never consumes a freshly granted window, and a state that moved
 * somewhere the deadline cannot act on composes null and drops quietly.
 */
import { randomBytes } from 'node:crypto';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { ModeId } from '../../src/lib/game/board-v1';
import { BANK_ID, type GameState, type TurnPhase } from '../../src/lib/game/types';
import type { DeadlineBroadcast } from '../../src/lib/game/transport/protocol';

/** Deadline windows in milliseconds — spec policy, owner-locked 2026-10-11. */
export interface DeadlinePolicy {
  readonly turnMs: Readonly<Record<ModeId, number>>;
  readonly auctionBidMs: number;
}

export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = {
  turnMs: { CLASSIC: 90_000, QUICK: 60_000, BLITZ: 45_000 },
  auctionBidMs: 30_000,
};

/** The player-facing decision points the turn window governs. RESOLVING_MOVE
 *  is deliberately absent — ROLL resolves movement atomically, so the phase
 *  is never observable between commands. The auction phases belong to the
 *  auction window instead. */
const TURN_DECISION_PHASES: readonly TurnPhase[] = ['AWAITING_ROLL', 'BUY_DECISION', 'SETTLING_DEBT', 'TURN_MANAGEMENT'];

/** A server-composed deadline submission: the session to stamp it as, and the command itself. */
export interface DeadlineSubmission {
  readonly session: { readonly gameId: string; readonly actorId: string };
  readonly command: GameCommand;
}

/** The host seam: run a composed submission inside the per-game queue. The
 *  composition closure receives the state AS OF EXECUTION — never a stale
 *  capture — and returns null to drop a stale or inapplicable expiry. */
export type DeadlineRunner = (compose: (state: GameState) => DeadlineSubmission | null) => Promise<unknown>;

/** Pure: the ordinary command that expresses "pass" for the pending turn decision. */
export function turnExpirySubmission(state: GameState, commandId: string): DeadlineSubmission | null {
  if (state.phase !== 'PLAYING' || state.activePlayerId === null) return null;
  const type = turnExpiryCommandType(state.turnPhase);
  if (type === null) return null;
  return composeSubmission(state, state.activePlayerId, type, {});
}

/** Pure: the ordinary command for an expired auction window — the bank's
 *  void of the standing bid, or a binding pass for the first eligible player
 *  still in when nobody has bid. */
export function auctionExpirySubmission(state: GameState, commandId: string): DeadlineSubmission | null {
  if (state.phase !== 'PLAYING' || state.auction === null) return null;
  const auction = state.auction;
  if (auction.highBidderId !== null) {
    return composeSubmission(state, BANK_ID, 'VOID_BID', { auctionId: auction.auctionId });
  }
  const firstUnpassed = auction.eligiblePlayerIds.find((id) => !auction.passedPlayerIds.includes(id));
  if (firstUnpassed === undefined) {
    // Unreachable while the tested auction⟷phase invariant holds (an open
    // auction always has an unpassed eligible player) — drop rather than
    // invent a command.
    return null;
  }
  return composeSubmission(state, firstUnpassed, 'PASS_BID', { auctionId: auction.auctionId });
}

function turnExpiryCommandType(turnPhase: TurnPhase | null): CommandType | null {
  switch (turnPhase) {
    case 'AWAITING_ROLL':
      return 'ROLL';
    case 'BUY_DECISION':
      return 'PASS_TO_AUCTION';
    case 'SETTLING_DEBT':
      return 'SURRENDER';
    case 'TURN_MANAGEMENT':
      return 'END_TURN';
    default:
      return null;
  }
}

function composeSubmission(
  state: GameState,
  actorId: string,
  type: CommandType,
  payload: Record<string, unknown>,
): DeadlineSubmission {
  return {
    session: { gameId: state.gameId, actorId },
    command: {
      commandId: nextAutoCommandId(),
      gameId: state.gameId,
      actorId,
      expectedVersion: state.version,
      type,
      payload,
    } as GameCommand,
  };
}

/** Deadline commandIds are namespaced so audits can separate server actions
 *  from player actions in the ledger. */
export function nextAutoCommandId(): string {
  return `server-auto-${randomBytes(8).toString('hex')}`;
}

/**
 * Owns the two windows for one game. Re-armed from the current state after
 * every applied command (and when a host resumes): each state change grants
 * a FULL fresh window for the decision now pending — the windows are
 * "decision idle timeouts", not shared budgets.
 */
export class DeadlineScheduler {
  private turnTimer: NodeJS.Timeout | null = null;
  private auctionTimer: NodeJS.Timeout | null = null;
  private turnExpiresAtMs: number | null = null;
  private auctionExpiresAtMs: number | null = null;
  private stopped = false;

  constructor(
    private readonly run: DeadlineRunner,
    private readonly policy: DeadlinePolicy = DEFAULT_DEADLINE_POLICY,
  ) {}

  /** Recompute the armed timers from the current state. Called after every
   *  applied command and when a host resumes from a snapshot. */
  sync(state: GameState): void {
    if (this.stopped) return;
    this.clear();
    if (state.phase !== 'PLAYING') return;
    if (state.turnPhase !== null && TURN_DECISION_PHASES.includes(state.turnPhase)) {
      this.turnTimer = setTimeout(() => this.onTurnExpiry(), this.policy.turnMs[state.mode]);
      this.turnTimer.unref?.();
      this.turnExpiresAtMs = Date.now() + this.policy.turnMs[state.mode];
    }
    if (state.auction !== null) {
      this.auctionTimer = setTimeout(() => this.onAuctionExpiry(), this.policy.auctionBidMs);
      this.auctionTimer.unref?.();
      this.auctionExpiresAtMs = Date.now() + this.policy.auctionBidMs;
    }
  }

  /** Stop re-arming and clear pending windows — the host is being discarded. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  broadcastOf(gameId: string): DeadlineBroadcast {
    return { gameId, turnExpiresAtMs: this.turnExpiresAtMs, auctionExpiresAtMs: this.auctionExpiresAtMs };
  }

  private onTurnExpiry(): void {
    this.turnTimer = null;
    this.turnExpiresAtMs = null;
    this.run((state) => {
      // Generation check: a newer state change re-armed this slot while the
      // queue was busy — that expiry is stale and must not consume the
      // freshly granted window.
      if (this.turnTimer !== null) return null;
      return turnExpirySubmission(state, nextAutoCommandId());
    }).then(undefined, (error: unknown) => {
      // Never swallowed, never fatal: the fault is logged and the next state
      // change re-syncs the windows.
      console.error('[tycoon-server] turn deadline submission failed:', error);
    });
  }

  private onAuctionExpiry(): void {
    this.auctionTimer = null;
    this.auctionExpiresAtMs = null;
    this.run((state) => {
      if (this.auctionTimer !== null) return null;
      return auctionExpirySubmission(state, nextAutoCommandId());
    }).then(undefined, (error: unknown) => {
      console.error('[tycoon-server] auction deadline submission failed:', error);
    });
  }

  private clear(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.auctionTimer !== null) {
      clearTimeout(this.auctionTimer);
      this.auctionTimer = null;
    }
    this.turnExpiresAtMs = null;
    this.auctionExpiresAtMs = null;
  }
}
