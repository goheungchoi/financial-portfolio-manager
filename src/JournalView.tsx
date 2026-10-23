import {LearningPanel} from './LearningPanel';
import {Scoreboard} from './Scoreboard';
import {TradeOutcomes} from './TradeOutcomes';
import type {RuntimeState} from './RuntimeSettings';
import {setDraft,useDraftState} from './useDraftState';
import {AccountScope,accountName,type HistoryScope} from './AccountScope';
type Review=RuntimeState['reviews'][number];
const PROVIDER:Record<string,string>={local:'Local rules',openai:'OpenAI',external:'External agent'};
const day=(t:number)=>new Date(t).toLocaleDateString('en-CA');
const clock=(t:number)=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const withheldOf=(r:Review)=>(r.decision as {withheld?:{symbol:string}}).withheld;
const title=(r:Review)=>withheldOf(r)?`Buy withheld: incomplete plan (${withheldOf(r)!.symbol})`:r.decision.action==='Hold'?'No trade':`${r.decision.symbol}${r.decision.quantity>0?` ×${r.decision.quantity}`:''}`;
const money=(value:number|null,currency:string)=>value==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2,signDisplay:'exceptZero'}).format(value);
// The selected decision with what came of it: the order, its outcome and any lesson drawn from it.
function DecisionDetail({review,state,onNavigate,onLessons}:{review:Review;state:RuntimeState;onNavigate?(tab:string):void;onLessons():void}){
  const outcomes=(state.outcomes??[]).filter(o=>o.reviewId===review.id);
  const lessons=state.lessons.filter(l=>l.evidence?.reviewId===review.id);
  const result=review.orderId?'Order submitted':review.proposalId?'Proposal created':'No order';
  return <article className="journal-entry thread" aria-label="Decision detail" data-id={review.id}>
    <div className="thread-head"><div><h3><span className={'decision-tag '+review.decision.action.toLowerCase()}>{review.decision.action}</span> {title(review)}</h3><small>{day(review.timestamp)} {clock(review.timestamp)} · {review.emergency?'Emergency review':review.trigger}</small></div><span className={`outcome-pill tone-${review.decision.action.toLowerCase()}`}>{result}</span></div>
    <div className="bubble from-ai"><div className="bubble-head"><span className="who">{PROVIDER[review.provider]??review.provider}</span></div><p>{review.decision.explanation}</p></div>
    {review.executionNote&&<div className="meta-line"><b>Execution</b><span>{review.executionNote}</span></div>}
    {outcomes.length>0&&<div className="detail-block"><div className="thread-label">Outcome</div>{outcomes.map(o=><div key={o.id} className="meta-line"><b>{o.side} {o.quantity}/{o.requested}</b><span>{o.side==='Sell'?`${money(o.gainAfterFees,o.currency)} after fees`:`Bought at ${money(o.averagePrice,o.currency).replace('+','')}`}{o.assessment?` · ${o.assessment.category}`:''}</span><time>{day(o.timestamp)}</time></div>)}</div>}
    {lessons.length>0&&<div className="detail-block"><div className="thread-label">Lessons</div>{lessons.map(l=><div key={l.id} className="meta-line"><b>{l.lifecycle?.status??(l.approved?'approved':'pending')}</b><span>{l.text}</span></div>)}<button className="link-button" onClick={onLessons}>Review lessons →</button></div>}
    <div className="detail-actions">{onNavigate&&<button onClick={()=>{setDraft('console:focus',review.id);onNavigate('AI console');}}>Open conversation</button>}<small className="muted">Review {review.id.slice(0,8)}{review.proposalId?` · proposal ${review.proposalId.slice(0,8)}`:''}{review.orderId?` · order ${review.orderId.slice(0,8)}`:''}</small></div>
  </article>;
}
export function JournalView({state,onNavigate}:{state:RuntimeState;busy:boolean;onLesson(id:string,approved:boolean):void;onNavigate?(tab:string):void}) {
  const [view,setView]=useDraftState('journal:view','Decisions');const [filter,setFilter]=useDraftState('journal:filter','All');const [selected,setSelected]=useDraftState<string|null>('journal:selected',null);const [scope,setScope]=useDraftState<HistoryScope>('history:accounts','account');
  const all=scope==='all'||!state.account;const source=all?state.allReviews??state.reviews:state.reviews;
  const reviews=source.filter(r=>filter==='All'||r.decision.action===filter);const current=reviews.find(r=>r.id===selected)??reviews[0]??null;
  const pending=state.lessons.filter(l=>!l.lifecycle||['pending','needs-review'].includes(l.lifecycle.status)).length;
  return <div aria-label="Portfolio journal" className="journal-page">
    <div className="journal-tabs segmented" aria-label="Journal views">{[['Decisions',source.length],['Trades',state.outcomes?.length??0],['Reviewed lessons',pending],['Scoreboard',0]].map(([name,count])=><button key={name} aria-pressed={view===name} data-count={Number(count)>0?count:undefined} onClick={()=>setView(String(name))}>{name}</button>)}</div>
    {view==='Decisions'&&(!source.length&&!(state.allReviews??[]).length?<section className="empty">No decisions yet<br/><small>Run a review from Home.</small></section>:
      <section className="ai-console journal-decisions" aria-label="Decisions"><div className="console-layout">
        <nav className="run-list" aria-label="Decision list"><select aria-label="Decision action" value={filter} onChange={e=>setFilter(e.target.value)}>{['All','Buy','Sell','Hold'].map(v=><option key={v}>{v}</option>)}</select><AccountScope account={state.account} scope={scope} onChange={setScope}/>
          {reviews.map(r=><button key={r.id} data-id={r.id} aria-current={r.id===current?.id?'true':undefined} className={`run-item tone-${r.decision.action.toLowerCase()}`} onClick={()=>setSelected(r.id)}><span className={`run-dot tone-${r.decision.action.toLowerCase()}`} aria-hidden="true"/><span className="run-main"><b>{r.decision.action} · {title(r)}</b><small>{r.emergency?'Emergency review':r.trigger}{all&&state.account?` · ${accountName(r.account?.label)}`:''}</small></span><span className="run-side"><time>{clock(r.timestamp)}</time><small>{day(r.timestamp)===day(Date.now())?'today':day(r.timestamp).slice(5)}</small></span></button>)}
          {!reviews.length&&<p className="muted">{!all&&!source.length?`No decisions on ${state.account?.label} yet. Choose All accounts to see earlier ones.`:'No decisions match.'}</p>}</nav>
        {current&&<DecisionDetail review={current} state={state} onNavigate={onNavigate} onLessons={()=>setView('Reviewed lessons')}/>}
      </div></section>)}
    {view==='Trades'&&<TradeOutcomes outcomes={state.outcomes??[]}/>}
    {view==='Reviewed lessons'&&<LearningPanel state={state}/>}
    {view==='Scoreboard'&&<Scoreboard/>}
  </div>;
}
