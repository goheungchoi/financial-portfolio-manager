import {useEffect,useState} from 'react';
import {Note} from './Note';
// What is driving the market: confirmed drivers with the signals behind them, and similar past episodes with what followed.
type Driver={id:string;kind:string;title:string;summary:string;direction:string;themes:string[];affects:string[];confirmedBy:{signal:string;observation:string}[];confirmed:boolean;confidence:string;since:string;hidden?:boolean;sources:{title:string;source:string;url?:string}[]};
type Episode={day:string;title:string;kind:string;similarity?:number;sharedThemes?:string[];drivers:any[];moves:Record<string,{d1:number|null;d5:number|null}>;outcomes?:Record<string,Record<string,number|null>>|null;note?:string};
export type NarrativeState={latest:{timestamp:number;regime:string;summary:string;drivers:Driver[];model?:string}|null;episodes:Episode[];similar:Episode[];busy:boolean;blocked:string|null;error:string|null;enabled:boolean};
const REGIME:Record<string,string>={risk_on:'Risk-on',neutral:'Neutral',risk_off:'Risk-off'};
const THEME:Record<string,string>={rates:'Rates',inflation:'Inflation',growth_slowdown:'Growth',geopolitics:'Geopolitics',oil_energy:'Oil',fx_dollar:'Dollar',credit_stress:'Credit',ai_profitability:'AI profits',ai_demand:'AI demand',semiconductor_cycle:'Chip cycle',china_competition:'China',trade_tariffs:'Tariffs',policy_regulation:'Policy',earnings:'Earnings',korea_policy:'Korea policy',liquidity_flows:'Flows',other:'Other'};
const pct=(v:number|null|undefined)=>v==null?'—':`${v>0?'+':''}${v.toFixed(1)}%`;
const ago=(t:number)=>{const m=Math.round((Date.now()-t)/60000);return m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:new Date(t).toLocaleDateString();};
function EpisodeRow({e}:{e:Episode}){
  const o=e.outcomes??{};const line=(index:string)=>o[index]?`${index} ${pct(o[index].d1)} / ${pct(o[index].d5)} / ${pct(o[index].d20)}`:null;
  return <li><div><b>{e.day} · {e.title}</b>{e.similarity!=null&&<span className="badge">{Math.round(e.similarity*100)}% similar</span>}
    <small>{(e.drivers??[]).map((d:any)=>typeof d==='string'?d:d.title).join(' · ')||'No drivers recorded'}</small>
    <small>After 1 / 5 / 20 trading days: {['KOSPI','SPX','SOX'].map(line).filter(Boolean).join(' · ')||'not enough days yet'}</small></div></li>;
}
export function MarketNarrative(){
  const [state,setState]=useState<NarrativeState|null>(null);const [note,setNote]=useState('');const [gauge,setGauge]=useState<{regime:string;score:number;components:{name:string;value:number;reading:string;score:number}[]}|null>(null);
  useEffect(()=>{let alive=true;const load=async()=>{try{const s=await window.portfolio?.getRuntime();if(alive&&s?.narrative)setState(s.narrative as NarrativeState);if(alive)setGauge((s as any)?.regime??null);}catch{}};void load();const t=setInterval(load,10000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!window.portfolio||!state)return null;
  const refresh=async()=>{setNote('');setState({...state,busy:true});const r=await window.portfolio!.refreshNarrative();setState(r.state);if(!r.ok)setNote(r.error==='AI_BUDGET_EXHAUSTED'?'Daily AI budget reached.':r.state.blocked??'The narrative could not be updated. See Console.');};
  const hide=async(id:string,hidden:boolean)=>setState(await window.portfolio!.hideNarrativeDriver(id,hidden));
  const n=state.latest;const drivers=n?.drivers??[];
  return <section className="market-narrative" aria-label="Market narrative" aria-busy={state.busy}>
    <div className="section-head"><div><h2>What's driving the market</h2><small className="muted">{state.busy?'Reading headlines…':n?`Updated ${ago(n.timestamp)} · weekdays 08:30 and 16:30`:state.blocked??'Not built yet'}</small></div><button disabled={state.busy||Boolean(state.blocked)} onClick={()=>void refresh()}>{state.busy?'Updating…':'Update now'}</button></div>
    {gauge&&<div className="regime-gauge" aria-label="Regime gauge"><span className={`regime regime-${gauge.regime}`}>Gauge: {REGIME[gauge.regime]}</span>{gauge.components.map(c=><span key={c.name} className={`gauge-part ${c.score<0?'neg':c.score>0?'pos':''}`} title={`${c.name}: ${c.value}`}>{c.name.replace(/ %$/,'')} · {c.reading}</span>)}</div>}
    {note&&<p className="warning-text">{note}</p>}
    {n&&<><p className="research-line"><span className={`regime regime-${n.regime}`}>{REGIME[n.regime]??n.regime}</span> {n.summary}</p>
      <ul className="desk-list narrative-drivers" aria-label="Market drivers">{drivers.map(d=><li key={d.id} className={d.hidden||!d.confirmed?'muted-row':''}>
        <div><span className={`role-tag ${d.direction==='negative'?'role-trim':d.direction==='positive'?'role-add':''}`}>{d.kind==='trigger'?'Trigger':'Background'}</span> <b>{d.title}</b>{d.themes.map(t=><span key={t} className="theme-chip">{THEME[t]??t}</span>)}
          <small className="desk-reason">{d.summary}</small>
          <small>{d.confirmed?<>Confirmed by: {d.confirmedBy.map(c=>c.observation).join('; ')}</>:'Not confirmed by market data, so the agents do not see it.'}{d.affects.length?` · Affects ${d.affects.join(', ')}`:''} · {d.confidence} confidence · since {d.since}</small>
          {d.sources.length>0&&<small>Sources: {d.sources.map((s,i)=><span key={i}>{i?' · ':''}{s.url?<button className="link-button" onClick={()=>void window.portfolio?.openNews(s.url!)}>{s.source}</button>:s.source}</span>)}</small>}</div>
        {d.confirmed&&<button aria-label={`${d.hidden?'Show':'Hide'} driver ${d.title}`} onClick={()=>void hide(d.id,!d.hidden)}>{d.hidden?'Show':'Hide'}</button>}</li>)}</ul></>}
    {state.similar.length>0&&<><h3 className="research-sub">Similar past episodes</h3><ul className="desk-list compact" aria-label="Similar episodes">{state.similar.map(e=><EpisodeRow key={e.day} e={e}/>)}</ul></>}
    {state.episodes.length>0&&<Note summary={`Episode library · ${state.episodes.length}`}><ul className="desk-list compact" aria-label="Episode library">{state.episodes.map(e=><EpisodeRow key={e.day} e={e}/>)}</ul><p className="muted">Days when KOSPI, the S&amp;P 500, Nasdaq or the semiconductor index moved sharply, with the drivers of the day and what indices did afterwards.</p></Note>}
    <p className="muted research-note">Hidden drivers stay here but the agents stop reading them.</p>
  </section>;
}
