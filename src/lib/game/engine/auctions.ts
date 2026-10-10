/**
 * Cash-backed ascending-bid auctions (spec §5; phase-table rows 6–8).
 *
 * An auction opens when the active player declines to buy an unowned
 * purchasable space (reason DECLINED; bank-creditor estate sales arrive with
 * PR 8's ELIMINATION_AUCTIONS under the same rules). Bidding is free-form
 * ascending — any eligible player may bid at any time while the auction is
 * open, in $10 steps, and every bid is backed by the bidder's cash. Because
 * no other command can move money while an auction is open, the winning bid
 * is always payable: there is no winner-debt scenario (spec §5). Passing is
 * binding and permanent; the current high bidder cannot pass, so a standing
 * bid always belongs to a player still in the auction.
 *
 * Resolution is a pure consequence of the command log: after every BID or
 * PASS_BID, the engine counts the players who have not passed. None remain —
 * the auction closes unsold and the space stays with the bank; exactly one
 * unpassed bidder remains — they win at their own standing bid and pay the
 * bank inside the same command (AUCTION_RESOLVED + PROPERTY_PURCHASED with
 * via 'AUCTION'); one unpassed player with no standing bid — the auction
 * stays open, because the engine never awards a price nobody bid: they open
 * the only bid (cash-backed, from the opening minimum) or pass, closing it
 * unsold. The decliner's turn then resumes at TURN_MANAGEMENT — the auction
 * runs inside the decliner's turn and touches nothing else.
 *
 * Determinism (spec §3, §5): no wall clock, no randomness — the command
 * order in the log IS the bid order, so replay reproduces the outcome
 * bit-for-bit.
 *
 * §17.2 structural guarantee: the event vocabulary below has no bankruptcy
 * member, so no auction path in this build can emit PLAYER_BANKRUPT,
 * ASSETS_TRANSFERRED, or PLAYER_ELIMINATED.
 */
import { BOARD_SPACES, isPurchasable, type PurchasableSpace } from '../board-v1';
import type { GameCommand } from '../commands';
import type { EventInput } from '../events';
import { AUCTION_MINIMUM_INCREMENT, AUCTION_OPENING_BID, isLegalBidAmount } from '../rules-v1';
import type { AuctionState, PlayerId } from '../types';
import { RuleError } from './errors';
import type { GameStateDraft } from './draft';
import { requirePlayer } from './draft';

/** The event vocabulary of the auction surface. PROPERTY_PURCHASED belongs
 *  here because settlement IS a purchase — always with via 'AUCTION'; the
 *  §17.2 negative tests pin the bankruptcy ban at type level. */
export type AuctionEventInput =
  | EventInput<'AUCTION_OPENED'>
  | EventInput<'AUCTION_BID'>
  | EventInput<'AUCTION_PASS'>
  | EventInput<'AUCTION_RESOLVED'>
  | EventInput<'AUCTION_CLOSED_UNSOLD'>
  | EventInput<'PROPERTY_PURCHASED'>;

/**
 * Deterministic auction id: the sequence the AUCTION_OPENED event receives.
 * Every opening emits at least one event, so no two auctions of a game share
 * a sequence — and replay reproduces the id exactly (spec §3).
 */
export function auctionIdFor(openingSequence: number): string {
  return `auction-${openingSequence}`;
}

/**
 * The landed space a BUY or a decline acts on: purchasable and unowned. Both
 * row-5 and row-6 commands share this precondition — one source of truth for
 * "the space an auction would sell". A miss is a rule outcome (the actor
 * named no space; the token's resting space decides).
 */
export function requireAuctionableLandedSpace(draft: GameStateDraft, playerId: PlayerId): PurchasableSpace {
  const player = requirePlayer(draft, playerId);
  const space = BOARD_SPACES[player.position];
  if (!isPurchasable(space)) {
    throw new RuleError('RULE_VIOLATION', `space ${space.id} is not purchasable`, { spaceId: space.id, kind: space.kind });
  }
  if (space.id in draft.owners) {
    throw new RuleError('RULE_VIOLATION', `space ${space.id} is already owned`, { spaceId: space.id, ownerId: draft.owners[space.id] });
  }
  return space;
}

