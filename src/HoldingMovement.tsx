// Holdings page, Movement section (2026-11-11, artifacts/reviews/2026-11-11-holding-graphs): one small card per open
// holding, largest first, with its price line and P/L line for 1W, 1M, 3M or since purchase. The figures come from
// src/holding-movement.mjs. Prices are read once per symbol per session, one symbol after another, never polled.
import {useEffect,useState} from 'react';
import type {PortfolioRow} from './UnifiedPortfolio';
import {useDraftState} from './useDraftState';
import {movementCards,recordedDays,seoulDay,PERIODS} from './holding-movement.mjs';
import {shortDay} from './PerfCharts';

type Closes={closes:{date:string;close:number}[]|null;reason:string|null;retrievedAt?:number;stale?:boolean};
// Kept for the session: the section asks KIS for each symbol at most once, unless the user retries it.
const closesCache=new Map<string,Closes>();
const money=(n:number,currency:string)=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:currency==='KRW'?0:2}).format(n);
const signed=(n:number,currency:string)=>(n>0?'+':n<0?'−':'')+money(Math.abs(n),currency);
const pct=(n:number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1,minimumFractionDigits:1,signDisplay:'exceptZero'}).format(n*100)+'%';
const tone=(n:number|null|undefined)=>n==null||Math.abs(n)<1e-9?'':n>0?'positive':'negative';
const readError=(code:string)=>code==='RATE_LIMITED'?'Prices could not be read: KIS asked the app to slow down.':code==='KIS_NOT_CONNECTED'||code==='NOT_CONNECTED'?'Prices could not be read: KIS is not connected.':`Prices could not be read (${code}).`;

// A small line: gaps where a value is null; an optional marker (the purchase day) and zero line (P/L).
function Line({values,marker=null,zero=false,label,className=''}:{values:(number|null)[];marker?:number|null;zero?:boolean;label:string;className?:string}){
  const known=values.filter((v):v is number=>v!=null);if(known.length<2)return null;
  const w=240,h=44,lo=Math.min(...known,...(zero?[0]:[])),hi=Math.max(...known,...(zero?[0]:[]));const x=(i:number)=>values.length<2?0:i/(values.length-1)*w;const y=(v:number)=>hi===lo?h/2:h-2-(v-lo)/(hi-lo)*(h-4);
  const runs:string[]=[];let cur:string[]=[];values.forEach((v,i)=>{if(v==null){if(cur.length)runs.push(cur.join(' '));cur=[];}else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);});if(cur.length)runs.push(cur.join(' '));
  return <svg className={`movement-line ${className}`.trim()} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
    {zero&&lo<0&&hi>0&&<line className="movement-zero" x1={0} x2={w} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke"/>}
    {marker!=null&&<line className="movement-marker" x1={x(marker)} x2={x(marker)} y1={0} y2={h} vectorEffect="non-scaling-stroke"><title>Purchase</title></line>}
    {runs.map((pts,i)=><polyline key={i} points={pts} fill="none" stroke="currentColor" strokeWidth={1.6} vectorEffect="non-scaling-stroke"/>)}
  </svg>;
}

