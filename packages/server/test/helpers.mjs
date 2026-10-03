import { randomBytes, randomUUID } from 'node:crypto';
import { createApplication } from '../dist/app.js';

export const origin = 'http://127.0.0.1:5173';
export const defaultRoomConfig = { gameId: 'holdem', maxSeats: 2, initialStack: 1000, smallBlind: 5, bigBlind: 10, turnTimeoutMs: 30_000 };
export async function fixture(overrides = {}) {
  const config = { databasePath: ':memory:', port: 0, allowedOrigins: [origin, 'http://127.0.0.1:5174'], inventoryKey: randomBytes(32), adminToken: randomBytes(32).toString('base64url'), schedulerIntervalMs: 0, ...overrides };
  const app = createApplication(config);
  const url = await app.listen(0);
  function client(cookie = '', bearer = '') {
    return { cookie, bearer, async request(path, body, method = body === undefined ? 'GET' : 'POST', options = {}) {
      const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(method === 'GET' ? {} : { Origin: origin }), ...options.headers };
      const response = await fetch(url + '/api' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', cache: response.headers.get('cache-control') };
    } };
  }
  async function register(label = '玩家') {
    const displayName = label + randomUUID().slice(0, 8);
    const password = randomBytes(12).toString('base64url');
    const result = await client().request('/auth/register', { displayName, password });
    if (!result.body.ok) throw new Error(`Registration failed: ${result.body.error.code}`);
    return { ...client(result.cookie), account: result.body.data.account, displayName, password };
  }
  return { app, url, config, client, register, admin: client('', config.adminToken), close: () => app.close() };
}
export async function twoPlayerRoom(f, config = defaultRoomConfig) {
  const a = await f.register('甲'); const b = await f.register('乙');
  let result = await a.request('/rooms', { name: '测试牌桌', config, requestId: randomUUID() });
  let snapshot = result.body.data.snapshot;
  for (const player of [a, b]) {
    result = await player.request(`/rooms/${snapshot.id}/join`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() });
    if (!result.body.ok) throw new Error(result.body.error.code);
    snapshot = result.body.data.snapshot;
  }
  result = await a.request(`/rooms/${snapshot.id}/start`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() });
  if (!result.body.ok) throw new Error(result.body.error.code);
  return { a, b, id: snapshot.id, snapshot: result.body.data.snapshot };
}
export async function finishHand(room) {
  let snapshot = (await room.a.request(`/rooms/${room.id}`)).body.data;
  for (let i = 0; snapshot.game.phase !== 'complete' && i < 100; i++) {
    const actorId = snapshot.game.seats.find(seat => seat.seat === snapshot.game.actorSeat).accountId;
    const actor = actorId === room.a.account.id ? room.a : room.b;
    const own = (await actor.request(`/rooms/${room.id}`)).body.data;
    const move = own.you.legalActions.find(action => action.type === 'check') ?? own.you.legalActions.find(action => action.type === 'call') ?? own.you.legalActions[0];
    const result = await actor.request(`/rooms/${room.id}/actions`, { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: move.type } });
    if (!result.body.ok) throw new Error(result.body.error.code);
    snapshot = result.body.data.snapshot;
  }
  return snapshot;
}
export async function threePlayerRoom(f) {
  const players = await Promise.all(['甲', '乙', '丙'].map(label => f.register(label)));
  let snapshot = (await players[0].request('/rooms', { name: '锁席位测试', config: { ...defaultRoomConfig, maxSeats: 3 }, requestId: randomUUID() })).body.data.snapshot;
  for (const player of players) snapshot = (await player.request(`/rooms/${snapshot.id}/join`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() })).body.data.snapshot;
  snapshot = (await players[0].request(`/rooms/${snapshot.id}/start`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() })).body.data.snapshot;
  return { players, id: snapshot.id, snapshot };
}
