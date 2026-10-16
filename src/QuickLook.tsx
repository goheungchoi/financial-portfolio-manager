import {useEffect,useState} from 'react';
import {Spark,type ResearchSection} from './ResearchPanel';
// A quick look at one listing from Discover: price trend, key numbers and the analyst or fund view, without leaving the page.
const n=(v:unknown,d=0)=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString(undefined,{maximumFractionDigits:d}):'—';
const pct=(v:unknown,d=1,sign=false)=>typeof v==='number'&&Number.isFinite(v)?`${sign&&v>0?'+':''}${v.toFixed(d)}%`:'—';
const big=(v:unknown,usd:boolean)=>typeof v==='number'&&Number.isFinite(v)?(usd?'$':'₩')+new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(v):'—';
export function QuickLook({symbol,name,watching,onClose,onOpen,onWatch}:{symbol:string;name:string;watching:boolean;onClose():void;onOpen():void;onWatch():void}){
  const [type,setType]=useState<string|null>(null);const [sections,setSections]=useState<Record<string,ResearchSection>>({});
  const usd=symbol.includes(':');
  useEffect(()=>{let alive=true;setSections({});setType(null);
    (async()=>{try{const first=await window.portfolio!.getResearch(symbol,['overview']);if(!alive)return;const kind=first.type??null;setType(kind);setSections(s=>({...s,...first.sections}));
      const more=['risk',usd?'financials':kind==='etf'||kind==='etn'?'fund':'analysts'];for(const name of more){const p=await window.portfolio!.getResearch(symbol,[name]);if(!alive)return;setSections(s=>({...s,...p.sections}));}}catch{}})();
    return()=>{alive=false;};},[symbol]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[onClose]);
  const o=sections.overview?.status==='ok'?sections.overview.data:null,r=sections.risk?.status==='ok'?sections.risk.data:null,a=sections.analysts?.status==='ok'?sections.analysts.data:null,f=sections.fund?.status==='ok'?sections.fund.data:null;
  const loading=!sections.overview;
  return <section className="quick-look" aria-label={`Quick look ${name}`}>
    <div className="section-head"><div><h2>{name}</h2><small className="muted">{symbol}{type?` · ${type.toUpperCase()}`:''}{o?.sectorName?` · ${o.sectorName}`:''}</small></div><button className="link-button" aria-label="Close quick look" onClick={onClose}>Close</button></div>
    {loading?<p className="muted">Loading…</p>:!o?<p className="muted">No quote available right now.</p>:<>
      <div className="quick-price"><b>{n(o.price,usd?2:0)}</b><span className={(o.changePct??0)>0?'positive':(o.changePct??0)<0?'negative':''}>{pct(o.changePct,2,true)}</span></div>
      {r?.closes&&<Spark closes={r.closes}/>}
      <div className="company-stats">{([['Market cap',big(usd?o.marketCapUSD:o.marketCapKRW,usd)],['PER',n(o.per,1)],['PBR',n(o.pbr,2)],['52-week range',`${n(o.low52Week,usd?2:0)} – ${n(o.high52Week,usd?2:0)}`],['1-month return',pct(r?.return1mPct,1,true)],['Volatility',pct(r?.annualizedVolatilityPct)]] as [string,string][]).map(([k,v])=><div key={k}><small>{k}</small><b>{v}</b></div>)}</div>
      {a&&<p className="research-line">{a.brokerages} brokerages · {a.buy} Buy · {a.hold} Hold · {a.sell} Sell · median target {n(a.medianTarget)} ({pct(a.upsideToMedianPct,1,true)}){a.targetRevisions?` · ${a.targetRevisions.raised} raised, ${a.targetRevisions.cut} cut in 90 days`:''}</p>}
      {f&&<p className="research-line">{f.underlyingIndex??'Fund'} · {f.issuer??''}{f.kind&&f.kind!=='standard'?` · ${f.leverageFactor}× daily`:''} · premium {pct(f.premiumPct,2,true)} · net assets {big(f.netAssetsKRW,false)}</p>}
    </>}
    <div className="actions"><button className="primary" onClick={onOpen}>Full research and chart</button>{watching?<span className="badge">WATCHING</span>:<button onClick={onWatch}>Add to watchlist</button>}</div>
  </section>;
}
