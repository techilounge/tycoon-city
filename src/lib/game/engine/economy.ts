/**
 * Economy resolution (spec §4 row 3, §8): what happens when a token lands.
 *
 * Every charge flows through chargePlayer — the single pay-or-enter-debt
 * seam (spec §7): a payer who can afford the charge pays it on the spot and
 * the charge's receipt event is pushed by the charge site; a payer who
 * cannot has the debt recorded (exactly one creditor in Phase 1) and the
 * turn pauses in SETTLING_DEBT. Resolution of a landing may chain through
 * Event-Deck movement cards; every hop resolves the space it lands on until
 * the token rests or a debt pauses the turn.
 *
 * This module is engine-internal: it mutates the reducer's draft and returns
 * event drafts for stamping. Its event vocabulary is deliberately narrower
 * than the full Phase 1 set — EconomyEventInput names every type this
 * surface can emit, which is exactly the §17.2 structural guarantee that no
 * economy path can produce a bankruptcy event in this build.
 */
import {
  BOARD_SPACES,
  DISTRICTS,
  EVENT_DECK_CATALOG,
  START_BONUS,
  type AssessmentSpace,
  type EventCard,
  type EventCardEffect,
  type HubSpace,
  type PropertySpace,
  type ServiceSpace,
} from '../board-v1';
import type { EventInput, RentDetail } from '../events';
import {
  DISTRICT_COMPLETE_MULTIPLIER,
  LEVEL_RENT_MULTIPLIERS,
  SERVICE_MULTIPLIER_BOTH,
  SERVICE_MULTIPLIER_SINGLE,
  assessmentCharge,
  baseRent,
  hubRent,
  rentFor,
  rentHolidayAdjusted,
  resolveCardMove,
  serviceCharge,
} from '../rules-v1';
import type { CreditorId, DebtReason, PlayerId } from '../types';
import { BANK_ID } from '../types';
import type { RandomSource } from '../rng';
import type { DraftPlayer, GameStateDraft } from './draft';
import { requirePlayer } from './draft';

/** The event vocabulary of the economy surface — every type resolveLanding
 *  and its charges can emit. No bankruptcy event is reachable from this
 *  union (spec §17.2 negative tests pin the Extract at type level). */
export type EconomyEventInput =
  | EventInput<'PLAYER_MOVED'>
  | EventInput<'START_BONUS_PAID'>
  | EventInput<'RENT_PAID'>
  | EventInput<'TAX_PAID'>
  | EventInput<'SERVICE_CHARGED'>
  | EventInput<'CARD_DRAWN'>
  | EventInput<'CARD_EFFECT_APPLIED'>
  | EventInput<'TOKEN_CONSUMED'>
  | EventInput<'DEBT_ENTERED'>;

/** Landing chains are bounded: the v1 catalog's movement cards target fixed
 *  properties, hubs, and the start space — never another Event space — so a
 *  chain longer than a handful of hops is a board-data bug, not gameplay. */
const MAX_LANDING_CHAIN = 10;

export type ChargeOutcome = 'PAID' | 'DEBT_ENTERED';

/**
 * The single charge seam (spec §7): pay the creditor in full when the payer
 * can afford it, or record the debt and pause the turn in SETTLING_DEBT.
 * Bank creditors absorb the cash; player creditors are credited exactly.
 * The receipt event for a paid charge is pushed by the charge site, which
 * owns its shape (RENT_PAID, TAX_PAID, SERVICE_CHARGED, or the card's own
 * CARD_EFFECT_APPLIED).
 */
function chargePlayer(
  draft: GameStateDraft,
  payer: DraftPlayer,
  amount: number,
  reason: DebtReason,
  creditorId: CreditorId,
  events: EconomyEventInput[],
): ChargeOutcome {
  if (payer.cash >= amount) {
    payer.cash -= amount;
    if (creditorId !== BANK_ID) requirePlayer(draft, creditorId).cash += amount;
    return 'PAID';
  }
  draft.debt = { debtorId: payer.id, creditorId, amountDue: amount, reason };
  draft.turnPhase = 'SETTLING_DEBT';
  events.push({ type: 'DEBT_ENTERED', payload: { debtorId: payer.id, creditorId, amount, reason } });
  return 'DEBT_ENTERED';
}

/**
 * Spend the payer's Rent Holiday token on a rent charge (only rent — never
 * taxes, service charges, or card penalties, spec §4): the token is consumed
 * the moment rent is owed, before affordability is tested, and the due amount
 * is the halved figure (spec §7). Returns the due amount.
 */
function spendRentHoliday(draft: GameStateDraft, payer: DraftPlayer, rent: number, events: EconomyEventInput[]): number {
  if (payer.tokens.RENT_HOLIDAY < 1) return rent;
  payer.tokens = { ...payer.tokens, RENT_HOLIDAY: payer.tokens.RENT_HOLIDAY - 1 };
  events.push({ type: 'TOKEN_CONSUMED', payload: { playerId: payer.id, token: 'RENT_HOLIDAY' } });
  return rentHolidayAdjusted(rent);
}

