/**
 * The endgame (spec §4 rows 11/15/16–17, §5, §7, §8; §17 amendment 2).
 *
 * Three responsibilities live here, all pure state machines:
 *
 * 1. Victory evaluation (§8) — driven exclusively by the canonical netWorth
 *    (rules-v1), never ad-hoc asset sums: LAST_SOLVENT at every elimination,
 *    NET_WORTH_TARGET at every TURN_ENDED and elimination, ROUND_CAP when a
 *    handover would start a round beyond the mode's cap (ties share).
 *
 * 2. The bankruptcy waterfall (§7) — SURRENDER's engine, replacing PR 5's
 *    transitional DEBT_UNRESOLVABLE seam: cash in full to the creditor,
 *    50% upgrade salvage, property transfer with mortgages intact (or the
 *    bank-creditor estate sale), pending-trade cancellation, elimination —
 *    then victory evaluation and, if the game continues, the turn tail.
 *
 * 3. Sequential estate auctions (§7 step 5) — ELIMINATION_AUCTIONS drives
 *    ./auctions' shared cores one space at a time, in board order; unsold
 *    spaces are simply unowned — returned to the bank (§5).
 *
 * Turn handover (advanceToNextTurn) lives here too: the waterfall ends the
 * bankrupt turn, elimination auctions complete inside the debtor's turn
 * (§4 row 16), and the shared tail — target check, offer expiry,
 * eliminated-skip, round tracking — is one function every ending path
 * reuses. Turn-ordinal semantics are copied from the reducer unchanged:
 * ordinals increment per new turn INCLUDING skipped seats, never across a
 * doubles extra cycle; rounds increment when the handover wraps the seats.
 *
 * Determinism (§3): no wall clock, no randomness. Elimination-auction
 * ordering derives from board order held in state, so replay reproduces
 * every outcome bit-for-bit.
 */
import { BOARD_SPACES, isPurchasable, MODES, type PurchasableSpace } from '../board-v1';
import type { GameCommand } from '../commands';
import type { AnyEventInput, EventInput } from '../events';
import { netWorthFromState, upgradeCost, upgradeSellBackProceeds } from '../rules-v1';
import type { AuctionState, CreditorId, GameState, PlayerId, SpaceId } from '../types';
import { BANK_ID } from '../types';
import {
  applyAuctionBid,
  applyAuctionPass,
  auctionIdFor,
  closeAuctionUnsold,
  requireOpenAuctionRef,
  resolveAuctionToWinner,
  unpassedPlayers,
} from './auctions';
import { RuleError } from './errors';
import type { DraftPlayer, GameStateDraft } from './draft';
import { requirePlayer } from './draft';
import { cancelTradeInvolving, expireAnchoredOffer, resolveAnchorAtTurnStart } from './trading';

/** The endgame's event vocabulary: victory, bankruptcy, and every event the
 *  waterfall and estate sales emit. This is the surface §17.2 deliberately
 *  reserved for PR 8 — the settlement and auction unions stay bankruptcy-free.
 *  (Handlers below accumulate `AnyEventInput[]` like the rest of the engine;
 *  this union documents and type-tests the surface's vocabulary.) */
export type EndgameEventInput =
  | EventInput<'TURN_STARTED'>
  | EventInput<'TURN_SKIPPED'>
  | EventInput<'TURN_ENDED'>
  | EventInput<'PLAYER_BANKRUPT'>
  | EventInput<'ASSETS_TRANSFERRED'>
  | EventInput<'PLAYER_ELIMINATED'>
  | EventInput<'TRADE_EXPIRED'>
  | EventInput<'TRADE_CANCELLED'>
  | EventInput<'AUCTION_OPENED'>
  | EventInput<'AUCTION_BID'>
  | EventInput<'AUCTION_PASS'>
  | EventInput<'AUCTION_RESOLVED'>
  | EventInput<'AUCTION_CLOSED_UNSOLD'>
  | EventInput<'PROPERTY_PURCHASED'>
  | EventInput<'VICTORY_DECIDED'>
  | EventInput<'GAME_ENDED'>;

