const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu } = require('electron');
if(!process.env.PORTFOLIO_SMOKE_DATA&&!app.requestSingleInstanceLock()){app.quit();process.exit(0);}
let mainWindow=null;const chartWindows=new Map();
// How the app last stopped (restart part 1, step 1): this run's exit record and the previous run's stop.
let exitRecord=null,previousStop=null;
// The start notice (step 2): shown on Home until auto trading is started or it is dismissed.
let restartNotice=null,restartNoticeDismissed=false;
app.on('second-instance',()=>{const window=mainWindow&&!mainWindow.isDestroyed()?mainWindow:BrowserWindow.getAllWindows()[0];if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
const { PortfolioStore } = require('./storage.cjs');
const { KisService } = require('./kis-service.cjs');
const { buildKisMarket } = require('./kis-market.cjs');
const { PaperEngine } = require('./paper-engine.cjs');
const {LiveEngine}=require('./live-engine.cjs');
const {TradingCosts}=require('./trading-costs.cjs');
const {PortfolioView,combinePortfolio}=require('./portfolio-view.cjs');let usLive,costs,usSnapshot=null;let lastUSRefresh=0,usRefreshing=false;
const {Automation}=require('./automation.cjs');const {Notifications}=require('./notifications.cjs');
const providerService=new KisService('provider-worker.cjs');const calendarService=new KisService('calendar-worker.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const kisService = new KisService();
let streamState={status:'disconnected',subscribed:0};
kisService.onStatus=state=>{streamState={status:state.status,subscribed:state.subscribed,retryInMs:state.retryInMs};if(kisState.snapshot)broadcastMarket();};
// Live Charts: each window tells the app which symbol it shows. Korean symbols join the KIS stream (after holdings);
// U.S. symbols are polled every 10 seconds while a U.S. session the app can trade is open, and Korean ones too while the
// stream is not connected. Ticks go only to the windows showing that symbol; they do not feed the portfolio or reviews.
const chartWatch=new Map(),chartVolume=new Map();let chartStreamKey='',lastChartPoll=0,chartPolling=false;
const chartSymbols=()=>[...new Set(chartWatch.values())];
function sendChartTick(tick){for(const [id,symbol] of chartWatch){if(symbol!==tick.symbol)continue;const contents=require('electron').webContents.fromId(id);if(contents&&!contents.isDestroyed())contents.send('chart:tick',tick);}}
function syncChartStream(){const kr=chartSymbols().filter(s=>/^\d{6}$/.test(s)).slice(0,5);const key=kisService.generation+':'+kr.join(',');if(key===chartStreamKey||!kisState.snapshot)return;chartStreamKey=key;void kisService.request('chart-stream',{symbols:kr}).catch(()=>{chartStreamKey='';});}
async function pollCharts(){if(chartPolling)return;chartPolling=true;try{
  for(const symbol of chartSymbols().filter(s=>s.includes(':'))){if(!automation?.sessionOpen('US'))break;try{const q=await kisService.request('us-quote',{symbol,sessions:automation.sessionOptions()});if(q?.price>0)sendChartTick({symbol,price:q.price,timestamp:q.retrievedAt,session:q.session??null,source:'poll'});}catch{}}
  const kr=chartSymbols().filter(s=>/^\d{6}$/.test(s));if(kr.length&&streamState.status!=='connected'&&automation?.sessionOpen('KR')){try{for(const q of await kisService.request('quotes',{symbols:kr}))if(q?.price>0)sendChartTick({symbol:q.symbol,price:q.price,timestamp:q.retrievedAt,...(Number.isFinite(q.volume)?{dayVolume:q.volume}:{}),source:'poll'});}catch{}}
}finally{chartPolling=false;}}
kisService.onQuote=quote=>{
  // A charted symbol's trade goes to its chart; the day's volume so far also gives this trade's volume.
  if(chartWatch.size&&chartSymbols().includes(quote.symbol)){const before=chartVolume.get(quote.symbol);chartVolume.set(quote.symbol,quote.cumulativeVolume);
    sendChartTick({symbol:quote.symbol,price:quote.price,timestamp:quote.timestamp,dayVolume:quote.cumulativeVolume,volume:before!=null&&quote.cumulativeVolume>before?quote.cumulativeVolume-before:0,source:'stream'});}
  if(!kisState.snapshot?.holdings.some(row=>row.symbol===quote.symbol))return;
  const previous=kisQuotes.get(quote.symbol);
  if(previous?.source==='stream' && (quote.timestamp<previous.timestamp || quote.timestamp===previous.timestamp && quote.cumulativeVolume<=previous.cumulativeVolume))return;
  // Streamed ticks carry only the price; the previous close from the last REST quote is kept for day change.
  kisQuotes.set(quote.symbol,{symbol:quote.symbol,price:quote.price,timestamp:quote.timestamp,receivedAt:quote.receivedAt,cumulativeVolume:quote.cumulativeVolume,previousClose:previous?.previousClose??null,source:'stream'});
};
let kisState = {status:'disconnected',snapshot:null,error:null};
// D4 (settlement-check.cjs): which Korean reading is used while KIS moves last night's settlement. heldReading is the new
// KIS reading when the last consistent one is held in its place; settlementProvisional marks an overnight reading used
// because none is held (it never sets the record's high or low, or a graph point).
let balanceHold=null;
const useKr=snapshot=>{if(!balanceHold)return {snapshot};const r=balanceHold.accept(snapshot);return {snapshot:r.provisional?{...r.balance,settlementProvisional:r.reason}:r.balance,...(r.held?{heldReading:snapshot}:{})};};
// C1d-1 (W6): the same for U.S. readings while KIS moves a KRW-funded U.S. settlement (negative U.S. cash before the
// exchange). usHeldReading is the new reading while the last consistent one is used: it is still stored as evidence,
// and the settlement tracker, the loss check, the flow detector, the record and the graph never take it.
let usBalanceHold=null,usHeldReading=null;
// S3a (G2): engine is the balance the U.S. engine gets for this reading, from this one acceptance (a reading passes
// through accept once): while held, the last consistent reading marked settlementHeld; provisional, the reading marked
// settlementProvisional. LiveEngine.observeBalance takes neither (no risk balance, baseline or peak from them); the
// review context shows the accepted reading without the marks.
const useUs=snapshot=>{if(!usBalanceHold)return {snapshot,engine:snapshot};const r=usBalanceHold.accept(snapshot);const shown=r.provisional?{...r.balance,settlementProvisional:r.reason}:r.balance;
  return {snapshot:shown,engine:r.held?{...r.balance,settlementHeld:r.reason}:shown,...(r.held?{heldReading:snapshot}:{})};};
let kisBusy = false;
let kisGeneration=0;
let quoteBusy=false;
let nextQuoteAttempt=0;
let kisQuotes=new Map();
const kisHistory=new Map();
let quoteTimer;
let accountTimer;
function kisErrorCode(error) {
  const allowed=['INVALID_CREDENTIAL_FILE','INVALID_RESPONSE','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','INCOMPLETE_BALANCE','BROKER_UNAVAILABLE','BUSY','INCOMPLETE_HISTORY','INVALID_DATE_RANGE','FEATURE_UNAVAILABLE'];
  return allowed.includes(error?.message)?error.message:'REQUEST_FAILED';
}
let events = [];
let running = false;
let domain;
let store;
let paper;
let automation;let notifier;let agentBridge;let live;let remembered;let detectFlows=()=>{};let inFlightOf=()=>null;let fundingOf=()=>null;let lastInFlightReading=null;let newsBusy=false;let lastNews=0;let closing=false;let lastReconcile=0;
async function connectProviderFile(file,selectProvider=true){
  remembered.progress.providers='connecting';remembered.errors.providers=null;
  try{providerService.disconnect();const flags=await providerService.request('import',file);if(closing)return;automation.providerStatus=flags;if(flags.aiConnected&&selectProvider)automation.configure({provider:'openai'});remembered.remember('providers',file);remembered.progress.providers='connected';}
  catch{if(closing)return;providerService.disconnect();automation.providerStatus={aiConnected:false,openaiConnected:false,anthropicConnected:false,dartConnected:false,pushConnected:false};remembered.progress.providers='error';remembered.errors.providers='Could not reopen provider JSON. Reimport it if moved, deleted or invalid.';throw new Error('PROVIDER_IMPORT_FAILED');}
}
// Official Korean market calendar from a live key (read-only, calendar worker only); refreshed every 6 hours.
let calendarAt=0,calendarError=null;
async function refreshKrCalendar(){if(remembered?.progress.calendar!=='connected')return;try{const db=store.db;db.exec('CREATE TABLE IF NOT EXISTS kr_calendar(day TEXT PRIMARY KEY,open INTEGER NOT NULL,fetchedAt INTEGER NOT NULL)');
    const today=require('./kis-activity.cjs').seoulDate();const put=db.prepare('INSERT INTO kr_calendar VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET open=excluded.open,fetchedAt=excluded.fetchedAt');
    for(const start of [today,new Date(Date.parse(today+'T00:00:00Z')+24*86400000).toISOString().slice(0,10)]){const rows=await calendarService.request('kr-calendar',{day:start.replaceAll('-','')});for(const r of rows)put.run(r.day,r.open?1:0,Date.now());}
    calendarAt=Date.now();calendarError=null;}catch(error){calendarError=/^[A-Z_]{3,40}$/.test(error?.message??'')?error.message:'CALENDAR_FAILED';}}
const officialKrCalendar=()=>{try{const today=require('./kis-activity.cjs').seoulDate();return store.db.prepare('SELECT day,open FROM kr_calendar WHERE day>=? ORDER BY day').all(today);}catch{return [];}};
async function connectCalendarFile(file){
  remembered.progress.calendar='connecting';remembered.errors.calendar=null;
  try{calendarService.disconnect();await calendarService.request('import',file);if(closing)return;remembered.remember('calendar',file);remembered.progress.calendar='connected';await refreshKrCalendar();}
  catch(error){if(closing)return;calendarService.disconnect();remembered.progress.calendar='error';remembered.errors.calendar=error?.message==='CALENDAR_NEEDS_LIVE_KEY'?'This is a mock key. KIS offers the market calendar only to live keys.':'Could not open the calendar key. Reimport it if moved or invalid.';throw new Error('CALENDAR_IMPORT_FAILED');}
}
async function connectKisFile(file){
  kisBusy=true;live.stop();usLive?.stop();usSnapshot=null;if(usLive)usLive.refreshError=null;usHeldReading=null;const generation=++kisGeneration;remembered.progress.kis='connecting';remembered.errors.kis=null;streamState={status:'connecting',subscribed:0};nextQuoteAttempt=0;kisQuotes.clear();kisHistory.clear();kisService.disconnect();kisState={status:'connecting',snapshot:null,error:null};broadcastMarket();
  try{const snapshot=await kisService.request('import',file);if(closing||generation!==kisGeneration)return;kisState={status:'connected',...useKr(snapshot),error:null};remembered.remember('kis',file);remembered.progress.kis='connected';}
  catch(error){if(closing||generation!==kisGeneration)return;kisService.disconnect();kisState={status:'disconnected',snapshot:null,error:kisErrorCode(error)};remembered.progress.kis='error';remembered.errors.kis='Could not reconnect. Check the file location, credentials and network, or import again.';}
  finally{kisBusy=false;if(!closing){broadcastMarket();void pollKisQuotes();}}
}
function interaction(runId,kind,title,body) {
  if(closing)return;
  // A console entry must never fail the review that writes it: over-long text is shortened and storage errors are ignored.
  const fit=(text,limit)=>typeof text==='string'&&text.length>limit?text.slice(0,limit-60)+`… [shortened from ${text.length.toLocaleString('en-US')} characters]`:text;
  let tag=null;try{tag=automation?.accountTag?.()??null;}catch{}
  try{store.appendEvent({id:require('node:crypto').randomUUID(),runId,timestamp:new Date().toISOString(),kind,title:fit(title,500),body:fit(body,32000),...(tag?{account:tag.key,accountLabel:tag.label}:{})});}catch{return;}events=store.getEvents();
  for(const win of BrowserWindow.getAllWindows())win.webContents.send('events:changed',events);
}
async function refreshNews() {
  if(newsBusy)return;newsBusy=true;
  try {
    // Sources: your feeds, per-ticker headlines for U.S. names you hold or watch, KIS market headlines and DART filings.
    const news=require('./news.cjs');const cfg=automation.config;const sources=[];const offline=Boolean(process.env.PORTFOLIO_SMOKE_DATA);
    const feeds=[...new Set([...(cfg.newsFeeds??[]).map(f=>f.url),...(cfg.newsURL?[cfg.newsURL]:[])])];if(!offline)for(const url of feeds)sources.push([url,news.fetchFeed(url)]);
    if(cfg.usTickerNews&&!offline){const us=[...new Set([...(usSnapshot?.holdings??[]).map(h=>h.symbol),...(automation.discovery?.symbols('US')??[])])].slice(0,5);for(const symbol of us){const url=news.yahooFeed(symbol);if(url)sources.push([symbol,news.fetchFeed(url).then(items=>items.map(i=>({...i,symbols:[symbol]})))]);}}
    if(cfg.kisNews&&kisState.snapshot&&!kisService.isBusy)sources.push(['KIS news',kisService.request('news',{})]);
    if(automation.providerStatus.dartConnected)sources.push(['DART',providerService.request('disclosures',{seen:automation.newsEvents.receipts()})]);
    const results=await Promise.allSettled(sources.map(([,task])=>task));const items=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
    automation.newsSourceErrors=results.map((r,i)=>r.status==='rejected'?sources[i][0]:null).filter(Boolean);
    const failed=sources.length>0&&results.every(r=>r.status==='rejected');
    if(!failed){automation.news=[...new Map(items.map(item=>[item.url,item])).values()].sort((a,b)=>(Date.parse(b.published)||0)-(Date.parse(a.published)||0)).slice(0,200);automation.newsUpdatedAt=Date.now();automation.newsEvents.ingest(items,automation.relevantSecurities());}
    automation.newsError=failed?'NEWS_REFRESH_FAILED':null;
  }catch{automation.newsError='NEWS_REFRESH_FAILED';}finally{newsBusy=false;lastNews=Date.now();}
}
let marketProvider;
let marketCache;
let marketTimer;
let snapshotTimer;
let feedPaused = false;
let revision = 0;
function syntheticState() {
  const quotes = marketCache.snapshot();
  const saved = store.latestSnapshot();
  const snapshot = { ...saved, holdings:saved.holdings.map(row=>({...row,price:quotes.find(q=>q.symbol===row.symbol)?.price ?? row.price})) };
  return {revision:++revision,source:'synthetic',paused:feedPaused,status:feedPaused?'paused':quotes.some(q=>q.stale)?'stale':'connected',quotes,snapshot};
}
// Whether any session (regular or extended) of the scope's markets is open now: with none, old quotes are normal and the
// Market feed reads "Closed", not "Stale" (2026-11-19). null when it cannot be told.
function marketsOpenNow(){try{const S=require('./market-sessions.cjs'),H=require('./market-hours.cjs');const scope=automation?.config?.scope??'kis';const markets=H.marketsFor(scope).length?H.marketsFor(scope):['KR'];
    const closedDays=new Set([...(automation?.closedDays??[]),...(automation?.officialClosedDays?.()??[])]);return markets.some(m=>S.marketStatus(m,Date.now(),m==='KR'?{closedDays}:{}).open.length>0);}catch{return null;}}
function marketState() {return kisState.snapshot?{...buildKisMarket(kisState,kisQuotes),connectionId:kisGeneration,stream:streamState,marketsOpen:marketsOpenNow(),revision:++revision}:syntheticState();}
function broadcastMarket() {const state=marketState();for(const win of BrowserWindow.getAllWindows())win.webContents.send('market:changed',state);}
// Which request failed, when, and KIS's own code if it gave one, for the Market feed (2026-11-19: it said only
// "The last request failed" and "Reconnecting").
const failedRequest=(request,error)=>({errorRequest:request,errorAt:Date.now(),brokerCode:/^[A-Z0-9_-]{1,24}$/.test(error?.brokerCode??'')?error.brokerCode:null,brokerMessage:typeof error?.brokerMessage==='string'&&error.brokerMessage?error.brokerMessage.slice(0,120):null});
async function pollKisQuotes() {
  if(kisService.isBusy || kisBusy || quoteBusy || !kisState.snapshot || Date.now()<nextQuoteAttempt)return;
  quoteBusy=true;const generation=kisGeneration;
  try {
    const watched=automation?.watches.list(automation.watchScope()).map(row=>row.symbol).filter(symbol=>/^\d{6}$/.test(symbol))??[];const selected=live?.getState().policy?.symbols??[];
    const quotes=await kisService.request('quotes',{symbols:[...new Set([...watched,...selected,...kisState.snapshot.holdings.map(row=>row.symbol),...(automation?.discovery?.symbols('KR')??[])])].filter(symbol=>/^\d{6}$/.test(symbol)).slice(0,20)});
    if(generation===kisGeneration) {
      // A good poll clears an error the quote poll itself set; a balance error stays until the balance is read again.
      if(kisState.status==='error'&&kisState.errorRequest==='quotes')kisState={...kisState,status:'connected',error:null,errorRequest:null,errorAt:null,brokerCode:null,brokerMessage:null};
      for(const quote of quotes){const previous=kisQuotes.get(quote.symbol);if(previous?.source!=='stream' || Date.now()-previous.receivedAt>60000)kisQuotes.set(quote.symbol,{...quote,source:'rest'});else if(quote.previousClose)kisQuotes.set(quote.symbol,{...previous,previousClose:quote.previousClose});}
      broadcastMarket();
    }
  } catch(error) {if(generation===kisGeneration && kisState.snapshot){const code=kisErrorCode(error);if(code==='RATE_LIMITED')nextQuoteAttempt=Date.now()+120000;kisState={...kisState,status:'error',error:code,...failedRequest('quotes',error)};broadcastMarket();}}
  finally {quoteBusy=false;}
}
async function refreshKisBalance() {
  if(kisService.isBusy || kisBusy || !kisState.snapshot)return kisState;
  kisBusy=true;const generation=kisGeneration;
  try {
    const snapshot=await kisService.request('refresh');
    if(generation===kisGeneration){kisState={status:'connected',...useKr(snapshot),error:null};live?.observeBalance(snapshot);detectFlows();kisQuotes=new Map([...kisQuotes].filter(([symbol])=>snapshot.holdings.some(h=>h.symbol===symbol)));broadcastMarket();}
  } catch(error){if(generation===kisGeneration){kisState={...kisState,status:'error',error:kisErrorCode(error),...failedRequest('balance',error)};broadcastMarket();}}
  finally {kisBusy=false;}
  return kisState;
}
app.setName('Financial Portfolio Manager');
const verificationDirectory=process.argv.includes('--verify-build')?process.env.PORTFOLIO_VERIFY_DIR:null;
if(verificationDirectory){if(!path.isAbsolute(verificationDirectory))throw new Error('Absolute verification directory required');app.setPath('userData',verificationDirectory);}
// --verify-profile (with --verify-build): the directory holds a copied profile (fix review 2026-11-05). Its saved
// preferences are kept as they are, so instead of a saved setting that is off, the check asserts the runtime pause: auto
// trading not armed after the restart, broker execution off, the saved preference unchanged, and no order recorded or
// submitted during startup.
const verifyProfile=Boolean(verificationDirectory)&&process.argv.includes('--verify-profile');let verifyStart=null;
const profileRecord=()=>{const count=t=>{try{return store.db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;}catch{return null;}};let enabled=null;
  try{const row=store.db.prepare('SELECT payload FROM automation_settings WHERE id=1').get();enabled=row?JSON.parse(row.payload).enabled===true:false;}catch{enabled=false;}
  return {intents:count('live_intents'),orders:count('broker_orders'),enabled};};
const page = path.join(__dirname, '../dist/index.html');
const allowedURL = pathToFileURL(page).href;
function authorize(event) {
  if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('#')[0] !== allowedURL || !BrowserWindow.fromWebContents(event.sender)) throw new Error('Unauthorized IPC sender');
}
function createWindow() {
  const win = new BrowserWindow({ show:!verificationDirectory, width: 1360, height: 880, minWidth: 760, minHeight: 600, backgroundColor: store?.getTheme() === 'light' ? '#f3f6fa' : '#181818', title: 'Financial Portfolio Manager', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Windows ending the session (restart, shutdown, sign-out): one synchronous row write, before anything else. Nothing
  // here holds Windows back (no preventDefault). before-quit is not sent on a shutdown, so this is the only word.
  // query-session-end is a question (the shutdown can still be cancelled): a tentative stop; session-end confirms it.
  win.on('query-session-end',event=>{try{exitRecord?.stop('windows-shutdown',event?.reasons,true);}catch{}});
  win.on('session-end',event=>{try{exitRecord?.stop('windows-shutdown',event?.reasons);}catch{}
    // Best effort, after the row: one phone message straight to the webhook, not through the outbox. Nothing waits for
    // it; if it is not confirmed, the start notice tells the phone at the next start, with the real time.
    try{const N=require('./start-notice.cjs');let scope=null;try{scope=automation?.watchScope();}catch{}const message=N.sessionEndMessage({stops:N.armedStops(store.db,{scope}),running:require('./auto-launch.cjs').launchState(automation).running});
      if(message&&automation?.config.mobileAlerts&&automation.providerStatus?.pushConnected)void Promise.resolve(providerService.request('push',{message})).then(()=>{try{exitRecord?.markPhoneSent();}catch{}}).catch(()=>{});}catch{}});
  win.webContents.on('will-navigate', event => event.preventDefault());
  if(verificationDirectory)win.webContents.once('did-finish-load',async()=>{try{await new Promise(resolve=>setTimeout(resolve,200));const result=await win.webContents.executeJavaScript("Promise.all([document.querySelector('h1').textContent,typeof window.require,window.portfolio.getPaper(),window.portfolio.liveAction('get'),window.portfolio.getRuntime()])");if(result[0]!=='Home'||result[1]!=='undefined'||!result[2].data.account.paused||result[3].state.enabled||result[3].state.autoEnabled)throw 0;
    // A fresh profile has auto trading off; a copied one keeps its preference, and only the runtime pause is asserted.
    const runtime=result[4],end=verifyProfile?profileRecord():null;
    if(!verifyProfile&&runtime.config.enabled)throw 0;
    if(verifyProfile&&(runtime.sessionArmed!==false||runtime.config.enabled!==verifyStart.enabled||runtime.config.enabled&&runtime.scheduler?.label!=='Paused after restart'||end.intents!==verifyStart.intents||end.orders!==verifyStart.orders))throw 0;
    // The provider worker is forked from inside the app archive; an empty rate request proves it starts without network use.
    const rates=await providerService.request('fx-rates',{days:[]});if(!Array.isArray(rates))throw 0;
    if(verifyProfile)console.log(`Copied profile verified: saved auto trading preference kept (${verifyStart.enabled?'on':'off'}), paused after restart, broker execution off, no orders recorded or submitted (${end.intents} intents, ${end.orders} broker orders, as before).`);
    console.log('Portable build verified: renderer, private IPC, SQLite, paused paper engine, disabled broker automation and private worker process.');app.quit();}catch{console.error('Portable build verification failed.');app.exit(1);}});
  win.loadFile(page, { hash: 'overview' });
  // Pop-out chart windows belong to the main window and close with it.
  mainWindow=win;win.on('closed',()=>{if(mainWindow===win)mainWindow=null;for(const chart of chartWindows.values())if(!chart.isDestroyed())chart.close();});
  return win;
}
// One chart-only window per symbol, loading the same page so IPC authorization is unchanged.
function openChartWindow(symbol){
  const existing=chartWindows.get(symbol);if(existing&&!existing.isDestroyed()){if(existing.isMinimized())existing.restore();existing.focus();return existing;}
  const win=new BrowserWindow({show:!verificationDirectory,width:1040,height:780,minWidth:560,minHeight:480,backgroundColor:store?.getTheme()==='light'?'#f3f6fa':'#181818',title:symbol+' · Chart',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  win.removeMenu?.();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  chartWindows.set(symbol,win);win.on('closed',()=>{if(chartWindows.get(symbol)===win)chartWindows.delete(symbol);});
  win.loadFile(page,{hash:'chart:'+encodeURIComponent(symbol)});return win;
}
app.whenReady().then(async () => {
  domain = await import('../src/domain.mjs');
  store = new PortfolioStore(path.join(app.getPath('userData'), 'portfolio.sqlite'));if(verifyProfile)verifyStart=profileRecord();
  // The previous run's stop, then this run's record and its heartbeat (not during build or profile verification).
  if(!verificationDirectory){const {ExitRecord,lastStop}=require('./exit-record.cjs');exitRecord=new ExitRecord(store.db);previousStop=lastStop(exitRecord.begin());setInterval(()=>{let scope=null;try{scope=automation?.watchScope();}catch{}exitRecord.heartbeat(scope);},60000).unref();}
  remembered=new (require('./remembered-files.cjs').RememberedFiles)(store.db);
  events = store.getEvents();
  if (!store.latestSnapshot()) store.saveSnapshot({timestamp:new Date().toISOString(), cash:domain.cash, holdings:domain.holdings});
  const market = await import('../src/market.mjs');
  marketCache = new market.MarketCache(store.latestSnapshot().holdings.map(row=>row.symbol));
  marketProvider = new market.SyntheticMarketProvider(store.latestSnapshot().holdings);
  const startFeed = () => marketProvider.start(quote=>marketCache.accept(quote));
  const publishMarket = () => {
    // A restarted worker (a new connection) gets the charted symbols again.
    if(chartWatch.size)syncChartStream();
    if(chartWatch.size&&kisState.snapshot&&!kisService.isBusy&&Date.now()-lastChartPoll>=10000){lastChartPoll=Date.now();void pollCharts();}
    paper?.tick();
    automation?.tick();if(notifier){notifier.observe([...paper.orders(),...live.orders(),...(usLive?.orders()??[])]);void notifier.tick();}
    if(kisState.snapshot && !kisService.isBusy && !live.busy && Date.now()-lastReconcile>30000){lastReconcile=Date.now();void live.reconcile().catch(()=>{}).finally(()=>automation?.observeReconcile('KR',live.reconcileHealth));if(usSnapshot)void usLive.reconcile().catch(()=>{}).finally(()=>automation?.observeReconcile('US',usLive.reconcileHealth));}
    if(kisState.snapshot&&!kisService.isBusy&&!usRefreshing&&Date.now()>(kisService.cooldownUntil??0)&&Date.now()-lastUSRefresh>60000){lastUSRefresh=Date.now();usRefreshing=true;void automation.refreshUS().catch(error=>{usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);usLive.brokerCode=/^[A-Z0-9_-]{1,24}$/.test(error.brokerCode??'')?error.brokerCode:null;}).finally(()=>{usRefreshing=false;});}
    if(automation && Date.now()-lastNews>(automation.config.enabled&&automation.config.newsTrigger!=='off'?300000:1800000) && (automation.config.newsURL||automation.config.newsFeeds?.length||automation.config.kisNews||automation.providerStatus.dartConnected))void refreshNews();
    const state = marketState();
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('market:changed',state);
  };
  startFeed();
  paper=new PaperEngine(store.db,domain.holdings,()=>marketCache.snapshot());
  automation=new Automation(store.db,paper,providerService,interaction);
  live=new LiveEngine(store.db,kisService,()=>kisState);automation.live=live;
  balanceHold=new (require('./settlement-check.cjs').BalanceHold)({log:(title,body)=>{try{automation.log('kis-balance-'+Date.now(),'System',title,body);}catch{}}});live.balanceHold=balanceHold;
  usBalanceHold=new (require('./settlement-check.cjs').UsBalanceHold)({log:(title,body)=>{try{automation.log('kis-us-balance-'+Date.now(),'System',title,body);}catch{}}});
  costs=new TradingCosts(store.db);live.costs=costs;automation.costs=costs;
  // Tax figures cover the connected live account (and accounts the user links as the same owner).
  costs.currentAccount=()=>kisState.snapshot?.accountKey?{accountKey:kisState.snapshot.accountKey,environment:kisState.snapshot.environment}:null;
  costs.krClosed=()=>new Set(automation.officialClosedDays?.()??[]);costs.marketRate=()=>usSnapshot?.fx?.usdKRW??null;costs.holdings=()=>kisState.snapshot&&usSnapshot?.accountKey===kisState.snapshot.accountKey+':US'?usSnapshot.holdings:null;
  // Leveraged/inverse products, margin and short policy per account.
  const exposure=new (require("./exposure.cjs").Exposure)(store.db);live.exposure=exposure;
  const usBroker={request:(operation,payload)=>kisService.request(operation==='live-context'?'us-context':'us-'+operation,payload),hold:(fn,options)=>kisService.hold(fn,options),ahead:()=>kisService.ahead()};
  // F3 (2026-11-18 order not sent): an order's hold on the KIS queue released by its 30-second limit is logged.
  // B(1): each failed KIS request's record (kis-service.cjs noteFailure) is stored; the last 200 are kept.
  {const db=store.db;try{db.exec('CREATE TABLE IF NOT EXISTS kis_failures(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,payload TEXT NOT NULL)');}catch{}
    kisService.onFailure=record=>{try{db.prepare('INSERT INTO kis_failures(at,payload) VALUES(?,?)').run(record.at,JSON.stringify(record));db.prepare('DELETE FROM kis_failures WHERE id<=(SELECT max(id)-200 FROM kis_failures)').run();}catch{}};}
  kisService.onHoldLimit=({label,heldMs,limitMs})=>{try{automation.log(require('node:crypto').randomUUID(),'System','KIS queue released by its limit',`The order ${label} held the KIS request queue for ${Math.round(heldMs/1000)} s; after ${Math.round(limitMs/1000)} s the queue was released for other requests. The order's remaining requests wait in line.`);}catch{}};
  // Which part of unsettled U.S. buys is known to be KRW-funded, tracked across U.S. balance readings.
  const funding=new (require('./integrated-settlement.cjs').FundingTracker)(store.db);
  usLive=new LiveEngine(store.db,usBroker,()=>({snapshot:kisState.snapshot&&usSnapshot?.accountKey===kisState.snapshot.accountKey+':US'?usSnapshot:null}),{market:'US'});
  usLive.annotateBalance=balance=>funding.annotate(balance,automation.fx?.()?.usdKRW??null);
  // S3a (G2, R3): a reading the U.S. engine reads itself (the order path) passes through the same hold once.
  usLive.acceptReading=balance=>useUs(balance).engine;
  // U.S. buying power capped at real cash: USD, plus settled KRW when integrated margin is on (one pool shared with Korea).
  live.sessionOptions=usLive.sessionOptions=()=>automation.sessionOptions();live.extendedMaxOrderPct=usLive.extendedMaxOrderPct=()=>automation.config.extendedMaxOrderPct;
  // M-6: several open orders, the user's saved switch (default off), read by both engines at every use.
  live.severalOpenSetting=usLive.severalOpenSetting=()=>automation.config.severalOpenOrders===true;
  usLive.buyingPower=balance=>require('./buying-power.cjs').usBuyingPower({usdCash:balance?.cash??0,broker:balance?.brokerBuyingPower??null,krwCash:kisState.snapshot?(Number.isFinite(kisState.snapshot.settledCash)?kisState.snapshot.settledCash:kisState.snapshot.cash):null,usdKRW:balance?.fx?.usdKRW??automation?.fx?.()?.usdKRW??null});usLive.costs=costs;usLive.exposure=exposure;automation.usLive=usLive;
  // The Korean balance the app holds, for the won-rule room the reviews read (live-engine wonRule; no KIS request).
  usLive.krReading=()=>kisState.snapshot??null;
  // One funding ledger for both markets' buys (electron/funding-ledger.cjs): checked under one lock against balances read
  // fresh for the check, with the rate read within two minutes; no funding regime is verified, so the shared-pool rule applies.
  const fundingLedger=new (require('./funding-ledger.cjs').FundingLedger)(store.db,{fresh:async market=>{if(market==='KR'){await refreshKisBalance();return kisState.snapshot??null;}try{await automation.refreshUS?.();}catch{}const u=usHeldReading??usSnapshot;return kisState.snapshot&&u?.accountKey===kisState.snapshot.accountKey+':US'?u:null;},
    // F2 (2026-11-18 order not sent): the other market's balance alone, read before an order's broker check. Korea: the
    // balance refresh, which reads the balance only. U.S.: us-balance (no quotes), kept apart from the stored reading:
    // it goes to this check only. It is not passed through the settlement hold or the funding tracker, not stored, and
    // the U.S. snapshot, its quotes and their time stay as the last full read left them. The check takes what it took
    // before: the new reading itself (fresh above gives the held raw reading when a settlement hold is on). A failed
    // read gives the stored reading, as fresh does, and the two-minute rule decides.
    balance:async market=>{if(market==='KR'){await refreshKisBalance();return kisState.snapshot??null;}
      const stored=()=>{const u=usHeldReading??usSnapshot;return kisState.snapshot&&u?.accountKey===kisState.snapshot.accountKey+':US'?u:null;};
      if(!kisState.snapshot)return null;const generation=kisGeneration;
      try{const b=await kisService.request('us-balance');return generation===kisGeneration&&b?.accountKey===kisState.snapshot?.accountKey+':US'?b:stored();}catch{return stored();}},
    fx:()=>automation.fx?.()??null,alert:(title,message)=>automation.log(require('node:crypto').randomUUID(),'System',title,message)});
  fundingLedger.init();live.funding=usLive.funding=fundingLedger;automation.fundingState=()=>kisState.snapshot?.accountKey?fundingLedger.summary(kisState.snapshot.accountKey):null;
  let usRefreshTask=null,usRefreshGeneration=-1;
  automation.refreshUS=()=>{if(usRefreshTask&&usRefreshGeneration===kisGeneration)return usRefreshTask;const generation=kisGeneration;usRefreshGeneration=generation;lastUSRefresh=Date.now();const task=(async()=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');const selected=usLive.getState().policy?.symbols??[];const watched=automation.watches.list(automation.watchScope()).map(row=>row.symbol).filter(symbol=>/^(NASD|NYSE|AMEX):/.test(symbol));const listedUS=automation.discovery?.symbols('US')??[];// Review watches are price alerts on symbols already reviewed; only the watchlist, allowlist or holdings replace starters.
    const starterUS=await usStarters.symbols({scope:watchScope(),watched:listedUS,allowed:selected,holdings:(usSnapshot?.holdings??[]).map(row=>row.symbol)}).catch(()=>[]);const listed=[...new Set([...listedUS,...starterUS,...(()=>{try{return scoutTargets('US');}catch{return [];}})()])];const symbols=watched.length||listed.length?[...new Set([...watched,...(selected.length?selected:(usSnapshot?.holdings??[]).map(row=>row.symbol)),...listed])].slice(0,20):selected;
      // Session switches go along so an enabled U.S. extended session counts as open for the review.
      const value=await kisService.request('us-context',{symbols,sessions:automation.sessionOptions()});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');if(!value.balance||value.balance.accountKey!==kisState.snapshot?.accountKey+':US')throw new Error('ACCOUNT_CHANGED');const h=useUs(value.balance);usSnapshot=h.snapshot;usHeldReading=h.heldReading??null;usLive.refreshWarnings=value.warnings??[];usLive.refreshError=null;usLive.brokerCode=null;usLive.httpStatus=null;automation.acceptUSQuotes(value);usLive.observeBalance(h.engine);detectFlows();
      // S3a (G2, R3/R4): the callers (usLive.context for the reviews) get this acceptance's balance, never the raw reading.
      return {...value,balance:h.engine};})().catch(error=>{if(generation===kisGeneration){usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);usLive.brokerCode=/^[A-Z0-9_-]{1,24}$/.test(error.brokerCode??'')?error.brokerCode:null;usLive.httpStatus=Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?error.httpStatus:null;}throw error;}).finally(()=>{if(usRefreshTask===task)usRefreshTask=null;});usRefreshTask=task;return task;};
  const portfolioView=new PortfolioView(store.db);automation.metadata=()=>portfolioView.metadata();automation.fx=()=>usSnapshot?.fx??(costs.get().usdKRW?{usdKRW:costs.get().usdKRW,source:'User indicative rate',timestamp:null}:null);
  const portfolioState=()=>{const kr=kisState.snapshot?{...kisState.snapshot,holdings:buildKisMarket(kisState,kisQuotes).snapshot.holdings}:null;return {...combinePortfolio(kr,usSnapshot,automation.fx(),portfolioView.metadata(),{inFlight:kisState.snapshot?.accountKey?inFlightOf(kisState.snapshot.accountKey):null,funding:kisState.snapshot?.accountKey?fundingOf(kisState.snapshot.accountKey):null}),valuationSample:Math.floor(Date.now()/1000),lastComplete:(()=>{try{const a=kisState.snapshot?.accountKey;const r=a?performance.history(a).filter(x=>Number.isFinite(x.equityKRW)&&(!x.valuation||x.valuation.scope?.length===2)).at(-1):null;return r?{value:r.equityKRW,at:r.at,day:r.day}:null;}catch{return null;}})(),sessions:{KR:live.enabled,US:usLive.enabled},usError:usLive.refreshError??null,brokerCode:usLive.brokerCode??null,httpStatus:usLive.httpStatus??null,warnings:usLive.refreshWarnings??[]};};
  const companyCache=new Map();let companyBusy=false;
  ipcMain.handle('chart:pop-out',(event,symbol)=>{authorize(event);if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))throw new Error('INVALID_REQUEST');openChartWindow(symbol);return true;});
  // Bars for the Charts technical summary, kept for a minute per symbol; the daily bars come with the company view.
  const barsCache=new Map();
  ipcMain.handle('chart:watch',(event,symbol)=>{authorize(event);const id=event.sender.id;
    if(symbol==null)chartWatch.delete(id);else{if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))throw new Error('INVALID_REQUEST');
      if(!chartWatch.has(id))event.sender.once('destroyed',()=>{chartWatch.delete(id);syncChartStream();});chartWatch.set(id,symbol);lastChartPoll=0;}
    syncChartStream();return true;});
  ipcMain.handle('chart:bars',async(event,symbol)=>{authorize(event);if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))return {error:'INVALID_REQUEST'};if(!kisState.snapshot)return {error:'KIS_NOT_CONNECTED'};
    const generation=kisGeneration,key=generation+':'+symbol,cached=barsCache.get(key);if(cached&&Date.now()-cached.timestamp<60000)return cached.value;
    try{const value=await kisService.request('chart-bars',{request:{symbol}});if(generation!==kisGeneration)return {error:'ACCOUNT_CHANGED'};if(barsCache.size>20)barsCache.clear();barsCache.set(key,{timestamp:Date.now(),value});return value;}
    catch(error){return {error:kisErrorCode(error)};}});
  ipcMain.handle('company:get',async(event,symbol)=>{authorize(event);if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))return {error:'Enter a six-digit Korean code or exchange:ticker, such as NASD:AAPL.'};if(!kisState.snapshot)return {error:'Connect your KIS account first.'};const generation=kisGeneration,key=generation+':'+symbol,cached=companyCache.get(key);if(cached&&Date.now()-cached.timestamp<30000)return cached.value;if(companyBusy)return {error:'Another company request is loading. Please retry.'};companyBusy=true;
    try{const value={symbol};for(const [name,dataset] of [['company','company'],['daily','daily_technicals'],['minute','minute_technicals']]){try{value[name]=await kisService.request('company-chart',{request:{symbol,dataset}});}catch{value[name]={status:'unavailable'};}}if(generation!==kisGeneration)return {error:'Account changed. Refresh the company view.'};if(companyCache.size>30)companyCache.clear();companyCache.set(key,{timestamp:Date.now(),value});return value;}finally{companyBusy=false;}
  });
  ipcMain.handle('portfolio:get',event=>{authorize(event);return portfolioState();});
  ipcMain.handle('portfolio:metadata',(event,symbol,value)=>{authorize(event);portfolioView.save(symbol,value);return portfolioState();});
  ipcMain.handle('portfolio:refresh',async event=>{authorize(event);await refreshKisBalance();if(kisState.snapshot){try{await automation.refreshUS();}catch(error){usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);}}return portfolioState();});
  const exposureState=()=>{const accounts={KR:kisState.snapshot?.accountKey??null,US:usSnapshot?.accountKey&&kisState.snapshot&&usSnapshot.accountKey===kisState.snapshot.accountKey+':US'?usSnapshot.accountKey:null};
    const market=(key,snapshot)=>accounts[key]?{account:true,policy:exposure.policy(accounts[key]),summary:exposure.summary(snapshot?.holdings??[],snapshot?.reportedTotal??0,Date.now(),symbol=>(key==='KR'?live:usLive).firstBought(symbol)),...(key==='KR'?{credit:exposure.creditRisk(accounts.KR,snapshot??{},require('./kis-activity.cjs').seoulDate()),creditPaths:Object.fromEntries(['margin-buy','margin-sell','short','cover'].map(k=>[k,require('./credit-paths.cjs').pathStatus(k,{approved:automation.config.creditProtectionApproved===true})]))}:{})}:{account:false};
    return {markets:{KR:market('KR',kisState.snapshot),US:market('US',usSnapshot)},overrides:exposure.overrides(),kinds:exposure.kindOverrides(),environment:kisState.snapshot?.environment??null};};
  const exposureAction=action=>async(event,...args)=>{authorize(event);try{await action(...args);return {ok:true,state:exposureState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED',state:exposureState()};}};
  ipcMain.handle('exposure:get',exposureAction(()=>{}));
  ipcMain.handle('exposure:save-policy',exposureAction((market,value)=>{const account=exposureState().markets[market]?.account?(market==='KR'?kisState.snapshot.accountKey:usSnapshot.accountKey):null;if(!account)throw new Error('KIS_NOT_CONNECTED');if(market==='US'&&value&&(value.margin||value.short))throw new Error('FEATURE_UNAVAILABLE');exposure.savePolicy(account,value);}));
  ipcMain.handle('exposure:set-override',exposureAction((symbol,factor)=>exposure.setOverride(symbol,factor)));
  ipcMain.handle('exposure:set-single-stock',exposureAction((symbol,value)=>exposure.setSingleStock(symbol,value)));
  ipcMain.handle('costs:get',event=>{authorize(event);return costs.saved();});
  ipcMain.handle('costs:save',(event,value)=>{authorize(event);return costs.save(value);});
  ipcMain.handle('costs:add-income',(event,value)=>{authorize(event);costs.addIncome(value);return costs.taxSummary();});
  ipcMain.handle('costs:remove-income',(event,id)=>{authorize(event);costs.income.remove(id);return costs.taxSummary();});
  ipcMain.handle('costs:declare-income',(event,year,value)=>{authorize(event);costs.income.declare(year,value);return costs.taxSummary();});
  ipcMain.handle('costs:fund-class',(event,symbol,value)=>{authorize(event);costs.setFundClass(symbol,value);return costs.taxSummary();});
  ipcMain.handle('costs:add-opening-lot',(event,value)=>{authorize(event);costs.addOpeningLot(value);return costs.taxSummary();});
  ipcMain.handle('costs:remove-opening-lot',(event,id)=>{authorize(event);costs.removeOpeningLot(id);return costs.taxSummary();});
  ipcMain.handle('costs:tax-profile',event=>{authorize(event);return {profile:costs.profile.get(),account:costs.currentAccount()?{accountKey:require('./tax-profile.cjs').ownerAccount(costs.currentAccount().accountKey),environment:costs.currentAccount().environment}:null};});
  ipcMain.handle('costs:save-tax-profile',(event,value)=>{authorize(event);costs.profile.save(value);return {profile:costs.profile.get(),account:costs.currentAccount()?{accountKey:require('./tax-profile.cjs').ownerAccount(costs.currentAccount().accountKey),environment:costs.currentAccount().environment}:null};});
  for(const name of ['get','refresh','configure','stop','auto','auto-off','propose','submit','reconcile','link'])ipcMain.handle('us:'+name,async(event,...args)=>{authorize(event);try{let data;if(name==='get')data=null;else if(name==='refresh'){if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');await automation.refreshUS();data=null;}else if(name==='auto-off'){usLive.autoEnabled=false;}else if(name==='auto')data=usLive.enableAuto(...args);else if(name==='link')data=await usLive.linkUncertain(...args);else{data=await (name==='propose'?usLive.propose(args[0],{ticket:true}):usLive[name](...args));if(name==='propose'&&data?.id)data=usLive.annotate(data.id,{madeBy:'ticket'})??data;}return {ok:true,data,state:usLive.getState()};}catch(error){if(name==='refresh'){usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);usLive.brokerCode=/^[A-Z0-9_-]{1,24}$/.test(error.brokerCode??'')?error.brokerCode:null;}const allowed=['NO_FUNDED_BALANCE','LEVERAGED_NOT_ENABLED','SINGLE_STOCK_LEVERAGED','LEVERAGED_EXPOSURE_LIMIT','KIS_NOT_CONNECTED','ACTIVATION_REQUIRED','INVALID_LIMITS','INVALID_ORDER','SESSION_CLOSED','PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','RECONCILIATION_REQUIRED','KIS_TRADING_DISABLED','DISABLED_OR_EXPIRED','BROKER_REJECTED','ORDER_UNCERTAIN','ACCOUNT_CHANGED','BROKER_ORDER_MISMATCH'];const r=require('./buyback.cjs').refusalReply(error,c=>allowed.includes(c));return {ok:false,...r,error:r.error??require('./us-errors.cjs').publicUSCode(error.message),state:usLive.getState()};}});
  
  notifier=new Notifications(store.db,providerService,()=>({...automation.config,pushConnected:automation.providerStatus.pushConnected}),message=>{if(Notification.isSupported())new Notification({title:'Financial Portfolio Manager',body:message}).show();});
  automation.notify=(id,message)=>notifier.notify(id,message);
  // The start notice (restart part 1, step 2): once per start, desktop and phone, when stop orders are armed or auto
  // trading was running at the last stop. Not on a first start. The Home item stays until Start or Dismiss.
  try{const N=require('./start-notice.cjs');restartNotice=N.startNotice({previousStop,stops:N.armedStops(store.db,{scope:previousStop?.scope??null}),trailing:automation.config.trailingStops===true&&automation.config.conditionalOrders?N.armedTrailing(store.db,{scope:previousStop?.scope??null}):0,wasRunning:Boolean(automation.config.enabled&&automation.config.autoSubmit)});
    if(restartNotice){const id='restart-notice:'+(exitRecord?.current?.startedAt??Date.now());setTimeout(()=>{try{notifier.notify(id,restartNotice.message);}catch{}},3000);}}catch{}
  agentBridge=require('./agent-bridge.cjs').startBridge(app.getPath('userData'),paper,decision=>automation.review('External agent',decision));
  automation.evidence=new (require('./market-evidence.cjs').MarketEvidence)(async(args,context)=>{
    if(context.environment==='local-paper'){
      if(args.dataset==='company')return {status:'unavailable',reason:'SIMULATION_HAS_NO_COMPANY_FUNDAMENTALS'};
      const interval=args.dataset==='daily_technicals'?'1d':'1m';return {status:'available',source:'synthetic',retrievedAt:Date.now(),data:require('./market-evidence.cjs').technicals(marketProvider.getHistory(args.symbol,interval),interval,args.dataset)};
    }
    const generation=kisGeneration;const result=await kisService.request('market-evidence',{request:args});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');return result;
  });
  automation.orderBook=async symbol=>{const generation=kisGeneration;const result=await kisService.request('market-evidence',{request:{symbol,dataset:'order_book'}});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');return result;};
  automation.marketQuotes=()=>[...kisQuotes.values()];
  // Market discovery. Tests never download: they serve master files from PORTFOLIO_MASTER_DIR or skip the master.
  const masterDir=process.env.PORTFOLIO_SMOKE_DATA?process.env.PORTFOLIO_MASTER_DIR:null;
  const masterFetch=process.env.PORTFOLIO_SMOKE_DATA?(masterDir?async url=>{try{const buffer=require('node:fs').readFileSync(path.join(masterDir,path.basename(new URL(url).pathname)));return {ok:true,arrayBuffer:async()=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length)};}catch{return {ok:false};}}:null):globalThis.fetch;
  const master=new (require('./security-master.cjs').SecurityMaster)(store.db,masterFetch??(async()=>({ok:false})));
  const {Watchlist,Screener}=require('./discovery.cjs');const watchlist=new Watchlist(store.db,master);
  const screener=new Screener(async request=>{const generation=kisGeneration;const rows=await kisService.request('screen',{request});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');return rows;},master);
  const watchScope=()=>kisState.snapshot?.accountKey??null;
  const securityRow=({symbol,name,englishName,market,type})=>({symbol,name,englishName,market,type});
  automation.discovery={
    list:()=>{const scope=watchScope();return scope?watchlist.list(scope):[];},
    symbols:market=>{const scope=watchScope();return scope?watchlist.symbols(scope,market):[];},
    screen_market:async args=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');return screener.screen({market:args.market,kind:args.ranking,exchange:args.exchange??undefined,type:args.security_type});},
    search_securities:async args=>({status:master.status().total?'ok':'unavailable',rows:master.search(args.query,{market:args.market,limit:10}).map(securityRow)}),
    update_watchlist:async args=>{const scope=watchScope();if(!scope)throw new Error('KIS_NOT_CONNECTED');return require('./discovery.cjs').applyAiUpdate(watchlist,scope,args);}
  };
  // Starter Korean candidates: with no allowlist, watchlist or Korean holdings, the largest listed companies give the AI something to review.
  const starters=new (require('./discovery.cjs').StarterCandidates)(screener);
  const usStarters=new (require('./discovery.cjs').StarterCandidates)(screener,Date.now,'US');
  automation.discovery.starters=()=>starters.current(watchScope());automation.discovery.usStarters=()=>usStarters.current(watchScope());
  live.nameOf=symbol=>master.get(symbol)?.name||null;
  // Company research for the agents and the Company page: KIS sections plus OpenDART filings, cached per source.
  // SEC EDGAR contact email saved in the app (Connections). A providers-file secContactEmail still works when none is saved here.
  const secContact=()=>store.getSetting('sec-contact-email');
  const research=new (require('./research-service.cjs').ResearchService)({db:store.db,master,classify:(symbol,name,known)=>exposure.classify(symbol,name,known),kis:(operation,payload)=>kisService.request(operation,payload),provider:(operation,payload)=>providerService.request(operation,['sec-company','sec-filings','sec-earnings','sec-about'].includes(operation)?{...payload,contact:secContact()}:payload),kisReady:()=>Boolean(kisState.snapshot),dartReady:()=>Boolean(automation.providerStatus.dartConnected),secReady:()=>Boolean(automation.providerStatus.secConnected||secContact())});
  automation.discovery.marketOverview=async()=>{const m=await research.market();if(m.status!=='ok')return {status:'unavailable',reason:m.reason};const sectors=m.data.kospiSectors??[];return {asOf:new Date(m.retrievedAt).toISOString(),...m.data,kospiSectors:undefined,strongestSectors:sectors.slice(0,8),weakestSectors:sectors.length>8?sectors.slice(-6).reverse():[],foreignTopBuys:m.data.foreignTopBuys?.slice(0,6),institutionTopBuys:m.data.institutionTopBuys?.slice(0,6)};};
  ipcMain.handle('research:market',async(event,refresh)=>{authorize(event);return research.market(refresh===true);});
  // U.S. market today, with the latest VIX close from the macro data.
  ipcMain.handle('research:us-market',async(event,refresh)=>{authorize(event);const r=await research.usMarket(refresh===true);const v=macro.get()?.series?.find(s=>s.id==='US_VIX');return {...r,vix:v?{value:v.value,change:v.change,date:v.date}:null};});
  automation.discovery.research=args=>research.agent(args);
  // Daily closes for the agents' formulas, triggers and conditional orders, from the research cache.
  // Index closes and the cached market overview feed the market narrative and the episode library.
  // The performance store is created further down; until then there are no closes.
  automation.indexCloses=()=>{try{return Object.fromEntries(Object.keys(require('./performance.cjs').INDEXES).map(index=>[index,performance.closes(index).slice(-90)]));}catch{return {};}};
  automation.marketOverviewCache=()=>{const hit=research.cached('MARKET','market');return hit?{value:hit.value,at:hit.at}:null;};
  // The other market's latest sector moves, as a lead for the next session: U.S. sector ETFs for Korean reviews (read at
  // most every three hours) and KOSPI sectors from the cached Korean overview for U.S. reviews.
  automation.sectorLeads=async scope=>{const out={};
    if(['kis','both'].includes(scope)){let hit=research.cached('MARKET','us-market');if(!hit||Date.now()-hit.at>3*3600000){try{await research.usMarket();}catch{}hit=research.cached('MARKET','us-market');}
      if(hit?.value?.sectors?.length)out.us={asOf:new Date(hit.at).toISOString(),indices:(hit.value.indices??[]).map(({label,changePct})=>({label,changePct})),sectors:hit.value.sectors.map(({symbol,label,changePct})=>({sector:label,etf:symbol,changePct}))};}
    if(['us','both'].includes(scope)){const hit=research.cached('MARKET','market');if(hit?.value?.kospiSectors?.length)out.korea={asOf:new Date(hit.at).toISOString(),sectors:hit.value.kospiSectors.map(({name,changePct})=>({sector:name,changePct})).filter(s=>s.changePct!=null).sort((a,b)=>b.changePct-a.changePct)};}
    return Object.keys(out).length?{...out,note:'Latest sector moves in the other market (change against its previous close, read at asOf). A sharp move in a sector there often carries into the same sector in the next session here, but it is a lead to check against news, flows and the open, not a certainty.'}:null;};
  automation.freshenMarket=async()=>{if(!kisState.snapshot)return;const F=require('./market-freshness.cjs');if(!F.krOpen(Date.now(),{closedDays:new Set([...(automation.closedDays??[]),...(automation.officialClosedDays?.()??[])])}))return;await research.market();};
  // B1: the key Test, only on the user's click (key-test.cjs). The renderer gets one of the fixed results and texts.
  ipcMain.handle('providers:test',async(event,vendor)=>{authorize(event);const K=require('./key-test.cjs');if(!Object.hasOwn(K.VENDORS,vendor))return {result:'unreachable',text:'Invalid request.'};
    let result='unreachable';try{const r=await providerService.request('test-key',{vendor});if(K.RESULTS.includes(r?.result))result=r.result;}catch{}
    try{automation.log('provider-test-'+Date.now(),'System',`Provider key test · ${K.VENDORS[vendor]} · ${result}`,K.text(vendor,result));}catch{}
    return {vendor,result,text:K.text(vendor,result)};});
  ipcMain.handle('narrative:refresh',async event=>{authorize(event);try{await automation.buildNarrative();return {ok:true,state:automation.narrativeState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'NARRATIVE_FAILED',state:automation.narrativeState()};}});
  ipcMain.handle('narrative:hide',(event,id,hidden)=>{authorize(event);automation.narratives.hide(String(id),hidden!==false);return automation.narrativeState();});
  // Holdings for exposure and sizing; sector names come from cached quotes.
  automation.valuation=()=>portfolioState().valuation;
  automation.portfolioHoldings=()=>{try{const st=portfolioState();const fx=st.fx?.usdKRW??null;return {holdings:st.rows.filter(r=>r.valueKRW>0).map(r=>({symbol:r.symbol,name:r.name,market:r.market,valueKRW:r.valueKRW})),cashKRW:(st.cash.KRW??0)+(fx?(st.cash.USD??0)*fx:0),equityKRW:st.totals.equityKRW??st.totals.KRW};}catch{return null;}};
  automation.loggedEvents=()=>events;
  ipcMain.handle('replay:list',event=>{authorize(event);return {runs:automation.replays.runs(),busy:Boolean(automation.replaying)};});
  // C1: the confirmation's estimate for a Claude replay, with the run's refusals; nothing is sent.
  ipcMain.handle('replay:estimate',(event,options)=>{authorize(event);try{return {ok:true,estimate:automation.replayEstimate(options&&typeof options==='object'?options:{})};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REPLAY_FAILED'};}});
  ipcMain.handle('replay:run',async(event,options)=>{authorize(event);try{const run=await automation.replay(options&&typeof options==='object'?options:{});return {ok:true,run};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REPLAY_FAILED'};}});
  // U.S. earnings dates for every listed company (Nasdaq's calendar, refreshed daily), and the 200 largest U.S. companies.
  const usCalendar=new (require('./us-calendar.cjs').UsCalendar)(store.db);automation.usCalendar=usCalendar;
  const seoulDay=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  let usCalendarBusy=false;const refreshUsCalendar=async()=>{if(usCalendarBusy||closing)return;const last=usCalendar.status().refreshedAt;if(last&&Date.now()-last<20*3600000)return;usCalendarBusy=true;try{await usCalendar.refresh({fetcher:fetch,known:symbol=>Boolean(master.get(symbol)),today:seoulDay()});}catch{}finally{usCalendarBusy=false;}};
  setTimeout(()=>void refreshUsCalendar(),45000).unref();setInterval(()=>void refreshUsCalendar(),3600000).unref();
  // U.S. symbols the agents can act on: holdings, the watchlist, scout targets and the review's starter list.
  const usRelevant=()=>[...new Set([...(usSnapshot?.holdings??[]).map(h=>h.symbol),...(automation.discovery?.symbols('US')??[]),...(()=>{try{return scoutTargets('US');}catch{return [];}})(),...usStarters.current(watchScope())])];
  // SEC data, daily and independent of what an agent researched: filings for the 200 largest U.S. companies and the
  // relevant symbols, full company facts for the relevant symbols, and a seventh of the largest each day (weekly).
  let secWarmDay=null;const warmSec=async()=>{const day=seoulDay();if(secWarmDay===day||closing||!(automation.providerStatus.secConnected||secContact()))return;secWarmDay=day;
    const relevant=usRelevant();const largest=usCalendar.largest(200);const weekday=new Date(day+'T00:00:00Z').getUTCDay();
    const pause=()=>new Promise(r=>setTimeout(r,400));
    for(const symbol of [...new Set([...relevant,...largest])]){if(closing)return;try{await research.source(symbol,'sec-filings');}catch{}await pause();}
    for(const symbol of [...new Set([...relevant,...largest.filter((_,i)=>i%7===weekday)])]){if(closing)return;try{await research.source(symbol,'sec');}catch{}await pause();}};
  setTimeout(()=>void warmSec(),120000).unref();setInterval(()=>void warmSec(),3600000).unref();
  // Calendar entries also cover the review's starter lists and scout targets, not only holdings and the watchlist.
  automation.calendarSymbols=()=>[...new Set([...usRelevant(),...starters.current(watchScope()),...(()=>{try{return scoutTargets('KR');}catch{return [];}})()])].map(symbol=>({symbol,name:master.get(symbol)?.name??symbol}));
  // Earnings: a listed U.S. report date first, then the SEC estimate; Korean stocks use OpenDART.
  research.listedEarnings=symbol=>usCalendar.next(symbol,seoulDay());
  const usEarnings=symbol=>{const listed=usCalendar.next(symbol,seoulDay());if(listed)return {nextExpected:listed.date,scheduled:true,time:listed.time,source:listed.source};const sec=research.cached(symbol,'sec-filings')?.value?.earnings??research.cached(symbol,'sec')?.value?.earnings??null;return sec?{...sec,estimated:true}:null;};
  automation.calendarSource=symbol=>({name:master.get(symbol)?.name??null,earnings:/:/.test(symbol)?usEarnings(symbol):research.cached(symbol,'dart')?.value?.earnings??null,dividends:research.cached(symbol,'dividends')?.value??null,meetings:research.cached(symbol,'meetings')?.value?.meetings??[]});
  automation.sectorOf=symbol=>research.cached(symbol,'overview')?.value?.sectorName??null;
  // Daily history for holdings and watchlist stocks is kept warm (every six hours) for exposure, sizing, triggers and formulas.
  let warmAt=0;setInterval(()=>{if(!kisState.snapshot||Date.now()-warmAt<6*3600000)return;warmAt=Date.now();void (async()=>{const symbols=[...new Set([...kisState.snapshot.holdings.map(h=>h.symbol),...(usSnapshot?.holdings??[]).map(h=>h.symbol),...(automation.discovery?.symbols('KR')??[])])].slice(0,25);for(const symbol of symbols){try{await research.source(symbol,'daily');await research.source(symbol,'overview');if(/^\d{6}$/.test(symbol)){await research.source(symbol,'dividends');await research.source(symbol,'meetings');if(automation.providerStatus.dartConnected)await research.source(symbol,'dart');}}catch{}}})();},120000).unref();
  automation.series={closes:symbol=>research.cached(symbol,'daily')?.value?.closes??null,ensure:symbol=>research.source(symbol,'daily')};
  // Trailing stops (T3): daily bars read fresh for a catch-up (null when they cannot be read), and the cached OpenDART
  // filings that say whether a capital change falls in the gap (null when there are none at hand).
  automation.dailyBars=async symbol=>{const r=await research.source(symbol,'daily',true);return r?.status==='ok'&&Array.isArray(r.data?.closes)?r.data.closes:null;};
  automation.capitalFilings=symbol=>research.cached(symbol,'dart')?.value?.filings??null;
  const deskAction=action=>(event,...args)=>{authorize(event);const scope=automation.watchScope();if(!scope)throw new Error('KIS_NOT_CONNECTED');action(scope,...args);return automation.deskState();};
  ipcMain.handle('desk:cancel-trigger',deskAction((scope,id)=>automation.desk.cancelTrigger(scope,String(id))));
  ipcMain.handle('desk:delete-note',deskAction((scope,symbol)=>automation.desk.deleteNote(scope,String(symbol??''))));
  ipcMain.handle('desk:cancel-order',deskAction((scope,id)=>automation.desk.cancelOrder(scope,String(id))));
  ipcMain.handle('desk:dismiss-unprotected',deskAction((scope,id)=>automation.desk.dismissUnprotected(scope,String(id))));
  ipcMain.handle('research:open-filing',(event,url)=>{authorize(event);if(typeof url==='string'&&(/^https:\/\/dart\.fss\.or\.kr\/dsaf001\/main\.do\?rcpNo=\d{14}$/.test(url)||/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/[A-Za-z0-9._-]{1,120}$/.test(url)))void shell.openExternal(url);});
  ipcMain.handle('research:company',async(event,symbol,sections,refresh)=>{authorize(event);if(typeof symbol!=='string'||!/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol))throw new Error('INVALID_REQUEST');return research.profile(symbol,{sections:Array.isArray(sections)?sections.filter(s=>typeof s==='string').slice(0,12):undefined,refresh:refresh===true});});
  // The scout plan's live Korean targets are always quoted and reviewable, alongside the watchlist or starter list.
  // Scout plans are saved under the automation scope (scope + account), not the bare account key.
  const scoutTargets=market=>{const plan=require('./scout.cjs').reviewContext(automation.scoutStore.latest(automation.watchScope()));return (plan?.targets??[]).filter(t=>t.role!=='exit'&&(market==='KR'?/^[0-9][0-9A-Z]{5}$/.test(t.symbol):t.symbol.includes(':'))).map(t=>t.symbol);};
  live.extraSymbols=async()=>{let allowed=[];try{allowed=live.policy()?.symbols??[];}catch{}const base=await starters.symbols({scope:watchScope(),watched:automation.discovery.symbols('KR'),allowed,holdings:(kisState.snapshot?.holdings??[]).map(row=>row.symbol)});return [...new Set([...base,...scoutTargets('KR')])];};
  // News matters for holdings, watchlist, allowlists and AI-watched symbols.
  automation.relevantSecurities=()=>{const symbols=new Set([...(kisState.snapshot?.holdings??[]).map(row=>row.symbol),...(usSnapshot?.holdings??[]).map(row=>row.symbol),...automation.discovery.list().map(row=>row.symbol),...(live.getState().policy?.symbols??[]),...(usLive.getState().policy?.symbols??[]),...automation.watches.list(automation.watchScope()).map(row=>row.symbol),...(automation.config.scope==='paper'?paper.getState().universe.map(row=>row.symbol):[])]);
    return [...symbols].map(symbol=>{const known=master.get(symbol);const held=[...(kisState.snapshot?.holdings??[]),...(usSnapshot?.holdings??[])].find(row=>row.symbol===symbol);return {symbol,name:known?.name??held?.name??'',englishName:known?.englishName??''};});};
  if(masterFetch){void master.refresh().catch(()=>{});setInterval(()=>void master.refresh().catch(()=>{}),3600000).unref();}
  // Screening history (note 6, S2): the U.S. size order from Nasdaq's public screener and the nightly read-only KIS
  // reads of daily closes for the screening set. Public market data only.
  const screenStore=new (require('./history-store.cjs').HistoryStore)(store.db),usSize=new (require('./us-size.cjs').UsSizeOrder)(store.db);
  const screenOwn=kind=>{if(kind==='review')return automation.lastReviewUniverse??[];if(kind==='holdings')return [...(kisState.snapshot?.holdings??[]),...(usSnapshot?.holdings??[])].map(r=>r.symbol);if(kind==='watchlist')return automation.discovery.list().map(r=>r.symbol);
    if(kind==='plan')return [...scoutTargets('KR'),...scoutTargets('US')];if(kind==='allowlist'){const out=[];try{out.push(...(live.policy()?.symbols??[]));}catch{}try{out.push(...(usLive.getState().policy?.symbols??[]));}catch{}return out;}return [];};
  automation.screens={db:store.db,store:screenStore,usSize,own:screenOwn,settings:()=>({perExchange:automation.config.screenStocksPerExchange,etfs:automation.config.screenEtfs}),
    closedDays:()=>new Set([...(automation.closedDays??[]),...(automation.officialClosedDays?.()??[])]),clock:Date.now};
  // When the reads may run (screen-wiring.cjs): no app order active in either market, the read window (real session
  // times, 15 minutes' margin, extended sessions you switched on), the KIS queue idle and not cooling down.
  const W=require('./screen-wiring.cjs'),MS=require('./market-sessions.cjs');
  const ordersActive=W.makeOrdersActive({engines:()=>[live,usLive],today:(market,now)=>market==='US'?require('./kis-overseas.cjs').localDate(new Date(now)):require('./kis-activity.cjs').seoulDate(now)});
  const screenAllowed=W.makeAllowed({closing:()=>closing,scoutOn:()=>automation.config.scoutEnabled,connected:()=>Boolean(kisState.snapshot),
    sessionsOf:(market,day)=>MS.sessionsOn(market,day,{closedDays:automation.screens.closedDays(),environment:kisState.snapshot?.environment??'mock',enabled:automation.sessionOptions()}),
    lateWindow:require('./outside-fills.cjs').lateWindow,queueBusy:()=>kisService.isBusy,cooldownUntil:()=>kisService.cooldownUntil,ordersActive});
  const screenRefresher=new (require('./history-store.cjs').HistoryRefresher)({store:screenStore,set:()=>require('./screen-universe.cjs').nightlySet(automation.screens),
    request:(symbol,end)=>kisService.request('history-page',{symbol,end}),allowed:screenAllowed,closedDays:automation.screens.closedDays,clock:Date.now});
  automation.screenRefresher=screenRefresher;
  // Live prices for screens (screen-run.cjs): a read is sent only while no app order is being sent or cancelled (an engine
  // sending, or an order Submitting or Cancellation uncertain that can still fill) and nothing waits in the KIS queue; once
  // an order starts being sent, the run's live reads stop.
  const orderSending=()=>Boolean(live?.busy||usLive?.busy);
  const liveAllowed=()=>{if(orderSending()||kisService.isBusy)return false;try{const now=Date.now();return ![...live.orders(),...usLive.orders()].some(o=>['Submitting','Cancellation uncertain'].includes(o?.status)&&now<W.activeUntil(o));}catch{return false;}};
  automation.screenLive=require('./screen-run.cjs').makeLiveReader({request:(op,p)=>kisService.request(op,p),allowed:liveAllowed,orderSending,sessionOpen:(m,t)=>automation.sessionOpen(m,t)});
  // A run of screens (a scout run; a review in S4) owns its live bound: 120 Korean and 40 U.S. stocks across its scripts.
  // What the Scout panel shows about the screening history: the as-of day per market, the store's depth, why it is behind,
  // and the stocks that stopped deepening. Worked out at most once a minute.
  let screenStatusAt=0,screenStatusValue=null;
  automation.screenStatus=()=>{const now=Date.now();if(screenStatusAt&&now-screenStatusAt<60000)return screenStatusValue;screenStatusAt=now;
    try{screenStatusValue=require('./screen-status.cjs').screenStatus({deps:automation.screens,refresher:screenRefresher,enabled:automation.config.scoutEnabled});}catch{screenStatusValue={error:true};}return screenStatusValue;};
  // The screening engine runs scripts in its own process (screen-worker.cjs), never here; each pass gets the lists,
  // settings, calendar and time from here and reads the database itself, read-only.
  const screenEngine=new (require('./screen-engine.cjs').ScreenEngine)({spawn:()=>{const child=require('electron').utilityProcess.fork(path.join(__dirname,'screen-worker.cjs'),[],{stdio:'ignore',serviceName:'Screening scripts'});
    return {postMessage:m=>child.postMessage(m),on:(event,fn)=>child.on(event,fn),kill:()=>{try{child.kill();}catch{}}};}});
  const screenEnv=()=>({dbPath:path.join(app.getPath('userData'),'portfolio.sqlite'),now:Date.now(),settings:automation.screens.settings(),closedDays:[...automation.screens.closedDays()],
    own:Object.fromEntries(require('./screen-universe.cjs').OWN.map(k=>{try{return [k,screenOwn(k)??[]];}catch{return [k,[]];}}))});
  // guard(): the scout run's account check; symbols are recorded for the next night only while the run's account is current.
  // A review's run (S4): its own stocks only (env.allowed), live() from its quotes that are fresh by the app's own rule
  // (not stale, under 90 s, the session open), the rest through the reader; a dry run reads nothing from KIS.
  const reviewReader=review=>require('./screen-run.cjs').reviewReader({...review,sessionOpen:(m,t)=>automation.sessionOpen(m,t),readLive:(s,o)=>automation.screenLive(s,o)});
  automation.openScreenRun=({guard,review=null}={})=>require('./screen-run.cjs').openRun({readLive:review?reviewReader(review):automation.screenLive,exec:(kind,payload)=>screenEngine.exec(kind,payload,{...screenEnv(),...(review?{allowed:review.allowed}:{})}),
    finish:missing=>{guard?.();require('./screen-universe.cjs').recordMissing(automation.screens,missing);},orderSending,cancelled:()=>closing||Boolean(automation.disposed)});
  if(!process.env.PORTFOLIO_SMOKE_DATA){
    setInterval(()=>{try{screenRefresher.tick();}catch{}},1000).unref();
    let usSizeBusy=false;const refreshUsSize=async()=>{if(usSizeBusy||closing||!usSize.due().length)return;usSizeBusy=true;try{await usSize.refresh({fetcher:fetch,known:s=>master.get(s)?.type==='stock'});}catch{}finally{usSizeBusy=false;}};
    setTimeout(()=>void refreshUsSize(),60000).unref();setInterval(()=>void refreshUsSize(),3600000).unref();
    // Pruning waits for a connection, so your holdings are known and kept.
    setInterval(()=>{try{if(kisState.snapshot)screenStore.prune(require('./screen-universe.cjs').nightlySet(automation.screens));}catch{}},6*3600000).unref();}
  // Performance history: daily account values, recorded cash flows and benchmark closes.
  const {PerformanceHistory,benchmarkFor}=require('./performance.cjs');const performance=new PerformanceHistory(store.db);let benchmarkTask=null,benchmarkAt=0,benchmarkError=null;
  // A skipped damaged record (release gate 1.5.52, R2): one System line per run and table, naming the days.
  performance.onSkipped=(table,keys)=>{const n=keys.length,list=keys.slice(0,10).join(', ')+(n>10?`, and ${n-10} more`:'');
    automation.log(require('node:crypto').randomUUID(),'System','Error: daily records could not be read',table==='nav_history'?`${n} daily record${n===1?'':'s'} could not be read and ${n===1?'is':'are'} left out (${list}). Returns across ${n===1?'that day are':'those days are'} unavailable. Logged once per run.`:`${n} recorded deposit or withdrawal${n===1?'':'s'} could not be read and ${n===1?'is':'are'} left out (${list}). Returns may not count ${n===1?'it':'them'}. Logged once per run.`);};
  // Versioned corrections to recorded values (electron/valuation-corrections.cjs): returns are computed with those in
  // force. Corrections are only previewed here; applying one needs the user's approval.
  const corrections=new (require('./valuation-corrections.cjs').ValuationCorrections)(store.db);performance.adjustments=account=>{try{return corrections.inForce(account);}catch{return [];}};
  // Test-only: UI tests seed earlier daily values because history cannot be backfilled from KIS.
  if(process.env.PORTFOLIO_SMOKE_DATA&&process.env.PORTFOLIO_PERFORMANCE_SEED){const seed=JSON.parse(process.env.PORTFOLIO_PERFORMANCE_SEED);for(const row of seed.history)store.db.prepare('INSERT OR REPLACE INTO nav_history VALUES(?,?,?)').run(seed.account,row.day,JSON.stringify(row));for(const review of seed.reviews??[])store.db.prepare('INSERT OR REPLACE INTO reviews VALUES(?,?)').run(review.id,JSON.stringify(review));}
  // Deposits and withdrawals not recorded by the user, detected after each balance refresh (electron/flow-detector.cjs).
  const flowDetector=new (require('./flow-detector.cjs').FlowDetector)(store.db,performance);flowDetector.onNote=(title,message)=>automation.log(require('node:crypto').randomUUID(),'System',title,message);
  // Orders made outside the app (found in live use: a sale made in the KIS app was recorded as a deposit). The history is
  // complete up to its last read, or, after the day's last fill, until the next session (outside-fills.cjs historyThrough;
  // automation.syncHistories reads it).
  // The days to read back from are latched once per account, before any reading of this start is saved (detectFlows calls
  // latchStart first; otherwise its first reading would make "the last reading" now and no missed day would be read): the
  // detector's last reading before the start, or, with none, the full 31 days the buy-back block reaches. Each market
  // counts from its own day (the U.S. from the New York day), the day the app was closed on included (it was only partly
  // read). undefined while the account is not known yet (syncMissed waits).
  const backfill=require('./buyback.cjs').startLatch(a=>flowDetector.lastAt(a));const latchStart=a=>backfill.latch(a);
  const nyDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t));
  const backfillFor=dayOf=>backfill.from(kisState.snapshot?.accountKey,dayOf);
  live.backfillFrom=()=>backfillFor(t=>require('./kis-activity.cjs').seoulDate(t));if(usLive)usLive.backfillFrom=()=>backfillFor(nyDay);
  // The buy-back block (buyback.cjs) and the review context's facts about orders made outside the app (outside-context.cjs),
  // from the recorded KIS order history of each market on its own, so one that cannot be read never holds the other.
  const buyback=new (require('./buyback.cjs').BuybackBlocks)(store.db);
  const marketSources=()=>{const from=require('./kis-activity.cjs').seoulDate(Date.now()-32*86400000),errors=[],sources=[];
    for(const [market,engine] of [['KR',live],['US',usLive]]){if(!engine)continue;try{sources.push({market,rows:engine.historyRange(from),intents:engine.orders()});}catch(error){errors.push({market,error:String(error?.message??error).slice(0,60)});}}return {sources,errors};};
  // The list, and the markets it could not be built for (logged once in 10 minutes, shown on Home: buybackFailure). Kept for
  // 5 seconds and dropped when either market's history is recorded or a block is removed, so the frequent checks (each
  // order, each send, the tracker) do not each parse 31 days of history.
  let buybackCache=null;const buybackInvalidate=()=>{buybackCache=null;};live.onHistory=buybackInvalidate;if(usLive)usLive.onHistory=buybackInvalidate;
  const buybackRead=()=>{const a=kisState.snapshot?.accountKey;if(!a)return {list:[],errors:[]};const now=Date.now();if(buybackCache&&buybackCache.a===a&&now-buybackCache.at<5000)return buybackCache.v;
    const {sources,errors}=marketSources();const list=buyback.list(a,sources,now,errors);
    for(const e of errors){const engine=e.market==='US'?usLive:live;if(!engine)continue;if(!engine.buybackFailure||now-engine.buybackFailure.at>600000)automation.log(require('node:crypto').randomUUID(),'System','Buy-back list not read',`${e.market==='US'?'U.S.':'Korean'} orders made outside the app could not be read (${e.error}); the app's own buys there wait until they can be.`);engine.buybackFailure={at:now,error:e.error};}
    buybackCache={a,at:now,v:{list,errors}};return buybackCache.v;};
  const buybackList=()=>buybackRead().list;
  // The user's rule: the app's own buys in a market wait while its history is not ready: the missed days not read for the
  // connected account, or the history not complete up to a recent time (Korea: historyThrough no older than 6 minutes;
  // the U.S.: read in the last 4 minutes while its session is open, or after its session closed), or the list failed.
  const historyReadyFor=(engine,market)=>require('./buyback.cjs').historyReady(engine,market,{sessionOpen:(m,t)=>automation.sessionOpen(m,t),lastOpenAt:automation.lastOpenAt?.[market]??0});
  // A market counts only when it is in scope and connected (no U.S. account: nothing to wait for there).
  const inScope=market=>require('./buyback.cjs').marketsInScope({scope:automation.config.scope,kr:Boolean(kisState.snapshot),us:Boolean(usSnapshot&&usSnapshot.accountKey===kisState.snapshot?.accountKey+':US')}).includes(market);
  const blockFor=(engine,market,symbol)=>{const B=require('./buyback.cjs'),ready=historyReadyFor(engine,market);if(!ready)return B.blockFor({ready,market,symbol});const {list,errors}=buybackRead();return B.blockFor({ready,errors,list,market,symbol});};
  live.buybackBlock=symbol=>blockFor(live,'KR',symbol);if(usLive)usLive.buybackBlock=symbol=>blockFor(usLive,'US',symbol);
  const buysWaiting=()=>[['KR',live],['US',usLive]].filter(([m,e])=>e&&inScope(m)&&(!historyReadyFor(e,m)||buybackRead().errors.some(x=>x.market===m))).map(([m])=>m);
  automation.outsideData=()=>{const {sources}=marketSources(),{outsideCashTrades}=require('./buyback.cjs'),{appOrderIds}=require('./outside-fills.cjs');
    // Open orders by each market's own day (the U.S. by the New York day its rows carry).
    const open=sources.flatMap(s=>{const engine=s.market==='US'?usLive:live;let today=null;try{today=engine.day();}catch{}try{return require('./buyback.cjs').openOutsideOrders(s,today);}catch{return [];}});
    return {trades:sources.flatMap(s=>{try{return outsideCashTrades(s.rows,s.intents,s.market);}catch{return [];}}),blocks:buybackList(),openOrders:open,buysWait:buysWaiting()};};
  ipcMain.handle('activity:buyback',event=>{authorize(event);return {blocks:buybackList()};});
  ipcMain.handle('activity:buyback-remove',(event,market,symbol)=>{authorize(event);const a=kisState.snapshot?.accountKey;if(!a)throw new Error('KIS_NOT_CONNECTED');buyback.remove(a,market,symbol);buybackInvalidate();return {blocks:buybackList()};});
  let historyUnreadSince=null;
  const historyReady=()=>{const a=kisState.snapshot?.accountKey;return Boolean(a&&live.missedRead&&live.historyKey===a&&Number.isFinite(live.historyReadAt));};
  const ordersThrough=()=>require('./outside-fills.cjs').historyThrough({readAt:live.historyReadAt,ready:historyReady()});
  const outsideFills=()=>{if(!historyReady())return null;try{const from=require('./kis-activity.cjs').seoulDate(Date.now()-100*86400000);return require('./outside-fills.cjs').outsideFills(live.historyRange(from),live.orders(),{charges:live.outsideCharges(),settings:costs?.get?.(),classify:s=>costs?.classify?.(s)??null});}catch{return null;}};
  // The broker's own balance figures, kept when they change (electron/broker-raw.cjs), for reconciliation.
  const brokerBalances=new (require('./broker-raw.cjs').BrokerBalances)(store.db);
  // M-1.5b: KIS's orderable answers at each order preparation, with the orders open then (for Q1/Q2).
  const brokerCapacity=new (require('./broker-raw.cjs').BrokerCapacity)(store.db);for(const e of [live,usLive])if(e)e.recordCapacity=x=>brokerCapacity.record(x);
  // U.S. fills KIS does not reflect yet (electron/valuation.cjs InFlight), decided at each U.S. balance reading.
  const inFlight=new (require('./valuation.cjs').InFlight)(store.db);
  // C1d-2: the KRW part of each U.S. buy, booked once as a transfer where KIS's figures show it (funding-transfers.cjs).
  const fundingTransfers=new (require('./funding-transfers.cjs').FundingTransfers)(store.db,{performance,log:(title,body)=>{try{automation.log(require('node:crypto').randomUUID(),'System',title,body);}catch{}}});let lastFundingKR=null;
  fundingOf=account=>{try{return fundingTransfers.current(account);}catch{return null;}};
  // S1a: a U.S. order settled by evidence or by age releases its funding commitment's filled part (one transaction).
  // S1b: a failing reading leaves one System line with its error code, at most once a minute per kind.
  const readingFailed=require('./reading-failures.cjs').readingFailures((title,message)=>automation.log(require('node:crypto').randomUUID(),'System',title,message));
  inFlight.onSettled=(account,{orderId,why})=>{const market=fundingLedger.row(String(orderId))?.market;if(market==='US')fundingLedger.releaseSettled({orderId,why});};inFlightOf=account=>{try{return inFlight.current(account);}catch{return null;}};
  // The U.S. daily-loss baseline and settlement corrections (electron/settlement-baseline.cjs, stage 2b.4): the tracker's
  // pieces are saved with each day's baseline, and the tracker's cash-free changes after it move the baseline with the value.
  const settlementBaseline=new (require('./settlement-baseline.cjs').SettlementBaseline)(store.db,{inFlight});
  usLive.baselineTaken=policy=>{const a=kisState.snapshot?.accountKey;if(a)settlementBaseline.take(a,policy.day,policy.baselineAt);};
  usLive.settlementAdjustments=policy=>{const a=kisState.snapshot?.accountKey;return a?settlementBaseline.adjustments(a,policy):null;};
  // S4b-2: the manual reconciliation and the U.S. settlements panel are gone (KIS evidence and the age rule settle every
  // fill); the U.S. page shows one read-only line while fills are settling (usLive.settlingFills).
  usLive.settlingFills=()=>{const a=kisState.snapshot?.accountKey;return a?(inFlightOf(a)?.open??[]).length:0;};
  // The accounting-correction component of the performance series (stage 3.1): cash-free settlement changes of the U.S.
  // low basis, kept out of P/L and returns; each recorded day keeps the tracker's state, so a day with a U.S. buy in
  // flight is an estimate (S2) and a day the tracker could not be read has no return (U4).
  const settlementCorrections=require('./performance-corrections.cjs').performanceCorrections(store.db,{inFlight});
  // C1a: settlement pieces an approved valuation correction supersedes make no correction in the series.
  settlementCorrections.superseded=account=>corrections.superseded(account);
  performance.corrections=(account,rows)=>settlementCorrections.byDay(account,rows);
  performance.settlement=account=>inFlight.snapshot(account);
  // Item 9 section 4 (A): the held cash changes for the headline series.
  performance.held=account=>flowDetector.heldParts(account);
  // S4a: historical restatements (stage 3.3/3.4: discovery, preview, approval) are gone.
  const readTime=x=>{const v=typeof x==='number'?x:Date.parse(x);return Number.isFinite(v)?v:null;};
  detectFlows=()=>{try{const s=kisState.snapshot;if(!s?.accountKey)return;latchStart(s.accountKey);const us=usSnapshot?.accountKey===s.accountKey+':US'?usSnapshot:null;try{brokerBalances.record(s.accountKey,'KR',kisState.heldReading??s);if(us)brokerBalances.record(s.accountKey,'US',usHeldReading??us);}catch{}
    if(us&&us!==lastInFlightReading){lastInFlightReading=us;try{const r=inFlight.observe(s.accountKey,{us,orders:usLive?.orders()??[],fx:automation.fx?.()?.usdKRW??null,netting:us.settlementProvisional?null:(()=>{try{const t=inFlightOf(s.accountKey);return fundingTransfers.peekNet(s.accountKey,{us,orders:usLive?.orders()??[],fx:automation.fx?.()?.usdKRW??null,openOrderIds:new Set((t?.open??[]).filter(p=>p.side==='Buy').map(p=>String(p.id))),openBuysUSD:t?.buysUSD??0,reportedOpenIds:require('./valuation.cjs').reportedOpenIds(t)});}catch{return null;}})(),krwGroups:(()=>{try{return fundingTransfers.current(s.accountKey).krwRouteGroups;}catch{return null;}})()});for(const n of r.notes)automation.log(require('node:crypto').randomUUID(),'System','U.S. settlement tracking',n);}catch(e){readingFailed('U.S. settlement tracking',e);}
      // C1d-2: never a held or provisional U.S. reading (C1d-1, M7).
      if(!us.settlementProvisional)try{const t=inFlightOf(s.accountKey);fundingTransfers.observeUS(s.accountKey,{us,orders:usLive?.orders()??[],fx:automation.fx?.()?.usdKRW??null,openOrderIds:new Set((t?.open??[]).filter(p=>p.side==='Buy').map(p=>String(p.id))),openBuysUSD:t?.buysUSD??0,reportedOpenIds:require('./valuation.cjs').reportedOpenIds(t)});}catch(e){readingFailed('U.S. funding transfers',e);}}
    if(s!==lastFundingKR&&!s.settlementProvisional){lastFundingKR=s;try{fundingTransfers.observeKR(s.accountKey,{korea:s,orders:live.orders()});}catch(e){readingFailed('U.S. funding transfers',e);}}
    // S1b: Korean filled buys release their funding by age (3 Korean business days after the order's day).
    try{for(const x of fundingLedger.releaseAgedKR(s.accountKey))automation.log(require('node:crypto').randomUUID(),'System','Korean settlement',`Buy ${x.orderId}: settled by age, 3 Korean business days after its trade date ${x.tradeDay}; its funding is released`);}catch(e){readingFailed('Korean settlement',e);}const funding=require('./integrated-settlement.cjs').settlement(us),route=fundingOf(s.accountKey);const kr=(Number.isFinite(s.settledCash)?s.settledCash:s.cash)-(route?(route.krwUnpaidKRW??route.krwKRW):funding.confirmedKRW);
    // The tracker's own changes to the U.S. basis (late pre-tracking fills, conflicts, age closes, fee differences) are
    // explained, never flows (stage 2b.4).
    for(const flow of flowDetector.observe(s.accountKey,{usExplained:range=>inFlight.explained(s.accountKey,range),krCash:kr,
      // Item 9: each balance's read time (a U.S. refresh that failed keeps its old snapshot, so it is no new read) and the
      // route's unpaid KRW, for the short hold.
      readAt:{KR:readTime(s.timestamp),US:us?readTime(us.timestamp):null},krwUnpaid:route?.krwUnpaidKRW??0,provisionalKRW:route?route.provisionalKRW:funding.uncertainKRW,...(route?{provisionalOutsideKRW:(()=>{try{const fx=automation.fx?.()?.usdKRW,c=require('./valuation.cjs').splitContext(usSnapshot,inFlightOf(s.accountKey),route,fx);return Math.max(0,route.provisionalKRW-(c?.reportedInFlightUSD??0)*(fx||0));}catch{return route.provisionalKRW;}})()}:{}),unsettledKRW:funding.unsettledKRW,usCash:usSnapshot?.accountKey===s.accountKey+':US'&&!usSnapshot.settlementProvisional?(f=>usSnapshot.cash+(usSnapshot.pendingSaleProceeds??0)-Math.max(0,(f?.buysUSD??0)-require('./valuation.cjs').coveredInFlight(f,route,automation.fx?.()?.usdKRW??null))+(f?.sellsUSD??0)-(route?.usUSD??0))(inFlightOf(s.accountKey)):null,...(route?{funding:route.explained}:{}),fx:automation.fx?.()?.usdKRW??null,orders:[...live.orders(),...(usLive?.orders()??[])],outside:outsideFills(),ordersThrough:ordersThrough()}))if(flow.detected)automation.noteDetectedFlow(flow);
      // A stop on Korean shares sold outside the app is closed or reduced with words, on the evidence of KIS's order history
      // (automation.closeStopsNotHeld).
      try{automation.closeStopsNotHeld(s,Date.now(),outsideFills());}catch{}}catch{}};
  live.flowsToday=()=>{const a=kisState.snapshot?.accountKey;return a?performance.flowsOn(a,require('./kis-activity.cjs').seoulDate(),'KR'):0;};
  // Recorded flows and the changes the detector still holds (electron/flow-detector.cjs flowsSince).
  live.flowsSince=policy=>{const a=kisState.snapshot?.accountKey;return a?flowDetector.flowsSince(a,'KR',policy?.baselineAt):null;};
  usLive.flowsSince=policy=>{const a=kisState.snapshot?.accountKey;return a?flowDetector.flowsSince(a,'US',policy?.baselineAt):null;};
  // Net equity for the daily loss and new-exposure checks (electron/valuation.cjs), from the balance the engine holds.
  const marketValue=(market,snapshot)=>{const k=kisState.snapshot;if(!k?.accountKey)return null;const kr=market==='KR'?snapshot:k,us=market==='US'?snapshot:(usSnapshot?.accountKey===k.accountKey+':US'?usSnapshot:null);
    if(market==='KR'&&snapshot?.accountKey!==k.accountKey||market==='US'&&snapshot?.accountKey!==k.accountKey+':US')return null;
    return require('./valuation.cjs').marketValue(market,{korea:kr,us,fx:automation.fx?.(),inFlight:inFlightOf(k.accountKey),funding:fundingOf(k.accountKey)});};
  live.netEquityOf=snapshot=>marketValue('KR',snapshot);live.creditApproved=()=>automation.config.creditProtectionApproved===true;usLive.netEquityOf=snapshot=>marketValue('US',snapshot);
  usLive.flowsToday=()=>{const a=kisState.snapshot?.accountKey;return a?performance.flowsOn(a,require('./kis-activity.cjs').seoulDate(),'US'):0;};
  // C1c (W5): after a failed U.S. refresh, the day's record waits while a U.S. buy may be awaiting settlement
  // (integrated-settlement.cjs usFundingMayBeOpen): the Korean value would leave out the KRW KIS holds for it. The day
  // then has no record (a gap), never a wrong one; one log line per Seoul day says so.
  let usHoldLogged=null;
  const usFundingOpen=account=>{let orders=[];try{orders=store.db.prepare('SELECT payload FROM live_intents WHERE accountKey=?').all(account+':US').map(r=>JSON.parse(r.payload));}catch{}
    let lastUS=null;try{lastUS=brokerBalances.list(account,'US',1)[0]??null;}catch{}
    return require('./integrated-settlement.cjs').usFundingMayBeOpen({lastUS,openBuysUSD:inFlightOf(account)?.buysUSD??0,orders});};
  const recordValue=()=>{try{const account=kisState.snapshot?.accountKey;if(!account||kisState.snapshot.settlementProvisional||usSnapshot?.settlementProvisional)return;
    if(!usSnapshot&&usLive.refreshError){const g=usFundingOpen(account);if(g.open){const day=require('./kis-activity.cjs').seoulDate();
      if(usHoldLogged!==day){usHoldLogged=day;automation.log(require('node:crypto').randomUUID(),'System','Daily record held',`The U.S. balance could not be loaded, and ${g.reasons[0]}. Today's Korean value would leave out the KRW KIS holds for it, so today's record waits until the U.S. balance loads (if it does not, the day has no record).`);}return;}}
    performance.record(account,portfolioState(),{awaitingUS:!usSnapshot&&!usLive.refreshError});}catch{}};
  setInterval(recordValue,60000).unref();
  setInterval(()=>{if(Date.now()-calendarAt>6*3600000)void refreshKrCalendar();},600000).unref();
  automation.officialClosedDays=()=>officialKrCalendar().filter(r=>!r.open).map(r=>r.day);
  // Daily digest fallback: today's recorded value against the previous recorded day, per market.
  // Stage 3.4: each market's day for the digest: its return (or why it has none) and its accounting correction.
  automation.performanceToday=day=>{const account=kisState.snapshot?.accountKey;return account?require('./performance.cjs').todayFigures(performance,account,day):[];};
  automation.accountValues=day=>{const account=kisState.snapshot?.accountKey;if(!account)return [];return [['KR','KRW','Korea'],['US','USD','U.S.']].flatMap(([market,currency,label])=>{const points=performance.series(account,currency);const today=points.find(p=>p.day===day),prior=points.filter(p=>p.day<day).at(-1);return today&&prior?[{market,currency,label,equity:today.value,baseline:prior.value+(today.flow??0)}]:[];});};
  // Phone snapshots when a buy or sell fills (only when phone alerts and snapshots are on).
  const phone=require('./phone-snapshot.cjs');const intraday=new phone.IntradayValues(store.db);
  // Only a value covering the account's markets: a Korea-only value of a two-market account would show as a fall.
  setInterval(()=>{try{const s=portfolioState();const v=s.totals.equityKRW??(automation.config.scope==='kis'?s.totals.KRW:null);if(kisState.snapshot?.accountKey&&!kisState.heldReading&&!kisState.snapshot.settlementProvisional&&!usHeldReading&&!usSnapshot?.settlementProvisional&&v!=null)intraday.record(kisState.snapshot.accountKey,v);}catch{}},60000).unref();
  notifier.render=spec=>require('./chart-image.cjs').renderChart(spec);
  const figures=()=>{const account=kisState.snapshot?.accountKey;const combined=account?performance.series(account,'COMBINED'):[];const daily=combined.length?combined:account?performance.series(account,'KRW'):[];
    return phone.portfolioFigures({portfolio:portfolioState(),daily,intraday:account?intraday.day(account):[],previousClose:symbol=>kisQuotes.get(symbol)?.previousClose??null,amounts:automation.config.phoneAmounts});};
  const phoneReady=()=>automation.config.mobileAlerts&&automation.config.phoneSnapshots;
  // The review that proposed an order (broker order ids are proposal ids; paper orders carry proposalId).
  // (electron/review-orders.cjs reviewForOrder: a further order's fill gets that order's own decision and plan.)
  const reviewFor=order=>require('./review-orders.cjs').reviewForOrder(store.db,order);
  notifier.onFill=order=>{if(!phoneReady())return false;
    return notifier.post(phone.tradeSnapshot({order,review:reviewFor(order),figures:figures(),regime:automation.regimeState()?.regime??null,conditional:automation.desk.orders(automation.watchScope()).length,name:master.get(order.symbol)?.name||order.symbol}));};
  ipcMain.handle('phone:test',event=>{authorize(event);if(!automation.config.mobileAlerts)return {ok:false,error:'PHONE_ALERTS_OFF'};if(!automation.providerStatus.pushConnected)return {ok:false,error:'NO_WEBHOOK'};notifier.post(phone.testSnapshot({figures:figures()}));return {ok:true};});
  const refreshBenchmarks=()=>{if(benchmarkTask||!kisState.snapshot)return benchmarkTask;const generation=kisGeneration;benchmarkTask=(async()=>{const today=require('./kis-activity.cjs').seoulDate();const first=performance.history(kisState.snapshot.accountKey)[0]?.day;
      for(const index of Object.keys(require('./performance.cjs').INDEXES)){const latest=performance.closes(index).at(-1)?.day;const start=latest??new Date(Math.min(Date.parse((first??today)+'T00:00:00Z')-10*86400000,Date.parse(today+'T00:00:00Z')-200*86400000)).toISOString().slice(0,10);const rows=await kisService.request('index-history',{request:{index,start,end:today}});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');performance.saveCloses(index,require('./performance.cjs').finishedRows(index,rows));}
      benchmarkAt=Date.now();benchmarkError=null;automation.detectEpisodes();})().catch(error=>{benchmarkError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'BENCHMARK_FAILED';}).finally(()=>{benchmarkTask=null;});return benchmarkTask;};
  // Every six hours, and soon after each Korean or U.S. close so the day's final closes replace nothing provisional.
  setInterval(()=>{if(Date.now()-benchmarkAt>6*3600000||require('./performance.cjs').closedSince(benchmarkAt))void refreshBenchmarks();},600000).unref();
  const performanceState=()=>{const account=kisState.snapshot?.accountKey;if(!account)return {connected:false,flows:[],summaries:{},benchmarks:{}};
    const summaries=Object.fromEntries(['COMBINED','KRW','USD'].map(kind=>[kind,performance.summary(account,kind,kind==='COMBINED'?'KOSPI':benchmarkFor(kind))]));
    return {connected:true,flows:performance.movements(account),summaries,benchmarks:Object.fromEntries(['KOSPI','SPX'].map(index=>[index,performance.closes(index).filter(c=>!summaries.COMBINED.start||c.day>=new Date(Date.parse(summaries.COMBINED.start+'T00:00:00Z')-7*86400000).toISOString().slice(0,10))])),benchmarkUpdatedAt:benchmarkAt||null,benchmarkError,refreshing:Boolean(benchmarkTask)};};
  automation.performanceSummary=market=>{const account=kisState.snapshot?.accountKey;if(!account)return null;const kind=market==='US'?'USD':'KRW';// Item 9 section 4: the review context keeps the figures it had ('exclude', no held changes): the model's input does
    // not change with the user's answer (A).
    const s=performance.summary(account,kind,benchmarkFor(kind),{unresolved:'exclude'});if(!s.start)return null;return {...require('./performance.cjs').reviewPerformance(s,{unconfirmed:performance.flows(account).filter(f=>f.detected&&!f.transfer&&f.market===market).map(f=>({day:f.day,amount:f.amount,currency:f.currency})),checking:require('./cash-checks.cjs').contextRows(flowDetector.pending(account)).filter(f=>f.market===market),uncertainKRW:market==='KR'?portfolioState().settlementUncertainKRW??0:0}),
    note:'Time-weighted returns use daily values recorded by this app and deposits/withdrawals, recorded by the user or detected by the app from cash changes no trade explains (unconfirmedFlows lists detected ones the user has not confirmed yet; cashChangesBeingChecked lists cash changes not yet explained, already in equity but not yet treated as deposits or withdrawals while the app looks for a matching exchange or settlement). Days without a return (unavailable: for example, the account or the settlement tracker could not be read that day) are unknown, not zero, and returns, drawdowns and gains spanning them are unavailable: never infer them from account values. accountingCorrections are settlement bookkeeping, not investment return. Performance touching any of these is not verified. returnReliability is separate from equityReliability: when it is false, these returns, daily P/L and drawdowns include cash movements that are not market performance; do not read them as evidence about holdings or the market, and say so if they bear on the decision. risk covers the last three months (or all history if shorter): peak and trough of daily values, drawdowns of the time-weighted index, annualized volatility of daily returns. Daily P/L excludes recorded deposits and withdrawals.'};};
  // R4 (release gate 1.5.52): a read that fails entirely is an error reply, never a rejection; the screens then say "The
  // performance records could not be read."
  const performanceStateSafe=()=>{try{return performanceState();}catch{return {connected:Boolean(kisState.snapshot),unreadable:true,flows:[],summaries:{},benchmarks:{}};}};
  // Item 9: an action may return a small result for the window (add-flow: the detected change your record replaced).
  const performanceAction=action=>async(event,...args)=>{authorize(event);try{const result=await action(...args);return {ok:true,state:performanceState(),...(result&&typeof result==='object'?{result}:{})};}catch(error){const state=performanceStateSafe();return {ok:false,error:state.unreadable?'PERFORMANCE_UNREADABLE':/^[A-Z_]{3,40}$/.test(error.message)?error.message:'PERFORMANCE_FAILED',state};}};
  ipcMain.handle('performance:get',performanceAction(()=>{recordValue();if(Date.now()-benchmarkAt>6*3600000)void refreshBenchmarks();}));
  // Holdings Movement cards (2026-11-11, artifacts/reviews/2026-11-11-holding-graphs), read-only. movement:records: the
  // recorded daily positions of the connected account (nav_history, the last 200 days) and the app's own filled orders
  // per symbol; movement:closes: one holding's daily closes from the research cache, fetched through the existing KIS
  // queue only when the cache has none or it is older than its 6-hour ttl. Nothing is written except that cache.
  ipcMain.handle('movement:records',event=>{authorize(event);const account=kisState.snapshot?.accountKey;if(!account)return {connected:false};
    const now=Date.now(),today=new Date(now+9*3600000).toISOString().slice(0,10),since=new Date(now+9*3600000-200*86400000).toISOString().slice(0,10);
    // Never throws (release gate 1.5.52, G3): a damaged row is left out and counted; a failed read is an error reply.
    const r=require('./movement-records.cjs').movementRecords({read:()=>store.db.prepare('SELECT day,payload FROM nav_history WHERE account=? AND day>=? ORDER BY day').all(account,since),orders:()=>automation.engineOrders()});
    return {connected:true,today,now,...r};});
  ipcMain.handle('movement:closes',async(event,symbol,refresh=false)=>{authorize(event);if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))return {error:'INVALID_REQUEST'};
    if(![...(kisState.snapshot?.holdings??[]),...(usSnapshot?.holdings??[])].some(h=>h.symbol===symbol))return {error:'NOT_HELD'};
    const shape=(value,at)=>({closes:(value?.closes??[]).filter(c=>c&&typeof c.date==='string'&&Number.isFinite(c.close)).map(({date,close})=>({date,close})),retrievedAt:at});
    const hit=research.cached(symbol,'daily');if(hit&&!refresh&&Date.now()-hit.at<6*3600000)return shape(hit.value,hit.at);
    try{const r=await research.source(symbol,'daily',Boolean(refresh));if(r.status==='ok')return shape(r.data,r.retrievedAt??Date.now());return hit?{...shape(hit.value,hit.at),stale:true}:{error:r.reason??'UNAVAILABLE'};}
    catch(error){return hit?{...shape(hit.value,hit.at),stale:true}:{error:kisErrorCode(error)};}});
  ipcMain.handle('performance:add-flow',performanceAction(value=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');const flow=performance.addFlow(kisState.snapshot.accountKey,value);return flow.replaced?{replaced:{amount:flow.replaced.amount,currency:flow.currency}}:null;}));
  ipcMain.handle('performance:confirm-flow',performanceAction(id=>{if(!kisState.snapshot||typeof id!=='string')throw new Error('INVALID_REQUEST');performance.confirmFlow(kisState.snapshot.accountKey,id);}));
  ipcMain.handle('performance:remove-flow',performanceAction(id=>{if(!kisState.snapshot||typeof id!=='string')throw new Error('INVALID_REQUEST');performance.removeFlow(kisState.snapshot.accountKey,id);try{flowDetector.noteRemoved(kisState.snapshot.accountKey,id);}catch{}}));
  // A detected inflow that was a dividend or interest becomes an income record, not a deposit: returns count it as income.
  ipcMain.handle('performance:flow-is-income',performanceAction(id=>{const account=kisState.snapshot?.accountKey;if(!account||typeof id!=='string')throw new Error('INVALID_REQUEST');const flow=performance.flows(account).find(f=>f.id===id);if(!flow?.detected||flow.transfer||!(flow.amount>0))throw new Error('INVALID_FLOW');
    costs.addIncome({symbol:'UNSPECIFIED',category:'dividend',payDate:flow.day,currency:flow.market==='US'?'USD':'KRW',country:flow.market==='US'?'US':'KR',net:flow.amount,gross:null,source:'detected-flow'});performance.removeFlow(account,id);try{flowDetector.noteRemoved(account,id);}catch{}}));
  ipcMain.handle('performance:refresh-benchmarks',performanceAction(()=>refreshBenchmarks()));
  // Macro inputs (ECOS / FRED) through the provider worker, refreshed every 6 hours while the app is open.
  // UI tests seed a snapshot and never reach the network.
  const {MacroStore}=require('./macro.cjs');const macro=new MacroStore(store.db);automation.macro=macro;let macroTask=null,macroAt=0,macroError=null;const macroSeed=process.env.PORTFOLIO_SMOKE_DATA?process.env.PORTFOLIO_MACRO_SEED??null:null;
  const refreshMacro=()=>{if(macroTask)return macroTask;macroTask=(async()=>{const result=macroSeed?{...JSON.parse(macroSeed),fetchedAt:Date.now()}:process.env.PORTFOLIO_SMOKE_DATA?null:await providerService.request('macro');if(result){macro.save(result);costs.saveRates(result.series.find(s=>s.id==='KR_USDKRW')?.history,'ECOS USD/KRW reference rate');}macroAt=Date.now();macroError=null;})().catch(error=>{macroError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'MACRO_FAILED';}).finally(()=>{macroTask=null;});return macroTask;};
  setTimeout(()=>{void refreshMacro();},macroSeed?0:30000).unref?.();setInterval(()=>{if(Date.now()-macroAt>6*3600000)void refreshMacro();},600000).unref();
  const macroState=()=>({snapshot:macro.get(),refreshing:Boolean(macroTask),error:macroError,ecosConnected:Boolean(automation.providerStatus.ecosConnected),fredConnected:Boolean(automation.providerStatus.fredConnected)});
  // What needs the user's attention, for the Overview panel and navigation badges. Read-only.
  const attentionState=()=>{
    const items=[],counts={approvals:{'KIS trading':0,'U.S. stocks':0},lessons:0,news:0},now=Date.now();const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
    // Item 9: a cash change the flow detector holds (not yet a return, a deposit or a withdrawal). One item per market,
    // or one for both when they may be an exchange; [Record it] opens Performance with the form filled (the draft).
    try{const a=kisState.snapshot?.accountKey;if(a)items.push(...require('./cash-checks.cjs').attentionItems(flowDetector.pending(a)));}catch{}
    // KIS's order history not read for more than 10 minutes: Korean rises cannot be checked against orders made outside the
    // app, so they wait 2 hours; said once, so a held change has a cause you can see.
    try{const a=kisState.snapshot?.accountKey;if(a&&automation.config.scope!=='paper'&&!historyReady()){historyUnreadSince??=now;if(now-historyUnreadSince>600000)items.push({id:'history-unread',tone:'info',title:'KIS order history not read yet · Korean cash changes wait 2 hours',detail:"The app has not yet read KIS's order history for today and for the days it missed, so a rise in Korean cash cannot be checked against orders you made outside the app. It is recorded after 2 hours instead of 10 minutes, or explained once the history is read.",tab:'Connections',action:'Open Connections'});}else historyUnreadSince=null;}catch{}
    // The buy-back list could not be built in the last 10 minutes: app buys there are not checked against it (said, never silent).
    // The app's own buys wait in a market whose orders made outside the app are not known (not read for 2 minutes since
    // the start, or the list failed in the last 10 minutes): the user's rule, said on Home.
    try{if(automation.config.scope!=='paper'&&kisState.snapshot?.accountKey){const waiting=[];for(const [e,n,m] of [[live,'Korean','KR'],[usLive,'U.S.','US']]){if(!e||!inScope(m))continue;const failed=e.buybackFailure&&now-e.buybackFailure.at<600000;
        if(historyReadyFor(e,m)&&!failed){e.buybackWaitSince=null;continue;}e.buybackWaitSince??=now;if(failed||now-e.buybackWaitSince>120000)waiting.push(n+(e.missedFailure?.tries>=3?` (the order history for ${e.missedFailure.day} could not be read)`:''));}
      if(waiting.length)items.push({id:'buyback-unread',tone:'warning',title:`App buys wait (${waiting.join(', ')}) · orders made outside the app not read yet`,detail:"The app has not read KIS's order history for the orders you made outside the app, so it cannot tell which stocks you sold there. Its own buys there wait until it has; your order ticket, sales, stops and covers are not held. If a day is named, the app keeps trying it every 5 minutes; reconnecting KIS on the Connections page may help.",tab:'Activity',action:'Open Activity'});}}catch{}
    // A deposit or withdrawal you confirmed that an order made outside the app explains (flow-detector settleRecorded).
    try{const a=kisState.snapshot?.accountKey;if(a)items.push(...require('./cash-checks.cjs').askItems(flowDetector.asks(a)));}catch{}
    // A stop closed or reduced because its shares were sold outside the app, or a question about one (closeStopsNotHeld),
    // until you dismiss it.
    try{for(const o of automation.stopNotices()){const k=o.notice.kind;items.push({id:'stop-notice-'+o.id,tone:k==='ask'?'action':'info',
      title:k==='closed'?`Stop for ${o.symbol} closed: you sold the shares outside the app`:k==='reduced'?`Stop for ${o.symbol} reduced to the shares you hold`:`Stop for ${o.symbol}: check it on the Agent Desk`,
      detail:o.notice.words,tab:'Journal',action:k==='ask'?'Open Agent Desk':'Open Journal',dismissible:true});}}catch{}
    if(!kisState.snapshot)items.push({id:'connect',tone:'info',title:'Connect your KIS account',detail:'Holdings, prices and broker trading appear after you import your KIS credentials.',tab:'Connections',action:'Open Connections'});
    for(const [engine,label,tab] of [[live,'Korea','KIS trading'],[usLive,'U.S.','U.S. stocks']]){try{const ready=engine.orders().filter(o=>o.status==='Ready'&&o.expiresAt>now);if(ready.length){counts.approvals[tab]=ready.length;items.push({id:'approve-'+tab,tone:'action',title:`${plural(ready.length,label+' order')} waiting for your approval`,detail:ready.slice(0,3).map(o=>`${o.side} ${o.quantity} ${o.symbol}`).join(' · ')+` · expires ${new Date(Math.min(...ready.map(o=>o.expiresAt))).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST`,tab,action:'Review orders'});}}catch{}}
    try{const learning=automation.memory.summary();if(learning.pending){counts.lessons=learning.pending;items.push({id:'lessons',tone:'info',title:`Optional: ${plural(learning.pending,'learning note')} to look at`,detail:'Learning feedback from completed trades. Nothing is waiting on it: no order and no money depends on this.',tab:'Journal',action:'Open Journal'});}}catch{}
    try{if(automation.guardrails.state(automation.config).trippedToday)items.push({id:'guardrail',tone:'warning',title:'A guardrail stopped auto trading today',detail:'Check the guardrail event before starting again.',tab:'Engine settings',action:'View guardrails'});}catch{}
    try{const emergency=automation.emergencyState();if(emergency.active)items.push({id:'emergency',tone:'warning',title:'Daily loss limit reached',detail:'Emergency loss-reduction reviews are active.',tab:'Engine settings',action:'Open engine'});
      if(emergency.unavailableMarkets?.length)items.push({id:'loss-unavailable',tone:'warning',title:'Daily loss check unavailable: new buys restricted',detail:`${emergency.unavailableMarkets.map(m=>m==='US'?'U.S.':'Korea').join(' and ')}: the data the check needs could not be read. Sales and covers are not held back.`,tab:'Engine settings',action:'Open engine'});
      if(emergency.lateMarkets?.length)items.push({id:'loss-late',tone:'warning',title:'Automatic new buys restricted for today',detail:`${emergency.lateMarkets.map(m=>m==='US'?'U.S.':'Korea').join(' and ')}: today's opening value could not be read, so an earlier loss cannot be ruled out. The loss since the value was read is still checked. Sales and covers are not held back.`,tab:'Engine settings',action:'Open engine'});}catch{}
    try{const b=automation.reviewBackoffState();if(b)items.push({id:'review-backoff',tone:'warning',title:'Automatic reviews paused after repeated failures',detail:`Until ${new Date(b.until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST. ${b.lastRule??''} Your own reviews still run; order tracking continues.`,tab:'AI console',action:'See details'});}catch{}
    // The provider wait (OpenAI refusal fix R3): one item per waiting provider, with the next try; details behind More.
    try{for(const w of automation.providerWaitState())items.push({id:'provider-wait-'+w.vendor,tone:'warning',title:w.kind==='quota'?`${w.name}: credit or spend limit used up`:`${w.name}: automatic AI calls waiting`,detail:`${w.summary} Your own reviews still run; stops and loss limits continue. Code ${w.code}${w.requestId?`, request ${w.requestId}`:''}.`,tab:'AI console',action:'See details'});}catch{}
    if(automation.lastError&&!automation.busy)items.push({id:'review-error',tone:'warning',title:'The last AI review failed',detail:String(automation.lastError).replaceAll('_',' ').toLowerCase(),tab:'AI console',action:'See details'});
    try{if(kisState.snapshot){for(const warning of exposure.creditRisk(kisState.snapshot.accountKey,kisState.snapshot,require('./kis-activity.cjs').seoulDate())?.warnings??[])items.push({id:'credit-'+warning.slice(0,30),tone:'warning',title:'Margin or short position needs attention',detail:warning,tab:'Short & leverage',action:'Open'});}}catch{}
    try{const important=automation.stateCached('newsEvents',()=>automation.newsEvents.list(100)).filter(e=>e.importance==='high'&&e.symbols?.length&&now-(e.firstSeenAt??0)<86400000);if(important.length){counts.news=important.length;items.push({id:'news',tone:'info',title:`${plural(important.length,'important disclosure')} about your stocks today`,detail:important.slice(0,2).map(e=>e.title).join(' · '),tab:'News',action:'Read'});}}catch{}
    try{for(const o of automation.desk.orders(automation.watchScope()))if(o.linkedBuy&&o.unreadableSince&&now-o.unreadableSince>300000)items.push({id:'stop-unreadable-'+o.id,tone:'warning',title:`Stop order for ${o.symbol} cannot read its purchase`,detail:'It stays armed and keeps trying; it sells nothing until the purchase can be read.',tab:'Journal',view:'Orders and triggers',action:'Orders and triggers'});}catch{}
    // Claude trading D-3: the first review on Claude waits for your press (run: 'review' starts it from Home).
    try{if(automation.claudeFirstReview()?.state==='pending'&&automation.vendorOf(automation.agentModel('trading').openaiModel)==='anthropic')items.push({id:'claude-first-review',tone:'action',title:'First review on Claude Opus 5.5 not run yet',detail:'Automatic reviews wait until it completes. Armed stops keep running.',tab:'Dashboard',action:'Run first review',run:'review'});}catch{}
    try{for(const f of automation.desk.planStopFailures(automation.watchScope()))items.push({id:'plan-stop-'+f.id,tone:'warning',title:`No stop order for the purchase of ${f.symbol}`,detail:`${f.quantity} ${f.symbol}: ${f.reason}`,tab:'Journal',view:'Orders and triggers',action:'Orders and triggers'});}catch{}
    // A plan stop armed fixed although its plan gave a trail (found in live use): until the trail is added at the fill.
    try{for(const o of automation.desk.plannedTrailsMissing(automation.watchScope()))items.push({id:'plan-trail-'+o.id,tone:'warning',title:`Stop for ${o.symbol} has no trailing`,detail:`A fixed stop at ${(v=>/:/.test(o.symbol)?Number(v).toFixed(2):Math.round(v).toLocaleString('en-US'))(o.conditions?.[0]?.value)} protects ${o.quantity} ${o.symbol}; its plan gave a trail. ${o.trailWanted&&o.linkedBuy?'The trail is added when the purchase fills. ':''}Why: ${o.trailNotUsed}`,tab:'Journal',view:'Orders and triggers',action:'Orders and triggers'});}catch{}
    try{if(restartNotice&&!restartNoticeDismissed&&!require('./auto-launch.cjs').launchState(automation).running)items.push({id:'restart-notice',tone:'warning',title:restartNotice.title,detail:restartNotice.message,tab:'Journal',view:'Orders and triggers',action:'Orders and triggers',dismissible:true});}catch{}
    if(updates.view().status==='downloaded')items.push({id:'update',tone:'info',title:`Version ${updates.view().available?.version} is ready to install`,detail:'Install from Connections when no trading is active.',tab:'Connections',action:'Install'});
    return {items,counts};
  };
  ipcMain.handle('workspace:attention',event=>{authorize(event);return attentionState();});
  // Start with Windows (restart part 1, step 3): read from Windows each time; set only by the installed app; a fake in test runs.
  const loginItem=require('./login-item.cjs').createLoginItem({app,packaged:app.isPackaged,fake:process.env.PORTFOLIO_SMOKE_DATA?{on:false}:null});
  ipcMain.handle('system:login-item',event=>{authorize(event);return loginItem.get();});
  ipcMain.handle('system:set-login-item',(event,on)=>{authorize(event);try{return loginItem.set(on);}catch{return {...loginItem.get(),error:'Invalid request.'};}});
  ipcMain.handle('workspace:dismiss',(event,id)=>{authorize(event);if(id==='restart-notice')restartNoticeDismissed=true;
    else if(typeof id==='string'&&/^flow-ask-[\w-]{1,80}$/.test(id)){const a=kisState.snapshot?.accountKey;if(a)flowDetector.dismissAsk(a,id.slice('flow-ask-'.length));}
    else if(typeof id==='string'&&/^stop-notice-[\w-]{1,80}$/.test(id))automation.acknowledgeStopNotice(id.slice('stop-notice-'.length));
    return attentionState();});
  // App updates from GitHub Releases, for installed builds only (PORTFOLIO_UPDATE_TEST names an update config file for local tests).
  // Only installer builds carry app-update.yml (and electron-updater); portable folder builds and source runs have no updates.
  const updateTest=Boolean(process.env.PORTFOLIO_UPDATE_TEST);const installed=app.isPackaged&&!process.env.PORTFOLIO_SMOKE_DATA&&require('node:fs').existsSync(path.join(process.resourcesPath,'app-update.yml'));
  const updates=new (require('./app-updates.cjs').AppUpdates)({updater:installed||updateTest?(()=>{const {autoUpdater}=require('electron-updater');if(updateTest){autoUpdater.forceDevUpdateConfig=true;autoUpdater.updateConfigPath=process.env.PORTFOLIO_UPDATE_TEST;}return autoUpdater;})():null,enabled:installed||updateTest,version:app.getVersion(),db:store.db,
    canInstall:()=>{if(automation.config.enabled&&automation.sessionArmed)return 'AUTO_TRADING_ARMED';if(automation.busy)return 'REVIEW_RUNNING';for(const engine of [live,usLive]){try{if(engine.orders().some(o=>['Submitting','Uncertain','Accepted','Partially filled'].includes(o.status)))return 'ORDERS_OPEN';}catch{}}return null;},
    onChange:state=>{for(const win of BrowserWindow.getAllWindows())win.webContents.send('update:changed',state);}});
  setTimeout(()=>updates.tick(),30000).unref?.();setInterval(()=>updates.tick(),600000).unref();
  const updateAction=action=>async(event,...args)=>{authorize(event);try{return {ok:true,state:await action(...args)};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'UPDATE_FAILED',state:updates.view()};}};
  ipcMain.handle('update:get',updateAction(()=>updates.view()));
  ipcMain.handle('update:check',updateAction(()=>updates.check()));
  ipcMain.handle('update:download',updateAction(()=>updates.download()));
  ipcMain.handle('update:install',updateAction(()=>updates.install()));
  ipcMain.handle('update:settings',updateAction(value=>updates.saveSettings(value)));
  // Broker-reported fees and taxes for executed orders, and reference exchange rates for the overseas tax ledger, every 15 minutes.
  let chargesTask=null,chargesAt=0,chargesError=null;
  // The broker's U.S. trade history (live accounts, read-only) is the tax record: from January of last year once a day,
  // in 90-day windows, and the last two weeks at every charges check. It runs as a job with a page and time budget
  // (TradingCosts.syncHistory): a window is imported only when read whole, one that is not stays a gap the tax report
  // names and is retried with backoff, and a job that stops resumes from its unread ranges at the next check.
  const importTaxTrades=async()=>{const s=kisState.snapshot;if(s?.environment!=='live'||!usLive)return;const {seoulDate}=require('./kis-activity.cjs'),{windows}=require('./trade-history.cjs');const today=seoulDate();
    // S-2: the day of the last full read is kept in the database (costs.fullReadDay), not only in this run's memory.
    const full=costs.fullReadDay(s.accountKey)!==today,from=full?`${Number(today.slice(0,4))-1}-01-01`:seoulDate(Date.now()-14*86400000);
    const r=await costs.syncHistory(s.accountKey,(a,b,o)=>usBroker.request('charges',{start:a,end:b,...o}),{plan:()=>windows(from,today)});
    if(r.planned&&full)costs.setFullReadDay(s.accountKey,today);if(r.code)throw new Error(r.code);};
  const refreshCharges=()=>{if(chargesTask)return chargesTask;chargesTask=(async()=>{
      if(kisState.snapshot){for(const engine of [live,usLive]){try{await engine.refreshCharges();}catch(error){chargesError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'CHARGES_FAILED';}}try{await importTaxTrades();}catch(error){chargesError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'TAX_IMPORT_FAILED';}}
      const days=costs.missingRateDays();if(days.length&&!process.env.PORTFOLIO_SMOKE_DATA)costs.saveRates(await providerService.request('fx-rates',{days}),'ECOS USD/KRW reference rate');
      chargesAt=Date.now();})().catch(error=>{chargesError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'CHARGES_FAILED';}).finally(()=>{chargesTask=null;});return chargesTask;};
  setInterval(()=>{void refreshCharges();},15*60000).unref();
  // A first check soon after start, so the tax record does not wait a quarter of an hour.
  setTimeout(()=>{void refreshCharges();},2*60000).unref();
  ipcMain.handle('costs:tax-summary',event=>{authorize(event);return {...costs.taxSummary(),refreshedAt:chargesAt||null,error:chargesError,refreshing:Boolean(chargesTask),environment:kisState.snapshot?.environment??null};});
  ipcMain.handle('costs:refresh-charges',async event=>{authorize(event);chargesError=null;await refreshCharges();return {...costs.taxSummary(),refreshedAt:chargesAt||null,error:chargesError,refreshing:false,environment:kisState.snapshot?.environment??null};});
  ipcMain.handle('macro:get',event=>{authorize(event);return macroState();});
  ipcMain.handle('macro:refresh',async event=>{authorize(event);await refreshMacro();return macroState();});
  // Learning scoreboard: daily closes for symbols with recent Buy/Sell decisions and scout picks, a few symbols per pass.
  const {closesFromCandles}=require('./scoreboard.cjs');let closesTask=null,closesAt=0,closesError=null;
  const refreshDecisionCloses=()=>{if(closesTask||!kisState.snapshot)return closesTask;const generation=kisGeneration;closesTask=(async()=>{
      // Scout picks share the price table, so their 5- and 20-day results fill in with the same fetches.
      for(const symbol of [...new Set([...automation.scoreboard.pendingSymbols(10),...automation.scoutScorecard.pendingSymbols(10)])].slice(0,14)){const snapshot=await kisService.request('company-chart',{request:{symbol,dataset:'daily_technicals'}});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');automation.scoreboard.saveCloses(symbol,closesFromCandles(symbol,snapshot.candles));}
      closesAt=Date.now();closesError=null;})().catch(error=>{closesError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'PRICE_HISTORY_FAILED';}).finally(()=>{closesTask=null;});return closesTask;};
  setInterval(()=>{if(Date.now()-closesAt>6*3600000)void refreshDecisionCloses();},600000).unref();
  const scoreboardState=()=>({...automation.scoreboard.build(),pricesUpdatedAt:closesAt||null,pricesError:closesError,refreshing:Boolean(closesTask),benchmarkUpdatedAt:benchmarkAt||null});
  const scoreboardAction=action=>async(event,...args)=>{authorize(event);try{await action(...args);return {ok:true,state:scoreboardState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'SCOREBOARD_FAILED'};}};
  ipcMain.handle('scoreboard:get',scoreboardAction(()=>{if(Date.now()-closesAt>6*3600000)void refreshDecisionCloses();if(Date.now()-benchmarkAt>6*3600000)void refreshBenchmarks();}));
  ipcMain.handle('scoreboard:refresh',scoreboardAction(async()=>{await refreshBenchmarks();await refreshDecisionCloses();}));
  const discoveryState=()=>({master:master.status(),watchlist:automation.discovery.list(),connected:Boolean(watchScope()),monitoring:automation.monitoring()});
  const discoveryAction=action=>async(event,...args)=>{authorize(event);try{const data=await action(...args);return {ok:true,data,state:discoveryState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DISCOVERY_FAILED',state:discoveryState()};}};
  ipcMain.handle('discovery:get',discoveryAction(()=>null));
  // Latest quotes the app already polls for watchlist and held symbols; no extra broker calls.
  ipcMain.handle('discovery:quotes',event=>{authorize(event);const out={};for(const [symbol,q] of kisQuotes){const at=q.source==='stream'?q.receivedAt:q.retrievedAt;out[symbol]={price:q.price,previousClose:q.previousClose??null,changePct:q.previousClose?Math.round((q.price/q.previousClose-1)*10000)/100:q.changePct??null,at,source:q.source};}for(const q of automation.usQuotes??[])if(q?.symbol&&Number.isFinite(q.price))out[q.symbol]={price:q.price,previousClose:null,changePct:null,at:q.retrievedAt??null,source:'rest'};return out;});
  ipcMain.handle('discovery:search',discoveryAction((query,market)=>{if(typeof query!=='string'||![null,'KR','US'].includes(market??null))throw new Error('INVALID_REQUEST');return master.search(query,{market:market??null,limit:30}).map(securityRow);}));
  ipcMain.handle('discovery:screen',discoveryAction(query=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');return screener.screen(query);}));
  ipcMain.handle('discovery:watch',discoveryAction((action,symbol,value)=>{if(action==='add')setTimeout(()=>void pollKisQuotes(),0);const scope=watchScope();if(!scope)throw new Error('KIS_NOT_CONNECTED');if(action==='add')return watchlist.add(scope,symbol,{source:'user',reason:typeof value==='string'?value.slice(0,300):''}).entry;if(action==='remove')return watchlist.remove(scope,symbol);if(action==='pin')return watchlist.pin(scope,symbol,value===true);throw new Error('INVALID_REQUEST');}));
  ipcMain.handle('discovery:refresh-master',discoveryAction(()=>masterFetch?master.refresh(true):master.status()));
  const {lightState,historyOf}=require('./runtime-state.cjs');
  const runtimeState=()=>lightState({...automation.getState(),funding:(()=>{try{return automation.fundingState?.()??null;}catch{return null;}})(),launch:require('./auto-launch.cjs').launchState(automation),connections:remembered.state(),bridgePipe:agentBridge.pipe,bridgeScript:path.join(__dirname,'../scripts/agent-bridge.cjs'),notifications:notifier.status()},{version:automation.historyVersion()});
  ipcMain.handle('connections:forget',(event,kind)=>{authorize(event);if(!['kis','providers','calendar'].includes(kind))throw new Error('INVALID_REQUEST');if(remembered.progress[kind]==='connecting')return runtimeState();remembered.forget(kind);if(kind==='calendar'){calendarService.disconnect();return runtimeState();}if(kind==='providers'){providerService.disconnect();automation.providerStatus={aiConnected:false,openaiConnected:false,anthropicConnected:false,dartConnected:false,pushConnected:false};}else{live.stop();usLive?.stop();usSnapshot=null;if(usLive)usLive.refreshError=null;usHeldReading=null;kisGeneration++;kisService.disconnect();kisQuotes.clear();kisHistory.clear();streamState={status:'disconnected',subscribed:0};kisState={status:'disconnected',snapshot:null,error:null};broadcastMarket();}return runtimeState();});
  ipcMain.handle('connections:reconnect',async(event,kind)=>{authorize(event);if(!['kis','providers','calendar'].includes(kind))throw new Error('INVALID_REQUEST');const file=remembered.get(kind);if(file&&remembered.progress[kind]!=='connecting'){try{await(kind==='kis'?connectKisFile(file):kind==='calendar'?connectCalendarFile(file):connectProviderFile(file));}catch{}}return runtimeState();});
  ipcMain.handle('calendar:import',async event=>{authorize(event);if(remembered.progress.calendar==='connecting')return {ok:false,error:'BUSY',state:runtimeState()};
    const selected=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'Import a live KIS key for the market calendar',filters:[{name:'Credential JSON',extensions:['json']}],properties:['openFile']});if(selected.canceled)return {ok:true,state:runtimeState()};
    try{remembered.forget('calendar');await connectCalendarFile(selected.filePaths[0]);return {ok:true,state:runtimeState()};}catch{return {ok:false,error:remembered.errors.calendar,state:runtimeState()};}});
  const SEC_EMAIL=/^[^\s@<>()"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  const secState=()=>({email:secContact(),fromFile:Boolean(automation.providerStatus.secConnected),ready:Boolean(automation.providerStatus.secConnected||secContact())});
  ipcMain.handle('sec:get',event=>{authorize(event);return secState();});
  ipcMain.handle('sec:set',(event,email)=>{authorize(event);const value=typeof email==='string'?email.trim():'';if(value&&!SEC_EMAIL.test(value))return {ok:false,error:'INVALID_EMAIL',state:secState()};store.setSetting('sec-contact-email',value||null);research.failures?.clear?.();return {ok:true,state:secState()};});
  // A test request for Apple's filings: proves sec.gov accepts the contact. Sends the email to sec.gov only.
  ipcMain.handle('sec:test',async event=>{authorize(event);if(!secState().ready)return {ok:false,error:'SEC_CONTACT_MISSING'};
    try{const r=await providerService.request('sec-company',{symbol:'NASD:AAPL',contact:secContact()});if(r?.status==='unavailable')return {ok:false,error:r.reason};return {ok:true,name:r.name,latestFiscalYear:r.annual?.[0]?.fiscalYearEnd??null,filings:r.filings?.length??0};}
    catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'SEC_UNAVAILABLE'};}});
  // Session status for both markets: every session today, what is open, what is next, and which ones this account can trade.
  ipcMain.handle('market:status',event=>{authorize(event);const {marketStatus}=require('./market-sessions.cjs');const official=officialKrCalendar();const closedDays=new Set([...official.filter(r=>!r.open).map(r=>r.day),...(automation.closedDays??[])]);const environment=kisState.snapshot?.environment??'mock';
    const enabled=automation.sessionOptions();return {at:Date.now(),environment,enabled,KR:marketStatus('KR',Date.now(),{closedDays,environment,enabled}),US:marketStatus('US',Date.now(),{environment,enabled}),calendar:{KR:official.length?{source:'KIS official calendar',days:official.length,updatedAt:calendarAt||null,error:calendarError}:{source:remembered.progress.calendar==='connected'?'KIS official calendar (loading)':'Weekdays only; add a live key in Connections for official holidays',days:0,updatedAt:null,error:calendarError},US:{source:'NYSE holiday and early-close rules (checked against nyse.com for 2026–2027)'}}};});
  const liveAction=action=>async(event,...args)=>{authorize(event);try{const data=await action(...args);return {ok:true,data,state:live.getState()};}catch(error){const allowed=['NO_FUNDED_BALANCE','INVALID_LOSS_LIMIT','ACTIVATION_REQUIRED','INVALID_LIMITS','APPROVAL_REQUIRED','KIS_NOT_CONNECTED','KIS_TRADING_DISABLED','INVALID_ORDER','INSTRUMENT_NOT_ALLOWED','ORDER_SIZE_LIMIT','KIS_ORDER_BUSY','UNKNOWN_ORDER','DISABLED_OR_EXPIRED','RECONCILIATION_REQUIRED','DAILY_TURNOVER_LIMIT','DAILY_LOSS_LIMIT','CONCENTRATION_LIMIT','SESSION_CLOSED','PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','FEATURE_UNAVAILABLE','LEVERAGED_NOT_ENABLED','SINGLE_STOCK_LEVERAGED','LEVERAGED_EXPOSURE_LIMIT','MARGIN_NOT_ENABLED','MARGIN_LIMIT','SHORT_NOT_ENABLED','SHORT_LIMIT','LIMIT_CHANGED','CREDIT_ACCOUNT_REQUIRED','DAILY_SESSION_SETUP_REQUIRED','BROKER_ORDER_MISMATCH','BUYBACK_BLOCKED','BUYBACK_UNKNOWN'];const r=require('./buyback.cjs').refusalReply(error,c=>allowed.includes(c));return {ok:false,...r,error:r.error??'KIS_ORDER_FAILED',state:live.getState()};}};
  ipcMain.handle('live:get',liveAction(()=>live.getState()));
  ipcMain.handle('live:configure',liveAction((value,phrase)=>live.configure(value,phrase)));
  ipcMain.handle('live:stop',liveAction(()=>live.stop()));
  ipcMain.handle('live:auto',liveAction(phrase=>live.enableAuto(phrase)));
  ipcMain.handle('live:auto-off',liveAction(()=>{live.autoEnabled=false;return live.getState();}));
  // An order ticket is the user's own order: marked so (order-origin.cjs madeBy 'ticket').
  ipcMain.handle('live:propose',liveAction(command=>{const p=live.propose(command,{ticket:true});return (p?.id&&live.annotate(p.id,{madeBy:'ticket'}))||p;}));
  ipcMain.handle('live:submit',liveAction((id,phrase)=>live.submit(id,phrase)));
  ipcMain.handle('live:reconcile',liveAction(()=>live.reconcile()));
  ipcMain.handle('live:link',liveAction((id,brokerId,phrase)=>live.linkUncertain(id,brokerId,phrase)));
  ipcMain.handle('runtime:start',async(event,token)=>{authorize(event);try{const message=await require('./auto-launch.cjs').start(automation,token);return {ok:true,message,state:runtimeState()};}catch(error){return {ok:false,error:error.text??error.message,state:runtimeState()};}});
  ipcMain.handle('runtime:stop',event=>{authorize(event);try{const message=require('./auto-launch.cjs').stop(automation);return {ok:true,message,state:runtimeState()};}catch(error){return {ok:false,error:error.text??error.message,state:runtimeState()};}});
  ipcMain.handle('runtime:get',event=>{authorize(event);return runtimeState();});
  ipcMain.handle('runtime:history',event=>{authorize(event);return historyOf(automation.getState());});
  ipcMain.handle('runtime:configure',(event,value)=>{authorize(event);try{automation.configure(value);return {ok:true,state:runtimeState()};}catch(error){return {ok:false,error:error?.message==='CLAUDE_NOT_ENABLED_FOR_TRADING'||/^CLAUDE_DRY_RUN_REQUIRED:(scout|narrative|compacting|reflection)$/.test(error?.message??'')||/^CLAUDE_TRADING_(DRY_RUN|KEY|CONSENT|LIMITS|CONFIRM)$/.test(error?.message??'')||error?.message==='CLAUDE_MODEL_NOT_FOR_TRADING'?error.message:'INVALID_SETTINGS'};}});
  ipcMain.handle('runtime:digest-preview',event=>{authorize(event);return require('./daily-digest.cjs').buildDigest(automation);});
  ipcMain.handle('runtime:reset-watches',event=>{authorize(event);automation.revision=(automation.revision??0)+1;automation.watches.reset(automation.watchScope());return runtimeState();});
  ipcMain.handle('scout:screens',event=>{authorize(event);try{return automation.scoutScreens();}catch{return {failed:false,at:null,screens:[]};}});
  ipcMain.handle('scout:run',async event=>{authorize(event);try{await automation.scout();return {ok:true,state:runtimeState()};}catch{return {ok:false,error:automation.scoutError??'SCOUT_FAILED',state:runtimeState()};}});
  ipcMain.handle('runtime:dry-run-estimate',(event,options)=>{authorize(event);return automation.dryRunEstimate({model:options?.model==='claude-opus-5-5'?'claude-opus-5-5':null});});
  ipcMain.handle('runtime:dry-run',async(event,mode,options)=>{authorize(event);const started=Date.now();try{const record=await automation.dryRun(mode,options&&typeof options==='object'?{model:options.model??null}:{});return {ok:true,record,state:runtimeState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DRY_RUN_FAILED',failure:automation.dryRunFailure(started),state:runtimeState()};}});
  ipcMain.handle('runtime:background-ai',(event,paused)=>{authorize(event);try{automation.setBackgroundPaused(paused);return {ok:true,state:runtimeState()};}catch(error){return {ok:false,error:error.message,state:runtimeState()};}});
  ipcMain.handle('runtime:review',async event=>{authorize(event);try{await automation.review();return {ok:true,state:runtimeState()};}catch{return {ok:false,error:automation.lastError??'REVIEW_FAILED',message:automation.lastErrorDetail??'Review failed.',state:runtimeState()};}});
  ipcMain.handle('runtime:providers',async event=>{
    if(remembered.progress.providers==='connecting'){authorize(event);return {ok:false,error:'BUSY',state:runtimeState()};}
    authorize(event);const selected=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'Import provider configuration',filters:[{name:'Provider JSON',extensions:['json']}],properties:['openFile']});
    if(selected.canceled)return {ok:true,state:runtimeState()};
    try{remembered.forget('providers');await connectProviderFile(selected.filePaths[0]);return {ok:true,state:runtimeState()};}
    catch{return {ok:false,error:'PROVIDER_IMPORT_FAILED',state:runtimeState()};}
  });
  ipcMain.handle('runtime:news',async event=>{authorize(event);await refreshNews();return runtimeState();});
  ipcMain.handle('runtime:outcome-history',(event,id)=>{authorize(event);return automation.outcomes.history(id);});
  ipcMain.handle('runtime:lesson-trial',(event,action,id,value)=>{authorize(event);try{automation.syncLearning();if(automation.learningError)throw Error('LOCAL_EVALUATION_FAILED');if(action==='start')automation.trials.start(id,value);else if(action==='stop')automation.trials.stop(id);else throw Error('INVALID_TRIAL');return {ok:true,state:runtimeState()};}catch(error){return {ok:false,error:['LESSON_CHANGED','INVALID_TRIAL','TRIAL_ACTIVE','TRIAL_NOT_FOUND'].includes(error.message)?error.message:'LOCAL_EVALUATION_FAILED'};}});
  ipcMain.handle('runtime:review-lesson',(event,id,value)=>{authorize(event);try{automation.syncLearning();if(automation.learningError)throw new Error('LESSON_REVIEW_FAILED');automation.memory.review(id,value);return {ok:true,state:runtimeState()};}catch(error){return {ok:false,error:['LESSON_CHANGED','OUTCOME_NOT_FINAL','INVALID_LESSON_REVIEW','LESSON_NOT_FOUND'].includes(error.message)?error.message:'LESSON_REVIEW_FAILED',state:runtimeState()};}});
  ipcMain.handle('runtime:lesson',(event,id,approved)=>{authorize(event);try{automation.approveLesson(id,approved);return {ok:true,state:runtimeState()};}catch{return {ok:false,error:'INVALID_REQUEST'};}});
  ipcMain.handle('news:suggested',event=>{authorize(event);return require('./news.cjs').SUGGESTED_FEEDS;});
  ipcMain.handle('runtime:open-news',(event,url)=>{authorize(event);if(typeof url==='string'&&(automation.news.some(item=>item.url===url)||automation.newsEvents.list(300).some(item=>item.url===url)))void shell.openExternal(url);});
  const paperAction=action=>event=>{authorize(event);try{return {ok:true,data:action()};}catch{return {ok:false,error:'PAPER_REQUEST_FAILED'};}};
  ipcMain.handle('paper:get',paperAction(()=>paper.getState()));
  ipcMain.handle('paper:loss',(event,value)=>{authorize(event);try{return {ok:true,state:paper.configureLoss(value)};}catch{return {ok:false,error:'INVALID_LOSS_LIMIT'};}});
  ipcMain.handle('paper:caps',(event,value)=>{authorize(event);try{return {ok:true,state:paper.configureCaps(value)};}catch{return {ok:false,error:'INVALID_LIMITS'};}});
  ipcMain.handle('paper:propose',(event,command)=>{authorize(event);try{return {ok:true,data:paper.propose(command),state:paper.getState()};}catch{return {ok:false,error:'INVALID_REQUEST'};}});
  ipcMain.handle('paper:submit',(event,id)=>{authorize(event);try{if(typeof id!=='string')throw 0;return {ok:true,data:paper.submit(id),state:paper.getState()};}catch{return {ok:false,error:'PAPER_REQUEST_FAILED'};}});
  ipcMain.handle('paper:pause',(event,paused)=>{authorize(event);try{return {ok:true,state:paper.setPaused(paused)};}catch{return {ok:false,error:'INVALID_REQUEST'};}});
  ipcMain.handle('paper:cancel',(event,id)=>{authorize(event);try{if(typeof id!=='string')throw 0;return {ok:true,state:paper.cancel(id)};}catch{return {ok:false,error:'PAPER_REQUEST_FAILED'};}});
  marketTimer = setInterval(publishMarket,1000);
  quoteTimer=setInterval(()=>void pollKisQuotes(),30000);
  accountTimer=setInterval(()=>void refreshKisBalance(),120000);
  snapshotTimer = setInterval(()=> {
    if (!feedPaused) store.saveSnapshot({...syntheticState().snapshot,timestamp:new Date().toISOString()});
  },30000);
  ipcMain.handle('market:get',event=>{authorize(event);return marketState();});
  ipcMain.handle('market:pause',(event,paused)=>{
    authorize(event);
    if(kisState.snapshot)return;
    if (typeof paused !== 'boolean') throw new Error('Invalid feed control');
    feedPaused=paused;
    if (paused) marketProvider.stop(); else startFeed();
    publishMarket();
  });
  ipcMain.handle('market:history',async(event,symbol,interval)=>{
    authorize(event);
    if(!kisState.snapshot)return marketProvider.getHistory(symbol,interval);
    if(!['1d','1m','5m'].includes(interval) || !kisState.snapshot.holdings.some(h=>h.symbol===symbol))throw new Error('Unsupported instrument or interval');
    const key=symbol+':'+interval;
    const existing=kisHistory.get(key);
    const duration=interval==='1d'?60000:30000;
    if(existing && existing.bucket===Math.floor(Date.now()/duration))return existing.candles;
    const generation=kisGeneration;
    const candles=await kisService.request('history',{symbol,interval});
    if(generation!==kisGeneration)throw new Error('Connection changed');
    kisHistory.set(key,{bucket:Math.floor(Date.now()/duration),candles});return candles;
  });
  ipcMain.handle('snapshot:get', event => { authorize(event); return store.latestSnapshot(); });
  ipcMain.handle('theme:get', event => { authorize(event); return store.getTheme(); });
  ipcMain.handle('theme:set', (event, theme) => {
    authorize(event);
    const value = store.setTheme(theme);
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('theme:changed', value);
    return value;
  });
  ipcMain.handle('kis:get',event=>{authorize(event);return kisState;});
  // The last report per kind, for Activity and Performance to show at once (activity-cache.cjs, Activity step 2).
  const activityCache=new (require('./activity-cache.cjs').ActivityCache)(store.db);
  // The Today strip (activity-today.cjs, Activity step 3): today's app orders from its own records; no KIS request.
  // Reviews are read only for orders made before the madeBy mark, and then only their ids (order-origin.cjs).
  ipcMain.handle('activity:today',event=>{authorize(event);try{const O=require('./order-origin.cjs'),T=require('./activity-today.cjs');
      const intents=[...(live?.orders?.()??[]),...(usLive?.orders?.()??[])].map(({accountKey,...o})=>o);const day=T.seoulDay(Date.now());
      const unmarked=intents.some(o=>T.seoulDay(o.createdAt)===day&&!o.madeBy);
      return {ok:true,data:T.today({intents,reviews:unmarked?O.reviewIdRows(store.db,Date.now()-2*86400000):[],conditionals:O.conditionalRows(store.db)})};}catch{return {ok:false};}});
  ipcMain.handle('kis:activity-cached',(event,kind)=>{authorize(event);const row=activityCache.get(kind,kisState.snapshot?.accountKey??null);return row?{ok:true,data:row.data}:{ok:false};});
  ipcMain.handle('kis:activity',async(event,kind,startDate,endDate,options={})=>{
    authorize(event);
    if(!kisState.snapshot)return {ok:false,error:'NOT_CONNECTED'};
    // An automatic refresh never runs ahead of an account request, a review or an order (the history read holds the
    // KIS queue for all its pages); the screen keeps what it shows and says why.
    if(options?.automatic===true){const skipped=require('./activity-cache.cjs').skipReason({kisBusy,reviewBusy:Boolean(automation?.busy),orderHeld:Boolean(kisService.holding)});if(skipped)return {ok:false,error:'SKIPPED',skipped};}
    if(kisBusy)return {ok:false,error:'BUSY'};
    if(!['orders','profit'].includes(kind))return {ok:false,error:'INVALID_REQUEST'};
    const generation=kisGeneration,account=kisState.snapshot.accountKey??null;
    try {
      require('./kis-activity.cjs').validateRange(startDate,endDate);
      let data=await kisService.request(kind,{startDate,endDate});
      // Orders cover both markets: U.S. orders join the Korean ones; if the U.S. part fails, the Korean report still shows.
      if(kind==='orders'){let us=[],usError=null;try{const rows=await kisService.request('us-order-history',{startDate,endDate});if(Array.isArray(rows))us=rows;else usError='INVALID_RESPONSE';}catch(error){usError=kisErrorCode(error);}
        data={...data,orders:[...(data.orders??[]).map(o=>({...o,market:'KR',currency:'KRW'})),...us].sort((a,b)=>b.timestamp-a.timestamp),...(usError?{usError}:{})};
        // The totals' guard: a chain the app knows whose rows fill more than its order is marked (activity-chains.cjs).
        try{const intents=[...(live?.orders?.()??[]),...(usLive?.orders?.()??[])];data={...data,orders:require('./activity-chains.cjs').markChains(data.orders,intents)};
          // Where each order came from, and the orders the app did not send (activity-origin.cjs, Activity step 4). Review
          // ids are read (in SQL) only when an order of the period has no origin mark.
          const O=require('./order-origin.cjs'),since=Date.parse(startDate+'T00:00:00+09:00'),unmarked=intents.some(o=>!o.madeBy&&o.createdAt>=since);
          data={...data,orders:require('./activity-origin.cjs').labelRows(data.orders,intents,{reviews:unmarked?O.reviewIdRows(store.db,since):[],conditionals:O.conditionalRows(store.db),startDate,endDate})};}catch{}}
      if(generation!==kisGeneration)return {ok:false,error:'CONNECTION_CHANGED'};
      activityCache.put(kind,account,data);
      return {ok:true,data};
    }catch(error){return {ok:false,error:kisErrorCode(error)};}
  });
  ipcMain.handle('kis:import',async event=>{
    authorize(event);
    if(kisBusy)return {...kisState,error:'BUSY'};
    kisBusy=true;
    try {
      const selected=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'Import KIS credentials',filters:[{name:'Credential JSON',extensions:['json']}],properties:['openFile']});
      if(selected.canceled || !selected.filePaths[0])return kisState;
      remembered.forget('kis');await connectKisFile(selected.filePaths[0]);
    } catch(error) {kisService.disconnect();kisState={status:'disconnected',snapshot:null,error:kisErrorCode(error)};}
    finally {kisBusy=false;broadcastMarket();void pollKisQuotes();}
    return kisState;
  });
  ipcMain.handle('kis:refresh',async event=>{authorize(event);return refreshKisBalance();});
  ipcMain.handle('kis:disconnect',event=>{authorize(event);remembered.progress.kis='disconnected';live.stop();usLive?.stop();usSnapshot=null;if(usLive)usLive.refreshError=null;usHeldReading=null;kisGeneration++;streamState={status:'disconnected',subscribed:0};kisQuotes.clear();kisHistory.clear();kisService.disconnect();kisState={status:'disconnected',snapshot:null,error:null};broadcastMarket();return kisState;});
  ipcMain.handle('events:get', event => { authorize(event); return events; });
  ipcMain.handle('events:export',async event=>{authorize(event);const selected=await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender),{title:'Export interaction journal',defaultPath:'portfolio-journal.json',filters:[{name:'JSON',extensions:['json']}]});if(!selected.canceled&&selected.filePath)await require('node:fs/promises').writeFile(selected.filePath,JSON.stringify({exportedAt:new Date().toISOString(),events,reviews:automation.getState().reviews,lessons:automation.getState().lessons},null,2));});
  ipcMain.handle('demo:run', async event => {
    if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('TEST_ONLY');
    authorize(event);
    if (running) return;
    running = true;
    try {
      const state = syntheticState();
      const run = domain.demoEvents(require('node:crypto').randomUUID(), new Date().toISOString(), {...state.snapshot,market:{source:state.source,status:state.status,quotes:state.quotes.map(({symbol,timestamp,stale})=>({symbol,timestamp,stale}))}});
      for (const item of run) {
        await new Promise(resolve => setTimeout(resolve, 400));
        store.appendEvent({ ...item, timestamp: new Date().toISOString() });
        events = store.getEvents();
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('events:changed', events);
      }
    } finally { running = false; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'File',submenu:[{role:'quit'}]},{role:'editMenu'},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},{role:'windowMenu'}]));
  createWindow();
  if(!verificationDirectory)void remembered.restore({kis:connectKisFile,providers:file=>connectProviderFile(file,false),calendar:file=>connectCalendarFile(file).catch(()=>{})});
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}).catch(() => { dialog.showErrorBox('Startup failed', 'The local portfolio database could not be opened. The app will close without submitting any orders.'); app.exit(1); });
app.on('will-quit', () => {
  try{exitRecord?.stop('clean');}catch{}
  closing=true;if(automation)automation.disposed=true;if(notifier)notifier.disposed=true;live?.stop();
  agentBridge?.close();providerService.disconnect();
  kisService.disconnect();
  clearInterval(quoteTimer);clearInterval(accountTimer);
  clearInterval(marketTimer); clearInterval(snapshotTimer); marketProvider?.stop();
  if (store && marketCache && !feedPaused) store.saveSnapshot({...syntheticState().snapshot,timestamp:new Date().toISOString()});
  store?.close();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
