import {useEffect,useRef,useState} from 'react';
import {useDraftState} from './useDraftState';
type Point={day:string;value:number;flow:number;dailyReturn:number|null;index:number};
type Period={label:string;start:string;end:string;partial:boolean;twr:number|null;gain:number|null;flows:number;benchmark:number|null};
type Summary={kind:string;benchmark:string|null;start:string|null;end:string|null;points:Point[];periods:Period[]};
type Flow={id:string;day:string;market:string;currency:string;amount:number;note:string};
export type PerformanceState={connected:boolean;flows:Flow[];summaries:Record<string,Summary>;benchmarks:Record<string,{day:string;close:number}[]>;benchmarkUpdatedAt?:number|null;benchmarkError?:string|null;refreshing?:boolean};
export type PerformanceReply={ok:boolean;error?:string;state:PerformanceState};
const SERIES:Record<string,{label:string;currency:string}>={COMBINED:{label:'All markets (KRW)',currency:'KRW'},KRW:{label:'Korea (KRW)',currency:'KRW'},USD:{label:'U.S. (USD)',currency:'USD'}};
const BENCH:Record<string,string>={KOSPI:'KOSPI',SPX:'S&P 500'};
const money=(value:number,currency:string)=>new Intl.NumberFormat(currency==='USD'?'en-US':'ko-KR',{style:'currency',currency,maximumFractionDigits:currency==='USD'?2:0}).format(value);
const pct=(value:number|null,digits=2)=>value==null?'—':`${value>0?'+':''}${(value*100).toFixed(digits)}%`;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date());
// Cumulative return since the first recorded day, for the portfolio and the benchmark rebased to the same day.
function chartRows(summary:Summary,closes:{day:string;close:number}[]){
  const closeOn=(day:string)=>closes.filter(c=>c.day<=day).at(-1)?.close??null;const base=summary.points[0];const baseClose=base?closeOn(base.day):null;
  return summary.points.map(p=>{const close=closeOn(p.day);return {day:p.day,portfolio:p.index/base.index-1,benchmark:baseClose&&close?close/baseClose-1:null};});
}
function ReturnChart({rows,benchmark}:{rows:{day:string;portfolio:number;benchmark:number|null}[];benchmark:string}){
  const [hover,setHover]=useState<number|null>(null);const ref=useRef<SVGSVGElement>(null);
  const W=640,H=220,L=48,R=88,T=12,B=26;const values=rows.flatMap(r=>[r.portfolio,r.benchmark]).filter((v):v is number=>v!=null);
  let lo=Math.min(0,...values),hi=Math.max(0,...values);if(hi-lo<0.01){hi+=0.005;lo-=0.005;}const pad=(hi-lo)*0.1;lo-=pad;hi+=pad;
  const x=(i:number)=>L+(rows.length===1?0:i*(W-L-R)/(rows.length-1)),y=(v:number)=>T+(hi-v)*(H-T-B)/(hi-lo);
  const path=(key:'portfolio'|'benchmark')=>rows.map((r,i)=>r[key]==null?null:`${x(i)},${y(r[key]!)}`).filter(Boolean).map((p,i)=>(i?'L':'M')+p).join('');
  // Round tick steps (0.1%, 0.25%, 0.5%, 1%, 2.5%, 5%…) aligned to zero.
  const step=[0.001,0.0025,0.005,0.01,0.025,0.05,0.1,0.25,0.5,1].find(s=>(hi-lo)/s<=5)??1;const ticks:number[]=[];for(let t=Math.ceil(lo/step)*step;t<=hi;t+=step)ticks.push(Math.round(t/step)*step);const last=rows.length-1,end=rows[last];
  const move=(e:React.PointerEvent)=>{const box=ref.current!.getBoundingClientRect();const px=(e.clientX-box.left)*W/box.width;setHover(Math.max(0,Math.min(last,Math.round((px-L)/((W-L-R)/Math.max(1,last))))));};
  const h=hover==null?null:rows[hover];
  return <div className="perf-chart"><svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cumulative return since ${rows[0].day}: portfolio ${pct(end.portfolio)}, ${benchmark} ${pct(end.benchmark)}`} onPointerMove={move} onPointerLeave={()=>setHover(null)}>
    {ticks.map(t=><g key={t}><line className="perf-grid" x1={L} x2={W-R} y1={y(t)} y2={y(t)}/><text className="perf-axis" x={L-6} y={y(t)} textAnchor="end" dominantBaseline="middle">{pct(t,1)}</text></g>)}
    <line className="perf-zero" x1={L} x2={W-R} y1={y(0)} y2={y(0)}/>
    <text className="perf-axis" x={L} y={H-6}>{rows[0].day}</text><text className="perf-axis" x={W-R} y={H-6} textAnchor="end">{end.day}</text>
    {rows.some(r=>r.benchmark!=null)&&<path className="perf-line benchmark" d={path('benchmark')}/>}<path className="perf-line portfolio" d={path('portfolio')}/>
    {end.benchmark!=null&&<text className="perf-label" x={x(last)+8} y={y(end.benchmark)} dominantBaseline="middle">{benchmark}</text>}<text className="perf-label" x={x(last)+8} y={y(end.portfolio)+(end.benchmark!=null&&Math.abs(y(end.portfolio)-y(end.benchmark))<12?(end.portfolio>=end.benchmark?-7:7):0)} dominantBaseline="middle">Portfolio</text>
    {h&&<><line className="perf-cross" x1={x(hover!)} x2={x(hover!)} y1={T} y2={H-B}/><circle className="perf-dot portfolio" cx={x(hover!)} cy={y(h.portfolio)} r="4"/>{h.benchmark!=null&&<circle className="perf-dot benchmark" cx={x(hover!)} cy={y(h.benchmark)} r="4"/>}</>}
    <rect x={L} y={T} width={W-L-R} height={H-T-B} fill="transparent"/>
  </svg>{h&&<div className="perf-tooltip" role="status" style={{left:`${Math.min(70,Math.max(5,x(hover!)/W*100))}%`}}><b>{h.day}</b><span><i className="swatch portfolio"/>Portfolio {pct(h.portfolio)}</span><span><i className="swatch benchmark"/>{benchmark} {pct(h.benchmark)}</span></div>}
    <div className="perf-legend"><span><i className="swatch portfolio"/>Portfolio (time-weighted)</span><span><i className="swatch benchmark"/>{benchmark}</span></div></div>;
}
export function AccountPerformance(){
  const [state,setState]=useState<PerformanceState|null>(null);const [kind,setKind]=useDraftState('performance:series','COMBINED');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [table,setTable]=useState(false);
  const [flow,setFlow]=useDraftState('performance:flow',{day:today(),market:'KR',direction:'deposit',amount:'',note:''});
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getPerformance();if(alive&&reply)setState(reply.state);}catch{}};void load();const timer=setInterval(load,30000);return()=>{alive=false;clearInterval(timer);};},[]);
  if(!window.portfolio)return null;
  const act=async(task:()=>Promise<PerformanceReply>|undefined,done?:()=>void)=>{setBusy(true);setNotice('');try{const reply=await task();if(!reply)return;setState(reply.state);if(reply.ok)done?.();else setNotice(reply.error==='INVALID_FLOW'?'Enter a past or current date and a non-zero amount.':reply.error==='KIS_NOT_CONNECTED'?'Connect KIS first.':'The request could not be completed.');}catch{setNotice('Could not reach the engine.');}finally{setBusy(false);}};
  if(!state?.connected)return <section aria-label="Account performance"><h2>Account value & returns</h2><p>Connect your KIS account in Connections to start recording daily account values.</p></section>;
  const summary=state.summaries[kind],series=SERIES[kind],benchmark=BENCH[summary?.benchmark??'KOSPI'];const points=summary?.points??[];const rows=points.length>=2?chartRows(summary,state.benchmarks[summary.benchmark??'KOSPI']??[]):[];
  const all=summary?.periods.find(p=>p.label==='All');
  return <section aria-label="Account performance"><div className="section-head"><div><h2>Account value & returns</h2><small>{summary?.start?`Recorded daily since ${summary.start}`:'No values recorded yet'}</small></div><select aria-label="Performance series" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(SERIES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
    {points.length?<div className="metrics perf-metrics"><div><small>Latest value · {series.label}</small><strong>{money(points.at(-1)!.value,series.currency)}</strong><span>{points.at(-1)!.day}</span></div><div><small>Time-weighted return · since {summary.start}</small><strong>{pct(all?.twr??null)}</strong><span>{benchmark} {pct(all?.benchmark??null)}</span></div><div><small>Gain after deposits & withdrawals</small><strong>{all?.gain==null?'—':money(all.gain,series.currency)}</strong><span>Net recorded flows {money(all?.flows??0,series.currency)}</span></div></div>:<p>No values for this market yet.</p>}
    {rows.length?<><ReturnChart rows={rows} benchmark={benchmark}/><button className="link-button" onClick={()=>setTable(!table)}>{table?'Hide data table':'Show data table'}</button>{table&&<table aria-label="Cumulative return data"><thead><tr><th>Day</th><th>Value</th><th>Recorded flow</th><th>Portfolio</th><th>{benchmark}</th></tr></thead><tbody>{rows.map((r,i)=><tr key={r.day}><td>{r.day}</td><td>{money(points[i].value,series.currency)}</td><td>{points[i].flow?money(points[i].flow,series.currency):'—'}</td><td>{pct(r.portfolio)}</td><td>{pct(r.benchmark)}</td></tr>)}</tbody></table>}</>:points.length?<p className="muted">The chart appears after values are recorded on at least two days.</p>:null}
    {summary?.periods.length>0&&<table aria-label="Period returns"><thead><tr><th>Period</th><th>From</th><th>Your return</th><th>Gain</th><th>{benchmark}</th><th>Difference</th></tr></thead><tbody>{summary.periods.map(p=><tr key={p.label}><td>{p.label}{p.partial?' *':''}</td><td>{p.start}</td><td className={(p.twr??0)>0?'positive':(p.twr??0)<0?'negative':''}>{pct(p.twr)}</td><td>{p.gain==null?'—':money(p.gain,series.currency)}</td><td>{pct(p.benchmark)}</td><td>{p.twr==null||p.benchmark==null?'—':`${((p.twr-p.benchmark)*100).toFixed(2)} pts`}</td></tr>)}</tbody></table>}
    <p className="muted small-print">* Shorter than the period: history starts {summary?.start??'today'}. Returns are time-weighted from daily values this app records while it runs, so deposits and withdrawals you record below are not counted as gains. Korean cash is valued at settled (D+2) cash. The all-markets series includes exchange-rate effects. Benchmark: {benchmark}{state.benchmarkUpdatedAt?`, updated ${new Date(state.benchmarkUpdatedAt).toLocaleString()}`:''}{state.benchmarkError?' · last refresh failed':''}. <button className="link-button" disabled={busy||state.refreshing} onClick={()=>void act(()=>window.portfolio!.refreshBenchmarks())}>Refresh benchmarks</button></p>
    <details className="inline-help" open={state.flows.length>0}><summary>Deposits & withdrawals · {state.flows.length}</summary>
      <p className="muted">KIS does not report transfers to this app. Record money you add or take out so it is not mistaken for investment gains or losses.</p>
      <div className="settings-grid"><label>Date<input aria-label="Flow date" type="date" max={today()} value={flow.day} onChange={e=>setFlow({...flow,day:e.target.value})}/></label><label>Account<select aria-label="Flow account" value={flow.market} onChange={e=>setFlow({...flow,market:e.target.value})}><option value="KR">Korea (KRW)</option><option value="US">U.S. (USD)</option></select></label><label>Type<select aria-label="Flow type" value={flow.direction} onChange={e=>setFlow({...flow,direction:e.target.value})}><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label><label>Amount<input aria-label="Flow amount" type="number" min="0" step="any" value={flow.amount} onChange={e=>setFlow({...flow,amount:e.target.value})}/></label><label>Note<input aria-label="Flow note" maxLength={200} value={flow.note} onChange={e=>setFlow({...flow,note:e.target.value})}/></label></div>
      <div className="actions"><button className="primary" disabled={busy||!(Number(flow.amount)>0)} onClick={()=>void act(()=>window.portfolio!.addCashFlow({day:flow.day,market:flow.market,amount:Number(flow.amount)*(flow.direction==='withdrawal'?-1:1),note:flow.note}),()=>setFlow({...flow,amount:'',note:''}))}>Record {flow.direction}</button></div>
      {state.flows.length>0&&<table aria-label="Recorded flows"><thead><tr><th>Date</th><th>Account</th><th>Amount</th><th>Note</th><th/></tr></thead><tbody>{state.flows.map(f=><tr key={f.id}><td>{f.day}</td><td>{f.market==='US'?'U.S.':'Korea'}</td><td className={f.amount>0?'positive':'negative'}>{money(f.amount,f.currency)}</td><td>{f.note||'—'}</td><td><button disabled={busy} aria-label={`Remove flow ${f.day} ${f.amount}`} onClick={()=>void act(()=>window.portfolio!.removeCashFlow(f.id))}>Remove</button></td></tr>)}</tbody></table>}
    </details>
    {notice&&<div role="status" className="notice error">{notice}</div>}
  </section>;
}
