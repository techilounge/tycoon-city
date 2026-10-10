# Tycoon City — Phase 1 Originality Audit

**Status:** final · **Run:** 2026-10-10 against the docs-wrap-up tree (base
`fc84844` + the four documentation commits) · **Scope:** every board space
name, district, card title, card body, token, mode name, and UI label in the
repository — plus all engine, tool, test, and documentation text.

**Verdict: CLEAN — no board or card string in the repository derives from any
protected property-trading game.** All work is original to Tycoon City, per
`AGENTS.md` rule 5 and the approved Phase 1 specification.

## 1. Standing protection (CI-enforced, every run)

`tests/game/rules-board.test.ts` carries a `BANNED_TERMS` list of 31 regular
expressions — `monopoly`, `boardwalk`, `park place`, `baltic`,
`mediterranean`, `marvin`, `ventnor`, `charles`, `illinois`, `atlantic city`,
`parker brothers`, `hasbro`, `pennybags`, `rich uncle`, `community chest`,
`free parking`, `jail`, `pass go`, `get out of`, `income tax`, `luxury tax`,
`electric company`, `waterworks`, `railroad`, `chance`, `advance to`,
`bank error`, `darrow`, `house`, `hotel` — and scans the rules data
(`board-v1.ts`, `rules-v1.ts`) **and** `docs/RULES.md` against it on every
test run, so an accidental borrowing fails CI before merge. The vocabulary is
deliberately different everywhere: our spaces are upgraded by **levels** to a
**landmark** (never "houses" or "hotels" — those tokens are banned outright,
even generically), ownership of all three district spaces is a **complete
district** (never the m-word), and the four event spaces carry original names
("Night Market", "Street Festival", …).

## 2. Manual comprehensive sweep (this audit)

A one-off sweep far broader than the CI list — 61 patterns (the 31 CI terms
plus genre phrases, character names, token names, avenue/street names, and
card-phrase fragments) run case-insensitively over all 59 TypeScript, TSX,
and Markdown files under `src/`, `tools/`, `tests/`, `docs/`, and the repo
root — produced matches only in the classes below. Every match was read in
context; none is game content.

| Hit | Where | Classification |
|---|---|---|
| "do not copy Monopoly brand, names, artwork, board arrangement or card text" | `AGENTS.md:8` | **Accepted — policy statement.** The prohibition itself, not game content. Naming what is forbidden is the point of the rule. Retained. |
| "No proprietary Monopoly assets are included." | `README.md:30` | **Accepted — disclaimer.** Asserts the clean state; not game content. Retained. |
| "No protected Monopoly assets or names." | `docs/PRODUCT.md:13` | **Accepted — disclaimer.** As above. Retained. |
| "50% buy chance, 40% bid chance" | `tools/sim/report.ts:237`, `docs/ECONOMY.md:16` | **Accepted — ordinary English.** Probability language in the simulation methodology; the genre space name appears nowhere as a game element (and `chance` remains banned from rules/board data by the CI list). |
| Sweep-fragment false positives | various | **Noise, not findings.** Loose fragments in the one-off sweep matched ordinary words: `states` inside "estate"/"estateSale"/"gameState", `chest` inside "richest", and `the bank pays`/`collect $200` inside Tycoon City's own original sentences (e.g. the "Tourism Season Windfall" card: "Collect $200 from the bank"). No protected source. |

The strict terms (`house`/`hotel`/`bhouse`, `community chest`, `jail`,
`boardwalk`, all avenue/street names, character names, and card-phrase
fragments) matched **nothing** in any board, card, rules, or UI string.

## 3. Card and board provenance

- All 32 space names, six districts, two hubs ("Central Relay Terminal",
  "Aurora Junction Depot"), two services ("Blue Water Utility", …),
  assessments, and three parks are original coinages — see
  `src/lib/game/board-v1.ts` and `docs/RULES.md` §1.
- All 18 Event Deck titles and bodies are original — see `board-v1.ts`
  (`EVENT_DECK_CATALOG`) and `docs/RULES.md` §11. Effects that rhyme with
  genre conventions (move to a space, pay/collect money, skip a turn) are
  implemented in Tycoon City's own vocabulary (Hold token, Rent Holiday) with
  original text.
- Card text was authored for this project and is owner-reviewed (spec §14,
  originality risk row).

## 4. Keeping it clean

1. The CI banned-term list is the first gate — extend `BANNED_TERMS` if a new
   concern appears; any new board or card content fails CI on borrowing.
2. New docs that discuss the genre should follow `AGENTS.md` rule 5 and this
   audit: describe mechanics in Tycoon City's vocabulary ("complete
   district", "levels", "landmark", "Hold token"), never in borrowed terms.
3. Re-run this audit whenever `board-v1.ts`, `rules-v1.ts`, `docs/RULES.md`,
   or UI-facing strings change materially. The sweep is reproducible: grep
   the CI list plus genre phrases over `src/ tools/ tests/ docs/ *.md`.
