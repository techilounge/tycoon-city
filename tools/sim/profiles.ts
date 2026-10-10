/**
 * Strategy profiles for the balance simulation (spec §8).
 *
 * Four profiles — Conservative, Aggressive, Mixed, Random-Walk — drive the
 * engine headless through complete games. Every profile is a PURE decision
 * function over (state, actor, rng, context): it reads the serializable
 * game state and returns a typed decision; it never touches the reducer,
 * the transport, or the wall clock. The driver (./driver) owns envelopes —
 * commandId, actorId, expectedVersion — and translates decisions into
 * GameCommands against the real CommandSink.
 *
 * Random-Walk consumes its own per-seat RandomSource (derived from the game
 * seed, never the engine's), so strategy randomness cannot perturb game
 * determinism: the command log alone is the record, and a replay folds the
 * log without re-running any profile.
 *
 * Games seat profiles in fixed rotation (spec §8: CONSERVATIVE, AGGRESSIVE,
 * MIXED, RANDOM_WALK, repeating), so the same seed exercises the same
 * profile per seat across every mode and player count.
 */
import {
  BOARD_SPACES,
  DISTRICTS,
  isPurchasable,
  type DistrictId,
  type PropertySpace,
  type PurchasableSpace,
} from '../../src/lib/game/board-v1';
import { MAX_UPGRADE_LEVEL, unmortgageCost, upgradeCost } from '../../src/lib/game/rules-v1';
import type { RandomSource } from '../../src/lib/game/rng';
import type { GameState, PlayerId, SpaceId, TradeOffer } from '../../src/lib/game/types';

export type ProfileId = 'CONSERVATIVE' | 'AGGRESSIVE' | 'MIXED' | 'RANDOM_WALK';

/** Fixed seat rotation (spec §8): every profile present, seeds comparable. */
export const PROFILE_ROTATION: readonly ProfileId[] = ['CONSERVATIVE', 'AGGRESSIVE', 'MIXED', 'RANDOM_WALK'];

/** The profile driving a seat — seat order maps to the fixed rotation. */
export function profileForSeat(seat: number): ProfileId {
  return PROFILE_ROTATION[seat % PROFILE_ROTATION.length] as ProfileId;
}

// ---------------------------------------------------------------------------
// Decision types — one union per decision point the driver polls.
// ---------------------------------------------------------------------------

export type RollDecision = { readonly action: 'ROLL' } | { readonly action: 'HOLD' };

export type BuyDecision = { readonly action: 'BUY' } | { readonly action: 'PASS_TO_AUCTION' };

export type BidDecision = { readonly action: 'BID'; readonly amount: number } | { readonly action: 'PASS_BID' };

export type AnswerDecision =
  | { readonly response: 'ACCEPT' | 'REJECT' }
  | { readonly response: 'COUNTER'; readonly counterOffer: TradeOffer };

export type SettlementStep =
  | { readonly action: 'SELL_UPGRADE'; readonly spaceId: SpaceId }
  | { readonly action: 'MORTGAGE'; readonly spaceId: SpaceId }
  | { readonly action: 'SETTLE_DEBT' }
  | { readonly action: 'SURRENDER' };

export type ManagementAction =
  | { readonly action: 'BUILD'; readonly spaceId: SpaceId }
  | { readonly action: 'SELL_UPGRADE'; readonly spaceId: SpaceId }
  | { readonly action: 'MORTGAGE'; readonly spaceId: SpaceId }
  | { readonly action: 'UNMORTGAGE'; readonly spaceId: SpaceId }
  | { readonly action: 'OFFER_TRADE'; readonly recipientId: PlayerId; readonly offer: TradeOffer }
  | { readonly action: 'END_TURN' };

/** Per-turn scratch the driver provides so a profile cannot loop a decision. */
export interface ManagementContext {
  readonly actionsThisTurn: number;
  readonly tradesProposedThisTurn: number;
}

/**
 * Depth of the current negotiation (0 = answering the original offer, 1+ =
 * answering a counter). Profiles other than Random-Walk never counter, and
 * nobody counters at depth ≥ 1, so negotiations terminate by construction.
 */
export type AnswerDepth = number;

/**
 * One profile: pure decision functions per polled decision point. The
 * driver guarantees the preconditions named on each method (e.g. decideBid
 * is only polled for a live, unpassed player who does not hold the high
 * bid); profiles may read anything on state.
 */
