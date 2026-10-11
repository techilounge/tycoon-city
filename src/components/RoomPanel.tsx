'use client';

import { useState } from 'react';
import type { RosterEntry } from '@/lib/game/transport/protocol';

/**
 * The online room panel (spec "Client experience"): the room code to share,
 * and one row per engine seat with claimed players (name + connection dot).
 * Presentation only — roster and phase arrive from the server broadcasts.
 */

function RoomCode({ roomCode }: { roomCode: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // clipboard unavailable (permissions) — the code is visible anyway
    }
  };
  return (
    <div className="flex items-center gap-3">
      <span
        aria-label={`Room code ${roomCode}`}
        className="rounded-lg border border-[#eacb7b]/60 bg-[#22323e] px-3 py-1.5 text-lg font-black tracking-[0.3em] text-[#eacb7b]"
      >
        {roomCode}
      </span>
      <button type="button" className="secondary text-xs" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy code'}
      </button>
    </div>
  );
}

export function RoomPanel({
  roomCode,
  roster,
  seatCount,
  phase,
  selfActorId,
}: {
  roomCode: string;
  roster: readonly RosterEntry[];
  seatCount: number;
  phase: string;
  selfActorId: string | null;
}) {
  const claimed = new Map(roster.map((entry) => [entry.actorId, entry]));
  // Seat ids match the server's `seatIdsFor` exactly — engine player ids are
  // lowercase `p1`… (rooms.ts), and roster entries claim seats by that id.
  const seatIds = Array.from({ length: seatCount }, (_, i) => `p${i + 1}`);
  return (
    <section className="panel p-4 sm:p-5" aria-label="Online room">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Room</h2>
        <span className="rounded-full border border-[#365158] px-2.5 py-1 text-xs font-semibold text-slate-300">
          {phase === 'LOBBY' ? 'Waiting in lobby' : phase === 'GAME_OVER' ? 'Finished' : 'Game in progress'}
        </span>
      </div>
      <div className="mt-3">
        <RoomCode roomCode={roomCode} />
        {phase === 'LOBBY' && <p className="mt-2 text-xs text-slate-400">Share the code — players join here before the game starts.</p>}
      </div>
      <ul className="mt-4 flex flex-col gap-1.5" aria-label="Seats">
        {seatIds.map((seatId) => {
          const entry = claimed.get(seatId);
          return (
            <li
              key={seatId}
              aria-label={entry ? `${entry.name} seated at ${seatId}` : `${seatId} open`}
              className="flex items-center gap-2.5 rounded-lg border border-[#2c4250] px-3 py-2 text-sm"
            >
              <span
                aria-hidden
                title={entry ? 'Connected' : 'Open seat'}
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${entry ? 'bg-[#7fa8a4]' : 'border border-[#365158] bg-transparent'}`}
              />
              <span className={`min-w-0 truncate ${entry ? 'text-slate-100' : 'text-slate-500'}`}>
                {entry ? entry.name : `${seatId} — open seat`}
                {entry && entry.actorId === selfActorId ? ' (you)' : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
