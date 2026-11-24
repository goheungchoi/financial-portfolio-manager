import {LearningPanel} from './LearningPanel';
import {Scoreboard} from './Scoreboard';
import {TradeOutcomes} from './TradeOutcomes';
import type {RuntimeState} from './RuntimeSettings';
import {useState} from 'react';
import {outcomeWords} from './outcome-words.mjs';
import {setDraft,useDraftState} from './useDraftState';
import {AccountScope,accountName,type HistoryScope} from './AccountScope';
import {AgentDesk} from './AgentDesk';
import {ReplayPanel} from './ReplayPanel';
import {ScreenList,type ScreenRecord} from './ScoutScreens';
import type {DeskState} from './RuntimeSettings';
import {JOURNAL_TABS,journalTab,journalBadges,firstSentences,decisionFacts,orderPill,ordersOf,batchCounts,batchAction,matchesAction} from './journalTabs';
type Review=RuntimeState['reviews'][number];
// Who decided (provider-naming P1): an AI decision names its company from vendor (the main process fills it from the
// model for old records); with neither known it says AI, never a company. 'openai' is the old word for any AI decision.
const PROVIDER:Record<string,string>={local:'Local rules',ai:'AI',openai:'AI',external:'External agent'};
const VENDOR:Record<string,string>={anthropic:'Claude',openai:'OpenAI'};
const day=(t:number)=>new Date(t).toLocaleDateString('en-CA');
const clock=(t:number)=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const withheldOf=(r:Review)=>(r.decision as {withheld?:{symbol:string}}).withheld;
// The tone of a review's dot and tag: its action, or for several orders the action they share (none when mixed).
const tone=(r:Review)=>(batchAction(r as never)??r.decision.action).toLowerCase();
const title=(r:Review)=>batchCounts(r as never)??(withheldOf(r)?`Buy withheld: incomplete plan (${withheldOf(r)!.symbol})`:r.decision.action==='Hold'?'No trade':`${r.decision.symbol}${r.decision.quantity>0?` ×${r.decision.quantity}`:''}`);
const money=(value:number|null,currency:string)=>value==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2,signDisplay:'exceptZero'}).format(value);
// The scripts a review ran with run_screen (S4), kept with the review (4 at most), collapsed under More; nothing when none ran.
export function DecisionScripts({review}:{review:Review}){
  const use=(review as {formulaUse?:{screenCalls?:number;scripts?:ScreenRecord[]}}).formulaUse;const scripts=Array.isArray(use?.scripts)?use!.scripts!:[];
  if(!scripts.length)return null;const calls=use?.screenCalls??scripts.length;
  return <details className="detail-block" aria-label="Scripts of this review"><summary>Scripts ({calls})</summary><ScreenList loaded={{failed:false,at:null,screens:scripts}}/>{calls>scripts.length&&<p className="muted">The first {scripts.length} are kept.</p>}</details>;}
