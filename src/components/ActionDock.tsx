'use client';

import { useState } from 'react';
import type { GameState } from '@/lib/game/types';
import type { DockAction } from '@/lib/game/ui/actionDock';
import type { PlayerId } from '@/lib/game/types';
import { dockGroups } from '@/lib/game/ui/actionDock';
import { playerColor } from '@/lib/game/ui/uiPlayer';

/**
 * The context-sensitive action dock (spec §11): only legal commands render,
 * disabled ones explain why, and multi-actor phases (auctions, pending
 * trades) expose per-player controls because the device is shared in hot-seat.
 * Rendering-only: legality comes from the pure dock module.
 */

type Submit = (type: DockAction['command'], payload?: Record<string, unknown>, actorId?: PlayerId) => void;

function ActionButton({ action, pending, onSubmit }: { action: DockAction; pending: boolean; onSubmit: Submit }) {
  const [armed, setArmed] = useState(false);
  const disabled = pending || action.disabledReason !== undefined;
  const className = action.primary ? 'cta' : action.danger ? 'secondary text-[#e8a87c]' : 'secondary';
  const reason = action.disabledReason ?? null;
  const detail = action.detail && !reason ? <span className="text-xs text-slate-400">{action.detail}</span> : null;

  const button =
    action.danger && !reason ? (
      <button
        className={className}
        disabled={disabled}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          onSubmit(action.command, action.payload, action.actorId);
        }}
        onBlur={() => setArmed(false)}
      >
        {armed ? 'Confirm surrender?' : action.label}
      </button>
    ) : (
      <button
        className={className}
        disabled={disabled}
        title={reason ?? action.detail}
        onClick={() => onSubmit(action.command, action.payload, action.actorId)}
      >
        {action.label}
      </button>
    );

  return (
    <span className="flex flex-col items-start gap-1">
      {button}
      {detail}
      {reason && <span className="text-xs text-[#e8a87c]">{reason}</span>}
    </span>
  );
}

export function ActionDock({
  state,
  pending,
  onSubmit,
  onOpenTrade,
}: {
  state: GameState;
  pending: boolean;
  onSubmit: Submit;
  /** Present when the trade composer may open (TURN_MANAGEMENT, no pending offer) —
   *  the composer is a modal, not a command, so it is a UI trigger, not a DockAction. */
  onOpenTrade?: () => void;
}) {
  const groups = dockGroups(state);
  const tradeTriggerVisible =
    onOpenTrade !== undefined && state.phase === 'PLAYING' && state.turnPhase === 'TURN_MANAGEMENT' && state.trade === null;
  return (
    <>
      {tradeTriggerVisible && (
        <section className="panel p-5" aria-label="Trade">
          <h3 className="text-base font-bold">Trade</h3>
          <p className="mt-1 text-xs text-slate-400">
            Opens the trade composer — one atomic swap, one pending offer at a time.
          </p>
          <div className="mt-3">
            <button className="secondary" disabled={pending} onClick={onOpenTrade}>
              Propose trade…
            </button>
          </div>
        </section>
      )}
      {groups.map((group) => (
        <section key={group.id} className="panel p-5" aria-label={group.title}>
          <h3 className="text-base font-bold">{group.title}</h3>
          {group.note && <p className="mt-1 text-xs text-slate-400">{group.note}</p>}
          {group.actions.length > 0 && (
            <div className="mt-3 flex flex-col items-start gap-3">
              {group.actions.map((action) => (
                <ActionButton
                  key={`${action.command}:${String(action.payload?.spaceId ?? '')}:${action.label}`}
                  action={action}
                  pending={pending}
                  onSubmit={onSubmit}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  );
}
