/**
 * Tycoon City board v1 — the complete original board, Event Deck, and mode
 * configurations as pure, serializable data (spec §8).
 *
 * RULES_VERSION 1 ships exactly one board. A future balance patch edits this
 * file (or adds board-v2 alongside a rules-v2 module) as a data-only change —
 * old logs are never reinterpreted under new math (spec §3).
 *
 * Economy values are PROVISIONAL (spec §8): the PR 9 balance simulation is
 * the arbiter, and retunes are data-only changes to this file.
 *
 * Originality: every name, price curve, arrangement, and card text below is
 * original to Tycoon City (AGENTS.md rule 5). The test suite greps this file
 * against a list of protected genre terms on every run, so an accidental
 * borrowing fails CI instead of shipping.
 */

import type { SpaceId } from './types';
import type { TaxKind, TokenKind } from './events';

/** Data format version of this board module (bundled with RULES_VERSION 1). */
export const BOARD_VERSION = 1;

/** The board is one closed loop; a token's position is an index into SPACES. */
export type SpaceKind = 'START' | 'PROPERTY' | 'HUB' | 'SERVICE' | 'EVENT' | 'ASSESSMENT' | 'PARK';

export type DistrictId =
  | 'FOUNDRY_ROW'
  | 'HARBOR_QUARTER'
  | 'MARKETVIEW'
  | 'PARKSIDE'
  | 'MIDTOWN'
  | 'CROWN_HEIGHTS';

interface SpaceBase {
  readonly id: SpaceId;
  readonly name: string;
  readonly kind: SpaceKind;
}

export interface StartSpace extends SpaceBase {
  readonly kind: 'START';
}

export interface PropertySpace extends SpaceBase {
  readonly kind: 'PROPERTY';
  readonly districtId: DistrictId;
  readonly listPrice: number;
}

export interface HubSpace extends SpaceBase {
  readonly kind: 'HUB';
  readonly listPrice: number;
}

export interface ServiceSpace extends SpaceBase {
  readonly kind: 'SERVICE';
  readonly listPrice: number;
}

/** Landing here draws the top card of the Event Deck (PR 5 resolves the draw). */
export interface EventSpace extends SpaceBase {
  readonly kind: 'EVENT';
}

export interface ParkSpace extends SpaceBase {
  readonly kind: 'PARK';
}

/**
 * What an assessment space charges. Data, not code, so PR 9 retunes rates
 * without touching the rules module. The third-doubles penalty also sends a
 * token to the NEAREST PARK — parks themselves charge nothing.
 */
export type AssessmentLevy =
  | { readonly kind: 'FLAT'; readonly amount: number }
  | { readonly kind: 'CASH_RATE'; readonly cashRate: number };

export interface AssessmentSpace extends SpaceBase {
  readonly kind: 'ASSESSMENT';
  /** Mirrors TaxKind in events.ts: 'ASSESSMENT_OFFICE' | 'MUNICIPAL_LEVY'. */
  readonly taxKind: TaxKind;
  readonly levy: AssessmentLevy;
}

export type BoardSpace =
  | StartSpace
  | PropertySpace
  | HubSpace
  | ServiceSpace
  | EventSpace
  | AssessmentSpace
  | ParkSpace;

/** Spaces a player can own: properties, transit hubs, and city services. */
export type PurchasableSpace = PropertySpace | HubSpace | ServiceSpace;

export function isPurchasable(space: BoardSpace): space is PurchasableSpace {
  return space.kind === 'PROPERTY' || space.kind === 'HUB' || space.kind === 'SERVICE';
}

/**
 * The 32-space loop, in movement order. Index 0 is Gateway Terminal; forward
 * movement wraps 31 → 0, and any forward pass or landing of index 0 pays the
 * start bonus (spec §4 row 3).
 */
