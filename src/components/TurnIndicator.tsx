'use client';

import type { GameState } from '@/lib/game/types';
import { playerColor } from '@/lib/game/ui/uiPlayer';
import { turnHeadline } from '@/lib/game/ui/actionDock';
import { MODES } from '@/lib/game/board-v1';

/** The current roll as the page derives it from the event log. */
export interface DiceDisplay {
  readonly die1: number;
  readonly die2: number;
  readonly isDoubles: boolean;
}

/**
 * The turn indicator (spec §11): who acts, what they may do next, the round,
 * and the current dice — everything orientation, nothing to click.
 */

export function TurnIndicator({
  state,
  seat,
  dice,
  diceKey,
}: {
  state: GameState;
  seat: number;
  dice: DiceDisplay | null;
  diceKey: number;
}) {
  const active = state.players.find((p) => p.id === state.activePlayerId);
  const mode = MODES[state.mode];

  return (
    <section className="panel p-5" aria-label="Turn status">
      <div className="flex items-center gap-3">
        {active && (
          <span
            aria-hidden
            data-testid="active-seat-dot"
            className="inline-block h-4 w-4 rounded-full border border-white/70"
            style={{ background: playerColor(seat) }}
          />
        )}
        <h2 data-testid="turn-headline" className="text-lg font-bold">
          {turnHeadline(state)}
        </h2>
      </div>

      <p className="mt-1 text-xs uppercase tracking-widest text-slate-400">
        {mode.name} · round {state.round} of {mode.roundCap}
        {active ? ` · seat ${seat + 1}` : ''}
      </p>

      {dice && (
        <div
          key={diceKey}
          className="dice-pop mt-4 flex items-center gap-2"
          role="status"
          aria-label={`Rolled ${dice.die1} and ${dice.die2}`}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#587078] bg-[#1b3038] text-xl font-black">
            {dice.die1}
          </span>
          <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#587078] bg-[#1b3038] text-xl font-black">
            {dice.die2}
          </span>
          {dice.isDoubles && <span className="text-sm font-bold text-[#e3bd72]">doubles!</span>}
        </div>
      )}

      {state.doublesCount > 0 && state.turnPhase !== 'AWAITING_ROLL' && (
        <p className="mt-3 text-xs text-[#e3bd72]">Doubles streak: {state.doublesCount} — a third consecutive doubles sends you to the nearest park.</p>
      )}
    </section>
  );
}
