# Tokem

Local multi-account Texas Hold'em for web clients and Codex tools, with a separate
sandbox rewards site.

## Repository and commands

- Repository: `github.com/hellsoul86/tablemesh`; integration: `origin/main`.
- Use isolated `codex/*` task branches and preserve unrelated changes.
- `npm ci` installs the lockfile. Node >=22.13 is required; CI uses Node 22/24.
- `npm run check`: typecheck, core/server tests, and all package builds.
- `npm run test --workspace @tablemesh/core` or `@tablemesh/server`: scoped tests.
- `npm run dev`: loopback API :4100, player web :5173, rewards web :5174.
- `npm run plugin:check`: starts the declared stdio launcher with an SDK client.
- `npm run test:e2e`: Chromium browser checks; install Chromium as in README.

## Project boundaries

- Product and UI: `docs/PRODUCT.md`, `docs/DESIGN.md`. Technical contracts:
  `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/SECURITY.md`,
  `docs/ENGINE-CONTRACT.ts`. Keep the documented DTOs and source types in sync.
- `packages/core` is pure and browser-safe: no server, database, network, random,
  or wall-clock imports. Deck and time are passed into the reducer.
- The server owns sessions, room state, deadlines, persistence, points, inventory
  and redemption permissions. Serialize public state plus the viewer's own cards
  and legal actions; keep the full engine record inside the service.
- Practice chips, platform points and external model spending are separate.
  v0 has no win-based point grants, paid buy-in or real card fulfillment.
- Game MCP tokens cannot read reward secrets or use admin endpoints. Keep keys,
  tokens and card codes out of plugin output, frontend bundles and public commits;
  exclude local databases and evidence as well.
- Active-hand accounts and seats stay fixed until settlement. Explicit
  `confirmAbandon` applies persisted reputation/cooldown once per account/room/hand.
  Disconnect does not confirm abandonment. All-in payout rights remain; platform
  points are not penalized.
- Keep the compatibility identifiers `@tablemesh/*`, `TABLEMESH_*`, MCP tool and
  plugin IDs, API paths and repository URLs when editing Tokem branding.
- Local tests, CI, SDK checks, host installation, deployment and public directory
  approval are separate evidence. Describe the result actually verified. Live
  deployment, real rewards and public plugin submission are outside local v0.
