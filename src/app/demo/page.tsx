'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { DemoBoard } from '@/components/DemoBoard';
import { applyCommand, createGame } from '@/lib/game/engine/reducer';
import { rngForState } from '@/lib/game/rng';
import type { GameCommand } from '@/lib/game/commands';
import type { GameState } from '@/lib/game/types';

/**
 * The archived vertical-slice board (spec §12 PR 4), preserved at /demo when
 * PR 10 replaced it with the perimeter loop. The state is built from the real
 * engine with a fixed seed, so the demo is identical on every visit.
 */

function demoState(): GameState | null {
  const created = createGame({ gameId: 'g-demo', seed: 176, playerIds: ['Ada', 'Grace'], mode: 'CLASSIC' });
  if (!created.ok) return null;
  const start: GameCommand = {
    commandId: 'demo-start',
    gameId: created.state.gameId,
    actorId: created.state.players[0].id,
    expectedVersion: created.state.version,
    type: 'START_GAME',
    payload: {},
  };
  const started = applyCommand(created.state, start, rngForState(created.state.rngState));
  return started.ok ? started.state : null;
}

export default function DemoPage() {
  const state = useMemo(demoState, []);
  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <nav className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
          TYCOON CITY
        </Link>
        <Link href="/game" className="secondary text-sm">
          Play the real game
        </Link>
      </nav>

      <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Slice demo</h1>
      <p className="mt-1 text-sm text-slate-400">
        The vertical-slice board grid (PR 4), preserved after the perimeter loop replaced it. Seeded 176 — the same
        deterministic engine renders it.
      </p>

      <div className="mt-6">
        {state ? (
          <DemoBoard state={state} />
        ) : (
          <p className="panel p-5 text-sm text-slate-300" role="alert">
            The demo could not build its game state.
          </p>
        )}
      </div>
    </main>
  );
}
