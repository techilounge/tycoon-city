/**
 * The reducer: createGame and applyCommand — the engine's only entry points
 * (spec §2.1, §2.3).
 *
 * PR 2 is the foundation skeleton: the full 8-step validation pipeline,
 * idempotency, optimistic-concurrency versioning, authorization, purity, and
 * event stamping. Game-rule handlers arrive with PRs 4–8 and plug into the
 * HANDLERS registry; until then every game command rejects with
 * COMMAND_NOT_IMPLEMENTED so no half-built rule can run.
 *
 * Purity is structural: applyCommand clones the state before any handler
 * runs, so the input state is never mutated — rejections and successes alike
 * leave it deep-equal untouched. There is no wall-clock and no ambient
 * randomness here; the only randomness is the injected RandomSource whose
 * state word is persisted back into GameState.
 */
import { validateCommandShape, type CommandType, type GameCommand } from '../commands';
import { BOARD_LOOP_SIZE, BOARD_SPACES, MODES, MODE_IDS, START_BONUS, isPurchasable, type ModeId } from '../board-v1';
import { stampEvents, type AnyEventInput, type AnyGameEvent } from '../events';
import { rngForState, type RandomSource } from '../rng';
import { MAX_PLAYERS, MIN_PLAYERS, RULES_VERSION, type GameState, type PlayerId } from '../types';
import { RuleError } from './errors';
import { moveForward, nearestParkIndex } from './movement';
import { resolveLanding } from './economy';
import { isDebtHopeless, mortgageHandler, settleDebtHandler, sellUpgradeHandler } from './debt';
import type { GameStateDraft, DraftPlayer } from './draft';
import { requirePlayer } from './draft';

export { requirePlayer } from './draft';
export type { GameStateDraft, DraftPlayer } from './draft';

/** Success carries the new state, the stamped events, and whether the command
 *  applied (false for idempotent duplicates, which apply nothing). Failure
 *  carries the typed RuleError; the previous state is never mutated. */
export type CommandResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly AnyGameEvent[]; readonly applied: boolean }
  | { readonly ok: false; readonly error: RuleError };

export type CreateGameResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly AnyGameEvent[] }
  | { readonly ok: false; readonly error: RuleError };

export interface CreateGameInput {
  readonly gameId: string;
  readonly seed: number;
  readonly playerIds: readonly PlayerId[];
  /** Game mode (spec §8); defaults to CLASSIC. Fixed at creation. */
  readonly mode?: ModeId;
}

/**
 * The engine's randomness contract: the caller supplies the source; the
 * reducer draws from it during the command and persists its resulting word
 * into state.rngState. Canonical wiring is rngForState(state.rngState), so
 * live play, replay, and post-snapshot continuation draw identically (spec §3).
 */
