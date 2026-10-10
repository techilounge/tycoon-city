/**
 * Event envelope and the full Phase 1 event vocabulary (spec §2.2).
 *
 * Thirty-five typed event types — the capped Phase 1 set (spec §14). The
 * reducer stamps envelope fields deterministically: sequences are gapless
 * per game and eventIds are composites of gameId and sequence, so replay
 * reproduces the log byte-for-byte.
 */
import type { AuctionOpenReason, CreditorId, DebtReason, EventMeta, PlayerId, SpaceId, TokenKind, TradeOffer, TradeResponse } from './types';
import { BANK_ID, RULES_VERSION } from './types';
import type { EventCardEffect } from './board-v1';
import { RuleError } from './engine/errors';

export type TurnSkipReason = 'HOLD_TOKEN' | 'THIRD_DOUBLES';
export type MoveDirection = 'FORWARD' | 'BACKWARD';
export type PurchaseVia = 'DIRECT' | 'AUCTION';
export type TaxKind = 'ASSESSMENT_OFFICE' | 'MUNICIPAL_LEVY';
/** TokenKind is owned by ./types (base vocabulary); re-exported here so the
 *  Event Deck catalog (board-v1) and TOKEN_CONSUMED payloads share one name. */
export type { TokenKind };
/** CreditorId is owned by ./types (base vocabulary); re-exported here so
 *  DEBT_* payload consumers keep one import site. */
export type { CreditorId };
/** AuctionOpenReason is owned by ./types (base vocabulary); re-exported here
 *  so AUCTION_OPENED payload consumers keep one import site. */
export type { AuctionOpenReason };
export type VictoryReason = 'LAST_SOLVENT' | 'NET_WORTH_TARGET' | 'ROUND_CAP';

/**
 * The worked arithmetic behind one rent payment (spec §11 explanations):
 * carried by the RENT_PAID event so the UI prints the derivation without
 * re-running any formula. amount on the event is the dollars that actually
 * moved; the detail names the inputs the rent formula combined.
 */
export type RentDetail =
  | {
      readonly via: 'PROPERTY';
      /** 10% of the space's list price. */
      readonly base: number;
      readonly levelMultiplier: number;
      readonly districtMultiplier: number;
    }
  | { readonly via: 'HUB'; /** How many hubs the owner holds (1 or 2). */
      readonly hubCount: 1 | 2 };

