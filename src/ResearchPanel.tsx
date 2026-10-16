import {useEffect,useRef,useState,type ReactNode} from 'react';
import './research.css';
export type ResearchSection={status:'ok'|'unavailable';retrievedAt?:number;data?:any;reason?:string;stale?:boolean};
export type ResearchProfile={symbol:string;name:string|null;market?:string;sector?:string|null;sectorName?:string|null;asOf:string;sections:Record<string,ResearchSection>};
// The same research the agents read, one tab per section; each tab loads when first opened.
const TABS:[string,string][]=[['overview','Overview'],['analysts','Analysts'],['estimates','Estimates'],['financials','Financials'],['dividends','Dividends'],['events','Events'],['flows','Flows'],['risk','Risk'],['valuation','Valuation'],['peers','Peers']];
const REASONS:Record<string,string>={KIS_NOT_CONNECTED:'Connect your KIS account to load research.',DART_KEY_MISSING:'Add an OpenDART key to your providers file.',KOREAN_LISTINGS_ONLY:'Available for Korean stocks.',INSUFFICIENT_HISTORY:'Not enough price history yet.',NO_PEERS:'No sector peers for this listing.',RATE_LIMITED:'KIS is rate limiting. Try again shortly.',NOT_IN_DART:'This listing has no DART filings.',DART_RATE_LIMITED:'OpenDART is rate limiting. Try again later.'};
const reason=(code?:string)=>REASONS[code??'']??'Not available right now.';
const n=(v:unknown,digits=0)=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString(undefined,{maximumFractionDigits:digits}):'—';
const pct=(v:unknown,digits=1,sign=false)=>typeof v==='number'&&Number.isFinite(v)?`${sign&&v>0?'+':''}${v.toFixed(digits)}%`:'—';
const krw=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?'₩'+new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(v):'—';
const ago=(t?:number)=>{if(!t)return '';const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:new Date(t).toLocaleDateString();};
const Stats=({items}:{items:[string,ReactNode][]})=><div className="company-stats">{items.map(([k,v])=><div key={k}><small>{k}</small><b>{v}</b></div>)}</div>;
const PAYOUT:Record<string,string>={'결산':'Year-end','분기':'Quarterly','중간':'Interim'};
const KIND:Record<string,string>={earnings:'Earnings',ir:'IR',dividend:'Dividend',buyback:'Buyback',capital:'Capital',periodic:'Report',corporate:'Corporate',contract:'Contract',legal:'Legal',ownership:'Ownership',material:'Material',other:'Other',meeting:'Meeting'};

