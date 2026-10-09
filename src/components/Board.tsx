import type { GameState } from '@/lib/game/types';
import { BOARD_SPACES, type BoardSpace } from '@/lib/game/board-v1';
import { playerColor } from '@/lib/game/ui/uiPlayer';

/**
 * Minimal slice board (spec §12 PR 4): a responsive grid over the 32 board
 * spaces with seat-colored tokens, ownership strips, and an active-space
 * ring. The perimeter layout and movement animations are the PR 10 deliverable.
 */

function spaceBg(space: BoardSpace): string {
  switch (space.kind) {
    case 'START':
    case 'HUB':
      return 'bg-[#22323e]';
    case 'PARK':
      return 'bg-[#17302b]';
    case 'EVENT':
      return 'bg-[#26313e]';
    default:
      return 'bg-[#1b3038]';
  }
}

function spaceLabel(space: BoardSpace): string {
  switch (space.kind) {
    case 'PROPERTY':
    case 'HUB':
    case 'SERVICE':
      return `$${space.listPrice}`;
    case 'START':
      return 'START';
    default:
      return space.kind;
  }
}

export function Board({ state }: { state: GameState }) {
  const seatOf = new Map(state.players.map((p, i) => [p.id, i]));
  const active = state.players.find((p) => p.id === state.activePlayerId);
  return (
    <div className="panel p-3 sm:p-5">
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 sm:gap-2">
        {BOARD_SPACES.map((space, index) => {
          const ownerId = state.owners[space.id];
          const ownerSeat = ownerId !== undefined ? seatOf.get(ownerId) : undefined;
          const tokens = state.players.filter((p) => p.position === index);
          const isActive = active !== undefined && active.position === index && state.phase === 'PLAYING';
          return (
            <div
              key={space.id}
              aria-label={`Space ${index + 1}: ${space.name}`}
              className={`relative flex min-h-16 flex-col justify-between rounded-lg border p-1.5 sm:min-h-20 sm:p-2 ${
                isActive ? 'border-[#eacb7b] ring-2 ring-[#eacb7b]' : 'border-[#365158]'
              } ${spaceBg(space)}`}
            >
              <div className="text-[10px] font-semibold leading-tight sm:text-xs">{space.name}</div>
              <div className="text-[10px] text-[#d5ba78] sm:text-xs">{spaceLabel(space)}</div>
              <div className="flex flex-wrap gap-1">
                {tokens.map((p) => (
                  <span
                    key={p.id}
                    title={p.id}
                    aria-label={`${p.id} token`}
                    className="inline-block h-3 w-3 rounded-full border border-white/70"
                    style={{ background: playerColor(seatOf.get(p.id) ?? 0) }}
                  />
                ))}
              </div>
              {ownerSeat !== undefined && (
                <span
                  title={`Owned by ${state.players[ownerSeat].id}`}
                  aria-label={`Owned by ${state.players[ownerSeat].id}`}
                  className="absolute right-0 top-0 h-1.5 w-7 rounded"
                  style={{ background: playerColor(ownerSeat) }}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-400">Minimal slice board — the perimeter layout and movement animations arrive with the UI milestone.</p>
    </div>
  );
}
