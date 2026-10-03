import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, twoPlayerRoom, threePlayerRoom } from './helpers.mjs';
import { endpoint, isPublicAddress, parseDecision, boundedRequest, DEFAULT_LIMITS } from '../dist/provider.js';
import { startFakeProvider } from './support/fake-provider.mjs';

const config = (baseUrl, protocol = 'openai-compatible', extra = {}) => ({ protocol, baseUrl, model: 'synthetic-test-model', limits: { ...DEFAULT_LIMITS }, ...extra });
const save = (player, input) => player.request('/llm/config', { requestId: randomUUID(), config: input }, 'PUT');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 100; n++) { const value = await predicate(); if (value) return value; await delay(10); } throw new Error('Condition did not complete'); }

test('endpoint and address restrictions reject private, credentials and redirects', async () => {
  for (const address of ['10.0.0.1', '169.254.169.254', '100.64.1.1', '192.168.1.1', '172.16.0.1', '0.0.0.0', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '224.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://example.com/v1', 'https://10.0.0.1/v1', 'https://u:p@example.com', 'https://example.com/v1?key=x', 'https://example.com/#x', 'file:///tmp/key']) assert.throws(() => endpoint(url));
  assert.equal(endpoint('http://127.0.0.1:11434/custom/v1/').pathname, '/custom/v1');
  const fake = await startFakeProvider();
  try {
    fake.setMode('redirect');
    await assert.rejects(boundedRequest(new URL(fake.baseUrl + '/chat/completions'), { messages: [{ content: '{}' }] }, {}, new AbortController().signal, 500), e => e.reason === 'MODEL_ERROR');
    assert.equal(fake.requests.length, 1);
    // Public-looking DNS that resolves to loopback is forbidden, even via HTTPS.
    await assert.rejects(boundedRequest(new URL('https://public-looking.example/v1/chat/completions'), {}, {}, new AbortController().signal, 500,
      async () => [{ address: '127.0.0.1', family: 4 }]), e => e.reason === 'MODEL_ERROR');
  } finally { await fake.close(); }
});

test('model decision parser requires exact nonce, shape, safe integer and legal range', () => {
  const legal = [{ type: 'fold' }, { type: 'raise', minAmount: 15, maxAmount: 25, allInOnly: false }];
  assert.deepEqual(parseDecision('{"decisionNonce":"n","action":{"type":"raise","amount":15}}', 'n', legal).action, { type: 'raise', amount: 15 });
  for (const raw of ['```json\n{}\n```', '{"decisionNonce":"other","action":{"type":"fold"}}', '{"decisionNonce":"n","action":{"type":"check"}}', '{"decisionNonce":"n","action":{"type":"fold"},"extra":1}', '{"decisionNonce":"n","action":{"type":"raise","amount":15.5}}', '{"decisionNonce":"n","action":{"type":"raise","amount":14}}']) assert.throws(() => parseDecision(raw, 'n', legal), e => e.reason === 'INVALID_RESPONSE');
  assert.throws(() => parseDecision('{"decisionNonce":"n","action":{"type":"raise","amount":15}}', 'n', [{ type: 'raise', minAmount: 15, maxAmount: 25, allInOnly: true }]));
});

