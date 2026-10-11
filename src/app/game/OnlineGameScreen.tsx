'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ActionDock } from '@/components/ActionDock';
import { AuctionModal } from '@/components/AuctionModal';
import { BankruptcyModal } from '@/components/BankruptcyModal';
import { Board } from '@/components/Board';
import { ConnectionBadge } from '@/components/ConnectionBadge';
import { DeadlineBar } from '@/components/DeadlineBar';
import { ErrorToasts, type ToastItem } from '@/components/ErrorToasts';
import { EventModal } from '@/components/EventModal';
import { HistoryPanel } from '@/components/HistoryPanel';
import { PlayerRail } from '@/components/PlayerRail';
import { RoomPanel } from '@/components/RoomPanel';
import { TradeComposerModal, TradeReviewModal } from '@/components/TradeModal';
import { TurnIndicator } from '@/components/TurnIndicator';
import { VictoryModal } from '@/components/VictoryModal';
import { MODES } from '@/lib/game/board-v1';
import type { CommandType, GameCommand } from '@/lib/game/commands';
import type { AnyGameEvent } from '@/lib/game/events';
import { gameOverSummary } from '@/lib/game/ui/actionDock';
import { modalPlan, pendingCardReveal, pendingElimination } from '@/lib/game/ui/modals';
import { currentTurnDice } from '@/lib/game/ui/uiPlayer';
import { createCommandSink } from '@/lib/game/transport/createCommandSink';
import {
  loadSessionRecord,
  sessionKeyFor,
  WireFaultError,
  type ConnectionState,
  type OnlineClientCallbacks,
  type OnlineGameClient,
  type OnlineSessionRecord,
} from '@/lib/game/transport/onlineClient';
import type { ClientGameState } from '@/lib/game/transport/clientState';
import type { TransportFault } from '@/lib/game/transport/networkSink';
import type { RosterEntry } from '@/lib/game/transport/protocol';

/**
 * The online game screen (spec "Client experience"): the same board, rails,
 * dock, and modals as the hot-seat page, driven entirely by server
 * broadcasts. The OnlineGameClient owns sink/events/connection; this screen
 * observes it and submits commands through the sink. Identity comes from the
 * session token — the server re-stamps every command, so the screen submits
 * with its own actorId. No handoff screen: each player has a device, so the
 * reveal gate is connection-scoped by construction.
 */
