/**
 * Command envelope and per-type payload schema (spec §2.1).
 *
 * All fifteen spec'd game commands are typed here from day one; their
 * handlers arrive with PRs 4–8 and reject with COMMAND_NOT_IMPLEMENTED until
 * then. Two machinery commands (START_GAME, SAVE_SNAPSHOT) are implemented by
 * the PR 2 reducer so the pipeline, idempotency, snapshots, and replay are
 * exercisable end to end before any game rules exist.
 *
 * Payload validation is the pipeline's step 1 and treats input as untrusted:
 * every field is re-checked at runtime, not just at compile time. Shape
 * validates what is observable without rules data: payload objectness,
 * unknown-key rejection, and the types of keys that are present. Required-key
 * PRESENCE is enforced by each command's handler (PRs 4–8) — presence rules
 * depend on game context (board data, open auctions, pending offers). This
 * keeps the skeleton honest: an unimplemented command whose envelope and
 * present-key types are valid rejects COMMAND_NOT_IMPLEMENTED, never
 * INVALID_SHAPE.
 */
import type { PlayerId, SpaceId, TradeOffer, TradeResponse } from './types';
import { RuleError } from './engine/errors';

export interface CommandPayloadMap {
  /** Hot-seat lobby action: open PLAYING on the created game. */
  readonly START_GAME: { readonly initialBalance?: 'initialBalance' | 'startingCash' };
  /** Persist a snapshot of the current state (spec §11 save/resume; machinery command). */
  readonly SAVE_SNAPSHOT: Record<string, never>;
  readonly ROLL: Record<string, never>;
  /** Consume a Hold token and skip the holder's entire current turn (spec §4 row 2). */
  readonly HOLD: Record<string, never>;
  /** Buy the unowned purchasable space the actor is on, at list price (spec §4 row 5). */
  readonly BUY: Record<string, never>;
  /** Decline to buy; the space goes to auction (spec §4 row 6, §5). */
  readonly PASS_TO_AUCTION: Record<string, never>;
  /** Ascending, cash-backed bid (spec §5). Amount rules are validated by auction rules in PR 6. */
  readonly BID: { readonly auctionId: string; readonly amount: number };
  /** Binding, permanent pass for the named auction (spec §5). */
  readonly PASS_BID: { readonly auctionId: string };
  readonly BUILD: { readonly spaceId: SpaceId };
  readonly SELL_UPGRADE: { readonly spaceId: SpaceId };
  readonly MORTGAGE: { readonly spaceId: SpaceId };
  readonly UNMORTGAGE: { readonly spaceId: SpaceId };
  /** Propose an atomic trade to one recipient (spec §6). */
  readonly OFFER_TRADE: { readonly recipientId: PlayerId; readonly offer: TradeOffer };
  /** Recipient-only answer (spec §6). A COUNTER replaces the pending offer; the
   *  COUNTER↔counterOffer pairing is enforced by the trade handler (PR 7). */
  readonly ANSWER_TRADE: {
    readonly tradeId: string;
    readonly response: TradeResponse;
    /** Required when response is COUNTER (spec §6). */
    readonly counterOffer?: TradeOffer;
  };
  /** Voluntary bankruptcy; mandatory when the debt is hopeless (spec §7). */
  readonly SURRENDER: Record<string, never>;
  /** One atomic payment of the due amount (spec §7). */
  readonly SETTLE_DEBT: Record<string, never>;
  /** End the turn: expire offers, run victory checks, advance or repeat the roller (spec §4 row 12). */
  readonly END_TURN: Record<string, never>;
}

export type CommandType = keyof CommandPayloadMap;

export interface GameCommand<T extends CommandType = CommandType> {
  /** Unique per submission; the idempotency key (spec §2.1 step 4). */
  readonly commandId: string;
  readonly gameId: string;
  /** Whose action this claims to be. */
  readonly actorId: PlayerId;
  /** State version the command was composed against (spec §2.1 step 3). */
  readonly expectedVersion: number;
  readonly type: T;
  readonly payload: CommandPayloadMap[T];
}

type PayloadValidator = (payload: Record<string, unknown>, type: CommandType) => RuleError | null;

function shapeError(field: string, expected: string, found: unknown, extra?: Record<string, unknown>): RuleError {
  return new RuleError('INVALID_SHAPE', `command field ${field}: expected ${expected}`, {
    field,
    found,
    ...extra,
  });
}

function requireNonEmptyString(value: unknown, field: string): RuleError | null {
  // Whitespace-only ids are not identifiers; commands come from untrusted clients.
  return typeof value === 'string' && value.trim().length > 0
    ? null
    : shapeError(field, 'a non-empty string', value);
}

function requirePositiveNumber(value: unknown, field: string): RuleError | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? null
    : shapeError(field, 'a positive finite number', value);
}

function requireNonNegativeNumber(value: unknown, field: string): RuleError | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? null
    : shapeError(field, 'a non-negative finite number', value);
}

