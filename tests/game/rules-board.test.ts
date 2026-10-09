/**
 * Board v1 data invariants and the rules-v1 formula tables (spec §8, §9).
 *
 * Structure mirrors docs/RULES.md section by section: one test per formula
 * table row, plus the data invariants and net-worth cases the PR brief
 * requires. An economy retune (PR 9) updates these expectations together
 * with rules-v1.ts and docs/RULES.md in the same PR.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  BOARD_LOOP_SIZE,
  BOARD_SPACES,
  DISTRICTS,
  EVENT_DECK_CATALOG,
  HUB_RENT_BOTH,
  HUB_RENT_SINGLE,
  MODES,
  MODE_IDS,
  START_BONUS,
  START_SPACE_ID,
  isPurchasable,
  type AssessmentSpace,
  type BoardSpace,
  type EventCardEffect,
  type PropertySpace,
} from '../../src/lib/game/board-v1';
import {
  DISTRICT_COMPLETE_MULTIPLIER,
  LEVEL_RENT_MULTIPLIERS,
  MAX_UPGRADE_LEVEL,
  SERVICE_MULTIPLIER_BOTH,
  SERVICE_MULTIPLIER_SINGLE,
  assessmentCharge,
  baseRent,
  floor5,
  hubRent,
  mortgageLiability,
  mortgageProceeds,
  netWorth,
  rentFor,
  rentHolidayAdjusted,
  resolveCardMove,
  round5,
  serviceCharge,
  spaceIndex,
  unmortgageCost,
  upgradeCost,
  upgradeSellBackProceeds,
} from '../../src/lib/game/rules-v1';

function spacesOfKind(kind: BoardSpace['kind']): BoardSpace[] {
  return BOARD_SPACES.filter((space) => space.kind === kind);
}

function propertySpaces(): PropertySpace[] {
  return spacesOfKind('PROPERTY') as PropertySpace[];
}

const OFFICE = BOARD_SPACES.find((space): space is AssessmentSpace => space.kind === 'ASSESSMENT' && space.taxKind === 'ASSESSMENT_OFFICE');
const LEVY = BOARD_SPACES.find((space): space is AssessmentSpace => space.kind === 'ASSESSMENT' && space.taxKind === 'MUNICIPAL_LEVY');

// ---------------------------------------------------------------------------
// Data invariants — board composition (spec §8)
// ---------------------------------------------------------------------------

test('board: exactly 32 spaces with unique ids in loop order', () => {
  assert.equal(BOARD_LOOP_SIZE, 32);
  assert.equal(BOARD_SPACES.length, 32);
  const ids = BOARD_SPACES.map((space) => space.id);
  assert.equal(new Set(ids).size, 32, 'space ids must be unique');
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
});

test('board: space-kind composition is 1 start, 18 properties, 2 hubs, 2 services, 4 events, 2 assessments, 3 parks', () => {
  const counts: Record<BoardSpace['kind'], number> = {
    START: 0, PROPERTY: 0, HUB: 0, SERVICE: 0, EVENT: 0, ASSESSMENT: 0, PARK: 0,
  };
  for (const space of BOARD_SPACES) counts[space.kind] += 1;
  assert.deepEqual(counts, { START: 1, PROPERTY: 18, HUB: 2, SERVICE: 2, EVENT: 4, ASSESSMENT: 2, PARK: 3 });
});

test('board: six districts of exactly three properties, disjoint and exhaustive', () => {
  assert.equal(DISTRICTS.length, 6);
  const seen = new Set<string>();
  for (const district of DISTRICTS) {
    assert.equal(district.spaceIds.length, 3, `district ${district.id} must have exactly 3 properties`);
    for (const id of district.spaceIds) {
      assert.ok(!seen.has(id), `space ${id} appears in two districts`);
      seen.add(id);
      const space = BOARD_SPACES.find((candidate) => candidate.id === id);
      assert.ok(space, `district lists unknown space ${id}`);
      assert.equal(space.kind, 'PROPERTY');
      assert.equal((space as PropertySpace).districtId, district.id, `space ${id} must name its own district`);
    }
  }
  assert.equal(seen.size, 18, 'districts must cover all 18 properties');
});

test('board: every list price is a positive multiple of 20 (keeps all derived money integral)', () => {
  for (const space of BOARD_SPACES) {
    if (!isPurchasable(space)) continue;
    assert.ok(space.listPrice > 0, `${space.id}: price must be positive`);
    assert.equal(space.listPrice % 20, 0, `${space.id}: price must be a multiple of 20`);
  }
});

test('board: hubs are $200 each; services are $160 each; district price curves ascend', () => {
  const hubs = spacesOfKind('HUB');
  assert.equal(hubs.length, 2);
  for (const hub of hubs) assert.equal((hub as { listPrice: number }).listPrice, 200);
  const services = spacesOfKind('SERVICE');
  assert.equal(services.length, 2);
  for (const service of services) assert.equal((service as { listPrice: number }).listPrice, 160);

  // Strictly rising entry price district by district (original design curve).
  const entryPrices = DISTRICTS.map((district) => {
    const first = propertySpaces().find((space) => space.districtId === district.id);
    return first ? first.listPrice : Number.NaN;
  });
  for (let i = 1; i < entryPrices.length; i += 1) {
    assert.ok(entryPrices[i] > entryPrices[i - 1], `district ${DISTRICTS[i].id} must open above ${DISTRICTS[i - 1].id}`);
  }
});

test('board: exactly one flat Assessment Office ($120) and one Municipal Levy (8% of cash)', () => {
  assert.ok(OFFICE && LEVY, 'both assessment spaces must exist');
  assert.deepEqual(OFFICE.levy, { kind: 'FLAT', amount: 120 });
  assert.deepEqual(LEVY.levy, { kind: 'CASH_RATE', cashRate: 0.08 });
});

test('board: Gateway Terminal is the start space at index 0 with a $250 bonus', () => {
  assert.equal(BOARD_SPACES[0].id, START_SPACE_ID);
  assert.equal(BOARD_SPACES[0].kind, 'START');
  assert.equal(START_BONUS, 250);
});

// ---------------------------------------------------------------------------
// Data invariants — Event Deck (spec §8)
// ---------------------------------------------------------------------------

test('deck: exactly 18 original cards with unique ids and titles', () => {
  assert.equal(EVENT_DECK_CATALOG.length, 18);
  assert.equal(new Set(EVENT_DECK_CATALOG.map((card) => card.id)).size, 18);
  assert.equal(new Set(EVENT_DECK_CATALOG.map((card) => card.title)).size, 18);
  assert.ok(EVENT_DECK_CATALOG.every((card) => card.text.length > 0));
});

test('deck: every card effect is well-formed against the board', () => {
  const effectKinds = new Set<string>();
  for (const card of EVENT_DECK_CATALOG) {
    const effect = card.effect as EventCardEffect;
    effectKinds.add(effect.kind);
    switch (effect.kind) {
      case 'MOVE_TO': {
        const target = BOARD_SPACES.find((space) => space.id === effect.spaceId);
        assert.ok(target, `card ${card.id} moves to unknown space ${effect.spaceId}`);
        assert.notEqual(target.kind, 'EVENT', `card ${card.id} must not target a draw space (infinite loop)`);
        break;
      }
      case 'MOVE_BACK':
        assert.ok(Number.isInteger(effect.spaces) && effect.spaces > 0 && effect.spaces < BOARD_LOOP_SIZE);
        break;
      case 'PAY':
      case 'COLLECT':
        assert.ok(effect.amount > 0 && effect.amount % 5 === 0, `card ${card.id}: amount must be a positive multiple of 5`);
        break;
      case 'GRANT_TOKEN':
        assert.ok(effect.token === 'HOLD' || effect.token === 'RENT_HOLIDAY');
        break;
      case 'MOVE_TO_NEAREST_HUB':
        break;
    }
  }
  assert.deepEqual(
    [...effectKinds].sort(),
    ['COLLECT', 'GRANT_TOKEN', 'MOVE_BACK', 'MOVE_TO', 'MOVE_TO_NEAREST_HUB', 'PAY'],
  );
});

test('deck: grants exactly one Hold token and one Rent Holiday token', () => {
  const grants = EVENT_DECK_CATALOG.filter((card) => card.effect.kind === 'GRANT_TOKEN');
  assert.equal(grants.length, 2);
  assert.deepEqual(grants.map((card) => (card.effect as { token: string }).token).sort(), ['HOLD', 'RENT_HOLIDAY']);
});

// ---------------------------------------------------------------------------
// Data invariants — modes (spec §8)
// ---------------------------------------------------------------------------

test('modes: exactly Classic, Quick, Blitz with descending cash, targets, and caps', () => {
  assert.deepEqual(MODE_IDS, ['CLASSIC', 'QUICK', 'BLITZ']);
  const classic = MODES.CLASSIC;
  const quick = MODES.QUICK;
  const blitz = MODES.BLITZ;
  for (const mode of [classic, quick, blitz]) {
    assert.ok(mode.startingCash > 0, `${mode.id}: starting cash must be positive`);
    assert.ok(mode.netWorthTarget > mode.startingCash, `${mode.id}: target must exceed starting cash`);
    assert.ok(mode.roundCap > 0, `${mode.id}: round cap must be positive`);
  }
  assert.ok(classic.startingCash > quick.startingCash && quick.startingCash > blitz.startingCash);
  assert.ok(classic.netWorthTarget > quick.netWorthTarget && quick.netWorthTarget > blitz.netWorthTarget);
  assert.ok(classic.roundCap > quick.roundCap && quick.roundCap > blitz.roundCap);
});

// ---------------------------------------------------------------------------
// Formula table rows — docs/RULES.md §3 Rent
// ---------------------------------------------------------------------------

test('RULES §3 base rent: 10% of list price', () => {
  assert.equal(baseRent(200), 20);
  assert.equal(baseRent(460), 46);
  assert.equal(baseRent(60), 6);
});

test('RULES §3 level multipliers: ×1/×3/×7/×15/×20 — the landmark ×20 is Decision D-3', () => {
  assert.deepEqual(LEVEL_RENT_MULTIPLIERS, [1, 3, 7, 15, 20]);
  assert.equal(MAX_UPGRADE_LEVEL, 4);
  const expectations = [20, 60, 140, 300, 400]; // base 20 on a $200 property, no district bonus
  expectations.forEach((expected, level) => {
    assert.equal(rentFor({ listPrice: 200, level, districtComplete: false }), expected, `level ${level}`);
  });
});

test('RULES §3 complete district: rents double (×2)', () => {
  assert.equal(DISTRICT_COMPLETE_MULTIPLIER, 2);
  assert.equal(rentFor({ listPrice: 200, level: 0, districtComplete: true }), 40);
  assert.equal(rentFor({ listPrice: 200, level: 2, districtComplete: true }), 280);
});

test('RULES §3 worked example: $100 property, level 2, complete district = $140', () => {
  assert.equal(rentFor({ listPrice: 100, level: 2, districtComplete: true }), 140);
});

// ---------------------------------------------------------------------------
// Formula table rows — docs/RULES.md §4 hubs, §5 services, §6 assessments
// ---------------------------------------------------------------------------

test('RULES §4 hub rent: $60 with one hub, $150 with both', () => {
  assert.equal(HUB_RENT_SINGLE, 60);
  assert.equal(HUB_RENT_BOTH, 150);
  assert.equal(hubRent(1), 60);
  assert.equal(hubRent(2), 150);
});

test('RULES §5 service charge: 6× dice total with one service, 18× with both, nothing unowned', () => {
  assert.equal(SERVICE_MULTIPLIER_SINGLE, 6);
  assert.equal(SERVICE_MULTIPLIER_BOTH, 18);
  assert.equal(serviceCharge(7, 1), 42);
  assert.equal(serviceCharge(7, 2), 126);
  assert.equal(serviceCharge(7, 0), 0);
});

test('RULES §6 Assessment Office: flat $120 regardless of cash', () => {
  assert.ok(OFFICE);
  assert.equal(assessmentCharge(OFFICE, 100), 120);
  assert.equal(assessmentCharge(OFFICE, 9999), 120);
});

test('RULES §6 Municipal Levy: 8% of cash, rounded to the nearest $5', () => {
  assert.ok(LEVY);
  assert.equal(assessmentCharge(LEVY, 1500), 120); // exactly 8%
  assert.equal(assessmentCharge(LEVY, 1000), 80);
  assert.equal(assessmentCharge(LEVY, 1537), 125); // 122.96 → 125
});

// ---------------------------------------------------------------------------
// Formula table rows — docs/RULES.md §7 upgrades, §8 mortgages
// ---------------------------------------------------------------------------

test('RULES §7 upgrade cost: 50% of list price per level', () => {
  assert.equal(upgradeCost(200), 100);
  assert.equal(upgradeCost(460), 230);
});

test('RULES §7 upgrade sell-back: 50% of the price originally paid', () => {
  assert.equal(upgradeSellBackProceeds(300), 150);
  assert.equal(upgradeSellBackProceeds(0), 0);
});

test('RULES §8 mortgage: taking pays 50%; the liability against net worth is 50%', () => {
  assert.equal(mortgageProceeds(200), 100);
  assert.equal(mortgageLiability(200), 100);
});

test('RULES §8 unmortgage: lifting costs 110% of list price', () => {
  assert.equal(unmortgageCost(200), 220);
  assert.equal(unmortgageCost(460), 506);
});

test('RULES §10 Rent Holiday: rent halved, rounded down to a multiple of $5', () => {
  assert.equal(rentHolidayAdjusted(143), 70);
  assert.equal(rentHolidayAdjusted(250), 125);
  assert.equal(rentHolidayAdjusted(47), 20);
  assert.equal(rentHolidayAdjusted(6), 0); // sub-$5 residue floors to $0
});

test('money helpers: round5 nearest / floor5 down, integral dollars', () => {
  assert.equal(round5(122.96), 125);
  assert.equal(round5(122), 120);
  assert.equal(round5(123), 125);
  assert.equal(floor5(127), 125);
  assert.equal(floor5(125), 125);
});

test('invariant: every derived amount for every purchasable space is an integer', () => {
  for (const space of BOARD_SPACES) {
    if (!isPurchasable(space)) continue;
    const derived = [
      baseRent(space.listPrice),
      upgradeCost(space.listPrice),
      mortgageProceeds(space.listPrice),
      mortgageLiability(space.listPrice),
      unmortgageCost(space.listPrice),
    ];
    for (const amount of derived) {
      assert.ok(Number.isInteger(amount), `${space.id}: derived ${amount} must be integral`);
    }
  }
});

// ---------------------------------------------------------------------------
// Card movement resolution — docs/RULES.md §11 movement rows
// ---------------------------------------------------------------------------

test('card move: MOVE_TO counts as landing, forward; passing Gateway on the walk grants the bonus', () => {
  // Wrapped forward walk 28 → 0 passes Gateway Terminal.
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 28, { kind: 'MOVE_TO', spaceId: 'gateway-terminal' }), {
    toIndex: 0, direction: 'FORWARD', passesGateway: true,
  });
  // Short forward hop, no wrap, no bonus.
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 5, { kind: 'MOVE_TO', spaceId: 'harbor-saltmarket' }), {
    toIndex: 9, direction: 'FORWARD', passesGateway: false,
  });
  // Forward move to an earlier index wraps past Gateway.
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 20, { kind: 'MOVE_TO', spaceId: 'foundry-smeltery' }), {
    toIndex: 1, direction: 'FORWARD', passesGateway: true,
  });
});

test('card move: MOVE_BACK retreats and never grants the start bonus', () => {
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 2, { kind: 'MOVE_BACK', spaces: 3 }), {
    toIndex: 31, direction: 'BACKWARD', passesGateway: false,
  });
});

test('card move: MOVE_TO_NEAREST_HUB walks forward to the closest hub', () => {
  // From 5: Central Relay (6) is 1 step ahead; Aurora Junction (17) is 12.
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 5, { kind: 'MOVE_TO_NEAREST_HUB' }), {
    toIndex: 6, direction: 'FORWARD', passesGateway: false,
  });
  // From 18 the walk wraps: Central Relay is 20 ahead via Gateway → bonus.
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 18, { kind: 'MOVE_TO_NEAREST_HUB' }), {
    toIndex: 6, direction: 'FORWARD', passesGateway: true,
  });
  // From 7 Aurora Junction (17) is 10 ahead vs 31 back to Central Relay.
  assert.deepEqual(resolveCardMove(BOARD_SPACES, 7, { kind: 'MOVE_TO_NEAREST_HUB' }), {
    toIndex: 17, direction: 'FORWARD', passesGateway: false,
  });
});

test('card move: unknown space ids and out-of-range input are rejected', () => {
  assert.throws(() => resolveCardMove(BOARD_SPACES, 0, { kind: 'MOVE_TO', spaceId: 'not-a-space' }));
  assert.throws(() => resolveCardMove(BOARD_SPACES, 32, { kind: 'MOVE_TO_NEAREST_HUB' }));
  assert.equal(spaceIndex(BOARD_SPACES, 'crown-summit'), 31);
});

// ---------------------------------------------------------------------------
// Canonical net worth — docs/RULES.md §9 (spec §9)
// ---------------------------------------------------------------------------

test('netWorth: cash only with no holdings', () => {
  assert.equal(netWorth({ cash: 1500, holdings: [] }), 1500);
});

test('netWorth: unmortgaged assets count at full list price', () => {
  assert.equal(
    netWorth({ cash: 0, holdings: [{ listPrice: 200, mortgaged: false, cumulativeUpgradeSpend: 0 }] }),
    200,
  );
});

test('netWorth: a mortgaged asset contributes equity exactly once — $200 under mortgage is $100, not $0 or $200', () => {
  // Double-counting the liability would yield 0 (200 − 100 − 100); ignoring it
  // entirely would yield 200. The canonical answer is 100.
  assert.equal(
    netWorth({ cash: 0, holdings: [{ listPrice: 200, mortgaged: true, cumulativeUpgradeSpend: 0 }] }),
    100,
  );
});

test('netWorth: upgrade value counts at 50% of spend — including on mortgaged assets', () => {
  assert.equal(
    netWorth({ cash: 0, holdings: [{ listPrice: 200, mortgaged: false, cumulativeUpgradeSpend: 300 }] }),
    350,
  );
  assert.equal(
    netWorth({ cash: 0, holdings: [{ listPrice: 200, mortgaged: true, cumulativeUpgradeSpend: 100 }] }),
    150,
  );
});

test('netWorth: an auction bargain counts at full list price (Decision D-8)', () => {
  // The input carries the LIST price only — there is no purchase-price field,
  // so a $40 bargain on a $200 property is worth $200. That is the documented
  // v1 choice, flagged for the PR 9 simulation.
  assert.equal(
    netWorth({ cash: 40, holdings: [{ listPrice: 200, mortgaged: false, cumulativeUpgradeSpend: 0 }] }),
    240,
  );
});

test('netWorth: the docs/RULES.md §9 worked example — 800 + (200 + 150) + (460 − 230) = 1380', () => {
  assert.equal(
    netWorth({
      cash: 800,
      holdings: [
        { listPrice: 200, mortgaged: false, cumulativeUpgradeSpend: 300 },
        { listPrice: 460, mortgaged: true, cumulativeUpgradeSpend: 0 },
      ],
    }),
    1380,
  );
});

// ---------------------------------------------------------------------------
// Originality audit — AGENTS.md rule 5 (no protected genre terms)
// ---------------------------------------------------------------------------

const ORIGINALITY_SCAN_PATHS = ['src/lib/game/board-v1.ts', 'src/lib/game/rules-v1.ts', 'docs/RULES.md'];

/** Brand names and signature genre terms that must never appear in Tycoon City
 *  rules data or its rules document. `monopoly` is banned outright: the code
 *  and docs say "complete district" so the audit stays unambiguous. */