export interface EventPayloadMap {
  /** A game was created; players are seated in turn order. The seed is deliberately
   *  NOT in the log — it is state-private and becomes server-private in Phase 2 (spec §3, §10). */
  readonly GAME_CREATED: { readonly playerIds: readonly PlayerId[] };
  readonly TURN_STARTED: { readonly playerId: PlayerId; readonly turn: number };
  readonly TURN_SKIPPED: { readonly playerId: PlayerId; readonly reason: TurnSkipReason };
  readonly TURN_ENDED: { readonly playerId: PlayerId; readonly turn: number };
  /** Dice values ride in meta as draw results, per spec §2.2. */
  readonly DICE_ROLLED: { readonly playerId: PlayerId };
  readonly PLAYER_MOVED: { readonly playerId: PlayerId; readonly from: number; readonly to: number; readonly direction: MoveDirection };
  /** $250 start bonus on any forward pass or landing of Gateway Terminal (spec §4 row 3). */
  readonly START_BONUS_PAID: { readonly playerId: PlayerId; readonly amount: number };
  readonly PROPERTY_PURCHASED: { readonly playerId: PlayerId; readonly spaceId: SpaceId; readonly amount: number; readonly via: PurchaseVia };
  readonly RENT_PAID: {
    readonly payerId: PlayerId;
    readonly ownerId: PlayerId;
    readonly spaceId: SpaceId;
    readonly amount: number;
    /** The worked rent arithmetic as applied (spec §11) — the event carries
     *  the derivation; the UI never recomputes a formula. */
    readonly detail: RentDetail;
    /** True when a Rent Holiday token was spent to halve this payment. */
    readonly rentHolidayApplied: boolean;
  };
  readonly TAX_PAID: {
    readonly playerId: PlayerId;
    readonly amount: number;
    readonly taxKind: TaxKind;
    /** The cash the levy rate applied to — present only for the Municipal
     *  Levy (CASH_RATE), so the UI can print "8% of $X = $amount". */
    readonly levyCashBasis?: number;
  };
  readonly SERVICE_CHARGED: {
    readonly playerId: PlayerId;
    readonly spaceId: SpaceId;
    readonly amount: number;
    /** The dice total and multiplier whose product is the amount (spec §11). */
    readonly diceTotal: number;
    readonly multiplier: number;
  };
  /** Card id rides in meta. */
  readonly CARD_DRAWN: { readonly playerId: PlayerId };
  readonly CARD_EFFECT_APPLIED: {
    readonly playerId: PlayerId;
    readonly cardId: string;
    /** The full effect as applied — the log stays self-explanatory without a
     *  catalog join, and money movements carry their own reason. */
    readonly effect: EventCardEffect;
  };
  readonly TOKEN_CONSUMED: { readonly playerId: PlayerId; readonly token: TokenKind };
  readonly UPGRADE_BUILT: { readonly playerId: PlayerId; readonly spaceId: SpaceId; readonly level: number; readonly cost: number };
  readonly UPGRADE_SOLD: { readonly playerId: PlayerId; readonly spaceId: SpaceId; readonly level: number; readonly proceeds: number };
  readonly MORTGAGE_TAKEN: { readonly playerId: PlayerId; readonly spaceId: SpaceId; readonly proceeds: number };
  readonly MORTGAGE_LIFTED: { readonly playerId: PlayerId; readonly spaceId: SpaceId; readonly cost: number };
  readonly AUCTION_OPENED: { readonly auctionId: string; readonly spaceId: SpaceId; readonly reason: AuctionOpenReason };
  readonly AUCTION_BID: { readonly auctionId: string; readonly bidderId: PlayerId; readonly amount: number };
  readonly AUCTION_PASS: { readonly auctionId: string; readonly bidderId: PlayerId };
  readonly AUCTION_RESOLVED: { readonly auctionId: string; readonly winnerId: PlayerId; readonly spaceId: SpaceId; readonly amount: number };
  readonly AUCTION_CLOSED_UNSOLD: { readonly auctionId: string; readonly spaceId: SpaceId };
  readonly TRADE_OFFERED: { readonly tradeId: string; readonly proposerId: PlayerId; readonly recipientId: PlayerId; readonly offer: TradeOffer };
  readonly TRADE_ANSWERED: { readonly tradeId: string; readonly responderId: PlayerId; readonly response: TradeResponse; readonly counterTradeId?: string };
  readonly TRADE_EXPIRED: { readonly tradeId: string };
  /** Offers die with any involved party's elimination or bankruptcy (spec §7). */
  readonly TRADE_CANCELLED: { readonly tradeId: string; readonly reason: 'PARTY_INELIGIBLE' };
  readonly DEBT_ENTERED: { readonly debtorId: PlayerId; readonly creditorId: CreditorId; readonly amount: number; readonly reason: DebtReason };
  readonly DEBT_SETTLED: { readonly debtorId: PlayerId; readonly creditorId: CreditorId; readonly amount: number };
  readonly PLAYER_BANKRUPT: { readonly playerId: PlayerId; readonly creditorId: CreditorId };
  readonly ASSETS_TRANSFERRED: { readonly fromId: PlayerId; readonly toId: CreditorId; readonly cash: number; readonly spaceIds: readonly SpaceId[] };
  readonly PLAYER_ELIMINATED: { readonly playerId: PlayerId };
  readonly VICTORY_DECIDED: { readonly winnerIds: readonly PlayerId[]; readonly reason: VictoryReason };
  readonly GAME_ENDED: { readonly winnerIds: readonly PlayerId[]; readonly reason: VictoryReason };
  readonly SNAPSHOT_SAVED: { readonly stateVersion: number };
}

export type EventType = keyof EventPayloadMap;

/** Exhaustive at compile time; gives a runtime list without duplicating the union. */
const EVENT_TYPE_RECORD: { [T in EventType]: true } = {
  GAME_CREATED: true,
  TURN_STARTED: true,
  TURN_SKIPPED: true,
  TURN_ENDED: true,
  DICE_ROLLED: true,
  PLAYER_MOVED: true,
  START_BONUS_PAID: true,
  PROPERTY_PURCHASED: true,
  RENT_PAID: true,
  TAX_PAID: true,
  SERVICE_CHARGED: true,
  CARD_DRAWN: true,
  CARD_EFFECT_APPLIED: true,
  TOKEN_CONSUMED: true,
  UPGRADE_BUILT: true,
  UPGRADE_SOLD: true,
  MORTGAGE_TAKEN: true,
  MORTGAGE_LIFTED: true,
  AUCTION_OPENED: true,
  AUCTION_BID: true,
  AUCTION_PASS: true,
  AUCTION_RESOLVED: true,
  AUCTION_CLOSED_UNSOLD: true,
  TRADE_OFFERED: true,
  TRADE_ANSWERED: true,
  TRADE_EXPIRED: true,
  TRADE_CANCELLED: true,
  DEBT_ENTERED: true,
  DEBT_SETTLED: true,
  PLAYER_BANKRUPT: true,
  ASSETS_TRANSFERRED: true,
  PLAYER_ELIMINATED: true,
  VICTORY_DECIDED: true,
  GAME_ENDED: true,
  SNAPSHOT_SAVED: true,
};

