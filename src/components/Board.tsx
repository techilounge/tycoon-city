import type { GameState } from '@/lib/game/types';
import { BOARD_SPACES, isPurchasable, MODES, type BoardSpace } from '@/lib/game/board-v1';
import { CENTER_PLACEMENT, districtTint, perimeterGridPosition } from '@/lib/game/ui/boardLayout';
import { playerColor, tileCaption } from '@/lib/game/ui/uiPlayer';

/**
 * The perimeter board (spec §12 PR 10): the 32-space loop laid out around a
 * 9×9 ring with a center panel, replacing the slice's illustrative grid.
 * Tokens move cell to cell; ownership, price, upgrades, and mortgages read
 * straight off engine state through the pinned presentation helpers — the
 * caption is always one consistent line: "<price> · Owned by <player>".
 */

function spaceBg(space: BoardSpace): string {
  switch (space.kind) {
    case 'START':
      return 'bg-[#22323e]';
    case 'HUB':
      return 'bg-[#20303f]';
    case 'PARK':
      return 'bg-[#17302b]';
    case 'EVENT':
      return 'bg-[#26313e]';
    case 'ASSESSMENT':
      return 'bg-[#2a2836]';
    default:
      return 'bg-[#1b3038]';
  }
}

function SpaceCell({ space, index, state }: { space: BoardSpace; index: number; state: GameState }) {
  const position = perimeterGridPosition(index);
  const seatOf = new Map(state.players.map((p, i) => [p.id, i]));
  const active = state.players.find((p) => p.id === state.activePlayerId);
  const tokens = state.players.filter((p) => p.position === index);
  const isActiveSpace = active !== undefined && active.position === index && state.phase === 'PLAYING';
  const caption = tileCaption(space, state);
  const ownerSeat = caption.ownerId !== null ? seatOf.get(caption.ownerId) : undefined;
  const level = isPurchasable(space) ? (state.upgrades[space.id] ?? 0) : 0;
  const mortgaged = isPurchasable(space) && state.mortgaged[space.id] === true;
  const tint = space.kind === 'PROPERTY' ? districtTint(space.districtId) : null;

  return (
    <div
      style={{ gridRow: position.row, gridColumn: position.col }}
      title={`${space.name} — ${caption.label}${caption.ownerLine !== null ? ` · ${caption.ownerLine}` : ''}`}
      aria-label={`Space ${index + 1}: ${space.name}`}
      className={`relative flex min-h-0 min-w-0 flex-col justify-between overflow-hidden rounded-md border p-1 sm:rounded-lg sm:p-1.5 ${
        isActiveSpace ? 'border-[#eacb7b] ring-1 ring-[#eacb7b]' : 'border-[#2c4250]'
      } ${spaceBg(space)}`}
    >
      {tint !== null && <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: tint }} />}
      {ownerSeat !== undefined && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-1 w-full"
          style={{ background: playerColor(ownerSeat) }}
        />
      )}

      <div className="hidden truncate text-[9px] font-semibold leading-tight text-slate-200 sm:block sm:text-[10px]">{space.name}</div>

      <div className="min-w-0 text-[8px] leading-tight text-[#d5ba78] sm:text-[10px]">
        {caption.label}
        {caption.ownerLine !== null && caption.ownerId !== null && (
          <span style={{ color: playerColor(seatOf.get(caption.ownerId) ?? 0) }}> · {caption.ownerLine}</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-0.5">
        <div className="flex min-w-0 flex-wrap gap-0.5">
          {tokens.map((p) => (
            <span
              key={`${p.id}:${p.position}`}
              title={p.id}
              aria-label={`${p.id} token`}
              className="token-land inline-block h-2 w-2 rounded-full border border-white/70 sm:h-3 sm:w-3"
              style={{ background: playerColor(seatOf.get(p.id) ?? 0) }}
            />
          ))}
        </div>
        {level > 0 && (
          <span aria-label={`${level} built levels`} className="flex shrink-0 gap-px">
            {Array.from({ length: level }, (_, i) => (
              <span key={i} aria-hidden className="h-1.5 w-1 rounded-sm bg-[#e3bd72]" />
            ))}
          </span>
        )}
        {mortgaged && (
          <span title="Mortgaged" aria-label="Mortgaged" className="shrink-0 text-[8px] font-bold text-[#e8a87c] sm:text-[9px]">
            M
          </span>
        )}
      </div>
    </div>
  );
}

export function Board({ state }: { state: GameState }) {
  const mode = MODES[state.mode];
  return (
    <div className="panel p-2 sm:p-4" data-testid="perimeter-board">
      <div
        className="grid aspect-square w-full grid-cols-9 gap-[3px] sm:gap-1.5"
        style={{ gridTemplateRows: 'repeat(9, minmax(0, 1fr))' }}
      >
        {BOARD_SPACES.map((space, index) => (
          <SpaceCell key={space.id} space={space} index={index} state={state} />
        ))}

        <div
          style={{ gridRow: CENTER_PLACEMENT.gridRow, gridColumn: CENTER_PLACEMENT.gridColumn }}
          className="flex min-h-0 flex-col items-center justify-center rounded-lg text-center"
          aria-hidden
        >
          <div className="text-sm font-black tracking-[0.3em] text-[#e3bd72] sm:text-lg">TYCOON CITY</div>
          <div className="mt-1 text-[9px] uppercase tracking-widest text-slate-400 sm:text-xs">
            {mode.name} · round {state.round} of {mode.roundCap}
          </div>
        </div>
      </div>
    </div>
  );
}