export interface Strategy {
  readonly id: ProfileId;
  decideRoll(state: GameState, actorId: PlayerId, rng: RandomSource): RollDecision;
  decideBuy(state: GameState, actorId: PlayerId, rng: RandomSource): BuyDecision;
  decideBid(state: GameState, actorId: PlayerId, rng: RandomSource): BidDecision;
  decideManagement(state: GameState, actorId: PlayerId, rng: RandomSource, context: ManagementContext): ManagementAction;
  decideAnswer(
    state: GameState,
    actorId: PlayerId,
    rng: RandomSource,
    depth: AnswerDepth,
  ): AnswerDecision;
  decideSettlement(state: GameState, actorId: PlayerId, rng: RandomSource): SettlementStep;
}

// ---------------------------------------------------------------------------
// Shared pure views over GameState — board-order scans, no Object.entries,
// so iteration order is board-derived and replay-stable.
// ---------------------------------------------------------------------------

export function playerOf(state: GameState, playerId: PlayerId) {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`sim: unknown player ${playerId}`);
  return player;
}

/** Every purchasable space `playerId` owns, in board order. */
export function ownedSpaces(state: GameState, playerId: PlayerId): PurchasableSpace[] {
  return BOARD_SPACES.filter((space): space is PurchasableSpace => isPurchasable(space) && state.owners[space.id] === playerId);
}

/** Districts fully held by `playerId` (spec §8 completion). */
export function completedDistrictIdsOf(state: GameState, playerId: PlayerId): DistrictId[] {
  return DISTRICTS.filter((district) => district.spaceIds.every((spaceId) => state.owners[spaceId] === playerId)).map((d) => d.id);
}

/** Spaces the actor may BUILD on: complete district, unmortgaged, below the landmark. */
export function buildableSpaces(state: GameState, actorId: PlayerId): PropertySpace[] {
  return ownedSpaces(state, actorId).filter((space): space is PropertySpace => {
    if (space.kind !== 'PROPERTY') return false;
    if (state.mortgaged[space.id]) return false;
    if ((state.upgrades[space.id] ?? 0) >= MAX_UPGRADE_LEVEL) return false;
    const district = DISTRICTS.find((d) => d.id === space.districtId);
    return district !== undefined && district.spaceIds.every((spaceId) => state.owners[spaceId] === actorId);
  });
}

/** Spaces with at least one built level (SELL_UPGRADE candidates), board order. */
export function builtSpaces(state: GameState, actorId: PlayerId): PropertySpace[] {
  return ownedSpaces(state, actorId).filter(
    (space): space is PropertySpace => space.kind === 'PROPERTY' && (state.upgrades[space.id] ?? 0) >= 1,
  );
}

/** Owned level-0 unmortgaged spaces (MORTGAGE candidates), board order. */
export function mortgageableSpaces(state: GameState, actorId: PlayerId): PurchasableSpace[] {
  return ownedSpaces(state, actorId).filter((space) => !state.mortgaged[space.id] && (state.upgrades[space.id] ?? 0) === 0);
}

/** Owned mortgaged spaces the actor could UNMORTGAGE, board order. */
export function mortgagedSpaces(state: GameState, actorId: PlayerId): PurchasableSpace[] {
  return ownedSpaces(state, actorId).filter((space) => state.mortgaged[space.id] === true);
}

/** Bids move in $10 steps — floor a willingness to a legal ceiling. */
export function bidCeiling(amount: number): number {
  return Math.floor(amount / 10) * 10;
}

