import { getPublicState } from '@tablemesh/core';
import type { Store } from './db.js';
import type { EngineTransition, HoldemEngineState, HoldemPublicState, HoldemConfig, HoldemAction, RoundActionState, SeatActionDetail,
 BettingStreet, HandReplayFrame, ReplayParticipant } from '@tablemesh/core/contracts';

export function bettingStreet(phase: HoldemPublicState['phase']): BettingStreet | null {
 return ['preflop','flop','turn','river'].includes(phase) ? phase as BettingStreet : null;
}
export function unknownRound(game: HoldemPublicState): RoundActionState {
 const street=bettingStreet(game.phase);
 return {street,seats:game.seats.map(p=>({seat:p.seat,streetCommitted:street?p.streetBet:game.phase==='waiting'?0:null,
  handCommitted:street?p.totalBet:game.phase==='waiting'?0:null,actionKnown:game.phase==='waiting',lastAction:null}))};
}
export function startedRound(game: HoldemPublicState, config: HoldemConfig,
 participants: {seat:number;startingStack:number|null}[]): RoundActionState {
 const street=bettingStreet(game.phase)??'preflop';
 return {street,seats:game.seats.map(p=>{
  const initial=participants.find(old=>old.seat===p.seat)?.startingStack;
  const blind=p.seat===game.smallBlindSeat?config.smallBlind:p.seat===game.bigBlindSeat?config.bigBlind:0;
  const paid=initial===undefined||initial===null?null:Math.min(initial,blind);
  return {seat:p.seat,streetCommitted:game.phase==='complete'?paid:p.streetBet,
   handCommitted:game.phase==='complete'?paid:p.totalBet,actionKnown:true,lastAction:null};
 })};
}
export function actionDetails(before: HoldemPublicState, seat:number, action:HoldemAction,
 source:SeatActionDetail['source'], at:number): SeatActionDetail | null {
 const street=bettingStreet(before.phase);const player=before.seats.find(p=>p.seat===seat);
 if (!street||!player) return null;
 const paid=action.type==='call'?Math.min(Math.max(0,before.currentBet-player.streetBet),player.stack):action.type==='raise'?action.amount-player.streetBet:0;
 if (!Number.isSafeInteger(paid)||paid<0||paid>player.stack) return null;
 return {seat,street,type:action.type==='raise'?(before.currentBet===0?'bet':'raise'):action.type,
  paid,committedTo:player.streetBet+paid,allIn:paid>0&&paid===player.stack,source,at};
}
export function advancedRound(prior:RoundActionState,before:HoldemPublicState,after:HoldemPublicState,
 detail:SeatActionDetail|null): RoundActionState {
 const oldStreet=bettingStreet(before.phase);
 const state=prior.street===oldStreet?structuredClone(prior):unknownRound(before);
 if(detail){const seat=state.seats.find(p=>p.seat===detail.seat);if(seat){seat.lastAction=detail;seat.actionKnown=true;}}
 if(after.phase==='complete') {
  // finish clears both counters and distributes payouts; use the validated
  // pre-action public commitments plus the actual deduction, never stack delta.
  state.street=oldStreet??prior.street;
  state.seats=after.seats.map(p=>{
   const old=before.seats.find(s=>s.seat===p.seat&&s.accountId===p.accountId);
   const status=state.seats.find(s=>s.seat===p.seat);
   const paid=detail?.seat===p.seat?detail.paid:0;
   return {seat:p.seat,streetCommitted:old&&oldStreet?old.streetBet+paid:null,
    handCommitted:old&&oldStreet?old.totalBet+paid:null,
    actionKnown:status?.actionKnown??false,lastAction:status?.lastAction??null};
  });return state;
 }
 const newStreet=bettingStreet(after.phase);
 const reset=newStreet!==oldStreet;
 return {street:newStreet,seats:after.seats.map(p=>{
  const old=state.seats.find(s=>s.seat===p.seat);
  return {seat:p.seat,streetCommitted:p.streetBet,handCommitted:p.totalBet,
   actionKnown:reset?true:old?.actionKnown??false,lastAction:reset?null:old?.lastAction??null};
 })};
}
/** Derive one old frame only from preceding public evidence, without rewriting JSON. */
export function projectedFrame(frame:HandReplayFrame,before:HoldemPublicState|undefined,
 prior:RoundActionState|undefined,config:HoldemConfig|null,participants:ReplayParticipant[]):HandReplayFrame {
 let round=frame.roundActions;let detail=frame.actionDetail??null;
 if(!round) {
  if(frame.kind==='start'&&config) round=startedRound(frame.game,config,participants);
  else if(before){
   const source=frame.kind==='timeout'?'timeout':frame.kind==='abandon_fold'?'abandon':'player';
   detail=frame.action&&frame.actorSeat!==null?actionDetails(before,frame.actorSeat,frame.action,source,frame.at):null;
   round=advancedRound(prior??unknownRound(before),before,frame.game,detail);
  }else round=unknownRound(frame.game);
 }
 return {...frame,roundActions:round,actionDetail:detail};
}
interface StoredRound { round:RoundActionState; bindings:Record<string,string> }

