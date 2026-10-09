'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Board } from '@/components/Board';
import type { CommandType, GameCommand } from '@/lib/game/commands';
import { LocalCommandSink } from '@/lib/game/engine/transport';
import type { AnyGameEvent } from '@/lib/game/events';
import { PLAYER_COLORS, buyOffer, currentTurnDice, describeEvent } from '@/lib/game/ui/uiPlayer';
import type { GameState } from '@/lib/game/types';

/**
 * The Phase 1 vertical slice (spec §12 PR 4): a minimal playable local
 * hot-seat game. The page submits commands through the LocalCommandSink and
 * renders events from the EventSource seam — the §2.3 transport contract
 * Phase 2 swaps for a WebSocket server without touching this page's logic.
 *
 * Slice scope: ROLL, HOLD, buy-or-decline, END_TURN. Rent, building,
 * auctions, and trading arrive with PRs 5–8; the perimeter board with PR 10.
 */

const PLAYER_NAMES = ['Ada', 'Grace'] as const;
const HISTORY_WINDOW = 12;
const MAX_SEED = 0xffffffff;

function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Whole-number seeds in [0, 2^32-1] only — the engine's seed space (spec §3). */
function parseSeed(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seed = Number.parseInt(trimmed, 10);
  return seed <= MAX_SEED ? seed : null;
}

