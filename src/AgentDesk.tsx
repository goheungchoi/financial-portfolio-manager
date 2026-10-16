import type {DeskState,DeskCondition} from './RuntimeSettings';
import {Note} from './Note';
// What the trading agent is keeping track of: its notes, the reviews it asked for and the orders it armed. You can remove any of them.
const when=(t:number)=>new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const conds=(list:DeskCondition[],combine:string)=>list.map(c=>`${c.expr} ${c.op} ${c.value}`).join(combine==='any'?' or ':' and ');
const PURPOSE:Record<string,string>={stop_loss:'Stop loss',take_profit:'Take profit',entry:'Entry',exit:'Exit',other:'Order'};
export function AgentDesk({desk,conditionalOn,onChange}:{desk:DeskState;conditionalOn:boolean;onChange(desk:DeskState):void}){
  const act=async(task:()=>Promise<DeskState>|undefined)=>{try{const next=await task();if(next)onChange(next);}catch{}};
  const empty=!desk.notes.length&&!desk.triggers.length&&!desk.orders.length&&!desk.recentOrders.length;
  return <section className="agent-desk" aria-label="Agent desk"><div className="section-head"><div><h2>Agent desk</h2><small className="muted">Notes, review triggers and conditional orders the AI is keeping.</small></div></div>
    {empty&&<p className="muted">Nothing yet. The AI adds notes, triggers{conditionalOn?' and conditional orders':''} during reviews.</p>}
    {desk.orders.length>0&&<><h3 className="research-sub">Conditional orders · armed</h3><ul className="desk-list" aria-label="Armed conditional orders">{desk.orders.map(o=><li key={o.id}>
      <div><span className={`role-tag ${o.side==='Buy'?'role-add':'role-trim'}`}>{PURPOSE[o.purpose]??o.purpose}</span> <b>{o.side} {o.quantity} {o.symbol}</b> at {o.limitPrice??'the market price'}<small> when {conds(o.conditions,o.combine)} · until {when(o.expiresAt)}{o.waiting?` · waiting: ${o.waiting}`:''}</small>{o.reason&&<small className="desk-reason">{o.reason}</small>}</div>
      <button aria-label={`Cancel conditional order ${o.id}`} onClick={()=>void act(()=>window.portfolio?.cancelConditionalOrder(o.id))}>Cancel</button></li>)}</ul></>}
    {desk.triggers.length>0&&<><h3 className="research-sub">Review triggers</h3><ul className="desk-list" aria-label="Review triggers">{desk.triggers.map(t=><li key={t.id}>
      <div><b>{t.name}</b><small> when {conds(t.conditions,t.combine)} · until {when(t.expiresAt)}</small>{t.reason&&<small className="desk-reason">{t.reason}</small>}</div>
      <button aria-label={`Remove trigger ${t.id}`} onClick={()=>void act(()=>window.portfolio?.cancelTrigger(t.id))}>Remove</button></li>)}</ul></>}
    {desk.notes.length>0&&<><h3 className="research-sub">Notes</h3><ul className="desk-list" aria-label="Agent notes">{desk.notes.map(n=><li key={n.symbol||'general'}>
      <div><b>{n.symbol||'General'}</b><small className="desk-reason">{n.note}</small><small> updated {when(n.updatedAt)} · until {when(n.expiresAt)}</small></div>
      <button aria-label={`Delete note ${n.symbol||'general'}`} onClick={()=>void act(()=>window.portfolio?.deleteNote(n.symbol))}>Delete</button></li>)}</ul></>}
    {(desk.recentOrders.length>0||desk.firedTriggers.length>0)&&<Note summary="Recently fired, expired or cancelled">
      <ul className="desk-list compact">{desk.recentOrders.map(o=><li key={o.id}><div><b>{PURPOSE[o.purpose]??o.purpose} · {o.side} {o.quantity} {o.symbol}</b> <span className="badge">{o.status}</span><small className="desk-reason">{o.outcome??''}</small></div></li>)}
        {desk.firedTriggers.map(t=><li key={t.id}><div><b>{t.name}</b> <span className="badge">fired {when(t.firedAt)}</span>{t.results&&<small className="desk-reason">{t.results.map(r=>`${r.expr} = ${r.actual} (${r.op} ${r.value})`).join('; ')}</small>}</div></li>)}</ul>
    </Note>}
  </section>;
}
