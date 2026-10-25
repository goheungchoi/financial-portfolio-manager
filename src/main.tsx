import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {Toaster} from './Toast';
import {MarketStatus} from './MarketStatus';
import { holdings } from './domain.mjs';
import {CompanyView} from './CompanyView';
import {ExposurePanel} from './Exposure';
import {ChartWindow} from './ChartWindow';
import {MacroView,type MacroState} from './MacroView';
import {AiConsole} from './AiConsole';
import {AttentionPanel,AiActivity,useAttention} from './Dashboard';
import {AppUpdates,type UpdateState,type UpdateReply} from './AppUpdates';
import {ShortLeverage,type ExposureReply} from './ShortLeverage';
import {TaxLedger,type TaxSummary} from './TaxLedger';
import type { KisState } from './KisAccount';
import { Connections } from './Connections';
import { Discover, type DiscoveryReply } from './Discover';
import { AccountPerformance, type PerformanceReply } from './AccountPerformance';
import type { ScoreboardReply } from './Scoreboard';
import { ActivityReport, type ActivityReply } from './ActivityReport';
import { PaperTrading, type PaperReply } from './PaperTrading';
import { RuntimeSettings, type RuntimeReply, type RuntimeState, type RuntimeConfig, type DailyDigest } from './RuntimeSettings';
import {UnifiedPortfolio,type PortfolioState} from './UnifiedPortfolio';
import {TradingCosts,type CostSettings,type TaxProfile,type TaxProfileState} from './TradingCosts';
import {LiveTrading,type LiveReply} from './LiveTrading';
import {workspaceGroups,tabGuides,HOME,navLabels} from './WorkspaceUX';
import {HomeMetrics,HomeHoldings,HomeTrend,HomeCalendar,EmergencyBanner,usePortfolio} from './Home';
import {TopBar} from './Shell';
import './style.css';
import './themes.css';
import './polish.css';
type Theme = 'dark' | 'light';
type Holding = typeof holdings[number];
type Snapshot = { cash: number; holdings: Holding[] };
type MarketState = { revision:number; source:string; paused:boolean; status:string; environment?:string; timeBasis?:string; accountTimestamp?:string; connectionId?:number; stream?:{status:string;subscribed:number;retryInMs?:number}; error?:string|null; quotes:{symbol:string; price?:number; timestamp?:number; timeBasis?:string; stale:boolean}[]; snapshot:Snapshot };
type Interaction = { id: string; runId: string; timestamp: string; kind: string; title: string; body: string };
declare global { interface Window { portfolio?: {getPortfolio():Promise<PortfolioState>;getResearch(symbol:string,sections?:string[],refresh?:boolean):Promise<import('./ResearchPanel').ResearchProfile>;getSecContact():Promise<{email:string|null;fromFile:boolean;ready:boolean}>;setSecContact(email:string):Promise<{ok:boolean;error:string;state:{email:string|null;fromFile:boolean;ready:boolean}}>;testSec():Promise<{ok:boolean;error:string;name?:string;filings?:number;latestFiscalYear?:string|null}>;openFiling(url:string):Promise<void>;listReplays():Promise<{runs:unknown[];busy:boolean}>;runReplay(options:object):Promise<{ok:boolean;run?:unknown;error?:string}>;refreshNarrative():Promise<{ok:boolean;error?:string;state:import('./MarketNarrative').NarrativeState}>;hideNarrativeDriver(id:string,hidden:boolean):Promise<import('./MarketNarrative').NarrativeState>;getSuggestedFeeds():Promise<{label:string;url:string}[]>;cancelTrigger(id:string):Promise<import('./RuntimeSettings').DeskState>;deleteNote(symbol:string):Promise<import('./RuntimeSettings').DeskState>;cancelConditionalOrder(id:string):Promise<import('./RuntimeSettings').DeskState>;getWatchQuotes():Promise<Record<string,{price:number;previousClose:number|null;changePct:number|null;at:number|null;source:string}>>;getMarketOverview(refresh?:boolean):Promise<{status:string;retrievedAt?:number;data?:any;reason?:string}>;refreshPortfolio():Promise<PortfolioState>;setInstrumentMetadata(symbol:string,value:{sector:string;region:string}):Promise<PortfolioState>; getCosts():Promise<CostSettings>;saveCosts(value:CostSettings):Promise<CostSettings>;getTaxProfile():Promise<TaxProfileState>;saveTaxProfile(value:TaxProfile):Promise<TaxProfileState>;usAction(name:string,...args:unknown[]):Promise<LiveReply>; reconnectConnection(kind:'kis'|'providers'|'calendar'):Promise<RuntimeState>; forgetConnection(kind:'kis'|'providers'|'calendar'):Promise<RuntimeState>; exportJournal():Promise<void>; liveAction(name:string,...args:unknown[]):Promise<LiveReply>; getRuntime():Promise<RuntimeState>; startAutoTrading(token:string):Promise<RuntimeReply>; stopAutoTrading():Promise<RuntimeReply>; getCompany(symbol:string):Promise<any>;openChartWindow(symbol:string):Promise<boolean>;getMacro():Promise<MacroState>;getAttention():Promise<import('./Dashboard').Attention>;getUpdates():Promise<UpdateReply>;checkForUpdates():Promise<UpdateReply>;downloadUpdate():Promise<UpdateReply>;installUpdate():Promise<UpdateReply>;saveUpdateSettings(value:{checkAutomatically:boolean}):Promise<UpdateReply>;onUpdates(callback:(state:UpdateState)=>void):()=>void;getTaxSummary():Promise<TaxSummary>;getExposure():Promise<ExposureReply>;saveExposurePolicy(market:string,value:unknown):Promise<ExposureReply>;setProductOverride(symbol:string,factor:number|null):Promise<ExposureReply>;refreshCharges():Promise<TaxSummary>;refreshMacro():Promise<MacroState>; configureRuntime(value:Partial<RuntimeConfig>):Promise<RuntimeReply>; reviewRuntime():Promise<RuntimeReply>;dryRunEstimate():Promise<import('./Dashboard').DryRunEstimate>;dryRun(mode:'inputs'|'review'):Promise<{ok:boolean;error?:string;record?:import('./Dashboard').DryRunRecord;state?:RuntimeState}>; runScout():Promise<RuntimeReply>; importProviders():Promise<RuntimeReply>; refreshNews():Promise<RuntimeState>; resetReviewWatches():Promise<RuntimeState>;previewDigest():Promise<DailyDigest>;testPhoneSnapshot():Promise<{ok:boolean;error?:string}>;importCalendarKey():Promise<{ok:boolean;error?:string;state:RuntimeState}>;getMarketStatus():Promise<import('./MarketStatus').MarketStatusState>;getPerformance():Promise<PerformanceReply>;getScoreboard():Promise<ScoreboardReply>;refreshScoreboard():Promise<ScoreboardReply>;addCashFlow(value:{day:string;market:string;amount:number;note:string}):Promise<PerformanceReply>;removeCashFlow(id:string):Promise<PerformanceReply>;confirmCashFlow(id:string):Promise<PerformanceReply>;refreshBenchmarks():Promise<PerformanceReply>;getDiscovery():Promise<DiscoveryReply>;searchSecurities(query:string,market:string|null):Promise<DiscoveryReply>;screenMarket(query:{market:string;kind:string;type:string;limit:number;exchange?:string}):Promise<DiscoveryReply>;updateWatchlist(action:'add'|'remove'|'pin',symbol:string,value?:string|boolean):Promise<DiscoveryReply>;refreshSecurityMaster():Promise<DiscoveryReply>; approveLesson(id:string,approved:boolean):Promise<RuntimeReply>; lessonTrial(action:string,id:string,value?:unknown):Promise<RuntimeReply>; reviewLesson(id:string,value:{expectedSignature:string;action:string;note:string;applicability:string;days:number}):Promise<RuntimeReply>; getOutcomeHistory(id:string):Promise<import('./TradeOutcomes').TradeOutcome[]>; openNews(url:string):Promise<void>; getPaper():Promise<PaperReply>; configurePaperCaps(value:{maxOrderKRW:number|null;maxDailyTurnoverKRW:number|null;maxCompanyPct:number|null}):Promise<PaperReply>; configurePaperLoss(value:{mode:string;value:number}):Promise<PaperReply>; proposePaper(command:{symbol:string;side:string;quantity:number}):Promise<PaperReply>; submitPaper(id:string):Promise<PaperReply>; pausePaper(paused:boolean):Promise<PaperReply>; cancelPaper(id:string):Promise<PaperReply>; getActivity(kind:'orders'|'profit',startDate:string,endDate:string):Promise<ActivityReply>; getKis(): Promise<KisState>; importKis(): Promise<KisState>; refreshKis(): Promise<KisState>; disconnectKis(): Promise<KisState>; getMarket(): Promise<MarketState>; pauseFeed(paused:boolean): Promise<void>; getHistory(symbol:string,interval:string): Promise<import('./CandleChart').Candle[]>; onMarket(callback:(state:MarketState)=>void):()=>void; getSnapshot(): Promise<Snapshot>; getTheme(): Promise<Theme>; setTheme(theme: Theme): Promise<Theme>; onTheme(callback: (theme: Theme) => void): () => void; getEvents(): Promise<Interaction[]>; runDemo(): Promise<void>; onEvents(callback: (events: Interaction[]) => void): () => void } } }
const money = (value: number) => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);
const time = (value: string) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' });
function App() {
  const [chartSymbol,setChartSymbol]=useState<string|undefined>();const attention=useAttention();
  const [tab, setTab] = useState(location.hash === '#console' ? 'AI console' : HOME);
  // Page history: every page change is a history entry, so Back/Forward, Alt+arrows and the mouse side buttons work.
  const [place,setPlace]=useState({index:0,last:0});const placeRef=useRef(place);placeRef.current=place;
  const show=(name:string,symbol?:string)=>{if(name===tab&&symbol===chartSymbol)return;const index=placeRef.current.index+1;history.pushState({tab:name,symbol,index},'');setPlace({index,last:index});setChartSymbol(symbol);setTab(name);};
  const back=()=>{if(placeRef.current.index>0)history.back();};const forward=()=>{if(placeRef.current.index<placeRef.current.last)history.forward();};
  useEffect(()=>{
    history.replaceState({tab,index:0},'');
    const pop=(event:PopStateEvent)=>{const value=event.state;if(!value?.tab)return;setTab(value.tab);setChartSymbol(value.symbol);setPlace(current=>({index:value.index,last:current.last}));};
    const mouse=(event:MouseEvent)=>{if(event.button===3){event.preventDefault();back();}else if(event.button===4){event.preventDefault();forward();}};
    const keys=(event:KeyboardEvent)=>{if(event.altKey&&event.key==='ArrowLeft'){event.preventDefault();back();}else if(event.altKey&&event.key==='ArrowRight'){event.preventDefault();forward();}};
    addEventListener('popstate',pop);addEventListener('mouseup',mouse);addEventListener('keydown',keys);
    return()=>{removeEventListener('popstate',pop);removeEventListener('mouseup',mouse);removeEventListener('keydown',keys);};
  },[]);
  const openCompany=(symbol:string)=>show('Charts',symbol);
  const [portfolio,setPortfolio]=usePortfolio(tab===HOME);const [portfolioBusy,setPortfolioBusy]=useState(false);
  const refreshPortfolio=async()=>{setPortfolioBusy(true);try{const next=await window.portfolio?.refreshPortfolio();if(next)setPortfolio(next);}catch{setError('Could not refresh portfolio.');}finally{setPortfolioBusy(false);}};
  const go=(name:string)=>show(name==='KIS account'?'Connections':name);
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
  const account=tab==='Paper trading'?'Paper · KRW':isKis||kis.snapshot?`KIS ${kis.snapshot?.environment==='live'?'live':'mock'}`:'Not connected';
  return <div className="app"><TopBar tab={tab} canBack={place.index>0} canForward={place.index<place.last} onBack={back} onForward={forward} onNavigate={go} market={market} isKis={isKis} account={account} theme={theme} onTheme={()=>void toggleTheme()}/><aside><nav aria-label="Workspace">{workspaceGroups.map(group=><div className="nav-group" key={group.label}>{group.label&&<div className="nav-label">{group.label}</div>}{group.tabs.map(name=>{const badge=name==='Journal'?attention?.counts.lessons:name==='News'?attention?.counts.news:attention?.counts.approvals[name];return <div className="nav-row" key={name}><button data-tab={name} title={tabGuides[name].description} aria-current={tab===name?'page':undefined} className={tab===name?'nav active':'nav'} onClick={()=>show(name)}>{navLabels[name]??name}</button>{badge?<span className={`nav-badge ${attention?.counts.approvals[name]?'urgent':''}`} title={name==='Journal'?'Lessons to review':name==='News'?'Important disclosures today':'Orders waiting for approval'}>{badge}</span>:null}</div>;})}</div>)}</nav></aside><main><EmergencyBanner/>{tab===HOME&&<div className="home-page">{isKis&&portfolio&&<HomeMetrics state={portfolio}/>}{isKis&&<MarketStatus compact/>}{isKis&&<div className="home-row"><HomeTrend onOpen={()=>go('Performance')}/><HomeCalendar/></div>}<div className="dashboard-row"><AttentionPanel attention={attention} onNavigate={go}/><AiActivity onNavigate={go}/></div>{isKis&&portfolio&&<HomeHoldings state={portfolio} busy={portfolioBusy} onCompany={openCompany} onAll={()=>go('Holdings')} onRefresh={()=>void refreshPortfolio()}/>}</div>}{error && <div role="alert" className="notice error">{error}</div>}
  {[HOME,'Holdings','Charts'].includes(tab)&&!isKis&&<section className="connection-empty"><h2>{kis.status==='connecting'?'Connecting your portfolio…':'Connect your portfolio'}</h2><p>{kis.status==='connecting'?'Restoring your saved KIS connection.':'Connect a KIS account to see holdings, company information and prices.'}</p>{kis.status!=='connecting'&&<button className="primary" onClick={()=>go('Connections')}>Connect account</button>}<button onClick={()=>show('Paper trading')}>Open paper trading</button></section>}
  {tab === 'Holdings' && isKis && <ExposurePanel/>}{tab === 'Holdings' && isKis && <UnifiedPortfolio mode="holdings" onCompany={openCompany}/>}
  {tab === 'Charts' && isKis && <CompanyView initialSymbol={chartSymbol}/>}
  {tab === 'Discover' && <Discover onOpenChart={openCompany} onNavigate={go}/>}
  {tab === 'Macro' && <MacroView/>}
  {tab === 'Short & leverage' && <ShortLeverage/>}
  {tab === 'Connections' && <Connections kis={kis} kisBusy={kisBusy} onNavigate={go} onImport={()=>void kisAction('import')} onRefresh={()=>void kisAction('refresh')} onDisconnect={()=>void kisAction('disconnect')}/>}
  {tab === 'Connections' && <AppUpdates/>}
  {tab === 'Performance' && <AccountPerformance/>}
  {(tab === 'Activity' || tab === 'Performance') && <ActivityReport key={`${tab}:${market?.source}:${market?.connectionId}`} mode={tab==='Activity'?'orders':'profit'} connected={isKis} loadReport={(kind,start,end)=>window.portfolio?.getActivity(kind,start,end)??Promise.resolve({ok:false,error:'NOT_CONNECTED'})}/>} 
  {tab === 'Paper trading' && <PaperTrading/>}
  {tab === 'U.S. stocks' && <LiveTrading key={'us:'+market?.connectionId} market="US" draftKey={`us:${market?.connectionId??'disconnected'}`}/>}
  {tab === 'Fees & taxes' && <><TradingCosts/><TaxLedger/></>}
  {tab === 'KIS trading' && <LiveTrading key={market?.connectionId??'disconnected'} draftKey={`kis:${market?.connectionId??'disconnected'}`}/>}
  {['Journal','News','Engine settings'].includes(tab) && <RuntimeSettings key={tab} mode={tab==='News'?'news':tab==='Journal'?'journal':'settings'} onNavigate={go}/>}
  {tab === 'AI console' && <AiConsole events={events}/>}
  <Toaster/></main></div>;
}
// A '#chart:SYMBOL' page is a pop-out chart window rather than the full workspace.
const chartWindow=location.hash.startsWith('#chart:')?decodeURIComponent(location.hash.slice(7)):null;
createRoot(document.getElementById('root')!).render(<React.StrictMode>{chartWindow?<ChartWindow symbol={chartWindow}/>:<App/>}</React.StrictMode>);