type Card=ReturnType<typeof movementCards>[number];
const at=(ms:number)=>new Date(ms).toLocaleString('en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})+' KST';
// More (step 4): where each line comes from, the first recorded day, how the two lines end, and the daily values behind
// both lines, newest first. A day without a record is listed as such.
function MovementMore({card:c,cache}:{card:Card;cache?:Closes}){
  const us=c.market==='US';const prices=[...c.price.points].reverse();const pl=[...c.pl.points].reverse();
  return <details className="inline-help metric-details movement-more"><summary>More</summary>
    <ul className="muted">
      <li>Prices: KIS daily closes{cache?.retrievedAt?`, read ${at(cache.retrievedAt)}`:''}{cache?.stale?' (could not be refreshed; the last read is shown)':''}. The price line ends on the live price from the holdings table.</li>
      <li>P/L: the app's daily records, value minus average cost at each day's last reading. The line ends on today's last recorded reading, so its end can differ from the live price.</li>
      {us&&<li>U.S. prices are dated by the New York day; P/L by the Seoul day.</li>}
      {c.purchase.source==='fill'&&<li>Bought {shortDay(c.purchase.day!,true)} (the app's order).</li>}
      {c.purchase.source==='first recorded'&&<li>The purchase is not in the app's orders: P/L starts at the first recorded day, {shortDay(c.purchase.day!,true)}.</li>}
      {c.pl.startsLate&&<li>The daily records start {shortDay(c.pl.startsAt!,true)}, after the purchase.</li>}
    </ul>
    <div className="movement-tables">
      {prices.length>0&&<table aria-label="Daily prices"><thead><tr><th>Day</th><th>Close</th></tr></thead><tbody>{prices.map(p=><tr key={p.day}><td>{shortDay(p.day)}</td><td>{money(p.close,c.currency)}{(p as any).live?' (live)':''}</td></tr>)}</tbody></table>}
      {pl.length>0&&<table aria-label="Daily P/L"><thead><tr><th>Day</th><th>P/L</th><th>%</th></tr></thead><tbody>{pl.map(p=><tr key={p.day}><td>{shortDay(p.day)}</td>{(p as any).gap?<td colSpan={2} className="muted">Not recorded</td>:<><td className={tone(p.pnl)}>{p.pnl==null?'—':signed(p.pnl,c.currency)}</td><td>{p.pct==null?'—':pct(p.pct)}</td></>}</tr>)}</tbody></table>}
    </div>
  </details>;
}

export function HoldingMovement({rows,equity,onCompany}:{rows:PortfolioRow[];equity:number|null;onCompany?:(symbol:string)=>void}){
  const [period,setPeriod]=useDraftState('portfolio:movementPeriod','1M');
  const [records,setRecords]=useState<Awaited<ReturnType<NonNullable<typeof window.portfolio>['getMovementRecords']>>|null>(null);
  const [,setTick]=useState(0);const bump=()=>setTick(t=>t+1);
  useEffect(()=>{let alive=true;void (async()=>{try{const r=await window.portfolio?.getMovementRecords();if(alive&&r)setRecords(r);}catch{}})();return()=>{alive=false;};},[]);
  const symbols=rows.filter(r=>r.quantity>0).map(r=>r.symbol).join(',');
  // One symbol after another (the KIS queue would space them anyway; this keeps the page from asking for all at once).
  useEffect(()=>{let alive=true;void (async()=>{for(const symbol of symbols.split(',').filter(Boolean)){if(!alive)return;if(closesCache.has(symbol))continue;
      try{const r=await window.portfolio?.getMovementCloses(symbol);closesCache.set(symbol,r?.closes?{closes:r.closes,reason:null,retrievedAt:r.retrievedAt,stale:r.stale}:{closes:null,reason:readError(r?.error??'UNAVAILABLE')});}catch{closesCache.set(symbol,{closes:null,reason:readError('REQUEST_FAILED')});}
      if(alive)bump();}})();return()=>{alive=false;};},[symbols]);
  const retry=async(symbol:string)=>{closesCache.set(symbol,{closes:null,reason:'Loading prices…'});bump();try{const r=await window.portfolio?.getMovementCloses(symbol,true);closesCache.set(symbol,r?.closes?{closes:r.closes,reason:null,retrievedAt:r.retrievedAt,stale:r.stale}:{closes:null,reason:readError(r?.error??'UNAVAILABLE')});}catch{closesCache.set(symbol,{closes:null,reason:readError('REQUEST_FAILED')});}bump();};
  const active=PERIODS.includes(period)?period:'1M';
  const now=Date.now(),today=seoulDay(now);
  const days=recordedDays(records?.days??[]);
  const closesBySymbol=Object.fromEntries(rows.map(r=>[r.symbol,closesCache.get(r.symbol)??{closes:null,reason:'Loading prices…'}]));
  // now: a U.S. holding's price line is dated by its New York day.
  const shown=records?movementCards({rows,closesBySymbol,days,fillsBySymbol:records.fills??{},period:active,today,now}):[];
  return <section className="holding-movement" aria-label="Movement">
    <div className="section-head"><h2>Movement</h2><div className="segmented compact" role="tablist" aria-label="Movement period">{PERIODS.map(p=><button key={p} role="tab" aria-selected={active===p} aria-pressed={active===p} onClick={()=>setPeriod(p)}>{p}</button>)}</div></div>
    {!records?<p className="muted">Loading the daily records…</p>:!records.connected?<p className="muted">Connect your KIS account to see how your holdings moved.</p>:!shown.length?<p className="muted">No open holdings for this market.</p>:
    <div className="movement-grid">{shown.map(c=>{const row=rows.find(r=>r.symbol===c.symbol)!;const share=equity&&row.valueKRW!=null?row.valueKRW/equity:null;
      const priceValues=c.price.points.map(p=>p.close);const marker=c.price.purchaseMarked?c.price.points.findIndex(p=>p.day>=c.purchase.marketDay!):null;
      const plDays=c.pl.points;const sinceText=c.purchase.source==='fill'?'since buy':c.purchase.day?`since first recorded ${shortDay(c.purchase.day)}`:'';
      const periodText=active==='Since purchase'?(c.purchase.source==='fill'?'since purchase':c.purchase.day?`since first recorded ${shortDay(c.purchase.day)}`:''):`in ${active}`;
      const cache=closesCache.get(c.symbol);
      return <article key={c.symbol} className="movement-card" aria-label={`Movement ${c.name}`} data-symbol={c.symbol}>
        <header><button className="company-link" onClick={()=>onCompany?.(c.symbol)} aria-label={`View ${c.name} charts`}>{c.name}</button><small>{row.quantity} share{row.quantity===1?'':'s'}{share!=null?` · ${(share*100).toFixed(share<0.01?1:0)}% of equity`:''}</small></header>
        <div className="movement-row" aria-label="Price"><span className="movement-label">Price</span>
          {c.price.reason?<span className="muted movement-reason">{c.price.reason}{!cache?.closes&&cache?.reason&&cache.reason!=='Loading prices…'&&<button className="link-button" onClick={()=>void retry(c.symbol)}>Retry</button>}</span>:<>
          <span className="movement-figures"><b>{money(c.price.end!,c.currency)}</b>{c.price.changePct!=null&&<em className={tone(c.price.changePct)}>{pct(c.price.changePct)} {periodText}</em>}</span>
          <Line values={priceValues} marker={marker!=null&&marker>=0?marker:null} label={`${c.name} daily closes ${c.price.points[0].day} to ${c.price.points.at(-1)!.day}`}/>
          <small className="movement-days" aria-label="Price line days"><span>{shortDay(c.price.points[0].day)}</span><span>{shortDay(c.price.points.at(-1)!.day)}</span></small></>}</div>
        <div className="movement-row" aria-label="P/L"><span className="movement-label">P/L</span>
          {c.pl.reason?<span className="muted movement-reason">{c.pl.reason}</span>:<>
          <span className="movement-figures"><b className={tone(c.pl.end)}>{c.pl.end==null?'—':signed(c.pl.end,c.currency)}</b>{c.pl.endPct!=null&&<em className={tone(c.pl.endPct)}>{pct(c.pl.endPct)} {sinceText}</em>}</span>
          <Line values={plDays.map(p=>p.pnl)} zero className={tone(c.pl.end)} label={`${c.name} P/L ${plDays[0]?.day??''} to ${plDays.at(-1)?.day??''}`}/>
          {plDays.length>0&&<small className="movement-days" aria-label="P/L line days"><span>{shortDay(plDays[0].day)}</span><span>{shortDay(plDays.at(-1)!.day)}</span></small>}
          {c.pl.startsLate&&<small className="muted">P/L from {shortDay(c.pl.startsAt!)}, the first recorded day</small>}</>}</div>
        <MovementMore card={c} cache={cache}/>
      </article>;})}</div>}
  </section>;
}
