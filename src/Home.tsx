import {useEffect,useState} from 'react';
import type {PortfolioState,PortfolioRow} from './UnifiedPortfolio';
import type {RuntimeState} from './RuntimeSettings';
import {PortfolioProfit} from './PortfolioProfit';
import {AllocationChart} from './AllocationChart';
import {TickDelta,LiveValue} from './LiveValue';
import {useDraftState} from './useDraftState';
import {Spark} from './ResearchPanel';
const krw=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(n);
const native=(n:number,currency:string)=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2}).format(n);
const compact=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',notation:'compact',maximumFractionDigits:1}).format(n);
const pct=(n:number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1,minimumFractionDigits:1,signDisplay:'exceptZero'}).format(n)+'%';
export function usePortfolio(active=true){
  const [state,setState]=useState<PortfolioState|null>(null);
  useEffect(()=>{if(!active)return;let alive=true,pending=false;const load=async()=>{if(pending)return;pending=true;try{const value=await window.portfolio?.getPortfolio();if(alive&&value)setState(value);}catch{}finally{pending=false;}};void load();const timer=setInterval(load,1000);return()=>{alive=false;clearInterval(timer);};},[active]);
  return [state,setState] as const;
}
// The three numbers that matter most: total value, cash and unrealized gain.
export function HomeMetrics({state}:{state:PortfolioState}){
  // Korea alone counts until the U.S. account and an exchange rate are both loaded.
  const fx=state.fx?.usdKRW??null;const krLoaded=state.timestamps.KR!=null;const withUS=state.timestamps.US!=null&&fx!=null;
  const cash=(state.cash.KRW??0)+(withUS?(state.cash.USD??0)*fx!:0);
  const equity=krLoaded?state.rows.filter(r=>r.market==='KR'||withUS).reduce((sum,row)=>sum+(row.valueKRW??0),0)+cash:null;
  const sample=state.valuationSample??Math.max(Date.parse(state.timestamps.KR??'')||0,Date.parse(state.timestamps.US??'')||0);
  const us=state.rows.filter(r=>r.market==='US');
  return <div className="home-metrics">
    <section className="metric-card" aria-label="Combined equity"><small>Total equity</small><strong>{equity==null?'—':<LiveValue value={equity} format={krw}/>}</strong>
      <div className="metric-foot">{equity!=null&&<TickDelta value={equity} sample={sample}/>}<span title="Korea and U.S. account totals in their own currencies">{withUS?`${state.totals.KRW!=null?compact(state.totals.KRW):'—'} · ${state.totals.USD!=null?native(state.totals.USD,'USD'):'—'}`:'Korea only'}</span></div></section>
    <section className="metric-card" aria-label="Cash"><small>Cash</small><strong>{state.cash.KRW==null&&state.cash.USD==null?'—':compact(cash)}</strong>
      <div className="metric-foot"><span>{equity?`${(cash/equity*100).toFixed(0)}% of equity`:'—'}</span>{withUS&&state.cash.USD?<span>incl. {native(state.cash.USD,'USD')}</span>:null}</div></section>
    <section className="metric-card" aria-label="Unrealized"><small>Unrealized</small><PortfolioProfit rows={state.rows} loaded={equity!=null}/>
      {us.length>0&&<div className="metric-foot" aria-label="U.S. unrealized"><span>U.S.</span><PortfolioProfit rows={us} currency="USD" loaded={state.totals.USD!=null}/></div>}</section>
  </div>;
}
// Account trend from the daily history: the last month of values, today's P/L and how far below the peak the account is.
export function HomeTrend({onOpen}:{onOpen():void}){
  const [summary,setSummary]=useState<any>(null);
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getPerformance();const s=reply?.state?.summaries;if(alive&&s)setSummary(s.COMBINED?.points?.length?s.COMBINED:s.KRW);}catch{}};void load();const t=setInterval(load,60000);return()=>{alive=false;clearInterval(t);};},[]);
  const points=(summary?.points??[]) as {day:string;value:number;pnl?:number|null;dailyReturn:number|null}[];if(points.length<2)return null;
  const m=summary.analytics?.['1M']??summary.analytics?.All;const last=points.at(-1)!;const recent=points.slice(-31);
  return <section className="metric-card home-trend" aria-label="Account trend"><div className="home-trend-head"><small>Account value · last {recent.length} recorded days</small><button className="link-button" onClick={onOpen}>Performance →</button></div>
    <Spark closes={recent.map(p=>({date:p.day,close:p.value}))}/>
    <div className="metric-foot"><span>Latest day {last.pnl==null?'—':`${last.pnl>=0?'+':''}${krw(last.pnl)}`}{last.dailyReturn!=null?` (${pct(last.dailyReturn*100)})`:''}</span>{m&&<span>1 month {m.twrPct==null?'—':pct(m.twrPct)} · {m.currentDrawdownPct?`${m.currentDrawdownPct.toFixed(1)}% below peak`:'at its peak'}</span>}</div>
  </section>;
}
// Largest positions first, one line each; the full table lives on Holdings.
export function HomeHoldings({state,onCompany,onAll,onRefresh,busy}:{state:PortfolioState;onCompany(symbol:string):void;onAll():void;onRefresh():void;busy:boolean}){
  const fx=state.fx?.usdKRW??null;const cash=(state.cash.KRW??0)+(state.cash.USD??0)*(fx??0);
  const equity=state.rows.reduce((sum,row)=>sum+(row.valueKRW??0),0)+cash;
  const rows=[...state.rows].sort((a,b)=>(b.valueKRW??0)-(a.valueKRW??0));const top=rows.slice(0,6);
  const [group,setGroup]=useDraftState('portfolio:group','Company');
  const labelOf=(r:PortfolioRow)=>group==='Sector'?r.sector:group==='Region'?r.region:group==='Market'?(r.market==='KR'?'Korea':'U.S.'):group==='Currency'?r.currency:r.name;
  const grouped=new Map<string,{label:string;value:number;percent:number;color:string;members:{name:string;symbol:string;value:number}[]}>();
  for(const r of rows){const label=labelOf(r);const old=grouped.get(label);grouped.set(label,{label,value:(old?.value??0)+(r.valueKRW??0),percent:0,color:old?.color??r.color,members:[...(old?.members??[]),{name:r.name,symbol:r.symbol,value:r.valueKRW??0}]});}
  const buckets=equity>0?[...grouped.values(),{label:'Cash',value:cash,percent:0,color:'#7e858c',members:[]}]:[];
  const change=(row:PortfolioRow)=>row.cost>0?(row.price/row.cost-1)*100:null;
  return <div className="home-bottom">
    <section className="home-holdings" aria-label="Top holdings"><div className="section-head"><h2>Holdings</h2><div className="actions"><button className="link-button" disabled={busy} onClick={onRefresh}>{busy?'Refreshing…':'Refresh'}</button><button className="link-button" onClick={onAll}>All {state.rows.length} →</button></div></div>
      {top.length?<ul className="compact-rows">{top.map(row=>{const c=change(row);return <li key={row.symbol}><button className="company-link" onClick={()=>onCompany(row.symbol)}>{row.name}</button><span className="num">{native(row.price,row.currency)}</span><span className={`num ${c==null||Math.abs(c)<.005?'muted':c>0?'positive':'negative'}`} title="Gain or loss against your average cost">{c==null||Math.abs(c)<.005?'—':pct(c)}</span><span className="num muted" title="Share of total equity">{equity>0&&row.valueKRW!=null?`${(row.valueKRW/equity*100).toFixed(0)}%`:'—'}</span></li>;})}</ul>:<p className="muted">No positions yet.</p>}
    </section>
    <section className="home-allocation" aria-label="Allocation"><div className="section-head"><h2>Allocation</h2><select aria-label="Allocation grouping" value={group} onChange={e=>setGroup(e.target.value)}>{['Company','Sector','Region','Market','Currency'].map(label=><option key={label}>{label}</option>)}</select></div>{buckets.length?<AllocationChart buckets={buckets} equity={equity}/>:<p className="muted">Waiting for balances.</p>}</section>
  </div>;
}
// Shown on every page while an emergency review mode is active.
export function EmergencyBanner(){
  const [state,setState]=useState<RuntimeState|null>(null);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
  useEffect(()=>{let alive=true;const load=()=>window.portfolio?.getRuntime().then(v=>{if(alive)setState(v);}).catch(()=>{});void load();const t=setInterval(load,2000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!state?.emergency?.active)return null;const e=state.emergency;const symbol=e.currency==='USD'?'$':'₩';
  return <div className="emergency-notice" role="status"><b>{e.scope==='paper'?'Paper':'KIS'} emergency · loss-reduction reviews</b><span>Daily loss {symbol}{e.loss?.loss.toLocaleString()} ({e.loss?.lossPct.toFixed(2)}%)</span>{note&&<small>{note}</small>}
    <button disabled={busy||state.busy} onClick={async()=>{setBusy(true);setNote('');try{const reply=await window.portfolio?.reviewRuntime();if(reply?.state)setState(reply.state);setNote(reply?.ok?'Review done. See Journal.':'Review failed.');}catch{setNote('Review failed.');}finally{setBusy(false);}}}>{busy?'Reviewing…':'Run emergency review'}</button></div>;
}
