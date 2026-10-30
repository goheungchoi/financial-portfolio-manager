const {randomUUID}=require('node:crypto');
// Order statuses that start a review when an order changes into them, statuses of an order still waiting at the broker,
// and how long routine reviews may wait for a pending order.
const ORDER_EVENTS=['Filled','Partially filled','Canceled','Rejected'],PENDING_ORDER=['Accepted','Partially filled'],ORDER_BACKSTOP_MS=120*60000,EVENT_RETRY_MS=5*60000,EVIDENCE_TRIGGERS=['Price movement trigger','News event trigger','Agent trigger','Order update'];const {seoulDate}=require('./kis-activity.cjs');
const DEFAULTS={unlimitedCalls:false,unlimitedBudget:false,reflectionUnlimitedCalls:false,reflectionUnlimitedBudget:false,autoReviewInterval:false,reflectionEnabled:false,reflectionCallsPerDay:5,reflectionUSDPerDay:1,enabled:false,autoSubmit:false,scope:'paper',shareKisWithAI:false,provider:'local',openaiModel:'gpt-6-luna',reasoningEffort:'none',intervalMinutes:10,eventTolerancePct:3,maxCallsPerDay:20,maxUSDPerDay:1,desktopAlerts:false,mobileAlerts:false,closedMarketReviews:'pre-open',sessionKrNxt:false,sessionKrxSingle:false,sessionUsPre:false,sessionUsAfter:false,sessionUsDaytime:false,extendedMaxOrderPct:5,phoneSnapshots:true,phoneAmounts:true,newsURL:'',guidelines:'',lossAction:'review',maxAutoOrdersPerDay:0,maxConsecutiveFailures:0,digestEnabled:false,digestHour:16,newsTrigger:'disclosures',watchlistAlerts:'observe',reviewGate:'observe',routineReviews:'full',orderTracking:true,watchlistMovePct:null,skipUnchanged:true,maxSkipMinutes:120,modelRouting:'fixed',routineModel:'gpt-6-luna',routineEffort:'none',complexityThreshold:40,spotCheckPct:25,lunaMaxRuns:4,lunaMaxMinutes:120,shadowEvaluation:false,shadowPct:100,shadowUSDPerDay:1,degradeNearBudget:true,scoutEnabled:false,scoutSchedule:'twice',scoutAiRequests:true,newsFeeds:[],kisNews:true,usTickerNews:true,narrativeEnabled:true,sizingRiskPct:1,sizingAtrMultiple:2,...require('./agent-desk.cjs').COND_DEFAULTS};
const LOG_LIMIT=30000;
// Two runs of one review (a cheaper model's and the confirming one): tokens and research counts add up.
function bothRuns(first,result){const sum=k=>(first.usage?.[k]??0)+(result.usage?.[k]??0);
  return {...result,usage:{inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),cachedTokens:sum('cachedTokens')},metrics:require('./research-meter.cjs').merge(first.metrics,result.metrics)};}
