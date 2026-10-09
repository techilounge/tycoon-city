# Agent instructions
This repository is a clean starter for Tycoon City, an original multiplayer property strategy game.

1. Read `docs/PRODUCT.md` and `docs/ROADMAP.md` before feature work.
2. Keep game rules pure and deterministic in `src/lib/game`. Never trust client dice, balances, trades, timers, or ownership in production.
3. The current UI is an explicitly local demo. Do not describe it as online multiplayer.
4. Implement mobile-first accessible screens with no page-level horizontal overflow.
5. Preserve originality: do not copy Monopoly brand, names, artwork, board arrangement or card text.
6. Run `npm run typecheck`, `npm test`, and `npm run build` before a PR.
7. Keep secrets out of Git; use `.env.example`. No production payments or AI services without approval.
8. Deliver changes in small reviewable PRs; document assumptions and tests.