/** The canonical net worth (§8) of one player — the ONLY winner math. */
export function netWorthOfPlayer(state: GameState, player: { readonly id: PlayerId }): number {
  return netWorthFromState(state, player.id);
}

/** The players still in the game — never eliminated (§7). */
function livePlayers(state: GameState): readonly { readonly id: PlayerId }[] {
  return state.players.filter((player) => !player.eliminated);
}

/** Every live player tied for the highest canonical net worth (§8 ties share). */
function richestPlayerIds(state: GameState): readonly PlayerId[] {
  const live = livePlayers(state);
  const best = Math.max(...live.map((player) => netWorthOfPlayer(state, player)));
  return live.filter((player) => netWorthOfPlayer(state, player) === best).map((player) => player.id);
}

/** End the game: VICTORY_DECIDED + GAME_ENDED, every open surface closed. */
function endGameWith(
  draft: GameStateDraft,
  winnerIds: readonly PlayerId[],
  reason: 'LAST_SOLVENT' | 'NET_WORTH_TARGET' | 'ROUND_CAP',
  events: AnyEventInput[],
): void {
  draft.phase = 'GAME_OVER';
  draft.turnPhase = null;
  draft.activePlayerId = null;
  draft.debt = null;
  draft.auction = null;
  draft.trade = null;
  draft.estateSale = null;
  events.push({ type: 'VICTORY_DECIDED', payload: { winnerIds, reason } });
  events.push({ type: 'GAME_ENDED', payload: { winnerIds, reason } });
}

/**
 * §8 condition (b): a live player has reached the mode's net-worth target —
 * evaluated at every TURN_ENDED and after every elimination. Returns true
 * when it ended the game; ties at the top share the victory.
 */
export function evaluateNetWorthTarget(draft: GameStateDraft, events: AnyEventInput[]): boolean {
  const live = livePlayers(draft);
  const best = Math.max(...live.map((player) => netWorthOfPlayer(draft, player)));
  if (best < MODES[draft.mode].netWorthTarget) return false;
  const winners = live.filter((player) => netWorthOfPlayer(draft, player) === best).map((player) => player.id);
  endGameWith(draft, winners, 'NET_WORTH_TARGET', events);
  return true;
}

/**
 * §8 condition (a): exactly one solvent player remains — evaluated after
 * every elimination.
 */
function evaluateLastSolvent(draft: GameStateDraft, events: AnyEventInput[]): boolean {
  const live = livePlayers(draft);
  if (live.length !== 1) return false;
  endGameWith(draft, [live[0].id], 'LAST_SOLVENT', events);
  return true;
}

/**
 * The shared tail of every turn-ending path (§4 rows 2/4/11/12/15/16):
 * the net-worth victory check, then the handover walk. The bankrupt turn's
 * tail runs through here too (§4: a bankruptcy ends the turn without a
 * management phase). The check precedes the walk because §4 row 12 evaluates
 * victory before deciding who — if anyone — rolls next.
 */
export function concludeTurn(draft: GameStateDraft, endingPlayerId: PlayerId, events: AnyEventInput[]): void {
  if (evaluateNetWorthTarget(draft, events)) return;
  advanceToNextTurn(draft, endingPlayerId, events);
}

/**
 * The turn handover walk (moved from the reducer by PR 8): passes the turn
 * to the next LIVE player in seat order, consuming any skipNextTurn marks
 * along the way (THIRD_DOUBLES rows), expiring the anchored offer at the
 * turn pass (§6), tracking rounds, and — §8 condition (c) — ending the game
 * when the handover would start a round beyond the mode's cap (the richest
 * live player wins; ties share).
 */
