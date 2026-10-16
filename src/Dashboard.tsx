import {useEffect,useState} from 'react';
import type {RuntimeState} from './RuntimeSettings';
export type AttentionItem={id:string;tone:'action'|'warning'|'info';title:string;detail:string;tab:string;action:string};
export type Attention={items:AttentionItem[];counts:{approvals:Record<string,number>;lessons:number;news:number}};
// Polls the main process for things that need the user, shared by the Overview panel and the nav badges.
export function useAttention(){
  const [attention,setAttention]=useState<Attention|null>(null);
  useEffect(()=>{const api=window.portfolio;if(!api?.getAttention)return;let alive=true;const load=()=>api.getAttention().then(value=>{if(alive)setAttention(value);}).catch(()=>{});void load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  return attention;
}
const ago=(t:number)=>{const s=Math.max(0,Math.round((Date.now()-t)/1000));return s<60?'just now':s<3600?`${Math.round(s/60)} min ago`:s<86400?`${Math.round(s/3600)} h ago`:new Date(t).toLocaleDateString();};
const ICON:Record<string,string>={action:'●',warning:'▲',info:'○'};
export function AttentionPanel({attention,onNavigate}:{attention:Attention|null;onNavigate(tab:string):void}){
  const items=attention?.items??[];
  return <section className="attention-panel" aria-label="Needs your attention"><div className="section-head"><h2>Needs your attention</h2>{items.length>0&&<span className="count-pill">{items.length}</span>}</div>
    {!attention?<p className="muted">Checking…</p>:items.length===0?<p className="all-clear">All clear. Nothing needs your action right now.</p>:
      <ul className="attention-list">{items.map(item=><li key={item.id} className={`attention-item tone-${item.tone}`}><span className="attention-icon" aria-hidden="true">{ICON[item.tone]}</span><div><b>{item.title}</b>{item.detail&&<small>{item.detail}</small>}</div><button className={item.tone==='action'?'primary':''} onClick={()=>onNavigate(item.tab)}>{item.action}</button></li>)}</ul>}
  </section>;
}
export function AiActivity({onNavigate}:{onNavigate(tab:string):void}){
  const [state,setState]=useState<RuntimeState|null>(null);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');const [now,setNow]=useState(Date.now());
  useEffect(()=>{let alive=true;const load=()=>window.portfolio?.getRuntime().then(value=>{if(alive)setState(value);}).catch(()=>{});void load();const timer=setInterval(()=>{setNow(Date.now());void load();},3000);return()=>{alive=false;clearInterval(timer);};},[]);
  if(!window.portfolio)return null;
  const reviews=(state?.reviews??[]).slice(0,3);const next=state?.nextReview;const wait=next?Math.max(0,next-now):null;
  const run=async()=>{setBusy(true);setNote('');try{const reply=await window.portfolio!.reviewRuntime();if(reply.state)setState(reply.state);setNote(reply.ok?'Review finished.':'The review did not complete. See AI console for details.');}catch{setNote('Could not reach the engine.');}finally{setBusy(false);}};
  return <section className="ai-activity" aria-label="AI activity"><div className="section-head"><div><h2>AI activity</h2><small>{state?.busy?'Reviewing now…':wait!=null?`Next review in ${Math.floor(wait/60000)}:${String(Math.floor(wait/1000)%60).padStart(2,'0')}`:'Scheduled reviews are off'}</small></div><button disabled={busy||state?.busy} onClick={()=>void run()}>{busy||state?.busy?'Reviewing…':'Run review now'}</button></div>
    {reviews.length?<ul className="decision-feed">{reviews.map(r=><li key={r.id}><span className={'decision-tag '+r.decision.action.toLowerCase()}>{r.decision.action}</span><div><b>{r.decision.action==='Hold'?'No trade':`${r.decision.symbol}${r.decision.quantity?` · ${r.decision.quantity} shares`:''}`}</b><small>{ago(r.timestamp)} · {r.trigger}</small><p>{r.decision.explanation}</p></div></li>)}</ul>:<p className="muted">No AI decisions yet. Run a review or start auto trading.</p>}
    {note&&<p role="status" className="notice">{note}</p>}
    <button className="link-button" onClick={()=>onNavigate('Journal')}>All decisions and lessons →</button>
  </section>;
}
