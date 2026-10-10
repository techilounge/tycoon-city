# Tycoon City — Rules v1

**RULES_VERSION = 1** · Board data version 1 (`src/lib/game/board-v1.ts`) · Formulas single-sourced in `src/lib/game/rules-v1.ts`

> **Provisional values.** Every number in this document is a RULES_VERSION 1
> provisional value. The deterministic balance simulation (spec §8, PR 9) is
> the arbiter; retunes change `board-v1.ts` / `rules-v1.ts` and this document
> together in one data-only PR — never engine logic.
>
> All money in Tycoon City is whole dollars: every list price is a multiple of
> 20, so every derived amount below (rents, upgrade costs, sell-backs,
> mortgage math) is integral by construction.

---

## 1. The board

One closed loop of **32 spaces**. Tokens move forward around the loop and wrap
from the last space back to the first. Space **0 is Gateway Terminal**, the
start space: any token that **passes or lands on it moving forward** collects
the **start bonus of $250**. Backward movement never pays the bonus.

| Idx | Space | Kind | Data |
|---:|---|---|---|
| 0 | Gateway Terminal | Start | start bonus $250 on forward pass or landing |
| 1 | Old Smeltery Lane | Property | Foundry Row — $60 |
| 2 | City Wire Bulletin | Event | draw an Event card |
| 3 | Brasshouse Court | Property | Foundry Row — $80 |
| 4 | Municipal Levy | Assessment | 8% of the payer's cash |
| 5 | Anvil & Ore Works | Property | Foundry Row — $100 |
| 6 | Central Relay Terminal | Transit hub | $200 |
| 7 | Ropefront Walk | Property | Harbor Quarter — $120 |
| 8 | Founders Green | Park | no effect |
| 9 | Saltmarket Pier | Property | Harbor Quarter — $140 |
| 10 | Night Market | Event | draw an Event card |
| 11 | Beaconside Terrace | Property | Harbor Quarter — $160 |
| 12 | City Powerworks | City service | $160 |
| 13 | Greenmarket Square | Property | Marketview — $180 |
| 14 | Coppermonger Row | Property | Marketview — $200 |
| 15 | Assessment Office | Assessment | flat $120 |
| 16 | Guildhall Yard | Property | Marketview — $220 |
| 17 | Aurora Junction Depot | Transit hub | $200 |
| 18 | Lantern Way | Property | Parkside — $240 |
| 19 | Street Festival | Event | draw an Event card |
| 20 | Museum Mile | Property | Parkside — $260 |
| 21 | Blue Water Utility | City service | $160 |
| 22 | Observatory Row | Property | Parkside — $280 |
| 23 | Aurora Gardens | Park | no effect |
| 24 | Exchange Boulevard | Property | Midtown — $300 |
| 25 | Meridian Plaza | Property | Midtown — $320 |
| 26 | Harbor Festival | Event | draw an Event card |
| 27 | Commerce Spire | Property | Midtown — $340 |
| 28 | Sovereign Terrace | Property | Crown Heights — $380 |
| 29 | Regent Gate | Property | Crown Heights — $420 |
| 30 | Verdant Commons | Park | no effect |
| 31 | Crown Summit | Property | Crown Heights — $460 |

Composition: 1 start · 18 properties · 2 transit hubs · 2 city services ·
4 event spaces · 2 assessments · 3 parks. The third-consecutive-doubles
penalty sends a token to the **nearest park** (which has no effect there).

## 2. Districts and prices

Six districts of exactly **three properties** each. All list prices rise by
district.

| District | Properties (list price) |
|---|---|
| Foundry Row | Old Smeltery Lane $60 · Brasshouse Court $80 · Anvil & Ore Works $100 |
| Harbor Quarter | Ropefront Walk $120 · Saltmarket Pier $140 · Beaconside Terrace $160 |
| Marketview | Greenmarket Square $180 · Coppermonger Row $200 · Guildhall Yard $220 |
| Parkside | Lantern Way $240 · Museum Mile $260 · Observatory Row $280 |
| Midtown | Exchange Boulevard $300 · Meridian Plaza $320 · Commerce Spire $340 |
| Crown Heights | Sovereign Terrace $380 · Regent Gate $420 · Crown Summit $460 |

A player who owns **all three properties of a district** has a **complete
district**: its rents **double (×2)**, and completing the district is the
prerequisite for building upgrades on it (the BUILD rules — see §7 — enforce
both).

## 3. Rent

**Base rent = 10% of the space's list price.**

Total rent = base rent × level multiplier × (2 if the owner's district is
complete, otherwise 1).

| Upgrade level | 0 (none) | 1 | 2 | 3 | 4 — landmark |
|---|---|---|---|---|---|
| Level multiplier | ×1 | ×3 | ×7 | ×15 | **×20** (Decision D-3, provisional) |

Worked example (the shape the game shows players): a $100 property at level 2
in a completed district rents for **$10 base × 7 (level 2) × 2 (district) =
$140**.

A **mortgaged property collects no rent**. It still counts in net worth at
equity (§9).

## 4. Transit hubs

Two hubs, **$200** each, freely tradable. Rent is **$60** when the owner holds
one hub and **$150** when the owner holds both.

## 5. City services

Two services, **$160** each. When a token lands on an owned service, the
lander pays the owner the **dice total × 6** if the owner holds one service,
**dice total × 18** if the owner holds both. An unowned service charges
nobody.

## 6. Assessments

Two assessment spaces, both paid to the **bank**:

| Space | Charge |
|---|---|
| Assessment Office | **flat $120** |
| Municipal Levy | **8% of the payer's current cash**, rounded to the nearest $5 |

