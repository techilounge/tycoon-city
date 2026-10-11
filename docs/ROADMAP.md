# Implementation roadmap for Obvious

Status as of the Phase 1 wrap-up (2026-10). Phase 0 and Phase 1 are complete;
Phase 2 is next. The approved Phase 1 specification (Rev 2) governs what
shipped; `docs/ARCHITECTURE.md`, `docs/MULTIPLAYER_CONTRACT.md`,
`docs/GAME_STATE_MACHINE.md`, `docs/TESTING.md`, and `docs/ECONOMY.md`
document the result.

## Phase 0 — Foundation ✅ (PR #1)

Runnable Next.js demo, home/lobby/board screens, shared types, pure initial reducer, agent instructions, tracked lockfile, CI gates (typecheck + tests + build). The original demo is preserved at `/demo`.

## Phase 1 — Rules and local gameplay ✅ (PRs #2–#12)

Original board/rules, complete property/rent/tax/event/auction/trade/upgrade/bankruptcy logic, deterministic seeded dice injection, invariants and exhaustive unit tests, turn action state machine, and end conditions — delivered as:

| PRs | Delivered |
|---|---|
| #2 | Engine foundation: command/event envelopes, idempotent reducer, seeded RNG, snapshots, replay |
| #3 | Board v1 data, economy formulas, canonical net worth, `docs/RULES.md` |
| #4 | Playable vertical slice (owner playtest checkpoint held) |
| #5–#8 | Economy (rent, taxes, services, event deck, debt settlement), auctions, trading, endgame (development, bankruptcy waterfall, elimination auctions, victory) |
| #9 | Balance-simulation harness + headless multiplayer-contract demonstration (`docs/ECONOMY.md`) |
| #10–#11 | Premium local UI (lobby, perimeter board, dock, handoff privacy) and complete UX (modals, explanations, history, save/resume) |
| #12 | Phase 2-ready contracts and documentation (this PR) |

All Phase 1 gameplay is local hot-seat on the deterministic engine: 2–6 players, a 32-space board, six districts, 18 event cards, Classic/Quick/Blitz modes.

## Phase 2 — Real multiplayer (in progress)

Dedicated Node WebSocket/Socket.IO server, authoritative commands, room join/create, guest identity, secure random rolls, persistence, reconnect, idempotency, concurrency tests and rate limits. Do not ship public multiplayer until these pass. The Phase 2 seams are already specified: `docs/MULTIPLAYER_CONTRACT.md` lists the contracts that are running code (demonstrated over complete games) versus documented-only, and `docs/ARCHITECTURE.md` §10–§11 name what must not break and how deadlines act.

Delivered so far:

| PRs | Delivered |
|---|---|
| #14 | One-port custom server: Socket.IO + SQLite (games, event log, sessions) with rate limits |
| #15 | Authoritative game service: rooms, session tokens, redacted broadcasts, reconnect catch-up, durable command ledger |
| #16 (this PR) | Server-enforced deadlines — per-mode turn windows and the auction bid window, expiry actions submitted as ordinary ledgered commands through the per-game queue; the additive bank-acted `VOID_BID` command + `AUCTION_BID_VOIDED` event (§3 rows moved to implemented) |

Still open in Phase 2: the client online-mode experience (transport factory, room panel, DeadlineBar), AI substitution, and spectator projections.

## Phase 3 — Social and polish

Chat moderation, sound, animations, accessibility audit, responsive board, stats/results, observability, E2E tests.

## Phase 4 — Growth

Accounts, public matchmaking, rankings, AI bots, cosmetic shop, custom boards, optional 3D. Validate legal/privacy and payment compliance before launch.

## First Obvious initiative ✅

Implement Phase 1 in small PRs — write an original rules specification with exact formulas and tests, and preserve the existing demo until the new local game is playable. Fulfilled: 12 PRs, each independently buildable and CI-gated; the pre-Phase-1 demo remains at `/demo`.
