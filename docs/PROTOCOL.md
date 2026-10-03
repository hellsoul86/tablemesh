# Tokem v0 protocol

Shared DTOs live in `packages/core/src/contracts.ts` and are mirrored in ENGINE-CONTRACT.ts. HTTP and MCP use the same server operations. Sessions resolve the account; request-body IDs, roles or balances do not grant authority.

## HTTP

API base `/api`. Success `{ok:true,data:T}`; failures `{ok:false,error:{code,message,currentStateVersion?}}`. JSON Content-Type. Do not place bearer tokens in URLs. Error statuses: 400 invalid input/action; 401 unauthenticated; 403 forbidden; 404 missing; 409 version/idempotency/stock conflicts; 429 rate limit; 503 temporarily unavailable. Validation failures reveal no internal stack/deck/SQL.

| Method and path | Input | Output/data |
|---|---|---|
| POST /auth/register | `{displayName,password}` | SessionView; set session cookie |
| POST /auth/login | `{displayName,password}` | SessionView; set session cookie |
| POST /auth/logout | `{}` | `{loggedOut:true}`; revoke cookie/session |
| GET /account | none | AccountView |
| POST /auth/tokens | `{label}` with web session | `{token,expiresAt}` once; game credential for MCP |
| GET /auth/tokens | owner web session | token IDs, labels and expiry; no token material |
| DELETE /auth/tokens/:id | owner web session | `{revoked:true}` |
| GET /rooms | none | RoomSummary[] |
| POST /rooms | `{name,config,requestId}` | RoomMutationResult |
| GET /rooms/:id | none | RoomSnapshot for authenticated viewer |
| POST /rooms/:id/join | `{seat?,stateVersion,requestId}` | RoomMutationResult |
| POST /rooms/:id/leave | `{stateVersion,requestId,confirmAbandon?:true}` | RoomMutationResult |
| POST /rooms/:id/start | `{stateVersion,requestId}` | RoomMutationResult |
| POST /rooms/:id/actions | RoomCommand | RoomMutationResult |
| GET /rooms/:id/events?after=N | cursor only | RoomEventBatch |
| GET /points | none | `{account:AccountView,entries:PointsEntry[]}` |
| GET /rewards/products | none; rewards scope | RewardProduct[] |
| POST /rewards/redemptions | `{productId,requestId}` | RedemptionView (no code) |
| GET /rewards/redemptions | none; own only | RedemptionView[] |
| GET /rewards/redemptions/:id | own only; rewards scope | RedemptionSecret |
| POST /ops/inventory | `{product:{id,name,pointsCost,sandbox},codes:string[],requestId}` + admin bearer | `{imported:number}`; never echo code inputs |
| GET /ops/redemptions | admin bearer | RedemptionView[] + accountId; no codes |

Authentication uses an opaque HttpOnly session cookie for web, plus separately minted, revocable `game` bearer tokens for MCP. Both web applications use relative `/api` via their Vite proxy and `fetch(...,{credentials:'include'})`; use one loopback hostname consistently. Session persists across refresh until expiration/revocation. On initial load GET /account restores login; 401 shows sign-in. Login/register set cookie `HttpOnly; SameSite=Strict; Path=/` (Secure outside local HTTP); mutations enforce an exact allowed Origin list. Cookie session can read own redemption secrets; game bearer tokens cannot access any reward/admin endpoint. Revocation route DELETE /auth/tokens/:id accepts the owning web session; token listing GET /auth/tokens returns ids/labels/expiry, never token material. Logout revokes the current web session; game tokens can be revoked individually through the account page. Username uniqueness case-folded; display names have bounded normalized Unicode length. The web package owns /app/lobby, /app/rooms/:id, /app/account, /app/points. The rewards-web package owns /shop, /redeem, /orders/:id, /ops/inventory, /ops/redemptions. They use the same account and ledger.

