'use client';

import { useState } from 'react';
import type { GameState, PlayerId } from '@/lib/game/types';
import { tradePanel } from '@/lib/game/ui/actionDock';
import {
  buildTradeOffer,
  counterTradeBuilder,
  newTradeBuilder,
  ownedPurchasables,
  setTradeCash,
  setTradeRecipient,
  toggleTradeSpace,
  tradeBuilderValidity,
  tradeSideText,
  type TradeBuilderState,
  type TradeSideKey,
} from '@/lib/game/ui/tradeBuilder';
import { Modal } from './Modal';

type Submit = (type: 'OFFER_TRADE' | 'ANSWER_TRADE', payload?: Record<string, unknown>, actorId?: PlayerId) => void;

/**
 * The trade review (spec §6, §11): a pending offer's summary with Accept /
 * Reject / Counter for the designated recipient. Dismissible — a pending
 * offer never disturbs the active player's turn, so the review cannot be
 * forced; the dock keeps a re-open trigger. Counter opens the composer
 * prefilled with the roles reversed (spec §6: counters replace the offer).
 */
export function TradeReviewModal({
  state,
  pending,
  onSubmit,
  onCounter,
  onClose,
}: {
  state: GameState;
  pending: boolean;
  onSubmit: Submit;
  onCounter: () => void;
  onClose: () => void;
}) {
  const panel = tradePanel(state);
  if (!panel) return null;
  const trade = state.trade;
  if (!trade) return null;
  const proposer = state.players.find((p) => p.id === trade.proposerId);
  const expiry =
    trade.anchorTurn === null
      ? `${trade.proposerId} answers after taking their next turn.`
      : `Expires when ${trade.proposerId}'s turn ends.`;

  const answer = (response: 'ACCEPT' | 'REJECT'): void => {
    onSubmit('ANSWER_TRADE', { tradeId: trade.tradeId, response }, trade.recipientId);
  };

  return (
    <Modal title="Trade offer" titleId="trade-review-title" onClose={onClose}>
      <p className="text-sm text-slate-200" aria-live="polite">
        {panel.summary}.
      </p>
      <p className="mt-2 text-xs text-slate-400">{expiry}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="cta" disabled={pending} onClick={() => answer('ACCEPT')}>
          Accept trade
        </button>
        <button className="secondary" disabled={pending} onClick={() => answer('REJECT')}>
          Reject
        </button>
        <button className="secondary" disabled={pending} onClick={onCounter}>
          Counter…
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        {proposer ? `${proposer.id} proposed this` : 'Proposed'} — only {trade.recipientId} may answer. The transfer is
        atomic: every asset moves or none does.
      </p>
    </Modal>
  );
}

/**
 * The trade composer (spec §6, §11): one atomic swap — assets and cash both
 * ways, no credit. `counterOf` is null for a fresh offer (proposed by the
 * active player) or the pending trade's id when countering (proposed by that
 * offer's recipient, submitted as ANSWER_TRADE COUNTER, which replaces the
 * pending offer). Client gating only — the engine re-proves everything at
 * submission.
 */
