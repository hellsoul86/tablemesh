import test from 'node:test';
import assert from 'node:assert/strict';
import {createTable,setSeats,startHand,applyAction,applyTimeout,getPublicState,getPrivateState,getLegalActions,evaluateHand,compareRanks} from '../dist/index.js';
const allCards=[...'23456789TJQKA'].flatMap(r=>[...'cdhs'].map(s=>r+s));
const deck=(prefix=[])=>[...prefix,...allCards.filter(c=>!prefix.includes(c))];
const identities=n=>Array.from({length:n},(_,seat)=>({seat,accountId:`p${seat}`,displayName:`Player ${seat}`}));
const config=(extra={})=>({gameId:'holdem',maxSeats:6,initialStack:1000,smallBlind:5,bigBlind:10,turnTimeoutMs:1000,...extra});
function accepted(result) {assert.equal(result.ok,true,result.ok?'':result.error.message);return result.transition.state;}
function begin(n=2,stacks,customDeck=deck(),extra={}) {
 let state=createTable(config(extra),identities(n));
 if(stacks) state.publicState.seats.forEach((p,i)=>p.stack=stacks[i]);
 return accepted(startHand(state,{handId:'h1',deck:customDeck,now:0}));
}
function step(state,action,extra={}) {
 const before=structuredClone(state);
 const next=accepted(applyAction(state,{seat:state.publicState.actorSeat,windowId:state.publicState.window.id,action,now:1,...extra}));
 assert.deepEqual(state,before,'reducer did not mutate input');
 return next;
}
function passive(state) {return step(state,getLegalActions(state,state.publicState.actorSeat).some(a=>a.type==='check')?{type:'check'}:{type:'call'});}
function finishPassively(state) {let count=0;while(state.publicState.phase!=='complete') {assert.ok(count++<100);state=passive(state);}return state;}
function total(state) {return state.publicState.seats.reduce((sum,p)=>sum+p.stack+(state.publicState.phase==='complete'?0:p.totalBet),0);}

