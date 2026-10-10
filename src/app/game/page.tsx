'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ActionDock } from '@/components/ActionDock';
import { AuctionModal } from '@/components/AuctionModal';
import { BankruptcyModal } from '@/components/BankruptcyModal';
import { Board } from '@/components/Board';
import { EventModal } from '@/components/EventModal';
import { PlayerRail } from '@/components/PlayerRail';
import { TradeComposerModal, TradeReviewModal } from '@/components/TradeModal';
import { TurnIndicator } from '@/components/TurnIndicator';
import { VictoryModal } from '@/components/VictoryModal';
import { MODES, MODE_IDS, type ModeId } from '@/lib/game/board-v1';
import type { CommandType, GameCommand } from '@/lib/game/commands';
import { LocalCommandSink } from '@/lib/game/engine/transport';
import type { AnyGameEvent } from '@/lib/game/events';
import { modalPlan, pendingCardReveal, pendingElimination } from '@/lib/game/ui/modals';
import { currentTurnDice, describeEvent } from '@/lib/game/ui/uiPlayer';
import { gameOverSummary } from '@/lib/game/ui/actionDock';
import type { GameState } from '@/lib/game/types';

/**
 * The Phase 1 game screen (spec §12 PR 10): the premium local hot-seat game —
 * perimeter board, context-sensitive dock, turn indicator, and handoff
 * privacy. Setup lives in the /lobby — this page consumes its config
 * (players, mode, seed) from the URL and starts lazily on the owner's click.
 * The page submits commands through the LocalCommandSink and renders events
 * from the EventSource seam — the §2.3 transport contract Phase 2 swaps for a
 * WebSocket server without touching this page's logic.
 */

const HISTORY_WINDOW = 12;

/** Lobby handoff config, validated before any game exists. */
interface GameConfig {
  readonly playerIds: readonly string[];
  readonly mode: ModeId;
  readonly seed: number;
}

const SEED_MAX = 0xffffffff;

function parseGameConfig(params: URLSearchParams): GameConfig | null {
  const playerIds = (params.get('players') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const mode = params.get('mode') ?? '';
  const seedRaw = params.get('seed') ?? '';
  if (
    playerIds.length < 2 ||
    playerIds.length > 6 ||
    new Set(playerIds).size !== playerIds.length ||
    !(MODE_IDS as readonly string[]).includes(mode) ||
    !/^\d+$/.test(seedRaw)
  ) {
    return null;
  }
  const seed = Number.parseInt(seedRaw, 10);
  if (seed > SEED_MAX) return null;
  return { playerIds, mode: mode as ModeId, seed };
}

function ConfigProblem() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
      <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
        TYCOON CITY
      </Link>
      <section className="panel mt-8 p-8 text-center" aria-label="Missing game setup">
        <h1 className="text-2xl font-black">No game is set up</h1>
        <p className="mt-2 text-sm text-slate-300">
          Local games start in the lobby — choose your players, mode, and seed there.
        </p>
        <Link href="/lobby" className="cta mt-6 inline-block">
          Go to the lobby
        </Link>
      </section>
    </main>
  );
}

export default function GamePage() {
  return (
    <Suspense fallback={null}>
      <GameScreen />
    </Suspense>
  );
}

function GameScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const config = useMemo(() => parseGameConfig(searchParams), [searchParams]);

  const [sink, setSink] = useState<LocalCommandSink | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [history, setHistory] = useState<readonly AnyGameEvent[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Hot-seat privacy (spec §11): false hides the board until the next player takes the handoff. */
  const [revealed, setRevealed] = useState(true);
  /** Trade composer bookkeeping (spec §11): open builder + the pending trade it counters, if any. */
  const [tradeBuilder, setTradeBuilder] = useState<{ counterOf: string | null } | null>(null);
  /** The pending-trade review the user dismissed — a NEW offer (different id) re-opens it. */
  const [dismissedTradeId, setDismissedTradeId] = useState<string | null>(null);
  /** The last card draw revealed to the table (sequence) — pendingCardReveal derives what is unseen. */
  const [seenCardSeq, setSeenCardSeq] = useState(0);
  /** The last elimination acknowledged (sequence). */
  const [seenElimSeq, setSeenElimSeq] = useState(0);
  /** The victory surface was dismissed to view the final board; re-openable. */
  const [victoryDismissed, setVictoryDismissed] = useState(false);
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
    // The trade composer belongs to the active player's TURN_MANAGEMENT — any
    // phase change (turn pass, doubles re-roll, move resolution) closes it.
    if (result.state.turnPhase !== 'TURN_MANAGEMENT') setTradeBuilder(null);
    // Handoff gate: pause for the next player when the turn changes hands.
    // Game start is not a handoff — the first TURN_STARTED reveals controls
    // directly (spec §11).
    if (result.state.phase === 'PLAYING' && previousPlayer !== null && result.state.activePlayerId !== previousPlayer) {
      setRevealed(false);
    }
  }, []);

  /** Creates the game with the lobby's config, then starts it in one action. */
  const startGame = useCallback(async () => {
    if (!config) return;
    const gameId = `g-local-${++gameCounter.current}`;
    const next = LocalCommandSink.create({
      gameId,
      seed: config.seed,
      playerIds: [...config.playerIds],
      mode: config.mode,
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
    setSeenCardSeq(0);
    setSeenElimSeq(0);
    setVictoryDismissed(false);
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
  }, [config]);

  const backToLobby = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    router.push('/lobby');
  }, [router]);

  const submit = useCallback(
    async (type: CommandType, payload: Record<string, unknown> = {}, actorId?: string) => {
      if (!sink || !state || pending) return;
      setPending(true);
      setError(null);
      // Hot-seat: auction bids/passes and trade answers name their own actor
      // (spec §5–§6); turn-owner commands default to the active player.
      const actor = actorId ?? state.activePlayerId ?? state.players[0].id;
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

  if (!config) return <ConfigProblem />;

  const turnDice = state ? currentTurnDice(history) : null;
  const dice = turnDice?.roll ?? null;
  const diceKey = turnDice?.key ?? -1;

  if (!state) {
    const modeConfig = MODES[config.mode];
    return (
      <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
        <nav className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
            TYCOON CITY
          </Link>
        </nav>

        <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Ready to begin</h1>
        <p className="mt-1 text-sm text-slate-400">
          {config.playerIds.length} players · {modeConfig.name} · seed {config.seed}
        </p>

        <section className="panel mt-6 p-6" aria-label="Game start">
          <p className="text-sm text-slate-300">
            {config.playerIds.join(', ')} take turns on this device. Each turn: roll, move, resolve the space, then end the turn.
          </p>
          <button className="cta mt-4" onClick={() => void startGame()} disabled={pending}>
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
  const activeSeat = activePlayer ? activePlayer.seat : 0;
  const over = gameOverSummary(history);
  const cardReveal = pendingCardReveal(history, seenCardSeq);
  const elimination = pendingElimination(history, seenElimSeq);
  const plan = modalPlan(state, {
    tradeBuilderOpen: tradeBuilder !== null,
    counterOf: tradeBuilder?.counterOf ?? null,
    dismissedTradeId,
    cardRevealPending: cardReveal !== null,
    bankruptcyPending: elimination !== null,
    victoryUnacknowledged: over !== null && !victoryDismissed,
  });
  const logLines = history
    .map(describeEvent)
    .filter((line): line is string => line !== null)
    .slice(-HISTORY_WINDOW)
    .reverse();

  // Hot-seat privacy (spec §11): until the next player takes the handoff, the
  // board, rails, and history stay off the screen entirely — not merely dimmed.
  if (!revealed && state.phase === 'PLAYING') {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-4 py-6 sm:px-5 sm:py-8">
        <section className="panel handoff-in w-full max-w-md p-8 text-center" aria-label="Device handoff">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#7fa8a4]">Pass the device</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">
            {activePlayer ? `Hand it to ${activePlayer.id}` : 'Hand it to the next player'}
          </h1>
          <p className="mt-3 text-sm text-slate-300">
            Round {state.round} · {MODES[state.mode].name} · seed {state.seed}
          </p>
          <button className="cta mt-6 w-full" onClick={() => { setRevealed(true); setDismissedTradeId(null); }}>
            {activePlayer ? `I'm ${activePlayer.id} — show my view` : 'Continue'}
          </button>
        </section>
      </main>
    );
  }

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
          <button className="secondary text-sm" onClick={backToLobby} disabled={pending}>
            New game
          </button>
        </div>
      </nav>

      <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Local Game</h1>
      <p className="mt-1 text-sm text-slate-400">
        {state.phase === 'LOBBY'
          ? `${MODES[state.mode].name} · ${state.players.length} players · hot-seat`
          : `Round ${state.round} · ${MODES[state.mode].name} · ${state.players.length} players · hot-seat`}
      </p>

      {state.phase !== 'LOBBY' && (
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
            <TurnIndicator state={state} seat={activeSeat} dice={dice} diceKey={diceKey} />
            <ActionDock state={state} pending={pending} onSubmit={submit} onOpenTrade={() => setTradeBuilder({ counterOf: null })} />

            {state.trade !== null && dismissedTradeId === state.trade.tradeId && (
              <button className="secondary text-sm" onClick={() => setDismissedTradeId(null)}>
                Review the pending trade offer…
              </button>
            )}

            {state.phase === 'GAME_OVER' && victoryDismissed && over !== null && (
              <button className="secondary text-sm" onClick={() => setVictoryDismissed(false)}>
                Final standings…
              </button>
            )}

            <PlayerRail state={state} />

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

      {plan.kind === 'AUCTION' && (
        <AuctionModal key={state.auction?.auctionId ?? 'auc'} state={state} pending={pending} onSubmit={submit} />
      )}
      {plan.kind === 'EVENT_REVEAL' && cardReveal !== null && (
        <EventModal
          key={`card-${cardReveal.sequence}`}
          reveal={cardReveal}
          pending={pending}
          onDismiss={() => setSeenCardSeq(cardReveal.sequence)}
        />
      )}
      {plan.kind === 'BANKRUPTCY' && elimination !== null && (
        <BankruptcyModal
          key={`elim-${elimination.sequence}`}
          reveal={elimination}
          pending={pending}
          onDismiss={() => setSeenElimSeq(elimination.sequence)}
        />
      )}
      {plan.kind === 'VICTORY' && over !== null && (
        <VictoryModal
          summary={over}
          state={state}
          onDismiss={() => setVictoryDismissed(true)}
          onBackToLobby={backToLobby}
        />
      )}
      {plan.kind === 'TRADE_REVIEW' && (
        <TradeReviewModal
          key={state.trade?.tradeId ?? 'review'}
          state={state}
          pending={pending}
          onSubmit={submit}
          onCounter={() => setTradeBuilder({ counterOf: state.trade?.tradeId ?? null })}
          onClose={() => setDismissedTradeId(state.trade?.tradeId ?? null)}
        />
      )}
      {plan.kind === 'TRADE_BUILDER' && (
        <TradeComposerModal
          key={`composer-${plan.counterOf ?? 'new'}`}
          state={state}
          pending={pending}
          onSubmit={submit}
          counterOf={plan.counterOf}
          onClose={() => setTradeBuilder(null)}
        />
      )}
    </main>
  );
}
