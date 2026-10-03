# Tokem security

## Accounts and sessions

v0 uses local registration and login. Account names are normalized and unique; passwords are checked for length before asynchronous `node:crypto` scrypt hashing with a random 16-byte salt. Login is rate-limited. Password comparison uses equal-length derived keys and `timingSafeEqual`. Session and game-token secrets are random 32-byte values; SQLite stores their SHA-256 hashes, expiry and revocation state. Credentials belong in local configuration, not repository files, screenshots or test output.

Web clients use an HttpOnly cookie; MCP uses a separately issued game bearer token. Invalid supplied bearer credentials are rejected rather than falling back to a cookie. Server identity and seat membership come from those credentials, not request-body account IDs. Game tokens cannot access reward or auth-management routes. Operations use a separate configured admin bearer; normal login does not issue it.

The API binds to loopback by default. Both Vite apps proxy `/api` and use the same hostname with `credentials:include`. Refresh restores the cookie session through GET /account; an expired session returns to sign-in. Reconnect keeps the existing seat, cards and deadline. Cookie attributes are HttpOnly, SameSite=Strict and Path=/, with Secure for HTTPS. Cookie mutations require an exact allowed Origin; requests without Origin require bearer authentication. Live hosting needs HTTPS and deployment-specific credential controls.

The stdio adapter reads `TABLEMESH_TOKEN` and `TABLEMESH_URL` from its environment. It accepts loopback HTTP or HTTPS, rejects URL credentials/query/hash and redirects, and limits HTTP request time. Stdout carries MCP protocol, with diagnostics on stderr. Transport/session IDs do not grant account authority. `/mcp` uses stateless Streamable HTTP and accepts game bearer credentials only; cookie-only access is rejected. The outer request validates Host and any supplied Origin, then each tool uses a fixed internal listener URL to pass the same bearer through the authoritative API. The target cannot be chosen by tool arguments; redirects are rejected. Initialization does not cache account authority, and expiry/revocation is checked again on calls and throughout waits. HTTP request bodies are bounded to 64 KiB. Public HTTPS deployment and OAuth discovery/login are not implemented.

The read-only wait tool has a 25-second maximum, two concurrent waits per account and 100 per process. Waiting holds no room queue/SQLite transaction, so other players and deadline processing continue. Cancel/disconnect releases wait resources without an abandonment mutation. HTTP cancellation correlates only active waits using account, credential ID and typed JSON-RPC request ID; another credential cannot cancel them, and an active ID cannot overwrite its existing entry. The map is cleared on completion/disconnect/shutdown. It cannot cancel accepted actions or change seat authority; separate clients should mint separate game tokens. The response always uses the same viewer projection as ordinary observation. Agents compute strategy on their own clients; Tokem receives no model credentials.

Connection metadata uses explicit TABLEMESH_MCP_PUBLIC_URL or an actual loopback listener address, not untrusted forwarding or browser headers. It returns no token. UI templates contain environment-variable references or placeholders; the real token is only exposed once by the existing mint route. A loopback URL is only usable from the client's own execution machine. Public exposure still requires deployment-specific HTTPS and credential controls; static-token manual setup is not an OAuth implementation.

## Cards, seats and history

The service builds RoomSnapshot from public game state and the authenticated account's own-seat view. It does not serialize the internal engine record. Spectators receive `privateState:null` and no legal actions. Folded cards remain private after a hand. Seat changes bind retained cards to the same account and clear cards for removed accounts; a replacement occupant does not inherit the previous player's hand.

The server accepts actions only for the account's current seat and window. Action bodies with supplied seat/account fields are rejected. Starting a hand is owner-only. People and agents have the same gameplay permissions. Two clients sharing an account share its authority, but the room version prevents both from applying competing moves.

Public events exclude deck and private cards. `hand_settled` stores the original account/seat/name mapping and amounts; current occupants do not replace those historical identities. Room snapshots, session responses and code reveals use Cache-Control:no-store. Logs and audits omit private cards, passwords, bearer material and code plaintext.

## State and deadlines