const heldSymbols=positions=>Object.entries(positions??{}).filter(([,p])=>p?.quantity>0).map(([symbol])=>symbol);
// Watchlist symbols in a review's universe: the ones it could research, for its coverage count.
const watchedIn=(discovery,context)=>{const universe=new Set((context.universe??[]).map(r=>r.symbol));return (discovery?.list?.()??[]).map(e=>e.symbol).filter(s=>universe.has(s));};
// The console keeps a copy of the supplied context. Large sections are summarized in that copy so it fits the event log; the AI still receives everything.
function loggableContext(context){
  const value={...context};let text=JSON.stringify(value);
  const keys=Object.keys(value).filter(key=>!['environment','market','currency','universe','positions','risk'].includes(key)).sort((a,b)=>(JSON.stringify(value[b])?.length??0)-(JSON.stringify(value[a])?.length??0));
  for(const key of keys){if(text.length<=LOG_LIMIT)break;value[key]=`[not kept in the log: ${(JSON.stringify(value[key])?.length??0).toLocaleString('en-US')} characters; the AI received it in full]`;text=JSON.stringify(value);}
  return text.length<=LOG_LIMIT?text:text.slice(0,LOG_LIMIT-1)+'…';
}
// What a dry run reports about the assembled review inputs: when and for which account they were built, market
// sessions, quote times, holdings, open orders and their confirmation, conditional orders and whether they are
// monitored, cash, and returns with deposits and withdrawals excluded.
function dryRunSummary(c,{assembledAt=Date.now(),account=null,scope=null}={}){
  const perf=market=>{const h=c.performance?.history?.[market]??(c.market===market?c.performance?.history:null);if(!h)return null;const all=(h.timeWeightedReturns??[]).find(p=>p.period==='All');const last=(h.recentDailyPnl??[]).at(-1)??null;
    return {allPeriodReturnPct:all?.returnPct??null,since:all?.from??null,latestDay:last,...(h.unconfirmedFlows?.length?{unconfirmedFlows:h.unconfirmedFlows}:{})};};
  const co=c.agentDesk?.conditionalOrders??null;const iso=t=>Number.isFinite(t)?new Date(t).toISOString():null;
  const quoteTimes=(c.quotes??[]).map(q=>q.timestamp??q.retrievedAt).filter(Number.isFinite);
  const sessions=Array.isArray(c.markets)&&c.markets.length?Object.fromEntries(c.markets.map(m=>[m.market,m.marketSession?.status??null])):{[c.market??'KR']:c.marketSession?.status??null};
  const price=s=>(c.quotes??[]).find(q=>q.symbol===s)?.price??null;
  return {assembledAt:iso(assembledAt),scope,account,environment:c.environment??null,sessions,
    quotes:{count:quoteTimes.length,oldest:iso(Math.min(...quoteTimes)),newest:iso(Math.max(...quoteTimes)),stale:(c.quotes??[]).filter(q=>q.stale).length},
    positions:Object.entries(c.positions??{}).filter(([,p])=>p?.quantity>0).map(([symbol,p])=>({symbol,quantity:p.quantity,costTotal:p.costTotal??null,price:price(symbol)})),cash:c.cash??null,
    openOrders:(c.orders??[]).map(({symbol,side,quantity,filled,status,orderId,placedAt,lastConfirmedAt})=>({symbol,side,quantity,filled,status,orderId:orderId??null,placedAt:placedAt??null,lastConfirmedAt:lastConfirmedAt??null})),orderReconciliation:c.orderReconciliation??null,
    conditionalOrders:co?{allowed:Boolean(co.allowed),monitoring:co.monitoring??null,armed:(co.armed??[]).map(o=>({symbol:o.symbol,side:o.side,quantity:o.quantity,conditions:o.conditions,expires:o.expires}))}:null,
    performance:{KR:perf('KR'),US:perf('US')}};
}
class Automation {
  constructor(db,paper,provider,log) {
    this.db=db;this.paper=paper;this.provider=provider;this.log=log;this.providerStatus={aiConnected:false,dartConnected:false,pushConnected:false};this.news=[];this.newsError=null;this.busy=false;this.lastRun=0;this.lastPrices=new Map();this.usVenues=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS routing_eval(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,account TEXT,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS shadow_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL,reservedMicro INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS routing_pass(id TEXT PRIMARY KEY,decidedAt INTEGER NOT NULL,payload TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS dry_runs(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL)');db.exec('CREATE TABLE IF NOT EXISTS review_clock(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)');db.exec('CREATE TABLE IF NOT EXISTS automation_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,text TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS ai_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL,reservedMicro INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS reviewed_fills(id TEXT PRIMARY KEY);');
    db.exec('CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL)');
    this.reviewInterval=new (require('./review-interval.cjs').ReviewInterval)(db);
    this.watches=new (require('./review-watches.cjs').ReviewWatches)(db);
    this.outcomes=new (require('./outcome-ledger.cjs').OutcomeLedger)(db);this.memory=new (require('./learning-memory.cjs').LearningMemory)(db);
    this.trials=new (require('./lesson-trials.cjs').LessonTrials)(db,this.memory);
    this.reflections=new (require('./reflection.cjs').ReflectionQueue)(db,this.memory);
    // Observation only: records when event-driven scheduling would run beside the current schedule; changes nothing.
    this.scheduleObserver=new (require('./schedule-observer.cjs').ScheduleObserver)(db);
    this.researchGaps=new (require('./research-gaps.cjs').ResearchGaps)(db);
    {const W=require('./watch-alerts.cjs');this.watchAlerts=new W.WatchAlerts();this.alertObservations=new W.AlertObservations(db);}this.reviewGate=new (require('./review-gate.cjs').ReviewGate)(db);this.waits=new (require('./waits.cjs').Waits)(db);this.pending=new (require('./pending-decisions.cjs').PendingDecisions)(db);this.assessments=new (require('./assessments.cjs').Assessments)(db);
    this.scoreboard=new (require('./scoreboard.cjs').Scoreboard)(db,Date.now,()=>{try{return this.live?.identity()??null;}catch{return null;}});this.guardrails=new (require('./guardrails.cjs').Guardrails)(db);this.newsEvents=new (require('./news-events.cjs').NewsEvents)(db);this.digest=new (require('./daily-digest.cjs').DailyDigest)(db);this.scoutStore=new (require('./scout.cjs').ScoutStore)(db);const feedback=require('./scout-feedback.cjs');this.briefs=new feedback.BriefStore(db);this.scoutScorecard=new feedback.ScoutScorecard(db,this.scoreboard);this.desk=new (require('./agent-desk.cjs').AgentDesk)(db);this.desk.sellStatus=o=>{const id=o.orderId??o.proposalId;return id?this.engineOrders().find(r=>r.id===id)?.status??null:null;};this.narratives=new (require('./narrative.cjs').NarrativeStore)(db);this.replays=new (require('./replay.cjs').ReplayStore)(db);this.episodes=new (require('./episodes.cjs').EpisodeLibrary)(db);db.exec('CREATE TABLE IF NOT EXISTS narrative_slots(id INTEGER PRIMARY KEY CHECK(id=1),slot TEXT NOT NULL)');
    const row=db.prepare('SELECT payload FROM automation_settings WHERE id=1').get();this.config={...DEFAULTS,...(row?JSON.parse(row.payload):{})};this.sessionArmed=false;this.lastError=null;this.lastSuccess=0;this.savedAt=null;if(!row)this.saveConfig();
  }
  // The account a review or console entry belongs to: the paper account, or the connected KIS account (its hashed identity).
  accountTag(){if(this.config.scope==='paper')return {key:'paper',label:'Paper'};try{const key=this.live?.identity();if(!key)return null;const env=this.live.getConnection?.()?.snapshot?.environment;return {key,label:env==='live'?'KIS live':env==='mock'?'KIS mock':'KIS'};}catch{return null;}}
  reviewHistory(limit=50,all=false){const key=all?null:this.accountTag()?.key;return (key?this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.account.key')=? ORDER BY rowid DESC LIMIT ?").all(key,limit):this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT ?').all(limit)).map(row=>JSON.parse(row.payload));}
  watchScope(){if(this.config.scope==='paper')return 'paper';try{return this.config.scope+':'+(this.live??this.usLive).identity();}catch{return this.config.scope+':disconnected';}}
  // The review clock: when this account and scope last had a review (run, skipped or failed) and which pre-open review
  // already ran, kept across restarts, so starting auto trading resumes the schedule instead of reviewing again.
  // The clock in memory belongs to clockScope. When the account or scope changes, both fields are replaced by that
  // scope's saved clock, or reset when it has none: another account's review time never carries over. Nothing changes
  // while a review runs, so its time is saved under the scope it reviewed. A disconnected account keeps the clock it
  // had, since its identity is unknown; a clock started while disconnected belongs to no account and is replaced. The
  // first scope adopted keeps a clock set before any scope was known, unless its saved one is later. A saved time in
  // the future (the system clock moved back) counts as now, so the interval still applies.
  saveClock(){const scope=this.clockScope;if(!scope||scope.endsWith(':disconnected')||!(this.lastRun>0)&&!this.preOpenKey)return;
    try{this.db.prepare('INSERT INTO review_clock VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload').run(scope,JSON.stringify({lastRun:this.lastRun,preOpenKey:this.preOpenKey??null}));}catch{}}
  restoreClock(){if(this.busy)return;const scope=this.watchScope();if(scope===this.clockScope)return;if(scope.endsWith(':disconnected')){this.clockScope??=scope;return;}let c=null;
    try{const row=this.db.prepare('SELECT payload FROM review_clock WHERE scope=?').get(scope);c=row?JSON.parse(row.payload):null;}catch{}
    const first=this.clockScope==null,saved=Number.isFinite(c?.lastRun)&&c.lastRun>0?Math.min(c.lastRun,Date.now()):0;this.clockScope=scope;
    this.lastRun=first?Math.max(this.lastRun,saved):saved;this.preOpenKey=typeof c?.preOpenKey==='string'?c.preOpenKey:first?this.preOpenKey??null:null;}
  saveConfig(){this.db.prepare('INSERT INTO automation_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(this.config));}
  configure(value) {
    if(!value || Object.keys(value).some(key=>!Object.hasOwn(DEFAULTS,key)))throw new Error('INVALID_SETTINGS');
    const next={...this.config,...value};
    if(!['local','openai','external'].includes(next.provider)||!Number.isInteger(next.intervalMinutes)||next.intervalMinutes<1||next.intervalMinutes>1440||!Number.isFinite(next.eventTolerancePct)||next.eventTolerancePct<.1||next.eventTolerancePct>50||!Number.isInteger(next.maxCallsPerDay)||next.maxCallsPerDay<1||next.maxCallsPerDay>200||!Number.isFinite(next.maxUSDPerDay)||next.maxUSDPerDay<.01||next.maxUSDPerDay>100||typeof next.newsURL!=='string'||next.newsURL.length>1000||typeof next.guidelines!=='string'||next.guidelines.length>6000)throw new Error('INVALID_SETTINGS');
    if(!Number.isInteger(next.reflectionCallsPerDay)||next.reflectionCallsPerDay<1||next.reflectionCallsPerDay>200||!Number.isFinite(next.reflectionUSDPerDay)||next.reflectionUSDPerDay<.01||next.reflectionUSDPerDay>100)throw new Error('INVALID_SETTINGS');
    for(const key of ['unlimitedCalls','unlimitedBudget','reflectionUnlimitedCalls','reflectionUnlimitedBudget','autoReviewInterval','reflectionEnabled','enabled','autoSubmit','desktopAlerts','mobileAlerts','phoneSnapshots','phoneAmounts'])if(typeof next[key]!=='boolean')throw new Error('INVALID_SETTINGS');
    if(!['paper','kis','us','both'].includes(next.scope)||typeof next.shareKisWithAI!=='boolean')throw new Error('INVALID_SETTINGS');
    if(typeof next.orderTracking!=='boolean'||!['full','focused'].includes(next.routineReviews)||!['off','observe','on'].includes(next.reviewGate)||!['off','observe','on'].includes(next.watchlistAlerts)||next.watchlistMovePct!==null&&(!Number.isFinite(next.watchlistMovePct)||next.watchlistMovePct<.1||next.watchlistMovePct>50))throw new Error('INVALID_SETTINGS');
    require('./guardrails.cjs').validateGuardrails(next);if(!require('./news-events.cjs').MODES.includes(next.newsTrigger))throw new Error('INVALID_SETTINGS');
    require('./ai-models.cjs').settings(next);require('./ai-models.cjs').settings({openaiModel:next.routineModel,reasoningEffort:next.routineEffort});
    if(['sessionKrNxt','sessionKrxSingle','sessionUsPre','sessionUsAfter','sessionUsDaytime'].some(k=>typeof next[k]!=='boolean')||!Number.isFinite(next.extendedMaxOrderPct)||next.extendedMaxOrderPct<0.5||next.extendedMaxOrderPct>50||!['pre-open','off','keep'].includes(next.closedMarketReviews)||typeof next.skipUnchanged!=='boolean'||typeof next.degradeNearBudget!=='boolean'||!['fixed','auto','complexity'].includes(next.modelRouting)||typeof next.shadowEvaluation!=='boolean'||!Number.isFinite(next.shadowUSDPerDay)||next.shadowUSDPerDay<0.1||next.shadowUSDPerDay>20||!Number.isInteger(next.shadowPct)||next.shadowPct<0||next.shadowPct>100||![next.complexityThreshold,next.spotCheckPct,next.lunaMaxRuns,next.lunaMaxMinutes].every(Number.isInteger)||next.complexityThreshold<0||next.complexityThreshold>100||next.spotCheckPct<0||next.spotCheckPct>100||next.lunaMaxRuns<1||next.lunaMaxRuns>20||next.lunaMaxMinutes<30||next.lunaMaxMinutes>720||!Number.isInteger(next.maxSkipMinutes)||next.maxSkipMinutes<15||next.maxSkipMinutes>720)throw new Error('INVALID_SETTINGS');
    if(typeof next.scoutAiRequests!=='boolean'||typeof next.scoutEnabled!=='boolean'||!Object.hasOwn(require('./scout.cjs').SCHEDULES,next.scoutSchedule))throw new Error('INVALID_SETTINGS');
    if(!Array.isArray(next.newsFeeds)||next.newsFeeds.length>10||next.newsFeeds.some(f=>!f||typeof f.url!=='string'||!/^https:\/\//.test(f.url)||f.url.length>500||typeof(f.label??'')!=='string'||String(f.label??'').length>60)||typeof next.kisNews!=='boolean'||typeof next.usTickerNews!=='boolean'||typeof next.narrativeEnabled!=='boolean'||!Number.isFinite(next.sizingRiskPct)||next.sizingRiskPct<0.1||next.sizingRiskPct>20||!Number.isFinite(next.sizingAtrMultiple)||next.sizingAtrMultiple<0.5||next.sizingAtrMultiple>5)throw new Error('INVALID_SETTINGS');
    if(typeof next.conditionalOrders!=='boolean'||typeof next.conditionalAutoSubmit!=='boolean'||!Number.isInteger(next.conditionalMaxActive)||next.conditionalMaxActive<1||next.conditionalMaxActive>10||!Number.isFinite(next.conditionalMaxOrderPct)||next.conditionalMaxOrderPct<1||next.conditionalMaxOrderPct>50||!Number.isFinite(next.conditionalMaxSlippagePct)||next.conditionalMaxSlippagePct<.1||next.conditionalMaxSlippagePct>10||!Number.isFinite(next.conditionalMaxHours)||next.conditionalMaxHours<1||next.conditionalMaxHours>336)throw new Error('INVALID_SETTINGS');
    this.config=next;this.revision=(this.revision??0)+1;this.saveConfig();this.savedAt=Date.now();if(Object.hasOwn(value,'enabled'))this.sessionArmed=next.enabled;return this.getState();
  }
  schedulerStatus(){
    if(this.launching)return {label:'Starting auto trading',detail:'Checking the selected account.'};
    if(this.busy)return {label:'Review in progress',detail:'Waiting for the decision and risk checks to complete.'};
    if(!this.config.enabled)return {label:'Manual reviews only',detail:'Scheduled reviews are disabled in your saved settings.'};
    if(!this.sessionArmed)return {label:'Paused after restart',detail:'Your settings were restored. Use Start auto trading to resume, or run a manual review.'};
    if(this.config.provider==='external')return {label:'Waiting for external agent',detail:'The external agent must send a decision through the bridge.'};
    if(this.config.provider==='openai'&&!this.providerStatus.aiConnected)return {label:'API key required',detail:'Import provider JSON to connect the selected OpenAI provider.'};
    if(this.config.scope==='paper'&&this.paper.account().paused)return {label:'Paper account paused',detail:'Enable Paper trading to allow scheduled reviews.'};
    if(this.config.scope!=='paper'&&this.config.provider==='openai'&&!this.config.shareKisWithAI)return {label:'Data sharing required',detail:'Allow KIS context sharing in Engine settings for OpenAI reviews.'};
    const usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0};
    if(this.config.provider==='openai'&&require('./ai-models.cjs').budgetExceeded(this.config,usage,require('./ai-models.cjs').reservation(this.config)))return {label:'Daily API limit reached',detail:'Review your budget or wait for the next Seoul calendar day.'};
    const hours=this.marketHours();if(!hours.open&&this.config.closedMarketReviews!=='keep'&&hours.next){const at=new Date(this.config.closedMarketReviews==='pre-open'?hours.next.at-require('./market-hours.cjs').PRE_OPEN_MS:hours.next.at).toLocaleString('en-GB',{timeZone:'Asia/Seoul',weekday:'short',hour:'2-digit',minute:'2-digit'});return {label:'Monitoring',detail:this.config.closedMarketReviews==='pre-open'?`Markets closed. Next review ${at} KST, before the ${hours.next.market==='KR'?'Korean':'U.S.'} open.`:`Markets closed. Reviews resume at the ${hours.next.market==='KR'?'Korean':'U.S.'} open, ${at} KST.`,closed:true};}
    return {label:'Monitoring',detail:'Waiting for the next scheduled review or price-movement trigger.'};
  }
  // Markets in the review scope that accept orders now; Korean holidays come from KIS session checks during reviews.
  // Extended sessions you switched on (live accounts only), as passed to the broker worker and the session schedule.
  // U.S. quotes from a refresh, as price triggers see them. With no U.S. session the app can trade open, a quote is a
  // broker snapshot (overnight the regular feed keeps an old price), so it is stale and starts no review. The regular and
  // daytime feeds can differ by several percent at the same moment, so when a symbol's feed changes, its baselines start
  // again from the new feed's price instead of counting the difference as a move.
  acceptUSQuotes(value){
    const open=value?.marketSession?.open===true,switched=[];
    this.usQuotes=(value?.quotes??[]).map(row=>{const venue=row.venue??'regular',before=this.usVenues.get(row.symbol);this.usVenues.set(row.symbol,venue);
      if(before&&before!==venue&&row.price>0)switched.push(row);return {...row,venue,timestamp:row.retrievedAt,stale:!open};});
    if(switched.length){for(const row of switched)this.lastPrices.set(row.symbol,row.price);this.watches.rebase(this.watchScope(),switched);}
    return this.usQuotes;
  }
  sessionOptions(){return {krNxt:this.config.sessionKrNxt,krxSingle:this.config.sessionKrxSingle,usPre:this.config.sessionUsPre,usAfter:this.config.sessionUsAfter,usDaytime:this.config.sessionUsDaytime};}
  marketHours(now=Date.now()){this.closedDays??=new Set();const closed=new Set([...this.closedDays,...(this.officialClosedDays?.()??[])]);const mh=require('./market-hours.cjs');const base=mh.marketHours(this.config.scope,now,closed);
    const enabled=this.sessionOptions();if(!Object.values(enabled).some(Boolean))return base;
    // An enabled extended session counts as open; the next review opening is the earliest tradable session start.
    const ms=require('./market-sessions.cjs');const environment=this.live?.getConnection?.()?.snapshot?.environment??'mock';const markets=mh.marketsFor(this.config.scope);const opts=m=>({environment,enabled,...(m==='KR'?{closedDays:closed}:{})});
    if(markets.some(m=>{const s=ms.tradableNow(m,now,opts(m));return s&&!s.regular;}))return {...base,open:true,preOpen:null};
    let next=base.next;for(const m of markets){const s=ms.marketStatus(m,now,opts(m));const start=[...s.sessions,...ms.sessionsOn(m,ms.localDay(now+86400000,s.timeZone),opts(m))].filter(x=>x.tradable==='app'&&x.startAt>now).sort((a,b)=>a.startAt-b.startAt)[0];if(start&&(!next||start.startAt<next.at))next={market:m,at:start.startAt};}
    const preOpen=next&&next.at-now<=mh.PRE_OPEN_MS?{market:next.market,at:next.at-mh.PRE_OPEN_MS,key:`${next.market}:${next.at}`}:null;return {...base,next,preOpen};}
  // Whether a session the app can trade is open in this market now (an extended session counts when you switched it on).
  sessionOpen(market,now=Date.now()){const ms=require('./market-sessions.cjs');const environment=this.live?.getConnection?.()?.snapshot?.environment??'mock';
    const closed=new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]);return Boolean(ms.tradableNow(market,now,{environment,enabled:this.sessionOptions(),...(market==='KR'?{closedDays:closed}:{})}));}
  noteSessions(context){const {krOpen,seoulDay}=require('./market-hours.cjs');const kr=context?.environment==='kis-combined'?context.markets?.find(m=>m.market==='KR')?.marketSession:this.config.scope==='kis'?context?.marketSession:null;
    if(kr&&kr.open===false&&kr.status==='closed'&&krOpen(Date.now(),this.closedDays??=new Set()))this.closedDays.add(seoulDay(Date.now()));}
  // When the next scheduled review is due: while markets are closed, the pre-open review or the open itself.
  // The pre-open review already ran for the next open: the next one is a scheduled review after that open.
  nextReviewAt(){if(!this.config.enabled||!this.sessionArmed)return null;this.restoreClock();const hours=this.marketHours(),emergency=this.emergencyState().active;
    const interval=Math.max(60000,emergency?60000:this.reviewInterval.get(this.watchScope(),this.config).minutes*60000*this.slowFactor());
    if(!hours.open&&this.config.closedMarketReviews!=='keep'&&!emergency&&hours.next){if(this.config.closedMarketReviews!=='pre-open')return hours.next.at;
      return this.preOpenRan(hours)?Math.max(hours.next.at,this.lastRun+interval):hours.next.at-require('./market-hours.cjs').PRE_OPEN_MS;}
    const due=Math.max(Date.now(),this.lastRun+interval);
    const defer=this.emergencyState().active?null:this.deferForPendingOrder();return defer?Math.max(due,defer.until):due;}
  preOpenRan(hours=this.marketHours()){return Boolean(hours.next)&&this.preOpenKey===`${hours.next.market}:${hours.next.at}`;}
  // Near the daily AI budget, scheduled reviews run at twice the interval instead of stopping (tick and nextReviewAt).
  slowFactor(){return this.config.provider==='openai'&&this.config.degradeNearBudget&&require('./token-saver.cjs').nearBudget(this.config,this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0})?2:1;}
  executionState(){const selected=this.config.scope==='both'?[['KR',this.live],['US',this.usLive]]:this.config.scope==='paper'?[['Paper',{enabled:!this.paper.account().paused,autoEnabled:true}]]:[[this.config.scope==='us'?'US':'KR',this.config.scope==='us'?this.usLive:this.live]];const markets=selected.map(([market,engine])=>({market,enabled:Boolean(engine?.enabled),automatic:Boolean(engine?.enabled&&engine?.autoEnabled)}));const describe=market=>(market==='US'?'U.S.':market==='KR'?'Korea':market);const blocked=markets.filter(row=>!row.enabled||this.config.autoSubmit&&!row.automatic);return {label:!this.config.autoSubmit?'Approval first':blocked.length?'Automatic requested · waiting for activation':'Automatic execution ready',detail:markets.map(row=>describe(row.market)+': '+(!row.enabled?'orders off':!this.config.autoSubmit?'approval first':row.automatic?'automatic orders enabled':'automatic orders off; approval required')).join(' · '),markets};}
  emergencyState(){const candidates=this.config.scope==='both'?[{market:'KR',loss:this.live?.getState().loss},{market:'US',loss:this.usLive?.getState().loss}]:[{market:this.config.scope==='us'?'US':'KR',loss:this.config.scope==='paper'?this.paper.getState().loss:(this.config.scope==='us'?this.usLive:this.live)?.getState().loss}];const selected=candidates.find(row=>row.loss?.breached)??candidates[0];return {active:candidates.some(row=>row.loss?.breached),scope:this.config.scope,currency:selected.market==='US'?'USD':'KRW',activeMarkets:candidates.filter(row=>row.loss?.breached).map(row=>row.market),loss:selected.loss??null,reviewIntervalSeconds:60,objective:'Prioritize justified loss reduction after costs. Reassess both markets when selected; respect native currencies, broker capacity, hours and approval. Do not chase losses.'};}
  observeEmergency(emergency){if(emergency.active!==Boolean(this.lastEmergencyActive)||emergency.active&&emergency.scope!==this.lastEmergencyScope){this.lastEmergencyActive=emergency.active;this.lastEmergencyScope=emergency.scope;this.emergencyStartedAt=emergency.active?Date.now():null;this.log(randomUUID(),'Risk',emergency.active?'Emergency mode entered':'Emergency mode cleared',JSON.stringify(emergency));}}
  // Headlines about your symbols first; general headlines are trimmed when the market narrative already summarizes them.
  // Market stories covered by many outlets in the last 24 hours (electron/news-stories.cjs), recomputed at most every
  // ten minutes. Given to reviews, the scout and the narrative whatever the portfolio holds.
  // Live bid/ask for the symbols a review is most likely to act on (holdings, scout targets, review watches; at most
  // eight), read just before the review and only while that symbol's regular session is open. Background for skipping.
  // A book older than five minutes, or of unknown age, is kept but marked stale; the feed's delay note is kept.
  async attachOrderBooks(context){
    if(context.environment==='local-paper'||!this.evidence)return;
    const session=market=>context.environment==='kis-combined'?context.markets?.find(m=>m.market===market)?.marketSession:context.marketSession;
    const regular=market=>{const s=session(market);return s?.open===true&&s?.session?.regular!==false;};
    const universe=new Set((context.universe??[]).map(r=>r.symbol));
    const wanted=[...Object.entries(context.positions??{}).filter(([,p])=>p?.quantity>0).map(([s])=>s),...(context.scoutPlan?.targets??[]).map(t=>t.symbol),...(context.reviewWatches??[]).map(w=>w.symbol)];
    const symbols=[...new Set(wanted)].filter(s=>universe.has(s)&&regular(/^\d{6}$/.test(s)?'KR':'US')).slice(0,8);if(!symbols.length)return;
    const books=await Promise.all(symbols.map(symbol=>this.evidence.get({symbol,dataset:'order_book'},context).catch(()=>null)));
    const STALE_SECONDS=300;const available=books.filter(b=>b?.status==='available'&&b.data);
    const rows=available.map(b=>{const age=Number.isFinite(b.data.ageSeconds)?b.data.ageSeconds:null;return {symbol:b.symbol,bid:b.data.bid,ask:b.data.ask,bidSize:b.data.bidSize,askSize:b.data.askSize,spreadPct:b.data.spreadPct,quoteTime:b.data.quoteTime??null,ageSeconds:age,stale:age==null||age>STALE_SECONDS,...(age==null?{ageUnknown:true}:{})};});
    if(rows.length)context.orderBooks={readAt:new Date(Math.max(...available.map(b=>b.retrievedAt??0))||Date.now()).toISOString(),staleAfterSeconds:STALE_SECONDS,delay:available.find(b=>b.delay)?.delay??null,books:rows};
  }
  async reconcileOpenOrders(){
    for(const [market,engine] of [['KR',this.live],['US',this.usLive]]){if(!engine?.orderReconciliation?.())continue;try{await engine.reconcile();}catch{}this.observeReconcile(market,engine.reconcileHealth);}
  }
  // A deposit or withdrawal found in the balance, not recorded by the user: one log entry and one alert.
  noteDetectedFlow(flow){
    const amount=flow.currency==='USD'?`$${Math.abs(flow.amount).toLocaleString('en-US')}`:`₩${Math.abs(flow.amount).toLocaleString('en-US')}`;
    const message=`${flow.amount>0?'Deposit':'Withdrawal'} detected: ${flow.market==='US'?'U.S.':'Korean'} cash ${flow.amount>0?'rose':'fell'} by ${amount} with no matching trade on ${flow.day}. Returns treat it as a ${flow.amount>0?'deposit':'withdrawal'}; confirm or remove it under Performance → Deposits & withdrawals.`;
    this.log(randomUUID(),'System',flow.amount>0?'Deposit detected':'Withdrawal detected',message);try{this.notify?.('flow-'+flow.id,message);}catch{}
  }
  // One alert per episode when open-order statuses cannot be confirmed with KIS after three checks; cleared on success.
  observeReconcile(market,health){
    this.reconcileAlerts??={};if(!health?.failures){this.reconcileAlerts[market]=false;return;}
    if(health.failures<3||this.reconcileAlerts[market])return;this.reconcileAlerts[market]=true;
    const message=`Order status could not be confirmed with KIS (${market}, ${health.error}) after ${health.failures} checks. An open order may already be filled; new ${market} orders, including stop-losses, are blocked until it is confirmed. Check the order in the KIS app.`;
    this.log(randomUUID(),'System','Order status not confirmed',message);try{this.notify?.('reconcile-'+market+'-'+health.since,message);}catch{}
  }
  topStories(now=Date.now()){
    if(this.storiesCache&&now-this.storiesCache.at<10*60000)return this.storiesCache.value;
    let value=[];try{const events=this.db.prepare('SELECT payload,firstSeenAt FROM news_events WHERE firstSeenAt>=?').all(now-7*86400000).map(r=>({...JSON.parse(r.payload),firstSeenAt:r.firstSeenAt}));value=require('./news-stories.cjs').topStories(events,now);}catch{}
    this.storiesCache={at:now,value};return value;
  }
  storiesContext(){return this.topStories().map(s=>({headline:s.headlines[0]?.title??null,otherHeadlines:s.headlines.slice(1,3).map(h=>h.title),outlets:s.outlets,timesUsual:s.timesUsual,terms:s.terms,latest:s.latest,...(s.symbols?{symbols:s.symbols}:{})}));}
  newsContext(){const relevant=this.newsEvents.relevant(8).map(({title,published,source,symbols,importance})=>({title,published,source,symbols,importance}));const seen=new Set(relevant.map(item=>item.title));const general=this.storyContext().marketNarrative?2:Math.max(2,10-relevant.length);return [...relevant,...this.news.filter(item=>!seen.has(item.title)).slice(0,general).map(({title,published,source})=>({title,published,source,symbols:[],importance:'normal'}))].slice(0,12);}
  // Symbols whose news matters: overridden by the main process with holdings, watchlist, allowlist and watches.
  relevantSecurities(){return this.paper.getState().universe.map(({symbol,name})=>({symbol,name,englishName:''}));}
  // One recorded event and alert per kind per Seoul day, except stops, which are always recorded.
  trip(kind,detail){
    const {seoulDate:today}=require('./kis-activity.cjs');
    if(kind!=='auto-stopped'&&this.guardrails.eventsOn(today()).some(event=>event.kind===kind)){this.log(randomUUID(),'Risk','Guardrail · '+kind,detail);return;}
    if(kind==='auto-stopped')require('./auto-launch.cjs').stop(this);
    const event=this.guardrails.record(kind,detail);this.log(event.id,'Risk','Guardrail · '+kind,detail);this.notify?.('guardrail:'+event.id,'Guardrail: '+detail);
  }
  // Daily counts of skipped, routine, escalated and confirmation reviews.
  // Complexity routing is allowed only after an evaluation pass is recorded (docs/ROUTING-EVALUATION.md section 6).
  // Nothing in the interface records one; it is written after the evaluation report is reviewed.
  // A stored pass counts only while it still validates against the current binding (models, router settings, protocol
  // and routing code); any change makes routing ineligible again until a new evaluation passes.
  routingEligibility(){const sim=require('./routing-sim.cjs');const row=this.db.prepare('SELECT id,decidedAt,payload FROM routing_pass ORDER BY decidedAt DESC LIMIT 1').get();if(!row)return {eligible:false,reason:'no routing evaluation has passed'};
    const problem=sim.validPass(JSON.parse(row.payload),sim.binding(this.config));return problem?{eligible:false,reason:problem}:{eligible:true,passId:row.id,decidedAt:row.decidedAt};}
  recordRoutingPass(report){const sim=require('./routing-sim.cjs');const problem=sim.validPass(report,sim.binding(this.config));if(problem)throw Object.assign(new Error('INVALID_ROUTING_PASS'),{detail:problem});const id=randomUUID();this.db.prepare('INSERT INTO routing_pass VALUES(?,?,?)').run(id,Date.now(),JSON.stringify(report));return id;}
  // Inputs for complexity routing: the score, and a hard rule when one sends this review to the configured model:
  // the first review after starting, no recent review on that model, the first review of a regular session, or the
  // cheaper model's run limit (count or time since the last review on the configured model).
  routingInputs(context,trigger,now=Date.now()){
    const history=this.reviewHistory(30);const strongModel=this.config.openaiModel;// A review counts as decided by the configured model when it ran there, or when that model confirmed, spot-checked or took over its decision.
    const strong=r=>r.provider==='openai'&&(r.routing?(r.routing.model===strongModel&&r.routing.tier!=='routine')||Boolean(r.routing.confirmedBy||r.routing.spotCheck||r.routing.verdictChange):r.model===strongModel);
    const lastStrong=history.find(strong)??null;const previousReview=history[0]??null;const previous=lastStrong?this.replays.context(lastStrong.id):null;
    const streak=[];for(const r of history){if(strong(r))break;if(r.routing?.tier==='routine')streak.push(r);}
    const assessment=require('./complexity.cjs').assess(context,{baseline:previous,previousReview,now});
    const complexity={score:assessment.score,rule:assessment.rule,parts:assessment.groups,agent:assessment.agent,reasons:assessment.features.map(f=>f.detail),consequence:assessment.consequence};
    // Mandatory escalations come from the same function the routing simulation uses.
    const markets=this.config.scope==='kis'?['KR']:this.config.scope==='us'?['US']:['KR','US'];const closed=new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]);
    // The calendar inputs are recorded with each shadow pair so the simulation applies the same session rules.
    const near=d=>Math.abs(Date.parse(d+'T00:00:00Z')-now)<=4*86400000;const calendar={scope:this.config.scope,markets,closedDays:[...closed].filter(d=>typeof d==='string'&&near(d)).sort()};
    const hardRule=require('./routing-sim.cjs').hardRule({trigger,now,lastMainAt:lastStrong?.timestamp??null,streak:streak.length,markets,closedDays:closed,maxRuns:this.config.lunaMaxRuns,maxMinutes:this.config.lunaMaxMinutes,consequence:assessment.consequence,mainModel:strongModel});
    // The evaluation binding is captured as the review starts, not when the background shadow run finishes.
    return {complexity,hardRule,previousReview,assessment,calendar,binding:require('./routing-sim.cjs').binding(this.config),baselineId:lastStrong?.id??null};
  }
  recordSaving(kind){
    this.db.exec('CREATE TABLE IF NOT EXISTS token_savings(day TEXT PRIMARY KEY,payload TEXT NOT NULL)');const day=seoulDate();const row=this.db.prepare('SELECT payload FROM token_savings WHERE day=?').get(day);const value=row?JSON.parse(row.payload):{};
    value[kind]=(value[kind]??0)+1;this.db.prepare('INSERT INTO token_savings VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(day,JSON.stringify(value));
  }
  // Per-review token use and estimated cost from recorded AI calls, newest first.
  tokenSavingState(){
    this.db.exec('CREATE TABLE IF NOT EXISTS token_savings(day TEXT PRIMARY KEY,payload TEXT NOT NULL)');const row=this.db.prepare('SELECT payload FROM token_savings WHERE day=?').get(seoulDate());
    const calls=this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 120').all().map(r=>JSON.parse(r.payload)).filter(c=>c.reviewId);const reviews=new Map();
    for(const call of calls){const r=reviews.get(call.reviewId)??{reviewId:call.reviewId,timestamp:call.timestamp,calls:0,inputTokens:0,cachedTokens:0,outputTokens:0,micro:0,models:[]};r.calls++;r.timestamp=Math.min(r.timestamp,call.timestamp);r.inputTokens+=call.usage?.inputTokens??0;r.cachedTokens+=call.usage?.cachedTokens??0;r.outputTokens+=call.usage?.outputTokens??0;r.micro+=call.estimatedMicro??call.accountedMicro??call.reservedMicro??0;if(!r.models.includes(call.model))r.models.push(call.model);reviews.set(call.reviewId,r);}
    const recent=[...reviews.values()].sort((a,b)=>b.timestamp-a.timestamp).slice(0,20);
    return {today:row?JSON.parse(row.payload):{},recent,averageMicro:recent.length?Math.round(recent.reduce((n,r)=>n+r.micro,0)/recent.length):null};
  }
  getState(){this.syncLearning();return {accountEnvironment:this.live?.getConnection?.()?.snapshot?.environment??null,calendar:this.calendarState(),regime:this.regimeState(),exposure:this.exposureState(),narrative:this.narrativeState(),desk:this.deskState(),scout:this.scoutState(),tokenSaving:{...this.tokenSavingState(),shadow:this.routingEvalState(),reviewGate:this.reviewGateState()},watchlistAlerts:this.watchlistAlertsState(),newsEvents:this.newsEvents.list(100),lastNewsTrigger:this.lastNewsTrigger??null,guardrails:this.guardrails.state(this.config),digests:this.digest.list(),lessonTrials:this.trials.list(),reviewInterval:this.reviewInterval.get(this.watchScope(),this.config),reflections:this.reflections.state(),aiCalls:this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.payload)),learning:{...this.memory.summary(),lastRun:this.learningLastRun??null,error:this.learningError??null},watches:this.watches.list(this.watchScope()),outcomes:this.outcomes.list(),execution:this.executionState(),emergency:this.emergencyState(),config:this.config,sessionArmed:this.sessionArmed,savedAt:this.savedAt,heartbeat:Date.now(),scheduler:this.schedulerStatus(),lastAttempt:this.lastRun||null,lastSuccess:this.lastSuccess||null,lastError:this.lastError,lastErrorDetail:this.lastErrorDetail??null,nextReview:this.nextReviewAt(),providerStatus:this.providerStatus,busy:this.busy,news:this.news,newsUpdatedAt:this.newsUpdatedAt??null,newsError:this.newsError,account:this.accountTag(),reviews:this.reviewHistory(50),allReviews:this.reviewHistory(50,true),lessons:this.memory.list(),usage:this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0}};}
  localDecision(context) {
    if(context.currency==='USD'||context.currency==='MULTI')return {action:'Hold',symbol:'',quantity:0,explanation:'U.S. portfolio requires an AI review or a manual proposal; the domestic demonstration rule does not trade USD assets.'};
    if(context.orders.some(order=>['Pending','Partially filled','Accepted','Submitting','Uncertain'].includes(order.status)))return {action:'Hold',symbol:'',quantity:0,explanation:'Wait for pending orders to reconcile before another rebalance.'};
    if(context.emergency?.active){
      const candidates=context.universe.map(row=>({row,quote:context.quotes.find(q=>q.symbol===row.symbol),quantity:context.positions[row.symbol]?.quantity??0})).filter(item=>item.quantity>0&&item.quote&&!item.quote.stale).sort((a,b)=>b.quantity*b.quote.price-a.quantity*a.quote.price);
      for(const item of candidates){const quantity=Math.min(item.quantity,Math.max(1,Math.ceil(item.quantity*.25)),Math.floor((context.risk.maxOrderKRW??context.equity)*.9/item.quote.price),1000);if(quantity>0)return {action:'Sell',symbol:item.row.symbol,quantity,explanation:'Emergency local rule: propose reducing up to 25% of the largest available position to lower exposure. This deterministic rule is not an AI forecast; approval and independent execution checks still apply.'};}
      return {action:'Hold',symbol:'',quantity:0,explanation:'Emergency local rule: no eligible held position with a fresh quote is available to reduce. Preserve cash and request further evidence.'};
    }
    const costs=context.tradingCosts;const roundTripPct=costs?.basis==='simulation'?2*(costs.commissionPct+costs.slippagePct):costs?.settings?2*costs.settings.krCommissionPct+(costs.krSaleTaxPct??0.2):0;
    if(roundTripPct>=this.config.eventTolerancePct)return {action:'Hold',symbol:'',quantity:0,explanation:'Estimated round-trip costs exceed the allocation-drift threshold. Avoid demonstration rebalancing that is smaller than its cost.'};
    for(const row of context.universe) {
      const quote=context.quotes.find(q=>q.symbol===row.symbol);if(!quote||quote.stale)continue;
      const quantity=context.positions[row.symbol]?.quantity??0;const target=Math.floor(context.equity*.10/quote.price);const difference=target-quantity;
      if(Math.abs(difference)*quote.price/context.equity*100<this.config.eventTolerancePct)continue;
      const bounded=Math.min(Math.abs(difference),Math.floor(900000/quote.price),1000);
      if(bounded>0)return {action:difference>0?'Buy':'Sell',symbol:row.symbol,quantity:bounded,explanation:'Local test rule: move toward a 10% per-company paper allocation. This is a deterministic demonstration, not an AI prediction.'};
    }
    return {action:'Hold',symbol:'',quantity:0,explanation:'No paper allocation drift exceeds the configured threshold.'};
  }
  context() {
    const state=this.paper.getState();
    return {environment:'local-paper',paperVersion:state.account.version,equity:state.account.equity,cash:state.account.availableCash,positions:state.account.positions,universe:state.universe,quotes:state.quotes,orders:state.orders.filter(order=>['Pending','Partially filled'].includes(order.status)).map(({symbol,side,quantity,filled,status})=>({symbol,side,quantity,filled,status})),risk:state.policy,news:this.newsContext(),reviewedLessons:this.db.prepare('SELECT text FROM lessons WHERE approved=1 ORDER BY rowid DESC LIMIT 5').all().map(row=>row.text)};
  }
  // A review's inputs, built through the normal path: fresh market data, reconciled orders, account context, lessons,
  // costs, performance, plan and order books. Shared by reviews and dry runs.
  // Dry runs check a review without acting on it. 'inputs' builds a fresh review input snapshot and makes no AI call;
  // 'review' also asks the configured model, with every state-changing tool answering "not applied: dry run". Neither
  // proposes or submits orders, changes conditional orders, watches, triggers, notes, the watchlist, the review interval
  // or the schedule, nor feeds the journal, lessons, learning or the routing evaluation. AI cost is accounted as usual.
  // Building the inputs still refreshes market data and reconciles open orders with KIS, as every review does.
  async dryRun(mode='inputs'){
    if(!['inputs','review'].includes(mode))throw new Error('INVALID_REQUEST');if(this.busy)throw new Error('REVIEW_BUSY');
    if(this.config.scope==='paper')throw new Error('DRY_RUN_NEEDS_KIS');if(mode==='review'&&(this.config.provider!=='openai'||!this.providerStatus.aiConnected))throw new Error('AI_NOT_CONNECTED');
    this.busy=true;const id=randomUUID();const watchScope=this.watchScope();
    try{
      const {context}=await this.assembleReviewContext({watchScope,trigger:'Dry run'});const summary=dryRunSummary(context,{assembledAt:Date.now(),account:this.accountTag(),scope:this.config.scope});
      // The full assembled inputs, as the model would receive them, are kept with the record for inspection.
      const snapshot=require('./token-saver.cjs').compact(context);
      let review=null;
      if(mode==='review'){
        // Shaped and logged as a live review is ("Review size"); the size, every request's bytes and the full research
        // transcript (detail reads, condensing, refusals) are kept with the record, also when the review fails.
        const shapedDry=require('./review-context.cjs').shape(require('./token-saver.cjs').compact(context));
        const size={...shapedDry.report,mandatoryBytes:shapedDry.mandatoryBytes,steps:shapedDry.steps,detailAvailable:shapedDry.context.detailAvailable??[]};
        this.log(id,'System','Review size',JSON.stringify({dryRun:true,...size}));
        const providerContext=shapedDry.context;const transcript=[],requests=[];
        const trace=()=>({size,requests,transcript,detailReads:transcript.filter(t=>t.title.startsWith('Context detail')).map(t=>t.title.replace(/^Context detail · /,'')+' → '+t.body),condensed:transcript.filter(t=>t.title==='Research context condensed').map(t=>t.body)});
        const failed=error=>{const at=Date.now();const record={id,timestamp:at,mode,summary,review:{failed:/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'DRY_RUN_FAILED',...trace(),...(error?.metrics?{research:error.metrics}:{})}};
          try{this.db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run(id,at,JSON.stringify({...record,snapshot}));}catch{}return error;};
        if(!shapedDry.fits)throw failed(require('./review-context.cjs').sizeFailure(shapedDry,{stage:'dry-run first request'}));
        const noop=name=>async()=>({status:'not-applied',reason:`Dry run: ${name} was not applied.`});
        const read=this.discovery?{...(this.discovery.research?{get_company_research:args=>this.discovery.research(args)}:{}),...(this.discovery.marketOverview?{get_market_overview:()=>this.discovery.marketOverview()}:{}),screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:noop('update_watchlist')}:null;
        // Every desk tool is a no-op except compute, which only reads prices.
        const desk=providerContext.agentDesk?(()=>{const real=this.deskActions(watchScope,providerContext,id,()=>{});return Object.fromEntries(Object.keys(real).map(k=>[k,k==='compute'?real.compute:noop(k)]));})():null;
        const model={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort};const models=require('./ai-models.cjs');let calls=0;const callIds=[];
        const request=async options=>{options={...options,...model};
          requests.push({call:requests.length+1,followUp:Boolean(options.continuation),bytes:Buffer.byteLength(JSON.stringify(options.continuation??[{role:'user',content:JSON.stringify(providerContext)}])),limitBytes:models.reviewByteLimit(options)});
          const reserve=models.reservation(model,providerContext,{...options,maxBytes:models.reviewByteLimit(options)});
          const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
          const callId=randomUUID();callIds.push(callId);this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify({reviewId:id,model:model.openaiModel,reasoningEffort:model.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'dry-run'}));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
          calls++;try{const r=await this.decisionWithRetry(providerContext,options);require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,r,'completed');return r;}
          catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}};
        // Condensing uses the routine model as a live review does (accounted as kind compact under this dry run's id).
        const log=(kind,title,body)=>{transcript.push({at:new Date().toISOString(),kind,title,body:String(body).slice(0,4000)});this.log(id,kind,title,String(body));};
        let r;try{r=await require('./research-review.cjs').researchReview({context:providerContext,detail:shapedDry.detail,watched:watchedIn(this.discovery,providerContext),wrap:null,evidence:this.evidence,discovery:providerContext.discovery?.enabled?read:null,setInterval:noop('set_review_interval'),setWatch:noop('set_review_watch'),actions:desk,log,compact:this.config.provider!=='openai'?null:payload=>this.compactResearch(id,payload),request});}
        catch(error){throw failed(error);}
        const micro=this.db.prepare('SELECT payload FROM ai_calls').all().map(row=>JSON.parse(row.payload)).filter(p=>p.reviewId===id).reduce((sum,p)=>sum+(p.accountedMicro??p.estimatedMicro??0),0);
        review={model:model.openaiModel,effort:model.reasoningEffort,decision:r.decision,usage:r.usage??null,research:r.metrics??null,calls,costUSD:Math.round(micro)/1e6,tools:transcript.filter(t=>/request/i.test(t.title)).map(t=>t.title+': '+t.body.slice(0,120)),...trace()};
      }
      const record={id,timestamp:Date.now(),mode,summary,...(review?{review}:{})};
      this.db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run(id,record.timestamp,JSON.stringify({...record,snapshot}));
      this.log(id,'System',mode==='review'?'Dry-run review · nothing applied':'Dry run · inputs checked',JSON.stringify(review?{summary,decision:{action:review.decision.action,symbol:review.decision.symbol,quantity:review.decision.quantity,explanation:review.decision.explanation},calls:review.calls,costUSD:review.costUSD,requestBytes:review.requests.map(q=>q.bytes),detailReads:review.detailReads.length,condensed:review.condensed.length}:{summary}));
      return record;
    }finally{this.busy=false;}
  }
  // Both engines' order records, open and resolved, for checking what notes claim about orders.
  engineOrders(){return [this.live,this.usLive].flatMap(e=>{try{return e?.orders?.()??[];}catch{return [];}});}
  // Orders of the markets this review covers: Korea for kis, the U.S. for us, both for both; none for paper.
  scopedOrders(){const engines={kis:[this.live],us:[this.usLive],both:[this.live,this.usLive]}[this.config.scope]??[];return engines.flatMap(e=>{try{return e?.orders?.()??[];}catch{return [];}});}
  // Notes with their claims checked against confirmed account state (electron/note-staleness.cjs): holdings and order
  // status from the broker engines, the time of the latest successful order check, and whether status is unconfirmed.
  // Holdings from the broker engines' latest balances: {symbol: {quantity}}.
  brokerPositions(){const positions={};
    for(const e of [this.live,this.usLive].filter(Boolean)){try{const snap=e.riskBalance??e.getConnection?.()?.snapshot;for(const h of snap?.holdings??[])positions[h.symbol]={quantity:h.quantity};}catch{}}
    return positions;}
  annotatedNotes(notes){
    const engines=[this.live,this.usLive].filter(Boolean);const positions=this.brokerPositions();
    const reconciliation=engines.map(e=>{try{return e.orderReconciliation?.()??null;}catch{return null;}}).find(r=>r?.status==='unconfirmed')??null;
    const confirmedAt=Math.max(...engines.map(e=>e.reconcileHealth?.lastSuccessAt??-Infinity),...this.engineOrders().map(o=>o.reconciledAt??-Infinity));
    return require('./note-staleness.cjs').annotate(notes,{orders:this.engineOrders(),positions,reconciliation,confirmedAt:Number.isFinite(confirmedAt)?confirmedAt:null});
  }
  // Order events: a pending order that fills, partly fills, is cancelled or rejected starts a review promptly, once per
  // change. Orders first seen after the app starts are only recorded.
  orderEvents(){
    this.orderSeen??=new Map();const events=[];
    for(const o of this.scopedOrders()){if(!o?.id)continue;const key=`${o.status}|${o.filled??0}`;const prev=this.orderSeen.get(o.id);this.orderSeen.set(o.id,key);
      if(prev!==undefined&&prev!==key&&ORDER_EVENTS.includes(o.status))events.push(o);}
    return events;
  }
  // Orders waiting at the broker on their own trading day. One left from an earlier day has expired: KIS reports some
  // expired day orders without a cancel flag, so they would otherwise stay Accepted and hold reviews back.
  pendingOrders(now=Date.now()){const today={KR:seoulDate(now),US:require('./kis-overseas.cjs').localDate(new Date(now))};
    return this.scopedOrders().filter(o=>PENDING_ORDER.includes(o.status)&&(!o.day||o.day>=today[o.market==='US'?'US':'KR']));}
  // Which markets are open: a change since the last review (an open or a close) is a backstop for a deferred review.
  sessionKey(now=Date.now()){try{return this.marketHours(now).markets.map(m=>`${m.market}:${m.open?'open':'closed'}`).join(',');}catch{return '';}}
  // While an order only waits at the broker, routine scheduled reviews would keep re-checking it: they wait for the
  // order's fill, partial fill or cancellation instead, with backstops: price, news and agent triggers still run, and so
  // does a review once a market opens or closes or ORDER_BACKSTOP_MS after the last one.
  deferForPendingOrder(now=Date.now()){
    const orders=this.pendingOrders(now);if(!orders.length)return null;
    if(now-this.lastRun>=ORDER_BACKSTOP_MS||this.reviewSessionKey&&this.sessionKey(now)!==this.reviewSessionKey)return null;
    return {orders,until:this.lastRun+ORDER_BACKSTOP_MS};
  }
  // Live state for the schedule observer (electron/schedule-observer.cjs), from data the app already holds: regular
  // sessions, streamed and refreshed quotes, the engines' holdings and orders, the regime, cached top stories and the scout
  // plan. Makes no broker or AI calls.
  scheduleState(now=Date.now()){
    const ms=require('./market-sessions.cjs'),mh=require('./market-hours.cjs');const environment=this.live?.getConnection?.()?.snapshot?.environment??'mock';
    const closed=new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]);const markets={};
    for(const m of mh.marketsFor(this.config.scope)){const s=ms.marketStatus(m,now,{environment,enabled:this.sessionOptions(),...(m==='KR'?{closedDays:closed}:{})});markets[m]=s.regular?{open:s.regular.startAt<=now&&now<s.regular.endAt,startAt:s.regular.startAt,endAt:s.regular.endAt}:{open:false};}
    const prices={};for(const q of [...(this.marketQuotes?.()??[]),...(this.usQuotes??[])])if(q?.price>0)prices[q.symbol]=q.price;
    const holdings={};for(const e of [this.live,this.usLive].filter(Boolean)){try{const snap=e.riskBalance??e.getConnection?.()?.snapshot;for(const h of snap?.holdings??[])holdings[h.symbol]=h.quantity;}catch{}}
    const scope=this.watchScope();const plan=this.scoutStore.latest(scope);
    const watched=[...new Set([...Object.keys(holdings),...(plan?.plan?.targets??[]).map(t=>t.symbol),...this.watches.list(scope).map(w=>w.symbol)])];
    const recon=[this.live,this.usLive].filter(Boolean).map(e=>{try{return e.orderReconciliation?.()?.status??null;}catch{return null;}});
    const names=new Set(watched.flatMap(s=>{let n=null;try{n=(/^\d{6}$/.test(s)?this.live:this.usLive)?.nameOf?.(s);}catch{}return [s,n].filter(Boolean);}));
    // A top story counts when it names a watched symbol or company, or is broad-market news.
    const BROAD=/코스피|코스닥|증시|나스닥|금리|환율|사이드카|서킷|연준|fed|s&p|dow/i;
    const stories=this.topStories(now).map(s=>({key:s.terms?.[0]??'',relevant:(s.symbols??[]).some(x=>watched.includes(x))||(s.terms??[]).some(t=>[...names].some(n=>String(n).toLowerCase()===t))||(s.terms??[]).some(t=>BROAD.test(t))}));
    return {at:now,markets,prices,watched,holdings,orders:this.engineOrders().filter(o=>now-(o.createdAt??0)<7*86400000).map(o=>({id:o.id,status:o.status,filled:o.filled??0})),
      reconciliation:recon.includes('unconfirmed')?'unconfirmed':recon.includes('confirmed')?'confirmed':null,regime:this.regimeState()?.regime??null,stories,scoutPlanAsOf:plan?.timestamp??null};
  }
  // Whether armed conditional orders are being checked and can fire: the one rule the firing loop, reviews and the UI share.
  conditionalMonitoringActive(){return Boolean(this.config.conditionalOrders&&this.config.enabled&&this.sessionArmed&&this.config.scope!=='paper');}
  dryRuns(limit=5){return this.db.prepare('SELECT payload FROM dry_runs ORDER BY timestamp DESC LIMIT ?').all(limit).map(r=>{const {snapshot,...rest}=JSON.parse(r.payload);return rest;});}
  // What a dry-run review would cost before it starts: today's AI use against the limits, and an estimate from the
  // recent completed reviews on the configured model (a review is one or more requests).
  dryRunEstimate(){
    const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
    const rows=this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 400').all().map(r=>JSON.parse(r.payload)).filter(c=>!c.kind&&c.model===this.config.openaiModel&&c.status==='completed'&&Number.isFinite(c.accountedMicro));
    const byReview=new Map();for(const c of rows){const v=byReview.get(c.reviewId)??{micro:0,calls:0};v.micro+=c.accountedMicro;v.calls++;byReview.set(c.reviewId,v);}
    const recent=[...byReview.values()].slice(0,10);const sorted=recent.map(v=>v.micro).sort((a,b)=>a-b);const median=sorted.length?sorted[Math.floor(sorted.length/2)]:null;
    const usd=v=>v==null?null:Math.round(v)/1e6;
    return {model:this.config.openaiModel,estimateUSD:usd(median),highUSD:usd(sorted.at(-1)??null),requests:recent.length?{min:Math.min(...recent.map(v=>v.calls)),max:Math.max(...recent.map(v=>v.calls))}:null,basis:`${recent.length} recent ${this.config.openaiModel} reviews`,
      today:{calls:usage.calls,usedUSD:usd(usage.reservedMicro),maxCalls:this.config.unlimitedCalls?null:this.config.maxCallsPerDay,maxUSD:this.config.unlimitedBudget?null:this.config.maxUSDPerDay},
      note:'A dry-run review counts against the same daily AI limits as live reviews.'};
  }
  async assembleReviewContext({watchScope,trigger='User request',externalDecision=null,setStage=()=>{},evidence}){
    let context;
      // Korean breadth and flows are refreshed before each review while the Korean session is open, so no review starts
      // from a previous session's reading.
      try{await this.freshenMarket?.();}catch{}
      // Open orders are checked against KIS order history first, so a review does not reason from a stale order status.
      await this.reconcileOpenOrders();
      let usValue;let execution=this.config.scope==='us'?this.usLive:this.live;
      if(this.config.scope!=='paper') {
        if(this.config.scope==='us'||this.config.scope==='both')usValue=await this.refreshUS();
        if(externalDecision)throw new Error('EXTERNAL_KIS_DISABLED');
        if(this.config.provider==='openai'&&!this.config.shareKisWithAI)throw new Error('DATA_SHARING_NOT_ENABLED');
        if(this.config.scope==='both'){const kr=await this.live.context(),us=await this.usLive.context(usValue);kr.tradingCosts=this.costs?.context('KR',kr.universe,kr.positions);us.tradingCosts=this.costs?.context('US',us.universe,us.positions);context=require('./combined-context.cjs').combinedContext(kr,us,this.fx?.(),this.metadata?.());}else context=await execution.context(this.config.scope==='us'?usValue:null);context.news=this.newsContext();if(context.environment!=='local-paper'){const stories=this.storiesContext();if(stories.length)context.topStories=stories;}context.reviewedLessons=this.db.prepare('SELECT text FROM lessons WHERE approved=1 ORDER BY rowid DESC LIMIT 5').all().map(row=>row.text);
      }else context=this.context();
      setStage('Local trade evidence');this.outcomes.sync();this.memory.sync();const accounts=[this.live,this.usLive].flatMap(engine=>{try{return [engine.identity()];}catch{return [];}});const lessons=this.memory.relevantLessons(context,accounts);context.reviewedLessons=lessons.map(row=>row.text);const lessonIds=lessons.map(row=>row.id);
      const conflicts=this.scoreboard.conflicts().filter(c=>lessonIds.includes(c.a)&&lessonIds.includes(c.b));if(conflicts.length)context.lessonConflicts=conflicts.map(c=>({lessons:[lessonIds.indexOf(c.a)+1,lessonIds.indexOf(c.b)+1],symbol:c.symbol,note:c.reason+' Weigh both; neither is a validated rule.'}));
      if(context.environment!=='local-paper'){const board=this.scoreboard.context();if(board)context.decisionScoreboard=board;const macro=this.macro?.context();if(macro)context.macro=macro;}
      setStage('Portfolio context');const emergency=context.environment==='kis'?{...this.emergencyState(),active:false,loss:null}:this.emergencyState();
      if(context.environment==='kis'){const policy=context.risk;const {lossStatus}=require('./loss-policy.cjs');emergency.loss=lossStatus(policy.lossLimit??{mode:'amount',value:policy.maxDailyLossKRW},policy.baseline,context.equity);emergency.active=emergency.loss.breached;}
      // Combined reviews state trading costs once (not again inside markets[]) and the tax rules once for both markets.
      if(context.environment==='kis-combined')Object.assign(context,require('./review-context.cjs').combineTradingCosts(context.markets));
      else context.tradingCosts=context.environment==='kis-combined'?null:context.environment==='local-paper'?{basis:'simulation',currency:'KRW',commissionPct:.1,slippagePct:.1,saleTaxPct:0,capitalGainsTax:'Not modeled in the local paper simulator. Live trading uses your fee and tax settings.'}:this.costs?.context(context.market??'KR',context.universe,context.positions);context.emergency=emergency;context.userGuidelines=this.config.guidelines;const peak=context.environment==='local-paper'?(this.paper.account().dayPeakEquity??this.paper.account().dayBaseline):(context.environment==='kis-combined'?null:context.risk.dayPeakEquity??context.risk.baseline);context.performance={dailyBaseline:emergency.loss?.baseline??null,observedDailyPeak:peak,currentEquity:context.equity,drawdownFromObservedPeakPct:peak>0?Math.max(0,(peak-context.equity)/peak*100):null};
      context.reviewInterval=this.reviewInterval.get(watchScope,this.config);if(context.environment==='kis'||context.environment==='kis-combined'){const history=context.environment==='kis-combined'?{KR:this.performanceSummary?.('KR')??null,US:this.performanceSummary?.('US')??null}:this.performanceSummary?.(context.market)??null;if(history)context.performance.history=history;}
      context.reviewWatches=this.watches.list(watchScope).map(({baseline,revision,...watch})=>watch);
      // Sector moves in the other market, as leads for the next session here (electron/main.cjs sectorLeads).
      if(this.config.scope!=='paper'&&this.sectorLeads){try{const leads=await this.sectorLeads(this.config.scope);if(leads)context.sectorLeads=leads;}catch{}}
      // How a pending order is followed, so reviews do not keep re-deciding an order that is only waiting.
      {const pending=this.pendingOrders();if(pending.length)context.orderFollowUp={orders:pending.map(o=>this.openOrderView(o)),
        note:`The app starts a review as soon as a pending order fills, partly fills or is cancelled, and otherwise routine reviews wait for it up to ${ORDER_BACKSTOP_MS/60000} minutes (price, news and agent triggers and market opens or closes still start reviews). Do not re-decide a pending order in each review: say only what would make you cancel or change it (a broken thesis, a price far from the limit, new evidence), and act if that has happened.`};}if(context.environment!=='local-paper'){const latestPlan=this.scoutStore.latest(watchScope);const plan=require('./scout.cjs').reviewContext(latestPlan,Date.now(),{stale:this.staleCarried(latestPlan?.plan?.targets,context.quotes)});if(plan){context.scoutPlan=plan;const gap=require('./plan-gap.cjs').planGap(context);if(gap)context.planGap=gap;}const brief=this.scoutBriefState(watchScope);if(brief)context.scoutBrief=brief;context.agentDesk=this.desk.context(watchScope,this.config,(context.universe??[]).map(r=>r.symbol),context.positions);if(context.agentDesk?.notes?.length){const flags=new Map(this.annotatedNotes(this.desk.notes(watchScope)).map(n=>[n.symbol,n]));context.agentDesk.notes=context.agentDesk.notes.map(n=>{const f=flags.get(n.symbol??'');return {...n,...(f?.accountStateConflict?{accountStateConflict:f.accountStateConflict}:{}),...(f?.orderClaimUnverified?{orderClaimUnverified:f.orderClaimUnverified}:{})};});}if(context.agentDesk?.conditionalOrders?.allowed)context.agentDesk.conditionalOrders.monitoring=this.conditionalMonitoringActive()?'active':'inactive: auto trading is paused, so armed orders do not fire until it is started';const story=this.storyContext();if(story.marketNarrative)context.marketNarrative=story.marketNarrative;if(story.similarEpisodes?.length)context.similarEpisodes=story.similarEpisodes;const risk=this.riskContext(context);Object.assign(context,risk);if(context.planGap)require('./plan-gap.cjs').addMinimumPositions(context);const events=this.calendarState(14,(context.universe??[]).map(r=>({symbol:r.symbol,name:r.name})));if(events.length)context.eventCalendar=events.slice(0,15).map(({date,kind,market,symbol,title,estimated})=>({date,kind,market,symbol,title,estimated}));}if(context.environment!=='local-paper'&&this.discovery){const starters=this.discovery.starters?.()??[];const usStarters=['us','both'].includes(this.config.scope)?this.discovery.usStarters?.()??[]:[];const starterCandidates=[...(starters.length?[{market:'KR',symbols:starters,source:'KIS market-cap ranking',note:'Korea has no allowlist, watchlist or holdings, so the largest listed companies were added to the review universe as a starting point. They are not recommendations.'}]:[]),...(usStarters.length?[{market:'US',symbols:usStarters,source:'KIS NASDAQ and NYSE market-cap rankings',note:'The U.S. market has no allowlist, watchlist or holdings, so the largest listed companies were added to the review universe as a starting point. They are not recommendations.'}]:[])];context.discovery={enabled:true,watchlist:this.discovery.list().map(({symbol,name,source,reason})=>({symbol,name,source,reason})),...(starterCandidates.length?{starterCandidates}:{})};}if(EVIDENCE_TRIGGERS.includes(trigger))context.triggerEvidence=evidence===undefined?this.triggerEvidence:evidence;
      try{await this.attachOrderBooks(context);}catch{}
      // Whether total equity can be trusted for weights: unconfirmed order status, an uncertain settlement or a missing market.
      if(context.environment!=='local-paper'){const reasons=[];if(context.orderReconciliation)reasons.push('open order status unconfirmed');
        reasons.push(...(context.equityUncertainty?.reasons??[]));
        if(!Number.isFinite(context.equity))reasons.push('total equity unavailable (a market or the exchange rate is missing)');context.equityReliability={reliable:!reasons.length,...(reasons.length?{reasons}:{})};}
      // Data gaps that persisted across reviews, with the research already tried (electron/research-gaps.cjs).
      if(context.environment!=='local-paper'){const gaps=this.researchGaps.context(watchScope);if(gaps.length)context.researchGaps=gaps;}
      {const open=this.waits.context(watchScope,{enforced:this.config.reviewGate==='on'});if(open.length)context.waits=open;const pending=this.pending.context(watchScope);if(pending.length)context.pendingDecisions=pending;
        if(context.agentDesk){const symbols=[...new Set([...Object.keys(context.positions??{}),...(context.universe??[]).map(r=>r.symbol)])];const list=this.assessments.context(watchScope,{context,symbols,events:this.newsEvents.list(300),movePct:this.config.eventTolerancePct??3});if(list.length)context.assessments=list;}}
      // The previous review on this account, so a reversal (Hold to Buy, waiting to acted) explains what changed.
      if(context.environment!=='local-paper'){const key=this.accountTag()?.key;const prev=key?this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.account.key')=? ORDER BY rowid DESC LIMIT 1").get(key):null;
        if(prev){const r=JSON.parse(prev.payload),d=r.decision??{};context.previousReview={at:new Date(r.timestamp).toISOString(),action:d.withheld?'Buy withheld (incomplete plan)':d.action,...(d.action!=='Hold'||d.withheld?{symbol:d.withheld?.symbol??d.symbol,quantity:d.withheld?.quantity??d.quantity}:{}),verdicts:Object.fromEntries((d.planVerdicts??[]).map(v=>[v.symbol,v.verdict])),explanation:String(d.explanation??'').slice(0,400)};}}
    return {context,emergency,usValue,execution,lessonIds};
  }
  async review(trigger='User request',externalDecision) {
    // The evidence that started this review, captured before anything is awaited: a later trigger replaces
    // this.triggerEvidence, and a review that fails before its context is built (account data) still puts it back.
    // Review of 8ef1be1, P1: an agent trigger followed by INCOMPLETE_BALANCE was used up with no decision.
    const entryEvidence=EVIDENCE_TRIGGERS.includes(trigger)?this.triggerEvidence??null:null;
    if(this.busy){if(entryEvidence)this.restoreEvents(this.watchScope(),entryEvidence);throw new Error('REVIEW_BUSY');}const startedAt=Date.now();this.restoreClock();this.busy=true;this.reviewSessionKey=this.sessionKey();const id=randomUUID();let context,decided=false;let stage='Account data';if(this.config.scope!=='paper'&&!externalDecision)try{this.scheduleObserver.noteEventReview(trigger,this.scheduleState());}catch{}const revision=this.revision;const watchScope=this.watchScope();let costRevision=null;
    try {
      costRevision=JSON.stringify(this.costs?.get());
      let emergency,usValue,execution,lessonIds;({context,emergency,usValue,execution,lessonIds}=await this.assembleReviewContext({watchScope,trigger,externalDecision,setStage:value=>{stage=value;},evidence:entryEvidence}));
      this.observeEmergency(emergency);if(emergency.active)this.lastEmergencyAttempt=Date.now();
      // Token saving: an unchanged scheduled review is skipped before any provider call.
      const saver=require('./token-saver.cjs');const hash=saver.fingerprint(context);
      this.noteSessions(context);
      // Review gate (electron/review-gate.cjs): what changed since the last successful decision. 'observe' logs it beside
      // the skip above; 'on' lets it decide. Either way its reasons are logged for every scheduled review.
      // News is read once, with the context: the baseline marks seen only what this review could have seen.
      const gateMode=this.config.reviewGate??'off';let gate=null;const gateEvents=gateMode!=='off'?this.newsEvents.list(300):[];
      if(gateMode!=='off'&&!externalDecision)try{const RG=require('./review-gate.cjs');gate=RG.compare(this.reviewGate.baseline(watchScope),RG.decisionState(context),{trigger,config:this.config,events:gateEvents,waits:this.waits.all(watchScope),pending:this.pending.active(watchScope)});}catch{gate=null;}
      const skippable=this.config.provider==='openai'&&!externalDecision&&!emergency.active;
      const oldSkip=skippable&&saver.shouldSkip({trigger,config:this.config,fingerprint:hash,last:this.lastFingerprint?.scope===watchScope?this.lastFingerprint:null});
      const gateLog=(ran,extra={})=>{if(gate)try{this.reviewGate.log(Date.now(),{scope:watchScope,trigger,mode:gateMode,oldSkip,ran,reviewId:ran?id:null,...extra,gate});}catch{}};
      if(gateMode==='on'&&gate&&skippable&&trigger==='Scheduled review'&&!gate.needsReview){
        gateLog(false);this.lastRun=Date.now();this.recordSaving('skipped');const stamp=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});
        this.log(id,'System','Review skipped · nothing decision-relevant changed',`Holdings, orders, cash, execution, risk, protection, exposure, prices (cumulative since the decision), entry levels and filings are unchanged since the last decision. No AI call was made. A full review runs by ${stamp(gate.nextBackstopAt)} KST at the latest.${gate.degraded.length?` Data missing or stale: ${gate.degraded.join(', ')}.`:''}`);return {skipped:true,id};}
      if(gateMode!=='on'&&oldSkip){
        gateLog(false);this.lastRun=Date.now();this.recordSaving('skipped');this.log(id,'System','Review skipped · no change',`Holdings, cash, prices (within ${this.config.eventTolerancePct/2}%), news, lessons and market sessions are unchanged since the review at ${new Date(this.lastFingerprint.completedAt).toLocaleTimeString()}. No AI call was made. A full review runs at least every ${this.config.maxSkipMinutes} minutes.`);return {skipped:true,id};
      }
      // A review that failed for its size is not retried on materially the same inputs; a material change (prices beyond
      // the tolerance, holdings, cash, sessions, important news), an emergency or the user's own request runs again.
      // After a failure on the app's own size limit, a review tries again only when something that can change a decision
      // changed (electron/size-retry.cjs); the skip is logged once per failure and every retry says what allowed it.
      const failed=this.failedInput?.scope===watchScope?this.failedInput:null;const inputState=require('./review-gate.cjs').decisionState(context);
      const eventKeys=require('./size-retry.cjs').eventKeys(entryEvidence);
      if(failed){const verdict=require('./size-retry.cjs').retryAfterSizeFailure(failed,{trigger,evidence:entryEvidence,emergency:emergency.active,version:this.appVersion(),state:inputState,events:this.newsEvents.list(300),config:this.config});
        if(!verdict.retry){gateLog(false,{failedInputs:true});this.lastRun=Date.now();failed.skipped=(failed.skipped??0)+1;failed.eventKeys=[...new Set([...(failed.eventKeys??[]),...eventKeys])];this.restoreEvents(watchScope,entryEvidence);
          if(failed.skipped===1)this.log(id,'System','Review skipped · same inputs as a failed review',`The review at ${new Date(failed.at).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST failed (${failed.code}) and ${verdict.why.replace(/^nothing/,'nothing')}. No AI call was made. A fill, an order change, a lost stop loss, a risk limit, a filing, a price move past the review gate's limits, a newly reached price level or met agent trigger, an app update, your own request or an emergency tries again; so does a 30-minute backstop. Later skips for this failure are not logged.`);
          return {skipped:true,id};}
        this.log(id,'System','Retrying after a size failure',`${failed.code} at ${new Date(failed.at).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST${failed.skipped?` (${failed.skipped} checks skipped since)`:''}; retried because: ${verdict.why}.`);}
      this.pendingInput={...hash,cash:require('./review-context.cjs').cashOf(context),scope:watchScope,state:inputState,version:this.appVersion(),seen:this.newsEvents.list(300).map(require('./review-gate.cjs').newsKey),eventKeys:[...new Set([...(failed?.eventKeys??[]),...eventKeys])]};
      // Routine reviews focus on what changed (setting routineReviews 'focused'); broad ones compare every strategy.
      if(gate&&this.config.routineReviews==='focused')try{context.reviewScope=require('./review-gate.cjs').reviewScope(gate,trigger,this.reviewGate.baseline(watchScope));}catch{}
      gateLog(true);if(gate&&trigger==='Scheduled review')this.log(id,'System',gate.needsReview?'Why this review runs':'Review gate · would skip',gate.needsReview?gate.reasons.map(r=>r.detail).join('; '):`Nothing decision-relevant changed since the last decision; ${gateMode==='on'?'':'the review gate is observing, so '}the review runs.`);
      this.log(id,'Program',trigger,context.environment!=='local-paper'?'Reviewing permitted KIS portfolio data. Credentials are excluded.':'Reviewing the local paper portfolio. KIS account data and credentials are excluded.');
      this.log(id,'Context','Supplied context',loggableContext(context));
      let result,routing=null,assessed=null,anchor=null,shadowRun=null;
      if(externalDecision){const {validateDecision}=require('./ai-client.cjs');result={decision:validateDecision(externalDecision,context.universe.map(row=>row.symbol)),provider:'external'};}
      else if(this.config.provider==='openai') {
        if(!this.providerStatus.aiConnected)throw new Error('AI_NOT_CONNECTED');
        stage='AI research and decision';
        const today=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0};
        assessed=this.config.modelRouting==='complexity'||this.config.shadowEvaluation?this.routingInputs(context,trigger):null;const inputs=this.config.modelRouting==='complexity'?assessed:null;
        let selected=saver.route(this.config,{trigger,emergencyActive:emergency.active,triggerEvidence:context.triggerEvidence,nearBudget:saver.nearBudget(this.config,today),complexity:inputs?.complexity,hardRule:inputs?.hardRule,eligible:this.routingEligibility().eligible});
        if(assessed)assessed.routeInputs={emergencyActive:Boolean(emergency.active),triggerEvidence:context.triggerEvidence?{kind:context.triggerEvidence.kind??null,events:(context.triggerEvidence.events??[]).map(e=>({importance:e.importance??null}))}:null,nearBudget:saver.nearBudget(this.config,today)};
        let providerContext=saver.compact(context);
        const shaped=require('./review-context.cjs').shape(providerContext);providerContext=shaped.context;const detail=shaped.detail;
        this.log(id,'System','Review size',JSON.stringify({...shaped.report,mandatoryBytes:shaped.mandatoryBytes,steps:shaped.steps}));
        if(!shaped.fits)throw require('./review-context.cjs').sizeFailure(shaped,{stage:'first request'});
        this.replays.saveContext(id,providerContext);
        // Shadow evaluation runs alongside this review, on a copy of the same context and with shared evidence.
        if(assessed&&this.config.shadowEvaluation&&!this.shadowing&&selected.openaiModel===this.config.openaiModel&&selected.reasoningEffort===this.config.reasoningEffort&&Math.random()*100<this.config.shadowPct){anchor=require('./evidence-anchor.cjs').createAnchor();shadowRun=this.shadowRun(id,structuredClone(providerContext),anchor,detail);}
        if(selected.tier!=='fixed')this.log(id,'System','Model routing',`${selected.openaiModel} · ${selected.reasoningEffort} (${selected.reason})`+(inputs?` · complexity ${inputs.complexity.score}/100${inputs.complexity.reasons.length?': '+inputs.complexity.reasons.join('; '):''}`:''));
        const research=()=>require('./research-review.cjs').researchReview({context,detail,watched:watchedIn(this.discovery,context),wrap:anchor?anchor.wrapper('live'):null,evidence:this.evidence,discovery:context.discovery?.enabled?{...(this.discovery.research?{get_company_research:this.researchFor({watchScope,trigger,emergency:emergency.active,gate,gateMode,id})}:{}),...(this.discovery.marketOverview?{get_market_overview:()=>this.discovery.marketOverview()}:{}),screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.discovery.update_watchlist(args);}}:null,setInterval:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.reviewInterval.set(watchScope,args,this.config,{heldMoves:this.heldMoves(context)});},setWatch:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.watches.set(watchScope,args,context);},actions:context.agentDesk?this.deskActions(watchScope,context,id,()=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');}):null,log:(kind,title,body)=>this.log(id,kind,title,body),compact:context.environment==='local-paper'||this.config.provider!=='openai'?null:payload=>this.compactResearch(id,payload),request:async options=>{
          if(this.disposed||watchScope!==this.watchScope()||revision!==this.revision||costRevision!==JSON.stringify(this.costs?.get()))throw new Error('STALE_DECISION');
          const modelConfig={openaiModel:selected.openaiModel,reasoningEffort:selected.reasoningEffort};options={...options,...modelConfig};
          const reserve=require('./ai-models.cjs').reservation(modelConfig,providerContext,{...options,maxBytes:require('./ai-models.cjs').reviewByteLimit(options)});
          const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
          if(require('./ai-models.cjs').budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
          const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now()};
          this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
          try{const response=await this.decisionWithRetry(providerContext,options);require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return {...response,model:response.model??modelConfig.openaiModel};}
          catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}

        }});
        if(selected.tier==='routine'&&(selected.openaiModel!==this.config.openaiModel||selected.reasoningEffort!==this.config.reasoningEffort)){
          // A failed cheaper-model run falls back to the main model instead of failing the review.
          // The failed run's research counts join the main model's run.
          try{result=await research();}catch(error){if(error.message==='STALE_DECISION'||error.message==='AI_BUDGET_EXHAUSTED')throw error;this.log(id,'System','Cheaper model failed',`${selected.openaiModel}: ${/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED'}; asking ${this.config.openaiModel} instead.`);selected={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort,tier:'escalated',reason:'cheaper model failed'};
            const failedMetrics=error.metrics;try{result=await research();}catch(again){if(failedMetrics&&again&&typeof again==='object')again.metrics=require('./research-meter.cjs').merge(failedMetrics,again.metrics);throw again;}if(failedMetrics)result={...result,metrics:require('./research-meter.cjs').merge(failedMetrics,result.metrics)};}
        }else result=await research();this.recordSaving(selected.tier);routing={tier:selected.tier,reason:selected.reason,model:selected.openaiModel,effort:selected.reasoningEffort,confirmed:null,...(inputs?{complexity:{score:inputs.complexity.score,parts:inputs.complexity.parts,reasons:inputs.complexity.reasons,agent:inputs.complexity.agent},hardRule:inputs.hardRule}:{})};
        // A trade proposed by the cheaper model is confirmed by the configured model before any proposal is created.
        if(selected.tier==='routine'&&result.decision.action!=='Hold'&&(selected.openaiModel!==this.config.openaiModel||selected.reasoningEffort!==this.config.reasoningEffort)){
          const first=result;this.log(id,'System','Trade confirmation',`${first.model} proposed ${first.decision.action} ${first.decision.quantity} ${first.decision.symbol}; asking ${this.config.openaiModel} to confirm.`);
          selected={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort,tier:'escalated',reason:'trade confirmation'};providerContext={...providerContext,confirmation:{proposedBy:first.model,decision:first.decision}};
          result=await research();this.recordSaving('confirmation');
          result=bothRuns(first,result);
          routing={...routing,confirmed:result.decision.action===first.decision.action&&result.decision.symbol===first.decision.symbol&&result.decision.quantity===first.decision.quantity,confirmedBy:this.config.openaiModel};
        }
        // Complexity routing: a cheaper-model Hold that changes a scout-target verdict goes to the configured model; other
        // cheaper-model Holds are spot-checked by it at the set rate, and its decision is used when the two differ.
        else if(inputs&&selected.tier==='routine'&&(selected.openaiModel!==this.config.openaiModel||selected.reasoningEffort!==this.config.reasoningEffort)){
          const before=new Map((inputs.previousReview?.decision?.planVerdicts??[]).map(v=>[v.symbol,v.verdict]));const changed=(result.decision.planVerdicts??[]).filter(v=>before.has(v.symbol)&&before.get(v.symbol)!==v.verdict);
          const spot=!changed.length&&Math.random()*100<this.config.spotCheckPct;
          if(changed.length||spot){
            const first=result;selected={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort,tier:'escalated',reason:changed.length?'verdict change':'spot check'};
            this.log(id,'System',changed.length?'Verdict change':'Spot check',changed.length?`${first.model} changed ${changed.map(v=>`${v.symbol} to ${v.verdict}`).join(', ')}; asking ${this.config.openaiModel} to decide.`:`Checking ${first.model}'s decision with ${this.config.openaiModel} (${this.config.spotCheckPct}% of cheaper-model reviews).`);
            result=await research();this.recordSaving(changed.length?'verdict-change':'spot-check');
            const verdicts=d=>JSON.stringify((d.planVerdicts??[]).map(v=>[v.symbol,v.verdict]).sort());const agreed=result.decision.action===first.decision.action&&result.decision.symbol===first.decision.symbol&&result.decision.quantity===first.decision.quantity&&verdicts(result.decision)===verdicts(first.decision);
            if(spot)this.log(id,'System','Spot check result',agreed?`${this.config.openaiModel} agreed with ${first.model}.`:`${this.config.openaiModel} disagreed (${first.decision.action}${first.decision.symbol?' '+first.decision.symbol:''} → ${result.decision.action}${result.decision.symbol?' '+result.decision.symbol:''}); using ${this.config.openaiModel}'s decision.`);
            result=bothRuns(first,result);
            routing={...routing,[changed.length?'verdictChange':'spotCheck']:{by:this.config.openaiModel,cheaper:{action:first.decision.action,symbol:first.decision.symbol||null,verdicts:first.decision.planVerdicts??[]},agreed}};
          }
        }
      } else if(this.config.provider==='external')throw new Error('EXTERNAL_DECISION_REQUIRED');
      else result={decision:this.localDecision(context),provider:'local'};
      if(this.disposed)return;if(watchScope!==this.watchScope()||revision!==this.revision||costRevision!==JSON.stringify(this.costs?.get()))throw new Error('STALE_DECISION');
      decided=true;stage='Decision recording and execution';if(result.model)this.log(id,'System','Model used',result.model+' · '+(routing?.confirmedBy||routing?.spotCheck||routing?.verdictChange?this.config.reasoningEffort:routing?.effort??this.config.reasoningEffort)+(routing?.confirmedBy?` (confirmed ${routing.confirmed?'unchanged':'with changes'})`:''));
      this.log(id,'Agent','Decision',JSON.stringify(result.decision,null,2));
      if(result.decision.withheld)this.log(id,'System','Buy held back · trade plan',`${result.decision.withheld.quantity} ${result.decision.withheld.symbol}: ${result.decision.withheld.reason}.`);
      // A Buy whose stop is not below the current price is held back too.
      // The stated before-and-after weights, checked against the app's own figures and kept with the decision.
      if(result.decision.action==='Buy'&&result.decision.plan?.portfolioImpact)try{const check=require('./plan-gap.cjs').impactCheck(context,result.decision);if(check){result={...result,decision:{...result.decision,portfolioImpactCheck:check}};if(check.differencePts>3)this.log(id,'System','Portfolio impact differs',JSON.stringify(check));}}catch{}
      if(result.decision.action==='Buy'&&result.decision.plan){const q=context.quotes?.find(r=>r.symbol===result.decision.symbol);if(q?.price>0&&!(result.decision.plan.stopPrice<q.price)){const d=result.decision;this.log(id,'System','Buy held back · trade plan',`${d.quantity} ${d.symbol}: stop ${d.plan.stopPrice} is not below the price ${q.price}.`);result={...result,decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',plan:d.plan,explanation:require('./ai-client.cjs').trimExplanation(`${d.explanation} [The app held back a Buy of ${d.quantity} ${d.symbol}: the stop price is not below the current price.]`),withheld:{symbol:d.symbol,quantity:d.quantity,reason:'stop not below price'}}};}}
      // The brief rides on the decision; it is saved for the scout and never affects the trade.
      {const PG=require('./plan-gap.cjs');const missing=PG.missingVerdicts(context,result.decision);const issues=PG.verdictIssues(context,result.decision);if(missing.length||issues.length)this.log(id,'System','Plan verdicts incomplete',[missing.length?`No verdict on ${missing.join(', ')}.`:'',...issues].filter(Boolean).join(' '));}
      if(result.decision.scoutBrief){const {scoutBrief,...decision}=result.decision;result={...result,decision};if(context.scoutBrief){const value=this.briefScout(watchScope,scoutBrief,id);this.log(id,'Tool','Scout brief',JSON.stringify({brief:scoutBrief,result:value}));}}
      const contextEvidence={guidelines:this.config.guidelines,environment:context.environment,marketSession:context.marketSession??null,quote:context.quotes.find(q=>q.symbol===result.decision.symbol)??null,position:context.positions?.[result.decision.symbol]??null,emergency:context.emergency.active,reviewedLessons:context.reviewedLessons,lessonIds};
      const recorded={model:result.model??null,contextEvidence,id,timestamp:Date.now(),scope:this.config.scope,account:this.accountTag(),trigger,provider:result.provider,decision:result.decision,proposalId:null,orderId:null,usage:result.usage??null,research:result.metrics??null};
      this.db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify(recorded));
      if(this.config.scope!=='paper')try{const events=this.db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.runId')=?").all(id).map(r=>JSON.parse(r.payload));this.researchGaps.record(watchScope,result.decision.planVerdicts,require('./research-gaps.cjs').researchFromEvents(events));}catch{}
      try{this.waits.record(watchScope,result.decision,{reviewId:id,context,research:this.researchSeen?.get(id)??[]});}catch{}
      if(this.config.scope!=='paper')try{const cost=this.db.prepare('SELECT payload FROM ai_calls').all().map(r=>JSON.parse(r.payload)).filter(c=>c.reviewId===id&&!c.kind).reduce((a,c)=>a+(c.accountedMicro??c.estimatedMicro??0),0)/1e6;this.scheduleObserver.recordReview(recorded,cost);}catch{}
      let proposal=null,order=null,executionNote=null,pendingAlready=null,placement=null,bounds=null,checked=null,stopNow=null;
      if(result.decision.action!=='Hold') {
        if(context.environment==='kis-combined')execution=/^\d{6}$/.test(result.decision.symbol)?this.live:this.usLive;
        if(context.environment==='local-paper'&&context.paperVersion!==this.paper.account().version)throw new Error('STALE_DECISION');
        const selected=context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market):context;
        const lossBreached=context.environment==='kis-combined'?(context.emergency.activeMarkets??[]).includes(execution.market):Boolean(context.emergency.active);
        if(result.decision.action==='Buy'&&lossBreached&&this.config.lossAction!=='review'){executionNote='Guardrail: new buys are blocked after the daily loss limit. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys blocked',executionNote);this.trip('buys-blocked',`Blocked a ${result.decision.symbol} buy after the daily loss limit was reached.`);}
        else if(result.decision.credit&&result.decision.credit!=='none'&&(context.environment==='local-paper'||execution.market!=='KR')){executionNote='Credit orders (margin buying, short selling) are only available for Korean live accounts. Recommendation recorded; no order proposal was made.';this.log(id,'System','Review only · credit order',executionNote);}
        else if(context.environment!=='local-paper'&&(selected?.executionEnabled===false||!execution.enabled)){executionNote=(execution.market==='US'?'U.S.':'Korea')+' trading session is off. Recommendation recorded; no order proposal or submission was made.';this.log(id,'System','Review only · execution off',executionNote);}
        // The same Buy or Sell already pending while its market is closed: one proposal, reassessed when it opens.
        // A KIS decision for a closed market places nothing: it is kept as a pending decision and reassessed when the market
        // opens (a proposal made now would expire unused, and pricing it would wait for a book that is not there).
        else if(context.environment!=='local-paper'&&!this.marketOpenIn(context)(/:/.test(result.decision.symbol)?'US':'KR')){pendingAlready=this.pending.repeats(watchScope,result.decision,this.marketOpenIn(context));executionNote=`The ${/:/.test(result.decision.symbol)?'U.S.':'Korean'} market is closed: ${result.decision.action} ${result.decision.symbol} is kept as a pending decision${pendingAlready?` (pending since ${new Date(pendingAlready.createdAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST)`:''} and reassessed when it opens. No order was placed.`;this.log(id,'System','Pending decision kept',executionNote);}
        // KIS orders are priced from a fresh order book; without one for a minute nothing is placed and a review follows.
        // Restrictions supplied but invalid withhold the order; a stop time or cancel condition is checked again after the
        // price is read (that can take a minute), immediately before the order is proposed and submitted.
        else if(context.environment!=='local-paper'&&(checked=this.executionBounds(result.decision,context.quotes.find(row=>row.symbol===result.decision.symbol)?.price,id)).invalid.length){executionNote=`Execution withheld: ${result.decision.action} ${result.decision.symbol} came with restrictions the app cannot honour (${checked.invalid.join('; ')}). No order was placed; the next review decides again.`;}
        else if(context.environment!=='local-paper'&&(bounds=checked.bounds,stopNow=this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true}))){executionNote=`Execution withheld: ${result.decision.action} ${result.decision.symbol}: ${stopNow}. No order was placed.`;this.log(id,'System','Execution withheld · restriction',executionNote);}
        else if(context.environment!=='local-paper'&&!(placement=await this.placementPrice({symbol:result.decision.symbol,side:result.decision.action,bound:bounds?.bound??null,id,still:()=>!this.disposed&&revision===this.revision&&watchScope===this.watchScope()&&!this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true})}))){stopNow=this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true});executionNote=stopNow?`Execution withheld: ${result.decision.action} ${result.decision.symbol}: ${stopNow} while the order book was awaited. No order was placed.`:`No usable order book for ${result.decision.symbol} for a minute; no order was placed. A review decides again.`;if(stopNow)this.log(id,'System','Execution withheld · restriction',executionNote);}
        else if(context.environment!=='local-paper'&&(stopNow=this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true}))){executionNote=`Execution withheld: ${result.decision.action} ${result.decision.symbol}: ${stopNow} while the order was priced. No order was placed.`;this.log(id,'System','Execution withheld · restriction',executionNote);}
        else if(pendingAlready=this.pending.repeats(watchScope,result.decision,this.marketOpenIn(context))){executionNote=`${result.decision.action} ${result.decision.symbol} has been pending since ${new Date(pendingAlready.createdAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST${pendingAlready.proposalId?` (proposal ${pendingAlready.proposalId})`:''}; it is reassessed when its market opens. No new proposal was made.`;this.log(id,'System','Pending decision kept',executionNote);}else{
        proposal=context.environment!=='local-paper'?execution.propose({...(result.decision.credit&&result.decision.credit!=='none'?{credit:{kind:result.decision.credit,...(result.decision.loanDate?{loanDate:result.decision.loanDate}:{})}}:{}),symbol:result.decision.symbol,side:result.decision.action,quantity:result.decision.quantity,limitPrice:placement.price}):this.paper.propose({symbol:result.decision.symbol,side:result.decision.action,quantity:result.decision.quantity});
        this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify({...recorded,proposalId:proposal.id}),id);
        // The order carries its bounds for the tracker, saved before it can be submitted.
        if(bounds&&context.environment!=='local-paper')execution.annotate?.(proposal.id,{tracking:bounds});
        this.log(id,'Risk','Proposal result',proposal.reason??'Paper risk checks passed.');
        if(result.decision.action==='Buy'&&result.decision.plan&&context.environment!=='local-paper')this.followPlan(watchScope,result.decision,id);
        const autoEligible=this.config.autoSubmit && (context.environment==='local-paper'||execution.autoEnabled!==false) && proposal.status==='Ready' && (context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market)?.marketSession.open===true:context.marketSession?.open!==false);
        const orderCap=this.config.maxAutoOrdersPerDay;
        if(autoEligible&&orderCap>0&&this.guardrails.autoOrdersToday()>=orderCap){executionNote=`Guardrail: the daily limit of ${orderCap} automatic orders is reached. Proposal awaits manual approval.`;this.log(id,'System','Guardrail · order limit',executionNote);this.trip('order-limit',`Daily automatic order limit (${orderCap}) reached; later proposals need approval.`);}
        else if(autoEligible) {order=context.environment!=='local-paper'?await execution.autoSubmit(proposal.id):this.paper.submit(proposal.id);this.log(id,'Tool','Order submission',JSON.stringify(order));}
        if(proposal?.reason)this.db.prepare('INSERT INTO lessons(id,text) VALUES(?,?)').run(randomUUID(),`Candidate lesson: avoid proposals blocked by ${proposal.reason}. Review freshness, reservations and configured limits before retrying.`);
        if(context.environment!=='local-paper'&&this.config.autoSubmit&&execution.autoEnabled===false){executionNote=(execution.market==='US'?'U.S.':'Korea')+' automatic execution is off. Proposal awaits manual approval.';this.log(id,'System','Approval required',executionNote);}}

      }
      const review={model:result.model??null,contextEvidence,id,scope:this.config.scope,account:recorded.account,timestamp:Date.now(),trigger,provider:result.provider,emergency:context.emergency.active,marketSession:context.marketSession?.status??null,decision:result.decision,executionNote,proposalId:proposal?.id??null,orderId:order?.id??null,usage:result.usage??null,research:result.metrics??null,routing};
      this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify(review),id);
      // Shadow evaluation: the cheaper model decides the same frozen inputs in the background; it changes nothing.
      if(shadowRun)this.shadowTask=shadowRun.then(shadow=>this.recordShadow(review,assessed,shadow,anchor)).catch(()=>null);
      this.lastFingerprint={...hash,scope:watchScope,completedAt:Date.now()};
      try{this.pending.record(watchScope,{decision:result.decision,reviewId:id,proposalId:proposal?.id??null,orderId:order?.id??null,context,marketOpen:this.marketOpenIn(context)});}catch{}
      if(gateMode!=='off')try{const RG=require('./review-gate.cjs'),m=result.metrics??{};const prev=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.payload)).find(r=>r.id!==id&&r.scope===this.config.scope&&r.decision);
        this.reviewGate.complete(id,{completed:true,orderId:order?.id??null,proposalId:proposal?.id??null,research:{toolCalls:m.toolCalls??0,researchReads:m.researchReads??0,detailReads:m.detailReads??0,fetched:m.fetched??0,refreshed:m.refreshed??0,reused:m.reused??0},change:RG.decisionChange(prev?.decision,result.decision)});}catch{}
      if(gateMode!=='off')try{this.reviewGate.settle(watchScope,require('./review-gate.cjs').decisionState(context),{decision:{action:result.decision?.action,symbol:result.decision?.symbol,orderId:order?.id??proposal?.id??null},contextAt:startedAt,events:gateEvents.filter(e=>e.firstSeenAt<=startedAt)});}catch{}
      this.lastRun=Date.now();this.lastSuccess=this.lastRun;this.guardrails.succeeded();this.lastError=null;this.failedInput=null;this.eventHold=null;this.lastErrorDetail=null;this.lastPrices=new Map(context.quotes.map(row=>[row.symbol,row.price]));this.watches.rebase(watchScope,context.quotes);this.lastWatchScope=watchScope;this.log(id,'System','Review completed',result.usage?JSON.stringify(result.usage):'No provider tokens used.');if(result.metrics)this.log(id,'System','Research metrics',JSON.stringify(result.metrics));return review;
    }catch(error){this.lastRun=Date.now();this.lastError=require('./ai-errors.cjs').publicCode(error)??(['AI_NOT_CONNECTED','AI_BUDGET_EXHAUSTED','EXTERNAL_DECISION_REQUIRED','PROVIDER_REQUEST_FAILED','AI_REQUEST_FAILED','DATA_SHARING_NOT_ENABLED','KIS_TRADING_DISABLED','STALE_DECISION','SESSION_CLOSED','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','FEATURE_UNAVAILABLE','INCOMPLETE_BALANCE'].includes(error.message)?error.message:'REVIEW_FAILED');this.lastErrorDetail=require('./ai-errors.cjs').detail(this.lastError,stage,error)+require('./ai-errors.cjs').sizeDetail(error);
      // A size failure is remembered with its inputs so the same inputs are not retried (see the skip above).
      const sizeFailed=require('./ai-errors.cjs').SIZE_CODES.includes(this.lastError)&&this.pendingInput;if(sizeFailed)this.failedInput={...this.pendingInput,code:this.lastError,at:Date.now()};
      // A review that reached no decision does not use up its one-off events (levels, agent triggers, filings). After a
      // size failure they are held until it clears; after any other failure, for EVENT_RETRY_MS, so a failing provider
      // is not called again every minute.
      if(!decided&&entryEvidence){this.restoreEvents(watchScope,entryEvidence);const keys=require('./size-retry.cjs').eventKeys(entryEvidence);
        if(!sizeFailed&&keys.length){const before=this.eventHold?.scope===watchScope&&Date.now()<this.eventHold.until?this.eventHold.keys:[];this.eventHold={scope:watchScope,keys:new Set([...before,...keys]),until:Date.now()+EVENT_RETRY_MS};if(!this.disposed)this.log(id,'System','Trigger kept for a later review',`No decision was made, so ${require('./size-retry.cjs').eventItems(entryEvidence).map(e=>e.label).join('; ')} ${keys.length>1?'are':'is'} kept and tried again from ${new Date(this.eventHold.until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST.`);}}
      if(!this.disposed){this.log(id,'System','Review failed',this.lastError+' · '+this.lastErrorDetail);if(error?.metrics)this.log(id,'System','Research metrics',JSON.stringify(error.metrics));const streak=this.guardrails.failed(),limit=this.config.maxConsecutiveFailures;if(limit>0&&streak>=limit&&(this.config.enabled||this.config.autoSubmit))this.trip('auto-stopped',`Auto trading stopped after ${streak} consecutive failed reviews (latest: ${this.lastError}).`);}throw new Error('REVIEW_FAILED');}
    finally{this.busy=false;this.researchSeen?.delete(id);this.firstAfterStart=false;this.saveClock();this.startRequestedScout();}
  }
  // A momentary OpenAI failure (connection, server error or timeout) is retried once after a short pause.
  async decisionWithRetry(context,options,pauseMs=3000){
    try{return await this.provider.request('decision',{context,options});}
    catch(error){if(!['AI_REQUEST_FAILED','AI_SERVER_ERROR','AI_TIMEOUT'].includes(error?.message)||this.disposed)throw error;await new Promise(r=>setTimeout(r,pauseMs));return this.provider.request('decision',{context,options});}
  }
  // Shadow evaluation (docs/ROUTING-EVALUATION.md): the cheaper model decides a copy of the exact context the live
  // review received, at the same time and without seeing the live answer. Read requests go through the shared evidence
  // anchor, so both models see the same data for the same question; write tools answer "not applied" and do nothing.
  // Its calls use their own daily allowance (shadow_usage), never the live budget. The result goes only to routing_eval.
  shadowRun(reviewId,frozen,anchor,detail=null){
    this.shadowing=true;
    const model={openaiModel:this.config.routineModel,reasoningEffort:this.config.routineEffort};const models=require('./ai-models.cjs');
    const noop=name=>async()=>({status:'not-applied',reason:`Shadow run: ${name} changes nothing.`});
    const read=this.discovery?{...(this.discovery.research?{get_company_research:args=>this.discovery.research(args)}:{}),...(this.discovery.marketOverview?{get_market_overview:()=>this.discovery.marketOverview()}:{}),screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:noop('update_watchlist')}:null;
    const desk=frozen.agentDesk?(()=>{const real=this.deskActions(this.watchScope(),frozen,reviewId,()=>{});return {compute:real.compute,save_note:noop('save_note'),save_assessment:noop('save_assessment'),set_review_trigger:noop('set_review_trigger'),set_conditional_order:noop('set_conditional_order')};})():null;
    const request=async options=>{options={...options,...model};const reserve=models.reservation(model,frozen,{...options,maxBytes:models.reviewByteLimit(options)});const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM shadow_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
      if(usage.reservedMicro+reserve>this.config.shadowUSDPerDay*1e6)throw new Error('SHADOW_BUDGET_EXHAUSTED');const callId=randomUUID();
      this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO shadow_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify({reviewId,model:model.openaiModel,reasoningEffort:model.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'shadow'}));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      try{const r=await this.decisionWithRetry(frozen,options);require('./ai-accounting.cjs').settle(this.db,'shadow_usage',day,callId,r,'completed');return r;}catch(error){require('./ai-accounting.cjs').settle(this.db,'shadow_usage',day,callId,error,'failed-or-uncertain');throw error;}};
    return require('./research-review.cjs').researchReview({context:frozen,detail,wrap:anchor.wrapper('shadow'),evidence:this.evidence,discovery:frozen.discovery?.enabled?read:null,setInterval:noop('set_review_interval'),setWatch:noop('set_review_watch'),actions:desk,log:()=>{},compact:null,request})
      .then(r=>({model,decision:r.decision,error:null}),e=>({model,decision:null,error:/^[A-Z_]{3,40}$/.test(e.message)?e.message:'SHADOW_FAILED'}))
      .finally(()=>{this.shadowing=false;});
  }
  // Stores the pair once both decisions exist: assessment, both decisions, both tool transcripts with the shared
  // evidence, costs and the automatic triage. Prices are converted to won before comparing sizes.
  recordShadow(review,assessed,shadow,anchor){
    const C=require('./complexity.cjs');const a=assessed.assessment;const frozen=this.replays.context(review.id)??{};
    const cost=kind=>this.db.prepare('SELECT payload FROM ai_calls WHERE day>=?').all(seoulDate(review.timestamp-86400000)).map(r=>JSON.parse(r.payload)).filter(c=>c.reviewId===review.id&&(c.kind??'review')===kind).reduce((x,c)=>({micro:x.micro+(c.accountedMicro??0),inputTokens:x.inputTokens+(c.usage?.inputTokens??0),outputTokens:x.outputTokens+(c.usage?.outputTokens??0),calls:x.calls+1}),{micro:0,inputTokens:0,outputTokens:0,calls:0});
    const brief=d=>d?{action:d.action,symbol:d.symbol||null,quantity:d.quantity||0,explanation:String(d.explanation??'').slice(0,1200),plan:d.plan??null,planVerdicts:d.planVerdicts??[],complexity:d.complexity??null,...(d.withheld?{withheld:{symbol:d.withheld.symbol,quantity:d.withheld.quantity,reason:d.withheld.reason,...(d.withheld.correctionTried?{correctionTried:true}:{})}}:{}),...(d.planCorrected?{planCorrected:d.planCorrected}:{})}:null;
    const symbol=review.decision.symbol||shadow.decision?.symbol;const quote=(frozen.quotes??[]).find(q=>q.symbol===symbol);const fx=C.usdKrw(frozen);
    const priceKRW=quote?.price>0?(/:/.test(symbol)?(fx?quote.price*fx:null):quote.price):null;
    const transcript=anchor.export();
    const row={reviewId:review.id,timestamp:review.timestamp,account:review.account?.key??null,environment:frozen.environment??null,provenance:{broker:{'KIS live':'live','KIS mock':'mock','Paper':'paper'}[review.account?.label]??'unknown',accountLabel:review.account?.label??null,connection:this.config.scope==='paper'?'paper':this.live?.getConnection?.()?.snapshot?.environment??'unknown'},routeInputs:assessed.routeInputs??null,calendar:assessed.calendar??null,binding:assessed.binding,trigger:review.trigger,baselineId:assessed.baselineId,
      assessment:{score:a.score,rule:a.rule,groups:a.groups,features:a.features,agent:a.agent,consequence:a.consequence},hardRule:assessed.hardRule,threshold:this.config.complexityThreshold,
      live:{model:review.model??this.config.openaiModel,effort:this.config.reasoningEffort,decision:brief(review.decision),usage:cost('review'),transcript:transcript.live},
      shadow:{model:shadow.model.openaiModel,effort:shadow.model.reasoningEffort,decision:brief(shadow.decision),error:shadow.error,usage:cost('shadow'),transcript:transcript.shadow},
      evidence:transcript.evidence,evidenceGap:require('./evidence-anchor.cjs').evidenceGap(transcript.live,transcript.shadow,{liveDecision:review.decision,shadowDecision:shadow.decision,koreaOpen:C.marketsOf(frozen).some(m=>m.market==='KR'&&m.marketSession?.open)}),triage:shadow.error?'failed':C.triage(review.decision,shadow.decision,{equityKRW:a.consequence.equityKRW,priceKRW}),adjudication:null};
    this.db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(review.id,review.timestamp,row.account,JSON.stringify(row));
    this.log(review.id,'System','Shadow review',shadow.error?`${shadow.model.openaiModel} could not decide (${shadow.error}); nothing changed.`:`${shadow.model.openaiModel}: ${shadow.decision.action}${shadow.decision.symbol?' '+shadow.decision.quantity+' '+shadow.decision.symbol:''} · difference: ${row.triage} · ${transcript.shadow.length} tool calls, ${transcript.shadow.filter(t=>t.reused).length} shared with the live review. Recorded for evaluation only; nothing changed.`);
    return row;
  }
  routingEvalState(){const rows=this.db.prepare('SELECT payload FROM routing_eval ORDER BY timestamp DESC LIMIT 2000').all().map(r=>JSON.parse(r.payload));const by={};for(const r of rows)by[r.triage]=(by[r.triage]??0)+1;const today=seoulDate();
    return {pairs:rows.length,today:rows.filter(r=>seoulDate(r.timestamp)===today).length,byTriage:by,candidates:rows.filter(r=>['action','symbol','size','verdict'].includes(r.triage)).length,shadowMicro:rows.reduce((a,r)=>a+(r.shadow.usage?.micro??0),0),liveMicro:rows.reduce((a,r)=>a+(r.live.usage?.micro??0),0)};}
  // Cheap-model condensation of older research results in a review near its size limit; metered like other AI calls.
  async compactResearch(reviewId,payload){
    const modelConfig={openaiModel:this.config.routineModel,reasoningEffort:this.config.routineEffort};const models=require('./ai-models.cjs');
    const reserve=models.reservation(modelConfig,payload,{maxBytes:400000});const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
    if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
    const callId=randomUUID(),record={reviewId,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'compact'};
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    try{const response=await this.provider.request('compact',{payload,options:modelConfig});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return response;}
    catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}
  }
  // Formula inputs: the latest quotes the app holds and cached daily closes; tools may warm the cache first.
  formulaData(quotes=[]){
    const live=this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):(this.marketQuotes?.()??[]);
    const all=[...quotes,...live];
    return {price:sym=>all.find(q=>q.symbol===sym&&Number.isFinite(q.price))?.price??null,previousClose:sym=>all.find(q=>q.symbol===sym)?.previousClose??null,closes:sym=>this.series?.closes(sym)??null};
  }
  // The price to place an order at, from a freshly read order book (electron/order-pricing.cjs): the best bid for a
  // sale, the best ask for a purchase, held at the agent's bound. Without a usable book it retries every 3 seconds for
  // up to a minute (still(): whether placing is still wanted), then gives up (null) and asks for a review.
  async placementPrice({symbol,side,bound=null,id,still=()=>true}){const P=require('./order-pricing.cjs');const market=/:/.test(symbol)?'US':'KR';let why=null;
    // 21 reads 3 seconds apart: 0, 3, ... 60 seconds.
    for(let attempt=0;;attempt++){let reply=null;try{reply=await this.orderBook?.(symbol);}catch(error){reply={status:'unavailable',reason:error.message};}
      const book=P.usableBook(reply);if(book){const t=P.target({side,book,bound,market});this.log(id,'System','Order priced',`${side} ${symbol} at ${t.price}: ${side==='Sell'?'best bid':'best ask'} ${t.best}${t.atBound?`, held at your bound ${bound}`:''} (book read ${new Date(book.retrievedAt).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST).`);return {...t,book};}
      if(!why){why=reply?.reason??(reply?.status==='available'?'stale or one-sided book':'no order book');this.log(id,'System','Order waits for the order book',`${side} ${symbol}: ${why}. Trying again every 3 seconds for up to a minute.`);}
      if(attempt>=20||!still()){if(still())this.requestReview('Order not placed',`${side} ${symbol} could not be priced for a minute (${why}); decide again.`,symbol);return null;}
      await this.wait(3000);}}
  wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  // The order tracker. Every open app order (not one you took over in KIS, not paused after an unclear reply, not
  // cancelling, regular session, today's) moves to the best bid (a sale) or ask (a purchase) when that is 0.2% or more
  // from its price, held at the agent's bound, with no limit on revisions; it is cancelled when the agent's stop time
  // passes or a cancel condition is met. Every 60 seconds while a market is open, the day's KIS order history (every
  // order, the app's or not) is read and kept.
  async trackOrders(now=Date.now()){const P=require('./order-pricing.cjs');
    for(const [market,engine] of [['KR',this.live],['US',this.usLive]]){if(!engine)continue;const open=this.sessionOpen(market,now);
      if(open&&now-((this.lastHistorySync??={})[market]??0)>=60000){this.lastHistorySync[market]=now;try{await engine.syncHistory();}catch{}}
      if(!open)continue;let orders;try{orders=engine.orders();}catch{continue;}
      for(const o of orders){
        if(!['Accepted','Partially filled'].includes(o.status)||!o.brokerOrderId||o.handsOff||o.trackingStopped||o.cancelRequestedAt||o.session&&!/regular/.test(o.session)||o.day!==engine.day())continue;
        if(engine.busy)break;const t=o.tracking??{},remaining=o.quantity-(o.filled??0);
        const stop=this.restrictionStop(t,now);
        if(stop){try{await engine.revise(o.id,{cancel:true});this.log(o.id,'System','Order cancelled',`${o.side} ${remaining} ${o.symbol}: ${stop}.`);}catch(error){await this.trackFailed(engine,o,error);}continue;}
        let reply=null;try{reply=await this.orderBook?.(o.symbol);}catch{}const book=P.usableBook(reply);if(!book){this.noteTrack(o,'no usable order book; it stays at its price');continue;}
        const target=P.target({side:o.side,book,bound:t.bound??null,market}),current=o.currentPrice??o.limitPrice;
        if(!P.shouldRevise(current,target.price)){if(target.atBound&&current===target.price)this.noteTrack(o,`held at your bound ${t.bound} (${o.side==='Sell'?'best bid':'best ask'} ${target.best})`);continue;}
        try{await engine.revise(o.id,{price:target.price});this.log(o.id,'System','Order revised',`${o.side} ${remaining} ${o.symbol}: ${current} → ${target.price} (${o.side==='Sell'?'best bid':'best ask'} ${target.best}${target.atBound?`, held at your bound ${t.bound}`:''}).`);}
        catch(error){await this.trackFailed(engine,o,error);}}}}
  // A refused revision usually means the order just filled or closed: its status is read now. An unclear reply pauses
  // the order until history shows what happened (electron/live-engine.cjs). Another order being sent just waits.
  async trackFailed(engine,o,error){const code=/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'REVISE_FAILED';if(code==='KIS_ORDER_BUSY')return;
    if(code==='SESSION_CLOSED'||code==='FEATURE_UNAVAILABLE'){this.noteTrack(o,code==='SESSION_CLOSED'?'KIS revises it only in the regular session; it stays at its price':'this session cannot be revised; it stays at its price');return;}
    this.log(o.id,'System','Order not revised',`${o.side} ${o.symbol}: ${code==='ORDER_UNCERTAIN'?'KIS did not confirm the change; the order waits until its history shows what happened':code==='BROKER_REJECTED'?'KIS refused the change (it may have just filled); checking its status':code}.`);
    if(code==='BROKER_REJECTED')try{await engine.reconcile();}catch{}}
  // Notes about a tracked order, each logged at most once every 5 minutes.
  noteTrack(o,text){const key=o.id+'|'+text,now=Date.now();this.trackNotes??=new Map();if(now-(this.trackNotes.get(key)??-Infinity)<300000)return;this.trackNotes.set(key,now);this.log(o.id,'System','Order tracking',`${o.side} ${o.symbol}: ${text}.`);}
  // The agent's execution restrictions for an order (decision.execution), checked before use: a bound within 50% of the
  // price, a stop time within the next 7 days, cancel conditions the formula engine accepts (at most 5). No restriction
  // supplied is not the same as one supplied but invalid: an invalid one withholds the order (it is never dropped and the
  // rest carried out). Returns {bounds: {bound?, cancelAfter?, cancelIf?} or null, invalid: [what failed]}.
  // Review of 8ef1be1, P1: a Sell whose stop time had passed lost the restriction and was submitted at the bid.
  executionBounds(decision,price,id,now=Date.now()){const e=decision?.execution;if(!e)return {bounds:null,invalid:[]};const out={},invalid=[...(e.invalid??[])];
    if(e.bound!=null){if(e.bound>0&&price>0&&Math.abs(e.bound/price-1)<=0.5)out.bound=e.bound;else invalid.push(price>0?`bound ${e.bound} (more than 50% from ${price})`:`bound ${e.bound} (no current price to check it against)`);}
    if(e.cancelAfter){const t=Date.parse(e.cancelAfter);if(t>now&&t<=now+7*86400000)out.cancelAfter=new Date(t).toISOString();else invalid.push(`cancelAfter ${e.cancelAfter} (${Number.isFinite(t)?t<=now?'already passed':'more than 7 days ahead':'not a time'})`);}
    if(e.cancelIf?.length){try{out.cancelIf=require('./formula.cjs').readConditions(e.cancelIf,5).conditions.map(({ast,...c})=>c);}catch(error){invalid.push(`cancelIf (${error.code??'invalid'})`);}}
    if(invalid.length)this.log(id,'System','Execution withheld · invalid restrictions',`${decision.action} ${decision.symbol}: ${invalid.join('; ')}. No order is placed.`);return {bounds:Object.keys(out).length?out:null,invalid};}
  // Why an order's restrictions stop it now: its stop time passed, or a cancel condition is met. Checked before an order
  // is proposed (after its price is read, which can take a minute) and by the tracker for open orders. quotes: the
  // review's own quotes, preferred to the live ones. strict (before placing): a condition that cannot be evaluated (no
  // price or history for it) stops the order too, since the app could not honour it.
  restrictionStop(t,now=Date.now(),{quotes=[],strict=false}={}){if(!t)return null;if(t.cancelAfter&&Date.parse(t.cancelAfter)<=now)return `its stop time ${t.cancelAfter} passed`;
    if(t.cancelIf?.length){const c=require('./formula.cjs').checkConditions(t.cancelIf,'any',this.formulaData(quotes));if(c.met)return 'a cancel condition was met: '+c.results.filter(r=>r.met).map(r=>`${r.expr} ${r.op} ${r.value} (now ${r.actual})`).join(', ');
      const unknown=c.results.filter(r=>r.error);if(strict&&unknown.length)return 'a cancel condition cannot be checked now: '+unknown.map(r=>`${r.expr} (${r.error})`).join(', ');}return null;}
  // A review the app asks for itself (an order that could not be priced); it starts when nothing else runs.
  // At most one per symbol every 15 minutes, so a book that stays unreadable cannot start a review a minute.
  requestReview(trigger,reason,symbol=null){const now=Date.now();this.requested??=new Map();if(symbol&&now-(this.requested.get(symbol)??-Infinity)<15*60000)return false;if(symbol)this.requested.set(symbol,now);this.reviewRequested={trigger,reason,at:now};return true;}
  // An open app order as the agents see it: its price now and how it got there, its bounds, and whether the app still
  // moves it (not when you took it over in KIS, or while it is paused after an unclear reply).
  openOrderView(o){const tracked=this.config.orderTracking!==false&&!o.handsOff&&!o.trackingStopped&&!o.cancelRequestedAt;
    return {symbol:o.symbol,side:o.side,quantity:o.quantity,filled:o.filled??0,status:o.status,...(o.limitPrice!=null?{placedAt:o.limitPrice,price:o.currentPrice??o.limitPrice}:{}),revisions:(o.revisions??[]).filter(r=>!r.cancel).length,
      ...(o.tracking?{bounds:o.tracking}:{}),tracked,...(o.handsOff?{takenOverByUser:true}:{}),...(o.trackingStopped?{paused:o.trackingStopped.reason}:{}),...(o.cancelRequestedAt?{cancelling:true}:{})};}
  // One-off events (a level reached or crossed, an agent trigger met, a filing, an order update) whose review made no decision are put
  // back, so a review that never decided does not use them up (electron/size-retry.cjs eventItems). They are held
  // (heldEvents) without rebuilding a review, then fire again. The selective alerts' own record is touched only when
  // they are the rule in force ('on'); in 'observe' it stays independent.
  restoreEvents(scope,evidence){for(const e of require('./size-retry.cjs').eventItems(evidence)){try{
    if(e.type==='agent')this.desk.reopenTrigger(scope,e.id);else if(e.type==='news')this.newsEvents.unmark([e.id]);
    else if(e.type==='order'){const o=this.orderTaken?.get(e.id);if(o){this.orderQueue??={scope:this.config.scope,orders:new Map()};if(!this.orderQueue.orders.has(e.id))this.orderQueue.orders.set(e.id,o);}}else{this.watches.unfire(scope,e.symbol,e.revision);if(e.revision&&this.config.watchlistAlerts==='on')this.watchAlerts.restore(e.revision);}}catch{}}}
  // Events held in this scope: those a size failure already had, until it clears, and those kept after any other
  // failure, until their retry time (EVENT_RETRY_MS).
  heldEvents(scope,now=Date.now()){const f=this.failedInput,h=this.eventHold;return new Set([...(f?.scope===scope?f.eventKeys??[]:[]),...(h?.scope===scope&&now<h.until?h.keys:[])]);}
  // The installed app version (a size failure is tried again after an update).
  appVersion(){try{return require('../package.json').version;}catch{return null;}}
  // Whether a market's session was open in a review's context.
  marketOpenIn(context){return market=>context.environment==='kis-combined'?context.markets?.find(row=>row.market===market)?.marketSession?.open===true:context.marketSession?.open!==false;}
  // Company research for a live review, held back by an open wait on its symbol (electron/waits.cjs): answered with the
  // wait while the review gate is on, logged as what would be held while it observes. Your own requests, emergencies
  // and anything the gate saw change about the symbol read as usual.
  // Each reply's sections are noted for the review (waits.outcomes), so a wait can hold exactly what was unavailable. A
  // request with some sections held reads the others and says which were skipped and why.
  researchFor({watchScope,trigger,emergency,gate,gateMode,id}){const note=(args,r)=>{try{const seen=(this.researchSeen??=new Map());if(!seen.has(id))seen.set(id,[]);seen.get(id).push(...require('./waits.cjs').outcomes(args,r));}catch{}return r;};
    return async args=>{
    // Without a gate result (it failed) nothing could override a wait, so nothing is held.
    const held=gateMode!=='off'&&gate&&!emergency&&!['User request','Emergency loss response'].includes(trigger)?this.waits.guard(watchScope,args?.symbol,{sections:args?.sections,overridden:new Set(gate?.changedSymbols??[]),isOpen:m=>this.sessionOpen(m)}):null;
    if(held){const what=held.reason==='market_closed'?`market closed until it opens`:held.held.map(h=>`${h.section} (${h.unavailable}) until ${h.until}`).join(', ');
      if(gateMode==='on'){this.log(id,'System','Research waits',`${held.symbol}: ${what}${held.status==='partial'?`; reading ${held.read.join(', ')}`:''}.`);if(held.status!=='partial')return held;
        const r=note(args,await this.discovery.research({...args,sections:held.read}));return r&&typeof r==='object'?{...r,skippedSections:held.held.map(({section,unavailable,until})=>({section,unavailable,until})),skippedNote:held.note}:r;}
      this.log(id,'System','Research would wait',`${held.symbol}: ${what}; the review gate is observing, so it is read.`);}
    return note(args,await this.discovery.research(args));};}
  // The review gate for the settings page: its mode and what it found over the last 7 days.
  reviewGateState(){let summary=null;try{summary=this.reviewGate.summary(Date.now()-7*86400000);}catch{}return {mode:this.config.reviewGate??'off',summary};}
  // The selective alert rules for the settings page: thresholds and what observation found over the last 7 days.
  watchlistAlertsState(){const T=this.config.eventTolerancePct;let summary=null;try{summary=this.alertObservations.summary(Date.now()-7*86400000);}catch{}
    return {mode:this.config.watchlistAlerts,holdingPct:T,watchlistPct:this.config.watchlistMovePct??2*T,summary};}
  // How each watchlist symbol is monitored under the rule in force: a holding, an entry level the AI set, or watching.
  monitoring(){const scope=this.watchScope();if(!scope)return null;const held=new Set(heldSymbols(this.brokerPositions()));const watches=this.watches.list(scope);
    const T=this.config.eventTolerancePct,mode=this.config.watchlistAlerts,W=mode==='on'?this.config.watchlistMovePct??2*T:T;
    return {mode,holdingPct:T,watchlistPct:W,symbols:Object.fromEntries((this.discovery?.list?.()??[]).map(e=>{const w=watches.find(x=>x.symbol===e.symbol);
      return [e.symbol,held.has(e.symbol)?{kind:'holding',pct:w?.percent??T}:w?.price!=null&&!w.priceFired?{kind:'entry-level',price:w.price,direction:w.direction}:{kind:'watching',pct:w?.percent??W}];}))};}
  // The price review to start, if any: the one rule for every quoted symbol (watchlistAlerts 'off'), or the selective
  // rules of electron/watch-alerts.cjs ('on'). 'observe' keeps the one rule and logs what the selective rules would do:
  // both read the watches as they were before this check, and the selective rules keep their own record of fired
  // levels, so the rule in force marking a level fired does not hide it from them.
  // skipLevels: level events held while a size failure stands (electron/size-retry.cjs); they apply to the rule in force
  // only, so observation records what its rules would do whatever happened to live reviews.
  priceTrigger(scope,quotes,now=Date.now(),{skipLevels=new Set()}={}){
    const mode=this.config.watchlistAlerts??'off';const watches=this.watches.list(scope);const current=mode==='on'?null:this.watches.detect(scope,quotes,this.lastPrices,this.config.eventTolerancePct,now,skipLevels);
    if(current?.kind==='price')this.watches.fired(scope,current.symbol);if(mode==='off')return current;
    const fresh=quotes.filter(q=>{const t=q.timestamp??q.retrievedAt;return !q.stale&&q.price>0&&Number.isFinite(t)&&t<=now+1000&&now-t<=90000&&this.sessionOpen(/:/.test(q.symbol)?'US':'KR',now);}).map(q=>({...q,timestamp:q.timestamp??q.retrievedAt}));
    const held=new Set(heldSymbols(this.brokerPositions()));const tolerance=this.config.eventTolerancePct;
    const {trigger,deliver}=this.watchAlerts.check({quotes:fresh,held,baselines:this.lastPrices,watches,tolerance,wide:this.config.watchlistMovePct??2*tolerance,now,ownFired:mode==='observe',skipLevels:mode==='on'?skipLevels:new Set()});
    if(mode==='observe'){deliver();try{this.alertObservations.record(now,{current,proposed:trigger,held});}catch{}return current;}
    for(const symbol of deliver())this.watches.fired(scope,symbol);return trigger;}
  // Today's change of each holding whose market has a session open and whose quote is fresh: [{symbol, changePct}].
  // Korean quotes carry it; U.S. ones are measured against the previous close, from the quote or the daily closes.
  heldMoves(context){const quotes=context.quotes??[];const data=this.formulaData(quotes);
    return heldSymbols(context.positions).flatMap(symbol=>{const us=/:/.test(symbol);const q=quotes.find(x=>x.symbol===symbol);if(!(q?.price>0)||q.stale||!this.sessionOpen(us?'US':'KR'))return [];
      let pct=Number.isFinite(q.changePct)?q.changePct:null;
      if(pct==null){const today=new Intl.DateTimeFormat('en-CA',{timeZone:us?'America/New_York':'Asia/Seoul'}).format(new Date());const prev=data.previousClose(symbol)??(data.closes(symbol)??[]).filter(c=>c.date<today).at(-1)?.close;if(prev>0)pct=(q.price/prev-1)*100;}
      return Number.isFinite(pct)?[{symbol,changePct:Math.round(pct*100)/100}]:[];});}
  // Carried scout targets that newer evidence contradicts (scout.staleCarried), from this account's recent trading
  // reviews, the latest prices and the daily closes.
  staleCarried(targets,quotes=[]){if(!targets?.some(t=>t.carriedFrom))return [];const data=this.formulaData(quotes);const key=this.accountTag()?.key;
    const reviews=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 80').all().map(r=>JSON.parse(r.payload)).filter(r=>r.scope===this.config.scope&&r.account?.key===key);
    return require('./scout.cjs').staleCarried(targets,{reviews,price:data.price,movePct:2*(this.config.eventTolerancePct??3)});}
  // Each target the scout wrote in this run keeps the price it was written at, the baseline for a later move; carried
  // targets keep theirs.
  priceTargets(plan,now=Date.now()){const data=this.formulaData();return {...plan,targets:plan.targets.map(t=>{if(t.carriedFrom)return t;const p=data.price(t.symbol);return p>0?{...t,priceWhenSet:p,priceWhenSetAt:now}:t;})};}
  async warmSeries(symbols){for(const sym of symbols.slice(0,6))try{await this.series?.ensure(sym);}catch{}}
  // The desk tools a review may call; every write checks that the account and settings are unchanged.
  deskActions(scope,context,reviewId,guard){
    const universe=(context.universe??[]).map(r=>r.symbol);const formula=require('./formula.cjs');
    return {
      compute:async args=>{
        const list=Array.isArray(args?.formulas)?args.formulas.slice(0,5):[];if(!list.length)return {status:'rejected',reason:'Give 1 to 5 formulas.'};
        const parsed=list.map(f=>{try{return {name:String(f.name??'').slice(0,40)||'value',expr:f.expr,...formula.parse(f.expr)};}catch(e){return {name:f.name,expr:f.expr,error:e.code+(e.detail?`: ${e.detail}`:'')};}});
        const symbols=[...new Set(parsed.flatMap(p=>p.symbols??[]))];if(symbols.length>6)return {status:'rejected',reason:'At most 6 symbols per call.'};
        await this.warmSeries(symbols);const data=this.formulaData(context.quotes??[]);
        return {status:'ok',results:parsed.map(p=>{if(p.error)return {name:p.name,error:p.error};try{const v=formula.evaluate(p.ast,data);return {name:p.name,value:Math.round(v*1e6)/1e6};}catch(e){return {name:p.name,error:e.code+(e.detail?`: ${e.detail}`:'')};}}),note:'Daily functions use completed daily closes; price() is the latest quote.'};
      },
      set_review_trigger:async args=>{guard();const reply=this.desk.setTrigger(scope,args,{universe,reviewId});if(reply.status==='saved')void this.warmSeries(reply.symbols);if(reply.status==='saved'){const check=formula.checkConditions(this.desk.triggers(scope).find(t=>t.id===reply.id).conditions,args.combine,this.formulaData(context.quotes??[]));reply.currentValues=check.results.map(r=>({expr:r.expr,actual:r.actual,met:r.met,...(r.error?{error:r.error}:{})}));}return reply;},
      save_assessment:async args=>{guard();return this.assessments.save(scope,args,{context,reviewId,symbols:[...new Set([...Object.keys(context.positions??{}),...(context.universe??[]).map(r=>r.symbol)])]});},
      save_note:async args=>{guard();return this.desk.saveNote(scope,args,{orderIds:this.engineOrders().filter(o=>o.symbol===String(args?.symbol??'').trim().toUpperCase()&&require('./note-staleness.cjs').OPEN.includes(o.status)).map(o=>o.id)});},
      set_conditional_order:async args=>{guard();if(args?.action!=='cancel'&&context.environment==='local-paper')return {status:'rejected',reason:'Conditional orders need a KIS account.'};const reply=this.desk.setOrder(scope,args,{config:this.config,universe,quotes:context.quotes??[],reviewId});if(reply.status==='armed'){await this.warmSeries(this.desk.orders(scope).find(o=>o.id===reply.id).symbols);const o=this.desk.orders(scope).find(x=>x.id===reply.id);const check=formula.checkConditions(o.conditions,o.combine,this.formulaData(context.quotes??[]));reply.currentValues=check.results.map(r=>({expr:r.expr,actual:r.actual,met:r.met,...(r.error?{error:r.error}:{})}));if(check.met)reply.warning='The conditions are already met; it will fire on the next check while auto trading is on and the market is open.';}return reply;},
    };
  }
  // Conditional orders fire one at a time: fresh account read, conditions re-checked, then every guardrail before the normal proposal path.
  async fireConditional(order){
    const scope=this.watchScope();if(order.scope!==scope)return;const note=(status,outcome,extra={})=>{const saved=this.desk.update(order,{status,outcome,closedAt:Date.now(),...extra});this.log(order.id,'System','Conditional order · '+status,`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): ${outcome}`);
      if(status==='rejected'&&order.side==='Sell'&&order.purpose==='stop_loss')try{this.notify?.('stop-rejected-'+order.id,`Stop loss for ${order.symbol} was rejected: ${outcome} The position is not protected until a new one is armed.`);}catch{}return saved;};
    const us=/:/.test(order.symbol);const engine=us?this.usLive:this.live;if(!engine)return note('rejected','No account for this market.');
    const BUSY='another order in progress';const busy=()=>{if(order.waiting!==BUSY)this.log(order.id,'System','Conditional order · waiting',`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): another order for this market is being sent; checking again in 10 seconds.`);this.desk.update(order,{status:'armed',waiting:BUSY,nextCheckAt:Date.now()+10000});};
    this.desk.update(order,{status:'firing',firingAt:Date.now()});
    try{
      const ctx=await engine.context(us?await this.refreshUS():null);
      if(!ctx.marketSession?.open){this.desk.update(order,{status:'armed',waiting:'market closed',nextCheckAt:Date.now()+300000});return;}
      const quote=ctx.quotes.find(q=>q.symbol===order.symbol);if(!(quote?.price>0)){this.desk.update(order,{status:'armed',waiting:'no fresh quote',nextCheckAt:Date.now()+60000});return;}
      const formula=require('./formula.cjs');const base=this.formulaData(ctx.quotes);const check=formula.checkConditions(order.conditions,order.combine,{...base,price:sym=>ctx.quotes.find(q=>q.symbol===sym)?.price??base.price(sym)});
      if(!check.met){this.desk.update(order,{status:'armed',waiting:null,lastCheck:check.results,nextCheckAt:Date.now()+60000});return;}
      // Priced from a fresh order book with limitPrice as the bound (a sale's floor, a purchase's cap); without a book for a
      // minute the order stays armed and a review is asked for.
      const placement=await this.placementPrice({symbol:order.symbol,side:order.side,bound:order.limitPrice??null,id:order.id,still:()=>this.watchScope()===scope});
      if(!placement){this.desk.update(order,{status:'armed',waiting:'no order book',nextCheckAt:Date.now()+60000});return;}const limit=placement.price;
      const drift=Math.abs(limit/quote.price-1)*100;if(drift>this.config.conditionalMaxSlippagePct)return note('rejected',`Limit ${limit} is ${drift.toFixed(2)}% from the price ${quote.price}, above the ${this.config.conditionalMaxSlippagePct}% limit.`,{results:check.results});
      // Another order for this market is being sent (the engine sends one at a time): the order stays armed and is checked
      // again shortly, with its conditions re-read. Checked before proposing, so no proposal is left behind.
      if(engine.busy)return busy();
      let quantity=order.quantity;
      if(order.side==='Sell'){const held=ctx.positions?.[order.symbol]?.quantity??0;if(held<1)return note('rejected','No shares held to sell.',{results:check.results});quantity=Math.min(quantity,held);}
      const notional=quantity*limit;
      if(order.side==='Buy'){
        const cap=ctx.equity*this.config.conditionalMaxOrderPct/100;if(!(notional<=cap))return note('rejected',`Order value ${Math.round(notional)} is above ${this.config.conditionalMaxOrderPct}% of equity (${Math.round(cap)}).`,{results:check.results});
        if(!(ctx.cash>=notional*1.005))return note('rejected','Not enough cash for the order and fees.',{results:check.results});
        const emergency=this.emergencyState();if((emergency.activeMarkets??(emergency.active?[market]:[])).includes(market)&&this.config.lossAction!=='review')return note('rejected','New buys are blocked after the daily loss limit.',{results:check.results});
      }
      const proposal=engine.propose({symbol:order.symbol,side:order.side,quantity,limitPrice:limit});if(order.limitPrice>0)engine.annotate?.(proposal.id,{tracking:{bound:order.limitPrice}});
      const cap=this.config.maxAutoOrdersPerDay;const capReached=cap>0&&this.guardrails.autoOrdersToday()>=cap;
      const auto=this.config.conditionalAutoSubmit&&this.config.autoSubmit&&engine.autoEnabled!==false&&proposal.status==='Ready'&&!proposal.requiresApproval&&!capReached;
      if(auto){const placed=await engine.autoSubmit(proposal.id);return note('submitted',`Submitted at ${limit} for ${quantity} shares.`,{proposalId:proposal.id,orderId:placed?.id??null,results:check.results});}
      return note('proposed',capReached?`Daily automatic order limit reached; proposal ${proposal.id} awaits approval.`:`Proposal at ${limit} for ${quantity} shares awaits approval.`,{proposalId:proposal.id,results:check.results});
    }catch(error){const code=/^[A-Z_]{3,40}$/.test(error?.code??error?.message??'')?(error.code??error.message):'ORDER_FAILED';if(code==='KIS_ORDER_BUSY')return busy();return note('rejected',`The broker or a risk check refused it (${code}).`);}
  }
  deskState(){const scope=this.watchScope();return {monitoringActive:this.conditionalMonitoringActive(),triggers:this.desk.triggers(scope),notes:this.desk.notes(scope),orders:this.desk.orders(scope),recentOrders:this.desk.recentOrders(scope,10),unprotected:this.desk.unprotected(scope,this.brokerPositions()),firedTriggers:this.desk.rows('agent_triggers',scope,'fired').slice(0,5)};}
  // A Buy's plan becomes a note on the symbol, and a stop-loss order when conditional orders are allowed.
  followPlan(scope,decision,reviewId){
    const p=decision.plan;const day=seoulDate();
    const text=`Plan from ${day}: ${p.thesis} Invalid if: ${p.invalidation}. Stop ${p.stopPrice}${p.targetPrice?`, target ${p.targetPrice}`:''}, horizon ${p.horizonDays} days, confidence ${p.confidence}.`;
    const note=this.desk.saveNote(scope,{action:'set',symbol:decision.symbol,note:text,expiresInDays:Math.min(90,Math.max(1,p.horizonDays))});this.log(reviewId,'Tool','Trade plan saved',JSON.stringify(note));
    if(this.config.conditionalOrders&&p.stopPrice){const stop=this.desk.setOrder(scope,{action:'add',id:'',symbol:decision.symbol,side:'Sell',quantity:decision.quantity,limitPrice:null,conditions:[{expr:`price("${decision.symbol}")`,op:'<=',value:p.stopPrice}],combine:'all',purpose:'stop_loss',expiresInHours:this.config.conditionalMaxHours,reason:`Stop from the trade plan of ${day}: ${p.invalidation}`.slice(0,300)},{config:this.config,reviewId});this.log(reviewId,'Tool','Stop-loss armed from the plan',JSON.stringify(stop));}
  }
  // Upcoming events from cached research, the macro calendar and computed options expiries.
  calendarState(days=21,extra=[]){try{const p=this.portfolioHoldings?.();const symbols=[...new Map([...(p?.holdings??[]).map(h=>[h.symbol,{symbol:h.symbol,name:h.name}]),...(this.discovery?.list?.()??[]).map(w=>[w.symbol,{symbol:w.symbol,name:w.name}]),...(this.calendarSymbols?.()??[]).map(e=>[e.symbol,e]),...extra.map(e=>[e.symbol,e])]).values()].slice(0,60);
    return require('./event-calendar.cjs').build({today:seoulDate(),days,macroCalendar:this.macro?.get?.()?.calendar??[],symbols,sources:sym=>this.calendarSource?.(sym)});}catch{return [];}}
  // Exposure, sizing and regime, computed locally from holdings, cached history and stress signals.
  riskContext(context){
    const pr=require('./portfolio-risk.cjs');const insights=require('./kis-insights.cjs');const ind=require('./indicators.cjs');const out={};
    try{
      const closes=this.indexCloses?.()??{};const daily=sym=>this.series?.closes(sym)??[];const beta=sym=>{const index=/:/.test(sym)?closes.SPX:closes.KOSPI;const m=insights.riskMetrics(daily(sym),index??[],[]);return m?.market?.beta??null;};
      const p=this.portfolioHoldings?.();
      if(p?.holdings?.length)out.portfolioExposure=pr.exposure(p.holdings,{daily,sector:sym=>this.sectorOf?.(sym)??null,beta,cashKRW:p.cashKRW});
      const fx=this.fx?.()?.usdKRW??null;const equity=p?.equityKRW??(context.environment==='kis'?context.equity:null);
      const rows=(context.universe??[]).map(u=>{const q=context.quotes?.find(r=>r.symbol===u.symbol);const c=daily(u.symbol);const atr=ind.atr(c,14);const us=/:/.test(u.symbol);const usMarket=(context.markets??[]).find(m=>m.market==='US');const cashKRW=us?(fx?((usMarket?.buyingPower?.usd??context.cash?.USD??(context.environment==='kis'&&context.currency==='USD'?context.cash:null))??NaN)*fx:NaN):(typeof context.cash==='object'?context.cash?.KRW:context.currency==='KRW'?context.cash:NaN);return {symbol:u.symbol,price:q?.price??c.at(-1)?.close,atr,fx:us?fx:1,cashKRW:Number.isFinite(cashKRW)?cashKRW:undefined};}).filter(r=>r.atr&&r.price&&r.fx);
      const sizing=pr.sizing({equityKRW:equity,riskPct:this.config.sizingRiskPct,atrMultiple:this.config.sizingAtrMultiple,rows});if(sizing?.rows.length)out.positionSizing=sizing;
      const g=this.regimeState();if(g)out.marketRegime={regime:g.regime,score:g.score,components:g.components.map(({name,value,reading,asOf,stale,note})=>({name,value,reading,...(asOf?{asOf}:{}),...(stale?{stale:true}:{}),...(note?{note}:{})}))};
    }catch{}
    return out;
  }
  exposureState(){try{const p=this.portfolioHoldings?.();if(!p?.holdings?.length)return null;const pr=require('./portfolio-risk.cjs');const closes=this.indexCloses?.()??{};const daily=sym=>this.series?.closes(sym)??[];const insights=require('./kis-insights.cjs');return pr.exposure(p.holdings,{daily,sector:sym=>this.sectorOf?.(sym)??null,beta:sym=>insights.riskMetrics(daily(sym),(/:/.test(sym)?closes.SPX:closes.KOSPI)??[],[])?.market?.beta??null,cashKRW:p.cashKRW});}catch{return null;}}
  regimeState(){
    const pr=require('./portfolio-risk.cjs');const closes=this.indexCloses?.()??{};const macro=this.macro?.get?.()??null;const cached=this.marketOverviewCache?.()??null;const market=cached?.value??null;
    const breadth=market?require('./market-freshness.cjs').breadthFreshness(cached.at,Date.now(),{closedDays:new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])])}):null;
    const ch=(c,k)=>c&&c.length>k?(c.at(-1).close/c.at(-1-k).close-1)*100:null;const series=id=>macro?.series?.find(s=>s.id===id);
    const kospi=closes.KOSPI??[];const sma50=kospi.length>=50?kospi.slice(-50).reduce((a,b)=>a+b.close,0)/50:null;const oil=series('US_WTI');const hy=series('US_HY_SPREAD');
    const oilHist=oil?.history??[];
    return pr.regime({vix:closes.VIX?.at(-1)?.close??series('US_VIX')?.value??null,vix5dChangePct:ch(closes.VIX,5),hySpread:hy?.value??null,hySpreadChange:hy?.change??null,advanceRatioPct:market?.breadth?.find(b=>b.index==='KOSPI')?.advanceRatioPct??null,kospiVs50dPct:sma50?(kospi.at(-1).close/sma50-1)*100:null,sox20dPct:ch(closes.SOX,20),oil20dPct:oilHist.length>=2?(oilHist.at(-1).value/oilHist[0].value-1)*100:null,breadth});
  }
  // Replays saved reviews with a change next to an unchanged baseline; no tools, no orders. Each call is metered.
  async replay(options={}){
    if(this.replaying)throw new Error('REPLAY_BUSY');const blocked=this.narrativeAvailable();if(blocked)throw new Error('REPLAY_UNAVAILABLE');
    const R=require('./replay.cjs');const instructions=typeof options.instructions==='string'?options.instructions.trim().slice(0,R.LIMITS.instructions):'';
    const models=require('./ai-models.cjs');const modelConfig={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort};
    // A model change: the variant runs on another model and effort, the baseline on the configured one.
    let model=null;if(options.model&&typeof options.model==='object'){const m={openaiModel:String(options.model.openaiModel??''),reasoningEffort:String(options.model.reasoningEffort??'')};try{models.settings(m);}catch{throw new Error('INVALID_MODEL_SETTINGS');}if(m.openaiModel!==modelConfig.openaiModel||m.reasoningEffort!==modelConfig.reasoningEffort)model=m;}
    const variant={instructions,withoutNarrative:options.withoutNarrative===true,withoutEpisodes:options.withoutEpisodes===true,withoutRegime:options.withoutRegime===true,...(model?{model}:{})};
    if(!variant.instructions&&!variant.withoutNarrative&&!variant.withoutEpisodes&&!variant.withoutRegime&&!variant.model)throw new Error('REPLAY_NO_CHANGE');
    const limit=Math.max(1,Math.min(R.LIMITS.reviews,Number(options.limit)||6));const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;
    const reviews=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 400').all().map(r=>JSON.parse(r.payload));
    const picks=R.candidates({reviews,store:this.replays,events:this.loggedEvents?.()??[],from:day(options.from),to:day(options.to),limit});if(!picks.length)throw new Error('REPLAY_NOTHING');
    this.replaying=true;const id=R.newId();
    const decide=async(context,config=modelConfig)=>{const reserve=models.reservation(config,context,{});const d=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(d)??{calls:0,reservedMicro:0};if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
      const callId=require('node:crypto').randomUUID();this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(d,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,d,JSON.stringify({reviewId:id,model:config.openaiModel,reasoningEffort:config.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'replay'}));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      try{const r=await this.provider.request('decision',{context,options:{...config,research:false}});require('./ai-accounting.cjs').settle(this.db,'ai_usage',d,callId,r,'completed');const row=this.db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(callId);const cost=row?JSON.parse(row.payload).accountedMicro??null:null;return {...r.decision,_usage:{model:config.openaiModel,effort:config.reasoningEffort,inputTokens:r.usage?.inputTokens??null,outputTokens:r.usage?.outputTokens??null,costMicro:cost}};}catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',d,callId,error,'failed-or-uncertain');throw error;}};
    this.log(id,'Program','Replay',`Replaying ${picks.length} saved review${picks.length===1?'':'s'} with a change: ${[instructions&&'extra instructions',variant.withoutNarrative&&'without the narrative',variant.withoutEpisodes&&'without episodes',variant.withoutRegime&&'without the regime gauge and sizing',variant.model&&`on ${variant.model.openaiModel} (${variant.model.reasoningEffort} effort) instead of ${modelConfig.openaiModel} (${modelConfig.reasoningEffort})`].filter(Boolean).join(', ')}. No orders are placed.`);
    try{
      const closes=this.indexCloses?.()??{};const rows=[];
      for(const pick of picks){
        const baseline=await decide(pick.context);const changed=await decide(R.applyVariant(pick.context,variant),variant.model??modelConfig);
        for(const d of [baseline,changed])if(d?.symbol)await this.warmSeries([d.symbol]);
        const score=d=>R.outcome(d,pick.day,d?.symbol?this.series?.closes(d.symbol):null,/:/.test(d?.symbol??'')?closes.SPX:closes.KOSPI);
        rows.push({reviewId:pick.review.id,day:pick.day,approximate:pick.approximate,original:R.brief(pick.review.decision),baseline:{decision:R.brief(baseline),explanation:baseline?.explanation?.slice(0,1200)??null,verdicts:baseline?.planVerdicts??[],usage:baseline?._usage??null,outcome:score(baseline)},variant:{decision:R.brief(changed),explanation:changed?.explanation?.slice(0,1200)??null,verdicts:changed?.planVerdicts??[],usage:changed?._usage??null,outcome:score(changed)},changed:JSON.stringify(R.brief(baseline))!==JSON.stringify(R.brief(changed))});
      }
      const run=this.replays.saveRun({id,timestamp:Date.now(),variant,rows,summary:R.summarize(rows)});this.log(id,'System','Replay finished',JSON.stringify(run.summary));return run;
    }catch(error){this.log(id,'System','Replay failed',/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REPLAY_FAILED');throw error;}
    finally{this.replaying=false;}
  }
  // Market narrative and similar past episodes, as the agents read them.
  storyContext(){const n=require('./narrative.cjs');const latest=this.narratives.latest();const view=n.agentView(latest);if(!view)return {};const vix=this.indexCloses?.()?.VIX?.at(-1)?.close??null;return {marketNarrative:view,similarEpisodes:this.episodes.similar(latest,{vix})};}
  narrativeAvailable(){if(this.config.provider!=='openai')return 'Choose OpenAI as the decision maker';if(!this.providerStatus.aiConnected)return 'Add an OpenAI key in Connections';return null;}
  // Builds the narrative from recent headlines and numeric signals; metered like any other AI call.
  async buildNarrative(trigger='User request'){
    if(this.narrating)throw new Error('NARRATIVE_BUSY');const blocked=this.narrativeAvailable();if(blocked){this.narrativeError=blocked;throw new Error('NARRATIVE_UNAVAILABLE');}
    this.narrating=true;const id=require('node:crypto').randomUUID();const n=require('./narrative.cjs');
    try{
      const closes=this.indexCloses?.()??{};const labels=Object.fromEntries(Object.entries(require('./performance.cjs').INDEXES).map(([k,v])=>[k,v.label]));
      const signalList=n.signals({indexCloses:closes,labels,macro:this.macro?.get?.()??null,market:this.marketOverviewCache?.()??null});
      const stories=this.topStories();const storyItems=stories.flatMap((s,k)=>s.headlines.map(h=>({title:h.title,source:h.source,published:h.published,symbols:s.symbols??[],story:k})));
      const headlineList=n.headlines([...storyItems,...this.newsEvents.list(300),...this.news.map(item=>({...item,symbols:[]}))]);
      const previous=this.narratives.latest();
      const context={today:seoulDate(),signals:signalList,headlines:headlineList.map(({url,...h})=>h),...(stories.length?{topStories:stories.map((s,k)=>({story:k,terms:s.terms,outlets:s.outlets,timesUsual:s.timesUsual,firstSeen:s.firstSeen,latest:s.latest}))}:{}),previousNarrative:previous?{asOf:new Date(previous.timestamp).toISOString(),drivers:previous.drivers.map(({id,kind,title,themes,since})=>({id,kind,title,themes,since}))}:null};
      this.log(id,'Program',trigger==='User request'?'Market narrative':'Market narrative · '+trigger,`Summarizing ${headlineList.length} recent headlines against ${signalList.length} market signals.`);
      const modelConfig={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort==='none'?'low':this.config.reasoningEffort};const models=require('./ai-models.cjs');
      const reserve=models.reservation(modelConfig,context,{maxBytes:120000});const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
      if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
      const callId=require('node:crypto').randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'narrative'};
      this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      let response;try{response=await this.provider.request('narrative',{context,options:modelConfig});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');}catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}
      const narrative=n.validate(response.narrative,{signalIds:signalList.map(x=>x.id),headlineList,previous});
      const saved=this.narratives.save(narrative,{runId:id,trigger,model:response.model??modelConfig.openaiModel,headlines:headlineList.length,signals:signalList.length});
      this.log(id,'Agent','Market narrative',JSON.stringify({regime:saved.regime,summary:saved.summary,drivers:saved.drivers.map(d=>({kind:d.kind,title:d.title,confirmed:d.confirmed,themes:d.themes}))},null,2));
      this.log(id,'System','Review completed',JSON.stringify(response.usage??{}));
      this.detectEpisodes();this.narrativeError=null;return saved;
    }catch(error){this.narrativeError=require('./ai-errors.cjs').publicCode(error)??(/^[A-Z_]{3,40}$/.test(error.message)?error.message:'NARRATIVE_FAILED');this.log(id,'System','Market narrative failed',this.narrativeError);throw error;}
    finally{this.narrating=false;}
  }
  // Episodes from large index moves; the day's narrative and stress readings are attached.
  detectEpisodes(){try{const closes=this.indexCloses?.()??{};if(!Object.keys(closes).length)return [];const closeOn=(index,day)=>(closes[index]??[]).filter(r=>r.day<=day).at(-1)?.close??null;
    return this.episodes.detect(closes,{narrativeAt:day=>this.narratives.at(day),signalsAt:day=>({VIX:closeOn('VIX',day),SOX:closeOn('SOX',day)}),since:new Date(Date.now()-120*86400000).toISOString().slice(0,10)});}catch{return [];}}
  narrativeState(){const latest=this.narratives.latest();return {latest,episodes:this.episodes.list().slice(0,20),similar:latest?this.episodes.similar(latest,{vix:this.indexCloses?.()?.VIX?.at(-1)?.close??null,limit:3,minScore:0.2}):[],busy:Boolean(this.narrating),blocked:this.narrativeAvailable(),error:this.narrativeError??null,enabled:this.config.narrativeEnabled};}
  // AI scout: research the market, update the shortlist and write a portfolio plan. Runs alongside reviews; it never trades.
  scoutAvailable(){
    if(this.config.provider!=='openai')return 'Choose OpenAI as the decision maker';
    if(!this.providerStatus.aiConnected)return 'Add an OpenAI key in Connections';
    if(this.config.scope==='paper')return 'The scout works with KIS accounts';
    if(!this.config.shareKisWithAI)return 'Allow sharing KIS data with OpenAI';
    if(!this.discovery)return 'Connect your KIS account';
    try{(this.config.scope==='us'?this.usLive:this.live)?.identity();}catch{return 'Connect your KIS account';}
    return null;
  }
  // What a trading review may know about briefing the scout; null when the scout cannot run or is not in use.
  scoutBriefState(scope){
    if(this.scoutAvailable())return null;const plan=this.scoutStore.latest(scope);
    if(!this.config.scoutEnabled&&!this.config.scoutAiRequests&&!(plan&&Date.now()-plan.timestamp<=36*3600000))return null;
    const status=this.scoutStore.requests(scope,seoulDate());const open=this.briefs.open(scope);
    return {runAllowed:Boolean(this.config.scoutAiRequests)&&!this.scouting&&!this.pendingScout&&status.remainingToday>0&&!status.nextAllowedAt,...(this.config.scoutAiRequests?{remainingRunsToday:status.remainingToday}:{runRequests:'turned off'}),...(status.nextAllowedAt&&this.config.scoutAiRequests?{nextRunAllowedAt:new Date(status.nextAllowedAt).toISOString()}:{}),...(this.scouting?{running:true}:{}),
      ...(this.config.scoutEnabled?{scheduledRuns:require('./scout.cjs').SCHEDULES[this.config.scoutSchedule].map(([h,m])=>String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+' KST weekdays')}:{}),openBriefs:open.map(b=>({id:b.id,asOf:new Date(b.timestamp).toISOString(),asked:b.asked.slice(0,200)}))};
  }
  // A brief from a trading review: saved for the next scout run, and optionally a request to run after this review.
  briefScout(scope,args,reviewId){
    if(scope!==this.watchScope())return {status:'rejected',reason:'The account changed.'};
    const state=this.scoutBriefState(scope);if(!state)return {status:'rejected',reason:'The scout is not available.'};
    const brief=require('./scout-feedback.cjs').normalizeBrief(args);
    if(!brief)return {status:'rejected',reason:args?.request==='run'?'A short reason is required.':'The brief is empty.'};
    let run='not requested';
    if(brief.request==='run'){
      const status=this.scoutStore.requests(scope,seoulDate());
      run=!this.config.scoutAiRequests?'not started: run requests are turned off':this.scouting||state.running?'not started: a scout run is already in progress':this.pendingScout?'not started: a scout run is already requested':status.remainingToday===0?'not started: the daily limit of requested runs is reached':status.nextAllowedAt?'not started: too soon after the last requested run':!brief.reason?'not started: a reason is required':'scheduled';
    }
    const record=this.briefs.add(scope,brief,{reviewId:reviewId??null});
    if(run==='scheduled'){this.scoutStore.noteRequest(scope,seoulDate());this.pendingScout={scope,reason:brief.reason};}
    return {status:'saved',briefId:record.id,run,note:run==='scheduled'?'A scout run starts after this review ends and will answer this brief.':'The next scout run will answer this brief.'};
  }
  startRequestedScout(){const pending=this.pendingScout;this.pendingScout=null;if(!pending||this.disposed||pending.scope!==this.watchScope()||this.scouting)return;void this.scout('Requested by review · '+pending.reason.slice(0,80)).catch(()=>{});}
  scoutState(){const scope=this.watchScope();const {SCHEDULES,dueSlot}=require('./scout.cjs');return {enabled:this.config.scoutEnabled,schedule:this.config.scoutSchedule,times:(SCHEDULES[this.config.scoutSchedule]??[]).map(([h,m])=>String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')),busy:Boolean(this.scouting),blocked:this.scoutAvailable(),lastError:this.scoutError??null,lastErrorDetail:this.scoutErrorDetail??null,lastSlot:this.scoutStore.lastSlot(scope),dueSlot:dueSlot(this.config.scoutSchedule),latest:this.scoutStore.latest(scope),briefs:this.briefs.open(scope).map(({id,timestamp,request,asked})=>({id,timestamp,request,asked})),scorecard:this.scoutScorecardState(scope)};}
  scoutScorecardState(scope){try{const board=this.scoutScorecard.build(scope,this.briefs.feedback(scope,0));return {summary:board.summary,minSample:board.minSample,picks:board.picks.slice(0,20).map(({symbol,name,role,pickedAt,endedAt,benchmark,horizons,acted,feedback})=>({symbol,name,role,pickedAt,endedAt,benchmark,horizons,acted,feedback}))};}catch{return null;}}
  async scoutAccount(){
    // What each account may buy: cash in its own currency and whether leveraged or inverse products are allowed.
    const products=engine=>{try{const p=engine?.exposure?.policy(engine.identity());return p?{leveragedOrInverseEtps:p.leveragedEtps.enabled?{allowed:true,maxPctOfEquity:p.leveragedEtps.maxPctOfEquity,maxHoldingDays:p.leveragedEtps.maxHoldingDays}:{allowed:false}}:null;}catch{return null;}};
    const pick=(c,engine)=>({market:c.market??'KR',currency:c.currency,equity:c.equity,cash:c.cash,...(c.buyingPower?{buyingPowerUSD:c.buyingPower.usd,integratedMargin:c.buyingPower.integratedMargin}:{}),...(products(engine)?{products:products(engine)}:{}),...((c.market??'KR')==='US'&&!((c.buyingPower?.usd??c.cash)>0)?{note:'No U.S. buying power: U.S. purchases need USD cash, or integrated margin with KRW cash.'}:(c.market??'KR')==='US'&&c.buyingPower?.integratedMargin?{note:'U.S. buys draw on KRW cash through integrated margin; that is the same money as the Korean account cash, so plan both markets from one pool.'}:{}),positions:Object.entries(c.positions??{}).map(([symbol,p])=>{const q=c.quotes?.find(x=>x.symbol===symbol);const value=q?q.price*p.quantity:null;return {symbol,name:c.universe?.find(u=>u.symbol===symbol)?.name??symbol,quantity:p.quantity,value,weightPct:value&&c.equity?Math.round(value/c.equity*1000)/10:null};})});
    if(this.config.scope==='kis')return [pick(await this.live.context(),this.live)];
    if(this.config.scope==='us')return [pick(await this.usLive.context(await this.refreshUS()),this.usLive)];
    // With both markets, a failed U.S. account check leaves the scout researching Korea instead of stopping it.
    const kr=pick(await this.live.context(),this.live);let us;try{us=pick(await this.usLive.context(await this.refreshUS()),this.usLive);}catch(error){us={market:'US',currency:'USD',status:'unavailable',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED'};}return [kr,us];
  }
  async scout(trigger='User request'){
    if(this.scouting)throw new Error('SCOUT_BUSY');const blocked=this.scoutAvailable();if(blocked){this.scoutError=blocked;throw new Error('SCOUT_UNAVAILABLE');}
    this.scouting=true;const id=randomUUID();const scope=this.watchScope();
    try{
      const previous=this.scoutStore.latest(scope);
      const accounts=await this.scoutAccount();
      // Research only markets open or near their open or close; the others keep their previous targets.
      const scoutLib=require('./scout.cjs');const markets=[...new Set(accounts.filter(a=>a.status!=='unavailable').map(a=>a.market))];const focus=scoutLib.researchFocus(markets.length?markets:['KR'],Date.now(),{closedDays:new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]),environment:this.live?.getConnection?.()?.snapshot?.environment??'mock',enabled:this.sessionOptions()});
      const usTradable=accounts.some(a=>a.market==='US'&&a.status!=='unavailable'&&(a.buyingPowerUSD??a.cash)>0);
      const leads=this.sectorLeads?await this.sectorLeads(this.config.scope).catch(()=>null):null;
      const context={today:seoulDate(),userGuidelines:this.config.guidelines||null,researchFocus:focus,accounts,...(leads?{sectorLeads:leads}:{}),opportunitySet:{tradableMarkets:accounts.filter(a=>a.status!=='unavailable').map(a=>a.market),usStocksBuyable:usTradable,fxUSDKRW:this.fx?.()?.usdKRW??null,note:usTradable?'Both Korean and U.S. listings can be bought; compare them on the same footing.':'Only Korean listings can be bought now. Korean-listed ETFs give exposure to foreign indexes (S&P 500, Nasdaq, China, Japan), commodities (gold, oil), bonds and the dollar.'},watchlist:this.discovery.list().filter(({symbol})=>!focus.deferred.includes(scoutLib.marketOf(symbol))).map(({symbol,name,source,reason,pinned})=>({symbol,name,source,reason,pinned})),previousPlan:previous?{asOf:new Date(previous.timestamp).toISOString(),...previous.plan}:null,macro:this.macro?.context()??null,news:this.newsContext(),...(()=>{const stories=this.storiesContext();return stories.length?{topStories:stories}:{};})()};
      // Feedback loop: open briefs from trading reviews, how earlier picks did, and the scout's own notes.
      const briefs=this.briefs.open(scope);if(briefs.length)context.briefs=briefs.map(b=>({id:b.id,asOf:new Date(b.timestamp).toISOString(),...(b.reason?{reason:b.reason}:{}),...(b.lookingFor?{lookingFor:b.lookingFor}:{}),...(b.avoid?{avoid:b.avoid}:{}),...(b.questions?{questions:b.questions}:{}),...(b.feedback?.length?{feedback:b.feedback}:{})}));
      const scorecard=this.scoutScorecard.context(scope,this.briefs.feedback(scope,0));if(scorecard)context.scorecard=scorecard;const lastVerdicts=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 40').all().map(r=>JSON.parse(r.payload)).find(r=>r.scope===this.config.scope&&r.account?.key===this.accountTag()?.key&&r.decision?.planVerdicts?.length&&Date.now()-r.timestamp<36*3600000);if(lastVerdicts)context.tradingVerdicts={asOf:new Date(lastVerdicts.timestamp).toISOString(),verdicts:lastVerdicts.decision.planVerdicts};
      // Open orders are not done: an acted verdict means an order was placed, not that it filled.
      {const open=this.pendingOrders();if(open.length)context.openOrders={orders:open.map(o=>this.openOrderView(o)),note:'These orders are placed but not filled: until they fill, the shares of a Sell are still held and a Buy has bought nothing. An acted trading verdict means an order was placed, not that it filled; positions are the holdings.'};}const deskNotes=this.annotatedNotes(this.desk.notes(scope).slice(0,15)).map(n=>({symbol:n.symbol||null,note:n.note,updated:new Date(n.updatedAt).toISOString(),...(n.accountStateConflict?{accountStateConflict:n.accountStateConflict}:{}),...(n.orderClaimUnverified?{orderClaimUnverified:n.orderClaimUnverified}:{})}));if(deskNotes.length)context.tradingNotes=deskNotes;const story=this.storyContext();if(story.marketNarrative)context.marketNarrative=story.marketNarrative;if(story.similarEpisodes?.length)context.similarEpisodes=story.similarEpisodes;const exposure=this.exposureState();if(exposure)context.portfolioExposure=exposure;const gauge=this.regimeState();if(gauge)context.marketRegime={regime:gauge.regime,score:gauge.score,components:gauge.components.map(({name,value,reading})=>({name,value,reading}))};const notes=this.scoutStore.retrospectives(scope);if(notes.length)context.retrospectives=notes;
      {const deferredTargets=(previous?.plan?.targets??[]).filter(t=>focus.deferred.includes(scoutLib.marketOf(t.symbol))).map(t=>({...t,carriedFrom:t.carriedFrom??new Date(previous.timestamp).toISOString()}));
        const stale=this.staleCarried(deferredTargets);if(stale.length)context.carriedNeedingReassessment=stale;}
      this.log(id,'Program',trigger==='User request'?'Scout run':'Scout run · '+trigger,'Researching the market to update the shortlist and the portfolio plan. The scout does not trade.');
      this.log(id,'Context','Supplied context',loggableContext(context));
      const modelConfig={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort==='none'?'low':this.config.reasoningEffort};
      const request=async({final,continuation})=>{
        const options={final,continuation,...modelConfig,maxBytes:scoutLib.SCOUT_REQUEST_BYTES};const models=require('./ai-models.cjs');
        const reserve=models.reservation(modelConfig,context,options);
        const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
        if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
        const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'scout'};
        this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
        try{const response=await this.provider.request('scout',{context,options:{final,continuation,...modelConfig}});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return response;}
        catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}
      };
      const tools=scoutLib.focusTools(this.discovery,focus,{reassess:(context.carriedNeedingReassessment??[]).map(s=>s.symbol),guard:()=>{if(this.disposed||scope!==this.watchScope())throw new Error('STALE_DECISION');}});
      const result=await scoutLib.runScout({request,tools,overheadBytes:require('./ai-client.cjs').scoutOverheadBytes(),watched:context.watchlist.map(e=>e.symbol),log:(kind,title,body)=>this.log(id,kind,title,body)});
      if(this.disposed||scope!==this.watchScope())throw new Error('STALE_DECISION');
      const answered=this.briefs.answer(scope,result.plan.briefAnswers);const plan=scoutLib.carryForward(this.priceTargets(result.plan),previous,focus.deferred,Date.now(),{reassessed:(context.carriedNeedingReassessment??[]).map(x=>x.symbol)});
      const saved=this.scoutStore.save(scope,plan,{runId:id,trigger,model:result.model??modelConfig.openaiModel,usage:result.usage,research:result.metrics??null,rounds:result.rounds,answered});this.scoutScorecard.record(scope,result.plan,saved.timestamp);
      this.log(id,'Agent','Scout plan',JSON.stringify(plan,null,2));this.log(id,'System','Review completed',JSON.stringify(result.usage));if(result.metrics)this.log(id,'System','Research metrics',JSON.stringify(result.metrics));
      this.scoutError=null;return saved;
    }catch(error){this.scoutError=require('./ai-errors.cjs').publicCode(error)??(/^[A-Z_]{3,40}$/.test(error.message)?error.message:'SCOUT_FAILED');this.scoutErrorDetail=typeof error.detail==='string'?error.detail:null;this.log(id,'System','Scout failed',this.scoutError+(this.scoutErrorDetail?' · '+this.scoutErrorDetail:''));if(error?.metrics)this.log(id,'System','Research metrics',JSON.stringify(error.metrics));throw error;}
    finally{this.scouting=false;}
  }
  syncLearning(){try{this.outcomes.sync();this.memory.sync();this.reflections.sync();this.trials.observe(this.paper.getState().quotes,'paper');
      for(const [engine,quotes] of [[this.live,this.marketQuotes?.()??[]],[this.usLive,this.usQuotes??[]]]){if(engine){try{this.trials.observe(quotes,'broker',engine.identity());}catch(error){if(!['KIS_NOT_CONNECTED','ACCOUNT_CHANGED'].includes(error.message))throw error;}}}this.learningLastRun=Date.now();this.learningError=null;}catch{this.learningError='LOCAL_EVALUATION_FAILED';}}
  tick() {
    this.restoreClock();
    if(!this.learningLastRun||Date.now()-this.learningLastRun>=15000)this.syncLearning();
    if(!this.busy&&!this.learningError)void this.reflections.tick(this.config,this.providerStatus.aiConnected,this.provider,this.log).catch(()=>{this.reflections.reason='Local reflection error';});
    const emergency=this.emergencyState();
    this.observeEmergency(emergency);
    if(emergency.active&&this.config.lossAction==='stop'&&(this.config.enabled||this.config.autoSubmit)&&!this.busy)this.trip('auto-stopped',`Auto trading stopped: daily loss limit reached in ${this.config.scope==='paper'?'the paper portfolio':emergency.activeMarkets.map(m=>m==='US'?'U.S.':'Korea').join(' and ')}. Positions and accepted broker orders are unchanged.`);
    this.digest.tick(this);
    for(const row of this.db.prepare('SELECT id,payload FROM paper_fills WHERE id NOT IN (SELECT id FROM reviewed_fills) ORDER BY seq LIMIT 20').all()) {
      const fill=JSON.parse(row.payload);this.db.prepare('INSERT INTO reviewed_fills VALUES(?)').run(row.id);
      if(fill.side==='Sell'&&fill.realized<0&&!this.db.prepare('SELECT id FROM paper_orders WHERE id=?').get(fill.orderId??''))this.db.prepare('INSERT INTO lessons(id,text) VALUES(?,?)').run(randomUUID(),`Candidate lesson: paper sale ${fill.symbol} realized a loss of KRW ${Math.abs(fill.realized)} after simulated fees. Inspect the linked decision, entry cost, slippage and market movement before drawing a causal conclusion. A loss alone does not establish a decision mistake.`);
    }
    // The narrative refreshes before the Korean open and after the close on weekdays, once per slot.
    if(this.config.narrativeEnabled&&!this.narrating&&!this.narrativeAvailable()){const slot=require('./scout.cjs').dueSlot('narrative');const last=this.db.prepare('SELECT slot FROM narrative_slots WHERE id=1').get()?.slot;if(slot&&slot!==last&&Date.now()-(this.lastNarrativeAttempt??0)>=600000){this.lastNarrativeAttempt=Date.now();this.db.prepare('INSERT INTO narrative_slots VALUES(1,?) ON CONFLICT(id) DO UPDATE SET slot=excluded.slot').run(slot);void this.buildNarrative('Scheduled').catch(()=>{});}}
    // Scout runs follow their own weekday schedule, independent of trading reviews; each slot runs once.
    if(this.config.scoutEnabled&&!this.scouting&&!this.scoutAvailable()){const scope=this.watchScope();const slot=require('./scout.cjs').dueSlot(this.config.scoutSchedule);if(slot&&this.scoutStore.lastSlot(scope)!==slot&&Date.now()-(this.lastScoutAttempt??0)>=600000){this.lastScoutAttempt=Date.now();this.scoutStore.markSlot(scope,slot);void this.scout('Scheduled').catch(()=>{});}}
    // Desk checks every 5 seconds: conditional orders while auto trading is on, one at a time.
    // Schedule observation every 30 seconds while auto trading runs on KIS: records only (electron/schedule-observer.cjs).
    if(this.sessionArmed&&this.config.enabled&&this.config.scope!=='paper'&&Date.now()-(this.lastScheduleObservation??0)>=30000){this.lastScheduleObservation=Date.now();try{this.scheduleObserver.observe(this.scheduleState());}catch{}}
    const deskDue=Date.now()-(this.lastDeskCheck??0)>=5000;if(deskDue)this.lastDeskCheck=Date.now();
    if(deskDue&&this.conditionalMonitoringActive()&&!this.firing){
      const scope=this.watchScope();const data=this.formulaData();const formula=require('./formula.cjs');
      for(const order of this.desk.orders(scope)){if(order.nextCheckAt>Date.now())continue;const check=formula.checkConditions(order.conditions,order.combine,data);if(check.met){this.firing=true;void this.fireConditional(order).catch(()=>{}).finally(()=>{this.firing=false;});break;}}
    }
    // Open app orders follow the best bid or ask every 3 seconds while the app runs, auto trading on or not.
    if(this.config.orderTracking!==false&&this.config.scope!=='paper'&&!this.trackingOrders&&Date.now()-(this.lastTrack??0)>=3000){this.lastTrack=Date.now();this.trackingOrders=true;void this.trackOrders().catch(()=>{}).finally(()=>{this.trackingOrders=false;});}
    if(this.schedulerStatus().label!=='Monitoring')return;
    if(this.reviewRequested&&!this.busy&&this.config.scope!=='paper'){const r=this.reviewRequested;this.reviewRequested=null;this.triggerEvidence={kind:'placement',reason:r.reason};this.log(randomUUID(),'System',r.trigger,r.reason);void this.review(r.trigger).catch(()=>{});return;}
    // Order updates are noted every 5 seconds, also while markets are closed, and start a review when one can run.
    // Each order keeps its latest update; the queue belongs to the scope it was noted in.
    if(deskDue&&this.config.scope!=='paper'){const events=this.orderEvents();if(events.length){if(this.orderQueue?.scope!==this.config.scope)this.orderQueue={scope:this.config.scope,orders:new Map()};for(const o of events)this.orderQueue.orders.set(o.id,o);}}
    if(this.orderQueue&&this.orderQueue.scope!==this.config.scope)this.orderQueue=null;
    // While every market in scope is closed, nothing can execute: scheduled, news and agent-trigger reviews wait,
    // except one review shortly before the next open (unless set otherwise). Emergencies and your own requests still run.
    if(!emergency.active&&this.config.closedMarketReviews!=='keep'){const hours=this.marketHours();if(!hours.open){
      if(this.config.closedMarketReviews==='pre-open'&&hours.preOpen&&this.preOpenKey!==hours.preOpen.key&&!this.busy){this.preOpenKey=hours.preOpen.key;this.saveClock();void this.review('Pre-open review').catch(()=>{});}
      return;}}
    if(this.orderQueue?.orders.size&&!this.busy&&Date.now()-this.lastRun>=30000&&(held=>[...this.orderQueue.orders.values()].some(o=>!held.has(require('./size-retry.cjs').orderEventKey(o))))(this.heldEvents(this.watchScope()))){const list=[...this.orderQueue.orders.values()];this.orderQueue=null;this.orderTaken=new Map(list.map(o=>[o.id,o]));
      this.triggerEvidence={kind:'order',orders:list.map(o=>({id:o.id,symbol:o.symbol,market:o.market??'KR',side:o.side,quantity:o.quantity,filled:o.filled??0,status:o.status,fillPrice:o.fillPrice??null,placedAt:o.createdAt?new Date(o.createdAt).toISOString():null}))};
      this.log(list[0].id,'System','Order update',list.map(o=>`${o.status}: ${o.side} ${o.symbol}, ${o.filled??0}/${o.quantity} shares`).join('; ')+'. A review starts now.');void this.review('Order update').catch(()=>{});return;}
    // Agent triggers: met conditions start a review with the values that met them.
    if(deskDue&&!this.busy&&this.config.scope!=='paper'&&Date.now()-this.lastRun>=60000){const open={KR:this.sessionOpen('KR'),US:this.sessionOpen('US')};const held=this.heldEvents(this.watchScope());const hit=this.desk.checkTriggers(this.watchScope(),this.formulaData(),t=>!held.has('agent:'+t.id)&&(t.symbols??[]).every(sym=>open[/:/.test(sym)?'US':'KR']));if(hit){this.triggerEvidence={kind:'agent-trigger',trigger:{id:hit.trigger.id,name:hit.trigger.name,reason:hit.trigger.reason},results:hit.results};this.log(hit.trigger.id,'System','Agent trigger met',`${hit.trigger.name}: ${hit.results.map(r=>`${r.expr} = ${r.actual} (${r.op} ${r.value})`).join('; ')}`);void this.review('Agent trigger').catch(()=>{});return;}}
    const elapsed=Date.now()-this.lastRun;
    if(emergency.active){if((this.lastEmergencyAttempt??0)<this.emergencyStartedAt||elapsed>=60000){this.lastEmergencyAttempt=Date.now();void this.review('Emergency loss response').catch(()=>{});}return;}
    if(elapsed<60000)return;
    const quotes=this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):this.config.scope==='kis'?(this.marketQuotes?.()??[]):this.paper.getState().quotes;
    const scope=this.watchScope();if(this.lastWatchScope!==scope){this.lastPrices.clear();this.watchAlerts.clear();this.lastWatchScope=scope;}
    let drift=this.priceTrigger(scope,quotes,Date.now(),{skipLevels:this.heldEvents(scope)});
    const sizeFailed=this.failedInput?.scope===scope?this.failedInput:null;
    if(drift&&sizeFailed&&!require('./size-retry.cjs').priceTriggerMoved(sizeFailed,drift,{tolerance:this.config.eventTolerancePct??3})){this.restoreEvents(scope,drift);if(!sizeFailed.priceHeld){sizeFailed.priceHeld=true;this.log(randomUUID(),'System','Price trigger held · size failure',`A price trigger (${drift.symbol??(drift.alerts??[]).map(a=>a.symbol).join(', ')}) was not rebuilt into a review: since the size failure at ${new Date(sizeFailed.at).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST its price has not moved past the review gate's limit. Logged once.`);}drift=null;}
    if(drift)this.triggerEvidence=drift;
    if(!drift&&this.config.newsTrigger!=='off'&&Date.now()-(this.lastNewsTrigger??0)>=600000){const held=this.heldEvents(scope);const pending=this.newsEvents.pending(this.config.newsTrigger).filter(event=>!held.has('news:'+event.id)).slice(0,5);if(pending.length){this.lastNewsTrigger=Date.now();this.newsEvents.markTriggered(pending.map(event=>event.id));this.triggerEvidence={kind:'news',events:pending.map(({id,title,source,published,symbols,importance})=>({id,title,source,published,symbols,importance}))};void this.review('News event trigger').catch(()=>{});return;}}
    // Near the daily AI budget, scheduled reviews run at twice the interval instead of stopping.
    const interval=this.reviewInterval.get(this.watchScope(),this.config).minutes*60000*this.slowFactor();
    if(!drift&&elapsed>=interval){const defer=this.deferForPendingOrder();if(defer){if(this.deferredAfter!==this.lastRun){this.deferredAfter=this.lastRun;const o=defer.orders[0];
      this.log(o.id,'System','Review waits for the pending order',`${o.side} ${o.quantity} ${o.symbol} is waiting at the broker (${o.status}${defer.orders.length>1?`, with ${defer.orders.length-1} more`:''}). The next review starts when it fills, partly fills or is cancelled, on a price, news or agent trigger, when a market opens or closes, or at ${new Date(defer.until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST at the latest.`);}return;}}
    if(elapsed>=interval||drift)void this.review(drift?'Price movement trigger':this.firstAfterStart?'Auto trading started':'Scheduled review').catch(()=>{});
  }
  approveLesson(id,approved){if(typeof id!=='string'||typeof approved!=='boolean')throw new Error('INVALID_REQUEST');this.syncLearning();if(this.learningError)throw new Error('LESSON_REVIEW_FAILED');const lifecycle=this.memory.lifecycle(id);if(lifecycle)this.memory.review(id,{expectedSignature:lifecycle.signature,action:approved?'approve':'retire'});else this.db.prepare('UPDATE lessons SET approved=? WHERE id=?').run(approved?1:0,id);return this.getState();}
}
module.exports={loggableContext,dryRunSummary,Automation,DEFAULTS};
