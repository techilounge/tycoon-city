'use client';

import { useMemo } from 'react';
import type { GameState } from '@/lib/game/types';
import { netWorthFromState } from '@/lib/game/rules-v1';
import { victoryReasonText, type GameOverSummary } from '@/lib/game/ui/actionDock';
import { playerColor } from '@/lib/game/ui/uiPlayer';
import { Modal } from './Modal';

interface Standing {
  readonly playerId: string;
  readonly cash: number;
  readonly netWorth: number;
}

/** Final standings by canonical net worth (spec §9) — pure fold over players. */
function finalStandings(state: GameState): readonly Standing[] {
  return state.players
    .map((p) => ({ playerId: p.id, cash: p.cash, netWorth: netWorthFromState(state, p.id) }))
    .sort((a, b) => b.netWorth - a.netWorth || a.playerId.localeCompare(b.playerId));
}

/**
 * The victory screen (spec §11): who won and why, final standings by the
 * canonical net worth, and the way out. Non-dismissible on open; "View the
 * final board" closes it and a standings button re-opens it.
 */
export function VictoryModal({
  summary,
  state,
  onDismiss,
  onBackToLobby,
}: {
  summary: GameOverSummary;
  state: GameState;
  onDismiss: () => void;
  onBackToLobby: () => void;
}) {
  const standings = useMemo(() => finalStandings(state), [state]);
  const headline =
    summary.winnerIds.length === 1
      ? `${summary.winnerIds[0]} wins — ${victoryReasonText(summary.reason)}.`
      : `Tie between ${summary.winnerIds.join(', ')} — ${victoryReasonText(summary.reason)}.`;

  return (
    <Modal title="Game over" titleId="victory-modal-title" dismissible={false}>
      <p className="text-2xl font-black text-[#e3bd72]" aria-live="polite">
        {headline}
      </p>
      <table className="mt-4 w-full text-sm">
        <caption className="sr-only">Final standings by net worth</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-widest text-slate-400">
            <th scope="col" className="py-1 font-semibold">
              Player
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              Cash
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              Net worth
            </th>
          </tr>
        </thead>
        <tbody>
          {standings.map((s) => (
            <tr key={s.playerId} className="border-t border-white/10">
              <td className="py-1.5">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 rounded-full border border-white/40"
                    style={{ background: playerColor(state.players.findIndex((p) => p.id === s.playerId)) }}
                  />
                  {s.playerId}
                </span>
              </td>
              <td className="py-1.5 text-right tabular-nums">${s.cash.toLocaleString()}</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">${s.netWorth.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="cta" onClick={onBackToLobby}>
          Back to the lobby
        </button>
        <button className="secondary" onClick={onDismiss}>
          View the final board
        </button>
      </div>
    </Modal>
  );
}
