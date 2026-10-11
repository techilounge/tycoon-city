/**
 * Guest session tokens (spec "Sessions and identity"): 256 bits of
 * crypto.randomBytes entropy, hex-encoded, bound to `(gameId, actorId)` in
 * SQLite at join time. The server stamps every command's actorId from the
 * session — a client-claimed identity never reaches `canAct`.
 */
import { randomBytes } from 'node:crypto';

/** Tokens expire 7 days after creation (spec: configurable). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function mintSessionToken(): string {
  return randomBytes(32).toString('hex');
}
