/**
 * The trade lifecycle (spec §6; phase-table rows 10 and 13; Decision D-6).
 *
 * Initiation is the active player's alone, in TURN_MANAGEMENT — or in
 * SETTLING_DEBT, where the debtor (the active player there) may propose and
 * answer trades by consent (spec §7, D-6). Answers belong to the designated
 * recipient only, and are legal in ANY phase while an offer is pending:
 * answering never disturbs the active player's turn, it only moves the
 * offered assets atomically when accepted. A counter reverses the roles and
 * REPLACES the pending offer under a new id.
 *
 * Expiry is wall-clock-free (spec §6): an offer records the turn ordinal
 * whose end kills it, and the shared turn-pass path (advanceToNextTurn —
 * rows 2, 4, and 12) compares that counter against state.turn. A fresh
 * offer is anchored to the proposer's current turn; a counter anchors to
 * the new proposer's NEXT turn (resolved at that TURN_STARTED — its ordinal
 * cannot be known at counter time because skipped seats consume ordinals).
 * A doubles extra cycle is the same turn ordinal, so an offer survives it;
 * the offer dies exactly when the proposer's turn passes to another player.
 *
 * Validation: the offerer must legally hold their give leg (ownership and
 * cash) when the offer is made, and the recipient must legally hold the
 * receive leg's spaces. Acceptance re-validates BOTH sides against current
 * state — a counter can outlive the assets it names — and applies the swap
 * atomically: one command, all-or-nothing, cash ≥ 0 both sides after
 * transfer, no credit (spec §6). Mortgaged spaces and built upgrade levels
 * ride with the space; the transferee pays the 110% unlock later (spec §6,
 * §8).
 *
 * One offer at a time: hot-seat negotiation answers through a single
 * handoff prompt, and a counter replaces the pending offer — so the state
 * carries one slot, like debt and auction.
 *
 * §17.2 seam note: offers involving a player who is eliminated or bankrupt
 * are cancelled (TRADE_CANCELLED) by PR 8's bankruptcy waterfall, which
 * owns PLAYER_ELIMINATED — no path in this module can emit it, nor
 * PLAYER_BANKRUPT or ASSETS_TRANSFERRED (§7's transfers are waterfall
 * events, not trade events).
 */
import type { GameCommand } from '../commands';
import type { AnyEventInput, EventInput } from '../events';
import type { PlayerId, TradeOffer } from '../types';
import { RuleError } from './errors';
import type { GameStateDraft, DraftPlayer } from './draft';
import { requirePlayer } from './draft';

/** The event vocabulary of the trade surface. Deliberately narrow: no
 *  bankruptcy member exists, so no trade path can emit one (§17.2). */
export type TradeEventInput =
  | EventInput<'TRADE_OFFERED'>
  | EventInput<'TRADE_ANSWERED'>
  | EventInput<'TRADE_EXPIRED'>;

/**
 * Deterministic trade id: the sequence the offer's TRADE_OFFERED event
 * receives. Every offer emits exactly one TRADE_OFFERED, so no two offers
 * of a game share an id — and replay reproduces it exactly (spec §3).
 */
export function tradeIdFor(offerSequence: number): string {
  return `trade-${offerSequence}`;
}

