# Tokem architecture

## v0

Tokem runs a multi-account Texas Hold'em service, a player web app, a separate rewards web app and MCP tools for user-operated Agents. People and agents use the same accounts, seat permissions, actions and deadlines. Registration and login create the identity; the plugin uses an issued game token. It makes no model calls and requires no OpenAI API key.

Joining a seat makes it ready. The owner can start with at least two funded seats. Practice chips belong to the table; platform points belong to the account ledger. Chips cannot buy points or be redeemed. v0 uses demo starter points and sandbox inventory, with real rewards disabled by default. A separate rewards website limits access to card secrets; it does not exempt the product from platform review. Public plugin submission, hosting and real reward economics are follow-up work.

## Runtime and packages

The repository uses npm workspaces, ESM, strict TypeScript and Node >=22.13. Dependencies are pinned in package-lock.json; CI runs Node 22/24. `node:sqlite` no longer needs a flag at 22.13, but was still experimental there. Code uses its baseline `DatabaseSync`, `prepare` and `exec` APIs. Database calls are synchronous, so transactions contain no network calls or `await`. The development API binds to loopback.

| Package | Responsibility | Runtime dependencies |
|---|---|---|
| packages/core | Serializable Hold'em reducer/evaluator and browser-safe DTOs | None |
| packages/server | Sessions, HTTP, room scheduler, SQLite, points, inventory, redemption and HTTP/stdio MCP adapters | core, Node builtins, MCP SDK, zod |
| packages/web | Login, lobby, account/points, table, reconnect and ended-hand replay | Browser API client; Vite build |
| packages/rewards-web | Catalog, redemption, owner code reveal and protected inventory UI | Browser API client; Vite build |
| plugins/tablemesh | Manifests, launcher and gameplay skill | Built server adapter |

Pinned versions include TypeScript 5.9.3, tsx 4.23.15, MCP SDK 1.32.0, zod 4.6.5 and Vite 8.3.2. Vite requires Node ^20.19.0 or >=22.12.0; SDK 1.32 supports Node >=18 and zod ^3.25 or ^4.0. Use the SDK v1 documentation for the selected package version. Tests use Node's built-in runner after TypeScript compilation.

Tokem is the display name. Package names `@tablemesh/*`, environment variables `TABLEMESH_*`, tool/plugin IDs, API paths and the repository URL retain their existing values for compatibility.

## Persistence and transactions

One Node server process owns each SQLite file. Both the stdio adapter and stateless HTTP MCP registry invoke the same authenticated game API on that process. It does not open the database or run a second engine. Startup sets `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL` and `busy_timeout=5000`. The timeout PRAGMA works on Node 22.13; the later `DatabaseSync` constructor timeout option is not used. Prepared statements and `BEGIN IMMEDIATE` handle writes. SQLite allows one writer; WAL does not remove that limit. Multi-instance room ownership and fencing are not implemented.

The current schema contains:

- `accounts` and `sessions`: normalized unique names, password hashes, hashed web/game tokens, expiry and revocation.
- `rooms`: engine JSON, state version and event cursor. `room_events` stores public payloads; private cards and remaining deck stay in the engine snapshot for recovery.
- `requests`: unique account/operation/resource/request ID, body hash and accepted-result metadata. A repeated ID with a different body conflicts.
- `wallets` and `ledger`: nonnegative available/held balances and unique ledger source keys. Wallet changes and entries share a transaction. The starter grant uses `starter:<account>:v0`; v0 has no game point grants.
- `products`, `inventory` and `redemptions`: price and sandbox flag, encrypted codes with unique keyed fingerprints, one code assignment per redemption, and unique account/request IDs. `admin_audit` records operations without code plaintext.
- `fair_play` and `room_abandons`: reputation, cooldown and one abandonment record per account/room/hand.
- `hand_replays`, `hand_replay_players`, `hand_replay_frames`: completed-hand metadata, original account-bound dealt cards and public post-reduction frames. Completion allocates the immutable listing sequence.
- `hand_settlements`: one result and original account/seat/name snapshot per room/hand. Its public `hand_settled` event and published marker commit with room state.