export function applyCommand(state: GameState, command: GameCommand, rng: RandomSource): CommandResult {
  // (1) shape — full schema check of the raw envelope and payload.
  const shapeError = validateCommandShape(command);
  if (shapeError) return err(shapeError);

  // (2) existence — the game, and the actor as a player in it.
  if (command.gameId !== state.gameId) {
    return err(new RuleError('UNKNOWN_GAME', `command targets game ${command.gameId}, but this game is ${state.gameId}`, {
      expected: state.gameId,
      received: command.gameId,
    }));
  }
  if (!state.players.some((player) => player.id === command.actorId)) {
    return err(new RuleError('UNKNOWN_PLAYER', `actor ${command.actorId} is not a player in this game`, { actorId: command.actorId }));
  }

  // (4, pre-read) idempotency ledger membership. Computed here so the version
  // check below can be idempotency-aware.
  const alreadyProcessed = state.processedCommandIds.includes(command.commandId);

  // (3) version — optimistic concurrency. A retry of an already-processed
  // command carries its ORIGINAL expectedVersion, so the check must exempt
  // processed ids; otherwise every legitimate retry would fail with
  // VERSION_CONFLICT before step 4 could return the idempotent result.
  if (!alreadyProcessed && command.expectedVersion !== state.version) {
    return err(new RuleError('VERSION_CONFLICT', `command was composed against version ${command.expectedVersion}, but the game is at version ${state.version}`, {
      expectedVersion: command.expectedVersion,
      currentVersion: state.version,
    }));
  }

  // (4) idempotency — a processed commandId is a successful retry: return the
  // current state, apply nothing. (The transport layer owns the original
  // events and returns them to the caller; see LocalCommandSink.)
  if (alreadyProcessed) {
    return { ok: true, state, events: [], applied: false };
  }

  // (6a) game over — row 17 of the phase table: every command is rejected.
  // Checked before authorization because a finished game admits no actor.
  if (state.phase === 'GAME_OVER') {
    return err(new RuleError('GAME_IS_OVER', 'the game is over; no commands are accepted'));
  }

  // (6b) Transitional settlement seam (spec §17.2): a debt that cash plus the
  // maximum liquidation value cannot cover pauses the game — every command
  // rejects atomically with a typed error and the state stays deep-equal
  // unchanged. PR 8's SURRENDER replaces this rejection with the waterfall;
  // negative tests pin both the rejection and the emitted-event ban.
  if (state.turnPhase === 'SETTLING_DEBT' && state.debt !== null && isDebtHopeless(state, state.debt)) {
    return err(
      new RuleError(
        'DEBT_UNRESOLVABLE',
        `the ${state.debt.reason.toLowerCase()} debt of ${state.debt.amountDue} exceeds everything player ${state.debt.debtorId} can raise; settlement is impossible in this rules build`,
        { debtorId: state.debt.debtorId, creditorId: state.debt.creditorId, amountDue: state.debt.amountDue },
      ),
    );
  }

  // (5) authorization — pure predicate reused verbatim by the Phase 2 server.
  if (!canAct(state, command)) {
    return err(new RuleError('NOT_AUTHORIZED', `player ${command.actorId} may not issue ${command.type} now`, {
      actorId: command.actorId,
      type: command.type,
      activePlayerId: state.activePlayerId,
    }));
  }

  const handler = HANDLERS[command.type];
  if (!handler) {
    return err(new RuleError('COMMAND_NOT_IMPLEMENTED', `command ${command.type} is not implemented by this rules build; its PR has not landed`, {
      type: command.type,
    }));
  }

  // (6b/7/8) phase, resources, and rule constraints live inside the handler.
  // Handlers may throw RuleError for rule outcomes; the throw aborts before
  // the draft below is committed, so purity holds. Any other error is a bug
  // and is rethrown — never swallowed.
  const draft = structuredClone(state) as GameStateDraft;
  let eventDrafts: readonly AnyEventInput[];
  try {
    eventDrafts = handler(draft, command, rng);
  } catch (caught) {
    if (caught instanceof RuleError) return err(caught);
    throw caught;
  }

  const events = stampEvents(state.gameId, state.lastEventSequence + 1, eventDrafts, state.rulesVersion, command.commandId);

  // Commit — bookkeeping on the private draft only.
  draft.version = state.version + 1;
  draft.processedCommandIds = [...state.processedCommandIds, command.commandId];
  draft.lastEventSequence = state.lastEventSequence + events.length;
  draft.rngState = rng.getState() >>> 0;

  return { ok: true, state: draft, events, applied: true };
}

/**
 * Pure authorization predicate (spec §10) — shipped now and reused verbatim
 * by the Phase 2 server. PR 2 covers the machinery commands; the remaining
 * actor classes join as their rules land: eligible auction bidders (PR 6),
 * designated trade recipients (PR 7), and debt-settlement actors (PR 5's
 * settlement commands run in SETTLING_DEBT, where the debtor IS the active
 * player, so the active-player default already covers them). PR 8 adds the
 * elimination-auction and estate cases.
 */
