import {useEffect,useRef,useState,type ReactNode} from 'react';
import './research.css';
export type ResearchSection={status:'ok'|'unavailable';retrievedAt?:number;data?:any;reason?:string;stale?:boolean};
export type ResearchProfile={symbol:string;name:string|null;market?:string;sector?:string|null;sectorName?:string|null;asOf:string;sections:Record<string,ResearchSection>};
// The same research the agents read, one tab per section; each tab loads when first opened.
const TABS:[string,string][]=[['overview','Overview'],['analysts','Analysts'],['estimates','Estimates'],['financials','Financials'],['dividends','Dividends'],['events','Events']];
const REASONS:Record<string,string>={KIS_NOT_CONNECTED:'Connect your KIS account to load research.',DART_KEY_MISSING:'Add an OpenDART key to your providers file.',KOREAN_LISTINGS_ONLY:'Available for Korean stocks.',RATE_LIMITED:'KIS is rate limiting. Try again shortly.',NOT_IN_DART:'This listing has no DART filings.',DART_RATE_LIMITED:'OpenDART is rate limiting. Try again later.'};
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
    {d.latest?.length>0&&<table className="compact-table research-table" aria-label="Latest analyst notes"><thead><tr><th>Date</th><th>Brokerage</th><th>Rating</th><th>Target</th></tr></thead><tbody>{d.latest.map((r:any)=><tr key={r.firm+r.date}><td>{r.date}</td><td>{r.firm}</td><td>{r.opinion}</td><td>{n(r.target)}</td></tr>)}</tbody></table>}
  </>;
}
const EST:[string,string,(v:number)=>string][]=[['revenue','Revenue',v=>krw(v*1e8)],['operatingProfit','Operating profit',v=>krw(v*1e8)],['netIncome','Net income',v=>krw(v*1e8)],['eps','EPS',v=>n(v)],['per','PER',v=>n(v,1)],['roePct','ROE',v=>pct(v)],['debtRatioPct','Debt ratio',v=>pct(v)]];
function Estimates({d}:{d:any}){
  if(!d?.years?.length)return <p className="muted">No consensus estimates for this stock.</p>;
  return <><table className="compact-table research-table" aria-label="Consensus estimates"><thead><tr><th>Metric</th>{d.years.map((y:string)=><th key={y}>{y}</th>)}</tr></thead><tbody>{EST.filter(([k])=>Array.isArray(d[k])).map(([k,label,f])=><tr key={k}><td>{label}</td>{d[k].map((v:number|null,i:number)=><td key={i}>{v==null?'—':f(v)}</td>)}</tr>)}</tbody></table>
    <p className="muted research-note">Years ending in E are forecasts.{d.reportOpinion?` Latest report: ${d.reportOpinion}${d.reportDate?` (${d.reportDate})`:''}.`:''}</p></>;
}
function Financials({d}:{d:any}){
  const rows=d.annualRatios??[];if(!rows.length)return <p className="muted">No financial ratios available.</p>;
  return <table className="compact-table research-table" aria-label="Annual ratios"><thead><tr><th>Period</th><th>Revenue growth</th><th>Op. profit growth</th><th>ROE</th><th>EPS</th><th>BPS</th><th>Debt ratio</th></tr></thead><tbody>{rows.map((r:any)=><tr key={r.period}><td>{r.period}</td><td>{pct(r.revenueGrowthPct,1,true)}</td><td>{pct(r.operatingProfitGrowthPct,1,true)}</td><td>{pct(r.roePct)}</td><td>{n(r.eps)}</td><td>{n(r.bps)}</td><td>{pct(r.debtRatioPct)}</td></tr>)}</tbody></table>;
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
const VIEWS:Record<string,(p:{d:any})=>ReactNode>={overview:Overview,analysts:Analysts,estimates:Estimates,financials:Financials,dividends:Dividends,events:Events};
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