export class RoundActionHistory {
 constructor(private readonly store:Store) {}
 private filtered(round:RoundActionState,bindings:Record<string,string>,game:HoldemPublicState):RoundActionState {
  const fallback=unknownRound(game);
  return {street:round.street,seats:game.seats.map(p=>bindings[p.seat]===p.accountId?round.seats.find(s=>s.seat===p.seat)??fallback.seats.find(s=>s.seat===p.seat)!:fallback.seats.find(s=>s.seat===p.seat)!)};
 }
 view(roomId:string,game:HoldemPublicState):RoundActionState {
  const row=this.store.one<{hand_id:string|null;state_json:string}>('SELECT * FROM room_round_actions WHERE room_id=?',roomId);
  if(row&&row.hand_id===game.handId){const saved=JSON.parse(row.state_json) as StoredRound;return this.filtered(saved.round,saved.bindings,game);}
  // Public full trace can bootstrap a pre-feature live/completed table view.
  const replay=game.handId?this.store.one<{config_json:string;participants_json:string}>('SELECT config_json,participants_json FROM hand_replays WHERE hand_id=? AND availability=?',game.handId,'full'):undefined;
  if(replay){
   const config=JSON.parse(replay.config_json) as HoldemConfig;const participants=JSON.parse(replay.participants_json) as ReplayParticipant[];
   let round:RoundActionState|undefined;let before:HoldemPublicState|undefined;
   for(const row of this.store.db.prepare('SELECT frame_json FROM hand_replay_frames WHERE hand_id=? ORDER BY step_index').iterate(game.handId!)) {
    const frame=JSON.parse(row.frame_json as string) as HandReplayFrame;
    // Streaming projection keeps memory bounded regardless of old trace length.
    const out=projectedFrame(frame,before,round,config,participants);
    round=out.roundActions;before=frame.game;
   }
   if(round&&before) return this.filtered(round,Object.fromEntries(before.seats.map(p=>[p.seat,p.accountId])),game);
  }
  return unknownRound(game);
 }
 record(roomId:string,before:HoldemEngineState,transition:EngineTransition,kind:HandReplayFrame['kind'],at:number):{roundActions:RoundActionState;actionDetail:SeatActionDetail|null} {
  const old=getPublicState(before),game=getPublicState(transition.state);
  const event=transition.events.find(e=>e.type==='action_applied'&&e.audience==='public');
  const payload=event?.payload as {seat:number;action:HoldemAction['type'];amount?:number}|undefined;
  const intent:HoldemAction|null=payload?payload.action==='raise'?{type:'raise',amount:payload.amount!}:{type:payload.action}:null;
  const detail=intent?actionDetails(old,payload!.seat,intent,kind==='timeout'?'timeout':kind==='abandon_fold'?'abandon':'player',at):null;
  const round=kind==='start'?startedRound(game,transition.state.config,old.seats.map(p=>({seat:p.seat,startingStack:p.stack}))):advancedRound(this.view(roomId,old),old,game,detail);
  const saved:StoredRound={round,bindings:Object.fromEntries(game.seats.map(p=>[p.seat,p.accountId]))};
  this.store.run('INSERT INTO room_round_actions VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET hand_id=excluded.hand_id,state_json=excluded.state_json',roomId,game.handId,JSON.stringify(saved));
  return {roundActions:round,actionDetail:detail};
 }
}