test('configuration, seat identity, deck and hand id validation',()=>{
 assert.throws(()=>createTable(config({maxSeats:7}),identities(2)));
 assert.throws(()=>createTable(config(),[{seat:0,accountId:'a',displayName:'a'},{seat:1,accountId:'a',displayName:'a'}]));
 const waiting=createTable(config(),identities(2));
 assert.equal(startHand(waiting,{handId:'h',deck:deck().slice(1),now:0}).ok,false);
 assert.equal(startHand(waiting,{handId:'h',deck:Array(52).fill('As'),now:0}).ok,false);
 assert.equal(startHand(waiting,{handId:'h',deck:deck(),now:NaN}).ok,false);
 assert.equal(startHand(createTable(config(),identities(1)),{handId:'h',deck:deck(),now:0}).ok,false);
 const started=begin();assert.equal(startHand(started,{handId:'again',deck:deck(),now:0}).ok,false);
 assert.equal(setSeats(started,identities(2)).ok,false);
});
test('heads-up button posts small blind, acts first preflop and last postflop',()=>{
 let state=begin();const p=state.publicState;
 assert.equal(p.button,0);assert.equal(p.smallBlindSeat,0);assert.equal(p.bigBlindSeat,1);assert.equal(p.actorSeat,0);
 assert.equal(p.seats[0].streetBet,5);assert.equal(p.seats[1].streetBet,10);
 state=step(state,{type:'call'});assert.equal(state.publicState.actorSeat,1);
 state=step(state,{type:'check'});assert.equal(state.publicState.phase,'flop');assert.equal(state.publicState.actorSeat,1);
 assert.equal(state.publicState.board.length,3);
});
test('six-player order, burn cards and button rotation over later hands',()=>{
 let state=begin(6);assert.equal(state.publicState.actorSeat,3);
 const originalPrivate=getPrivateState(state,0).holeCards;
 assert.equal(originalPrivate.length,2);assert.equal(getPrivateState(state,1).holeCards[0],allCards[0]);
 state=finishPassively(state);assert.equal(state.publicState.board.length,5);
 assert.deepEqual(state.publicState.board,[allCards[13],allCards[14],allCards[15],allCards[17],allCards[19]]);
 state=accepted(startHand(state,{handId:'h2',deck:deck(),now:10}));
 assert.equal(state.publicState.button,1);assert.equal(state.publicState.smallBlindSeat,2);assert.equal(state.publicState.bigBlindSeat,3);assert.equal(state.publicState.actorSeat,4);
});
test('raises use total street contribution, minimum full raise and BB option',()=>{
 let state=begin(3);assert.equal(state.publicState.actorSeat,0);
 const min=getLegalActions(state,0).find(a=>a.type==='raise');assert.deepEqual(min,{type:'raise',minAmount:20,maxAmount:1000,allInOnly:false});
 assert.equal(applyAction(state,{seat:0,windowId:state.publicState.window.id,now:1,action:{type:'raise',amount:19}}).ok,false);
 state=step(state,{type:'raise',amount:25});assert.equal(state.publicState.minRaiseIncrement,15);
 assert.equal(state.publicState.seats[0].stack,975);
 assert.equal(getLegalActions(state,1).find(a=>a.type==='raise').minAmount,40);
 state=step(state,{type:'call'});state=step(state,{type:'call'});assert.equal(state.publicState.phase,'flop');
});
test('short all-in forces call without reopening a player who already acted',()=>{
 let state=begin(3,[100,15,100]);state=step(state,{type:'call'});
 assert.deepEqual(getLegalActions(state,1).find(a=>a.type==='raise'),{type:'raise',minAmount:15,maxAmount:15,allInOnly:true});
 state=step(state,{type:'raise',amount:15});assert.equal(state.publicState.minRaiseIncrement,10);
 assert.ok(getLegalActions(state,2).some(a=>a.type==='raise'),'BB has not acted yet');
 state=step(state,{type:'call'});assert.equal(state.publicState.actorSeat,0);
 assert.equal(getLegalActions(state,0).some(a=>a.type==='raise'),false);
 assert.equal(getLegalActions(state,0).find(a=>a.type==='call').amount,5);
 state=step(state,{type:'call'});assert.equal(state.publicState.phase,'flop');
});
test('multiple short all-ins cumulatively reopen a previous caller',()=>{
 let state=begin(4,[15,20,100,100]);
 state=step(state,{type:'call'}); // seat3 calls10
 state=step(state,{type:'raise',amount:15}); // seat0 short all-in +5
 state=step(state,{type:'raise',amount:20}); // seat1 short all-in +5
 assert.equal(state.publicState.minRaiseIncrement,10);
 state=step(state,{type:'call'}); // seat2
 assert.equal(state.publicState.actorSeat,3);
 assert.deepEqual(getLegalActions(state,3).find(a=>a.type==='raise'),{type:'raise',minAmount:30,maxAmount:100,allInOnly:false});
 state=step(state,{type:'raise',amount:30});
 assert.equal(state.publicState.actorSeat,2);
 state=step(state,{type:'call'});state=finishPassively(state);assert.equal(total(state),235);
});
test('NL short opening all-in requires a full BB increment, previous checks remain closed',()=>{
 let state=begin(3,[15,100,100]);while(state.publicState.phase==='preflop') state=passive(state);
 assert.equal(state.publicState.actorSeat,1);
 state=step(state,{type:'check'}); // seat1 already checked, cannot raise over short5
 state=step(state,{type:'check'}); // seat2 also checked
 state=step(state,{type:'raise',amount:5}); // seat0 all-in
 assert.equal(getLegalActions(state,1).some(a=>a.type==='raise'),false);
 state=step(state,{type:'call'});state=step(state,{type:'call'});
 assert.equal(state.publicState.phase,'turn');
 // A short opener lets an unacted player raise by a full BB, not complete to the BB.
 state=begin(3,[100,15,100]);while(state.publicState.phase==='preflop') state=passive(state);
 state=step(state,{type:'raise',amount:5});
 assert.deepEqual(getLegalActions(state,2).find(a=>a.type==='raise'),{type:'raise',minAmount:15,maxAmount:90,allInOnly:false});
 assert.equal(applyAction(state,{seat:2,windowId:state.publicState.window.id,now:1,action:{type:'raise',amount:10}}).ok,false);
 state=step(state,{type:'raise',amount:15});assert.equal(state.publicState.minRaiseIncrement,10);
 assert.equal(getLegalActions(state,0).find(a=>a.type==='raise').minAmount,25);
});
test('a full raise reopens betting for previous callers',()=>{
 let state=begin(3);state=step(state,{type:'call'});state=step(state,{type:'raise',amount:30});state=step(state,{type:'call'});
 assert.equal(state.publicState.actorSeat,0);assert.equal(getLegalActions(state,0).find(a=>a.type==='raise').minAmount,50);
});
test('side pots evaluate eligibility independently and return uncalled all-in excess',()=>{
 const customDeck=deck(['Ks','Qs','As','Kh','Qh','Ah','2c','3d','4c','8s','2d','9d','2h','Tc']);
 let state=begin(3,[100,300,200],customDeck);
 state=step(state,{type:'raise',amount:100});state=step(state,{type:'raise',amount:300});state=step(state,{type:'call'});
 assert.equal(state.publicState.phase,'complete');assert.equal(state.publicState.board.length,5);
 const settlement=state.publicState.settlement;
 assert.deepEqual(settlement.pots.map(p=>({amount:p.amount,winners:p.winners})),[{amount:300,winners:[0]},{amount:200,winners:[1]}]);
 assert.deepEqual(settlement.refunds,[{seat:1,amount:100}]);
 assert.deepEqual(state.publicState.seats.map(p=>p.stack),[300,300,0]);
 assert.equal(total(state),600);assert.ok(state.publicState.seats.every(p=>p.totalBet===0));
 assert.equal(applyTimeout(state,9999).ok,false);
});
test('folded contributions stay in pots, odd chip follows button clockwise among tied winners',()=>{
 const customDeck=deck(['2s','3s','4s','2h','3h','4h','5c','Ts','Js','Qs','5d','Ks','5h','As']);
 let state=begin(3,[100,100,100],customDeck,{smallBlind:1,bigBlind:2});
 state=step(state,{type:'raise',amount:5});state=step(state,{type:'call'});state=step(state,{type:'call'});
 assert.equal(state.publicState.actorSeat,1);state=step(state,{type:'fold'});state=finishPassively(state);
 assert.deepEqual(state.publicState.settlement.pots,[{amount:15,winners:[2,0],awards:[{seat:2,amount:8},{seat:0,amount:7}]}]);
 assert.deepEqual(state.publicState.seats.map(p=>p.stack),[102,95,103]);
 assert.deepEqual(state.publicState.revealedHands.map(p=>p.seat),[0,2]);
 assert.equal(total(state),300);
});
test('heads-up single fold pays contested blinds and refunds unmatched blind without revealing',()=>{
 let state=begin();state=step(state,{type:'fold'});
 assert.equal(state.publicState.phase,'complete');assert.deepEqual(state.publicState.revealedHands,[]);
 assert.deepEqual(state.publicState.settlement.pots,[{amount:10,winners:[1],awards:[{seat:1,amount:10}]}]);
 assert.deepEqual(state.publicState.settlement.refunds,[{seat:1,amount:5}]);
 assert.deepEqual(state.publicState.seats.map(p=>p.stack),[995,1005]);
});
test('short big blind keeps nominal BB bring-in, no raise against a sole all-in opponent',()=>{
 let state=begin(2,[100,3]);assert.equal(state.publicState.currentBet,10);
 assert.equal(getLegalActions(state,0).some(a=>a.type==='raise'),false);
 state=step(state,{type:'call'});assert.equal(state.publicState.phase,'complete');
 assert.deepEqual(state.publicState.settlement.refunds,[{seat:0,amount:7}]);assert.equal(total(state),103);
});
test('two blinds already all-in run out without an action window',()=>{
 const state=begin(2,[5,10]);assert.equal(state.publicState.phase,'complete');assert.equal(state.publicState.window,null);assert.equal(total(state),15);
});
test('timeout before deadline denied, exact deadline folds or checks once',()=>{
 let state=begin();const snapshot=structuredClone(state);
 assert.equal(applyTimeout(state,999).ok,false);assert.deepEqual(state,snapshot);
 assert.equal(applyAction(state,{seat:0,action:{type:'call'},windowId:state.publicState.window.id,now:1000}).ok,false);
 state=accepted(applyTimeout(state,1000));assert.equal(state.publicState.phase,'complete');assert.equal(applyTimeout(state,1000).ok,false);
 state=begin();state=step(state,{type:'call'});const window=state.publicState.window;
 state=accepted(applyTimeout(state,window.deadline));assert.equal(state.publicState.phase,'flop');
 assert.equal(state.publicState.seats[1].status,'active');
});
test('wrong seat/window, illegal check/call/raise and nonfinite amounts rejected without mutation',()=>{
 const state=begin();const original=structuredClone(state);const input={seat:0,windowId:state.publicState.window.id,now:1};
 for(const bad of [{seat:1,action:{type:'call'}},{windowId:'stale',action:{type:'call'}},{action:{type:'check'}},{action:{type:'dance'}},{action:{type:'raise',amount:NaN}},{action:{type:'raise',amount:20.5}},{action:{type:'raise',amount:1001}}])
  assert.equal(applyAction(state,{...input,...bad}).ok,false);
 assert.deepEqual(state,original);assert.deepEqual(getLegalActions(state,1),[]);
 let next=step(state,{type:'call'});assert.equal(applyAction(next,{seat:1,windowId:next.publicState.window.id,action:{type:'call'},now:1}).ok,false);
});
test('projection clones state and never includes deck/opponent hole cards',()=>{
 const state=begin(3);const pub=getPublicState(state);assert.equal('privateState' in pub,false);assert.equal('deck' in pub,false);
 assert.equal(JSON.stringify(pub).includes('holeCards'),false);assert.equal(getPrivateState(state,0).holeCards.length,2);
 assert.deepEqual(getPrivateState(state,99),{holeCards:[]});
 pub.seats[0].stack=0;getPrivateState(state,0).holeCards.pop();assert.equal(state.publicState.seats[0].stack,1000);
 assert.equal(state.privateState.holeCards[0].length,2);
 const roundtrip=JSON.parse(JSON.stringify(state));assert.deepEqual(getLegalActions(roundtrip,0),getLegalActions(state,0));
 assert.deepEqual(step(roundtrip,{type:'call'}),step(state,{type:'call'}));
});
test('leaving/rejoining and moving seat preserves chips, seating membership updates conservation baseline',()=>{
 let state=step(begin(),{type:'fold'});const remaining=state.publicState.seats[0].stack;
 const removal=setSeats(state,[identities(2)[1]]);assert.equal(removal.transition.settlement,null,'seating does not signal a second settlement');
 state=accepted(removal);assert.equal(state.publicState.seats.length,1);
 state=accepted(setSeats(state,[{seat:3,accountId:'p0',displayName:'Again'},identities(2)[1],{seat:4,accountId:'new',displayName:'New'}]));
 assert.equal(state.publicState.seats.find(p=>p.accountId==='p0').stack,remaining);
 state=accepted(startHand(state,{handId:'h2',deck:deck(),now:2}));assert.equal(total(state),3000);
});
test('completed folded cards stay with the owning account, never a replacement slot occupant',()=>{
 let state=step(begin(),{type:'fold'});
 assert.deepEqual(state.publicState.revealedHands,[]);
 const ownCards=getPrivateState(state,0).holeCards;
 assert.equal(ownCards.length,2);
 // Ordinary same-account reconnect does not lose that account's private observation.
 let reconnected=accepted(setSeats(state,identities(2)));
 assert.deepEqual(getPrivateState(reconnected,0).holeCards,ownCards);
 // Direct replacement of the same slot cannot inherit its previous occupant's cards.
 const replacement={seat:0,accountId:'newcomer',displayName:'Newcomer'};
 let replaced=accepted(setSeats(state,[replacement,identities(2)[1]]));
 assert.deepEqual(getPrivateState(replaced,0).holeCards,[]);
 assert.deepEqual(getPrivateState(replaced,1).holeCards,getPrivateState(state,1).holeCards);
 // Leaving first must clear orphaned cards, including access at the now-empty slot.
 state=accepted(setSeats(state,[identities(2)[1]]));
 assert.deepEqual(getPrivateState(state,0).holeCards,[]);
 state=accepted(setSeats(state,[replacement,identities(2)[1]]));
 assert.deepEqual(getPrivateState(state,0).holeCards,[]);
 // Seat changes preserve the account's own cards and cannot cross-contaminate accounts.
 const moved=accepted(setSeats(reconnected,[{...identities(2)[0],seat:1},{...identities(2)[1],seat:0}]));
 assert.deepEqual(getPrivateState(moved,1).holeCards,ownCards);
 assert.deepEqual(getPrivateState(moved,0).holeCards,getPrivateState(reconnected,1).holeCards);
});
test('completed winner display survives reconnect but clears when its slot identity changes',()=>{
 const completed=finishPassively(begin());
 assert.ok(completed.publicState.revealedHands.length>0);
 assert.ok(completed.publicState.settlement.pots.length>0);
 const same=accepted(setSeats(completed,identities(2)));
 assert.deepEqual(same.publicState.revealedHands,completed.publicState.revealedHands);
 assert.deepEqual(same.publicState.settlement,completed.publicState.settlement);
 const winnerSeat=completed.publicState.settlement.pots[0].winners[0];
 const changed=identities(2).map(p=>p.seat===winnerSeat?{...p,accountId:'newcomer',displayName:'Newcomer'}:p);
 const replacement=setSeats(completed,changed);const state=accepted(replacement);
 assert.deepEqual(state.publicState.revealedHands,[]);
 assert.equal(state.publicState.settlement,null,'new occupant has no previous winner label');
 assert.equal(replacement.transition.settlement,null,'no fresh settlement was emitted');
 assert.deepEqual(replacement.transition.events.map(e=>e.type),['seats_changed']);
 assert.equal(completed.publicState.settlement.pots[0].winners[0],winnerSeat,'historic input remains intact');
});
test('button skips busted and absent seats; payout does not repeat in next hand',()=>{
 const customDeck=deck(['Ks','As','Kh','Ah','2c','3d','4c','8s','2d','9d','2h','Tc']);
 let state=begin(2,[10,10],customDeck);state=step(state,{type:'call'});
 assert.equal(state.publicState.phase,'complete');assert.deepEqual(state.publicState.seats.map(p=>p.stack),[20,0]);
 assert.equal(startHand(state,{handId:'h2',deck:deck(),now:2}).ok,false);
 state=accepted(setSeats(state,[...identities(2),{seat:3,accountId:'new',displayName:'New'}]));
 const prior=total(state);state=accepted(startHand(state,{handId:'h2',deck:deck(),now:2}));
 assert.equal(state.publicState.button,3);assert.equal(state.publicState.smallBlindSeat,3);assert.equal(state.publicState.bigBlindSeat,0);assert.equal(total(state),prior);
});

