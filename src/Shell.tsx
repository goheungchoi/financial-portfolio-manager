import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {RuntimeState} from './RuntimeSettings';
import {HOME,tabGuides,workspaceGroups} from './WorkspaceUX';
type Market={status:string;error?:string|null;accountTimestamp?:string;stream?:{status:string;subscribed:number};quotes:{timestamp?:number;timeBasis?:string;stale:boolean}[]};
const kst=(ms:number)=>new Date(ms).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
// A status chip that opens a small panel of details; closes on outside click or Escape.
function Chip({label,tone,children,title}:{label:ReactNode;tone:string;children?:ReactNode;title?:string}){
  const [open,setOpen]=useState(false);const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const away=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false);};const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};addEventListener('mousedown',away);addEventListener('keydown',esc);return()=>{removeEventListener('mousedown',away);removeEventListener('keydown',esc);};},[open]);
  return <div className="chip-wrap" ref={ref}><button className={`top-chip tone-${tone}`} aria-expanded={children?open:undefined} title={title} onClick={()=>children&&setOpen(v=>!v)}><span className="chip-dot" aria-hidden="true"/>{label}</button>{open&&children&&<div className="chip-panel" role="dialog">{children}</div>}</div>;
}
function EngineChip({onNavigate}:{onNavigate(tab:string):void}){
  const [state,setState]=useState<RuntimeState|null>(null);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
  useEffect(()=>{let alive=true;const load=()=>window.portfolio?.getRuntime().then(v=>{if(alive)setState(v);}).catch(()=>{});void load();const t=setInterval(load,3000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!window.portfolio||!state)return null;
  const running=Boolean(state.launch?.running);const emergency=state.emergency?.active;
  const tone=emergency||state.lastError?'danger':state.guardrails?.trippedToday?'warning':state.busy?'accent':running?'success':'muted';
  const label=emergency?'Emergency':state.busy?'Reviewing…':state.lastError?'Review failed':running?`Auto${state.nextReview?' · next '+kst(state.nextReview):''}`:'Manual';
  const toggle=async()=>{const launch=state.launch;if(!launch)return;setBusy(true);setNote('');try{const reply=await((launch.running||launch.starting)?window.portfolio!.stopAutoTrading():window.portfolio!.startAutoTrading(launch.token));if(reply.state)setState(reply.state);setNote(reply.ok?reply.message??'Done.':reply.error??'Could not start.');}catch{setNote('Could not reach the engine.');}finally{setBusy(false);}};
  return <Chip label={label} tone={tone} title="AI engine">
    <b>{state.scheduler.label}</b><p>{state.scheduler.detail}</p>{state.execution?.detail&&<p>{state.execution.detail}</p>}
    {state.lastErrorDetail&&<p className="negative">{state.lastErrorDetail}</p>}
    {note&&<p role="status">{note}</p>}
    <div className="chip-actions">{state.launch&&<button className={running?'':'primary'} disabled={busy||(!running&&!state.launch.starting&&state.busy)} onClick={()=>void toggle()}>{running?'Stop auto trading':state.launch.starting?'Cancel start':busy?'Working…':'Start auto trading'}</button>}<button onClick={()=>onNavigate('Engine settings')}>Settings</button>{state.lastError&&<button onClick={()=>onNavigate('AI console')}>Console</button>}</div>
  </Chip>;
}
export function TopBar({tab,canBack,canForward,onBack,onForward,onNavigate,market,isKis,account,theme,onTheme}:{tab:string;canBack:boolean;canForward:boolean;onBack():void;onForward():void;onNavigate(tab:string):void;market:Market|null;isKis:boolean;account:string;theme:'dark'|'light';onTheme():void}){
  const group=workspaceGroups.find(g=>g.tabs.includes(tab))?.label;const quote=market?.quotes[0];const stale=market?.quotes.some(q=>q.stale);
  const feedTone=market?.status!=='connected'?'warning':stale?'warning':'success';
  return <div className="topbar">
    <button className={`brand ${tab===HOME?'active':''}`} aria-label="Home" aria-current={tab===HOME?'page':undefined} title="Home" onClick={()=>onNavigate(HOME)}><span className="brand-mark" aria-hidden="true">◈</span><span className="brand-name">Portfolio</span></button>
    <div className="history-buttons"><button aria-label="Back" title="Back (Alt+←)" disabled={!canBack} onClick={onBack}>‹</button><button aria-label="Forward" title="Forward (Alt+→)" disabled={!canForward} onClick={onForward}>›</button></div>
    <nav className="breadcrumb" aria-label="Breadcrumb">{group&&<><span>{group}</span><span className="crumb-sep" aria-hidden="true">›</span></>}<h1 title={tabGuides[tab]?.description}>{tab}</h1></nav>
    <div className="top-status">
      {isKis&&<Chip tone={feedTone} title="Market feed" label={<>{market?.status==='connected'?(stale?'Stale':'Live'):'Reconnecting'}{quote?.timestamp?<small>{kst(quote.timestamp)}</small>:null}</>}>
        <b>Market feed</b><p>{`WebSocket ${market?.stream?.status??'connecting'} · ${market?.stream?.subscribed??0} symbols · REST fallback`}</p>
        {quote?.timestamp&&<p>{quote.timeBasis==='exchange'?'Last trade':'Last quote'} {kst(quote.timestamp)} KST</p>}{market?.accountTimestamp&&<p>Account synced {kst(Date.parse(market.accountTimestamp))} KST</p>}{market?.error&&<p className="negative">The last request failed.</p>}
      </Chip>}
      <Chip tone={account==='Not connected'?'muted':'accent'} label={account}>{account==='Not connected'?<><p>No broker account connected.</p><div className="chip-actions"><button className="primary" onClick={()=>onNavigate('Connections')}>Connect</button></div></>:<><b>{account}</b><div className="chip-actions"><button onClick={()=>onNavigate('Connections')}>Connections</button></div></>}</Chip>
      <EngineChip onNavigate={onNavigate}/>
      <button className="theme-switch icon" role="switch" aria-label="Dark mode" aria-checked={theme==='dark'} title={theme==='dark'?'Switch to light':'Switch to dark'} onClick={onTheme}>{theme==='dark'?'☾':'☀'}</button>
    </div>
  </div>;
}
