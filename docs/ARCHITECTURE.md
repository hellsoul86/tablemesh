# Tokem architecture

## v0

Tokem runs a multi-account Texas Hold'em service, a player web app, a separate rewards web app and a local Codex plugin. People and agents use the same accounts, seat permissions, actions and deadlines. Registration and login create the identity; the plugin uses an issued game token. The Codex plugin makes no model calls. Manual play needs no model key; optional server autoplay uses the account’s saved model connection.

Joining a seat makes it ready. The owner can start with at least two funded seats. Practice chips belong to the table; platform points belong to the account ledger. Chips cannot buy points or be redeemed. v0 uses demo starter points and sandbox inventory, with real rewards disabled by default. A separate rewards website limits access to card secrets; it does not exempt the product from platform review. Public plugin submission, hosting and real reward economics are follow-up work.

## Runtime and packages

The repository uses npm workspaces, ESM, strict TypeScript and Node >=22.13. Dependencies are pinned in package-lock.json; CI runs Node 22/24. `node:sqlite` no longer needs a flag at 22.13, but was still experimental there. Code uses its baseline `DatabaseSync`, `prepare` and `exec` APIs. Database calls are synchronous, so transactions contain no network calls or `await`. The development API binds to loopback.

| Package | Responsibility | Runtime dependencies |
|---|---|---|
| packages/core | Serializable Hold'em reducer/evaluator and browser-safe DTOs | None |
| packages/server | Sessions, HTTP, room scheduler, SQLite, points, inventory, redemption, model providers/autoplay and stdio MCP adapter | core, Node builtins, MCP SDK, zod |
| packages/web | Login, lobby, account/points, table and reconnect | Browser API client; Vite build |
| packages/rewards-web | Catalog, redemption, owner code reveal and protected inventory UI | Browser API client; Vite build |
| plugins/tablemesh | Manifests, launcher and gameplay skill | Built server adapter |

Pinned versions include TypeScript 5.9.3, tsx 4.23.15, MCP SDK 1.32.0, zod 4.6.5 and Vite 8.3.2. Vite requires Node ^20.19.0 or >=22.12.0; SDK 1.32 supports Node >=18 and zod ^3.25 or ^4.0. Use the SDK v1 documentation for the selected package version. Tests use Node's built-in runner after TypeScript compilation.

Tokem is the display name. Package names `@tablemesh/*`, environment variables `TABLEMESH_*`, tool/plugin IDs, API paths and the repository URL retain their existing values for compatibility.

## Persistence and transactions

One Node server process owns each SQLite file. The stdio adapter connects over authenticated HTTP to that process. It does not open the database or run a second engine. Startup sets `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL` and `busy_timeout=5000`. The timeout PRAGMA works on Node 22.13; the later `DatabaseSync` constructor timeout option is not used. Prepared statements and `BEGIN IMMEDIATE` handle writes. SQLite allows one writer; WAL does not remove that limit. Multi-instance room ownership and fencing are not implemented.

The current schema contains:

- `accounts` and `sessions`: normalized unique names, password hashes, hashed web/game tokens, expiry and revocation.
- `rooms`: engine JSON, state version and event cursor. `room_events` stores public payloads; private cards and remaining deck stay in the engine snapshot for recovery.
- `requests`: unique account/operation/resource/request ID, body hash and accepted-result metadata. A repeated ID with a different body conflicts.
- `wallets` and `ledger`: nonnegative available/held balances and unique ledger source keys. Wallet changes and entries share a transaction. The starter grant uses `starter:<account>:v0`; v0 has no game point grants.
- `products`, `inventory` and `redemptions`: price and sandbox flag, encrypted codes with unique keyed fingerprints, one code assignment per redemption, and unique account/request IDs. `admin_audit` records operations without code plaintext.
- `llm_configs` and `llm_tests`: one account configuration with encrypted provider credentials, plus reserved test IDs and safe test outcomes. Active autoplay controllers are not persisted.
- `fair_play` and `room_abandons`: reputation, cooldown and one abandonment record per account/room/hand.
- `hand_settlements`: one result and original account/seat/name snapshot per room/hand. Its public `hand_settled` event and published marker commit with room state.