export default function GamePage() {
  const [sink, setSink] = useState<LocalCommandSink | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [history, setHistory] = useState<readonly AnyGameEvent[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Hot-seat privacy (spec §11): false hides the board until the next player takes the handoff. */
  const [revealed, setRevealed] = useState(true);
  /** Draft seed for the next game; overridable in the lobby (spec §3). */
  const [seedDraft, setSeedDraft] = useState(() => String(randomSeed()));
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const commandCounter = useRef(0);
  const gameCounter = useRef(0);

  useEffect(() => () => unsubscribeRef.current?.(), []);

  const applyResult = useCallback((result: Awaited<ReturnType<LocalCommandSink['submit']>>, previousPlayer: string | null) => {
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    if (!result.applied) return; // idempotent duplicate — nothing changed
    setState(result.state);
    // Handoff gate: pause for the next player when the turn changes hands.
    // Game start is not a handoff — the first TURN_STARTED reveals controls
    // directly (spec §11).
    if (result.state.phase === 'PLAYING' && previousPlayer !== null && result.state.activePlayerId !== previousPlayer) {
      setRevealed(false);
    }
  }, []);

  /** Creates the game with the lobby's seed, then starts it in one action. */
  const startGame = useCallback(async () => {
    const seed = parseSeed(seedDraft);
    if (seed === null) return;
    const gameId = `g-local-${++gameCounter.current}`;
    const next = LocalCommandSink.create({
      gameId,
      seed,
      playerIds: [...PLAYER_NAMES],
    });
    unsubscribeRef.current?.();
    // The subscription replays the log from sequence 1, so history and state
    // stay in sync through one seam.
    unsubscribeRef.current = next.events.subscribe(gameId, 1, (event) => {
      setHistory((h) => [...h, event]);
      setState(next.state());
    });
    setSink(next);
    setState(next.state());
    setHistory([]);
    setPending(true);
    setError(null);
    setRevealed(true);
    const fresh = next.state();
    const result = await next.submit({
      commandId: 'ui-start',
      gameId: fresh.gameId,
      actorId: fresh.players[0].id,
      expectedVersion: fresh.version,
      type: 'START_GAME',
      payload: {},
    } as GameCommand);
    setPending(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    if (result.applied) setState(result.state);
  }, [seedDraft]);

  const newGame = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setSink(null);
    setState(null);
    setHistory([]);
    setPending(false);
    setError(null);
    setRevealed(true);
    setSeedDraft(String(randomSeed()));
  }, []);

  const submit = useCallback(
    async (type: CommandType, payload: Record<string, unknown> = {}) => {
      if (!sink || !state || pending) return;
      setPending(true);
      setError(null);
      const actor = state.activePlayerId ?? state.players[0].id;
      const command = {
        commandId: `ui-${state.version}-${type}-${++commandCounter.current}`,
        gameId: state.gameId,
        actorId: actor,
        expectedVersion: state.version,
        type,
        payload,
      } as GameCommand;
      const result = await sink.submit(command);
      setPending(false);
      applyResult(result, state.activePlayerId);
    },
    [sink, state, pending, applyResult],
  );

  const turnDice = useMemo(() => currentTurnDice(history), [history]);
  const dice = turnDice?.roll ?? null;
  const diceKey = turnDice?.key ?? -1;

  if (!state) {
    const seed = parseSeed(seedDraft);
    return (
      <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
        <nav className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
            TYCOON CITY
          </Link>
        </nav>

        <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Local Game</h1>
        <p className="mt-1 text-sm text-slate-400">Hot-seat preview · 2 players</p>

        <section className="panel mt-6 p-6" aria-label="Game start">
          <h2 className="text-xl font-bold">Ready to begin</h2>
          <p className="mt-2 text-sm text-slate-300">
            {PLAYER_NAMES.join(' and ')} take turns on this device. Each turn: roll, move, buy or decline, then end the turn.
          </p>
          <div className="mt-4 flex flex-col gap-1.5">
            <label htmlFor="seed-input" className="text-xs text-slate-400">
              Seed — same seed and same moves reproduce this game exactly
            </label>
            <input
              id="seed-input"
              inputMode="numeric"
              autoComplete="off"
              value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value)}
              aria-invalid={seed === null}
              className="w-44 rounded-lg border border-[#365158] bg-[#1b3038] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#eacb7b] focus:ring-2 focus:ring-[#eacb7b]"
            />
            {seed === null && (
              <p className="text-xs text-[#e8a87c]" role="alert">
                Enter a whole number from 0 to 4294967295.
              </p>
            )}
          </div>
          <button className="cta mt-4" onClick={() => void startGame()} disabled={pending || seed === null}>
            Start game
          </button>
        </section>

        {error && (
          <div role="alert" className="panel mt-4 border-[#a3552f] p-4 text-sm text-[#e8a87c]">
            {error}
            <button className="ml-3 underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
      </main>
    );
  }

  const activePlayer = state.players.find((p) => p.id === state.activePlayerId);
  const offer = buyOffer(state);
  const seatOf = new Map(state.players.map((p, i) => [p.id, i]));
  const round = Math.ceil(state.turn / state.players.length);
  const logLines = history
    .map(describeEvent)
    .filter((line): line is string => line !== null)
    .slice(-HISTORY_WINDOW)
    .reverse();

  const phaseHint = (() => {
    switch (state.turnPhase) {
      case 'AWAITING_ROLL':
        return 'Roll the dice to move, or spend a Hold token to skip the turn.';
      case 'BUY_DECISION':
        return offer ? `You landed on ${offer.name}. Buy it at list price, or decline.` : 'Decide whether to buy.';
      case 'TURN_MANAGEMENT':
        return 'Turn management: building, mortgaging, and trading arrive in later updates. End your turn.';
      default:
        return state.phase === 'LOBBY' ? 'Start the game when everyone is ready.' : 'The game is over.';
    }
  })();

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <nav className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
          TYCOON CITY
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400" title="Deterministic seed — same seed and same moves reproduce this game exactly">
            seed {state.seed}
          </span>
          <button className="secondary text-sm" onClick={newGame} disabled={pending}>
            New game
          </button>
        </div>
      </nav>

      <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Local Game</h1>
      <p className="mt-1 text-sm text-slate-400">
        {state.phase === 'LOBBY' ? 'Hot-seat preview · 2 players' : `Round ${round} · ${state.players.length} players · hot-seat`}
      </p>

      {state.phase === 'PLAYING' && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-4">
            <Board state={state} />
            {error && (
              <div role="alert" className="panel border-[#a3552f] p-4 text-sm text-[#e8a87c]">
                {error}
                <button className="ml-3 underline" onClick={() => setError(null)}>
                  dismiss
                </button>
              </div>
            )}
          </div>

          <aside className="flex flex-col gap-4">
            {revealed ? (
              <section className="panel p-5" aria-label="Turn controls">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-block h-4 w-4 rounded-full border border-white/70"
                    style={{ background: activePlayer ? PLAYER_COLORS[seatOf.get(activePlayer.id) ?? 0] : '#555' }}
                  />
                  <h2 className="text-lg font-bold">{activePlayer ? `${activePlayer.id}'s turn` : 'Waiting'}</h2>
                </div>
                <p className="mt-2 text-sm text-slate-300">{phaseHint}</p>

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

                <div className="mt-4 flex flex-wrap gap-3">
                  {state.turnPhase === 'AWAITING_ROLL' && (
                    <button className="cta" onClick={() => submit('ROLL')} disabled={pending}>
                      Roll dice
                    </button>
                  )}
                  {state.turnPhase === 'AWAITING_ROLL' && activePlayer && activePlayer.tokens.HOLD >= 1 && (
                    <button className="secondary" onClick={() => submit('HOLD')} disabled={pending}>
                      Hold — skip turn ({activePlayer.tokens.HOLD} left)
                    </button>
                  )}
                  {offer && (
                    <button
                      className="cta"
                      onClick={() => submit('BUY', { spaceId: offer.spaceId })}
                      disabled={pending || (activePlayer !== undefined && activePlayer.cash < offer.listPrice)}
                    >
                      Buy {offer.name} — ${offer.listPrice}
                    </button>
                  )}
                  {offer && (
                    <button className="secondary" onClick={() => submit('PASS_TO_AUCTION')} disabled={pending}>
                      Decline
                    </button>
                  )}
                  {state.turnPhase === 'TURN_MANAGEMENT' && (
                    <button className="cta" onClick={() => submit('END_TURN')} disabled={pending}>
                      End turn
                    </button>
                  )}
                </div>
                {state.doublesCount > 0 && state.turnPhase !== 'AWAITING_ROLL' && (
                  <p className="mt-3 text-xs text-[#e3bd72]">
                    Doubles streak: {state.doublesCount} — a third consecutive doubles sends you to the nearest park.
                  </p>
                )}
              </section>
            ) : (
              <section className="panel p-8 text-center" aria-label="Device handoff">
                <h2 className="text-xl font-bold">Pass the device</h2>
                <p className="mt-2 text-sm text-slate-300">
                  {activePlayer ? `Hand the device to ${activePlayer.id}.` : 'Hand the device to the next player.'}
                </p>
                <button className="cta mt-4" onClick={() => setRevealed(true)}>
                  {activePlayer ? `I'm ${activePlayer.id} — show my view` : 'Continue'}
                </button>
              </section>
            )}

            <section className="panel p-5" aria-label="Players">
              <h2 className="text-lg font-bold">Players</h2>
              <ul className="mt-3 flex flex-col gap-2">
                {state.players.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-3.5 w-3.5 rounded-full border border-white/70"
                        style={{ background: PLAYER_COLORS[seatOf.get(p.id) ?? 0] }}
                      />
                      <span className={p.id === state.activePlayerId ? 'font-bold' : ''}>{p.id}</span>
                      {p.id === state.activePlayerId && <span className="text-xs text-[#e3bd72]">active</span>}
                      {p.skipNextTurn && <span className="text-xs text-slate-400">skips next turn</span>}
                    </span>
                    <span className="text-slate-300">
                      ${p.cash.toLocaleString()} · {p.tokens.HOLD} hold
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel p-5" aria-label="Game activity">
              <h2 className="text-lg font-bold">Activity</h2>
              <ul className="mt-3 flex flex-col gap-1.5 text-sm text-slate-300" aria-live="polite">
                {logLines.map((line, i) => (
                  <li key={`${i}-${line}`}>{line}</li>
                ))}
                {logLines.length === 0 && <li className="text-slate-400">No moves yet.</li>}
              </ul>
            </section>
          </aside>
        </div>
      )}

      {state.phase === 'GAME_OVER' && (
        <section className="panel mt-6 p-8 text-center" aria-label="Game over">
          <h2 className="text-2xl font-black text-[#e3bd72]">Game over</h2>
          <p className="mt-2 text-slate-300">End conditions arrive with a later update — start a new game to keep playing.</p>
        </section>
      )}

      <p className="mt-8 text-xs text-slate-400">
        Vertical slice build: roll, doubles, hold, buy, and turn handover. Rent, auctions, trading, building, and save/resume land in
        upcoming updates.
      </p>
    </main>
  );
}
