import {useEffect,useState} from 'react';
type Point={date:string;value:number};
type Series={id:string;market:'KR'|'US';source:string;name:string;unit:string;frequency:string;date:string|null;value:number|null;previous:number|null;change:number|null;history:Point[];stale?:boolean};
type Snapshot={fetchedAt:number;ecosAccess:'key'|'sample';calendarAccess:'key'|'none';series:Series[];calendar:{date:string;market:string;event:string;source:string}[]|null;errors:{id:string;source:string;code:string}[]};
export type MacroState={snapshot:Snapshot|null;refreshing:boolean;error:string|null;ecosConnected:boolean;fredConnected:boolean};
const number=(value:number|null,unit:string)=>value==null?'—':value.toLocaleString(undefined,{minimumFractionDigits:unit==='KRW'?1:2,maximumFractionDigits:unit==='KRW'?1:2});
const signed=(value:number|null,unit:string)=>value==null?'—':`${value>0?'+':value<0?'−':'±'}${number(Math.abs(value),unit)}${unit.startsWith('%')?' pts':''}`;
const period=(s:Series)=>s.date==null?'':s.frequency==='monthly'?new Date(s.date+'T00:00:00Z').toLocaleDateString(undefined,{year:'numeric',month:'short',timeZone:'UTC'}):s.date;
// Recent observations as a small line; the value and change in text carry the information.
function Spark({points}:{points:Point[]}){
  if(points.length<2)return null;const W=120,H=32,lo=Math.min(...points.map(p=>p.value)),hi=Math.max(...points.map(p=>p.value)),span=hi-lo||1;
  const d=points.map((p,i)=>`${i?'L':'M'}${(i*(W-4)/(points.length-1)+2).toFixed(1)},${(H-3-(p.value-lo)/span*(H-6)).toFixed(1)}`).join('');
  return <svg className="macro-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${points.length} recent observations from ${points[0].date} to ${points.at(-1)!.date}`}><path d={d}/></svg>;
}
function Tile({s}:{s:Series}){
  return <div className="macro-tile" aria-label={s.name}><small>{s.name}</small><strong>{number(s.value,s.unit)}<span className="muted">{s.unit&&s.unit!=='KRW'?` ${s.unit}`:s.unit==='KRW'?' ₩':''}</span></strong>
    <span className={s.change==null||s.change===0?'muted':s.change>0?'macro-up':'macro-down'}>{signed(s.change,s.unit)} <span className="muted">vs previous</span></span>
    <Spark points={s.history}/><span className="muted small-print">{period(s)} · {s.source}{s.stale?' · last refresh failed':''}</span></div>;
}
export function MacroView(){
  const [state,setState]=useState<MacroState|null>(null);const [busy,setBusy]=useState(false);
  useEffect(()=>{let alive=true;const load=async()=>{try{const value=await window.portfolio?.getMacro();if(alive&&value)setState(value);}catch{}};void load();const timer=setInterval(load,60000);return()=>{alive=false;clearInterval(timer);};},[]);
  if(!window.portfolio)return null;
  const refresh=async()=>{setBusy(true);try{setState(await window.portfolio!.refreshMacro());}catch{}finally{setBusy(false);}};
  const snap=state?.snapshot;const group=(market:'KR'|'US')=>snap?.series.filter(s=>s.market===market)??[];const today=new Date().toISOString().slice(0,10);
  return <section aria-label="Macro inputs">
    <div className="section-head"><div><h2>Macro inputs</h2><small>{snap?`Updated ${new Date(snap.fetchedAt).toLocaleString()} · refreshes every 6 hours`:state?.refreshing?'Loading official data…':'Not loaded yet'}</small></div><button disabled={busy||state?.refreshing} onClick={()=>void refresh()}>{busy||state?.refreshing?'Refreshing…':'Refresh'}</button></div>
    {state?.error&&<p role="alert" className="notice error">The last refresh failed ({state.error}). Showing the previous data.</p>}
    {snap&&<>
      <h3>Korea · Bank of Korea ECOS</h3><div className="macro-grid">{group('KR').map(s=><Tile key={s.id} s={s}/>)}</div>
      <h3>United States · FRED</h3><div className="macro-grid">{group('US').map(s=><Tile key={s.id} s={s}/>)}</div>
      {snap.errors.filter(e=>e.id!=='CALENDAR').length>0&&<p className="notice">Unavailable this refresh: {snap.errors.filter(e=>e.id!=='CALENDAR').map(e=>e.id).join(', ')}.</p>}
      <h3>Upcoming releases</h3>
      {snap.calendar?snap.calendar.length?<table aria-label="Release calendar"><thead><tr><th>Date</th><th>Release</th><th>Source</th></tr></thead><tbody>{snap.calendar.map(e=><tr key={e.date+e.event} className={e.date===today?'macro-today':''}><td>{e.date}{e.date===today?' · today':''}</td><td>{e.event}</td><td className="muted">{e.source}</td></tr>)}</tbody></table>:<p className="muted">No tracked releases in the next 45 days.</p>
        :<p className="muted">{snap.errors.some(e=>e.id==='CALENDAR')?'The FRED release calendar could not load; check the FRED key.':'Add a free FRED key in Connections to see U.S. release dates.'}</p>}
    </>}
    <details className="inline-help"><summary>Sources and coverage</summary><p className="muted">Korea: Bank of Korea ECOS ({snap?.ecosAccess==='key'?'your key':'public sample access, limited to the latest 10 observations per series'}). United States: Federal Reserve Bank of St. Louis FRED downloads; daily rates and VIX lag one business day, CPI and unemployment are monthly. Inflation is year-over-year from the index. Changes compare with the previous observation. The AI receives the latest values and the next two weeks of releases as background context. Korean policy-meeting dates and analyst consensus are not connected.</p></details>
  </section>;
}