export const BOARD_SPACES: readonly BoardSpace[] = [
  { id: 'gateway-terminal', name: 'Gateway Terminal', kind: 'START' },
  { id: 'foundry-smeltery', name: 'Old Smeltery Lane', kind: 'PROPERTY', districtId: 'FOUNDRY_ROW', listPrice: 60 },
  { id: 'event-city-wire', name: 'City Wire Bulletin', kind: 'EVENT' },
  { id: 'foundry-brasshouse', name: 'Brasshouse Court', kind: 'PROPERTY', districtId: 'FOUNDRY_ROW', listPrice: 80 },
  { id: 'municipal-levy', name: 'Municipal Levy', kind: 'ASSESSMENT', taxKind: 'MUNICIPAL_LEVY', levy: { kind: 'CASH_RATE', cashRate: 0.08 } },
  { id: 'foundry-anvil', name: 'Anvil & Ore Works', kind: 'PROPERTY', districtId: 'FOUNDRY_ROW', listPrice: 100 },
  { id: 'hub-central-relay', name: 'Central Relay Terminal', kind: 'HUB', listPrice: 200 },
  { id: 'harbor-ropefront', name: 'Ropefront Walk', kind: 'PROPERTY', districtId: 'HARBOR_QUARTER', listPrice: 120 },
  { id: 'founders-green', name: 'Founders Green', kind: 'PARK' },
  { id: 'harbor-saltmarket', name: 'Saltmarket Pier', kind: 'PROPERTY', districtId: 'HARBOR_QUARTER', listPrice: 140 },
  { id: 'event-night-market', name: 'Night Market', kind: 'EVENT' },
  { id: 'harbor-beaconside', name: 'Beaconside Terrace', kind: 'PROPERTY', districtId: 'HARBOR_QUARTER', listPrice: 160 },
  { id: 'service-powerworks', name: 'City Powerworks', kind: 'SERVICE', listPrice: 160 },
  { id: 'market-greenmarket', name: 'Greenmarket Square', kind: 'PROPERTY', districtId: 'MARKETVIEW', listPrice: 180 },
  { id: 'market-coppermonger', name: 'Coppermonger Row', kind: 'PROPERTY', districtId: 'MARKETVIEW', listPrice: 200 },
  { id: 'assessment-office', name: 'Assessment Office', kind: 'ASSESSMENT', taxKind: 'ASSESSMENT_OFFICE', levy: { kind: 'FLAT', amount: 120 } },
  { id: 'market-guildhall', name: 'Guildhall Yard', kind: 'PROPERTY', districtId: 'MARKETVIEW', listPrice: 220 },
  { id: 'hub-aurora-junction', name: 'Aurora Junction Depot', kind: 'HUB', listPrice: 200 },
  { id: 'parkside-lantern', name: 'Lantern Way', kind: 'PROPERTY', districtId: 'PARKSIDE', listPrice: 240 },
  { id: 'event-street-festival', name: 'Street Festival', kind: 'EVENT' },
  { id: 'parkside-museum', name: 'Museum Mile', kind: 'PROPERTY', districtId: 'PARKSIDE', listPrice: 260 },
  { id: 'service-waterline', name: 'Blue Water Utility', kind: 'SERVICE', listPrice: 160 },
  { id: 'parkside-observatory', name: 'Observatory Row', kind: 'PROPERTY', districtId: 'PARKSIDE', listPrice: 280 },
  { id: 'aurora-gardens', name: 'Aurora Gardens', kind: 'PARK' },
  { id: 'midtown-exchange', name: 'Exchange Boulevard', kind: 'PROPERTY', districtId: 'MIDTOWN', listPrice: 300 },
  { id: 'midtown-meridian', name: 'Meridian Plaza', kind: 'PROPERTY', districtId: 'MIDTOWN', listPrice: 320 },
  { id: 'event-harbor-festival', name: 'Harbor Festival', kind: 'EVENT' },
  { id: 'midtown-commerce', name: 'Commerce Spire', kind: 'PROPERTY', districtId: 'MIDTOWN', listPrice: 340 },
  { id: 'crown-sovereign', name: 'Sovereign Terrace', kind: 'PROPERTY', districtId: 'CROWN_HEIGHTS', listPrice: 380 },
  { id: 'crown-regent-gate', name: 'Regent Gate', kind: 'PROPERTY', districtId: 'CROWN_HEIGHTS', listPrice: 420 },
  { id: 'verdant-commons', name: 'Verdant Commons', kind: 'PARK' },
  { id: 'crown-summit', name: 'Crown Summit', kind: 'PROPERTY', districtId: 'CROWN_HEIGHTS', listPrice: 460 },
];

export const BOARD_LOOP_SIZE = BOARD_SPACES.length; // 32 — invariant-tested

/** The start space: forward passes and landings pay START_BONUS (spec §4). */
export const START_SPACE_ID: SpaceId = 'gateway-terminal';