Room commands run in a per-room queue. Accepted duplicates replay first. For a new command, the server captures time and commits any due timeout separately, then checks the command's version, seat and window in its own transaction. A valid reducer result, room snapshot, public events and request metadata commit together; responses follow commit. Persisted deadlines restore on restart. At the deadline, timeout wins and a command carrying the previous version conflicts. Confirmed abandonment before the deadline uses the captured time to fold in the current or next legal window; all-in rights remain until settlement. Disconnects do not incur a penalty.

The service saves each new transition settlement before abandoned participants are removed. Seat changes clear stale current-hand display fields, while the persisted event retains the original account identities and awards. GET snapshots project the requesting viewer's cards and legal actions; the full engine JSON stays inside the service.

Redemption checks retry history, product mode, balance and available inventory in one transaction. It assigns one code, records a points reserve and capture, and marks the order fulfilled. Failure rolls back the transaction. A retry returns the same order; two accounts competing for the last code yield one fulfillment and one OUT_OF_STOCK, without debiting the loser. Future external fulfillment will need pending holds, an outbox, idempotent delivery and release on definitive failure before supplier calls are added.

## Hold'em rules

Core takes a complete unique 52-card deck and time as inputs. The server shuffles with Fisher–Yates and `crypto.randomInt`. Reducers leave their input unchanged and return JSON-serializable state. Function and DTO signatures are in ENGINE-CONTRACT.ts.

- 2–6 occupied seats; positive blinds with SB <= BB; integer chips. Heads-up button posts SB and acts first preflop, last postflop. Multiway action starts left of BB preflop and left of button postflop. The button rotates among funded seats. Deal two hole cards and burn before flop, turn and river.
- `raise.amount` is the total street contribution. `toCall = max(0, currentBet - streetBet)`; a call deducts at most the remaining stack. Minimum full raise is `currentBet + lastFullRaiseIncrement`, initially BB. A below-minimum raise is allowed only for an exact all-in. Raising requires another active opponent.
- A short all-in increases the amount owed without alone reopening a previously acting player. Track the bet and full increment at that player's last action; cumulative short raises can reopen betting. Postflop short opening 5 with BB 10 requires an unacted player to raise to at least 15. After that raise the next minimum is 25, because the raise increment was 10. Completing to 10 is a limit rule; a prior check is not reopened by the short 5 alone.
- A street finishes after all active responders have acted and matched the current bet. With no further betting possible, run out the board. One surviving player wins immediately without a public hole-card reveal.
- Side pots follow contribution thresholds. Folded contributions count toward amounts, but folded players are ineligible. Refund unmatched top contributions. Evaluate each contested pot separately, split integer shares and award odd chips clockwise from left of the button among tied winners. Suits do not break ties.
- Evaluate the best five of seven by category and kickers, including the A2345 wheel. Showdown reveals nonfolded contenders; folded cards remain private. Validate deck uniqueness.
- During a hand, `sum(stacks) + sum(contributions)` is constant. Settlement awards plus refunds equal contributions. After payout contributions clear, stacks remain nonnegative and starting the next hand does not pay the previous one again.

## Optional model autoplay

An account can configure OpenAI-compatible Chat Completions or Anthropic Messages and enable its current seat’s controller. The base URL is an API prefix: for example `https://api.openai.com/v1`, `http://127.0.0.1:11434/v1`, or `https://api.anthropic.com/v1`. The adapter appends `/chat/completions` or `/messages`; it does not infer `/v1`. OpenAI-compatible output limits use the saved `max_tokens` or `max_completion_tokens` field, defaulting to `max_tokens`; Anthropic uses `max_tokens`. There is no automatic fallback or retry. Anthropic credentials must work without a workspace-selection header; multi-workspace keys needing `anthropic-workspace-id` are not supported.

