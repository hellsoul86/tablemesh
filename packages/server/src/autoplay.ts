import { randomUUID } from 'node:crypto';
import type {
  AccountId, AutoplayReason, AutoplayView, Card, HoldemAction, HoldemConfig,
  HoldemPublicState, LegalAction, LlmConfigView, PublicSeat, RoomCommand, RoomId, RoomSnapshot,
} from '@tablemesh/core/contracts';

// Internal seams. Provider credentials and full engine state never enter these objects.
export interface AutoplayAuthority { accountId: AccountId; sessionId: string }
export interface PokerObservation {
  decisionNonce: string; seat: number; holeCards: Card[];
  phase: HoldemPublicState['phase']; board: Card[]; button: number | null;
  smallBlindSeat: number | null; bigBlindSeat: number | null; actorSeat: number | null;
  currentBet: number; minRaiseIncrement: number;
  seats: Pick<PublicSeat, 'seat' | 'stack' | 'streetBet' | 'totalBet' | 'status'>[];
  pots: HoldemPublicState['pots']; config: HoldemConfig; legalActions: LegalAction[];
}
export interface ProviderInvocation {
  accountId: AccountId; observation: PokerObservation; signal: AbortSignal; timeoutMs: number;
}
export interface ProviderDecision { decisionNonce: string; action: HoldemAction }
export interface AutoplayHooks {
  now(): number;
  config(accountId: AccountId): LlmConfigView;
  read(authority: AutoplayAuthority, roomId: RoomId): Promise<RoomSnapshot>;
  decide(input: ProviderInvocation): Promise<ProviderDecision>;
  // Revalidate the session and run guard inside the authoritative room queue.
  submit(authority: AutoplayAuthority, roomId: RoomId, command: RoomCommand, guard: () => boolean): Promise<void>;
}
export class AutoplayFault extends Error {
  constructor(readonly reason: AutoplayReason) { super(reason); this.name = 'AutoplayFault'; }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}
/** Validate both the provider response and the controller's final candidate. */
export function validateModelDecision(value: unknown, observation: PokerObservation): ProviderDecision {
  if (!plain(value) || !keys(value, ['decisionNonce', 'action']) || value.decisionNonce !== observation.decisionNonce || !plain(value.action)) {
    throw new AutoplayFault('INVALID_RESPONSE');
  }
  const candidate = value.action;
  if (candidate.type === 'raise') {
    if (!keys(candidate, ['type', 'amount']) || typeof candidate.amount !== 'number' || !Number.isSafeInteger(candidate.amount)) throw new AutoplayFault('INVALID_RESPONSE');
    const legal = observation.legalActions.find(action => action.type === 'raise');
    if (!legal || candidate.amount < legal.minAmount || candidate.amount > legal.maxAmount || (legal.allInOnly && candidate.amount !== legal.maxAmount)) throw new AutoplayFault('INVALID_RESPONSE');
    return { decisionNonce: observation.decisionNonce, action: { type: 'raise', amount: candidate.amount } };
  }
  if (!keys(candidate, ['type']) || !['fold', 'check', 'call'].includes(String(candidate.type)) || !observation.legalActions.some(action => action.type === candidate.type)) throw new AutoplayFault('INVALID_RESPONSE');
  return { decisionNonce: observation.decisionNonce, action: { type: candidate.type as 'fold' | 'check' | 'call' } };
}

export function pokerObservation(snapshot: RoomSnapshot, decisionNonce: string): PokerObservation {
  if (snapshot.you.seat === null || !snapshot.you.privateState || snapshot.you.privateState.holeCards.length !== 2) throw new AutoplayFault('SEAT_LOST');
  const game = snapshot.game;
  return {
    decisionNonce, seat: snapshot.you.seat, holeCards: [...snapshot.you.privateState.holeCards],
    phase: game.phase, board: [...game.board], button: game.button,
    smallBlindSeat: game.smallBlindSeat, bigBlindSeat: game.bigBlindSeat, actorSeat: game.actorSeat,
    currentBet: game.currentBet, minRaiseIncrement: game.minRaiseIncrement,
    seats: game.seats.map(({ seat, stack, streetBet, totalBet, status }) => ({ seat, stack, streetBet, totalBet, status })),
    pots: game.pots.map(({ amount, eligibleSeats }) => ({ amount, eligibleSeats: [...eligibleSeats] })),
    config: { gameId: snapshot.config.gameId, maxSeats: snapshot.config.maxSeats, initialStack: snapshot.config.initialStack,
      smallBlind: snapshot.config.smallBlind, bigBlind: snapshot.config.bigBlind, turnTimeoutMs: snapshot.config.turnTimeoutMs },
    legalActions: snapshot.you.legalActions.map(action => action.type === 'raise'
      ? { type: 'raise', minAmount: action.minAmount, maxAmount: action.maxAmount, allInOnly: action.allInOnly }
      : action.type === 'call' ? { type: 'call', amount: action.amount } : { type: action.type }),
  };
}