The server shuffles with Fisher–Yates and `crypto.randomInt`; client requests cannot supply decks. Core fixtures can inject deterministic decks for tests. The engine validates 52 distinct cards and persists the deck/hand for crash recovery. Database and backup access therefore includes access to private game state. Server-operator-blind dealing and fairness certification are not provided; commit/reveal would need a separate design.

Successful request dedup precedes version checks. A matching request ID/body replays acceptance; the same ID with a changed body conflicts. Room mutations and timer work share the room queue. Due windows commit before a new command's version guard, including exact deadline equality. Deadlines and window IDs are persisted so restart recovery cannot act on a later player's window. Chip and point amounts are safe integers; balance checks, chip conservation and unique settlement records protect state during retries. Persistence failures roll back the affected transaction and return a generic error.

Active-hand accounts and slots stay fixed until settlement. Confirmed abandonment folds a non-all-in participant in the current or next legal window; all-in contributions and payout rights remain. One account/room/hand incurs one persisted penalty: first abandonment is reputation −10 and a 5-minute cooldown; another within 24 hours is −20 and 15 minutes, with reputation floored at 0. Cooldown blocks new tables, joins and new hands, but permits existing-hand actions and observation. Disconnect, refresh and normal timeout do not confirm abandonment or penalize points. If timeout changes the version before a confirmation is accepted, the rejected confirmation incurs no penalty.

## Points and reward codes

Practice chips do not change the platform wallet. v0 has no paid buy-in, recharge, cash withdrawal or win-based point grant. Starter points and inventory are labeled sandbox. Real rewards are disabled by default; configuration alone does not resolve their economic, supplier or policy requirements.

Inventory codes are encrypted with AES-256-GCM, a fresh nonce and authentication tag per item, an external key and a key-version field. A keyed HMAC fingerprint detects duplicates without storing a plain code hash. Without the configured key, import and secret retrieval are disabled; there is no plaintext fallback. Keys stay out of SQLite, source and frontend VITE_ variables. Test keys are ephemeral. Backup recovery and key rotation require retaining and testing the correct key; production rotation is not implemented.

Code reveal requires the order owner's web session. Product/order lists and MCP outputs omit codes. The ops UI keeps its supplied admin token in memory and sends it only to ops endpoints. Import and reveal audits record counts/targets, not codes. Unconfigured admin endpoints reject requests.

Redemption assigns stock and records reserve/capture entries in one BEGIN IMMEDIATE transaction. Conditional stock assignment and unique request IDs prevent a second sale or debit. Insufficient balance and out-of-stock failures leave wallet and inventory unchanged. A supplier integration will need durable pending holds, idempotent delivery and release-on-failure handling before external calls are added.

## Verification cases

1. Outsiders receive no private cards/deck; a seated account sees its own cards. Folded cards stay out of public completion events, and slot replacement exposes none of the former occupant's cards.
2. Cross-account actions, duplicate seating, outsider start, game-token reward reads and unauthorized ops requests fail without mutation.
3. Duplicate accepted actions apply once; changed payloads conflict; simultaneous current-version moves accept one. Test deadline −1, equality and +1, plus accepted replay after expiry.
4. Restart preserves sessions, cards, stacks, cursors and deadlines. Due timeout runs once; expired/revoked credentials fail.
5. Starter grants and redemption ledger entries are unique. Final-stock races fulfill one order; a losing or unaffordable request does not debit or consume stock.
6. Owner-only code reveal, missing-key behavior, encrypted storage and secret-free list/tool/log output are checked.
7. Two separate browser accounts play against the service. Refresh restores the session, and a stale action requires a fresh decision.
8. HTTP/stdio share the same tools and seat authority. Cookie-only MCP, invalid Origin/Host, revoked tokens and forged action identity are rejected. Bounded waits cancel without mutation and cannot block deadline processing.
9. Abandonment confirmation, one-time persistent punishment, cooldown, passive network recovery and all-in rights are checked independently of normal timeouts.

## References

[MCP security](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), [official SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Node crypto](https://nodejs.org/api/crypto.html), [SQLite transactions](https://sqlite.org/lang_transaction.html) and [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) inform the implementation. Tokem's reputation numbers, deadlines and free-practice reward boundaries are application choices.