function validateTradeSide(side: unknown, field: string): RuleError | null {
  if (typeof side !== 'object' || side === null || Array.isArray(side)) return shapeError(field, 'an object', side);
  const record = side as Record<string, unknown>;
  const cashError = requireNonNegativeNumber(record.cash, `${field}.cash`);
  if (cashError) return cashError;
  if (!Array.isArray(record.spaceIds)) return shapeError(`${field}.spaceIds`, 'an array', record.spaceIds);
  for (const id of record.spaceIds) {
    const problem = requireNonEmptyString(id, `${field}.spaceIds[]`);
    if (problem) return problem;
  }
  return null;
}

function validateTradeOffer(offer: unknown, field: string): RuleError | null {
  if (typeof offer !== 'object' || offer === null || Array.isArray(offer)) return shapeError(field, 'an object', offer);
  const record = offer as Record<string, unknown>;
  return validateTradeSide(record.give, `${field}.give`) ?? validateTradeSide(record.receive, `${field}.receive`);
}

const TRADE_RESPONSES: readonly TradeResponse[] = ['ACCEPT', 'REJECT', 'COUNTER'];

function validateTradeResponse(value: unknown, field: string): RuleError | null {
  return typeof value === 'string' && (TRADE_RESPONSES as readonly string[]).includes(value)
    ? null
    : shapeError(field, `one of ${TRADE_RESPONSES.join(', ')}`, value);
}

/**
 * Payload shape rule: reject keys outside the command's declared schema and
 * type-check the keys that are present. Missing declared keys are left to the
 * consuming handler (see the module doc comment on required-key presence).
 */
type FieldCheck = (value: unknown, field: string) => RuleError | null;

function payloadFor(checks: Readonly<Record<string, FieldCheck>>): PayloadValidator {
  return (payload, type) => {
    for (const key of Object.keys(payload)) {
      const check = checks[key];
      if (!check) {
        return shapeError(`${type}.${key}`, 'a recognized payload key', payload[key], { key });
      }
      const problem = check(payload[key], `${type}.${key}`);
      if (problem) return problem;
    }
    return null;
  };
}

const enumCheck =
  (values: readonly string[]): FieldCheck =>
  (value, field) =>
    typeof value === 'string' && values.includes(value)
      ? null
      : shapeError(field, `one of ${values.join(', ')}`, value);

const BALANCE_MODES: readonly string[] = ['initialBalance', 'startingCash'];

/** Exhaustive by construction: TypeScript forces a validator per command type. */
const PAYLOAD_VALIDATORS: { [T in CommandType]: PayloadValidator } = {
  START_GAME: payloadFor({ initialBalance: enumCheck(BALANCE_MODES) }),
  SAVE_SNAPSHOT: payloadFor({}),
  ROLL: payloadFor({}),
  HOLD: payloadFor({}),
  BUY: payloadFor({ spaceId: requireNonEmptyString }),
  PASS_TO_AUCTION: payloadFor({}),
  SURRENDER: payloadFor({}),
  SETTLE_DEBT: payloadFor({}),
  END_TURN: payloadFor({}),
  BID: payloadFor({ auctionId: requireNonEmptyString, amount: requirePositiveNumber }),
  PASS_BID: payloadFor({ auctionId: requireNonEmptyString }),
  BUILD: payloadFor({ spaceId: requireNonEmptyString }),
  SELL_UPGRADE: payloadFor({ spaceId: requireNonEmptyString }),
  MORTGAGE: payloadFor({ spaceId: requireNonEmptyString }),
  UNMORTGAGE: payloadFor({ spaceId: requireNonEmptyString }),
  OFFER_TRADE: payloadFor({ recipientId: requireNonEmptyString, offer: validateTradeOffer }),
  ANSWER_TRADE: payloadFor({
    tradeId: requireNonEmptyString,
    response: validateTradeResponse,
    counterOffer: validateTradeOffer,
  }),
};

export const COMMAND_TYPES: readonly CommandType[] = Object.keys(PAYLOAD_VALIDATORS) as CommandType[];

/**
 * Pipeline step 1: full schema check of the raw envelope. The parameter is
 * typed GameCommand for callers, but the body treats it as unknown — this is
 * the boundary where untrusted input is checked.
 */
export function validateCommandShape(command: GameCommand): RuleError | null {
  const raw = command as unknown as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return shapeError('envelope', 'an object', raw);
  }
  const header =
    requireNonEmptyString(raw.commandId, 'commandId') ??
    requireNonEmptyString(raw.gameId, 'gameId') ??
    requireNonEmptyString(raw.actorId, 'actorId');
  if (header) return header;
  if (typeof raw.expectedVersion !== 'number' || !Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0) {
    return shapeError('expectedVersion', 'a non-negative integer', raw.expectedVersion);
  }
  if (typeof raw.type !== 'string' || !(COMMAND_TYPES as readonly string[]).includes(raw.type)) {
    return shapeError('type', `one of ${COMMAND_TYPES.join(', ')}`, raw.type, { type: raw.type });
  }
  const payload = raw.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return shapeError('payload', 'an object', payload);
  }
  return PAYLOAD_VALIDATORS[raw.type as CommandType](payload as Record<string, unknown>, raw.type as CommandType);
}