function advanceToNextTurn(draft: GameStateDraft, fromPlayerId: PlayerId, events: AnyEventInput[]): void {
  draft.doublesCount = 0;
  const from = requirePlayer(draft, fromPlayerId);
  const count = draft.players.length;
  expireAnchoredOffer(draft, events);
  let turnCounter = draft.turn;
  let chosen: DraftPlayer | undefined;
  let chosenStep = 0;
  for (let step = 1; step <= 2 * count && !chosen; step++) {
    const candidate = draft.players[(from.seat + step) % count];
    // §7: an eliminated player is out of turn order — no ordinal, no skip
    // event, no TURN_STARTED; the walk simply does not see them.
    if (candidate.eliminated) continue;
    turnCounter += 1;
    if (!candidate.skipNextTurn) {
      chosen = candidate;
      chosenStep = step;
    } else {
      candidate.skipNextTurn = false;
      events.push({ type: 'TURN_SKIPPED', payload: { playerId: candidate.id, reason: 'THIRD_DOUBLES' } });
      events.push({ type: 'TURN_ENDED', payload: { playerId: candidate.id, turn: turnCounter } });
    }
  }
  if (!chosen) throw new Error('engine bug: turn handover found no eligible player');
  // §8 condition (c): a handover that wraps the seats starts a new round;
  // one beyond the cap ends the game before any TURN_STARTED is emitted.
  const nextRound = from.seat + chosenStep >= count ? draft.round + 1 : draft.round;
  if (nextRound > MODES[draft.mode].roundCap) {
    endGameWith(draft, richestPlayerIds(draft), 'ROUND_CAP', events);
    return;
  }
  draft.round = nextRound;
  draft.turn = turnCounter;
  draft.activePlayerId = chosen.id;
  draft.turnPhase = 'AWAITING_ROLL';
  resolveAnchorAtTurnStart(draft, chosen.id, turnCounter);
  events.push({ type: 'TURN_STARTED', payload: { playerId: chosen.id, turn: turnCounter } });
}

/**
 * §7 steps 2–4: liquid in full to the creditor; built levels sell back at
 * 50% of the price paid (proceeds to a player-creditor; buildings vanish
 * unpaid when the creditor is the bank); properties transfer with mortgages
 * intact — or leave `owners` for the estate sale when the creditor is the
 * bank, because unsold estate spaces are unowned — returned to the bank
 * (§5). The debtor always ends at $0 cash with no built levels.
 */
function transferEstate(
  draft: GameStateDraft,
  debtorId: PlayerId,
  creditorId: CreditorId,
): { cash: number; spaceIds: readonly SpaceId[] } {
  const debtor = requirePlayer(draft, debtorId);
  const ownedSpaceIds = BOARD_SPACES.filter((space) => isPurchasable(space) && draft.owners[space.id] === debtorId).map((space) => space.id);
  let liquid = debtor.cash;
  const owners = { ...draft.owners };
  const upgrades = { ...draft.upgrades };
  const mortgaged = { ...draft.mortgaged };
  for (const spaceId of ownedSpaceIds) {
    const space = BOARD_SPACES.find((candidate): candidate is PurchasableSpace => isPurchasable(candidate) && candidate.id === spaceId);
    if (!space) throw new Error(`engine bug: owned space "${spaceId}" is not a purchasable board space`);
    const level = upgrades[spaceId] ?? 0;
    if (level > 0) {
      // §7 step 4: 50% of the price originally paid per level — to the
      // creditor, or nothing when the bank takes the estate.
      if (creditorId !== BANK_ID) liquid += level * upgradeSellBackProceeds(upgradeCost(space.listPrice));
      delete upgrades[spaceId];
    }
    if (creditorId === BANK_ID) {
      // §7 step 5: the bank repossesses — a mortgage is a loan between the
      // bank and its owner, so it dies with the ownership; a space sold from
      // the estate passes to its buyer unencumbered. (§7 keeps mortgages
      // intact only for a player-creditor transfer.)
      delete owners[spaceId];
      delete mortgaged[spaceId];
    } else {
      owners[spaceId] = creditorId;
    }
  }
  debtor.cash = 0;
  if (creditorId !== BANK_ID) requirePlayer(draft, creditorId).cash += liquid;
  draft.owners = owners;
  draft.upgrades = upgrades;
  draft.mortgaged = mortgaged;
  return { cash: liquid, spaceIds: ownedSpaceIds };
}

