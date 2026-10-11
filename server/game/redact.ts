/**
 * The §4 public/private boundary (server side). The pure core lives in
 * src/lib/game/transport/clientState.ts so the CLIENT imports the same
 * definition without reaching into server/ — one boundary, one source of
 * truth. This module re-exports it for the server's broadcast path;
 * `projectClientState` is the ONLY function a server broadcast may use to
 * send state to clients.
 */
export {
  PRIVATE_STATE_KEYS,
  projectClientState,
} from '../../src/lib/game/transport/clientState';
export type { PrivateStateKey, ClientGameState } from '../../src/lib/game/transport/clientState';
