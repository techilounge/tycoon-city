/**
 * The §4 public/private boundary — the client-visible pure core. The seed and
 * the RNG word together predict every future draw, and the event deck is the
 * shuffled order itself — none of them may cross the wire to a client.
 *
 * This module is the single definition of that boundary, shared by BOTH sides
 * of the wire: the server's broadcast path (server/game/redact.ts re-exports
 * it verbatim) and the client's redacted-state rendering (the online game
 * screen holds a ClientGameState, never a full GameState). Pure serializable
 * data — no Node, no DOM.
 */
import type { GameState } from '../types';

/** Server-private top-level state keys (contract §4: seed / RNG state / deck orders). */
export const PRIVATE_STATE_KEYS = ['seed', 'rngState', 'eventDeck'] as const;

export type PrivateStateKey = (typeof PRIVATE_STATE_KEYS)[number];

/**
 * The client-facing projection of GameState. GameState stays assignable to
 * it (extra fields dropped structurally), so one set of UI projections can
 * render both hot-seat (full) and online (redacted) state.
 */
export type ClientGameState = Omit<GameState, PrivateStateKey>;

/** The ONLY shape a server state broadcast may take across the wire. */
export function projectClientState(state: GameState): ClientGameState {
  const { seed, rngState, eventDeck, ...client } = state;
  return client;
}