function Overview({d}:{d:any}){
  return <Stats items={[['Price',n(d.price)],['Day change',pct(d.changePct,2,true)],['Market cap',krw(d.marketCapKRW)],['PER',n(d.per,2)],['PBR',n(d.pbr,2)],['EPS',n(d.eps)],['BPS',n(d.bps)],['52-week low',n(d.low52Week)],['52-week high',n(d.high52Week)],['Foreign ownership',pct(d.foreignOwnershipPct)],['Turnover',pct(d.turnoverPct,2)],['Sector',d.sectorName??'—']]}/>;
}
function Analysts({d}:{d:any}){
  const r=d.targetRevisions;
  return <>
    <p className="research-line"><b>{d.brokerages}</b> brokerages in 180 days · {d.buy} Buy · {d.hold} Hold · {d.sell} Sell</p>
    <Stats items={[['Median target',n(d.medianTarget)],['Upside to median',pct(d.upsideToMedianPct,1,true)],['High target',n(d.highTarget)],['Low target',n(d.lowTarget)]]}/>
    {r&&<p className="research-line">Last {r.windowDays} days: <b>{r.raised}</b> raised, <b>{r.cut}</b> cut, {r.unchanged} kept their target</p>}
    <Trend t={d.consensusTrend} keys={[['medianTargetChangePct','Median target']]}/>
    {d.latest?.length>0&&<table className="compact-table research-table" aria-label="Latest analyst notes"><thead><tr><th>Date</th><th>Brokerage</th><th>Rating</th><th>Target</th></tr></thead><tbody>{d.latest.map((r:any)=><tr key={r.firm+r.date}><td>{r.date}</td><td>{r.firm}</td><td>{r.opinion}</td><td>{n(r.target)}</td></tr>)}</tbody></table>}
  </>;
}
const EST:[string,string,(v:number)=>string][]=[['revenue','Revenue',v=>krw(v*1e8)],['operatingProfit','Operating profit',v=>krw(v*1e8)],['netIncome','Net income',v=>krw(v*1e8)],['eps','EPS',v=>n(v)],['per','PER',v=>n(v,1)],['roePct','ROE',v=>pct(v)],['debtRatioPct','Debt ratio',v=>pct(v)]];
function Estimates({d}:{d:any}){
  if(!d?.years?.length)return <p className="muted">No consensus estimates for this stock.</p>;
  return <><table className="compact-table research-table" aria-label="Consensus estimates"><thead><tr><th>Metric</th>{d.years.map((y:string)=><th key={y}>{y}</th>)}</tr></thead><tbody>{EST.filter(([k])=>Array.isArray(d[k])).map(([k,label,f])=><tr key={k}><td>{label}</td>{d[k].map((v:number|null,i:number)=><td key={i}>{v==null?'—':f(v)}</td>)}</tr>)}</tbody></table>
    <Trend t={d.consensusTrend} keys={[['epsChangePct','EPS estimate'],['operatingProfitChangePct','Operating profit estimate']]}/>
    <p className="muted research-note">Years ending in E are forecasts.{d.reportOpinion?` Latest report: ${d.reportOpinion}${d.reportDate?` (${d.reportDate})`:''}.`:''}</p></>;
}
const LINES:[string,string,(v:number)=>string][]=[['revenueKRW','Revenue',krw],['operatingProfitKRW','Operating profit',krw],['netIncomeKRW','Net income',krw],['operatingMarginPct','Operating margin',v=>pct(v)],['netMarginPct','Net margin',v=>pct(v)],['roePct','ROE',v=>pct(v)],['roaPct','ROA',v=>pct(v)],['revenueGrowthPct','Revenue growth',v=>pct(v,1,true)],['operatingProfitGrowthPct','Op. profit growth',v=>pct(v,1,true)],['eps','EPS',v=>n(v)],['bps','BPS',v=>n(v)],['totalAssetsKRW','Total assets',krw],['equityKRW','Equity',krw],['debtRatioPct','Debt ratio',v=>pct(v)],['currentRatioPct','Current ratio',v=>pct(v)],['ebitdaKRW','EBITDA',krw],['evToEbitda','EV/EBITDA',v=>n(v,1)]];
function Financials({d}:{d:any}){
  const rows=(d.periods??[]).slice(0,5);
  if(!rows.length){const r=d.annualRatios??[];if(!r.length)return <p className="muted">No financial data available.</p>;return <table className="compact-table research-table" aria-label="Annual ratios"><thead><tr><th>Period</th><th>Revenue growth</th><th>ROE</th><th>EPS</th><th>Debt ratio</th></tr></thead><tbody>{r.map((x:any)=><tr key={x.period}><td>{x.period}</td><td>{pct(x.revenueGrowthPct,1,true)}</td><td>{pct(x.roePct)}</td><td>{n(x.eps)}</td><td>{pct(x.debtRatioPct)}</td></tr>)}</tbody></table>;}
  return <><div className="research-scroll"><table className="compact-table research-table" aria-label="Financial statements"><thead><tr><th>Item</th>{rows.map((r:any)=><th key={r.period}>{r.period}</th>)}</tr></thead><tbody>{LINES.filter(([k])=>rows.some((r:any)=>r[k]!=null)).map(([k,label,f])=><tr key={k}><td>{label}</td>{rows.map((r:any)=><td key={r.period}>{r[k]==null?'—':f(r[k])}</td>)}</tr>)}</tbody></table></div>
    <p className="muted research-note">Periods not ending in December are year to date.</p></>;
}
function Trend({t,keys}:{t:any;keys:[string,string][]}){
  if(!t)return null;if(t.buildingSince)return <p className="muted research-note">Revision tracking started {t.buildingSince}; changes show after a month.</p>;
  const parts=(['1m','3m'] as const).filter(k=>t[k]).flatMap(k=>keys.filter(([key])=>t[k][key]!=null).map(([key,label])=>`${label} ${pct(t[k][key],1,true)} since ${t[k].since}`));
  return parts.length?<p className="research-line">{parts.join(' · ')}</p>:null;
}
function Valuation({d}:{d:any}){
  const c=d.current??{};
  return <>
    <Stats items={[['PER now',n(c.per,1)],['PER range',d.perRange?`${d.perRange.min}–${d.perRange.max}`:'—'],['vs median PER',pct(d.perVsMedianPct,1,true)],['PBR now',n(c.pbr,2)],['PBR range',d.pbrRange?`${d.pbrRange.min}–${d.pbrRange.max}`:'—'],['vs median PBR',pct(d.pbrVsMedianPct,1,true)],['1-year return',pct(d.return1yPct,1,true)],['3-year return',pct(d.return3yPct,1,true)],['5-year return',pct(d.return5yPct,1,true)]]}/>
    {d.years?.length>0&&<table className="compact-table research-table" aria-label="Valuation history"><thead><tr><th>Year</th><th>Year-end close</th><th>EPS</th><th>PER</th><th>BPS</th><th>PBR</th></tr></thead><tbody>{d.years.map((y:any)=><tr key={y.year}><td>{y.year}</td><td>{n(y.close)}</td><td>{n(y.eps)}</td><td>{n(y.per,1)}</td><td>{n(y.bps)}</td><td>{n(y.pbr,2)}</td></tr>)}</tbody></table>}
    <p className="muted research-note">Year-end multiples use the December close with EPS and BPS for the same year.</p>
  </>;
}
function Peers({d}:{d:any}){
  return <>
    <p className="research-line">{d.sectorName??'Same sector'} · PER {pct(d.perVsPeersPct,1,true)} and PBR {pct(d.pbrVsPeersPct,1,true)} versus the peer median</p>
    <table className="compact-table research-table" aria-label="Peers"><thead><tr><th>Company</th><th>Market cap</th><th>PER</th><th>PBR</th><th>Day</th></tr></thead><tbody>{d.rows.map((r:any)=><tr key={r.symbol} className={r.self?'research-self':''}><td>{r.name??r.symbol}<small> {r.symbol}</small></td><td>{krw(r.marketCapKRW)}</td><td>{n(r.per,1)}</td><td>{n(r.pbr,2)}</td><td>{pct(r.changePct,2,true)}</td></tr>)}<tr className="research-median"><td>Peer median</td><td></td><td>{n(d.peerMedianPer,1)}</td><td>{n(d.peerMedianPbr,2)}</td><td></td></tr></tbody></table>
    <p className="muted research-note">The largest listed stocks in the same KRX index sector.</p>
  </>;
}
function Dividends({d}:{d:any}){
  const report=d.annualReport?.years??[];
  return <>
    <Stats items={[['Last 12 months',d.trailing12mPerShare!=null?`₩${n(d.trailing12mPerShare)}`:'—'],['Trailing yield',pct(d.trailingYieldPct,2)],['Frequency',d.frequency==='none'?'No dividends':d.frequency[0].toUpperCase()+d.frequency.slice(1)]]}/>
    {report.length>0&&<table className="compact-table research-table" aria-label="Annual report dividends"><thead><tr><th>Fiscal year</th><th>Per share</th><th>Payout ratio</th><th>Yield</th></tr></thead><tbody>{report.map((y:any)=><tr key={y.year}><td>{y.year}</td><td>{y.perShare!=null?`₩${n(y.perShare)}`:'—'}</td><td>{pct(y.payoutRatioPct)}</td><td>{pct(y.yieldPct,2)}</td></tr>)}</tbody></table>}
    {d.annualReportUnavailable&&<p className="muted research-note">Payout ratios: {reason(d.annualReportUnavailable)}</p>}
    {d.payments?.length>0&&<table className="compact-table research-table" aria-label="Dividend payments"><thead><tr><th>Record date</th><th>Kind</th><th>Per share</th><th>Paid</th></tr></thead><tbody>{d.payments.map((p:any)=><tr key={p.recordDate+p.kind}><td>{p.recordDate}</td><td>{PAYOUT[p.kind]??p.kind??'—'}</td><td>{p.perShare!=null?`₩${n(p.perShare)}`:'Not set yet'}</td><td>{p.payDate??'—'}</td></tr>)}</tbody></table>}
  </>;
}
function Events({d}:{d:any}){
  const [all,setAll]=useState(false);const filings=(d.filings??[]).filter((f:any)=>all||f.kind!=='ownership');
  return <>
    <h3 className="research-sub">Coming up</h3>
    {d.upcoming?.length?<ul className="research-events">{d.upcoming.map((e:any)=><li key={e.date+e.kind}><span className="research-date">{e.date}</span><span className={`role-tag kind-${e.kind}`}>{KIND[e.kind]??e.kind}</span>{e.title}</li>)}</ul>:<p className="muted">Nothing scheduled that we know of.</p>}
    {d.earnings?.lastRelease&&<p className="muted research-note">Last preliminary earnings filed {d.earnings.lastRelease}{d.earnings.nextExpected?`; next expected around ${d.earnings.nextExpected} (estimated)`:''}.</p>}
    <div className="research-sub-head"><h3 className="research-sub">Filings, last 12 months</h3>{(d.filings??[]).some((f:any)=>f.kind==='ownership')&&<label className="inline-check"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>Show ownership reports</label>}</div>
    {d.filingsUnavailable?<p className="muted">{reason(d.filingsUnavailable)}</p>:filings.length?<table className="compact-table research-table research-filings" aria-label="Filings"><tbody>{filings.map((f:any)=><tr key={f.url}><td>{f.date}</td><td><span className={`role-tag kind-${f.kind}`}>{KIND[f.kind]??f.kind}</span></td><td><button className="link-button" onClick={()=>void window.portfolio?.openFiling(f.url)}>{f.title}</button></td></tr>)}</tbody></table>:<p className="muted">No material filings in the last 12 months.</p>}
  </>;
}
const flow=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?<span className={v<0?'negative':v>0?'positive':''}>{v>0?'+':v<0?'−':''}{krw(Math.abs(v))}</span>:'—';
const streak=(v:unknown)=>typeof v==='number'&&v!==0?`${Math.abs(v)} day${Math.abs(v)===1?'':'s'} of net ${v>0?'buying':'selling'}`:'—';
function Flows({d}:{d:any}){
  const i=d.investors,s=d.shortSelling,m=d.margin,p=d.program;
  return <>
    {i&&<><table className="compact-table research-table" aria-label="Investor net buying"><thead><tr><th>Net buying</th><th>5 days</th><th>20 days</th><th>Streak</th></tr></thead><tbody>
      <tr><td>Foreigners</td><td>{flow(i.net5d?.foreignKRW)}</td><td>{flow(i.net20d?.foreignKRW)}</td><td>{streak(i.foreignStreakDays)}</td></tr>
      <tr><td>Institutions</td><td>{flow(i.net5d?.institutionKRW)}</td><td>{flow(i.net20d?.institutionKRW)}</td><td>{streak(i.institutionStreakDays)}</td></tr>
      <tr><td>Individuals</td><td>{flow(i.net5d?.individualKRW)}</td><td>{flow(i.net20d?.individualKRW)}</td><td>—</td></tr></tbody></table>
      <p className="muted research-note">Through {i.asOf}.</p></>}
    <Stats items={[['Short selling (latest)',pct(s?.latestSharePct,2)],['Short selling (20-day avg)',pct(s?.avg20dSharePct,2)],['Margin loans / shares',pct(m?.balanceRatePct,2)],['Margin change',m?.changeSharesPct!=null?`${pct(m.changeSharesPct,1,true)} since ${m.changeSince}`:'—'],['Program trading (5 days)',flow(p?.net5dKRW)],['Program trading (20 days)',flow(p?.net20dKRW)]]}/>
    <p className="muted research-note">Short selling is the share of daily volume sold short. Margin is loans outstanding as a share of listed shares.</p>
  </>;
}
function Spark({closes}:{closes:{date:string;close:number}[]}){
  if(!closes?.length)return null;const min=Math.min(...closes.map(c=>c.close)),max=Math.max(...closes.map(c=>c.close)),w=600,h=80;
  const pts=closes.map((c,i)=>`${(i/(closes.length-1)*w).toFixed(1)},${(h-(max===min?h/2:(c.close-min)/(max-min)*h)).toFixed(1)}`).join(' ');
  return <svg className="research-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Closing prices ${closes[0].date} to ${closes.at(-1)!.date}`}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>;
}
function Risk({d}:{d:any}){
  return <>
    <Spark closes={d.closes}/>
    <Stats items={[['Volatility (annualized)',pct(d.annualizedVolatilityPct)],[`Beta to ${d.marketIndex}`,n(d.market?.beta,2)],['Correlation',n(d.market?.correlation,2)],['1-month return',pct(d.return1mPct,1,true)],['3-month return',pct(d.return3mPct,1,true)],[`1 month vs ${d.marketIndex}`,pct(d.vsMarket1mPct,1,true)],['1 month vs sector',pct(d.vsSector1mPct,1,true)],['Max drawdown',pct(d.maxDrawdownPct)],['From high',pct(d.fromHighPct)],['vs 20-day average',pct(d.priceVsSma20Pct,1,true)],['vs 60-day average',pct(d.priceVsSma60Pct,1,true)],['Avg daily value (20 days)',krw(d.avgDailyValue20dKRW)]]}/>
    <p className="muted research-note">From {d.days} daily closes through {d.asOf}; drawdown and high cover that window.</p>
  </>;
}
const VIEWS:Record<string,(p:{d:any})=>ReactNode>={overview:Overview,analysts:Analysts,estimates:Estimates,financials:Financials,dividends:Dividends,events:Events,flows:Flows,risk:Risk,valuation:Valuation,peers:Peers};
export function ResearchPanel({symbol}:{symbol:string}){
  const [tab,setTab]=useState('overview');const [data,setData]=useState<Record<string,ResearchSection>>({});const [loading,setLoading]=useState('');const current=useRef(symbol);
  const load=async(section:string,refresh=false)=>{setLoading(section);try{const p=await window.portfolio!.getResearch(symbol,[section],refresh);if(current.current===symbol)setData(d=>({...d,[section]:p.sections[section]??{status:'unavailable',reason:'UNKNOWN_SECTION'}}));}catch{if(current.current===symbol)setData(d=>({...d,[section]:{status:'unavailable'}}));}finally{if(current.current===symbol)setLoading('');}};
  useEffect(()=>{current.current=symbol;setData({});},[symbol]);
  useEffect(()=>{if(window.portfolio&&!data[tab])void load(tab);},[tab,symbol,data[tab]]);
  if(!window.portfolio)return null;
  const section=data[tab];const View=VIEWS[tab];const busy=loading===tab;
  return <section className="research-panel" aria-label="Company research" aria-busy={busy}>
    <div className="section-head"><div><h2>Research</h2><small className="muted">{busy?'Loading…':section?.retrievedAt?`Updated ${ago(section.retrievedAt)}${section.stale?' · showing saved data':''}`:''}</small></div><button disabled={busy} onClick={()=>void load(tab,true)}>Refresh</button></div>
    <div className="segmented research-tabs" role="tablist" aria-label="Research sections">{TABS.map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    <div className="research-body" role="tabpanel">{!section?<p className="muted">{busy?'Loading…':''}</p>:section.status!=='ok'?<p className="muted">{reason(section.reason)}</p>:<View d={section.data}/>}</div>
    <p className="muted research-note">KIS and OpenDART data. The AI agents read the same research.</p>
  </section>;
}
