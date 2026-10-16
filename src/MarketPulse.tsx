import {useEffect,useState} from 'react';
import {Note} from './Note';
import './research.css';
// Korean market today: breadth, sector moves and where foreign and institutional money went. The agents read the same overview.
type Breadth={index:string;level:number|null;changePct:number|null;advancers:number|null;decliners:number|null;unchanged:number|null;limitUp:number|null;limitDown:number|null;advanceRatioPct:number|null};
type Buyer={symbol:string;name:string;netBuyKRW:number;changePct:number|null};
type Market={breadth:Breadth[];kospiSectors:{code:string;name:string;changePct:number;valueSharePct:number|null}[];foreignTopBuys:Buyer[];institutionTopBuys:Buyer[]};
const pct=(v:number|null|undefined,sign=true)=>v==null?'—':`${sign&&v>0?'+':''}${v.toFixed(2)}%`;
const krw=(v:number)=>'₩'+new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(v);
const tone=(v:number|null|undefined)=>v==null||v===0?'':v>0?'positive':'negative';
export function MarketPulse({onOpenChart}:{onOpenChart(symbol:string):void}){
  const [state,setState]=useState<{status:string;retrievedAt?:number;data?:Market;reason?:string}|null>(null);const [busy,setBusy]=useState(false);
  const load=async(refresh=false)=>{setBusy(true);try{setState(await window.portfolio!.getMarketOverview(refresh));}catch{setState({status:'unavailable'});}finally{setBusy(false);}};
  useEffect(()=>{if(window.portfolio)void load();},[]);
  if(!window.portfolio)return null;
  const d=state?.status==='ok'?state.data:null;
  const sectors=d?.kospiSectors??[];const shown=sectors.length>10?[...sectors.slice(0,5),...sectors.slice(-5)]:sectors;
  const buyers=(title:string,rows:Buyer[])=><div><h3 className="research-sub">{title}</h3>{rows.length?<ol className="pulse-buyers">{rows.slice(0,5).map(r=><li key={r.symbol}><button className="link-button" onClick={()=>onOpenChart(r.symbol)}>{r.name}</button><span className="positive">{krw(r.netBuyKRW)}</span></li>)}</ol>:<p className="muted">No data yet today.</p>}</div>;
  return <section className="market-pulse" aria-label="Korea market today" aria-busy={busy}>
    <div className="section-head"><div><h2>Korea market today</h2><small className="muted">{busy?'Loading…':state?.retrievedAt?`Updated ${new Date(state.retrievedAt).toLocaleTimeString()}`:''}</small></div><button disabled={busy} onClick={()=>void load(true)}>Refresh</button></div>
    {!state?<p className="muted">Loading…</p>:!d?<p className="muted">{state.reason==='KIS_NOT_CONNECTED'?'Connect your KIS account to see the market.':'Market data is not available right now.'}</p>:<>
      <div className="pulse-breadth">{d.breadth.map(b=><div key={b.index}><small>{b.index}</small><b>{b.level?.toLocaleString(undefined,{maximumFractionDigits:2})??'—'} <span className={tone(b.changePct)}>{pct(b.changePct)}</span></b>
        <div className="pulse-bar" role="img" aria-label={`${b.advancers} advancing, ${b.decliners} declining`}><span className="up" style={{flex:b.advancers??0}}/><span className="flat" style={{flex:b.unchanged??0}}/><span className="down" style={{flex:b.decliners??0}}/></div>
        <small className="muted">{b.advancers??'—'} up · {b.decliners??'—'} down{b.limitUp?` · ${b.limitUp} limit up`:''}{b.limitDown?` · ${b.limitDown} limit down`:''}</small></div>)}</div>
      {shown.length>0&&<><h3 className="research-sub">KOSPI sectors{sectors.length>10?' · strongest and weakest':''}</h3><div className="pulse-sectors">{shown.map(s=><div key={s.code} className={tone(s.changePct)}><span>{s.name}</span><b>{pct(s.changePct)}</b></div>)}</div></>}
      <div className="pulse-flows">{buyers('Foreigners are buying',d.foreignTopBuys)}{buyers('Institutions are buying',d.institutionTopBuys)}</div>
      <Note summary="About this data"><p>KIS data. Sector moves compare with the previous close. Foreign and institutional buying are preliminary intraday tallies by value and change through the day.</p></Note>
    </>}
  </section>;
}