// The selected decision with what came of it: the order, its outcome and any lesson drawn from it.
function DecisionDetail({review,state,onNavigate,onLessons}:{review:Review;state:RuntimeState;onNavigate?(tab:string):void;onLessons():void}){
  const outcomes=(state.outcomes??[]).filter(o=>o.reviewId===review.id);
  const lessons=state.lessons.filter(l=>l.evidence?.reviewId===review.id);
  const all=ordersOf(review as never);const result=all?`${all.length} orders`:orderPill(review as never);
  const [whole,setWhole]=useState(false);const [more,setMore]=useDraftState('journal:detailMore',false);
  const text=firstSentences(review.decision.explanation);const usage=state.tokenSaving?.recent?.find(r=>r.reviewId===review.id)??null;
  const facts=decisionFacts(review as never,usage);
  return <article className="journal-entry thread" aria-label="Decision detail" data-id={review.id}>
    <div className="thread-head"><div><h3>{!all&&<><span className={'decision-tag '+review.decision.action.toLowerCase()}>{review.decision.action}</span> </>}{title(review)}</h3><small>{day(review.timestamp)} {clock(review.timestamp)} · {review.emergency?'Emergency review':review.trigger}</small></div><span className={`outcome-pill tone-${review.decision.action.toLowerCase()}`}>{result}</span></div>
    <div className="bubble from-ai"><div className="bubble-head"><span className="who">{VENDOR[(review as {vendor?:string}).vendor??'']??PROVIDER[review.provider]??review.provider}</span></div><p aria-label="Explanation">{whole||!text.more?review.decision.explanation:text.short}{text.more&&<> <button className="link-button" aria-expanded={whole} aria-label={whole?'Show less of the explanation':'Show the whole explanation'} onClick={()=>setWhole(v=>!v)}>{whole?'Less':'More'}</button></>}</p></div>
    {all&&<div className="detail-block" aria-label="Orders of this review"><div className="thread-label">Orders</div>{all.map(o=><div key={o.item} className="meta-line"><b>{o.action} {o.symbol} ×{o.quantity}</b><span className="outcome-pill">{orderPill(o)}</span>{o.executionNote&&<small>{o.executionNote}</small>}</div>)}</div>}
    <div className="decision-facts" aria-label="Decision facts">{facts.map(f=><div key={f.label} className="decision-fact"><small>{f.label}</small><span>{f.value}</span></div>)}</div>
    <details className="inline-help decision-more" aria-label="More about this decision" open={more} onToggle={e=>setMore((e.currentTarget as HTMLDetailsElement).open)}><summary>More</summary>
    {review.executionNote&&<div className="meta-line"><b>Execution</b><span>{review.executionNote}</span></div>}
    {outcomes.length>0&&<div className="detail-block"><div className="thread-label">Outcome</div>{outcomes.map(o=><div key={o.id} className="meta-line"><b>{o.side} {o.quantity}/{o.requested}</b><span>{outcomeWords(o,money)??`Bought at ${money(o.averagePrice,o.currency).replace('+','')}`}{o.assessment?` · ${o.assessment.category}`:''}</span><time>{day(o.timestamp)}</time></div>)}</div>}
    {lessons.length>0&&<div className="detail-block"><div className="thread-label">Lessons</div>{lessons.map(l=><div key={l.id} className="meta-line"><b>{l.lifecycle?.status??(l.approved?'approved':'pending')}</b><span>{l.text}</span></div>)}<button className="link-button" onClick={onLessons}>Review lessons →</button></div>}
    <DecisionScripts review={review}/>
    <div className="detail-actions">{onNavigate&&<button onClick={()=>{setDraft('console:focus',review.id);onNavigate('AI console');}}>Open conversation</button>}<small className="muted">Review {review.id.slice(0,8)}{review.proposalId?` · proposal ${review.proposalId.slice(0,8)}`:''}{review.orderId?` · order ${review.orderId.slice(0,8)}`:''}</small></div>
    </details>
  </article>;
}
export function JournalView({state,onNavigate,onDesk}:{state:RuntimeState;busy:boolean;onLesson(id:string,approved:boolean):void;onNavigate?(tab:string):void;onDesk?(desk:DeskState):void}) {
  const [saved,setView]=useDraftState('journal:view','Decisions');const view=journalTab(saved);const badges=journalBadges(state as never);const [filter,setFilter]=useDraftState('journal:filter','All');const [selected,setSelected]=useDraftState<string|null>('journal:selected',null);const [scope,setScope]=useDraftState<HistoryScope>('history:accounts','account');
  const all=scope==='all'||!state.account;const source=all?state.allReviews??state.reviews:state.reviews;
  const reviews=source.filter(r=>matchesAction(r as never,filter));const current=reviews.find(r=>r.id===selected)??reviews[0]??null;
  const warn=Boolean(badges.unmonitored);
  return <div aria-label="Portfolio journal" className="journal-page">
    <div className="journal-tabs segmented" aria-label="Journal views">{JOURNAL_TABS.map(name=>{const count=name==='Orders and triggers'||name==='Lessons'?badges[name]:0;return <button key={name} aria-pressed={view===name} data-count={count>0?count:undefined} data-warn={name==='Orders and triggers'&&warn?'true':undefined} title={name==='Orders and triggers'&&warn?'Not monitored while auto trading is paused.':undefined} onClick={()=>setView(name)}>{name}</button>;})}</div>
    {view==='Decisions'&&(!source.length&&!(state.allReviews??[]).length?<section className="empty">No decisions yet<br/><small>Run a review from Home.</small></section>:
      <section className="ai-console journal-decisions" aria-label="Decisions"><div className="console-layout">
        <nav className="run-list" aria-label="Decision list"><select aria-label="Decision action" value={filter} onChange={e=>setFilter(e.target.value)}>{['All','Buy','Sell','Hold'].map(v=><option key={v}>{v}</option>)}</select><AccountScope account={state.account} scope={scope} onChange={setScope}/>
          {reviews.map(r=><button key={r.id} data-id={r.id} aria-current={r.id===current?.id?'true':undefined} className={`run-item tone-${tone(r)}`} onClick={()=>setSelected(r.id)}><span className={`run-dot tone-${tone(r)}`} aria-hidden="true"/><span className="run-main"><b>{ordersOf(r as never)?title(r):`${r.decision.action} · ${title(r)}`}</b><small>{r.emergency?'Emergency review':r.trigger}{all&&state.account?` · ${accountName(r.account?.label)}`:''}</small></span><span className="run-side"><time>{clock(r.timestamp)}</time><small>{day(r.timestamp)===day(Date.now())?'today':day(r.timestamp).slice(5)}</small></span></button>)}
          {!reviews.length&&<p className="muted">{!all&&!source.length?`No decisions on ${state.account?.label} yet. Choose All accounts to see earlier ones.`:'No decisions match.'}</p>}</nav>
        {current&&<DecisionDetail review={current} state={state} onNavigate={onNavigate} onLessons={()=>setView('Lessons')}/>}
      </div></section>)}
    {view==='Trades'&&<TradeOutcomes outcomes={state.outcomes??[]}/>}
    {view==='Orders and triggers'&&<>{warn&&<p className="notice" role="status">Not monitored while auto trading is paused.</p>}{state.desk?<AgentDesk desk={state.desk} conditionalOn={state.config.conditionalOrders} trailingOn={state.config.trailingStops===true} onChange={desk=>onDesk?.(desk)}/>:<section className="empty">Nothing to show yet<br/><small>The agent's notes, review triggers and conditional orders appear here once the engine has loaded them.</small></section>}</>}
    {view==='Lessons'&&<LearningPanel state={state}/>}
    {view==='Scoreboard'&&<Scoreboard/>}
    {view==='Replay'&&<ReplayPanel/>}
  </div>;
}