test('config permissions, two transports, redaction, keyed dedup and single test dispatch', async () => {
  const fake = await startFakeProvider(); const f = await fixture();
  try {
    const a = await f.register(); const b = await f.register();
    const key = 'synthetic-secret-not-a-real-key';
    const body = { requestId: randomUUID(), config: config(fake.baseUrl, 'openai-compatible', { apiKey: key, tokenLimitField: 'max_completion_tokens' }) };
    assert.equal((await a.request('/llm/config', body, 'PUT')).body.ok, true);
    assert.equal((await a.request('/llm/config', body, 'PUT')).body.ok, true);
    const view = (await a.request('/llm/config')).body.data;
    assert.equal(view.hasApiKey, true); assert.equal(JSON.stringify(view).includes(key), false);
    assert.equal((await b.request('/llm/config')).body.data.configured, false);
    const persisted = JSON.stringify(f.app.store.one('SELECT * FROM llm_configs WHERE account_id=?', a.account.id));
    assert.equal(persisted.includes(key), false);
    const minted = (await a.request('/auth/tokens', { label: 'test' })).body.data;
    const game = f.client('', minted.token);
    assert.equal((await game.request('/llm/config')).body.data.ready, true);
    for (const [path, payload, method] of [['/llm/config', body, 'PUT'], ['/llm/config', { requestId: randomUUID() }, 'DELETE'], ['/llm/test', { requestId: randomUUID() }, 'POST']]) assert.equal((await game.request(path, payload, method)).status, 403);
    const testBody = { requestId: randomUUID() }; fake.setMode('delay', 80);
    const first = a.request('/llm/test', testBody); await until(() => fake.requests.length === 1);
    assert.equal((await a.request('/llm/test', testBody)).body.data.status, 'pending');
    assert.equal((await first).body.data.status, 'passed');
    assert.equal((await a.request('/llm/test', testBody)).body.data.status, 'passed');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${key}`);
    assert.equal(fake.requests[0].body.max_completion_tokens, 64);
    const prompt = JSON.parse(fake.requests[0].body.messages.at(-1).content);
    assert.deepEqual(Object.keys(prompt).sort(), ['decisionNonce', 'legalActions']);
    fake.setMode('passive');
    assert.equal((await save(a, config(fake.baseUrl, 'anthropic', { apiKey: key }))).body.ok, true);
    assert.equal((await a.request('/llm/test', { requestId: randomUUID() })).body.data.status, 'passed');
    assert.equal(fake.requests[1].headers['x-api-key'], key);
    assert.equal(fake.requests[1].headers['anthropic-version'], '2023-06-01');
    assert.equal(fake.requests[1].body.max_tokens, 64); assert.equal(fake.requests[1].path, '/v1/messages');
    const conflict = await a.request('/llm/config', { ...body, config: { ...body.config, apiKey: 'different' } }, 'PUT');
    assert.equal(conflict.body.error.code, 'REQUEST_ID_CONFLICT');
    assert.equal(JSON.stringify(f.app.store.all('SELECT * FROM requests')).includes(key), false);
    fake.setMode('error');
    const failure = await a.request('/llm/test', { requestId: randomUUID() });
    assert.deepEqual(failure.body.data, { status: 'failed', reason: 'MODEL_ERROR' });
    assert.equal(JSON.stringify(failure.body).includes('synthetic-private-error'), false);
    assert.equal(JSON.stringify(failure.body).includes(key), false);
    fake.setMode('oversized'); assert.equal((await a.request('/llm/test', { requestId: randomUUID() })).body.data.reason, 'INVALID_RESPONSE');
    fake.setMode('invalid'); assert.equal((await a.request('/llm/test', { requestId: randomUUID() })).body.data.reason, 'INVALID_RESPONSE');
    fake.setMode('nonce'); assert.equal((await a.request('/llm/test', { requestId: randomUUID() })).body.data.reason, 'INVALID_RESPONSE');
    assert.equal((await a.request('/llm/config', { requestId: randomUUID() }, 'DELETE')).body.data.configured, false);
    assert.equal((await save(a, config(fake.baseUrl))).body.data.ready, true); // keyless loopback
  } finally { await f.close(); await fake.close(); }
});

test('real three-seat hand with two model controllers and one manual player preserves private cards, budgets and chips', async () => {
  const f = await fixture(); const fake = await startFakeProvider();
  try {
    const room = await threePlayerRoom(f); const [a, b, human] = room.players;
    const initial = await Promise.all(room.players.map(async player => (await player.request(`/rooms/${room.id}`)).body.data));
    const keyA = 'synthetic-controller-a'; const keyB = 'synthetic-controller-b';
    await save(a, config(fake.baseUrl, 'openai-compatible', { apiKey: keyA }));
    await save(b, config(fake.baseUrl, 'openai-compatible', { apiKey: keyB }));
    for (const player of [a, b]) assert.equal((await player.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() })).body.ok, true);
    let final;
    for (let n = 0; n < 150; n++) {
      const own = (await human.request(`/rooms/${room.id}`)).body.data;
      if (own.game.phase === 'complete') { final = own; break; }
      if (own.you.legalActions.length) {
        const move = own.you.legalActions.find(item => item.type === 'check') ?? own.you.legalActions.find(item => item.type === 'call');
        assert.ok(move);
        const result = await human.request(`/rooms/${room.id}/actions`, { requestId: randomUUID(), stateVersion: own.stateVersion, windowId: own.game.window.id, action: { type: move.type } });
        assert.equal(result.body.ok, true);
      } else await delay(10);
    }
    assert.equal(final?.game.phase, 'complete');
    assert.equal(final.game.seats.reduce((sum, seat) => sum + seat.stack, 0), 3000);
    for (const [index, key] of [[0, keyA], [1, keyB]]) {
      const requests = fake.requests.filter(item => item.headers.authorization === `Bearer ${key}`);
      assert.ok(requests.length >= 4 && requests.length <= DEFAULT_LIMITS.maxRequestsPerHand);
      for (const request of requests) {
        const observation = JSON.parse(request.body.messages.at(-1).content);
        assert.deepEqual(observation.holeCards, initial[index].you.privateState.holeCards);
        for (const other of initial.filter((_, n) => n !== index)) for (const card of other.you.privateState.holeCards) assert.equal(JSON.stringify(observation).includes(`"${card}"`), false);
        for (const identity of room.players) { assert.equal(JSON.stringify(observation).includes(identity.account.id), false); assert.equal(JSON.stringify(observation).includes(identity.displayName), false); }
      }
      const status = (await room.players[index].request(`/rooms/${room.id}/autoplay`)).body.data;
      assert.equal(status.requestsThisHand, requests.length); assert.equal(status.requestsThisRun, requests.length); assert.equal(status.inFlight, false);
    }
    for (const player of room.players) assert.equal((await player.request('/account')).body.data.points, 1000);
  } finally { await f.close(); await fake.close(); }
});

test('provider key persists privately beside DB; test/start replay after restart cannot spend again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokem-provider-')); const databasePath = join(directory, 'state.sqlite');
  const fake = await startFakeProvider(); let f = await fixture({ databasePath });
  try {
    const room = await twoPlayerRoom(f); await save(room.a, config(fake.baseUrl));
    const testBody = { requestId: randomUUID() }; assert.equal((await room.a.request('/llm/test', testBody)).body.data.status, 'passed');
    const startBody = { requestId: randomUUID() }; await room.a.request(`/rooms/${room.id}/autoplay/start`, startBody);
    await until(() => fake.requests.length === 2);
    await room.a.request(`/rooms/${room.id}/autoplay/stop`, { requestId: randomUUID() });
    const keyPath = join(directory, 'tablemesh.provider-key'); const key = readFileSync(keyPath);
    assert.equal(key.length, 32); assert.equal(statSync(keyPath).mode & 0o077, 0);
    const cookie = room.a.cookie; const count = fake.requests.length;
    f.app.store.run('INSERT INTO llm_tests VALUES(?,?,?,?,?)', room.a.account.id, 'crash-pending', f.app.provider.fingerprint({ requestId: 'crash-pending' }), '{"status":"pending","reason":null}', Date.now());
    await f.close(); f = await fixture({ databasePath }); const a = f.client(cookie);
    assert.deepEqual(readFileSync(keyPath), key);
    assert.equal((await a.request('/llm/config')).body.data.ready, true);
    assert.equal((await a.request('/llm/test', testBody)).body.data.status, 'passed');
    assert.equal((await a.request('/llm/test', { requestId: 'crash-pending' })).body.data.status, 'interrupted');
    assert.equal((await a.request(`/rooms/${room.id}/autoplay/start`, startBody)).body.data.autoplay.phase, 'stopped');
    await delay(50); assert.equal(fake.requests.length, count);
  } finally { await f.close(); await fake.close(); rmSync(directory, { recursive: true }); }
});

test('real App autoplay uses own projection, cancels manual/config/revoke, permits ordinary timeouts', async () => {
  let now = Date.now(); const f = await fixture({ now: () => now }); const fake = await startFakeProvider();
  try {
    const room = await twoPlayerRoom(f); await save(room.a, config(fake.baseUrl));
    fake.setMode('delay', 1200);
    await room.a.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() });
    await until(() => fake.requests.length === 1);
    const serialized = JSON.stringify(fake.requests[0].body);
    for (const value of [room.id, room.a.account.id, room.b.account.id, room.a.displayName, room.b.displayName]) assert.equal(serialized.includes(value), false);
    const bSnapshot = (await room.b.request(`/rooms/${room.id}`)).body.data;
    for (const card of bSnapshot.you.privateState.holeCards) assert.equal(serialized.includes(`"${card}"`), false);
    let own = (await room.a.request(`/rooms/${room.id}`)).body.data;
    const version = own.stateVersion;
    const failedManual = await room.a.request(`/rooms/${room.id}/actions`, { stateVersion: version - 1, requestId: randomUUID(), windowId: own.game.window.id, action: { type: 'call' } });
    assert.equal(failedManual.body.error.code, 'VERSION_CONFLICT');
    await delay(220); assert.equal((await room.a.request(`/rooms/${room.id}`)).body.data.stateVersion, version);
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay`)).body.data.reason, 'MANUAL_TAKEOVER');
    fake.setMode('delay', 1200); await room.a.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() }); await until(() => fake.requests.length === 2);
    await save(room.a, config(fake.baseUrl)); await delay(220); assert.equal((await room.a.request(`/rooms/${room.id}`)).body.data.stateVersion, version);
    const minted = (await room.a.request('/auth/tokens', { label: 'auto-test' })).body.data;
    const tokenId = (await room.a.request('/auth/tokens')).body.data[0].id; const game = f.client('', minted.token);
    await game.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() }); await until(() => fake.requests.length === 3);
    await room.a.request('/auth/tokens/' + tokenId, undefined, 'DELETE'); await delay(220);
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay`)).body.data.reason, 'CREDENTIAL_REVOKED');
    assert.equal((await room.a.request(`/rooms/${room.id}`)).body.data.stateVersion, version);
    await room.a.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() }); await until(() => fake.requests.length === 4);
    own = (await room.a.request(`/rooms/${room.id}`)).body.data; now = own.game.window.deadline;
    await f.app.runTimeouts(); await delay(220);
    const after = (await room.a.request(`/rooms/${room.id}`)).body.data;
    assert.equal(after.game.phase, 'complete'); assert.equal(after.stateVersion, version + 1);
    assert.equal((await room.a.request('/account')).body.data.fairPlay.reputation, 100);
    assert.equal((await room.a.request('/account')).body.data.points, 1000);
  } finally { await f.close(); await fake.close(); }
});

test('failed durable start acceptance cannot dispatch or stop an already enabled run', async () => {
  const f = await fixture(); const fake = await startFakeProvider();
  try {
    const room = await twoPlayerRoom(f); await save(room.a, config(fake.baseUrl));
    f.app.store.db.exec("CREATE TRIGGER reject_start BEFORE INSERT ON requests WHEN NEW.operation='autoplay_start' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() })).status, 500);
    await delay(40); assert.equal(fake.requests.length, 0);
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay`)).body.data.phase, 'stopped');
    f.app.store.db.exec('DROP TRIGGER reject_start'); fake.setMode('delay', 1200);
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() })).body.ok, true);
    await until(() => fake.requests.length === 1);
    f.app.store.db.exec("CREATE TRIGGER reject_start BEFORE INSERT ON requests WHEN NEW.operation='autoplay_start' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay/start`, { requestId: randomUUID() })).status, 500);
    assert.equal((await room.a.request(`/rooms/${room.id}/autoplay`)).body.data.phase, 'thinking');
    assert.equal(fake.requests.length, 1);
  } finally { await f.close(); await fake.close(); }
});
