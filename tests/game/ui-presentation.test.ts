import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOARD_SPACES, isPurchasable } from '../../src/lib/game/board-v1';
import { applyCommand, createGame } from '../../src/lib/game/engine/reducer';
import { rngForState } from '../../src/lib/game/rng';
import { currentTurnDice, describeEvent, tileCaption } from '../../src/lib/game/ui/uiPlayer';
import type { CommandType, GameCommand } from '../../src/lib/game/commands';
import type { GameState, PlayerId } from '../../src/lib/game/types';
import type { AnyGameEvent } from '../../src/lib/game/events';

/** Presentation contracts pinned by the owner's playtest:
 *  owned tiles caption price + owner consistently, and dice never leak across
 *  a turn boundary. */

const GAME_ID = 'ui-presentation';
const PLAYERS = ['Ada', 'Grace'];

function freshState(seed: number): GameState {
  const created = createGame({ gameId: GAME_ID, seed, playerIds: [...PLAYERS] });
  if (!created.ok) throw created.error;
  return created.state;
}

function submit(state: GameState, type: CommandType, payload: Record<string, unknown> = {}, actorOverride?: PlayerId): ReturnType<typeof applyCommand> {
  const command = {
    commandId: `ui-pres-${state.version}-${type}`,
    gameId: state.gameId,
    actorId: actorOverride ?? state.activePlayerId ?? state.players[0].id,
    expectedVersion: state.version,
    type,
    payload,
  } as GameCommand;
  return applyCommand(state, command, rngForState(state.rngState));
}

interface Driven {
  readonly state: GameState;
  readonly events: readonly AnyGameEvent[];
}

/** Drives `rolls` dice rolls from a fresh game, auto-declining buys and ending
 *  turns, accumulating the emitted event log. With stopAfterRoll, halts right
 *  after the final roll's transition (BUY_DECISION or TURN_MANAGEMENT still
 *  pending). Seed 176's trace: Ada rolls 1+5, Grace rolls 1+1, 4+4, 4+4
 *  (third doubles parks). */
function drive(seed: number, rolls: number, stopAfterRoll = false): Driven {
  let state = freshState(seed);
  const events: AnyGameEvent[] = [];
  const started = submit(state, 'START_GAME');
  if (!started.ok) throw started.error;
  state = started.state;
  events.push(...started.events);
  let n = 0;
  for (let made = 0; made < rolls && n < 40; made++) {
    const r = submit(state, 'ROLL');
    if (!r.ok) throw r.error;
    state = r.state;
    events.push(...r.events);
    n++;
    if (stopAfterRoll && made === rolls - 1) break;
    // Real auctions (PR 6) resolve inside the decliner's turn; the resolve
    // loop simply runs until the next AWAITING_ROLL.
    let guard = 0;
    while (state.phase === 'PLAYING' && state.turnPhase !== 'AWAITING_ROLL' && guard++ < 10) {
      // The driver never bids — the first player who is unpassed and not the
      // high bidder passes, deterministically; a no-bid auction always ends
      // unsold once everyone has passed.
      let actor: PlayerId | undefined;
      let payload: Record<string, unknown> = {};
      let type: CommandType;
      if (state.turnPhase === 'BUY_DECISION') {
        type = 'PASS_TO_AUCTION';
      } else if (state.turnPhase === 'AUCTION') {
        const auction = state.auction;
        if (!auction) throw new Error('auction phase without an open auction');
        const bidder = auction.eligiblePlayerIds.find(
          (id) => !auction.passedPlayerIds.includes(id) && auction.highBidderId !== id,
        );
        if (!bidder) throw new Error('auction invariant: an actionable bidder exists while the auction is open');
        actor = bidder;
        type = 'PASS_BID';
        payload = { auctionId: auction.auctionId };
      } else {
        type = 'END_TURN';
      }
      const r2 = submit(state, type, payload, actor);
      if (!r2.ok) throw r2.error;
      state = r2.state;
      events.push(...r2.events);
      n++;
    }
  }
  return { state, events };
}

function endCurrentTurn(driven: Driven): Driven {
  const r = submit(driven.state, 'END_TURN');
  if (!r.ok) throw r.error;
  return { state: r.state, events: [...driven.events, ...r.events] };
}