export function canAct(state: GameState, command: GameCommand): boolean {
  const actor = state.players.find((player) => player.id === command.actorId);
  if (!actor || actor.eliminated) return false;
  switch (command.type) {
    case 'START_GAME':
    case 'SAVE_SNAPSHOT':
      // Hot-seat device actions: any live player at the controls.
      return true;
    default:
      // Turn-scoped commands default to the active player (spec §10).
      return state.activePlayerId === command.actorId;
  }
}

type CommandHandler = (draft: GameStateDraft, command: GameCommand, rng: RandomSource) => readonly AnyEventInput[];

function startGameHandler(draft: GameStateDraft): readonly AnyEventInput[] {
  if (draft.phase !== 'LOBBY') {
    throw new RuleError('INVALID_PHASE', `START_GAME is only valid in LOBBY, not ${draft.phase}`, { phase: draft.phase });
  }
  const first = draft.players[0];
  draft.phase = 'PLAYING';
  draft.turnPhase = 'AWAITING_ROLL';
  draft.turn = 1;
  draft.activePlayerId = first.id;
  return [{ type: 'TURN_STARTED', payload: { playerId: first.id, turn: 1 } }];
}

function saveSnapshotHandler(draft: GameStateDraft): readonly AnyEventInput[] {
  // stateVersion is the version this command produces (pre-increment view).
  return [{ type: 'SNAPSHOT_SAVED', payload: { stateVersion: draft.version + 1 } }];
}

/**
 * Hand the turn to the next player in seat order — the shared tail of rows
 * 2, 4, and 12. The doubles counter resets on a turn pass (spec §4); marked
 * players have their next-turn skip consumed as TURN_SKIPPED + TURN_ENDED
 * pairs; the first unmarked player begins the next turn ordinal. Skipped
 * players consume an ordinal — a round is one pass through the seats (PR 8's
 * round cap builds on this). Prerequisite: TURN_ENDED for the ending player
 * was already emitted by the caller.
 */
function advanceToNextTurn(draft: GameStateDraft, fromPlayerId: PlayerId): readonly AnyEventInput[] {
  draft.doublesCount = 0;
  const from = requirePlayer(draft, fromPlayerId);
  const count = draft.players.length;
  const events: AnyEventInput[] = [];
  let turnCounter = draft.turn;
  let chosen: DraftPlayer | undefined;
  // players is seat-ordered by construction (createGame maps seat = index).
  // Two laps bound the walk: one lap can consume every mark (when all players
  // are marked), so the first unmarked seat may only appear on the second.
  for (let step = 1; step <= 2 * count && !chosen; step++) {
    const candidate = draft.players[(from.seat + step) % count];
    turnCounter += 1;
    if (!candidate.skipNextTurn) {
      chosen = candidate;
    } else {
      candidate.skipNextTurn = false;
      events.push({ type: 'TURN_SKIPPED', payload: { playerId: candidate.id, reason: 'THIRD_DOUBLES' } });
      events.push({ type: 'TURN_ENDED', payload: { playerId: candidate.id, turn: turnCounter } });
    }
  }
  if (!chosen) throw new Error('engine bug: turn handover found no eligible player');
  draft.turn = turnCounter;
  draft.activePlayerId = chosen.id;
  draft.turnPhase = 'AWAITING_ROLL';
  events.push({ type: 'TURN_STARTED', payload: { playerId: chosen.id, turn: turnCounter } });
  return events;
}

/** Row 1: roll two d6; row 3 resolves the move automatically inside the same
 *  command; row 4 intercepts the third consecutive double. */
