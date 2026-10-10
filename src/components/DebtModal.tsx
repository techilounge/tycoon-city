'use client';

import type { GameState } from '@/lib/game/types';
import { DockActionGroups } from './ActionDock';
import { Modal } from './Modal';

type Submit = React.ComponentProps<typeof DockActionGroups>['onSubmit'];

/**
 * The debt settlement surface (spec §7, §11): a non-dismissible, focused
 * view while SETTLING_DEBT is open — what is owed, to whom, and the exact
 * legal ways out. The action list is the SAME pure dock projection the
 * dock panel renders (unilateral liquidation, consented trades, one atomic
 * settle, surrender) — one source of truth for legality, two renderings.
 */
export function DebtModal({ state, pending, onSubmit }: { state: GameState; pending: boolean; onSubmit: Submit }) {
  const debt = state.debt;
  if (!debt) return null;
  const debtor = state.players.find((p) => p.id === debt.debtorId);

  return (
    <Modal title="Debt settlement" titleId="debt-modal-title" dismissible={false}>
      <p className="text-sm text-slate-200" aria-live="polite">
        <span className="font-semibold text-[#e3bd72]">{debt.debtorId}</span> owes{' '}
        <span className="font-semibold">${debt.amountDue.toLocaleString()}</span>{' '}
        {debt.creditorId === 'BANK' ? 'to the bank' : `to ${debt.creditorId}`}
        {debtor ? ` — $${debtor.cash.toLocaleString()} on hand.` : '.'}
      </p>
      <p className="mt-2 text-xs text-slate-400">
        Raise cash by selling upgrades or mortgaging (unilateral), by a consented trade, or settle in one atomic
        payment once the cash is on hand. Nothing else is allowed while the debt stands.
      </p>
      <div className="mt-4 flex flex-col gap-3 [&_section]:p-4 [&_section]:bg-[#0f1b22]">
        <DockActionGroups state={state} pending={pending} onSubmit={onSubmit} />
      </div>
    </Modal>
  );
}
