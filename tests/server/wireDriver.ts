/**
 * The networked game driver (spec criteria 2/3): a port of
 * `tools/sim/driver.ts`'s phase machine that drives the REAL gateway over
 * REAL sockets — same strategy profiles, same §17.3 probe skeleton, but
 * every submission is a public `game:command` message and every observation
 * is a public `game:state`/`game:event` broadcast. Nothing here reaches into
 * server internals to play the game; the database is read only for the
 * replay seed and the authoritative final hash (operator privileges —
 * clients never see them).
 */
import type { GameCommand } from '../../src/lib/game/commands';
import type { AnyGameEvent } from '../../src/lib/game/events';
import type { ModeId } from '../../src/lib/game/board-v1';
import { mulberry32, type RandomSource } from '../../src/lib/game/rng';
import { createGame } from '../../src/lib/game/engine/reducer';
import { replayCommands, stateHash } from '../../src/lib/game/engine/replay';
import type { PlayerId, GameState } from '../../src/lib/game/types';
import type { WireCommandResult, SessionAck, WireError } from '../../src/lib/game/transport/protocol';
import { projectClientState, type ClientGameState } from '../../server/game/redact';
import type { Socket as ClientSocket } from 'socket.io-client';
import { profileForSeat, strategyFor, type Strategy } from '../../tools/sim/profiles';
import type { TestHarness } from './helpers';

/** Harness bugs (not rule outcomes) throw immediately — never swallowed. */
export class WireDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireDriverError';
  }
}

/** Hard bounds — a strategy that exceeds them is a harness bug. */
const MAX_SUBMISSIONS = 120_000;
const MAX_MANAGEMENT_ACTIONS_PER_TURN = 200;
const MAX_NEGOTIATION_DEPTH = 3;

/**
 * The profiles read only public fields; the wire client holds the redacted
 * projection. This one cast documents that contract — a profile that reads
 * a private field would see undefined at runtime (and break replay, probe d).
 */
function asGameState(state: ClientGameState): GameState {
  return state as unknown as GameState;
}

/** stateHash over a redacted projection — a change-detector use, never security. */
function hashOf(state: ClientGameState | GameState): string {
  return stateHash(state as GameState);
}

/** A connected client that tracks the authoritative redacted state. */
export class WireClient {
  readonly socket: ClientSocket;
  readonly events: AnyGameEvent[] = [];
  private latest: ClientGameState | null = null;
  private readonly waiters: Array<{ version: number; resolve: () => void }> = [];

  private constructor(socket: ClientSocket) {
    this.socket = socket;
    socket.on('game:state', (state: ClientGameState) => {
      this.latest = state;
      this.waiters.splice(0).forEach((w) => {
        if (state.version >= w.version) w.resolve();
      });
    });
    socket.on('game:event', (event: AnyGameEvent) => {
      this.events.push(event);
    });
  }

  static async connect(harness: TestHarness, auth: Record<string, unknown> = {}): Promise<WireClient> {
    return new WireClient(await harness.connect(auth));
  }

  /** The latest observed redacted state; a fresh client throws — read it only after a state arrived. */
  get state(): ClientGameState {
    if (this.latest === null) throw new WireDriverError('client has not observed any game state yet');
    return this.latest;
  }

  /** Resolves once a state broadcast of at least `version` has been observed. */
  waitForVersion(version: number): Promise<void> {
    if (this.latest !== null && this.latest.version >= version) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ version, resolve }));
  }

  /** Submit a command envelope through the public `game:command` ack. */
  command(command: GameCommand): Promise<WireCommandResult> {
    return new Promise<WireCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new WireDriverError(`command ack timeout (${command.type})`)), 30_000);
      this.socket.emit('game:command', command, (result: WireCommandResult) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }
}

