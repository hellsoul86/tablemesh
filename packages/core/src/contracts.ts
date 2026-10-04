/** Tokem v0 DTO and engine contract; mirrored in docs/ENGINE-CONTRACT.ts.
 * Amounts use nonnegative safe integers; times use Unix milliseconds.
 * The server validates requests and resolves account identity from the session.
 */
export type AccountId = string;
export type RoomId = string;
export type HandId = string;
export type Card = string; // canonical rank+suit: 2..9,T,J,Q,K,A + c,d,h,s
export type SeatIndex = number; // integer 0..maxSeats-1
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type GameId = 'holdem' | 'tractor' | 'mahjong';
export type ErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_INPUT'
 | 'VERSION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'ILLEGAL_ACTION' | 'ROOM_FULL'
 | 'MATCH_COOLDOWN' | 'INSUFFICIENT_POINTS' | 'OUT_OF_STOCK' | 'REWARDS_DISABLED' | 'RATE_LIMITED' | 'INTERNAL';
export interface ApiError { code: ErrorCode; message: string; currentStateVersion?: number }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export interface AccountView { id: AccountId; displayName: string; points: number; heldPoints: number;
 fairPlay: { reputation: number; cooldownUntil: number; abandonCount: number } }
export interface SessionView { account: AccountView; expiresAt: number }
export interface MutationMeta { requestId: string; stateVersion: number }
export interface SeatIdentity { seat: SeatIndex; accountId: AccountId; displayName: string; teamId?: string }
export interface HoldemConfig {
 gameId: 'holdem'; maxSeats: number; initialStack: number; // maxSeats 2..6 in v0
 smallBlind: number; bigBlind: number; turnTimeoutMs: number;
}
export interface PublicSeat extends SeatIdentity {
 stack: number; streetBet: number; totalBet: number;
 status: 'waiting' | 'active' | 'folded' | 'all-in' | 'out';
}
export type HoldemAction = { type: 'fold' } | { type: 'check' } | { type: 'call' }
 | { type: 'raise'; amount: number }; // amount = total street contribution, NEVER increment
export type LegalAction = { type: 'fold' } | { type: 'check' }
 | { type: 'call'; amount: number } // actual deduction = min(toCall, stack)
 | { type: 'raise'; minAmount: number; maxAmount: number; allInOnly: boolean };
export interface ActionWindow {
 id: string; kind: 'turn' | 'response'; eligibleSeats: SeatIndex[];
 deadline: number; // an absolute persisted deadline
 responseMode: 'single' | 'parallel';
}
export interface PotView { amount: number; eligibleSeats: SeatIndex[] }
export interface HandSettlement {
 handId: HandId; pots: { amount: number; winners: SeatIndex[]; awards: { seat: SeatIndex; amount: number }[] }[];
 // payouts include uncalled refunds separately. Sum(pot awards)+sum(refunds)=sum(contributions).
 refunds: { seat: SeatIndex; amount: number }[];
}
export interface HoldemPublicState {
 gameId: 'holdem'; handId: HandId | null;
 phase: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'complete';
 seats: PublicSeat[]; board: Card[]; button: SeatIndex | null;
 smallBlindSeat: SeatIndex | null; bigBlindSeat: SeatIndex | null;
 actorSeat: SeatIndex | null; currentBet: number; minRaiseIncrement: number;
 pots: PotView[]; window: ActionWindow | null;
 revealedHands: { seat: SeatIndex; cards: Card[] }[];
 settlement: HandSettlement | null;
}
export interface HoldemPrivateState { holeCards: Card[] }
export interface RoomSnapshot {
 id: RoomId; name: string; ownerAccountId: AccountId; abandonedAccountIds: AccountId[];
 stateVersion: number; eventCursor: number; config: HoldemConfig;
 game: HoldemPublicState; you: { accountId: AccountId; seat: SeatIndex | null;
 privateState: HoldemPrivateState | null; legalActions: LegalAction[] };
}
export interface RoomSummary { id: RoomId; name: string; gameId: GameId; occupiedSeats: number; maxSeats: number; phase: string }
export interface RoomCommand extends MutationMeta { action: HoldemAction; windowId: string }
export interface RoomMutationResult { snapshot: RoomSnapshot; replayed: boolean }
export interface RoomEvent {
 cursor: number; stateVersion: number; type: string; payload: Json;
} // Only viewer-filtered events. Never broadcast the engine state/event object.
export interface RoomEventBatch { events: RoomEvent[]; snapshot: RoomSnapshot; reset: boolean }
export interface ReplayParticipant extends SeatIdentity {
 startingStack: number | null; finalStack: number | null;
}
export interface HandReplaySummary {
 sequence: number; handId: HandId; roomId: RoomId; roomName: string;
 startedAt: number | null; finishedAt: number;
 participants: ReplayParticipant[];
 availability: 'full' | 'summary_only'; stepCount: number;
 netChips: number | null; settlement: HandSettlement;
}
export interface HandReplayList { hands: HandReplaySummary[]; nextBefore: number | null }
export interface HandReplayFrame {
 index: number; at: number;
 kind: 'start' | 'action' | 'timeout' | 'abandon' | 'abandon_fold';
 actorSeat: SeatIndex | null; action: HoldemAction | null;
 // Real post-reduction public state. No usable live action window.
 game: HoldemPublicState;
 // Core-issued public board transitions within this same atomic reduction.
 streets: { phase: 'flop' | 'turn' | 'river'; board: Card[] }[];
}
export interface HandReplayDetail {
 summary: HandReplaySummary; config: HoldemConfig | null;
 you: { accountId: AccountId; seat: SeatIndex; privateState: HoldemPrivateState | null };
 frames: HandReplayFrame[]; nextAfterStep: number | null;
}

