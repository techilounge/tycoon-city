/**
 * Typed rule violations (spec §2.1).
 *
 * Invalid commands RETURN a RuleError — the reducer never throws for rule
 * outcomes, so callers can branch on a discriminated result. Handlers may
 * throw RuleError internally; applyCommand converts that into a returned
 * error before any state change is committed.
 */

export const RULE_ERROR_CODES = [
  /** Envelope or payload failed schema validation (pipeline step 1). */
  'INVALID_SHAPE',
  /** gameId does not match this game (pipeline step 2). */
  'UNKNOWN_GAME',
  /** actorId is not a player in this game (pipeline step 2). */
  'UNKNOWN_PLAYER',
  /** expectedVersion does not match the current state version (pipeline step 3). */
  'VERSION_CONFLICT',
  /** The actor may not issue this command now (pipeline step 5): not the
   *  active player, not an eligible bidder, not the designated trade
   *  recipient, not the debtor, or not a live player. */
  'NOT_AUTHORIZED',
  /** No handler implements this command in this rules build; its PR has not landed. */
  'COMMAND_NOT_IMPLEMENTED',
  /** The command is not valid in the game's current phase (pipeline step 6). */
  'INVALID_PHASE',
  /** The game is over — every command is rejected (spec §4 row 17). */
  'GAME_IS_OVER',
  /** The command would spend resources the actor does not have (pipeline step 7). */
  'INSUFFICIENT_RESOURCES',
  /** The command violates a rule constraint (pipeline step 8). */
  'RULE_VIOLATION',
  /** The debt cannot be resolved even with maximum liquidation (spec §7):
   *  every command except SURRENDER is refused while the debt is hopeless;
   *  SURRENDER runs the bankruptcy waterfall (PR 8). */
  'DEBT_HOPELESS',
  /** A replay or load met an event log or snapshot produced under unsupported rules (spec §3). */
  'RULES_VERSION_UNSUPPORTED',
] as const;

export type RuleErrorCode = (typeof RULE_ERROR_CODES)[number];

/** Structured, serializable rule violation. */
export class RuleError extends Error {
  readonly code: RuleErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RuleErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
    this.details = details;
  }
}