function rollHandler(draft: GameStateDraft, command: GameCommand, rng: RandomSource): readonly AnyEventInput[] {
  if (draft.turnPhase !== 'AWAITING_ROLL') {
    throw new RuleError('INVALID_PHASE', `ROLL is only valid in AWAITING_ROLL, not ${String(draft.turnPhase)}`, { phase: draft.turnPhase });
  }
  const player = requirePlayer(draft, command.actorId);
  // Two d6 draws, die1 then die2 — call order is replay-stable (spec §3).
  const die1 = rng.nextInt(6) + 1;
  const die2 = rng.nextInt(6) + 1;
  const dice = [die1, die2] as const;
  const events: AnyEventInput[] = [{ type: 'DICE_ROLLED', payload: { playerId: player.id }, meta: { dice } }];

  const doubles = die1 === die2;
  draft.doublesCount = doubles ? draft.doublesCount + 1 : 0;

  // Row 4: third consecutive doubles — the roll does not move the token by
  // its dice; the token is relocated to the nearest park, the player's next
  // turn is skipped, and the turn ends without a management phase.
  if (doubles && draft.doublesCount >= 3) {
    const parkIndex = nearestParkIndex(player.position, BOARD_SPACES);
    events.push({ type: 'PLAYER_MOVED', payload: { playerId: player.id, from: player.position, to: parkIndex, direction: 'FORWARD' } });
    player.position = parkIndex;
    player.skipNextTurn = true;
    draft.doublesCount = 0;
    // The penalty relocation never pays the start bonus — even when the
    // forward park walk crosses Gateway Terminal (row 3 grants the bonus on
    // dice and card moves only; genre penalty convention). Pinned by test.
    events.push({ type: 'TURN_ENDED', payload: { playerId: player.id, turn: draft.turn } });
    events.push(...advanceToNextTurn(draft, player.id));
    return events;
  }

  // Row 3 (automatic): advance the token, pay the start bonus on any forward
  // pass or landing of Gateway Terminal, then resolve the landed space.
  const move = moveForward(player.position, die1 + die2, BOARD_LOOP_SIZE);
  events.push({ type: 'PLAYER_MOVED', payload: { playerId: player.id, from: player.position, to: move.toIndex, direction: move.direction } });
  player.position = move.toIndex;
  if (move.passesGateway) {
    player.cash += START_BONUS;
    events.push({ type: 'START_BONUS_PAID', payload: { playerId: player.id, amount: START_BONUS } });
  }
  // Row 3 (automatic): advance the token, pay the start bonus on any forward
  // pass or landing of Gateway Terminal (never on backward movement), then
  // resolve the landed space — rent, taxes, service charges, and Event-Deck
  // draws, each of which may pause the turn in SETTLING_DEBT (spec §4 row 3,
  // §7, §8).
  events.push(...resolveLanding(draft, player.id, die1 + die2, rng));
  // A charge that shorted the payer has already set SETTLING_DEBT; otherwise
  // an unowned purchasable resting space opens the buy decision (row 5) and
  // everything else proceeds to management (row 9).
  if (!draft.debt) {
    const resting = BOARD_SPACES[player.position];
    draft.turnPhase = isPurchasable(resting) && !(resting.id in draft.owners) ? 'BUY_DECISION' : 'TURN_MANAGEMENT';
  }
  return events;
}

/** Row 2: consume a Hold token and skip the holder's entire current turn. */
function holdHandler(draft: GameStateDraft, command: GameCommand): readonly AnyEventInput[] {
  if (draft.turnPhase !== 'AWAITING_ROLL') {
    throw new RuleError('INVALID_PHASE', `HOLD is only valid in AWAITING_ROLL, not ${String(draft.turnPhase)}`, { phase: draft.turnPhase });
  }
  const player = requirePlayer(draft, command.actorId);
  if (player.tokens.HOLD < 1) {
    throw new RuleError('INSUFFICIENT_RESOURCES', `player ${player.id} holds no Hold token`, { token: 'HOLD', held: player.tokens.HOLD });
  }
  player.tokens = { ...player.tokens, HOLD: player.tokens.HOLD - 1 };
  const events: AnyEventInput[] = [
    { type: 'TOKEN_CONSUMED', payload: { playerId: player.id, token: 'HOLD' } },
    { type: 'TURN_SKIPPED', payload: { playerId: player.id, reason: 'HOLD_TOKEN' } },
    { type: 'TURN_ENDED', payload: { playerId: player.id, turn: draft.turn } },
  ];
  // Victory check seam (PR 8): evaluated at every TURN_ENDED (spec §4, §8).
  events.push(...advanceToNextTurn(draft, player.id));
  return events;
}

