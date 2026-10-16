import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { holdings } from './domain.mjs';
import {CompanyView} from './CompanyView';
import type { KisState } from './KisAccount';
import { Connections } from './Connections';
import { Discover, type DiscoveryReply } from './Discover';
import { AccountPerformance, type PerformanceReply } from './AccountPerformance';
import type { ScoreboardReply } from './Scoreboard';
import { ActivityReport, type ActivityReply } from './ActivityReport';
import { PaperTrading, type PaperReply } from './PaperTrading';
import { RuntimeSettings, type RuntimeReply, type RuntimeState, type RuntimeConfig, type DailyDigest } from './RuntimeSettings';
import {UnifiedPortfolio,type PortfolioState} from './UnifiedPortfolio';
import {TradingCosts,type CostSettings} from './TradingCosts';
import {LiveTrading,type LiveReply} from './LiveTrading';
import {RuntimePulse,workspaceGroups,tabGuides} from './WorkspaceUX';
import './style.css';
import './themes.css';
type Theme = 'dark' | 'light';
type Holding = typeof holdings[number];
type Snapshot = { cash: number; holdings: Holding[] };
type MarketState = { revision:number; source:string; paused:boolean; status:string; environment?:string; timeBasis?:string; accountTimestamp?:string; connectionId?:number; stream?:{status:string;subscribed:number;retryInMs?:number}; error?:string|null; quotes:{symbol:string; price?:number; timestamp?:number; timeBasis?:string; stale:boolean}[]; snapshot:Snapshot };
type Interaction = { id: string; runId: string; timestamp: string; kind: string; title: string; body: string };
declare global { interface Window { portfolio?: {getPortfolio():Promise<PortfolioState>;refreshPortfolio():Promise<PortfolioState>;setInstrumentMetadata(symbol:string,value:{sector:string;region:string}):Promise<PortfolioState>; getCosts():Promise<CostSettings>;saveCosts(value:CostSettings):Promise<CostSettings>;usAction(name:string,...args:unknown[]):Promise<LiveReply>; reconnectConnection(kind:'kis'|'providers'):Promise<RuntimeState>; forgetConnection(kind:'kis'|'providers'):Promise<RuntimeState>; exportJournal():Promise<void>; liveAction(name:string,...args:unknown[]):Promise<LiveReply>; getRuntime():Promise<RuntimeState>; startAutoTrading(token:string):Promise<RuntimeReply>; stopAutoTrading():Promise<RuntimeReply>; getCompany(symbol:string):Promise<any>; configureRuntime(value:Partial<RuntimeConfig>):Promise<RuntimeReply>; reviewRuntime():Promise<RuntimeReply>; importProviders():Promise<RuntimeReply>; refreshNews():Promise<RuntimeState>; resetReviewWatches():Promise<RuntimeState>;previewDigest():Promise<DailyDigest>;getPerformance():Promise<PerformanceReply>;getScoreboard():Promise<ScoreboardReply>;refreshScoreboard():Promise<ScoreboardReply>;addCashFlow(value:{day:string;market:string;amount:number;note:string}):Promise<PerformanceReply>;removeCashFlow(id:string):Promise<PerformanceReply>;refreshBenchmarks():Promise<PerformanceReply>;getDiscovery():Promise<DiscoveryReply>;searchSecurities(query:string,market:string|null):Promise<DiscoveryReply>;screenMarket(query:{market:string;kind:string;type:string;limit:number;exchange?:string}):Promise<DiscoveryReply>;updateWatchlist(action:'add'|'remove'|'pin',symbol:string,value?:string|boolean):Promise<DiscoveryReply>;refreshSecurityMaster():Promise<DiscoveryReply>; approveLesson(id:string,approved:boolean):Promise<RuntimeReply>; lessonTrial(action:string,id:string,value?:unknown):Promise<RuntimeReply>; reviewLesson(id:string,value:{expectedSignature:string;action:string;note:string;applicability:string;days:number}):Promise<RuntimeReply>; getOutcomeHistory(id:string):Promise<import('./TradeOutcomes').TradeOutcome[]>; openNews(url:string):Promise<void>; getPaper():Promise<PaperReply>; configurePaperCaps(value:{maxOrderKRW:number|null;maxDailyTurnoverKRW:number|null;maxCompanyPct:number|null}):Promise<PaperReply>; configurePaperLoss(value:{mode:string;value:number}):Promise<PaperReply>; proposePaper(command:{symbol:string;side:string;quantity:number}):Promise<PaperReply>; submitPaper(id:string):Promise<PaperReply>; pausePaper(paused:boolean):Promise<PaperReply>; cancelPaper(id:string):Promise<PaperReply>; getActivity(kind:'orders'|'profit',startDate:string,endDate:string):Promise<ActivityReply>; getKis(): Promise<KisState>; importKis(): Promise<KisState>; refreshKis(): Promise<KisState>; disconnectKis(): Promise<KisState>; getMarket(): Promise<MarketState>; pauseFeed(paused:boolean): Promise<void>; getHistory(symbol:string,interval:string): Promise<import('./CandleChart').Candle[]>; onMarket(callback:(state:MarketState)=>void):()=>void; getSnapshot(): Promise<Snapshot>; getTheme(): Promise<Theme>; setTheme(theme: Theme): Promise<Theme>; onTheme(callback: (theme: Theme) => void): () => void; getEvents(): Promise<Interaction[]>; runDemo(): Promise<void>; onEvents(callback: (events: Interaction[]) => void): () => void } } }
const money = (value: number) => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);
const time = (value: string) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' });
function App() {
  const [chartSymbol,setChartSymbol]=useState<string|undefined>();
  const openCompany=(symbol:string)=>{setChartSymbol(symbol);setTab('Charts');};
  const [tab, setTab] = useState(location.hash === '#console' ? 'AI console' : 'Overview');
  const go=(name:string)=>{setChartSymbol(undefined);setTab(name==='KIS account'?'Connections':name);};
  const [theme, setTheme] = useState<Theme>('dark');
  const [market, setMarket] = useState<MarketState | null>(null);
  const [kis, setKis] = useState<KisState>({status:'disconnected',snapshot:null,error:null});
  const [kisBusy, setKisBusy] = useState(false);
  const [events, setEvents] = useState<Interaction[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [scroll, setScroll] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const api = window.portfolio;
    if (!api) {
      try { setTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark'); } catch {}
      return;
    }
    let alive = true;
    const off = api.onTheme(value => { if (alive) setTheme(value); });
    api.getTheme().then(value => { if (alive) setTheme(value); }).catch(() => setError('Could not load appearance settings.'));

    return () => { alive = false; off(); };
  }, []);
  useEffect(() => {
    const api = window.portfolio;
    if (!api) return;
    let alive = true;
    const accept = (value:MarketState) => { if (alive) { setMarket(current => current && current.revision > value.revision ? current : value); } };
    const off = api.onMarket(accept);
    api.getMarket().then(accept).catch(()=>setError('Could not load portfolio connection status.'));
    return () => { alive = false; off(); };
  }, []);
  const isKis=market?.source==='kis';
  useEffect(()=>{
    let alive=true;
    window.portfolio?.getKis().then(value=>{if(alive)setKis(value);}).catch(()=>{if(alive)setError('Could not load KIS connection status.');});
    return ()=>{alive=false;};
  },[]);
  useEffect(()=>{
    if(!window.portfolio)return;
    let alive=true;
    window.portfolio.getKis().then(value=>{if(alive)setKis(value);}).catch(()=>{});
    return ()=>{alive=false;};
  },[market?.revision]);
  async function kisAction(action:'import'|'refresh'|'disconnect') {
    const api=window.portfolio;
    if(!api){setError('KIS connection is available in the desktop app.');return;}
    setKisBusy(true);
    try {setKis(await (action==='import'?api.importKis():action==='refresh'?api.refreshKis():api.disconnectKis()));}
    catch {setError('KIS connection request failed.');}
    finally {setKisBusy(false);}
  }
  async function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    try {
      if (window.portfolio) await window.portfolio.setTheme(next);
      else { try { localStorage.setItem('theme', next); } catch {} }
      setTheme(next);
    } catch { setError('Could not save appearance settings.'); }
  }
  useEffect(() => {
    const api = window.portfolio;
    if (!api) return;
    let alive = true;
    // Subscribe first; the snapshot request is sent before any subsequent run request.
    const off = api.onEvents(value => { if (alive) setEvents(value); });
    api.getEvents().then(value => { if (alive) setEvents(current => current.length > value.length ? current : value); }).catch(() => setError('Could not load console events.'));
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => { if (scroll && tab === 'AI console') end.current?.scrollIntoView({ behavior: 'smooth' }); }, [events, scroll, tab]);
  const shown = events.filter(e => (filter === 'All' || e.kind === filter) && `${e.title} ${e.body} ${e.runId}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="app"><aside><div className="brand">◈ <span>Portfolio<br/><small>FINANCIAL MANAGER</small></span></div><nav aria-label="Workspace">{workspaceGroups.map(group=><div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div>{group.tabs.map(name=><button title={tabGuides[name].description} aria-current={tab===name?'page':undefined} className={tab===name?'nav active':'nav'} key={name} onClick={()=>{setChartSymbol(undefined);setTab(name);}}>{name}</button>)}</div>)}</nav><div className="sidebar-footer"><span className="dot"/> {isKis?'KIS account data':'Account not connected'}<br/><small>Portfolio monitor<br/>{isKis?'Session-gated broker':'No broker connected'}<br/>{market ? `Feed: ${market.status}` : 'Feed unavailable'}</small></div></aside><main><header><div><div className="eyebrow">YOUR INVESTMENT WORKSPACE</div><h1>{tab}</h1></div><div className="actions"><span className="badge">{tab === 'Paper trading' ? 'LOCAL PAPER · KRW' : isKis || tab === 'Connections' ? `KIS · ${kis.snapshot?.environment.toUpperCase() ?? 'READ ONLY'}` : 'NOT CONNECTED'}</span><div className="theme-control"><span className={theme === 'light' ? 'selected' : ''}>Light</span><button className="theme-switch" role="switch" aria-label="Dark mode" aria-checked={theme === 'dark'} onClick={toggleTheme}><span className="thumb" aria-hidden="true"/></button><span className={theme === 'dark' ? 'selected' : ''}>Dark</span></div></div></header><div className="page-guide"><details className="page-help"><summary>About this page</summary><p>{tabGuides[tab]?.description}</p><button onClick={()=>go(tabGuides[tab].target)}>{tabGuides[tab]?.next} →</button></details></div><RuntimePulse onNavigate={go} expanded={tab==='Overview'}/>{isKis&&['Overview','Holdings','Charts','Activity','Performance'].includes(tab) && <div className="market-bar"><div><span className={market?.status === 'connected' ? 'dot' : 'dot warning-dot'}/>{isKis ? `KIS WebSocket: ${market?.stream?.status ?? 'connecting'} · ${market?.stream?.subscribed ?? 0} subscriptions · REST fallback` : market ? 'Simulated market feed' : 'Static browser preview'} · {market?.status ?? 'offline'}<small>{market?.quotes[0]?.timestamp ? (isKis ? market?.quotes[0]?.timeBasis==='exchange'?'Last trade ':'Quote retrieved ' : 'Latest quote ') + time(new Date(market.quotes[0].timestamp).toISOString()) + ' KST' : 'Awaiting quotes'}{isKis && market?.accountTimestamp ? ' · Account sync ' + time(market.accountTimestamp) + ' KST' : ''}{market?.error ? ' · Last request failed' : ''}{market?.quotes.some(q=>q.stale) ? ' · Prices may be stale' : ''}</small></div></div>}{error && <div role="alert" className="notice error">{error}</div>}
  {tab === 'Overview' && isKis && <UnifiedPortfolio onCompany={openCompany}/>}
  {['Overview','Holdings','Charts'].includes(tab)&&!isKis&&<section className="connection-empty"><h2>{kis.status==='connecting'?'Connecting your portfolio…':'Connect your portfolio'}</h2><p>{kis.status==='connecting'?'Restoring your saved KIS connection.':'Connect a KIS account to see holdings, company information and prices.'}</p>{kis.status!=='connecting'&&<button className="primary" onClick={()=>go('Connections')}>Connect account</button>}<button onClick={()=>setTab('Paper trading')}>Open paper trading</button></section>}
  {tab === 'Holdings' && isKis && <UnifiedPortfolio mode="holdings" onCompany={openCompany}/>}
  {tab === 'Charts' && isKis && <CompanyView initialSymbol={chartSymbol}/>}
  {tab === 'Discover' && <Discover onOpenChart={openCompany}/>}
  {tab === 'Connections' && <Connections kis={kis} kisBusy={kisBusy} onNavigate={go} onImport={()=>void kisAction('import')} onRefresh={()=>void kisAction('refresh')} onDisconnect={()=>void kisAction('disconnect')}/>}
  {tab === 'Performance' && <AccountPerformance/>}
  {(tab === 'Activity' || tab === 'Performance') && <ActivityReport key={`${tab}:${market?.source}:${market?.connectionId}`} mode={tab==='Activity'?'orders':'profit'} connected={isKis} loadReport={(kind,start,end)=>window.portfolio?.getActivity(kind,start,end)??Promise.resolve({ok:false,error:'NOT_CONNECTED'})}/>} 
  {tab === 'Paper trading' && <PaperTrading/>}
  {tab === 'U.S. stocks' && <LiveTrading key={'us:'+market?.connectionId} market="US" draftKey={`us:${market?.connectionId??'disconnected'}`}/>}
  {tab === 'Fees & taxes' && <TradingCosts/>}
  {tab === 'KIS trading' && <LiveTrading key={market?.connectionId??'disconnected'} draftKey={`kis:${market?.connectionId??'disconnected'}`}/>}
  {['Journal','News','Engine settings'].includes(tab) && <RuntimeSettings key={tab} mode={tab==='News'?'news':tab==='Journal'?'journal':'settings'}/>}
  {tab === 'AI console' && <><div className="console-toolbar"><button onClick={()=>void window.portfolio?.exportJournal()}>Export interactions</button><input aria-label="Search interactions" placeholder="Search messages, context, or run ID…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Event type" value={filter} onChange={e=>setFilter(e.target.value)}>{['All','Program','Context','Tool','Agent','Risk','System'].map(v=><option key={v}>{v}</option>)}</select><button onClick={()=>setScroll(v=>!v)}>{scroll?'Pause auto-scroll':'Resume auto-scroll'}</button></div><p className="muted">Supplied context, decisions, risk results and tool interactions. Private internal reasoning is not displayed. {window.portfolio ? 'History is saved locally; the latest 600 events survive restarts.' : 'Browser preview history is temporary.'}</p><div className="timeline">{shown.length ? shown.map(e=><article key={e.id}><div className="event-meta"><span className="badge">{e.kind}</span><time>{time(e.timestamp)} KST</time><span>Run {e.runId.slice(0,8)}</span></div><h3>{e.title}</h3>{e.kind==='Context'?<details><summary>Inspect supplied context</summary><pre>{e.body}</pre></details>:<pre>{e.body}</pre>}</article>):<div className="empty">No matching interactions<br/><small>Completed reviews appear here. Run a portfolio review from Engine settings.</small></div>}<div ref={end}/></div></>}
  <footer>Financial Portfolio Manager · Portfolio workspace 1.1 · Session-gated execution</footer></main></div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