/** A room with its creator and joiners, plus the operator-side replay seed. */
export interface RoomFixture {
  readonly gameId: string;
  readonly roomCode: string;
  /** The server-held seed — an operator/test privilege, never client-visible. */
  readonly seed: number;
  readonly mode: ModeId;
  readonly playerIds: readonly PlayerId[];
  readonly tokens: readonly string[];
  readonly clients: readonly WireClient[];
  /** Operator access to the harness (DB reads: snapshot hash, applied ledger). */
  readonly harness: TestHarness;
}

export interface OpenRoomOptions {
  readonly harness: TestHarness;
  readonly mode: ModeId;
  readonly seatCount: number;
  readonly names?: readonly string[];
}

/** Create a room, join it with `seatCount - 1` more clients, wait for the initial state everywhere. */
export async function openRoom(options: OpenRoomOptions): Promise<RoomFixture> {
  const { harness, mode, seatCount } = options;
  const names = options.names ?? Array.from({ length: seatCount }, (_, i) => `Player ${i + 1}`);

  const creator = await WireClient.connect(harness);
  const created = (await harness.ack(creator.socket, 'game:create', { mode, seatCount, name: names[0] })) as SessionAck;
  if (!created.ok) throw new WireDriverError(`create failed: ${JSON.stringify(created)}`);

  const clients: WireClient[] = [creator];
  const tokens: string[] = [created.token];
  for (let seat = 1; seat < seatCount; seat++) {
    const client = await WireClient.connect(harness);
    const ack = (await harness.ack(client.socket, 'game:join', {
      code: created.roomCode,
      name: names[seat],
    })) as SessionAck | { ok: false; error: WireError };
    if (!ack.ok) throw new WireDriverError(`join failed: ${JSON.stringify(ack)}`);
    clients.push(client);
    tokens.push(ack.token);
  }

  // Every client must hold the initial authoritative state before play begins.
  await Promise.all(clients.map((client) => client.waitForVersion(0)));

  const row = harness.db.getGame(created.gameId);
  if (row === null) throw new WireDriverError('created game row missing');
  const snapshot = harness.db.loadSnapshot(created.gameId);
  if (snapshot === null) throw new WireDriverError('created game snapshot missing');
  return {
    gameId: created.gameId,
    roomCode: created.roomCode,
    seed: snapshot.seed,
    mode,
    playerIds: clients.map((_, seat) => `p${seat + 1}` as PlayerId),
    tokens,
    clients,
    harness,
  };
}

/** §17.3 demonstration record for one networked game. */
export interface NetworkedDemonstration {
  readonly unauthorizedActorRejections: number;
  readonly staleVersionRejections: number;
  readonly idempotentReplays: number;
  /** The public projection of the replayed state matches the live observed one. */
  readonly replayVerified: boolean;
  /** The full replayed state matches the server's authoritative `games.stateHash`. */
  readonly replayFullHashMatchesServer: boolean;
  readonly allGreen: boolean;
}

export interface NetworkedGameResult {
  readonly commands: readonly GameCommand[];
  readonly appliedCommands: number;
  readonly submittedCommands: number;
  readonly demonstration: NetworkedDemonstration;
}

/**
 * Drive a complete game to victory over the wire. Ported 1:1 from the
 * driver's phase machine — the only differences are transport (socket acks)
 * and state visibility (redacted projections; profiles read only public
 * fields — dice/cash/ownership arrive in state and event meta).
 */