/** Row 5: buy the token's unowned purchasable space at list price. */
function buyHandler(draft: GameStateDraft, command: GameCommand): readonly AnyEventInput[] {
  if (draft.turnPhase !== 'BUY_DECISION') {
    throw new RuleError('INVALID_PHASE', `BUY is only valid in BUY_DECISION, not ${String(draft.turnPhase)}`, { phase: draft.turnPhase });
  }
  const player = requirePlayer(draft, command.actorId);
  const landed = BOARD_SPACES[player.position];
  if (!isPurchasable(landed)) {
    throw new RuleError('RULE_VIOLATION', `space ${landed.id} is not purchasable`, { spaceId: landed.id, kind: landed.kind });
  }
  if (landed.id in draft.owners) {
    throw new RuleError('RULE_VIOLATION', `space ${landed.id} is already owned`, { spaceId: landed.id, ownerId: draft.owners[landed.id] });
  }
  // The registry correlates type and payload; TS cannot carry that through
  // the handler union — same documented cast as stampEvents.
  const requested = (command.payload as { readonly spaceId?: string }).spaceId;
  if (requested !== undefined && requested !== landed.id) {
    throw new RuleError('RULE_VIOLATION', `payload spaceId ${requested} does not match the token's space ${landed.id}`, { spaceId: requested, expected: landed.id });
  }
  if (player.cash < landed.listPrice) {
    throw new RuleError('INSUFFICIENT_RESOURCES', `buying ${landed.id} costs ${landed.listPrice}; player ${player.id} holds ${player.cash}`, { needed: landed.listPrice, cash: player.cash });
  }
  player.cash -= landed.listPrice;
  draft.owners = { ...draft.owners, [landed.id]: player.id };
  draft.turnPhase = 'TURN_MANAGEMENT';
  // via is always DIRECT here — AUCTION purchases arrive with PR 6.
  return [{ type: 'PROPERTY_PURCHASED', payload: { playerId: player.id, spaceId: landed.id, amount: landed.listPrice, via: 'DIRECT' } }];
}

/**
 * Row 6 (TRANSITIONAL — replaced by PR 6): the AUCTION phase and its BID /
 * PASS_BID commands are PR 6 (spec §12 rows 6–8). Declining in PR 4 parks
 * the space with the bank, unowned, and the turn proceeds. Zero events is
 * the honest log — no money or ownership changed. PR 6 replaces this
 * handler's tail with AUCTION_OPENED + the AUCTION phase, mirroring the
 * §17.2 replacement-seam pattern.
 */
function passToAuctionHandler(draft: GameStateDraft): readonly AnyEventInput[] {
  if (draft.turnPhase !== 'BUY_DECISION') {
    throw new RuleError('INVALID_PHASE', `PASS_TO_AUCTION is only valid in BUY_DECISION, not ${String(draft.turnPhase)}`, { phase: draft.turnPhase });
  }
  draft.turnPhase = 'TURN_MANAGEMENT';
  return [];
}

/** Row 12: end the turn — doubles grant exactly one extra cycle, else hand over. */
function endTurnHandler(draft: GameStateDraft, command: GameCommand): readonly AnyEventInput[] {
  if (draft.turnPhase !== 'TURN_MANAGEMENT') {
    throw new RuleError('INVALID_PHASE', `END_TURN is only valid in TURN_MANAGEMENT, not ${String(draft.turnPhase)}`, { phase: draft.turnPhase });
  }
  const player = requirePlayer(draft, command.actorId);
  const events: AnyEventInput[] = [{ type: 'TURN_ENDED', payload: { playerId: player.id, turn: draft.turn } }];
  // Doubles extra cycle: same player, same turn ordinal, straight back to
  // AWAITING_ROLL (spec §4 row 12). The counter cannot be 3 here — the third
  // consecutive double ends the turn inside ROLL (row 4).
  // Pending-offer expiry (PR 7) runs only when the turn passes; victory
  // checks are PR 8's seam at every TURN_ENDED.
  if (draft.doublesCount > 0 && draft.doublesCount < 3) {
    draft.turnPhase = 'AWAITING_ROLL';
    events.push({ type: 'TURN_STARTED', payload: { playerId: player.id, turn: draft.turn } });
    return events;
  }
  events.push(...advanceToNextTurn(draft, player.id));
  return events;
}

