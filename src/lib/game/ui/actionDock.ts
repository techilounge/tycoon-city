/**
 * Context-sensitive action dock (spec §11, §12 PR 10): a pure projection of
 * GameState onto the commands that are legal right now, each with a plain
 * reason when disabled. The reducer owns legality — this module renders it,
 * reusing the same rules-v1 formulas the engine uses instead of duplicating
 * them. The dock component renders these structures; nothing here touches DOM.
 */
import {
  BOARD_SPACES,
  isPurchasable,
  type DistrictId,
  type PropertySpace,
  type PurchasableSpace,
} from '../board-v1';
import {
  AUCTION_MINIMUM_INCREMENT,
  AUCTION_OPENING_BID,
  isLegalBidAmount,
  MAX_UPGRADE_LEVEL,
  unmortgageCost,
  upgradeCost,
  upgradeSellBackProceeds,
} from '../rules-v1';
import type { AnyGameEvent, VictoryReason } from '../events';
import type { AuctionState, GameState, PlayerId, PlayerState } from '../types';
import type { CommandType } from '../commands';
import { buyOffer } from './uiPlayer';

export interface DockAction {
  readonly command: CommandType;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly label: string;
  /** Supporting line — cost, proceeds, or what the command does. */
  readonly detail?: string;
  /** Present → render the control disabled with this explanation. */
  readonly disabledReason?: string;
  readonly primary?: boolean;
  /** Destructive intent (surrender) — the component adds a confirm step. */
  readonly danger?: boolean;
  /** Who issues this command; defaults to the active player. Hot-seat auctions
   *  and trade answers belong to other seats on the shared device (spec §5–§6). */
  readonly actorId?: PlayerId;
}

export interface DockGroup {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly actions: readonly DockAction[];
}

/** The standing high bid plus one minimum increment (the opening minimum on an untouched auction). */
export function nextBidAmount(auction: AuctionState): number {
  return auction.currentBid === null ? AUCTION_OPENING_BID : auction.currentBid + AUCTION_MINIMUM_INCREMENT;
}

/** Every district property of `districtId` on the board. */
function districtSpaces(districtId: DistrictId): readonly PropertySpace[] {
  return BOARD_SPACES.filter((space): space is PropertySpace => space.kind === 'PROPERTY' && space.districtId === districtId);
}

/** True when one player owns every space of the district (the BUILD prerequisite, spec §8). */
export function districtComplete(state: GameState, districtId: DistrictId, ownerId: PlayerId): boolean {
  return districtSpaces(districtId).every((space) => state.owners[space.id] === ownerId);
}

function playerById(state: GameState, playerId: PlayerId): PlayerState {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`actionDock: unknown player ${playerId}`);
  return player;
}

