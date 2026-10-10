/**
 * The demonstration driver (spec §8 + §17.3).
 *
 * Simulated actors (./profiles) drive the REAL CommandSink — the Phase 1
 * LocalCommandSink, the same class the hot-seat UI submits through — over
 * complete headless games. Every simulated game is a multiplayer-contract
 * demonstration: interleaved with ordinary play, the driver enforces all
 * four §17.3 assertions and throws the moment any of them fails:
 *
 *   (a) authorization — a non-active live player's ROLL is rejected
 *       (NOT_AUTHORIZED) and leaves the state untouched;
 *   (b) optimistic concurrency — a command composed against a stale
 *       expectedVersion is rejected (VERSION_CONFLICT), state untouched;
 *   (c) idempotency — resubmitting a processed commandId verbatim returns
 *       ok with `applied: false` and changes nothing (applied exactly once);
 *   (d) replay — the full ordered submission log (probes included) refolds
 *       from { seed, mode, players } to an identical state hash.
 *
 * Probes are state-neutral (rejections apply nothing; duplicates apply
 * nothing), so demonstration games ARE the §8 economy games — the metrics
 * in ./metrics never see probe noise.
 */
import type { GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import { mulberry32, type RandomSource } from '../../src/lib/game/rng';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import { createGame, type CommandResult } from '../../src/lib/game/engine/reducer';
import { LocalCommandSink } from '../../src/lib/game/engine/transport';
import type { GameState, PlayerId } from '../../src/lib/game/types';
import { MODES, type ModeId } from '../../src/lib/game/board-v1';
import { profileForSeat, strategyFor, type Strategy } from './profiles';

/** Harness bugs (not rule outcomes) throw immediately — never swallowed. */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export interface SimGameInput {
  readonly gameId: string;
  readonly seed: number;
  readonly mode: ModeId;
  readonly playerIds: readonly PlayerId[];
}

/** §17.3 demonstration record for one game. */
export interface DemonstrationRecord {
  /** (a) rejected unauthorized-actor probes observed. */
  readonly unauthorizedActorRejections: number;
  /** (b) rejected stale-version probes observed. */
  readonly staleVersionRejections: number;
  /** (c) idempotent duplicate replays observed (applied exactly once). */
  readonly idempotentReplays: number;
  /** (d) replay refolded to the live final state hash. */
  readonly replayVerified: boolean;
  readonly liveFinalHash: string | null;
  readonly replayFinalHash: string | null;
  /** All four assertions held for this game. */
  readonly allGreen: boolean;
}

export interface SimGameResult {
  readonly input: SimGameInput;
  /** Every submission in order — probes and duplicates included; the replay input. */
  readonly commands: readonly GameCommand[];
  /** The full stamped event log (GAME_CREATED → GAME_ENDED). */
  readonly events: readonly AnyGameEvent[];
  readonly finalState: GameState;
  readonly demonstration: DemonstrationRecord;
  /** Submissions that applied (probes and duplicates never count). */
  readonly appliedCommands: number;
  readonly submittedCommands: number;
}

/** Hard bounds — a strategy that exceeds them is a harness bug. */
const MAX_SUBMISSIONS = 250_000;
const MAX_MANAGEMENT_ACTIONS_PER_TURN = 200;
const MAX_NEGOTIATION_DEPTH = 3;

export async function runSimulatedGame(input: SimGameInput): Promise<SimGameResult> {
  const { gameId, seed, mode, playerIds } = input;
  if (playerIds.length < 2 || playerIds.length > 6) {
    throw new HarnessError(`sim needs 2–6 players, got ${playerIds.length}`);
  }
  if (playerIds.length > MODES[mode].roundCap) {
    // No mode constraint requires this, but a game longer than its cap's
    // handovers cannot exist; kept as a cheap structural sanity check.
    throw new HarnessError('player count exceeds mode round cap');
  }

  const sink = LocalCommandSink.create({ gameId, seed, playerIds, mode });
  const events: AnyGameEvent[] = [];
  sink.events.subscribe(gameId, 0, (event) => events.push(event));

  const strategies: readonly Strategy[] = playerIds.map((_, seat) => strategyFor(profileForSeat(seat)));
  // Per-seat actor randomness, derived from the game seed — independent of
  // the engine's RNG word (profiles never draw from the game's source).
  const actorRngs: readonly RandomSource[] = playerIds.map((_, seat) =>
    mulberry32((seed ^ (0x9e3779b9 * (seat + 1))) >>> 0),
  );

  const commands: GameCommand[] = [];
  let appliedCommands = 0;
  let lastApplied: GameCommand | null = null;
  const demonstration = {
    unauthorizedActorRejections: 0,
    staleVersionRejections: 0,
    idempotentReplays: 0,
    replayVerified: false,
    liveFinalHash: null as string | null,
    replayFinalHash: null as string | null,
  };

  const stateOf = (): GameState => sink.state();

  const submit = async (command: GameCommand): Promise<CommandResult> => {
    if (commands.length >= MAX_SUBMISSIONS) {
      throw new HarnessError(`game ${gameId} exceeded the ${MAX_SUBMISSIONS}-submission bound — strategy livelock`);
    }
    commands.push(command);
    const result = await sink.submit(command);
    if (result.ok && result.applied) {
      appliedCommands += 1;
      lastApplied = command;
    }
    return result;
  };

  /** A strategy command must apply — anything else is strategy-invalid. */
  const submitOrThrow = async (command: GameCommand, where: string): Promise<void> => {
    const result = await submit(command);
    if (!result.ok) {
      throw new HarnessError(
        `game ${gameId} ${where}: strategy produced an illegal ${command.type} (${result.error.code}: ${result.error.message})`,
      );
    }
  };

  const commandFor = (type: GameCommand['type'], actorId: PlayerId, payload: Record<string, unknown> = {}): GameCommand => {
    return {
      commandId: `sim-${commands.length + 1}`,
      gameId,
      actorId,
      expectedVersion: stateOf().version,
      type,
      payload,
    } as GameCommand;
  };

  // --- §17.3 probes (a)(b)(c) — each asserts rejection-or-noop + hash stability.

  const hashBefore = (): string => stateHash(stateOf());

  const probeUnauthorizedActor = async (): Promise<void> => {
    const state = stateOf();
    const active = state.activePlayerId;
    if (active === null) throw new HarnessError('probe (a) ran with no active player');
    const other = strategies
      .map((_, i) => state.players[i])
      .find((player) => !player.eliminated && player.id !== active);
    if (!other) throw new HarnessError('probe (a) found no second live player');
    const before = hashBefore();
    const result = await submit(commandFor('ROLL', other.id));
    if (result.ok || result.error.code !== 'NOT_AUTHORIZED') {
      throw new HarnessError(`§17.3(a) FAILED: unauthorized actor's ROLL was not rejected with NOT_AUTHORIZED (${JSON.stringify(result.ok ? 'applied' : result.error.code)})`);
    }
    if (stateHash(stateOf()) !== before) throw new HarnessError('§17.3(a) FAILED: rejection mutated state');
    demonstration.unauthorizedActorRejections += 1;
  };

  const probeStaleVersion = async (): Promise<void> => {
    const state = stateOf();
    const active = state.activePlayerId;
    if (active === null || state.version < 1) throw new HarnessError('probe (b) ran in an impossible state');
    const before = hashBefore();
    const stale = { ...commandFor('ROLL', active), expectedVersion: state.version - 1, commandId: `sim-probe-b-${commands.length + 1}` } as GameCommand;
    const result = await submit(stale);
    if (result.ok || result.error.code !== 'VERSION_CONFLICT') {
      throw new HarnessError(`§17.3(b) FAILED: stale expectedVersion was not rejected with VERSION_CONFLICT (${JSON.stringify(result.ok ? 'applied' : result.error.code)})`);
    }
    if (stateHash(stateOf()) !== before) throw new HarnessError('§17.3(b) FAILED: rejection mutated state');
    demonstration.staleVersionRejections += 1;
  };

  const probeIdempotency = async (): Promise<void> => {
    if (lastApplied === null) throw new HarnessError('probe (c) ran before any applied command');
    const before = hashBefore();
    const result = await submit(lastApplied);
    if (!result.ok || result.applied !== false) {
      throw new HarnessError(`§17.3(c) FAILED: duplicate commandId did not return ok/applied:false (${JSON.stringify(result.ok ? result.applied : result.error.code)})`);
    }
    if (stateHash(stateOf()) !== before) throw new HarnessError('§17.3(c) FAILED: duplicate application mutated state');
    demonstration.idempotentReplays += 1;
  };

  // --- Phase-walking sub-protocols.

  const negotiation = async (): Promise<void> => {
    for (let depth = 0; depth < MAX_NEGOTIATION_DEPTH; depth++) {
      const pending = stateOf().trade;
      if (!pending) return;
      const responder = pending.recipientId;
      const seat = playerIds.indexOf(responder);
      const strategy = strategies[seat];
      if (!strategy) throw new HarnessError(`negotiation found no strategy for ${responder}`);
      const decision = strategy.decideAnswer(stateOf(), responder, actorRngs[seat] as RandomSource, depth);
      const command = commandFor('ANSWER_TRADE', responder, {
        tradeId: pending.tradeId,
        ...(decision.response === 'COUNTER'
          ? { response: decision.response, counterOffer: decision.counterOffer }
          : { response: decision.response }),
      });
      await submitOrThrow(command, 'negotiation');
    }
    // Depth bound hit with an offer still pending: reject it (deterministic).
    const pending = stateOf().trade;
    if (pending) {
      await submitOrThrow(
        commandFor('ANSWER_TRADE', pending.recipientId, { tradeId: pending.tradeId, response: 'REJECT' }),
        'negotiation depth bound',
      );
    }
  };

  const auctionProtocol = async (): Promise<void> => {
    while (stateOf().auction !== null) {
      const auction = stateOf().auction;
      if (!auction) break;
      const openId = auction.auctionId;
      for (const player of stateOf().players) {
        const current = stateOf().auction;
        if (!current || current.auctionId !== openId) break; // resolved mid-round
        if (player.eliminated) continue;
        if (current.passedPlayerIds.includes(player.id)) continue;
        if (current.highBidderId === player.id) continue; // holds the bid — cannot pass
        const seat = playerIds.indexOf(player.id);
        const decision = strategies[seat]?.decideBid(stateOf(), player.id, actorRngs[seat] as RandomSource);
        if (!decision) throw new HarnessError(`auction found no strategy for ${player.id}`);
        const command =
          decision.action === 'BID'
            ? commandFor('BID', player.id, { auctionId: current.auctionId, amount: decision.amount })
            : commandFor('PASS_BID', player.id, { auctionId: current.auctionId });
        await submitOrThrow(command, 'auction');
      }
    }
  };

  const settlementProtocol = async (): Promise<void> => {
    while (stateOf().turnPhase === 'SETTLING_DEBT') {
      const state = stateOf();
      const debtor = state.debt?.debtorId;
      if (!debtor) throw new HarnessError('settlement phase without a debt');
      const seat = playerIds.indexOf(debtor);
      const step = strategies[seat]?.decideSettlement(state, debtor, actorRngs[seat] as RandomSource);
      if (!step) throw new HarnessError(`settlement found no strategy for ${debtor}`);
      const command =
        step.action === 'SETTLE_DEBT'
          ? commandFor('SETTLE_DEBT', debtor)
          : step.action === 'SURRENDER'
            ? commandFor('SURRENDER', debtor)
            : commandFor(step.action, debtor, { spaceId: step.spaceId });
      const result = await submit(command);
      if (!result.ok) {
        if (result.error.code === 'DEBT_HOPELESS' && step.action !== 'SURRENDER') {
          // §7: only SURRENDER passes the hopeless veto — force it.
          await submitOrThrow(commandFor('SURRENDER', debtor), 'hopeless debt');
          continue;
        }
        throw new HarnessError(`game ${gameId}: settlement ${step.action} rejected (${result.error.code}: ${result.error.message})`);
      }
    }
  };

  const managementProtocol = async (): Promise<void> => {
    const context: { tradesProposedThisTurn: number } = { tradesProposedThisTurn: 0 };
    for (let action = 0; action < MAX_MANAGEMENT_ACTIONS_PER_TURN; action++) {
      const state = stateOf();
      if (state.turnPhase !== 'TURN_MANAGEMENT' || state.phase !== 'PLAYING') return;
      const actor = state.activePlayerId;
      if (actor === null) throw new HarnessError('management phase with no active player');
      const seat = playerIds.indexOf(actor);
      const decision = strategies[seat]?.decideManagement(state, actor, actorRngs[seat] as RandomSource, {
        actionsThisTurn: action,
        tradesProposedThisTurn: context.tradesProposedThisTurn,
      });
      if (!decision) throw new HarnessError(`management found no strategy for ${actor}`);
      if (decision.action === 'END_TURN') {
        await submitOrThrow(commandFor('END_TURN', actor), 'management');
        return;
      }
      if (decision.action === 'OFFER_TRADE') {
        const result = await submit(
          commandFor('OFFER_TRADE', actor, { recipientId: decision.recipientId, offer: decision.offer }),
        );
        if (!result.ok) throw new HarnessError(`game ${gameId}: OFFER_TRADE rejected (${result.error.code}: ${result.error.message})`);
        context.tradesProposedThisTurn += 1;
        await negotiation();
        continue;
      }
      await submitOrThrow(commandFor(decision.action, actor, { spaceId: decision.spaceId }), 'management');
    }
    throw new HarnessError(`game ${gameId}: management exceeded ${MAX_MANAGEMENT_ACTIONS_PER_TURN} actions`);
  };

  // --- The main walk (spec §4 phase table).

  await submitOrThrow(commandFor('START_GAME', playerIds[0] as PlayerId), 'lobby');

  while (stateOf().phase === 'PLAYING') {
    const state = stateOf();
    switch (state.turnPhase) {
      case 'AWAITING_ROLL': {
        // §17.3 probes (a), (b), (c) — once per roll decision point.
        await probeUnauthorizedActor();
        await probeStaleVersion();
        await probeIdempotency();
        const actor = state.activePlayerId;
        if (actor === null) throw new HarnessError('AWAITING_ROLL with no active player');
        const seat = playerIds.indexOf(actor);
        const decision = strategies[seat]?.decideRoll(state, actor, actorRngs[seat] as RandomSource);
        if (!decision) throw new HarnessError(`roll found no strategy for ${actor}`);
        await submitOrThrow(commandFor(decision.action, actor), 'roll');
        break;
      }
      case 'BUY_DECISION': {
        const actor = state.activePlayerId;
        if (actor === null) throw new HarnessError('BUY_DECISION with no active player');
        const seat = playerIds.indexOf(actor);
        const decision = strategies[seat]?.decideBuy(state, actor, actorRngs[seat] as RandomSource);
        if (!decision) throw new HarnessError(`buy found no strategy for ${actor}`);
        await submitOrThrow(commandFor(decision.action, actor), 'buy decision');
        break;
      }
      case 'AUCTION':
      case 'ELIMINATION_AUCTIONS':
        await auctionProtocol();
        break;
      case 'TURN_MANAGEMENT':
        await managementProtocol();
        break;
      case 'SETTLING_DEBT':
        await settlementProtocol();
        break;
      case 'RESOLVING_MOVE':
      case null:
        throw new HarnessError(`unexpected turn phase ${String(state.turnPhase)} — the driver cannot proceed`);
      default:
        throw new HarnessError(`unexpected turn phase ${String(state.turnPhase)}`);
    }
  }

  if (stateOf().phase !== 'GAME_OVER') throw new HarnessError('game loop exited before GAME_OVER');

  // --- §17.3 (d): replay the whole submission log to an identical hash.

  const liveFinal = stateOf();
  const created = createGame({ gameId, seed, playerIds, mode });
  if (!created.ok) throw new HarnessError(`replay could not recreate game ${gameId}`);
  const replay = replayCommands(created.state, commands);
  const liveHash = stateHash(liveFinal);
  const replayHash = stateHash(replay.state);
  if (liveHash !== replayHash || replay.appliedCount !== appliedCommands) {
    throw new HarnessError(
      `§17.3(d) FAILED: replay hash ${replayHash} (${replay.appliedCount} applied) != live ${liveHash} (${appliedCommands} applied)`,
    );
  }
  demonstration.replayVerified = true;
  demonstration.liveFinalHash = liveHash;
  demonstration.replayFinalHash = replayHash;

  return {
    input,
    commands,
    events,
    finalState: liveFinal,
    demonstration: {
      ...demonstration,
      allGreen:
        demonstration.unauthorizedActorRejections >= 1 &&
        demonstration.staleVersionRejections >= 1 &&
        demonstration.idempotentReplays >= 1 &&
        demonstration.replayVerified,
    },
    appliedCommands,
    submittedCommands: commands.length,
  };
}