/** Live players in seat order after `afterId` (wrapping); empty when alone. */
export function livePlayersAfter(state: GameState, afterId: PlayerId): PlayerId[] {
  const count = state.players.length;
  const from = playerOf(state, afterId).seat;
  const result: PlayerId[] = [];
  // Steps 1..count-1 strictly: the wrap-around step would re-include the actor.
  for (let step = 1; step < count; step++) {
    const candidate = state.players[(from + step) % count];
    if (candidate && !candidate.eliminated) result.push(candidate.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The four profiles.
// ---------------------------------------------------------------------------

/** Conservative: buy only with cash > 2× price; build only with surplus; cheap bids. */
const CONSERVATIVE: Strategy = {
  id: 'CONSERVATIVE',
  decideRoll: () => ({ action: 'ROLL' }),
  decideBuy(state, actorId) {
    const player = playerOf(state, actorId);
    const space = BOARD_SPACES[player.position];
    return player.cash > 2 * (space as PurchasableSpace).listPrice ? { action: 'BUY' } : { action: 'PASS_TO_AUCTION' };
  },
  decideBid(state, actorId) {
    const player = playerOf(state, actorId);
    const auction = state.auction;
    if (!auction) return { action: 'PASS_BID' };
    const space = BOARD_SPACES.find((candidate) => candidate.id === auction.spaceId);
    if (!space || !isPurchasable(space)) return { action: 'PASS_BID' };
    // Sit out unless wealth comfortably covers the list price (their buy rule).
    if (player.cash <= 2 * space.listPrice) return { action: 'PASS_BID' };
    return bidTowards({ cash: player.cash, currentBid: auction.currentBid, ceiling: 0.5 * space.listPrice });
  },
  decideManagement(state, actorId, _rng, context) {
    const player = playerOf(state, actorId);
    // Build with surplus: keep 3× the cost in reserve.
    const buildable = buildableSpaces(state, actorId).filter((space) => player.cash >= 3 * upgradeCost(space.listPrice));
    if (buildable.length > 0) return { action: 'BUILD', spaceId: buildable[0].id };
    if (context.tradesProposedThisTurn === 0 && state.trade === null) {
      const offer = sellProposal(state, actorId, 1.0);
      if (offer) return offer;
    }
    return { action: 'END_TURN' };
  },
  decideAnswer(state, actorId, rng, depth) {
    const pending = state.trade;
    if (!pending) return { response: 'REJECT' };
    return answerAsBuyer(state, actorId, rng, depth, { maxFactor: 0.6, cashGate: 2, counter: false });
  },
  decideSettlement(state, actorId) {
    return settlementStep(state, actorId);
  },
};

/** Aggressive: buy anything affordable; bid hard; build to the landmark ASAP. */
const AGGRESSIVE: Strategy = {
  id: 'AGGRESSIVE',
  decideRoll: () => ({ action: 'ROLL' }),
  decideBuy(state, actorId) {
    const player = playerOf(state, actorId);
    const space = BOARD_SPACES[player.position];
    return player.cash >= (space as PurchasableSpace).listPrice ? { action: 'BUY' } : { action: 'PASS_TO_AUCTION' };
  },
  decideBid(state, actorId) {
    const player = playerOf(state, actorId);
    const auction = state.auction;
    if (!auction) return { action: 'PASS_BID' };
    const space = BOARD_SPACES.find((candidate) => candidate.id === auction.spaceId);
    if (!space || !isPurchasable(space)) return { action: 'PASS_BID' };
    return bidTowards({ cash: player.cash, currentBid: auction.currentBid, ceiling: 1.2 * space.listPrice });
  },
  decideManagement(state, actorId, _rng, context) {
    const player = playerOf(state, actorId);
    // Build to the landmark ASAP: any buildable, whenever affordable.
    const buildable = buildableSpaces(state, actorId).filter((space) => player.cash >= upgradeCost(space.listPrice));
    if (buildable.length > 0) return { action: 'BUILD', spaceId: buildable[0].id };
    if (context.tradesProposedThisTurn === 0 && state.trade === null) {
      const offer = sellProposal(state, actorId, 1.5);
      if (offer) return offer;
    }
    return { action: 'END_TURN' };
  },
  decideAnswer(state, actorId, rng, depth) {
    const pending = state.trade;
    if (!pending) return { response: 'REJECT' };
    return answerAsBuyer(state, actorId, rng, depth, { maxFactor: 1.6, cashGate: 1, counter: false });
  },
  decideSettlement(state, actorId) {
    return settlementStep(state, actorId);
  },
};

/** Mixed: buy if price < 40% of cash (cash > 2.5× price); balanced building. */
const MIXED: Strategy = {
  id: 'MIXED',
  decideRoll: () => ({ action: 'ROLL' }),
  decideBuy(state, actorId) {
    const player = playerOf(state, actorId);
    const space = BOARD_SPACES[player.position];
    return (space as PurchasableSpace).listPrice < 0.4 * player.cash ? { action: 'BUY' } : { action: 'PASS_TO_AUCTION' };
  },
  decideBid(state, actorId) {
    const player = playerOf(state, actorId);
    const auction = state.auction;
    if (!auction) return { action: 'PASS_BID' };
    const space = BOARD_SPACES.find((candidate) => candidate.id === auction.spaceId);
    if (!space || !isPurchasable(space)) return { action: 'PASS_BID' };
    return bidTowards({ cash: player.cash, currentBid: auction.currentBid, ceiling: 0.9 * space.listPrice });
  },
  decideManagement(state, actorId, _rng, context) {
    const player = playerOf(state, actorId);
    const buildable = buildableSpaces(state, actorId).filter((space) => player.cash >= 2 * upgradeCost(space.listPrice));
    if (buildable.length > 0) return { action: 'BUILD', spaceId: buildable[0].id };
    if (context.tradesProposedThisTurn === 0 && state.trade === null) {
      const offer = sellProposal(state, actorId, 1.2);
      if (offer) return offer;
    }
    return { action: 'END_TURN' };
  },
  decideAnswer(state, actorId, rng, depth) {
    const pending = state.trade;
    if (!pending) return { response: 'REJECT' };
    return answerAsBuyer(state, actorId, rng, depth, { maxFactor: 1.0, cashGate: 1, counter: false });
  },
  decideSettlement(state, actorId) {
    return settlementStep(state, actorId);
  },
};

/**
 * Random-Walk: valid random commands for invariant stress (spec §8). Every
 * decision is drawn from its per-seat rng; every path stays legal.
 */
const RANDOM_WALK: Strategy = {
  id: 'RANDOM_WALK',
  decideRoll(state, actorId, rng) {
    const player = playerOf(state, actorId);
    return player.tokens.HOLD >= 1 && rng.next() < 0.1 ? { action: 'HOLD' } : { action: 'ROLL' };
  },
  decideBuy(state, actorId, rng) {
    const player = playerOf(state, actorId);
    const space = BOARD_SPACES[player.position];
    if (player.cash < (space as PurchasableSpace).listPrice) return { action: 'PASS_TO_AUCTION' };
    return rng.next() < 0.5 ? { action: 'BUY' } : { action: 'PASS_TO_AUCTION' };
  },
  decideBid(state, actorId, rng) {
    const player = playerOf(state, actorId);
    const auction = state.auction;
    if (!auction) return { action: 'PASS_BID' };
    if (rng.next() >= 0.4) return { action: 'PASS_BID' };
    // Willing to go anywhere between $10 and all-in, $10 steps.
    return bidTowards({ cash: player.cash, currentBid: auction.currentBid, ceiling: bidCeiling(rng.next() * player.cash) });
  },
  decideManagement(state, actorId, rng, context) {
    const player = playerOf(state, actorId);
    const buildable = buildableSpaces(state, actorId).filter((space) => player.cash >= upgradeCost(space.listPrice));
    const built = builtSpaces(state, actorId);
    const mortgageable = mortgageableSpaces(state, actorId);
    const mortgaged = mortgagedSpaces(state, actorId).filter((space) => player.cash >= unmortgageCost(space.listPrice));
    const roll = rng.next();
    // 60% plain end; otherwise one random legal flourish.
    if (roll < 0.6) return { action: 'END_TURN' };
    const options: ManagementAction[] = [];
    if (mortgaged.length > 0) options.push({ action: 'UNMORTGAGE', spaceId: mortgaged[0].id });
    if (built.length > 0) options.push({ action: 'SELL_UPGRADE', spaceId: built[0].id });
    if (buildable.length > 0) options.push({ action: 'BUILD', spaceId: buildable[0].id });
    if (mortgageable.length > 0) options.push({ action: 'MORTGAGE', spaceId: mortgageable[0].id });
    if (options.length === 0) return { action: 'END_TURN' };
    return options[rng.nextInt(options.length)] as ManagementAction;
  },
  decideAnswer(state, actorId, rng, depth) {
    const pending = state.trade;
    if (!pending) return { response: 'REJECT' };
    if (depth === 0 && rng.next() < 1 / 3) {
      // Counter: buy the offered space back at ~70% of list, cash only.
      const spaceIds = pending.offer.give.spaceIds;
      const first = spaceIds[0];
      if (first === undefined || spaceIds.length !== 1 || pending.offer.give.cash !== 0) return { response: 'REJECT' };
      const space = BOARD_SPACES.find((candidate) => candidate.id === first);
      if (!space || !isPurchasable(space)) return { response: 'REJECT' };
      const player = playerOf(state, actorId);
      const cash = bidCeiling(0.7 * space.listPrice);
      if (player.cash < cash) return { response: 'REJECT' };
      return {
        response: 'COUNTER',
        counterOffer: { give: { cash, spaceIds: [] }, receive: { cash: 0, spaceIds: [first] } },
      };
    }
    return answerAsBuyer(state, actorId, rng, depth, { maxFactor: Number.POSITIVE_INFINITY, cashGate: 1, counter: false, acceptChance: 0.5 });
  },
  decideSettlement(state, actorId) {
    return settlementStep(state, actorId);
  },
};

// ---------------------------------------------------------------------------
// Shared decision helpers.
// ---------------------------------------------------------------------------

/** Open at $10 or raise one increment while under the ceiling; else pass. */
export function bidTowards(input: { cash: number; currentBid: number | null; ceiling: number }): BidDecision {
  const { cash, currentBid, ceiling } = input;
  if (currentBid === null) {
    return cash >= 10 && ceiling >= 10 ? { action: 'BID', amount: 10 } : { action: 'PASS_BID' };
  }
  const next = currentBid + 10;
  return next <= bidCeiling(ceiling) && next <= bidCeiling(cash) ? { action: 'BID', amount: next } : { action: 'PASS_BID' };
}

/**
 * A management-phase sale proposal: offer the actor's cheapest unmortgaged
 * space for `askFactor` × its list price, cash-only, to the first live
 * player after the actor who could plausibly pay. Null when no legal
 * proposal exists (no spaces, or nobody solvent enough to matter).
 */
function sellProposal(state: GameState, actorId: PlayerId, askFactor: number): ManagementAction | null {
  const candidate = ownedSpaces(state, actorId).find((space) => !state.mortgaged[space.id]);
  if (!candidate) return null;
  const ask = Math.round(askFactor * candidate.listPrice);
  const recipient = livePlayersAfter(state, actorId).find((id) => playerOf(state, id).cash >= ask);
  if (!recipient) return null;
  return {
    action: 'OFFER_TRADE',
    recipientId: recipient,
    offer: { give: { cash: 0, spaceIds: [candidate.id] }, receive: { cash: ask, spaceIds: [] } },
  };
}

interface BuyerPolicy {
  /** Accept when the ask is at most this factor of the space's list price. */
  readonly maxFactor: number;
  /** Require cash > cashGate × ask before accepting (conservative buffer). */
  readonly cashGate: number;
  readonly counter: boolean;
  /** Random-Walk only: accept with this probability when otherwise eligible. */
  readonly acceptChance?: number;
}

/** Evaluate a cash-for-space offer as the recipient (spec §6 semantics). */
function answerAsBuyer(
  state: GameState,
  actorId: PlayerId,
  rng: RandomSource,
  depth: AnswerDepth,
  policy: BuyerPolicy,
): AnswerDecision {
  const pending = state.trade;
  if (!pending) return { response: 'REJECT' };
  const spaceIds = pending.offer.give.spaceIds;
  const first = spaceIds[0];
  // Our harness only ever negotiates single-space, cash-only offers.
  if (first === undefined || spaceIds.length !== 1 || pending.offer.give.cash !== 0) return { response: 'REJECT' };
  if (pending.offer.receive.spaceIds.length !== 0) return { response: 'REJECT' };
  const space = BOARD_SPACES.find((candidate) => candidate.id === first);
  if (!space || !isPurchasable(space)) return { response: 'REJECT' };
  const ask = pending.offer.receive.cash;
  const player = playerOf(state, actorId);
  if (player.cash < ask) return { response: 'REJECT' };
  if (ask > policy.maxFactor * space.listPrice) return { response: 'REJECT' };
  if (player.cash <= policy.cashGate * ask) return { response: 'REJECT' };
  if (policy.acceptChance !== undefined && rng.next() >= policy.acceptChance) return { response: 'REJECT' };
  // Nobody counters at depth ≥ 1 — negotiations terminate (see AnswerDepth).
  if (policy.counter && depth === 0) {
    return { response: 'COUNTER', counterOffer: { give: { cash: bidCeiling(0.7 * space.listPrice), spaceIds: [] }, receive: { cash: 0, spaceIds: [first] } } };
  }
  return { response: 'ACCEPT' };
}

/**
 * Settlement (spec §7): settle as soon as cash covers the due amount; else
 * liquidate — sell built levels first (board order), then mortgage level-0
 * spaces; when nothing legal remains, surrender is the only path left.
 *
 * Exported for contract tests (tests/sim); the driver is its integration test.
 */
export function settlementStep(state: GameState, actorId: PlayerId): SettlementStep {
  const debt = state.debt;
  if (!debt) throw new Error('sim: settlement decided with no open debt');
  const player = playerOf(state, actorId);
  if (player.cash >= debt.amountDue) return { action: 'SETTLE_DEBT' };
  const built = builtSpaces(state, actorId);
  if (built.length > 0) return { action: 'SELL_UPGRADE', spaceId: built[0].id };
  const mortgageable = mortgageableSpaces(state, actorId);
  if (mortgageable.length > 0) return { action: 'MORTGAGE', spaceId: mortgageable[0].id };
  return { action: 'SURRENDER' };
}

const PROFILES: Readonly<Record<ProfileId, Strategy>> = {
  CONSERVATIVE: CONSERVATIVE,
  AGGRESSIVE: AGGRESSIVE,
  MIXED: MIXED,
  RANDOM_WALK: RANDOM_WALK,
};

export function strategyFor(profileId: ProfileId): Strategy {
  return PROFILES[profileId];
}
