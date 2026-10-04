import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,twoPlayerRoom,threePlayerRoom,finishHand,defaultRoomConfig} from './helpers.mjs';
const view=async(p,id)=>(await p.request(`/rooms/${id}`)).body.data;
const events=async(p,id,after=0)=>(await p.request(`/rooms/${id}/events?after=${after}`)).body.data.events;
async function act(p,id,action,extra={}) {const s=await view(p,id);return p.request(`/rooms/${id}/actions`,{stateVersion:s.stateVersion,windowId:s.game.window.id,requestId:randomUUID(),action,...extra});}
const lastAction=es=>es.filter(e=>e.type==='room_action').at(-1).payload.steps[0];
function safe(es) {const text=JSON.stringify(es);for(const field of ['holeCards','privateState','own_cards','deck','token','password','you'])assert.equal(new RegExp(`"${field}"`).test(text),false,field);}
function strip(f,id) {
 for(const row of f.app.store.all('SELECT cursor,public_payload_json FROM room_events WHERE room_id=?',id)) {
  const p=JSON.parse(row.public_payload_json);delete p.steps;delete p.handId;if(p.settlement)p.handId=p.settlement.handId;
  if(p.participants)p.participants=p.participants.map(({seat,accountId,displayName})=>({seat,accountId,displayName}));
  delete p.participant;delete p.abandoned;
  f.app.store.run('UPDATE room_events SET public_payload_json=? WHERE room_id=? AND cursor=?',JSON.stringify(p),id,row.cursor);
 }
 return f.app.store.all('SELECT * FROM room_events WHERE room_id=? ORDER BY cursor',id);
}

test('accepted payments and frozen membership identities survive settlement refunds without private fields',async()=>{
 const f=await fixture();try {const r=await twoPlayerRoom(f);let es=await events(r.a,r.id);
 const start=es.find(e=>e.type==='room_start');assert.equal(start.payload.handId,r.snapshot.game.handId);assert.equal(start.payload.steps[0].actor,null);assert.equal(start.payload.steps[0].board.length,0);assert.equal(start.payload.participants[0].startingStack,1000);assert.equal(start.payload.participants[0].finalStack,null);
 const joins=es.filter(e=>e.type==='room_join');assert.equal(joins[0].payload.participant.accountId,r.a.account.id);
 await act(r.a,r.id,{type:'call'});es=await events(r.a,r.id);assert.equal(lastAction(es).actionDetail.paid,5);assert.equal(lastAction(es).actor.displayName,r.a.displayName);
 await act(r.b,r.id,{type:'raise',amount:100});es=await events(r.a,r.id);assert.equal(lastAction(es).actionDetail.paid,90);assert.equal(lastAction(es).actionDetail.committedTo,100);
 await act(r.a,r.id,{type:'fold'});es=await events(r.a,r.id);const settled=es.find(e=>e.type==='hand_settled');assert.equal(settled.payload.participants.find(p=>p.seat===1).netChips,10);assert.equal(settled.payload.participants.find(p=>p.seat===1).finalStack,1010);assert.deepEqual(settled.payload.settlement.refunds,[{seat:1,amount:90}]);
 let s=await view(r.b,r.id);await r.b.request(`/rooms/${r.id}/leave`,{stateVersion:s.stateVersion,requestId:randomUUID()});const newcomer=await f.register('新人');s=await view(r.a,r.id);await newcomer.request(`/rooms/${r.id}/join`,{stateVersion:s.stateVersion,seat:1,requestId:randomUUID()});
 es=await events(newcomer,r.id);assert.equal(es.find(e=>e.type==='hand_settled').payload.participants.find(p=>p.seat===1).accountId,r.b.account.id);assert.equal(es.filter(e=>e.type==='room_leave').at(-1).payload.participant.accountId,r.b.account.id);safe(es);
 }finally{await f.close();}
});

test('dedup and rejected actions add no events; a failed multi-event commit rolls back the complete action',async()=>{
 const f=await fixture();try {const r=await twoPlayerRoom(f);const s=await view(r.a,r.id);const body={stateVersion:s.stateVersion,windowId:s.game.window.id,requestId:randomUUID(),action:{type:'call'}};
 await r.a.request(`/rooms/${r.id}/actions`,body);const accepted=await events(r.a,r.id);
 assert.equal((await r.a.request(`/rooms/${r.id}/actions`,body)).body.data.replayed,true);assert.deepEqual(await events(r.a,r.id),accepted);
 assert.equal((await r.a.request(`/rooms/${r.id}/actions`,{...body,requestId:randomUUID()})).body.error.code,'VERSION_CONFLICT');assert.deepEqual(await events(r.a,r.id),accepted);
 f.app.store.db.exec("CREATE TRIGGER reject_settlement_event BEFORE INSERT ON room_events WHEN NEW.type='hand_settled' BEGIN SELECT RAISE(ABORT,'test injected'); END;");
 assert.equal((await act(r.b,r.id,{type:'fold'})).status,500);assert.deepEqual(await events(r.a,r.id),accepted);assert.equal((await view(r.a,r.id)).game.phase,'preflop');
 assert.equal(f.app.store.one('SELECT COUNT(*) n FROM hand_settlements').n,0);
 }finally{await f.close();}
});

