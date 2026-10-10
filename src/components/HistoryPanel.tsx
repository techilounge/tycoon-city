'use client';

import { historyNewestFirst } from '@/lib/game/ui/history';
import type { AnyGameEvent } from '@/lib/game/events';

/**
 * The activity history panel (spec §11): the full rendered event log,
 * newest first, scrollable — not the PR 10 twelve-line window. Money
 * movements show their worked explanation beneath the headline, derived
 * from the event payload (never recomputed).
 */
export function HistoryPanel({
  history,
  savedLabel = null,
}: {
  history: readonly AnyGameEvent[];
  savedLabel?: 'saved' | 'failed' | null;
}) {
  const entries = historyNewestFirst(history);
  return (
    <section className="panel p-5" aria-label="Game activity">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Activity</h2>
        {savedLabel && (
          <span className={`text-xs ${savedLabel === 'saved' ? 'text-[#7fa8a4]' : 'text-[#e0a1a1]'}`} role="status">
            {savedLabel === 'saved' ? 'Saved' : 'Save failed'}
          </span>
        )}
      </div>
      <ul className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1 text-sm text-slate-300" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.sequence} className="border-b border-white/5 pb-1.5 last:border-0">
            <span className={entry.money ? 'text-[#e3bd72]' : ''}>{entry.headline}</span>
            {entry.detail && <span className="block text-xs text-[#7fa8a4]">{entry.detail}</span>}
          </li>
        ))}
        {entries.length === 0 && <li className="text-slate-400">No moves yet.</li>}
      </ul>
    </section>
  );
}
