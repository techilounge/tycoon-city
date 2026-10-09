/**
 * Presentation helpers for the local slice UI (spec §12 PR 4). Pure functions
 * over engine state and events — no React, no DOM. The richer projection
 * layer (`projectPublicState`, spec §10) and the full UI arrive with PRs 10–11.
 */
import { BOARD_SPACES, isPurchasable, type BoardSpace } from '../board-v1';
import type { AnyGameEvent } from '../events';
import type { GameState, SpaceId } from '../types';

/** One restrained color per seat order — presentation-only, never game state. */
export const PLAYER_COLORS = ['#39b8a4', '#d8b86b', '#7fb1d8', '#c98bb0', '#8fd17f', '#d8a06b'] as const;

export function playerColor(seatIndex: number): string {
  return PLAYER_COLORS[seatIndex % PLAYER_COLORS.length];
}

export interface BuyOffer {
  readonly spaceId: SpaceId;
  readonly name: string;
  readonly listPrice: number;
}

/** The purchasable space the active player faces in BUY_DECISION, if any. */
export function buyOffer(state: GameState): BuyOffer | null {
  if (state.phase !== 'PLAYING' || state.turnPhase !== 'BUY_DECISION') return null;
  const player = state.players.find((p) => p.id === state.activePlayerId);
  if (!player) return null;
  const space = BOARD_SPACES[player.position];
  if (!isPurchasable(space)) return null;
  return { spaceId: space.id, name: space.name, listPrice: space.listPrice };
}

export interface DiceRoll {
  readonly die1: number;
  readonly die2: number;
  readonly isDoubles: boolean;
}

/** The most recent roll's dice (draw results ride in event meta, spec §2.2). */
export function lastDice(events: readonly AnyGameEvent[]): DiceRoll | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'DICE_ROLLED' && event.meta.dice) {
      const [die1, die2] = event.meta.dice;
      return { die1, die2, isDoubles: die1 === die2 };
    }
  }
  return null;
}

function spaceName(spaceId: SpaceId): string {
  return BOARD_SPACES.find((s) => s.id === spaceId)?.name ?? spaceId;
}

/** One human-readable line per event; null for types the slice does not render. */
export function describeEvent(event: AnyGameEvent): string | null {
  switch (event.type) {
    case 'GAME_CREATED':
      return `Game created for ${event.payload.playerIds.join(', ')}`;
    case 'TURN_STARTED':
      return `Turn ${event.payload.turn}: ${event.payload.playerId}`;
    case 'DICE_ROLLED':
      return event.meta.dice ? `${event.payload.playerId} rolled ${event.meta.dice[0]} + ${event.meta.dice[1]}` : null;
    case 'PLAYER_MOVED':
      return `${event.payload.playerId} moved to ${BOARD_SPACES[event.payload.to].name}`;
    case 'START_BONUS_PAID':
      return `${event.payload.playerId} collected the $${event.payload.amount} Gateway bonus`;
    case 'PROPERTY_PURCHASED':
      return `${event.payload.playerId} bought ${spaceName(event.payload.spaceId)} for $${event.payload.amount}`;
    case 'TOKEN_CONSUMED':
      return `${event.payload.playerId} spent a Hold token`;
    case 'TURN_SKIPPED':
      return event.payload.reason === 'HOLD_TOKEN'
        ? `${event.payload.playerId} skipped the turn (Hold token)`
        : `${event.payload.playerId} will skip their next turn (third doubles)`;
    case 'TURN_ENDED':
      return `${event.payload.playerId} ended turn ${event.payload.turn}`;
    default:
      return null;
  }
}
