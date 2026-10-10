'use client';

import { useState } from 'react';
import type { GameState, PlayerId } from '@/lib/game/types';
import { auctionPanel } from '@/lib/game/ui/actionDock';
import { playerColor } from '@/lib/game/ui/uiPlayer';
import { AUCTION_MINIMUM_INCREMENT, AUCTION_OPENING_BID } from '@/lib/game/rules-v1';
import { Modal } from './Modal';

/**
 * The auction modal (spec §5, §11): the non-dismissible decision surface for
 * an open auction — a declined buy or a bank-creditor estate sale (same
 * rules). Bids are cash-backed and ascend in $10 steps; passing is binding.
 * Per-bidder controls because the device is shared in hot-seat. All legality
 * comes from the pinned `auctionPanel` projection — this component renders.
 */
export function AuctionModal({
  state,
  pending,
  onSubmit,
}: {
  state: GameState;
  pending: boolean;
  onSubmit: (type: 'BID' | 'PASS_BID', payload?: Record<string, unknown>, actorId?: PlayerId) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const panel = auctionPanel(state);
  if (!panel) return null;
  const auction = state.auction;
  const estate = auction?.reason === 'BANK_ESTATE' ? state.estateSale : null;
  const remainingAfter = estate ? estate.pendingSpaceIds.length : 0;

  return (
    <Modal title={`Auction — ${panel.spaceName}`} titleId="auction-modal-title" dismissible={false}>
      <p className="text-xs text-slate-400">
        {panel.reason === 'BANK_ESTATE'
          ? `Estate sale: ${estate?.debtorId ?? 'the bankrupt player'}'s properties are sold one by one to the highest bidder${remainingAfter > 0 ? ` — ${remainingAfter} more after this one` : ''}.`
          : 'The landing player declined to buy — every solvent player may bid, the decliner included.'}
      </p>
      <p className="mt-2 text-sm text-slate-300" aria-live="polite">
        {panel.currentBid === null
          ? `No bids yet — opening minimum $${AUCTION_OPENING_BID.toLocaleString()}.`
          : `Standing bid $${panel.currentBid.toLocaleString()} by ${panel.highBidderId}.`}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {panel.bidders.map((bidder) => {
          const draft = drafts[bidder.playerId] ?? String(bidder.minBid);
          const amount = Number.parseInt(draft, 10);
          const amountValid = Number.isInteger(amount) && amount >= bidder.minBid && (amount - bidder.minBid) % AUCTION_MINIMUM_INCREMENT === 0;
          return (
            <li key={bidder.playerId} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#2c4250] px-3 py-2">
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-full border border-white/70"
                style={{ background: playerColor(state.players.findIndex((p) => p.id === bidder.playerId)) }}
              />
              <span className="text-sm font-semibold">{bidder.playerId}</span>
              <label className="sr-only" htmlFor={`bid-${bidder.playerId}`}>
                Bid amount for {bidder.playerId}
              </label>
              <input
                id={`bid-${bidder.playerId}`}
                type="number"
                inputMode="numeric"
                step={10}
                min={bidder.minBid}
                value={draft}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [bidder.playerId]: event.target.value }))}
                className="w-24 rounded-md border border-[#587078] bg-[#15242e] px-2 py-1 text-sm"
                aria-describedby={`bid-note-${bidder.playerId}`}
              />
              <button
                className="cta text-sm"
                disabled={pending || bidder.bidDisabledReason !== null || !amountValid}
                onClick={() => onSubmit('BID', { auctionId: state.auction?.auctionId, amount }, bidder.playerId)}
              >
                Bid ${amount.toLocaleString()}
              </button>
              <button
                className="secondary text-sm"
                disabled={pending || bidder.passDisabledReason !== null}
                title={bidder.passDisabledReason ?? undefined}
                onClick={() => onSubmit('PASS_BID', { auctionId: state.auction?.auctionId }, bidder.playerId)}
              >
                Pass
              </button>
              <span id={`bid-note-${bidder.playerId}`} className="w-full text-xs text-[#e8a87c]">
                {bidder.bidDisabledReason ?? `Minimum bid $${bidder.minBid.toLocaleString()} — $${AUCTION_MINIMUM_INCREMENT.toLocaleString()} steps, cash-backed.`}
              </span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