interface Job {
  generation: number; abort: AbortController; dispatched: boolean;
  timer: ReturnType<typeof setTimeout> | null; followUp: boolean;
}
interface Controller {
  authority: AutoplayAuthority; roomId: RoomId; enabled: boolean; generation: number;
  view: AutoplayView; job: Job | null; dirty: boolean; lastAttempt: string | null;
}

function failureReason(error: unknown): AutoplayReason {
  if (error instanceof AutoplayFault) return error.reason;
  if (plain(error) || error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'UNAUTHENTICATED') return 'CREDENTIAL_REVOKED';
    if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return 'SEAT_LOST';
    if (code === 'VERSION_CONFLICT' || code === 'ILLEGAL_ACTION') return 'STALE_STATE';
  }
  return 'MODEL_ERROR';
}

/** Process-local controller. Restart never restores paid model work. */
export class AutoplayManager {
  private readonly controllers = new Map<AccountId, Map<RoomId, Controller>>();
  private closed = false;
  constructor(private readonly hooks: AutoplayHooks) {}

  private get(accountId: AccountId, roomId: RoomId): Controller | undefined { return this.controllers.get(accountId)?.get(roomId); }
  private copy(controller: Controller): AutoplayView { return { ...controller.view, inFlight: controller.job?.dispatched ?? false }; }
  view(accountId: AccountId, roomId: RoomId): AutoplayView {
    const controller = this.get(accountId, roomId);
    return controller ? this.copy(controller) : { roomId, phase: 'stopped', reason: null, handId: null,
      requestsThisHand: 0, requestsThisRun: 0, inFlight: false, startedAt: null, updatedAt: this.hooks.now() };
  }

  // The caller resolves/validates authority and membership before accepting a control command.
  start(authority: AutoplayAuthority, snapshot: RoomSnapshot): AutoplayView {
    if (this.closed) throw new AutoplayFault('SERVER_RESTART');
    if (snapshot.you.accountId !== authority.accountId || snapshot.you.seat === null) throw new AutoplayFault('SEAT_LOST');
    if (snapshot.abandonedAccountIds.includes(authority.accountId)) throw new AutoplayFault('ABANDONED');
    const config = this.hooks.config(authority.accountId);
    if (!config.ready) throw new AutoplayFault('CONFIG_CHANGED');
    let controller = this.get(authority.accountId, snapshot.id);
    if (controller?.enabled) return this.copy(controller);
    if (!controller) {
      controller = { authority: { ...authority }, roomId: snapshot.id, enabled: false, generation: 0,
        view: this.view(authority.accountId, snapshot.id), job: null, dirty: false, lastAttempt: null };
      let rooms = this.controllers.get(authority.accountId);
      if (!rooms) { rooms = new Map(); this.controllers.set(authority.accountId, rooms); }
      rooms.set(snapshot.id, controller);
    }
    controller.authority = { ...authority }; controller.enabled = true; controller.generation++;
    controller.lastAttempt = null; controller.dirty = true;
    if (controller.view.handId !== snapshot.game.handId) controller.view.requestsThisHand = 0;
    controller.view = { ...controller.view, phase: 'waiting', reason: null, handId: snapshot.game.handId,
      requestsThisRun: 0, startedAt: this.hooks.now(), updatedAt: this.hooks.now() };
    queueMicrotask(() => this.kick(controller));
    return this.copy(controller);
  }

  stop(accountId: AccountId, roomId: RoomId, reason: AutoplayReason = 'USER_STOP'): AutoplayView {
    const controller = this.get(accountId, roomId);
    if (!controller) return { ...this.view(accountId, roomId), reason };
    this.pause(controller, reason, reason === 'USER_STOP' || reason === 'SERVER_RESTART' ? 'stopped' : 'paused');
    return this.copy(controller);
  }
  pauseAccount(accountId: AccountId, reason: AutoplayReason = 'CONFIG_CHANGED'): void {
    for (const controller of this.controllers.get(accountId)?.values() ?? []) this.pause(controller, reason);
  }
  pauseCredential(sessionId: string): void {
    for (const rooms of this.controllers.values()) for (const controller of rooms.values()) {
      if (controller.authority.sessionId === sessionId) this.pause(controller, 'CREDENTIAL_REVOKED');
    }
  }
  roomChanged(roomId: RoomId): void {
    if (this.closed) return;
    for (const rooms of this.controllers.values()) {
      const controller = rooms.get(roomId);
      if (controller?.enabled) { controller.dirty = true; queueMicrotask(() => this.kick(controller)); }
    }
  }
  close(): void {
    this.closed = true;
    for (const rooms of this.controllers.values()) for (const controller of rooms.values()) this.pause(controller, 'SERVER_RESTART', 'stopped');
  }

