'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Shared modal shell (spec §11): a dialog over the board with backdrop,
 * Escape handling, and focus on open. Dismissible modals close on backdrop
 * click and Escape; decision surfaces (auction, debt) are non-dismissible —
 * they are the phase's only legal command surface, so they cannot close.
 * Animations honor prefers-reduced-motion via the shared .modal-in reset.
 */
export function Modal({
  title,
  titleId,
  onClose,
  dismissible = true,
  wide = false,
  children,
}: {
  title: string;
  /** id of the heading element — aria-labelledby target. */
  titleId: string;
  /** Present → dismissible; absent → the modal cannot be closed. */
  onClose?: () => void;
  dismissible?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    if (!onClose) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-[#0b1319]/85 p-3 sm:p-6"
      onClick={onClose}
      data-testid="modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={`modal-in panel mx-auto my-4 w-full outline-none sm:my-8 ${wide ? 'max-w-2xl' : 'max-w-lg'}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#294047] px-5 py-4 sm:px-6">
          <h2 id={titleId} className="text-lg font-black tracking-tight text-[#e3bd72]">
            {title}
          </h2>
          {dismissible && onClose && (
            <button className="secondary px-3 py-1 text-sm" onClick={onClose} aria-label="Close dialog">
              ✕
            </button>
          )}
        </div>
        <div className="px-5 py-4 sm:px-6 sm:py-5">{children}</div>
      </div>
    </div>
  );
}
