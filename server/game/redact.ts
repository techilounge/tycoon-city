/**
 * The §4 public/private boundary, enforced in one place: the seed and the
 * RNG word together predict every future draw, and the event deck is the
 * shuffled order itself — none of them may cross the wire to a client.
 * `projectClientState` is the ONLY function a server broadcast may use to
 * send state to clients.
 */
import type { GameState } from '../../src/lib/game/types';

/** Server-private top-level state keys (contract §4: seed / RNG state / deck orders). */
export const PRIVATE_STATE_KEYS = ['seed', 'rngState', 'eventDeck'] as const;

export type PrivateStateKey = (typeof PRIVATE_STATE_KEYS)[number];

/**
 * The client-facing projection of GameState. GameState stays assignable to
 * it (extra fields dropped structurally), so one set of UI projections can
 * render both hot-seat (full) and online (redacted) state.
 */
export type ClientGameState = Omit<GameState, PrivateStateKey>;

export function projectClientState(state: GameState): ClientGameState {
  const { seed, rngState, eventDeck, ...client } = state;
  return client;
}
