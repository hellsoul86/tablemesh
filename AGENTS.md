# TableMesh

Multi-account tabletop rooms for web clients and Codex tools. v0 implements local
Texas Hold'em with an independent sandbox rewards site.

## Repository

- `repository identity`: github.com/hellsoul86/tablemesh
- `integration remote`: origin
- `integration branch`: main (greenfield: absent until the reviewed first push)
- `task worktrees`: isolated codex/* branches; never commit from main
- `deployment model`: non-publishing (local v0; repository publication only)
- No deployment, release tag, production reward activation, or public plugin
  directory submission is part of the initial implementation.

## Commands

- `install`: npm ci (lockfile); worker installation used npm install.
- `check`: npm run check (typecheck, core/server tests, all builds).
- `test`: npm test; scoped server: npm run test --workspace @tablemesh/server.
- `build`: npm run build.
- `dev`: npm run dev (API 4100; player 5173; rewards 5174, loopback).
- `plugin check`: npm run plugin:check (actual stdio launcher/SDK).
- `browser acceptance`: npm run test:e2e.
- Runtime target: Node >=22.13; CI exercises Node 22 and 24. Command existence is
  verified; final aggregate results are reported separately from scoped results.

## Boundaries

- Product scope: docs/PRODUCT.md; canonical UI contract: docs/DESIGN.md.
- Architecture, HTTP/MCP protocol, security, and frozen DTO/engine contracts:
  docs/ARCHITECTURE.md, docs/PROTOCOL.md, docs/SECURITY.md,
  docs/ENGINE-CONTRACT.ts. Record incompatible changes before implementation.
- packages/core is pure and browser-safe. It must not import server, database,
  network, random, or wall-clock facilities.
- Only the server owns authentication, authoritative rooms, deadlines, persistence,
  the points ledger, encrypted inventory, and redemption authorization.
- Never serialize full engine state externally. Each viewer receives only public
  state, their own private cards, and their own legal actions.
- Practice chips, platform points, and external model spending stay separate.
  v0 has no win-based point grant, paid buy-in, or real card fulfillment.
- MCP tokens permit game operations only. Reward secrets and admin credentials
  must never enter plugin outputs or frontend bundles.
- Keep credentials, real card codes, sessions, databases, and local evidence out
  of public commits. Use example values in configuration templates.
- Close roadmap issues only with exact checks and runtime evidence. Local tests,
  CI, host installation, deployment, and directory approval are distinct claims.
- Active-hand participants stay locked. Explicit confirmAbandon applies persisted
  reputation/cooldown once per account/room/hand; disconnect never confirms it.
  All-in settlement rights remain, and no platform points are penalized.
