/**
 * Restart durability (spec criterion 9, probe 3c-across-restart): a server
 * restarted against the same SQLite file resumes the room from the latest
 * snapshot; an idempotent retry of a pre-restart commandId returns the stored
 * events; the host accepts new commands immediately after.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { GameCommand } from '../../src/lib/game/commands';
import { stateHash } from '../../src/lib/game/engine/replay';
import { SOCKET_EVENTS, type SessionAck } from '../../src/lib/game/transport/protocol';
import { startHarness, type TestHarness } from './helpers';
import { WireClient } from './wireDriver';

const CREATE = SOCKET_EVENTS.create;
const JOIN = SOCKET_EVENTS.join;

describe('restart durability (criterion 9)', () => {
  let dir: string;
  let dbPath: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-dur-'));
    dbPath = path.join(dir, 'game.db');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resumes a mid-game room after a restart and serves pre-restart idempotent retries', async () => {
    // ── Session 1: build a small game history, then stop the server. ──
    const first = await startHarness({ dbPath });
    const creator = await WireClient.connect(first);
    const created = (await first.ack(creator.socket, CREATE, { mode: 'BLITZ', seatCount: 2, name: 'A' })) as SessionAck;
    await creator.waitForVersion(0);
    const joiner = await WireClient.connect(first);
    const joined = (await first.ack(joiner.socket, JOIN, { code: created.roomCode, name: 'B' })) as SessionAck;
    assert.equal(joined.ok, true);

    const start = {
      commandId: 'dur-start-1', gameId: created.gameId, actorId: 'p1',
      expectedVersion: creator.state.version, type: 'START_GAME', payload: {},
    } as GameCommand;
    const startResult = (await creator.command(start)) as { ok: boolean; applied: boolean; events: unknown[] };
    assert.equal(startResult.applied, true);

    const roll = {
      commandId: 'dur-roll-1', gameId: created.gameId, actorId: 'p1',
      expectedVersion: creator.state.version, type: 'ROLL', payload: {},
    } as GameCommand;
    const rollResult = (await creator.command(roll)) as { ok: boolean; applied: boolean };
    assert.equal(rollResult.applied, true);

    const preSnapshot = first.db.loadSnapshot(created.gameId);
    assert.ok(preSnapshot);
    const preHash = stateHash(preSnapshot.state);
    first.close();

    // ── Session 2: same SQLite file, fresh process state. ──
    const second = await startHarness({ dbPath });

    // The creator re-authenticates with the pre-restart token (sessions persist).
    const reCreator = await WireClient.connect(second);
    const reAck = (await second.ack(reCreator.socket, JOIN, {
      code: created.roomCode, name: 'A', token: created.token, fromSeq: 1,
    })) as SessionAck;
    assert.equal(reAck.ok, true);
    assert.equal(reAck.actorId, 'p1');
    await reCreator.waitForVersion(0);

    const postSnapshot = second.db.loadSnapshot(created.gameId);
    assert.ok(postSnapshot);
    assert.equal(postSnapshot.state.version, preSnapshot.state.version);
    assert.equal(stateHash(postSnapshot.state), preHash);

    // Cross-restart idempotent retry of the PRE-restart START_GAME: ok +
    // applied:false with the stored events of the original application.
    const retry = (await reCreator.command(start)) as { ok: boolean; applied: boolean; events: unknown[] };
    assert.equal(retry.ok, true);
    assert.equal(retry.applied, false);
    assert.deepEqual(retry.events, startResult.events);

    // Liveness: a fresh command applies right after the restart.
    const live = {
      commandId: 'dur-snap-1', gameId: created.gameId, actorId: 'p1',
      expectedVersion: reCreator.state.version, type: 'SAVE_SNAPSHOT', payload: {},
    } as GameCommand;
    const liveResult = (await reCreator.command(live)) as { ok: boolean; applied: boolean };
    assert.equal(liveResult.ok, true);
    assert.equal(liveResult.applied, true);

    second.close();
  });
});
