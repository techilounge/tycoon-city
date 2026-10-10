import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOARD_SPACES, isPurchasable } from '../../src/lib/game/board-v1';
import { RULES_VERSION, type GameState, type PlayerState } from '../../src/lib/game/types';
import { auctionPanel, dockGroups, districtComplete, nextBidAmount, tradePanel, turnHeadline } from '../../src/lib/game/ui/actionDock';
import { upgradeCost, upgradeSellBackProceeds } from '../../src/lib/game/rules-v1';

/** The action-dock projection (spec §11, §12 PR 10): legal commands + reasons, per phase. */

function mkPlayer(overrides: { id: string; seat: number } & Partial<PlayerState>): PlayerState {
  return {
    eliminated: false,
    position: 0,
    cash: 1500,
    tokens: { HOLD: 0, RENT_HOLIDAY: 0 },
    skipNextTurn: false,
    ...overrides,
  };
}

function craftedState(overrides: {
  phase?: GameState['phase'];
  turnPhase?: GameState['turnPhase'];
  players?: PlayerState[];
  activePlayerId?: string | null;
  owners?: Record<string, string>;
  upgrades?: Record<string, number>;
  mortgaged?: Record<string, boolean>;
  debt?: GameState['debt'];
  auction?: GameState['auction'];
  trade?: GameState['trade'];
}): GameState {
  return {
    gameId: 'g-dock',
    version: 7,
    phase: overrides.phase ?? 'PLAYING',
    turnPhase: overrides.turnPhase ?? 'AWAITING_ROLL',
    mode: 'CLASSIC',
    doublesCount: 0,
    owners: overrides.owners ?? {},
    upgrades: overrides.upgrades ?? {},
    mortgaged: overrides.mortgaged ?? {},
    eventDeck: { drawPile: [], discardPile: [] },
    debt: overrides.debt ?? null,
    auction: overrides.auction ?? null,
    trade: overrides.trade ?? null,
    estateSale: null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId !== undefined ? overrides.activePlayerId : 'Ada',
    turn: 3,
    round: 1,
    lastEventSequence: 40,
    processedCommandIds: [],
  };
}

const FIRST_PROPERTY = BOARD_SPACES.find((s) => isPurchasable(s) && s.kind === 'PROPERTY');
assert.ok(FIRST_PROPERTY, 'board data has at least one district property');

describe('dockGroups', () => {
  it('offers START_GAME in the lobby and nothing once the game is over', () => {
    const lobby = craftedState({ phase: 'LOBBY', turnPhase: null, activePlayerId: null });
    assert.deepEqual(
      dockGroups(lobby).flatMap((g) => g.actions.map((a) => a.command)),
      ['START_GAME'],
    );
    assert.deepEqual(dockGroups(craftedState({ phase: 'GAME_OVER', turnPhase: null, activePlayerId: null })), []);
  });

  it('offers ROLL in AWAITING_ROLL and HOLD only while the actor holds a token', () => {
    const plain = craftedState({});
    assert.deepEqual(dockGroups(plain)[0].actions.map((a) => a.command), ['ROLL']);

    const holding = craftedState({ players: [mkPlayer({ id: 'Ada', seat: 0, tokens: { HOLD: 1, RENT_HOLIDAY: 0 } })] });
    const commands = dockGroups(holding)[0].actions.map((a) => a.command);
    assert.ok(commands.includes('HOLD'));
    assert.ok(commands.includes('ROLL'));
  });

  it('disables BUY with the shortfall and always offers the auction path', () => {
    const space = FIRST_PROPERTY;
    const poor = craftedState({
      turnPhase: 'BUY_DECISION',
      players: [
        mkPlayer({ id: 'Ada', seat: 0, position: BOARD_SPACES.indexOf(space), cash: space.listPrice - 10 }),
        mkPlayer({ id: 'Grace', seat: 1 }),
      ],
    });
    const groups = dockGroups(poor);
    const buy = groups.flatMap((g) => g.actions).find((a) => a.command === 'BUY');
    assert.ok(buy?.disabledReason?.includes('Needs'));
    assert.ok(groups.flatMap((g) => g.actions).some((a) => a.command === 'PASS_TO_AUCTION'));
  });

  it('in TURN_MANAGEMENT lists END_TURN plus management for owned spaces with reasoned disables', () => {
    const space = FIRST_PROPERTY;
    const state = craftedState({
      turnPhase: 'TURN_MANAGEMENT',
      owners: { [space.id]: 'Ada' },
      upgrades: { [space.id]: 2 },
    });
    const actions = dockGroups(state).flatMap((g) => g.actions);
    assert.ok(actions.some((a) => a.command === 'END_TURN' && a.primary));
    const build = actions.find((a) => a.command === 'BUILD');
    assert.ok(build?.disabledReason?.includes('district'));
    const sell = actions.find((a) => a.command === 'SELL_UPGRADE');
    assert.ok(sell?.label.includes(`+$${upgradeSellBackProceeds(2 * upgradeCost(space.listPrice)).toLocaleString()}`));
    const mortgage = actions.find((a) => a.command === 'MORTGAGE');
    assert.equal(mortgage?.disabledReason, 'Sell the buildings first (mortgage needs level 0).');
    assert.ok(actions.some((a) => a.command === 'SURRENDER' && a.danger));
  });

  it('offers UNMORTGAGE for mortgaged holdings and MORTGAGE at level 0', () => {
    const space = FIRST_PROPERTY;
    const mortgaged = craftedState({ turnPhase: 'TURN_MANAGEMENT', owners: { [space.id]: 'Ada' }, mortgaged: { [space.id]: true } });
    const actions = dockGroups(mortgaged).flatMap((g) => g.actions);
    assert.ok(actions.some((a) => a.command === 'UNMORTGAGE' && a.disabledReason === undefined));
    assert.ok(!actions.some((a) => a.command === 'MORTGAGE'));
    assert.ok(actions.some((a) => a.command === 'BUILD' && a.disabledReason === 'Mortgaged — lift the mortgage first.'));

    const clean = craftedState({ turnPhase: 'TURN_MANAGEMENT', owners: { [space.id]: 'Ada' } });
    const cleanActions = dockGroups(clean).flatMap((g) => g.actions);
    assert.ok(cleanActions.some((a) => a.command === 'MORTGAGE' && a.disabledReason === undefined));
  });

  it('in SETTLING_DEBT gates SETTLE_DEBT on cash and always offers SURRENDER', () => {
    const short = craftedState({
      turnPhase: 'SETTLING_DEBT',
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 40 }), mkPlayer({ id: 'Grace', seat: 1 })],
      debt: { debtorId: 'Ada', creditorId: 'BANK', amountDue: 100, reason: 'TAX' },
    });
    const shortActions = dockGroups(short).flatMap((g) => g.actions);
    const settle = shortActions.find((a) => a.command === 'SETTLE_DEBT');
    assert.ok(settle?.disabledReason?.includes('raise cash or surrender'));
    assert.ok(shortActions.some((a) => a.command === 'SURRENDER'));

    const covered = craftedState({
      turnPhase: 'SETTLING_DEBT',
      players: [mkPlayer({ id: 'Ada', seat: 0, cash: 140 }), mkPlayer({ id: 'Grace', seat: 1 })],
      debt: { debtorId: 'Ada', creditorId: 'Grace', amountDue: 100, reason: 'RENT' },
    });
    const coveredActions = dockGroups(covered).flatMap((g) => g.actions);
    const coveredSettle = coveredActions.find((a) => a.command === 'SETTLE_DEBT');
    assert.equal(coveredSettle?.disabledReason, undefined);
    assert.ok(coveredSettle?.label.includes('to Grace'));
  });
});