`autoplay.ts` owns the process-local controller; `provider.ts` owns configuration, encrypted keys and bounded HTTP. The controller receives no credentials. A prompt contains only numeric poker fields, the viewer’s hole cards, public board/pots, legal actions, game settings and a random decision nonce. It excludes names, account/room/hand IDs, sessions, rewards and the internal deck. Output is exactly `{decisionNonce,action}`. The controller checks nonce, current legal amount, room version, window, deadline and originating session, then submits through the same room reducer as manual play. A guard runs again inside the room queue.

Model network work runs outside room queues and SQLite transactions. One account/room has one unfinished job; cancellation retains that job until it settles, so a noncooperative provider cannot overlap a resumed job. Stop, manual takeover, configuration changes, revoked/expired credentials, abandonment and stale results prevent late submission. Ordinary server timeout still checks or folds. Stopping autoplay does not leave the seat or penalize reputation.

Autoplay continues at the same table across hands, but does not create a room, sit down or start a hand. Restart defaults to stopped and requires a new explicit start. Each dispatched request counts, including failed/cancelled requests. Defaults are 5 seconds, 256 output tokens, 20 requests per hand and 100 per run; accepted ranges are 1–30 seconds, 64–1024 tokens, 1–60 per hand and 1–500 per run. The request timeout is shortened to the remaining turn time minus a 25ms margin. Pause/resume preserves the current-hand count; a new explicit start resets the run count. These are request/token budgets, not a currency cost guarantee; the supplier may bill a cancelled request.

Configuration tests reserve their request ID before network work. Replays return the existing result; interrupted tests do not dispatch again after restart. The configured model may charge for a test. Fake local providers validate both protocols and controller races without paid API calls.

## Other games

Only Hold'em is implemented. `RuleSet` reserves separate public/private views, optional team IDs and single/parallel response windows for future games. Tractor teams and Mahjong claim priority need their own reducers and tests. Parallel response windows collect intents against a common baseline and resolve serially; they do not permit concurrent mutation of state. Game-specific views and actions can extend the discriminated union when those engines exist.

## Commands and verification

Use `npm ci`, `npm run check`, `npm run plugin:check` and `npm run test:e2e`. Scoped rule/service tests are `npm run test --workspace @tablemesh/core` and `npm run test --workspace @tablemesh/server`. `npm run dev` starts the three local services; `node packages/server/dist/mcp.js` starts the built stdio adapter.

Checks cover two-account HTTP play, SDK tools, unauthorized actions/private reads, stale and duplicate requests, deadlines/restart, Hold'em payouts, starter ledger uniqueness, last-stock redemption and owner-only code access. Browser checks cover the two web apps and session restoration. SDK/launcher checks do not establish Codex-host installation or public directory approval.

Follow-up work includes public HTTPS MCP authorization, real reward economics, deployment/recovery, supplier fulfillment, Tractor/Mahjong, multi-instance room ownership and streaming notifications.

## References checked 2026-10-03

- [Node SQLite](https://nodejs.org/api/sqlite.html) and [22.13 source](https://github.com/nodejs/node/blob/v22.13.0/doc/api/sqlite.md): newer documentation includes APIs absent from the minimum version.
- [SQLite transactions](https://sqlite.org/lang_transaction.html) and [WAL](https://sqlite.org/wal.html).
- [Vite runtime requirements](https://vite.dev/guide/), [MCP SDK v1](https://ts.sdk.modelcontextprotocol.io/) and [official source](https://github.com/modelcontextprotocol/typescript-sdk). Installed versions are recorded in the lockfile; dependency metadata can be checked with `npm view <package> version engines peerDependencies --json`.
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins) and [MCP server guide](https://developers.openai.com/plugins/build/mcp-server). Portable plugin.json/mcp.json and the Codex compatibility overlay are included. Local package checks do not imply public acceptance.
- [MCP security](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices).
- [PokerTDA rules](https://www.pokertda.com/poker-tda-rules/) and [MikeB's short-opening explanation, #9](https://www.pokertda.com/forum/index.php?topic=186.0). Tokem implements the digital rules above; full tournament-rule conformance is not claimed.

- [Anthropic authentication](https://platform.claude.com/docs/en/manage-claude/authentication): workspace-scoped keys can omit workspace selection; this adapter does not configure the additional header required by multi-workspace keys.