export function OnlineGameScreen({ code }: { code: string }) {
  const router = useRouter();

  /** connecting → live; join-card (expired/absent session → fresh name); error (fatal refusal). */
  const [screen, setScreen] = useState<'connecting' | 'join-card' | 'error' | 'live'>('connecting');
  const [fatal, setFatal] = useState<TransportFault | null>(null);
  const [client, setClient] = useState<OnlineGameClient | null>(null);
  const [state, setState] = useState<ClientGameState | null>(null);
  const [history, setHistory] = useState<readonly AnyGameEvent[]>([]);
  const [roster, setRoster] = useState<readonly RosterEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const [pending, setPending] = useState(false);
  const [joinName, setJoinName] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [tradeBuilder, setTradeBuilder] = useState<{ counterOf: string | null } | null>(null);
  const [dismissedTradeId, setDismissedTradeId] = useState<string | null>(null);
  const [seenCardSeq, setSeenCardSeq] = useState(0);
  const [seenElimSeq, setSeenElimSeq] = useState(0);
  const [victoryDismissed, setVictoryDismissed] = useState(false);

  const clientRef = useRef<OnlineGameClient | null>(null);
  const toastCounter = useRef(0);
  const commandCounter = useRef(0);

  const pushToast = useCallback((faultCode: string, message: string) => {
    setToasts((current) => [...current, { id: ++toastCounter.current, code: faultCode, message }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /** The observation points, rebuilt per connect attempt (fresh closures). */
  const buildCallbacks = useCallback(
    (): OnlineClientCallbacks => ({
      onState: (next) => setState(next),
      onEvent: (event) => setHistory((h) => [...h, event]),
      onRoster: (next) => setRoster(next),
      onFault: (fault) => pushToast(fault.code, fault.message),
      onConnection: (next) => setConnection(next),
    }),
    [pushToast],
  );

  /** One connect attempt: factory online branch → live. Fatal faults route the screen. */
  const connectNow = useCallback(
    async (name: string, session: OnlineSessionRecord | null) => {
      try {
        const bundle = await createCommandSink({
          mode: 'online',
          code,
          name,
          session,
          storage: window.sessionStorage,
          callbacks: buildCallbacks(),
        });
        clientRef.current = bundle.client;
        setClient(bundle.client);
        setScreen('live');
      } catch (connectError) {
        const fault =
          connectError instanceof WireFaultError
            ? connectError.fault
            : ({ code: 'INTERNAL', message: 'Unexpected error joining the room.' } as TransportFault);
        if (fault.code === 'INVALID_SESSION') {
          // The stored token is dead — clear it and offer a fresh join.
          window.sessionStorage.removeItem(sessionKeyFor(code));
          setScreen('join-card');
        } else {
          setFatal(fault);
          setScreen('error');
        }
      }
    },
    [code, buildCallbacks],
  );

  // One connect attempt per mount — ONLY when a stored session can re-auth.
  // A session-less tab shows the fresh-join card: auto-joining with an empty
  // name would just draw a server refusal. Cleanup closes the socket —
  // StrictMode's double mount joins once net.
  useEffect(() => {
    let cancelled = false;
    const stored = loadSessionRecord(window.sessionStorage, code);
    void (async () => {
      if (cancelled) return;
      if (stored === null) {
        setScreen('join-card');
        return;
      }
      await connectNow(stored.name, stored);
    })();
    return () => {
      cancelled = true;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [code, connectNow]);

  // The trade composer belongs to TURN_MANAGEMENT (same rule as hot-seat):
  // a broadcast that leaves the phase closes it.
  useEffect(() => {
    if (state !== null && state.turnPhase !== 'TURN_MANAGEMENT') setTradeBuilder(null);
  }, [state]);

  const backToLobby = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    router.push('/lobby');
  }, [router]);

  const submit = useCallback(
    async (type: CommandType, payload: Record<string, unknown> = {}) => {
      const current = clientRef.current;
      if (!current || pending) return;
      const session = current.getSession();
      if (state === null || session === null) return;
      setPending(true);
      const command = {
        commandId: `ui-${state.version}-${type}-${++commandCounter.current}`,
        gameId: session.gameId,
        actorId: session.actorId,
        expectedVersion: state.version,
        type,
        payload,
      } as GameCommand;
      const result = await current.sink.submit(command);
      setPending(false);
      if (!result.ok) {
        // Rejections surface as toasts: RATE_LIMITED, NOT_AUTHORIZED, VERSION_CONFLICT…
        pushToast(result.error.code, result.error.message);
        return;
      }
      if (result.applied) setDismissedTradeId(null); // state arrives with the broadcast
    },
    [state, pending, pushToast],
  );

  const startGame = useCallback(() => {
    void submit('START_GAME', {});
  }, [submit]);

  if (screen === 'connecting') {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-6">
        <section className="panel p-8 text-center" aria-live="polite" aria-label="Joining room">
          <h1 className="text-2xl font-black tracking-tight">Joining room {code.toUpperCase()}…</h1>
          <p className="mt-2 text-sm text-slate-400">Connecting to the game server.</p>
        </section>
      </main>
    );
  }

  if (screen === 'join-card') {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-6 sm:px-5 sm:py-8">
        <section className="panel w-full max-w-md p-8" aria-label="Join room">
          <h1 className="text-2xl font-black tracking-tight">Join room {code.toUpperCase()}</h1>
          <p className="mt-2 text-sm text-slate-400">Choose a display name — it appears to the other players.</p>
          <label htmlFor="join-name" className="mt-4 block text-xs text-slate-400">
            Display name
          </label>
          <input
            id="join-name"
            value={joinName}
            onChange={(e) => setJoinName(e.target.value.replace(/,/g, '').slice(0, 16))}
            className="mt-1 w-full rounded-lg border border-[#365158] bg-[#1b3038] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#eacb7b] focus:ring-2 focus:ring-[#eacb7b]"
            placeholder="Your name"
          />
          <button
            className="cta mt-4 w-full"
            disabled={joinBusy || joinName.trim().length === 0}
            onClick={() => {
              setJoinBusy(true);
              void connectNow(joinName.trim(), null).finally(() => setJoinBusy(false));
            }}
          >
            Join the room
          </button>
          <Link href="/lobby" className="secondary mt-3 inline-block text-sm">
            Back to the lobby
          </Link>
        </section>
      </main>
    );
  }

  if (screen === 'error' || state === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4 py-6 sm:px-5 sm:py-8">
        <section className="panel w-full max-w-md p-8" role="alert" aria-label="Room unavailable">
          <h1 className="text-2xl font-black tracking-tight text-[#e3bd72]">Room unavailable</h1>
          <p className="mt-2 text-sm text-slate-300">
            {fatal?.message ?? 'The room could not be reached.'} Nothing was changed — check the code and try again.
          </p>
          <Link href="/lobby" className="cta mt-6 inline-block">
            Back to the lobby
          </Link>
        </section>
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
  const turnDice = currentTurnDice(history);
  const dice = turnDice?.roll ?? null;
  const diceKey = turnDice?.key ?? -1;
  // PR 17 broadcasts deadlines; until then the bar renders nothing.
  const deadline = null;

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <nav className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-xl font-black tracking-wide text-[#e3bd72]">
          TYCOON CITY
        </Link>
        <div className="flex items-center gap-3">
          <ConnectionBadge connection={connection} />
          <button className="secondary text-sm" onClick={backToLobby} disabled={pending}>
            Leave room
          </button>
        </div>
      </nav>

      <h1 className="mt-6 text-3xl font-black tracking-tight sm:text-4xl">Online Room {code.toUpperCase()}</h1>
      <p className="mt-1 text-sm text-slate-400">
        {state.phase === 'LOBBY'
          ? `${MODES[state.mode].name} · ${state.players.length} seats · waiting to start`
          : `Round ${state.round} · ${MODES[state.mode].name} · ${state.players.length} players`}
      </p>

      {state.phase === 'LOBBY' ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <RoomPanel
            roomCode={code.toUpperCase()}
            roster={roster}
            seatCount={state.players.length}
            phase={state.phase}
            selfActorId={client?.getSession()?.actorId ?? null}
          />
          <aside className="flex flex-col gap-4">
            <section className="panel p-4 sm:p-5" aria-label="Start game">
              <h2 className="text-lg font-bold">Ready?</h2>
              <p className="mt-1 text-sm text-slate-400">Anyone seated can start the game.</p>
              <button className="cta mt-3 w-full" onClick={startGame} disabled={pending || state.players.length < 2}>
                Start game
              </button>
            </section>
            <DeadlineBar deadline={deadline} />
          </aside>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-4">
            <Board state={state} />
            <DeadlineBar deadline={deadline} />
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

            <HistoryPanel history={history} savedLabel={null} />
          </aside>
        </div>
      )}

      {plan.kind === 'AUCTION' && (
        <AuctionModal key={state.auction?.auctionId ?? 'auc'} state={state} pending={pending} onSubmit={submit} />
      )}
      {plan.kind === 'EVENT_REVEAL' && cardReveal !== null && (
        <EventModal key={`card-${cardReveal.sequence}`} reveal={cardReveal} pending={pending} onDismiss={() => setSeenCardSeq(cardReveal.sequence)} />
      )}
      {plan.kind === 'BANKRUPTCY' && elimination !== null && (
        <BankruptcyModal key={`elim-${elimination.sequence}`} reveal={elimination} pending={pending} onDismiss={() => setSeenElimSeq(elimination.sequence)} />
      )}
      {plan.kind === 'VICTORY' && over !== null && (
        <VictoryModal summary={over} state={state} onDismiss={() => setVictoryDismissed(true)} onBackToLobby={backToLobby} />
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

      <ErrorToasts toasts={toasts} onDismiss={dismissToast} />
    </main>
  );
}
