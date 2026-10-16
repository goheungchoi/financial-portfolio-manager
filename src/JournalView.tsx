import {LearningPanel} from './LearningPanel';
import {useState} from 'react';
import {TradeOutcomes} from './TradeOutcomes';
import type {RuntimeState} from './RuntimeSettings';
export function JournalView({state,busy,onLesson}:{state:RuntimeState;busy:boolean;onLesson(id:string,approved:boolean):void}) {
  const [view,setView]=useState('Trades');const [filter,setFilter]=useState('All');
  const reviews=state.reviews.filter(r=>filter==='All'||r.decision.action===filter);
  return <div aria-label="Portfolio journal"><section className="journal-header"><div className="section-head"><h2>Portfolio journal</h2><small>{state.reviews.length} recent decisions · {state.outcomes?.length??0} trade outcomes</small></div><div className="segmented" aria-label="Journal views">{['Trades','Decisions','Reviewed lessons'].map(name=><button key={name} aria-pressed={view===name} onClick={()=>setView(name)}>{name}</button>)}</div></section>
    {view==='Trades'&&<TradeOutcomes outcomes={state.outcomes??[]}/>}
    {view==='Decisions'&&<section><div className="section-head"><h2>Decisions</h2><select aria-label="Decision action" value={filter} onChange={e=>setFilter(e.target.value)}>{['All','Buy','Sell','Hold'].map(v=><option key={v}>{v}</option>)}</select></div>{!reviews.length&&<div className="empty">No decisions in this view.</div>}{reviews.map(r=><article className="journal-entry" key={r.id}><div className="section-head"><h3><span className={'decision-tag '+r.decision.action.toLowerCase()}>{r.decision.action}</span> {r.decision.symbol}{r.decision.quantity>0?` · ${r.decision.quantity} shares`:''}</h3><time>{new Date(r.timestamp).toLocaleString()}</time></div><p>{r.decision.explanation}</p><small>{r.provider==='local'?'Local rules':r.provider==='openai'?'OpenAI':'External agent'} · {r.emergency?'Emergency review':r.trigger} · {r.orderId?'Order submitted':r.proposalId?'Proposal created':'No order'}</small>{r.executionNote&&<p className="notice">{r.executionNote}</p>}<details className="inline-help"><summary>Record details</summary><p>Review {r.id}<br/>Proposal {r.proposalId??'None'}<br/>Order {r.orderId??'None'}</p></details></article>)}</section>}
    {view==='Reviewed lessons'&&<LearningPanel state={state}/>}
  </div>;
}