Room commands run in a per-room queue. Accepted duplicates replay first. For a new command, the server captures time and commits any due timeout separately, then checks the command's version, seat and window in its own transaction. A valid reducer result, room snapshot, public events and request metadata commit together; responses follow commit. Persisted deadlines restore on restart. At the deadline, timeout wins and a command carrying the previous version conflicts. Confirmed abandonment before the deadline uses the captured time to fold in the current or next legal window; all-in rights remain until settlement. Disconnects do not incur a penalty.

The service saves each new transition settlement before abandoned participants are removed. Seat changes clear stale current-hand display fields, while the persisted event retains the original account identities and awards. GET snapshots project the requesting viewer's cards and legal actions; the full engine JSON stays inside the service.

Redemption checks retry history, product mode, balance and available inventory in one transaction. It assigns one code, records a points reserve and capture, and marks the order fulfilled. Failure rolls back the transaction. A retry returns the same order; two accounts competing for the last code yield one fulfillment and one OUT_OF_STOCK, without debiting the loser. Future external fulfillment will need pending holds, an outbox, idempotent delivery and release on definitive failure before supplier calls are added.

## Ended-hand replay

`replay.ts` captures new hands inside the existing command transaction. Original dealt-in accounts, names, pre-blind stacks, room label and config are frozen at start. Each successful core reduction records its real public state; timeout and abandonment folds have distinct sources. Confirmed abandonment also records a marker before automatic fold. Completion records the original final stacks and settlement before abandoned seats are removed. A request retry adds no frame, and a rejected action contributes none. An independently committed due timeout can still add its genuine frame before the stale action is rejected.

A replay step is one atomic reducer result. If an all-in action runs multiple streets and settles, its final public snapshot and ordered public street transitions stay together; the UI labels automatic runout rather than inventing intermediate states. Private dealt cards live in separate account-bound rows. A response includes only the caller's cards; each frame retains its own original public revealedHands. Historical action windows are cleared. Replay reads neither move the live room nor affect points or reputation.

Only ended hands are listed or read, and authorization uses the original account rather than current occupancy. Frame and list pagination are bounded. Additive startup tables/backfill preserve existing settlements as summary_only: old public events omit enough action and table data that a full trajectory, original private cards and chip net cannot be recovered. Such results have no frames, private cards or claimed net change. A pre-feature active hand also becomes summary-only upon finishing; a newly captured active hand continues its trace across restart. Completed sequence is allocated at settlement, so a long hand that finishes later sorts ahead of a later-started short hand.

## User Agent connection

The user runs the Agent and its model. Tokem provides an authenticated `/mcp` Streamable HTTP endpoint, with local stdio as an alternative; no model provider configuration or server-side decision loop is involved. `mcp-tools.ts` owns one registry for both transports. The HTTP adapter creates a server/transport per POST and uses a fixed self-HTTP target to reuse the game dispatcher; it does not duplicate reducers or ledger operations. Current game tokens resolve one account, so manual and Agent clients share its seat. Competing actions are serialized and stale versions rejected.

The eleventh tool, `tablemesh_wait_for_turn`, returns a fresh viewer snapshot on the viewer's turn, hand completion, state change or a bounded timeout. At most two waits per account and 100 process-wide wait outside room queues/transactions, for at most 25 seconds. Cancellation and stopping an Agent do not leave the table; normal deadline check/fold continues. Connection metadata gives the web UI a trusted `/mcp` address without token material. A local address is only reachable from the Agent's execution machine; deployment is separate.

## Hold'em rules

Core takes a complete unique 52-card deck and time as inputs. The server shuffles with Fisher–Yates and `crypto.randomInt`. Reducers leave their input unchanged and return JSON-serializable state. Function and DTO signatures are in ENGINE-CONTRACT.ts.

