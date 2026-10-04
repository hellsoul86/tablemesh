import type {HoldemPublicState,PublicSeat,RoundActionState,SeatActionDetail} from '../../core/src/contracts';
import {esc,num} from './shared';
const streets:Record<string,string>={preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌'};
export function actionDescription(action:SeatActionDetail){
 const source=action.source==='timeout'?'超时自动 · ':action.source==='abandon'?'放弃后自动 · ':'';
 const allIn=action.allIn?'全下 · ':'';
 const text=action.type==='check'?'过牌':action.type==='fold'?'弃牌':action.type==='call'?`跟注 ${num(action.paid)} 筹码`:action.type==='bet'?`下注 ${num(action.paid)} 筹码`:`加注至 ${num(action.committedTo)} 筹码（本次投入 ${num(action.paid)} 筹码）`;
 return source+allIn+text;
}
export function roundDescription(game:HoldemPublicState,round:RoundActionState|undefined){
 if(game.phase==='waiting')return '尚未开局 · 盲注投入与主动动作分开记录';
 const street=round?.street?streets[round.street]:'未记录';
 return game.phase==='complete'?`最后下注轮：${street} · 显示结算前的累计投入`:`本轮：${streets[game.phase]??street} · 每席显示最近动作与本轮累计投入`;
}
export function seatActionState(seat:PublicSeat,game:HoldemPublicState,round:RoundActionState|undefined,abandoned=false){
 const entry=round?.seats.find(s=>s.seat===seat.seat);
 const completed=game.phase==='complete';
 const status=abandoned?'已放弃 · 结算后离席':seat.status==='folded'?'已弃牌':seat.status==='all-in'?(completed?'全下 · 已结算':'已全下'):seat.status==='out'?'本手未参与':completed?'本手已结算':game.phase==='waiting'?'等待开局':game.actorSeat===seat.seat?'行动中':'等待行动';
 const committed=entry?entry.streetCommitted:(completed?null:seat.streetBet);
 const recorded=entry?.actionKnown===true;
 const action=entry?.lastAction;
 const noAction=game.phase==='waiting'?'尚未开局':seat.status==='out'?'本手未参与':!recorded?'动作未记录':seat.status==='folded'?`${completed?'末轮':'本轮'}无新增动作`:seat.status==='all-in'?`${completed?'末轮':'本轮'}无新增动作`:completed?'末轮未行动':'本轮尚未行动';
 return `<div class="seat-state">${game.button===seat.seat?'<span class="dealer-badge" title="庄位">D</span>':''}${game.smallBlindSeat===seat.seat?'小盲 · ':game.bigBlindSeat===seat.seat?'大盲 · ':''}${status}</div><div class="seat-commitment">${completed?'末轮':'本轮'}累计 <strong>${committed===null?'未记录':num(committed)}</strong>${committed===null?'':' 筹码'}</div><div class="seat-last-action ${action?'':'muted'}">${esc(action?actionDescription(action):noAction)}</div>`;
}
