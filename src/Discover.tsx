import {useEffect,useRef,useState} from 'react';
import {useDraftState} from './useDraftState';
export type Security={symbol:string;name:string;englishName:string;market:string;type:string};
export type WatchEntry={symbol:string;name:string;market:string;type:string;source:'user'|'ai';reason:string;pinned:boolean;addedAt:number};
export type ScreenRow={symbol:string;name:string;englishName?:string;market:string;type:string;price:number|null;changePct:number|null;volume:number|null;marketCap:number|null;per:number|null;currency:string;orderable?:boolean|null};
export type ScreenResult={kind:string;market:string;exchange:string|null;retrievedAt:number;note:string;rows:ScreenRow[]};
export type DiscoveryState={master:{markets:{market:string;count:number;updatedAt:number}[];total:number;updatedAt:number|null;refreshing:boolean;error:string|null};watchlist:WatchEntry[];connected:boolean};
export type DiscoveryReply<T=unknown>={ok:boolean;data?:T;error?:string;state:DiscoveryState};
const errors:Record<string,string>={KIS_NOT_CONNECTED:'Connect your KIS account in Connections first.',UNKNOWN_SYMBOL:'That symbol is not in the downloaded symbol list.',WATCHLIST_FULL:'The watchlist is full (30). Remove an entry first.',INVALID_WATCHLIST:'Invalid symbol.',RATE_LIMITED:'KIS is rate limiting requests. Try again shortly.'};
const message=(reply:DiscoveryReply)=>errors[reply.error??'']??'The request could not be completed.';
const compact=(value:number|null,currency:string)=>value==null?'—':new Intl.NumberFormat(currency==='USD'?'en-US':'ko-KR',{style:'currency',currency,notation:'compact',maximumFractionDigits:1}).format(value);
const price=(value:number|null,currency:string)=>value==null?'—':new Intl.NumberFormat(currency==='USD'?'en-US':'ko-KR',{style:'currency',currency,maximumFractionDigits:currency==='USD'?2:0}).format(value);
const typeLabel:Record<string,string>={stock:'Stock',etf:'ETF',etn:'ETN',reit:'REIT',fund:'Fund',warrant:'Warrant',other:'Other',unknown:'Unlisted'};
export function Discover({onOpenChart}:{onOpenChart(symbol:string):void}){
  const [state,setState]=useState<DiscoveryState|null>(null);const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
  const [query,setQuery]=useDraftState('discover:query','');const [queryMarket,setQueryMarket]=useDraftState('discover:query-market','');const [results,setResults]=useState<Security[]|null>(null);
  const [screen,setScreen]=useDraftState('discover:screen',{market:'KR',exchange:'NASD',kind:'volume',type:'stock'});const [screened,setScreened]=useState<ScreenResult|null>(null);const [screening,setScreening]=useState(false);const [screenError,setScreenError]=useState('');const screenSeq=useRef(0);
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getDiscovery();if(alive&&reply)setState(reply.state);}catch{}};void load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  const connected=Boolean(state?.connected);
  // The screener reloads whenever a filter changes and every minute while this page is open; older replies are ignored.
  useEffect(()=>{
    if(!connected||!window.portfolio)return;let alive=true;
    const load=async()=>{const seq=++screenSeq.current;setScreening(true);setScreenError('');
      try{const reply=await window.portfolio!.screenMarket({market:screen.market,kind:screen.kind,type:screen.type,limit:30,...(screen.market==='US'?{exchange:screen.exchange}:{})});if(!alive||seq!==screenSeq.current)return;setState(reply.state);if(reply.ok)setScreened(reply.data as ScreenResult);else setScreenError(message(reply));}
      catch{if(alive&&seq===screenSeq.current)setScreenError('Could not reach the engine.');}
      finally{if(alive&&seq===screenSeq.current)setScreening(false);}};
    void load();const timer=setInterval(load,60000);return()=>{alive=false;clearInterval(timer);};
  },[connected,screen.market,screen.exchange,screen.kind,screen.type]);
  if(!window.portfolio)return <section><p>Use the desktop app for market discovery.</p></section>;
  const run=async<T,>(task:()=>Promise<DiscoveryReply<T>|undefined>,done?:(data:T)=>void)=>{setBusy(true);setNotice('');try{const reply=await task();if(!reply)return;setState(reply.state);if(reply.ok)done?.(reply.data as T);else setNotice(message(reply));}catch{setNotice('Could not reach the engine.');}finally{setBusy(false);}};
  const listed=new Set(state?.watchlist.map(row=>row.symbol));
  const addButton=(symbol:string)=>listed.has(symbol)?<span className="badge">WATCHING</span>:<button disabled={busy||!state?.connected} onClick={()=>void run(()=>window.portfolio!.updateWatchlist('add',symbol,''))}>Add</button>;
  const master=state?.master;
  return <>
    <section aria-label="Symbol list"><div className="section-head"><h2>Symbol list</h2><button disabled={busy||master?.refreshing} onClick={()=>void run(()=>window.portfolio!.refreshSecurityMaster())}>{master?.refreshing?'Downloading…':'Refresh symbol list'}</button></div>
      <p className="muted" title="KOSPI, KOSDAQ, NASDAQ, NYSE and AMEX, downloaded daily from KIS public master files.">{master?.total?`${master.total.toLocaleString()} listings · updated ${new Date(master.updatedAt!).toLocaleString()}`:'Downloading the symbol list…'}</p>
      {master?.error&&<p className="warning-text">Some markets could not be refreshed: {master.error}. Previous listings remain in use.</p>}
      <div className="search-row"><input aria-label="Search securities" placeholder="Company name, Korean code or U.S. ticker" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void run(()=>window.portfolio!.searchSecurities(query,queryMarket||null),data=>setResults(data as Security[]));}}/><select aria-label="Search market" value={queryMarket} onChange={e=>setQueryMarket(e.target.value)}><option value="">All markets</option><option value="KR">Korea</option><option value="US">U.S.</option></select><button className="primary" disabled={busy||!query.trim()} onClick={()=>void run(()=>window.portfolio!.searchSecurities(query,queryMarket||null),data=>setResults(data as Security[]))}>Search</button></div>
      {results&&(results.length?<table aria-label="Search results"><thead><tr><th>Symbol</th><th>Name</th><th>Market</th><th>Type</th><th/></tr></thead><tbody>{results.map(row=><tr key={row.symbol}><td><button className="link-button" onClick={()=>onOpenChart(row.symbol)}>{row.symbol}</button></td><td>{row.name}{row.englishName&&row.englishName!==row.name?<small> · {row.englishName}</small>:null}</td><td>{row.market}</td><td>{typeLabel[row.type]??row.type}</td><td>{addButton(row.symbol)}</td></tr>)}</tbody></table>:<p>No matching listings.</p>)}
    </section>
    <section aria-label="Market screener" aria-busy={screening}><div className="section-head"><h2>Market screener</h2>{screening?<small className="loading-label"><span className="spinner" aria-hidden="true"/>Loading…</small>:screened&&<small>Updated {new Date(screened.retrievedAt).toLocaleTimeString()}</small>}</div>
      <div className="settings-grid"><label>Market<select aria-label="Screener market" value={screen.market} onChange={e=>setScreen({...screen,market:e.target.value})}><option value="KR">Korea (KOSPI + KOSDAQ)</option><option value="US">U.S.</option></select></label>
        {screen.market==='US'&&<label>Exchange<select aria-label="Screener exchange" value={screen.exchange} onChange={e=>setScreen({...screen,exchange:e.target.value})}><option value="NASD">NASDAQ</option><option value="NYSE">NYSE</option><option value="AMEX">AMEX</option></select></label>}
        <label>Ranking<select aria-label="Screener ranking" value={screen.kind} onChange={e=>setScreen({...screen,kind:e.target.value})}><option value="volume">Trading volume</option><option value="gainers">Top gainers</option><option value="losers">Top losers</option><option value="market-cap">Market value</option></select></label>
        <label>Security type<select aria-label="Screener type" value={screen.type} onChange={e=>setScreen({...screen,type:e.target.value})}><option value="stock">Stocks</option><option value="etf">ETFs</option><option value="any">Any except warrants</option></select></label></div>
      {!connected?<p className="muted">Connect KIS in Connections to see market rankings.</p>:screenError&&!screening?<p className="warning-text">{screenError}</p>:null}
      {connected&&<div className={`screen-results ${screening?'loading':''}`}>
        {!screened&&screening?<div className="skeleton-table" aria-label="Loading rankings">{Array.from({length:6},(_,i)=><div key={i} className="skeleton-row"/>)}</div>:
        screened&&(screened.rows.length?<table aria-label="Screener results"><thead><tr><th>Symbol</th><th>Name</th><th>Price</th><th>Change</th><th>Volume</th><th>Market value</th><th/></tr></thead><tbody>{screened.rows.map(row=><tr key={row.symbol}><td><button className="link-button" onClick={()=>onOpenChart(row.symbol)}>{row.symbol}</button></td><td>{row.name}<small> · {typeLabel[row.type]??row.type}</small></td><td>{price(row.price,row.currency)}</td><td className={(row.changePct??0)>0?'positive':(row.changePct??0)<0?'negative':''}>{row.changePct==null?'—':`${row.changePct>0?'+':''}${row.changePct.toFixed(2)}%`}</td><td>{row.volume==null?'—':row.volume.toLocaleString()}</td><td>{compact(row.marketCap,row.currency)}</td><td>{addButton(row.symbol)}</td></tr>)}</tbody></table>:<p>No results match the selected type.</p>)}
        {screened&&screening&&<div className="loading-veil" aria-hidden="true"><span className="spinner"/></div>}
      </div>}
      <p className="muted small-print" title="Korean codes containing letters, such as some preferred shares, cannot be traded in this app and are left out.">KIS rankings, refreshed every minute. A ranking is not a trade signal.</p>
    </section>
    <section aria-label="Watchlist"><div className="section-head"><h2>Watchlist</h2><span className="badge">{state?.watchlist.length??0} / 30</span></div>
      <p className="muted" title="Watchlist symbols are quoted with your holdings (up to 20 per market). The AI may add up to 10 entries with a reason and replaces its oldest unpinned entry when full; it cannot remove yours. Your trading allowlist and caps still decide what can be ordered.">The AI reviews these with your holdings and can propose trades in them. Pin an AI pick to keep it.</p>
      {!state?.connected?<p>Connect your KIS account in Connections to keep a watchlist for it.</p>:state.watchlist.length?<table aria-label="Watchlist entries"><thead><tr><th>Symbol</th><th>Name</th><th>Added by</th><th>Reason</th><th/></tr></thead><tbody>{state.watchlist.map(row=><tr key={row.symbol}><td><button className="link-button" onClick={()=>onOpenChart(row.symbol)}>{row.symbol}</button></td><td>{row.name}<small> · {typeLabel[row.type]??row.type}</small></td><td>{row.source==='ai'?(row.pinned?'AI · pinned':'AI'):'You'}<br/><small>{new Date(row.addedAt).toLocaleDateString()}</small></td><td>{row.reason||'—'}</td><td className="row-actions">{row.source==='ai'&&<button disabled={busy} onClick={()=>void run(()=>window.portfolio!.updateWatchlist('pin',row.symbol,!row.pinned))}>{row.pinned?'Unpin':'Pin'}</button>}<button disabled={busy} aria-label={`Remove ${row.symbol}`} onClick={()=>void run(()=>window.portfolio!.updateWatchlist('remove',row.symbol))}>Remove</button></td></tr>)}</tbody></table>:<p>No symbols yet. Add from search or the screener, or let the agent suggest some during reviews.</p>}
    </section>
    {notice&&<div role="status" className="notice error">{notice}</div>}
  </>;
}