## 7. Upgrades

- One upgrade level costs **50% of the property's list price**, paid to the bank.
- Maximum level is **4**, the **landmark** (rent multiplier ×20).
- Building requires the owner to hold the complete district (§2).
- Selling a built level back to the bank returns **50% of the price originally
  paid for that level** (the same rate applies to forced sell-backs during
  debt settlement and in the bankruptcy waterfall — see
  `docs/GAME_STATE_MACHINE.md` §6–§7).

## 8. Mortgages

- **Mortgage** an unmortgaged space at upgrade level 0: the bank pays the owner
  **50% of the list price**.
- **Lift** a mortgage: pay the bank **110% of the list price**.
- A mortgaged property collects no rent (§3). Mortgaged spaces may still be
  traded (the transferee later pays the 110% to lift).
- **Bank repossession clears mortgages:** when a bankruptcy transfers an
  estate to the **bank**, mortgage flags are cleared with the ownership — the
  liability dies with the ownership, and repossessed spaces return clean for
  the next buyer. Estates transferred to a **player** creditor keep their
  mortgage flags intact (that creditor lifts them at the 110% rate).
  See `docs/GAME_STATE_MACHINE.md` §7.

## 9. Net worth — the canonical formula

Net worth is computed by exactly one function (`netWorth` in `rules-v1.ts`);
leaderboards, victory checks, and results all use it.

```
netWorth(p) = p.cash
  + Σ over unmortgaged spaces:  listPrice
  + Σ over mortgaged spaces:    listPrice − mortgageLiability   // liability = 50% of listPrice
  + Σ over all owned spaces:    0.5 × cumulativeUpgradeSpend    // liquidation value of levels
```

- **No double-counting:** the mortgage liability is deducted once, inside the
  asset's equity term; there is no global liability subtraction. A $200
  property under mortgage contributes **$100**.
- **Upgrades count at 50% of what was paid for them** — the value a player can
  actually realize by selling back.
- **Auction bargains count at full list price** (Decision D-8): a player who
  bid $40 for a $200 property holds $200 of net worth.
- **No pending payments:** a debt is either settled (cash reduced) or resolved
  by bankruptcy (assets gone) before net worth is ever evaluated — inputs
  always describe settled state.

Worked example: cash $800, owning a $200 property unmortgaged with $300 of
build spend, and a $460 property under mortgage with no builds →
800 + (200 + 150) + (460 − 230) = **$1,380**.

## 10. Tokens

- **Hold token** — spent by its holder with a `HOLD` command on their own turn
  to **skip that entire turn** (no roll, no movement, no management actions).
  End-of-turn victory evaluation still runs. It does not interact with doubles.
- **Rent Holiday token** — spent automatically the moment its holder next owes
  **rent** (never taxes, service charges, or card penalties): that payment is
  **halved, rounded down to a multiple of $5**. Sub-$5 residues round to $0.

## 11. The Event Deck

18 original cards. At game start the draw pile is the catalog below, shuffled
with the game's seeded random source; when the draw pile empties, the discard
pile reshuffles the same way. Draw order lives in game state, so replays
reproduce it exactly.

| Card | Effect |
|---|---|
| Summons from City Hall | Move to Gateway Terminal (counts as landing; the forward move pays the start bonus) |
| Trade Summit Invitation | Move to Exchange Boulevard (counts as landing) |
| Gallery Night Spotlight | Move to Observatory Row (counts as landing) |
| Harbor Strike Closure | Move to Saltmarket Pier (counts as landing) |
| Transit Day Pass | Move to the nearest transit hub (counts as landing) |
| Parade Blocks the Line | Move back 3 spaces (never pays the start bonus) |
| Municipal Fine Notice | Pay the bank $100 |
| Storm Damage Repairs | Pay the bank $75 |
| Audit Adjustment | Pay the bank $150 |
| Festival Sponsor Drive | Pay the bank $50 |
| Elevator Modernization | Pay the bank $120 |
| Dividend Disbursement | Collect $100 from the bank |
| Heritage Facade Grant | Collect $150 from the bank |
| Loyalty Program Payout | Collect $75 from the bank |
| Tourism Season Windfall | Collect $200 from the bank |
| Zoning Variance Approved | Collect $120 from the bank |
| Administrative Recess | Gain a Hold token |
| Small Business Relief | Gain a Rent Holiday token |

"Move to X" cards count as **landing on X**: an unowned purchasable X opens
the normal buy decision, rents are due, and the forward walk pays the start
bonus when it passes or lands on Gateway Terminal. Card debts are owed to the
bank and enter the ordinary debt process.

## 12. Game modes and victory

| Mode | Starting cash | Net-worth target | Round cap |
|---|---|---|---|
| Classic | $1,500 | $6,000 | 40 |
| Quick | $1,200 | $4,500 | 25 |
| Blitz | $1,000 | $3,000 | 15 |

Victory — the first condition reached ends the game:

1. **Last solvent player** — everyone else is bankrupt.
2. **Net-worth target** — a player's net worth (§9) reaches the mode's target
   at the end of any turn.
3. **Round cap** — when a new round would start beyond the cap, the **richest
   player by net worth wins** (ties share the victory).

Eliminated players are out of turn order; their estates settle through the
bankruptcy waterfall and (for bank creditors) elimination auctions — fully
specified and implemented; see `docs/GAME_STATE_MACHINE.md` §6–§7.

## 13. Originality

Every space name, district, card title, and card text is original to Tycoon
City. The test suite scans the rules data and this document against a list of
protected genre terms on every run, so an accidental borrowing fails CI.
