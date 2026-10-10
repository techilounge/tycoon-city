import { RULES_VERSION, type GameState, type PlayerState } from '../../src/lib/game/types';

/** Shared crafted-state factory for the UI projection tests (mirrors the dock test's shape). */

export function mkPlayer(overrides: { id: string; seat: number } & Partial<PlayerState>): PlayerState {
  return {
    eliminated: false,
    position: 0,
    cash: 1500,
    tokens: { HOLD: 0, RENT_HOLIDAY: 0 },
    skipNextTurn: false,
    ...overrides,
  };
}

export function craftedState(overrides: {
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
  estateSale?: GameState['estateSale'];
  turn?: number;
  round?: number;
}): GameState {
  return {
    gameId: 'g-crafted',
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
    estateSale: overrides.estateSale ?? null,
    rulesVersion: RULES_VERSION,
    seed: 1,
    rngState: 1,
    players: overrides.players ?? [mkPlayer({ id: 'Ada', seat: 0 }), mkPlayer({ id: 'Grace', seat: 1 })],
    activePlayerId: overrides.activePlayerId !== undefined ? overrides.activePlayerId : 'Ada',
    turn: overrides.turn ?? 3,
    round: overrides.round ?? 1,
    lastEventSequence: 40,
    processedCommandIds: [],
  };
}
