/**
 * Full-game integration (spec criteria 2, 5, 11): six players play a complete
 * CLASSIC game to victory through the real gateway using only public socket
 * messages; every client observes the identical gapless event stream; and a
 * wire-level scan proves no game:state or game:event payload ever carried a
 * private key.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stateHash } from '../../src/lib/game/engine/replay';
import { hasKeyDeep, startHarness, type TestHarness } from './helpers';
import { openRoom, runNetworkedGame, type RoomFixture } from './wireDriver';

describe('full 6-player CLASSIC game over the wire (criteria 2, 5, 11)', () => {
  let harness: TestHarness;
  before(async () => {
    harness = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
  });
  after(() => harness.close());

  it('reaches victory with identical gapless streams and no private keys on the wire', { timeout: 600_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'CLASSIC', seatCount: 6 });

    // Wire-level redaction scan (criterion 11): watch every state and event
    // payload each client receives for the private keys.
    const PRIVATE_KEYS = ['seed', 'rngState', 'eventDeck'] as const;
    const leaks: string[] = [];
    for (const client of fixture.clients) {
      const scan = (label: string): ((payload: unknown) => void) => (payload: unknown) => {
        for (const key of PRIVATE_KEYS) {
          if (hasKeyDeep(payload, key)) leaks.push(`${label}:${key}`);
        }
      };
      client.socket.on('game:state', scan('state'));
      client.socket.on('game:event', scan('event'));
    }

    const result = await runNetworkedGame(fixture, serverHashOf(fixture));

    // Criterion 2 — victory over public messages only.
    assert.ok(result.demonstration.allGreen, `probes: ${JSON.stringify(result.demonstration)}`);
    for (const client of fixture.clients) {
      await client.waitForVersion(finalVersionOf(fixture));
      assert.equal(client.state.phase, 'GAME_OVER');
    }

    // Criterion 5 — every seat observed the same events, gapless from 1.
    const reference = fixture.clients[0].events.map((e) => `${e.sequence}:${e.type}`);
    assert.ok(reference.length > 100, `a full 6-player game should emit many events, got ${reference.length}`);
    fixture.clients.forEach((client, seat) => {
      assert.deepEqual(
        client.events.map((e) => `${e.sequence}:${e.type}`),
        reference,
        `client ${seat + 1} event stream diverged`,
      );
      client.events.forEach((event, i) => {
        assert.equal(event.sequence, i + 1, `client ${seat + 1} event at index ${i} broke the gapless sequence`);
      });
    });

    // Criterion 11 — the scan saw payloads (the game definitely streamed)
    // and never observed a private key.
    assert.ok(reference.length > 0);
    assert.deepEqual(leaks, [], 'private keys appeared on the wire');
  });

  function finalVersionOf(fixture: RoomFixture): number {
    return fixture.clients[0].state.version;
  }

  function serverHashOf(fixture: RoomFixture): () => string {
    return () => {
      const snapshot = harness.db.loadSnapshot(fixture.gameId);
      if (snapshot === null) throw new Error(`no snapshot for ${fixture.gameId}`);
      return stateHash(snapshot.state);
    };
  }
});
