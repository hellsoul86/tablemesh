import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setMaxListeners } from 'node:events';
import { randomInt, randomUUID, randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { createTable, setSeats, startHand, applyAction, applyTimeout, getPublicState, getPrivateState, getLegalActions } from '@tablemesh/core';
import type { AccountView, HoldemConfig, HoldemEngineState, EngineResult, RoomSnapshot, RoomMutationResult, RedemptionView, RewardProduct, PointsEntry, ApiResult, Json } from '@tablemesh/core/contracts';
import { Store } from './db.js';
import { readConfig, mcpPublicUrl, type AppConfig } from './config.js';
import { handleGameMcp, McpWaitCancellation } from './mcp-http.js';
import type { GameApi } from './mcp-tools.js';
import { AppError, fail, object, exactKeys, text, integer, canonical, hash, sameSecret, newToken, password, passwordHash, passwordMatches, readJson } from './util.js';

interface Identity { accountId: string; sessionId: string; kind: 'web' | 'game' }
interface AccountRow { id: string; display_name: string; password_hash: string }
interface SessionRow { id: string; account_id: string; kind: 'web' | 'game'; expires_at: number }
interface RoomRow { id: string; name: string; owner_account_id: string; engine_json: string; state_version: number; event_cursor: number }
interface ProductRow { id: string; name: string; points_cost: number; sandbox: number; enabled: number }
interface RedemptionRow { id: string; account_id: string; product_id: string; points_cost: number; status: 'fulfilled' | 'failed' | 'pending'; sandbox: number; request_id: string; body_hash: string; created_at: number }

function shuffleDeck(): string[] {
  const deck = [...'23456789TJQKA'].flatMap(rank => [...'cdhs'].map(suit => rank + suit));
  for (let i = deck.length - 1; i > 0; i--) { const j = randomInt(i + 1); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
  return deck;
}
function unwrap(result: EngineResult): HoldemEngineState {
  if (!result.ok) fail(result.error.code, result.error.message);
  return result.transition.state;
}
function gameConfig(value: unknown): HoldemConfig {
  const v = object(value);
  exactKeys(v, ['gameId', 'maxSeats', 'initialStack', 'smallBlind', 'bigBlind', 'turnTimeoutMs']);
  if (v.gameId !== 'holdem') fail('INVALID_INPUT', 'Only Hold’em is implemented in v0');
  const config: HoldemConfig = {
    gameId: 'holdem', maxSeats: integer(v.maxSeats, 'maxSeats', 2, 6), initialStack: integer(v.initialStack, 'initialStack', 1, 1_000_000),
    smallBlind: integer(v.smallBlind, 'smallBlind', 1, 1_000_000), bigBlind: integer(v.bigBlind, 'bigBlind', 1, 1_000_000),
    turnTimeoutMs: integer(v.turnTimeoutMs, 'turnTimeoutMs', 1000, 600_000)
  };
  if (config.smallBlind > config.bigBlind) fail('INVALID_INPUT', 'Small blind must not exceed big blind');
  return config;
}

export class Application {
  readonly config: AppConfig;
  readonly store: Store;
  readonly server;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly rate = new Map<string, { count: number; until: number }>();
  private readonly timer: ReturnType<typeof setInterval> | null;
  private closing = false;
  private readonly shutdown = new AbortController();
  private readonly mcpWaits = new McpWaitCancellation();
  private readonly waiters = new Map<string, number>();
  private waiterCount = 0;

  constructor(overrides: Partial<AppConfig> = {}) {
    this.config = { ...readConfig(), ...overrides };
    this.config.mcpPublicUrl = mcpPublicUrl(this.config.mcpPublicUrl);
    setMaxListeners(101, this.shutdown.signal); // At most 100 pending wait listeners.
    this.store = new Store(this.config.databasePath);
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.timer = this.config.schedulerIntervalMs > 0 ? setInterval(() => { void this.runTimeouts().catch(() => console.error('Tokem timeout processing failed')); }, this.config.schedulerIntervalMs) : null;
    this.timer?.unref();
    // Startup immediately restores overdue persisted windows through the same queue.
    void this.runTimeouts().catch(() => console.error('Tokem startup recovery failed'));
  }
  async listen(port = this.config.port): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, this.config.host, () => { this.server.off('error', reject); resolve(); }); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Server failed to bind');
    return `http://${this.config.host}:${address.port}`;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    this.mcpWaits.close();
    if (this.timer) clearInterval(this.timer);
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...this.queues.values()]);
    this.store.close();
  }
  private queue<T>(key: string, fn: () => T): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
  private account(id: string): AccountView {
    const row = this.store.one<{ id: string; display_name: string; available: number; held: number }>('SELECT a.id,a.display_name,w.available,w.held FROM accounts a JOIN wallets w ON w.account_id=a.id WHERE a.id=?', id);
    if (!row) fail('UNAUTHENTICATED', 'Account is unavailable', 401);
    const fairness = this.store.one<{ reputation: number; cooldown_until: number }>('SELECT * FROM fair_play WHERE account_id=?', id)!;
    const abandonCount = this.store.one<{ n: number }>('SELECT COUNT(*) n FROM room_abandons WHERE account_id=?', id)!.n;
    return { id: row.id, displayName: row.display_name, points: row.available, heldPoints: row.held,
      fairPlay: { reputation: fairness.reputation, cooldownUntil: fairness.cooldown_until, abandonCount } };
  }
  private enteringAllowed(accountId: string): void {
    const fairness = this.store.one<{ cooldown_until: number }>('SELECT cooldown_until FROM fair_play WHERE account_id=?', accountId);
    if (fairness && fairness.cooldown_until > this.config.now()) fail('MATCH_COOLDOWN', 'Active abandonment cooldown: joining or starting a new game is unavailable', 409);
  }
  private identity(req: IncomingMessage): Identity {
    const authorization = req.headers.authorization;
    let token: string | undefined;
    let kind: 'web' | 'game';
    if (authorization !== undefined) {
      if (!authorization.startsWith('Bearer ') || !authorization.slice(7)) fail('UNAUTHENTICATED', 'Invalid bearer credential', 401);
      token = authorization.slice(7); kind = 'game';
    } else {
      token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('tablemesh_session='))?.slice('tablemesh_session='.length);
      kind = 'web';
    }
    if (!token) fail('UNAUTHENTICATED', 'Sign in required', 401);
    const row = this.store.one<SessionRow>('SELECT id,account_id,kind,expires_at FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?', hash(token), this.config.now());
    if (!row || row.kind !== kind) fail('UNAUTHENTICATED', 'Session expired or revoked', 401);
    return { accountId: row.account_id, sessionId: row.id, kind: row.kind };
  }
  private webOnly(identity: Identity): void { if (identity.kind !== 'web') fail('FORBIDDEN', 'A web session is required for this operation', 403); }
  private activeIdentity(identity: Identity): void {
    if (!this.store.one('SELECT id FROM sessions WHERE id=? AND account_id=? AND kind=? AND revoked_at IS NULL AND expires_at>?',
      identity.sessionId, identity.accountId, identity.kind, this.config.now())) fail('UNAUTHENTICATED', 'Session expired or revoked', 401);
  }
  private listenerUrl(): URL {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Server is not listening');
    const host = address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '::1' : address.address;
    return new URL(`http://${host.includes(':') ? `[${host}]` : host}:${address.port}`);
  }
  private agentConnection(): { mcpUrl: string | null; transport: 'streamable-http'; authentication: 'game-bearer'; tokenEnvVar: 'TABLEMESH_TOKEN'; maxWaitMs: 25000 } {
    const address = this.server.address();
    const local = address && typeof address !== 'string' && ['127.0.0.1', '::1'].includes(address.address);
    return { mcpUrl: this.config.mcpPublicUrl ?? (local ? new URL('/mcp', this.listenerUrl()).href : null),
      transport: 'streamable-http', authentication: 'game-bearer', tokenEnvVar: 'TABLEMESH_TOKEN', maxWaitMs: 25000 };
  }
  private mcpHost(req: IncomingMessage): void {
    const host = req.headers.host?.toLowerCase();
    const address = this.server.address();
    if (!host || !address || typeof address === 'string') fail('FORBIDDEN', 'MCP Host is not allowed', 403);
    const allowed = new Set([this.listenerUrl().host.toLowerCase()]);
    if (['127.0.0.1', '::1', '0.0.0.0', '::'].includes(address.address)) {
      for (const loopback of ['127.0.0.1', 'localhost', '[::1]']) allowed.add(`${loopback}:${address.port}`);
    }
    // A public authority is trusted only when explicitly supplied by the operator.
    if (this.config.mcpPublicUrl) allowed.add(new URL(this.config.mcpPublicUrl).host.toLowerCase());
    if (!allowed.has(host)) fail('FORBIDDEN', 'MCP Host is not allowed', 403);
  }
  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.mcpHost(req);
    this.origin(req, false);
    if (!req.headers.authorization) fail('UNAUTHENTICATED', 'A game bearer token is required', 401);
    const identity = this.identity(req);
    if (identity.kind !== 'game') fail('FORBIDDEN', 'A game bearer token is required', 403);
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } }));
      return;
    }
    const authorization = req.headers.authorization;
    const target = this.listenerUrl();
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    const api: GameApi = async (path, method = 'GET', body, signal) => {
      try {
        // The target is this listener, never a URL obtained from tool arguments.
        const response = await fetch(new URL('/api' + path, target), {
          method, headers: { Authorization: authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
          signal: AbortSignal.any([controller.signal, this.shutdown.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
        });
        const result = await response.json() as ApiResult<unknown>;
        if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid game response');
        return result;
      } catch {
        return { ok: false, error: { code: 'INTERNAL', message: 'Tokem game request was interrupted. Observe current state before retrying a command.' } };
      }
    };
    try { await handleGameMcp(req, res, api, this.mcpWaits, JSON.stringify([identity.accountId, identity.sessionId])); }
    finally { req.off('aborted', disconnected); res.off('close', disconnected); }
  }
  private async waitForRoom(identity: Identity, id: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    for (const key of url.searchParams.keys()) if (!['afterStateVersion', 'maxWaitMs'].includes(key)) fail('INVALID_INPUT', 'Unexpected wait parameter');
    const parse = (key: string, fallback: number, max: number) => {
      const values = url.searchParams.getAll(key);
      if (values.length > 1 || (values.length === 1 && !/^\d+$/u.test(values[0]!))) fail('INVALID_INPUT', `Invalid ${key}`);
      return values.length ? integer(Number(values[0]), key, 0, max) : fallback;
    };
    if (!url.searchParams.has('afterStateVersion')) fail('INVALID_INPUT', 'afterStateVersion is required');
    const after = parse('afterStateVersion', 0, Number.MAX_SAFE_INTEGER);
    const maxWaitMs = parse('maxWaitMs', 20_000, 25_000);
    const project = () => {
      this.activeIdentity(identity);
      const snapshot = this.snapshot(this.room(id), identity);
      const reason = snapshot.you.legalActions.length ? 'your_turn' : snapshot.game.phase === 'complete' ? 'hand_complete'
        : snapshot.stateVersion !== after ? 'state_changed' : null;
      return { snapshot, reason };
    };
    const initial = project();
    if (initial.reason || maxWaitMs === 0) return { ...initial, reason: initial.reason ?? 'timeout' };
    if ((this.waiters.get(identity.accountId) ?? 0) >= 2 || this.waiterCount >= 100) fail('RATE_LIMITED', 'Too many pending game waits', 429);
    this.waiters.set(identity.accountId, (this.waiters.get(identity.accountId) ?? 0) + 1);
    this.waiterCount++;
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const disconnected = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort);
    res.once('close', disconnected);
    this.shutdown.signal.addEventListener('abort', abort, { once: true });
    const deadline = performance.now() + maxWaitMs;
    try {
      for (;;) {
        if (cancellation.signal.aborted || this.closing) throw new AppError('INTERNAL', 'Game wait interrupted', 503);
        const current = project();
        if (current.reason || performance.now() >= deadline) return { ...current, reason: current.reason ?? 'timeout' };
        await new Promise<void>(resolve => {
          const onAbort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { cancellation.signal.removeEventListener('abort', onAbort); resolve(); }, Math.min(40, Math.max(1, deadline - performance.now())));
          cancellation.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally {
      req.off('aborted', abort);
      res.off('close', disconnected);
      this.shutdown.signal.removeEventListener('abort', abort);
      const remaining = (this.waiters.get(identity.accountId) ?? 1) - 1;
      if (remaining) this.waiters.set(identity.accountId, remaining); else this.waiters.delete(identity.accountId);
      this.waiterCount--;
    }
  }
  private origin(req: IncomingMessage, requireOrigin: boolean): void {
    const origin = req.headers.origin;
    if (origin ? !this.config.allowedOrigins.includes(origin) : requireOrigin) fail('FORBIDDEN', 'Origin is not allowed', 403);
  }
  private authRate(req: IncomingMessage, path: string): void {
    const key = `${req.socket.remoteAddress ?? 'unknown'}:${path}`;
    const now = this.config.now();
    let entry = this.rate.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + 60_000 }; this.rate.set(key, entry); }
    entry.count++;
    if (entry.count > 30) fail('RATE_LIMITED', 'Try authentication again later', 429);
    if (this.rate.size > 10_000) for (const [key, item] of this.rate) if (item.until <= now) this.rate.delete(key);
  }
  private issueSession(accountId: string, kind: 'web' | 'game', label: string) {
    const token = newToken();
    const expiresAt = this.config.now() + (kind === 'web' ? this.config.sessionTtlMs : this.config.gameTokenTtlMs);
    this.store.run('INSERT INTO sessions(id,token_hash,account_id,kind,label,expires_at) VALUES(?,?,?,?,?,?)', randomUUID(), hash(token), accountId, kind, label, expiresAt);
    return { token, expiresAt };
  }
  private cookie(res: ServerResponse, token: string, maxAge: number): void {
    res.setHeader('Set-Cookie', `tablemesh_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.config.secureCookies ? '; Secure' : ''}`);
  }
  private ledger(accountId: string, delta: number, heldDelta: number, reason: string, source: string): void {
    if (this.store.one('SELECT id FROM ledger WHERE source_key=?', source)) return;
    const changed = this.store.run('UPDATE wallets SET available=available+?,held=held+? WHERE account_id=? AND available+?>=0 AND held+?>=0 AND available+?<=1000000000 AND held+?<=1000000000', delta, heldDelta, accountId, delta, heldDelta, delta, heldDelta);
    if (Number(changed.changes) !== 1) fail('INSUFFICIENT_POINTS', 'Insufficient available points', 409);
    this.store.run('INSERT INTO ledger(id,account_id,delta,held_delta,reason,source_key,created_at) VALUES(?,?,?,?,?,?,?)', randomUUID(), accountId, delta, heldDelta, reason, source, this.config.now());
  }
  private room(id: string): RoomRow {
    const row = this.store.one<RoomRow>('SELECT * FROM rooms WHERE id=?', id);
    if (!row) fail('NOT_FOUND', 'Room not found', 404);
    return row;
  }
  private engine(room: RoomRow): HoldemEngineState { return JSON.parse(room.engine_json) as HoldemEngineState; }
  private snapshot(room: RoomRow, identity: Identity): RoomSnapshot {
    const state = this.engine(room);
    const game = getPublicState(state);
    const seat = game.seats.find(seat => seat.accountId === identity.accountId)?.seat ?? null;
    // Explicit DTO assembly: the complete engine record never leaves this service.
    return {
      id: room.id, name: room.name, ownerAccountId: room.owner_account_id,
      stateVersion: room.state_version, eventCursor: room.event_cursor, config: state.config, game,
      abandonedAccountIds: this.abandoned(state, room.id),
      you: { accountId: identity.accountId, seat, privateState: seat === null ? null : getPrivateState(state, seat), legalActions: seat === null ? [] : getLegalActions(state, seat) }
    };
  }
  private request(accountId: string, operation: string, resourceId: string, body: Record<string, unknown>): { requestId: string; bodyHash: string; prior: Record<string, unknown> | null } {
    const requestId = text(body.requestId, 'requestId', 128);
    const bodyHash = operation === 'inventory'
      ? createHmac('sha256', this.config.inventoryKey!).update('request:').update(canonical(body)).digest('hex')
      : hash(canonical(body));
    const row = this.store.one<{ body_hash: string; result_json: string }>('SELECT body_hash,result_json FROM requests WHERE account_id=? AND operation=? AND resource_id=? AND request_id=?', accountId, operation, resourceId, requestId);
    if (row && row.body_hash !== bodyHash) fail('REQUEST_ID_CONFLICT', 'requestId was already used with a different payload', 409);
    return { requestId, bodyHash, prior: row ? object(JSON.parse(row.result_json)) : null };
  }
  private recordRequest(accountId: string, operation: string, resourceId: string, requestId: string, bodyHash: string, result: unknown): void {
    this.store.run('INSERT INTO requests VALUES(?,?,?,?,?,?)', accountId, operation, resourceId, requestId, bodyHash, JSON.stringify(result));
  }
  private reduce(result: EngineResult, roomId: string): HoldemEngineState {
    const state = unwrap(result);
    // Only this transition's settlement is accepted; an old public summary is
    // never interpreted as a new payout or result. This runs in the command tx.
    if (result.ok && result.transition.settlement) {
      const participants = getPublicState(state).seats.map(({ seat, accountId, displayName }) => ({ seat, accountId, displayName }));
      this.store.run('INSERT OR IGNORE INTO hand_settlements(room_id,hand_id,result_json,participants_json,created_at) VALUES(?,?,?,?,?)',
        roomId, result.transition.settlement.handId, JSON.stringify(result.transition.settlement), JSON.stringify(participants), this.config.now());
    }
    return state;
  }
  private persistRoom(row: RoomRow, state: HoldemEngineState, eventType: string, payload: Json): RoomRow {
    const version = row.state_version + 1;
    const records = this.store.all<{ hand_id: string; result_json: string; participants_json: string }>('SELECT * FROM hand_settlements WHERE room_id=? AND published=0 ORDER BY created_at', row.id);
    const cursor = row.event_cursor + 1 + records.length;
    const changed = this.store.run('UPDATE rooms SET engine_json=?,state_version=?,event_cursor=?,updated_at=? WHERE id=? AND state_version=?', JSON.stringify(state), version, cursor, this.config.now(), row.id, row.state_version);
    if (Number(changed.changes) !== 1) fail('VERSION_CONFLICT', 'Room changed; observe again', 409, this.room(row.id).state_version);
    this.store.run('INSERT INTO room_events VALUES(?,?,?,?,?)', row.id, row.event_cursor + 1, version, eventType, JSON.stringify(payload));
    records.forEach((record, index) => {
      const summary = { handId: record.hand_id, participants: JSON.parse(record.participants_json), settlement: JSON.parse(record.result_json) };
      this.store.run('INSERT INTO room_events VALUES(?,?,?,?,?)', row.id, row.event_cursor + 2 + index, version, 'hand_settled', JSON.stringify(summary));
      this.store.run('UPDATE hand_settlements SET published=1 WHERE room_id=? AND hand_id=?', row.id, record.hand_id);
    });
    return this.room(row.id);
  }
  private version(body: Record<string, unknown>, row: RoomRow): void {
    if (integer(body.stateVersion, 'stateVersion') !== row.state_version) fail('VERSION_CONFLICT', 'Room changed; observe again before deciding', 409, row.state_version);
  }
  private abandoned(state: HoldemEngineState, roomId: string): string[] {
    const game = getPublicState(state);
    if (!game.handId || game.phase === 'complete' || game.phase === 'waiting') return [];
    return this.store.all<{ account_id: string }>('SELECT account_id FROM room_abandons WHERE room_id=? AND hand_id=?', roomId, game.handId).map(row => row.account_id);
  }
  private recordAbandon(roomId: string, handId: string, accountId: string, seat: number, now: number): boolean {
    if (this.store.one('SELECT account_id FROM room_abandons WHERE room_id=? AND hand_id=? AND account_id=?', roomId, handId, accountId)) return false;
    const repeats = this.store.one<{ n: number }>('SELECT COUNT(*) n FROM room_abandons WHERE account_id=? AND created_at>?', accountId, now - 24 * 60 * 60 * 1000)!.n;
    const reputationDelta = repeats ? -20 : -10;
    const cooldownUntil = now + (repeats ? 15 : 5) * 60 * 1000;
    this.store.run('INSERT INTO room_abandons VALUES(?,?,?,?,?,?,?)', roomId, handId, accountId, seat, now, reputationDelta, cooldownUntil);
    this.store.run('UPDATE fair_play SET reputation=MAX(0,reputation+?),cooldown_until=MAX(cooldown_until,?) WHERE account_id=?', reputationDelta, cooldownUntil, accountId);
    this.store.run('INSERT INTO admin_audit VALUES(?,?,?,?)', randomUUID(), 'confirmed_abandonment', `${accountId}:${roomId}:${handId}:${reputationDelta}:${cooldownUntil}`, now);
    return true;
  }
  private settleAbandons(state: HoldemEngineState, roomId: string, now: number): HoldemEngineState {
    let current = state;
    // Consume only current legal actor windows; folded/all-in seats need no action.
    for (let n = 0; n < current.config.maxSeats; n++) {
      const game = getPublicState(current);
      const window = game.window;
      if (!window || game.phase === 'complete' || now >= window.deadline) break;
      const actor = game.seats.find(seat => seat.seat === game.actorSeat);
      if (!actor || actor.status !== 'active' || !this.abandoned(current, roomId).includes(actor.accountId)) break;
      current = this.reduce(applyAction(current, { seat: actor.seat, action: { type: 'fold' }, windowId: window.id, now }), roomId);
    }
    const game = getPublicState(current);
    if (game.phase === 'complete' && game.handId) {
      const ids = this.store.all<{ account_id: string }>('SELECT account_id FROM room_abandons WHERE room_id=? AND hand_id=?', roomId, game.handId).map(row => row.account_id);
      if (ids.length && game.seats.some(seat => ids.includes(seat.accountId))) {
        const remaining = game.seats.filter(seat => !ids.includes(seat.accountId)).map(({ seat, accountId, displayName }) => ({ seat, accountId, displayName }));
        current = this.reduce(setSeats(current, remaining), roomId);
      }
    }
    return current;
  }
  private async roomMutation(identity: Identity, id: string, operation: string, body: Record<string, unknown>): Promise<RoomMutationResult> {
    return this.queue(id, () => {
      this.activeIdentity(identity);
      const now = this.config.now();
      const preflight = this.request(identity.accountId, operation, id, body);
      // Successful dedup wins first. For a new command, commit the autonomous
      // deadline transition separately; the command then meets the new version.
      if (!preflight.prior) this.expireRoom(id, now);
      return this.store.transaction(() => {
      const request = this.request(identity.accountId, operation, id, body);
      const row = this.room(id);
      if (request.prior) return { snapshot: this.snapshot(row, identity), replayed: true };
      this.version(body, row);
      let state = this.engine(row);
      const current = getPublicState(state);
      const own = current.seats.find(seat => seat.accountId === identity.accountId);
      if (operation === 'join' || operation === 'leave') {
        exactKeys(body, operation === 'join' ? ['seat', 'stateVersion', 'requestId'] : ['stateVersion', 'requestId', 'confirmAbandon']);
        const live = current.phase !== 'waiting' && current.phase !== 'complete';
        if (live && operation === 'join') fail('ILLEGAL_ACTION', 'Participants and seats are locked until settlement', 409);
        if (live && operation === 'leave') {
          if (!own) fail('FORBIDDEN', 'This account does not own a seat', 403);
          if (body.confirmAbandon !== true) fail('ILLEGAL_ACTION', 'Confirm abandonment explicitly: reputation and new-game cooldown penalties apply', 409);
          if (!current.handId) fail('ILLEGAL_ACTION', 'No active hand');
          const recorded = this.recordAbandon(id, current.handId, identity.accountId, own.seat, now);
          if (!recorded) {
            this.recordRequest(identity.accountId, operation, id, request.requestId, request.bodyHash, { roomId: id, acceptedStateVersion: row.state_version });
            return { snapshot: this.snapshot(row, identity), replayed: false };
          }
          state = this.settleAbandons(state, id, now);
        } else {
        const seats = current.seats.map(({ seat, accountId, displayName }) => ({ seat, accountId, displayName }));
        if (operation === 'join') {
          this.enteringAllowed(identity.accountId);
          if (own) fail('ILLEGAL_ACTION', 'This account already has a seat', 409);
          const seat = body.seat === undefined ? Array.from({ length: state.config.maxSeats }, (_, n) => n).find(n => !seats.some(seat => seat.seat === n)) : integer(body.seat, 'seat', 0, state.config.maxSeats - 1);
          if (seat === undefined || seats.some(item => item.seat === seat)) fail('ROOM_FULL', 'No requested seat is available', 409);
          seats.push({ seat, accountId: identity.accountId, displayName: this.account(identity.accountId).displayName });
          state = this.reduce(setSeats(state, seats), id);
        } else {
          if (!own) fail('FORBIDDEN', 'This account does not own a seat', 403);
          state = this.reduce(setSeats(state, seats.filter(seat => seat.accountId !== identity.accountId)), id);
        }
        }
      } else if (operation === 'start') {
        exactKeys(body, ['stateVersion', 'requestId']);
        if (row.owner_account_id !== identity.accountId) fail('FORBIDDEN', 'Only the owner can start a hand', 403);
        this.enteringAllowed(identity.accountId);
        for (const seat of current.seats) this.enteringAllowed(seat.accountId);
        state = this.reduce(startHand(state, { handId: randomUUID(), deck: shuffleDeck(), now }), id);
      } else {
        exactKeys(body, ['stateVersion', 'requestId', 'windowId', 'action']);
        if (!own) fail('FORBIDDEN', 'A seat belonging to this account is required', 403);
        const windowId = text(body.windowId, 'windowId', 128);
        if (!current.window || current.window.id !== windowId || !current.window.eligibleSeats.includes(own.seat)) fail('ILLEGAL_ACTION', 'This seat has no matching action window');
        if (now >= current.window.deadline) fail('ILLEGAL_ACTION', 'Action deadline passed; observe again', 409);
        const action = object(body.action);
        exactKeys(action, action.type === 'raise' ? ['type', 'amount'] : ['type']);
        if (!['fold', 'check', 'call', 'raise'].includes(String(action.type))) fail('INVALID_INPUT', 'Invalid action type');
        const validated = action.type === 'raise' ? { type: 'raise' as const, amount: integer(action.amount, 'amount') } : { type: action.type as 'fold' | 'check' | 'call' };
        state = this.reduce(applyAction(state, { seat: own.seat, action: validated, windowId, now }), id);
      }
      state = this.settleAbandons(state, id, now);
      const updated = this.persistRoom(row, state, `room_${operation}`, { phase: getPublicState(state).phase, actorSeat: own?.seat ?? null });
      this.recordRequest(identity.accountId, operation, id, request.requestId, request.bodyHash, { roomId: id, acceptedStateVersion: updated.state_version });
      return { snapshot: this.snapshot(updated, identity), replayed: false };
      });
    });
  }
  private expireRoom(roomId: string, now: number): boolean {
    return this.store.transaction(() => {
      const latest = this.room(roomId);
      const current = this.engine(latest);
      const active = getPublicState(current).window;
      if (!active || active.deadline > now) return false;
      const requestId = `timeout:${roomId}:${active.id}`;
      if (this.store.one('SELECT request_id FROM requests WHERE account_id=? AND operation=? AND resource_id=? AND request_id=?', 'server', 'timeout', roomId, requestId)) return false;
      const state = this.settleAbandons(this.reduce(applyTimeout(current, now), roomId), roomId, now);
      const updated = this.persistRoom(latest, state, 'room_timeout', { windowId: active.id, phase: getPublicState(state).phase });
      this.recordRequest('server', 'timeout', roomId, requestId, hash(active.id), { acceptedStateVersion: updated.state_version });
      return true;
    });
  }
  async runTimeouts(): Promise<void> {
    if (this.closing) return;
    for (const row of this.store.all<RoomRow>('SELECT * FROM rooms')) {
      if (this.closing) return;
      const window = getPublicState(this.engine(row)).window;
      if (!window || window.deadline > this.config.now()) continue;
      await this.queue(row.id, () => this.expireRoom(row.id, this.config.now()));
    }
  }
  private rewardMode(sandbox: number | boolean): void {
    if (!this.config.inventoryKey) fail('REWARDS_DISABLED', 'Inventory encryption is not configured', 503);
    if (!sandbox && !this.config.realRewardsEnabled) fail('REWARDS_DISABLED', 'Real rewards are disabled', 503);
  }
  private encryptCode(code: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.inventoryKey!, nonce);
    const data = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return JSON.stringify({ nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  private decryptCode(value: string): string {
    const encrypted = JSON.parse(value) as { nonce: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.config.inventoryKey!, Buffer.from(encrypted.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8');
  }
  private redemption(row: RedemptionRow): RedemptionView {
    return { id: row.id, productId: row.product_id, pointsCost: row.points_cost, status: row.status, sandbox: Boolean(row.sandbox), createdAt: row.created_at };
  }
  private importInventory(body: Record<string, unknown>): { imported: number } {
    exactKeys(body, ['product', 'codes', 'requestId']);
    const product = object(body.product);
    exactKeys(product, ['id', 'name', 'pointsCost', 'sandbox']);
    const id = text(product.id, 'product id', 64);
    const name = text(product.name, 'product name', 100);
    const pointsCost = integer(product.pointsCost, 'pointsCost', 1);
    if (typeof product.sandbox !== 'boolean') fail('INVALID_INPUT', 'Product must explicitly declare sandbox mode');
    this.rewardMode(product.sandbox);
    if (!Array.isArray(body.codes) || body.codes.length < 1 || body.codes.length > 500) fail('INVALID_INPUT', 'Import 1–500 codes');
    const codes = body.codes.map(code => text(code, 'inventory code', 512));
    const fingerprints = codes.map(code => createHmac('sha256', this.config.inventoryKey!).update('inventory:').update(code).digest('hex'));
    if (new Set(fingerprints).size !== fingerprints.length) fail('INVALID_INPUT', 'Duplicate inventory entries');
    return this.store.transaction(() => {
      const request = this.request('ops', 'inventory', id, body);
      if (request.prior) return { imported: Number(request.prior.imported) };
      if (fingerprints.some(fingerprint => this.store.one('SELECT id FROM inventory WHERE code_fingerprint=?', fingerprint))) fail('INVALID_INPUT', 'Inventory entry already exists');
      const existing = this.store.one<ProductRow>('SELECT * FROM products WHERE id=?', id);
      if (existing && (existing.name !== name || existing.points_cost !== pointsCost || Boolean(existing.sandbox) !== product.sandbox)) fail('INVALID_INPUT', 'Existing product metadata must match');
      if (!existing) this.store.run('INSERT INTO products(id,name,points_cost,sandbox) VALUES(?,?,?,?)', id, name, pointsCost, Number(product.sandbox));
      codes.forEach((code, index) => this.store.run('INSERT INTO inventory(id,product_id,code_ciphertext,code_fingerprint,key_version,status) VALUES(?,?,?,?,?,?)', randomUUID(), id, this.encryptCode(code), fingerprints[index]!, 'v1', 'available'));
      this.store.run('INSERT INTO admin_audit VALUES(?,?,?,?)', randomUUID(), 'inventory_import', `${id}:${codes.length}`, this.config.now());
      this.recordRequest('ops', 'inventory', id, request.requestId, request.bodyHash, { imported: codes.length });
      return { imported: codes.length };
    });
  }
  private redeem(identity: Identity, body: Record<string, unknown>): RedemptionView {
    exactKeys(body, ['productId', 'requestId']);
    const productId = text(body.productId, 'productId', 64);
    const requestId = text(body.requestId, 'requestId', 128);
    const bodyHash = hash(canonical(body));
    return this.store.transaction(() => {
      const prior = this.store.one<RedemptionRow>('SELECT * FROM redemptions WHERE account_id=? AND request_id=?', identity.accountId, requestId);
      if (prior) { if (prior.body_hash !== bodyHash) fail('REQUEST_ID_CONFLICT', 'requestId already used with different payload', 409); return this.redemption(prior); }
      const product = this.store.one<ProductRow>('SELECT * FROM products WHERE id=? AND enabled=1', productId);
      if (!product) fail('NOT_FOUND', 'Product not found', 404);
      this.rewardMode(product.sandbox);
      if (this.account(identity.accountId).points < product.points_cost) fail('INSUFFICIENT_POINTS', 'Insufficient available points', 409);
      const stock = this.store.one<{ id: string }>('SELECT id FROM inventory WHERE product_id=? AND status=? ORDER BY rowid LIMIT 1', productId, 'available');
      if (!stock) fail('OUT_OF_STOCK', 'No inventory remains', 409);
      const id = randomUUID();
      this.store.run('INSERT INTO redemptions VALUES(?,?,?,?,?,?,?,?,?)', id, identity.accountId, productId, product.points_cost, 'pending', product.sandbox, requestId, bodyHash, this.config.now());
      const changed = this.store.run('UPDATE inventory SET status=?,redemption_id=? WHERE id=? AND status=?', 'fulfilled', id, stock.id, 'available');
      if (Number(changed.changes) !== 1) fail('OUT_OF_STOCK', 'Inventory was already allocated', 409);
      this.ledger(identity.accountId, -product.points_cost, product.points_cost, 'sandbox redemption reserve', `reserve:${id}`);
      this.ledger(identity.accountId, 0, -product.points_cost, 'sandbox redemption capture', `capture:${id}`);
      this.store.run('UPDATE redemptions SET status=? WHERE id=?', 'fulfilled', id);
      return this.redemption(this.store.one<RedemptionRow>('SELECT * FROM redemptions WHERE id=?', id)!);
    });
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method ?? 'GET';
      if (path === '/mcp') { await this.mcp(req, res); return; }
      const mutation = ['POST', 'DELETE', 'PUT', 'PATCH'].includes(method);
      if (mutation) this.origin(req, req.headers.authorization === undefined);
      const body = mutation && method !== 'DELETE' ? await readJson(req) : {};
      let data: unknown;
      if (method === 'GET' && path === '/api/health') data = { status: 'ok', sandbox: true, inventoryConfigured: Boolean(this.config.inventoryKey), realRewardsEnabled: this.config.realRewardsEnabled };
      else if (method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
        this.origin(req, true);
        this.authRate(req, path);
        exactKeys(body, ['displayName', 'password']);
        const displayName = text(body.displayName, 'displayName', 32);
        const normalized = displayName.toLocaleLowerCase('en-US');
        const value = password(body.password);
        let row = this.store.one<AccountRow>('SELECT * FROM accounts WHERE normalized_name=?', normalized);
        if (path.endsWith('register')) {
          if (row) fail('INVALID_INPUT', 'Display name already registered', 409);
          const encoded = await passwordHash(value);
          const accountId = randomUUID();
          const session = this.store.transaction(() => {
            if (this.store.one('SELECT id FROM accounts WHERE normalized_name=?', normalized)) fail('INVALID_INPUT', 'Display name already registered', 409);
            this.store.run('INSERT INTO accounts VALUES(?,?,?,?,?)', accountId, normalized, displayName, encoded, this.config.now());
            this.store.run('INSERT INTO wallets VALUES(?,?,?)', accountId, 0, 0);
            this.ledger(accountId, this.config.starterPoints, 0, 'sandbox starter points', `starter:${accountId}:v0`);
            return this.issueSession(accountId, 'web', 'web session');
          });
          this.cookie(res, session.token, Math.floor(this.config.sessionTtlMs / 1000));
          data = { account: this.account(accountId), expiresAt: session.expiresAt };
        } else {
          if (!row || !await passwordMatches(value, row.password_hash)) fail('UNAUTHENTICATED', 'Invalid credentials', 401);
          const session = this.store.transaction(() => this.issueSession(row.id, 'web', 'web session'));
          this.cookie(res, session.token, Math.floor(this.config.sessionTtlMs / 1000));
          data = { account: this.account(row.id), expiresAt: session.expiresAt };
        }
      } else if (path.startsWith('/api/ops/')) {
        if (!this.config.adminToken || !req.headers.authorization?.startsWith('Bearer ') || !sameSecret(req.headers.authorization.slice(7), this.config.adminToken)) fail('FORBIDDEN', 'Operations authorization required', 403);
        if (method === 'POST' && path === '/api/ops/inventory') data = this.importInventory(body);
        else if (method === 'GET' && path === '/api/ops/redemptions') data = this.store.all<RedemptionRow>('SELECT * FROM redemptions ORDER BY created_at DESC').map(row => ({ ...this.redemption(row), accountId: row.account_id }));
        else fail('NOT_FOUND', 'Endpoint not found', 404);
      } else {
        const identity = this.identity(req);
        if (path.startsWith('/api/rewards/') || path.startsWith('/api/auth/') || path === '/api/agent-connection') this.webOnly(identity);
        if (method === 'GET' && path === '/api/account') data = this.account(identity.accountId);
        else if (method === 'GET' && path === '/api/agent-connection') data = this.agentConnection();
        else if (method === 'POST' && path === '/api/auth/logout') {
          exactKeys(body, []);
          this.store.run('UPDATE sessions SET revoked_at=? WHERE id=?', this.config.now(), identity.sessionId);
          this.cookie(res, '', 0); data = { loggedOut: true };
        } else if (method === 'POST' && path === '/api/auth/tokens') {
          exactKeys(body, ['label']);
          data = this.store.transaction(() => this.issueSession(identity.accountId, 'game', text(body.label, 'token label', 64)));
        } else if (method === 'GET' && path === '/api/auth/tokens') data = this.store.all<{ id: string; label: string; expires_at: number }>('SELECT id,label,expires_at FROM sessions WHERE account_id=? AND kind=? AND revoked_at IS NULL AND expires_at>?', identity.accountId, 'game', this.config.now()).map(row => ({ id: row.id, label: row.label, expiresAt: row.expires_at }));
        else if (method === 'DELETE' && path.startsWith('/api/auth/tokens/')) {
          const id = path.slice('/api/auth/tokens/'.length);
          const changed = this.store.run('UPDATE sessions SET revoked_at=? WHERE id=? AND account_id=? AND kind=? AND revoked_at IS NULL', this.config.now(), id, identity.accountId, 'game');
          if (!Number(changed.changes)) fail('NOT_FOUND', 'Token not found', 404);
          data = { revoked: true };
        } else if (method === 'GET' && path === '/api/points') data = { account: this.account(identity.accountId), entries: this.store.all<{ id: string; delta: number; held_delta: number; reason: string; created_at: number }>('SELECT * FROM ledger WHERE account_id=? ORDER BY rowid DESC LIMIT 200', identity.accountId).map((row): PointsEntry => ({ id: row.id, delta: row.delta, heldDelta: row.held_delta, reason: row.reason, createdAt: row.created_at })) };
        else if (method === 'GET' && path === '/api/rooms') data = this.store.all<RoomRow>('SELECT * FROM rooms ORDER BY updated_at DESC').map(row => { const state = this.engine(row); const game = getPublicState(state); return { id: row.id, name: row.name, gameId: state.config.gameId, occupiedSeats: game.seats.length, maxSeats: state.config.maxSeats, phase: game.phase }; });
        else if (method === 'POST' && path === '/api/rooms') data = this.store.transaction(() => {
          exactKeys(body, ['name', 'config', 'requestId']);
          const request = this.request(identity.accountId, 'create', 'rooms', body);
          if (request.prior) return { snapshot: this.snapshot(this.room(String(request.prior.roomId)), identity), replayed: true };
          const id = randomUUID();
          this.enteringAllowed(identity.accountId);
          const state = createTable(gameConfig(body.config), []);
          this.store.run('INSERT INTO rooms VALUES(?,?,?,?,?,?,?)', id, text(body.name, 'room name', 80), identity.accountId, JSON.stringify(state), 0, 0, this.config.now());
          this.recordRequest(identity.accountId, 'create', 'rooms', request.requestId, request.bodyHash, { roomId: id });
          return { snapshot: this.snapshot(this.room(id), identity), replayed: false };
        });
        else if (path.startsWith('/api/rooms/')) {
          const match = /^\/api\/rooms\/([^/]+)(?:\/(join|leave|start|actions|events|wait))?$/u.exec(path);
          if (!match) fail('NOT_FOUND', 'Endpoint not found', 404);
          const id = match[1]!; const operation = match[2];
          if (method === 'GET' && !operation) data = this.snapshot(this.room(id), identity);
          else if (method === 'GET' && operation === 'wait') data = await this.waitForRoom(identity, id, new URL(req.url!, 'http://localhost'), req, res);
          else if (method === 'GET' && operation === 'events') {
            const row = this.room(id);
            const raw = new URL(req.url!, 'http://localhost').searchParams.get('after');
            const after = raw === null ? 0 : integer(Number(raw), 'after');
            const reset = after > row.event_cursor;
            const events = this.store.all<{ cursor: number; state_version: number; type: string; public_payload_json: string }>('SELECT * FROM room_events WHERE room_id=? AND cursor>? ORDER BY cursor LIMIT 200', id, reset ? 0 : after).map(event => ({ cursor: event.cursor, stateVersion: event.state_version, type: event.type, payload: JSON.parse(event.public_payload_json) as Json }));
            data = { events, snapshot: this.snapshot(row, identity), reset };
          } else if (method === 'POST' && operation && !['events', 'wait'].includes(operation)) data = await this.roomMutation(identity, id, operation === 'actions' ? 'action' : operation, body);
          else fail('NOT_FOUND', 'Endpoint not found', 404);
        } else if (method === 'GET' && path === '/api/rewards/products') data = this.store.all<ProductRow>('SELECT * FROM products WHERE enabled=1').filter(product => product.sandbox || this.config.realRewardsEnabled).map((row): RewardProduct => ({ id: row.id, name: row.name, pointsCost: row.points_cost, sandbox: Boolean(row.sandbox), available: this.store.one<{ n: number }>('SELECT COUNT(*) n FROM inventory WHERE product_id=? AND status=?', row.id, 'available')!.n }));
        else if (method === 'POST' && path === '/api/rewards/redemptions') data = this.redeem(identity, body);
        else if (method === 'GET' && path === '/api/rewards/redemptions') data = this.store.all<RedemptionRow>('SELECT * FROM redemptions WHERE account_id=? ORDER BY created_at DESC', identity.accountId).map(row => this.redemption(row));
        else if (method === 'GET' && path.startsWith('/api/rewards/redemptions/')) {
          const id = path.slice('/api/rewards/redemptions/'.length);
          const row = this.store.one<RedemptionRow>('SELECT * FROM redemptions WHERE id=? AND account_id=?', id, identity.accountId);
          if (!row) fail('NOT_FOUND', 'Order not found', 404);
          this.rewardMode(row.sandbox);
          const stock = this.store.one<{ code_ciphertext: string }>('SELECT code_ciphertext FROM inventory WHERE redemption_id=?', row.id);
          if (!stock || row.status !== 'fulfilled') fail('REWARDS_DISABLED', 'Order has not been fulfilled', 503);
          this.store.run('INSERT INTO admin_audit VALUES(?,?,?,?)', randomUUID(), 'owner_code_reveal', `${identity.accountId}:${id}`, this.config.now());
          data = { ...this.redemption(row), code: this.decryptCode(stock.code_ciphertext) };
        } else fail('NOT_FOUND', 'Endpoint not found', 404);
      }
      res.end(JSON.stringify({ ok: true, data } satisfies ApiResult<unknown>));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const failure = error instanceof AppError ? error : new AppError('INTERNAL', 'Server could not complete this request', 500);
      if (!(error instanceof AppError)) console.error('Tokem request failed');
      res.statusCode = failure.status;
      res.end(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, ...(failure.currentStateVersion === undefined ? {} : { currentStateVersion: failure.currentStateVersion }) } }));
    }
  }
}

export function createApplication(config: Partial<AppConfig> = {}): Application { return new Application(config); }
