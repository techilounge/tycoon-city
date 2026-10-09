# Tycoon City Starter
An original premium property strategy game foundation for Obvious Autobuild. **Current status: local UI/gameplay demo, not online multiplayer.**

## Quick start
```bash
npm install
npm run dev
```
Open http://localhost:3000. Visit `/lobby` and `/game`.

## Validation
```bash
npm run typecheck
npm test
npm run build
```

## Connect to Obvious
1. Create a GitHub repository and push these files (do not commit secrets).
2. Install/connect the Obvious GitHub App and import the repository into Autobuild, if enabled in your workspace.
3. Ask Obvious to read `AGENTS.md`, `.obvious/obvious.md`, `docs/PRODUCT.md`, and `docs/ROADMAP.md`.
4. Start with the Phase 1 rules/specification initiative; review PRs before merging.

See https://help.obvious.ai/autobuild for current instructions.

## Architecture intent
Next.js frontend; shared pure game rules; future dedicated authoritative Node/WebSocket server; Supabase Postgres/auth/storage only when needed. `.env.example` is intentionally empty.

## Important
`/game` uses browser-generated demo dice and allows cycling demo players. Never expose this implementation as secure multiplayer. No proprietary Monopoly assets are included.
