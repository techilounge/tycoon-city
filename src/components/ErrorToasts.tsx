'use client';

import { useEffect } from 'react';

/**
 * Error toasts (spec "Client experience"): RATE_LIMITED, ROOM_IN_PROGRESS,
 * ROOM_NOT_FOUND and transport faults surface here — never a disconnect,
 * never a corrupted state. Presentation only; the screen owns the list.
 */

export interface ToastItem {
  readonly id: number;
  readonly code: string;
  readonly message: string;
}

export function ErrorToasts({ toasts, onDismiss }: { toasts: readonly ToastItem[]; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => setTimeout(() => onDismiss(toast.id), 6000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="panel pointer-events-auto flex w-full max-w-md items-start justify-between gap-3 border-[#a3552f] p-3 text-sm text-[#e8a87c]"
        >
          <span className="min-w-0 break-words">
            <span className="font-bold">{toast.code}</span> — {toast.message}
          </span>
          <button type="button" className="shrink-0 underline" onClick={() => onDismiss(toast.id)}>
            dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
