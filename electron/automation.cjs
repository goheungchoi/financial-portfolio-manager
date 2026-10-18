const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
const DEFAULTS={unlimitedCalls:false,unlimitedBudget:false,reflectionUnlimitedCalls:false,reflectionUnlimitedBudget:false,autoReviewInterval:false,reflectionEnabled:false,reflectionCallsPerDay:5,reflectionUSDPerDay:1,enabled:false,autoSubmit:false,scope:'paper',shareKisWithAI:false,provider:'local',openaiModel:'gpt-6-luna',reasoningEffort:'none',intervalMinutes:10,eventTolerancePct:3,maxCallsPerDay:20,maxUSDPerDay:1,desktopAlerts:false,mobileAlerts:false,phoneSnapshots:true,phoneAmounts:true,newsURL:'',guidelines:'',lossAction:'review',maxAutoOrdersPerDay:0,maxConsecutiveFailures:0,digestEnabled:false,digestHour:16,newsTrigger:'disclosures',skipUnchanged:true,maxSkipMinutes:120,modelRouting:'fixed',routineModel:'gpt-6-luna',routineEffort:'none',degradeNearBudget:true,scoutEnabled:false,scoutSchedule:'twice',scoutAiRequests:true,newsFeeds:[],kisNews:true,usTickerNews:true,narrativeEnabled:true,sizingRiskPct:1,sizingAtrMultiple:2,...require('./agent-desk.cjs').COND_DEFAULTS};
const LOG_LIMIT=30000;
// The console keeps a copy of the supplied context. Large sections are summarized in that copy so it fits the event log; the AI still receives everything.
function loggableContext(context){
  const value={...context};let text=JSON.stringify(value);
  const keys=Object.keys(value).filter(key=>!['environment','market','currency','universe','positions','risk'].includes(key)).sort((a,b)=>(JSON.stringify(value[b])?.length??0)-(JSON.stringify(value[a])?.length??0));
  for(const key of keys){if(text.length<=LOG_LIMIT)break;value[key]=`[not kept in the log: ${(JSON.stringify(value[key])?.length??0).toLocaleString('en-US')} characters; the AI received it in full]`;text=JSON.stringify(value);}
  return text.length<=LOG_LIMIT?text:text.slice(0,LOG_LIMIT-1)+'…';
}
class Automation {
  constructor(db,paper,provider,log) {
    this.db=db;this.paper=paper;this.provider=provider;this.log=log;this.providerStatus={aiConnected:false,dartConnected:false,pushConnected:false};this.news=[];this.newsError=null;this.busy=false;this.lastRun=0;this.lastPrices=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS automation_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,text TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS ai_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL,reservedMicro INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS reviewed_fills(id TEXT PRIMARY KEY);');
    db.exec('CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL)');
    this.reviewInterval=new (require('./review-interval.cjs').ReviewInterval)(db);
    this.watches=new (require('./review-watches.cjs').ReviewWatches)(db);
    this.outcomes=new (require('./outcome-ledger.cjs').OutcomeLedger)(db);this.memory=new (require('./learning-memory.cjs').LearningMemory)(db);
    this.trials=new (require('./lesson-trials.cjs').LessonTrials)(db,this.memory);
    this.reflections=new (require('./reflection.cjs').ReflectionQueue)(db,this.memory);
    this.scoreboard=new (require('./scoreboard.cjs').Scoreboard)(db);this.guardrails=new (require('./guardrails.cjs').Guardrails)(db);this.newsEvents=new (require('./news-events.cjs').NewsEvents)(db);this.digest=new (require('./daily-digest.cjs').DailyDigest)(db);this.scoutStore=new (require('./scout.cjs').ScoutStore)(db);const feedback=require('./scout-feedback.cjs');this.briefs=new feedback.BriefStore(db);this.scoutScorecard=new feedback.ScoutScorecard(db,this.scoreboard);this.desk=new (require('./agent-desk.cjs').AgentDesk)(db);this.narratives=new (require('./narrative.cjs').NarrativeStore)(db);this.replays=new (require('./replay.cjs').ReplayStore)(db);this.episodes=new (require('./episodes.cjs').EpisodeLibrary)(db);db.exec('CREATE TABLE IF NOT EXISTS narrative_slots(id INTEGER PRIMARY KEY CHECK(id=1),slot TEXT NOT NULL)');
    const row=db.prepare('SELECT payload FROM automation_settings WHERE id=1').get();this.config={...DEFAULTS,...(row?JSON.parse(row.payload):{})};this.sessionArmed=false;this.lastError=null;this.lastSuccess=0;this.savedAt=null;if(!row)this.saveConfig();
  }
  watchScope(){if(this.config.scope==='paper')return 'paper';try{return this.config.scope+':'+(this.live??this.usLive).identity();}catch{return this.config.scope+':disconnected';}}
  saveConfig(){this.db.prepare('INSERT INTO automation_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(this.config));}
  configure(value) {
    if(!value || Object.keys(value).some(key=>!Object.hasOwn(DEFAULTS,key)))throw new Error('INVALID_SETTINGS');
    const next={...this.config,...value};
    if(!['local','openai','external'].includes(next.provider)||!Number.isInteger(next.intervalMinutes)||next.intervalMinutes<1||next.intervalMinutes>1440||!Number.isFinite(next.eventTolerancePct)||next.eventTolerancePct<.1||next.eventTolerancePct>50||!Number.isInteger(next.maxCallsPerDay)||next.maxCallsPerDay<1||next.maxCallsPerDay>200||!Number.isFinite(next.maxUSDPerDay)||next.maxUSDPerDay<.01||next.maxUSDPerDay>100||typeof next.newsURL!=='string'||next.newsURL.length>1000||typeof next.guidelines!=='string'||next.guidelines.length>6000)throw new Error('INVALID_SETTINGS');
    if(!Number.isInteger(next.reflectionCallsPerDay)||next.reflectionCallsPerDay<1||next.reflectionCallsPerDay>200||!Number.isFinite(next.reflectionUSDPerDay)||next.reflectionUSDPerDay<.01||next.reflectionUSDPerDay>100)throw new Error('INVALID_SETTINGS');
    for(const key of ['unlimitedCalls','unlimitedBudget','reflectionUnlimitedCalls','reflectionUnlimitedBudget','autoReviewInterval','reflectionEnabled','enabled','autoSubmit','desktopAlerts','mobileAlerts','phoneSnapshots','phoneAmounts'])if(typeof next[key]!=='boolean')throw new Error('INVALID_SETTINGS');
    if(!['paper','kis','us','both'].includes(next.scope)||typeof next.shareKisWithAI!=='boolean')throw new Error('INVALID_SETTINGS');
    require('./guardrails.cjs').validateGuardrails(next);if(!require('./news-events.cjs').MODES.includes(next.newsTrigger))throw new Error('INVALID_SETTINGS');
    require('./ai-models.cjs').settings(next);require('./ai-models.cjs').settings({openaiModel:next.routineModel,reasoningEffort:next.routineEffort});
    if(typeof next.skipUnchanged!=='boolean'||typeof next.degradeNearBudget!=='boolean'||!['fixed','auto'].includes(next.modelRouting)||!Number.isInteger(next.maxSkipMinutes)||next.maxSkipMinutes<15||next.maxSkipMinutes>720)throw new Error('INVALID_SETTINGS');
    if(typeof next.scoutAiRequests!=='boolean'||typeof next.scoutEnabled!=='boolean'||!Object.hasOwn(require('./scout.cjs').SCHEDULES,next.scoutSchedule))throw new Error('INVALID_SETTINGS');
    if(!Array.isArray(next.newsFeeds)||next.newsFeeds.length>10||next.newsFeeds.some(f=>!f||typeof f.url!=='string'||!/^https:\/\//.test(f.url)||f.url.length>500||typeof(f.label??'')!=='string'||String(f.label??'').length>60)||typeof next.kisNews!=='boolean'||typeof next.usTickerNews!=='boolean'||typeof next.narrativeEnabled!=='boolean'||!Number.isFinite(next.sizingRiskPct)||next.sizingRiskPct<0.1||next.sizingRiskPct>5||!Number.isFinite(next.sizingAtrMultiple)||next.sizingAtrMultiple<0.5||next.sizingAtrMultiple>5)throw new Error('INVALID_SETTINGS');
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
    return {label:'Monitoring',detail:'Waiting for the next scheduled review or price-movement trigger.'};
  }
  executionState(){const selected=this.config.scope==='both'?[['KR',this.live],['US',this.usLive]]:this.config.scope==='paper'?[['Paper',{enabled:!this.paper.account().paused,autoEnabled:true}]]:[[this.config.scope==='us'?'US':'KR',this.config.scope==='us'?this.usLive:this.live]];const markets=selected.map(([market,engine])=>({market,enabled:Boolean(engine?.enabled),automatic:Boolean(engine?.enabled&&engine?.autoEnabled)}));const describe=market=>(market==='US'?'U.S.':market==='KR'?'Korea':market);const blocked=markets.filter(row=>!row.enabled||this.config.autoSubmit&&!row.automatic);return {label:!this.config.autoSubmit?'Approval first':blocked.length?'Automatic requested · waiting for activation':'Automatic execution ready',detail:markets.map(row=>describe(row.market)+': '+(!row.enabled?'orders off':!this.config.autoSubmit?'approval first':row.automatic?'automatic orders enabled':'automatic orders off; approval required')).join(' · '),markets};}
  emergencyState(){const candidates=this.config.scope==='both'?[{market:'KR',loss:this.live?.getState().loss},{market:'US',loss:this.usLive?.getState().loss}]:[{market:this.config.scope==='us'?'US':'KR',loss:this.config.scope==='paper'?this.paper.getState().loss:(this.config.scope==='us'?this.usLive:this.live)?.getState().loss}];const selected=candidates.find(row=>row.loss?.breached)??candidates[0];return {active:candidates.some(row=>row.loss?.breached),scope:this.config.scope,currency:selected.market==='US'?'USD':'KRW',activeMarkets:candidates.filter(row=>row.loss?.breached).map(row=>row.market),loss:selected.loss??null,reviewIntervalSeconds:60,objective:'Prioritize justified loss reduction after costs. Reassess both markets when selected; respect native currencies, broker capacity, hours and approval. Do not chase losses.'};}
  observeEmergency(emergency){if(emergency.active!==Boolean(this.lastEmergencyActive)||emergency.active&&emergency.scope!==this.lastEmergencyScope){this.lastEmergencyActive=emergency.active;this.lastEmergencyScope=emergency.scope;this.emergencyStartedAt=emergency.active?Date.now():null;this.log(randomUUID(),'Risk',emergency.active?'Emergency mode entered':'Emergency mode cleared',JSON.stringify(emergency));}}
  // Headlines about your symbols first; general headlines are trimmed when the market narrative already summarizes them.
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
  getState(){this.syncLearning();return {calendar:this.calendarState(),regime:this.regimeState(),exposure:this.exposureState(),narrative:this.narrativeState(),desk:this.deskState(),scout:this.scoutState(),tokenSaving:this.tokenSavingState(),newsEvents:this.newsEvents.list(100),lastNewsTrigger:this.lastNewsTrigger??null,guardrails:this.guardrails.state(this.config),digests:this.digest.list(),lessonTrials:this.trials.list(),reviewInterval:this.reviewInterval.get(this.watchScope(),this.config),reflections:this.reflections.state(),aiCalls:this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.payload)),learning:{...this.memory.summary(),lastRun:this.learningLastRun??null,error:this.learningError??null},watches:this.watches.list(this.watchScope()),outcomes:this.outcomes.list(),execution:this.executionState(),emergency:this.emergencyState(),config:this.config,sessionArmed:this.sessionArmed,savedAt:this.savedAt,heartbeat:Date.now(),scheduler:this.schedulerStatus(),lastAttempt:this.lastRun||null,lastSuccess:this.lastSuccess||null,lastError:this.lastError,lastErrorDetail:this.lastErrorDetail??null,nextReview:this.config.enabled&&this.sessionArmed?Math.max(Date.now(),this.lastRun+Math.max(60000,this.emergencyState().active?60000:this.reviewInterval.get(this.watchScope(),this.config).minutes*60000)):null,providerStatus:this.providerStatus,busy:this.busy,news:this.news,newsUpdatedAt:this.newsUpdatedAt??null,newsError:this.newsError,reviews:this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 50').all().map(row=>JSON.parse(row.payload)),lessons:this.memory.list(),usage:this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0}};}
  localDecision(context) {
    if(context.currency==='USD'||context.currency==='MULTI')return {action:'Hold',symbol:'',quantity:0,explanation:'U.S. portfolio requires an AI review or a manual proposal; the domestic demonstration rule does not trade USD assets.'};
    if(context.orders.some(order=>['Pending','Partially filled','Accepted','Submitting','Uncertain'].includes(order.status)))return {action:'Hold',symbol:'',quantity:0,explanation:'Wait for pending orders to reconcile before another rebalance.'};
    if(context.emergency?.active){
      const candidates=context.universe.map(row=>({row,quote:context.quotes.find(q=>q.symbol===row.symbol),quantity:context.positions[row.symbol]?.quantity??0})).filter(item=>item.quantity>0&&item.quote&&!item.quote.stale).sort((a,b)=>b.quantity*b.quote.price-a.quantity*a.quote.price);
      for(const item of candidates){const quantity=Math.min(item.quantity,Math.max(1,Math.ceil(item.quantity*.25)),Math.floor((context.risk.maxOrderKRW??context.equity)*.9/item.quote.price),1000);if(quantity>0)return {action:'Sell',symbol:item.row.symbol,quantity,explanation:'Emergency local rule: propose reducing up to 25% of the largest available position to lower exposure. This deterministic rule is not an AI forecast; approval and independent execution checks still apply.'};}
      return {action:'Hold',symbol:'',quantity:0,explanation:'Emergency local rule: no eligible held position with a fresh quote is available to reduce. Preserve cash and request further evidence.'};
    }
    const costs=context.tradingCosts;const roundTripPct=costs?.basis==='simulation'?2*(costs.commissionPct+costs.slippagePct):costs?.settings?2*costs.settings.krCommissionPct+costs.settings.krSellTaxPct:0;
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
  async review(trigger='User request',externalDecision) {
    if(this.busy)throw new Error('REVIEW_BUSY');this.busy=true;const id=randomUUID();let context;let stage='Account data';const revision=this.revision;const watchScope=this.watchScope();let costRevision=null;
    try {
      costRevision=JSON.stringify(this.costs?.get());
      let usValue;let execution=this.config.scope==='us'?this.usLive:this.live;
      if(this.config.scope!=='paper') {
        if(this.config.scope==='us'||this.config.scope==='both')usValue=await this.refreshUS();
        if(externalDecision)throw new Error('EXTERNAL_KIS_DISABLED');
        if(this.config.provider==='openai'&&!this.config.shareKisWithAI)throw new Error('DATA_SHARING_NOT_ENABLED');
        if(this.config.scope==='both'){const kr=await this.live.context(),us=await this.usLive.context(usValue);kr.tradingCosts=this.costs?.context('KR',kr.universe,kr.positions);us.tradingCosts=this.costs?.context('US',us.universe,us.positions);context=require('./combined-context.cjs').combinedContext(kr,us,this.fx?.(),this.metadata?.());}else context=await execution.context(this.config.scope==='us'?usValue:null);context.news=this.newsContext();context.reviewedLessons=this.db.prepare('SELECT text FROM lessons WHERE approved=1 ORDER BY rowid DESC LIMIT 5').all().map(row=>row.text);
      }else context=this.context();
      stage='Local trade evidence';this.outcomes.sync();this.memory.sync();const accounts=[this.live,this.usLive].flatMap(engine=>{try{return [engine.identity()];}catch{return [];}});const lessons=this.memory.relevantLessons(context,accounts);context.reviewedLessons=lessons.map(row=>row.text);const lessonIds=lessons.map(row=>row.id);
      const conflicts=this.scoreboard.conflicts().filter(c=>lessonIds.includes(c.a)&&lessonIds.includes(c.b));if(conflicts.length)context.lessonConflicts=conflicts.map(c=>({lessons:[lessonIds.indexOf(c.a)+1,lessonIds.indexOf(c.b)+1],symbol:c.symbol,note:c.reason+' Weigh both; neither is a validated rule.'}));
      if(context.environment!=='local-paper'){const board=this.scoreboard.context();if(board)context.decisionScoreboard=board;const macro=this.macro?.context();if(macro)context.macro=macro;}
      stage='Portfolio context';const emergency=context.environment==='kis'?{...this.emergencyState(),active:false,loss:null}:this.emergencyState();
      if(context.environment==='kis'){const policy=context.risk;const {lossStatus}=require('./loss-policy.cjs');emergency.loss=lossStatus(policy.lossLimit??{mode:'amount',value:policy.maxDailyLossKRW},policy.baseline,context.equity);emergency.active=emergency.loss.breached;}
      context.tradingCosts=context.environment==='kis-combined'?{markets:context.markets.map(row=>({market:row.market,...row.tradingCosts}))}:context.environment==='local-paper'?{basis:'simulation',currency:'KRW',commissionPct:.1,slippagePct:.1,saleTaxPct:0,capitalGainsTax:'Not modeled in the local paper simulator. Live trading uses your fee and tax settings.'}:this.costs?.context(context.market??'KR',context.universe,context.positions);context.emergency=emergency;context.userGuidelines=this.config.guidelines;const peak=context.environment==='local-paper'?(this.paper.account().dayPeakEquity??this.paper.account().dayBaseline):(context.environment==='kis-combined'?null:context.risk.dayPeakEquity??context.risk.baseline);context.performance={dailyBaseline:emergency.loss?.baseline??null,observedDailyPeak:peak,currentEquity:context.equity,drawdownFromObservedPeakPct:peak>0?Math.max(0,(peak-context.equity)/peak*100):null};
      context.reviewInterval=this.reviewInterval.get(watchScope,this.config);if(context.environment==='kis'||context.environment==='kis-combined'){const history=context.environment==='kis-combined'?{KR:this.performanceSummary?.('KR')??null,US:this.performanceSummary?.('US')??null}:this.performanceSummary?.(context.market)??null;if(history)context.performance.history=history;}
      context.reviewWatches=this.watches.list(watchScope).map(({baseline,...watch})=>watch);if(context.environment!=='local-paper'){const plan=require('./scout.cjs').reviewContext(this.scoutStore.latest(watchScope));if(plan)context.scoutPlan=plan;const brief=this.scoutBriefState(watchScope);if(brief)context.scoutBrief=brief;context.agentDesk=this.desk.context(watchScope,this.config,(context.universe??[]).map(r=>r.symbol));const story=this.storyContext();if(story.marketNarrative)context.marketNarrative=story.marketNarrative;if(story.similarEpisodes?.length)context.similarEpisodes=story.similarEpisodes;const risk=this.riskContext(context);Object.assign(context,risk);const events=this.calendarState(14,(context.universe??[]).map(r=>({symbol:r.symbol,name:r.name})));if(events.length)context.eventCalendar=events.slice(0,15).map(({date,kind,market,symbol,title,estimated})=>({date,kind,market,symbol,title,estimated}));}if(context.environment!=='local-paper'&&this.discovery){const starters=this.discovery.starters?.()??[];context.discovery={enabled:true,watchlist:this.discovery.list().map(({symbol,name,source,reason})=>({symbol,name,source,reason})),...(starters.length?{starterCandidates:{market:'KR',symbols:starters,source:'KIS market-cap ranking',note:'Korea has no allowlist, watchlist or holdings, so the largest listed companies were added to the review universe as a starting point. They are not recommendations.'}}:{})};}if(['Price movement trigger','News event trigger','Agent trigger'].includes(trigger))context.triggerEvidence=this.triggerEvidence;
      this.observeEmergency(emergency);if(emergency.active)this.lastEmergencyAttempt=Date.now();
      // Token saving: an unchanged scheduled review is skipped before any provider call.
      const saver=require('./token-saver.cjs');const hash=saver.fingerprint(context);
      if(this.config.provider==='openai'&&!externalDecision&&!emergency.active&&saver.shouldSkip({trigger,config:this.config,fingerprint:hash,last:this.lastFingerprint?.scope===watchScope?this.lastFingerprint:null})){
        this.lastRun=Date.now();this.recordSaving('skipped');this.log(id,'System','Review skipped · no change',`Holdings, cash, prices (within ${this.config.eventTolerancePct/2}%), news, lessons and market sessions are unchanged since the review at ${new Date(this.lastFingerprint.completedAt).toLocaleTimeString()}. No AI call was made. A full review runs at least every ${this.config.maxSkipMinutes} minutes.`);return {skipped:true,id};
      }
      this.log(id,'Program',trigger,context.environment!=='local-paper'?'Reviewing permitted KIS portfolio data. Credentials are excluded.':'Reviewing the local paper portfolio. KIS account data and credentials are excluded.');
      this.log(id,'Context','Supplied context',loggableContext(context));
      let result,routing=null;
      if(externalDecision){const {validateDecision}=require('./ai-client.cjs');result={decision:validateDecision(externalDecision,context.universe.map(row=>row.symbol)),provider:'external'};}
      else if(this.config.provider==='openai') {
        if(!this.providerStatus.aiConnected)throw new Error('AI_NOT_CONNECTED');
        stage='AI research and decision';
        const today=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0};
        let selected=saver.route(this.config,{trigger,emergencyActive:emergency.active,triggerEvidence:context.triggerEvidence,nearBudget:saver.nearBudget(this.config,today)});
        let providerContext=saver.compact(context);this.replays.saveContext(id,providerContext);
        if(selected.tier!=='fixed')this.log(id,'System','Model routing',`${selected.openaiModel} · ${selected.reasoningEffort} (${selected.reason})`);
        const research=()=>require('./research-review.cjs').researchReview({context,evidence:this.evidence,discovery:context.discovery?.enabled?{...(this.discovery.research?{get_company_research:args=>this.discovery.research(args)}:{}),...(this.discovery.marketOverview?{get_market_overview:()=>this.discovery.marketOverview()}:{}),screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.discovery.update_watchlist(args);}}:null,setInterval:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.reviewInterval.set(watchScope,args,this.config);},setWatch:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.watches.set(watchScope,args,context);},actions:context.agentDesk?this.deskActions(watchScope,context,id,()=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');}):null,log:(kind,title,body)=>this.log(id,kind,title,body),request:async options=>{
          if(this.disposed||watchScope!==this.watchScope()||revision!==this.revision||costRevision!==JSON.stringify(this.costs?.get()))throw new Error('STALE_DECISION');
          const modelConfig={openaiModel:selected.openaiModel,reasoningEffort:selected.reasoningEffort};options={...options,...modelConfig};
          const reserve=require('./ai-models.cjs').reservation(modelConfig,providerContext,options);
          const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
          if(require('./ai-models.cjs').budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
          const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now()};
          this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
          try{const response=await this.provider.request('decision',{context:providerContext,options});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return {...response,model:response.model??modelConfig.openaiModel};}
          catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}

        }});
        result=await research();this.recordSaving(selected.tier);routing={tier:selected.tier,reason:selected.reason,model:selected.openaiModel,effort:selected.reasoningEffort,confirmed:null};
        // A trade proposed by the cheaper model is confirmed by the configured model before any proposal is created.
        if(selected.tier==='routine'&&result.decision.action!=='Hold'&&(selected.openaiModel!==this.config.openaiModel||selected.reasoningEffort!==this.config.reasoningEffort)){
          const first=result;this.log(id,'System','Trade confirmation',`${first.model} proposed ${first.decision.action} ${first.decision.quantity} ${first.decision.symbol}; asking ${this.config.openaiModel} to confirm.`);
          selected={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort,tier:'escalated',reason:'trade confirmation'};providerContext={...providerContext,confirmation:{proposedBy:first.model,decision:first.decision}};
          result=await research();this.recordSaving('confirmation');
          result={...result,usage:{inputTokens:(first.usage?.inputTokens??0)+(result.usage?.inputTokens??0),outputTokens:(first.usage?.outputTokens??0)+(result.usage?.outputTokens??0)}};
          routing={...routing,confirmed:result.decision.action===first.decision.action&&result.decision.symbol===first.decision.symbol&&result.decision.quantity===first.decision.quantity,confirmedBy:this.config.openaiModel};
        }
      } else if(this.config.provider==='external')throw new Error('EXTERNAL_DECISION_REQUIRED');
      else result={decision:this.localDecision(context),provider:'local'};
      if(this.disposed)return;if(watchScope!==this.watchScope()||revision!==this.revision||costRevision!==JSON.stringify(this.costs?.get()))throw new Error('STALE_DECISION');
      stage='Decision recording and execution';if(result.model)this.log(id,'System','Model used',result.model+' · '+(routing?.confirmedBy?this.config.reasoningEffort:routing?.effort??this.config.reasoningEffort)+(routing?.confirmedBy?` (confirmed ${routing.confirmed?'unchanged':'with changes'})`:''));
      this.log(id,'Agent','Decision',JSON.stringify(result.decision,null,2));
      if(result.decision.withheld)this.log(id,'System','Buy held back · trade plan',`${result.decision.withheld.quantity} ${result.decision.withheld.symbol}: ${result.decision.withheld.reason}.`);
      // A Buy whose stop is not below the current price is held back too.
      if(result.decision.action==='Buy'&&result.decision.plan){const q=context.quotes?.find(r=>r.symbol===result.decision.symbol);if(q?.price>0&&!(result.decision.plan.stopPrice<q.price)){const d=result.decision;this.log(id,'System','Buy held back · trade plan',`${d.quantity} ${d.symbol}: stop ${d.plan.stopPrice} is not below the price ${q.price}.`);result={...result,decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',plan:d.plan,explanation:require('./ai-client.cjs').trimExplanation(`${d.explanation} [The app held back a Buy of ${d.quantity} ${d.symbol}: the stop price is not below the current price.]`),withheld:{symbol:d.symbol,quantity:d.quantity,reason:'stop not below price'}}};}}
      // The brief rides on the decision; it is saved for the scout and never affects the trade.
      if(result.decision.scoutBrief){const {scoutBrief,...decision}=result.decision;result={...result,decision};if(context.scoutBrief){const value=this.briefScout(watchScope,scoutBrief,id);this.log(id,'Tool','Scout brief',JSON.stringify({brief:scoutBrief,result:value}));}}
      const contextEvidence={guidelines:this.config.guidelines,environment:context.environment,marketSession:context.marketSession??null,quote:context.quotes.find(q=>q.symbol===result.decision.symbol)??null,position:context.positions?.[result.decision.symbol]??null,emergency:context.emergency.active,reviewedLessons:context.reviewedLessons,lessonIds};
      const recorded={model:result.model??null,contextEvidence,id,timestamp:Date.now(),scope:this.config.scope,trigger,provider:result.provider,decision:result.decision,proposalId:null,orderId:null,usage:result.usage??null};
      this.db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify(recorded));
      let proposal=null,order=null,executionNote=null;
      if(result.decision.action!=='Hold') {
        if(context.environment==='kis-combined')execution=/^\d{6}$/.test(result.decision.symbol)?this.live:this.usLive;
        if(context.environment==='local-paper'&&context.paperVersion!==this.paper.account().version)throw new Error('STALE_DECISION');
        const selected=context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market):context;
        const lossBreached=context.environment==='kis-combined'?(context.emergency.activeMarkets??[]).includes(execution.market):Boolean(context.emergency.active);
        if(result.decision.action==='Buy'&&lossBreached&&this.config.lossAction!=='review'){executionNote='Guardrail: new buys are blocked after the daily loss limit. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys blocked',executionNote);this.trip('buys-blocked',`Blocked a ${result.decision.symbol} buy after the daily loss limit was reached.`);}
        else if(result.decision.credit&&result.decision.credit!=='none'&&(context.environment==='local-paper'||execution.market!=='KR')){executionNote='Credit orders (margin buying, short selling) are only available for Korean live accounts. Recommendation recorded; no order proposal was made.';this.log(id,'System','Review only · credit order',executionNote);}
        else if(context.environment!=='local-paper'&&(selected?.executionEnabled===false||!execution.enabled)){executionNote=(execution.market==='US'?'U.S.':'Korea')+' trading session is off. Recommendation recorded; no order proposal or submission was made.';this.log(id,'System','Review only · execution off',executionNote);}else{
        proposal=context.environment!=='local-paper'?execution.propose({...(result.decision.credit&&result.decision.credit!=='none'?{credit:{kind:result.decision.credit,...(result.decision.loanDate?{loanDate:result.decision.loanDate}:{})}}:{}),symbol:result.decision.symbol,side:result.decision.action,quantity:result.decision.quantity,limitPrice:(context.currency==='USD'||execution?.market==='US')?(result.decision.action==='Buy'?Math.ceil:Math.floor)(context.quotes.find(row=>row.symbol===result.decision.symbol).price*100)/100:context.quotes.find(row=>row.symbol===result.decision.symbol).price}):this.paper.propose({symbol:result.decision.symbol,side:result.decision.action,quantity:result.decision.quantity});
        this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify({...recorded,proposalId:proposal.id}),id);
        this.log(id,'Risk','Proposal result',proposal.reason??'Paper risk checks passed.');
        if(result.decision.action==='Buy'&&result.decision.plan&&context.environment!=='local-paper')this.followPlan(watchScope,result.decision,id);
        const autoEligible=this.config.autoSubmit && (context.environment==='local-paper'||execution.autoEnabled!==false) && proposal.status==='Ready' && (context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market)?.marketSession.open===true:context.marketSession?.open!==false);
        const orderCap=this.config.maxAutoOrdersPerDay;
        if(autoEligible&&orderCap>0&&this.guardrails.autoOrdersToday()>=orderCap){executionNote=`Guardrail: the daily limit of ${orderCap} automatic orders is reached. Proposal awaits manual approval.`;this.log(id,'System','Guardrail · order limit',executionNote);this.trip('order-limit',`Daily automatic order limit (${orderCap}) reached; later proposals need approval.`);}
        else if(autoEligible) {order=context.environment!=='local-paper'?await execution.autoSubmit(proposal.id):this.paper.submit(proposal.id);this.log(id,'Tool','Order submission',JSON.stringify(order));}
        if(proposal?.reason)this.db.prepare('INSERT INTO lessons(id,text) VALUES(?,?)').run(randomUUID(),`Candidate lesson: avoid proposals blocked by ${proposal.reason}. Review freshness, reservations and configured limits before retrying.`);
        if(context.environment!=='local-paper'&&this.config.autoSubmit&&execution.autoEnabled===false){executionNote=(execution.market==='US'?'U.S.':'Korea')+' automatic execution is off. Proposal awaits manual approval.';this.log(id,'System','Approval required',executionNote);}}

      }
      const review={model:result.model??null,contextEvidence,id,scope:this.config.scope,timestamp:Date.now(),trigger,provider:result.provider,emergency:context.emergency.active,marketSession:context.marketSession?.status??null,decision:result.decision,executionNote,proposalId:proposal?.id??null,orderId:order?.id??null,usage:result.usage??null,routing};
      this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify(review),id);
      try{this.onReviewed?.(review);}catch{}
      this.lastFingerprint={...hash,scope:watchScope,completedAt:Date.now()};
      this.lastRun=Date.now();this.lastSuccess=this.lastRun;this.guardrails.succeeded();this.lastError=null;this.lastErrorDetail=null;this.lastPrices=new Map(context.quotes.map(row=>[row.symbol,row.price]));this.watches.rebase(watchScope,context.quotes);this.lastWatchScope=watchScope;this.log(id,'System','Review completed',result.usage?JSON.stringify(result.usage):'No provider tokens used.');return review;
    }catch(error){this.lastRun=Date.now();this.lastError=require('./ai-errors.cjs').publicCode(error)??(['AI_NOT_CONNECTED','AI_BUDGET_EXHAUSTED','EXTERNAL_DECISION_REQUIRED','PROVIDER_REQUEST_FAILED','AI_REQUEST_FAILED','DATA_SHARING_NOT_ENABLED','KIS_TRADING_DISABLED','STALE_DECISION','SESSION_CLOSED','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','FEATURE_UNAVAILABLE','INCOMPLETE_BALANCE'].includes(error.message)?error.message:'REVIEW_FAILED');this.lastErrorDetail=require('./ai-errors.cjs').detail(this.lastError,stage,error);if(!this.disposed){this.log(id,'System','Review failed',this.lastError+' · '+this.lastErrorDetail);const streak=this.guardrails.failed(),limit=this.config.maxConsecutiveFailures;if(limit>0&&streak>=limit&&(this.config.enabled||this.config.autoSubmit))this.trip('auto-stopped',`Auto trading stopped after ${streak} consecutive failed reviews (latest: ${this.lastError}).`);}throw new Error('REVIEW_FAILED');}
    finally{this.busy=false;this.startRequestedScout();}
  }
  // Formula inputs: the latest quotes the app holds and cached daily closes; tools may warm the cache first.
  formulaData(quotes=[]){
    const live=this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):(this.marketQuotes?.()??[]);
    const all=[...quotes,...live];
    return {price:sym=>all.find(q=>q.symbol===sym&&Number.isFinite(q.price))?.price??null,previousClose:sym=>all.find(q=>q.symbol===sym)?.previousClose??null,closes:sym=>this.series?.closes(sym)??null};
  }
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
      save_note:async args=>{guard();return this.desk.saveNote(scope,args);},
      set_conditional_order:async args=>{guard();if(args?.action!=='cancel'&&context.environment==='local-paper')return {status:'rejected',reason:'Conditional orders need a KIS account.'};const reply=this.desk.setOrder(scope,args,{config:this.config,universe,quotes:context.quotes??[],reviewId});if(reply.status==='armed'){await this.warmSeries(this.desk.orders(scope).find(o=>o.id===reply.id).symbols);const o=this.desk.orders(scope).find(x=>x.id===reply.id);const check=formula.checkConditions(o.conditions,o.combine,this.formulaData(context.quotes??[]));reply.currentValues=check.results.map(r=>({expr:r.expr,actual:r.actual,met:r.met,...(r.error?{error:r.error}:{})}));if(check.met)reply.warning='The conditions are already met; it will fire on the next check while auto trading is on and the market is open.';}return reply;},
    };
  }
  // Conditional orders fire one at a time: fresh account read, conditions re-checked, then every guardrail before the normal proposal path.
  async fireConditional(order){
    const scope=this.watchScope();if(order.scope!==scope)return;const note=(status,outcome,extra={})=>{const saved=this.desk.update(order,{status,outcome,closedAt:Date.now(),...extra});this.log(order.id,'System','Conditional order · '+status,`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): ${outcome}`);return saved;};
    const us=/:/.test(order.symbol);const engine=us?this.usLive:this.live;if(!engine)return note('rejected','No account for this market.');
    this.desk.update(order,{status:'firing',firingAt:Date.now()});
    try{
      const ctx=await engine.context(us?await this.refreshUS():null);
      if(!ctx.marketSession?.open){this.desk.update(order,{status:'armed',waiting:'market closed',nextCheckAt:Date.now()+300000});return;}
      const quote=ctx.quotes.find(q=>q.symbol===order.symbol);if(!(quote?.price>0)){this.desk.update(order,{status:'armed',waiting:'no fresh quote',nextCheckAt:Date.now()+60000});return;}
      const formula=require('./formula.cjs');const base=this.formulaData(ctx.quotes);const check=formula.checkConditions(order.conditions,order.combine,{...base,price:sym=>ctx.quotes.find(q=>q.symbol===sym)?.price??base.price(sym)});
      if(!check.met){this.desk.update(order,{status:'armed',waiting:null,lastCheck:check.results,nextCheckAt:Date.now()+60000});return;}
      const market=us?'US':'KR';const {onTick}=require('./agent-desk.cjs');const limit=onTick(order.limitPrice??quote.price,order.side,market);
      const drift=Math.abs(limit/quote.price-1)*100;if(drift>this.config.conditionalMaxSlippagePct)return note('rejected',`Limit ${limit} is ${drift.toFixed(2)}% from the price ${quote.price}, above the ${this.config.conditionalMaxSlippagePct}% limit.`,{results:check.results});
      let quantity=order.quantity;
      if(order.side==='Sell'){const held=ctx.positions?.[order.symbol]?.quantity??0;if(held<1)return note('rejected','No shares held to sell.',{results:check.results});quantity=Math.min(quantity,held);}
      const notional=quantity*limit;
      if(order.side==='Buy'){
        const cap=ctx.equity*this.config.conditionalMaxOrderPct/100;if(!(notional<=cap))return note('rejected',`Order value ${Math.round(notional)} is above ${this.config.conditionalMaxOrderPct}% of equity (${Math.round(cap)}).`,{results:check.results});
        if(!(ctx.cash>=notional*1.005))return note('rejected','Not enough cash for the order and fees.',{results:check.results});
        const emergency=this.emergencyState();if((emergency.activeMarkets??(emergency.active?[market]:[])).includes(market)&&this.config.lossAction!=='review')return note('rejected','New buys are blocked after the daily loss limit.',{results:check.results});
      }
      const proposal=engine.propose({symbol:order.symbol,side:order.side,quantity,limitPrice:limit});
      const cap=this.config.maxAutoOrdersPerDay;const capReached=cap>0&&this.guardrails.autoOrdersToday()>=cap;
      const auto=this.config.conditionalAutoSubmit&&this.config.autoSubmit&&engine.autoEnabled!==false&&proposal.status==='Ready'&&!proposal.requiresApproval&&!capReached;
      if(auto){const placed=await engine.autoSubmit(proposal.id);return note('submitted',`Submitted at ${limit} for ${quantity} shares.`,{proposalId:proposal.id,orderId:placed?.id??null,results:check.results});}
      return note('proposed',capReached?`Daily automatic order limit reached; proposal ${proposal.id} awaits approval.`:`Proposal at ${limit} for ${quantity} shares awaits approval.`,{proposalId:proposal.id,results:check.results});
    }catch(error){const code=/^[A-Z_]{3,40}$/.test(error?.code??error?.message??'')?(error.code??error.message):'ORDER_FAILED';return note('rejected',`The broker or a risk check refused it (${code}).`);}
  }
  deskState(){const scope=this.watchScope();return {triggers:this.desk.triggers(scope),notes:this.desk.notes(scope),orders:this.desk.orders(scope),recentOrders:this.desk.recentOrders(scope,10),firedTriggers:this.desk.rows('agent_triggers',scope,'fired').slice(0,5)};}
  // A Buy's plan becomes a note on the symbol, and a stop-loss order when conditional orders are allowed.
  followPlan(scope,decision,reviewId){
    const p=decision.plan;const day=seoulDate();
    const text=`Plan from ${day}: ${p.thesis} Invalid if: ${p.invalidation}. Stop ${p.stopPrice}${p.targetPrice?`, target ${p.targetPrice}`:''}, horizon ${p.horizonDays} days, confidence ${p.confidence}.`;
    const note=this.desk.saveNote(scope,{action:'set',symbol:decision.symbol,note:text,expiresInDays:Math.min(90,Math.max(1,p.horizonDays))});this.log(reviewId,'Tool','Trade plan saved',JSON.stringify(note));
    if(this.config.conditionalOrders&&p.stopPrice){const stop=this.desk.setOrder(scope,{action:'add',id:'',symbol:decision.symbol,side:'Sell',quantity:decision.quantity,limitPrice:null,conditions:[{expr:`price("${decision.symbol}")`,op:'<=',value:p.stopPrice}],combine:'all',purpose:'stop_loss',expiresInHours:this.config.conditionalMaxHours,reason:`Stop from the trade plan of ${day}: ${p.invalidation}`.slice(0,300)},{config:this.config,reviewId});this.log(reviewId,'Tool','Stop-loss armed from the plan',JSON.stringify(stop));}
  }
  // Upcoming events from cached research, the macro calendar and computed options expiries.
  calendarState(days=21,extra=[]){try{const p=this.portfolioHoldings?.();const symbols=[...new Map([...(p?.holdings??[]).map(h=>[h.symbol,{symbol:h.symbol,name:h.name}]),...(this.discovery?.list?.()??[]).map(w=>[w.symbol,{symbol:w.symbol,name:w.name}]),...extra.map(e=>[e.symbol,e])]).values()].slice(0,40);
    return require('./event-calendar.cjs').build({today:seoulDate(),days,macroCalendar:this.macro?.get?.()?.calendar??[],symbols,sources:sym=>this.calendarSource?.(sym)});}catch{return [];}}
  // Exposure, sizing and regime, computed locally from holdings, cached history and stress signals.
  riskContext(context){
    const pr=require('./portfolio-risk.cjs');const insights=require('./kis-insights.cjs');const ind=require('./indicators.cjs');const out={};
    try{
      const closes=this.indexCloses?.()??{};const daily=sym=>this.series?.closes(sym)??[];const beta=sym=>{const index=/:/.test(sym)?closes.SPX:closes.KOSPI;const m=insights.riskMetrics(daily(sym),index??[],[]);return m?.market?.beta??null;};
      const p=this.portfolioHoldings?.();
      if(p?.holdings?.length)out.portfolioExposure=pr.exposure(p.holdings,{daily,sector:sym=>this.sectorOf?.(sym)??null,beta,cashKRW:p.cashKRW});
      const fx=this.fx?.()?.usdKRW??null;const equity=p?.equityKRW??(context.environment==='kis'?context.equity:null);
      const rows=(context.universe??[]).map(u=>{const q=context.quotes?.find(r=>r.symbol===u.symbol);const c=daily(u.symbol);const atr=ind.atr(c,14);return {symbol:u.symbol,price:q?.price??c.at(-1)?.close,atr,fx:/:/.test(u.symbol)?fx:1};}).filter(r=>r.atr&&r.price&&r.fx);
      const sizing=pr.sizing({equityKRW:equity,riskPct:this.config.sizingRiskPct,atrMultiple:this.config.sizingAtrMultiple,rows});if(sizing?.rows.length)out.positionSizing=sizing;
      const g=this.regimeState();if(g)out.marketRegime={regime:g.regime,score:g.score,components:g.components.map(({name,value,reading})=>({name,value,reading}))};
    }catch{}
    return out;
  }
  exposureState(){try{const p=this.portfolioHoldings?.();if(!p?.holdings?.length)return null;const pr=require('./portfolio-risk.cjs');const closes=this.indexCloses?.()??{};const daily=sym=>this.series?.closes(sym)??[];const insights=require('./kis-insights.cjs');return pr.exposure(p.holdings,{daily,sector:sym=>this.sectorOf?.(sym)??null,beta:sym=>insights.riskMetrics(daily(sym),(/:/.test(sym)?closes.SPX:closes.KOSPI)??[],[])?.market?.beta??null,cashKRW:p.cashKRW});}catch{return null;}}
  regimeState(){
    const pr=require('./portfolio-risk.cjs');const closes=this.indexCloses?.()??{};const macro=this.macro?.get?.()??null;const market=this.marketOverviewCache?.()??null;
    const ch=(c,k)=>c&&c.length>k?(c.at(-1).close/c.at(-1-k).close-1)*100:null;const series=id=>macro?.series?.find(s=>s.id===id);
    const kospi=closes.KOSPI??[];const sma50=kospi.length>=50?kospi.slice(-50).reduce((a,b)=>a+b.close,0)/50:null;const oil=series('US_WTI');const hy=series('US_HY_SPREAD');
    const oilHist=oil?.history??[];
    return pr.regime({vix:closes.VIX?.at(-1)?.close??series('US_VIX')?.value??null,vix5dChangePct:ch(closes.VIX,5),hySpread:hy?.value??null,hySpreadChange:hy?.change??null,advanceRatioPct:market?.breadth?.find(b=>b.index==='KOSPI')?.advanceRatioPct??null,kospiVs50dPct:sma50?(kospi.at(-1).close/sma50-1)*100:null,sox20dPct:ch(closes.SOX,20),oil20dPct:oilHist.length>=2?(oilHist.at(-1).value/oilHist[0].value-1)*100:null});
  }
  // Replays saved reviews with a change next to an unchanged baseline; no tools, no orders. Each call is metered.
  async replay(options={}){
    if(this.replaying)throw new Error('REPLAY_BUSY');const blocked=this.narrativeAvailable();if(blocked)throw new Error('REPLAY_UNAVAILABLE');
    const R=require('./replay.cjs');const instructions=typeof options.instructions==='string'?options.instructions.trim().slice(0,R.LIMITS.instructions):'';
    const variant={instructions,withoutNarrative:options.withoutNarrative===true,withoutEpisodes:options.withoutEpisodes===true,withoutRegime:options.withoutRegime===true};
    if(!variant.instructions&&!variant.withoutNarrative&&!variant.withoutEpisodes&&!variant.withoutRegime)throw new Error('REPLAY_NO_CHANGE');
    const limit=Math.max(1,Math.min(R.LIMITS.reviews,Number(options.limit)||6));const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;
    const reviews=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 400').all().map(r=>JSON.parse(r.payload));
    const picks=R.candidates({reviews,store:this.replays,events:this.loggedEvents?.()??[],from:day(options.from),to:day(options.to),limit});if(!picks.length)throw new Error('REPLAY_NOTHING');
    this.replaying=true;const id=R.newId();const modelConfig={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort};const models=require('./ai-models.cjs');
    const decide=async context=>{const reserve=models.reservation(modelConfig,context,{});const d=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(d)??{calls:0,reservedMicro:0};if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
      const callId=require('node:crypto').randomUUID();this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(d,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,d,JSON.stringify({reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'replay'}));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      try{const r=await this.provider.request('decision',{context,options:{...modelConfig,research:false}});require('./ai-accounting.cjs').settle(this.db,'ai_usage',d,callId,r,'completed');return r.decision;}catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',d,callId,error,'failed-or-uncertain');throw error;}};
    this.log(id,'Program','Replay',`Replaying ${picks.length} saved review${picks.length===1?'':'s'} with a change: ${[instructions&&'extra instructions',variant.withoutNarrative&&'without the narrative',variant.withoutEpisodes&&'without episodes',variant.withoutRegime&&'without the regime gauge and sizing'].filter(Boolean).join(', ')}. No orders are placed.`);
    try{
      const closes=this.indexCloses?.()??{};const rows=[];
      for(const pick of picks){
        const baseline=await decide(pick.context);const changed=await decide(R.applyVariant(pick.context,variant));
        for(const d of [baseline,changed])if(d?.symbol)await this.warmSeries([d.symbol]);
        const score=d=>R.outcome(d,pick.day,d?.symbol?this.series?.closes(d.symbol):null,/:/.test(d?.symbol??'')?closes.SPX:closes.KOSPI);
        rows.push({reviewId:pick.review.id,day:pick.day,approximate:pick.approximate,original:R.brief(pick.review.decision),baseline:{decision:R.brief(baseline),explanation:baseline?.explanation?.slice(0,400)??null,outcome:score(baseline)},variant:{decision:R.brief(changed),explanation:changed?.explanation?.slice(0,400)??null,outcome:score(changed)},changed:JSON.stringify(R.brief(baseline))!==JSON.stringify(R.brief(changed))});
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
      const headlineList=n.headlines([...this.newsEvents.list(300),...this.news.map(item=>({...item,symbols:[]}))]);
      const previous=this.narratives.latest();
      const context={today:seoulDate(),signals:signalList,headlines:headlineList.map(({url,...h})=>h),previousNarrative:previous?{asOf:new Date(previous.timestamp).toISOString(),drivers:previous.drivers.map(({id,kind,title,themes,since})=>({id,kind,title,themes,since}))}:null};
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
    const pick=(c,engine)=>({market:c.market??'KR',currency:c.currency,equity:c.equity,cash:c.cash,...(products(engine)?{products:products(engine)}:{}),...((c.market??'KR')==='US'&&!(c.cash>0)?{note:'No USD cash: U.S. purchases need USD in this account first.'}:{}),positions:Object.entries(c.positions??{}).map(([symbol,p])=>{const q=c.quotes?.find(x=>x.symbol===symbol);const value=q?q.price*p.quantity:null;return {symbol,name:c.universe?.find(u=>u.symbol===symbol)?.name??symbol,quantity:p.quantity,value,weightPct:value&&c.equity?Math.round(value/c.equity*1000)/10:null};})});
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
      const accounts=await this.scoutAccount();const usTradable=accounts.some(a=>a.market==='US'&&a.status!=='unavailable'&&a.cash>0);
      const context={today:seoulDate(),userGuidelines:this.config.guidelines||null,accounts,opportunitySet:{tradableMarkets:accounts.filter(a=>a.status!=='unavailable').map(a=>a.market),usStocksBuyable:usTradable,fxUSDKRW:this.fx?.()?.usdKRW??null,note:usTradable?'Both Korean and U.S. listings can be bought; compare them on the same footing.':'Only Korean listings can be bought now. Korean-listed ETFs give exposure to foreign indexes (S&P 500, Nasdaq, China, Japan), commodities (gold, oil), bonds and the dollar.'},watchlist:this.discovery.list().map(({symbol,name,source,reason,pinned})=>({symbol,name,source,reason,pinned})),previousPlan:previous?{asOf:new Date(previous.timestamp).toISOString(),...previous.plan}:null,macro:this.macro?.context()??null,news:this.newsContext()};
      // Feedback loop: open briefs from trading reviews, how earlier picks did, and the scout's own notes.
      const briefs=this.briefs.open(scope);if(briefs.length)context.briefs=briefs.map(b=>({id:b.id,asOf:new Date(b.timestamp).toISOString(),...(b.reason?{reason:b.reason}:{}),...(b.lookingFor?{lookingFor:b.lookingFor}:{}),...(b.avoid?{avoid:b.avoid}:{}),...(b.questions?{questions:b.questions}:{}),...(b.feedback?.length?{feedback:b.feedback}:{})}));
      const scorecard=this.scoutScorecard.context(scope,this.briefs.feedback(scope,0));if(scorecard)context.scorecard=scorecard;const deskNotes=this.desk.notes(scope).slice(0,15).map(n=>({symbol:n.symbol||null,note:n.note}));if(deskNotes.length)context.tradingNotes=deskNotes;const story=this.storyContext();if(story.marketNarrative)context.marketNarrative=story.marketNarrative;if(story.similarEpisodes?.length)context.similarEpisodes=story.similarEpisodes;const exposure=this.exposureState();if(exposure)context.portfolioExposure=exposure;const gauge=this.regimeState();if(gauge)context.marketRegime={regime:gauge.regime,score:gauge.score,components:gauge.components.map(({name,value,reading})=>({name,value,reading}))};const notes=this.scoutStore.retrospectives(scope);if(notes.length)context.retrospectives=notes;
      this.log(id,'Program',trigger==='User request'?'Scout run':'Scout run · '+trigger,'Researching the market to update the shortlist and the portfolio plan. The scout does not trade.');
      this.log(id,'Context','Supplied context',loggableContext(context));
      const modelConfig={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort==='none'?'low':this.config.reasoningEffort};
      const request=async({final,continuation})=>{
        const options={final,continuation,...modelConfig,maxBytes:160000};const models=require('./ai-models.cjs');
        const reserve=models.reservation(modelConfig,context,options);
        const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
        if(models.budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
        const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'scout'};
        this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
        try{const response=await this.provider.request('scout',{context,options:{final,continuation,...modelConfig}});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return response;}
        catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}
      };
      const tools={screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),get_company_research:args=>this.discovery.research(args),get_market_overview:()=>this.discovery.marketOverview?this.discovery.marketOverview():{status:'unavailable',reason:'MARKET_OVERVIEW_UNAVAILABLE'},
        update_watchlist:args=>{if(this.disposed||scope!==this.watchScope())throw new Error('STALE_DECISION');return this.discovery.update_watchlist(args);}};
      const result=await require('./scout.cjs').runScout({request,tools,log:(kind,title,body)=>this.log(id,kind,title,body)});
      if(this.disposed||scope!==this.watchScope())throw new Error('STALE_DECISION');
      const answered=this.briefs.answer(scope,result.plan.briefAnswers);
      const saved=this.scoutStore.save(scope,result.plan,{runId:id,trigger,model:result.model??modelConfig.openaiModel,usage:result.usage,rounds:result.rounds,answered});this.scoutScorecard.record(scope,result.plan,saved.timestamp);try{this.onScouted?.(result.plan,id);}catch{}
      this.log(id,'Agent','Scout plan',JSON.stringify(result.plan,null,2));this.log(id,'System','Review completed',JSON.stringify(result.usage));
      this.scoutError=null;return saved;
    }catch(error){this.scoutError=require('./ai-errors.cjs').publicCode(error)??(/^[A-Z_]{3,40}$/.test(error.message)?error.message:'SCOUT_FAILED');this.scoutErrorDetail=typeof error.detail==='string'?error.detail:null;this.log(id,'System','Scout failed',this.scoutError+(this.scoutErrorDetail?' · '+this.scoutErrorDetail:''));throw error;}
    finally{this.scouting=false;}
  }
  syncLearning(){try{this.outcomes.sync();this.memory.sync();this.reflections.sync();this.trials.observe(this.paper.getState().quotes,'paper');
      for(const [engine,quotes] of [[this.live,this.marketQuotes?.()??[]],[this.usLive,this.usQuotes??[]]]){if(engine){try{this.trials.observe(quotes,'broker',engine.identity());}catch(error){if(!['KIS_NOT_CONNECTED','ACCOUNT_CHANGED'].includes(error.message))throw error;}}}this.learningLastRun=Date.now();this.learningError=null;}catch{this.learningError='LOCAL_EVALUATION_FAILED';}}
  tick() {
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
    const deskDue=Date.now()-(this.lastDeskCheck??0)>=5000;if(deskDue)this.lastDeskCheck=Date.now();
    if(deskDue&&this.config.conditionalOrders&&this.config.enabled&&this.sessionArmed&&!this.firing&&this.config.scope!=='paper'){
      const scope=this.watchScope();const data=this.formulaData();const formula=require('./formula.cjs');
      for(const order of this.desk.orders(scope)){if(order.nextCheckAt>Date.now())continue;const check=formula.checkConditions(order.conditions,order.combine,data);if(check.met){this.firing=true;void this.fireConditional(order).catch(()=>{}).finally(()=>{this.firing=false;});break;}}
    }
    if(this.schedulerStatus().label!=='Monitoring')return;
    // Agent triggers: met conditions start a review with the values that met them.
    if(deskDue&&!this.busy&&this.config.scope!=='paper'&&Date.now()-this.lastRun>=60000){const hit=this.desk.checkTriggers(this.watchScope(),this.formulaData());if(hit){this.triggerEvidence={kind:'agent-trigger',trigger:{id:hit.trigger.id,name:hit.trigger.name,reason:hit.trigger.reason},results:hit.results};this.log(hit.trigger.id,'System','Agent trigger met',`${hit.trigger.name}: ${hit.results.map(r=>`${r.expr} = ${r.actual} (${r.op} ${r.value})`).join('; ')}`);void this.review('Agent trigger').catch(()=>{});return;}}
    const elapsed=Date.now()-this.lastRun;
    if(emergency.active){if((this.lastEmergencyAttempt??0)<this.emergencyStartedAt||elapsed>=60000){this.lastEmergencyAttempt=Date.now();void this.review('Emergency loss response').catch(()=>{});}return;}
    if(elapsed<60000)return;
    const quotes=this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):this.config.scope==='kis'?(this.marketQuotes?.()??[]):this.paper.getState().quotes;
    const scope=this.watchScope();if(this.lastWatchScope!==scope){this.lastPrices.clear();this.lastWatchScope=scope;}
    const drift=this.watches.detect(scope,quotes,this.lastPrices,this.config.eventTolerancePct);
    if(drift){this.triggerEvidence=drift;if(drift.kind==='price')this.watches.fired(scope,drift.symbol);}
    if(!drift&&this.config.newsTrigger!=='off'&&Date.now()-(this.lastNewsTrigger??0)>=600000){const pending=this.newsEvents.pending(this.config.newsTrigger);if(pending.length){this.lastNewsTrigger=Date.now();this.newsEvents.markTriggered(pending.map(event=>event.id));this.triggerEvidence={kind:'news',events:pending.slice(0,5).map(({title,source,published,symbols,importance})=>({title,source,published,symbols,importance}))};void this.review('News event trigger').catch(()=>{});return;}}
    // Near the daily AI budget, scheduled reviews run at twice the interval instead of stopping.
    const slow=this.config.provider==='openai'&&this.config.degradeNearBudget&&require('./token-saver.cjs').nearBudget(this.config,this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0})?2:1;
    if(elapsed>=this.reviewInterval.get(this.watchScope(),this.config).minutes*60000*slow||drift)void this.review(drift?'Price movement trigger':'Scheduled review').catch(()=>{});
  }
  approveLesson(id,approved){if(typeof id!=='string'||typeof approved!=='boolean')throw new Error('INVALID_REQUEST');this.syncLearning();if(this.learningError)throw new Error('LESSON_REVIEW_FAILED');const lifecycle=this.memory.lifecycle(id);if(lifecycle)this.memory.review(id,{expectedSignature:lifecycle.signature,action:approved?'approve':'retire'});else this.db.prepare('UPDATE lessons SET approved=? WHERE id=?').run(approved?1:0,id);return this.getState();}
}
module.exports={loggableContext,Automation,DEFAULTS};