test('best5of7 categories, wheel, kickers, double trips/full house and suits do not break ties',()=>{
 const rank=cards=>evaluateHand(cards.split(' '));
 assert.deepEqual(rank('As 2s 3s 4s 5s Kc Qd'),[8,5]);
 assert.deepEqual(rank('As Ah Ad Ac Ks Qc Jc'),[7,14,13]);
 assert.deepEqual(rank('As Ah Ad Ks Kh Kd 2c'),[6,14,13]);
 assert.deepEqual(rank('As Js 9s 4s 2s Kc Qc'),[5,14,11,9,4,2]);
 assert.deepEqual(rank('As 2d 3h 4c 5s Ks Qd'),[4,5]);
 assert.deepEqual(rank('As Ah Ad Ks Qh 3c 2d'),[3,14,13,12]);
 assert.deepEqual(rank('As Ah Ks Kh Qh Qc 2d'),[2,14,13,12]);
 assert.deepEqual(rank('As Ah Ks Qh Jc 3c 2d'),[1,14,13,12,11]);
 assert.deepEqual(rank('As Kh Qd Jc 9c 3c 2d'),[0,14,13,12,11,9]);
 assert.equal(compareRanks(rank('As Ah Ks Qh Jc'),rank('Ad Ac Kd Qc Jh')),0);
 assert.ok(compareRanks(rank('As Ah Ks Qh Jc'),rank('Ad Ac Kd Qc Th'))>0);
 assert.throws(()=>rank('As As Ks Qh Jc'));assert.throws(()=>rank('As Ks Qh Jc'));
});