/**
 * §7: the full bankruptcy waterfall for one debtor and the single Phase 1
 * creditor — PLAYER_BANKRUPT, estate transfer, elimination, trade
 * cancellation, victory evaluation, then either the estate sale (bank
 * creditor) or the turn tail. The debtor's turn ends without a management
 * phase (§4). Event order: PLAYER_BANKRUPT names the creditor before any
 * money or ownership moves; PLAYER_ELIMINATED precedes the estate
 * auction's AUCTION_OPENED so §5 eligibility (non-eliminated players)
 * excludes the debtor from their own sale.
 */
function runBankruptcy(draft: GameStateDraft, debtorId: PlayerId, creditorId: CreditorId, events: AnyEventInput[]): void {
  events.push({ type: 'PLAYER_BANKRUPT', payload: { playerId: debtorId, creditorId } });
  const transferred = transferEstate(draft, debtorId, creditorId);
  events.push({ type: 'ASSETS_TRANSFERRED', payload: { fromId: debtorId, toId: creditorId, cash: transferred.cash, spaceIds: transferred.spaceIds } });

  // §7 step 6: eliminated — out of turn order, tokens discarded. The skip
  // mark is cleared with the rest of the player's turn state for hygiene.
  const debtor = requirePlayer(draft, debtorId);
  debtor.eliminated = true;
  debtor.tokens = { HOLD: 0, RENT_HOLIDAY: 0 };
  debtor.skipNextTurn = false;
  events.push({ type: 'PLAYER_ELIMINATED', payload: { playerId: debtorId } });

  // §7 step 7: offers die with any involved party's elimination (§6) —
  // filling the trading PR's deliberately untested seam.
  cancelTradeInvolving(draft, debtorId, events);

  // §7 step 9: victory evaluation on settled state — a debt is either
  // settled or bankrupted before any victory evaluation (§8). The debt is
  // extinguished by the bankruptcy either way.
  draft.debt = null;
  if (evaluateLastSolvent(draft, events)) return;
  if (evaluateNetWorthTarget(draft, events)) return;

  if (creditorId === BANK_ID && transferred.spaceIds.length > 0) {
    // §7 step 5: sequential per-property estate auctions
    // (ELIMINATION_AUCTIONS), in board order.
    startEstateSale(draft, debtorId, transferred.spaceIds, events);
  } else {
    events.push({ type: 'TURN_ENDED', payload: { playerId: debtorId, turn: draft.turn } });
    concludeTurn(draft, debtorId, events);
  }
}

/**
 * Row 11/15: SURRENDER — voluntary bankruptcy (§7: "always available").
 * In SETTLING_DEBT the debt's own creditor takes the estate; in
 * TURN_MANAGEMENT there is no debt, so the bank takes it. Hopeless debtors
 * reach here because the DEBT_HOPELESS veto admits SURRENDER alone.
 */
