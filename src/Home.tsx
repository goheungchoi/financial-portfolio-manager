import {useEffect,useState} from 'react';
import type {PortfolioState,PortfolioRow} from './UnifiedPortfolio';
import type {RuntimeState} from './RuntimeSettings';
import {PortfolioProfit} from './PortfolioProfit';
import {AllocationChart} from './AllocationChart';
import {TickDelta,LiveValue} from './LiveValue';
import {useDraftState} from './useDraftState';
import {ValueChart,shortDay} from './PerfCharts';
const krw=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',maximumFractionDigits:0}).format(n);
const native=(n:number,currency:string)=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2}).format(n);
const compact=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'KRW',notation:'compact',maximumFractionDigits:1}).format(n);
// Small moves get two decimals so they do not round to 0.0%.
const pct=(n:number)=>{const d=Math.abs(n)<1?2:1;return new Intl.NumberFormat('en-US',{maximumFractionDigits:d,minimumFractionDigits:d,signDisplay:'exceptZero'}).format(n)+'%';};
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
// Account value over a chosen period: the change in money and percent, the benchmark over the same days, and a chart with hover.
const TREND_PERIODS=['1W','1M','3M','YTD','1Y','All'];
export function HomeTrend({onOpen}:{onOpen():void}){
  const [summary,setSummary]=useState<any>(null);const [period,setPeriod]=useDraftState('home:trendPeriod','1M');
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getPerformance();const s=reply?.state?.summaries;if(alive&&s)setSummary(s.COMBINED?.points?.length?s.COMBINED:s.KRW);}catch{}};void load();const t=setInterval(load,60000);return()=>{alive=false;clearInterval(t);};},[]);
  const points=(summary?.points??[]) as {day:string;value:number;high?:number;low?:number;pnl?:number|null;dailyReturn:number|null}[];
  if(points.length<2)return <section className="metric-card home-trend" aria-label="Account trend"><div className="home-trend-head"><small>Account value</small><button className="link-button" onClick={onOpen}>Performance →</button></div><p className="muted">The chart starts after values are recorded on two days.</p></section>;
  // Only periods the recorded history covers; "All" always.
  const periods=(summary.periods??[]).filter((p:any)=>TREND_PERIODS.includes(p.label)&&(!p.partial||p.label==='All')).filter((p:any,_:number,list:any[])=>p.label==='All'||!list.some(q=>q.label==='All'&&q.start===p.start));
  const active=periods.some((p:any)=>p.label===period)?period:'All';const sel=periods.find((p:any)=>p.label===active);const a=summary.analytics?.[active];
  const rows=points.filter(p=>p.day>=(sel?.start??points[0].day));const last=points.at(-1)!;const bench=summary.benchmark==='SPX'?'S&P 500':'KOSPI';
  const change=sel?.gain??null,ret=sel?.twr==null?null:sel.twr*100,vs=sel?.benchmark==null?null:sel.benchmark*100;
  const tone=(v:number|null)=>v==null||Math.abs(v)<1e-9?'':v>0?'positive':'negative';const sign=(v:number)=>(v>0?'+':v<0?'−':'')+krw(Math.abs(v)).replace('-','');
  return <section className="metric-card home-trend" aria-label="Account trend">
    <div className="home-trend-head"><small>Account value</small><div className="home-trend-tools"><div className="segmented compact" role="tablist" aria-label="Account trend period">{periods.map((p:any)=><button key={p.label} role="tab" aria-selected={active===p.label} aria-pressed={active===p.label} onClick={()=>setPeriod(p.label)}>{p.label}</button>)}</div><button className="link-button" onClick={onOpen}>Performance →</button></div></div>
    <div className="home-trend-figures"><strong>{krw(last.value)}</strong>{change!=null&&<span className={tone(change)}>{sign(change)}{ret!=null?` (${pct(ret)})`:''}</span>}<small className="muted">{active==='All'?`since ${shortDay(rows[0].day,true)}`:`over ${active}`}{vs!=null?` · ${bench} ${pct(vs)}`:''}</small></div>
    {rows.length>=2?<ValueChart rows={rows.map(p=>({day:p.day,value:p.value,high:p.high??p.value,low:p.low??p.value}))} fmt={krw} height={170} marks={false}/>:<p className="muted">One recorded day in this period.</p>}
    <div className="home-trend-stats">
      <span><small>Latest day</small><b className={tone(last.pnl??null)}>{last.pnl==null?'—':sign(last.pnl)}</b>{last.dailyReturn!=null&&<em>{pct(last.dailyReturn*100)}</em>}</span>
      {a&&<span><small>Period high</small><b>{krw(a.peak.value)}</b><em>{shortDay(a.peak.day)}</em></span>}
      {a&&<span><small>From return peak</small><b className={a.currentDrawdownPct<-0.05?'negative':''}>{a.currentDrawdownPct<-0.05?`${a.currentDrawdownPct.toFixed(1)}%`:'At peak'}</b>{a.maxDrawdownPct<-0.05&&<em>worst {a.maxDrawdownPct.toFixed(1)}%</em>}</span>}
      {a?.bestDay&&<span><small>Best / worst day</small><b><span className="positive">{pct(a.bestDay.returnPct)}</span> / <span className="negative">{pct(a.worstDay.returnPct)}</span></b></span>}
    </div>
  </section>;
}
// Known events in the next three weeks for your stocks and the market.
const KIND_LABEL:Record<string,string>={earnings:'Earnings',dividend:'Dividend',meeting:'Meeting',macro:'Macro',expiry:'Expiry'};
type CalendarEvent={date:string;kind:string;title:string;symbol?:string;name?:string;market?:string;estimated?:boolean;time?:string};
type CalendarItem=CalendarEvent&{label:string;tickers:string[];sub:string|null};
const dayName=(day:string,offset=0,opts:Intl.DateTimeFormatOptions={weekday:'short'})=>new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toLocaleDateString('en-US',{timeZone:'UTC',...opts});
const seoulToday=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
// Short company names: no parenthetical aliases, and share classes (A/C) folded into one company.
const baseName=(name:string)=>name.replace(/\s*\(.*?\)\s*/g,' ').replace(/\s+(Class\s+)?[A-C]$/i,'').trim();
const ticker=(symbol?:string)=>symbol?.includes(':')?symbol.split(':')[1]:null;
function calendarItems(events:CalendarEvent[]):CalendarItem[]{
  const out:CalendarItem[]=[];
  for(const e of events){
    const company=['earnings','dividend','meeting'].includes(e.kind)&&e.name;const label=company?baseName(e.name!):e.title;const t=ticker(e.symbol);
    const same=company?out.find(o=>o.date===e.date&&o.kind===e.kind&&o.label===label):null;if(same){if(t)same.tickers.push(t);continue;}
    const sub=e.kind==='earnings'?(e.time==='after-close'?`After the U.S. close · ${dayName(e.date,1)} morning KST`:e.time==='before-open'?`Before the U.S. open · ${dayName(e.date)} evening KST`:e.estimated?'Estimated date, not announced':null)
      :e.kind==='dividend'?'Record date':e.kind==='macro'||e.kind==='expiry'?(e.market==='KR'?'Korea':e.market==='US'?'U.S.':null):null;
    out.push({...e,label,tickers:t?[t]:[],sub});
  }
  return out;
}
export function HomeCalendar(){
  const [events,setEvents]=useState<CalendarEvent[]>([]);
  useEffect(()=>{let alive=true;const load=async()=>{try{const s:any=await window.portfolio?.getRuntime();if(alive)setEvents(s?.calendar??[]);}catch{}};void load();const t=setInterval(load,60000);return()=>{alive=false;clearInterval(t);};},[]);
  if(!events.length)return null;
  const items=calendarItems(events).slice(0,10);const days=[...new Set(items.map(i=>i.date))];const today=seoulToday(),tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  return <section className="metric-card home-calendar" aria-label="Coming up"><div className="home-trend-head"><small>Coming up · next 3 weeks</small></div>
    <div className="cal-list">{days.map(day=><div key={day} className="cal-day">
      <div className="cal-date"><b>{dayName(day,0,{weekday:'short',month:'short',day:'numeric'})}</b>{day===today?<em>Today</em>:day===tomorrow?<em>Tomorrow</em>:null}</div>
      <ul>{items.filter(i=>i.date===day).map(i=><li key={i.kind+i.label} className="cal-item">
        <span className={`cal-kind kind-${i.kind}`}>{KIND_LABEL[i.kind]??i.kind}</span>
        <span className="cal-text"><span className="cal-title"><b>{i.label}</b>{i.tickers.length>0&&<small className="cal-ticker">{i.tickers.join(' · ')}</small>}</span>{i.sub&&<small className="cal-sub">{i.sub}</small>}</span>
      </li>)}</ul>
    </div>)}</div>
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
