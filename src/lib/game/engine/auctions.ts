/**
 * Cash-backed ascending-bid auctions (spec §5; phase-table rows 6–8, 16).
 *
 * An auction opens under either reason: DECLINED — the active player passed
 * on buying an unowned purchasable space — or BANK_ESTATE, one step of a
 * bankrupt player's sequential estate sale (spec §7 step 5, driven by
 * ./endgame under the ELIMINATION_AUCTIONS phase). The rules are identical:
 * bidding is free-form ascending — any eligible player may bid at any time
 * while the auction is open, in $10 steps, and every bid is backed by the
 * bidder's cash. Because no other command can move money while an auction
 * is open, the winning bid is always payable: there is no winner-debt
 * scenario (spec §5). Passing is binding and permanent; the current high
 * bidder cannot pass, so a standing bid always belongs to a player still in
 * the auction.
 *
 * Resolution is a pure consequence of the command log: after every BID or
 * PASS_BID, the engine counts the players who have not passed. None remain —
 * the auction closes unsold and the space stays with the bank; exactly one
 * unpassed bidder remains — they win at their own standing bid and pay the
 * bank inside the same command (AUCTION_RESOLVED + PROPERTY_PURCHASED with
 * via 'AUCTION'); one unpassed player with no standing bid — the auction
 * stays open, because the engine never awards a price nobody bid: they open
 * the only bid (cash-backed, from the opening minimum) or pass, closing it
 * unsold. The caller sequences what follows: the decliner's turn resumes at
 * TURN_MANAGEMENT, or the estate sale opens its next space.
 *
 * Determinism (spec §3, §5): no wall clock, no randomness — the command
 * order in the log IS the bid order, so replay reproduces the outcome
 * bit-for-bit. Estate-sale ordering derives from board order (spec §7), so
 * full games with bankruptcies replay identically too.
 *
 * §17.2 structural guarantee: the event vocabulary below has no bankruptcy
 * member — no auction path here emits PLAYER_BANKRUPT, ASSETS_TRANSFERRED,
 * or PLAYER_ELIMINATED; the waterfall in ./endgame owns those.
 */
import { BOARD_SPACES, isPurchasable, type PurchasableSpace } from '../board-v1';
import type { GameCommand } from '../commands';
import type { AnyEventInput, EventInput } from '../events';
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

/**
 * The open auction a BID or PASS_BID names: the expected turn phase must
 * match (AUCTION for a declined buy, ELIMINATION_AUCTIONS for a bank-creditor
 * estate sale), an auction must be open, and the payload must name it — a
 * stale id (an auction that already closed, or a rival one) is a rule
 * violation, not a shape fault. Shared by both auction surfaces.
 */
