/**
 * Core domain vocabulary for the Tycoon City engine (spec §2).
 *
 * Everything here is plain, serializable data: no DOM, no wall-clock, no
 * ambient randomness. Commands, events, and snapshots all serialize these
 * types, so the reducer that runs local hot-seat play in Phase 1 can run
 * behind a server in Phase 2 without rework (spec §10).
 *
 * Note: the pre-spec demo's own vocabulary lives in ./demo-types.ts until
 * PR 10 relocates the demo.
 */

/** Rules version in effect for this engine build (spec §8). */
export const RULES_VERSION = 1;

/** Snapshot format version — independent of RULES_VERSION (spec §2.4). */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Player-count bounds for Phase 1 (spec §1: 2–6 players). */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Sentinel creditor for amounts owed to the bank rather than to a player (spec §7). */
export const BANK_ID = 'BANK';

/** A player's identity within one game. A plain string keeps every envelope JSON-friendly. */
export type PlayerId = string;

/** A board space identifier; concrete ids arrive with board-v1 data (PR 3). */
export type SpaceId = string;

/** Top-level game phases (spec §4). */
export type GamePhase = 'LOBBY' | 'PLAYING' | 'GAME_OVER';

export const GAME_PHASES: readonly GamePhase[] = ['LOBBY', 'PLAYING', 'GAME_OVER'];

/** Within-PLAYING phases (spec §4). PRs 4–8 light the phases they own. */
export type TurnPhase =
  | 'AWAITING_ROLL'
  | 'RESOLVING_MOVE'
  | 'BUY_DECISION'
  | 'AUCTION'
  | 'ELIMINATION_AUCTIONS'
  | 'SETTLING_DEBT'
  | 'TURN_MANAGEMENT';

export const TURN_PHASES: readonly TurnPhase[] = [
  'AWAITING_ROLL',
  'RESOLVING_MOVE',
  'BUY_DECISION',
  'AUCTION',
  'ELIMINATION_AUCTIONS',
  'SETTLING_DEBT',
  'TURN_MANAGEMENT',
];

/** Per-player state. Economy fields (cash, tokens) land with board-v1 data (PR 3). */
export interface PlayerState {
  readonly id: PlayerId;
  /** Fixed seat, 0-based; defines turn order. */
  readonly seat: number;
  readonly eliminated: boolean;
}

/**
 * The authoritative game state. Every field is serializable and every change
 * flows through applyCommand; consumers treat instances as immutable.
 */
export interface GameState {
  readonly gameId: string;
  /** Count of applied commands — the optimistic-concurrency version (spec §2.1 step 3, §2.4). */
  readonly version: number;
  readonly phase: GamePhase;
  /** Within-turn phase; null outside PLAYING. */
  readonly turnPhase: TurnPhase | null;
  readonly rulesVersion: number;
  readonly seed: number;
  /** Current Mulberry32 word — the engine's entire randomness state (spec §3). */
  readonly rngState: number;
  readonly players: readonly PlayerState[];
  /** Player whose turn it is; null in LOBBY and GAME_OVER. */
  readonly activePlayerId: PlayerId | null;
  /** 1-based turn counter; 0 in LOBBY. */
  readonly turn: number;
  /** Highest event sequence stamped so far; keeps sequences gapless across the fold (spec §2.2). */
  readonly lastEventSequence: number;
  /** Idempotency ledger — every commandId applied to this state (spec §2.1 step 4, §2.4). */
  readonly processedCommandIds: readonly string[];
}

/** One side of a trade offer. Trading rules and validation land in PR 7 (spec §6). */
export interface TradeSide {
  readonly cash: number;
  readonly spaceIds: readonly SpaceId[];
}

/** An atomic swap: the proposer gives `give` and receives `receive`. */
export interface TradeOffer {
  readonly give: TradeSide;
  readonly receive: TradeSide;
}

/** How the recipient answered a trade offer (spec §6). */
export type TradeResponse = 'ACCEPT' | 'REJECT' | 'COUNTER';

/** Why a payment came due — exactly one creditor per debt in Phase 1 (spec §7). */
export type DebtReason = 'RENT' | 'TAX' | 'SERVICE' | 'CARD';

/** Deterministic event metadata: draw RESULTS only, never raw PRNG words (spec §2.2, §3). */
export interface EventMeta {
  /** Both dice for a roll. */
  readonly dice?: readonly [number, number];
  /** Id of the card drawn from the Event Deck. */
  readonly cardId?: string;
}

/** True when v is an integer in [0, 2^32). Used for seeds, RNG words, and shape validation. */
export function isUint32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}
