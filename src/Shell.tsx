import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {RuntimeState} from './RuntimeSettings';
import {HOME,tabGuides,workspaceGroups} from './WorkspaceUX';
import {subscribeRuntime} from './runtimeFeed';
type Market={status:string;marketsOpen?:boolean|null;error?:string|null;failure?:{code:string|null;request:string|null;at:number|null;brokerCode:string|null;brokerMessage?:string|null};accountTimestamp?:string;stream?:{status:string;subscribed:number};quotes:{timestamp?:number;timeBasis?:string;stale:boolean}[]};
const kst=(ms:number)=>new Date(ms).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
// 2026-11-19: "Reconnecting" only when the stream is reconnecting. Before, any status but "connected" read so: a stale
// quote overnight (markets closed) or one failed request showed "Reconnecting" with nothing reconnecting.
// The stream's own states: 'reconnecting' and 'unavailable' (the KIS worker stopped) are named; 'disconnected', 'idle',
// 'connecting', 'subscribing' and 'streaming' are not faults (quotes come by the REST fallback), so the label follows the
// quotes. Old quotes with every market of the scope closed (marketsOpen false) are normal: "Closed", not "Stale".
export function feedLabel(market:Market|null|undefined,stale:boolean){if(!market)return 'Connecting';if(market.stream?.status==='reconnecting')return 'Reconnecting';
  if(market.stream?.status==='unavailable')return 'Unavailable';if(market.status==='error')return 'Request failed';
  if(market.status==='stale'||stale)return market.marketsOpen===false?'Closed':'Stale';return 'Live';}
// The chip's tone: a fault warns; closed markets and a live feed do not.
export function feedTone(market:Market|null|undefined,stale:boolean){const l=feedLabel(market,stale);return l==='Live'?'success':l==='Closed'?'muted':'warning';}
const REQUEST:Record<string,string>={quotes:'quote poll',balance:'balance refresh'};
// Which request failed, its code (and KIS's own code), and when.
export function failureLine(market:Market){const f=market.failure;if(!f)return `The last request failed (${market.error??'unknown'}).`;
  return `The last ${REQUEST[f.request??'']??'request'} failed: ${f.code??'unknown'}${f.brokerCode?` (KIS ${f.brokerCode}${f.brokerMessage?`: ${f.brokerMessage}`:''})`:''}${f.at?` at ${kst(f.at)} KST`:''}.`;}
