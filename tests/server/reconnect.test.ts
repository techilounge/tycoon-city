/**
 * Reconnect matrix (spec criterion 6): a client killed mid-turn and an
 * eligible bidder killed mid-auction rejoin with their token, receive the
 * snapshot plus the missed events from `fromSeq`, and end up hash-equal to
 * the server — with no duplicated and no missing events. The always-on
 * witness client owns the reference stream; the rejoining seat's stream
 * (pre-disconnect events + catch-up) must equal it exactly.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AUCTION_MINIMUM_INCREMENT, AUCTION_OPENING_BID } from '../../src/lib/game/rules-v1';
import { stateHash } from '../../src/lib/game/engine/replay';
import type { GameState, PlayerId } from '../../src/lib/game/types';
import { SOCKET_EVENTS, type SessionAck, type WireCommandResult } from '../../src/lib/game/transport/protocol';
import { startHarness, type TestHarness } from './helpers';
import {
  assertGapless,
  eventStream,
  openRoom,
  playSingleTurn,
  serverRedactedHashOf,
  submitAs,
  submitFromSeat,
  waitForObserved,
  WireClient,
  type RoomFixture,
} from './wireDriver';

/**
 * Reconnect a fixture seat: fresh socket, token re-authentication, catch-up
 * from the seat's last observed sequence. Returns the replacement client.
 */
async function reconnectSeat(harness: TestHarness, fixture: RoomFixture, seat: number, fromSeq: number): Promise<WireClient> {
  const actorId = fixture.playerIds[seat] as PlayerId;
  const fresh = await WireClient.connect(harness);
  const ack = (await harness.ack(fresh.socket, SOCKET_EVENTS.join, {
    code: fixture.roomCode,
    name: `Player ${seat + 1}`,
    token: fixture.tokens[seat],
    fromSeq,
  })) as SessionAck | { ok: false; error: { code: string; message: string } };
  if (!ack.ok) throw new Error(`reconnect of ${actorId} failed: ${JSON.stringify(ack)}`);
  assert.equal(ack.actorId, actorId, 'the re-authenticated seat came back as a different actor');
  await fresh.waitForVersion(0); // the join's authoritative state broadcast
  return fresh;
}

