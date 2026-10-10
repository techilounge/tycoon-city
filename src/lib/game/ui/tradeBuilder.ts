/**
 * Trade composer state (spec §6, §11): a pure builder that assembles the
 * OFFER_TRADE payload and gates the submit button client-side. The engine
 * re-proves every rule at submission (ownership on both legs, cash, no
 * credit, atomicity) — the builder only prevents obvious dead ends before a
 * command is spent, and never relaxes an engine rule.
 *
 * A counter prefill (spec §6: a counter reverses proposer/recipient roles
 * and REPLACES the pending offer) starts from the role-swapped legs of the
 * offer being countered.
 */
import { BOARD_SPACES, isPurchasable, type PurchasableSpace } from '../board-v1';
import type { GameState, PlayerId, SpaceId, TradeOffer } from '../types';

export type TradeSideKey = 'give' | 'receive';

export interface TradeBuilderState {
  readonly recipientId: PlayerId | null;
  /** Raw draft inputs — validated by tradeBuilderValidity, never trusted. */
  readonly giveCash: string;
  readonly receiveCash: string;
  readonly giveSpaceIds: readonly SpaceId[];
  readonly receiveSpaceIds: readonly SpaceId[];
}

export function newTradeBuilder(recipientId: PlayerId | null = null): TradeBuilderState {
  return { recipientId, giveCash: '', receiveCash: '', giveSpaceIds: [], receiveSpaceIds: [] };
}

/**
 * Prefill a counter to the pending offer: the counter-er (the pending
 * offer's recipient) gives what they were set to receive, and receives what
 * the original proposer offered. Empty cash drafts stay empty for editing.
 */
export function counterTradeBuilder(state: GameState): TradeBuilderState {
  const pending = state.trade;
  if (!pending) return newTradeBuilder();
  return {
    recipientId: pending.proposerId,
    giveCash: pending.offer.receive.cash > 0 ? String(pending.offer.receive.cash) : '',
    receiveCash: pending.offer.give.cash > 0 ? String(pending.offer.give.cash) : '',
    giveSpaceIds: [...pending.offer.receive.spaceIds],
    receiveSpaceIds: [...pending.offer.give.spaceIds],
  };
}

export function setTradeRecipient(builder: TradeBuilderState, recipientId: PlayerId | null): TradeBuilderState {
  return { ...builder, recipientId };
}

export function setTradeCash(builder: TradeBuilderState, side: TradeSideKey, raw: string): TradeBuilderState {
  return side === 'give' ? { ...builder, giveCash: raw } : { ...builder, receiveCash: raw };
}

export function toggleTradeSpace(builder: TradeBuilderState, side: TradeSideKey, spaceId: SpaceId): TradeBuilderState {
  if (side === 'give') {
    const spaceIds = builder.giveSpaceIds.includes(spaceId)
      ? builder.giveSpaceIds.filter((id) => id !== spaceId)
      : [...builder.giveSpaceIds, spaceId];
    return { ...builder, giveSpaceIds: spaceIds };
  }
  const spaceIds = builder.receiveSpaceIds.includes(spaceId)
    ? builder.receiveSpaceIds.filter((id) => id !== spaceId)
    : [...builder.receiveSpaceIds, spaceId];
  return { ...builder, receiveSpaceIds: spaceIds };
}

/** The purchasable spaces `playerId` owns — one side's picker list, board order. */
export function ownedPurchasables(state: GameState, playerId: PlayerId): readonly PurchasableSpace[] {
  return BOARD_SPACES.filter((space): space is PurchasableSpace => isPurchasable(space) && state.owners[space.id] === playerId);
}

/** "" parses to 0; otherwise whole digits only. Null = not a whole-dollar amount. */
function parseCash(raw: string): number | null {
  if (raw === '') return 0;
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** Assemble the payload when the drafts parse; null while a cash draft is malformed. */
export function buildTradeOffer(builder: TradeBuilderState): TradeOffer | null {
  const giveCash = parseCash(builder.giveCash);
  const receiveCash = parseCash(builder.receiveCash);
  if (giveCash === null || receiveCash === null) return null;
  return {
    give: { cash: giveCash, spaceIds: [...builder.giveSpaceIds] },
    receive: { cash: receiveCash, spaceIds: [...builder.receiveSpaceIds] },
  };
}

export interface TradeBuilderValidity {
  readonly ok: boolean;
  /** Human problems, deduplicated; empty exactly when ok. */
  readonly problems: readonly string[];
}

/**
 * Client-side gating (spec §6 rules restated as UX): a recipient is chosen
 * and solvent, cash drafts are whole dollars within what the proposer
 * actually holds (no credit), no space appears on both sides of the swap,
 * each named space is owned by the side that gives it, and the offer is not
 * empty. Final authority is the engine's.
 */
export function tradeBuilderValidity(state: GameState, builder: TradeBuilderState, proposerId: PlayerId): TradeBuilderValidity {
  const problems = new Set<string>();

  const recipient = builder.recipientId ? state.players.find((p) => p.id === builder.recipientId) : undefined;
  if (!builder.recipientId) {
    problems.add('Choose a player to trade with.');
  } else if (builder.recipientId === proposerId) {
    problems.add('You cannot trade with yourself.');
  } else if (!recipient || recipient.eliminated) {
    problems.add(`${builder.recipientId} is not a solvent player in this game.`);
  }

  const giveCash = parseCash(builder.giveCash);
  const receiveCash = parseCash(builder.receiveCash);
  if (giveCash === null || receiveCash === null) {
    problems.add('Cash must be whole dollars.');
  } else {
    const proposer = state.players.find((p) => p.id === proposerId);
    if (proposer && giveCash > proposer.cash) {
      problems.add(`You hold $${proposer.cash.toLocaleString()} — an offer cannot promise cash you do not have.`);
    }
    if (recipient && receiveCash > recipient.cash) {
      problems.add(`${recipient.id} holds $${recipient.cash.toLocaleString()} — they cannot promise more cash than they have.`);
    }
  }

  const seen = new Set<string>();
  for (const spaceId of [...builder.giveSpaceIds, ...builder.receiveSpaceIds]) {
    if (seen.has(spaceId)) problems.add('A space cannot be on both sides of the swap.');
    seen.add(spaceId);
  }
  for (const spaceId of builder.giveSpaceIds) {
    if (state.owners[spaceId] !== proposerId) problems.add(`You do not own ${spaceName(spaceId)}.`);
  }
  for (const spaceId of builder.receiveSpaceIds) {
    if (builder.recipientId && state.owners[spaceId] !== builder.recipientId) {
      problems.add(`${builder.recipientId} does not own ${spaceName(spaceId)}.`);
    }
  }

  if ((giveCash ?? 0) === 0 && (receiveCash ?? 0) === 0 && builder.giveSpaceIds.length === 0 && builder.receiveSpaceIds.length === 0) {
    problems.add('Offer at least one asset or some cash.');
  }

  return { ok: problems.size === 0, problems: [...problems] };
}

/** One side of a swap as human text — the composer's and history's review line. */
export function tradeSideText(cash: number, spaceIds: readonly SpaceId[]): string {
  const parts: string[] = [];
  if (cash > 0) parts.push(`$${cash.toLocaleString()}`);
  for (const spaceId of spaceIds) parts.push(spaceName(spaceId));
  return parts.length > 0 ? parts.join(' + ') : 'nothing';
}

function spaceName(spaceId: SpaceId): string {
  return BOARD_SPACES.find((space) => space.id === spaceId)?.name ?? spaceId;
}
