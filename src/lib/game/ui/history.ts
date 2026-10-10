'use client';

import type { AnyGameEvent } from '../events';
import { BOARD_SPACES, EVENT_DECK_CATALOG } from '../board-v1';
import { BANK_ID } from '../types';
import { victoryReasonText } from './actionDock';
import { cardEffectText } from './modals';
import { tradeSideText } from './tradeBuilder';
import { describeEvent } from './uiPlayer';

/**
 * The activity history projection (spec §11): every loggable event becomes
 * one headline plus — for money movements — the worked arithmetic carried
 * by the event payload itself. The UI never recomputes a formula: rent
 * detail, levy basis, and service dice/multiplier are payload facts,
 * printed exactly as applied.
 */

export interface HistoryEntry {
  readonly sequence: number;
  readonly headline: string;
  /** The worked arithmetic behind a money movement, straight from the payload. */
  readonly detail: string | null;
  /** True when dollars moved in this event — drives the explanation styling. */
  readonly money: boolean;
}

/** The published levy rate of the Municipal Levy space (board data, not recomputation). */
function levyRateText(): string {
  const levy = BOARD_SPACES.find((s) => s.kind === 'ASSESSMENT' && s.taxKind === 'MUNICIPAL_LEVY');
  if (!levy || levy.kind !== 'ASSESSMENT' || levy.levy.kind !== 'CASH_RATE') return 'Levy';
  return `${Math.round(levy.levy.cashRate * 100)}% levy`;
}

function tradeResponseVerb(response: string): string {
  switch (response) {
    case 'ACCEPT':
      return 'accepted';
    case 'REJECT':
      return 'rejected';
    case 'COUNTER':
      return 'countered';
    default:
      return response;
  }
}

function debtReasonText(reason: string): string {
  switch (reason) {
    case 'RENT':
      return 'rent';
    case 'TAX':
      return 'tax';
    case 'SERVICE':
      return 'a service charge';
    case 'CARD':
      return 'a card penalty';
    default:
      return reason;
  }
}

function spaceName(spaceId: string): string {
  return BOARD_SPACES.find((s) => s.id === spaceId)?.name ?? spaceId;
}

type Described = { readonly headline: string; readonly detail: string | null; readonly money: boolean };

