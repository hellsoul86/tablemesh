import {test,expect} from '@playwright/test';
import {TableEventLog,describeTableEvent,settlementDescription} from '../../packages/web/src/table-events';
import type {RoomEvent,SeatActionDetail} from '../../packages/core/src/contracts';
const event=(cursor:number,type:string,payload:unknown):RoomEvent=>({cursor,stateVersion:cursor,type,payload:payload as RoomEvent['payload']});
const actor={seat:1,accountId:'original-account',displayName:'小盲玩家'};
const detail:SeatActionDetail={seat:1,street:'preflop',type:'call',paid:5,committedTo:10,allIn:false,source:'player',at:10};
test('公开动态保留真实支付及顺序，重复游标、同步占位和未授权字段不形成日志',()=>{
 const log=new TableEventLog();const batch=[event(1,'room_join',{participant:actor}),event(2,'room_start',{participants:[actor]}),event(3,'room_action',{steps:[{actor,actionDetail:detail,streets:[{phase:'flop',board:['As','Td','2c']}]}],privateState:{holeCards:['Kh','Ks']}})];
 expect(log.ingest(batch)).toBe(true);expect(log.entries()).toEqual(['小盲玩家 入座','新一手开始 · 1 人','小盲玩家 跟注 5 筹码','翻牌 · A♠ 10♦ 2♣']);expect(log.ingest(batch)).toBe(false);expect(log.ingest([event(4,'snapshot_updated',{}),event(5,'room_action',{phase:'flop'})])).toBe(false);expect(log.entries()).toHaveLength(4);expect(log.entries().join('')).not.toMatch(/Kh|Ks|已更新|跟注 10/);
 const actionKinds:SeatActionDetail[]=[{...detail,type:'check',paid:0},{...detail,type:'bet',paid:20,committedTo:20},{...detail,type:'raise',paid:35,committedTo:40},{...detail,type:'fold',paid:0,source:'timeout'},{...detail,type:'call',paid:90,committedTo:100,allIn:true}];
 expect(actionKinds.map(actionDetail=>describeTableEvent(event(6,'room_action',{steps:[{actor,actionDetail,streets:[]}]}))[0])).toEqual(['小盲玩家 过牌','小盲玩家 下注 20 筹码','小盲玩家 加注至 40 筹码（本次投入 35 筹码）','小盲玩家 超时自动 · 弃牌','小盲玩家 全下 · 跟注 90 筹码']);
});
test('结算按原参与者合并净额、奖励和退款，同手只记一次',()=>{
 const settlement={handId:'hand-1',pots:[{amount:30,winners:[1],awards:[{seat:1,amount:30}]},{amount:30,winners:[1],awards:[{seat:1,amount:30}]}],refunds:[{seat:1,amount:75}]};
 const old={handId:'hand-1',participants:[actor],settlement};expect(settlementDescription(old)).toBe('小盲玩家 获得 60 筹码；未跟注退回：小盲玩家 75 筹码');
 const full={...old,participants:[{...actor,startingStack:1000,finalStack:1035,netChips:35},{seat:2,accountId:'other',displayName:'大盲玩家',startingStack:1000,finalStack:965,netChips:-35}]};
 const log=new TableEventLog();log.ingest([event(1,'hand_settled',full),event(2,'hand_settled',full)]);expect(log.entries()).toEqual(['本手结算 · 筹码净变化：小盲玩家 +35 / 大盲玩家 -35；未跟注退回：小盲玩家 75 筹码']);
});