test('deterministic random legal hands preserve chips, settle all contributions exactly once and terminate',()=>{
 let seed=720_031;const rng=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
 for(let run=0;run<200;run++) {
  const n=2+Math.floor(rng()*5);const stacks=Array.from({length:n},()=>1+Math.floor(rng()*300));
  const shuffled=[...allCards];for(let i=shuffled.length-1;i>0;i--) {const j=Math.floor(rng()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
  let state=begin(n,stacks,shuffled);const original=stacks.reduce((a,b)=>a+b,0);let steps=0;
  while(state.publicState.phase!=='complete') {
   assert.equal(total(state),original);assert.ok(++steps<150,'bounded hand');
   const actions=getLegalActions(state,state.publicState.actorSeat);assert.ok(actions.length>=2);
   const selected=actions[Math.floor(rng()*actions.length)];
   const action=selected.type==='raise'?{type:'raise',amount:Math.floor(rng()*(selected.maxAmount-selected.minAmount+1))+selected.minAmount}:{type:selected.type};
   const beforeContributions=state.publicState.seats.reduce((sum,p)=>sum+p.totalBet,0);
   const beforeStacks=state.publicState.seats.reduce((sum,p)=>sum+p.stack,0);
   const actor=state.publicState.seats.find(p=>p.seat===state.publicState.actorSeat);
   const added=action.type==='raise'?action.amount-actor.streetBet:action.type==='call'?Math.min(state.publicState.currentBet-actor.streetBet,actor.stack):0;
   state=step(state,action);
   if(state.publicState.phase==='complete') {
    const settlement=state.publicState.settlement;
    const paid=settlement.pots.reduce((sum,p)=>sum+p.awards.reduce((s,a)=>s+a.amount,0),0)+settlement.refunds.reduce((sum,p)=>sum+p.amount,0);
    assert.equal(paid,beforeContributions+added);
    assert.equal(state.publicState.seats.reduce((sum,p)=>sum+p.stack,0),beforeStacks-added+paid);
   }
  }
  assert.equal(total(state),original);assert.equal(state.publicState.window,null);
  assert.ok(state.publicState.seats.every(p=>Number.isSafeInteger(p.stack)&&p.stack>=0));
 }
});
