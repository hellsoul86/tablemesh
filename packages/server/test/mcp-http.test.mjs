import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, defaultRoomConfig, twoPlayerRoom } from './helpers.mjs';
import { mcpPublicUrl } from '../dist/config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, ms = 2000) {
  const end = performance.now() + ms;
  while (!check()) { if (performance.now() > end) assert.fail('Timed out waiting for a bounded test condition'); await delay(10); }
}
async function agent(t, f, player, label = 'test agent') {
  const minted = (await player.request('/auth/tokens', { label })).body.data;
  const client = new Client({ name: 'tokem-sdk-integration', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${minted.token}` }, redirect: 'error' } });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name, args = {}, options) => {
    const response = await client.callTool({ name, arguments: args }, undefined, options);
    assert.ok(response.structuredContent);
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.equal(response.isError, !response.structuredContent.ok);
    return response.structuredContent;
  };
  return { client, transport, call, token: minted.token, player };
}
function rpc(name = 'initialize', params = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }) {
  return { jsonrpc: '2.0', id: 1, method: name, params };
}
async function raw(f, token, body = rpc(), options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.url + '/mcp', { method: options.method ?? 'POST', headers: {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers
    } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('test RPC timeout')));
    req.end(options.method && options.method !== 'POST' ? undefined : JSON.stringify(body));
  });
}
async function waitingRoom(f, player) {
  return (await player.request('/rooms', { name: '等待测试', config: defaultRoomConfig, requestId: randomUUID() })).body.data.snapshot;
}
function assertPrivate(snapshot, owner, otherCards) {
  assert.equal(snapshot.you.accountId, owner.account.id);
  assert.equal(snapshot.you.privateState.holeCards.length, 2);
  for (const card of otherCards) assert.equal(JSON.stringify(snapshot).includes(`"${card}"`), false);
  assert.equal(JSON.stringify(snapshot).includes('engine_json'), false);
  assert.equal(JSON.stringify(snapshot).includes('code_ciphertext'), false);
  assert.equal(JSON.stringify(snapshot).includes('deck'), false);
}

test('two independent HTTP MCP agents and one manual seat complete a hand with private views and conserved chips', async t => {
  const f = await fixture(); t.after(f.close);
  const players = await Promise.all(['甲Agent', '乙Agent', '网页'].map(label => f.register(label)));
  const agents = await Promise.all(players.slice(0, 2).map(player => agent(t, f, player)));
  assert.equal((await agents[0].client.listTools()).tools.length, 13);
  assert.match(agents[0].client.getInstructions(), /shared|sharing/);
  let result = await agents[0].call('tablemesh_create_room', { name: '用户Agent同桌', config: { ...defaultRoomConfig, maxSeats: 3 }, requestId: randomUUID() });
  assert.equal(result.ok, true);
  let snapshot = result.data.snapshot; const roomId = snapshot.id;
  for (let i = 0; i < players.length; i++) {
    const body = { stateVersion: snapshot.stateVersion, requestId: randomUUID(), seat: i };
    result = i < 2 ? await agents[i].call('tablemesh_join_room', { roomId, ...body }) : (await players[i].request(`/rooms/${roomId}/join`, body)).body;
    assert.equal(result.ok, true); snapshot = result.data.snapshot;
  }
  result = await agents[0].call('tablemesh_start_hand', { roomId, stateVersion: snapshot.stateVersion, requestId: randomUUID() });
  assert.equal(result.ok, true); snapshot = result.data.snapshot;
  const privateCards = await Promise.all(players.map(async p => (await p.request(`/rooms/${roomId}`)).body.data.you.privateState.holeCards));
  const moves = [0, 0, 0];
  for (let i = 0; i < 60 && snapshot.game.phase !== 'complete'; i++) {
    for (let n = 0; n < 2; n++) {
      const view = await agents[n].call('tablemesh_observe', { roomId });
      assertPrivate(view.data, players[n], privateCards.filter((_, index) => index !== n).flat());
    }
    const actorId = snapshot.game.seats.find(seat => seat.seat === snapshot.game.actorSeat).accountId;
    const index = players.findIndex(p => p.account.id === actorId);
    const own = index < 2 ? (await agents[index].call('tablemesh_observe', { roomId })).data : (await players[index].request(`/rooms/${roomId}`)).body.data;
    if (index < 2) {
      const waited = await agents[index].call('tablemesh_wait_for_turn', { roomId, afterStateVersion: own.stateVersion, maxWaitMs: 500 });
      assert.equal(waited.data.reason, 'your_turn');
      assert.equal(waited.data.snapshot.you.accountId, players[index].account.id);
    }
    const legal = index < 2 ? (await agents[index].call('tablemesh_legal_actions', { roomId })).data.legalActions : own.you.legalActions;
    const move = legal.find(x => x.type === 'check') ?? legal.find(x => x.type === 'call');
    assert.ok(move);
    const body = { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: move.type } };
    result = index < 2 ? await agents[index].call('tablemesh_act', { roomId, ...body }) : (await players[index].request(`/rooms/${roomId}/actions`, body)).body;
    assert.equal(result.ok, true); moves[index]++; snapshot = result.data.snapshot;
  }
  assert.equal(snapshot.game.phase, 'complete');
  assert.equal(moves.every(n => n > 0), true);
  assert.equal(snapshot.game.seats.reduce((sum, seat) => sum + seat.stack, 0), 3000);
  const settled = await agents[1].call('tablemesh_wait_for_turn', { roomId, afterStateVersion: snapshot.stateVersion, maxWaitMs: 500 });
  assert.equal(settled.data.reason, 'hand_complete');
  for (let i = 0; i < 2; i++) {
    assert.equal((await agents[i].call('tablemesh_account')).data.points, 1000);
    assert.equal((await agents[i].call('tablemesh_account')).data.fairPlay.reputation, 100);
  }
});

test('HTTP MCP requires game bearer on every request and enforces Host, Origin, methods and 64KiB bodies', async t => {
  const f = await fixture(); t.after(f.close);
  const p = await f.register(); const a = await agent(t, f, p);
  assert.equal((await raw(f, '')).status, 401);
  assert.equal((await raw(f, '', rpc(), { headers: { Cookie: p.cookie } })).status, 401);
  assert.equal((await raw(f, p.cookie.split('=')[1])).status, 401);
  assert.equal((await raw(f, a.token, rpc(), { headers: { Host: 'attacker.invalid' } })).status, 403);
  assert.equal((await raw(f, a.token, rpc(), { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  for (const method of ['GET', 'DELETE']) assert.equal((await raw(f, a.token, undefined, { method })).status, 405);
  assert.equal((await raw(f, a.token, { ...rpc(), padding: 'x'.repeat(65_536) })).status, 413);
  const tokenRow = f.app.store.one('SELECT id FROM sessions WHERE account_id=? AND kind=?', p.account.id, 'game');
  assert.equal((await p.request('/auth/tokens/' + tokenRow.id, undefined, 'DELETE')).body.ok, true);
  await assert.rejects(a.call('tablemesh_account'));
  const expired = await agent(t, f, p, 'expired');
  f.app.store.run('UPDATE sessions SET expires_at=0 WHERE account_id=? AND kind=?', p.account.id, 'game');
  await assert.rejects(expired.call('tablemesh_lobby'));
});

test('connection metadata is web-only, trusts configured URL or actual listener, and never request headers', async t => {
  const f = await fixture(); t.after(f.close);
  const p = await f.register(); const a = await agent(t, f, p);
  const metadata = await p.request('/agent-connection', undefined, 'GET', { headers: { Host: 'wrong.invalid', 'X-Forwarded-Host': 'wrong.invalid' } });
  assert.deepEqual(metadata.body.data, { mcpUrl: f.url + '/mcp', transport: 'streamable-http', authentication: 'game-bearer', tokenEnvVar: 'TABLEMESH_TOKEN', maxWaitMs: 25000 });
  assert.equal((await f.client('', a.token).request('/agent-connection')).status, 403);
  const remote = await fixture({ host: '0.0.0.0' }); t.after(remote.close);
  const rp = await remote.register();
  assert.equal((await rp.request('/agent-connection')).body.data.mcpUrl, null);
  const explicit = await fixture({ mcpPublicUrl: 'https://tokem.example/mcp' }); t.after(explicit.close);
  const ep = await explicit.register();
  assert.equal((await ep.request('/agent-connection')).body.data.mcpUrl, 'https://tokem.example/mcp');
  const et = (await ep.request('/auth/tokens', { label: 'explicit host' })).body.data.token;
  assert.equal((await raw(explicit, et, rpc(), { headers: { Host: 'tokem.example' } })).status, 200);
  for (const bad of ['http://private.example/mcp', 'http://192.168.0.2/mcp', 'https://x/mcp?q=x', 'https://x/mcp#x', 'https://user:secret@x/mcp', 'https://x/api', 'file:///mcp']) assert.throws(() => mcpPublicUrl(bad));
});

test('wait releases on timeout, change, revoke and disconnect without leaving or imposing penalties', async t => {
  const f = await fixture(); t.after(f.close);
  const p = await f.register(); const a = await agent(t, f, p);
  let snapshot = await waitingRoom(f, p);
  const query = `/rooms/${snapshot.id}/wait?afterStateVersion=${snapshot.stateVersion}&maxWaitMs=25000`;
  const headers = { Authorization: `Bearer ${a.token}` };
  const pending = () => f.app.waiterCount;
  const one = new AbortController(); const two = new AbortController();
  const first = fetch(f.url + '/api' + query, { headers, signal: one.signal }).catch(() => null);
  const second = fetch(f.url + '/api' + query, { headers, signal: two.signal }).catch(() => null);
  await eventually(() => pending() === 2);
  assert.equal((await fetch(f.url + '/api' + query, { headers })).status, 429);
  one.abort(); two.abort(); await Promise.all([first, second]);
  await eventually(() => pending() === 0);
  const timeout = await a.call('tablemesh_wait_for_turn', { roomId: snapshot.id, afterStateVersion: snapshot.stateVersion, maxWaitMs: 40 });
  assert.equal(timeout.data.reason, 'timeout');
  const change = a.call('tablemesh_wait_for_turn', { roomId: snapshot.id, afterStateVersion: snapshot.stateVersion, maxWaitMs: 2000 });
  await eventually(() => pending() === 1);
  const joined = await p.request(`/rooms/${snapshot.id}/join`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() });
  assert.equal(joined.body.ok, true);
  const changed = await change;
  assert.equal(changed.data.reason, 'state_changed');
  assert.equal(changed.data.snapshot.stateVersion, joined.body.data.snapshot.stateVersion);
  assert.equal(changed.data.snapshot.you.seat, 0);
  const current = changed.data.snapshot;
  const revoked = a.call('tablemesh_wait_for_turn', { roomId: snapshot.id, afterStateVersion: current.stateVersion, maxWaitMs: 2000 });
  await eventually(() => pending() === 1);
  const tokenRow = f.app.store.one('SELECT id FROM sessions WHERE account_id=? AND kind=?', p.account.id, 'game');
  await p.request('/auth/tokens/' + tokenRow.id, undefined, 'DELETE');
  assert.equal((await revoked).error.code, 'UNAUTHENTICATED');
  assert.equal(pending(), 0);
  assert.equal((await p.request('/account')).body.data.fairPlay.reputation, 100);
  assert.equal((await p.request(`/rooms/${snapshot.id}`)).body.data.you.seat, 0);
  assert.equal((await p.request('/account')).body.data.points, 1000);
});

test('HTTP Agent stale action loses to manual action, successful retry dedups, locked seats and explicit penalty remain', async t => {
  const f = await fixture(); t.after(f.close);
  const room = await twoPlayerRoom(f);
  const a = await agent(t, f, room.a);
  const initial = (await a.call('tablemesh_observe', { roomId: room.id })).data;
  const body = { stateVersion: initial.stateVersion, windowId: initial.game.window.id, requestId: 'manual-first', action: { type: 'call' } };
  assert.equal((await room.a.request(`/rooms/${room.id}/actions`, body)).body.ok, true);
  const stale = await a.call('tablemesh_act', { roomId: room.id, ...body, requestId: 'agent-old' });
  assert.equal(stale.error.code, 'VERSION_CONFLICT');
  const replay = await a.call('tablemesh_act', { roomId: room.id, ...body });
  assert.equal(replay.ok, true); assert.equal(replay.data.replayed, true);
  const changedPayload = await a.call('tablemesh_act', { roomId: room.id, ...body, action: { type: 'fold' } });
  assert.equal(changedPayload.error.code, 'REQUEST_ID_CONFLICT');
  const third = await f.register('替补'); const c = await agent(t, f, third);
  const snapshot = (await a.call('tablemesh_observe', { roomId: room.id })).data;
  assert.equal((await c.call('tablemesh_join_room', { roomId: room.id, stateVersion: snapshot.stateVersion, requestId: randomUUID() })).error.code, 'ILLEGAL_ACTION');
  const leaveBody = { roomId: room.id, stateVersion: snapshot.stateVersion, requestId: 'abandon' };
  assert.equal((await a.call('tablemesh_leave_room', leaveBody)).error.code, 'ILLEGAL_ACTION');
  assert.equal((await a.call('tablemesh_account')).data.fairPlay.reputation, 100);
  assert.equal((await a.call('tablemesh_leave_room', { ...leaveBody, confirmAbandon: true })).ok, true);
  const fair = (await a.call('tablemesh_account')).data.fairPlay;
  assert.equal(fair.reputation, 90); assert.equal(fair.abandonCount, 1);
  assert.equal((await a.call('tablemesh_leave_room', { ...leaveBody, confirmAbandon: true })).data.replayed, true);
  assert.equal((await a.call('tablemesh_account')).data.fairPlay.abandonCount, 1);
  assert.equal((await a.call('tablemesh_points')).data.account.points, 1000);
});

test('wait observes normal persisted deadline timeout with a fresh private snapshot and does not act itself', async t => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now }); t.after(f.close);
  const room = await twoPlayerRoom(f, { ...defaultRoomConfig, turnTimeoutMs: 1000 });
  const b = await agent(t, f, room.b);
  const pending = b.call('tablemesh_wait_for_turn', { roomId: room.id, afterStateVersion: room.snapshot.stateVersion, maxWaitMs: 2000 });
  await eventually(() => f.app.waiterCount === 1);
  now = room.snapshot.game.window.deadline;
  await f.app.runTimeouts();
  const result = await pending;
  assert.equal(result.data.reason, 'hand_complete');
  assert.equal(result.data.snapshot.stateVersion, room.snapshot.stateVersion + 1);
  assert.equal(f.app.store.all('SELECT * FROM hand_settlements WHERE room_id=?', room.id).length, 1);
  assert.equal((await b.call('tablemesh_account')).data.fairPlay.reputation, 100);
  for (const bad of ['afterStateVersion=-1', 'afterStateVersion=0&maxWaitMs=25001', 'afterStateVersion=0&maxWaitMs=1.5', 'afterStateVersion=0&afterStateVersion=1', 'maxWaitMs=0', 'afterStateVersion=0&token=x']) {
    assert.equal((await room.b.request(`/rooms/${room.id}/wait?${bad}`)).body.error.code, 'INVALID_INPUT');
  }
});

test('real HTTP SDK signal cancellation releases a wait; credential, typed id and pending-id collisions stay isolated', async t => {
  const f = await fixture(); t.after(f.close);
  const p = await f.register(); const other = await f.register('另一账号');
  const a = await agent(t, f, p, 'agent A'); const b = await agent(t, f, p, 'agent B'); const c = await agent(t, f, other);
  const room = await waitingRoom(f, p);
  const args = { roomId: room.id, afterStateVersion: room.stateVersion, maxWaitMs: 25000 };
  const abort = new AbortController();
  const signalled = a.call('tablemesh_wait_for_turn', args, { signal: abort.signal });
  await eventually(() => f.app.waiterCount === 1);
  abort.abort();
  await assert.rejects(signalled);
  await eventually(() => f.app.waiterCount === 0);
  const waitRpc = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'tablemesh_wait_for_turn', arguments: args } });
  const begin = (token, id) => fetch(f.url + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify(waitRpc(id)) }).then(r => r.json());
  const first = begin(a.token, 77); const second = begin(b.token, 77);
  await eventually(() => f.app.waiterCount === 2);
  await c.client.notification({ method: 'notifications/cancelled', params: { requestId: 77, reason: 'unrelated credential' } });
  await delay(60);
  assert.equal(f.app.waiterCount, 2);
  const duplicate = await begin(a.token, 77);
  assert.equal(duplicate.error.code, -32600);
  assert.equal(f.app.waiterCount, 2);
  await b.client.notification({ method: 'notifications/cancelled', params: { requestId: 77 } });
  await second; await eventually(() => f.app.waiterCount === 1);
  await a.client.notification({ method: 'notifications/cancelled', params: { requestId: '77' } });
  await delay(60); assert.equal(f.app.waiterCount, 1);
  await a.client.notification({ method: 'notifications/cancelled', params: { requestId: 77 } });
  await first; await eventually(() => f.app.waiterCount === 0);
  // Numeric/string JSON-RPC ids are separate entries; completing an old request
  // cannot remove the newer entry using the same credential and id.
  const number = begin(a.token, 77); const string = begin(a.token, '77');
  await eventually(() => f.app.waiterCount === 2);
  await a.client.notification({ method: 'notifications/cancelled', params: { requestId: 77 } });
  await number; await eventually(() => f.app.waiterCount === 1);
  await a.client.notification({ method: 'notifications/cancelled', params: { requestId: '77' } });
  await string; await eventually(() => f.app.waiterCount === 0);
  assert.equal((await a.call('tablemesh_account')).data.fairPlay.reputation, 100);
  assert.equal((await a.call('tablemesh_account')).data.points, 1000);
  assert.equal((await a.call('tablemesh_observe', { roomId: room.id })).data.stateVersion, room.stateVersion);
});

test('the global 100 pending wait cap, shutdown cleanup and in-queue credential revalidation are enforced', async t => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now });
  let closed = false;
  t.after(() => closed ? undefined : f.close());
  const players = [];
  for (let i = 0; i < 51; i++) { now += 61_000; players.push(await f.register('配额')); }
  const room = await waitingRoom(f, players[0]);
  const controllers = []; const waiting = [];
  for (let i = 0; i < 50; i++) for (let j = 0; j < 2; j++) {
    const controller = new AbortController(); controllers.push(controller);
    waiting.push(fetch(f.url + `/api/rooms/${room.id}/wait?afterStateVersion=${room.stateVersion}&maxWaitMs=25000`, { headers: { Cookie: players[i].cookie }, signal: controller.signal }).catch(() => null));
  }
  await eventually(() => f.app.waiterCount === 100);
  const extra = await players[50].request(`/rooms/${room.id}/wait?afterStateVersion=${room.stateVersion}&maxWaitMs=25000`);
  assert.equal(extra.status, 429);
  for (const controller of controllers) controller.abort();
  await Promise.all(waiting); await eventually(() => f.app.waiterCount === 0);
  // A credential can be revoked while its command waits behind a room writer.
  const live = await twoPlayerRoom(f);
  const a = await agent(t, f, live.a);
  let release;
  const gate = f.app.queue(live.id, () => new Promise(resolve => { release = resolve; }));
  await eventually(() => typeof release === 'function');
  const late = a.call('tablemesh_act', { roomId: live.id, stateVersion: live.snapshot.stateVersion, windowId: live.snapshot.game.window.id, requestId: 'queued-revoke', action: { type: 'call' } });
  await delay(30);
  const tokenRow = f.app.store.one('SELECT id FROM sessions WHERE account_id=? AND kind=?', live.a.account.id, 'game');
  await live.a.request('/auth/tokens/' + tokenRow.id, undefined, 'DELETE');
  release(); await gate;
  assert.equal((await late).error.code, 'UNAUTHENTICATED');
  assert.equal((await live.a.request(`/rooms/${live.id}`)).body.data.stateVersion, live.snapshot.stateVersion);
  assert.equal((await live.a.request('/account')).body.data.fairPlay.reputation, 100);
  const shutdown = fetch(f.url + `/api/rooms/${room.id}/wait?afterStateVersion=${room.stateVersion}&maxWaitMs=25000`, { headers: { Cookie: players[0].cookie } });
  await eventually(() => f.app.waiterCount === 1);
  await f.close();
  closed = true;
  assert.equal((await shutdown).status, 503);
  assert.equal(f.app.waiterCount, 0);
  assert.equal(f.app.waiters.size, 0);
});

test('MCP all-in abandonment retains settlement rights; restart preserves unrelated stored configuration and key files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tokem-mcp-restart-'));
  const keyPath = join(dir, 'tablemesh.provider-key');
  const retainedKey = Buffer.alloc(32, 17);
  writeFileSync(keyPath, retainedKey, { mode: 0o600 });
  const databasePath = join(dir, 'test.sqlite');
  let f = await fixture({ databasePath });
  let closed = false;
  t.after(async () => { if (!closed) await f.close(); rmSync(dir, { recursive: true, force: true }); });
  // The game-only service must leave unsupported legacy data untouched.
  f.app.store.run('CREATE TABLE llm_configs(account_id TEXT PRIMARY KEY, encrypted_payload TEXT)');
  f.app.store.run('INSERT INTO llm_configs VALUES(?,?)', 'legacy-account', 'synthetic-encrypted-configuration');
  const room = await twoPlayerRoom(f, { ...defaultRoomConfig, initialStack: 20 });
  const a = await agent(t, f, room.a);
  const allin = await a.call('tablemesh_act', { roomId: room.id, stateVersion: room.snapshot.stateVersion, windowId: room.snapshot.game.window.id, requestId: randomUUID(), action: { type: 'raise', amount: 20 } });
  assert.equal(allin.ok, true);
  assert.equal(allin.data.snapshot.game.seats.find(s => s.accountId === room.a.account.id).status, 'all-in');
  const abandoned = await a.call('tablemesh_leave_room', { roomId: room.id, stateVersion: allin.data.snapshot.stateVersion, requestId: 'all-in-leave', confirmAbandon: true });
  assert.equal(abandoned.ok, true);
  assert.equal(abandoned.data.snapshot.game.seats.find(s => s.accountId === room.a.account.id).status, 'all-in');
  const own = (await room.b.request(`/rooms/${room.id}`)).body.data;
  const settled = (await room.b.request(`/rooms/${room.id}/actions`, { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: 'call' } })).body.data.snapshot;
  assert.equal(settled.game.phase, 'complete');
  const history = (await a.call('tablemesh_observe', { roomId: room.id, after: 0 })).data.events.filter(e => e.type === 'hand_settled');
  assert.equal(history.length, 1);
  assert.equal(history[0].payload.participants.some(p => p.accountId === room.a.account.id), true);
  const settlement = history[0].payload.settlement;
  assert.equal([...settlement.pots.flatMap(p => p.awards), ...settlement.refunds].reduce((sum, p) => sum + p.amount, 0), 40);
  assert.equal((await a.call('tablemesh_points')).data.account.points, 1000);
  assert.equal(JSON.stringify(history).includes('synthetic-encrypted-configuration'), false);
  await f.close();
  f = await fixture({ databasePath });
  assert.deepEqual(readFileSync(keyPath), retainedKey);
  assert.equal(f.app.store.one('SELECT encrypted_payload FROM llm_configs').encrypted_payload, 'synthetic-encrypted-configuration');
  const restored = (await f.client(room.a.cookie).request(`/rooms/${room.id}/events?after=0`)).body.data.events.filter(e => e.type === 'hand_settled');
  assert.deepEqual(restored, history);
  assert.equal((await f.client(room.a.cookie).request('/account')).body.data.points, 1000);
  assert.equal((await f.client(room.a.cookie).request('/account')).body.data.fairPlay.abandonCount, 1);
  const p = await f.register('等待过期');
  const fresh = await agent(t, f, p);
  const waiting = await waitingRoom(f, p);
  const expired = fresh.call('tablemesh_wait_for_turn', { roomId: waiting.id, afterStateVersion: waiting.stateVersion, maxWaitMs: 2000 });
  await eventually(() => f.app.waiterCount === 1);
  f.app.store.run('UPDATE sessions SET expires_at=0 WHERE account_id=? AND kind=?', p.account.id, 'game');
  assert.equal((await expired).error.code, 'UNAUTHENTICATED');
  assert.equal(f.app.waiterCount, 0);
  await f.close(); closed = true;
});
