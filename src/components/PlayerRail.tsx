import type { GameState } from '@/lib/game/types';
import { netWorthFromState } from '@/lib/game/rules-v1';
import { PLAYER_COLORS, playerColor } from '@/lib/game/ui/uiPlayer';

/**
 * The player rail (spec §11): one row per seat — cash, canonical net worth,
 * holdings, and tokens — with a clear active marker and eliminated state.
 * Net worth is the §9 canonical function, never a UI recomputation.
 */

export function PlayerRail({ state }: { state: GameState }) {
  const seatOf = new Map(state.players.map((p, i) => [p.id, i]));
  const ownedCount = new Map<string, number>();
  for (const owner of Object.values(state.owners)) {
    ownedCount.set(owner, (ownedCount.get(owner) ?? 0) + 1);
  }

  return (
    <section className="panel p-5" aria-label="Players">
      <h2 className="text-lg font-bold">Players</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {state.players.map((p) => {
          const seat = seatOf.get(p.id) ?? 0;
          const active = p.id === state.activePlayerId && state.phase === 'PLAYING';
          const worth = netWorthFromState(state, p.id);
          return (
            <li
              key={p.id}
              aria-label={`${p.id}: $${p.cash.toLocaleString()} cash, $${worth.toLocaleString()} net worth${active ? ', active player' : ''}`}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                p.eliminated
                  ? 'border-[#2c4250] opacity-50'
                  : active
                    ? 'border-[#eacb7b] bg-[#22323e]'
                    : 'border-[#2c4250]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-white/70" style={{ background: playerColor(seat) }} />
                  <span className={`truncate ${active ? 'font-bold text-[#eacb7b]' : ''}`}>{p.id}</span>
                  {active && <span className="shrink-0 text-xs text-[#e3bd72]">active</span>}
                  {p.eliminated && <span className="shrink-0 text-xs text-slate-400">bankrupt</span>}
                  {p.skipNextTurn && !p.eliminated && <span className="shrink-0 text-xs text-slate-400">skips next</span>}
                </span>
                <span className="shrink-0 text-right text-slate-300">
                  <span className="font-semibold">${p.cash.toLocaleString()}</span>
                  <span className="text-slate-400"> · worth ${worth.toLocaleString()}</span>
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-400">
                <span>{ownedCount.get(p.id) ?? 0} owned</span>
                {p.tokens.HOLD > 0 && <span>{p.tokens.HOLD} hold</span>}
                {p.tokens.RENT_HOLIDAY > 0 && <span>{p.tokens.RENT_HOLIDAY} rent holiday</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
