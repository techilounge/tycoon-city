'use client';

import type { AnyGameEvent } from '@/lib/game/events';
import { buildSnapshot, type GameSnapshot } from '@/lib/game/snapshot-schema';
import { parseSnapshot } from '@/lib/game/snapshot-schema';
import type { GameState } from '@/lib/game/types';

/**
 * Local save/resume (spec §11): the browser adapter over the versioned,
 * schema-validated SnapshotStore contract (§2.4). Saves are written through
 * `serializeSnapshot` and read back through `parseSnapshot` — an unknown
 * schemaVersion is refused with a clear message and the offer of a new game,
 * never silently loaded.
 *
 * The activity log rides alongside as a UI cache (a snapshot is state-only
 * per §2.4). Losing it degrades the history panel to empty while the
 * authoritative game state still loads — the only honest degradation.
 */

const SNAPSHOT_KEY = 'tycoon-city:save:v2';
const LOG_KEY = 'tycoon-city:log:v2';
/** Companion-log cap (oldest dropped) — the snapshot, not the log, is the truth. */
const LOG_CAP = 600;

/** Browser snapshot store: one saved game per device. */
export class LocalSnapshotStore {
  constructor(private readonly storage: Storage) {}

  save(snapshot: GameSnapshot): void {
    this.storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  }

  /** SnapshotStore.load — the stored game when it is this gameId, else null. */
  load(gameId: string): GameSnapshot | null {
    const parsed = this.parse();
    return parsed !== null && parsed.gameId === gameId ? parsed : null;
  }

  /** Raw stored bytes for startup planning (schema validation happens once, at startup). */
  raw(): string | null {
    return this.storage.getItem(SNAPSHOT_KEY);
  }

  saveCompanionLog(gameId: string, history: readonly AnyGameEvent[]): void {
    const events = history.slice(-LOG_CAP);
    this.storage.setItem(LOG_KEY, JSON.stringify({ gameId, events }));
  }

  /** The cached activity log for a game — empty when absent, stale, or corrupt. */
  loadCompanionLog(gameId: string): readonly AnyGameEvent[] {
    const raw = this.storage.getItem(LOG_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'gameId' in parsed &&
        (parsed as { gameId: unknown }).gameId === gameId &&
        'events' in parsed &&
        Array.isArray((parsed as { events: unknown }).events)
      ) {
        return (parsed as { events: readonly AnyGameEvent[] }).events;
      }
      return [];
    } catch (error) {
      // The log is a display cache only; the snapshot itself is validated separately.
      console.warn('Discarding an unreadable activity log', error);
      return [];
    }
  }

  clear(): void {
    this.storage.removeItem(SNAPSHOT_KEY);
    this.storage.removeItem(LOG_KEY);
  }

  private parse(): GameSnapshot | null {
    const raw = this.raw();
    if (raw === null) return null;
    const parsed = parseSnapshot(raw);
    return parsed.ok ? parsed.snapshot : null;
  }
}

export type StartupSnapshot =
  | { readonly kind: 'LOADING' }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'RESUMABLE'; readonly snapshot: GameSnapshot }
  | { readonly kind: 'REFUSED'; readonly message: string };

/** Refusal copy per parse failure — always points at the new-game path (§2.4). */
export function refusalMessage(reason: string): string {
  switch (reason) {
    case 'UNKNOWN_SCHEMA_VERSION':
      return 'This saved game was written by a different version of the game and cannot be loaded.';
    case 'UNSUPPORTED_RULES_VERSION':
      return 'This saved game uses rules this version does not support and cannot be loaded.';
    case 'MALFORMED':
      return 'This saved game is damaged and cannot be loaded.';
    default:
      return 'This saved game failed its integrity check and cannot be loaded.';
  }
}

/** One-time startup read: what the pre-game screen should offer. */
export function readStartupSnapshot(store: LocalSnapshotStore): StartupSnapshot {
  const raw = store.raw();
  if (raw === null) return { kind: 'ABSENT' };
  const parsed = parseSnapshot(raw);
  if (parsed.ok) return { kind: 'RESUMABLE', snapshot: parsed.snapshot };
  return { kind: 'REFUSED', message: refusalMessage(parsed.reason) };
}

/**
 * Autosave after each state change. Returns false when storage refused the
 * write (quota, privacy mode) so the UI can say so — failures surface, never
 * throw into the render path.
 */
export function persistGame(store: LocalSnapshotStore, state: GameState, history: readonly AnyGameEvent[]): boolean {
  try {
    store.save(buildSnapshot(state));
    store.saveCompanionLog(state.gameId, history);
    return true;
  } catch (error) {
    console.warn('Saving the game failed', error);
    return false;
  }
}