export function surrenderHandler(draft: GameStateDraft, command: GameCommand): AnyEventInput[] {
  let creditorId: CreditorId;
  if (draft.turnPhase === 'SETTLING_DEBT' && draft.debt !== null) {
    if (draft.debt.debtorId !== command.actorId) {
      throw new RuleError('NOT_AUTHORIZED', `only the debtor ${draft.debt.debtorId} may surrender the debt`, {
        debtorId: draft.debt.debtorId,
        actorId: command.actorId,
      });
    }
    creditorId = draft.debt.creditorId;
  } else if (draft.turnPhase === 'TURN_MANAGEMENT') {
    creditorId = BANK_ID;
  } else {
    throw new RuleError('INVALID_PHASE', `SURRENDER is only valid in TURN_MANAGEMENT or SETTLING_DEBT, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
    });
  }
  const events: AnyEventInput[] = [];
  runBankruptcy(draft, command.actorId, creditorId, events);
  return events;
}

/** Open one estate auction — board order, BANK_ESTATE reason, §5 rules. */
function openEstateAuction(draft: GameStateDraft, spaceId: SpaceId, events: AnyEventInput[]): void {
  const auction: AuctionState = {
    auctionId: auctionIdFor(draft.lastEventSequence + 1),
    spaceId,
    reason: 'BANK_ESTATE',
    currentBid: null,
    highBidderId: null,
    passedPlayerIds: [],
    // Eligibility frozen at open: every live player (§5). The debtor is
    // already eliminated, so they cannot bid on their own former estate.
    eligiblePlayerIds: draft.players.filter((player) => !player.eliminated).map((player) => player.id),
  };
  draft.auction = auction;
  events.push({ type: 'AUCTION_OPENED', payload: { auctionId: auction.auctionId, spaceId, reason: 'BANK_ESTATE' } });
}

/** Enter ELIMINATION_AUCTIONS and open the estate's first auction. */
function startEstateSale(draft: GameStateDraft, debtorId: PlayerId, spaceIds: readonly SpaceId[], events: AnyEventInput[]): void {
  const [first, ...rest] = spaceIds;
  if (!first) throw new Error('engine bug: estate sale started with no estate spaces');
  draft.estateSale = { debtorId, pendingSpaceIds: rest };
  draft.turnPhase = 'ELIMINATION_AUCTIONS';
  openEstateAuction(draft, first, events);
}

/** After each estate auction closes: open the next, or end the phase. */
function advanceEstateSale(draft: GameStateDraft, events: AnyEventInput[]): void {
  const estate = draft.estateSale;
  if (!estate) throw new Error('engine bug: estate advance without an open estate');
  if (estate.pendingSpaceIds.length > 0) {
    const [next, ...rest] = estate.pendingSpaceIds;
    draft.estateSale = { ...estate, pendingSpaceIds: rest };
    openEstateAuction(draft, next, events);
  } else {
    // §4 row 16: after the last property, the debtor's interrupted turn ends.
    draft.estateSale = null;
    events.push({ type: 'TURN_ENDED', payload: { playerId: estate.debtorId, turn: draft.turn } });
    concludeTurn(draft, estate.debtorId, events);
  }
}

/** The open BANK_ESTATE auction the command names (phase + reason + ref). */
function requireOpenEstateAuction(draft: GameStateDraft, command: GameCommand): AuctionState {
  const auction = requireOpenAuctionRef(draft, command, 'ELIMINATION_AUCTIONS');
  if (auction.reason !== 'BANK_ESTATE') {
    throw new Error(`engine bug: estate auction command reached a ${auction.reason} auction`);
  }
  return auction;
}

/** Advance the estate sale when the current auction has closed
 *  (`draft.auction === null` — both resolution paths clear it): a contested
 *  bid with two or more unpassed bidders must leave the auction open, never
 *  clobber it with the next estate space. */
function settleEstateStep(draft: GameStateDraft, events: AnyEventInput[]): void {
  if (draft.auction === null) advanceEstateSale(draft, events);
}

/** Row 16: a bid in a bank-creditor estate auction (spec §5 rules). */
export function estateBidHandler(draft: GameStateDraft, command: GameCommand): AnyEventInput[] {
  const auction = requireOpenEstateAuction(draft, command);
  const events: AnyEventInput[] = [];
  const next = applyAuctionBid(draft, auction, command, events);
  // A bid never changes who has passed; the bidder holding the only standing
  // bid as the sole unpassed player wins at their own bid, in this command
  // (§5, row 7).
  const remaining = unpassedPlayers(next);
  if (remaining.length === 1) resolveAuctionToWinner(draft, next, remaining[0], events);
  settleEstateStep(draft, events);
  return events;
}

/** Row 16: a binding pass in a bank-creditor estate auction (spec §5 rules). */
export function estatePassBidHandler(draft: GameStateDraft, command: GameCommand): AnyEventInput[] {
  const auction = requireOpenEstateAuction(draft, command);
  const events: AnyEventInput[] = [];
  const next = applyAuctionPass(draft, auction, command, events);
  const remaining = unpassedPlayers(next);
  if (remaining.length === 0) {
    closeAuctionUnsold(draft, next, events);
  } else if (remaining.length === 1 && next.currentBid !== null) {
    // The sole unpassed player holds the standing bid (a passed player can
    // never hold one) — they win at it. One unpassed player with NO standing
    // bid keeps the auction open: they bid the opening minimum or pass (§5).
    resolveAuctionToWinner(draft, next, remaining[0], events);
  }
  settleEstateStep(draft, events);
  return events;
}
