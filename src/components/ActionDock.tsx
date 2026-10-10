'use client';

import { useState } from 'react';
import type { GameState } from '@/lib/game/types';
import type { DockAction } from '@/lib/game/ui/actionDock';
import { auctionPanel, dockGroups, tradePanel } from '@/lib/game/ui/actionDock';
import { playerColor } from '@/lib/game/ui/uiPlayer';

/**
 * The context-sensitive action dock (spec §11): only legal commands render,
 * disabled ones explain why, and multi-actor phases (auctions, pending
 * trades) expose per-player controls because the device is shared in hot-seat.
 * Rendering-only: legality comes from the pure dock module.
 */

type Submit = (type: DockAction['command'], payload?: Record<string, unknown>) => void;

function ActionButton({ action, pending, onSubmit }: { action: DockAction; pending: boolean; onSubmit: Submit }) {
  const [armed, setArmed] = useState(false);
  const disabled = pending || action.disabledReason !== undefined;
  const className = action.primary ? 'cta' : action.danger ? 'secondary text-[#e8a87c]' : 'secondary';
  const reason = action.disabledReason ?? null;
  const detail = action.detail && !reason ? <span className="text-xs text-slate-400">{action.detail}</span> : null;

  const button =
    action.danger && !reason ? (
      <button
        className={className}
        disabled={disabled}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          onSubmit(action.command, action.payload);
        }}
        onBlur={() => setArmed(false)}
      >
        {armed ? 'Confirm surrender?' : action.label}
      </button>
    ) : (
      <button
        className={className}
        disabled={disabled}
        title={reason ?? action.detail}
        onClick={() => onSubmit(action.command, action.payload)}
      >
        {action.label}
      </button>
    );

  return (
    <span className="flex flex-col items-start gap-1">
      {button}
      {detail}
      {reason && <span className="text-xs text-[#e8a87c]">{reason}</span>}
    </span>
  );
}

function AuctionSection({ state, pending, onSubmit }: { state: GameState; pending: boolean; onSubmit: Submit }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const panel = auctionPanel(state);
  if (!panel) return null;

  return (
    <section className="panel p-5" aria-label={`Auction for ${panel.spaceName}`}>
      <h3 className="text-base font-bold text-[#e3bd72]">Auction — {panel.spaceName}</h3>
      <p className="mt-1 text-sm text-slate-300" aria-live="polite">
        {panel.currentBid === null
          ? 'No bids yet — opening minimum $10.'
          : `Standing bid $${panel.currentBid.toLocaleString()} by ${panel.highBidderId}.`}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {panel.bidders.map((bidder) => {
          const draft = drafts[bidder.playerId] ?? String(bidder.minBid);
          const amount = Number.parseInt(draft, 10);
          const amountValid = Number.isInteger(amount) && amount >= bidder.minBid && (amount - bidder.minBid) % 10 === 0;
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
                onClick={() => onSubmit('BID', { auctionId: state.auction?.auctionId, amount })}
              >
                Bid ${amount.toLocaleString()}
              </button>
              <button
                className="secondary text-sm"
                disabled={pending}
                onClick={() => onSubmit('PASS_BID', { auctionId: state.auction?.auctionId })}
              >
                Pass
              </button>
              <span id={`bid-note-${bidder.playerId}`} className="w-full text-xs text-[#e8a87c]">
                {bidder.bidDisabledReason ?? `Minimum bid $${bidder.minBid.toLocaleString()} — $10 steps, cash-backed.`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TradeSection({ state, pending, onSubmit }: { state: GameState; pending: boolean; onSubmit: Submit }) {
  const panel = tradePanel(state);
  if (!panel) return null;
  return (
    <section className="panel p-5" aria-label={`Trade offer from ${panel.proposerId}`}>
      <h3 className="text-base font-bold text-[#e3bd72]">Trade offer</h3>
      <p className="mt-1 text-sm text-slate-300" aria-live="polite">
        {panel.summary} — {panel.recipientId} answers; the offer expires when {panel.proposerId}&apos;s turn ends.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        {panel.actions.map((action) => (
          <ActionButton key={action.label} action={action} pending={pending} onSubmit={onSubmit} />
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">Counteroffers arrive with the trade composer in the full UI update.</p>
    </section>
  );
}

export function ActionDock({ state, pending, onSubmit }: { state: GameState; pending: boolean; onSubmit: Submit }) {
  const groups = dockGroups(state);
  return (
    <>
      {state.turnPhase === 'AUCTION' && <AuctionSection key={state.auction?.auctionId ?? 'none'} state={state} pending={pending} onSubmit={onSubmit} />}
      <TradeSection state={state} pending={pending} onSubmit={onSubmit} />
      {groups.map((group) => (
        <section key={group.id} className="panel p-5" aria-label={group.title}>
          <h3 className="text-base font-bold">{group.title}</h3>
          {group.note && <p className="mt-1 text-xs text-slate-400">{group.note}</p>}
          {group.actions.length > 0 && (
            <div className="mt-3 flex flex-col items-start gap-3">
              {group.actions.map((action) => (
                <ActionButton
                  key={`${action.command}:${String(action.payload?.spaceId ?? '')}:${action.label}`}
                  action={action}
                  pending={pending}
                  onSubmit={onSubmit}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  );
}