test('street boundaries and atomic all-in runout retain pre-action payment and only public boards',async()=>{
 const f=await fixture();try {const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});await act(r.b,r.id,{type:'check'});
 let es=await events(r.a,r.id);let step=lastAction(es);assert.equal(step.actionDetail.street,'preflop');assert.equal(step.phase,'flop');assert.equal(step.streets[0].phase,'flop');assert.equal(step.streets[0].board.length,3);
 await act(r.b,r.id,{type:'raise',amount:990});await act(r.a,r.id,{type:'call'});es=await events(r.a,r.id);step=lastAction(es);assert.equal(step.actionDetail.paid,990);assert.equal(step.actionDetail.allIn,true);assert.equal(step.actionDetail.street,'flop');assert.equal(step.phase,'complete');assert.deepEqual(step.streets.map(s=>s.phase),['turn','river']);assert.equal(step.board.length,5);safe(es);
 }finally{await f.close();}
});

test('timeout check and actual abandon fold are ordered public reductions with distinct sources',async()=>{
 let now=100000;const f=await fixture({now:()=>now});try {const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});let s=await view(r.b,r.id);now=s.game.window.deadline;await f.app.runTimeouts();
 let es=await events(r.a,r.id);const timeout=es.find(e=>e.type==='room_timeout').payload.steps[0];assert.equal(timeout.actor.accountId,r.b.account.id);assert.equal(timeout.actionDetail.source,'timeout');assert.equal(timeout.actionDetail.type,'check');assert.equal(timeout.actionDetail.paid,0);
 const t=await threePlayerRoom(f);const[a,b,c]=t.players;await b.request(`/rooms/${t.id}/leave`,{stateVersion:t.snapshot.stateVersion,requestId:randomUUID(),confirmAbandon:true});await act(a,t.id,{type:'call'});
 es=await events(a,t.id);const action=es.filter(e=>e.type==='room_action').at(-1);assert.equal(action.payload.steps.length,2);assert.deepEqual(action.payload.steps.map(s=>s.actionDetail.source),['player','abandon']);assert.equal(action.payload.steps[1].actor.accountId,b.account.id);assert.equal(action.payload.steps[1].actionDetail.type,'fold');
 assert.equal(es.find(e=>e.type==='room_leave').payload.abandoned,true);safe(es);
 }finally{await f.close();}
});

test('old FULL event projection matches a complete trace, is page-stable and never rewrites JSON or exposes future start data',async()=>{
 const f=await fixture();try {const r=await twoPlayerRoom(f);await act(r.a,r.id,{type:'call'});await act(r.b,r.id,{type:'check'});await finishHand(r);const current=await events(r.a,r.id);const raw=strip(f,r.id);
 const old=await events(r.a,r.id);assert.deepEqual(old.filter(e=>e.type==='room_action').map(e=>e.payload.steps),current.filter(e=>e.type==='room_action').map(e=>e.payload.steps));
 const start=old.find(e=>e.type==='room_start');assert.deepEqual(start.payload.steps[0].board,[]);assert.equal(start.payload.participants[0].finalStack,null);assert.equal(start.payload.steps[0].actionDetail,null);
 const boundary=old.find(e=>e.type==='room_action'&&e.payload.steps[0].phase==='flop');assert.equal(boundary.payload.steps[0].board.length,3);assert.equal(boundary.payload.steps[0].streets.length,1);
 const paged=await events(r.a,r.id,boundary.cursor-1);assert.deepEqual(paged,old.filter(e=>e.cursor>=boundary.cursor));safe(old);assert.deepEqual(f.app.store.all('SELECT * FROM room_events WHERE room_id=? ORDER BY cursor',r.id),raw);
 const event=raw.find(e=>e.type==='room_action');f.app.store.run('DELETE FROM room_events WHERE room_id=? AND cursor=?',r.id,event.cursor);const gap=await events(r.a,r.id);assert.equal(gap.filter(e=>e.type==='room_action').every(e=>e.payload.steps===undefined),true);
 f.app.store.run('INSERT INTO room_events VALUES(?,?,?,?,?)',event.room_id,event.cursor,event.state_version,event.type,event.public_payload_json);const bad=JSON.parse(event.public_payload_json);bad.actorSeat=99;f.app.store.run('UPDATE room_events SET public_payload_json=? WHERE room_id=? AND cursor=?',JSON.stringify(bad),r.id,event.cursor);assert.equal((await events(r.a,r.id)).filter(e=>e.type==='room_action').every(e=>e.payload.steps===undefined),true);
 }finally{await f.close();}
});
