/**
 * Modal orchestration (spec §11): which single modal the game screen shows.
 * A pure decision table over engine state and light UI bookkeeping — at most
 * one modal renders at a time, chosen by a fixed priority order. The
 * component layer renders the plan; nothing here touches the DOM.
 *
 * Priority (the relative order is the contract):
 *   AUCTION (non-dismissible decision surface, declined buys and estate
 *   sales alike) → DEBT (non-dismissible settlement surface, spec §7) →
 *   TRADE_REVIEW (pending offer, dismissible — it must never disturb the
 *   active player's turn, spec §6) → TRADE_BUILDER (user-opened composer).
 *
 * A pending offer and an open auction cannot coexist in Phase 1 (offers are
 * proposed in TURN_MANAGEMENT/SETTLING_DEBT and expire at the turn pass),
 * but the priority makes the plan deterministic regardless.
 */
import type { GameState } from '../types';

export type ModalPlan =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'AUCTION' }
  | { readonly kind: 'DEBT' }
  | { readonly kind: 'TRADE_REVIEW' }
  | { readonly kind: 'TRADE_BUILDER'; readonly counterOf: string | null };

export interface ModalUiState {
  /** The trade composer is open (user-triggered); `counterOf` is the pending trade it counters, if any. */
  readonly tradeBuilderOpen: boolean;
  readonly counterOf: string | null;
  /** The id of the pending trade whose review the user dismissed — a NEW
   *  offer (different tradeId) re-opens the review automatically. */
  readonly dismissedTradeId: string | null;
}

export function modalPlan(state: GameState, ui: ModalUiState): ModalPlan {
  if (state.phase !== 'PLAYING') return { kind: 'NONE' };
  if (state.auction !== null) return { kind: 'AUCTION' };
  if (state.debt !== null) return { kind: 'DEBT' };
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