/** The open auction on the draft after the phase check has proven one exists. */
function requireOpenAuction(draft: GameStateDraft): AuctionState {
  if (draft.turnPhase !== 'AUCTION' || draft.auction === null) {
    throw new RuleError('INVALID_PHASE', `this command is only valid in AUCTION, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
    });
  }
  return draft.auction;
}

/** The registry correlates type and payload; TS cannot carry that through
 *  the handler union — same documented cast as the reducer's buyHandler.
 *  Shape validation already ran (pipeline step 1); presence is checked here. */
interface BidPayload {
  readonly auctionId?: string;
  readonly amount?: number;
}

function payloadOf(command: GameCommand): BidPayload {
  return command.payload as BidPayload;
}

/** The payload must name the open auction — a stale id (an auction that
 *  already closed, or a rival one) is a rule violation, not a shape fault. */
function requireAuctionRef(draft: GameStateDraft, command: GameCommand): AuctionState {
  const auction = requireOpenAuction(draft);
  const payload = payloadOf(command);
  if (payload.auctionId !== auction.auctionId) {
    throw new RuleError('RULE_VIOLATION', `payload auctionId ${String(payload.auctionId)} does not match the open auction ${auction.auctionId}`, {
      auctionId: payload.auctionId ?? null,
      openAuctionId: auction.auctionId,
    });
  }
  return auction;
}

/** Players still in the auction: eligible, never passed (spec §5). */
function unpassedPlayers(auction: AuctionState): readonly PlayerId[] {
  return auction.eligiblePlayerIds.filter((id) => !auction.passedPlayerIds.includes(id));
}

/**
 * §5 settlement: the last unpassed bidder wins at their own standing bid and
 * pays the bank immediately, inside the resolving command — award, payment,
 * and ownership land atomically. The caller has proven the standing bid
 * exists and belongs to the winner; the guards below turn a violation of
 * that proof into an engine bug, never a silent award.
 */
function resolveAuction(draft: GameStateDraft, auction: AuctionState, winnerId: PlayerId, events: AuctionEventInput[]): void {
  const bid = auction.currentBid;
  if (bid === null || auction.highBidderId !== winnerId) {
    throw new Error('engine bug: auction resolution without a standing bid held by the winner');
  }
  const winner = requirePlayer(draft, winnerId);
  if (winner.cash < bid) {
    // Unreachable while bids are cash-backed: no command can move cash while
    // an auction is open (spec §5). This guard is the settlement assertion.
    throw new Error(`engine bug: winning bid $${bid} exceeded the winner's cash $${winner.cash} at settlement`);
  }
  winner.cash -= bid;
  draft.owners = { ...draft.owners, [auction.spaceId]: winnerId };
  draft.auction = null;
  draft.turnPhase = 'TURN_MANAGEMENT';
  events.push({ type: 'AUCTION_RESOLVED', payload: { auctionId: auction.auctionId, winnerId, spaceId: auction.spaceId, amount: bid } });
  events.push({ type: 'PROPERTY_PURCHASED', payload: { playerId: winnerId, spaceId: auction.spaceId, amount: bid, via: 'AUCTION' } });
}

/** All passed, no sale: the space stays with the bank, unowned (spec §5). */
function closeUnsold(draft: GameStateDraft, auction: AuctionState, events: AuctionEventInput[]): void {
  draft.auction = null;
  draft.turnPhase = 'TURN_MANAGEMENT';
  events.push({ type: 'AUCTION_CLOSED_UNSOLD', payload: { auctionId: auction.auctionId, spaceId: auction.spaceId } });
}

/**
 * Row 6: decline to buy — the space opens to the players at auction (spec
 * §5). Emits AUCTION_OPENED and parks the turn in AUCTION, still the
 * decliner's turn; resolution returns it to their TURN_MANAGEMENT. Replaces
 * the PR 4 transitional decline (§17.2 replacement-seam pattern).
 */
export function passToAuctionHandler(draft: GameStateDraft, command: GameCommand): AuctionEventInput[] {
  if (draft.turnPhase !== 'BUY_DECISION') {
    throw new RuleError('INVALID_PHASE', `PASS_TO_AUCTION is only valid in BUY_DECISION, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
    });
  }
  const space = requireAuctionableLandedSpace(draft, command.actorId);
  const auction: AuctionState = {
    auctionId: auctionIdFor(draft.lastEventSequence + 1),
    spaceId: space.id,
    reason: 'DECLINED',
    currentBid: null,
    highBidderId: null,
    passedPlayerIds: [],
    // Eligibility frozen at open: every live player, the decliner included (D-2).
    eligiblePlayerIds: draft.players.filter((player) => !player.eliminated).map((player) => player.id),
  };
  draft.auction = auction;
  draft.turnPhase = 'AUCTION';
  return [{ type: 'AUCTION_OPENED', payload: { auctionId: auction.auctionId, spaceId: space.id, reason: 'DECLINED' } }];
}

/**
 * Row 7: one ascending, cash-backed bid (spec §5). Any eligible player may
 * bid — the decliner included (Decision D-2), the current high bidder
 * included (raising your own bid merely raises the price). The amount must
 * be a $10 step at least one increment above the standing bid, and never
 * above the bidder's cash. When the bid leaves the bidder as the only
 * player who has not passed, the auction settles immediately in this same
 * command.
 */
export function bidHandler(draft: GameStateDraft, command: GameCommand): AuctionEventInput[] {
  const auction = requireAuctionRef(draft, command);
  if (auction.passedPlayerIds.includes(command.actorId)) {
    throw new RuleError('NOT_AUTHORIZED', `player ${command.actorId} passed this auction and may not bid again — passes are binding`, {
      actorId: command.actorId,
      auctionId: auction.auctionId,
    });
  }
  const amount = payloadOf(command).amount;
  if (!isLegalBidAmount(amount ?? NaN, auction.currentBid)) {
    throw new RuleError(
      'RULE_VIOLATION',
      `bid ${String(amount)} is not legal: bids are $10 steps, strictly ascending from the standing bid ${String(auction.currentBid)} (opening minimum $${AUCTION_OPENING_BID})`,
      { bid: amount ?? null, currentBid: auction.currentBid, openingBid: AUCTION_OPENING_BID, increment: AUCTION_MINIMUM_INCREMENT },
    );
  }
  const bidder = requirePlayer(draft, command.actorId);
  if (bidder.cash < (amount ?? 0)) {
    throw new RuleError(
      'INSUFFICIENT_RESOURCES',
      `bid of $${amount} exceeds player ${bidder.id}'s cash of $${bidder.cash} — bids are strictly cash-backed`,
      { bid: amount, cash: bidder.cash },
    );
  }
  const bid = amount as number;
  const events: AuctionEventInput[] = [{ type: 'AUCTION_BID', payload: { auctionId: auction.auctionId, bidderId: bidder.id, amount: bid } }];
  const next: AuctionState = { ...auction, currentBid: bid, highBidderId: bidder.id };
  draft.auction = next;
  // A bid never changes who has passed; if the bidder is now the only player
  // in the auction, they win at their own bid, paid in this command (row 7).
  const remaining = unpassedPlayers(next);
  if (remaining.length === 1) resolveAuction(draft, next, remaining[0], events);
  return events;
}

/**
 * Row 8: a binding, permanent pass (spec §5). The current high bidder cannot
 * pass — "the last unpassed bidder wins at their own bid" needs its subject;
 * a standing bid held by a passed player would be unpayable-by-rule. When
 * the pass leaves exactly one unpassed bidder, they win at their standing
 * bid; when it leaves none, the auction closes unsold.
 */
export function passBidHandler(draft: GameStateDraft, command: GameCommand): AuctionEventInput[] {
  const auction = requireAuctionRef(draft, command);
  if (auction.passedPlayerIds.includes(command.actorId)) {
    throw new RuleError('NOT_AUTHORIZED', `player ${command.actorId} already passed this auction — passes are binding`, {
      actorId: command.actorId,
      auctionId: auction.auctionId,
    });
  }
  if (auction.highBidderId === command.actorId) {
    throw new RuleError(
      'RULE_VIOLATION',
      `player ${command.actorId} holds the standing bid of $${auction.currentBid} and cannot pass — wait to be outbid`,
      { actorId: command.actorId, auctionId: auction.auctionId, currentBid: auction.currentBid },
    );
  }
  const events: AuctionEventInput[] = [{ type: 'AUCTION_PASS', payload: { auctionId: auction.auctionId, bidderId: command.actorId } }];
  const next: AuctionState = { ...auction, passedPlayerIds: [...auction.passedPlayerIds, command.actorId] };
  draft.auction = next;
  const remaining = unpassedPlayers(next);
  if (remaining.length === 0) {
    closeUnsold(draft, next, events);
  } else if (remaining.length === 1 && next.currentBid !== null) {
    // The sole unpassed player is the high bidder (a standing bid's holder is
    // always unpassed, and every other player has now passed).
    resolveAuction(draft, next, remaining[0], events);
  }
  // One unpassed player with no standing bid: the auction stays open — they
  // open the only bid (cash-backed, from the opening minimum) or pass. The
  // engine never awards a price nobody bid (spec §5).
  return events;
}