/** $250 on any forward pass or landing of Gateway Terminal (spec §4, §8). */
export const START_BONUS = 250;

/** Transit hubs: $60 rent with one hub, $150 with both (spec §8). */
export const HUB_RENT_SINGLE = 60;
export const HUB_RENT_BOTH = 150;

/** A district: three properties whose ids are contiguous in the board data. */
export interface District {
  readonly id: DistrictId;
  readonly name: string;
  readonly spaceIds: readonly SpaceId[];
}

/**
 * Six districts of exactly three properties (spec §8). Completing a district
 * doubles its rents and is the prerequisite for building upgrades (enforced
 * by the BUILD rules in PR 8).
 */
export const DISTRICTS: readonly District[] = [
  { id: 'FOUNDRY_ROW', name: 'Foundry Row', spaceIds: ['foundry-smeltery', 'foundry-brasshouse', 'foundry-anvil'] },
  { id: 'HARBOR_QUARTER', name: 'Harbor Quarter', spaceIds: ['harbor-ropefront', 'harbor-saltmarket', 'harbor-beaconside'] },
  { id: 'MARKETVIEW', name: 'Marketview', spaceIds: ['market-greenmarket', 'market-coppermonger', 'market-guildhall'] },
  { id: 'PARKSIDE', name: 'Parkside', spaceIds: ['parkside-lantern', 'parkside-museum', 'parkside-observatory'] },
  { id: 'MIDTOWN', name: 'Midtown', spaceIds: ['midtown-exchange', 'midtown-meridian', 'midtown-commerce'] },
  { id: 'CROWN_HEIGHTS', name: 'Crown Heights', spaceIds: ['crown-sovereign', 'crown-regent-gate', 'crown-summit'] },
];

/**
 * One card effect, declaratively. The reducer (PR 5) interprets these; PR 3
 * only guarantees the data is well-formed. A PAY effect is a CARD-reason debt
 * owed to the bank (single-creditor scope, spec §7) — never to another
 * player, so no Phase 1 card can create a second creditor.
 */
export type EventCardEffect =
  | { readonly kind: 'MOVE_TO'; readonly spaceId: SpaceId }
  | { readonly kind: 'MOVE_TO_NEAREST_HUB' }
  | { readonly kind: 'MOVE_BACK'; readonly spaces: number }
  | { readonly kind: 'PAY'; readonly amount: number }
  | { readonly kind: 'COLLECT'; readonly amount: number }
  | { readonly kind: 'GRANT_TOKEN'; readonly token: TokenKind };

export type CardMoveEffect = Extract<EventCardEffect, { kind: 'MOVE_TO' | 'MOVE_TO_NEAREST_HUB' | 'MOVE_BACK' }>;