/** Economy-and-beyond lines — the types `describeEvent` does not render. */
function describeExtended(event: AnyGameEvent): Described | null {
  switch (event.type) {
    case 'RENT_PAID': {
      const d = event.payload.detail;
      let detail: string;
      if (d.via === 'PROPERTY') {
        const parts = [`$${d.base.toLocaleString()} base`];
        if (d.levelMultiplier !== 1) parts.push(`${d.levelMultiplier} (level multiplier)`);
        if (d.districtMultiplier !== 1) parts.push(`${d.districtMultiplier} (district)`);
        detail = parts.join(' × ');
      } else {
        detail = `${d.hubCount} ${d.hubCount === 1 ? 'hub' : 'hubs'} held`;
      }
      if (event.payload.rentHolidayApplied) detail += ' — halved by a Rent Holiday token';
      return {
        headline: `Rent $${event.payload.amount.toLocaleString()} from ${event.payload.payerId} to ${event.payload.ownerId}`,
        detail,
        money: true,
      };
    }
    case 'TAX_PAID': {
      const isLevy = event.payload.taxKind === 'MUNICIPAL_LEVY';
      const detail =
        isLevy && event.payload.levyCashBasis !== undefined
          ? `${levyRateText()} of $${event.payload.levyCashBasis.toLocaleString()} cash on hand`
          : null;
      return {
        headline: `Tax $${event.payload.amount.toLocaleString()} — ${isLevy ? 'Municipal Levy' : 'Assessment Office'}`,
        detail,
        money: true,
      };
    }
    case 'SERVICE_CHARGED':
      return {
        headline: `Service charge $${event.payload.amount.toLocaleString()} — ${spaceName(event.payload.spaceId)}`,
        detail: `${event.payload.diceTotal} (dice) × ${event.payload.multiplier} (multiplier)`,
        money: true,
      };
    case 'CARD_DRAWN':
      return { headline: `${event.payload.playerId} drew an Event card`, detail: null, money: false };
    case 'CARD_EFFECT_APPLIED': {
      const card = EVENT_DECK_CATALOG.find((c) => c.id === event.payload.cardId);
      const effect = cardEffectText(event.payload.effect);
      return {
        headline: `${card?.title ?? event.payload.cardId} — ${effect}`,
        detail: null,
        money: event.payload.effect.kind === 'PAY' || event.payload.effect.kind === 'COLLECT',
      };
    }
    case 'UPGRADE_BUILT':
      return {
        headline: `${event.payload.playerId} built level ${event.payload.level} on ${spaceName(event.payload.spaceId)}`,
        detail: `−$${event.payload.cost.toLocaleString()}`,
        money: true,
      };
    case 'UPGRADE_SOLD':
      return {
        headline: `${event.payload.playerId} sold a level on ${spaceName(event.payload.spaceId)}`,
        detail: `+$${event.payload.proceeds.toLocaleString()}`,
        money: true,
      };
    case 'MORTGAGE_TAKEN':
      return {
        headline: `${event.payload.playerId} mortgaged ${spaceName(event.payload.spaceId)}`,
        detail: `+$${event.payload.proceeds.toLocaleString()}`,
        money: true,
      };
    case 'MORTGAGE_LIFTED':
      return {
        headline: `${event.payload.playerId} lifted the mortgage on ${spaceName(event.payload.spaceId)}`,
        detail: `−$${event.payload.cost.toLocaleString()}`,
        money: true,
      };
    case 'AUCTION_OPENED':
      return {
        headline: `${spaceName(event.payload.spaceId)} goes to auction (${event.payload.reason === 'DECLINED' ? 'declined' : 'bank-creditor estate'})`,
        detail: null,
        money: false,
      };
    case 'AUCTION_BID':
      return { headline: `${event.payload.bidderId} bid $${event.payload.amount.toLocaleString()}`, detail: null, money: false };
    case 'AUCTION_PASS':
      return { headline: `${event.payload.bidderId} passed`, detail: null, money: false };
    case 'AUCTION_RESOLVED':
      return {
        headline: `${event.payload.winnerId} won ${spaceName(event.payload.spaceId)} for $${event.payload.amount.toLocaleString()}`,
        detail: null,
        money: true,
      };
    case 'AUCTION_CLOSED_UNSOLD':
      return { headline: `${spaceName(event.payload.spaceId)} drew no bids — stays with the bank`, detail: null, money: false };
    case 'TRADE_OFFERED': {
      const { offer, proposerId, recipientId } = event.payload;
      return {
        headline: `${proposerId} offered a trade to ${recipientId}`,
        detail: `${proposerId} gives ${tradeSideText(offer.give.cash, offer.give.spaceIds)} — ${recipientId} gives ${tradeSideText(offer.receive.cash, offer.receive.spaceIds)}`,
        money: false,
      };
    }
    case 'TRADE_ANSWERED':
      return {
        headline: `${event.payload.responderId} ${tradeResponseVerb(event.payload.response)} the trade`,
        detail: null,
        money: false,
      };
    case 'TRADE_EXPIRED':
      return { headline: 'The pending trade offer expired', detail: null, money: false };
    case 'TRADE_CANCELLED':
      return { headline: 'The pending trade offer was cancelled (a party left the game)', detail: null, money: false };
    case 'DEBT_ENTERED':
      return {
        headline: `${event.payload.debtorId} owes $${event.payload.amount.toLocaleString()} (${debtReasonText(event.payload.reason)})`,
        detail: null,
        money: false,
      };
    case 'DEBT_SETTLED':
      return {
        headline: `${event.payload.debtorId} settled the debt`,
        detail: `−$${event.payload.amount.toLocaleString()} to ${event.payload.creditorId === BANK_ID ? 'the bank' : event.payload.creditorId}`,
        money: true,
      };
    case 'PLAYER_BANKRUPT':
      return { headline: `${event.payload.playerId} is bankrupt`, detail: null, money: false };
    case 'ASSETS_TRANSFERRED': {
      const to = event.payload.toId === BANK_ID ? 'the bank' : event.payload.toId;
      return {
        headline: `Estate of ${event.payload.fromId} settled`,
        detail: `$${event.payload.cash.toLocaleString()} and ${event.payload.spaceIds.length} ${event.payload.spaceIds.length === 1 ? 'property' : 'properties'} to ${to}`,
        money: true,
      };
    }
    case 'PLAYER_ELIMINATED':
      return { headline: `${event.payload.playerId} was eliminated`, detail: null, money: false };
    case 'VICTORY_DECIDED':
    case 'GAME_ENDED': {
      const winners = event.payload.winnerIds.join(', ');
      return { headline: `Victory: ${winners} — ${victoryReasonText(event.payload.reason)}`, detail: null, money: false };
    }
    case 'SNAPSHOT_SAVED':
      return { headline: `Game saved at move ${event.payload.stateVersion}`, detail: null, money: false };
    default:
      return null;
  }
}

/** Full-history entries: the shared describeEvent lines plus every economy event.
 *  An event type neither describer knows still appears by its raw type —
 *  the log never silently drops a fact. */
export function historyEntries(history: readonly AnyGameEvent[]): readonly HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const event of history) {
    const base = describeEvent(event);
    if (base !== null) {
      entries.push({ sequence: event.sequence, headline: base, detail: null, money: false });
      continue;
    }
    const described = describeExtended(event);
    if (described !== null) {
      entries.push({ sequence: event.sequence, ...described });
      continue;
    }
    entries.push({ sequence: event.sequence, headline: event.type, detail: null, money: false });
  }
  return entries;
}

/** Convenience for the page: the newest entry first. */
export function historyNewestFirst(history: readonly AnyGameEvent[]): readonly HistoryEntry[] {
  return [...historyEntries(history)].reverse();
}
