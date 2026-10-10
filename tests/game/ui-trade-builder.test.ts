import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { craftedState, mkPlayer } from './ui-crafted';
import { FIRST_PROPERTY_ID, SECOND_PROPERTY_ID } from './ui-spaces';
import {
  buildTradeOffer,
  counterTradeBuilder,
  newTradeBuilder,
  ownedPurchasables,
  setTradeCash,
  setTradeRecipient,
  toggleTradeSpace,
  tradeBuilderValidity,
  tradeSideText,
} from '../../src/lib/game/ui/tradeBuilder';

/** The trade composer (spec §6, §11): client gating, payload assembly, counter prefill. */

function twoPlayerState(overrides: { owners?: Record<string, string> } = {}) {
  return craftedState({
    players: [mkPlayer({ id: 'Ada', seat: 0, cash: 800 }), mkPlayer({ id: 'Grace', seat: 1, cash: 500 })],
    owners: overrides.owners,
  });
}

describe('tradeBuilderValidity', () => {
  const base = newTradeBuilder();

  it('requires a recipient and rejects self-trades', () => {
    const state = twoPlayerState();
    assert.equal(tradeBuilderValidity(state, base, 'Ada').ok, false);
    assert.ok(tradeBuilderValidity(state, base, 'Ada').problems.some((p) => p.startsWith('Choose a player')));

    const self = tradeBuilderValidity(state, setTradeRecipient(base, 'Ada'), 'Ada');
    assert.ok(self.problems.includes('You cannot trade with yourself.'));
  });

  it('flags cash that is not whole dollars or exceeds what either side holds', () => {
    const state = twoPlayerState();
    const over = tradeBuilderValidity(state, { ...setTradeRecipient(base, 'Grace'), giveCash: '801' }, 'Ada');
    assert.ok(over.problems.some((p) => p.includes('cannot promise cash you do not have')));

    const malformed = tradeBuilderValidity(state, { ...setTradeRecipient(base, 'Grace'), giveCash: '12.5' }, 'Ada');
    assert.ok(malformed.problems.includes('Cash must be whole dollars.'));

    const overReceive = tradeBuilderValidity(state, { ...setTradeRecipient(base, 'Grace'), receiveCash: '501' }, 'Ada');
    assert.ok(overReceive.problems.some((p) => p.includes('cannot promise more cash')));
  });

  it('rejects a space on both sides, unowned spaces, and empty offers', () => {
    const state = twoPlayerState({ owners: { [FIRST_PROPERTY_ID]: 'Ada' } });
    const bothSides = tradeBuilderValidity(
      state,
      { ...setTradeRecipient(base, 'Grace'), giveSpaceIds: [FIRST_PROPERTY_ID], receiveSpaceIds: [FIRST_PROPERTY_ID] },
      'Ada',
    );
    assert.ok(bothSides.problems.includes('A space cannot be on both sides of the swap.'));

    const notYours = tradeBuilderValidity(state, { ...setTradeRecipient(base, 'Grace'), receiveSpaceIds: [FIRST_PROPERTY_ID] }, 'Ada');
    assert.ok(notYours.problems.some((p) => p.includes('does not own')));

    const empty = tradeBuilderValidity(state, setTradeRecipient(base, 'Grace'), 'Ada');
    assert.ok(empty.problems.includes('Offer at least one asset or some cash.'));
  });

  it('passes a legal one-space-for-cash swap and assembles the payload', () => {
    const state = twoPlayerState({ owners: { [FIRST_PROPERTY_ID]: 'Ada' } });
    const builder = { ...setTradeRecipient(base, 'Grace'), giveSpaceIds: [FIRST_PROPERTY_ID], receiveCash: '250' };
    const validity = tradeBuilderValidity(state, builder, 'Ada');
    assert.equal(validity.ok, true);
    assert.deepEqual(buildTradeOffer(builder), {
      give: { cash: 0, spaceIds: [FIRST_PROPERTY_ID] },
      receive: { cash: 250, spaceIds: [] },
    });
  });

  it('treats an empty cash draft as zero and malformed drafts as unbuildable', () => {
    const state = twoPlayerState({ owners: { [FIRST_PROPERTY_ID]: 'Ada' } });
    const builder = { ...setTradeRecipient(base, 'Grace'), giveSpaceIds: [FIRST_PROPERTY_ID] };
    assert.equal(buildTradeOffer(builder)?.give.cash, 0);
    assert.equal(buildTradeOffer({ ...builder, receiveCash: 'abc' }), null);
  });
});

describe('counterTradeBuilder', () => {
  it('reverses the roles and legs of the pending offer (spec §6)', () => {
    const pending = {
      tradeId: 'tr-1',
      proposerId: 'Ada',
      recipientId: 'Grace',
      offer: { give: { cash: 50, spaceIds: [SECOND_PROPERTY_ID] }, receive: { cash: 100, spaceIds: [FIRST_PROPERTY_ID] } },
      anchorTurn: 3 as number | null,
    };
    const state = craftedState({ trade: pending });
    const builder = counterTradeBuilder(state);
    assert.equal(builder.recipientId, 'Ada');
    assert.equal(builder.giveCash, '100');
    assert.equal(builder.receiveCash, '50');
    assert.deepEqual(builder.giveSpaceIds, [FIRST_PROPERTY_ID]);
    assert.deepEqual(builder.receiveSpaceIds, [SECOND_PROPERTY_ID]);
  });

  it('falls back to an empty builder when nothing is pending', () => {
    assert.deepEqual(counterTradeBuilder(craftedState({})), newTradeBuilder());
  });
});

describe('ownedPurchasables and tradeSideText', () => {
  it("lists only the owner's purchasable spaces and names cash + spaces", () => {
    const state = twoPlayerState({ owners: { [FIRST_PROPERTY_ID]: 'Ada' } });
    assert.deepEqual(ownedPurchasables(state, 'Ada').map((s) => s.id), [FIRST_PROPERTY_ID]);
    assert.equal(ownedPurchasables(state, 'Grace').length, 0);
    assert.equal(tradeSideText(250, [FIRST_PROPERTY_ID]), `$250 + ${ownedPurchasables(state, 'Ada')[0].name}`);
    assert.equal(tradeSideText(0, []), 'nothing');
  });
});