export interface EventCard {
  /** Matches EventMeta.cardId (events.ts) — a plain string id, not a space id. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly effect: EventCardEffect;
}

/**
 * The 18 original Event Deck cards (spec §8) — the canonical catalog in
 * catalog order. At game start the draw pile is this catalog shuffled by the
 * seeded RandomSource; the discard pile reshuffles the same way when the draw
 * pile empties (spec §3). The catalog itself is the stable, replay-safe
 * identity of the deck; draw ORDER lives in game state.
 */
export const EVENT_DECK_CATALOG: readonly EventCard[] = [
  { id: 'summons-city-hall', title: 'Summons from City Hall', text: 'The Mayor requests your presence. Move to Gateway Terminal.', effect: { kind: 'MOVE_TO', spaceId: 'gateway-terminal' } },
  { id: 'trade-summit', title: 'Trade Summit Invitation', text: 'Investors gather downtown. Move to Exchange Boulevard.', effect: { kind: 'MOVE_TO', spaceId: 'midtown-exchange' } },
  { id: 'gallery-spotlight', title: 'Gallery Night Spotlight', text: 'Your portfolio is the talk of the district. Move to Observatory Row.', effect: { kind: 'MOVE_TO', spaceId: 'parkside-observatory' } },
  { id: 'harbor-strike', title: 'Harbor Strike Closure', text: 'Pickets close the docks. Move to Saltmarket Pier.', effect: { kind: 'MOVE_TO', spaceId: 'harbor-saltmarket' } },
  { id: 'transit-day-pass', title: 'Transit Day Pass', text: 'Ride the loop. Move to the nearest transit hub.', effect: { kind: 'MOVE_TO_NEAREST_HUB' } },
  { id: 'parade-blocks-line', title: 'Parade Blocks the Line', text: 'A parade reroutes traffic. Move back 3 spaces.', effect: { kind: 'MOVE_BACK', spaces: 3 } },
  { id: 'municipal-fine', title: 'Municipal Fine Notice', text: 'An unpaid permit surfaces. Pay the bank $100.', effect: { kind: 'PAY', amount: 100 } },
  { id: 'storm-repairs', title: 'Storm Damage Repairs', text: 'Straighten the roofline. Pay the bank $75.', effect: { kind: 'PAY', amount: 75 } },
  { id: 'audit-adjustment', title: 'Audit Adjustment', text: 'The city rechecks your books. Pay the bank $150.', effect: { kind: 'PAY', amount: 150 } },
  { id: 'festival-sponsor', title: 'Festival Sponsor Drive', text: 'Your name on the banner. Pay the bank $50.', effect: { kind: 'PAY', amount: 50 } },
  { id: 'elevator-modernization', title: 'Elevator Modernization', text: 'Code compliance arrives. Pay the bank $120.', effect: { kind: 'PAY', amount: 120 } },
  { id: 'dividend-disbursement', title: 'Dividend Disbursement', text: 'Holdings pay out. Collect $100 from the bank.', effect: { kind: 'COLLECT', amount: 100 } },
  { id: 'heritage-facade-grant', title: 'Heritage Facade Grant', text: 'The city subsidizes character. Collect $150 from the bank.', effect: { kind: 'COLLECT', amount: 150 } },
  { id: 'loyalty-payout', title: 'Loyalty Program Payout', text: 'Points convert to cash. Collect $75 from the bank.', effect: { kind: 'COLLECT', amount: 75 } },
  { id: 'tourism-windfall', title: 'Tourism Season Windfall', text: 'Visitors everywhere. Collect $200 from the bank.', effect: { kind: 'COLLECT', amount: 200 } },
  { id: 'zoning-variance', title: 'Zoning Variance Approved', text: 'Your petition clears. Collect $120 from the bank.', effect: { kind: 'COLLECT', amount: 120 } },
  { id: 'administrative-recess', title: 'Administrative Recess', text: 'City hall stalls. Gain a Hold token.', effect: { kind: 'GRANT_TOKEN', token: 'HOLD' } },
  { id: 'small-business-relief', title: 'Small Business Relief', text: 'The city cushions rent. Gain a Rent Holiday token.', effect: { kind: 'GRANT_TOKEN', token: 'RENT_HOLIDAY' } },
];

/** How a match is configured (spec §8). All values PROVISIONAL. */
export type ModeId = 'CLASSIC' | 'QUICK' | 'BLITZ';

export interface ModeConfig {
  readonly id: ModeId;
  readonly name: string;
  /** Cash each player starts with. */
  readonly startingCash: number;
  /** First player to reach this net worth wins (VICTORY_DECIDED: NET_WORTH_TARGET). */
  readonly netWorthTarget: number;
  /** When a new round would start beyond this cap, the richest player wins (ROUND_CAP). */
  readonly roundCap: number;
}

/**
 * Classic / Quick / Blitz (spec §8). Provisional v1 values, authored for this
 * revision — PR 9's simulation report is the arbiter and may retune them as a
 * data-only change.
 */
export const MODES: Readonly<Record<ModeId, ModeConfig>> = {
  CLASSIC: { id: 'CLASSIC', name: 'Classic', startingCash: 1500, netWorthTarget: 6000, roundCap: 40 },
  QUICK: { id: 'QUICK', name: 'Quick', startingCash: 1200, netWorthTarget: 4500, roundCap: 25 },
  BLITZ: { id: 'BLITZ', name: 'Blitz', startingCash: 1000, netWorthTarget: 3000, roundCap: 15 },
};

export const MODE_IDS: readonly ModeId[] = ['CLASSIC', 'QUICK', 'BLITZ'];

/** The whole v1 board as one value — convenient for snapshot and lobby code. */
export const BOARD_V1 = {
  version: BOARD_VERSION,
  spaces: BOARD_SPACES,
  districts: DISTRICTS,
  startSpaceId: START_SPACE_ID,
  startBonus: START_BONUS,
  eventDeckCatalog: EVENT_DECK_CATALOG,
  modes: MODES,
} as const;