export function requireOpenAuctionRef(
  draft: GameStateDraft,
  command: GameCommand,
  expectedPhase: 'AUCTION' | 'ELIMINATION_AUCTIONS',
): AuctionState {
  if (draft.turnPhase !== expectedPhase || draft.auction === null) {
    throw new RuleError('INVALID_PHASE', `this command is only valid in ${expectedPhase}, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
      expectedPhase,
    });
  }
  const payload = payloadOf(command);
  if (payload.auctionId !== draft.auction.auctionId) {
    throw new RuleError('RULE_VIOLATION', `payload auctionId ${String(payload.auctionId)} does not match the open auction ${draft.auction.auctionId}`, {
      auctionId: payload.auctionId ?? null,
      openAuctionId: draft.auction.auctionId,
    });
  }
  return draft.auction;
}

/** Players still in the auction: eligible, never passed (spec §5). */
export function unpassedPlayers(auction: AuctionState): readonly PlayerId[] {
  return auction.eligiblePlayerIds.filter((id) => !auction.passedPlayerIds.includes(id));
}

/**
 * §5 settlement: the last unpassed bidder wins at their own standing bid and
 * pays the bank immediately, inside the resolving command — award, payment,
 * and ownership land atomically. The caller has proven the standing bid
 * exists and belongs to the winner; the guards below turn a violation of
 * that proof into an engine bug, never a silent award. No phase write — the
 * caller sequences the next phase (TURN_MANAGEMENT for a declined buy, the
 * estate sale's next space in ./endgame).
 */
export function resolveAuctionToWinner(
  draft: GameStateDraft,
  auction: AuctionState,
  winnerId: PlayerId,
  events: AnyEventInput[],
): void {
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
  events.push({ type: 'AUCTION_RESOLVED', payload: { auctionId: auction.auctionId, winnerId, spaceId: auction.spaceId, amount: bid } });
  events.push({ type: 'PROPERTY_PURCHASED', payload: { playerId: winnerId, spaceId: auction.spaceId, amount: bid, via: 'AUCTION' } });
}

/** All passed, no sale: the space stays with the bank, unowned (spec §5).
 *  No phase write — the caller sequences the next phase. */
export function closeAuctionUnsold(draft: GameStateDraft, auction: AuctionState, events: AnyEventInput[]): void {
  draft.auction = null;
  events.push({ type: 'AUCTION_CLOSED_UNSOLD', payload: { auctionId: auction.auctionId, spaceId: auction.spaceId } });
}

/**
 * Row 6: decline to buy — the space opens to the players at auction (spec
 * §5). Emits AUCTION_OPENED and parks the turn in AUCTION, still the
 * decliner's turn; resolution returns it to their TURN_MANAGEMENT.
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
 * Row 7 shared body — validate and apply one ascending, cash-backed bid
 * (spec §5): any eligible player may bid — the decliner included (Decision
 * D-2), the current high bidder included (raising your own bid merely
 * raises the price); the amount must be a $10 step at least one increment
 * above the standing bid, and never above the bidder's cash. Pushes
 * AUCTION_BID and returns the advanced auction state; the caller resolves
 * endings against the unpassed count.
 */
export function applyAuctionBid(
  draft: GameStateDraft,
  auction: AuctionState,
  command: GameCommand,
  events: AnyEventInput[],
): AuctionState {
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
  events.push({ type: 'AUCTION_BID', payload: { auctionId: auction.auctionId, bidderId: bidder.id, amount: bid } });
  const next: AuctionState = { ...auction, currentBid: bid, highBidderId: bidder.id };
  draft.auction = next;
  return next;
}

/**
 * Row 7 (declined-buy auction): bid, then settle immediately when the bid
 * leaves the bidder as the only player who has not passed — the winner pays
 * in this same command and the decliner's turn resumes (spec §5).
 */
export function bidHandler(draft: GameStateDraft, command: GameCommand): AuctionEventInput[] {
  const auction = requireOpenAuctionRef(draft, command, 'AUCTION');
  const events: AuctionEventInput[] = [];
  const next = applyAuctionBid(draft, auction, command, events);
  // A bid never changes who has passed; if the bidder is now the only player
  // in the auction, they win at their own bid, paid in this command (row 7).
  const remaining = unpassedPlayers(next);
  if (remaining.length === 1) {
    resolveAuctionToWinner(draft, next, remaining[0], events);
    draft.turnPhase = 'TURN_MANAGEMENT';
  }
  return events;
}

/**
 * Row 8 shared body — validate and apply one binding, permanent pass (spec
 * §5): the current high bidder cannot pass ("the last unpassed bidder wins
 * at their own bid" needs its subject; a standing bid held by a passed
 * player would be unpayable-by-rule). Pushes AUCTION_PASS and returns the
 * advanced auction state; the caller resolves endings.
 */
export function applyAuctionPass(
  draft: GameStateDraft,
  auction: AuctionState,
  command: GameCommand,
  events: AnyEventInput[],
): AuctionState {
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
  events.push({ type: 'AUCTION_PASS', payload: { auctionId: auction.auctionId, bidderId: command.actorId } });
  const next: AuctionState = { ...auction, passedPlayerIds: [...auction.passedPlayerIds, command.actorId] };
  draft.auction = next;
  return next;
}

/**
 * Row 8 (declined-buy auction): pass; when it leaves zero unpassed players
 * the sale closes unsold, when it leaves the high bidder alone they win at
 * their standing bid; either way the decliner's turn resumes at
 * TURN_MANAGEMENT. One unpassed player with no standing bid leaves the
 * auction open — they open the only bid or pass (spec §5).
 */
export function passBidHandler(draft: GameStateDraft, command: GameCommand): AuctionEventInput[] {
  const auction = requireOpenAuctionRef(draft, command, 'AUCTION');
  const events: AuctionEventInput[] = [];
  const next = applyAuctionPass(draft, auction, command, events);
  const remaining = unpassedPlayers(next);
  if (remaining.length === 0) {
    closeAuctionUnsold(draft, next, events);
    draft.turnPhase = 'TURN_MANAGEMENT';
  } else if (remaining.length === 1 && next.currentBid !== null) {
    // The sole unpassed player is the high bidder (a standing bid's holder is
    // always unpassed, and every other player has now passed).
    resolveAuctionToWinner(draft, next, remaining[0], events);
    draft.turnPhase = 'TURN_MANAGEMENT';
  }
  return events;
}
