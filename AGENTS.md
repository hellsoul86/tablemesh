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

The workspace scaffold is not present in the seed commit. Verified installation,
typecheck, test, build, and development commands are TBD and must be added after
they exist and pass. Target Node >=22.13; exercise Node 22 and 24 in CI.

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
