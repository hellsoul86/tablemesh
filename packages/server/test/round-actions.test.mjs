import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHand } from '@tablemesh/core';
import { fixture, twoPlayerRoom, threePlayerRoom, finishHand, defaultRoomConfig } from './helpers.mjs';
const view=async(p,id)=>(await p.request(`/rooms/${id}`)).body.data;
const seat=(s,n)=>s.roundActions.seats.find(p=>p.seat===n);
async function act(p,id,action,body={}) {const s=await view(p,id);return p.request(`/rooms/${id}/actions`,{stateVersion:s.stateVersion,windowId:s.game.window.id,requestId:randomUUID(),action,...body});}
async function replay(p,handId,query='') {const r=await p.request(`/replays/${handId}${query}`);assert.equal(r.body.ok,true);return r.body.data;}
function legacyFrames(f,roomId,handId) {
 const rows=f.app.store.all('SELECT step_index,frame_json FROM hand_replay_frames WHERE hand_id=? ORDER BY step_index',handId);
 for(const row of rows) {const frame=JSON.parse(row.frame_json);delete frame.roundActions;delete frame.actionDetail;f.app.store.run('UPDATE hand_replay_frames SET frame_json=? WHERE hand_id=? AND step_index=?',JSON.stringify(frame),handId,row.step_index);}
 f.app.store.run('DELETE FROM room_round_actions WHERE room_id=?',roomId);
 return f.app.store.all('SELECT frame_json FROM hand_replay_frames WHERE hand_id=? ORDER BY step_index',handId);
}

 test('blinds are contributions without actions; paid call, checks and bet/raise labels follow the correct street',async()=>{
 const f=await fixture();try {
  const r=await twoPlayerRoom(f);let s=r.snapshot;
  assert.equal(seat(s,0).streetCommitted,5);assert.equal(seat(s,1).streetCommitted,10);assert.equal(seat(s,1).lastAction,null);assert.equal(seat(s,1).actionKnown,true);
  s=(await act(r.a,r.id,{type:'call'})).body.data.snapshot;assert.equal(seat(s,0).lastAction.type,'call');assert.equal(seat(s,0).lastAction.paid,5);assert.equal(seat(s,0).lastAction.committedTo,10);
  s=(await act(r.b,r.id,{type:'check'})).body.data.snapshot;assert.equal(s.roundActions.street,'flop');assert.equal(seat(s,0).lastAction,null);assert.equal(seat(s,1).lastAction,null);assert.equal(seat(s,0).streetCommitted,0);assert.equal(seat(s,0).handCommitted,10);
  s=(await act(r.b,r.id,{type:'raise',amount:20})).body.data.snapshot;assert.equal(seat(s,1).lastAction.type,'bet');assert.equal(seat(s,1).lastAction.paid,20);
  s=(await act(r.a,r.id,{type:'raise',amount:40})).body.data.snapshot;assert.equal(seat(s,0).lastAction.type,'raise');assert.equal(seat(s,0).lastAction.paid,40);
  await act(r.b,r.id,{type:'call'});const done=await finishHand(r);assert.equal(done.roundActions.street,'river');
  const history=await replay(r.a,r.snapshot.game.handId);const boundary=history.frames.find(x=>x.game.phase==='flop');assert.equal(boundary.actionDetail.type,'check');assert.equal(boundary.actionDetail.street,'preflop');assert.equal(boundary.actionDetail.paid,0);assert.equal(boundary.roundActions.street,'flop');
  const call=history.frames.find(x=>x.actionDetail?.street==='flop'&&x.actionDetail.type==='call');assert.equal(call.actionDetail.paid,20);assert.equal(call.actionDetail.committedTo,40);assert.equal(call.roundActions.street,'turn');
 }finally{await f.close();}
 });

 test('terminal gross commitments include uncalled chips while refunds and net payouts remain separate',async()=>{
 const f=await fixture();try {
  const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});await act(r.b,r.id,{type:'raise',amount:100});const s=(await act(r.a,r.id,{type:'fold'})).body.data.snapshot;
  assert.equal(s.game.phase,'complete');assert.equal(s.game.seats[1].stack,1010);assert.equal(s.game.seats[1].streetBet,0);
  assert.equal(seat(s,1).lastAction.paid,90);assert.equal(seat(s,1).lastAction.committedTo,100);assert.equal(seat(s,1).streetCommitted,100);assert.equal(seat(s,1).handCommitted,100);
  assert.deepEqual(s.game.settlement.refunds,[{seat:1,amount:90}]);assert.equal(s.game.settlement.pots[0].amount,20);
  assert.equal(seat(s,0).lastAction.type,'fold');assert.equal(seat(s,0).lastAction.paid,0);
 }finally{await f.close();}
 });

 test('short all-in call pays remaining stack and preflop runout retains its actual last betting round',async()=>{
 const f=await fixture();try {
  const r=await threePlayerRoom(f);await act(r.players[0],r.id,{type:'call'});await act(r.players[1],r.id,{type:'raise',amount:1000});await act(r.players[2],r.id,{type:'call'});const s=(await act(r.players[0],r.id,{type:'call'})).body.data.snapshot;
  assert.equal(s.game.phase,'complete');assert.equal(s.roundActions.street,'preflop');assert.equal(seat(s,0).lastAction.paid,990);assert.equal(seat(s,0).lastAction.allIn,true);assert.equal(seat(s,0).streetCommitted,1000);assert.equal(seat(s,0).handCommitted,1000);
  assert.equal(s.roundActions.seats.reduce((n,p)=>n+p.handCommitted,0),3000);
  const history=await replay(r.players[0],r.snapshot.game.handId);assert.equal(history.frames.at(-1).actionDetail.paid,990);assert.equal(history.frames.at(-1).roundActions.street,'preflop');
 }finally{await f.close();}
 });

 test('timeout and abandonment provenance is attached only to the action actually applied',async()=>{
 let now=100_000;const f=await fixture({now:()=>now});try {
  const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});let s=await view(r.b,r.id);now=s.game.window.deadline;await f.app.runTimeouts();
  const historyId=r.snapshot.game.handId;s=await view(r.a,r.id);await act(r.b,r.id,{type:'fold'});const history=await replay(r.a,historyId);
  const automatic=history.frames.find(x=>x.kind==='timeout');assert.equal(automatic.actionDetail.source,'timeout');assert.equal(automatic.actionDetail.type,'check');assert.equal(automatic.actionDetail.paid,0);
  const t=await threePlayerRoom(f);const [a,b,c]=t.players;await b.request(`/rooms/${t.id}/leave`,{stateVersion:t.snapshot.stateVersion,requestId:randomUUID(),confirmAbandon:true});await act(a,t.id,{type:'call'});await act(c,t.id,{type:'fold'});
  const trace=await replay(b,t.snapshot.game.handId);const marker=trace.frames.find(x=>x.kind==='abandon');assert.equal(marker.action,null);assert.equal(marker.roundActions.seats[1].lastAction,null);
  const folded=trace.frames.find(x=>x.kind==='abandon_fold');assert.equal(folded.actionDetail.source,'abandon');assert.equal(folded.actionDetail.type,'fold');assert.equal(folded.actionDetail.paid,0);
 }finally{await f.close();}
 });

 test('dedup, stale action and transaction failure do not change labels or payments',async()=>{
 const f=await fixture();try {
  const r=await twoPlayerRoom(f);const meta={stateVersion:r.snapshot.stateVersion,windowId:r.snapshot.game.window.id,requestId:randomUUID()};
  const accepted=(await act(r.a,r.id,{type:'call'},meta)).body.data.snapshot;
  assert.equal((await act(r.a,r.id,{type:'call'},meta)).body.data.replayed,true);assert.deepEqual((await view(r.a,r.id)).roundActions,accepted.roundActions);
  assert.equal((await act(r.b,r.id,{type:'fold'},{...meta,requestId:randomUUID()})).body.error.code,'VERSION_CONFLICT');assert.deepEqual((await view(r.a,r.id)).roundActions,accepted.roundActions);
  f.app.store.db.exec("CREATE TRIGGER reject_action_frame BEFORE INSERT ON hand_replay_frames BEGIN SELECT RAISE(ABORT,'test injected'); END;");
  assert.equal((await act(r.b,r.id,{type:'check'})).status,500);assert.deepEqual((await view(r.a,r.id)).roundActions,accepted.roundActions);
 }finally{await f.close();}
 });

 test('old full projection, paginated middle frame and completed live bootstrap agree without rewriting old JSON',async()=>{
 const f=await fixture();try {
  const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});await act(r.b,r.id,{type:'raise',amount:100});await act(r.a,r.id,{type:'call'});await finishHand(r);
  const handId=r.snapshot.game.handId;const original=await replay(r.a,handId);const finalRound=(await view(r.a,r.id)).roundActions;
  const raw=legacyFrames(f,r.id,handId);const old=await replay(r.a,handId);assert.deepEqual(old.frames,original.frames);assert.deepEqual((await view(r.a,r.id)).roundActions,finalRound);
  const page=await replay(r.a,handId,'?afterStep=2&limit=1');assert.deepEqual(page.frames,[original.frames[3]]);
  assert.deepEqual(f.app.store.all('SELECT frame_json FROM hand_replay_frames WHERE hand_id=? ORDER BY step_index',handId),raw);
  let s=await view(r.a,r.id);s=(await r.a.request(`/rooms/${r.id}/leave`,{stateVersion:s.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  const newcomer=await f.register('新席');await newcomer.request(`/rooms/${r.id}/join`,{stateVersion:s.stateVersion,seat:0,requestId:randomUUID()});
  const changed=await view(newcomer,r.id);assert.equal(seat(changed,0).lastAction,null);assert.equal(seat(changed,0).actionKnown,false);assert.equal(seat(changed,0).streetCommitted,null);
 }finally{await f.close();}
 });

 test('blind-only immediate completion has no invented action; absent legacy trace has unknown terminal commitments',async()=>{
 const f=await fixture();try {
  const r=await twoPlayerRoom(f,{...defaultRoomConfig,initialStack:1,smallBlind:1,bigBlind:1});const s=r.snapshot;
  assert.equal(s.game.phase,'complete');assert.equal(s.roundActions.street,'preflop');for(const p of s.roundActions.seats){assert.equal(p.streetCommitted,1);assert.equal(p.handCommitted,1);assert.equal(p.lastAction,null);}
  legacyFrames(f,r.id,s.game.handId);assert.deepEqual((await view(r.a,r.id)).roundActions,s.roundActions);
  f.app.store.run('DELETE FROM hand_replay_frames WHERE hand_id=?',s.game.handId);
  f.app.store.run("UPDATE hand_replays SET availability='summary_only' WHERE hand_id=?",s.game.handId);
  const legacy=await view(r.a,r.id);assert.equal(legacy.roundActions.street,null);for(const p of legacy.roundActions.seats){assert.equal(p.actionKnown,false);assert.equal(p.streetCommitted,null);assert.equal(p.lastAction,null);}
 }finally{await f.close();}
 });

 test('restart retains active labels and actual payments in a separate persistent test database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tokem-actions-'));let f;try {
  const config={databasePath:join(dir,'fixture.sqlite'),now:()=>200_000};f=await fixture(config);const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});const saved=(await view(r.a,r.id)).roundActions;
  await f.close();f=await fixture(config);assert.deepEqual((await view(f.client(r.a.cookie),r.id)).roundActions,saved);
 }finally{await f?.close();await rm(dir,{recursive:true,force:true});}
 });

 test('fixed last-call winner keeps paid five independently of a twenty-chip award, including old full pagination',async()=>{
 const f=await fixture();try {
  const a=await f.register('AA');const b=await f.register('KK');const config={...defaultRoomConfig,initialStack:10};
  let s=(await a.request('/rooms',{name:'确定性支付fixture',config,requestId:randomUUID()})).body.data.snapshot;
  for(const p of [a,b])s=(await p.request(`/rooms/${s.id}/join`,{stateVersion:s.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  const row=f.app.store.one('SELECT * FROM rooms WHERE id=?',s.id);const before=JSON.parse(row.engine_json);const handId=randomUUID();
  const prefix=['Kc','Ac','Kd','Ad','2c','3d','7h','9s','4c','Jd','5c','Qh'];const deck=[...prefix,...[...'23456789TJQKA'].flatMap(rank=>[...'cdhs'].map(suit=>rank+suit)).filter(c=>!prefix.includes(c))];
  // Seed only this isolated fixture through the actual pure reducer and the
  // real capture transaction; gameplay and history below use HTTP.
  f.app.store.transaction(()=>{const state=f.app.reduce(startHand(before,{handId,deck,now:f.app.config.now()}),s.id,{kind:'start',at:f.app.config.now(),before});f.app.persistRoom(row,state,'room_start',{phase:state.publicState.phase});});
  const ended=(await act(a,s.id,{type:'call'})).body.data.snapshot;assert.equal(ended.game.seats[0].stack,20);assert.equal(seat(ended,0).lastAction.paid,5);assert.equal(seat(ended,0).handCommitted,10);
  const full=await replay(a,handId);legacyFrames(f,s.id,handId);const page=await replay(a,handId,'?afterStep=0&limit=1');assert.deepEqual(page.frames,[full.frames[1]]);assert.equal(page.frames[0].actionDetail.paid,5);
 }finally{await f.close();}
 });

 test('an underfunded all-in call reports the two chips actually paid, not ninety-five owed',async()=>{
 const f=await fixture();try {
  const players=await Promise.all(['甲','乙','丙'].map(label=>f.register(label)));
  let s=(await players[0].request('/rooms',{name:'短筹码fixture',config:{...defaultRoomConfig,maxSeats:3},requestId:randomUUID()})).body.data.snapshot;
  for(const p of players)s=(await p.request(`/rooms/${s.id}/join`,{stateVersion:s.stateVersion,requestId:randomUUID()})).body.data.snapshot;
  const row=f.app.store.one('SELECT * FROM rooms WHERE id=?',s.id);const before=JSON.parse(row.engine_json);before.publicState.seats[1].stack=7;
  const deck=[...'23456789TJQKA'].flatMap(rank=>[...'cdhs'].map(suit=>rank+suit));const handId=randomUUID();
  f.app.store.transaction(()=>{const state=f.app.reduce(startHand(before,{handId,deck,now:f.app.config.now()}),s.id,{kind:'start',at:f.app.config.now(),before});f.app.persistRoom(row,state,'room_start',{phase:state.publicState.phase});});
  await act(players[0],s.id,{type:'raise',amount:100});
  const updated=(await act(players[1],s.id,{type:'call'})).body.data.snapshot;
  const status=seat(updated,1);assert.equal(status.lastAction.paid,2);assert.equal(status.lastAction.committedTo,7);assert.equal(status.lastAction.allIn,true);assert.equal(status.streetCommitted,7);assert.equal(status.handCommitted,7);
 }finally{await f.close();}
 });
