'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MODES, MODE_IDS, type ModeId } from '@/lib/game/board-v1';
import { MAX_PLAYERS, MIN_PLAYERS } from '@/lib/game/types';
import { PLAYER_COLORS } from '@/lib/game/ui/uiPlayer';

/**
 * The Phase 1 lobby (spec §11): seats 2–6 players, picks a mode, and validates
 * the deterministic seed before any game exists. Starting is deliberately lazy —
 * the seed can be replayed exactly (seed 176 is the owner's playtest demo), and
 * nothing is created until the handoff to /game.
 *
 * Config rides in the URL to /game: hot-seat Phase 1 has nothing to hide, and a
 * plain link keeps the setup reviewable and shareable without storage.
 */

const SEED_MAX = 0xffffffff;

/** Whole-number seeds in [0, 2^32-1] only — the engine's seed space (spec §3). */
function parseSeed(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seed = Number.parseInt(trimmed, 10);
  return seed <= SEED_MAX ? seed : null;
}

function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Names double as player ids — commas would corrupt the URL handoff. */
function sanitizeName(raw: string): string {
  return raw.replace(/,/g, '').replace(/\s+/g, ' ').trimStart().slice(0, 16);
}

const SEAT_NAMES = ['Ada', 'Grace', 'Edsger', 'Hopper', 'Turing', 'Marie'];

export default function LobbyPage() {
  const router = useRouter();
  const [mode, setMode] = useState<ModeId>('CLASSIC');
  const [playerCount, setPlayerCount] = useState(3);
  const [names, setNames] = useState<string[]>(SEAT_NAMES);
  const [seedDraft, setSeedDraft] = useState(() => String(randomSeed()));

  const seatNames = useMemo(
    () => Array.from({ length: playerCount }, (_, seat) => sanitizeName(names[seat] ?? '') || SEAT_NAMES[seat]),
    [names, playerCount],
  );
  const namesValid = seatNames.every((name) => name.length > 0) && new Set(seatNames).size === seatNames.length;
  const seed = parseSeed(seedDraft);
  const modeConfig = MODES[mode];
  const ready = namesValid && seed !== null;

  const startGame = () => {
    if (!ready) return;
    const query = new URLSearchParams({ players: seatNames.join(','), mode, seed: String(seed) });
    router.push(`/game?${query.toString()}`);
  };

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
      <nav className="flex items-center justify-between">
        <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
          TYCOON CITY
        </Link>
        <Link href="/demo" className="secondary text-sm">
          Archived demo
        </Link>
      </nav>

      <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Game Lobby</h1>
      <p className="mt-1 text-sm text-slate-400">
        Local hot-seat — everyone plays from this device, one seat at a time.
      </p>

      <section className="panel mt-6 p-5 sm:p-6" aria-label="Players">
        <h2 className="text-lg font-bold">Players</h2>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Player count">
          {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((count) => (
            <button
              key={count}
              type="button"
              aria-pressed={playerCount === count}
              onClick={() => setPlayerCount(count)}
              className={`h-10 w-10 rounded-lg border text-sm font-bold transition-colors ${
                playerCount === count ? 'border-[#eacb7b] bg-[#22323e] text-[#eacb7b]' : 'border-[#365158] text-slate-300 hover:border-[#587078]'
              }`}
            >
              {count}
            </button>
          ))}
        </div>
        <ul className="mt-4 flex flex-col gap-2">
          {Array.from({ length: playerCount }, (_, seat) => {
            const value = sanitizeName(names[seat] ?? '');
            const duplicate = seatNames.filter((name) => name === (value || SEAT_NAMES[seat])).length > 1;
            return (
              <li key={seat} className="flex items-center gap-3">
                <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-white/70" style={{ background: PLAYER_COLORS[seat] }} />
                <label className="sr-only" htmlFor={`player-name-${seat}`}>
                  Player {seat + 1} name
                </label>
                <input
                  id={`player-name-${seat}`}
                  value={names[seat] ?? ''}
                  onChange={(e) => {
                    const next = [...names];
                    next[seat] = sanitizeName(e.target.value);
                    setNames(next);
                  }}
                  placeholder={SEAT_NAMES[seat]}
                  aria-invalid={duplicate || (names[seat] !== undefined && value.length === 0)}
                  className="w-full rounded-lg border border-[#365158] bg-[#1b3038] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#eacb7b] focus:ring-2 focus:ring-[#eacb7b]"
                />
              </li>
            );
          })}
        </ul>
        {!namesValid && (
          <p className="mt-2 text-xs text-[#e8a87c]" role="alert">
            Every player needs a name, and names must be different.
          </p>
        )}
      </section>

      <section className="panel mt-4 p-5 sm:p-6" aria-label="Game mode">
        <h2 className="text-lg font-bold">Mode</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {MODE_IDS.map((id) => {
            const config = MODES[id];
            const selected = mode === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(id)}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  selected ? 'border-[#eacb7b] bg-[#22323e] ring-2 ring-[#eacb7b]' : 'border-[#365158] hover:border-[#587078]'
                }`}
              >
                <div className={`font-bold ${selected ? 'text-[#eacb7b]' : ''}`}>{config.name}</div>
                <dl className="mt-2 space-y-0.5 text-xs text-slate-400">
                  <div>Start ${config.startingCash.toLocaleString()}</div>
                  <div>Win at ${config.netWorthTarget.toLocaleString()} net worth</div>
                  <div>Max {config.roundCap} rounds</div>
                </dl>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel mt-4 p-5 sm:p-6" aria-label="Deterministic seed">
        <h2 className="text-lg font-bold">Seed</h2>
        <div className="mt-3 flex flex-col gap-1.5">
          <label htmlFor="seed-input" className="text-xs text-slate-400">
            Same seed and same moves reproduce this game exactly. Try 176 for the playtest demo.
          </label>
          <div className="flex gap-2">
            <input
              id="seed-input"
              inputMode="numeric"
              autoComplete="off"
              value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value)}
              aria-invalid={seed === null}
              className="w-44 rounded-lg border border-[#365158] bg-[#1b3038] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#eacb7b] focus:ring-2 focus:ring-[#eacb7b]"
            />
            <button type="button" className="secondary" onClick={() => setSeedDraft(String(randomSeed()))}>
              New seed
            </button>
          </div>
          {seed === null && (
            <p className="text-xs text-[#e8a87c]" role="alert">
              Enter a whole number from 0 to 4294967295.
            </p>
          )}
        </div>
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button className="cta" onClick={startGame} disabled={!ready}>
          Set up game — {modeConfig.name}, {playerCount} players
        </button>
        <span className="text-xs text-slate-400">The game starts on the next screen — nothing is created yet.</span>
      </div>
    </main>
  );
}