export async function runNetworkedGame(
  fixture: RoomFixture,
  /** Reads the server's authoritative full-state hash (`games.state_snapshot`) at probe-(d) time. */
  serverFullHash: () => string,
): Promise<NetworkedGameResult> {
  const { gameId, seed, mode, playerIds, clients } = fixture;
  const strategies: readonly Strategy[] = playerIds.map((_, seat) => strategyFor(profileForSeat(seat)));
  // Per-seat actor randomness, derived from the game seed — independent of
  // the engine's private word (profiles never draw from the game's source).
  const actorRngs: readonly RandomSource[] = playerIds.map((_, seat) =>
    mulberry32((seed ^ (0x9e3779b9 * (seat + 1))) >>> 0),
  );

  const commands: GameCommand[] = [];
  let appliedCommands = 0;
  let lastApplied: GameCommand | null = null;
  const probes = { unauthorized: 0, stale: 0, idempotent: 0 };

  const stateOf = (): ClientGameState => clients[0].state;

  const submit = async (command: GameCommand): Promise<WireCommandResult> => {
    if (commands.length >= MAX_SUBMISSIONS) {
      throw new WireDriverError(`game ${gameId} exceeded the ${MAX_SUBMISSIONS}-submission bound — strategy livelock`);
    }
    commands.push(command);
    const seatOfSubmitter = playerIds.indexOf(command.actorId);
    const client = clients[seatOfSubmitter];
    if (!client) throw new WireDriverError(`no client for actor ${command.actorId}`);
    const result = await client.command(command);
    if (result.ok && result.applied) {
      appliedCommands += 1;
      lastApplied = command;
      // Every applied command bumps the version; every client must observe
      // the new authoritative state before the next decision reads one.
      const preVersion = command.expectedVersion;
      await Promise.all(clients.map((c) => c.waitForVersion(preVersion + 1)));
    }
    return result;
  };

  const submitOrThrow = async (command: GameCommand, where: string): Promise<void> => {
    const result = await submit(command);
    if (!result.ok) {
      throw new WireDriverError(
        `game ${gameId} ${where}: strategy produced an illegal ${command.type} (${result.error.code}: ${result.error.message})`,
      );
    }
  };

  const commandFor = (type: GameCommand['type'], actorId: PlayerId, payload: Record<string, unknown> = {}): GameCommand => {
    return {
      commandId: `wire-${commands.length + 1}`,
      gameId,
      actorId,
      expectedVersion: stateOf().version,
      type,
      payload,
    } as GameCommand;
  };

  // --- §17.3 probes (a)(b)(c) — rejection purity observed over the wire.
  // The hash change-detector runs on the public projection: a private-field
  // mutation with no public effect would break replay (probe d), so public
  // hash stability is the honest wire-observable form of this assertion.

  const publicHashOf = (client: WireClient): string => hashOf(projectClientState(asGameState(client.state)));

  const probeUnauthorizedActor = async (): Promise<void> => {
    const state = stateOf();
    const active = state.activePlayerId;
    if (active === null) throw new WireDriverError('probe (a) ran with no active player');
    const other = state.players.find((player) => !player.eliminated && player.id !== active);
    if (!other) throw new WireDriverError('probe (a) found no second live player');
    const before = clients.map(publicHashOf);
    const result = await submit(commandFor('ROLL', other.id));
    if (result.ok || result.error.code !== 'NOT_AUTHORIZED') {
      throw new WireDriverError(
        `17.3(a) FAILED: unauthorized ROLL not rejected NOT_AUTHORIZED (${JSON.stringify(result.ok ? 'applied' : result.error.code)})`,
      );
    }
    const after = clients.map(publicHashOf);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new WireDriverError('17.3(a) FAILED: rejection mutated observed state');
    probes.unauthorized += 1;
  };

  const probeStaleVersion = async (): Promise<void> => {
    const state = stateOf();
    const active = state.activePlayerId;
    if (active === null || state.version < 1) throw new WireDriverError('probe (b) ran in an impossible state');
    const before = clients.map(publicHashOf);
    const stale = { ...commandFor('ROLL', active), expectedVersion: state.version - 1, commandId: `wire-probe-b-${commands.length + 1}` } as GameCommand;
    const result = await submit(stale);
    if (result.ok || result.error.code !== 'VERSION_CONFLICT') {
      throw new WireDriverError(
        `17.3(b) FAILED: stale expectedVersion not rejected VERSION_CONFLICT (${JSON.stringify(result.ok ? 'applied' : result.error.code)})`,
      );
    }
    const after = clients.map(publicHashOf);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new WireDriverError('17.3(b) FAILED: rejection mutated observed state');
    probes.stale += 1;
  };

  const probeIdempotency = async (): Promise<void> => {
    if (lastApplied === null) throw new WireDriverError('probe (c) ran before any applied command');
    const before = clients.map(publicHashOf);
    const result = await submit(lastApplied);
    if (!result.ok || result.applied !== false) {
      throw new WireDriverError(
        `17.3(c) FAILED: duplicate commandId did not return ok/applied:false (${JSON.stringify(result.ok ? result.applied : result.error.code)})`,
      );
    }
    const after = clients.map(publicHashOf);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new WireDriverError('17.3(c) FAILED: duplicate application mutated observed state');
    probes.idempotent += 1;
  };

  // --- Phase-walking sub-protocols (ported from driver.ts).

  const negotiation = async (): Promise<void> => {
    for (let depth = 0; depth < MAX_NEGOTIATION_DEPTH; depth++) {
      const pending = stateOf().trade;
      if (!pending) return;
      const responder = pending.recipientId;
      const seat = playerIds.indexOf(responder);
      const strategy = strategies[seat];
      if (!strategy) throw new WireDriverError(`negotiation found no strategy for ${responder}`);
      const decision = strategy.decideAnswer(stateOf() as never, responder, actorRngs[seat] as RandomSource, depth);
      const command = commandFor('ANSWER_TRADE', responder, {
        tradeId: pending.tradeId,
        ...(decision.response === 'COUNTER'
          ? { response: decision.response, counterOffer: decision.counterOffer }
          : { response: decision.response }),
      });
      await submitOrThrow(command, 'negotiation');
    }
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
        const decision = strategies[seat]?.decideBid(stateOf() as never, player.id, actorRngs[seat] as RandomSource);
        if (!decision) throw new WireDriverError(`auction found no strategy for ${player.id}`);
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
      if (!debtor) throw new WireDriverError('settlement phase without a debt');
      const seat = playerIds.indexOf(debtor);
      const step = strategies[seat]?.decideSettlement(state as never, debtor, actorRngs[seat] as RandomSource);
      if (!step) throw new WireDriverError(`settlement found no strategy for ${debtor}`);
      const command =
        step.action === 'SETTLE_DEBT'
          ? commandFor('SETTLE_DEBT', debtor)
          : step.action === 'SURRENDER'
            ? commandFor('SURRENDER', debtor)
            : commandFor(step.action, debtor, { spaceId: step.spaceId });
      const result = await submit(command);
      if (!result.ok) {
        if (result.error.code === 'DEBT_HOPELESS' && step.action !== 'SURRENDER') {
          // The hopeless veto only lets SURRENDER through — force it.
          await submitOrThrow(commandFor('SURRENDER', debtor), 'hopeless debt');
          continue;
        }
        throw new WireDriverError(`game ${gameId}: settlement ${step.action} rejected (${result.error.code}: ${result.error.message})`);
      }
    }
  };

  const managementProtocol = async (): Promise<void> => {
    const context: { tradesProposedThisTurn: number } = { tradesProposedThisTurn: 0 };
    for (let action = 0; action < MAX_MANAGEMENT_ACTIONS_PER_TURN; action++) {
      const state = stateOf();
      if (state.turnPhase !== 'TURN_MANAGEMENT' || state.phase !== 'PLAYING') return;
      const actor = state.activePlayerId;
      if (actor === null) throw new WireDriverError('management phase with no active player');
      const seat = playerIds.indexOf(actor);
      const decision = strategies[seat]?.decideManagement(state as never, actor, actorRngs[seat] as RandomSource, {
        actionsThisTurn: action,
        tradesProposedThisTurn: context.tradesProposedThisTurn,
      });
      if (!decision) throw new WireDriverError(`management found no strategy for ${actor}`);
      if (decision.action === 'END_TURN') {
        await submitOrThrow(commandFor('END_TURN', actor), 'management');
        return;
      }
      if (decision.action === 'OFFER_TRADE') {
        const result = await submit(
          commandFor('OFFER_TRADE', actor, { recipientId: decision.recipientId, offer: decision.offer }),
        );
        if (!result.ok) throw new WireDriverError(`game ${gameId}: OFFER_TRADE rejected (${result.error.code}: ${result.error.message})`);
        context.tradesProposedThisTurn += 1;
        await negotiation();
        continue;
      }
      await submitOrThrow(commandFor(decision.action, actor, { spaceId: decision.spaceId }), 'management');
    }
    throw new WireDriverError(`game ${gameId}: management exceeded ${MAX_MANAGEMENT_ACTIONS_PER_TURN} actions`);
  };

  // --- The main walk (spec §4 phase table).

  await submitOrThrow(commandFor('START_GAME', playerIds[0]), 'lobby');

  while (stateOf().phase === 'PLAYING') {
    const state = stateOf();
    switch (state.turnPhase) {
      case 'AWAITING_ROLL': {
        await probeUnauthorizedActor();
        await probeStaleVersion();
        await probeIdempotency();
        const actor = state.activePlayerId;
        if (actor === null) throw new WireDriverError('AWAITING_ROLL with no active player');
        const seat = playerIds.indexOf(actor);
        const decision = strategies[seat]?.decideRoll(state as never, actor, actorRngs[seat] as RandomSource);
        if (!decision) throw new WireDriverError(`roll found no strategy for ${actor}`);
        await submitOrThrow(commandFor(decision.action, actor), 'roll');
        break;
      }
      case 'BUY_DECISION': {
        const actor = state.activePlayerId;
        if (actor === null) throw new WireDriverError('BUY_DECISION with no active player');
        const seat = playerIds.indexOf(actor);
        const decision = strategies[seat]?.decideBuy(state as never, actor, actorRngs[seat] as RandomSource);
        if (!decision) throw new WireDriverError(`buy found no strategy for ${actor}`);
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
        throw new WireDriverError(`unexpected turn phase ${String(state.turnPhase)} — the wire driver cannot proceed`);
      default:
        throw new WireDriverError(`unexpected turn phase ${String(state.turnPhase)}`);
    }
  }

  if (stateOf().phase !== 'GAME_OVER') throw new WireDriverError('game loop exited before GAME_OVER');

  // --- §17.3 (d): replay the SERVER's applied-command ledger to identical state.
  // The ledger is the audit trail (every applied command in application
  // order, stored by recordApplied) — the probe verifies the reducer refolds
  // the DB's own history, independent of driver bookkeeping. Replay needs
  // the seed — operator privilege via the harness DB (clients never receive
  // it). Two equalities: the replayed state's public projection must match
  // the clients' final observed state, and the full replayed state must
  // match the server's own authoritative hash.

  const ledger = fixture.harness.db.listAppliedCommands(gameId);
  const created = createGame({ gameId, seed, playerIds, mode });
  if (!created.ok) throw new WireDriverError(`replay could not recreate game ${gameId}`);
  const folded = replayCommands(created.state, ledger);

  const livePublicHash = hashOf(projectClientState(asGameState(stateOf())));
  const replayPublicHash = hashOf(projectClientState(folded.state));
  const replayFullHashMatchesServer = serverFullHash() === stateHash(folded.state);

  if (livePublicHash !== replayPublicHash) {
    throw new WireDriverError(
      `17.3(d) FAILED: replay public hash ${replayPublicHash} != live public ${livePublicHash}`,
    );
  }
  if (!replayFullHashMatchesServer) {
    throw new WireDriverError(
      `17.3(d) FAILED: replay full-state hash ${stateHash(folded.state)} != server authoritative ${serverFullHash()}`,
    );
  }

  return {
    commands,
    appliedCommands,
    submittedCommands: commands.length,
    demonstration: {
      unauthorizedActorRejections: probes.unauthorized,
      staleVersionRejections: probes.stale,
      idempotentReplays: probes.idempotent,
      replayVerified: true,
      replayFullHashMatchesServer,
      allGreen:
        probes.unauthorized >= 1 && probes.stale >= 1 && probes.idempotent >= 1 && replayFullHashMatchesServer,
    },
  };
}
