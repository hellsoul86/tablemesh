import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, threePlayerRoom, twoPlayerRoom, defaultRoomConfig } from './helpers.mjs';

test('active seats stay locked; explicit abandonment confirms, folds immediately and penalizes once across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tablemesh-fairness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_000_000;
  const config = { databasePath: join(directory, 'test.sqlite'), inventoryKey: randomBytes(32), now: () => now };
  let f = await fixture(config);
  const room = await threePlayerRoom(f);
  const [a, b, c] = room.players;
  const d = await f.register('替补');
  assert.equal((await d.request(`/rooms/${room.id}/join`, { seat: 0, stateVersion: room.snapshot.stateVersion, requestId: randomUUID() })).status, 409);
  const noConfirm = await a.request(`/rooms/${room.id}/leave`, { stateVersion: room.snapshot.stateVersion, requestId: randomUUID() });
  assert.equal(noConfirm.status, 409);
  assert.equal((await a.request('/account')).body.data.fairPlay.reputation, 100);
  const body = { stateVersion: room.snapshot.stateVersion, requestId: 'confirm-once', confirmAbandon: true };
  const abandoned = await a.request(`/rooms/${room.id}/leave`, body);
  assert.equal(abandoned.body.ok, true);
  const snapshot = abandoned.body.data.snapshot;
  assert.equal(snapshot.game.phase !== 'complete', true);
  assert.equal(snapshot.game.seats.length, 3);
  assert.equal(snapshot.game.seats.find(seat => seat.accountId === a.account.id).status, 'folded');
  assert.deepEqual(snapshot.abandonedAccountIds, [a.account.id]);
  const fairness = (await a.request('/account')).body.data.fairPlay;
  assert.deepEqual(fairness, { reputation: 90, cooldownUntil: now + 5 * 60_000, abandonCount: 1 });
  assert.equal((await a.request('/account')).body.data.points, 1000);
  assert.equal((await a.request(`/rooms/${room.id}/leave`, body)).body.data.replayed, true);
  assert.equal((await a.request(`/rooms/${room.id}/leave`, { ...body, stateVersion: snapshot.stateVersion, requestId: 'second-id' })).body.ok, true);
  assert.equal((await a.request('/account')).body.data.fairPlay.abandonCount, 1);
  assert.equal((await a.request('/rooms', { name: '绕过', config: defaultRoomConfig, requestId: randomUUID() })).body.error.code, 'MATCH_COOLDOWN');
  await f.close();
  f = await fixture(config);
  const restoredA = f.client(a.cookie);
  assert.deepEqual((await restoredA.request('/account')).body.data.fairPlay, fairness);
  const restored = (await restoredA.request(`/rooms/${room.id}`)).body.data;
  assert.equal(restored.game.seats.length, 3);
  assert.deepEqual(restored.abandonedAccountIds, [a.account.id]);
  assert.equal((await restoredA.request(`/rooms/${room.id}/leave`, { ...body, stateVersion: restored.stateVersion, requestId: 'after-restart' })).body.ok, true);
  assert.equal((await restoredA.request('/account')).body.data.fairPlay.abandonCount, 1);
  assert.equal(f.app.store.all("SELECT * FROM admin_audit WHERE action='confirmed_abandonment'").length, 1);
  await f.close();
});

test('abandoning a nonacting seat folds at its next legal window without spending the deadline', async t => {
  const f = await fixture(); t.after(f.close);
  const room = await threePlayerRoom(f);
  const [a, b] = room.players;
  const abandoned = await b.request(`/rooms/${room.id}/leave`, { stateVersion: room.snapshot.stateVersion, requestId: randomUUID(), confirmAbandon: true });
  assert.equal(abandoned.body.ok, true);
  assert.equal(abandoned.body.data.snapshot.game.seats.find(seat => seat.accountId === b.account.id).status, 'active');
  const own = (await a.request(`/rooms/${room.id}`)).body.data;
  const result = await a.request(`/rooms/${room.id}/actions`, { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: 'call' } });
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.snapshot.game.seats.find(seat => seat.accountId === b.account.id).status, 'folded');
  assert.notEqual(result.body.data.snapshot.game.actorSeat, 1);
});

