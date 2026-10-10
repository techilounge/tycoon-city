/**
 * Modal orchestration (spec §11): which single modal the game screen shows.
 * A pure decision table over engine state and light UI bookkeeping — at most
 * one modal renders at a time, chosen by a fixed priority order. The
 * component layer renders the plan; nothing here touches the DOM.
 *
 * Priority (the relative order is the contract):
 *   VICTORY (game over trumps everything) → AUCTION (non-dismissible
 *   decision surface, declined buys and estate sales alike) → DEBT
 *   (non-dismissible settlement surface, spec §7) → BANKRUPTCY
 *   (elimination acknowledgment — yields to auctions since a bank-creditor
 *   estate sale follows) → EVENT_REVEAL (dismissible card reveal) →
 *   TRADE_REVIEW (pending offer, dismissible — it must never disturb the
 *   active player's turn, spec §6) → TRADE_BUILDER (user-opened composer).
 *
 * A pending offer and an open auction cannot coexist in Phase 1 (offers are
 * proposed in TURN_MANAGEMENT/SETTLING_DEBT and expire at the turn pass),
 * but the priority makes the plan deterministic regardless.
 */
import type { AnyGameEvent } from '../events';
import { EVENT_DECK_CATALOG, type EventCardEffect } from '../board-v1';
import type { CreditorId, GameState, PlayerId, SpaceId } from '../types';

export type ModalPlan =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'AUCTION' }
  | { readonly kind: 'DEBT' }
  | { readonly kind: 'BANKRUPTCY' }
  | { readonly kind: 'EVENT_REVEAL' }
  | { readonly kind: 'TRADE_REVIEW' }
  | { readonly kind: 'TRADE_BUILDER'; readonly counterOf: string | null }
  | { readonly kind: 'VICTORY' };

export interface ModalUiState {
  /** The trade composer is open (user-triggered); `counterOf` is the pending trade it counters, if any. */
  readonly tradeBuilderOpen: boolean;
  readonly counterOf: string | null;
  /** The id of the pending trade whose review the user dismissed — a NEW
   *  offer (different tradeId) re-opens the review automatically. */
  readonly dismissedTradeId: string | null;
  /** A card draw not yet revealed (page derives this from the event history
   *  vs the acknowledged sequence — pendingCardReveal). */
  readonly cardRevealPending: boolean;
  /** An elimination not yet acknowledged (pendingElimination). */
  readonly bankruptcyPending: boolean;
  /** The game is over and the victory surface has not been dismissed. */
  readonly victoryUnacknowledged: boolean;
}

export function modalPlan(state: GameState, ui: ModalUiState): ModalPlan {
  if (state.phase !== 'PLAYING') return state.phase === 'GAME_OVER' && ui.victoryUnacknowledged ? { kind: 'VICTORY' } : { kind: 'NONE' };
  if (state.auction !== null) return { kind: 'AUCTION' };
  if (state.debt !== null) return { kind: 'DEBT' };
  if (ui.bankruptcyPending) return { kind: 'BANKRUPTCY' };
  if (ui.cardRevealPending) return { kind: 'EVENT_REVEAL' };
  // A counter replaces the pending offer (spec §6): its composer outranks
  // the review and may open in any phase while that exact offer is pending
  // (recipient answers are legal in any phase while an offer pends).
  if (ui.tradeBuilderOpen && state.trade !== null && ui.counterOf === state.trade.tradeId) {
    return { kind: 'TRADE_BUILDER', counterOf: ui.counterOf };
  }
  // The review auto-shows for a pending offer unless THIS offer was dismissed.
  if (state.trade !== null && ui.dismissedTradeId !== state.trade.tradeId) return { kind: 'TRADE_REVIEW' };
  // A fresh offer is the active player's TURN_MANAGEMENT action (spec §6).
  if (ui.tradeBuilderOpen && state.turnPhase === 'TURN_MANAGEMENT') return { kind: 'TRADE_BUILDER', counterOf: null };
  return { kind: 'NONE' };
}

// ---------------------------------------------------------------------------
// Unseen-history reveals (bankruptcy and event modals)

export interface CardReveal {
  readonly sequence: number;
  readonly playerId: PlayerId;
  readonly cardId: string;
  readonly title: string;
  readonly text: string;
  /** The effect as applied, from CARD_EFFECT_APPLIED — null if none followed. */
  readonly effect: EventCardEffect | null;
}

/**
 * The last card draw the player has not seen yet (sequence > seenThroughSeq),
 * resolved against the canonical EVENT_DECK_CATALOG — null when there is none.
 */
export function pendingCardReveal(history: readonly AnyGameEvent[], seenThroughSeq: number): CardReveal | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i];
    if (event.sequence <= seenThroughSeq) return null;
    if (event.type !== 'CARD_DRAWN' || event.meta.cardId === undefined) continue;
    const cardId = event.meta.cardId;
    const card = EVENT_DECK_CATALOG.find((c) => c.id === cardId);
    const effect = [...history.slice(i + 1)].find((e) => e.type === 'CARD_EFFECT_APPLIED' && e.payload.cardId === cardId);
    return {
      sequence: event.sequence,
      playerId: event.payload.playerId,
      cardId,
      title: card?.title ?? cardId,
      text: card?.text ?? '',
      effect: effect && effect.type === 'CARD_EFFECT_APPLIED' ? effect.payload.effect : null,
    };
  }
  return null;
}

export interface EliminationReveal {
  readonly sequence: number;
  readonly playerId: PlayerId;
  readonly creditorId: CreditorId | null;
  readonly transferredCash: number;
  readonly transferredSpaceIds: readonly SpaceId[];
}

/**
 * The last elimination the player has not acknowledged yet, with the estate
 * facts from the waterfall events that preceded it (PLAYER_BANKRUPT names the
 * creditor; ASSETS_TRANSFERRED carries the cash and properties moved).
 */
export function pendingElimination(history: readonly AnyGameEvent[], seenThroughSeq: number): EliminationReveal | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i];
    if (event.sequence <= seenThroughSeq) return null;
    if (event.type !== 'PLAYER_ELIMINATED') continue;
    const playerId = event.payload.playerId;
    let creditorId: CreditorId | null = null;
    let transferredCash = 0;
    let transferredSpaceIds: readonly SpaceId[] = [];
    for (let j = i - 1; j >= 0; j -= 1) {
      const prior = history[j];
      if (prior.type === 'PLAYER_BANKRUPT' && prior.payload.playerId === playerId) creditorId = prior.payload.creditorId;
      if (prior.type === 'ASSETS_TRANSFERRED' && prior.payload.fromId === playerId) {
        transferredCash = prior.payload.cash;
        transferredSpaceIds = prior.payload.spaceIds;
      }
    }
    return { sequence: event.sequence, playerId, creditorId, transferredCash, transferredSpaceIds };
  }
  return null;
}

/** One human line for an applied card effect — the payload's own numbers. */
export function cardEffectText(effect: EventCardEffect): string {
  switch (effect.kind) {
    case 'MOVE_TO':
      return 'Move forward to your destination.';
    case 'MOVE_TO_NEAREST_HUB':
      return 'Move to the nearest transit hub.';
    case 'MOVE_BACK':
      return `Move back ${effect.spaces} ${effect.spaces === 1 ? 'space' : 'spaces'}.`;
    case 'PAY':
      return `Pay $${effect.amount.toLocaleString()}.`;
    case 'COLLECT':
      return `Collect $${effect.amount.toLocaleString()}.`;
    case 'GRANT_TOKEN':
      return 'A token is granted to you.';
  }
}
