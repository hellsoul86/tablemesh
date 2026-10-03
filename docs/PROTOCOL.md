# TableMesh protocol v0 (frozen draft)

The shared wire DTOs are `packages/core/src/contracts.ts`, sourced from ENGINE-CONTRACT.ts. HTTP JSON and MCP tools call one authenticated ApplicationService. The requesting account is resolved exclusively from the session; neither seat, accountId, admin role nor reward balance is accepted as authority from request bodies.

## HTTP

API base `/api`. Success `{ok:true,data:T}`; failures `{ok:false,error:{code,message,currentStateVersion?}}`. JSON Content-Type. Do not place bearer tokens in URLs. Error statuses: 400 invalid input/action; 401 unauthenticated; 403 forbidden; 404 missing; 409 version/idempotency/stock conflicts; 429 rate limit; 503 temporarily unavailable. Validation failures reveal no internal stack/deck/SQL.

| Method and path | Input | Output/data |
|---|---|---|
| POST /auth/register | `{displayName,password}` | SessionView; set session cookie |
| POST /auth/login | `{displayName,password}` | SessionView; set session cookie |
| POST /auth/logout | `{}` | `{loggedOut:true}`; revoke cookie/session |
| GET /account | none | AccountView |
| POST /auth/tokens | `{label}` with web session | `{token,expiresAt}` once; scoped `game` credential for local MCP adapter |
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

Authentication is fixed for v0: opaque HttpOnly session cookie for web, plus separately minted, revocable `game` bearer tokens for MCP. Both web applications use relative `/api` via their Vite proxy and `fetch(...,{credentials:'include'})`; use one loopback hostname consistently. Session persists across refresh until expiration/revocation. On initial load GET /account restores login; 401 shows sign-in. Login/register set cookie `HttpOnly; SameSite=Strict; Path=/` (Secure outside local HTTP); mutations enforce an exact allowed Origin list. Cookie session can read own redemption secrets; game bearer tokens cannot access any reward/admin endpoint. Revocation route DELETE /auth/tokens/:id accepts the owning web session; token listing GET /auth/tokens returns ids/labels/expiry, never token material. Logout revokes the current web session; explicitly revoking all game tokens is a separate account action. Username uniqueness case-folded; display names have bounded normalized Unicode length. The web package owns /app/lobby, /app/rooms/:id, /app/account, /app/points. The rewards-web package owns /shop, /redeem, /orders/:id, /ops/inventory, /ops/redemptions. They use the same account and ledger.

Create assigns owner; joining means immediately ready in v0 (no separate ready field or endpoint). Owner alone starts a hand after >=2 funded seats. The UI states this explicitly and offers no fake ready control. Joining or changing seats is allowed only waiting/complete; active-hand participants stay locked. Live leave requires explicit confirmAbandon:true. Without confirmation it returns409 and changes nothing. Non-all-in abandoned seats fold immediately in their current or next eligible window; all-in seats retain committed chips and legitimate payout rights. Seats are removed only after settlement. A disconnected account keeps its seat and its deadline. Seats receive fixed initial game chips only once per table membership; rejoin must not reset a live or depleted stack. v0 permits a new free table to reset practice chips. Gameplay never awards platform points in v0.

## Mutation ordering and retry

The authenticated server normalizes the body and computes a canonical request hash. Dedup key `(accountId,operation,resourceId,requestId)` is checked BEFORE checking stateVersion. Same hash returns the recorded prior result marked replayed; same requestId with different body returns REQUEST_ID_CONFLICT. For a new action require exact stateVersion, room membership, correct windowId, actor eligibility, and `now < deadline` before reduction. Other room mutations require exact stateVersion and their membership/owner guards. At the exact deadline, timeout wins. A worker serializes room commands; transaction uses `BEGIN IMMEDIATE`, reads current authoritative snapshot/version, reruns guards, reduces, stores events/state, applies any unique settlement reward, stores request result, then commits. Only after commit emit/return. A crash before commit has no effect; after commit retries replay.