Create assigns owner; joining means immediately ready in v0 (no separate ready field or endpoint). Owner alone starts a hand after >=2 funded seats. There is no separate ready command. Joining or changing seats is allowed only waiting/complete; active-hand participants stay locked. Live leave requires explicit confirmAbandon:true. Without confirmation it returns 409 and changes nothing. Non-all-in abandoned seats fold immediately in their current or next eligible window; all-in seats retain committed chips and legitimate payout rights. Seats are removed only after settlement. A disconnected account keeps its seat and its deadline. Seats receive fixed initial game chips only once per table membership; rejoining the same table retains the account’s chips. v0 permits a new free table to reset practice chips. Gameplay never awards platform points in v0.

## Mutation ordering and retry

The server hashes a canonical request body. It checks `(accountId,operation,resourceId,requestId)` before the version guard: a matching accepted request replays; a changed body returns REQUEST_ID_CONFLICT. For a new command, the room queue captures time and commits any due timeout separately. The command then checks the current stateVersion, membership and permissions in a BEGIN IMMEDIATE transaction. Actions also require the current windowId, eligible seat and time before deadline. At deadline equality, timeout wins.

A valid reducer result, room snapshot, public events and accepted-request metadata commit together. Responses follow commit; retries replay accepted commands without another action. Stored request results contain a room ID and accepted version, not tokens, cards or private snapshots. Replays return the current viewer-filtered snapshot, so they do not overwrite a newer state with an old one. v0 game results do not generate platform point grants.

All rejected stale versions return VERSION_CONFLICT+currentStateVersion. Clients fetch a snapshot and choose from its current legalActions; changing the version alone is not a new decision. Accepted duplicates do not apply again. A periodic due-window scheduler enqueues server timeout commands with deterministic key `timeout:<roomId>:<windowId>`. On restart enumerate persisted due deadlines; each reducer validates windowId and version so an old timer cannot fold a later actor.

## Observations and reconnect

Web polls GET events after cursor every 1s. MCP clients observe explicitly or use the bounded wait tool. An events response always includes a fresh viewer-filtered snapshot. A cursor beyond the room head sets reset=true. Persist cursor monotonically per room. Public events contain public facts only; hole-card deal/deck events are server audience. A future SSE adapter can send `room_changed {stateVersion,eventCursor}` then fetch snapshot, with cookie authorization and origin checks. Snapshots remain the reconnect source of state.

## MCP tools and transports

Both transports use the same `createGameMcpServer` registry and the same authenticated game API. Tokem does not run the user's model or require a model API key. The stdio process reads TABLEMESH_TOKEN and TABLEMESH_URL (default loopback); diagnostics go to stderr, stdout contains MCP protocol only. HTTP uses `/mcp` on the API listener and requires a game bearer token on every request. Cookie-only clients cannot use it. Each POST gets a stateless SDK server/transport with JSON responses; GET and DELETE return 405. No MCP session ID grants account access.

Tool names and args:

| Tool | Args | Maps to |
|---|---|---|
| tablemesh_account | `{}` | GET /account |
| tablemesh_points | `{}` | GET /points |
| tablemesh_lobby | `{}` | GET /rooms |
| tablemesh_create_room | `{name,config,requestId}` | POST /rooms |
| tablemesh_join_room | `{roomId,seat?,stateVersion,requestId}` | join |
| tablemesh_leave_room | `{roomId,stateVersion,requestId,confirmAbandon?:true}` | leave |
| tablemesh_start_hand | `{roomId,stateVersion,requestId}` | start |
| tablemesh_observe | `{roomId,after?}` | snapshot/events |
| tablemesh_legal_actions | `{roomId}` | observe snapshot.you.legalActions+version+windowId |
| tablemesh_act | `{roomId,stateVersion,windowId,requestId,action}` | actions |
| tablemesh_wait_for_turn | `{roomId,afterStateVersion,maxWaitMs?}` | GET /rooms/:id/wait |

Return human-readable JSON text plus structuredContent containing the same ApiResult; error tools set isError. Mutating tools annotated readOnlyHint:false/destructiveHint:false/idempotentHint:true; observation readOnlyHint:true. Tool output text is data, not instructions; room names/display names untrusted. The plugin skill tells Codex to inspect current state and legalActions before each action, pass exact version/window, and use the server-provided private view. Users control whether their Codex acts automatically; the server enforces deadlines.