export function TradeComposerModal({
  state,
  pending,
  onSubmit,
  counterOf,
  onClose,
}: {
  state: GameState;
  pending: boolean;
  onSubmit: Submit;
  counterOf: string | null;
  onClose: () => void;
}) {
  const [builder, setBuilder] = useState<TradeBuilderState>(() =>
    counterOf !== null ? counterTradeBuilder(state) : newTradeBuilder(),
  );

  const pendingTrade = counterOf !== null ? state.trade : null;
  const proposerId = pendingTrade ? pendingTrade.recipientId : state.activePlayerId;
  const proposer = state.players.find((p) => p.id === proposerId);
  if (!proposer) return null;
  const validity = tradeBuilderValidity(state, builder, proposer.id);
  const offer = buildTradeOffer(builder);
  const recipient = builder.recipientId;

  const submitOffer = (): void => {
    if (!validity.ok || !offer || !recipient) return;
    if (pendingTrade) {
      onSubmit(
        'ANSWER_TRADE',
        { tradeId: pendingTrade.tradeId, response: 'COUNTER', counterOffer: offer },
        pendingTrade.recipientId,
      );
    } else {
      onSubmit('OFFER_TRADE', { recipientId: recipient, offer }, proposer.id);
    }
  };

  return (
    <Modal
      title={counterOf !== null ? 'Counter-offer' : 'Propose a trade'}
      titleId="trade-modal-title"
      onClose={onClose}
      wide
    >
      <div className="flex flex-col gap-4">
        {!pendingTrade && (
          <section aria-label="Trade partner">
            <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">Trade with</p>
            <div className="flex flex-wrap gap-2">
              {state.players
                .filter((p) => !p.eliminated && p.id !== proposer.id)
                .map((p) => (
                  <button
                    key={p.id}
                    className={builder.recipientId === p.id ? 'cta text-sm' : 'secondary text-sm'}
                    aria-pressed={builder.recipientId === p.id}
                    onClick={() => setBuilder(setTradeRecipient(builder, p.id))}
                  >
                    {p.id}
                  </button>
                ))}
            </div>
          </section>
        )}

        <TradeSide
          state={state}
          label={`You give (as ${proposer.id})`}
          side="give"
          builder={builder}
          ownerId={proposer.id}
          onCash={(raw) => setBuilder(setTradeCash(builder, 'give', raw))}
          onToggle={(spaceId) => setBuilder(toggleTradeSpace(builder, 'give', spaceId))}
        />

        <TradeSide
          state={state}
          label={recipient ? `You receive (from ${recipient})` : 'You receive'}
          side="receive"
          builder={builder}
          ownerId={recipient}
          onCash={(raw) => setBuilder(setTradeCash(builder, 'receive', raw))}
          onToggle={(spaceId) => setBuilder(toggleTradeSpace(builder, 'receive', spaceId))}
        />

        <p className="text-sm text-slate-300">
          {offer && recipient ? (
            <>
              <span className="font-semibold text-[#e3bd72]">{proposer.id}</span> gives {tradeSideText(offer.give.cash, offer.give.spaceIds, state)} ↔ receives{' '}
              {tradeSideText(offer.receive.cash, offer.receive.spaceIds, state)}.
            </>
          ) : (
            'Assemble the swap above — assets and cash move atomically, all-or-nothing.'
          )}
        </p>

        {!validity.ok && (
          <ul className="flex flex-col gap-1 text-xs text-[#e8a87c]" aria-live="polite">
            {validity.problems.map((problem) => (
              <li key={problem}>· {problem}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="cta" disabled={pending || !validity.ok} onClick={submitOffer}>
            {counterOf !== null ? 'Send counter-offer' : 'Send offer'}
          </button>
          <button className="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </div>
        <p className="text-xs text-slate-400">
          {pendingTrade
            ? 'Sending replaces the pending offer with this counter.'
            : `The offer waits for ${recipient ?? 'their'} answer and expires when your turn ends.`}
        </p>
      </div>
    </Modal>
  );
}

function TradeSide({
  state,
  label,
  side,
  builder,
  ownerId,
  onCash,
  onToggle,
}: {
  state: GameState;
  label: string;
  side: TradeSideKey;
  builder: TradeBuilderState;
  ownerId: PlayerId | null;
  onCash: (raw: string) => void;
  onToggle: (spaceId: string) => void;
}) {
  const spaces = ownerId ? ownedPurchasables(state, ownerId) : [];
  const selected = side === 'give' ? builder.giveSpaceIds : builder.receiveSpaceIds;
  const owner = ownerId ? state.players.find((p) => p.id === ownerId) : undefined;

  return (
    <section aria-label={label}>
      <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`cash-${side}`}>
          Cash for {label}
        </label>
        <span className="text-sm text-slate-400">{owner ? `$${owner.cash.toLocaleString()} held —` : ''} cash:</span>
        <input
          id={`cash-${side}`}
          type="number"
          inputMode="numeric"
          min={0}
          value={side === 'give' ? builder.giveCash : builder.receiveCash}
          onChange={(event) => onCash(event.target.value)}
          placeholder="0"
          className="w-28 rounded-md border border-[#587078] bg-[#15242e] px-2 py-1 text-sm"
        />
      </div>
      {spaces.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">
          {ownerId ? 'No owned spaces on this side.' : 'Choose a trade partner first.'}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {spaces.map((space) => {
            const level = state.upgrades[space.id] ?? 0;
            const mortgaged = state.mortgaged[space.id] === true;
            const isOn = selected.includes(space.id);
            return (
              <button
                key={space.id}
                className={isOn ? 'cta text-xs' : 'secondary text-xs'}
                aria-pressed={isOn}
                onClick={() => onToggle(space.id)}
              >
                {space.name} · ${space.listPrice.toLocaleString()}
                {level > 0 ? ` · L${level}` : ''}
                {mortgaged ? ' · M' : ''}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