  private pause(controller: Controller, reason: AutoplayReason, phase: 'paused' | 'stopped' = 'paused'): void {
    controller.enabled = false; controller.generation++; controller.dirty = false;
    controller.view = { ...controller.view, phase, reason, updatedAt: this.hooks.now() };
    if (controller.job?.timer) clearTimeout(controller.job.timer);
    controller.job?.abort.abort();
  }
  private current(controller: Controller, job: Job): boolean {
    return !this.closed && controller.enabled && controller.job === job && controller.generation === job.generation && !job.abort.signal.aborted;
  }
  private kick(controller: Controller): void {
    if (this.closed || !controller.enabled || controller.job) return;
    const job: Job = { generation: controller.generation, abort: new AbortController(), dispatched: false, timer: null, followUp: false };
    controller.job = job; controller.dirty = false;
    void this.run(controller, job).finally(() => {
      if (job.timer) clearTimeout(job.timer);
      if (controller.job === job) {
        controller.job = null;
        if (controller.enabled && (controller.dirty || job.followUp)) queueMicrotask(() => this.kick(controller));
      }
    });
  }
  private async run(controller: Controller, job: Job): Promise<void> {
    try {
      const snapshot = await this.hooks.read(controller.authority, controller.roomId);
      if (!this.current(controller, job)) return;
      if (snapshot.you.accountId !== controller.authority.accountId || snapshot.you.seat === null) throw new AutoplayFault('SEAT_LOST');
      if (snapshot.abandonedAccountIds.includes(controller.authority.accountId)) throw new AutoplayFault('ABANDONED');
      if (controller.view.handId !== snapshot.game.handId) {
        controller.view.handId = snapshot.game.handId; controller.view.requestsThisHand = 0; controller.lastAttempt = null;
      }
      const window = snapshot.game.window;
      if (!window || !window.eligibleSeats.includes(snapshot.you.seat) || !snapshot.you.legalActions.length) {
        controller.view = { ...controller.view, phase: 'waiting', updatedAt: this.hooks.now() }; return;
      }
      const attempt = `${snapshot.stateVersion}:${window.id}`;
      if (controller.lastAttempt === attempt) return; // Never automatically retry the same decision.
      const config = this.hooks.config(controller.authority.accountId);
      if (!config.ready) throw new AutoplayFault('CONFIG_CHANGED');
      if (controller.view.requestsThisHand >= config.limits.maxRequestsPerHand) throw new AutoplayFault('HAND_BUDGET');
      if (controller.view.requestsThisRun >= config.limits.maxRequestsPerRun) throw new AutoplayFault('RUN_BUDGET');
      const timeoutMs = Math.min(config.limits.timeoutMs, window.deadline - this.hooks.now() - 25);
      if (timeoutMs <= 0) throw new AutoplayFault('REQUEST_TIMEOUT');
      const observation = pokerObservation(snapshot, randomUUID());
      controller.lastAttempt = attempt;
      controller.view = { ...controller.view, phase: 'thinking', reason: null,
        requestsThisHand: controller.view.requestsThisHand + 1, requestsThisRun: controller.view.requestsThisRun + 1, updatedAt: this.hooks.now() };
      job.dispatched = true;
      job.timer = setTimeout(() => { if (this.current(controller, job)) this.pause(controller, 'REQUEST_TIMEOUT'); }, timeoutMs);
      const decision = validateModelDecision(await this.hooks.decide({ accountId: controller.authority.accountId,
        observation, signal: job.abort.signal, timeoutMs }), observation);
      if (!this.current(controller, job)) return;
      if (this.hooks.now() >= window.deadline) throw new AutoplayFault('STALE_STATE');
      const latest = await this.hooks.read(controller.authority, controller.roomId);
      if (!this.current(controller, job)) return;
      if (latest.abandonedAccountIds.includes(controller.authority.accountId)) throw new AutoplayFault('ABANDONED');
      if (latest.you.seat !== snapshot.you.seat || latest.you.accountId !== controller.authority.accountId) throw new AutoplayFault('SEAT_LOST');
      if (latest.stateVersion !== snapshot.stateVersion || latest.game.window?.id !== window.id || latest.game.window.deadline !== window.deadline) throw new AutoplayFault('STALE_STATE');
      validateModelDecision(decision, pokerObservation(latest, observation.decisionNonce));
      await this.hooks.submit(controller.authority, controller.roomId, {
        requestId: `autoplay:${observation.decisionNonce}`, stateVersion: snapshot.stateVersion,
        windowId: window.id, action: decision.action,
      }, () => this.current(controller, job) && this.hooks.now() < window.deadline);
      if (this.current(controller, job)) {
        controller.view = { ...controller.view, phase: 'waiting', updatedAt: this.hooks.now() };
        job.followUp = true;
      }
    } catch (error) {
      if (this.current(controller, job)) this.pause(controller, failureReason(error));
    }
  }
}