describe('tileCaption', () => {
  const base = freshState(1);
  const properties = BOARD_SPACES.filter(isPurchasable);
  const property = properties.find((s) => s.kind === 'PROPERTY');
  const hub = properties.find((s) => s.kind === 'HUB');
  const service = properties.find((s) => s.kind === 'SERVICE');
  assert.ok(property && hub && service, 'board v1 must have one purchasable of each kind');

  const ownedState: GameState = {
    ...base,
    owners: { ...base.owners, [property.id]: 'Grace', [hub.id]: 'Ada', [service.id]: 'Ada' },
  };

  it('unowned purchasables caption the list price only', () => {
    const caption = tileCaption(property, base);
    assert.equal(caption.label, '$' + property.listPrice);
    assert.equal(caption.ownerLine, null);
    assert.equal(caption.ownerId, null);
  });

  it('every owned purchasable kind captions price AND owner (playtest consistency pin)', () => {
    for (const space of [property, hub, service]) {
      const caption = tileCaption(space, ownedState);
      assert.equal(caption.label, '$' + space.listPrice, `${space.kind} must keep its price when owned`);
      assert.ok(caption.ownerLine !== null && caption.ownerId !== null, `${space.kind} must name its owner`);
      assert.match(caption.ownerLine, /^Owned by /);
    }
    assert.equal(tileCaption(property, ownedState).ownerLine, 'Owned by Grace');
  });

  it('non-purchasable spaces never show an owner', () => {
    for (const kind of ['PARK', 'EVENT', 'START'] as const) {
      const space = BOARD_SPACES.find((s) => s.kind === kind);
      assert.ok(space, `board has a ${kind}`);
      const caption = tileCaption(space, ownedState);
      assert.equal(caption.label, kind);
      assert.equal(caption.ownerLine, null);
      assert.equal(caption.ownerId, null);
    }
  });

  it('a bought property captions price and owner (engine-driven)', () => {
    const driven = drive(176, 1, true); // stop at Ada's BUY_DECISION
    const buyer = driven.state.players[0];
    const landed = BOARD_SPACES[buyer.position];
    assert.ok(isPurchasable(landed), 'seed 176 roll 1 must land on a purchasable');
    const bought = submit(driven.state, 'BUY', { spaceId: landed.id });
    if (!bought.ok) throw bought.error;
    const caption = tileCaption(landed, bought.state);
    assert.equal(caption.label, '$' + landed.listPrice);
    assert.equal(caption.ownerLine, `Owned by ${buyer.id}`);
    assert.equal(caption.ownerId, buyer.id);
  });
});

describe('currentTurnDice', () => {
  it('returns null before the active player has rolled', () => {
    const driven = drive(176, 0); // START_GAME only — first TURN_STARTED, no roll
    assert.equal(currentTurnDice(driven.events), null);
  });

  it('returns the current turn roll with its event index', () => {
    const driven = drive(176, 1, true); // stopped at Ada's BUY_DECISION, her roll still current
    const dice = currentTurnDice(driven.events);
    assert.ok(dice);
    assert.deepEqual({ die1: dice.roll.die1, die2: dice.roll.die2, isDoubles: dice.roll.isDoubles }, {
      die1: 1,
      die2: 5,
      isDoubles: false,
    });
    assert.equal(driven.events[dice.key].type, 'DICE_ROLLED');
  });

  it('previous turns rolls never leak across a handover (playtest pin)', () => {
    // Ada rolled 1+5 and declined; the turn already advanced to Grace.
    const handed = drive(176, 1);
    assert.equal(handed.state.activePlayerId, 'Grace');
    assert.equal(currentTurnDice(handed.events), null);
  });

  it('a doubled roll does not bleed into its extra cycle', () => {
    const doubled = drive(176, 2, true); // Ada 1+5, then Grace 1+1 — her current roll
    const current = currentTurnDice(doubled.events);
    assert.ok(current);
    assert.equal(current.roll.die1, 1);
    assert.equal(current.roll.die2, 1);
    assert.equal(current.roll.isDoubles, true);
    // Ending the turn starts the doubles extra cycle: same player, fresh
    // roll pending, previous dice cleared from the current-turn view. The
    // streak persists (D-5) — that is what keeps a third consecutive
    // doubles reachable across extra cycles.
    const extra = endCurrentTurn(doubled);
    assert.equal(extra.state.activePlayerId, 'Grace');
    assert.equal(extra.state.doublesCount, 1);
    assert.equal(currentTurnDice(extra.events), null);
    // The log still narrates the doubled roll for the record.
    const lines = extra.events.map(describeEvent).filter((line) => line !== null);
    assert.ok(lines.some((line) => line === 'Grace rolled 1 + 1'));
  });
});
