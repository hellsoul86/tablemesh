import { getPublicState, getPrivateState } from '@tablemesh/core';
import type { EngineTransition, HoldemEngineState, HoldemAction, HandReplayFrame, HandReplaySummary,
  HandReplayList, HandReplayDetail, ReplayParticipant, HandSettlement, RoundActionState, SeatActionDetail } from '@tablemesh/core/contracts';
import type { Store } from './db.js';
import { projectedFrame } from './round-actions.js';
import { fail } from './util.js';

export interface ReplayCapture {
 roundActions?: RoundActionState; actionDetail?: SeatActionDetail | null;
 kind: HandReplayFrame['kind']; at: number; actorSeat?: number;
 before?: HoldemEngineState;
}
interface ReplayRow {
 sequence: number | null; hand_id: string; room_id: string; room_name: string;
 config_json: string | null; started_at: number | null; finished_at: number | null;
 availability: 'full' | 'summary_only'; participants_json: string;
 settlement_json: string | null; step_count: number;
}
interface LegacyRow { hand_id: string; room_id: string; result_json: string; participants_json: string; created_at: number; name: string }

/** Stores only public frames and separately account-bound dealt cards. No deck or engine snapshot. */
export class ReplayHistory {
 constructor(private readonly store: Store) {
  store.transaction(() => {
   for (const row of store.all<LegacyRow>('SELECT h.*,r.name FROM hand_settlements h JOIN rooms r ON r.id=h.room_id WHERE NOT EXISTS (SELECT 1 FROM hand_replays replay WHERE replay.hand_id=h.hand_id) ORDER BY h.created_at,h.rowid')) this.legacy(row);
  });
 }
 private nextSequence(): number { return this.store.one<{n:number}>('SELECT COALESCE(MAX(sequence),0)+1 n FROM hand_replays')!.n; }
 private legacy(row: LegacyRow): void {
  const participants: ReplayParticipant[] = JSON.parse(row.participants_json).map((p: ReplayParticipant) => ({ seat:p.seat, accountId:p.accountId, displayName:p.displayName, startingStack:null, finalStack:null }));
  const inserted = this.store.run('INSERT OR IGNORE INTO hand_replays(hand_id,room_id,room_name,finished_at,availability,participants_json,settlement_json,sequence) VALUES(?,?,?,?,?,?,?,?)',
   row.hand_id,row.room_id,row.name,row.created_at,'summary_only',JSON.stringify(participants),row.result_json,this.nextSequence());
  if (Number(inserted.changes)) for (const p of participants) this.store.run('INSERT INTO hand_replay_players VALUES(?,?,?,NULL)',row.hand_id,p.accountId,p.seat);
 }
 capture(roomId: string, transition: EngineTransition, capture: ReplayCapture): void {
  const game = getPublicState(transition.state);
  if (!game.handId) return;
  const handId = game.handId;
  if (capture.kind === 'start') {
   if (!capture.before) throw new Error('Replay start requires original chip stacks');
   const original = getPublicState(capture.before).seats;
   const participants: ReplayParticipant[] = game.seats.filter(p => getPrivateState(transition.state,p.seat).holeCards.length === 2).map(p => ({
    seat:p.seat,accountId:p.accountId,displayName:p.displayName,
    startingStack:original.find(old => old.accountId === p.accountId && old.seat === p.seat)!.stack,finalStack:null
   }));
   const room = this.store.one<{name:string}>('SELECT name FROM rooms WHERE id=?',roomId)!;
   this.store.run('INSERT INTO hand_replays(hand_id,room_id,room_name,config_json,started_at,availability,participants_json) VALUES(?,?,?,?,?,?,?)',
    handId,roomId,room.name,JSON.stringify(transition.state.config),capture.at,'full',JSON.stringify(participants));
   for (const p of participants) this.store.run('INSERT INTO hand_replay_players VALUES(?,?,?,?)',handId,p.accountId,p.seat,JSON.stringify(getPrivateState(transition.state,p.seat).holeCards));
  }
  const row = this.store.one<ReplayRow>('SELECT * FROM hand_replays WHERE hand_id=?',handId);
  // An already-active pre-feature hand has no trustworthy start or full trace.
  if (!row) {
   if (transition.settlement) {
    const old = this.store.one<LegacyRow>('SELECT h.*,r.name FROM hand_settlements h JOIN rooms r ON r.id=h.room_id WHERE h.hand_id=? AND h.room_id=?',handId,roomId)!;
    this.legacy(old);
   }
   return;
  }
  if (row.availability !== 'full' || row.finished_at !== null) return;
  game.window = null; // Historical observations cannot supply a usable action window.
  const actionEvent = transition.events.find(e => e.type === 'action_applied' && e.audience === 'public');
  const payload = actionEvent?.payload as {seat:number;action:HoldemAction['type'];amount?:number} | undefined;
  const action: HoldemAction | null = payload ? payload.action === 'raise' ? {type:'raise',amount:payload.amount!} : {type:payload.action} : null;
  const streets: HandReplayFrame['streets'] = transition.events.filter(e => e.type === 'street_changed' && e.audience === 'public').map(e => e.payload as HandReplayFrame['streets'][number]);
  const frame: HandReplayFrame = {index:row.step_count,at:capture.at,kind:capture.kind,actorSeat:payload?.seat ?? capture.actorSeat ?? null,action,game,streets,roundActions:capture.roundActions,actionDetail:capture.actionDetail};
  this.store.run('INSERT INTO hand_replay_frames VALUES(?,?,?)',handId,row.step_count,JSON.stringify(frame));
  this.store.run('UPDATE hand_replays SET step_count=step_count+1 WHERE hand_id=?',handId);
  if (transition.settlement) {
   const participants: ReplayParticipant[] = JSON.parse(row.participants_json);
   for (const p of participants) p.finalStack = game.seats.find(seat => seat.seat === p.seat && seat.accountId === p.accountId)!.stack;
   this.store.run('UPDATE hand_replays SET finished_at=?,participants_json=?,settlement_json=?,sequence=? WHERE hand_id=?',capture.at,JSON.stringify(participants),JSON.stringify(transition.settlement),this.nextSequence(),handId);
  }
 }
 abandon(roomId: string, state: HoldemEngineState, actorSeat: number, at: number, roundActions?: RoundActionState): void {
  this.capture(roomId,{state,events:[],settlement:null},{kind:'abandon',actorSeat,at,roundActions,actionDetail:null});
 }
 private summary(row: ReplayRow, accountId: string): HandReplaySummary {
  const participants: ReplayParticipant[] = JSON.parse(row.participants_json);
  const own = participants.find(p => p.accountId === accountId)!;
  return {sequence:row.sequence!,handId:row.hand_id,roomId:row.room_id,roomName:row.room_name,
   startedAt:row.started_at,finishedAt:row.finished_at!,participants,availability:row.availability,stepCount:row.step_count,
   netChips:own.startingStack === null || own.finalStack === null ? null : own.finalStack-own.startingStack,
   settlement:JSON.parse(row.settlement_json!) as HandSettlement};
 }
 list(accountId: string, before: number | undefined, limit: number): HandReplayList {
  const rows = this.store.all<ReplayRow>('SELECT h.* FROM hand_replays h JOIN hand_replay_players p ON p.hand_id=h.hand_id WHERE p.account_id=? AND h.finished_at IS NOT NULL AND (? IS NULL OR h.sequence<?) ORDER BY h.sequence DESC LIMIT ?',accountId,before??null,before??null,limit+1);
  const more = rows.length > limit;const page=rows.slice(0,limit);
  return {hands:page.map(row=>this.summary(row,accountId)),nextBefore:more?page.at(-1)!.sequence:null};
 }
 detail(accountId: string, handId: string, afterStep: number, limit: number): HandReplayDetail {
  const row=this.store.one<ReplayRow & {seat:number;own_cards_json:string|null}>('SELECT h.*,p.seat,p.own_cards_json FROM hand_replays h JOIN hand_replay_players p ON p.hand_id=h.hand_id WHERE h.hand_id=? AND p.account_id=? AND h.finished_at IS NOT NULL',handId,accountId);
  if (!row) fail('NOT_FOUND','Completed participating hand not found',404);
  const frames=this.store.all<{frame_json:string}>('SELECT frame_json FROM hand_replay_frames WHERE hand_id=? AND step_index>? ORDER BY step_index LIMIT ?',handId,afterStep,limit+1).map(frame=>JSON.parse(frame.frame_json) as HandReplayFrame);
  const more=frames.length>limit;let page=frames.slice(0,limit);
  if(page.some(frame=>frame.roundActions===undefined)) {
   // Stream only the historical prefix needed for this page; never persist
   // invented metadata or use future frames to explain earlier decisions.
   const end=page.at(-1)!.index;let before:HandReplayFrame|undefined;const projected:HandReplayFrame[]=[];
   const config=row.config_json?JSON.parse(row.config_json):null;const participants=JSON.parse(row.participants_json) as ReplayParticipant[];
   for(const item of this.store.db.prepare('SELECT frame_json FROM hand_replay_frames WHERE hand_id=? AND step_index<=? ORDER BY step_index').iterate(handId,end)) {
    const original=JSON.parse(item.frame_json as string) as HandReplayFrame;
    const frame=projectedFrame(original,before?.game,before?.roundActions,config,participants);
    if(frame.index>afterStep) projected.push(frame);
    before=frame;
   }
   page=projected;
  }
  return {summary:this.summary(row,accountId),config:row.config_json?JSON.parse(row.config_json):null,
   you:{accountId,seat:row.seat,privateState:row.own_cards_json?{holeCards:JSON.parse(row.own_cards_json)}:null},frames:page,nextAfterStep:more?page.at(-1)!.index:null};
 }
}
