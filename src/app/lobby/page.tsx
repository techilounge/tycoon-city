'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MODES, MODE_IDS, type ModeId } from '@/lib/game/board-v1';
import { MAX_PLAYERS, MIN_PLAYERS } from '@/lib/game/types';
import { PLAYER_COLORS } from '@/lib/game/ui/uiPlayer';
import {
  createRoomOnWire,
  defaultSocketFactory,
  joinRoomOnWire,
  saveSessionRecord,
  WireFaultError,
} from '@/lib/game/transport/onlineClient';

/**
 * The lobby (spec §11, Phase 2 "Client experience"): a mode-of-play toggle
 * splits two flows.
 *
 * - **Local** — the Phase 1 hot-seat flow unchanged: seats 2–6 players on one
 *   device, picks a mode, and validates a deterministic seed before any game
 *   exists. Starting is deliberately lazy; config rides in the URL.
 * - **Online** — create a room (the server mints the seed and the room code;
 *   the client never sends a seed, per the locked decision) or join a room by
 *   its 6-character code with a display name. The session record returned by
 *   the server is persisted per tab so /game re-authenticates with the token.
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
  const [playMode, setPlayMode] = useState<'local' | 'online'>('local');
  const [mode, setMode] = useState<ModeId>('CLASSIC');
  const [playerCount, setPlayerCount] = useState(3);
  const [names, setNames] = useState<string[]>(SEAT_NAMES);
  const [seedDraft, setSeedDraft] = useState(() => String(randomSeed()));

  // Online state: one display name, a create seat count, a join code, busy flags.
  const [displayName, setDisplayName] = useState('');
  const [onlineSeats, setOnlineSeats] = useState(3);
  const [roomCodeDraft, setRoomCodeDraft] = useState('');
  const [onlineBusy, setOnlineBusy] = useState<'create' | 'join' | null>(null);
  const [onlineError, setOnlineError] = useState<string | null>(null);

  const seatNames = useMemo(
    () => Array.from({ length: playerCount }, (_, seat) => sanitizeName(names[seat] ?? '') || SEAT_NAMES[seat]),
    [names, playerCount],
  );
  const namesValid = seatNames.every((name) => name.length > 0) && new Set(seatNames).size === seatNames.length;
  const seed = parseSeed(seedDraft);
  const modeConfig = MODES[mode];
  const localReady = namesValid && seed !== null;

  const startGame = () => {
    if (!localReady) return;
    const query = new URLSearchParams({ players: seatNames.join(','), mode, seed: String(seed) });
    router.push(`/game?${query.toString()}`);
  };

  /** The online display name, sanitized like hot-seat names. */
  const cleanName = sanitizeName(displayName);

  const createRoom = async () => {
    if (onlineBusy !== null || cleanName.length === 0) return;
    setOnlineBusy('create');
    setOnlineError(null);
    const socket = defaultSocketFactory();
    try {
      const ack = await createRoomOnWire(socket, { mode, seatCount: onlineSeats, name: cleanName });
      saveSessionRecord(window.sessionStorage, ack.roomCode, {
        token: ack.token,
        gameId: ack.gameId,
        roomCode: ack.roomCode,
        actorId: ack.actorId,
        name: cleanName,
      });
      router.push(`/game?mode=online&code=${ack.roomCode}`);
    } catch (error) {
      setOnlineError(error instanceof WireFaultError ? error.fault.message : 'Unexpected error creating the room.');
      setOnlineBusy(null);
    } finally {
      socket.disconnect();
    }
  };

  const joinRoom = async () => {
    if (onlineBusy !== null || cleanName.length === 0) return;
    const code = roomCodeDraft.trim().toUpperCase();
    setOnlineBusy('join');
    setOnlineError(null);
    const socket = defaultSocketFactory();
    try {
      const ack = await joinRoomOnWire(socket, { code, name: cleanName });
      saveSessionRecord(window.sessionStorage, ack.roomCode, {
        token: ack.token,
        gameId: ack.gameId,
        roomCode: ack.roomCode,
        actorId: ack.actorId,
        name: cleanName,
      });
      router.push(`/game?mode=online&code=${ack.roomCode}`);
    } catch (error) {
      setOnlineError(error instanceof WireFaultError ? error.fault.message : 'Unexpected error joining the room.');
      setOnlineBusy(null);
    } finally {
      socket.disconnect();
    }
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
        {playMode === 'local'
          ? 'Local hot-seat — everyone plays from this device, one seat at a time.'
          : 'Online — create a room and share its code, or join a friend’s.'}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:inline-grid sm:w-auto" role="group" aria-label="Mode of play">
        <button
          type="button"
          aria-pressed={playMode === 'local'}
          onClick={() => setPlayMode('local')}
          className={`rounded-xl border px-6 py-2.5 text-sm font-bold transition-colors ${
            playMode === 'local' ? 'border-[#eacb7b] bg-[#22323e] text-[#eacb7b]' : 'border-[#365158] text-slate-300 hover:border-[#587078]'
          }`}
        >
          Local
        </button>
        <button
          type="button"
          aria-pressed={playMode === 'online'}
          onClick={() => setPlayMode('online')}
          className={`rounded-xl border px-6 py-2.5 text-sm font-bold transition-colors ${
            playMode === 'online' ? 'border-[#eacb7b] bg-[#22323e] text-[#eacb7b]' : 'border-[#365158] text-slate-300 hover:border-[#587078]'
          }`}
        >
          Online
        </button>
      </div>

      {playMode === 'local' && (
        <>
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
            <button className="cta" onClick={startGame} disabled={!localReady}>
              Set up game — {modeConfig.name}, {playerCount} players
            </button>
            <span className="text-xs text-slate-400">The game starts on the next screen — nothing is created yet.</span>
          </div>
        </>
      )}

      {playMode === 'online' && (
        <>
          <section className="panel mt-6 p-5 sm:p-6" aria-label="Your name">
            <h2 className="text-lg font-bold">Your name</h2>
            <label htmlFor="display-name" className="mt-1 block text-xs text-slate-400">
              Shown to the other players in the room.
            </label>
            <input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(sanitizeName(e.target.value))}
              placeholder={SEAT_NAMES[0]}
              aria-invalid={displayName.length > 0 && cleanName.length === 0}
              className="mt-2 w-full max-w-xs rounded-lg border border-[#365158] bg-[#1b3038] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#eacb7b] focus:ring-2 focus:ring-[#eacb7b]"
            />
          </section>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <section className="panel p-5" aria-label="Create a room">
              <h2 className="text-lg font-bold">Create a room</h2>
              <p className="mt-1 text-xs text-slate-400">
                The server generates the room code and the seed. Share the code after the room opens.
              </p>
              <label htmlFor="online-seats" className="mt-3 block text-xs text-slate-400">
                Seats
              </label>
              <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Seat count">
                {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((count) => (
                  <button
                    key={count}
                    type="button"
                    aria-pressed={onlineSeats === count}
                    onClick={() => setOnlineSeats(count)}
                    className={`h-9 w-9 rounded-lg border text-sm font-bold transition-colors ${
                      onlineSeats === count ? 'border-[#eacb7b] bg-[#22323e] text-[#eacb7b]' : 'border-[#365158] text-slate-300 hover:border-[#587078]'
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <button className="cta mt-4 w-full" onClick={() => void createRoom()} disabled={onlineBusy !== null || cleanName.length === 0}>
                {onlineBusy === 'create' ? 'Opening the room…' : `Create — ${modeConfig.name}, ${onlineSeats} seats`}
              </button>
            </section>

            <section className="panel p-5" aria-label="Join a room">
              <h2 className="text-lg font-bold">Join a room</h2>
              <p className="mt-1 text-xs text-slate-400">Enter the 6-character code the host shared.</p>
              <label htmlFor="room-code" className="mt-3 block text-xs text-slate-400">
                Room code
              </label>
              <input
                id="room-code"
                value={roomCodeDraft}
                onChange={(e) => setRoomCodeDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                autoComplete="off"
                spellCheck={false}
                className="mt-1.5 w-40 rounded-lg border border-[#365158] bg-[#1b3038] px-3 py-2 text-lg font-black uppercase tracking-[0.3em] text-slate-100 outline-none focus:border-[#eacb7b] focus:ring-2 focus:ring-[#eacb7b]"
                placeholder="······"
              />
              <button
                className="cta mt-4 w-full"
                onClick={() => void joinRoom()}
                disabled={onlineBusy !== null || cleanName.length === 0 || roomCodeDraft.trim().length !== 6}
              >
                {onlineBusy === 'join' ? 'Joining…' : 'Join room'}
              </button>
            </section>
          </div>

          {onlineError && (
            <p className="mt-4 text-sm text-[#e8a87c]" role="alert">
              {onlineError}
            </p>
          )}
        </>
      )}

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
        {playMode === 'local' && <p className="mt-3 text-xs text-slate-400">Modes apply to both local and online play.</p>}
      </section>
    </main>
  );
}
