import type { EngineTransition, HandReplayFrame, ReplayParticipant, SeatIdentity, Json } from '@tablemesh/core/contracts';
import { getPublicState } from '@tablemesh/core';
import type { ReplayCapture } from './replay.js';
import type { Store } from './db.js';
import { projectedFrame } from './round-actions.js';

export type PublicTableStep = Pick<HandReplayFrame,'kind'|'at'|'actionDetail'|'streets'> & {
 actor: SeatIdentity|null; phase: string; board: string[];
};
const identity = (p: SeatIdentity): SeatIdentity => ({seat:p.seat,accountId:p.accountId,displayName:p.displayName});
export function tableStep(transition: EngineTransition,capture: ReplayCapture): PublicTableStep {
 const game=getPublicState(transition.state);const before=capture.before?getPublicState(capture.before):game;
 const detail=capture.actionDetail??null;const actor=before.seats.find(p=>p.seat===(detail?.seat??capture.actorSeat));
 const streets=transition.events.filter(e=>e.type==='street_changed'&&e.audience==='public').map(e=>{
  const payload=e.payload as {phase:string;board:string[]};return {phase:payload.phase,board:[...payload.board]};
 });
 return {kind:capture.kind,at:capture.at,actor:actor?identity(actor):null,actionDetail:detail,streets:streets as HandReplayFrame['streets'],phase:game.phase,board:[...game.board]};
}
export function settlementParticipants(store:Store,handId:string,fallback:SeatIdentity[]): Array<ReplayParticipant & {netChips:number|null}> {
 const row=store.one<{participants_json:string}>('SELECT participants_json FROM hand_replays WHERE hand_id=? AND finished_at IS NOT NULL',handId);
 const participants:ReplayParticipant[]=row?JSON.parse(row.participants_json):fallback.map(p=>({...identity(p),startingStack:null,finalStack:null}));
 return participants.map(p=>({...identity(p),startingStack:p.startingStack,finalStack:p.finalStack,netChips:p.startingStack===null||p.finalStack===null?null:p.finalStack-p.startingStack}));
}
interface StoredEvent {cursor:number;stateVersion:number;type:string;payload:Json}
/** Enhance only a completely matched finished hand. No private-card table is read. */
export function projectTableEvents(store:Store,roomId:string,page:StoredEvent[]):StoredEvent[] {
 if(!page.some(e=>{const p=e.payload as Record<string,unknown>|null;return p&&((['room_start','room_action','room_timeout','room_leave'].includes(e.type)&&p.steps===undefined)||(e.type==='hand_settled'&&Array.isArray(p.participants)&&p.participants.some((x:Record<string,unknown>)=>x.netChips===undefined)));}))return page;
 const replacements=new Map<number,Json>();
 const settled=store.all<{cursor:number;state_version:number;public_payload_json:string}>('SELECT cursor,state_version,public_payload_json FROM room_events WHERE room_id=? AND type=? ORDER BY cursor',roomId,'hand_settled');
 for(const end of settled) {
  const summary=JSON.parse(end.public_payload_json) as {handId?:string;participants?:SeatIdentity[]};
  if(!summary.handId)continue;
  replacements.set(end.cursor,{...summary,participants:settlementParticipants(store,summary.handId,summary.participants??[])} as unknown as Json);
  const row=store.one<{availability:string;finished_at:number|null;step_count:number;participants_json:string;config_json:string|null}>('SELECT * FROM hand_replays WHERE hand_id=? AND room_id=?',summary.handId,roomId);
  if(!row||row.availability!=='full'||row.finished_at===null)continue;
  const start=store.one<{cursor:number}>('SELECT cursor FROM room_events WHERE room_id=? AND type=? AND cursor<? ORDER BY cursor DESC LIMIT 1',roomId,'room_start',end.cursor);
  if(!start||start.cursor>page.at(-1)!.cursor||end.cursor<page[0]!.cursor)continue;
  const events=store.all<{cursor:number;state_version:number;type:string;public_payload_json:string}>('SELECT cursor,state_version,type,public_payload_json FROM room_events WHERE room_id=? AND cursor>=? AND cursor<? ORDER BY cursor',roomId,start.cursor,end.cursor);
  // A missing event cursor is evidence of an incomplete segment, even if its
  // neighbouring reducer states happen to match.
  if(events.length!==end.cursor-start.cursor||events.some((e,i)=>i>0&&e.state_version!==events[i-1]!.state_version+1)||events.at(-1)?.state_version!==end.state_version)continue;
  const participants=JSON.parse(row.participants_json) as ReplayParticipant[];
  const config=row.config_json?JSON.parse(row.config_json):null;
  let previous:HandReplayFrame|undefined;const frames:HandReplayFrame[]=[];
  for(const raw of store.all<{step_index:number;frame_json:string}>('SELECT step_index,frame_json FROM hand_replay_frames WHERE hand_id=? ORDER BY step_index',summary.handId)) {
   const original=JSON.parse(raw.frame_json) as HandReplayFrame;
   const frame=projectedFrame(original,previous?.game,previous?.roundActions,config,participants);frames.push(frame);previous=frame;
  }
  if(frames.length!==row.step_count||frames.some((f,i)=>f.index!==i||f.game.handId!==summary.handId)||frames.at(-1)?.game.phase!=='complete')continue;
  let at=0;let valid=true;const candidate=new Map<number,Json>();
  for(const event of events) {
   const payload=JSON.parse(event.public_payload_json) as Record<string,unknown>;
   const expected=event.type==='room_start'?'start':event.type==='room_action'?'action':event.type==='room_timeout'?'timeout':event.type==='room_leave'?'abandon':null;
   if(!expected||frames[at]?.kind!==expected){valid=false;break;}
   const first=frames[at++]!;const group=[first];
   while(frames[at]?.kind==='abandon_fold')group.push(frames[at++]!);
   if(payload.phase!==group.at(-1)!.game.phase||((expected==='action'||expected==='abandon')&&payload.actorSeat!==first.actorSeat)){valid=false;break;}
   const steps=group.filter(f=>f.kind!=='abandon').map(f=>({kind:f.kind,at:f.at,actor:participants.find(p=>p.seat===f.actorSeat)?identity(participants.find(p=>p.seat===f.actorSeat)!):null,actionDetail:f.actionDetail??null,streets:f.streets,phase:f.game.phase,board:[...f.game.board]}));
   const extra:Record<string,unknown>={steps};
   if(expected==='start')Object.assign(extra,{handId:summary.handId,participants:participants.map(p=>({...identity(p),startingStack:p.startingStack,finalStack:null}))});
   if(expected==='abandon')Object.assign(extra,{abandoned:true,participant:participants.find(p=>p.seat===first.actorSeat)?identity(participants.find(p=>p.seat===first.actorSeat)!):null});
   candidate.set(event.cursor,{...payload,...extra} as Json);
  }
  if(valid&&at===frames.length)for(const [cursor,payload]of candidate)replacements.set(cursor,payload);
 }
 return page.map(event=>({...event,payload:replacements.get(event.cursor)??event.payload}));
}
