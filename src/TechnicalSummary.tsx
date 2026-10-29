import {useEffect,useMemo,useState} from 'react';
import {useDraftState} from './useDraftState';
import type {Candle} from './CandleChart';
import {TIMEFRAMES,RATINGS,SIGNALS,summarize,aggregate} from './technical-summary.mjs';
import {applyTick,type Tick} from './live-bars.mjs';
import './technical.css';
type Bars={frames?:Record<string,Candle[]>;errors?:Record<string,string>;retrievedAt?:number;error?:string};
// Investing-style technical summary for the charted symbol: a rating per timeframe, then the selected timeframe's moving
// averages, indicators and pivot points. Display only; reviews do not receive these readings.
export function TechnicalSummary({symbol,daily}:{symbol:string;daily:Candle[]}){
  const [bars,setBars]=useState<Bars|null>(null);const [loading,setLoading]=useState(false);const [frame,setFrame]=useDraftState('technical:frame','1d');const [reload,setReload]=useState(0);
  useEffect(()=>{let alive=true;setBars(null);setLoading(true);window.portfolio?.getChartBars(symbol).then(v=>{if(alive)setBars(v);}).catch(()=>{if(alive)setBars({error:'REQUEST_FAILED'});}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[symbol,reload]);
  const us=symbol.includes(':');
  // Live ticks move the latest bar of each fetched timeframe (daily bars come live from the chart above).
  useEffect(()=>window.portfolio?.onChartTick?.((t:Tick)=>{if(t.symbol!==symbol)return;const market=symbol.includes(':')?'US':'KR';
    setBars(prev=>{if(!prev?.frames)return prev;const frames:Record<string,Candle[]>={};for(const [id,list] of Object.entries(prev.frames)){const minutes=id==='1m'?1:TIMEFRAMES.find(f=>f.id===id)?.minutes;
      frames[id]=applyTick(list,t,{period:minutes?minutes*60000:'last',market});}return {...prev,frames};});}),[symbol]);
  // Candles per timeframe: Korean intraday bars are combined from today's one-minute bars.
  const series=useMemo(()=>{const f=bars?.frames??{};const out:Record<string,Candle[]>={'1d':daily,'1w':f['1w']??[],'1M':f['1M']??[]};
    for(const t of TIMEFRAMES)if(t.minutes)out[t.id]=us?(f[t.id]??[]):aggregate(f['1m']??[],t.minutes);return out;},[bars,daily,us]);
  const summaries=useMemo(()=>Object.fromEntries(TIMEFRAMES.map(t=>[t.id,summarize(series[t.id])])),[series]);
  const selected=summaries[frame]??null;const price=(v:number|null|undefined,d?:number)=>v==null?'—':v.toLocaleString(undefined,{minimumFractionDigits:d??(us?2:0),maximumFractionDigits:d??(us?2:0)});
  const missing=(id:string)=>bars?.errors?.[id==='1d'||!TIMEFRAMES.find(t=>t.id===id)?.minutes||us?id:'1m'];
  const Pill=({value,kind='rating'}:{value:string|null;kind?:'rating'|'signal'})=>value?<span className={`ta-pill ta-${value}`}>{kind==='rating'?RATINGS[value as keyof typeof RATINGS]:SIGNALS[value as keyof typeof SIGNALS]}</span>:<span className="ta-pill ta-none">Not enough data</span>;
  const counts=(c?:{buy:number;neutral:number;sell:number})=>c?<small className="muted">Buy {c.buy} · Neutral {c.neutral} · Sell {c.sell}</small>:null;
  const label=TIMEFRAMES.find(t=>t.id===frame)?.label??frame;
  return <section className="technical-summary" aria-label="Technical summary">
    <div className="section-head"><h2>Technical summary</h2><div className="actions">{loading&&<span className="muted"><span className="spinner"/> Loading bars</span>}{bars?.error&&<button onClick={()=>setReload(n=>n+1)}>Retry</button>}</div></div>
    <div className="ta-frames" role="tablist" aria-label="Timeframe">{TIMEFRAMES.map(t=>{const s=summaries[t.id];return <button key={t.id} role="tab" aria-selected={frame===t.id} className={`ta-frame${frame===t.id?' selected':''}`} onClick={()=>setFrame(t.id)}>
      <small>{t.label}</small>{loading&&t.id!=='1d'&&!s?<span className="ta-pill ta-none"><i className="skeleton-text"/></span>:<Pill value={s?.rating??null}/>}</button>;})}</div>
    {!selected?<p className="muted">{loading?'Loading bars…':missing(frame)?`${label} bars could not load (${missing(frame)}).`:`Not enough ${label.toLowerCase()} bars yet${!us&&TIMEFRAMES.find(t=>t.id===frame)?.minutes?': Korean intraday readings use today’s bars only.':'.'}`}</p>:<>
      <div className="ta-overall"><div><small>{label} summary</small><Pill value={selected.rating}/></div><div><small>Moving averages</small><Pill value={selected.movingAverages.rating}/>{counts(selected.movingAverages.counts)}</div><div><small>Indicators</small><Pill value={selected.indicators.rating}/>{counts(selected.indicators.counts)}</div>
        <small className="muted ta-basis">{selected.bars} bars · last {new Date(selected.asOf).toLocaleString([],frame==='1d'||frame==='1w'||frame==='1M'?{year:'numeric',month:'short',day:'numeric'}:{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></div>
      <div className="ta-grid">
        <div className="ta-card"><h3>Moving averages</h3><table className="ta-table"><thead><tr><th>Period</th><th>Simple</th><th>Exponential</th></tr></thead><tbody>{selected.movingAverages.rows.map(r=><tr key={r.period}><th>MA{r.period}</th>{[r.simple,r.exponential].map((v,i)=><td key={i}>{v?<><span>{price(v.value)}</span><Pill value={v.signal} kind="signal"/></>:<span className="muted">—</span>}</td>)}</tr>)}</tbody></table></div>
        <div className="ta-card"><h3>Indicators</h3><table className="ta-table"><thead><tr><th>Name</th><th>Value</th><th>Reading</th></tr></thead><tbody>{selected.indicators.rows.map(r=><tr key={r.name}><th>{r.name}</th><td>{r.value==null?<span className="muted">—</span>:price(r.value,2)}</td><td>{r.signal?<Pill value={r.signal} kind="signal"/>:<span className="muted">—</span>}</td></tr>)}</tbody></table></div>
        <div className="ta-card"><h3>Pivot points</h3>{selected.pivots?<table className="ta-table ta-pivots"><thead><tr><th>Level</th><th>Classic</th><th>Fibonacci</th></tr></thead><tbody>{(['r3','r2','r1','p','s1','s2','s3'] as const).map(k=><tr key={k} className={`ta-level-${k[0]}`}><th>{k==='p'?'Pivot':k.toUpperCase()}</th><td>{price(selected.pivots!.classic[k])}</td><td>{price(selected.pivots!.fibonacci[k])}</td></tr>)}</tbody></table>:<p className="muted">Needs a completed bar.</p>}</div>
      </div></>}
    <details className="inline-help"><summary>How these are read</summary><p className="muted">Each reading follows a fixed rule on completed and current bars; it is not advice and the trading AI does not receive it. Moving averages read Buy when the price is above them. RSI, Stochastic, StochRSI, Williams %R, CCI and the Ultimate Oscillator read Overbought or Oversold at their extremes, which count as Neutral. ADX reads only from 25, in the direction of +DI or −DI. ATR shows volatility against its 14-bar average and is not counted. Ratings weigh Buy against Sell readings. Pivot points come from the bar before the latest one. {us?'U.S. intraday bars include earlier sessions.':'Korean intraday bars are today’s from the open; weekly and monthly bars come from KIS.'}</p></details>
  </section>;
}
