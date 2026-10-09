/**
 * Engine-private draft types shared by the handler modules (spec §2.1).
 *
 * The reducer clones state before any handler runs (mutation here never
 * escapes uncommitted); handlers write through the draft, and the reducer
 * commits it in one piece. This module exists so the per-PR rule modules
 * (movement, economy, debt, and later auctions/trading/endgame) can share
 * the draft vocabulary without importing the reducer and forming a cycle.
 */
import type { GameState, PlayerId } from '../types';

/**
 * Deeply mutable view of GameState for handler bodies: the reducer clones
 * before any handler runs, handlers write through the draft, and the
 * reducer commits it in one piece. Engine-private — never crosses the
 * public boundary — so stripping readonly (including inside the players
 * array) is safe. Handlers mutate player drafts freely; the array itself
 * is never resized.
 */
export type GameStateDraft = {
  -readonly [K in keyof GameState]: GameState[K] extends readonly (infer T)[]
    ? T extends object
      ? Array<{ -readonly [P in keyof T]: T[P] }>
      : T[]
    : GameState[K];
};

/** A player ON the draft: mutable, unlike the published PlayerState. */
export type DraftPlayer = GameStateDraft['players'][number];

/**
 * Look up a player on the draft after authorization has proven they exist;
 * a miss is an engine bug (canAct already rejected unknown actors), not a
 * rule outcome — so a plain Error, never a RuleError.
 */
export function requirePlayer(draft: GameStateDraft, playerId: PlayerId): DraftPlayer {
  const player = draft.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`engine bug: player ${playerId} not found after authorization`);
  return player;
}