export interface PointsEntry { id: string; delta: number; heldDelta: number; reason: string; createdAt: number }
export interface RewardProduct { id: string; name: string; pointsCost: number; available: number; sandbox: boolean }
export interface RedemptionView { id: string; productId: string; pointsCost: number;
 status: 'fulfilled' | 'failed' | 'pending'; sandbox: boolean; createdAt: number }
export interface RedemptionSecret extends RedemptionView { code: string }

/** Internal engine state. HTTP/MCP serializers use viewer projections. */
export interface HoldemEngineState {
 config: HoldemConfig; publicState: HoldemPublicState;
 // explicit serializable engine-private record supports snapshot/restart.
 privateState: { deck: Card[]; deckCursor: number; holeCards: Record<string, Card[]>;
 actedSeats: SeatIndex[]; raiseRights: SeatIndex[]; [key: string]: Json };
}
export interface EngineEvent { type: string; payload: Json; audience: 'public' | 'server' | { seats: SeatIndex[] } }
export interface EngineTransition { state: HoldemEngineState; events: EngineEvent[]; settlement: HandSettlement | null }
export type EngineResult = { ok: true; transition: EngineTransition }
 | { ok: false; error: { code: 'ILLEGAL_ACTION' | 'INVALID_INPUT'; message: string } };
export interface StartHandInput { handId: HandId; deck: Card[]; now: number }
export interface ApplyActionInput { seat: SeatIndex; action: HoldemAction; windowId: string; now: number }
/** Pure engine functions: callers supply the deck and time; core performs no IO. */
export interface HoldemEngine {
 createTable(config: HoldemConfig, seats: SeatIdentity[]): HoldemEngineState;
 setSeats(state: HoldemEngineState, seats: SeatIdentity[]): EngineResult;
 startHand(state: HoldemEngineState, input: StartHandInput): EngineResult;
 applyAction(state: HoldemEngineState, input: ApplyActionInput): EngineResult;
 applyTimeout(state: HoldemEngineState, now: number): EngineResult;
 getPublicState(state: HoldemEngineState): HoldemPublicState;
 getPrivateState(state: HoldemEngineState, seat: SeatIndex): HoldemPrivateState;
 getLegalActions(state: HoldemEngineState, seat: SeatIndex): LegalAction[];
}
/** Extension shape for future games with separate public/private views. */
export interface RuleSet<State, Public, Private, Action, Config> {
 id: GameId; version: string;
 create(config: Config, seats: SeatIdentity[]): State;
 reduce(state: State, actorSeat: SeatIndex, action: Action, context: { now: number; windowId: string }): {
 state: State; events: EngineEvent[]; windows: ActionWindow[]; settlement?: Json;
 };
 publicView(state: State): Public;
 privateView(state: State, viewerSeat: SeatIndex): Private;
 legalActions(state: State, viewerSeat: SeatIndex): Action[];
}