describe('reconnect matrix (criterion 6)', () => {
  let harness: TestHarness;
  before(async () => {
    harness = await startHarness({
      commandLimit: { max: 1_000_000, windowMs: 10_000 },
      joinLimit: { max: 1_000_000, windowMs: 60_000 },
    });
  });
  after(() => harness.close());

  it('a client killed mid-turn rejoins with its token: hash equality, exact catch-up, and it acts again', { timeout: 120_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 2 });
    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'reconn-midturn-start');

    const witness = fixture.clients[0]; // p1 — never disconnects
    const victim = fixture.clients[1]; // p2 — killed mid-turn
    const fromSeq = (victim.events.at(-1)?.sequence ?? 0) + 1;

    // Kill p2 during p1's live turn, then let p1 play the whole turn solo.
    victim.socket.disconnect();
    await playSingleTurn(fixture, 0);
    assert.ok(witness.events.length > victim.events.length, 'no events occurred while the client was away');

    const p2b = await reconnectSeat(harness, fixture, 1, fromSeq);

    // No duplicated and no missing events: pre-disconnect + catch-up == the
    // witness stream, gapless from 1. The catch-up must contain ONLY the
    // missed events (nothing the seat already saw).
    const rejoined = [...victim.events, ...p2b.events];
    assert.deepEqual(
      p2b.events.map((event) => event.sequence),
      witness.events.slice(victim.events.length).map((event) => event.sequence),
      'catch-up did not start at fromSeq',
    );
    assert.deepEqual(eventStream(rejoined), eventStream(witness.events), 'the rejoined seat’s stream diverged');
    assertGapless(rejoined, 'mid-turn reconnect');

    // Hash equality: the rejoining seat's observed state matches the
    // server's authoritative snapshot through the same redacted projection.
    assert.equal(stateHash(p2b.state as GameState), serverRedactedHashOf(fixture));

    // Liveness: when p2's turn comes, it acts again over its new socket.
    await waitForObserved(p2b, (s) => s.phase === 'PLAYING' && s.activePlayerId === 'p2' && s.turnPhase === 'AWAITING_ROLL', 'p2 turn start');
    const roll = (await submitAs(fixture, p2b, 'p2', 'ROLL')) as WireCommandResult;
    assert.ok(roll.ok && roll.applied, `the reconnected seat could not act: ${JSON.stringify(roll)}`);
  });

  it('an eligible bidder killed mid-auction rejoins mid-auction, catches up exactly, and takes the high bid', { timeout: 120_000 }, async () => {
    const fixture = await openRoom({ harness, mode: 'BLITZ', seatCount: 3 });
    await submitFromSeat(fixture, 0, 'START_GAME', {}, 'reconn-auction-start');

    // Drive turns, forcing every BUY_DECISION to decline, until an auction
    // opens — then halt mid-turn with the auction live.
    let opened = false;
    for (let turn = 0; turn < 30 && !opened; turn++) {
      await waitForObserved(fixture.clients[0], (s) => s.phase === 'PLAYING' && s.turnPhase === 'AWAITING_ROLL', 'a turn to start');
      const seat = fixture.playerIds.indexOf(fixture.clients[0].state.activePlayerId as PlayerId);
      await playSingleTurn(fixture, seat, {
        forceDecline: true,
        haltOnAuctionOpen: true,
        onAuctionOpen: () => {
          opened = true;
        },
      });
    }
    assert.ok(opened, 'no auction opened within 30 turns');

    const witness = fixture.clients[2]; // p3 — never disconnects
    const victim = fixture.clients[1]; // p2 — killed mid-auction
    const auction = witness.state.auction;
    if (!auction) throw new Error('the driver halted outside an open auction');
    const auctionId = auction.auctionId;
    const spaceId = auction.spaceId;
    const fromSeq = (victim.events.at(-1)?.sequence ?? 0) + 1;

    victim.socket.disconnect();

    // While p2 is away: p1 bids the opening minimum and the witness (p3)
    // passes — two events the victim will have to catch up on. Each actor
    // submits through its OWN socket: the gateway re-stamps identity from
    // the session, so a claim of another seat's id would be re-stamped and
    // refused, not honored.
    const bid = await submitFromSeat(fixture, 0, 'BID', { auctionId, amount: AUCTION_OPENING_BID }, 'reconn-auction-bid-1');
    assert.ok(bid.ok && bid.applied, `p1's opening bid failed: ${JSON.stringify(bid)}`);
    const pass = await submitFromSeat(fixture, 2, 'PASS_BID', { auctionId }, 'reconn-auction-pass-1');
    assert.ok(pass.ok && pass.applied, `p3's pass failed: ${JSON.stringify(pass)}`);

    // Rejoin MID-AUCTION: exact catch-up — only the two missed events.
    const p2b = await reconnectSeat(harness, fixture, 1, fromSeq);
    assert.deepEqual(
      p2b.events.map((event) => event.type),
      ['AUCTION_BID', 'AUCTION_PASS'],
      'catch-up delivered something other than the missed auction events',
    );
    const rejoined = [...victim.events, ...p2b.events];
    assert.deepEqual(eventStream(rejoined), eventStream(witness.events), 'the rejoined bidder’s stream diverged');
    assertGapless(rejoined, 'mid-auction reconnect');

    // Hash equality against the server snapshot.
    assert.equal(stateHash(p2b.state as GameState), serverRedactedHashOf(fixture));

    // The seat is still in the auction and acts: it takes the high bid.
    const standing = p2b.state.auction;
    if (!standing || standing.auctionId !== auctionId || standing.currentBid === null) {
      throw new Error('the auction (with a standing high bid) did not survive the reconnect');
    }
    const rebid = await submitAs(
      fixture,
      p2b,
      'p2',
      'BID',
      { auctionId, amount: standing.currentBid + AUCTION_MINIMUM_INCREMENT },
      'reconn-auction-bid-2',
    );
    assert.ok(rebid.ok && rebid.applied, `the reconnected bidder was refused: ${JSON.stringify(rebid)}`);

    // The auction completes: p1 passes, p2 is the last unpassed bidder and
    // wins at its own bid — the reconnected seat bought the property.
    const p1pass = await submitFromSeat(fixture, 0, 'PASS_BID', { auctionId }, 'reconn-auction-pass-2');
    assert.ok(p1pass.ok && p1pass.applied, `p1's closing pass failed: ${JSON.stringify(p1pass)}`);
    await waitForObserved(p2b, (s) => s.auction === null, 'the auction to close after the reconnected seat took the high bid');
    assert.equal(p2b.state.owners[spaceId], 'p2', 'the reconnected seat did not win the property it bid on');
  });
});