/** LOBBY / GAME_OVER / each turn phase → its dock groups. */
export function dockGroups(state: GameState): readonly DockGroup[] {
  if (state.phase === 'LOBBY') {
    return [
      {
        id: 'start',
        title: 'Ready to begin',
        note: 'Start when everyone can see the screen.',
        actions: [{ command: 'START_GAME', label: 'Start game', primary: true }],
      },
    ];
  }
  if (state.phase === 'GAME_OVER') return [];

  const active = state.activePlayerId ? state.players.find((p) => p.id === state.activePlayerId) : undefined;
  const groups: DockGroup[] = [];
  const actorName = active?.id ?? 'the active player';

  switch (state.turnPhase) {
    case 'AWAITING_ROLL': {
      const actions: DockAction[] = [{ command: 'ROLL', label: 'Roll dice', primary: true }];
      if (active && active.tokens.HOLD >= 1) {
        actions.push({
          command: 'HOLD',
          label: `Hold — skip turn (${active.tokens.HOLD} left)`,
          detail: 'Consumes a Hold token: no roll, no move, no management.',
        });
      }
      groups.push({ id: 'roll', title: `${actorName} — roll`, note: 'Roll to move around the perimeter.', actions });
      break;
    }

    case 'RESOLVING_MOVE':
      groups.push({ id: 'resolve', title: 'Resolving the move…', note: 'Movement and the landing resolve automatically.', actions: [] });
      break;

    case 'BUY_DECISION': {
      const offer = buyOffer(state);
      const buyReason =
        offer && active && active.cash < offer.listPrice
          ? 'Needs $' + offer.listPrice.toLocaleString() + '; ' + actorName + ' has $' + active.cash.toLocaleString() + '.'
          : undefined;
      groups.push({
        id: 'buy',
        title: offer ? `Buy or decline: ${offer.name}` : 'Buy or decline',
        note: offer ? 'Declining opens a cash-backed auction open to every solvent player.' : undefined,
        actions: [
          {
            command: 'BUY',
            label: offer ? `Buy ${offer.name} — $` + offer.listPrice.toLocaleString() : 'Buy',
            primary: true,
            disabledReason: buyReason,
          },
          { command: 'PASS_TO_AUCTION', label: 'Decline — open auction' },
        ],
      });
      break;
    }

    case 'TURN_MANAGEMENT': {
      groups.push({
        id: 'end',
        title: `${actorName} — manage, then end the turn`,
        note: 'Develop, trade, or end the turn — the composer and modals open over the board.',
        actions: [{ command: 'END_TURN', label: 'End turn', primary: true }],
      });

      const management: DockAction[] = [];
      for (const space of BOARD_SPACES) {
        if (!isPurchasable(space) || state.owners[space.id] !== state.activePlayerId) continue;
        const level = state.upgrades[space.id] ?? 0;
        const mortgaged = state.mortgaged[space.id] === true;
        const funds = active?.cash ?? 0;

        // Levels live on district properties only; mortgages apply to every purchasable.
        if (space.kind === 'PROPERTY') {
          const cost = upgradeCost(space.listPrice);
          if (level < MAX_UPGRADE_LEVEL) {
            const buildReason = mortgaged
              ? 'Mortgaged — lift the mortgage first.'
              : !districtComplete(state, space.districtId, state.owners[space.id])
                ? 'Requires owning the whole district.'
                : funds < cost
                  ? 'Needs $' + cost.toLocaleString() + '; available $' + funds.toLocaleString() + '.'
                  : undefined;
            management.push({
              command: 'BUILD',
              payload: { spaceId: space.id },
              label: `Build on ${space.name} — $` + cost.toLocaleString(),
              disabledReason: buildReason,
            });
          }
          if (level > 0) {
            const proceeds = upgradeSellBackProceeds(level * upgradeCost(space.listPrice));
            management.push({
              command: 'SELL_UPGRADE',
              payload: { spaceId: space.id },
              label: `Sell a level on ${space.name} — +$` + proceeds.toLocaleString(),
              detail: 'Sold at 50% of what was paid for levels.',
            });
          }
        }

        if (!mortgaged) {
          management.push({
            command: 'MORTGAGE',
            payload: { spaceId: space.id },
            label: `Mortgage ${space.name} — +$` + Math.floor(space.listPrice / 2).toLocaleString(),
            detail: 'No rent while mortgaged; lifting later costs 110% of list.',
            disabledReason: level > 0 ? 'Sell the buildings first (mortgage needs level 0).' : undefined,
          });
        } else {
          const lift = unmortgageCost(space.listPrice);
          management.push({
            command: 'UNMORTGAGE',
            payload: { spaceId: space.id },
            label: `Lift mortgage on ${space.name} — $` + lift.toLocaleString(),
            disabledReason: funds < lift ? 'Needs $' + lift.toLocaleString() + '; available $' + funds.toLocaleString() + '.' : undefined,
          });
        }
      }
      if (management.length > 0) {
        groups.push({ id: 'management', title: 'Development and mortgages', note: 'Only legal moves are listed — disabled ones explain why.', actions: management });
      }

      groups.push({
        id: 'surrender',
        title: 'Leave the game',
        note: 'Voluntary bankruptcy transfers everything to your creditor.',
        actions: [{ command: 'SURRENDER', label: 'Surrender', danger: true }],
      });
      break;
    }

    case 'SETTLING_DEBT': {
      const debt = state.debt;
      if (!debt) break;
      const debtor = state.players.find((p) => p.id === debt.debtorId);
      const due = debt.amountDue;
      const funds = debtor?.cash ?? 0;
      const liquidations: DockAction[] = [];
      for (const space of BOARD_SPACES) {
        if (!isPurchasable(space) || state.owners[space.id] !== debt.debtorId) continue;
        const level = state.upgrades[space.id] ?? 0;
        const mortgaged = state.mortgaged[space.id] === true;
        if (level > 0) {
          const proceeds = upgradeSellBackProceeds(level * upgradeCost(space.listPrice));
          liquidations.push({
            command: 'SELL_UPGRADE',
            payload: { spaceId: space.id },
            label: `Sell a level on ${space.name} — +$` + proceeds.toLocaleString(),
          });
        }
        if (!mortgaged) {
          liquidations.push({
            command: 'MORTGAGE',
            payload: { spaceId: space.id },
            label: `Mortgage ${space.name} — +$` + Math.floor(space.listPrice / 2).toLocaleString(),
            disabledReason: level > 0 ? 'Sell the buildings first (mortgage needs level 0).' : undefined,
          });
        }
      }

      groups.push({
        id: 'debt',
        title: 'Debt: owe $' + due.toLocaleString(),
        note: 'Settle in one payment, raise cash by liquidation or a consented trade, or surrender.',
        actions: [
          {
            command: 'SETTLE_DEBT',
            label: 'Pay $' + due.toLocaleString() + (debt.creditorId === 'BANK' ? ' to the bank' : ` to ${debt.creditorId}`),
            primary: true,
            disabledReason:
              funds < due
                ? 'Owe $' + due.toLocaleString() + '; only $' + funds.toLocaleString() + ' on hand — raise cash or surrender.'
                : undefined,
          },
          ...liquidations,
          { command: 'SURRENDER', label: 'Surrender', danger: true },
        ],
      });
      break;
    }

    default:
      // AUCTION and ELIMINATION_AUCTIONS render through auctionPanel below.
      break;
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Auction panel (hot-seat: any eligible, non-passed bidder may act)

export interface BidderRow {
  readonly playerId: PlayerId;
  readonly minBid: number;
  readonly bidDisabledReason: string | null;
  /** The standing bidder cannot pass — the engine rejects it; name that rule instead of a silent failure. */
  readonly passDisabledReason: string | null;
}

export interface AuctionPanel {
  readonly spaceName: string;
  readonly reason: AuctionState['reason'];
  readonly currentBid: number | null;
  readonly highBidderId: PlayerId | null;
  readonly bidders: readonly BidderRow[];
}

/** The standing high bidder cannot pass — the engine rejects PASS_BID for them. */
function passDisabledReasonFor(auction: AuctionState, playerId: PlayerId): string | null {
  return auction.highBidderId === playerId ? `You hold the standing bid of ${(auction.currentBid ?? 0).toLocaleString()} — wait to be outbid or win.` : null;
}

/** The open auction as the dock renders it; null when no auction is open. */
export function auctionPanel(state: GameState): AuctionPanel | null {
  const auction = state.auction;
  if (!auction) return null;
  const space = BOARD_SPACES.find((s) => s.id === auction.spaceId);
  const bidders: BidderRow[] = [];
  for (const playerId of auction.eligiblePlayerIds) {
    if (auction.passedPlayerIds.includes(playerId)) continue;
    const player = playerById(state, playerId);
    const minBid = nextBidAmount(auction);
    let bidDisabledReason: string | null = null;
    if (!isLegalBidAmount(minBid, auction.currentBid)) bidDisabledReason = 'Bid is not a legal next bid.';
    else if (player.cash < minBid) bidDisabledReason = `Cash-backed bids: $${minBid.toLocaleString()} exceeds ${playerId}'s $${player.cash.toLocaleString()}.`;
    bidders.push({ playerId, minBid, bidDisabledReason, passDisabledReason: passDisabledReasonFor(auction, playerId) });
  }
  return {
    spaceName: space?.name ?? auction.spaceId,
    reason: auction.reason,
    currentBid: auction.currentBid,
    highBidderId: auction.highBidderId,
    bidders,
  };
}

// ---------------------------------------------------------------------------
// Pending trade panel (the recipient answers; the composer arrives with PR 11)

export interface TradePanel {
  readonly tradeId: string;
  readonly proposerId: PlayerId;
  readonly recipientId: PlayerId;
  readonly summary: string;
  readonly actions: readonly DockAction[];
}

function sideSummary(cash: number, spaceIds: readonly string[]): string {
  const parts: string[] = [];
  if (cash > 0) parts.push(`$${cash.toLocaleString()}`);
  if (spaceIds.length > 0) parts.push(spaceIds.join(', '));
  return parts.length > 0 ? parts.join(' + ') : 'nothing';
}

/** The one pending trade as the dock renders it; null when nothing is pending. */
export function tradePanel(state: GameState): TradePanel | null {
  const trade = state.trade;
  if (!trade) return null;
  return {
    tradeId: trade.tradeId,
    proposerId: trade.proposerId,
    recipientId: trade.recipientId,
    summary: `${trade.proposerId} offers ${sideSummary(trade.offer.give.cash, trade.offer.give.spaceIds)} for ${sideSummary(trade.offer.receive.cash, trade.offer.receive.spaceIds)}`,
    actions: [
      { command: 'ANSWER_TRADE', payload: { tradeId: trade.tradeId, response: 'ACCEPT' }, label: 'Accept trade', primary: true, actorId: trade.recipientId },
      { command: 'ANSWER_TRADE', payload: { tradeId: trade.tradeId, response: 'REJECT' }, label: 'Reject trade', actorId: trade.recipientId },
    ],
  };
}

/** The turn indicator headline (spec §11: a clear active-player indicator). */
export function turnHeadline(state: GameState): string {
  if (state.phase === 'LOBBY') return 'Lobby';
  if (state.phase === 'GAME_OVER') return 'Game over';
  const active = state.players.find((p) => p.id === state.activePlayerId);
  const who = active ? `${active.id}'s turn` : 'Between turns';
  switch (state.turnPhase) {
    case 'AWAITING_ROLL':
      return `${who} — roll to move`;
    case 'RESOLVING_MOVE':
      return `${who} — resolving the move`;
    case 'BUY_DECISION':
      return `${who} — buy or decline`;
    case 'AUCTION':
      return `Auction — ${who}`;
    case 'SETTLING_DEBT':
      return `${who} — settling debt`;
    case 'TURN_MANAGEMENT':
      return `${who} — manage, then end turn`;
    case 'ELIMINATION_AUCTIONS':
      return `Estate auction — ${state.estateSale?.debtorId ?? ''}'s estate`;
    default:
      return who;
  }
}

// Game-over presentation (the winner lives in the event log, not on state)

export interface GameOverSummary {
  readonly winnerIds: readonly PlayerId[];
  readonly reason: VictoryReason;
}

const VICTORY_REASON_TEXT: Record<VictoryReason, string> = {
  LAST_SOLVENT: 'the last solvent player standing',
  NET_WORTH_TARGET: 'reached the net-worth target',
  ROUND_CAP: 'richest when the round cap was reached',
};

/** Terminal victory read from the log; null until GAME_ENDED has fired. */
export function gameOverSummary(history: readonly AnyGameEvent[]): GameOverSummary | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const event = history[i];
    if (event.type === 'GAME_ENDED') {
      return { winnerIds: event.payload.winnerIds, reason: event.payload.reason };
    }
  }
  return null;
}

export function victoryReasonText(reason: VictoryReason): string {
  return VICTORY_REASON_TEXT[reason];
}
