import {useEffect,useMemo,useRef,useState} from 'react';
import {useDraftState,takeDraft} from './useDraftState';
import {AccountScope,accountName,type AccountTag,type HistoryScope} from './AccountScope';
export type Interaction={id:string;runId:string;timestamp:string;kind:string;title:string;body:string;account?:string;accountLabel?:string};
const clock=(value:string)=>new Date(value).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'});
const day=(value:string)=>new Date(value).toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'});
const parse=(text:string)=>{try{return JSON.parse(text);}catch{return null;}};
const pretty=(text:string)=>{const value=parse(text);return value==null?text:JSON.stringify(value,null,2);};
const short=(text:string,n=160)=>{const flat=text.replace(/\s+/g,' ').trim();return flat.length>n?flat.slice(0,n)+'…':flat;};
type Run={id:string;events:Interaction[];started:string;trigger:string;outcome:string;tone:string;model:string|null;tokens:string|null;symbol:string};
// One review, reflection or test run = one conversation between the app and the AI.
function summarize(id:string,events:Interaction[]):Run{
  const first=events[0];const decision=events.find(e=>e.kind==='Agent'&&e.title==='Decision');const value=decision?parse(decision.body):null;
  const failed=events.find(e=>/fail|error/i.test(e.title));// Runs end with "Review completed" (reviews, scout, narrative) or "Replay finished" (replays).
  const done=events.find(e=>e.title==='Review completed'||e.title==='Replay finished');const model=events.find(e=>e.title==='Model used');const usage=done?parse(done.body):null;
  const planned=events.some(e=>e.title==='Scout plan');
  // A dry run logs one summary entry when it finishes; it has no "Review completed" entry.
  const dry=events.some(e=>e.title==='Dry run · inputs checked'||e.title==='Dry-run review · nothing applied');
  // A standalone notice (deposit detected, order status not confirmed, emergency mode, guardrail) is one logged entry
  // with no AI exchange: it is complete as soon as it is logged.
  const notice=!dry&&!events.some(e=>['Program','Agent','Context'].includes(e.kind)||e.title==='Review completed'||e.title==='Replay finished');
  const outcome=failed?'Failed':planned?'Plan':dry?'Dry run':notice?'Notice':value?.withheld?'Buy withheld':value?.action??(events.some(e=>/reflection/i.test(e.title))?'Reflection':done?'Completed':'In progress');
  return {id,events,started:first.timestamp,trigger:events.find(e=>e.kind==='Program')?.title??first.title,outcome,tone:failed?'failed':planned?'scout':dry||notice?'done':value?.action?.toLowerCase()??(done?'done':'running'),model:model?model.body.split(' ')[0]:null,tokens:usage&&usage.inputTokens!=null?`${(usage.inputTokens+(usage.outputTokens??0)).toLocaleString()} tokens`:null,symbol:value?.symbol??''};
}
// A short, readable preview of the context object the AI received.
function ContextCard({event}:{event:Interaction}){
  const value=parse(event.body);const facts:[string,string][]=[];
  if(value&&typeof value==='object'){
    if(value.environment)facts.push(['Account',String(value.environment).replace('kis-combined','Korea + U.S.').replace('local-paper','Paper').replace('kis','KIS')]);
    if(Array.isArray(value.universe))facts.push(['Stocks',String(value.universe.length)]);
    if(value.positions)facts.push(['Positions',String(Object.keys(value.positions).length)]);
    if(Array.isArray(value.news))facts.push(['News items',String(value.news.length)]);
    if(Array.isArray(value.reviewedLessons))facts.push(['Lessons',String(value.reviewedLessons.length)]);
    if(value.macro)facts.push(['Macro','included']);if(value.emergency?.active)facts.push(['Emergency','active']);
  }
  return <div className="thread-context"><div className="thread-label">What the AI saw</div>{facts.length>0&&<div className="context-facts">{facts.map(([k,v])=><span key={k}>{k} <b>{v}</b></span>)}</div>}<details><summary>Inspect supplied context</summary><pre>{pretty(event.body)}</pre></details></div>;
}
function ThreadItem({event}:{event:Interaction}){
  const time=<time>{clock(event.timestamp)}</time>;
  if(event.kind==='Context')return <ContextCard event={event}/>;
  if(event.kind==='Agent'&&event.title==='Decision'){const d=parse(event.body);return <div className="bubble from-ai"><div className="bubble-head"><span className="who">AI</span>{time}</div>{d?<><div className="decision-line"><span className={'decision-tag '+String(d.action).toLowerCase()}>{d.action}</span>{d.action!=='Hold'&&<b>{d.symbol} · {d.quantity} shares{d.credit&&d.credit!=='none'?` (${d.credit})`:''}</b>}</div><p>{d.explanation}</p>{d.plan&&(d.plan.thesis||d.plan.stopPrice)&&<p className="muted">Plan: {[d.plan.thesis,d.plan.invalidation&&`invalid if ${d.plan.invalidation}`,d.plan.stopPrice&&`stop ${d.plan.stopPrice}`,d.plan.targetPrice&&`target ${d.plan.targetPrice}`,d.plan.horizonDays&&`${d.plan.horizonDays} days`,`${d.plan.confidence} confidence`].filter(Boolean).join(' · ')}</p>}{d.scoutBrief&&<p className="muted">To scout{d.scoutBrief.request==='run'?' (run requested)':''}: {[d.scoutBrief.lookingFor&&'looking for '+d.scoutBrief.lookingFor,d.scoutBrief.avoid&&'avoid '+d.scoutBrief.avoid,d.scoutBrief.questions,...(d.scoutBrief.feedback??[]).map((f:{symbol:string;verdict:string;reason:string})=>`${f.symbol} ${f.verdict}${f.reason?' – '+f.reason:''}`),!d.scoutBrief.lookingFor&&!d.scoutBrief.avoid&&!d.scoutBrief.questions&&!d.scoutBrief.feedback?.length&&d.scoutBrief.reason].filter(Boolean).join(' · ')}</p>}</>:<pre>{event.body}</pre>}</div>;}
  if(event.kind==='Agent'&&event.title==='Scout plan'){const p=parse(event.body);return <div className="bubble from-ai"><div className="bubble-head"><span className="who">AI</span><b>Portfolio plan</b>{time}</div>{p?<><p>{p.summary}</p>{p.targets?.length>0&&<ul className="plan-lines">{p.targets.map((t:{symbol:string;name:string;role:string;targetWeightPct:number|null;thesis:string})=><li key={t.symbol}><span className={`role-tag role-${t.role}`}>{t.role}</span><b>{t.name||t.symbol}</b>{t.targetWeightPct!=null&&<span> · {t.targetWeightPct}%</span>}<small> {t.thesis}</small></li>)}</ul>}{p.focus&&<p className="muted">Watch: {p.focus}</p>}{p.briefAnswers?.length>0&&<ul className="plan-lines">{p.briefAnswers.map((a:{briefId:string;answer:string})=><li key={a.briefId}><span className="role-tag">{a.briefId}</span><small> {a.answer}</small></li>)}</ul>}{p.retrospective&&<p className="muted">Self-review: {p.retrospective}</p>}</>:<pre>{event.body}</pre>}</div>;}
  if(event.kind==='Agent')return <div className="tool-row ask"><span className="tool-icon" aria-hidden="true">→</span><div><b>AI asked: {event.title}</b><code>{short(event.body,200)}</code></div>{time}</div>;
  if(event.kind==='Tool')return <div className="tool-row result"><span className="tool-icon" aria-hidden="true">←</span><div><b>{event.title}</b><details><summary>{short(event.body)}</summary><pre>{pretty(event.body)}</pre></details></div>{time}</div>;
  if(event.kind==='Program')return <div className="bubble from-app"><div className="bubble-head"><span className="who">App</span><b>{event.title}</b>{time}</div><p>{event.body}</p></div>;
  if(event.kind==='Risk')return <div className="tool-row risk"><span className="tool-icon" aria-hidden="true">◆</span><div><b>{event.title}</b><p>{event.body}</p></div>{time}</div>;
  const failed=/fail|error/i.test(event.title);const usage=parse(event.body);
  if(usage&&Number.isFinite(usage.inputTokens))return <div className="meta-line"><b>{event.title}</b><span>{usage.inputTokens.toLocaleString()} in · {(usage.outputTokens??0).toLocaleString()} out tokens{usage.cachedTokens?` · ${usage.cachedTokens.toLocaleString()} cached`:''}</span>{time}</div>;
  // A request's size in a sentence (used, limit and the largest parts); the full record opens below.
  if(usage&&Number.isFinite(usage.wireBytes)){const kb=(n:number)=>`${(n/1000).toFixed(1)} KB`;
    const largest=(Array.isArray(usage.largest)?usage.largest:[]).slice(0,3).map((s:string)=>{const [k,b]=String(s).split(':');return Number.isFinite(Number(b))?`${k} ${kb(Number(b))}`:k;});
    return <div className="meta-line"><b>{event.title}</b><span>{kb(usage.wireBytes)}{Number.isFinite(usage.limitBytes)?` of ${kb(usage.limitBytes)}`:''}{usage.dryRun?' · dry run':''}{largest.length?` · largest: ${largest.join(', ')}`:''}</span>{time}<details className="meta-detail"><summary>Details</summary><pre>{pretty(event.body)}</pre></details></div>;}
  // Any other structured record: a short line, with the full record behind Details.
  if(usage&&typeof usage==='object')return <div className={`meta-line ${failed?'failed':''}`}><b>{event.title}</b>{time}<details className="meta-detail"><summary>{short(event.body,120)}</summary><pre>{pretty(event.body)}</pre></details></div>;
  return <div className={`meta-line ${failed?'failed':''}`}><b>{event.title}</b>{event.body&&<span>{short(event.body,240)}</span>}{time}</div>;
}
export function AiConsole({events:allEvents}:{events:Interaction[]}){
  const [account,setAccount]=useState<AccountTag|null>(null);const [scope,setScope]=useDraftState<HistoryScope>('history:accounts','account');
  useEffect(()=>{let alive=true;const load=()=>window.portfolio?.getRuntime().then(v=>{if(alive)setAccount(v?.account??null);}).catch(()=>{});void load();const t=setInterval(load,30000);return()=>{alive=false;clearInterval(t);};},[]);
  const all=scope==='all'||!account;const events=useMemo(()=>all?allEvents:allEvents.filter(e=>e.account===account!.key),[allEvents,all,account]);
  const [query,setQuery]=useDraftState('console:query','');const [filter,setFilter]=useDraftState('console:filter','All');const [scroll,setScroll]=useDraftState('console:scroll',true);const [selected,setSelected]=useDraftState<string|null>('console:run',null);const [focus,setFocus]=useState<string|null>(()=>takeDraft<string>('console:focus'));const end=useRef<HTMLDivElement>(null);
  const runs=useMemo(()=>{const groups=new Map<string,Interaction[]>();for(const e of events){if(!groups.has(e.runId))groups.set(e.runId,[]);groups.get(e.runId)!.push(e);}return [...groups].map(([id,list])=>summarize(id,list.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)))).sort((a,b)=>b.started.localeCompare(a.started));},[events]);
  const q=query.trim().toLowerCase();const matches=(e:Interaction)=>(filter==='All'||e.kind===filter)&&(!q||`${e.title} ${e.body} ${e.runId}`.toLowerCase().includes(q));
  const visible=runs.filter(r=>r.events.some(matches));const run=visible.find(r=>r.id===focus)??visible.find(r=>r.id===selected)??visible[0]??null;const shown=run?run.events.filter(matches):[];
  useEffect(()=>{if(scroll)end.current?.scrollIntoView({block:'nearest'});},[shown.length,run?.id,scroll]);
  return <section className="ai-console" aria-label="AI conversations">
    <div className="console-toolbar"><input aria-label="Search interactions" placeholder="Search messages, context, or run ID…" value={query} onChange={e=>setQuery(e.target.value)}/><AccountScope account={account} scope={scope} onChange={setScope}/><select aria-label="Event type" value={filter} onChange={e=>setFilter(e.target.value)}>{['All','Program','Context','Tool','Agent','Risk','System'].map(v=><option key={v}>{v}</option>)}</select><button onClick={()=>setScroll(v=>!v)}>{scroll?'Pause auto-scroll':'Resume auto-scroll'}</button><button onClick={()=>void window.portfolio?.exportJournal()}>Export interactions</button></div>
    {!runs.length?<div className="empty">{!all&&allEvents.length?`No AI conversations on ${account?.label} yet`:'No AI conversations yet'}<br/><small>{!all&&allEvents.length?'Choose All accounts to see earlier ones. ':''}Run a review from Home to see it here.</small></div>:
    <div className="console-layout">
      <nav className="run-list" aria-label="AI runs">{visible.map(r=><button key={r.id} aria-current={r.id===run?.id?'true':undefined} className={`run-item tone-${r.tone}`} onClick={()=>{setFocus(null);setSelected(r.id);}}><span className={`run-dot tone-${r.tone}`} aria-hidden="true"/><span className="run-main"><b>{r.outcome}{r.symbol&&r.outcome!=='Hold'?` · ${r.symbol}`:''}</b><small>{r.trigger}{all&&account?` · ${accountName(r.events[0]?.accountLabel)}`:''}</small></span><span className="run-side"><time>{clock(r.started).slice(0,5)}</time><small>{day(r.started)===day(new Date().toISOString())?'today':day(r.started).slice(5)}</small></span></button>)}{!visible.length&&<p className="muted">No runs match.</p>}</nav>
      {run&&<div className="thread" aria-label="Conversation">
        <div className="thread-head"><div><h3>{run.trigger}</h3><small>{day(run.started)} {clock(run.started)} KST · run {run.id.slice(0,8)}{run.model?` · ${run.model}`:''}{run.tokens?` · ${run.tokens}`:''}</small></div><span className={`outcome-pill tone-${run.tone}`}>{run.outcome}</span></div>
        {shown.map(e=><ThreadItem key={e.id} event={e}/>)}
        <div ref={end}/>
      </div>}
    </div>}
    <p className="muted small-print">The AI's private reasoning is not shown, only what was exchanged. {window.portfolio?'History is saved on this computer (latest 600 events).':'Browser preview history is temporary.'}</p>
  </section>;
}
