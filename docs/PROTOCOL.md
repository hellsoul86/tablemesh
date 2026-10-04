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

Every new core transition.settlement is stored once in hand_settlements within the room transaction. Public room events add type hand_settled with payload {handId,participants:[{seat,accountId,displayName,startingStack,finalStack,netChips}],settlement:HandSettlement}. No hole cards or deck enter this record. Participants bind historical awards to the original accounts, not later occupants of the same seat. The event survives reconnect/restart and is not republished on seat changes or request replay. Current snapshot.game.settlement may be null after participants change; renderers can recover the same hand's summary from GET events and must use its participants for names. The ledger remains independent and receives no game payout entries.

## Personal ended-hand history

GET `/api/replays?before=<sequence>&limit=<1..50>` returns HandReplayList, default limit 20. Results are restricted to originally participating accounts and ordered by descending completion sequence. `nextBefore` is the last returned sequence when another page exists, otherwise null.

GET `/api/replays/:handId?afterStep=<-1 or nonnegative index>&limit=<1..200>` returns HandReplayDetail, default afterStep -1 and limit 100. Frames have index greater than afterStep. `nextAfterStep` is the last returned index when another page exists, otherwise null. The original participant/config/name metadata, settlement and caller's private dealt cards accompany each page. Unknown, unfinished and nonparticipant hands all return NOT_FOUND/404. Both web sessions and game bearer tokens can read their own history. No request accepts an account or seat identity override.

A full frame is an actual successful reduction or accepted abandonment marker, with kind start/action/timeout/abandon/abandon_fold, timestamp, original actor seat and validated action when applicable. `game` is that step's public state with window=null; `streets` contains the reducer's ordered public street changes. Automatic all-in runout and settlement can share one step. Opponent revealedHands appear only in the step where the original engine actually revealed them. There are no legalActions or live mutation controls in a replay. Caller privateState contains only their two originally dealt cards. Participants' net chips equal final minus pre-blind stack; award totals are not net profit.

Old results use availability=summary_only, stepCount=0, frames=[], config=null, startedAt=null, privateState=null and netChips=null; participant starting/final stacks are null. The settlement and original recorded identities remain known. New full traces persist through restart, including hands active at restart. Reads are immutable and do not process deadlines or modify points/penalties.

The shared registry has thirteen tools. `tablemesh_list_replays {before?,limit?}` and `tablemesh_get_replay {handId,afterStep?,limit?}` are strict, read-only wrappers for the two endpoints, with the same bounds and identity permissions on HTTP and stdio. A caller can page a completed history for review; these tools neither run a model nor share histories with other accounts.

## Per-seat action and chip metadata

RoomSnapshot adds required `roundActions:RoundActionState`; full replay frames add optional `roundActions` and nullable optional `actionDetail` to remain compatible with stored older frame JSON. Tool count and game command schemas stay unchanged. Current projections enrich provable old full traces without modifying their stored JSON. No metadata contains private state or extra account authority.

RoundActionState contains `street` (preflop/flop/turn/river or null) and one status per public seat: `{seat,streetCommitted,handCommitted,actionKnown,lastAction}`. Commitments are actual gross payments before uncalled refunds; the final settlement lists returned chips separately. Example: a big blind originally paid 10, then raises to 100 by paying 90; after its opponent folds, terminal commitment is still 100, refund is 90 and contested pot is 20. Commitment is neither final net loss nor a wallet debit. Blinds count toward commitments but do not invent a deliberate action. Waiting/new-street known seats have lastAction=null; actionKnown=false marks unavailable previous action evidence rather than claiming the player has not acted.

SeatActionDetail contains `{seat,street,type,paid,committedTo,allIn,source,at}`. Type distinguishes check/call/bet/raise/fold; a raise command with previously zero currentBet is displayed as bet. `paid` is this action's actual deduction, `committedTo` is its resulting total street contribution, and allIn is paying a positive remaining stack. Call pays min(toCall, prior stack); raise pays target minus prior streetBet. Neither amount is inferred from a post-settlement balance difference. Source player covers both manual and Agent submissions, while timeout and abandon identify automatic check/fold causes. Confirming abandonment is a marker, not a fold before the engine actually folds.

Genuine street advancement clears current-round actions and street commitments while hand commitments continue. The boundary replay frame retains actionDetail for the action that closed the previous street. Completion retains the last actual betting/decision street and its gross commitments, even though core clears counters after payout. Preflop all-in automatic runout therefore shows the last preflop actions, not invented river actions. A blind-only immediate completion has blinds and no deliberate action.

`room_round_actions` stores metadata in the same authoritative transaction as room state, dedup records and replay frames. Internal account/slot binding prevents a replacement occupant inheriting prior labels. Accepted duplicate, stale or failed actions do not add payments or change labels. Restart retains recorded active metadata. If an older current live/completed hand has a full public trace, its metadata can be projected from that trace; absent history leaves action evidence and terminal commitment unknown/null. Old full replay pagination derives from the necessary prior public prefix, so a middle page agrees with the same frames in a full read. summary_only histories have no fabricated details.

Public table event details are additive fields on the existing `room_start`, `room_action`, `room_timeout`, `room_join` and `room_leave` event types. A command's `steps` array preserves each committed reducer in order: `{kind,at,actor:{seat,accountId,displayName}|null,actionDetail:SeatActionDetail|null,streets:[{phase,board}],phase,board}`. Action payment and committed-to totals come from the authoritative pre-action state; a finishing payout never changes those amounts. Crossing a street keeps the preceding action's street and lists the actual new public streets. An all-in runout is one reduction with its public street changes, not invented decisions. Blind-only start has no action detail.

`room_start` adds `handId` and original `participants` with starting stacks and `finalStack:null`. Join/leave add the frozen `participant` identity; leave's `abandoned` flag distinguishes confirmation during a hand from ordinary departure. Confirmation itself is not a fold: only a later actual `abandon_fold` reduction records `source:abandon`. Settlement participants retain the original accounts and add final stacks and `netChips=finalStack-startingStack`; unknown legacy balances are null. Awards and uncalled refunds remain in settlement, and their sum is not presented as profit. These fields commit with room state, replay, request dedup and all command events; rejected, stale and duplicate commands add no events.

For older events, GET events can project details from a completed full public replay only when the entire segment from `room_start` to `hand_settled` has contiguous cursors/versions and exactly matches frame kinds, action actors, phases and order. Missing or conflicting segments retain their original unknown payload. This projection reads only public replay frames/participants, never own-card rows, and does not rewrite stored event or replay JSON. It works across event pagination. Start details never receive later boards or final balances. A summary-only result may supply its known settlement and null balances, but has no invented action trace.
