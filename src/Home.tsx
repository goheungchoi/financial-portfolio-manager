import {priceBasis} from './live-change.mjs';
import {useEffect,useState} from 'react';
import {subscribeRuntime} from './runtimeFeed';
import type {PortfolioState,PortfolioRow} from './UnifiedPortfolio';
import {pendingKRW} from './pending';
import type {RuntimeState} from './RuntimeSettings';
import {AllocationChart} from './AllocationChart';
import {TickDelta,LiveValue} from './LiveValue';
import {useDraftState} from './useDraftState';
import {ValueChart,shortDay} from './PerfCharts';
import {homeResult,resultSummary,periodNote} from './home-result.mjs';
import {SectionBoundary} from './SectionBoundary';
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
  // Equity is the account valuation's (electron/valuation.cjs), never recomputed here: its low bound, called an estimate
  // whenever the bounds differ. Korea alone shows until the U.S. account and an exchange rate are both loaded, said so.
  const fx=state.fx?.usdKRW??null;const krLoaded=state.timestamps.KR!=null;const withUS=state.timestamps.US!=null&&fx!=null;
  const cash=(state.cash.KRW??0)+(withUS?(state.cash.USD??0)*fx!:0);
  const v=state.valuation?.combined;const both=v?v.scope.length===2:withUS;
  const equity=v&&v.low!=null?(both?v.low:state.totals.KRW):krLoaded?state.rows.filter(r=>r.market==='KR'||withUS).reduce((sum,row)=>sum+(row.valueKRW??0),0)+cash+(withUS?pendingKRW(state):0):null;
  // 1.5.48 UI: one value, called an estimate when it is a range, with one plain reason; the bounds and the technical
  // reasons are behind Details.
  // Release gate H3 (1.5.50): a range under 0.05% of the value is immaterial: one figure, the reason and the bounds under
  // Details. A material range shows both ends on the tile.
  const estimate=Boolean(v&&both&&!v.exact);const spread=estimate&&v&&v.high!=null&&v.low!=null&&v.low>0?(v.high-v.low)/v.low:null;const immaterial=spread!=null&&spread<0.0005;const ranged=estimate&&!immaterial;
  const title=!both?'Korea only':ranged?'Estimated account value':'Account value';
  // The plain reason names the market its reasons are about, and says "range" only when the bounds differ (release
  // gate G5: a Korean reason was shown as "Some U.S. trades are still being checked", with a range of zero).
  const plain=(reasons:string[])=>{const end=v&&v.high!=null&&v.low!=null&&v.high>v.low?'so the value is a range.':'so the value is an estimate.';const us=reasons.filter(r=>!/^Korea:/.test(r));
    return us.some(r=>/flight|unresolved|settl|review|verification/i.test(r))?`Some U.S. trades are still being checked, ${end}`:us.some(r=>/funding|KRW/i.test(r))?`How some U.S. buys were paid is not known yet, ${end}`:reasons.some(r=>/^Korea:/.test(r))&&!us.length?`Some Korean balance figures were not reported, ${end}`:`Some figures are estimates, ${end}`;};
  const sample=state.valuationSample??Math.max(Date.parse(state.timestamps.KR??'')||0,Date.parse(state.timestamps.US??'')||0);
  // Where the totals come from: a change here (a market loading, a holding moving from its balance price to a live quote)
  // settles the value without showing it as a move.
  const basis=priceBasis(state.rows.filter(r=>r.market==='KR'||withUS),{krLoaded,withUS});
  return <div className="home-metrics">
    <section className="metric-card" aria-label="Combined equity"><small className={!both?'negative':undefined}>{title}</small><strong>{equity==null?'—':<LiveValue value={equity} format={krw} basis={basis}/>}</strong>
      <div className="metric-foot">{equity!=null&&<TickDelta value={equity} sample={sample} basis={basis}/>}<span title="Korea and U.S. account totals in their own currencies">{both?`${state.totals.KRW!=null?compact(state.totals.KRW):'—'} · ${state.totals.USD!=null?native(state.totals.USD,'USD'):'—'}`:'U.S. not loaded'}</span></div>
      {ranged&&v&&v.high!=null&&<div className="metric-foot" aria-label="Value range"><span>{krw(v.low!)} – {krw(v.high)}</span></div>}
      {ranged&&v&&v.high!=null&&<div className="metric-foot"><span>{plain(v.reasons)}</span></div>}
      {estimate&&v&&v.high!=null&&<details className="inline-help metric-details"><summary>Details</summary>{immaterial&&<p className="muted">{plain(v.reasons)}</p>}{v.high>v.low!&&<p className="muted">Range {krw(v.low!)} – {krw(v.high)}; the value shown is the low end.</p>}<ul className="muted">{v.reasons.map(r=><li key={r}>{r}</li>)}</ul></details>}
      {!both&&state.lastComplete&&<div className="metric-foot"><span>Last full value {krw(state.lastComplete.value)} at {new Date(state.lastComplete.at).toLocaleString('en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div>}
      {v?.stale&&<div className="metric-foot"><span className="negative">A balance is out of date</span></div>}</section>
    <section className="metric-card" aria-label="Cash"><small>Cash</small><strong>{state.cash.KRW==null&&state.cash.USD==null?'—':krw(cash)}</strong>
      {/* A share of a conservative, uncertain estimate can exceed 100% and mislead: the amount only, said why. */}
      <div className="metric-foot"><span>{!equity?'—':ranged?'Share of account value: not shown while the value is a range':cash>equity?'Share of account value: not shown (cash is more than the account value)':`${(cash/equity*100).toFixed(0)}% of account value`}</span>{state.committedKRW?<span title="KRW committed to U.S. buys through integrated margin; KIS deducts it at settlement">{krw(state.committedKRW)} for U.S. buys settling{state.settlementUncertainKRW?` (funding of ${krw(state.settlementUncertainKRW)} not yet known)`:''}</span>:null}{withUS&&state.cash.USD?<span>incl. {native(state.cash.USD,'USD')}</span>:null}{withUS&&state.pendingSettlement?.USD?<span title="Money from U.S. sales that has not settled yet: counted in total equity, spendable once it settles">{native(state.pendingSettlement.USD,'USD')} pending settlement</span>:null}</div></section>
    <SectionBoundary label="Result" className="metric-card home-result"><HomeResult state={state} usLoaded={withUS} equityKnown={equity!=null}/></SectionBoundary>
  </div>;
}
// The total investment result since the first daily record (artifacts/reviews/2026-11-11-home-result): the account value
// box's "All" figures, the latest day, unrealized gain and the benchmark, from src/home-result.mjs. Unknown stays "—" with
// its reason. The performance summary is read every minute, as the account value box reads it.
function HomeResult({state,usLoaded,equityKnown}:{state:PortfolioState;usLoaded:boolean;equityKnown:boolean}){
  const [summary,setSummary]=useState<any>(null);const [failure,setFailure]=useState<string|null>(null);
  // A read that fails, or a reply marked not ok without a summary, is said as such (release gate 1.5.52, G3).
  useEffect(()=>{let alive=true;const failed='The performance records could not be read.';const load=async()=>{let reply:any=null;try{reply=await window.portfolio?.getPerformance();}catch{if(alive)setFailure(failed);return;}const s=resultSummary(reply?.state?.summaries);if(!alive)return;if(s){setSummary(s);setFailure(null);}else if(!reply||reply.ok===false)setFailure(failed);};void load();const t=setInterval(load,60000);return()=>{alive=false;clearInterval(t);};},[]);
  const r=homeResult({summary,rows:state.rows,usLoaded,equityKnown,usdLoaded:state.totals.USD!=null,failure});
  const tone=(v:number|null)=>v==null||Math.abs(v)<1e-9?'':v>0?'positive':'negative';const sign=(v:number)=>(v>0?'+':v<0?'−':'')+krw(Math.abs(v)).replace('-','');
  const t=r.total,d=r.today,u=r.unrealized;
  // The Today line stays brief (review of the blank-window fix): a range or a correction is a small tag; the figures are in More.
  const todayProvisional=Boolean(d?.provisional);
  const totalPct=t?.twr!=null?pct(t.twr*100):t?.twrRange?`${pct(t.twrRange.low*100)} to ${pct(t.twrRange.high*100)}`:null;
  return <section className="metric-card home-result" aria-label="Result"><small>Result</small>
    <strong className="result-total"><span className={tone(t?.gain??null)} title="Investment P/L and time-weighted return: deposits, withdrawals and accounting corrections are not counted" data-amount={t?.gain??''}>{t?.gain==null?'—':sign(t.gain)}</span>{totalPct&&<span className={`result-pct ${tone(t?.twr??null)}`}>{totalPct}</span>}{t?.tag&&<em className="result-tag" title={t.tag.why}>{t.tag.text}</em>}</strong>
    <div className="metric-foot">{r.since&&<span>since {shortDay(r.since,true)}, after deposits</span>}</div>
    {t?.reason&&<div className="metric-foot"><span className={t.twr==null&&!t.twrRange?'negative':undefined} title={t.reason}>{t.reason}</span></div>}
    <dl className="result-lines">
      <div aria-label="Today"><dt>Today</dt><dd className={tone(d?.pnl??null)} title={d?.reason??undefined}>{d?.pnl==null?(d?.unavailable?'Unavailable':'—'):sign(d.pnl)}{d?.dailyReturn!=null&&!d.returnRange&&<em>{pct(d.dailyReturn*100)}</em>}{todayProvisional&&<em className="result-tag" title="A range or a settlement correction applies to this day; see More.">Provisional</em>}</dd></div>
      <div aria-label="Unrealized"><dt>Unrealized</dt><dd className={tone(u.amount)} data-amount={u.amount??''} title={u.reason??'Unrealized price gain/loss against holding acquisition cost, before selling fees and taxes. Percentage uses invested cost, excluding cash. Combined KRW uses current indicative FX; historical currency gains are not included.'}>{u.amount==null?'—':sign(u.amount)}{u.percent!=null&&<em>{pct(u.percent)}</em>}{r.scope==='korea'&&<em className="negative">Korea only</em>}</dd></div>
      {r.benchmark&&<div aria-label="Benchmark"><dt>{r.benchmarkName}</dt><dd>{pct(r.benchmark.benchmark*100)}<em>· you {pct(r.benchmark.you*100)}</em></dd></div>}
    </dl>
    {/* More (step 3): what each line counts, the U.S. amount in dollars, and the reason behind any tag. */}
    <details className="inline-help metric-details result-more"><summary>More</summary><ul className="muted">
      {t?.tag&&<li>{t.tag.text}: {t.tag.why}</li>}
      <li>Total: account value now minus money paid in{r.since?` since ${shortDay(r.since,true)}`:''}, as on the account value chart's "All".</li>
      <li>Unrealized: holdings against their average cost, before selling fees and taxes{r.scope==='korea'?'; Korea only until the U.S. account and an exchange rate load':''}.</li>
      {d?.pnlRange&&<li aria-label="Today range">Today is provisional: between {sign(d.pnlRange.low)} and {sign(d.pnlRange.high)}; the valuation range changed this day, so part of the change may be funding settling.</li>}
      {d?.returnRange&&<li aria-label="Today range">Today's return is a range: {pct(d.returnRange.low*100)} to {pct(d.returnRange.high*100)}.</li>}
      {d?.correction?<li aria-label="Today correction">Today includes a settlement correction of {sign(d.correction)}: bookkeeping, not investment P/L.</li>:null}
      {r.unrealizedUSD&&<li aria-label="U.S. unrealized" data-amount={r.unrealizedUSD.amount}>U.S. unrealized: <span className="nowrap">{(r.unrealizedUSD.amount>0?'+':r.unrealizedUSD.amount<0?'−':'')+native(Math.abs(r.unrealizedUSD.amount),'USD')}</span>{r.unrealizedUSD.percent!=null?` (${pct(r.unrealizedUSD.percent)})`:''}, in dollars.</li>}
      <li>Total and Unrealized come from different records and need not add up.</li>
    </ul></details>
  </section>;
}
// Account value over a chosen period: the change in money and percent, the benchmark over the same days, and a chart with hover.
const TREND_PERIODS=['1W','1M','3M','YTD','1Y','All'];
export function HomeTrend({onOpen}:{onOpen():void}){
  const [summary,setSummary]=useState<any>(null);const [period,setPeriod]=useDraftState('home:trendPeriod','1M');const [unreadable,setUnreadable]=useState(false);
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getPerformance();if(!alive)return;setUnreadable(Boolean(reply?.state?.unreadable));const s=reply?.state?.summaries;if(s)setSummary(s.COMBINED?.points?.length?s.COMBINED:s.KRW);}catch{if(alive)setUnreadable(true);}};void load();const t=setInterval(load,60000);return()=>{alive=false;clearInterval(t);};},[]);
  // Stage 3.4: a day or period without a return says so (never a zero or a raw value change); settlement-affected figures
  // are tagged "Not verified", and accounting corrections are not investment P/L.
  const points=(summary?.points??[]) as {day:string;value:number;high?:number;low?:number;flow?:number;pnl?:number|null;pnlRange?:{low:number;high:number};dailyReturn:number|null;unavailable?:string[];correction?:number;bounded?:{returnRange:{low:number;high:number}}}[];
  if(points.length<2)return <section className="metric-card home-trend" aria-label="Account trend"><div className="home-trend-head"><small>Account value</small><button className="link-button" onClick={onOpen}>Performance →</button></div>{unreadable?<p className="negative" role="status">The performance records could not be read.</p>:<p className="muted">The chart starts after values are recorded on two days.</p>}</section>;
  // Only periods the recorded history covers; "All" always.
  const periods=(summary.periods??[]).filter((p:any)=>TREND_PERIODS.includes(p.label)&&(!p.partial||p.label==='All')).filter((p:any,_:number,list:any[])=>p.label==='All'||!list.some(q=>q.label==='All'&&q.start===p.start));
  const active=periods.some((p:any)=>p.label===period)?period:'All';const sel=periods.find((p:any)=>p.label===active);const a=summary.analytics?.[active];
  const rows=points.filter(p=>p.day>=(sel?.start??points[0].day));const last=points.at(-1)!;const bench=summary.benchmark==='SPX'?'S&P 500':'KOSPI';
  const change=sel?.gain??null,ret=sel?.twr==null?null:sel.twr*100,vs=sel?.benchmark==null?null:sel.benchmark*100,missing=Boolean(sel?.unavailable?.length),range=sel?.twrRange as {low:number;high:number}|undefined,affected=sel?.settlementAffected;
  // One sentence, in order of what matters (1.5.48 UI): no return at all; a return that is an estimate; a figure that
  // leaves out money changes awaiting you. The reasons are in the tooltip and on the Performance page.
  // The actual reason, not a presumed one (1.5.48 review): a failed corrections read, a missing exchange rate and an
  // unsettled trade each say so. Each entry is "day: reason; reason"; the first reason is shown, the rest are in the tooltip.
  // The note text is shared with the Result tile (src/home-result.mjs periodNote), so the two cannot drift.
  const trendNote=periodNote(sel,summary);
  const tone=(v:number|null)=>v==null||Math.abs(v)<1e-9?'':v>0?'positive':'negative';const sign=(v:number)=>(v>0?'+':v<0?'−':'')+krw(Math.abs(v)).replace('-','');
  return <section className="metric-card home-trend" aria-label="Account trend">
    <div className="home-trend-head"><small>Account value</small><div className="home-trend-tools"><div className="segmented compact" role="tablist" aria-label="Account trend period">{periods.map((p:any)=><button key={p.label} role="tab" aria-selected={active===p.label} aria-pressed={active===p.label} onClick={()=>setPeriod(p.label)}>{p.label}</button>)}</div><button className="link-button" onClick={onOpen}>Performance →</button></div></div>
    <div className="home-trend-figures"><strong>{krw(last.value)}</strong>{change!=null&&Number.isFinite(change)&&<span className={tone(change)} title="Investment P/L and time-weighted return: deposits, withdrawals and accounting corrections are not counted">Investment P/L {sign(change)}{ret!=null?` (${pct(ret)})`:range?` (${pct(range.low*100)} to ${pct(range.high*100)})`:''}</span>}{trendNote&&<span className={missing?'negative trend-note':'muted trend-note'} title={trendNote.why}>{trendNote.text}</span>}<small className="muted">{active==='All'?`since ${shortDay(rows[0].day,true)}`:`over ${active}`}{vs!=null?` · ${bench} ${pct(vs)}`:''}</small></div>
    {rows.length>=2?<ValueChart rows={rows.map(p=>({day:p.day,value:p.value,high:p.high??p.value,low:p.low??p.value,flow:p.flow??0,pnl:p.pnl??null,correction:p.correction,restated:(p as any).restated}))} fmt={krw} height={170} marks={false}/>:<p className="muted">One recorded day in this period.</p>}
    <div className="home-trend-stats">
      <span><small>Latest day</small><b className={tone(last.pnl??null)} title={last.unavailable?.[0]}>{last.pnl==null?(last.unavailable?.length?'Unavailable':'—'):sign(last.pnl)}</b>{last.correction?<em title="Settlement bookkeeping, not investment P/L">Correction {sign(last.correction)}</em>:null}{last.bounded?<em>{pct(last.bounded.returnRange.low*100)} to {pct(last.bounded.returnRange.high*100)}</em>:last.pnlRange?<em title="The valuation range changed this day: the change may be funding settling, not only investment gain or loss.">Provisional: {sign(last.pnlRange.low)} to {sign(last.pnlRange.high)}</em>:last.dailyReturn!=null&&<em>{pct(last.dailyReturn*100)}</em>}</span>
      {a&&<span><small>Period high</small><b>{krw(a.peak.value)}</b><em>{shortDay(a.peak.day)}</em></span>}
      {a&&(a.currentDrawdownPct==null?<span><small>From return peak</small><b title={a.chainBrokenFrom?`A day without a return on ${a.chainBrokenFrom} breaks the time-weighted chain`:undefined}>Unavailable</b></span>:<span><small>From return peak</small><b className={a.currentDrawdownPct<-0.05?'negative':''}>{a.currentDrawdownPct<-0.05?`${a.currentDrawdownPct.toFixed(1)}%`:'At peak'}</b>{a.maxDrawdownPct!=null&&a.maxDrawdownPct<-0.05&&<em>worst {a.maxDrawdownPct.toFixed(1)}%</em>}</span>)}
      {a?.bestDay&&<span><small>Best / worst day</small><b><span className="positive">{pct(a.bestDay.returnPct)}</span> / <span className="negative">{pct(a.worstDay.returnPct)}</span></b><em>of {a.returnDays} day{a.returnDays===1?'':'s'} with a return</em></span>}
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
  const equity=state.rows.reduce((sum,row)=>sum+(row.valueKRW??0),0)+cash+pendingKRW(state);
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
  useEffect(()=>subscribeRuntime(v=>{if(v)setState(v);}),[]);
  if(!state?.emergency?.active)return null;const e=state.emergency;const symbol=e.currency==='USD'?'$':'₩';
  return <div className="emergency-notice" role="status"><b>{e.scope==='paper'?'Paper':'KIS'} emergency · loss-reduction reviews</b><span>Daily loss {symbol}{e.loss?.loss.toLocaleString()} ({e.loss?.lossPct.toFixed(2)}%)</span>{note&&<small>{note}</small>}
    <button disabled={busy||state.busy} onClick={async()=>{setBusy(true);setNote('');try{const reply=await window.portfolio?.reviewRuntime();if(reply?.state)setState(reply.state);setNote(reply?.ok?'Review done. See Journal.':'Review failed.');}catch{setNote('Review failed.');}finally{setBusy(false);}}}>{busy?'Reviewing…':'Run emergency review'}</button></div>;
}
