/**
 * Development and mortgages (spec §4 row 9, §8; docs/RULES.md §7–§8).
 *
 * The four TURN_MANAGEMENT actions of the active player: BUILD raises a
 * district property's upgrade level (complete-district prerequisite, 50% of
 * list price per level, landmark cap), SELL_UPGRADE sells one level back at
 * 50% of the price paid, MORTGAGE banks a level-0 space for 50% of its list
 * price, and UNMORTGAGE lifts a mortgage for 110% of the list price.
 *
 * The SETTLING_DEBT liquidation variants (spec §4 row 13) are the debtor's
 * narrower commands in ./debt — they share the cores below. A mortgaged
 * property is inert collateral: it collects no rent (spec §8) and cannot be
 * developed until the mortgage is lifted, so a mortgaged space always sits
 * at level 0 and BUILD refuses it outright.
 *
 * §17.2 structural note: this surface's event vocabulary has no bankruptcy
 * member — development never eliminates anyone.
 */
import { BOARD_SPACES, DISTRICTS, isPurchasable, type PropertySpace, type PurchasableSpace } from '../board-v1';
import type { GameCommand } from '../commands';
import type { EventInput } from '../events';
import { MAX_UPGRADE_LEVEL, mortgageProceeds, unmortgageCost, upgradeCost, upgradeSellBackProceeds } from '../rules-v1';
import type { PlayerId, SpaceId } from '../types';
import { RuleError } from './errors';
import type { GameStateDraft, DraftPlayer } from './draft';
import { requirePlayer } from './draft';

/** The event vocabulary of the development surface — development and
 *  mortgage actions only; no debt, auction, or bankruptcy events. */
export type DevelopmentEventInput =
  | EventInput<'UPGRADE_BUILT'>
  | EventInput<'UPGRADE_SOLD'>
  | EventInput<'MORTGAGE_TAKEN'>
  | EventInput<'MORTGAGE_LIFTED'>;

/** Row 9 is a TURN_MANAGEMENT phase — the settlement variants live in ./debt. */
function requireManagementPhase(draft: GameStateDraft): void {
  if (draft.turnPhase !== 'TURN_MANAGEMENT') {
    throw new RuleError('INVALID_PHASE', `development commands are only valid in TURN_MANAGEMENT, not ${String(draft.turnPhase)}`, {
      phase: draft.turnPhase,
    });
  }
}

/** The registry correlates type and payload; TS cannot carry that through
 *  the handler union — same documented cast as the reducer's buyHandler.
 *  Shape validation already ran (pipeline step 1); presence is checked here.
 *  Shared with the settlement surface in ./debt. */
export function spaceIdPayload(command: GameCommand): SpaceId {
  const spaceId = (command.payload as { readonly spaceId?: SpaceId }).spaceId;
  if (!spaceId) {
    throw new RuleError('INVALID_SHAPE', `${command.type} requires a spaceId`, { field: 'spaceId' });
  }
  return spaceId;
}

/** The actor's owned purchasable space a mortgage command names (hubs and
 *  services mortgage like properties; spec §8). A miss is a rule outcome. */
function requireOwnedPurchasable(draft: GameStateDraft, playerId: PlayerId, spaceId: string): PurchasableSpace {
  const space = BOARD_SPACES.find((candidate) => candidate.id === spaceId);
  if (!space || !isPurchasable(space)) {
    throw new RuleError('RULE_VIOLATION', `space ${spaceId} is not a purchasable space`, { spaceId });
  }
  if (draft.owners[spaceId] !== playerId) {
    throw new RuleError('RULE_VIOLATION', `space ${spaceId} is not owned by player ${playerId}`, {
      spaceId,
      ownerId: draft.owners[spaceId] ?? null,
    });
  }
  return space;
}

/** The actor's owned district property a BUILD or SELL_UPGRADE names — hubs
 *  and services have no upgrade levels (spec §8). */
function requireOwnedProperty(draft: GameStateDraft, playerId: PlayerId, spaceId: string): PropertySpace {
  const space = requireOwnedPurchasable(draft, playerId, spaceId);
  if (space.kind !== 'PROPERTY') {
    throw new RuleError('RULE_VIOLATION', `space ${spaceId} has no upgrade levels — only district properties develop`, {
      spaceId,
      kind: space.kind,
    });
  }
  return space;
}

/** True when the owner holds every property of the district (spec §8) — the
 *  BUILD prerequisite. Shared shape with the economy's rent check; both read
 *  ownership the same way, so they stay consistent by construction. */
function isDistrictCompleteFor(draft: GameStateDraft, ownerId: PlayerId, districtId: PropertySpace['districtId']): boolean {
  const district = DISTRICTS.find((d) => d.id === districtId);
  if (!district) throw new Error(`board data: unknown district id "${districtId}"`);
  return district.spaceIds.every((spaceId) => draft.owners[spaceId] === ownerId);
}

/**
 * Sell one built level back to the bank for 50% of the price originally
 * paid for a level (spec §7, §8) — the shared core of the TURN_MANAGEMENT
 * and SETTLING_DEBT variants. UPGRADE_SOLD carries the resulting level.
 */