const BANNED_TERMS: readonly RegExp[] = [
  /\bmonopoly\b/i,
  /\bboardwalk\b/i,
  /\bpark place\b/i,
  /\bbaltic\b/i,
  /\bmediterranean\b/i,
  /\bmarvin\b/i,
  /\bventnor\b/i,
  /\bcharles\b/i,
  /\billinois\b/i,
  /\batlantic city\b/i,
  /\bparker brothers\b/i,
  /\bhasbro\b/i,
  /\bpennybags\b/i,
  /\brich uncle\b/i,
  /\bcommunity chest\b/i,
  /\bfree parking\b/i,
  /\bjail\b/i,
  /\bpass go\b/i,
  /\bget out of\b/i,
  /\bincome tax\b/i,
  /\bluxury tax\b/i,
  /\belectric company\b/i,
  /\bwater ?works\b/i,
  /\brailroad\b/i,
  /\bchance\b/i,
  /\badvance to\b/i,
  /\bbank error\b/i,
  /\bdarrow\b/i,
  /\bhouse\b/i,
  /\bhotel\b/i,
];

test('originality: no protected genre terms in rules data or docs', () => {
  for (const relativePath of ORIGINALITY_SCAN_PATHS) {
    const text = readFileSync(join(process.cwd(), relativePath), 'utf8');
    for (const banned of BANNED_TERMS) {
      const match = text.match(banned);
      assert.ok(!match, `${relativePath}: banned genre term "${match?.[0]}" (pattern ${banned})`);
    }
  }
});