describe('auctionPanel', () => {
  it('excludes passed players, prices the next bid, and disables unpayable bidders', () => {
    const space = FIRST_PROPERTY;
    const state = craftedState({
      turnPhase: 'AUCTION',
      players: [
        mkPlayer({ id: 'Ada', seat: 0, cash: 500 }),
        mkPlayer({ id: 'Grace', seat: 1, cash: 5 }),
        mkPlayer({ id: 'Linus', seat: 2, cash: 500 }),
      ],
      auction: {
        auctionId: 'auc-1',
        spaceId: space.id,
        reason: 'DECLINED',
        currentBid: 30,
        highBidderId: 'Ada',
        passedPlayerIds: ['Grace'],
        eligiblePlayerIds: ['Ada', 'Grace', 'Linus'],
      },
    });
    const panel = auctionPanel(state);
    assert.ok(panel);
    assert.deepEqual(
      panel.bidders.map((b) => b.playerId),
      ['Ada', 'Linus'],
    );
    assert.equal(panel.bidders[0].minBid, 40);
    assert.equal(panel.bidders[0].bidDisabledReason, null);
    assert.equal(auctionPanel(craftedState({})), null);
  });

  it('opens at the $10 minimum when nobody has bid', () => {
    const space = FIRST_PROPERTY;
    const auction = {
      auctionId: 'auc-1',
      spaceId: space.id,
      reason: 'DECLINED' as const,
      currentBid: null,
      highBidderId: null,
      passedPlayerIds: [],
      eligiblePlayerIds: ['Ada'],
    };
    assert.equal(nextBidAmount(auction), 10);
  });
});

describe('tradePanel', () => {
  it('summarizes the offer and answers accept/reject', () => {
    const state = craftedState({
      trade: {
        tradeId: 'tr-1',
        proposerId: 'Grace',
        recipientId: 'Ada',
        offer: { give: { cash: 50, spaceIds: ['harbor-1'] }, receive: { cash: 0, spaceIds: [] } },
        anchorTurn: null,
      },
    });
    const panel = tradePanel(state);
    assert.ok(panel);
    assert.equal(panel.recipientId, 'Ada');
    assert.ok(panel.summary.includes('$50'));
    assert.deepEqual(
      panel.actions.map((a) => (a.payload as { response: string }).response),
      ['ACCEPT', 'REJECT'],
    );
    assert.equal(tradePanel(craftedState({})), null);
  });
});

describe('turnHeadline', () => {
  it('names the actor and the phase', () => {
    assert.ok(turnHeadline(craftedState({})).startsWith("Ada's turn"));
    assert.ok(turnHeadline(craftedState({ turnPhase: 'TURN_MANAGEMENT' })).includes('end turn'));
    assert.equal(turnHeadline(craftedState({ phase: 'GAME_OVER', turnPhase: null, activePlayerId: null })), 'Game over');
  });
});

describe('districtComplete', () => {
  it('requires every space of the district to be owned by one player', () => {
    const district = FIRST_PROPERTY.districtId;
    const districtSpaces = BOARD_SPACES.filter((s) => s.kind === 'PROPERTY' && s.districtId === district);
    const owners: Record<string, string> = {};
    for (const space of districtSpaces) owners[space.id] = 'Ada';
    assert.equal(districtComplete(craftedState({ owners }), district, 'Ada'), true);
    owners[districtSpaces[0].id] = 'Grace';
    assert.equal(districtComplete(craftedState({ owners }), district, 'Ada'), false);
  });
});