Persist a minimal result reference/version plus public command metadata rather than bearer tokens, card codes, or repeated private snapshots. A replay may return the current viewer-filtered snapshot and the originally accepted version separately when needed; consumers must treat replay as success and must not overwrite a newer state with an old snapshot. v0 simplest is store original accepted result with private fields encrypted or obtain viewer-filtered snapshot at current head on replay. Either must preserve the original action acceptance decision.

All rejected stale versions return VERSION_CONFLICT+currentStateVersion. Clients fetch a snapshot and reconsider current legalActions; never blindly resubmit the old action using the new version. Duplicate requests after successful acceptance are harmless. A periodic due-window scheduler enqueues server timeout commands with deterministic key `timeout:<roomId>:<windowId>`. On restart enumerate persisted due deadlines; each reducer validates windowId and version so an old timer cannot fold a later actor.

## Observations and reconnect

v0 polling is sufficient: GET events after cursor every 1s in web, explicit observe calls in MCP. An events response always includes a fresh viewer-filtered snapshot. Unknown/expired cursor sets reset=true. Persist cursor monotonically per room. Public events contain public facts only; hole-card deal/deck events are server audience. If eventual SSE is added, send only `room_changed {stateVersion,eventCursor}` then fetch snapshot, with cookie authorization and origin checks. Snapshot recovery is the correctness path; streaming is a latency optimization.

## MCP stdio tools

The SDK stdio process is a narrow HTTP client authenticated by TABLEMESH_TOKEN and pointed at TABLEMESH_URL (default loopback). No database connection, synthetic account, rewards tool, admin credential, or OpenAI API call exists in the adapter. Diagnostics go to stderr; stdout contains MCP protocol only. Tool names and args:

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

Return human-readable JSON text plus structuredContent containing the same ApiResult; error tools set isError. Mutating tools annotated readOnlyHint:false/destructiveHint:false/idempotentHint:true; observation readOnlyHint:true. Tool output text is data, not instructions; room names/display names untrusted. The plugin skill tells Codex to inspect current state and legalActions before each action, pass exact version/window, and never guess hidden cards. Users control whether their Codex acts automatically; server deadlines are authoritative.

HTTP MCP is deferred: adding a public Streamable HTTP endpoint requires implemented MCP authorization and origin protections, not simply exposing the stdio adapter. No OpenAI model key is needed for either transport.


## Confirmed abandonment, deadline ordering and public settlement history

AccountView includes fairPlay {reputation,cooldownUntil,abandonCount}; RoomSnapshot includes abandonedAccountIds for current-hand pending removals. Reputation starts100. First confirmed abandonment loses10 and gives5-minute new-game cooldown; repeat within24h loses20 and gives15 minutes, floor0. These are TableMesh v0 design values. Each account/room/hand is penalized once, persisted with an audit entry; changing requestId or restarting cannot add a second penalty. No redeemable points are deducted. Disconnect, refresh, and connection loss never confirm abandonment. MATCH_COOLDOWN blocks create/join/new start (including all participants), while existing live-hand actions and observation remain permitted.

Within the room queue, a successful dedup replay is checked first. A new command captures server time once. If a current window is already due at that time, the server commits normal timeout processing in a separate transaction before the command's version guard. A now-stale leave/action returns VERSION_CONFLICT and must be reconsidered; no abandonment penalty is applied to that rejected confirmation. Before deadline, confirmed abandonment folds in a legal window using the actual captured time, never a fabricated earlier clock.

Every new core transition.settlement is stored once in hand_settlements within the room transaction. Public room events add type hand_settled with payload {handId,participants:[{seat,accountId,displayName}],settlement:HandSettlement}. No hole cards or deck enter this record. Participants bind historical awards to the original accounts, not later occupants of the same seat. The event survives reconnect/restart and is not republished on seat changes or request replay. Current snapshot.game.settlement may be null after participants change; renderers can recover the same hand's summary from GET events and must use its participants for names. The ledger remains independent and receives no game payout entries.