/** The phases an offer may be PROPOSED in (rows 10 and 13/D-6). */
function requireOfferingPhase(draft: GameStateDraft): void {
  if (draft.turnPhase !== 'TURN_MANAGEMENT' && draft.turnPhase !== 'SETTLING_DEBT') {
    throw new RuleError('INVALID_PHASE', `OFFER_TRADE is only valid in TURN_MANAGEMENT or SETTLING_DEBT, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
    });
  }
}

/**
 * Legality of one offer's two legs against current state (spec §6): cash is
 * whole dollars, no space is named twice across the swap, and each side
 * legally holds what it gives.
 */
function requireValidOffer(draft: GameStateDraft, offer: TradeOffer, giveOwnerId: PlayerId, receiveOwnerId: PlayerId): void {
  requireWholeDollars(offer.give.cash);
  requireWholeDollars(offer.receive.cash);
  const seen = new Set<string>();
  for (const [side, ownerId] of [
    [offer.give, giveOwnerId],
    [offer.receive, receiveOwnerId],
  ] as const) {
    for (const spaceId of side.spaceIds) {
      if (seen.has(spaceId)) {
        throw new RuleError('RULE_VIOLATION', `space ${spaceId} is named on both sides of the trade — a swap cannot move one asset twice`, { spaceId });
      }
      seen.add(spaceId);
      requireOwnedBy(draft, spaceId, ownerId);
    }
  }
}

function requireWholeDollars(amount: number): void {
  if (!Number.isInteger(amount)) {
    throw new RuleError('RULE_VIOLATION', `trade cash ${amount} is not whole dollars — the ledger moves whole dollars only`, { cash: amount });
  }
}

/** The space a trade leg names, held by `ownerId`. A miss is a rule outcome
 *  — an unknown id, an unowned space, or a wrong owner. Owners only ever
 *  hold purchasable spaces (invariant over every owners write), so the
 *  ownership check covers all three. */
function requireOwnedBy(draft: GameStateDraft, spaceId: string, ownerId: PlayerId): void {
  if (draft.owners[spaceId] !== ownerId) {
    throw new RuleError('RULE_VIOLATION', `space ${spaceId} is not owned by player ${ownerId}`, {
      spaceId,
      expectedOwnerId: ownerId,
      ownerId: draft.owners[spaceId] ?? null,
    });
  }
}

/** The registry correlates type and payload; TS cannot carry that through
 *  the handler union — same documented cast as the reducer's buyHandler.
 *  Shape validation already ran (pipeline step 1); presence is checked here. */
interface OfferPayload {
  readonly recipientId?: PlayerId;
  readonly offer?: TradeOffer;
}

interface AnswerPayload {
  readonly tradeId?: string;
  readonly response?: 'ACCEPT' | 'REJECT' | 'COUNTER';
  readonly counterOffer?: TradeOffer;
}

function offerPayload(command: GameCommand): OfferPayload {
  return command.payload as OfferPayload;
}

function answerPayload(command: GameCommand): AnswerPayload {
  return command.payload as AnswerPayload;
}

/**
 * What a proposal must prove about its counterparty (spec §6): a live
 * player, not the proposer. Elimination cannot occur in this build; the
 * solvency guard below is §6's "both sides must remain solvent", and PR 8's
 * waterfall replaces it with offer cancellation for the eliminated party.
 */
function requireEligibleCounterparty(draft: GameStateDraft, proposerId: PlayerId, recipientId: PlayerId | undefined): void {
  if (!recipientId) {
    throw new RuleError('INVALID_SHAPE', 'OFFER_TRADE requires a recipientId', { field: 'recipientId' });
  }
  if (recipientId === proposerId) {
    throw new RuleError('RULE_VIOLATION', `player ${proposerId} cannot trade with themselves`, { recipientId });
  }
  const recipient = draft.players.find((player) => player.id === recipientId);
  if (!recipient) {
    throw new RuleError('RULE_VIOLATION', `recipient ${recipientId} is not a player in this game`, { recipientId });
  }
  if (recipient.eliminated) {
    throw new RuleError('RULE_VIOLATION', `recipient ${recipientId} is not solvent — trades with a bankrupt player are void`, { recipientId });
  }
}

/** The pending offer an answer acts on, matched by the payload's tradeId —
 *  a stale id (already answered, replaced by a counter, or expired) is a
 *  rule violation, not a shape fault, mirroring requireAuctionRef. */
function requirePendingTrade(draft: GameStateDraft, command: GameCommand): NonNullable<GameStateDraft['trade']> {
  const payload = answerPayload(command);
  const pending = draft.trade;
  if (pending === null) {
    // Unreachable: canAct (pipeline step 5) rejects every ANSWER_TRADE
    // while no offer is pending.
    throw new Error('engine bug: ANSWER_TRADE reached a handler with no pending offer');
  }
  if (payload.tradeId !== pending.tradeId) {
    throw new RuleError('RULE_VIOLATION', `payload tradeId ${String(payload.tradeId)} does not match the pending trade ${pending.tradeId}`, {
      tradeId: payload.tradeId ?? null,
      pendingTradeId: pending.tradeId,
    });
  }
  return pending;
}

/**
 * Anchor a proposal to the proposer's turns (spec §6): the active player's
 * current turn if they are proposing mid-turn, otherwise (a counter) their
 * next turn — stored as null and resolved at that TURN_STARTED.
 */
function anchorFor(draft: GameStateDraft, proposerId: PlayerId): number | null {
  return draft.activePlayerId === proposerId ? draft.turn : null;
}

/**
 * Row 10 (and row 13 in settlement): propose an atomic swap to one
 * recipient (spec §6). Emits TRADE_OFFERED and parks the offer until the
 * recipient answers or the proposer's anchored turn ends.
 */
export function offerTradeHandler(draft: GameStateDraft, command: GameCommand): TradeEventInput[] {
  requireOfferingPhase(draft);
  if (draft.trade !== null) {
    throw new RuleError('RULE_VIOLATION', `trade ${draft.trade.tradeId} is already pending — one offer at a time`, {
      pendingTradeId: draft.trade.tradeId,
    });
  }
  const payload = offerPayload(command);
  requireEligibleCounterparty(draft, command.actorId, payload.recipientId);
  if (!payload.offer) {
    throw new RuleError('INVALID_SHAPE', 'OFFER_TRADE requires an offer', { field: 'offer' });
  }
  const offer = payload.offer;
  const recipientId = payload.recipientId as PlayerId;
  // The proposer must hold their give leg now; the recipient must hold the
  // receive leg now — both are re-proven at acceptance (spec §6).
  requireValidOffer(draft, offer, command.actorId, recipientId);
  const tradeId = tradeIdFor(draft.lastEventSequence + 1);
  draft.trade = {
    tradeId,
    proposerId: command.actorId,
    recipientId,
    offer,
    anchorTurn: anchorFor(draft, command.actorId),
  };
  return [{ type: 'TRADE_OFFERED', payload: { tradeId, proposerId: command.actorId, recipientId, offer } }];
}

/**
 * The accepted swap, applied atomically (spec §6): both sides re-proven
 * against current state, then cash and ownership move in one transition —
 * no credit, cash ≥ 0 both sides after transfer.
 */
function applyAcceptance(draft: GameStateDraft, pending: NonNullable<GameStateDraft['trade']>): void {
  const proposer = requirePlayer(draft, pending.proposerId);
  const recipient = requirePlayer(draft, pending.recipientId);
  if (proposer.eliminated || recipient.eliminated) {
    throw new RuleError('RULE_VIOLATION', 'both sides of a trade must be solvent', {
      proposerId: pending.proposerId,
      recipientId: pending.recipientId,
    });
  }
  const offer = pending.offer;
  // Re-validate both legs at acceptance: a counter can outlive the assets
  // it names (spec §6 validity holds at the moment of transfer).
  requireValidOffer(draft, offer, pending.proposerId, pending.recipientId);
  if (proposer.cash < offer.give.cash) {
    throw new RuleError('INSUFFICIENT_RESOURCES', `the trade needs $${offer.give.cash} from ${proposer.id}, who holds $${proposer.cash} — no credit`, {
      playerId: proposer.id,
      needed: offer.give.cash,
      cash: proposer.cash,
    });
  }
  if (recipient.cash < offer.receive.cash) {
    throw new RuleError('INSUFFICIENT_RESOURCES', `the trade needs $${offer.receive.cash} from ${recipient.id}, who holds $${recipient.cash} — no credit`, {
      playerId: recipient.id,
      needed: offer.receive.cash,
      cash: recipient.cash,
    });
  }
  // Atomic swap: every write below is unconditional from here on.
  proposer.cash += offer.receive.cash - offer.give.cash;
  recipient.cash += offer.give.cash - offer.receive.cash;
  const owners = { ...draft.owners };
  for (const spaceId of offer.give.spaceIds) owners[spaceId] = recipient.id;
  for (const spaceId of offer.receive.spaceIds) owners[spaceId] = proposer.id;
  draft.owners = owners;
  draft.trade = null;
}

/**
 * Row 10 (any phase while pending) and row 13 (settlement answers): the
 * designated recipient answers — ACCEPT moves the assets atomically,
 * REJECT drops the offer, COUNTER reverses the roles and replaces the
 * pending offer under a new id (spec §6).
 */
export function answerTradeHandler(draft: GameStateDraft, command: GameCommand): TradeEventInput[] {
  // No phase check by design: an answer is legal in any phase while the
  // offer is pending (spec §4 row 10) — including during another player's
  // turn, whose flow an answer must not disturb.
  const payload = answerPayload(command);
  const pending = requirePendingTrade(draft, command);
  const response = payload.response;
  if (!response) {
    throw new RuleError('INVALID_SHAPE', 'ANSWER_TRADE requires a response', { field: 'response' });
  }
  if (response === 'REJECT') {
    draft.trade = null;
    return [{ type: 'TRADE_ANSWERED', payload: { tradeId: pending.tradeId, responderId: command.actorId, response } }];
  }
  if (response === 'ACCEPT') {
    applyAcceptance(draft, pending);
    return [{ type: 'TRADE_ANSWERED', payload: { tradeId: pending.tradeId, responderId: command.actorId, response } }];
  }
  // COUNTER: the responder becomes the proposer of a replacement offer.
  if (!payload.counterOffer) {
    throw new RuleError('INVALID_SHAPE', 'a COUNTER answer requires a counterOffer', { field: 'counterOffer' });
  }
  const counterOffer = payload.counterOffer;
  requireEligibleCounterparty(draft, command.actorId, pending.proposerId);
  requireValidOffer(draft, counterOffer, command.actorId, pending.proposerId);
  // The counter's TRADE_OFFERED is this command's second event, after
  // TRADE_ANSWERED — the id derives from the sequence that event receives.
  const counterTradeId = tradeIdFor(draft.lastEventSequence + 2);
  draft.trade = {
    tradeId: counterTradeId,
    proposerId: command.actorId,
    recipientId: pending.proposerId,
    offer: counterOffer,
    anchorTurn: anchorFor(draft, command.actorId),
  };
  return [
    { type: 'TRADE_ANSWERED', payload: { tradeId: pending.tradeId, responderId: command.actorId, response, counterTradeId } },
    { type: 'TRADE_OFFERED', payload: { tradeId: counterTradeId, proposerId: command.actorId, recipientId: pending.proposerId, offer: counterOffer } },
  ];
}

/**
 * Expiry at the turn pass (spec §6) — called by the reducer's
 * advanceToNextTurn, the one path every turn-passing row (2, 4, 12) shares.
 * The offer dies when the turn ordinal it is anchored to is the one now
 * ending: a pure turn-counter comparison, no wall clock. A doubles extra
 * cycle never reaches this path (same ordinal, no pass), so an offer
 * survives it.
 */
export function expireAnchoredOffer(draft: GameStateDraft, events: AnyEventInput[]): void {
  const pending = draft.trade;
  if (pending !== null && pending.anchorTurn === draft.turn) {
    draft.trade = null;
    events.push({ type: 'TRADE_EXPIRED', payload: { tradeId: pending.tradeId } });
  }
}

/**
 * Anchor resolution at TURN_STARTED (spec §6): a counter waits for its
 * proposer's next turn; when that turn begins, the offer re-anchors to its
 * ordinal so it dies at that turn's end. Called by advanceToNextTurn.
 */
export function resolveAnchorAtTurnStart(draft: GameStateDraft, playerId: PlayerId, turn: number): void {
  const pending = draft.trade;
  if (pending !== null && pending.proposerId === playerId && pending.anchorTurn === null) {
    draft.trade = { ...pending, anchorTurn: turn };
  }
}
