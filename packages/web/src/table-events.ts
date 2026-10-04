import type {RoomEvent,SeatActionDetail,SeatIdentity,HandSettlement} from '../../core/src/contracts';
import {actionDescription} from './seat-actions';
import {num} from './shared';
export type HistoricHand={handId:string;participants:(SeatIdentity&{startingStack?:number|null;finalStack?:number|null;netChips?:number|null})[];settlement:HandSettlement};
const obj=(value:unknown):Record<string,any>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
function person(value:unknown){const p=obj(value);return p&&typeof p.displayName==='string'?p.displayName:null;}
export function settlementDescription(hand:HistoricHand){
 const names=new Map(hand.participants.map(p=>[p.seat,p.displayName]));
 const net=hand.participants.every(p=>finite(p.netChips));
 const awards=new Map<number,number>();for(const pot of hand.settlement.pots)for(const award of pot.awards)awards.set(award.seat,(awards.get(award.seat)??0)+award.amount);
 const result=net?'筹码净变化：'+hand.participants.map(p=>`${p.displayName} ${p.netChips!>0?'+':''}${num(p.netChips!)}`).join(' / '):[...awards].map(([seat,amount])=>`${names.get(seat)??'原席位 '+(seat+1)} 获得 ${num(amount)} 筹码`).join(' / ');
 const refunds=new Map<number,number>();for(const r of hand.settlement.refunds)refunds.set(r.seat,(refunds.get(r.seat)??0)+r.amount);
 return result+(refunds.size?'；未跟注退回：'+[...refunds].map(([seat,amount])=>`${names.get(seat)??'原席位 '+(seat+1)} ${num(amount)} 筹码`).join(' / '):'');
}
function action(value:unknown):SeatActionDetail|null{const a=obj(value);return a&&['check','call','bet','raise','fold'].includes(a.type)&&finite(a.paid)&&finite(a.committedTo)&&typeof a.allIn==='boolean'&&['player','timeout','abandon'].includes(a.source)?a as SeatActionDetail:null;}
function cards(value:unknown){return Array.isArray(value)?value.filter((c):c is string=>typeof c==='string'&&/^[2-9TJQKA][shdc]$/.test(c)).map(c=>`${c[0]==='T'?'10':c[0]}${({s:'♠',h:'♥',d:'♦',c:'♣'} as Record<string,string>)[c[1]]}`).join(' '):'';}
export function describeTableEvent(event:RoomEvent):string[]{
 const data=obj(event.payload);if(!data)return [];
 if(event.type==='hand_settled'&&typeof data.handId==='string'&&Array.isArray(data.participants)&&Array.isArray(data.settlement?.pots)&&Array.isArray(data.settlement?.refunds))return ['本手结算 · '+settlementDescription(data as HistoricHand)];
 const lines:string[]=[];
 if(event.type==='room_join'&&person(data.participant))lines.push(`${person(data.participant)} 入座`);
 if(event.type==='room_leave'&&person(data.participant))lines.push(`${person(data.participant)} ${data.abandoned?'主动放弃本局':'离席'}`);
 if(event.type==='room_start')lines.push(`新一手开始${Array.isArray(data.participants)?' · '+data.participants.length+' 人':''}`);
 if(Array.isArray(data.steps))for(const value of data.steps){const step=obj(value);if(!step)continue;const detail=action(step.actionDetail),name=person(step.actor);if(detail&&name)lines.push(`${name} ${actionDescription(detail)}`);if(Array.isArray(step.streets))for(const streetValue of step.streets){const street=obj(streetValue);if(!street)continue;const label=({flop:'翻牌',turn:'转牌',river:'河牌'} as Record<string,string>)[street.phase];const board=cards(street.board);if(label&&board)lines.push(`${label} · ${board}`);}}
 return lines;
}
/** Room-scoped public event ledger. Polls and snapshot refreshes are not events. */
export class TableEventLog{
 private cursors=new Set<number>();private settled=new Set<string>();private lines:string[]=[];
 ingest(events:RoomEvent[]){let changed=false;for(const event of events){if(this.cursors.has(event.cursor))continue;this.cursors.add(event.cursor);const data=obj(event.payload);if(event.type==='hand_settled'&&typeof data?.handId==='string'){if(this.settled.has(data.handId))continue;this.settled.add(data.handId);}const lines=describeTableEvent(event);if(lines.length){this.lines.push(...lines);changed=true;}}this.lines=this.lines.slice(-60);return changed;}
 entries(){return [...this.lines];}
}
