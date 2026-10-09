# Implementation roadmap for Obvious
## Phase 0 — Foundation (this repository)
Runnable Next.js demo, home/lobby/board screens, shared types, pure initial reducer, agent instructions.
## Phase 1 — Rules and local gameplay
Define original board/rules, complete property/rent/tax/event/auction/trade/upgrade/bankruptcy logic, deterministic seeded dice injection, invariants and exhaustive unit tests. Add turn action state machine and end conditions.
## Phase 2 — Real multiplayer
Dedicated Node WebSocket/Socket.IO server, authoritative commands, room join/create, guest identity, secure random rolls, persistence, reconnect, idempotency, concurrency tests and rate limits. Do not ship public multiplayer until these pass.
## Phase 3 — Social and polish
Chat moderation, sound, animations, accessibility audit, responsive board, stats/results, observability, E2E tests.
## Phase 4 — Growth
Accounts, public matchmaking, rankings, AI bots, cosmetic shop, custom boards, optional 3D. Validate legal/privacy and payment compliance before launch.
## First Obvious initiative
Implement Phase 1 in small PRs. Start by writing an original rules specification with exact formulas and tests. Preserve existing demo until the new local game is playable.