test('all-in abandonment keeps committed chips and settlement rights, removes only after settlement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tablemesh-allin-history-'));
  const config = { databasePath: join(directory, 'test.sqlite'), inventoryKey: randomBytes(32) };
  let f = await fixture(config);
  t.after(async () => { await f.close(); rmSync(directory, { recursive: true, force: true }); });
  const room = await twoPlayerRoom(f);
  const own = room.snapshot;
  const allIn = await room.a.request(`/rooms/${room.id}/actions`, { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: 'raise', amount: 1000 } });
  assert.equal(allIn.body.ok, true);
  const abandoned = await room.a.request(`/rooms/${room.id}/leave`, { stateVersion: allIn.body.data.snapshot.stateVersion, requestId: randomUUID(), confirmAbandon: true });
  assert.equal(abandoned.body.ok, true);
  const pending = abandoned.body.data.snapshot;
  const committed = pending.game.seats.find(seat => seat.accountId === room.a.account.id);
  assert.equal(committed.status, 'all-in');
  assert.equal(committed.totalBet, 1000);
  assert.equal(pending.game.seats.length, 2);
  const other = (await room.b.request(`/rooms/${room.id}`)).body.data;
  const settled = await room.b.request(`/rooms/${room.id}/actions`, { stateVersion: other.stateVersion, windowId: other.game.window.id, requestId: randomUUID(), action: { type: 'call' } });
  assert.equal(settled.body.ok, true);
  const done = settled.body.data.snapshot;
  assert.equal(done.game.phase, 'complete');
  assert.equal(done.game.seats.some(seat => seat.accountId === room.a.account.id), false);
  const history = (await room.b.request(`/rooms/${room.id}/events?after=0`)).body.data.events.filter(event => event.type === 'hand_settled');
  assert.equal(history.length, 1);
  assert.equal(history[0].payload.settlement.pots.reduce((sum, pot) => sum + pot.amount, 0), 2000);
  assert.equal(history[0].payload.participants.some(player => player.accountId === room.a.account.id && player.seat === 0), true);
  assert.equal(f.app.store.all('SELECT * FROM hand_settlements WHERE room_id=?', room.id).length, 1);
  const persisted = JSON.parse(f.app.store.one('SELECT engine_json FROM rooms WHERE id=?', room.id).engine_json);
  const retained = persisted.privateState.retainedStacks[room.a.account.id];
  assert.equal(done.game.seats[0].stack + retained, 2000);
  assert.equal((await room.a.request('/account')).body.data.points, 1000);
  await f.close();
  f = await fixture(config);
  const restored = (await f.client(room.a.cookie).request(`/rooms/${room.id}/events?after=0`)).body.data.events.filter(event => event.type === 'hand_settled');
  assert.deepEqual(restored, history);
  assert.equal(f.app.store.all('SELECT * FROM hand_settlements WHERE room_id=?', room.id).length, 1);
  assert.equal((await f.client(room.a.cookie).request('/account')).body.data.points, 1000);
});

test('cooldown blocks new tables/seats/start participants but preserves existing hand actions and network recovery', async t => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now }); t.after(f.close);
  const first = await threePlayerRoom(f);
  const [a, b] = first.players;
  async function newTable(owner) { return (await owner.request('/rooms', { name: '现有房间', config: defaultRoomConfig, requestId: randomUUID() })).body.data.snapshot; }
  async function seatBoth(snapshot) {
    for (const player of [a, b]) snapshot = (await player.request(`/rooms/${snapshot.id}/join`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() })).body.data.snapshot;
    return snapshot;
  }
  const waiting = await seatBoth(await newTable(b));
  const live = await seatBoth(await newTable(a));
  const started = (await a.request(`/rooms/${live.id}/start`, { stateVersion: live.stateVersion, requestId: randomUUID() })).body.data.snapshot;
  assert.equal((await a.request('/account')).body.data.fairPlay.reputation, 100);
  assert.equal((await a.request(`/rooms/${live.id}`)).body.data.stateVersion, started.stateVersion);
  assert.equal((await a.request(`/rooms/${live.id}`)).body.data.you.privateState.holeCards.length, 2);
  assert.equal((await a.request('/account')).body.data.fairPlay.abandonCount, 0);
  const abandoned = await a.request(`/rooms/${first.id}/leave`, { stateVersion: first.snapshot.stateVersion, requestId: randomUUID(), confirmAbandon: true });
  assert.equal(abandoned.body.ok, true);
  assert.equal((await b.request(`/rooms/${waiting.id}/start`, { stateVersion: waiting.stateVersion, requestId: randomUUID() })).body.error.code, 'MATCH_COOLDOWN');
  const empty = await newTable(b);
  assert.equal((await a.request(`/rooms/${empty.id}/join`, { stateVersion: empty.stateVersion, requestId: randomUUID() })).body.error.code, 'MATCH_COOLDOWN');
  assert.equal((await a.request(`/rooms/${live.id}/actions`, { stateVersion: started.stateVersion, windowId: started.game.window.id, requestId: randomUUID(), action: { type: 'call' } })).body.ok, true);
  now += 5 * 60_000 + 1;
  assert.equal((await a.request(`/rooms/${empty.id}/join`, { stateVersion: empty.stateVersion, requestId: randomUUID() })).body.ok, true);
});

test('repeat explicit abandonments within 24h escalate, reputation is bounded and points stay separate', async t => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now }); t.after(f.close);
  const a = await f.register(); const b = await f.register();
  for (let i = 0; i < 7; i++) {
    let snapshot = (await a.request('/rooms', { name: '重复放弃测试', config: defaultRoomConfig, requestId: randomUUID() })).body.data.snapshot;
    for (const player of [a, b]) snapshot = (await player.request(`/rooms/${snapshot.id}/join`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() })).body.data.snapshot;
    snapshot = (await a.request(`/rooms/${snapshot.id}/start`, { stateVersion: snapshot.stateVersion, requestId: randomUUID() })).body.data.snapshot;
    const response = await a.request(`/rooms/${snapshot.id}/leave`, { stateVersion: snapshot.stateVersion, requestId: randomUUID(), confirmAbandon: true });
    assert.equal(response.body.ok, true);
    const account = (await a.request('/account')).body.data;
    assert.equal(account.fairPlay.reputation, Math.max(0, 90 - i * 20));
    assert.equal(account.fairPlay.cooldownUntil, now + (i ? 15 : 5) * 60_000);
    assert.equal(account.fairPlay.abandonCount, i + 1);
    assert.equal(account.points, 1000);
    now = account.fairPlay.cooldownUntil + 1;
  }
});
