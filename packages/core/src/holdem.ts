import type { ApplyActionInput, Card, EngineEvent, EngineResult, HandSettlement, HoldemConfig,
 HoldemEngineState, HoldemPrivateState, HoldemPublicState, LegalAction, PublicSeat,
 SeatIdentity, SeatIndex, StartHandInput } from './contracts.js';
import { compareRanks, evaluateHand } from './evaluator.js';

interface Metadata {
 pending: SeatIndex[];
 actedAt: Record<string, number>;
 actedIncrement: Record<string, number>;
 sequence: number;
 handTotal: number;
 retainedStacks: Record<string, number>;
}
const meta = (state: HoldemEngineState): Metadata => state.privateState as unknown as Metadata;
const copy = <T>(value: T): T => structuredClone(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const live = (s: HoldemEngineState): boolean => s.publicState.phase !== 'waiting' && s.publicState.phase !== 'complete';
const active = (s: HoldemEngineState): PublicSeat[] => s.publicState.seats.filter(p => p.status === 'active');
const contenders = (s: HoldemEngineState): PublicSeat[] => s.publicState.seats.filter(p => p.status === 'active' || p.status === 'all-in');
const invalid = (message: string): EngineResult => ({ ok:false, error:{ code:'INVALID_INPUT', message } });
const illegal = (message: string): EngineResult => ({ ok:false, error:{ code:'ILLEGAL_ACTION', message } });
function configValid(config: HoldemConfig): boolean {
 return config.gameId === 'holdem' && integer(config.maxSeats) && config.maxSeats >= 2 && config.maxSeats <= 6
  && integer(config.initialStack) && config.initialStack > 0 && config.initialStack <= 1_000_000_000
  && integer(config.smallBlind) && config.smallBlind > 0 && integer(config.bigBlind)
  && config.bigBlind >= config.smallBlind && config.bigBlind <= config.initialStack
  && integer(config.turnTimeoutMs) && config.turnTimeoutMs >= 1 && config.turnTimeoutMs <= 86_400_000;
}
function seatsValid(config: HoldemConfig, seats: SeatIdentity[]): boolean {
 return Array.isArray(seats) && seats.length <= config.maxSeats
  && seats.every(p => integer(p.seat) && p.seat < config.maxSeats && typeof p.accountId === 'string' && p.accountId.length > 0 && typeof p.displayName === 'string')
  && new Set(seats.map(p => p.seat)).size === seats.length && new Set(seats.map(p => p.accountId)).size === seats.length;
}
function initialPublic(config: HoldemConfig, seats: SeatIdentity[]): HoldemPublicState {
 return { gameId:'holdem', handId:null, phase:'waiting',
  seats:seats.map(p => ({ ...p, stack:config.initialStack, streetBet:0,totalBet:0,status:'waiting' as const })).sort((a,b) => a.seat-b.seat),
  board:[], button:null,smallBlindSeat:null,bigBlindSeat:null,actorSeat:null,
  currentBet:0,minRaiseIncrement:config.bigBlind,pots:[],window:null,revealedHands:[],settlement:null };
}
export function createTable(config: HoldemConfig, seats: SeatIdentity[]): HoldemEngineState {
 if (!configValid(config) || !seatsValid(config,seats)) throw new Error('Invalid table config or seats');
 return { config:copy(config),publicState:initialPublic(config,seats),privateState:{
  deck:[],deckCursor:0,holeCards:{},actedSeats:[],raiseRights:[],
  pending:[],actedAt:{},actedIncrement:{},sequence:0,handTotal:0,retainedStacks:{} } };
}
export function setSeats(state: HoldemEngineState, seats: SeatIdentity[]): EngineResult {
 if (!seatsValid(state.config,seats)) return invalid('Invalid or duplicate seat identity');
 if (live(state)) return illegal('Seat changes wait until hand completes');
 const next=copy(state);
 const sameOccupants=seats.length===state.publicState.seats.length && seats.every(identity=>
  state.publicState.seats.some(previous=>previous.seat===identity.seat && previous.accountId===identity.accountId));
 // Completed hand displays reference the old seat identities. Once those identities
 // change, the historical event remains authoritative, not the current seating chart.
 if(next.publicState.phase==='complete' && !sameOccupants) {
  next.publicState.revealedHands=[];
  next.publicState.settlement=null;
 }
 const retained=meta(next).retainedStacks;
 const cardsByAccount=new Map(state.publicState.seats.map(player=>[
  player.accountId, state.privateState.holeCards[player.seat] ?? []
 ]));
 next.privateState.holeCards={};
 for(const identity of seats) {
  const ownCards=cardsByAccount.get(identity.accountId);
  if(ownCards?.length) next.privateState.holeCards[identity.seat]=copy(ownCards);
 }
 for (const player of next.publicState.seats) retained[player.accountId]=player.stack;
 next.publicState.seats=seats.map(identity => {
  const stack=retained[identity.accountId] ?? state.config.initialStack;
  return { ...identity, stack,streetBet:0,totalBet:0,status:stack > 0 ? 'waiting' as const : 'out' as const };
 }).sort((a,b) => a.seat-b.seat);
 meta(next).handTotal=next.publicState.seats.reduce((sum,p)=>sum+p.stack,0);
 return success(next,[{type:'seats_changed',payload:{seats:next.publicState.seats.map(p=>p.seat)},audience:'public'}]);
}
function nextSeat(seats: PublicSeat[], after: SeatIndex): PublicSeat {
 const ordered=[...seats].sort((a,b)=>a.seat-b.seat);
 const result=ordered.find(p=>p.seat>after) ?? ordered[0];
 if (!result) throw new Error('Cannot select from empty seats');
 return result;
}
function clockwise(seats: PublicSeat[], after: SeatIndex): PublicSeat[] {
 return [...seats].sort((a,b)=> ((a.seat-after-1+1000)%1000)-((b.seat-after-1+1000)%1000));
}
function draw(state: HoldemEngineState): Card {
 const card=state.privateState.deck[state.privateState.deckCursor++];
 if (!card) throw new Error('Exhausted validated deck');
 return card;
}
function pay(player: PublicSeat, amount: number): void {
 const paid=Math.min(amount,player.stack);
 player.stack-=paid;player.streetBet+=paid;player.totalBet+=paid;
 if (player.stack === 0) player.status='all-in';
}
function canRaise(state: HoldemEngineState, player: PublicSeat): boolean {
 const m=meta(state);
 const last=m.actedAt[player.seat];
 return active(state).some(p=>p.seat !== player.seat)
  && (last === undefined || state.publicState.currentBet-last >= (m.actedIncrement[player.seat] ?? state.publicState.minRaiseIncrement));
}
export function getLegalActions(state: HoldemEngineState, seat: SeatIndex): LegalAction[] {
 const pub=state.publicState;
 const player=pub.seats.find(p=>p.seat===seat);
 if (!live(state) || !player || player.status !== 'active' || pub.actorSeat !== seat) return [];
 const owed=Math.max(0,pub.currentBet-player.streetBet);
 const actions: LegalAction[]=[{type:'fold'},owed === 0 ? {type:'check'} : {type:'call',amount:Math.min(owed,player.stack)}];
 const maxAmount=player.streetBet+player.stack;
 if (maxAmount>pub.currentBet && canRaise(state,player)) {
  const fullMinimum=pub.currentBet+pub.minRaiseIncrement;
  actions.push({type:'raise',minAmount:Math.min(fullMinimum,maxAmount),maxAmount,allInOnly:maxAmount<fullMinimum});
 }
 return actions;
}
function setWindow(state: HoldemEngineState, seat: SeatIndex, now: number): void {
 const pub=state.publicState;
 const m=meta(state);
 m.sequence++;
 pub.actorSeat=seat;
 pub.window={id:`${pub.handId}:${m.sequence}`,kind:'turn',eligibleSeats:[seat],deadline:now+state.config.turnTimeoutMs,responseMode:'single'};
 state.privateState.raiseRights=active(state).filter(p=>canRaise(state,p)).map(p=>p.seat);
}
function potsFromContributions(state: HoldemEngineState): { amount:number; contributors:PublicSeat[]; eligible:PublicSeat[] }[] {
 const players=state.publicState.seats;
 const levels=[...new Set(players.map(p=>p.totalBet).filter(b=>b>0))].sort((a,b)=>a-b);
 let lower=0;
 return levels.map(level=>{
  const contributors=players.filter(p=>p.totalBet>=level);
  const amount=(level-lower)*contributors.length;lower=level;
  return { amount, contributors,eligible:contributors.filter(p=>p.status==='active'||p.status==='all-in') };
 });
}
function refreshPots(state: HoldemEngineState): void {
 state.publicState.pots=potsFromContributions(state).map(p=>({amount:p.amount,eligibleSeats:p.eligible.map(s=>s.seat)}));
}
function finish(state: HoldemEngineState, events: EngineEvent[]): void {
 const pub=state.publicState;
 const remaining=contenders(state);
 const settlement:HandSettlement={handId:pub.handId!,pots:[],refunds:[]};
 const ranks=new Map<number,number[]>();
 if(remaining.length>1) {
  for(const player of remaining) ranks.set(player.seat,evaluateHand([...state.privateState.holeCards[player.seat]!,...pub.board]));
  pub.revealedHands=remaining.map(p=>({seat:p.seat,cards:copy(state.privateState.holeCards[p.seat]!)}));
 }
 for(const pot of potsFromContributions(state)) {
  if(pot.contributors.length===1) {
   const player=pot.contributors[0]!;player.stack+=pot.amount;
   settlement.refunds.push({seat:player.seat,amount:pot.amount});continue;
  }
  // With one survivor every contested contribution is awarded to that survivor.
  const eligible=remaining.length===1 ? remaining : pot.eligible;
  if(eligible.length===0) throw new Error('Pot has no eligible contender');
  let winners:PublicSeat[]=[];
  for(const player of eligible) {
   const comparison=winners.length ? compareRanks(ranks.get(player.seat)!,ranks.get(winners[0]!.seat)!) : 1;
   if(comparison>0) winners=[player];else if(comparison===0) winners.push(player);
  }
  const ordered=clockwise(winners,pub.button!);
  const split=Math.floor(pot.amount/winners.length);let odd=pot.amount%winners.length;
  const awards=ordered.map(player=>{
   const amount=split+(odd-- > 0 ? 1 : 0);player.stack+=amount;return {seat:player.seat,amount};
  });
  settlement.pots.push({amount:pot.amount,winners:ordered.map(p=>p.seat),awards});
 }
 pub.pots=settlement.pots.map(p=>({amount:p.amount,eligibleSeats:p.winners}));
 pub.settlement=settlement;pub.phase='complete';pub.actorSeat=null;pub.window=null;
 pub.currentBet=0;
 for(const player of pub.seats) {player.streetBet=0;player.totalBet=0;}
 meta(state).pending=[];state.privateState.raiseRights=[];
 events.push({type:'hand_complete',payload:settlement as unknown as import('./contracts.js').Json,audience:'public'});
}
function advanceStreet(state: HoldemEngineState, now:number, events:EngineEvent[]): void {
 const pub=state.publicState;
 if(pub.phase==='river') {finish(state,events);return;}
 draw(state); // burn
 if(pub.phase==='preflop') {pub.phase='flop';pub.board.push(draw(state),draw(state),draw(state));}
 else if(pub.phase==='flop') {pub.phase='turn';pub.board.push(draw(state));}
 else {pub.phase='river';pub.board.push(draw(state));}
 pub.currentBet=0;pub.minRaiseIncrement=state.config.bigBlind;
 for(const player of pub.seats) player.streetBet=0;
 const m=meta(state);m.actedAt={};m.actedIncrement={};
 state.privateState.actedSeats=[];
 m.pending=active(state).map(p=>p.seat);
 events.push({type:'street_changed',payload:{phase:pub.phase,board:copy(pub.board)},audience:'public'});
 const players=active(state);
 if(players.length<=1) advanceStreet(state,now,events);
 else setWindow(state,nextSeat(players,pub.button!).seat,now);
}
function advance(state: HoldemEngineState, after: SeatIndex, now:number, events:EngineEvent[]): void {
 if(contenders(state).length===1) {finish(state,events);return;}
 const m=meta(state);
 m.pending=m.pending.filter(seat=>active(state).some(p=>p.seat===seat));
 const players=active(state);
 // One active player can still owe a call to an all-in opponent.
 if(players.length===1 && players[0]!.streetBet>=state.publicState.currentBet) m.pending=[];
 if(m.pending.length===0) advanceStreet(state,now,events);
 else setWindow(state,nextSeat(players.filter(p=>m.pending.includes(p.seat)),after).seat,now);
}
function assertInvariant(state: HoldemEngineState): void {
 if(!state.publicState.handId) return;
 const total=state.publicState.seats.reduce((sum,p)=>sum+p.stack+(live(state)?p.totalBet:0),0);
 if(total!==meta(state).handTotal || state.publicState.seats.some(p=>!integer(p.stack)||!integer(p.totalBet)||!integer(p.streetBet)))
  throw new Error('Chip conservation invariant failed');
}
function success(state:HoldemEngineState,events:EngineEvent[]):EngineResult {
 assertInvariant(state);
 return {ok:true,transition:{state,events,settlement:events.some(event=>event.type==='hand_complete')?state.publicState.settlement:null}};
}
export function startHand(state:HoldemEngineState,input:StartHandInput):EngineResult {
 if(live(state)) return illegal('Hand is already active');
 if(!integer(input.now)||!input.handId||input.handId===state.publicState.handId||input.deck.length!==52||new Set(input.deck).size!==52||input.deck.some(c=>!/^[2-9TJQKA][cdhs]$/.test(c)))
  return invalid('Expected a fresh hand id, valid time and complete unique deck');
 const next=copy(state);const pub=next.publicState;
 const funded=pub.seats.filter(p=>p.stack>0);
 if(funded.length<2) return illegal('At least two funded players are required');
 const oldButton=pub.button;
 pub.button=oldButton===null?funded[0]!.seat:nextSeat(funded,oldButton).seat;
 pub.handId=input.handId;pub.phase='preflop';pub.board=[];pub.revealedHands=[];pub.settlement=null;
 pub.smallBlindSeat=funded.length===2?pub.button:nextSeat(funded,pub.button).seat;
 pub.bigBlindSeat=nextSeat(funded,pub.smallBlindSeat).seat;
 pub.currentBet=next.config.bigBlind;pub.minRaiseIncrement=next.config.bigBlind;
 for(const player of pub.seats) {player.status=player.stack>0?'active':'out';player.streetBet=0;player.totalBet=0;}
 next.privateState.deck=copy(input.deck);next.privateState.deckCursor=0;next.privateState.holeCards={};
 next.privateState.actedSeats=[];
 const m=meta(next);m.actedAt={};m.actedIncrement={};m.handTotal=pub.seats.reduce((sum,p)=>sum+p.stack,0);
 const order=clockwise(funded,pub.button);
 for(let round=0;round<2;round++) for(const player of order) (next.privateState.holeCards[player.seat]??=[]).push(draw(next));
 pay(pub.seats.find(p=>p.seat===pub.smallBlindSeat)!,next.config.smallBlind);
 pay(pub.seats.find(p=>p.seat===pub.bigBlindSeat)!,next.config.bigBlind);
 m.pending=active(next).map(p=>p.seat);refreshPots(next);
 const events:EngineEvent[]=[{type:'hand_started',payload:{handId:input.handId,button:pub.button},audience:'public'}];
 // Never emit hole cards in public events. Each private projection is built separately.
 advance(next,pub.bigBlindSeat,input.now,events);
 return success(next,events);
}
function actionInternal(state:HoldemEngineState,input:ApplyActionInput,timeout:boolean):EngineResult {
 const pub=state.publicState;
 if(!integer(input.now)||!integer(input.seat)||!input.action||typeof input.action.type!=='string') return invalid('Invalid action input');
 if(!pub.window||pub.window.id!==input.windowId||pub.actorSeat!==input.seat) return illegal('Not the current action window');
 if(!timeout&&input.now>=pub.window.deadline) return illegal('Action deadline has passed');
 const legal=getLegalActions(state,input.seat);
 const allowed=legal.find(a=>a.type===input.action.type);
 if(!allowed) return illegal('Action is not legal');
 if(input.action.type==='raise') {
  if(allowed.type!=='raise'||!integer(input.action.amount)||input.action.amount<allowed.minAmount||input.action.amount>allowed.maxAmount||allowed.allInOnly&&input.action.amount!==allowed.maxAmount)
   return illegal('Raise amount is outside the legal range');
 }
 const next=copy(state);const p=next.publicState;const player=p.seats.find(s=>s.seat===input.seat)!;
 const m=meta(next);const previousBet=p.currentBet;
 if(input.action.type==='fold') player.status='folded';
 else if(input.action.type==='call') pay(player,Math.max(0,p.currentBet-player.streetBet));
 else if(input.action.type==='raise') {
  pay(player,input.action.amount-player.streetBet);p.currentBet=input.action.amount;
  const increase=p.currentBet-previousBet;
  if(increase>=p.minRaiseIncrement) p.minRaiseIncrement=increase;
  m.pending=active(next).filter(s=>s.seat!==player.seat).map(s=>s.seat);
 }
 m.actedAt[player.seat]=p.currentBet;m.actedIncrement[player.seat]=p.minRaiseIncrement;
 if(!next.privateState.actedSeats.includes(player.seat)) next.privateState.actedSeats.push(player.seat);
 m.pending=m.pending.filter(seat=>seat!==player.seat);
 refreshPots(next);
 const payload:import('./contracts.js').Json={seat:player.seat,action:input.action.type,automatic:timeout};
 if(input.action.type==='raise') payload.amount=input.action.amount;
 const events:EngineEvent[]=[{type:'action_applied',payload,audience:'public'}];
 advance(next,player.seat,input.now,events);
 return success(next,events);
}
export function applyAction(state:HoldemEngineState,input:ApplyActionInput):EngineResult {return actionInternal(state,input,false);}
export function applyTimeout(state:HoldemEngineState,now:number):EngineResult {
 const window=state.publicState.window;const seat=state.publicState.actorSeat;
 if(!integer(now)) return invalid('Invalid timeout time');
 if(!window||seat===null||now<window.deadline) return illegal('No due action window');
 const action=getLegalActions(state,seat).some(a=>a.type==='check')?{type:'check' as const}:{type:'fold' as const};
 return actionInternal(state,{seat,action,windowId:window.id,now},true);
}
export function getPublicState(state:HoldemEngineState):HoldemPublicState {return copy(state.publicState);}
export function getPrivateState(state:HoldemEngineState,seat:SeatIndex):HoldemPrivateState {
 return {holeCards:copy(state.privateState.holeCards[seat]??[])};
}
