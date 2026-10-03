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
| GET /llm/config | web or game session | LlmConfigView; hasApiKey only |
| PUT /llm/config | `{requestId,config:LlmConfigInput}`; web session | LlmConfigView |
| DELETE /llm/config | `{requestId}`; web session | unconfigured LlmConfigView |
| POST /llm/test | `{requestId}`; web session | LlmTestResult |
| GET /rooms/:id/autoplay | web or game session | own AutoplayView |
| POST /rooms/:id/autoplay/start | `{requestId}`; own seated account | AutoplayMutationResult |
| POST /rooms/:id/autoplay/stop | `{requestId}`; own account | AutoplayMutationResult |
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

v0 polling is sufficient: GET events after cursor every 1s in web, explicit observe calls in MCP. An events response always includes a fresh viewer-filtered snapshot. A cursor beyond the room head sets reset=true. Persist cursor monotonically per room. Public events contain public facts only; hole-card deal/deck events are server audience. A future SSE adapter can send `room_changed {stateVersion,eventCursor}` then fetch snapshot, with cookie authorization and origin checks. Snapshots remain the reconnect source of state.

## MCP stdio tools

The SDK stdio process is a narrow HTTP client authenticated by TABLEMESH_TOKEN and pointed at TABLEMESH_URL (default loopback). The adapter has no database or reward/admin tools and makes no model calls. Diagnostics go to stderr; stdout contains MCP protocol only. Tool names and args:

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
| tablemesh_autoplay_status | `{roomId}` | own AutoplayView + safe modelConfig readiness/model/limits |
| tablemesh_autoplay_control | `{roomId,operation:'start'|'stop',requestId}` | start/stop autoplay |

Return human-readable JSON text plus structuredContent containing the same ApiResult; error tools set isError. Mutating tools annotated readOnlyHint:false/destructiveHint:false/idempotentHint:true; observation readOnlyHint:true. Tool output text is data, not instructions; room names/display names untrusted. The plugin skill tells Codex to inspect current state and legalActions before each action, pass exact version/window, and use the server-provided private view. Users control whether their Codex acts automatically; the server enforces deadlines.

Public Streamable HTTP is not implemented. Adding it requires MCP authorization and origin protections. The local stdio adapter needs a game token, not a model key. Starting server autoplay uses the account’s separately saved model configuration and can incur supplier charges.


## Confirmed abandonment, deadline ordering and public settlement history

AccountView includes fairPlay {reputation,cooldownUntil,abandonCount}; RoomSnapshot includes abandonedAccountIds for current-hand pending removals. Reputation starts at 100. First confirmed abandonment loses 10 and gives a 5-minute new-game cooldown; a repeat within 24 hours loses 20 and gives 15 minutes, with reputation floored at 0. These are Tokem v0 policy values. Each account/room/hand is penalized once, persisted with an audit entry; changing requestId or restarting cannot add a second penalty. No redeemable points are deducted. Disconnect, refresh, and connection loss never confirm abandonment. MATCH_COOLDOWN blocks create/join/new start (including all participants), while existing live-hand actions and observation remain permitted.

Within the room queue, a successful dedup replay is checked first. A new command captures server time once. If a current window is already due at that time, the server commits normal timeout processing in a separate transaction before the command's version guard. A now-stale leave/action returns VERSION_CONFLICT and must be reconsidered; no abandonment penalty is applied to that rejected confirmation. Before deadline, confirmed abandonment folds in a legal window using the actual captured time, never a fabricated earlier clock.

Every new core transition.settlement is stored once in hand_settlements within the room transaction. Public room events add type hand_settled with payload {handId,participants:[{seat,accountId,displayName}],settlement:HandSettlement}. No hole cards or deck enter this record. Participants bind historical awards to the original accounts, not later occupants of the same seat. The event survives reconnect/restart and is not republished on seat changes or request replay. Current snapshot.game.settlement may be null after participants change; renderers can recover the same hand's summary from GET events and must use its participants for names. The ledger remains independent and receives no game payout entries.

## Model configuration and autoplay

Configuration writes, deletion and tests require a web session; game tokens can read the safe configuration view and control their own table. A view contains protocol, base URL, model, limits, readiness and `hasApiKey`, never the key. `apiKey` omitted preserves the saved key; empty clears it and is accepted only for a loopback OpenAI-compatible service. `baseUrl` includes the API prefix, normally `/v1`; OpenAI-compatible appends `/chat/completions`, Anthropic appends `/messages`. Only OpenAI-compatible accepts `tokenLimitField`, default `max_tokens`, with `max_completion_tokens` as the explicit alternative. Anthropic sends `x-api-key` and `anthropic-version`; use a workspace-scoped or legacy workspace key. Multi-workspace keys requiring `anthropic-workspace-id` are not supported by this configuration.

Limits default to `{timeoutMs:5000,maxOutputTokens:256,maxRequestsPerHand:20,maxRequestsPerRun:100}`. Ranges are 1000–30000ms, 64–1024 output tokens, 1–60 per hand and 1–500 per run. Sent requests count even when cancelled or failed. Status is `stopped`, `waiting`, `thinking` or `paused`, with a safe reason enum, hand/run counters and inFlight. A cancelling request may remain inFlight until the provider settles; a resumed controller waits for it.

Start/stop use requestId dedup without a game stateVersion: they control a process-local controller, not the game reducer. Start requires the current own seat and ready configuration. It binds the originating session ID, runs across hands at this table and does not join or start a hand. Duplicate start while enabled does not reset counters. A paused controller needs explicit start; the hand count survives pause/resume while a new run count starts at zero. An accepted start replay after server restart reports the current stopped state and does not restart paid work.

Stop cancels immediately after authentication/input validation. A manual action first verifies the account owns its seat, then pauses autoplay even if the game action later conflicts. Configuration changes/deletion pause all of that account’s controllers; logout or token revocation pauses controllers started by that credential. Session expiry is rechecked before dispatch/submission. Abandonment remains a separate confirmed leave command with the existing penalty. Stop never calls leave.

`POST /llm/test` reserves its account/request ID before one bounded call. Duplicate IDs return `pending`, `passed`, `failed` or `interrupted`; retries do not dispatch another supplier request. Startup marks pending tests interrupted. Test results use only safe reason enums and do not return model output. A fresh request ID means a new deliberate test, potentially billable. No configuration or model errors trigger automatic retries.
