'use client';

import { cardEffectText, type CardReveal } from '@/lib/game/ui/modals';
import { Modal } from './Modal';

/**
 * The event reveal (spec §11): what the deck dealt and what it did — the
 * card's own words plus the applied effect from the CARD_EFFECT_APPLIED
 * payload (never recomputed). Dismissible: the draw already resolved inside
 * RESOLVING_MOVE; the modal only explains it before the turn continues.
 */
export function EventModal({
  reveal,
  pending,
  onDismiss,
}: {
  reveal: CardReveal;
  pending: boolean;
  onDismiss: () => void;
}) {
  return (
    <Modal title={reveal.title} titleId="event-modal-title" onClose={onDismiss}>
      <p className="text-xs uppercase tracking-widest text-[#7fa8a4]">Event card</p>
      <p className="mt-2 text-base leading-relaxed text-slate-100" aria-live="polite">
        “{reveal.text}”
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Drawn by <span className="font-semibold text-slate-200">{reveal.playerId}</span>
      </p>
      {reveal.effect && <p className="mt-3 text-sm text-[#7fa8a4]">Applied: {cardEffectText(reveal.effect)}</p>}
      <div className="mt-5">
        <button className="cta" disabled={pending} onClick={onDismiss}>
          Seen
        </button>
      </div>
    </Modal>
  );
}