// A status chip that opens a small panel of details; closes on outside click or Escape.
function Chip({label,tone,children,title}:{label:ReactNode;tone:string;children?:ReactNode;title?:string}){
  const [open,setOpen]=useState(false);const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const away=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false);};const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};addEventListener('mousedown',away);addEventListener('keydown',esc);return()=>{removeEventListener('mousedown',away);removeEventListener('keydown',esc);};},[open]);
  return <div className="chip-wrap" ref={ref}><button className={`top-chip tone-${tone}`} aria-expanded={children?open:undefined} title={title} onClick={()=>children&&setOpen(v=>!v)}><span className="chip-dot" aria-hidden="true"/>{label}</button>{open&&children&&<div className="chip-panel" role="dialog">{children}</div>}</div>;
}
function EngineChip({onNavigate}:{onNavigate(tab:string):void}){
  const [state,setState]=useState<RuntimeState|null>(null);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
  useEffect(()=>subscribeRuntime(v=>{if(v)setState(v);}),[]);
  if(!window.portfolio||!state)return null;
  const running=Boolean(state.launch?.running);const emergency=state.emergency?.active;
  const tone=emergency||state.lastError?'danger':state.guardrails?.trippedToday?'warning':state.busy?'accent':running?'success':'muted';
  const label=emergency?'Emergency':state.busy?'Reviewing…':state.lastError?'Review failed':running?`Auto${state.nextReview?' · next '+kst(state.nextReview):''}`:'Manual';
  const toggle=async()=>{const launch=state.launch;if(!launch)return;setBusy(true);setNote('');try{const reply=await((launch.running||launch.starting)?window.portfolio!.stopAutoTrading():window.portfolio!.startAutoTrading(launch.token));if(reply.state)setState(reply.state);setNote(reply.ok?reply.message??'Done.':reply.error??'Could not start.');}catch{setNote('Could not reach the engine.');}finally{setBusy(false);}};
  return <Chip label={label} tone={tone} title="AI engine">
    <b>{state.scheduler.label}</b><p>{state.scheduler.detail}</p>{state.execution?.detail&&<p>{state.execution.detail}</p>}
    {state.lastErrorDetail&&<p className="negative">{state.lastErrorDetail}</p>}
    {note&&<p role="status">{note}</p>}
    <div className="chip-actions">{state.launch&&<button className={running?'':'primary'} disabled={busy||(!running&&!state.launch.starting&&state.busy)} onClick={()=>void toggle()}>{running?'Stop auto trading':busy?'Starting…':state.launch.starting?'Cancel start':'Start auto trading'}</button>}<button onClick={()=>onNavigate('Engine settings')}>Settings</button>{state.lastError&&<button onClick={()=>onNavigate('AI console')}>Console</button>}</div>
  </Chip>;
}
export function TopBar({tab,canBack,canForward,onBack,onForward,onNavigate,market,isKis,account,theme,onTheme}:{tab:string;canBack:boolean;canForward:boolean;onBack():void;onForward():void;onNavigate(tab:string):void;market:Market|null;isKis:boolean;account:string;theme:'dark'|'light';onTheme():void}){
  const group=workspaceGroups.find(g=>g.tabs.includes(tab))?.label;const quote=market?.quotes[0];const stale=market?.quotes.some(q=>q.stale);
  const tone=feedTone(market,Boolean(stale));
  return <div className="topbar">
    <button className={`brand ${tab===HOME?'active':''}`} aria-label="Home" aria-current={tab===HOME?'page':undefined} title="Home" onClick={()=>onNavigate(HOME)}><span className="brand-mark" aria-hidden="true">◈</span><span className="brand-name">Portfolio</span></button>
    <div className="history-buttons"><button aria-label="Back" title="Back (Alt+←)" disabled={!canBack} onClick={onBack}>‹</button><button aria-label="Forward" title="Forward (Alt+→)" disabled={!canForward} onClick={onForward}>›</button></div>
    <nav className="breadcrumb" aria-label="Breadcrumb">{group&&<><span>{group}</span><span className="crumb-sep" aria-hidden="true">›</span></>}<h1 title={tabGuides[tab]?.description}>{tab}</h1></nav>
    <div className="top-status">
      {isKis&&<Chip tone={tone} title="Market feed" label={<>{feedLabel(market,Boolean(stale))}{quote?.timestamp?<small>{kst(quote.timestamp)}</small>:null}</>}>
        <b>Market feed</b><p>{`WebSocket ${market?.stream?.status??'connecting'} · ${market?.stream?.subscribed??0} symbols · REST fallback`}</p>
        {feedLabel(market,Boolean(stale))==='Closed'&&<p>Markets closed{quote?.timestamp?`; last quote ${kst(quote.timestamp)} KST`:''}.</p>}{quote?.timestamp&&<p>{quote.timeBasis==='exchange'?'Last trade':'Last quote'} {kst(quote.timestamp)} KST</p>}{market?.accountTimestamp&&<p>Account synced {kst(Date.parse(market.accountTimestamp))} KST</p>}{market?.error&&<p className="negative">{failureLine(market)}</p>}
      </Chip>}
      <Chip tone={account==='Not connected'?'muted':'accent'} label={account}>{account==='Not connected'?<><p>No broker account connected.</p><div className="chip-actions"><button className="primary" onClick={()=>onNavigate('Connections')}>Connect</button></div></>:<><b>{account}</b><div className="chip-actions"><button onClick={()=>onNavigate('Connections')}>Connections</button></div></>}</Chip>
      <EngineChip onNavigate={onNavigate}/>
      <button className="theme-switch icon" role="switch" aria-label="Dark mode" aria-checked={theme==='dark'} title={theme==='dark'?'Switch to light':'Switch to dark'} onClick={onTheme}>{theme==='dark'?'☾':'☀'}</button>
    </div>
  </div>;
}