/** Rules PRs (5–8) add handlers here; the pipeline itself is closed. */
const HANDLERS: { [T in CommandType]?: CommandHandler } = {
  START_GAME: startGameHandler,
  SAVE_SNAPSHOT: saveSnapshotHandler,
  ROLL: rollHandler,
  HOLD: holdHandler,
  BUY: buyHandler,
  PASS_TO_AUCTION: passToAuctionHandler,
  SETTLE_DEBT: settleDebtHandler,
  SELL_UPGRADE: sellUpgradeHandler,
  MORTGAGE: mortgageHandler,
  END_TURN: endTurnHandler,
};

/**
 * The initial fold entry: build a LOBBY state from a lobby-generated seed and
 * a fixed player order, emitting GAME_CREATED as sequence 1. The seed is the
 * initial RNG word (spec §3). Not a command — the Phase 2 server calls this
 * exactly like the local lobby does.
 */
export function createGame(input: CreateGameInput): CreateGameResult {
  const { gameId, seed, playerIds } = input;
  const mode = input.mode ?? 'CLASSIC';
  if (typeof gameId !== 'string' || gameId.length === 0) {
    return { ok: false, error: new RuleError('INVALID_SHAPE', 'gameId must be a non-empty string', { field: 'gameId' }) };
  }
  if (!(MODE_IDS as readonly string[]).includes(mode)) {
    return { ok: false, error: new RuleError('INVALID_SHAPE', `mode must be one of ${MODE_IDS.join(', ')}`, { field: 'mode', found: mode }) };
  }
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return { ok: false, error: new RuleError('INVALID_SHAPE', 'seed must be a uint32', { field: 'seed' }) };
  }
  if (
    !Array.isArray(playerIds) ||
    playerIds.length < MIN_PLAYERS ||
    playerIds.length > MAX_PLAYERS ||
    new Set(playerIds).size !== playerIds.length ||
    playerIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return {
      ok: false,
      error: new RuleError('INVALID_SHAPE', `playerIds must be ${MIN_PLAYERS}–${MAX_PLAYERS} unique non-empty strings`, {
        field: 'playerIds',
        count: Array.isArray(playerIds) ? playerIds.length : 'not-an-array',
      }),
    };
  }

  const state = {
    gameId,
    version: 0,
    phase: 'LOBBY',
    turnPhase: null,
    mode,
    doublesCount: 0,
    owners: {},
    upgrades: {},
    mortgaged: {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: null,
    rulesVersion: RULES_VERSION,
    seed,
    rngState: seed >>> 0,
    // Tokens are PLACED on Gateway Terminal (index 0) — placement is not a
    // landing and pays no bonus; the first roll grants it only on a pass.
    players: playerIds.map((id, seat) => ({
      id,
      seat,
      eliminated: false,
      position: 0,
      cash: MODES[mode].startingCash,
      tokens: { HOLD: 0, RENT_HOLIDAY: 0 },
      skipNextTurn: false,
    })),
    activePlayerId: null,
    turn: 0,
    lastEventSequence: 0,
    processedCommandIds: [],
  } as GameState;
  const events = stampEvents(gameId, 1, [{ type: 'GAME_CREATED', payload: { playerIds: [...playerIds] } }]);
  return { ok: true, state: { ...state, lastEventSequence: 1 }, events };
}

function err(error: RuleError): CommandResult {
  return { ok: false, error };
}
