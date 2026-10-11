/**
 * The deadline bar (spec "Client experience"): renders a server-broadcast
 * deadline as a draining bar. Presentation only — the server enforces the
 * deadline; PR 17's broadcast slots in via the `deadline` prop. With no
 * broadcast (today), the bar renders nothing.
 */

export interface DeadlineBroadcast {
  /** What the deadline ends — "your turn", "settle debts", "place a bid". */
  readonly label: string;
  /** Epoch ms when the deadline fires. */
  readonly endsAtMs: number;
  /** The full budget the deadline started with — the bar's denominator. */
  readonly durationMs: number;
  /** The render clock (injected so the bar stays a pure presentation). */
  readonly nowMs: number;
}

/** Remaining share in [0, 1] from the broadcast alone. */
export function remainingShare(deadline: DeadlineBroadcast): number {
  if (deadline.durationMs <= 0) return 0;
  const share = (deadline.endsAtMs - deadline.nowMs) / deadline.durationMs;
  return Math.max(0, Math.min(1, share));
}

export function DeadlineBar({ deadline }: { deadline: DeadlineBroadcast | null }) {
  if (deadline === null) return null;
  const share = remainingShare(deadline);
  const seconds = Math.max(0, Math.ceil((deadline.endsAtMs - deadline.nowMs) / 1000));
  const urgent = share <= 0.25;
  return (
    <section className="panel p-3" aria-label={`Deadline: ${deadline.label}`} data-testid="deadline-bar">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-300">{deadline.label}</span>
        <span className={`font-bold tabular-nums ${urgent ? 'text-[#e8a87c]' : 'text-[#7fa8a4]'}`}>{seconds}s</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1b3038]" role="presentation">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${urgent ? 'bg-[#e8a87c]' : 'bg-[#7fa8a4]'}`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </section>
  );
}