export function sellUpgradeCore(draft: GameStateDraft, playerId: PlayerId, spaceId: string): EventInput<'UPGRADE_SOLD'> {
  const space = requireOwnedProperty(draft, playerId, spaceId);
  const level = draft.upgrades[spaceId] ?? 0;
  if (level < 1) {
    throw new RuleError('RULE_VIOLATION', `${spaceId} has no built levels to sell`, { spaceId, level });
  }
  const proceeds = upgradeSellBackProceeds(upgradeCost(space.listPrice));
  draft.upgrades = { ...draft.upgrades, [spaceId]: level - 1 };
  requirePlayer(draft, playerId).cash += proceeds;
  return { type: 'UPGRADE_SOLD', payload: { playerId, spaceId, level: level - 1, proceeds } };
}

/**
 * Mortgage a level-0 space for 50% of its list price (spec §8) — the shared
 * core of the TURN_MANAGEMENT and SETTLING_DEBT variants.
 */
export function mortgageCore(draft: GameStateDraft, playerId: PlayerId, spaceId: string): EventInput<'MORTGAGE_TAKEN'> {
  const space = requireOwnedPurchasable(draft, playerId, spaceId);
  const level = draft.upgrades[spaceId] ?? 0;
  if (level > 0) {
    throw new RuleError('RULE_VIOLATION', `${spaceId} must be level 0 to mortgage — sell the built levels first`, { spaceId, level });
  }
  if (draft.mortgaged[spaceId]) {
    throw new RuleError('RULE_VIOLATION', `${spaceId} is already mortgaged`, { spaceId });
  }
  const proceeds = mortgageProceeds(space.listPrice);
  draft.mortgaged = { ...draft.mortgaged, [spaceId]: true };
  requirePlayer(draft, playerId).cash += proceeds;
  return { type: 'MORTGAGE_TAKEN', payload: { playerId, spaceId, proceeds } };
}

/** Row 9 — BUILD one level onto the actor's district property (spec §8):
 *  complete district, level below the landmark, cash-backed, and never on
 *  mortgaged collateral. */
export function buildHandler(draft: GameStateDraft, command: GameCommand): DevelopmentEventInput[] {
  requireManagementPhase(draft);
  const spaceId = spaceIdPayload(command);
  const space = requireOwnedProperty(draft, command.actorId, spaceId);
  if (!isDistrictCompleteFor(draft, command.actorId, space.districtId)) {
    throw new RuleError('RULE_VIOLATION', `building in ${space.districtId} requires owning the complete district`, {
      spaceId,
      districtId: space.districtId,
    });
  }
  if (draft.mortgaged[spaceId]) {
    throw new RuleError('RULE_VIOLATION', `${spaceId} is mortgaged — lift the mortgage before developing it`, { spaceId });
  }
  const level = draft.upgrades[spaceId] ?? 0;
  if (level >= MAX_UPGRADE_LEVEL) {
    throw new RuleError('RULE_VIOLATION', `${spaceId} is already at the landmark — level ${MAX_UPGRADE_LEVEL} is the maximum`, {
      spaceId,
      level,
    });
  }
  const cost = upgradeCost(space.listPrice);
  const player: DraftPlayer = requirePlayer(draft, command.actorId);
  if (player.cash < cost) {
    throw new RuleError('INSUFFICIENT_RESOURCES', `building on ${spaceId} costs $${cost}; player ${player.id} holds $${player.cash}`, {
      needed: cost,
      cash: player.cash,
    });
  }
  player.cash -= cost;
  draft.upgrades = { ...draft.upgrades, [spaceId]: level + 1 };
  return [{ type: 'UPGRADE_BUILT', payload: { playerId: player.id, spaceId, level: level + 1, cost } }];
}

/** Row 9 — SELL_UPGRADE one level in TURN_MANAGEMENT (spec §7 sell-back). */
export function sellUpgradeManagementHandler(draft: GameStateDraft, command: GameCommand): DevelopmentEventInput[] {
  requireManagementPhase(draft);
  return [sellUpgradeCore(draft, command.actorId, spaceIdPayload(command))];
}

/** Row 9 — MORTGAGE in TURN_MANAGEMENT (spec §8). */
export function mortgageManagementHandler(draft: GameStateDraft, command: GameCommand): DevelopmentEventInput[] {
  requireManagementPhase(draft);
  return [mortgageCore(draft, command.actorId, spaceIdPayload(command))];
}

/** Row 9 — UNMORTGAGE: pay the bank 110% of the list price (spec §8). */
export function unmortgageHandler(draft: GameStateDraft, command: GameCommand): DevelopmentEventInput[] {
  requireManagementPhase(draft);
  const spaceId = spaceIdPayload(command);
  const space = requireOwnedPurchasable(draft, command.actorId, spaceId);
  if (!draft.mortgaged[spaceId]) {
    throw new RuleError('RULE_VIOLATION', `${spaceId} is not mortgaged`, { spaceId });
  }
  const cost = unmortgageCost(space.listPrice);
  const player: DraftPlayer = requirePlayer(draft, command.actorId);
  if (player.cash < cost) {
    throw new RuleError('INSUFFICIENT_RESOURCES', `lifting the mortgage on ${spaceId} costs $${cost}; player ${player.id} holds $${player.cash}`, {
      needed: cost,
      cash: player.cash,
    });
  }
  player.cash -= cost;
  const mortgaged = { ...draft.mortgaged };
  delete mortgaged[spaceId];
  draft.mortgaged = mortgaged;
  return [{ type: 'MORTGAGE_LIFTED', payload: { playerId: player.id, spaceId, cost } }];
}
