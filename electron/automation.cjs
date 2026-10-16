const {randomUUID}=require('node:crypto');const {seoulDate}=require('./kis-activity.cjs');
const DEFAULTS={unlimitedCalls:false,unlimitedBudget:false,reflectionUnlimitedCalls:false,reflectionUnlimitedBudget:false,autoReviewInterval:false,reflectionEnabled:false,reflectionCallsPerDay:5,reflectionUSDPerDay:1,enabled:false,autoSubmit:false,scope:'paper',shareKisWithAI:false,provider:'local',openaiModel:'gpt-6-luna',reasoningEffort:'none',intervalMinutes:10,eventTolerancePct:3,maxCallsPerDay:20,maxUSDPerDay:1,desktopAlerts:false,mobileAlerts:false,newsURL:'',guidelines:'',lossAction:'review',maxAutoOrdersPerDay:0,maxConsecutiveFailures:0,digestEnabled:false,digestHour:16};
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
    this.guardrails=new (require('./guardrails.cjs').Guardrails)(db);this.digest=new (require('./daily-digest.cjs').DailyDigest)(db);
    const row=db.prepare('SELECT payload FROM automation_settings WHERE id=1').get();this.config={...DEFAULTS,...(row?JSON.parse(row.payload):{})};this.sessionArmed=false;this.lastError=null;this.lastSuccess=0;this.savedAt=null;if(!row)this.saveConfig();
  }
  watchScope(){if(this.config.scope==='paper')return 'paper';try{return this.config.scope+':'+(this.live??this.usLive).identity();}catch{return this.config.scope+':disconnected';}}
  saveConfig(){this.db.prepare('INSERT INTO automation_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(this.config));}
  configure(value) {
    if(!value || Object.keys(value).some(key=>!Object.hasOwn(DEFAULTS,key)))throw new Error('INVALID_SETTINGS');
    const next={...this.config,...value};
    if(!['local','openai','external'].includes(next.provider)||!Number.isInteger(next.intervalMinutes)||next.intervalMinutes<1||next.intervalMinutes>1440||!Number.isFinite(next.eventTolerancePct)||next.eventTolerancePct<.1||next.eventTolerancePct>50||!Number.isInteger(next.maxCallsPerDay)||next.maxCallsPerDay<1||next.maxCallsPerDay>200||!Number.isFinite(next.maxUSDPerDay)||next.maxUSDPerDay<.01||next.maxUSDPerDay>100||typeof next.newsURL!=='string'||next.newsURL.length>1000||typeof next.guidelines!=='string'||next.guidelines.length>6000)throw new Error('INVALID_SETTINGS');
    if(!Number.isInteger(next.reflectionCallsPerDay)||next.reflectionCallsPerDay<1||next.reflectionCallsPerDay>200||!Number.isFinite(next.reflectionUSDPerDay)||next.reflectionUSDPerDay<.01||next.reflectionUSDPerDay>100)throw new Error('INVALID_SETTINGS');
    for(const key of ['unlimitedCalls','unlimitedBudget','reflectionUnlimitedCalls','reflectionUnlimitedBudget','autoReviewInterval','reflectionEnabled','enabled','autoSubmit','desktopAlerts','mobileAlerts'])if(typeof next[key]!=='boolean')throw new Error('INVALID_SETTINGS');
    if(!['paper','kis','us','both'].includes(next.scope)||typeof next.shareKisWithAI!=='boolean')throw new Error('INVALID_SETTINGS');
    require('./guardrails.cjs').validateGuardrails(next);
    require('./ai-models.cjs').settings(next);
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
  // One recorded event and alert per kind per Seoul day, except stops, which are always recorded.
  trip(kind,detail){
    const {seoulDate:today}=require('./kis-activity.cjs');
    if(kind!=='auto-stopped'&&this.guardrails.eventsOn(today()).some(event=>event.kind===kind)){this.log(randomUUID(),'Risk','Guardrail · '+kind,detail);return;}
    if(kind==='auto-stopped')require('./auto-launch.cjs').stop(this);
    const event=this.guardrails.record(kind,detail);this.log(event.id,'Risk','Guardrail · '+kind,detail);this.notify?.('guardrail:'+event.id,'Guardrail: '+detail);
  }
  getState(){this.syncLearning();return {guardrails:this.guardrails.state(this.config),digests:this.digest.list(),lessonTrials:this.trials.list(),reviewInterval:this.reviewInterval.get(this.watchScope(),this.config),reflections:this.reflections.state(),aiCalls:this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.payload)),learning:{...this.memory.summary(),lastRun:this.learningLastRun??null,error:this.learningError??null},watches:this.watches.list(this.watchScope()),outcomes:this.outcomes.list(),execution:this.executionState(),emergency:this.emergencyState(),config:this.config,sessionArmed:this.sessionArmed,savedAt:this.savedAt,heartbeat:Date.now(),scheduler:this.schedulerStatus(),lastAttempt:this.lastRun||null,lastSuccess:this.lastSuccess||null,lastError:this.lastError,lastErrorDetail:this.lastErrorDetail??null,nextReview:this.config.enabled&&this.sessionArmed?Math.max(Date.now(),this.lastRun+Math.max(60000,this.emergencyState().active?60000:this.reviewInterval.get(this.watchScope(),this.config).minutes*60000)):null,providerStatus:this.providerStatus,busy:this.busy,news:this.news,newsUpdatedAt:this.newsUpdatedAt??null,newsError:this.newsError,reviews:this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 50').all().map(row=>JSON.parse(row.payload)),lessons:this.memory.list(),usage:this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0}};}
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
    return {environment:'local-paper',paperVersion:state.account.version,equity:state.account.equity,cash:state.account.availableCash,positions:state.account.positions,universe:state.universe,quotes:state.quotes,orders:state.orders.filter(order=>['Pending','Partially filled'].includes(order.status)).map(({symbol,side,quantity,filled,status})=>({symbol,side,quantity,filled,status})),risk:state.policy,news:this.news.slice(0,10).map(({title,published,source})=>({title,published,source})),reviewedLessons:this.db.prepare('SELECT text FROM lessons WHERE approved=1 ORDER BY rowid DESC LIMIT 5').all().map(row=>row.text)};
  }
  async review(trigger='User request',externalDecision) {
    if(this.busy)throw new Error('REVIEW_BUSY');this.busy=true;const id=randomUUID();let context;let stage='Account data';const revision=this.revision;const watchScope=this.watchScope();const costRevision=JSON.stringify(this.costs?.get());
    try {
      let usValue;let execution=this.config.scope==='us'?this.usLive:this.live;
      if(this.config.scope!=='paper') {
        if(this.config.scope==='us'||this.config.scope==='both')usValue=await this.refreshUS();
        if(externalDecision)throw new Error('EXTERNAL_KIS_DISABLED');
        if(this.config.provider==='openai'&&!this.config.shareKisWithAI)throw new Error('DATA_SHARING_NOT_ENABLED');
        if(this.config.scope==='both'){const kr=await this.live.context(),us=await this.usLive.context(usValue);kr.tradingCosts=this.costs?.context('KR',kr.universe,kr.positions);us.tradingCosts=this.costs?.context('US',us.universe,us.positions);context=require('./combined-context.cjs').combinedContext(kr,us,this.fx?.(),this.metadata?.());}else context=await execution.context(this.config.scope==='us'?usValue:null);context.news=this.news.slice(0,10).map(({title,published,source})=>({title,published,source}));context.reviewedLessons=this.db.prepare('SELECT text FROM lessons WHERE approved=1 ORDER BY rowid DESC LIMIT 5').all().map(row=>row.text);
      }else context=this.context();
      stage='Local trade evidence';this.outcomes.sync();this.memory.sync();const accounts=[this.live,this.usLive].flatMap(engine=>{try{return [engine.identity()];}catch{return [];}});context.reviewedLessons=this.memory.relevant(context,accounts);
      stage='Portfolio context';const emergency=context.environment==='kis'?{...this.emergencyState(),active:false,loss:null}:this.emergencyState();
      if(context.environment==='kis'){const policy=context.risk;const {lossStatus}=require('./loss-policy.cjs');emergency.loss=lossStatus(policy.lossLimit??{mode:'amount',value:policy.maxDailyLossKRW},policy.baseline,context.equity);emergency.active=emergency.loss.breached;}
      context.tradingCosts=context.environment==='kis-combined'?{markets:context.markets.map(row=>({market:row.market,...row.tradingCosts}))}:context.environment==='local-paper'?{basis:'simulation',currency:'KRW',commissionPct:.1,slippagePct:.1,saleTaxPct:0,capitalGainsTax:'Not modeled in the local paper simulator. Live trading uses your fee and tax settings.'}:this.costs?.context(context.market??'KR',context.universe,context.positions);context.emergency=emergency;context.userGuidelines=this.config.guidelines;const peak=context.environment==='local-paper'?(this.paper.account().dayPeakEquity??this.paper.account().dayBaseline):(context.environment==='kis-combined'?null:context.risk.dayPeakEquity??context.risk.baseline);context.performance={dailyBaseline:emergency.loss?.baseline??null,observedDailyPeak:peak,currentEquity:context.equity,drawdownFromObservedPeakPct:peak>0?Math.max(0,(peak-context.equity)/peak*100):null};
      context.reviewInterval=this.reviewInterval.get(watchScope,this.config);
      context.reviewWatches=this.watches.list(watchScope).map(({baseline,...watch})=>watch);if(context.environment!=='local-paper'&&this.discovery)context.discovery={enabled:true,watchlist:this.discovery.list().map(({symbol,name,source,reason})=>({symbol,name,source,reason}))};if(trigger==='Price movement trigger')context.triggerEvidence=this.triggerEvidence;
      this.observeEmergency(emergency);if(emergency.active)this.lastEmergencyAttempt=Date.now();
      this.log(id,'Program',trigger,context.environment!=='local-paper'?'Reviewing permitted KIS portfolio data. Credentials are excluded.':'Reviewing the local paper portfolio. KIS account data and credentials are excluded.');
      this.log(id,'Context','Supplied context',JSON.stringify(context,null,2));
      let result;
      if(externalDecision){const {validateDecision}=require('./ai-client.cjs');result={decision:validateDecision(externalDecision,context.universe.map(row=>row.symbol)),provider:'external'};}
      else if(this.config.provider==='openai') {
        if(!this.providerStatus.aiConnected)throw new Error('AI_NOT_CONNECTED');
        stage='AI research and decision';result=await require('./research-review.cjs').researchReview({context,evidence:this.evidence,discovery:context.discovery?.enabled?{screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.discovery.update_watchlist(args);}}:null,setInterval:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.reviewInterval.set(watchScope,args,this.config);},setWatch:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.watches.set(watchScope,args,context);},log:(kind,title,body)=>this.log(id,kind,title,body),request:async options=>{
          if(this.disposed||watchScope!==this.watchScope()||revision!==this.revision||costRevision!==JSON.stringify(this.costs?.get()))throw new Error('STALE_DECISION');
          const modelConfig={openaiModel:this.config.openaiModel,reasoningEffort:this.config.reasoningEffort};options={...options,...modelConfig};
          const reserve=require('./ai-models.cjs').reservation(modelConfig,context,options);
          const day=seoulDate(),usage=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
          if(require('./ai-models.cjs').budgetExceeded(this.config,usage,reserve))throw new Error('AI_BUDGET_EXHAUSTED');
          const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now()};
          this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(record));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
          try{const response=await this.provider.request('decision',{context,options});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return {...response,model:response.model??modelConfig.openaiModel};}
          catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}

        }});
      } else if(this.config.provider==='external')throw new Error('EXTERNAL_DECISION_REQUIRED');
      else result={decision:this.localDecision(context),provider:'local'};
      if(this.disposed)return;if(watchScope!==this.watchScope()||revision!==this.revision||costRevision!==JSON.stringify(this.costs?.get()))throw new Error('STALE_DECISION');
      stage='Decision recording and execution';if(result.model)this.log(id,'System','Model used',result.model+' · '+this.config.reasoningEffort);
      this.log(id,'Agent','Decision',JSON.stringify(result.decision,null,2));
      const contextEvidence={guidelines:this.config.guidelines,environment:context.environment,marketSession:context.marketSession??null,quote:context.quotes.find(q=>q.symbol===result.decision.symbol)??null,position:context.positions?.[result.decision.symbol]??null,emergency:context.emergency.active,reviewedLessons:context.reviewedLessons};
      const recorded={model:result.model??null,contextEvidence,id,timestamp:Date.now(),scope:this.config.scope,trigger,provider:result.provider,decision:result.decision,proposalId:null,orderId:null,usage:result.usage??null};
      this.db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify(recorded));
      let proposal=null,order=null,executionNote=null;
      if(result.decision.action!=='Hold') {
        if(context.environment==='kis-combined')execution=/^\d{6}$/.test(result.decision.symbol)?this.live:this.usLive;
        if(context.environment==='local-paper'&&context.paperVersion!==this.paper.account().version)throw new Error('STALE_DECISION');
        const selected=context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market):context;
        const lossBreached=context.environment==='kis-combined'?(context.emergency.activeMarkets??[]).includes(execution.market):Boolean(context.emergency.active);
        if(result.decision.action==='Buy'&&lossBreached&&this.config.lossAction!=='review'){executionNote='Guardrail: new buys are blocked after the daily loss limit. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys blocked',executionNote);this.trip('buys-blocked',`Blocked a ${result.decision.symbol} buy after the daily loss limit was reached.`);}
        else if(context.environment!=='local-paper'&&(selected?.executionEnabled===false||!execution.enabled)){executionNote=(execution.market==='US'?'U.S.':'Korea')+' trading session is off. Recommendation recorded; no order proposal or submission was made.';this.log(id,'System','Review only · execution off',executionNote);}else{
        proposal=context.environment!=='local-paper'?execution.propose({symbol:result.decision.symbol,side:result.decision.action,quantity:result.decision.quantity,limitPrice:(context.currency==='USD'||execution?.market==='US')?(result.decision.action==='Buy'?Math.ceil:Math.floor)(context.quotes.find(row=>row.symbol===result.decision.symbol).price*100)/100:context.quotes.find(row=>row.symbol===result.decision.symbol).price}):this.paper.propose({symbol:result.decision.symbol,side:result.decision.action,quantity:result.decision.quantity});
        this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify({...recorded,proposalId:proposal.id}),id);
        this.log(id,'Risk','Proposal result',proposal.reason??'Paper risk checks passed.');
        const autoEligible=this.config.autoSubmit && (context.environment==='local-paper'||execution.autoEnabled!==false) && proposal.status==='Ready' && (context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market)?.marketSession.open===true:context.marketSession?.open!==false);
        const orderCap=this.config.maxAutoOrdersPerDay;
        if(autoEligible&&orderCap>0&&this.guardrails.autoOrdersToday()>=orderCap){executionNote=`Guardrail: the daily limit of ${orderCap} automatic orders is reached. Proposal awaits manual approval.`;this.log(id,'System','Guardrail · order limit',executionNote);this.trip('order-limit',`Daily automatic order limit (${orderCap}) reached; later proposals need approval.`);}
        else if(autoEligible) {order=context.environment!=='local-paper'?await execution.autoSubmit(proposal.id):this.paper.submit(proposal.id);this.log(id,'Tool','Order submission',JSON.stringify(order));}
        if(proposal?.reason)this.db.prepare('INSERT INTO lessons(id,text) VALUES(?,?)').run(randomUUID(),`Candidate lesson: avoid proposals blocked by ${proposal.reason}. Review freshness, reservations and configured limits before retrying.`);
        if(context.environment!=='local-paper'&&this.config.autoSubmit&&execution.autoEnabled===false){executionNote=(execution.market==='US'?'U.S.':'Korea')+' automatic execution is off. Proposal awaits manual approval.';this.log(id,'System','Approval required',executionNote);}}

      }
      const review={model:result.model??null,contextEvidence,id,scope:this.config.scope,timestamp:Date.now(),trigger,provider:result.provider,emergency:context.emergency.active,marketSession:context.marketSession?.status??null,decision:result.decision,executionNote,proposalId:proposal?.id??null,orderId:order?.id??null,usage:result.usage??null};
      this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify(review),id);
      this.lastRun=Date.now();this.lastSuccess=this.lastRun;this.guardrails.succeeded();this.lastError=null;this.lastErrorDetail=null;this.lastPrices=new Map(context.quotes.map(row=>[row.symbol,row.price]));this.watches.rebase(watchScope,context.quotes);this.lastWatchScope=watchScope;this.log(id,'System','Review completed',result.usage?JSON.stringify(result.usage):'No provider tokens used.');return review;
    }catch(error){this.lastRun=Date.now();this.lastError=require('./ai-errors.cjs').publicCode(error)??(['AI_NOT_CONNECTED','AI_BUDGET_EXHAUSTED','EXTERNAL_DECISION_REQUIRED','PROVIDER_REQUEST_FAILED','AI_REQUEST_FAILED','DATA_SHARING_NOT_ENABLED','KIS_TRADING_DISABLED','STALE_DECISION','SESSION_CLOSED','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','FEATURE_UNAVAILABLE','INCOMPLETE_BALANCE'].includes(error.message)?error.message:'REVIEW_FAILED');this.lastErrorDetail=require('./ai-errors.cjs').detail(this.lastError,stage,error);if(!this.disposed){this.log(id,'System','Review failed',this.lastError+' · '+this.lastErrorDetail);const streak=this.guardrails.failed(),limit=this.config.maxConsecutiveFailures;if(limit>0&&streak>=limit&&(this.config.enabled||this.config.autoSubmit))this.trip('auto-stopped',`Auto trading stopped after ${streak} consecutive failed reviews (latest: ${this.lastError}).`);}throw new Error('REVIEW_FAILED');}
    finally{this.busy=false;}
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
    if(this.schedulerStatus().label!=='Monitoring')return;
    const elapsed=Date.now()-this.lastRun;
    if(emergency.active){if((this.lastEmergencyAttempt??0)<this.emergencyStartedAt||elapsed>=60000){this.lastEmergencyAttempt=Date.now();void this.review('Emergency loss response').catch(()=>{});}return;}
    if(elapsed<60000)return;
    const quotes=this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):this.config.scope==='kis'?(this.marketQuotes?.()??[]):this.paper.getState().quotes;
    const scope=this.watchScope();if(this.lastWatchScope!==scope){this.lastPrices.clear();this.lastWatchScope=scope;}
    const drift=this.watches.detect(scope,quotes,this.lastPrices,this.config.eventTolerancePct);
    if(drift){this.triggerEvidence=drift;if(drift.kind==='price')this.watches.fired(scope,drift.symbol);}
    if(elapsed>=this.reviewInterval.get(this.watchScope(),this.config).minutes*60000||drift)void this.review(drift?'Price movement trigger':'Scheduled review').catch(()=>{});
  }
  approveLesson(id,approved){if(typeof id!=='string'||typeof approved!=='boolean')throw new Error('INVALID_REQUEST');this.syncLearning();if(this.learningError)throw new Error('LESSON_REVIEW_FAILED');const lifecycle=this.memory.lifecycle(id);if(lifecycle)this.memory.review(id,{expectedSignature:lifecycle.signature,action:approved?'approve':'retire'});else this.db.prepare('UPDATE lessons SET approved=? WHERE id=?').run(approved?1:0,id);return this.getState();}
}
module.exports={Automation,DEFAULTS};
