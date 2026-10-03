import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, twoPlayerRoom, defaultRoomConfig } from './helpers.mjs';

async function finalRiverWindow(f) {
  const room = await twoPlayerRoom(f, { ...defaultRoomConfig, turnTimeoutMs: 1000 });
  let snapshot = room.snapshot;
  let acceptedRequest;
  for (let i = 0; snapshot.game.phase !== 'river'; i++) {
    assert.ok(i < 30);
    const actor = snapshot.game.actorSeat === 0 ? room.a : room.b;
    const own = (await actor.request(`/rooms/${room.id}`)).body.data;
    const body = { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: own.you.legalActions.some(move => move.type === 'check') ? 'check' : 'call' } };
    const result = await actor.request(`/rooms/${room.id}/actions`, body);
    assert.equal(result.body.ok, true);
    acceptedRequest ??= { actor, body };
    snapshot = result.body.data.snapshot;
  }
  const first = snapshot.game.actorSeat === 0 ? room.a : room.b;
  snapshot = (await first.request(`/rooms/${room.id}/actions`, { stateVersion: snapshot.stateVersion, windowId: snapshot.game.window.id, requestId: randomUUID(), action: { type: 'check' } })).body.data.snapshot;
  assert.equal(snapshot.game.phase, 'river');
  const actor = snapshot.game.actorSeat === 0 ? room.a : room.b;
  return { ...room, snapshot, actor, acceptedRequest };
}

test('final river abandonment before/equal/after deadline preserves timeout priority and avoids a penalty on stale confirmation', async t => {
  for (const offset of [-1, 0, 1]) await t.test(`deadline offset ${offset} ms`, async sub => {
    let now = 1_000_000;
    const f = await fixture({ now: () => now }); sub.after(f.close);
    const room = await finalRiverWindow(f);
    now = room.snapshot.game.window.deadline + offset;
    const result = await room.actor.request(`/rooms/${room.id}/leave`, { stateVersion: room.snapshot.stateVersion, requestId: randomUUID(), confirmAbandon: true });
    const account = (await room.actor.request('/account')).body.data;
    if (offset < 0) {
      assert.equal(result.body.ok, true);
      assert.equal(account.fairPlay.reputation, 90);
      assert.equal(account.fairPlay.abandonCount, 1);
    } else {
      assert.equal(result.body.error.code, 'VERSION_CONFLICT');
      assert.equal(result.body.error.currentStateVersion, room.snapshot.stateVersion + 1);
      assert.equal(account.fairPlay.reputation, 100);
      assert.equal(account.fairPlay.abandonCount, 0);
    }
    assert.equal(account.points, 1000);
    const restored = (await room.a.request(`/rooms/${room.id}`)).body.data;
    assert.equal(restored.game.phase, 'complete');
    const history = (await room.a.request(`/rooms/${room.id}/events?after=0`)).body.data.events.filter(event => event.type === 'hand_settled');
    assert.equal(history.length, 1);
    if (offset < 0) {
      const ownSeat = room.snapshot.game.seats.find(seat => seat.accountId === room.actor.account.id).seat;
      assert.equal(history[0].payload.settlement.pots.some(pot => pot.winners.includes(ownSeat)), false);
    }
    await f.app.runTimeouts();
    assert.equal(f.app.store.all('SELECT * FROM hand_settlements WHERE room_id=?', room.id).length, 1);
  });
});

test('accepted action dedup precedes expired-window processing; new actions see committed timeout and version conflict', async t => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now }); t.after(f.close);
  const room = await finalRiverWindow(f);
  now = room.snapshot.game.window.deadline;
  const repeated = await room.acceptedRequest.actor.request(`/rooms/${room.id}/actions`, room.acceptedRequest.body);
  assert.equal(repeated.body.ok, true);
  assert.equal(repeated.body.data.replayed, true);
  assert.equal(repeated.body.data.snapshot.stateVersion, room.snapshot.stateVersion);
  const newAction = await room.actor.request(`/rooms/${room.id}/actions`, { stateVersion: room.snapshot.stateVersion, windowId: room.snapshot.game.window.id, requestId: randomUUID(), action: { type: 'check' } });
  assert.equal(newAction.body.error.code, 'VERSION_CONFLICT');
  assert.equal(newAction.body.error.currentStateVersion, room.snapshot.stateVersion + 1);
  assert.equal((await room.actor.request('/account')).body.data.fairPlay.reputation, 100);
  assert.equal(f.app.store.all('SELECT * FROM hand_settlements WHERE room_id=?', room.id).length, 1);
});