function isDistrictComplete(draft: GameStateDraft, ownerId: PlayerId, districtId: PropertySpace['districtId']): boolean {
  const district = DISTRICTS.find((d) => d.id === districtId);
  if (!district) throw new Error(`board data: unknown district id "${districtId}"`);
  return district.spaceIds.every((spaceId) => draft.owners[spaceId] === ownerId);
}

function countOwnedKind(draft: GameStateDraft, ownerId: PlayerId, kind: HubSpace['kind'] | ServiceSpace['kind']): number {
  return BOARD_SPACES.filter((space) => space.kind === kind && draft.owners[space.id] === ownerId).length;
}

function resolvePropertyRent(draft: GameStateDraft, payer: DraftPlayer, space: PropertySpace, events: EconomyEventInput[]): void {
  const ownerId = draft.owners[space.id];
  // Unowned spaces are handled by the caller's buy-decision tail; landing on
  // your own property charges nothing; a mortgaged property collects no rent
  // (spec §8) — and owing no rent, consumes no Rent Holiday.
  if (ownerId === undefined || ownerId === payer.id || draft.mortgaged[space.id]) return;
  const level = draft.upgrades[space.id] ?? 0;
  const districtComplete = isDistrictComplete(draft, ownerId, space.districtId);
  const levelMultiplier = LEVEL_RENT_MULTIPLIERS[level];
  const districtMultiplier = districtComplete ? DISTRICT_COMPLETE_MULTIPLIER : 1;
  const rent = rentFor({ listPrice: space.listPrice, level, districtComplete });
  const due = spendRentHoliday(draft, payer, rent, events);
  const holidayApplied = due !== rent;
  const detail: RentDetail = { via: 'PROPERTY', base: baseRent(space.listPrice), levelMultiplier, districtMultiplier };
  if (chargePlayer(draft, payer, due, 'RENT', ownerId, events) === 'PAID') {
    events.push({
      type: 'RENT_PAID',
      payload: { payerId: payer.id, ownerId, spaceId: space.id, amount: due, detail, rentHolidayApplied: holidayApplied },
    });
  }
}

function resolveHubRent(draft: GameStateDraft, payer: DraftPlayer, space: HubSpace, events: EconomyEventInput[]): void {
  const ownerId = draft.owners[space.id];
  if (ownerId === undefined || ownerId === payer.id) return;
  // The owner of this hub holds at least one; both hubs double the rent.
  const hubCount = Math.min(countOwnedKind(draft, ownerId, 'HUB'), 2) as 1 | 2;
  const rent = hubRent(hubCount);
  const due = spendRentHoliday(draft, payer, rent, events);
  const holidayApplied = due !== rent;
  const detail: RentDetail = { via: 'HUB', hubCount };
  if (chargePlayer(draft, payer, due, 'RENT', ownerId, events) === 'PAID') {
    events.push({
      type: 'RENT_PAID',
      payload: { payerId: payer.id, ownerId, spaceId: space.id, amount: due, detail, rentHolidayApplied: holidayApplied },
    });
  }
}

function resolveServiceCharge(draft: GameStateDraft, payer: DraftPlayer, space: ServiceSpace, diceTotal: number, events: EconomyEventInput[]): void {
  const ownerId = draft.owners[space.id];
  if (ownerId === undefined || ownerId === payer.id) return;
  const servicesOwned = countOwnedKind(draft, ownerId, 'SERVICE');
  const multiplier = servicesOwned >= 2 ? SERVICE_MULTIPLIER_BOTH : SERVICE_MULTIPLIER_SINGLE;
  const charge = serviceCharge(diceTotal, servicesOwned);
  // A service charge is not rent — the Rent Holiday never applies (spec §4).
  if (chargePlayer(draft, payer, charge, 'SERVICE', ownerId, events) === 'PAID') {
    events.push({
      type: 'SERVICE_CHARGED',
      payload: { playerId: payer.id, spaceId: space.id, amount: charge, diceTotal, multiplier },
    });
  }
}

function resolveAssessment(draft: GameStateDraft, payer: DraftPlayer, space: AssessmentSpace, events: EconomyEventInput[]): void {
  // Computed on the payer's current cash (spec §8: the levy is 8% of it).
  const charge = assessmentCharge(space, payer.cash);
  const levyCashBasis = space.levy.kind === 'CASH_RATE' ? payer.cash : undefined;
  if (chargePlayer(draft, payer, charge, 'TAX', BANK_ID, events) === 'PAID') {
    events.push({
      type: 'TAX_PAID',
      payload: {
        playerId: payer.id,
        amount: charge,
        taxKind: space.taxKind,
        ...(levyCashBasis === undefined ? {} : { levyCashBasis }),
      },
    });
  }
}

