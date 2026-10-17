import {useEffect,useRef,useState} from 'react';
import {useDraftState} from './useDraftState';
import {ScoutPanel} from './ScoutPanel';
import {MarketPulse} from './MarketPulse';
import {QuickLook} from './QuickLook';
import {MarketNarrative} from './MarketNarrative';
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
export function Discover({onOpenChart,onNavigate}:{onOpenChart(symbol:string):void;onNavigate(tab:string):void}){
  const [state,setState]=useState<DiscoveryState|null>(null);const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
  const [query,setQuery]=useDraftState('discover:query','');const [queryMarket,setQueryMarket]=useDraftState('discover:query-market','');const [results,setResults]=useState<Security[]|null>(null);
  const [screen,setScreen]=useDraftState('discover:screen',{market:'KR',exchange:'NASD',kind:'volume',type:'stock'});const [screened,setScreened]=useState<ScreenResult|null>(null);const [screening,setScreening]=useState(false);const [screenError,setScreenError]=useState('');const screenSeq=useRef(0);
  useEffect(()=>{let alive=true;const load=async()=>{try{const reply=await window.portfolio?.getDiscovery();if(alive&&reply)setState(reply.state);}catch{}};void load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  const connected=Boolean(state?.connected);
  const [peek,setPeek]=useState<{symbol:string;name:string}|null>(null);const [filter,setFilter]=useState('');const [sort,setSort]=useState<{key:keyof ScreenRow|'';dir:1|-1}>({key:'',dir:-1});const [reload,setReload]=useState(0);
  const [quotes,setQuotes]=useState<Record<string,{price:number;changePct:number|null;at:number|null}>>({});const [flash,setFlash]=useState<Record<string,'up'|'down'>>({});const [clock,setClock]=useState(Date.now());const lastPrice=useRef<Record<string,number>>({});
  // Prices that moved since the last update flash briefly, from watchlist quotes and screener refreshes alike.
  const mark=(prices:Record<string,number>)=>{const moved:Record<string,'up'|'down'>={};for(const [symbol,value] of Object.entries(prices)){const before=lastPrice.current[symbol];if(before!=null&&value!==before)moved[symbol]=value>before?'up':'down';lastPrice.current[symbol]=value;}
    if(Object.keys(moved).length){setFlash(f=>({...f,...moved}));setTimeout(()=>setFlash(f=>{const next={...f};for(const k of Object.keys(moved))delete next[k];return next;}),1400);}};
  useEffect(()=>{if(!connected||!window.portfolio)return;let alive=true;const load=async()=>{try{const q=await window.portfolio!.getWatchQuotes();if(!alive)return;setQuotes(q);mark(Object.fromEntries(Object.entries(q).map(([k,v])=>[k,v.price])));}catch{}};void load();const t=setInterval(load,4000);return()=>{alive=false;clearInterval(t);};},[connected]);
  useEffect(()=>{const t=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(screened)mark(Object.fromEntries(screened.rows.filter(r=>r.price!=null).map(r=>[r.symbol,r.price!])));},[screened]);
  // The screener reloads whenever a filter changes and every minute while this page is open; older replies are ignored.
  useEffect(()=>{
    if(!connected||!window.portfolio)return;let alive=true;
    const load=async()=>{const seq=++screenSeq.current;setScreening(true);setScreenError('');
      try{const reply=await window.portfolio!.screenMarket({market:screen.market,kind:screen.kind,type:screen.type,limit:30,...(screen.market==='US'?{exchange:screen.exchange}:{})});if(!alive||seq!==screenSeq.current)return;setState(reply.state);if(reply.ok)setScreened(reply.data as ScreenResult);else setScreenError(message(reply));}
      catch{if(alive&&seq===screenSeq.current)setScreenError('Could not reach the engine.');}
      finally{if(alive&&seq===screenSeq.current)setScreening(false);}};
    void load();const timer=setInterval(load,60000);return()=>{alive=false;clearInterval(timer);};
  },[connected,screen.market,screen.exchange,screen.kind,screen.type,reload]);
  if(!window.portfolio)return <section><p>Use the desktop app for market discovery.</p></section>;
  const run=async<T,>(task:()=>Promise<DiscoveryReply<T>|undefined>,done?:(data:T)=>void)=>{setBusy(true);setNotice('');try{const reply=await task();if(!reply)return;setState(reply.state);if(reply.ok)done?.(reply.data as T);else setNotice(message(reply));}catch{setNotice('Could not reach the engine.');}finally{setBusy(false);}};
  const listed=new Set(state?.watchlist.map(row=>row.symbol));
  const addButton=(symbol:string)=>listed.has(symbol)?<span className="badge">WATCHING</span>:<button disabled={busy||!state?.connected} onClick={()=>void run(()=>window.portfolio!.updateWatchlist('add',symbol,''))}>Add</button>;
  const master=state?.master;
  const needle=filter.trim().toLowerCase();
  const shownRows=(screened?.rows??[]).filter(r=>!needle||r.name.toLowerCase().includes(needle)||r.symbol.toLowerCase().includes(needle)||(r.englishName??'').toLowerCase().includes(needle)).sort((a,b)=>{if(!sort.key)return 0;const x=a[sort.key] as number|null,y=b[sort.key] as number|null;return x==null?1:y==null?-1:(x-y)*sort.dir;});
  const sortHead=(key:keyof ScreenRow,label:string)=><th aria-sort={sort.key===key?(sort.dir>0?'ascending':'descending'):'none'}><button className="sort-head" onClick={()=>setSort(s=>s.key===key?{key,dir:s.dir>0?-1:1}:{key,dir:-1})}>{label}{sort.key===key?(sort.dir>0?' ▲':' ▼'):''}</button></th>;
  // Day change as text plus a small bar centered on zero (±10% fills the bar).
  const changeCell=(v:number|null)=>v==null?'—':<span className={`change-cell ${v>0?'positive':v<0?'negative':''}`}><i className="change-bar"><i style={{width:`${Math.min(50,Math.abs(v)*5)}%`,[v>=0?'left':'right']:'50%'}}/></i>{`${v>0?'+':''}${v.toFixed(2)}%`}</span>;
  return <>
    {peek&&<QuickLook symbol={peek.symbol} name={peek.name} watching={listed.has(peek.symbol)} onClose={()=>setPeek(null)} onOpen={()=>onOpenChart(peek.symbol)} onWatch={()=>void run(()=>window.portfolio!.updateWatchlist('add',peek.symbol,''))}/>}
    <MarketPulse onOpenChart={onOpenChart}/>
    <MarketNarrative/>
    <section aria-label="Find a listing"><div className="section-head"><h2>Find a listing</h2></div>
      <div className="search-row"><input aria-label="Search securities" placeholder="Company name, Korean code or U.S. ticker" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void run(()=>window.portfolio!.searchSecurities(query,queryMarket||null),data=>setResults(data as Security[]));}}/><select aria-label="Search market" value={queryMarket} onChange={e=>setQueryMarket(e.target.value)}><option value="">All markets</option><option value="KR">Korea</option><option value="US">U.S.</option></select><button className="primary" disabled={busy||!query.trim()} onClick={()=>void run(()=>window.portfolio!.searchSecurities(query,queryMarket||null),data=>setResults(data as Security[]))}>Search</button></div>
      {results&&(results.length?<table aria-label="Search results"><thead><tr><th>Symbol</th><th>Name</th><th>Market</th><th>Type</th><th/></tr></thead><tbody>{results.map(row=><tr key={row.symbol}><td><button className="link-button" onClick={()=>onOpenChart(row.symbol)}>{row.symbol}</button></td><td><button className="link-button" onClick={()=>setPeek({symbol:row.symbol,name:row.name})}>{row.name}</button>{row.englishName&&row.englishName!==row.name?<small> · {row.englishName}</small>:null}</td><td>{row.market}</td><td>{typeLabel[row.type]??row.type}</td><td>{addButton(row.symbol)}</td></tr>)}</tbody></table>:<p>No matching listings.</p>)}
    </section>
    <section aria-label="Watchlist"><div className="section-head"><h2>Watchlist</h2><span className="badge">{state?.watchlist.length??0} / 30</span></div>
      <p className="muted" title="Watchlist symbols are quoted with your holdings (up to 20 per market). The AI may add up to 10 entries with a reason and replaces its oldest unpinned entry when full; it cannot remove yours. Your trading allowlist and caps still decide what can be ordered.">The AI reviews these with your holdings and can propose trades in them. Pin an AI pick to keep it.</p>
      {!state?.connected?<p>Connect your KIS account in Connections to keep a watchlist for it.</p>:state.watchlist.length?<table aria-label="Watchlist entries"><thead><tr><th>Symbol</th><th>Name</th><th>Price</th><th>Day</th><th>Added by</th><th>Reason</th><th/></tr></thead><tbody>{state.watchlist.map(row=>{const q=quotes[row.symbol];return <tr key={row.symbol} className={flash[row.symbol]?`flash-${flash[row.symbol]}`:''}><td><button className="link-button" onClick={()=>onOpenChart(row.symbol)}>{row.symbol}</button></td><td><button className="link-button" onClick={()=>setPeek({symbol:row.symbol,name:row.name})}>{row.name}</button><small> · {typeLabel[row.type]??row.type}</small></td><td className="live-price" title={q?.at?`Updated ${new Date(q.at).toLocaleTimeString()}`:'Not quoted yet'}>{q?price(q.price,row.symbol.includes(':')?'USD':'KRW'):'—'}</td><td>{changeCell(q?.changePct??null)}</td><td>{row.source==='ai'?(row.pinned?'AI · pinned':'AI'):'You'}<br/><small>{new Date(row.addedAt).toLocaleDateString()}</small></td><td>{row.reason||'—'}</td><td className="row-actions">{row.source==='ai'&&<button disabled={busy} onClick={()=>void run(()=>window.portfolio!.updateWatchlist('pin',row.symbol,!row.pinned))}>{row.pinned?'Unpin':'Pin'}</button>}<button disabled={busy} aria-label={`Remove ${row.symbol}`} onClick={()=>void run(()=>window.portfolio!.updateWatchlist('remove',row.symbol))}>Remove</button></td></tr>;})}</tbody></table>:<p>Add stocks from search or the screener.</p>}
    </section>
    <section aria-label="Market screener" aria-busy={screening}><div className="section-head"><h2>Market screener</h2>{screening?<small className="loading-label"><span className="spinner" aria-hidden="true"/>Loading…</small>:screened&&<small>Updated {new Date(screened.retrievedAt).toLocaleTimeString()} · next in {Math.max(0,Math.ceil((screened.retrievedAt+60000-clock)/1000))}s</small>}<button disabled={screening} onClick={()=>setReload(n=>n+1)}>Refresh</button></div>
      <div className="settings-grid"><label>Market<select aria-label="Screener market" value={screen.market} onChange={e=>setScreen({...screen,market:e.target.value})}><option value="KR">Korea (KOSPI + KOSDAQ)</option><option value="US">U.S.</option></select></label>
        {screen.market==='US'&&<label>Exchange<select aria-label="Screener exchange" value={screen.exchange} onChange={e=>setScreen({...screen,exchange:e.target.value})}><option value="NASD">NASDAQ</option><option value="NYSE">NYSE</option><option value="AMEX">AMEX</option></select></label>}
        <label>Ranking<select aria-label="Screener ranking" value={screen.kind} onChange={e=>setScreen({...screen,kind:e.target.value})}><option value="volume">Trading volume</option><option value="gainers">Top gainers</option><option value="losers">Top losers</option><option value="market-cap">Market value</option></select></label>
        <label>Security type<select aria-label="Screener type" value={screen.type} onChange={e=>setScreen({...screen,type:e.target.value})}><option value="stock">Stocks</option><option value="etf">ETFs</option><option value="any">Any except warrants</option></select></label></div>
      {connected&&screened&&<input className="screen-filter" aria-label="Filter screener results" placeholder="Filter by name or code" value={filter} onChange={e=>setFilter(e.target.value)}/>}
      {!connected?<p className="muted">Connect KIS in Connections to see market rankings.</p>:screenError&&!screening?<p className="warning-text">{screenError}</p>:null}
      {connected&&<div className={`screen-results ${screening?'loading':''}`}>
        {!screened&&screening?<div className="skeleton-table" aria-label="Loading rankings">{Array.from({length:6},(_,i)=><div key={i} className="skeleton-row"/>)}</div>:
        screened&&(shownRows.length?<table aria-label="Screener results"><thead><tr><th>Symbol</th><th>Name</th>{sortHead('price','Price')}{sortHead('changePct','Change')}{sortHead('volume','Volume')}{sortHead('marketCap','Market value')}<th/></tr></thead><tbody>{shownRows.map(row=><tr key={row.symbol} className={flash[row.symbol]?`flash-${flash[row.symbol]}`:''}><td><button className="link-button" onClick={()=>onOpenChart(row.symbol)}>{row.symbol}</button></td><td><button className="link-button" onClick={()=>setPeek({symbol:row.symbol,name:row.name})}>{row.name}</button><small> · {typeLabel[row.type]??row.type}</small></td><td>{price(row.price,row.currency)}</td><td>{changeCell(row.changePct)}</td><td>{row.volume==null?'—':row.volume.toLocaleString()}</td><td>{compact(row.marketCap,row.currency)}</td><td>{addButton(row.symbol)}</td></tr>)}</tbody></table>:<p>{filter?'No rows match the filter.':'No results match the selected type.'}</p>)}
        {screened&&screening&&<div className="loading-veil" aria-hidden="true"><span className="spinner"/></div>}
      </div>}
      <p className="muted small-print" title="Korean codes containing letters, such as some preferred shares, cannot be traded in this app and are left out.">KIS rankings, refreshed every minute. Click a column to sort and a name for a quick look. A ranking is not a trade signal.</p>
    </section>
    <ScoutPanel onOpenChart={onOpenChart} onNavigate={onNavigate}/>
    <section aria-label="Symbol list" className="discover-footer"><div className="section-head"><div><h2>Symbol list</h2><small className="muted" title="KOSPI, KOSDAQ, NASDAQ, NYSE and AMEX, downloaded daily from KIS public master files.">{master?.total?`${master.total.toLocaleString()} listings · updated ${new Date(master.updatedAt!).toLocaleString()}`:'Downloading the symbol list…'}</small></div><button disabled={busy||master?.refreshing} onClick={()=>void run(()=>window.portfolio!.refreshSecurityMaster())}>{master?.refreshing?'Downloading…':'Refresh symbol list'}</button></div>
      {master?.error&&<p className="warning-text">Some markets could not be refreshed: {master.error}. Previous listings remain in use.</p>}
    </section>
    {notice&&<div role="status" className="notice error">{notice}</div>}
  </>;
}
