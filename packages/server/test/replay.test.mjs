import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, twoPlayerRoom, threePlayerRoom, finishHand } from './helpers.mjs';

async function act(player, roomId, action, requestId=randomUUID(), snapshot) {
 const own=snapshot??(await player.request(`/rooms/${roomId}`)).body.data;
 return player.request(`/rooms/${roomId}/actions`,{stateVersion:own.stateVersion,windowId:own.game.window.id,requestId,action});
}
async function detail(player,handId,query='') {
 const r=await player.request(`/replays/${handId}${query}`);assert.equal(r.body.ok,true);return r.body.data;
}
const count=(f,handId)=>f.app.store.one('SELECT COUNT(*) n FROM hand_replay_frames WHERE hand_id=?',handId).n;

 test('completed replay is participant-only, private to its original viewer and never shows future showdown cards',async()=>{
 const f=await fixture();try {
  const room=await twoPlayerRoom(f); const handId=room.snapshot.game.handId;
  const outsider=await f.register('旁观');
  const aCards=room.snapshot.you.privateState.holeCards;
  const bCards=(await room.b.request(`/rooms/${room.id}`)).body.data.you.privateState.holeCards;
  assert.equal((await room.a.request(`/replays/${handId}`)).status,404);
  assert.deepEqual((await room.a.request('/replays')).body.data.hands,[]);
  await finishHand(room);
  const a=await detail(room.a,handId);const b=await detail(room.b,handId);
  assert.deepEqual(a.you.privateState.holeCards,aCards);assert.deepEqual(b.you.privateState.holeCards,bCards);
  assert.equal(a.frames[0].kind,'start'); assert.equal(a.frames.at(-1).game.phase,'complete');
  assert.equal(a.frames.at(-1).game.revealedHands.length,2);
  for(const frame of a.frames.slice(0,-1)) {
   assert.deepEqual(frame.game.revealedHands,[]);assert.equal(frame.game.window,null);
   for(const card of bCards) assert.equal(JSON.stringify(frame).includes(`"${card}"`),false);
  }
  assert.deepEqual(a.frames.map(x=>x.index),a.frames.map((_,i)=>i));
  assert.equal(a.summary.netChips,a.summary.participants[0].finalStack-a.summary.participants[0].startingStack);
  assert.equal(a.summary.participants.reduce((n,p)=>n+p.finalStack,0),2000);
  assert.equal((await outsider.request(`/replays/${handId}`)).status,404);
  assert.deepEqual((await outsider.request('/replays')).body.data.hands,[]);
  assert.equal((await room.a.request('/account')).body.data.points,1000);
  const payload=JSON.stringify(a);for(const key of ['deckCursor','actedSeats','raiseRights','token_hash','code_ciphertext','"deck"']) assert.equal(payload.includes(key),false);
 }finally{await f.close();}
 });

 test('folded cards and old names remain bound to original accounts after same-slot replacement and game-token access',async()=>{
 const f=await fixture();try {
  const room=await twoPlayerRoom(f);const handId=room.snapshot.game.handId;
  const bCards=(await room.b.request(`/rooms/${room.id}`)).body.data.you.privateState.holeCards;
  await act(room.a,room.id,{type:'fold'});
  const before=await detail(room.a,handId);assert.equal(before.frames.at(-1).game.revealedHands.length,0);
  let state=(await room.a.request(`/rooms/${room.id}`)).body.data;
  state=(await room.a.request(`/rooms/${room.id}/leave`,{stateVersion:state.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  const newcomer=await f.register('新人');
  await newcomer.request(`/rooms/${room.id}/join`,{seat:0,stateVersion:state.stateVersion,requestId:randomUUID()});
  assert.equal((await newcomer.request(`/replays/${handId}`)).status,404);
  assert.deepEqual(await detail(room.a,handId),before);
  for(const card of bCards) assert.equal(JSON.stringify(before).includes(`"${card}"`),false);
  const minted=(await room.a.request('/auth/tokens',{label:'复盘'})).body.data;
  const agent=f.client('',minted.token);assert.deepEqual(await detail(agent,handId),before);
  const tokenId=(await room.a.request('/auth/tokens')).body.data.find(t=>t.label==='复盘').id;
  assert.equal((await room.a.request(`/auth/tokens/${tokenId}`,undefined,'DELETE')).body.ok,true);
  assert.equal((await agent.request(`/replays/${handId}`)).status,401);
 }finally{await f.close();}
 });

 test('accepted retries and failed commands add no false frames; a due deadline commits only its genuine timeout',async()=>{
 let now=100_000;const f=await fixture({now:()=>now});try {
  const room=await twoPlayerRoom(f);const handId=room.snapshot.game.handId;
  const own=room.snapshot;const requestId=randomUUID();
  const accepted=await act(room.a,room.id,{type:'call'},requestId,own);assert.equal(accepted.body.ok,true);
  assert.equal(count(f,handId),2);
  const retry=await act(room.a,room.id,{type:'call'},requestId,own);assert.equal(retry.body.data.replayed,true);assert.equal(count(f,handId),2);
  const stale=await act(room.a,room.id,{type:'fold'},randomUUID(),own);assert.equal(stale.body.error.code,'VERSION_CONFLICT');assert.equal(count(f,handId),2);
  const current=(await room.b.request(`/rooms/${room.id}`)).body.data;now=current.game.window.deadline;
  const late=await act(room.b,room.id,{type:'fold'},randomUUID(),current);assert.equal(late.body.error.code,'VERSION_CONFLICT');assert.equal(count(f,handId),3);
  await finishHand(room);
  const replay=await detail(room.a,handId);assert.equal(replay.frames[2].kind,'timeout');assert.equal(replay.frames[2].action.type,'check');
  assert.equal(replay.frames.filter(frame=>frame.kind==='action'&&frame.action.type==='fold').length,0);
 }finally{await f.close();}
 });

 test('confirmed all-in abandonment records its source and preserves payout and original private access before cleanup',async()=>{
 const f=await fixture();try {
  const room=await threePlayerRoom(f);const [a,b,c]=room.players;const handId=room.snapshot.game.handId;
  const aCards=(await a.request(`/rooms/${room.id}`)).body.data.you.privateState.holeCards;
  assert.equal((await act(a,room.id,{type:'raise',amount:1000})).body.ok,true);
  assert.equal((await act(b,room.id,{type:'call'})).body.ok,true);
  const state=(await a.request(`/rooms/${room.id}`)).body.data;
  assert.equal((await a.request(`/rooms/${room.id}/leave`,{stateVersion:state.stateVersion,requestId:randomUUID(),confirmAbandon:true})).body.ok,true);
  const ended=await act(c,room.id,{type:'fold'});assert.equal(ended.body.data.snapshot.game.phase,'complete');
  assert.equal(ended.body.data.snapshot.game.seats.some(p=>p.accountId===a.account.id),false);
  const replay=await detail(a,handId);assert.deepEqual(replay.you.privateState.holeCards,aCards);
  assert.equal(replay.frames.filter(x=>x.kind==='abandon').length,1);
  assert.equal(replay.frames.some(x=>x.kind==='abandon_fold'&&x.actorSeat===0),false);
  assert.deepEqual(replay.frames.at(-1).streets.map(s=>s.phase),['flop','turn','river']);
  assert.equal(replay.frames.at(-1).game.seats.length,3);
  assert.equal(replay.summary.participants.reduce((n,p)=>n+p.finalStack,0),3000);
  assert.equal((await a.request('/account')).body.data.fairPlay.abandonCount,1);
 }finally{await f.close();}
 });

 test('out-of-turn abandoned seat has a marker then a separately sourced fold, with one penalty',async()=>{
 const f=await fixture();try {
  const room=await threePlayerRoom(f);const [a,b,c]=room.players;const handId=room.snapshot.game.handId;
  const leave={stateVersion:room.snapshot.stateVersion,requestId:randomUUID(),confirmAbandon:true};
  await b.request(`/rooms/${room.id}/leave`,leave);
  assert.equal((await b.request(`/rooms/${room.id}/leave`,leave)).body.data.replayed,true);
  const fresh=(await b.request(`/rooms/${room.id}`)).body.data;
  assert.equal((await b.request(`/rooms/${room.id}/leave`,{...leave,stateVersion:fresh.stateVersion,requestId:randomUUID()})).body.ok,true);
  assert.equal(count(f,handId),2);
  await act(a,room.id,{type:'call'});await act(c,room.id,{type:'fold'});
  const replay=await detail(b,handId);const marker=replay.frames.find(x=>x.kind==='abandon');const folded=replay.frames.find(x=>x.kind==='abandon_fold');
  assert.equal(marker.actorSeat,1);assert.equal(marker.action,null);assert.equal(folded.actorSeat,1);assert.equal(folded.action.type,'fold');assert.ok(marker.index<folded.index);
  assert.equal((await b.request('/account')).body.data.fairPlay.abandonCount,1);
 }finally{await f.close();}
 });

 test('file-backed active restart continues exact frames and completed replay survives another restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tokem-replay-'));let f;try {
  const config={databasePath:join(dir,'test.sqlite'),now:()=>200_000};f=await fixture(config);
  const room=await twoPlayerRoom(f);const handId=room.snapshot.game.handId;
  await act(room.a,room.id,{type:'call'});const prefix=f.app.store.all('SELECT frame_json FROM hand_replay_frames WHERE hand_id=? ORDER BY step_index',handId);
  await f.close();f=await fixture(config);
  const restored={id:room.id,a:{...f.client(room.a.cookie),account:room.a.account},b:{...f.client(room.b.cookie),account:room.b.account}};
  assert.equal((await restored.a.request(`/replays/${handId}`)).status,404);
  await finishHand(restored);const replay=await detail(restored.a,handId);
  assert.deepEqual(replay.frames.slice(0,prefix.length),prefix.map(p=>JSON.parse(p.frame_json)));
  await f.close();f=await fixture(config);
  assert.deepEqual(await detail(f.client(room.a.cookie),handId),replay);
  assert.equal(f.app.store.one('SELECT COUNT(*) n FROM hand_settlements WHERE hand_id=?',handId).n,1);
 }finally{await f?.close();await rm(dir,{recursive:true,force:true});}
 });

 test('legacy startup migration and pre-feature active finish expose result-only without fabricated cards or net',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tokem-replay-old-'));let f;try {
  const config={databasePath:join(dir,'test.sqlite'),now:()=>300_000};f=await fixture(config);
  const ended=await twoPlayerRoom(f);await act(ended.a,ended.id,{type:'fold'});const oldId=ended.snapshot.game.handId;
  const active=await twoPlayerRoom(f);const activeId=active.snapshot.game.handId;
  f.app.store.db.exec('DROP TABLE hand_replay_frames; DROP TABLE hand_replay_players; DROP TABLE hand_replays;');
  await f.close();f=await fixture(config);
  const own=f.client(ended.a.cookie);const legacy=await detail(own,oldId);
  assert.equal(legacy.summary.availability,'summary_only');assert.equal(legacy.summary.netChips,null);assert.equal(legacy.you.privateState,null);assert.equal(legacy.config,null);assert.deepEqual(legacy.frames,[]);
  const restored={id:active.id,a:{...f.client(active.a.cookie),account:active.a.account},b:{...f.client(active.b.cookie),account:active.b.account}};
  await act(restored.a,restored.id,{type:'fold'});assert.equal((await detail(restored.a,activeId)).summary.availability,'summary_only');
  await f.close();f=await fixture(config);assert.equal(f.app.store.one('SELECT COUNT(*) n FROM hand_replays').n,2);
  assert.deepEqual(await detail(f.client(ended.a.cookie),oldId),legacy);
 }finally{await f?.close();await rm(dir,{recursive:true,force:true});}
 });

 test('finished sequence respects opposite start/finish order and list/frame pagination is stable',async()=>{
 const f=await fixture();try {
  const first=await twoPlayerRoom(f);const a=first.a;const b=first.b;
  let state=(await a.request('/rooms',{name:'后开先结束',config:first.snapshot.config,requestId:randomUUID()})).body.data.snapshot;
  for(const player of [a,b]) state=(await player.request(`/rooms/${state.id}/join`,{stateVersion:state.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  state=(await a.request(`/rooms/${state.id}/start`,{stateVersion:state.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  const secondId=state.game.handId;await act(a,state.id,{type:'fold'});await finishHand(first);
  const page=(await a.request('/replays?limit=1')).body.data;assert.equal(page.hands[0].handId,first.snapshot.game.handId);assert.equal(page.nextBefore,page.hands[0].sequence);
  const next=(await a.request(`/replays?limit=1&before=${page.nextBefore}`)).body.data;assert.equal(next.hands[0].handId,secondId);assert.equal(next.nextBefore,null);
  const one=await detail(a,first.snapshot.game.handId,'?limit=1');const two=await detail(a,first.snapshot.game.handId,`?limit=1&afterStep=${one.nextAfterStep}`);
  assert.equal(one.frames[0].index,0);assert.equal(two.frames[0].index,1);
  assert.equal((await a.request('/replays?limit=51')).status,400);assert.equal((await a.request(`/replays/${secondId}?afterStep=-2`)).status,400);
 }finally{await f.close();}
 });

 test('frame persistence failure rolls back game/action request and successful retry records one real transition',async()=>{
 const f=await fixture();try {
  const room=await twoPlayerRoom(f);const handId=room.snapshot.game.handId;const requestId=randomUUID();
  f.app.store.db.exec("CREATE TRIGGER reject_frame BEFORE INSERT ON hand_replay_frames BEGIN SELECT RAISE(ABORT,'injected test'); END;");
  const failed=await act(room.a,room.id,{type:'call'},requestId,room.snapshot);assert.equal(failed.status,500);assert.equal(count(f,handId),1);
  assert.equal((await room.a.request(`/rooms/${room.id}`)).body.data.stateVersion,room.snapshot.stateVersion);
  f.app.store.db.exec('DROP TRIGGER reject_frame');
  assert.equal((await act(room.a,room.id,{type:'call'},requestId,room.snapshot)).body.ok,true);assert.equal(count(f,handId),2);
 }finally{await f.close();}
 });


 test('blinds-only all-in can finish in the start step without inventing preceding live states',async()=>{
 const f=await fixture();try {
  const room=await twoPlayerRoom(f,{gameId:'holdem',maxSeats:2,initialStack:1,smallBlind:1,bigBlind:1,turnTimeoutMs:30_000});
  assert.equal(room.snapshot.game.phase,'complete');const replay=await detail(room.a,room.snapshot.game.handId);
  assert.equal(replay.frames.length,1);assert.equal(replay.frames[0].kind,'start');assert.equal(replay.frames[0].game.phase,'complete');
  assert.deepEqual(replay.frames[0].streets.map(s=>s.phase),['flop','turn','river']);
  assert.equal(replay.summary.participants.reduce((n,p)=>n+p.finalStack,0),2);
 }finally{await f.close();}
 });

 test('zero-stack seated observer was not dealt in and cannot read the new replay',async()=>{
 const f=await fixture();try {
  const room=await threePlayerRoom(f);await act(room.players[0],room.id,{type:'fold'});await act(room.players[1],room.id,{type:'fold'});
  // Isolated stored fixture starts the next hand with an exhausted third seat.
  const row=f.app.store.one('SELECT engine_json FROM rooms WHERE id=?',room.id);const engine=JSON.parse(row.engine_json);engine.publicState.seats[2].stack=0;
  f.app.store.run('UPDATE rooms SET engine_json=? WHERE id=?',JSON.stringify(engine),room.id);
  const current=(await room.players[0].request(`/rooms/${room.id}`)).body.data;
  const started=(await room.players[0].request(`/rooms/${room.id}/start`,{stateVersion:current.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  const actor=room.players[started.game.actorSeat];await act(actor,room.id,{type:'fold'});
  const history=await detail(room.players[0],started.game.handId);assert.equal(history.summary.participants.length,2);
  assert.equal((await room.players[2].request(`/replays/${started.game.handId}`)).status,404);
  assert.equal((await room.players[2].request('/replays')).body.data.hands.some(h=>h.handId===started.game.handId),false);
 }finally{await f.close();}
 });
