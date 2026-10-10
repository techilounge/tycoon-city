'use client';

import { BANK_ID, type CreditorId } from '@/lib/game/types';
import type { EliminationReveal } from '@/lib/game/ui/modals';
import { Modal } from './Modal';

/** One line naming the estate's creditor — the bank or the player. */
function creditorName(creditorId: CreditorId | null): string {
  return creditorId === null || creditorId === BANK_ID ? 'the bank' : creditorId;
}

/**
 * The bankruptcy screen (spec §7, §11): acknowledges an elimination with
 * the estate facts from the waterfall events (creditor, cash and
 * properties transferred). Dismissible — it yields to any auction first
 * because a bank-creditor estate sale follows the elimination.
 */
export function BankruptcyModal({
  reveal,
  pending,
  onDismiss,
}: {
  reveal: EliminationReveal;
  pending: boolean;
  onDismiss: () => void;
}) {
  const bankEstate = reveal.creditorId === BANK_ID;
  return (
    <Modal title={`${reveal.playerId} is bankrupt`} titleId="bankruptcy-modal-title" onClose={onDismiss}>
      <p className="text-sm text-slate-200" aria-live="polite">
        Every asset went to {creditorName(reveal.creditorId)} in settlement of the debt.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-slate-300">
        <li>
          Cash transferred: <span className="font-semibold text-[#e3bd72]">${reveal.transferredCash.toLocaleString()}</span>
        </li>
        <li>
          Properties transferred: <span className="font-semibold text-[#e3bd72]">{reveal.transferredSpaceIds.length}</span>
          {reveal.transferredSpaceIds.length > 0 && (
            <span className="text-slate-400"> — with mortgages intact where applicable.</span>
          )}
        </li>
      </ul>
      {bankEstate && (
        <p className="mt-3 text-xs text-[#e8a87c]">
          A bank-creditor estate sells each property at sequential auction before play resumes.
        </p>
      )}
      <div className="mt-5">
        <button className="cta" disabled={pending} onClick={onDismiss}>
          Acknowledge
        </button>
      </div>
    </Modal>
  );
}
