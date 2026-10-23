const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu } = require('electron');
if(!process.env.PORTFOLIO_SMOKE_DATA&&!app.requestSingleInstanceLock()){app.quit();process.exit(0);}
let mainWindow=null;const chartWindows=new Map();
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
kisService.onQuote=quote=>{
  if(!kisState.snapshot?.holdings.some(row=>row.symbol===quote.symbol))return;
  const previous=kisQuotes.get(quote.symbol);
  if(previous?.source==='stream' && (quote.timestamp<previous.timestamp || quote.timestamp===previous.timestamp && quote.cumulativeVolume<=previous.cumulativeVolume))return;
  // Streamed ticks carry only the price; the previous close from the last REST quote is kept for day change.
  kisQuotes.set(quote.symbol,{symbol:quote.symbol,price:quote.price,timestamp:quote.timestamp,receivedAt:quote.receivedAt,cumulativeVolume:quote.cumulativeVolume,previousClose:previous?.previousClose??null,source:'stream'});
};
let kisState = {status:'disconnected',snapshot:null,error:null};
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
let automation;let notifier;let agentBridge;let live;let remembered;let detectFlows=()=>{};let newsBusy=false;let lastNews=0;let closing=false;let lastReconcile=0;
async function connectProviderFile(file,selectProvider=true){
  remembered.progress.providers='connecting';remembered.errors.providers=null;
  try{providerService.disconnect();const flags=await providerService.request('import',file);if(closing)return;automation.providerStatus=flags;if(flags.aiConnected&&selectProvider)automation.configure({provider:'openai'});remembered.remember('providers',file);remembered.progress.providers='connected';}
  catch{if(closing)return;providerService.disconnect();automation.providerStatus={aiConnected:false,dartConnected:false,pushConnected:false};remembered.progress.providers='error';remembered.errors.providers='Could not reopen provider JSON. Reimport it if moved, deleted or invalid.';throw new Error('PROVIDER_IMPORT_FAILED');}
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
  kisBusy=true;live.stop();usLive?.stop();usSnapshot=null;const generation=++kisGeneration;remembered.progress.kis='connecting';remembered.errors.kis=null;streamState={status:'connecting',subscribed:0};nextQuoteAttempt=0;kisQuotes.clear();kisHistory.clear();kisService.disconnect();kisState={status:'connecting',snapshot:null,error:null};broadcastMarket();
  try{const snapshot=await kisService.request('import',file);if(closing||generation!==kisGeneration)return;kisState={status:'connected',snapshot,error:null};remembered.remember('kis',file);remembered.progress.kis='connected';}
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
function marketState() {return kisState.snapshot?{...buildKisMarket(kisState,kisQuotes),connectionId:kisGeneration,stream:streamState,revision:++revision}:syntheticState();}
function broadcastMarket() {const state=marketState();for(const win of BrowserWindow.getAllWindows())win.webContents.send('market:changed',state);}
async function pollKisQuotes() {
  if(kisService.isBusy || kisBusy || quoteBusy || !kisState.snapshot || Date.now()<nextQuoteAttempt)return;
  quoteBusy=true;const generation=kisGeneration;
  try {
    const watched=automation?.watches.list(automation.watchScope()).map(row=>row.symbol).filter(symbol=>/^\d{6}$/.test(symbol))??[];const selected=live?.getState().policy?.symbols??[];
    const quotes=await kisService.request('quotes',{symbols:[...new Set([...watched,...selected,...kisState.snapshot.holdings.map(row=>row.symbol),...(automation?.discovery?.symbols('KR')??[])])].filter(symbol=>/^\d{6}$/.test(symbol)).slice(0,20)});
    if(generation===kisGeneration) {
      for(const quote of quotes){const previous=kisQuotes.get(quote.symbol);if(previous?.source!=='stream' || Date.now()-previous.receivedAt>60000)kisQuotes.set(quote.symbol,{...quote,source:'rest'});else if(quote.previousClose)kisQuotes.set(quote.symbol,{...previous,previousClose:quote.previousClose});}
      broadcastMarket();
    }
  } catch(error) {if(generation===kisGeneration && kisState.snapshot){const code=kisErrorCode(error);if(code==='RATE_LIMITED')nextQuoteAttempt=Date.now()+120000;kisState={...kisState,status:'error',error:code};broadcastMarket();}}
  finally {quoteBusy=false;}
}
async function refreshKisBalance() {
  if(kisService.isBusy || kisBusy || !kisState.snapshot)return kisState;
  kisBusy=true;const generation=kisGeneration;
  try {
    const snapshot=await kisService.request('refresh');
    if(generation===kisGeneration){kisState={status:'connected',snapshot,error:null};live?.observeBalance(snapshot);detectFlows();kisQuotes=new Map([...kisQuotes].filter(([symbol])=>snapshot.holdings.some(h=>h.symbol===symbol)));broadcastMarket();}
  } catch(error){if(generation===kisGeneration){kisState={...kisState,status:'error',error:kisErrorCode(error)};broadcastMarket();}}
  finally {kisBusy=false;}
  return kisState;
}
app.setName('Financial Portfolio Manager');
const verificationDirectory=process.argv.includes('--verify-build')?process.env.PORTFOLIO_VERIFY_DIR:null;
if(verificationDirectory){if(!path.isAbsolute(verificationDirectory))throw new Error('Absolute verification directory required');app.setPath('userData',verificationDirectory);}
const page = path.join(__dirname, '../dist/index.html');
const allowedURL = pathToFileURL(page).href;
function authorize(event) {
  if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('#')[0] !== allowedURL || !BrowserWindow.fromWebContents(event.sender)) throw new Error('Unauthorized IPC sender');
}
function createWindow() {
  const win = new BrowserWindow({ show:!verificationDirectory, width: 1360, height: 880, minWidth: 760, minHeight: 600, backgroundColor: store?.getTheme() === 'light' ? '#f3f6fa' : '#181818', title: 'Financial Portfolio Manager', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  if(verificationDirectory)win.webContents.once('did-finish-load',async()=>{try{await new Promise(resolve=>setTimeout(resolve,200));const result=await win.webContents.executeJavaScript("Promise.all([document.querySelector('h1').textContent,typeof window.require,window.portfolio.getPaper(),window.portfolio.liveAction('get'),window.portfolio.getRuntime()])");if(result[0]!=='Home'||result[1]!=='undefined'||!result[2].data.account.paused||result[3].state.enabled||result[4].config.enabled)throw 0;
    // The provider worker is forked from inside the app archive; an empty rate request proves it starts without network use.
    const rates=await providerService.request('fx-rates',{days:[]});if(!Array.isArray(rates))throw 0;
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
  store = new PortfolioStore(path.join(app.getPath('userData'), 'portfolio.sqlite'));
  remembered=new (require('./remembered-files.cjs').RememberedFiles)(store.db);
  events = store.getEvents();
  if (!store.latestSnapshot()) store.saveSnapshot({timestamp:new Date().toISOString(), cash:domain.cash, holdings:domain.holdings});
  const market = await import('../src/market.mjs');
  marketCache = new market.MarketCache(store.latestSnapshot().holdings.map(row=>row.symbol));
  marketProvider = new market.SyntheticMarketProvider(store.latestSnapshot().holdings);
  const startFeed = () => marketProvider.start(quote=>marketCache.accept(quote));
  const publishMarket = () => {
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
  costs=new TradingCosts(store.db);live.costs=costs;automation.costs=costs;
  // Leveraged/inverse products, margin and short policy per account.
  const exposure=new (require("./exposure.cjs").Exposure)(store.db);live.exposure=exposure;
  const usBroker={request:(operation,payload)=>kisService.request(operation==='live-context'?'us-context':'us-'+operation,payload)};
  usLive=new LiveEngine(store.db,usBroker,()=>({snapshot:kisState.snapshot&&usSnapshot?.accountKey===kisState.snapshot.accountKey+':US'?usSnapshot:null}),{market:'US'});
  // U.S. buying power capped at real cash: USD, plus settled KRW when integrated margin is on (one pool shared with Korea).
  live.sessionOptions=usLive.sessionOptions=()=>automation.sessionOptions();live.extendedMaxOrderPct=usLive.extendedMaxOrderPct=()=>automation.config.extendedMaxOrderPct;
  usLive.buyingPower=balance=>require('./buying-power.cjs').usBuyingPower({usdCash:balance?.cash??0,broker:balance?.brokerBuyingPower??null,krwCash:kisState.snapshot?(Number.isFinite(kisState.snapshot.settledCash)?kisState.snapshot.settledCash:kisState.snapshot.cash):null,usdKRW:balance?.fx?.usdKRW??automation?.fx?.()?.usdKRW??null});usLive.costs=costs;usLive.exposure=exposure;automation.usLive=usLive;
  let usRefreshTask=null,usRefreshGeneration=-1;
  automation.refreshUS=()=>{if(usRefreshTask&&usRefreshGeneration===kisGeneration)return usRefreshTask;const generation=kisGeneration;usRefreshGeneration=generation;lastUSRefresh=Date.now();const task=(async()=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');const selected=usLive.getState().policy?.symbols??[];const watched=automation.watches.list(automation.watchScope()).map(row=>row.symbol).filter(symbol=>/^(NASD|NYSE|AMEX):/.test(symbol));const listedUS=automation.discovery?.symbols('US')??[];// Review watches are price alerts on symbols already reviewed; only the watchlist, allowlist or holdings replace starters.
    const starterUS=await usStarters.symbols({scope:watchScope(),watched:listedUS,allowed:selected,holdings:(usSnapshot?.holdings??[]).map(row=>row.symbol)}).catch(()=>[]);const listed=[...new Set([...listedUS,...starterUS,...(()=>{try{return scoutTargets('US');}catch{return [];}})()])];const symbols=watched.length||listed.length?[...new Set([...watched,...(selected.length?selected:(usSnapshot?.holdings??[]).map(row=>row.symbol)),...listed])].slice(0,20):selected;
      // Session switches go along so an enabled U.S. extended session counts as open for the review.
      const value=await kisService.request('us-context',{symbols,sessions:automation.sessionOptions()});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');if(!value.balance||value.balance.accountKey!==kisState.snapshot?.accountKey+':US')throw new Error('ACCOUNT_CHANGED');usSnapshot=value.balance;usLive.refreshWarnings=value.warnings??[];usLive.refreshError=null;usLive.brokerCode=null;usLive.httpStatus=null;automation.usQuotes=value.quotes.map(row=>({...row,timestamp:row.retrievedAt}));usLive.observeBalance(value.balance);detectFlows();return value;})().catch(error=>{if(generation===kisGeneration){usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);usLive.brokerCode=/^[A-Z0-9_-]{1,24}$/.test(error.brokerCode??'')?error.brokerCode:null;usLive.httpStatus=Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?error.httpStatus:null;}throw error;}).finally(()=>{if(usRefreshTask===task)usRefreshTask=null;});usRefreshTask=task;return task;};
  const portfolioView=new PortfolioView(store.db);automation.metadata=()=>portfolioView.metadata();automation.fx=()=>usSnapshot?.fx??(costs.get().usdKRW?{usdKRW:costs.get().usdKRW,source:'User indicative rate',timestamp:null}:null);
  const portfolioState=()=>{const kr=kisState.snapshot?{...kisState.snapshot,holdings:buildKisMarket(kisState,kisQuotes).snapshot.holdings}:null;return {...combinePortfolio(kr,usSnapshot,automation.fx(),portfolioView.metadata()),valuationSample:Math.floor(Date.now()/1000),sessions:{KR:live.enabled,US:usLive.enabled},usError:usLive.refreshError??null,brokerCode:usLive.brokerCode??null,httpStatus:usLive.httpStatus??null,warnings:usLive.refreshWarnings??[]};};
  const companyCache=new Map();let companyBusy=false;
  ipcMain.handle('chart:pop-out',(event,symbol)=>{authorize(event);if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))throw new Error('INVALID_REQUEST');openChartWindow(symbol);return true;});
  ipcMain.handle('company:get',async(event,symbol)=>{authorize(event);if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/.test(symbol)))return {error:'Enter a six-digit Korean code or exchange:ticker, such as NASD:AAPL.'};if(!kisState.snapshot)return {error:'Connect your KIS account first.'};const generation=kisGeneration,key=generation+':'+symbol,cached=companyCache.get(key);if(cached&&Date.now()-cached.timestamp<30000)return cached.value;if(companyBusy)return {error:'Another company request is loading. Please retry.'};companyBusy=true;
    try{const value={symbol};for(const [name,dataset] of [['company','company'],['daily','daily_technicals'],['minute','minute_technicals']]){try{value[name]=await kisService.request('company-chart',{request:{symbol,dataset}});}catch{value[name]={status:'unavailable'};}}if(generation!==kisGeneration)return {error:'Account changed. Refresh the company view.'};if(companyCache.size>30)companyCache.clear();companyCache.set(key,{timestamp:Date.now(),value});return value;}finally{companyBusy=false;}
  });
  ipcMain.handle('portfolio:get',event=>{authorize(event);return portfolioState();});
  ipcMain.handle('portfolio:metadata',(event,symbol,value)=>{authorize(event);portfolioView.save(symbol,value);return portfolioState();});
  ipcMain.handle('portfolio:refresh',async event=>{authorize(event);await refreshKisBalance();if(kisState.snapshot){try{await automation.refreshUS();}catch(error){usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);}}return portfolioState();});
  const exposureState=()=>{const accounts={KR:kisState.snapshot?.accountKey??null,US:usSnapshot?.accountKey&&kisState.snapshot&&usSnapshot.accountKey===kisState.snapshot.accountKey+':US'?usSnapshot.accountKey:null};
    const market=(key,snapshot)=>accounts[key]?{account:true,policy:exposure.policy(accounts[key]),summary:exposure.summary(snapshot?.holdings??[],snapshot?.reportedTotal??0,Date.now(),symbol=>(key==='KR'?live:usLive).firstBought(symbol)),...(key==='KR'?{credit:exposure.creditRisk(accounts.KR,snapshot??{},require('./kis-activity.cjs').seoulDate())}:{})}:{account:false};
    return {markets:{KR:market('KR',kisState.snapshot),US:market('US',usSnapshot)},overrides:exposure.overrides(),environment:kisState.snapshot?.environment??null};};
  const exposureAction=action=>async(event,...args)=>{authorize(event);try{await action(...args);return {ok:true,state:exposureState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED',state:exposureState()};}};
  ipcMain.handle('exposure:get',exposureAction(()=>{}));
  ipcMain.handle('exposure:save-policy',exposureAction((market,value)=>{const account=exposureState().markets[market]?.account?(market==='KR'?kisState.snapshot.accountKey:usSnapshot.accountKey):null;if(!account)throw new Error('KIS_NOT_CONNECTED');if(market==='US'&&value&&(value.margin||value.short))throw new Error('FEATURE_UNAVAILABLE');exposure.savePolicy(account,value);}));
  ipcMain.handle('exposure:set-override',exposureAction((symbol,factor)=>exposure.setOverride(symbol,factor)));
  ipcMain.handle('costs:get',event=>{authorize(event);return costs.saved();});
  ipcMain.handle('costs:save',(event,value)=>{authorize(event);return costs.save(value);});
  for(const name of ['get','refresh','configure','stop','auto','auto-off','propose','submit','reconcile','link'])ipcMain.handle('us:'+name,async(event,...args)=>{authorize(event);try{let data;if(name==='get')data=null;else if(name==='refresh'){if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');await automation.refreshUS();data=null;}else if(name==='auto-off'){usLive.autoEnabled=false;}else if(name==='auto')data=usLive.enableAuto(...args);else if(name==='link')data=await usLive.linkUncertain(...args);else data=await usLive[name](...args);return {ok:true,data,state:usLive.getState()};}catch(error){if(name==='refresh'){usLive.refreshError=require('./us-errors.cjs').publicUSCode(error.message);usLive.brokerCode=/^[A-Z0-9_-]{1,24}$/.test(error.brokerCode??'')?error.brokerCode:null;}const allowed=['NO_FUNDED_BALANCE','LEVERAGED_NOT_ENABLED','LEVERAGED_EXPOSURE_LIMIT','KIS_NOT_CONNECTED','ACTIVATION_REQUIRED','INVALID_LIMITS','INVALID_ORDER','SESSION_CLOSED','PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','RECONCILIATION_REQUIRED','KIS_TRADING_DISABLED','DISABLED_OR_EXPIRED','BROKER_REJECTED','ORDER_UNCERTAIN','ACCOUNT_CHANGED','BROKER_ORDER_MISMATCH'];return {ok:false,error:allowed.includes(error.message)?error.message:require('./us-errors.cjs').publicUSCode(error.message),state:usLive.getState()};}});
  
  notifier=new Notifications(store.db,providerService,()=>({...automation.config,pushConnected:automation.providerStatus.pushConnected}),message=>{if(Notification.isSupported())new Notification({title:'Financial Portfolio Manager',body:message}).show();});
  automation.notify=(id,message)=>notifier.notify(id,message);
  agentBridge=require('./agent-bridge.cjs').startBridge(app.getPath('userData'),paper,decision=>automation.review('External agent',decision));
  automation.evidence=new (require('./market-evidence.cjs').MarketEvidence)(async(args,context)=>{
    if(context.environment==='local-paper'){
      if(args.dataset==='company')return {status:'unavailable',reason:'SIMULATION_HAS_NO_COMPANY_FUNDAMENTALS'};
      const interval=args.dataset==='daily_technicals'?'1d':'1m';return {status:'available',source:'synthetic',retrievedAt:Date.now(),data:require('./market-evidence.cjs').technicals(marketProvider.getHistory(args.symbol,interval),interval,args.dataset)};
    }
    const generation=kisGeneration;const result=await kisService.request('market-evidence',{request:args});if(generation!==kisGeneration)throw new Error('ACCOUNT_CHANGED');return result;
  });
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
  const research=new (require('./research-service.cjs').ResearchService)({db:store.db,master,kis:(operation,payload)=>kisService.request(operation,payload),provider:(operation,payload)=>providerService.request(operation,['sec-company','sec-filings'].includes(operation)?{...payload,contact:secContact()}:payload),kisReady:()=>Boolean(kisState.snapshot),dartReady:()=>Boolean(automation.providerStatus.dartConnected),secReady:()=>Boolean(automation.providerStatus.secConnected||secContact())});
  automation.discovery.marketOverview=async()=>{const m=await research.market();if(m.status!=='ok')return {status:'unavailable',reason:m.reason};const sectors=m.data.kospiSectors??[];return {asOf:new Date(m.retrievedAt).toISOString(),...m.data,kospiSectors:undefined,strongestSectors:sectors.slice(0,8),weakestSectors:sectors.length>8?sectors.slice(-6).reverse():[],foreignTopBuys:m.data.foreignTopBuys?.slice(0,6),institutionTopBuys:m.data.institutionTopBuys?.slice(0,6)};};
  ipcMain.handle('research:market',async(event,refresh)=>{authorize(event);return research.market(refresh===true);});
  automation.discovery.research=args=>research.agent(args);
  // Daily closes for the agents' formulas, triggers and conditional orders, from the research cache.
  // Index closes and the cached market overview feed the market narrative and the episode library.
  // The performance store is created further down; until then there are no closes.
  automation.indexCloses=()=>{try{return Object.fromEntries(Object.keys(require('./performance.cjs').INDEXES).map(index=>[index,performance.closes(index).slice(-90)]));}catch{return {};}};
  automation.marketOverviewCache=()=>{const hit=research.cached('MARKET','market');return hit?{value:hit.value,at:hit.at}:null;};
  automation.freshenMarket=async()=>{if(!kisState.snapshot)return;const F=require('./market-freshness.cjs');if(!F.krOpen(Date.now(),{closedDays:new Set([...(automation.closedDays??[]),...(automation.officialClosedDays?.()??[])])}))return;await research.market();};
  ipcMain.handle('narrative:refresh',async event=>{authorize(event);try{await automation.buildNarrative();return {ok:true,state:automation.narrativeState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'NARRATIVE_FAILED',state:automation.narrativeState()};}});
  ipcMain.handle('narrative:hide',(event,id,hidden)=>{authorize(event);automation.narratives.hide(String(id),hidden!==false);return automation.narrativeState();});
  // Holdings for exposure and sizing; sector names come from cached quotes.
  automation.portfolioHoldings=()=>{try{const st=portfolioState();const fx=st.fx?.usdKRW??null;return {holdings:st.rows.filter(r=>r.valueKRW>0).map(r=>({symbol:r.symbol,name:r.name,market:r.market,valueKRW:r.valueKRW})),cashKRW:(st.cash.KRW??0)+(fx?(st.cash.USD??0)*fx:0),equityKRW:st.totals.equityKRW??st.totals.KRW};}catch{return null;}};
  automation.loggedEvents=()=>events;
  ipcMain.handle('replay:list',event=>{authorize(event);return {runs:automation.replays.runs(),busy:Boolean(automation.replaying)};});
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
  const deskAction=action=>(event,...args)=>{authorize(event);const scope=automation.watchScope();if(!scope)throw new Error('KIS_NOT_CONNECTED');action(scope,...args);return automation.deskState();};
  ipcMain.handle('desk:cancel-trigger',deskAction((scope,id)=>automation.desk.cancelTrigger(scope,String(id))));
  ipcMain.handle('desk:delete-note',deskAction((scope,symbol)=>automation.desk.deleteNote(scope,String(symbol??''))));
  ipcMain.handle('desk:cancel-order',deskAction((scope,id)=>automation.desk.cancelOrder(scope,String(id))));
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
  // Performance history: daily account values, recorded cash flows and benchmark closes.
  const {PerformanceHistory,benchmarkFor}=require('./performance.cjs');const performance=new PerformanceHistory(store.db);let benchmarkTask=null,benchmarkAt=0,benchmarkError=null;
  // Test-only: UI tests seed earlier daily values because history cannot be backfilled from KIS.
  if(process.env.PORTFOLIO_SMOKE_DATA&&process.env.PORTFOLIO_PERFORMANCE_SEED){const seed=JSON.parse(process.env.PORTFOLIO_PERFORMANCE_SEED);for(const row of seed.history)store.db.prepare('INSERT OR REPLACE INTO nav_history VALUES(?,?,?)').run(seed.account,row.day,JSON.stringify(row));for(const review of seed.reviews??[])store.db.prepare('INSERT OR REPLACE INTO reviews VALUES(?,?)').run(review.id,JSON.stringify(review));}
  // Deposits and withdrawals not recorded by the user, detected after each balance refresh (electron/flow-detector.cjs).
  const flowDetector=new (require('./flow-detector.cjs').FlowDetector)(store.db,performance);
  detectFlows=()=>{try{const s=kisState.snapshot;if(!s?.accountKey)return;const kr=Number.isFinite(s.settledCash)?s.settledCash:s.cash;
    for(const flow of flowDetector.observe(s.accountKey,{krCash:kr,usCash:usSnapshot?.accountKey===s.accountKey+':US'?usSnapshot.cash:null,fx:automation.fx?.()?.usdKRW??null,orders:[...live.orders(),...(usLive?.orders()??[])]}))automation.noteDetectedFlow(flow);}catch{}};
  live.flowsToday=()=>{const a=kisState.snapshot?.accountKey;return a?performance.flowsOn(a,require('./kis-activity.cjs').seoulDate(),'KR'):0;};
  usLive.flowsToday=()=>{const a=kisState.snapshot?.accountKey;return a?performance.flowsOn(a,require('./kis-activity.cjs').seoulDate(),'US'):0;};
  const recordValue=()=>{try{if(kisState.snapshot?.accountKey)performance.record(kisState.snapshot.accountKey,portfolioState());}catch{}};
  setInterval(recordValue,60000).unref();
  setInterval(()=>{if(Date.now()-calendarAt>6*3600000)void refreshKrCalendar();},600000).unref();
  automation.officialClosedDays=()=>officialKrCalendar().filter(r=>!r.open).map(r=>r.day);
  // Daily digest fallback: today's recorded value against the previous recorded day, per market.
  automation.accountValues=day=>{const account=kisState.snapshot?.accountKey;if(!account)return [];return [['KR','KRW','Korea'],['US','USD','U.S.']].flatMap(([market,currency,label])=>{const points=performance.series(account,currency);const today=points.find(p=>p.day===day),prior=points.filter(p=>p.day<day).at(-1);return today&&prior?[{market,currency,label,equity:today.value,baseline:prior.value+(today.flow??0)}]:[];});};
  // Phone snapshots when a buy or sell fills (only when phone alerts and snapshots are on).
  const phone=require('./phone-snapshot.cjs');const intraday=new phone.IntradayValues(store.db);
  setInterval(()=>{try{const s=portfolioState();if(kisState.snapshot?.accountKey)intraday.record(kisState.snapshot.accountKey,s.totals.equityKRW??s.totals.KRW);}catch{}},60000).unref();
  notifier.render=spec=>require('./chart-image.cjs').renderChart(spec);
  const figures=()=>{const account=kisState.snapshot?.accountKey;const combined=account?performance.series(account,'COMBINED'):[];const daily=combined.length?combined:account?performance.series(account,'KRW'):[];
    return phone.portfolioFigures({portfolio:portfolioState(),daily,intraday:account?intraday.day(account):[],previousClose:symbol=>kisQuotes.get(symbol)?.previousClose??null,amounts:automation.config.phoneAmounts});};
  const phoneReady=()=>automation.config.mobileAlerts&&automation.config.phoneSnapshots;
  // The review that proposed an order (broker order ids are proposal ids; paper orders carry proposalId).
  const reviewFor=order=>{for(const row of store.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 300').all()){const r=JSON.parse(row.payload);if(r.orderId===order.id||r.proposalId===order.id||order.proposalId&&r.proposalId===order.proposalId)return r;}return null;};
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
    return {connected:true,flows:performance.flows(account),summaries,benchmarks:Object.fromEntries(['KOSPI','SPX'].map(index=>[index,performance.closes(index).filter(c=>!summaries.COMBINED.start||c.day>=new Date(Date.parse(summaries.COMBINED.start+'T00:00:00Z')-7*86400000).toISOString().slice(0,10))])),benchmarkUpdatedAt:benchmarkAt||null,benchmarkError,refreshing:Boolean(benchmarkTask)};};
  automation.performanceSummary=market=>{const account=kisState.snapshot?.accountKey;if(!account)return null;const kind=market==='US'?'USD':'KRW';const s=performance.summary(account,kind,benchmarkFor(kind));if(!s.start)return null;return {since:s.start,currency:kind,benchmark:s.benchmark==='SPX'?'S&P 500':'KOSPI',timeWeightedReturns:s.periods.filter(p=>p.twr!=null).map(p=>({period:p.label,from:p.start,partial:p.partial,returnPct:+(p.twr*100).toFixed(2),benchmarkPct:p.benchmark==null?null:+(p.benchmark*100).toFixed(2)})),...(()=>{const a=s.analytics?.['3M']??s.analytics?.All;if(!a)return {};const m1=s.analytics?.['1M'];const day=d=>d&&{day:d.day,returnPct:d.returnPct,pnl:Math.round(d.pnl)};const top=(a.contributions??[]).filter(c=>c.change!==0);
      return {risk:{window:`${a.from} to ${a.to}`,peak:{value:Math.round(a.peak.value),day:a.peak.day},trough:{value:Math.round(a.trough.value),day:a.trough.day},maxDrawdownPct:a.maxDrawdownPct,currentDrawdownPct:a.currentDrawdownPct,maxDrawdown1mPct:m1?.maxDrawdownPct??null,volatilityPct:a.volatilityPct,bestDay:day(a.bestDay),worstDay:day(a.worstDay),positiveDaysPct:a.positiveDaysPct},
        recentDailyPnl:a.dailyPnl.slice(-5).map(p=>({day:p.day,pnl:p.pnl==null?null:Math.round(p.pnl),returnPct:p.returnPct})),unrealizedPnl:a.unrealized==null?null:Math.round(a.unrealized),cashSharePct:a.cashSharePct,
        holdingContribution:top.length?{basis:'Change in unrealized P/L over the window',best:top.slice(0,3).map(c=>({symbol:c.symbol,change:Math.round(c.change),status:c.status})),worst:top.slice(-3).reverse().filter(c=>c.change<0).map(c=>({symbol:c.symbol,change:Math.round(c.change),status:c.status}))}:undefined};})(),
    ...(()=>{const pending=performance.flows(account).filter(f=>f.detected&&f.market===market).map(f=>({day:f.day,amount:f.amount,currency:f.currency}));return pending.length?{unconfirmedFlows:pending}:{};})(),
    note:'Time-weighted returns use daily values recorded by this app and deposits/withdrawals, recorded by the user or detected by the app from cash changes no trade explains (unconfirmedFlows lists detected ones the user has not confirmed yet). risk covers the last three months (or all history if shorter): peak and trough of daily values, drawdowns of the time-weighted index, annualized volatility of daily returns. Daily P/L excludes recorded deposits and withdrawals.'};};
  const performanceAction=action=>async(event,...args)=>{authorize(event);try{await action(...args);return {ok:true,state:performanceState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'PERFORMANCE_FAILED',state:performanceState()};}};
  ipcMain.handle('performance:get',performanceAction(()=>{recordValue();if(Date.now()-benchmarkAt>6*3600000)void refreshBenchmarks();}));
  ipcMain.handle('performance:add-flow',performanceAction(value=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');performance.addFlow(kisState.snapshot.accountKey,value);}));
  ipcMain.handle('performance:confirm-flow',performanceAction(id=>{if(!kisState.snapshot||typeof id!=='string')throw new Error('INVALID_REQUEST');performance.confirmFlow(kisState.snapshot.accountKey,id);}));
  ipcMain.handle('performance:remove-flow',performanceAction(id=>{if(!kisState.snapshot||typeof id!=='string')throw new Error('INVALID_REQUEST');performance.removeFlow(kisState.snapshot.accountKey,id);}));
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
    if(!kisState.snapshot)items.push({id:'connect',tone:'info',title:'Connect your KIS account',detail:'Holdings, prices and broker trading appear after you import your KIS credentials.',tab:'Connections',action:'Open Connections'});
    for(const [engine,label,tab] of [[live,'Korea','KIS trading'],[usLive,'U.S.','U.S. stocks']]){try{const ready=engine.orders().filter(o=>o.status==='Ready'&&o.expiresAt>now);if(ready.length){counts.approvals[tab]=ready.length;items.push({id:'approve-'+tab,tone:'action',title:`${plural(ready.length,label+' order')} waiting for your approval`,detail:ready.slice(0,3).map(o=>`${o.side} ${o.quantity} ${o.symbol}`).join(' · ')+` · expires ${new Date(Math.min(...ready.map(o=>o.expiresAt))).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST`,tab,action:'Review orders'});}}catch{}}
    try{const learning=automation.memory.summary();if(learning.pending){counts.lessons=learning.pending;items.push({id:'lessons',tone:'info',title:`${plural(learning.pending,'lesson')} to review`,detail:'Approve useful lessons from completed trades so future reviews can use them.',tab:'Journal',action:'Open Journal'});}}catch{}
    try{if(automation.guardrails.state(automation.config).trippedToday)items.push({id:'guardrail',tone:'warning',title:'A guardrail stopped auto trading today',detail:'Check the guardrail event before starting again.',tab:'Engine settings',action:'View guardrails'});}catch{}
    try{const emergency=automation.emergencyState();if(emergency.active)items.push({id:'emergency',tone:'warning',title:'Daily loss limit reached',detail:'Emergency loss-reduction reviews are active.',tab:'Engine settings',action:'Open engine'});}catch{}
    if(automation.lastError&&!automation.busy)items.push({id:'review-error',tone:'warning',title:'The last AI review failed',detail:String(automation.lastError).replaceAll('_',' ').toLowerCase(),tab:'AI console',action:'See details'});
    try{if(kisState.snapshot){for(const warning of exposure.creditRisk(kisState.snapshot.accountKey,kisState.snapshot,require('./kis-activity.cjs').seoulDate())?.warnings??[])items.push({id:'credit-'+warning.slice(0,30),tone:'warning',title:'Margin or short position needs attention',detail:warning,tab:'Short & leverage',action:'Open'});}}catch{}
    try{const important=automation.newsEvents.list(100).filter(e=>e.importance==='high'&&e.symbols?.length&&now-(e.firstSeenAt??0)<86400000);if(important.length){counts.news=important.length;items.push({id:'news',tone:'info',title:`${plural(important.length,'important disclosure')} about your stocks today`,detail:important.slice(0,2).map(e=>e.title).join(' · '),tab:'News',action:'Read'});}}catch{}
    if(updates.view().status==='downloaded')items.push({id:'update',tone:'info',title:`Version ${updates.view().available?.version} is ready to install`,detail:'Install from Connections when no trading is active.',tab:'Connections',action:'Install'});
    return {items,counts};
  };
  ipcMain.handle('workspace:attention',event=>{authorize(event);return attentionState();});
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
  const refreshCharges=()=>{if(chargesTask)return chargesTask;chargesTask=(async()=>{
      if(kisState.snapshot){for(const engine of [live,usLive]){try{await engine.refreshCharges();}catch(error){chargesError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'CHARGES_FAILED';}}}
      const days=costs.missingRateDays();if(days.length&&!process.env.PORTFOLIO_SMOKE_DATA)costs.saveRates(await providerService.request('fx-rates',{days}),'ECOS USD/KRW reference rate');
      chargesAt=Date.now();})().catch(error=>{chargesError=/^[A-Z_]{3,40}$/.test(error.message)?error.message:'CHARGES_FAILED';}).finally(()=>{chargesTask=null;});return chargesTask;};
  setInterval(()=>{void refreshCharges();},15*60000).unref();
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
  const discoveryState=()=>({master:master.status(),watchlist:automation.discovery.list(),connected:Boolean(watchScope())});
  const discoveryAction=action=>async(event,...args)=>{authorize(event);try{const data=await action(...args);return {ok:true,data,state:discoveryState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DISCOVERY_FAILED',state:discoveryState()};}};
  ipcMain.handle('discovery:get',discoveryAction(()=>null));
  // Latest quotes the app already polls for watchlist and held symbols; no extra broker calls.
  ipcMain.handle('discovery:quotes',event=>{authorize(event);const out={};for(const [symbol,q] of kisQuotes){const at=q.source==='stream'?q.receivedAt:q.retrievedAt;out[symbol]={price:q.price,previousClose:q.previousClose??null,changePct:q.previousClose?Math.round((q.price/q.previousClose-1)*10000)/100:q.changePct??null,at,source:q.source};}for(const q of automation.usQuotes??[])if(q?.symbol&&Number.isFinite(q.price))out[q.symbol]={price:q.price,previousClose:null,changePct:null,at:q.retrievedAt??null,source:'rest'};return out;});
  ipcMain.handle('discovery:search',discoveryAction((query,market)=>{if(typeof query!=='string'||![null,'KR','US'].includes(market??null))throw new Error('INVALID_REQUEST');return master.search(query,{market:market??null,limit:30}).map(securityRow);}));
  ipcMain.handle('discovery:screen',discoveryAction(query=>{if(!kisState.snapshot)throw new Error('KIS_NOT_CONNECTED');return screener.screen(query);}));
  ipcMain.handle('discovery:watch',discoveryAction((action,symbol,value)=>{if(action==='add')setTimeout(()=>void pollKisQuotes(),0);const scope=watchScope();if(!scope)throw new Error('KIS_NOT_CONNECTED');if(action==='add')return watchlist.add(scope,symbol,{source:'user',reason:typeof value==='string'?value.slice(0,300):''}).entry;if(action==='remove')return watchlist.remove(scope,symbol);if(action==='pin')return watchlist.pin(scope,symbol,value===true);throw new Error('INVALID_REQUEST');}));
  ipcMain.handle('discovery:refresh-master',discoveryAction(()=>masterFetch?master.refresh(true):master.status()));
  const runtimeState=()=>({...automation.getState(),launch:require('./auto-launch.cjs').launchState(automation),connections:remembered.state(),bridgePipe:agentBridge.pipe,bridgeScript:path.join(__dirname,'../scripts/agent-bridge.cjs'),notifications:notifier.status()});
  ipcMain.handle('connections:forget',(event,kind)=>{authorize(event);if(!['kis','providers','calendar'].includes(kind))throw new Error('INVALID_REQUEST');if(remembered.progress[kind]==='connecting')return runtimeState();remembered.forget(kind);if(kind==='calendar'){calendarService.disconnect();return runtimeState();}if(kind==='providers'){providerService.disconnect();automation.providerStatus={aiConnected:false,dartConnected:false,pushConnected:false};}else{live.stop();usLive?.stop();usSnapshot=null;kisGeneration++;kisService.disconnect();kisQuotes.clear();kisHistory.clear();streamState={status:'disconnected',subscribed:0};kisState={status:'disconnected',snapshot:null,error:null};broadcastMarket();}return runtimeState();});
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
  const liveAction=action=>async(event,...args)=>{authorize(event);try{const data=await action(...args);return {ok:true,data,state:live.getState()};}catch(error){const allowed=['NO_FUNDED_BALANCE','INVALID_LOSS_LIMIT','ACTIVATION_REQUIRED','INVALID_LIMITS','APPROVAL_REQUIRED','KIS_NOT_CONNECTED','KIS_TRADING_DISABLED','INVALID_ORDER','INSTRUMENT_NOT_ALLOWED','ORDER_SIZE_LIMIT','KIS_ORDER_BUSY','UNKNOWN_ORDER','DISABLED_OR_EXPIRED','RECONCILIATION_REQUIRED','DAILY_TURNOVER_LIMIT','DAILY_LOSS_LIMIT','CONCENTRATION_LIMIT','SESSION_CLOSED','PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','FEATURE_UNAVAILABLE','LEVERAGED_NOT_ENABLED','LEVERAGED_EXPOSURE_LIMIT','MARGIN_NOT_ENABLED','MARGIN_LIMIT','SHORT_NOT_ENABLED','SHORT_LIMIT','LIMIT_CHANGED','CREDIT_ACCOUNT_REQUIRED','DAILY_SESSION_SETUP_REQUIRED','BROKER_ORDER_MISMATCH'];return {ok:false,error:allowed.includes(error.message)?error.message:'KIS_ORDER_FAILED',state:live.getState()};}};
  ipcMain.handle('live:get',liveAction(()=>live.getState()));
  ipcMain.handle('live:configure',liveAction((value,phrase)=>live.configure(value,phrase)));
  ipcMain.handle('live:stop',liveAction(()=>live.stop()));
  ipcMain.handle('live:auto',liveAction(phrase=>live.enableAuto(phrase)));
  ipcMain.handle('live:auto-off',liveAction(()=>{live.autoEnabled=false;return live.getState();}));
  ipcMain.handle('live:propose',liveAction(command=>live.propose(command)));
  ipcMain.handle('live:submit',liveAction((id,phrase)=>live.submit(id,phrase)));
  ipcMain.handle('live:reconcile',liveAction(()=>live.reconcile()));
  ipcMain.handle('live:link',liveAction((id,brokerId,phrase)=>live.linkUncertain(id,brokerId,phrase)));
  ipcMain.handle('runtime:start',async(event,token)=>{authorize(event);try{const message=await require('./auto-launch.cjs').start(automation,token);return {ok:true,message,state:runtimeState()};}catch(error){return {ok:false,error:error.message,state:runtimeState()};}});
  ipcMain.handle('runtime:stop',event=>{authorize(event);const message=require('./auto-launch.cjs').stop(automation);return {ok:true,message,state:runtimeState()};});
  ipcMain.handle('runtime:get',event=>{authorize(event);return runtimeState();});
  ipcMain.handle('runtime:configure',(event,value)=>{authorize(event);try{automation.configure(value);return {ok:true,state:runtimeState()};}catch{return {ok:false,error:'INVALID_SETTINGS'};}});
  ipcMain.handle('runtime:digest-preview',event=>{authorize(event);return require('./daily-digest.cjs').buildDigest(automation);});
  ipcMain.handle('runtime:reset-watches',event=>{authorize(event);automation.revision=(automation.revision??0)+1;automation.watches.reset(automation.watchScope());return runtimeState();});
  ipcMain.handle('scout:run',async event=>{authorize(event);try{await automation.scout();return {ok:true,state:runtimeState()};}catch{return {ok:false,error:automation.scoutError??'SCOUT_FAILED',state:runtimeState()};}});
  ipcMain.handle('runtime:dry-run-estimate',event=>{authorize(event);return automation.dryRunEstimate();});
  ipcMain.handle('runtime:dry-run',async(event,mode)=>{authorize(event);try{const record=await automation.dryRun(mode);return {ok:true,record,state:runtimeState()};}catch(error){return {ok:false,error:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DRY_RUN_FAILED',state:runtimeState()};}});
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
  ipcMain.handle('kis:activity',async(event,kind,startDate,endDate)=>{
    authorize(event);
    if(!kisState.snapshot)return {ok:false,error:'NOT_CONNECTED'};
    if(kisBusy)return {ok:false,error:'BUSY'};
    if(!['orders','profit'].includes(kind))return {ok:false,error:'INVALID_REQUEST'};
    const generation=kisGeneration;
    try {
      require('./kis-activity.cjs').validateRange(startDate,endDate);
      const data=await kisService.request(kind,{startDate,endDate});
      if(generation!==kisGeneration)return {ok:false,error:'CONNECTION_CHANGED'};
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
  ipcMain.handle('kis:disconnect',event=>{authorize(event);remembered.progress.kis='disconnected';live.stop();usLive?.stop();usSnapshot=null;kisGeneration++;streamState={status:'disconnected',subscribed:0};kisQuotes.clear();kisHistory.clear();kisService.disconnect();kisState={status:'disconnected',snapshot:null,error:null};broadcastMarket();return kisState;});
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
  closing=true;if(automation)automation.disposed=true;if(notifier)notifier.disposed=true;live?.stop();
  agentBridge?.close();providerService.disconnect();
  kisService.disconnect();
  clearInterval(quoteTimer);clearInterval(accountTimer);
  clearInterval(marketTimer); clearInterval(snapshotTimer); marketProvider?.stop();
  if (store && marketCache && !feedPaused) store.saveSnapshot({...syntheticState().snapshot,timestamp:new Date().toISOString()});
  store?.close();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