- 2–6 occupied seats; positive blinds with SB <= BB; integer chips. Heads-up button posts SB and acts first preflop, last postflop. Multiway action starts left of BB preflop and left of button postflop. The button rotates among funded seats. Deal two hole cards and burn before flop, turn and river.
- `raise.amount` is the total street contribution. `toCall = max(0, currentBet - streetBet)`; a call deducts at most the remaining stack. Minimum full raise is `currentBet + lastFullRaiseIncrement`, initially BB. A below-minimum raise is allowed only for an exact all-in. Raising requires another active opponent.
- A short all-in increases the amount owed without alone reopening a previously acting player. Track the bet and full increment at that player's last action; cumulative short raises can reopen betting. Postflop short opening 5 with BB 10 requires an unacted player to raise to at least 15. After that raise the next minimum is 25, because the raise increment was 10. Completing to 10 is a limit rule; a prior check is not reopened by the short 5 alone.
- A street finishes after all active responders have acted and matched the current bet. With no further betting possible, run out the board. One surviving player wins immediately without a public hole-card reveal.
- Side pots follow contribution thresholds. Folded contributions count toward amounts, but folded players are ineligible. Refund unmatched top contributions. Evaluate each contested pot separately, split integer shares and award odd chips clockwise from left of the button among tied winners. Suits do not break ties.
- Evaluate the best five of seven by category and kickers, including the A2345 wheel. Showdown reveals nonfolded contenders; folded cards remain private. Validate deck uniqueness.
- During a hand, `sum(stacks) + sum(contributions)` is constant. Settlement awards plus refunds equal contributions. After payout contributions clear, stacks remain nonnegative and starting the next hand does not pay the previous one again.

## Other games

Only Hold'em is implemented. `RuleSet` reserves separate public/private views, optional team IDs and single/parallel response windows for future games. Tractor teams and Mahjong claim priority need their own reducers and tests. Parallel response windows collect intents against a common baseline and resolve serially; they do not permit concurrent mutation of state. Game-specific views and actions can extend the discriminated union when those engines exist.

## Commands and verification

Use `npm ci`, `npm run check`, `npm run plugin:check` and `npm run test:e2e`. Scoped rule/service tests are `npm run test --workspace @tablemesh/core` and `npm run test --workspace @tablemesh/server`. `npm run dev` starts the three local services; `node packages/server/dist/mcp.js` starts the built stdio adapter.

Checks cover two-account HTTP play, SDK tools, unauthorized actions/private reads, stale and duplicate requests, deadlines/restart, Hold'em payouts, starter ledger uniqueness, last-stock redemption and owner-only code access. Browser checks cover the two web apps and session restoration. SDK/launcher checks do not establish Codex-host installation or public directory approval. A separate Codex CLI 0.158.0 app-server check used an ephemeral thread and runtime MCP configuration to list all thirteen tools and call account/observation/wait/action plus original-account replay list/detail through the actual HTTP host. It made no model turn and does not establish autonomous strategy, plugin installation or continuous background execution.

Follow-up work includes public HTTPS deployment and MCP OAuth authorization, real reward economics, deployment/recovery, supplier fulfillment, Tractor/Mahjong, multi-instance room ownership and streaming notifications.

## References checked 2026-10-03

- [Node SQLite](https://nodejs.org/api/sqlite.html) and [22.13 source](https://github.com/nodejs/node/blob/v22.13.0/doc/api/sqlite.md): newer documentation includes APIs absent from the minimum version.
- [SQLite transactions](https://sqlite.org/lang_transaction.html) and [WAL](https://sqlite.org/wal.html).
- [Vite runtime requirements](https://vite.dev/guide/), [MCP SDK v1](https://ts.sdk.modelcontextprotocol.io/) and [official source](https://github.com/modelcontextprotocol/typescript-sdk). Installed versions are recorded in the lockfile; dependency metadata can be checked with `npm view <package> version engines peerDependencies --json`.
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins) and [MCP server guide](https://developers.openai.com/plugins/build/mcp-server). Portable plugin.json/mcp.json and the Codex compatibility overlay are included. Local package checks do not imply public acceptance.
- [MCP security](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices).
- [PokerTDA rules](https://www.pokertda.com/poker-tda-rules/) and [MikeB's short-opening explanation, #9](https://www.pokertda.com/forum/index.php?topic=186.0). Tokem implements the digital rules above; full tournament-rule conformance is not claimed.

The optional real-host check is `node scripts/check-codex-host.mjs` after building. It requires an existing Codex CLI (verified 0.158.0), uses runtime overrides and an ephemeral thread, and never starts a model turn or installs/configures the client. Evidence defaults to a temporary directory; TABLEMESH_HOST_CHECK_EVIDENCE_DIR can select a task directory. A missing CLI or unsupported host method is a failed check, not an installation request.