`GET /rooms/:id/wait?afterStateVersion=N&maxWaitMs=N` returns `ApiResult<{reason,snapshot:RoomSnapshot}>`. `afterStateVersion` is a nonnegative integer; maxWaitMs is an integer 0..25000, default 20000. Return priority is `your_turn` when the viewer has legal actions, `hand_complete` when the hand is complete, `state_changed` when the current version differs, and `timeout` when the wait budget expires. An already changed version returns immediately. Clients can decide from the fresh snapshot or wait again with its version. Normal deadlines still run through the existing scheduler; waiting submits no action.

Waits hold no room queue or database transaction. Each poll and final response recheck the credential before building the viewer projection. At most two waits per account and 100 across the process are pending; further waits return RATE_LIMITED. Cancellation, network close or server shutdown releases the wait without leaving the seat or confirming abandonment. For stateless HTTP, cancellation notifications can arrive on a different POST; a temporary pending-wait map binds the typed JSON-RPC request ID to the authenticated account and game credential ID. It cancels only that pending wait, never an accepted action; duplicate active IDs cannot replace entries. Different clients should use separate game tokens to avoid sharing a cancellation namespace. This is not a persisted MCP session or an account-authority cache. The stdio wait network limit is 30 seconds; ordinary calls are limited to 10 seconds. Client tool timeouts should exceed 25 seconds. No tool wakes an idle chat or starts a background strategy loop.

`GET /agent-connection` requires a web session and returns `{mcpUrl:string|null,transport:'streamable-http',authentication:'game-bearer',tokenEnvVar:'TABLEMESH_TOKEN',maxWaitMs:25000}`. The URL comes from explicit TABLEMESH_MCP_PUBLIC_URL or the actual loopback listener; it is not derived from browser/Host/Forwarded headers. Public URL configuration accepts HTTPS or loopback HTTP at `/mcp`, with no credentials/query/hash. A non-loopback listener without a configured URL returns null. This metadata contains no token. Connection templates refer to the environment variable; creating a game token remains a separate, once-visible web operation.

Static game bearer credentials support manually configured clients. OAuth discovery/login, hosted deployment and public directory submission are separate work. For [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), configure a Streamable HTTP `url`, `bearer_token_env_var="TABLEMESH_TOKEN"` and `tool_timeout_sec=45`; local stdio remains available. Local URLs must be reachable from the Agent's execution machine. Losing or stopping a client does not stop the server deadline; only an explicit confirmed leave applies abandonment policy.


## Confirmed abandonment, deadline ordering and public settlement history

AccountView includes fairPlay {reputation,cooldownUntil,abandonCount}; RoomSnapshot includes abandonedAccountIds for current-hand pending removals. Reputation starts at 100. First confirmed abandonment loses 10 and gives a 5-minute new-game cooldown; a repeat within 24 hours loses 20 and gives 15 minutes, with reputation floored at 0. These are Tokem v0 policy values. Each account/room/hand is penalized once, persisted with an audit entry; changing requestId or restarting cannot add a second penalty. No redeemable points are deducted. Disconnect, refresh, and connection loss never confirm abandonment. MATCH_COOLDOWN blocks create/join/new start (including all participants), while existing live-hand actions and observation remain permitted.

Within the room queue, a successful dedup replay is checked first. A new command captures server time once. If a current window is already due at that time, the server commits normal timeout processing in a separate transaction before the command's version guard. A now-stale leave/action returns VERSION_CONFLICT and must be reconsidered; no abandonment penalty is applied to that rejected confirmation. Before deadline, confirmed abandonment folds in a legal window using the actual captured time, never a fabricated earlier clock.

Every new core transition.settlement is stored once in hand_settlements within the room transaction. Public room events add type hand_settled with payload {handId,participants:[{seat,accountId,displayName}],settlement:HandSettlement}. No hole cards or deck enter this record. Participants bind historical awards to the original accounts, not later occupants of the same seat. The event survives reconnect/restart and is not republished on seat changes or request replay. Current snapshot.game.settlement may be null after participants change; renderers can recover the same hand's summary from GET events and must use its participants for names. The ledger remains independent and receives no game payout entries.