function cardById(cardId: string): EventCard {
  const card = EVENT_DECK_CATALOG.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error(`board data: unknown event card id "${cardId}"`);
  return card;
}

/**
 * Draw the top card of the Event Deck (spec §3, §11): pile orders are
 * ordinary state. An empty draw pile shuffles the discard pile — or, before
 * the game's first draw, the catalog itself — with the game's seeded random
 * source, so draw order is fully seed-determined and replay reproduces it
 * exactly. Drawn cards move to the discard pile.
 */
function drawEventCard(draft: GameStateDraft, rng: RandomSource): string {
  let drawPile = draft.eventDeck.drawPile;
  let discardPile = draft.eventDeck.discardPile;
  if (drawPile.length === 0) {
    drawPile = rng.shuffle(discardPile.length > 0 ? discardPile : EVENT_DECK_CATALOG.map((card) => card.id));
    discardPile = [];
  }
  const [top] = drawPile;
  if (top === undefined) throw new Error('engine bug: event deck draw found no card after reshuffle');
  draft.eventDeck = { drawPile: drawPile.slice(1), discardPile: [...discardPile, top] };
  return top;
}

/** Apply one drawn card (spec §8 catalog): movement cards route the token
 *  through its ordinary movement path; money and token effects apply here.
 *  Returns true when the effect moved the token and the new landing must be
 *  resolved. */
function applyCardEffect(draft: GameStateDraft, player: DraftPlayer, effect: EventCardEffect, events: EconomyEventInput[]): boolean {
  switch (effect.kind) {
    case 'MOVE_TO':
    case 'MOVE_TO_NEAREST_HUB':
    case 'MOVE_BACK': {
      const outcome = resolveCardMove(BOARD_SPACES, player.position, effect);
      events.push({
        type: 'PLAYER_MOVED',
        payload: { playerId: player.id, from: player.position, to: outcome.toIndex, direction: outcome.direction },
      });
      player.position = outcome.toIndex;
      if (outcome.passesGateway) {
        player.cash += START_BONUS;
        events.push({ type: 'START_BONUS_PAID', payload: { playerId: player.id, amount: START_BONUS } });
      }
      return true;
    }
    case 'PAY':
      // Card debts are owed to the bank (single-creditor scope, spec §7).
      // CARD_EFFECT_APPLIED — already pushed by the caller — is the payment's
      // receipt: it carries the full effect, amount included.
      chargePlayer(draft, player, effect.amount, 'CARD', BANK_ID, events);
      return false;
    case 'COLLECT':
      player.cash += effect.amount;
      return false;
    case 'GRANT_TOKEN':
      player.tokens = { ...player.tokens, [effect.token]: player.tokens[effect.token] + 1 };
      return false;
  }
}

/**
 * Resolve the space under the player's token, chasing Event-Deck movement
 * cards until the token rests on a non-event space or a charge pauses the
 * turn in SETTLING_DEBT (spec §4 row 3). The caller selects the landing
 * turn phase from the resting position and the resulting debt state.
 */
export function resolveLanding(draft: GameStateDraft, playerId: PlayerId, diceTotal: number, rng: RandomSource): EconomyEventInput[] {
  const events: EconomyEventInput[] = [];
  const player = requirePlayer(draft, playerId);
  for (let hop = 0; hop < MAX_LANDING_CHAIN; hop++) {
    // A shorted charge handed the turn to SETTLING_DEBT — resolution pauses
    // there until the debt settles (spec §7); nothing further resolves.
    if (draft.debt) return events;
    const space = BOARD_SPACES[player.position];
    if (space.kind === 'EVENT') {
      const cardId = drawEventCard(draft, rng);
      const card = cardById(cardId);
      events.push({ type: 'CARD_DRAWN', payload: { playerId }, meta: { cardId } });
      events.push({ type: 'CARD_EFFECT_APPLIED', payload: { playerId, cardId, effect: card.effect } });
      if (applyCardEffect(draft, player, card.effect, events)) continue;
      return events;
    }
    switch (space.kind) {
      case 'PROPERTY':
        resolvePropertyRent(draft, player, space, events);
        return events;
      case 'HUB':
        resolveHubRent(draft, player, space, events);
        return events;
      case 'SERVICE':
        resolveServiceCharge(draft, player, space, diceTotal, events);
        return events;
      case 'ASSESSMENT':
        resolveAssessment(draft, player, space, events);
        return events;
      case 'START':
      case 'PARK':
        // No effect on either (spec §8) — the start bonus, when due, was
        // already paid by the movement that arrived here.
        return events;
    }
  }
  throw new Error(`board data: event-card movement chain exceeded the ${MAX_LANDING_CHAIN}-hop depth guard — check EVENT_DECK_CATALOG targets`);
}