export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENT_TYPE_RECORD) as EventType[];

export interface GameEvent<T extends EventType = EventType> {
  readonly eventId: string;
  readonly gameId: string;
  /** id of the command that produced this event — provenance for tracing and duplicate audits; null for GAME_CREATED. */
  readonly commandId: string | null;
  /** Monotonic per game, gapless (spec §2.2). */
  readonly sequence: number;
  readonly rulesVersion: number;
  readonly type: T;
  readonly payload: EventPayloadMap[T];
  readonly meta: EventMeta;
}

/** A handler's draft event before the reducer stamps the envelope fields. */
export interface EventInput<T extends EventType = EventType> {
  readonly type: T;
  readonly payload: EventPayloadMap[T];
  readonly meta?: EventMeta;
}

export type AnyEventInput = { [T in EventType]: EventInput<T> }[EventType];

/** A fully stamped event as the distributed union — `type` and `payload` stay correlated, so narrowing on `type` yields the typed payload. */
export type AnyGameEvent = { [T in EventType]: GameEvent<T> }[EventType];

/**
 * Stamps drafts with the deterministic envelope fields. eventId is composite
 * (game + sequence) — never random, so replay reproduces it exactly.
 */
export function stampEvents(
  gameId: string,
  firstSequence: number,
  drafts: readonly AnyEventInput[],
  rulesVersion: number = RULES_VERSION,
  commandId: string | null = null,
): AnyGameEvent[] {
  return drafts.map((draft, offset): AnyGameEvent => {
    const sequence = firstSequence + offset;
    const envelope = {
      eventId: `${gameId}-e${sequence}`,
      gameId,
      commandId,
      sequence,
      rulesVersion,
      type: draft.type,
      payload: draft.payload,
      meta: draft.meta ?? {},
    };
    // Safe: `type` and `payload` come from the same draft of the correlated
    // AnyEventInput union, so the pair is one of the AnyGameEvent members —
    // TS just cannot carry the correlation through a map over the union.
    return envelope as AnyGameEvent;
  });
}

/**
 * Envelope validation for events read back from storage or a transport —
 * the counterpart of command shape validation. Envelope fields are checked
 * strictly; payloads are engine-produced and only checked to be objects.
 * An event stamped under any rules version other than this build's single
 * rules module is refused outright (spec §3).
 */
export function validateEventEnvelope(event: GameEvent): RuleError | null {
  const raw = event as unknown as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return new RuleError('INVALID_SHAPE', 'event: expected an object', { field: 'envelope' });
  }
  const header =
    requireString(raw.eventId, 'eventId') ??
    requireString(raw.gameId, 'gameId');
  if (header) return header;
  if (raw.commandId !== null && typeof raw.commandId !== 'string') {
    return new RuleError('INVALID_SHAPE', 'event field commandId: expected a string or null', { field: 'commandId', found: raw.commandId });
  }
  if (typeof raw.sequence !== 'number' || !Number.isInteger(raw.sequence) || raw.sequence < 1) {
    return new RuleError('INVALID_SHAPE', 'event field sequence: expected an integer >= 1', { field: 'sequence', found: raw.sequence });
  }
  if (raw.rulesVersion !== RULES_VERSION) {
    return new RuleError('RULES_VERSION_UNSUPPORTED', `event log rules version ${String(raw.rulesVersion)} is not supported by this build (expected ${RULES_VERSION})`, {
      field: 'rulesVersion',
      found: raw.rulesVersion,
      supported: RULES_VERSION,
    });
  }
  if (typeof raw.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(raw.type)) {
    return new RuleError('INVALID_SHAPE', 'event field type: unknown event type', { field: 'type', found: raw.type });
  }
  for (const field of ['payload', 'meta'] as const) {
    const value = raw[field];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return new RuleError('INVALID_SHAPE', `event field ${field}: expected an object`, { field, found: value });
    }
  }
  return null;
}

function requireString(value: unknown, field: string): RuleError | null {
  return typeof value === 'string' && value.length > 0
    ? null
    : new RuleError('INVALID_SHAPE', `event field ${field}: expected a non-empty string`, { field, found: value });
}
