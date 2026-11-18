const {randomUUID}=require('node:crypto');
// Order statuses that start a review when an order changes into them, statuses of an order still waiting at the broker,
// and how long routine reviews may wait for a pending order.
const ORDER_EVENTS=['Filled','Partially filled','Canceled','Rejected'],PENDING_ORDER=['Accepted','Partially filled'],ORDER_BACKSTOP_MS=120*60000,EVENT_RETRY_MS=5*60000,BATCH_LIMIT_MS=5*60000,ORDERS_PER_REVIEW_MAX=22,NEW_ORDER_WAIT_MS=30*60000,UNIVERSE_PER_MARKET=20,EVIDENCE_TRIGGERS=['Price movement trigger','News event trigger','Agent trigger','Order update'];const {seoulDate}=require('./kis-activity.cjs');
// creditProtectionApproved: the user approved Stage 3 (audit 2026-11-04); until then no credit close is automatic.
const DEFAULTS={alertTrial:'off',notHeldPriceReviews:'default',researchSuppression:'off',creditProtectionApproved:false,unlimitedCalls:false,unlimitedBudget:false,reflectionUnlimitedCalls:false,reflectionUnlimitedBudget:false,autoReviewInterval:false,reflectionEnabled:false,reflectionCallsPerDay:5,reflectionUSDPerDay:1,enabled:false,autoSubmit:false,scope:'paper',shareKisWithOpenAI:false,shareKisWithAnthropic:false,anthropicCallsPerDay:10,anthropicUSDPerDay:1,anthropicUnlimitedCalls:false,anthropicUnlimitedBudget:false,provider:'local',openaiModel:'gpt-6-luna',reasoningEffort:'none',intervalMinutes:10,eventTolerancePct:3,maxCallsPerDay:20,maxUSDPerDay:1,desktopAlerts:false,mobileAlerts:false,closedMarketReviews:'pre-open',sessionKrNxt:false,sessionUsPre:false,sessionUsAfter:false,sessionUsDaytime:false,extendedMaxOrderPct:5,phoneSnapshots:true,phoneAmounts:true,newsURL:'',guidelines:'',lossAction:'review',maxAutoOrdersPerDay:0,maxConsecutiveFailures:0,digestEnabled:false,digestHour:16,newsTrigger:'disclosures',watchlistAlerts:'observe',reviewGate:'observe',routineReviews:'full',orderTracking:true,orderUpdateReviews:false,watchlistMovePct:null,skipUnchanged:true,maxSkipMinutes:120,routineModel:'gpt-6-luna',routineEffort:'none',degradeNearBudget:true,scoutEnabled:false,scoutAiRequests:true,newsFeeds:[],kisNews:true,usTickerNews:true,narrativeEnabled:true,sizingRiskPct:1,sizingAtrMultiple:2,ordersPerReview:1,severalOpenOrders:false,...require('./agent-desk.cjs').COND_DEFAULTS,...require('./agent-models.cjs').AGENT_DEFAULTS,...require('./scout-timing.cjs').TIMING_DEFAULTS};
// Settings that no longer exist: accepted from a saved profile or the window and ignored. sessionKrxSingle switched on
// the KRX after-hours single-price auction, which KRX ended on 2026-09-14 (fact check X1).
// Shadow evaluation and complexity routing were removed on 2026-11-12 (step A1, artifacts/reviews/2026-11-12-engine-settings):
// their saved values are ignored. routineModel and routineEffort stay: they are the context-compacting model.
const LEGACY_SETTINGS=['shareKisWithAI','scoutSchedule','sessionKrxSingle','modelRouting','complexityThreshold','spotCheckPct','lunaMaxRuns','lunaMaxMinutes','shadowEvaluation','shadowPct','shadowUSDPerDay'];
const LOG_LIMIT=30000;
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
    conditionalOrders:co?{allowed:Boolean(co.allowed),monitoring:co.monitoring??null,armed:(co.armed??[]).map(o=>({symbol:o.symbol,side:o.side,quantity:o.quantity,conditions:o.conditions,expires:o.expires,...(o.trail?{trail:{level:o.trail.level,high:o.trail.high,floor:o.trail.floor}}:{})}))}:null,
    performance:{KR:perf('KR'),US:perf('US')}};
}
// The symbols that started a review and the symbols it assessed: those, its verdicts and decision, and holdings
// (audit 2026-11-04, Stage 5), so observation episodes can be linked to the reviews that actually looked at them.
// The validation snapshot of a review (release review 2026-11-05, P1): the full position memory and quotes, taken from
// the review context before it is compressed for the prompt, and checked again at the execution boundary.
function validationOf(context){return {positionMemory:Array.isArray(context?.positionMemory)?structuredClone(context.positionMemory):null,quotes:structuredClone(context?.quotes??[])};}
function reviewSymbols(context,decision){const t=context?.triggerEvidence;const trigger=[...new Set([t?.symbol,...(t?.symbols??[]),...(t?.alerts??[]).map(a=>a?.symbol),...(t?.alongside??[]).map(a=>a?.symbol),...(t?.events??[]).flatMap(e=>[e?.symbol,...(e?.symbols??[])])].filter(s=>typeof s==='string'&&s))];
  const held=Object.entries(context?.positions??{}).filter(([,p])=>p?.quantity>0).map(([s])=>s);
  return {triggerSymbols:trigger,assessed:[...new Set([...trigger,...(decision?.planVerdicts??[]).map(v=>v.symbol),decision?.symbol,...held].filter(s=>typeof s==='string'&&s))]};}
// Release B, step B1 (artifacts/reviews/2026-11-12-engine-settings/b1-design.md): data sharing and daily limits per AI
// provider. A profile saved before B1 had one switch, shareKisWithAI, given for OpenAI (its hint said "sent to
// OpenAI"): it becomes the OpenAI switch; the Anthropic one starts off.
function providerConsent(saved){if(!saved||typeof saved!=='object'||!Object.hasOwn(saved,'shareKisWithAI')||Object.hasOwn(saved,'shareKisWithOpenAI'))return {};return {shareKisWithOpenAI:saved.shareKisWithAI===true,shareKisWithAnthropic:false};}
// The daily limits of one provider, in the shape budgetExceeded and nearBudget read. OpenAI keeps the keys every profile
// already has (maxCallsPerDay, maxUSDPerDay and their No limit switches).
// Claude trading D-1: 1.5.60's publish time. A Claude dry run from before it used older request forms (review.md).
const CLAUDE_FORMS_SINCE=Date.parse('2026-11-15T11:36:26Z');
const versionAtLeast=(v,min)=>{const a=String(v).split('.').map(Number),b=String(min).split('.').map(Number);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);}return true;};
function vendorLimits(config,vendor){return vendor==='anthropic'?{maxCallsPerDay:config.anthropicCallsPerDay,maxUSDPerDay:config.anthropicUSDPerDay,unlimitedCalls:config.anthropicUnlimitedCalls,unlimitedBudget:config.anthropicUnlimitedBudget}:{maxCallsPerDay:config.maxCallsPerDay,maxUSDPerDay:config.maxUSDPerDay,unlimitedCalls:config.unlimitedCalls,unlimitedBudget:config.unlimitedBudget};}
const VENDOR_NAMES={openai:'OpenAI',anthropic:'Anthropic'};
// B3 review F1: the reason a Claude agent does not run on an account with no completed Claude dry run.
const CLAUDE_GATE_REASON='Run one dry run on Claude on this account first';
// B2: the measurement of one dry run, from its own AI call records: per request, the kind (dry-run or compact), model,
// status, stop reason, tokens (cache read and write apart), service tier, reserved and settled cost and sizes; and the
// totals. Built for GPT and Claude runs alike; a record made before B2 has no block and still opens.
// The app's own rule for an answer it did not accept (short gate 1.5.56, note 2): the rule text of fail(rule) in the
// clients and of the validators, as the provider worker forwards it (decisionDetail), with the answer's stop reason.
// Kept on the failed dry-run record for the Dry-run panel only; the dry run logs no line with it. The only rule that
// quotes the answer is checkDecision's "unexpected <field names>" (up to six names of 30 characters); control
// characters are removed and the whole rule is cut to 200 characters.
const ANSWER_CODES=['INVALID_AI_RESPONSE','AI_OUTPUT_LIMIT','AI_REFUSED'];
function answerRule(error){if(!ANSWER_CODES.includes(error?.message))return null;const d=error?.detail&&typeof error.detail==='object'?error.detail:null;
  const clean=(v,n)=>String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
  const rule=typeof d?.rule==='string'&&d.rule.trim()?clean(d.rule,200):typeof error?.detail==='string'&&error.detail.trim()?clean(error.detail,200):null;
  const stop=typeof error?.stopReason==='string'?error.stopReason:typeof d?.status==='string'?d.status:null;
  return rule||stop?{code:error.message,...(rule?{rule}:{}),...(stop?{stopReason:clean(stop,30).replace(/[^a-z_ ]/g,'')}:{})}:null;}
// The first refused call of a review (ai-accounting.cjs settle keeps providerError on it), for the dry-run record.
function firstRefusal(db,reviewId){try{for(const r of db.prepare('SELECT payload FROM ai_calls ORDER BY rowid').all()){const p=JSON.parse(r.payload);if(p.reviewId===reviewId&&p.providerError)return p.providerError;}}catch{}return null;}
function dryRunMeasurement(db,reviewId){
  try{const rows=db.prepare('SELECT payload FROM ai_calls ORDER BY rowid').all().map(r=>JSON.parse(r.payload)).filter(p=>p.reviewId===reviewId);
    const usd=m=>m==null?null:Math.round(m)/1e6;const requests=rows.map((p,i)=>({request:i+1,kind:p.kind??'review',model:p.model??null,status:p.status??null,stopReason:p.stopReason??null,
      inputTokens:p.usage?.inputTokens??null,outputTokens:p.usage?.outputTokens??null,cacheReadTokens:p.usage?.cachedTokens??null,cacheWriteTokens:p.usage?.cacheWriteTokens??null,serviceTier:p.usage?.serviceTier??null,
      reservedUSD:usd(p.reservedMicro),costUSD:usd(p.accountedMicro??p.estimatedMicro),requestBytes:p.requestSizes?.totalBytes??null,responseChars:p.responseChars??null,...(p.answerForm?{answerForm:p.answerForm}:{}),...(p.formFallback?{formFallback:true}:{}),...(p.textPartsDropped?{textPartsDropped:p.textPartsDropped}:{}),...(p.droppedThinking?{droppedThinking:p.droppedThinking}:{})}));
    const sum=k=>requests.reduce((n,r)=>n+(Number.isFinite(r[k])?r[k]:0),0);
    return {requests,totals:{requests:requests.length,inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),cacheReadTokens:sum('cacheReadTokens'),cacheWriteTokens:sum('cacheWriteTokens'),reservedUSD:Math.round(sum('reservedUSD')*1e6)/1e6,costUSD:Math.round(sum('costUSD')*1e6)/1e6}};}
  catch{return null;}
}
// M-5 (e): the review record's further orders (m5-plan.md section 6; M-6 shapes it): one row per further order sent from
// a batch, in item order, with what became of it. The first order keeps today's proposalId, orderId and executionNote.
function furtherOrderRows(rows){return rows.filter(r=>r.item>0).sort((a,b)=>a.item-b.item).map(r=>({item:r.item,symbol:r.symbol,action:r.action,quantity:r.quantity,
  proposalId:r.proposal?.id??null,orderId:r.order?.id??null,executionNote:r.executionNote??null,outcome:r.outcome??null,
  // M-6 part 3: the engine's status and reason of the order, as for the first (orderOutcome), synced when it leaves unclear.
  ...(r.order?{orderOutcome:{status:r.order.status??null,reason:r.order.reason??null}}:{})}));}
// An opening whose stop is not on the losing side of the current price (below for a long, above for a short; Stage 3):
// {side, q, eff}, else null. Covers and repayments need no stop. One function for the first order and each further one.
function stopSideGap(decision,context){
  const eff=(()=>{try{return decision.action==='Hold'?null:require('./credit-paths.cjs').effectOf({side:decision.action,credit:decision.credit});}catch{return null;}})();
  if(!eff?.opening||!decision.plan)return null;const q=context.quotes?.find(r=>r.symbol===decision.symbol);const side=require('./credit-paths.cjs').stopSide(eff.effect);
  return q?.price>0&&!(side==='below'?decision.plan.stopPrice<q.price:decision.plan.stopPrice>q.price)?{side,q,eff}:null;}
class Automation {
  constructor(db,paper,provider,log) {
    this.db=db;this.paper=paper;this.provider=provider;this.log=log;this.providerStatus={aiConnected:false,openaiConnected:false,anthropicConnected:false,dartConnected:false,pushConnected:false};this.news=[];this.newsError=null;this.busy=false;this.lastRun=0;this.lastPrices=new Map();this.usVenues=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS ai_usage_vendor(day TEXT NOT NULL,vendor TEXT NOT NULL,calls INTEGER NOT NULL,reservedMicro INTEGER NOT NULL,PRIMARY KEY(day,vendor))');db.exec('CREATE TABLE IF NOT EXISTS dry_runs(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL)');db.exec('CREATE TABLE IF NOT EXISTS review_clock(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)');db.exec('CREATE TABLE IF NOT EXISTS automation_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,text TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS ai_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL,reservedMicro INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS reviewed_fills(id TEXT PRIMARY KEY);');
    db.exec('CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS claude_trading_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');// Claude trading D-3 (review F1: created once)
    this.reviewInterval=new (require('./review-interval.cjs').ReviewInterval)(db);
    this.watches=new (require('./review-watches.cjs').ReviewWatches)(db);
    this.outcomes=new (require('./outcome-ledger.cjs').OutcomeLedger)(db);this.memory=new (require('./learning-memory.cjs').LearningMemory)(db);try{this.memory.proposeProcedural();}catch{}this.alertTrial=new (require('./alert-trial.cjs').AlertTrial)(db);
    this.trials=new (require('./lesson-trials.cjs').LessonTrials)(db,this.memory);
    this.reflections=new (require('./reflection.cjs').ReflectionQueue)(db,this.memory);
    // Observation only: records when event-driven scheduling would run beside the current schedule; changes nothing.
    this.scheduleObserver=new (require('./schedule-observer.cjs').ScheduleObserver)(db);this.scheduleObserver.tag=()=>this.alertTag();
    this.researchGaps=new (require('./research-gaps.cjs').ResearchGaps)(db);
    {const W=require('./watch-alerts.cjs');this.watchAlerts=new W.WatchAlerts();this.entryLevels=new W.WatchAlerts();this.alertObservations=new W.AlertObservations(db);}this.reviewGate=new (require('./review-gate.cjs').ReviewGate)(db);this.waits=new (require('./waits.cjs').Waits)(db);this.pending=new (require('./pending-decisions.cjs').PendingDecisions)(db);this.assessments=new (require('./assessments.cjs').Assessments)(db);
    this.scoreboard=new (require('./scoreboard.cjs').Scoreboard)(db,Date.now,()=>{try{return this.live?.identity()??null;}catch{return null;}});this.guardrails=new (require('./guardrails.cjs').Guardrails)(db);this.newsEvents=new (require('./news-events.cjs').NewsEvents)(db);this.digest=new (require('./daily-digest.cjs').DailyDigest)(db);this.scoutStore=new (require('./scout.cjs').ScoutStore)(db);const feedback=require('./scout-feedback.cjs');this.briefs=new feedback.BriefStore(db);this.scoutScorecard=new feedback.ScoutScorecard(db,this.scoreboard);this.desk=new (require('./agent-desk.cjs').AgentDesk)(db);this.desk.onError=(title,message)=>this.log(randomUUID(),'System',title,message);this.desk.sellStatus=o=>{const id=o.orderId??o.proposalId;return id?this.engineOrders().find(r=>r.id===id)?.status??null:null;};this.desk.sellOrder=o=>{const id=o.orderId??o.proposalId;return id?this.engineOrders().find(r=>r.id===id)??null:null;};this.narratives=new (require('./narrative.cjs').NarrativeStore)(db);this.replays=new (require('./replay.cjs').ReplayStore)(db);this.contextFailures=new (require('./context-failures.cjs').ContextFailures)(db);this.episodes=new (require('./episodes.cjs').EpisodeLibrary)(db);db.exec('CREATE TABLE IF NOT EXISTS narrative_slots(id INTEGER PRIMARY KEY CHECK(id=1),slot TEXT NOT NULL)');
    const row=db.prepare('SELECT payload FROM automation_settings WHERE id=1').get();const saved=row?JSON.parse(row.payload):{};this.config={...DEFAULTS,...saved,...(require('./scout-timing.cjs').migrate(saved)??{}),...providerConsent(saved)};for(const k of LEGACY_SETTINGS)delete this.config[k];this.sessionArmed=false;this.lastError=null;this.lastSuccess=0;this.savedAt=null;if(!row)this.saveConfig();
  }
  // The account a review or console entry belongs to: the paper account, or the connected KIS account (its hashed identity).
  accountTag(){if(this.config.scope==='paper')return {key:'paper',label:'Paper'};try{const key=this.live?.identity();if(!key)return null;const env=this.live.getConnection?.()?.snapshot?.environment;return {key,label:env==='live'?'KIS live':env==='mock'?'KIS mock':'KIS'};}catch{return null;}}
  // Parts of getState() that only read stored history (lag fix L1, artifacts/reviews/2026-11-10-lag): reused while
  // nothing was written through the app's database connection (SQLite total_changes(), which counts every row any
  // INSERT, UPDATE or DELETE on it changed), the settings revision and the account scope are the same, and it is the
  // same clock minute (time windows such as 'the last 7 days' and 'today' move at most a minute late). All writes go
  // through this one connection (storage.cjs). stateCacheOff turns it off (tests compare both).
  // PRAGMA data_version changes when another connection commits to the file (CPU fix F1 follow-on: total_changes() sees
  // only this connection's writes; a per-second paper save used to hide that; the desktop fixtures write directly).
  // The learning sync's key (lag fix L1): the database's change count and the clock minute, read after the sync so its
  // own writes do not cause a second run.
  learningKey(){try{return `${(this.totalChanges??=this.db.prepare('SELECT total_changes() AS n')).get().n}|${Math.floor(Date.now()/60000)}|${(this.dataVersion??=this.db.prepare('PRAGMA data_version')).get().data_version}`;}catch{return null;}}
  // The key the cached history reads share (L1); also sent to the window as historyVersion (L2b), so Journal and News
  // fetch the 1.6 MB history again only when it can have changed. null when the change count cannot be read.
  historyVersion(){try{return `${(this.totalChanges??=this.db.prepare('SELECT total_changes() AS n')).get().n}|${this.revision??0}|${this.watchScope()}|${Math.floor(Date.now()/60000)}|${(this.dataVersion??=this.db.prepare('PRAGMA data_version')).get().data_version}`;}catch{return null;}}
  stateCached(name,fn){if(this.stateCacheOff)return fn();const key=this.historyVersion();if(key==null)return fn();const cache=this.stateCache??=new Map();const hit=cache.get(name);if(hit&&hit.key===key)return hit.value;
    const value=fn();cache.set(name,{key,value});return value;}
  reviewHistory(limit=50,all=false){const key=all?null:this.accountTag()?.key;return (key?this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.account.key')=? ORDER BY rowid DESC LIMIT ?").all(key,limit):this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT ?').all(limit)).map(row=>{const r=this.syncOrderOutcome(JSON.parse(row.payload));return Array.isArray(r?.orders)?{...r,allOrders:require('./review-orders.cjs').ordersOfReview(r).map(({decision:_,...o})=>o)}:r;});}
  // M-6 part 0 (F1): a review's orderOutcome is written when the review is recorded. An order unclear then (Uncertain,
  // Submitting) that later leaves that state (you linked it, marked it not placed, or the order history resolved it)
  // updates its review here, so the Journal stops saying "Unclear: check KIS". Read from the engines' own order records;
  // runs whenever the reviews are read for the window (any order change is a database write, which renews that cache).
  // M-6 part 3: the same for each further order's row in orders. The window also gets allOrders, every order of the
  // review (review-orders.cjs ordersOfReview), computed here and not stored.
  syncOrderOutcome(review){if(!review||typeof review!=='object')return review;const UNCLEAR=['Uncertain','Submitting'];
    const engineOrder=id=>{for(const engine of [this.live,this.usLive]){try{const o=engine?.orders?.().find(x=>x.id===id);if(o)return o;}catch{}}return null;};
    const fresh=(id,o)=>{if(!id||!o||!UNCLEAR.includes(o.status))return null;const now=engineOrder(id);return now&&now.status!==o.status?{status:now.status??null,reason:now.reason??null}:null;};
    let changed=false,updated=review;const first=fresh(review.orderId,review.orderOutcome);if(first){updated={...updated,orderOutcome:first};changed=true;}
    if(Array.isArray(review.orders)){const rows=review.orders.map(row=>{const f=fresh(row?.orderId,row?.orderOutcome);if(!f)return row;changed=true;return {...row,orderOutcome:f};});if(changed)updated={...updated,orders:rows};}
    if(changed)try{this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify(updated),review.id);}catch{}
    return updated;}
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
    value=value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!LEGACY_SETTINGS.includes(k))):value;
    // claudeTradingConfirmed (Claude trading D-1) is not a setting: it confirms one save and is removed before storing.
    if(!value || Object.keys(value).some(key=>key!=='claudeTradingConfirmed'&&!Object.hasOwn(DEFAULTS,key)))throw new Error('INVALID_SETTINGS');
    const next={...this.config,...value};
    if(!['local','openai','external'].includes(next.provider)||!Number.isInteger(next.intervalMinutes)||next.intervalMinutes<1||next.intervalMinutes>1440||!Number.isFinite(next.eventTolerancePct)||next.eventTolerancePct<.1||next.eventTolerancePct>50||!Number.isInteger(next.maxCallsPerDay)||next.maxCallsPerDay<1||next.maxCallsPerDay>200||!Number.isFinite(next.maxUSDPerDay)||next.maxUSDPerDay<.01||next.maxUSDPerDay>100||typeof next.newsURL!=='string'||next.newsURL.length>1000||typeof next.guidelines!=='string'||next.guidelines.length>6000)throw new Error('INVALID_SETTINGS');
    if(!Number.isInteger(next.reflectionCallsPerDay)||next.reflectionCallsPerDay<1||next.reflectionCallsPerDay>200||!Number.isFinite(next.reflectionUSDPerDay)||next.reflectionUSDPerDay<.01||next.reflectionUSDPerDay>100)throw new Error('INVALID_SETTINGS');
    for(const key of ['unlimitedCalls','unlimitedBudget','reflectionUnlimitedCalls','reflectionUnlimitedBudget','autoReviewInterval','reflectionEnabled','enabled','autoSubmit','orderUpdateReviews','desktopAlerts','mobileAlerts','phoneSnapshots','phoneAmounts'])if(typeof next[key]!=='boolean')throw new Error('INVALID_SETTINGS');
    if(!['paper','kis','us','both'].includes(next.scope)||typeof next.shareKisWithOpenAI!=='boolean'||typeof next.shareKisWithAnthropic!=='boolean')throw new Error('INVALID_SETTINGS');
    if(!Number.isInteger(next.anthropicCallsPerDay)||next.anthropicCallsPerDay<1||next.anthropicCallsPerDay>200||!Number.isFinite(next.anthropicUSDPerDay)||next.anthropicUSDPerDay<.01||next.anthropicUSDPerDay>100||typeof next.anthropicUnlimitedCalls!=='boolean'||typeof next.anthropicUnlimitedBudget!=='boolean')throw new Error('INVALID_SETTINGS');
    if(typeof next.orderTracking!=='boolean'||!['full','focused'].includes(next.routineReviews)||!['off','observe','on'].includes(next.reviewGate)||!['off','on'].includes(next.researchSuppression)||!['off','observe','on'].includes(next.watchlistAlerts)||!['off','on'].includes(next.alertTrial)||!require('./not-held.cjs').CHOICES.includes(next.notHeldPriceReviews)||next.alertTrial==='on'&&next.notHeldPriceReviews!=='default'||next.alertTrial==='on'&&(next.watchlistAlerts!=='observe'||next.scope==='paper'||this.config.alertTrial==='on'&&next.scope!==this.config.scope)||next.watchlistMovePct!==null&&(!Number.isFinite(next.watchlistMovePct)||next.watchlistMovePct<.1||next.watchlistMovePct>50))throw new Error('INVALID_SETTINGS');
    require('./guardrails.cjs').validateGuardrails(next);if(!require('./news-events.cjs').MODES.includes(next.newsTrigger))throw new Error('INVALID_SETTINGS');
    require('./ai-models.cjs').settings(next);
    // A Claude model is not a trading model yet (Anthropic provider A1b): refused for the trading review and, through each
    // agent's resolved model, for every other agent (step A2) before anything is saved.
    require('./ai-models.cjs').assertTradingModel(next.openaiModel);
    // Claude trading D-1: with the gate open, a Claude trading model is saved only under the conditions of the D-0 note,
    // section 2. claudeTradingConfirmed belongs to this save only and is never stored. Switching back is always allowed.
    const toClaude=this.vendorOf(next.openaiModel)==='anthropic'&&this.vendorOf(this.config.openaiModel)!=='anthropic',fromClaude=this.vendorOf(next.openaiModel)!=='anthropic'&&this.vendorOf(this.config.openaiModel)==='anthropic';
    if(this.vendorOf(next.openaiModel)==='anthropic'){const why=this.claudeTradingRefusal(next,{saving:true,switching:toClaude});if(why)throw new Error(why.code);}
    delete next.claudeTradingConfirmed;{const AM=require('./agent-models.cjs');const claude=AM.AGENTS.filter(a=>a!=='trading').some(a=>this.vendorOf(AM.agentModel(next,a).openaiModel)==='anthropic');AM.validate(next,{claudeAllowed:claude&&Boolean(this.completedClaudeDryRun())});}
    if(['sessionKrNxt','sessionUsPre','sessionUsAfter','sessionUsDaytime'].some(k=>typeof next[k]!=='boolean')||!Number.isFinite(next.extendedMaxOrderPct)||next.extendedMaxOrderPct<0.5||next.extendedMaxOrderPct>50||!['pre-open','off','keep'].includes(next.closedMarketReviews)||typeof next.skipUnchanged!=='boolean'||typeof next.degradeNearBudget!=='boolean'||!Number.isInteger(next.maxSkipMinutes)||next.maxSkipMinutes<15||next.maxSkipMinutes>720)throw new Error('INVALID_SETTINGS');
    if(typeof next.scoutAiRequests!=='boolean'||typeof next.scoutEnabled!=='boolean')throw new Error('INVALID_SETTINGS');require('./scout-timing.cjs').validate(next);
    // M-6: several open orders (the user's switch, default off) and the most orders one review may place (default 1; at
    // most the highest model ceiling, 22; the selected model's ceiling limits what is used).
    if(typeof next.severalOpenOrders!=='boolean'||!Number.isInteger(next.ordersPerReview)||next.ordersPerReview<1||next.ordersPerReview>ORDERS_PER_REVIEW_MAX)throw new Error('INVALID_SETTINGS');
    if(!Array.isArray(next.newsFeeds)||next.newsFeeds.length>10||next.newsFeeds.some(f=>!f||typeof f.url!=='string'||!/^https:\/\//.test(f.url)||f.url.length>500||typeof(f.label??'')!=='string'||String(f.label??'').length>60)||typeof next.kisNews!=='boolean'||typeof next.usTickerNews!=='boolean'||typeof next.narrativeEnabled!=='boolean'||!Number.isFinite(next.sizingRiskPct)||next.sizingRiskPct<0.1||next.sizingRiskPct>20||!Number.isFinite(next.sizingAtrMultiple)||next.sizingAtrMultiple<0.5||next.sizingAtrMultiple>5)throw new Error('INVALID_SETTINGS');
    if(typeof next.conditionalOrders!=='boolean'||typeof next.trailingStops!=='boolean'||typeof next.conditionalAutoSubmit!=='boolean'||typeof next.creditProtectionApproved!=='boolean'||!Number.isInteger(next.conditionalMaxActive)||next.conditionalMaxActive<1||next.conditionalMaxActive>10||!Number.isFinite(next.conditionalMaxOrderPct)||next.conditionalMaxOrderPct<1||next.conditionalMaxOrderPct>50||!Number.isFinite(next.conditionalMaxSlippagePct)||next.conditionalMaxSlippagePct<.1||next.conditionalMaxSlippagePct>10||!Number.isFinite(next.conditionalMaxHours)||next.conditionalMaxHours<1||next.conditionalMaxHours>336)throw new Error('INVALID_SETTINGS');
    // Trailing stops switched off (T2): armed trailing stops stay armed as fixed stops at their current level; switched
    // on again they resume from the next quotes (no catch-up of the off time). The two-check memory starts afresh.
    if(Boolean(next.trailingStops)!==Boolean(this.config.trailingStops)){this.trailMemory=new Map();this.trailSeen=new Map();
      // Switched on again (ruling 5): the off time is not caught up; daily bars count only from the next day.
      if(next.trailingStops)try{const T=require('./trailing-stops.cjs'),now=Date.now();for(const o of this.desk.orders(this.watchScope()))if(o.trail&&!o.trail.awaitingFill){const day=T.dayOf(now,T.marketOf(o.symbol));this.desk.update(o,{trail:{...o.trail,watchedDay:day,watchedAt:now,catchUpFrom:[o.trail.catchUpFrom,T.nextDay(day)].filter(Boolean).sort().at(-1),resumedAt:now}});}}catch{}
      if(!next.trailingStops)try{const n=this.desk.orders(this.watchScope()).filter(o=>o.trail).length;if(n)this.log(randomUUID(),'System','Trailing stops paused',`${n} trailing ${n===1?'stop stays armed at its current level':'stops stay armed at their current levels'}.`);}catch{}}
    if(next.alertTrial!==this.config.alertTrial){if(next.alertTrial==='on'){this.alertTrial.start({scope:this.watchScope(),markets:require('./market-hours.cjs').marketsFor(next.scope)});this.log(randomUUID(),'System','Watchlist alert trial started','Price reviews now come from the selective watchlist rules; the current rule runs in shadow. Every other trigger and all protection are unchanged.');}
      else{const t=this.alertTrial.end('turned off');if(t)this.log(randomUUID(),'System','Watchlist alert trial stopped','Turned off. Price reviews come from the current rule again.');}}
    this.config=next;this.revision=(this.revision??0)+1;this.saveConfig();this.savedAt=Date.now();if(Object.hasOwn(value,'enabled'))this.sessionArmed=next.enabled;
    // Claude trading D-3 (D-0 note section 8; review C): the switch to Claude makes the first review wait for your press;
    // switching back to another vendor's model clears it.
    if(toClaude)this.setClaudeFirstReview({state:'pending',since:Date.now()});else if(fromClaude)this.setClaudeFirstReview(null);
    return this.getState();
  }
  schedulerStatus(){
    if(this.launching)return {label:'Starting auto trading',detail:'Checking the selected account.'};
    if(this.busy)return {label:'Review in progress',detail:'Waiting for the decision and risk checks to complete.'};
    if(!this.config.enabled)return {label:'Manual reviews only',detail:'Scheduled reviews are disabled in your saved settings.'};
    if(!this.sessionArmed)return {label:'Paused after restart',detail:'Your settings were restored. Use Start auto trading to resume, or run a manual review.'};
    if(this.config.provider==='external')return {label:'Waiting for external agent',detail:'The external agent must send a decision through the bridge.'};
    if(this.config.provider==='openai'){const missing=this.missingKey(this.config.openaiModel);if(missing)return {label:'API key required',detail:`Import provider JSON with an ${missing} key for the selected model.`};}
    if(this.config.scope==='paper'&&this.paper.account().paused)return {label:'Paper account paused',detail:'Enable Paper trading to allow scheduled reviews.'};
    if(this.config.scope!=='paper'&&this.config.provider==='openai'&&!this.consentFor(this.config.openaiModel))return {label:'Data sharing required',detail:this.consentMessage(this.config.openaiModel)};
    if(this.config.provider==='openai'&&this.budgetBlocked(this.config.openaiModel,require('./ai-models.cjs').reservation(this.config)))return {label:'Daily API limit reached',detail:'Review your budget or wait for the next Seoul calendar day.'};
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
  sessionOptions(){return {krNxt:this.config.sessionKrNxt,usPre:this.config.sessionUsPre,usAfter:this.config.sessionUsAfter,usDaytime:this.config.sessionUsDaytime};}
  // The extended sessions the user switched on, for this scope's markets (instruction rewrite: the condition of the
  // extended-session part, so the review's text follows the setting and not the clock). An empty list when none is on.
  extendedSessions(){const o=this.sessionOptions(),markets=require('./market-hours.cjs').marketsFor(this.config.scope);
    return [...(markets.includes('KR')&&o.krNxt?['Nextrade pre- and after-market']:[]),...(markets.includes('US')?[o.usPre&&'U.S. pre-market',o.usAfter&&'U.S. after-market',o.usDaytime&&'U.S. daytime (KIS)'].filter(Boolean):[])];}
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
  // The 80% slowdown follows the trading model's provider: its limits and its usage today (B1).
  slowFactor(){const v=this.vendorOf(this.config.openaiModel);return this.config.provider==='openai'&&this.config.degradeNearBudget&&require('./token-saver.cjs').nearBudget(vendorLimits(this.config,v),this.vendorUsage(v))?2:1;}
  executionState(){const selected=this.config.scope==='both'?[['KR',this.live],['US',this.usLive]]:this.config.scope==='paper'?[['Paper',{enabled:!this.paper.account().paused,autoEnabled:true}]]:[[this.config.scope==='us'?'US':'KR',this.config.scope==='us'?this.usLive:this.live]];const markets=selected.map(([market,engine])=>({market,enabled:Boolean(engine?.enabled),automatic:Boolean(engine?.enabled&&engine?.autoEnabled)}));const describe=market=>(market==='US'?'U.S.':market==='KR'?'Korea':market);const blocked=markets.filter(row=>!row.enabled||this.config.autoSubmit&&!row.automatic);return {label:!this.config.autoSubmit?'Approval first':blocked.length?'Automatic requested · waiting for activation':'Automatic execution ready',detail:markets.map(row=>describe(row.market)+': '+(!row.enabled?'orders off':!this.config.autoSubmit?'approval first':row.automatic?'automatic orders enabled':'automatic orders off; approval required')).join(' · '),markets};}
  emergencyState(){const candidates=this.config.scope==='both'?[{market:'KR',loss:this.live?.getState().loss},{market:'US',loss:this.usLive?.getState().loss}]:[{market:this.config.scope==='us'?'US':'KR',loss:this.config.scope==='paper'?this.paper.getState().loss:(this.config.scope==='us'?this.usLive:this.live)?.getState().loss}];const selected=candidates.find(row=>row.loss?.breached)??candidates[0];return {active:candidates.some(row=>row.loss?.breached),scope:this.config.scope,currency:selected.market==='US'?'USD':'KRW',activeMarkets:candidates.filter(row=>row.loss?.breached).map(row=>row.market),ambiguousMarkets:candidates.filter(row=>row.loss?.ambiguous).map(row=>row.market),unavailableMarkets:candidates.filter(row=>row.loss?.unavailable).map(row=>row.market),lateMarkets:candidates.filter(row=>row.loss?.restrictedForDay).map(row=>row.market),loss:selected.loss??null,reviewIntervalSeconds:60,objective:'Prioritize justified loss reduction after costs. Reassess both markets when selected; respect native currencies, broker capacity, hours and approval. Do not chase losses.'};}
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
    const message=`${flow.amount>0?'Deposit':'Withdrawal'} detected: ${flow.market==='US'?'U.S.':'Korean'} cash ${flow.amount>0?'rose':'fell'} by ${amount} with no matching trade on ${flow.day}. Until you confirm or remove it, it counts as a ${flow.amount>0?'deposit':'withdrawal'}; if it was income, Performance shows the returns both ways. Confirm or remove it under Performance → Deposits & withdrawals.`;
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
  // Daily counts of skipped and full reviews (days before step A1 also count routine, escalated and confirmation reviews).
  recordSaving(kind){
    this.db.exec('CREATE TABLE IF NOT EXISTS token_savings(day TEXT PRIMARY KEY,payload TEXT NOT NULL)');const day=seoulDate();const row=this.db.prepare('SELECT payload FROM token_savings WHERE day=?').get(day);const value=row?JSON.parse(row.payload):{};
    value[kind]=(value[kind]??0)+1;this.db.prepare('INSERT INTO token_savings VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(day,JSON.stringify(value));
  }
  // Per-review token use and estimated cost from recorded AI calls, newest first.
  tokenSavingState(){
    this.db.exec('CREATE TABLE IF NOT EXISTS token_savings(day TEXT PRIMARY KEY,payload TEXT NOT NULL)');const row=this.db.prepare('SELECT payload FROM token_savings WHERE day=?').get(seoulDate());
    // Completed calls only (fix R2): a refused or failed call has no measured cost, and its reservation is not a review's cost.
    const calls=this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 120').all().map(r=>JSON.parse(r.payload)).filter(c=>c.reviewId&&c.status==='completed');const reviews=new Map();
    for(const call of calls){const r=reviews.get(call.reviewId)??{reviewId:call.reviewId,timestamp:call.timestamp,calls:0,inputTokens:0,cachedTokens:0,outputTokens:0,micro:0,models:[]};r.calls++;r.timestamp=Math.min(r.timestamp,call.timestamp);r.inputTokens+=call.usage?.inputTokens??0;r.cachedTokens+=call.usage?.cachedTokens??0;r.outputTokens+=call.usage?.outputTokens??0;r.micro+=call.estimatedMicro??call.accountedMicro??call.reservedMicro??0;if(!r.models.includes(call.model))r.models.push(call.model);reviews.set(call.reviewId,r);}
    const recent=[...reviews.values()].sort((a,b)=>b.timestamp-a.timestamp).slice(0,20);
    return {today:row?JSON.parse(row.payload):{},recent,averageMicro:recent.length?Math.round(recent.reduce((n,r)=>n+r.micro,0)/recent.length):null};
  }
  // Background AI (the scout, reflections and the market narrative) paused for this session only: the saved settings are
  // unchanged and it runs again after a restart, as the status says. Trading reviews and order safety are separate.
  setBackgroundPaused(paused){if(typeof paused!=='boolean')throw new Error('INVALID_REQUEST');this.backgroundPaused=paused;this.log(randomUUID(),'System',paused?'Background AI paused':'Background AI resumed',paused?'Scout, reflection and narrative runs are paused for this session; your saved settings are unchanged.':'Scout, reflection and narrative runs follow your settings again.');return this.getState();}
  backgroundAi(){const c=this.config;return {paused:Boolean(this.backgroundPaused),enabled:[c.scoutEnabled&&'scout',c.reflectionEnabled&&'reflections',c.narrativeEnabled&&'market narrative'].filter(Boolean)};}
  // claudeTrading (D-3): what the settings window and Home need for trading on Claude: whether the gate is open, whether
  // a dry run allows the switch, and the first review's state.
  getState(){this.syncLearning();return {claudeTrading:{enabled:require('./ai-models.cjs').claudeTradingEnabled(),dryRunReady:Boolean(this.stateCached?this.stateCached('claudeTradingDryRun',()=>{try{return this.claudeTradingDryRun();}catch{return null;}}):this.claudeTradingDryRun()),firstReview:this.claudeFirstReview()?.state??null},claudeReservation:this.stateCached?this.stateCached('claudeReservation',()=>{try{return this.claudeReservation('claude-opus-5-5',vendorLimits(this.config,'anthropic'));}catch{return null;}}):null,claudeDryRun:this.completedClaudeDryRunCached(),agentModels:require('./agent-models.cjs').agentModels(this.config),usageByVendor:this.usageByVendor(),backgroundAi:this.backgroundAi(),lastErrorAt:this.lastError?this.lastErrorAt??null:null,reviewBackoff:this.reviewBackoffState(),providerWait:this.providerWaitState(),accountEnvironment:this.live?.getConnection?.()?.snapshot?.environment??null,calendar:this.calendarState(),regime:this.regimeState(),exposure:this.exposureState(),narrative:this.narrativeState(),desk:this.deskState(),scout:this.scoutState(),tokenSaving:{...this.tokenSavingState(),reviewGate:this.reviewGateState()},watchlistAlerts:this.watchlistAlertsState(),newsEvents:this.stateCached('newsEvents',()=>this.newsEvents.list(100)),lastNewsTrigger:this.lastNewsTrigger??null,guardrails:this.guardrails.state(this.config,Date.now(),{autoOrders:this.stateCached('autoOrdersToday',()=>this.guardrails.autoOrdersToday())}),digests:this.digest.list(),lessonTrials:this.trials.list(),reviewInterval:this.reviewInterval.get(this.watchScope(),this.config),reflections:this.reflections.state(),aiCalls:this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.payload)),learning:{...this.memory.summary(),lastRun:this.learningLastRun??null,error:this.learningError??null},watches:this.watches.list(this.watchScope()),outcomes:this.outcomes.list(),execution:this.executionState(),emergency:this.emergencyState(),config:this.config,sessionArmed:this.sessionArmed,savedAt:this.savedAt,heartbeat:Date.now(),scheduler:this.schedulerStatus(),lastAttempt:this.lastRun||null,lastSuccess:this.lastSuccess||null,lastError:this.lastError,lastErrorDetail:this.lastErrorDetail??null,nextReview:this.nextReviewAt(),providerStatus:this.providerStatus,busy:this.busy,news:this.news,newsUpdatedAt:this.newsUpdatedAt??null,newsError:this.newsError,account:this.accountTag(),orderLimits:this.orderLimits(),reviews:this.stateCached('reviews',()=>this.reviewHistory(50)),allReviews:this.stateCached('allReviews',()=>this.reviewHistory(50,true)),lessons:this.memory.list(),usage:this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0}};}
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
    return {environment:'local-paper',paperVersion:state.account.version,equity:state.account.equity,cash:state.account.availableCash,positions:state.account.positions,universe:state.universe,quotes:state.quotes,orders:state.orders.filter(order=>['Pending','Partially filled'].includes(order.status)).map(({symbol,side,quantity,filled,status})=>({symbol,side,quantity,filled,status})),risk:state.policy,news:this.newsContext(),reviewedLessons:this.db.prepare("SELECT text FROM lessons WHERE approved=1 AND id NOT LIKE 'procedural:%' ORDER BY rowid DESC LIMIT 5").all().map(row=>row.text)};
  }
  // A review's inputs, built through the normal path: fresh market data, reconciled orders, account context, lessons,
  // costs, performance, plan and order books. Shared by reviews and dry runs.
  // Dry runs check a review without acting on it. 'inputs' builds a fresh review input snapshot and makes no AI call;
  // 'review' also asks the configured model, with every state-changing tool answering "not applied: dry run". Neither
  // proposes or submits orders, changes conditional orders, watches, triggers, notes, the watchlist, the review interval
  // or the schedule, nor feeds the journal, lessons or learning. AI cost is accounted as usual.
  // Building the inputs still refreshes market data and reconciles open orders with KIS, as every review does.
  // options.model: {openaiModel, reasoningEffort} to run one dry-run review on another model while the saved settings
  // stay as they are (Anthropic A5: one read-only review on Claude Opus 5.5). Validated by settings(); it needs that
  // vendor's key and the one data-sharing switch, which covers whichever provider receives the account (decision D4).
  async dryRun(mode='inputs',options={}){
    if(!['inputs','review'].includes(mode))throw new Error('INVALID_REQUEST');if(this.busy)throw new Error('REVIEW_BUSY');
    let override=null;if(options?.model!=null){if(mode!=='review'||typeof options.model!=='object')throw new Error('INVALID_REQUEST');override={openaiModel:String(options.model.openaiModel??''),reasoningEffort:String(options.model.reasoningEffort??'')};try{require('./ai-models.cjs').settings(override);}catch{throw new Error('INVALID_MODEL_SETTINGS');}}
    if(this.config.scope==='paper')throw new Error('DRY_RUN_NEEDS_KIS');if(mode==='review'&&(this.config.provider!=='openai'||this.missingKey((override??this.config).openaiModel)))throw new Error('AI_NOT_CONNECTED');
    // B1: the provider the dry run's model sends to must have its own consent (a Claude dry run needs the Anthropic one).
    if(mode==='review'&&!this.consentFor((override??this.agentModel('trading')).openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');
    this.busy=true;const id=randomUUID();const watchScope=this.watchScope();
    try{
      const {context}=await this.assembleReviewContext({watchScope,trigger:'Dry run'});const summary=dryRunSummary(context,{assembledAt:Date.now(),account:this.accountTag(),scope:this.config.scope});
      // The full assembled inputs, as the model would receive them, are kept with the record for inspection.
      const snapshot=require('./token-saver.cjs').compact(context);
      let review=null;
      if(mode==='review'){
        // Shaped and logged as a live review is ("Review size"); the size, every request's bytes and the full research
        // transcript (detail reads, condensing, refusals) are kept with the record, also when the review fails.
        // M-7 (c): n as a review computes it (ordersFor), with the dry run's own model; the context says it when above 1.
        const dryOrders=this.ordersFor(override??this.agentModel('trading'));if(dryOrders>1)context.ordersPerReview=dryOrders;
        // Item 12 step 1: shaped with the dry run's own model's limit and kept sections, as a review would be.
        const dryModel=override??this.agentModel('trading'),dryM=require('./ai-models.cjs');
        const shapedDry=require('./review-context.cjs').shape(require('./token-saver.cjs').compact(context),{limit:dryM.reviewByteLimit({},dryModel),keep:dryM.contextKeep(dryModel)});const dryValidation=validationOf(context);
        const size={...shapedDry.report,mandatoryBytes:shapedDry.mandatoryBytes,steps:shapedDry.steps,detailAvailable:shapedDry.context.detailAvailable??[]};
        this.log(id,'System','Review size',JSON.stringify({dryRun:true,...size}));
        const providerContext=shapedDry.context;const transcript=[],requests=[];
        const trace=()=>({size,requests,transcript,detailReads:transcript.filter(t=>t.title.startsWith('Context detail')).map(t=>t.title.replace(/^Context detail · /,'')+' → '+t.body),condensed:transcript.filter(t=>t.title==='Research context condensed').map(t=>t.body)});
        // A refused request (Claude refused-request design 1): the first refused call's local record goes with the failed
        // dry run for the Dry-run panel; the console line carries its status, type and request id, never the message.
        const failed=error=>{const at=Date.now();const providerError=firstRefusal(this.db,id);if(providerError)this.log(id+':refused','System','Dry-run review · request refused',`${providerError.status}${providerError.errorType?' '+providerError.errorType:''}${providerError.requestId?` · request ${providerError.requestId}`:''}`);
          const notAccepted=providerError?null:answerRule(error);
          const record={id,timestamp:at,mode,summary,review:{failed:/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'DRY_RUN_FAILED',...(providerError?{providerError}:{}),...(notAccepted?{answerRule:notAccepted}:{}),measurement:dryRunMeasurement(this.db,id),...trace(),...(error?.metrics?{research:error.metrics}:{})}};
          try{this.db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run(id,at,JSON.stringify({...record,snapshot}));}catch{}return error;};
        if(!shapedDry.fits){const failure=require('./review-context.cjs').sizeFailure(shapedDry,{stage:'dry-run first request'});this.saveSizeFailure(id,failure,{report:size,steps:shapedDry.steps,input:providerContext});throw failed(failure);}
        const noop=name=>async()=>({status:'not-applied',reason:`Dry run: ${name} was not applied.`});
        const read=this.discovery?{...(this.discovery.research?{get_company_research:args=>this.discovery.research(args)}:{}),...(this.discovery.marketOverview?{get_market_overview:()=>this.discovery.marketOverview()}:{}),screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:noop('update_watchlist')}:null;
        // Every desk tool is a no-op except compute, which only reads prices.
        const desk=providerContext.agentDesk?(()=>{const real=this.deskActions(watchScope,providerContext,id,()=>{});return Object.fromEntries(Object.keys(real).map(k=>[k,k==='compute'?real.compute:noop(k)]));})():null;
        const model=override??this.agentModel('trading');const models=require('./ai-models.cjs');let calls=0;const callIds=[];
        const request=async options=>{options={...options,...model,validation:dryValidation,...(dryOrders>1?{moreOrders:dryOrders-1}:{})};
          requests.push({call:requests.length+1,followUp:Boolean(options.continuation),bytes:Buffer.byteLength(JSON.stringify(options.continuation??[{role:'user',content:JSON.stringify(providerContext)}])),limitBytes:models.reviewByteLimit(options,model)});
          const reserve=models.reservation(model,providerContext,{...options,maxBytes:models.reviewByteLimit(options,model)});
          const day=seoulDate();
          const callId=randomUUID();callIds.push(callId);this.reserveCall(model,reserve,callId,day,JSON.stringify({reviewId:id,model:model.openaiModel,reasoningEffort:model.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'dry-run'}));
          calls++;try{const r=await this.decisionWithRetry(providerContext,options);require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,r,'completed');return r;}
          catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}};
        // Condensing uses the routine model as a live review does (accounted as kind compact under this dry run's id).
        const log=(kind,title,body)=>{transcript.push({at:new Date().toISOString(),kind,title,body:String(body).slice(0,4000)});this.log(id,kind,title,String(body));};
        let r;try{r=await require('./research-review.cjs').researchReview({context:providerContext,detail:shapedDry.detail,watched:watchedIn(this.discovery,providerContext),wrap:null,evidence:this.evidence,discovery:providerContext.discovery?.enabled?read:null,setInterval:noop('set_review_interval'),setWatch:noop('set_review_watch'),actions:desk,log,compact:this.config.provider!=='openai'?null:payload=>this.compactResearch(id,payload),request});}
        catch(error){throw failed(error);}
        const micro=this.db.prepare('SELECT payload FROM ai_calls').all().map(row=>JSON.parse(row.payload)).filter(p=>p.reviewId===id).reduce((sum,p)=>sum+(p.accountedMicro??p.estimatedMicro??0),0);
        // Claude trading D-1: what made this dry run (the app version, the instruction set and fingerprint of its
        // context, and the form of its final answer), so the trading gate can ask for a new one after a text or schema change.
        const measurement=dryRunMeasurement(this.db,id);let instructions=null;try{instructions=require('./ai-client.cjs').instructions(providerContext);}catch{}
        review={model:model.openaiModel,effort:model.reasoningEffort,decision:r.decision,usage:r.usage??null,research:r.metrics??null,calls,costUSD:Math.round(micro)/1e6,measurement,appVersion:this.appVersion(),instructions,answerForm:measurement?.requests?.at(-1)?.answerForm??null,tools:transcript.filter(t=>/request/i.test(t.title)).map(t=>t.title+': '+t.body.slice(0,120)),...trace()};
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
      // An order the request limit stopped before it was sent (M-1a) has its own review request, after KIS may be asked.
      if(prev!==undefined&&prev!==key&&ORDER_EVENTS.includes(o.status)&&!(o.status==='Rejected'&&o.reason==='ORDER_NOT_SENT'))events.push(o);}
    return events;
  }
  // M-4 part 2: a decision with further orders, after the first order's checks. Each further order still standing gets the
  // checks the first got after the AI answered (position memory at the execution boundary, the stop's side), one by one;
  // then D8: an order (the first or a further one) for a stock with an app order still open at the broker is held back,
  // here at the decision so the record says so (the send-time guard stays). A single order keeps today's path.
  // Returns the decision: the first order (held back if D8 applies), moreOrders standing, moreWithheld with each reason.
  furtherAtDecision(id,{moreOrders,moreWithheld},result,context){
    const PM=require('./position-memory.cjs'),{sameStock}=require('./broker-open-orders.cjs'),{trimExplanation}=require('./ai-client.cjs');
    // Open: waiting at the broker on its own day (pendingOrders), or unclear (sent with a lost reply, being sent, a
    // cancellation not confirmed), whatever its day: rule U's set (F2, the planner's p31).
    const UNCLEAR=['Submitting','Uncertain','Cancellation uncertain'];
    const open=[...this.pendingOrders(),...this.scopedOrders().filter(o=>UNCLEAR.includes(o.status))],openFor=symbol=>open.some(o=>sameStock(o.symbol,symbol)),OPEN='an order for this stock is still open';
    const withheld=[...moreWithheld],standing=[];const hold=(o,reason,kind)=>withheld.push({item:o.item,action:o.action,symbol:o.symbol,quantity:o.quantity,reason,kind});
    let {moreOrders:_m,moreWithheld:_w,...decision}=result.decision;
    if(decision.action!=='Hold'&&openFor(decision.symbol)){const d=decision;const {execution:_e,reversal:_r,reversalFlag:_f,portfolioImpactCheck:_p,...kept}=d;
      decision={...kept,action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:trimExplanation(`${d.explanation} [The app held back a ${d.action} of ${d.quantity} ${d.symbol}: ${OPEN}.]`),withheld:{symbol:d.symbol,quantity:d.quantity,reason:OPEN,kind:'open-order'}};
      this.log(id,'System','Order held back · order still open',`${d.action} ${d.quantity} ${d.symbol}: ${OPEN}.`);}
    const boundary=result.provider==='openai'&&context.environment!=='local-paper';
    for(const o of moreOrders){
      if(boundary){const e=PM.enforce({...o,explanation:''},context.positionMemory??[],{price:context.quotes?.find(q=>q.symbol===o.symbol)?.price??null});if(e.withheld){hold(o,e.withheld.reason,'reversal');continue;}}
      const gap=stopSideGap(o,context);if(gap){hold(o,`stop not ${gap.side} price`,'stop-side');continue;}
      if(openFor(o.symbol)){hold(o,OPEN,'open-order');continue;}
      standing.push(o);}
    withheld.sort((a,b)=>a.item-b.item);
    for(const w of withheld)this.log(id,'System','Further order held back',`${w.item?`Order ${w.item+1}: `:''}${[w.action,w.quantity||'',w.symbol].filter(Boolean).join(' ')}${w.symbol?': ':''}${w.reason}.`);
    return {...decision,moreOrders:standing,...(withheld.length?{moreWithheld:withheld}:{})};
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
    // M-6 part 4 (the user's "Wait 30 min for new orders"): with several open orders on, a scheduled review waits only
    // for the orders the latest review placed, and for at most NEW_ORDER_WAIT_MS after it; older resting orders (an
    // earlier review's, a conditional order's) no longer hold reviews back. With it off, today's rule, unchanged.
    if(this.severalOpenNow()){const ids=this.latestReviewOrderIds();const mine=orders.filter(o=>ids.has(o.id));
      if(!mine.length||now-this.lastRun>=NEW_ORDER_WAIT_MS||this.reviewSessionKey&&this.sessionKey(now)!==this.reviewSessionKey)return null;
      return {orders:mine,until:this.lastRun+NEW_ORDER_WAIT_MS};}
    if(now-this.lastRun>=ORDER_BACKSTOP_MS||this.reviewSessionKey&&this.sessionKey(now)!==this.reviewSessionKey)return null;
    return {orders,until:this.lastRun+ORDER_BACKSTOP_MS};
  }
  // The broker orders the latest review of this account placed (its first and further orders).
  latestReviewOrderIds(){try{const [r]=this.reviewHistory(1);return new Set(require('./review-orders.cjs').ordersOfReview(r).map(o=>o.orderId).filter(Boolean));}catch{return new Set();}}
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
  // The model and effort an agent runs on (step A2): 'trading', 'scout', 'narrative', 'compacting' or 'reflection'.
  agentModel(agent){return require('./agent-models.cjs').agentModel(this.config,agent);}
  conditionalMonitoringActive(){return Boolean(this.config.conditionalOrders&&this.config.enabled&&this.sessionArmed&&this.config.scope!=='paper');}
  dryRuns(limit=5){return this.db.prepare('SELECT payload FROM dry_runs ORDER BY timestamp DESC LIMIT ?').all(limit).map(r=>{const {snapshot,...rest}=JSON.parse(r.payload);return rest;});}
  // What a dry-run review would cost before it starts: today's AI use against the limits, and an estimate from the
  // recent completed reviews on the model it would run on (a review is one or more requests). model: the dry run's
  // override (release gate R1: Claude Opus 5.5 gets its own measured cost, or none until a review on it completed).
  dryRunEstimate({model=null}={}){const m=model==='claude-opus-5-5'?model:this.config.openaiModel,claude=m.startsWith('claude-');
    const same=c=>claude?String(c.model??'').startsWith(m):c.model===m;
    const day=seoulDate(),vendor=this.vendorOf(m),usage=this.vendorUsage(vendor,day),limits=vendorLimits(this.config,vendor);
    // Claude trading D-2 (D-0 note section 0): live reviews first; for Claude with no live review yet, its dry runs (kind
    // dry-run), so the estimate is never missing after a completed Claude dry run. basis says which.
    const calls=this.db.prepare('SELECT payload FROM ai_calls ORDER BY rowid DESC LIMIT 400').all().map(r=>JSON.parse(r.payload)).filter(same);
    const live=calls.filter(c=>!c.kind),fromDry=claude&&!live.some(c=>c.status==='completed'&&Number.isFinite(c.accountedMicro));const all=fromDry?calls.filter(c=>c.kind==='dry-run'):live;
    const rows=all.filter(c=>c.status==='completed'&&Number.isFinite(c.accountedMicro));
    const byReview=new Map();for(const c of rows){const v=byReview.get(c.reviewId)??{micro:0,calls:0};v.micro+=c.accountedMicro;v.calls++;byReview.set(c.reviewId,v);}
    const recent=[...byReview.values()].slice(0,10);const sorted=recent.map(v=>v.micro).sort((a,b)=>a-b);const median=sorted.length?sorted[Math.floor(sorted.length/2)]:null;
    const usd=v=>v==null?null:Math.round(v)/1e6;
    const reserveFigures=vendor==='anthropic'?this.claudeReservation(m,limits):null;
    return {model:m,...(reserveFigures?{claude:reserveFigures}:{}),vendor:claude?'Anthropic':'OpenAI',ran:all.length>0||live.length>0,estimateUSD:usd(median),highUSD:usd(sorted.at(-1)??null),requests:recent.length?{min:Math.min(...recent.map(v=>v.calls)),max:Math.max(...recent.map(v=>v.calls))}:null,basis:`${recent.length} recent ${m} ${fromDry?'dry run':'review'}${recent.length===1?'':'s'}`,
      today:{provider:VENDOR_NAMES[vendor],calls:usage.calls,usedUSD:usd(usage.reservedMicro),maxCalls:limits.unlimitedCalls?null:limits.maxCallsPerDay,maxUSD:limits.unlimitedBudget?null:limits.maxUSDPerDay},
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
        if(this.config.provider==='openai'&&!this.consentFor(this.agentModel('trading').openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');
        if(this.config.scope==='both'){const kr=await this.live.context(),us=await this.usLive.context(usValue);kr.tradingCosts=this.costs?.context('KR',kr.universe,kr.positions);us.tradingCosts=this.costs?.context('US',us.universe,us.positions);context=require('./combined-context.cjs').combinedContext(kr,us,this.fx?.(),this.metadata?.());}else context=await execution.context(this.config.scope==='us'?usValue:null);context.news=this.newsContext();if(context.environment!=='local-paper'){const stories=this.storiesContext();if(stories.length)context.topStories=stories;}context.reviewedLessons=this.db.prepare('SELECT text FROM lessons WHERE approved=1 ORDER BY rowid DESC LIMIT 5').all().map(row=>row.text);
      }else context=this.context();
      setStage('Local trade evidence');this.outcomes.sync();this.memory.sync();const accounts=[this.live,this.usLive].flatMap(engine=>{try{return [engine.identity()];}catch{return [];}});const lessons=this.memory.relevantLessons(context,accounts);context.reviewedLessons=lessons.map(row=>row.text);const lessonIds=lessons.map(row=>row.id);
      // The last filled entry and exit per held or recently traded symbol, with the reviews that decided them (audit 2026-11-04, Stage 4).
      if(context.environment!=='local-paper')try{const tag=this.accountTag()?.key??null;const outcomes=this.db.prepare('SELECT payload FROM trade_outcomes').all().map(r=>JSON.parse(r.payload));const ids=[...new Set(outcomes.map(o=>o.reviewId).filter(Boolean))];
        const reviewAt=new Map(ids.length?this.db.prepare(`SELECT id,json_extract(payload,'$.timestamp') AS t FROM reviews WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(r=>[r.id,r.t]):[]);
        const since=tag?this.db.prepare("SELECT count(*) AS n FROM reviews WHERE json_extract(payload,'$.account.key')=? AND json_extract(payload,'$.timestamp')>?"):null;
        const memory=require('./position-memory.cjs').build(outcomes,{accounts,positions:context.positions,reviewAt,reviewsSince:(symbol,t)=>since?since.get(tag,t).n:null});if(memory.length)context.positionMemory=memory;}catch{}
      const conflicts=this.scoreboard.conflicts().filter(c=>lessonIds.includes(c.a)&&lessonIds.includes(c.b));if(conflicts.length)context.lessonConflicts=conflicts.map(c=>({lessons:[lessonIds.indexOf(c.a)+1,lessonIds.indexOf(c.b)+1],symbol:c.symbol,note:c.reason+' Weigh both; neither is a validated rule.'}));
      if(context.environment!=='local-paper'){const board=this.scoreboard.context();if(board)context.decisionScoreboard=board;const macro=this.macro?.context();if(macro)context.macro=macro;}
      setStage('Portfolio context');const emergency=context.environment==='kis'?{...this.emergencyState(),active:false,loss:null}:this.emergencyState();
      if(context.environment==='kis'){const policy=context.risk;const {lossStatus}=require('./loss-policy.cjs');const own=(()=>{try{return (this.config.scope==='us'?this.usLive:this.live)?.getState().loss??null;}catch{return null;}})();if(own){emergency.loss=own;emergency.active=Boolean(own.breached);}else emergency.loss=lossStatus(policy.lossLimit??{mode:'amount',value:policy.maxDailyLossKRW},policy.baseline,context.equity);emergency.active=emergency.loss.breached;}
      // Combined reviews state trading costs once (not again inside markets[]) and the tax rules once for both markets.
      if(context.environment==='kis-combined')Object.assign(context,require('./review-context.cjs').combineTradingCosts(context.markets));
      else context.tradingCosts=context.environment==='kis-combined'?null:context.environment==='local-paper'?{basis:'simulation',currency:'KRW',commissionPct:.1,slippagePct:.1,saleTaxPct:0,capitalGainsTax:'Not modeled in the local paper simulator. Live trading uses your fee and tax settings.'}:this.costs?.context(context.market??'KR',context.universe,context.positions);context.emergency=emergency;context.userGuidelines=this.config.guidelines;const peak=context.environment==='local-paper'?(this.paper.account().dayPeakEquity??this.paper.account().dayBaseline):(context.environment==='kis-combined'?null:context.risk.dayPeakEquity??context.risk.baseline);context.performance={dailyBaseline:emergency.loss?.baseline??null,observedDailyPeak:peak,currentEquity:context.equity,drawdownFromObservedPeakPct:peak>0?Math.max(0,(peak-context.equity)/peak*100):null};
      context.reviewInterval=this.reviewInterval.get(watchScope,this.config);context.extendedSessions=this.extendedSessions();if(context.environment==='kis'||context.environment==='kis-combined'){let history;try{history=context.environment==='kis-combined'?{KR:this.performanceSummary?.('KR')??null,US:this.performanceSummary?.('US')??null}:this.performanceSummary?.(context.market)??null;}catch(error){history={unavailable:'The performance records could not be read.'};if(!this.performanceUnavailableLogged){this.performanceUnavailableLogged=true;try{const at=String(error?.stack??'').match(/([A-Za-z0-9_-]+\.cjs):(\d+)/);this.log(randomUUID(),'System','Performance history unavailable',`The review runs without the performance history: the performance records could not be read (${error?.name??'Error'}${at?` at ${at[1]}:${at[2]}`:''}). Logged once per run.`);}catch{}}}if(history)context.performance.history=history;}
      context.reviewWatches=this.watches.list(watchScope).map(({baseline,revision,...watch})=>watch);{const notHeld=require('./not-held.cjs').contextText(this.config.notHeldPriceReviews);if(notHeld)context.notHeldPriceReviews=notHeld;}
      // Sector moves in the other market, as leads for the next session here (electron/main.cjs sectorLeads).
      if(this.config.scope!=='paper'&&this.sectorLeads){try{const leads=await this.sectorLeads(this.config.scope);if(leads)context.sectorLeads=leads;}catch{}}
      // How a pending order is followed, so reviews do not keep re-deciding an order that is only waiting.
      {const pending=this.pendingOrders();if(pending.length)context.orderFollowUp={orders:pending.map(o=>this.openOrderView(o)),
        // M-1b: what the app does when an order updates follows the user's switch; the note says so either way.
        note:`${this.config.orderUpdateReviews===true?`The app starts a review as soon as a pending order fills, partly fills or is cancelled, and otherwise routine reviews wait for it up to ${ORDER_BACKSTOP_MS/60000} minutes`:`Routine reviews wait for a pending order up to ${ORDER_BACKSTOP_MS/60000} minutes and resume at their scheduled time once it has filled or been cancelled; a fill or cancellation does not start a review of its own`} (price, news and agent triggers and market opens or closes still start reviews). Do not re-decide a pending order in each review: say only what would make you cancel or change it (a broken thesis, a price far from the limit, new evidence), and act if that has happened.`};}if(context.environment!=='local-paper'){const latestPlan=this.scoutStore.latest(watchScope);const plan=require('./scout.cjs').reviewContext(latestPlan,Date.now(),{stale:this.staleCarried(latestPlan?.plan?.targets,context.quotes),failed:(()=>{const f=this.scoutStore.failedAfter(watchScope,latestPlan);return f&&f.trigger!=='User request'?f:null;})()});if(plan){context.scoutPlan=plan;const gap=require('./plan-gap.cjs').planGap(context);if(gap)context.planGap=gap;}const brief=this.scoutBriefState(watchScope);if(brief)context.scoutBrief=brief;context.agentDesk=this.desk.context(watchScope,this.config,(context.universe??[]).map(r=>r.symbol),context.positions);if(context.agentDesk?.notes?.length){const flags=new Map(this.annotatedNotes(this.desk.notes(watchScope)).map(n=>[n.symbol,n]));context.agentDesk.notes=context.agentDesk.notes.map(n=>{const f=flags.get(n.symbol??'');return {...n,...(f?.accountStateConflict?{accountStateConflict:f.accountStateConflict}:{}),...(f?.orderClaimUnverified?{orderClaimUnverified:f.orderClaimUnverified}:{})};});}if(context.agentDesk?.conditionalOrders?.allowed)context.agentDesk.conditionalOrders.monitoring=this.conditionalMonitoringActive()?'active':'inactive: auto trading is paused, so armed orders do not fire until it is started';const story=this.storyContext();if(story.marketNarrative)context.marketNarrative=story.marketNarrative;if(story.similarEpisodes?.length)context.similarEpisodes=story.similarEpisodes;const risk=this.riskContext(context);Object.assign(context,risk);if(context.planGap)require('./plan-gap.cjs').addMinimumPositions(context);const events=this.calendarState(14,(context.universe??[]).map(r=>({symbol:r.symbol,name:r.name})));if(events.length)context.eventCalendar=events.slice(0,15).map(({date,kind,market,symbol,title,estimated})=>({date,kind,market,symbol,title,estimated}));}if(context.environment!=='local-paper'&&this.discovery){const starters=this.discovery.starters?.()??[];const usStarters=['us','both'].includes(this.config.scope)?this.discovery.usStarters?.()??[]:[];const starterCandidates=[...(starters.length?[{market:'KR',symbols:starters,source:'KIS market-cap ranking',note:'Korea has no allowlist, watchlist or holdings, so the largest listed companies were added to the review universe as a starting point. They are not recommendations.'}]:[]),...(usStarters.length?[{market:'US',symbols:usStarters,source:'KIS NASDAQ and NYSE market-cap rankings',note:'The U.S. market has no allowlist, watchlist or holdings, so the largest listed companies were added to the review universe as a starting point. They are not recommendations.'}]:[])];context.discovery={enabled:true,watchlist:this.discovery.list().map(({symbol,name,source,reason})=>({symbol,name,source,reason})),...(starterCandidates.length?{starterCandidates}:{})};}if(EVIDENCE_TRIGGERS.includes(trigger))context.triggerEvidence=evidence===undefined?this.triggerEvidence:evidence;
      try{await this.attachOrderBooks(context);}catch{}
      // The account valuation (electron/valuation.cjs, set by main) is the equity reviews reason from: its low bound, and
      // when it is an estimate, how much it may understate and why. Without both markets in it the engines' figure stays.
      // A valuation that cannot be read is said so (1.5.48 audit, A4): the equity is then KIS's total, not a net figure.
      if(context.environment==='kis-combined'){const c=(()=>{try{return this.valuation?.()?.combined??null;}catch{context.equityUncertainty={...(context.equityUncertainty??{}),reasons:[...(context.equityUncertainty?.reasons??[]),'the account valuation could not be read; equity is the KIS total, which may overstate it']};return null;}})();
        if(c&&c.low!=null&&c.scope.length===2){context.equity=Math.round(c.low);if(!c.exact)context.equityUncertainty={...(context.equityUncertainty??{}),understatedUpToKRW:Math.round(c.high-c.low),reasons:[...new Set([...(context.equityUncertainty?.reasons??[]),...c.reasons])].slice(0,6),basis:'estimated net equity: the low bound'};}}
      // Whether total equity can be trusted for weights: unconfirmed order status, an uncertain settlement or a missing market.
      if(context.environment!=='local-paper'){const reasons=[];if(context.orderReconciliation)reasons.push('open order status unconfirmed');
        reasons.push(...(context.equityUncertainty?.reasons??[]));
        if(!Number.isFinite(context.equity))reasons.push('total equity unavailable (a market or the exchange rate is missing)');context.equityReliability={reliable:!reasons.length,...(reasons.length?{reasons}:{})};}
      // Data gaps that persisted across reviews, with the research already tried (electron/research-gaps.cjs).
      if(context.environment!=='local-paper'){const gaps=this.researchGaps.context(watchScope);if(gaps.length)context.researchGaps=gaps;}
      {const open=this.waits.context(watchScope,{enforced:this.config.reviewGate==='on'||this.config.researchSuppression==='on'});if(open.length)context.waits=open;const pending=this.pending.context(watchScope);if(pending.length)context.pendingDecisions=pending;
        if(context.agentDesk){const symbols=[...new Set([...Object.keys(context.positions??{}),...(context.universe??[]).map(r=>r.symbol)])];const list=this.assessments.context(watchScope,{context,symbols,events:this.newsEvents.list(300),movePct:this.config.eventTolerancePct??3});if(list.length)context.assessments=list;}}
      // The previous review on this account, so a reversal (Hold to Buy, waiting to acted) explains what changed.
      if(context.environment!=='local-paper'){const key=this.accountTag()?.key;const prev=key?this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.account.key')=? ORDER BY rowid DESC LIMIT 1").get(key):null;
        if(prev){const r=JSON.parse(prev.payload),d=r.decision??{};context.previousReview={at:new Date(r.timestamp).toISOString(),action:d.withheld?'Buy withheld (incomplete plan)':d.action,...(d.action!=='Hold'||d.withheld?{symbol:d.withheld?.symbol??d.symbol,quantity:d.withheld?.quantity??d.quantity}:{}),verdicts:Object.fromEntries((d.planVerdicts??[]).map(v=>[v.symbol,v.verdict])),explanation:String(d.explanation??'').slice(0,400),
          // M-6 part 3: the previous review's further orders, and whether each was sent (only when it had them).
          ...(Array.isArray(r.orders)&&r.orders.length?{moreOrders:r.orders.map(o=>({action:o.action,symbol:o.symbol,quantity:o.quantity,sent:Boolean(o.orderId)&&!['Rejected','Uncertain','Submitting'].includes(o.orderOutcome?.status)}))}:{})};}}
    return {context,emergency,usValue,execution,lessonIds};
  }
  // Repeated format failures (1.5.48 audit, A5): after the second in a row, automatic reviews wait 15 minutes, doubling
  // with each further failure up to 6 hours, kept in the database so a restart does not reset it. Your own review
  // requests and an external agent's decisions still run; order tracking, conditional orders and the loss guardrails are
  // separate and keep running. Independent of the consecutive-failure cap, which may be off. A completed review clears it.
  // The backoff as getState() and the attention panel show it (CPU fix F3: the panel no longer builds the whole state).
  reviewBackoffState(){let b;try{b=this.reviewBackoff();}catch{b={until:0};}return b.until>Date.now()?{until:b.until,count:b.count,lastCode:b.lastCode??null,lastRule:b.lastRule??null}:null;}
  reviewBackoff(){this.db.exec('CREATE TABLE IF NOT EXISTS review_backoff(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');const r=this.db.prepare('SELECT payload FROM review_backoff WHERE id=1').get();return r?JSON.parse(r.payload):{count:0,until:0};}
  setReviewBackoff(next){this.reviewBackoff();this.db.prepare('INSERT INTO review_backoff VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(next));}
  // OpenAI refusal fix R2 (artifacts/reviews/2026-11-13-openai-rate-limit: design 5, review Q2, the user's emergency
  // decision): one wait per AI provider, shared by every automatic path. A rate limit, a server error, a timeout or a
  // connection failure ('rate') waits max(Retry-After + up to 20 %, 2 min x 2^(n-1)), at most 30 min; used-up credit or a
  // spend limit ('quota') waits 60 min. Failures within a minute of each other count as one (a retry inside one call).
  // The first completed call to that provider ends the wait. Accounting is not touched here (ai-accounting.cjs).
  providerBackoff(vendor){this.db.exec('CREATE TABLE IF NOT EXISTS provider_backoff(vendor TEXT PRIMARY KEY,payload TEXT NOT NULL)');const r=this.db.prepare('SELECT payload FROM provider_backoff WHERE vendor=?').get(vendor);return r?JSON.parse(r.payload):{count:0,until:0};}
  setProviderBackoff(vendor,next){this.providerBackoff(vendor);this.db.prepare('INSERT INTO provider_backoff VALUES(?,?) ON CONFLICT(vendor) DO UPDATE SET payload=excluded.payload').run(vendor,JSON.stringify(next));}
  providerWaitKind(error){const code=error?.message,p=error?.providerError;const E=require('./ai-errors.cjs');
    if(code==='AI_QUOTA_EXHAUSTED'||p&&(E.QUOTA_CODES.includes(p.errorCode)||p.errorType==='insufficient_quota'))return 'quota';
    if(['AI_RATE_LIMITED','AI_SERVER_ERROR','AI_TIMEOUT','AI_REQUEST_FAILED'].includes(code)||p&&(p.status===429||p.status>=500))return 'rate';return null;}
  noteProviderOutcome(vendor,error,now=Date.now()){try{
    const prev=this.providerBackoff(vendor);
    if(!error){if(prev.count||!prev.lastOkAt||now-prev.lastOkAt>60000)this.setProviderBackoff(vendor,{count:0,until:0,lastOkAt:now,...(prev.count?{lastOutage:{kind:prev.kind,firstAt:prev.firstAt,lastAt:prev.lastAt,failures:prev.failures,lastCode:prev.lastCode,endedAt:now}}:prev.lastOutage?{lastOutage:prev.lastOutage}:{})});
      // R3: one recovery notice, only after an outage that was alerted.
      if(prev.count&&prev.alertedAt){const hm=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});const message=`AI reviews are running again: ${VENDOR_NAMES[vendor]??vendor} failed from ${hm(prev.firstAt)} to ${hm(prev.lastAt)} KST (${prev.failures??prev.count} attempt${(prev.failures??prev.count)===1?'':'s'}).`;
        this.log(randomUUID(),'System','AI provider recovered',message);try{this.notify?.(`ai-recovered:${vendor}:${prev.firstAt}`,message);}catch{}}
      return;}
    const kind=this.providerWaitKind(error);if(!kind)return;const p=error.providerError??null;
    const same=prev.count&&prev.lastAt&&now-prev.lastAt<60000;const count=same?prev.count:(prev.count??0)+1;
    const retryMs=Number.isInteger(p?.retryAfterSec)?p.retryAfterSec*1000*(1+0.2*(this.random??Math.random)()):0;
    const wait=kind==='quota'?60*60000:Math.max(retryMs,Math.min(30*60000,2*60000*2**(count-1)));
    this.setProviderBackoff(vendor,{...prev,count,kind,firstAt:prev.count?prev.firstAt:now,lastAt:now,until:now+wait,failures:(prev.count?prev.failures??0:0)+1,lastCode:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'AI_REQUEST_FAILED',
      ...(p?{lastRefusal:{status:p.status,...(p.errorCode?{errorCode:p.errorCode}:{}),...(p.errorType?{errorType:p.errorType}:{}),...(p.requestId?{requestId:p.requestId}:{}),...(p.message?{message:p.message}:{}),...(Number.isInteger(p.retryAfterSec)?{retryAfterSec:p.retryAfterSec}:{})}}:{lastRefusal:null}),retryAfterSec:Number.isInteger(p?.retryAfterSec)?p.retryAfterSec:null});
    // R3: one console line when a wait starts or grows (a retry inside one call does not add one), with its reason and next try.
    if(!same){const b=this.providerBackoff(vendor),why=this.providerReason(vendor,b);this.log(randomUUID(),'System',count===1?'AI provider wait':'AI provider wait longer',`${why.text} (${why.code}). Automatic AI calls to ${VENDOR_NAMES[vendor]??vendor} wait until ${new Date(b.until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST (failure ${count} in a row). Your own requests still run; stops and loss limits continue.`);}
  }catch{}}
  // When automatic calls to this provider may run again (0: now). An emergency review waits at most max(Retry-After,
  // 2 min) after the last failure of a rate wait, without growth; for used-up credit it waits like the rest.
  providerWaitUntil(vendor,{emergency=false}={},now=Date.now()){let b;try{b=this.providerBackoff(vendor);}catch{return 0;}if(!b.count||!(b.until>now))return 0;
    const until=emergency&&b.kind==='rate'?Math.min(b.until,b.lastAt+Math.max(120000,(b.retryAfterSec??0)*1000)):b.until;return until>now?until:0;}
  // One line for a skipped run: which provider, why it waits, and when it tries again (KST).
  providerWaitText(model,until){let v=null;try{v=this.vendorOf(model);}catch{}const b=v?this.providerBackoff(v):{};const name=VENDOR_NAMES[v]??'The AI provider';
    return `${name} is ${b.kind==='quota'?'refusing requests: the account credit or spend limit is used up':'limiting requests or unavailable'}; automatic runs wait until ${new Date(until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST.`;}
  // R3 (fix design 6, review Q1, Q3, Q5, Q6 and the R2/R3 notes): what a wait means, in a few words and with its code.
  // A connection failure without a provider record (AI_REQUEST_FAILED) is also the fallback for an unknown local failure,
  // so it names the code and does not say the provider is down. A 429 with an unknown code may be a new billing code.
  providerReason(vendor,b=this.providerBackoff(vendor)){const name=VENDOR_NAMES[vendor]??'The AI provider',r=b.lastRefusal??{},code=r.errorCode??r.errorType??b.lastCode??'unknown';
    // Claude trading D-1: an Anthropic 429 has no errorCode, only its error type; one other than rate_limit_error is unfamiliar too.
    const unknown=r.status===429&&b.kind!=='quota'&&(r.errorCode?!['rate_limit_exceeded','slow_down'].includes(r.errorCode):vendor==='anthropic'&&Boolean(r.errorType)&&r.errorType!=='rate_limit_error');
    const text=b.kind==='quota'?`${name} refuses requests: the account credit or spend limit is used up`:unknown?`${name} refused requests with an unfamiliar code`:r.status===429||b.lastCode==='AI_RATE_LIMITED'?`${name} is limiting requests`
      :b.lastCode==='AI_SERVER_ERROR'||r.status>=500?`${name} is unavailable`:b.lastCode==='AI_TIMEOUT'?`${name} did not answer in time`:`AI requests are failing`;
    return {text,code,unknown:Boolean(unknown)};}
  providerWaitState(){const hm=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});const out=[];
    for(const vendor of Object.keys(VENDOR_NAMES)){let b;try{b=this.providerBackoff(vendor);}catch{continue;}if(!b.count||!(b.until>Date.now()))continue;const why=this.providerReason(vendor,b);
      out.push({vendor,name:VENDOR_NAMES[vendor],kind:b.kind,until:b.until,nextTry:hm(b.until),since:b.firstAt,failures:b.failures??b.count,code:why.code,summary:`${why.text}. ${b.kind==='quota'?'Add credit or raise the limit; next check':'Next try'} ${hm(b.until)}.`,
        ...(b.lastRefusal?.requestId?{requestId:b.lastRefusal.requestId}:{}),...(b.lastRefusal?.message?{message:b.lastRefusal.message}:{})});}
    return out;}
  lastCompletedReviewAt(){try{return this.db.prepare("SELECT json_extract(payload,'$.timestamp') AS t FROM reviews ORDER BY rowid DESC LIMIT 1").get()?.t??null;}catch{return null;}}
  // One alert per outage, while a market of this scope is in session (or at the next open): at the first failure for used-up
  // credit (Q1) or an unfamiliar 429 code (Q6), at the third in a row otherwise; and one alert when no review has completed
  // for 30 minutes of an open session after a failed attempt, whatever the cause (Q3), unless an outage alert covers it.
  checkAiAlerts(now=Date.now()){try{
    const markets=require('./market-hours.cjs').marketsFor(this.config.scope);const open=markets.filter(m=>{try{return this.sessionOpen(m,now);}catch{return false;}});if(!open.length)return;
    const hm=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'}),at=t=>t?hm(t)+' KST':'none today';const last=this.lastCompletedReviewAt();let alerted=false;
    for(const vendor of Object.keys(VENDOR_NAMES)){const b=this.providerBackoff(vendor);if(!b.count)continue;if(b.alertedAt&&b.alertedAt>=b.firstAt){alerted=true;continue;}const why=this.providerReason(vendor,b);
      if(!(b.kind==='quota'||why.unknown||b.count>=3))continue;
      const message=`AI reviews are failing: ${why.text} (${why.code}) since ${hm(b.firstAt)} KST; last completed review ${at(last)}. ${b.kind==='quota'?'Add credit or raise the limit on the provider account.':`Next try ${hm(b.until)} KST.`} Stops and loss limits still run.`;
      this.setProviderBackoff(vendor,{...b,alertedAt:now});alerted=true;this.log(randomUUID(),'System','AI provider alert',message+(b.lastRefusal?.message?` Message: ${b.lastRefusal.message}`:''));try{this.notify?.(`ai-outage:${vendor}:${b.firstAt}`,message);}catch{}}
    if(!(this.lastErrorAt>(this.lastSuccess||0)))this.stallFrom=null;else this.stallFrom??=this.lastErrorAt;
    if(!alerted&&this.stallFrom&&now-this.stallFrom>=30*60000&&now-(last??0)>=30*60000&&this.stallAlertedFor!==this.stallFrom){this.stallAlertedFor=this.stallFrom;
      const message=`No AI review has completed for 30 minutes while ${open.map(m=>m==='US'?'the U.S. market':'the Korean market').join(' and ')} is open (last completed review ${at(last)}; last error ${this.lastError??'unknown'}). Stops and loss limits still run.`;
      this.log(randomUUID(),'System','AI review alert',message);try{this.notify?.(`ai-stalled:${this.stallFrom}`,message);}catch{}}
  }catch{}}
  providerWaitFor(model,opts={}){let vendor;try{vendor=this.vendorOf(model);}catch{return 0;}return vendor?this.providerWaitUntil(vendor,opts):0;}
  // Every AI call goes through this wrapper, which records its outcome for the provider wait; nothing else changes.
  get provider(){return this.guardedProvider;}
  set provider(p){this.rawProvider=p;if(!p||typeof p.request!=='function'){this.guardedProvider=p;return;}const self=this,AI=new Set(['decision','scout','narrative','compact','reflection']);
    const g=Object.create(p);g.request=async(op,payload)=>{let vendor=null;if(AI.has(op))try{vendor=require('./ai-models.cjs').vendorOf(payload?.options?.openaiModel);}catch{}
      let result;try{result=await p.request(op,payload);}catch(error){if(vendor)self.noteProviderOutcome(vendor,error);throw error;}if(vendor)self.noteProviderOutcome(vendor,null);return result;};this.guardedProvider=g;}
  noteReviewOutcome(code,error=null,now=Date.now()){const E=require('./ai-errors.cjs');
    if(code==null){if(this.reviewBackoff().count)this.setReviewBackoff({count:0,until:0,clearedAt:now});return;}
    if(!E.FORMAT_CODES.includes(code))return;const prev=this.reviewBackoff(),count=(prev.count??0)+1,until=count>=2?now+Math.min(6*3600000,15*60000*2**(count-2)):0;
    this.setReviewBackoff({count,until,lastAt:now,lastCode:code,lastRule:E.ruleDetail(error).trim().slice(0,220)||null});
    if(until)this.log(randomUUID(),'System','Automatic reviews paused',`${count} reviews in a row failed on the response's format (${code}). Automatic reviews wait until ${new Date(until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST. Your own review requests still run; order tracking, conditional orders and the loss guardrails continue.`);}
  async review(trigger='User request',externalDecision) {
    if(!['User request','External agent'].includes(trigger)){const b=this.reviewBackoff();if(b.until>Date.now()){if(EVIDENCE_TRIGGERS.includes(trigger)&&this.triggerEvidence)this.restoreEvents(this.watchScope(),this.triggerEvidence);throw new Error('REVIEW_BACKOFF');}
      // The provider wait (fix R2): an automatic review does not call a provider that is waiting; its one-off events are
      // kept and held until the wait ends. Your own review requests still run.
      const until=this.config.provider==='openai'?this.providerWaitFor(this.agentModel('trading').openaiModel,{emergency:trigger==='Emergency loss response'}):0;
      if(until){if(EVIDENCE_TRIGGERS.includes(trigger)&&this.triggerEvidence){const scope=this.watchScope(),evidence=this.triggerEvidence;this.restoreEvents(scope,evidence);this.holdEvents(scope,require('./size-retry.cjs').eventKeys(evidence),until);}throw new Error('REVIEW_PROVIDER_WAIT');}}
    // Claude trading D-1, the check at review time (D-0 note section 3): a Claude trading model whose dry run, key or
    // consent no longer holds does not review. Nothing is sent to any provider (no fallback); the Journal and an alert
    // say why once per cause; the trigger's events are kept and held as for a failed review. Every trigger, yours too.
    if(this.config.provider==='openai'&&this.vendorOf(this.agentModel('trading').openaiModel)==='anthropic'){const why=this.claudeTradingRefusal(this.config);
      if(why){if(this.claudeRefusalShown!==why.code){this.claudeRefusalShown=why.code;this.log(randomUUID(),'System','Claude review not started',why.text);try{this.notify?.('claude-review-'+why.code,`Claude review not started: ${why.text}`);}catch{}}
        if(EVIDENCE_TRIGGERS.includes(trigger)&&this.triggerEvidence){const scope=this.watchScope(),evidence=this.triggerEvidence;this.restoreEvents(scope,evidence);this.holdEvents(scope,require('./size-retry.cjs').eventKeys(evidence),Date.now()+EVENT_RETRY_MS);}
        throw new Error('CLAUDE_TRADING_BLOCKED');}
      this.claudeRefusalShown=null;
      // D-3: until the first review on Claude has completed, only your own request, an external agent's and an emergency
      // review run; the others are held, their events kept, and said once.
      if(this.claudeFirstReview()?.state==='pending'&&!['User request','External agent','Emergency loss response'].includes(trigger)){
        if(!this.claudeFirstShown){this.claudeFirstShown=true;this.log(randomUUID(),'System','First Claude review waits for you','Automatic reviews wait until you run the first review on Claude Opus 5.5 (Home → Run first review) and it completes. Armed stops keep running.');}
        if(EVIDENCE_TRIGGERS.includes(trigger)&&this.triggerEvidence)this.restoreEvents(this.watchScope(),this.triggerEvidence);throw new Error('CLAUDE_FIRST_REVIEW_PENDING');}
      // Review F1: after an update whose instructions differ from those of the last Claude dry run, reviewing goes on; one
      // Journal line and one alert (once per instruction fingerprint in a run) advise a new dry run.
      try{const fp=require('./review-instructions.cjs').fingerprint();if(this.claudeAdviceShown!==fp&&!this.claudeTradingDryRun()){this.claudeAdviceShown=fp;const text='The review instructions changed in this version; a Claude dry run on it is advised (Dashboard → Dry run).';
        this.log(randomUUID(),'System','Claude dry run advised',text);try{this.notify?.('claude-dry-run-advised',text);}catch{}}}catch{}}
    // The evidence that started this review, captured before anything is awaited: a later trigger replaces
    // this.triggerEvidence, and a review that fails before its context is built (account data) still puts it back.
    // Review of 8ef1be1, P1: an agent trigger followed by INCOMPLETE_BALANCE was used up with no decision.
    const entryEvidence=EVIDENCE_TRIGGERS.includes(trigger)?this.triggerEvidence??null:null;
    if(this.busy){if(entryEvidence)this.restoreEvents(this.watchScope(),entryEvidence);throw new Error('REVIEW_BUSY');}const startedAt=Date.now();this.restoreClock();this.busy=true;this.reviewSessionKey=this.sessionKey();const id=randomUUID();if(this.trialRunning())try{this.alertTrial.attempt({now:startedAt,trigger,reviewId:id,shadowFired:trigger==='Price movement trigger'&&this.lastShadow&&startedAt-this.lastShadow.at<15000?this.lastShadow.fired:null});}catch{}let context,decided=false,firstRequest=null;let stage='Account data';if(this.config.scope!=='paper'&&!externalDecision)try{this.scheduleObserver.noteEventReview(trigger,this.scheduleState());}catch{}const revision=this.revision;const watchScope=this.watchScope();let costRevision=null;
    try {
      costRevision=this.costSnapshot();
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
      const gateLog=(ran,extra={})=>{if(gate)try{this.reviewGate.log(Date.now(),{scope:watchScope,trigger,mode:gateMode,alerts:this.alertTag(),oldSkip,ran,reviewId:ran?id:null,...extra,gate});}catch{}};
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
      // Routine reviews focus on what changed (setting routineReviews 'focused'); broad ones compare every strategy. The
      // comparison with the last decision is made here whatever the review gate's mode (audit 2026-11-04, Stage 4).
      if(this.config.routineReviews==='focused'&&!externalDecision)try{const RG=require('./review-gate.cjs');const base=this.reviewGate.baseline(watchScope);
        const scopeGate=gate??RG.compare(base,RG.decisionState(context),{trigger,config:this.config,events:this.newsEvents.list(300),waits:this.waits.all(watchScope),pending:this.pending.active(watchScope)});
        const key=this.accountTag()?.key;const last=key?this.db.prepare("SELECT json_extract(payload,'$.timestamp') AS t FROM reviews WHERE json_extract(payload,'$.account.key')=? AND coalesce(json_extract(payload,'$.reviewScope'),'broad')!='routine' ORDER BY rowid DESC LIMIT 1").get(key):null;
        context.reviewScope=RG.reviewScope(scopeGate,trigger,base,{lastBroadAt:last?.t??null,marketOpen:this.marketHours().open});}catch{}
      gateLog(true);if(gate&&trigger==='Scheduled review')this.log(id,'System',gate.needsReview?'Why this review runs':'Review gate · would skip',gate.needsReview?gate.reasons.map(r=>r.detail).join('; '):`Nothing decision-relevant changed since the last decision; ${gateMode==='on'?'':'the review gate is observing, so '}the review runs.`);
      this.log(id,'Program',trigger,context.environment!=='local-paper'?'Reviewing permitted KIS portfolio data. Credentials are excluded.':'Reviewing the local paper portfolio. KIS account data and credentials are excluded.');
      this.log(id,'Context','Supplied context',loggableContext(context));
      let result;
      // Formula use in this review (agent tools T0): counting only, never fails the review.
      const formulaUse=(()=>{try{return new (require('./formula-use.cjs').FormulaUse)();}catch{return null;}})();
      if(externalDecision){const {validateDecision}=require('./ai-client.cjs');result={decision:validateDecision(externalDecision,context.universe.map(row=>row.symbol)),provider:'external'};}
      else if(this.config.provider==='openai') {
        if(this.missingKey(this.config.openaiModel))throw new Error('AI_NOT_CONNECTED');
        stage='AI research and decision';
        // The configured model decides every review (model routing and shadow evaluation were removed in step A1).
        const selected=this.agentModel('trading');
        // The validation snapshot: position memory and quotes before compression, for every request of this review.
        const validation=validationOf(context);
        // M-6: n for this review, once; the context says it only when it is above 1 (the more-orders instruction part).
        const reviewOrders=this.ordersFor({openaiModel:selected.openaiModel,reasoningEffort:selected.reasoningEffort});if(reviewOrders>1)context.ordersPerReview=reviewOrders;
        let providerContext=saver.compact(context);
        // Item 12 step 1: the trading model's first-request limit and the sections it keeps whole (on Claude, 80,000 and
        // performance; on OpenAI, 70,000 and none, as before).
        const shaped=require('./review-context.cjs').shape(providerContext,{limit:require('./ai-models.cjs').reviewByteLimit({},selected),keep:require('./ai-models.cjs').contextKeep(selected)});providerContext=shaped.context;const detail=shaped.detail;
        this.log(id,'System','Review size',JSON.stringify({...shaped.report,mandatoryBytes:shaped.mandatoryBytes,steps:shaped.steps}));
        if(!shaped.fits){const failure=require('./review-context.cjs').sizeFailure(shaped,{stage:'first request'});this.saveSizeFailure(id,failure,{report:{...shaped.report,mandatoryBytes:shaped.mandatoryBytes},steps:shaped.steps,input:providerContext});throw failure;}
        this.replays.saveContext(id,providerContext);firstRequest=providerContext;
        const research=()=>require('./research-review.cjs').researchReview({context,detail,watched:watchedIn(this.discovery,context),evidence:this.evidence,discovery:context.discovery?.enabled?{...(this.discovery.research?{get_company_research:this.researchFor({watchScope,trigger,emergency:emergency.active,gate,gateMode,id})}:{}),...(this.discovery.marketOverview?{get_market_overview:()=>this.discovery.marketOverview()}:{}),screen_market:args=>this.discovery.screen_market(args),search_securities:args=>this.discovery.search_securities(args),update_watchlist:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.discovery.update_watchlist(args);}}:null,setInterval:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return this.reviewInterval.set(watchScope,args,this.config,{heldMoves:this.heldMoves(context)});},setWatch:args=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');return require('./not-held.cjs').withWatchNote(this.watches.set(watchScope,args,context),this.config.notHeldPriceReviews,args,this.heldNow());},actions:context.agentDesk?this.deskActions(watchScope,context,id,()=>{if(this.disposed||revision!==this.revision||watchScope!==this.watchScope())throw new Error('STALE_DECISION');},formulaUse):null,log:(kind,title,body)=>this.log(id,kind,title,body),compact:context.environment==='local-paper'||this.config.provider!=='openai'?null:payload=>this.compactResearch(id,payload),request:async options=>{
          {const changed=this.staleReason(watchScope,revision,costRevision);if(changed)throw Object.assign(new Error('STALE_DECISION'),{detail:{changed}});}
          const modelConfig={openaiModel:selected.openaiModel,reasoningEffort:selected.reasoningEffort};const n=reviewOrders;options={...options,...modelConfig,validation,...(n>1?{moreOrders:n-1}:{})};
          const reserve=require('./ai-models.cjs').reservation(modelConfig,providerContext,{...options,maxBytes:require('./ai-models.cjs').reviewByteLimit(options,modelConfig)});
          const day=seoulDate();
          const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now()};
          this.reserveCall(modelConfig,reserve,callId,day,JSON.stringify(record));
          try{const response=await this.decisionWithRetry(providerContext,options);require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return {...response,model:response.model??modelConfig.openaiModel};}
          catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}

        }});
        result=await research();this.recordSaving('fixed');
      } else if(this.config.provider==='external')throw new Error('EXTERNAL_DECISION_REQUIRED');
      else result={decision:this.localDecision(context),provider:'local'};
      if(this.disposed)return;{const changed=this.staleReason(watchScope,revision,costRevision);if(changed)throw Object.assign(new Error('STALE_DECISION'),{detail:{changed}});}
      decided=true;stage='Decision recording and execution';if(result.model)this.log(id,'System','Model used',result.model+' · '+this.agentModel('trading').reasoningEffort);
      this.log(id,'Agent','Decision',JSON.stringify(result.decision,null,2));
      const furtherPart=Array.isArray(result.decision.moreOrders)?{moreOrders:result.decision.moreOrders,moreWithheld:result.decision.moreWithheld??[]}:null;
      // The execution boundary (release review 2026-11-05, P1): a model decision is checked once more against this review's
      // full position memory, whatever the prompt showed, so compression or a repair round can never remove the reversal rule.
      if(result.provider==='openai'&&context.environment!=='local-paper')result={...result,decision:require('./position-memory.cjs').enforce(result.decision,context.positionMemory??[],{price:context.quotes?.find(q=>q.symbol===result.decision.symbol)?.price??null})};
      if(result.decision.withheld)this.log(id,'System',result.decision.withheld.kind==='reversal'?'Opening held back · reversal not explained':'Buy held back · trade plan',`${result.decision.withheld.quantity} ${result.decision.withheld.symbol}: ${result.decision.withheld.reason}.`);
      if(result.decision.reversalFlag)this.log(id,'System','Reversal not explained',`${result.decision.action} ${result.decision.quantity} ${result.decision.symbol}: ${result.decision.reversalFlag.reason}. A reduction is never held back for this.`);
      // A Buy whose stop is not below the current price is held back too.
      // The stated before-and-after weights, checked against the app's own figures and kept with the decision.
      if(result.decision.action==='Buy'&&result.decision.plan?.portfolioImpact)try{const check=require('./plan-gap.cjs').impactCheck(context,result.decision);if(check){result={...result,decision:{...result.decision,portfolioImpactCheck:check}};if(check.differencePts>3)this.log(id,'System','Portfolio impact differs',JSON.stringify(check));}}catch{}
      // An opening's stop is on the losing side: below the price for a long, above it for a short (Stage 3). Covers and
      // repayments reduce exposure and need no stop.
      {const gap=stopSideGap(result.decision,context);
      if(gap){const {side,q,eff}=gap;const d=result.decision;const what=eff.effect==='OPEN_SHORT'?'short sale':'Buy';this.log(id,'System','Buy held back · trade plan',`${d.quantity} ${d.symbol}: stop ${d.plan.stopPrice} is not ${side} the price ${q.price}.`);result={...result,decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',plan:d.plan,explanation:require('./ai-client.cjs').trimExplanation(`${d.explanation} [The app held back a ${what} of ${d.quantity} ${d.symbol}: the stop price is not ${side} the current price.]`),withheld:{symbol:d.symbol,quantity:d.quantity,reason:`stop not ${side} price`},...require('./position-memory.cjs').keptBeside(d)}};}}
      // M-4 part 2: the further orders, carried past the first order's checks above (which rebuild a held-back first order
      // without them), get the same checks after them, one by one, and the open-order rule (D8).
      if(furtherPart)result={...result,decision:this.furtherAtDecision(id,furtherPart,result,context)};
      // The brief rides on the decision; it is saved for the scout and never affects the trade.
      {const PG=require('./plan-gap.cjs');const missing=PG.missingVerdicts(context,result.decision);const issues=PG.verdictIssues(context,result.decision);if(missing.length||issues.length)this.log(id,'System','Plan verdicts incomplete',[missing.length?`No verdict on ${missing.join(', ')}.`:'',...issues].filter(Boolean).join(' '));}
      if(result.decision.scoutBrief){const {scoutBrief,...decision}=result.decision;result={...result,decision};if(context.scoutBrief){const value=this.briefScout(watchScope,scoutBrief,id);this.log(id,'Tool','Scout brief',JSON.stringify({brief:scoutBrief,result:value}));}}
      const contextEvidence={guidelines:this.config.guidelines,environment:context.environment,marketSession:context.marketSession??null,quote:context.quotes.find(q=>q.symbol===result.decision.symbol)??null,position:context.positions?.[result.decision.symbol]??null,emergency:context.emergency.active,reviewedLessons:context.reviewedLessons,lessonIds};
      const recorded={model:result.model??null,contextEvidence,id,timestamp:Date.now(),scope:this.config.scope,account:this.accountTag(),trigger,provider:result.provider,...(result.provider==='openai'?(v=>v?{vendor:v}:{})(['openai','anthropic'].includes(result.vendor)?result.vendor:(()=>{try{return require('./ai-models.cjs').vendorOf(result.model);}catch{return null;}})()):{}),...(result.provider==='openai'?{instructions:require('./ai-client.cjs').instructions(context)}:{}),...(context.reviewScope?{reviewScope:context.reviewScope.kind}:{}),alerts:this.alertTag(),...reviewSymbols(context,result.decision),decision:result.decision,proposalId:null,orderId:null,usage:result.usage??null,research:result.metrics??null,...((u=>u?{formulaUse:u}:{})((()=>{try{return formulaUse?.summary(result.decision)??null;}catch{return null;}})()))};
      this.db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,JSON.stringify(recorded));
      // A completed review answers the watchlist alert trial's open alerts on the symbols it assessed.
      if(this.trialRunning())try{this.alertTrial.answered({reviewId:id,assessed:recorded.assessed??[]});}catch{}
      if(this.config.scope!=='paper')try{const events=this.db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.runId')=?").all(id).map(r=>JSON.parse(r.payload));this.researchGaps.record(watchScope,result.decision.planVerdicts,require('./research-gaps.cjs').researchFromEvents(events));}catch{}
      try{const {nextOpen}=require('./market-hours.cjs');const closed=new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]);
        // The daily reassessment: the first open after the session in progress (or after now, while closed).
        const openAt=(m,t)=>{const o=nextOpen(m,t,closed);return o!=null&&o<=t+60000;};const sessionAfter=(m,t)=>{let s=t;for(let i=0;i<48&&openAt(m,s);i++)s+=1800000;return nextOpen(m,s,closed);};
        this.waits.record(watchScope,result.decision,{reviewId:id,context,research:this.researchSeen?.get(id)??[],nextOpen:(m,t)=>nextOpen(m,t,closed),sessionAfter});}catch{}
      if(this.config.scope!=='paper')try{const cost=this.db.prepare('SELECT payload FROM ai_calls').all().map(r=>JSON.parse(r.payload)).filter(c=>c.reviewId===id&&!c.kind).reduce((a,c)=>a+(c.accountedMicro??c.estimatedMicro??0),0)/1e6;this.scheduleObserver.recordReview(recorded,cost);}catch{}
      let proposal=null,order=null,executionNote=null;const onProposal=proposal=>this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify({...recorded,proposalId:proposal.id}),id);
      // M-5 (c): with further orders standing, the batch places the first and each further order (placeBatch); the first
      // order's fields below stay its own. A single order goes as before.
      const further=Array.isArray(result.decision.moreOrders)&&result.decision.moreOrders.length?result.decision.moreOrders:null;
      let batchRows=null;
      if(further){const sent=batchRows=await this.placeBatch([...(result.decision.action!=='Hold'?[result.decision]:[]),...further],{id,context,watchScope,revision,costRevision,base:execution,decidedAt:recorded.timestamp,onProposal});
        const first=sent.find(r=>r.item===0);if(first)({proposal,order,executionNote}=first);}
      else if(result.decision.action!=='Hold')({proposal,order,executionNote}=await this.placeOrder(result.decision,{id,context,watchScope,revision,base:execution,onProposal}));
      const review={model:result.model??null,contextEvidence,id,scope:this.config.scope,account:recorded.account,timestamp:Date.now(),trigger,provider:result.provider,...(recorded.vendor?{vendor:recorded.vendor}:{}),...(recorded.instructions?{instructions:recorded.instructions}:{}),...(recorded.reviewScope?{reviewScope:recorded.reviewScope}:{}),...(recorded.assessed?{triggerSymbols:recorded.triggerSymbols,assessed:recorded.assessed}:{}),...(recorded.alerts?{alerts:recorded.alerts}:{}),emergency:context.emergency.active,marketSession:context.marketSession?.status??null,decision:result.decision,executionNote,proposalId:proposal?.id??null,orderId:order?.id??null,...(order?{orderOutcome:{status:order.status??null,reason:order.reason??null}}:{}),usage:result.usage??null,research:result.metrics??null,...(recorded.formulaUse?{formulaUse:recorded.formulaUse}:{}),...(batchRows?{orders:furtherOrderRows(batchRows)}:{})};
      this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify(review),id);
      this.lastFingerprint={...hash,scope:watchScope,completedAt:Date.now()};
      // M-5 (e): each further order kept for a closed market is its own pending decision, and closes its own (carried out).
      const more=batchRows?batchRows.filter(r=>r.item>0).map(r=>({decision:further.find(o=>o.item===r.item)??r,orderId:r.order?.id??null,proposalId:r.proposal?.id??null})):[];
      try{this.pending.record(watchScope,{decision:result.decision,reviewId:id,proposalId:proposal?.id??null,orderId:order?.id??null,context,marketOpen:this.marketOpenIn(context),...(more.length?{more}:{})});}catch{}
      if(gateMode!=='off')try{const RG=require('./review-gate.cjs'),m=result.metrics??{};const prev=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 20').all().map(r=>JSON.parse(r.payload)).find(r=>r.id!==id&&r.scope===this.config.scope&&r.decision);
        this.reviewGate.complete(id,{completed:true,orderId:order?.id??null,...(batchRows?{orders:batchRows.filter(r=>r.order?.id).length}:{}),proposalId:proposal?.id??null,research:{toolCalls:m.toolCalls??0,researchReads:m.researchReads??0,detailReads:m.detailReads??0,fetched:m.fetched??0,refreshed:m.refreshed??0,reused:m.reused??0},change:RG.decisionChange(prev?.decision,result.decision)});}catch{}
      // The baseline is also what focused routine reviews compare with, so it is kept while they are on, gate or no gate.
      if(gateMode!=='off'||this.config.routineReviews==='focused')try{this.reviewGate.settle(watchScope,require('./review-gate.cjs').decisionState(context),{decision:{action:result.decision?.action,symbol:result.decision?.symbol,orderId:order?.id??proposal?.id??null,...(batchRows?{placed:batchRows.filter(r=>r.item>0&&(r.order?.id||r.proposal?.id)).map(r=>({symbol:r.symbol,action:r.action}))}:{})},contextAt:startedAt,events:(gateMode!=='off'?gateEvents:this.newsEvents.list(300)).filter(e=>e.firstSeenAt<=startedAt)});}catch{}
      // D-3: the first completed review on Claude ends the wait; automatic reviews continue.
      if(this.vendorOf(this.agentModel('trading').openaiModel)==='anthropic'&&this.claudeFirstReview()?.state==='pending'){const fr=this.claudeFirstReview();this.setClaudeFirstReview({...fr,state:'done',doneAt:Date.now()});this.claudeFirstShown=false;this.log(randomUUID(),'System','First Claude review completed','Automatic reviews on Claude Opus 5.5 continue at your interval.');}
      this.noteReviewOutcome(null);this.lastRun=Date.now();this.lastSuccess=this.lastRun;this.guardrails.succeeded();this.lastError=null;this.failedInput=null;this.eventHold=null;this.lastErrorDetail=null;this.lastPrices=new Map(context.quotes.map(row=>[row.symbol,row.price]));this.watches.rebase(watchScope,context.quotes);this.lastWatchScope=watchScope;this.log(id,'System','Review completed',result.usage?JSON.stringify(result.usage):'No provider tokens used.');if(result.metrics)this.log(id,'System','Research metrics',JSON.stringify(result.metrics));return review;
    }catch(error){this.lastRun=Date.now();this.lastErrorAt=this.lastRun;this.lastError=require('./ai-errors.cjs').publicCode(error)??(['AI_NOT_CONNECTED','AI_BUDGET_EXHAUSTED','EXTERNAL_DECISION_REQUIRED','PROVIDER_REQUEST_FAILED','AI_REQUEST_FAILED','DATA_SHARING_NOT_ENABLED','KIS_TRADING_DISABLED','STALE_DECISION','SESSION_CLOSED','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','FEATURE_UNAVAILABLE','INCOMPLETE_BALANCE'].includes(error.message)?error.message:'REVIEW_FAILED');this.lastErrorDetail=require('./ai-errors.cjs').detail(this.lastError,stage,error)+require('./ai-errors.cjs').sizeDetail(error);
      // M-5 (e): a batch that failed on an error the app does not know: its record keeps what became of each order (the
      // first order's proposal id was written when it was made; the further orders here).
      if(Array.isArray(error?.batch))try{const row=this.db.prepare('SELECT payload FROM reviews WHERE id=?').get(id);const first=error.batch.find(r=>r.item===0);
        if(row)this.db.prepare('UPDATE reviews SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.payload),...(first?{executionNote:first.executionNote??null,orderId:first.order?.id??null,...(first.order?{orderOutcome:{status:first.order.status??null,reason:first.order.reason??null}}:{})}:{}),orders:furtherOrderRows(error.batch)}),id);}catch{}
      // What research changed before the failure is reported apart from the failed result (1.5.48 audit, A5).
      if(Array.isArray(error?.applied)&&error.applied.length){const list=error.applied.slice(0,10).map(a=>`${a.tool}${a.id?` ${a.id}`:''} (${a.status})`).join('; ');this.lastErrorDetail+=` Changed during research before the failure, and kept: ${list}.`;if(!this.disposed)this.log(id,'System','Research changes kept after a failed review',list);}
      try{this.noteReviewOutcome(this.lastError,error);}catch{}
      // A size failure is remembered with its inputs so the same inputs are not retried (see the skip above).
      // A research round that did not fit carries the continuation it would have sent (research-review.cjs).
      // A request the client refused for size after shaping (ai-client.cjs) comes back from the provider worker without
      // its input: the record then holds the first request that was sent.
      if(require('./ai-errors.cjs').SIZE_CODES.includes(this.lastError)&&!error?.failureRecord&&(error?.input||firstRequest))this.saveSizeFailure(id,error,{report:error.detail??null,input:error.input??{firstRequest,note:'The request the client refused is not returned by the provider worker; this is the first request of the review.'}});
      const sizeFailed=require('./ai-errors.cjs').SIZE_CODES.includes(this.lastError)&&this.pendingInput;if(sizeFailed)this.failedInput={...this.pendingInput,code:this.lastError,at:Date.now()};
      // A review that reached no decision does not use up its one-off events (levels, agent triggers, filings). After a
      // size failure they are held until it clears; after any other failure, for EVENT_RETRY_MS, so a failing provider
      // is not called again every minute.
      if(!decided&&entryEvidence){this.restoreEvents(watchScope,entryEvidence);const keys=require('./size-retry.cjs').eventKeys(entryEvidence);
        if(!sizeFailed&&keys.length){this.holdEvents(watchScope,keys,Math.max(Date.now()+EVENT_RETRY_MS,this.config.provider==='openai'?this.providerWaitFor(this.agentModel('trading').openaiModel):0));if(!this.disposed)this.log(id,'System','Trigger kept for a later review',`No decision was made, so ${require('./size-retry.cjs').eventItems(entryEvidence).map(e=>e.label).join('; ')} ${keys.length>1?'are':'is'} kept and tried again from ${new Date(this.eventHold.until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST.`);}}
      if(!this.disposed){this.log(id,'System','Review failed',this.lastError+' · '+this.lastErrorDetail);if(error?.metrics)this.log(id,'System','Research metrics',JSON.stringify(error.metrics));const streak=this.guardrails.failed(),limit=this.config.maxConsecutiveFailures;if(limit>0&&streak>=limit&&(this.config.enabled||this.config.autoSubmit))this.trip('auto-stopped',`Auto trading stopped after ${streak} consecutive failed reviews (latest: ${this.lastError}).`);}throw new Error('REVIEW_FAILED');}
    finally{this.busy=false;this.researchSeen?.delete(id);this.firstAfterStart=false;this.saveClock();this.startRequestedScout();}
  }
  // A momentary OpenAI failure (connection, server error or timeout) is retried once after a short pause.
  // Which of a review's freshness guards tripped (once, a pre-open review failed STALE_DECISION and nothing said
  // why). Returns null when the review is still current; otherwise 'disposed', 'account scope', 'settings', or
  // 'cost settings: <changed top-level keys>'. Key names only, never values: no rates, tax figures or account ids.
  // What a review's cost freshness compares (STALE_DECISION fix S-1, artifacts/reviews/2026-11-15-claude-trading/
  // stale-decision.md): only what the user sets, the saved cost settings and the tax profile. Derived figures (taxStatus,
  // krTaxStatus, marketUsdKRW, taxLots, annualRealizedKRW, the ledger-filled basis) move with the broker, the market and
  // background jobs (a trade-history read two minutes after start failed the first Claude review); they never make a
  // decision stale. Never throws: unreadable is null on both sides.
  costSnapshot(){try{if(!this.costs)return null;return JSON.stringify({...this.costs.saved(),taxProfile:this.costs.profile?.get?.()??null});}catch{return null;}}
  staleReason(watchScope,revision,costRevision){
    if(this.disposed)return 'disposed';if(watchScope!==this.watchScope())return 'account scope';if(revision!==this.revision)return 'settings';
    const now=this.costSnapshot();if(costRevision===now)return null;
    let keys=[];try{const a=JSON.parse(costRevision??'null')??{},b=JSON.parse(now??'null')??{};keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k])).sort();}catch{}
    return 'cost settings'+(keys.length?': '+keys.slice(0,8).map(k=>String(k).replace(/[^A-Za-z0-9_.-]/g,'').slice(0,40)).join(', '):'');
  }
  // B1: whether KIS data may go to the provider of this model, and the message when not.
  vendorOf(model){try{return require('./ai-models.cjs').vendorOf(model);}catch{return 'openai';}}
  consentFor(model){return this.vendorOf(model)==='anthropic'?this.config.shareKisWithAnthropic===true:this.config.shareKisWithOpenAI===true;}
  consentMessage(model){return `Allow sharing KIS data with ${VENDOR_NAMES[this.vendorOf(model)]} in Connections.`;}
  // Today's usage of one provider. On the first day of B1 the per-provider table has no row while ai_usage already has the
  // day's calls; every call before B1 was OpenAI, so OpenAI's row is seeded from the total (review condition a).
  vendorUsage(vendor,day=seoulDate()){
    const row=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage_vendor WHERE day=? AND vendor=?').get(day,vendor);if(row)return {calls:row.calls,reservedMicro:row.reservedMicro};
    const any=this.db.prepare('SELECT COUNT(*) n FROM ai_usage_vendor WHERE day=?').get(day).n;const total=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day);
    if(!any&&total&&vendor==='openai')return {calls:total.calls,reservedMicro:total.reservedMicro};return {calls:0,reservedMicro:0};}
  // B3: reflection on Claude also counts against the Anthropic limits: the check, and the provider row written in the
  // reflection's own transaction. On OpenAI there is none, and reflection stays exactly as before.
  reflectionProviderBudget(){const model=this.agentModel('reflection').openaiModel;const vendor=this.vendorOf(model);if(vendor!=='anthropic')return null;
    return {vendor,gateClosed:this.claudeGateClosed('reflection'),missing:this.missingKey(model),blocked:reserve=>this.budgetBlocked(model,reserve),add:(day,reserve)=>{const mine=this.vendorUsage(vendor,day);this.db.prepare('INSERT INTO ai_usage_vendor VALUES(?,?,?,?) ON CONFLICT(day,vendor) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,vendor,mine.calls+1,mine.reservedMicro+reserve);}};}
  usageByVendor(day=seoulDate()){return Object.fromEntries(Object.keys(VENDOR_NAMES).map(v=>[v,this.vendorUsage(v,day)]));}
  budgetBlocked(model,reserve){return require('./ai-models.cjs').budgetExceeded(vendorLimits(this.config,this.vendorOf(model)),this.vendorUsage(this.vendorOf(model)),reserve);}
  // One reservation for every AI call (B1): the provider's limits, then in one transaction the all-provider total
  // (ai_usage), the provider's row (ai_usage_vendor, seeded on the first day) and the call record. A failure leaves all
  // three as they were. Throws AI_BUDGET_EXHAUSTED at the provider's limit.
  reserveCall(modelConfig,reserve,callId,day,record){
    if(this.budgetBlocked(modelConfig.openaiModel,reserve))throw new Error('AI_BUDGET_EXHAUSTED');const vendor=this.vendorOf(modelConfig.openaiModel);
    const mine=this.vendorUsage(vendor,day),total=this.db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
    const seed=vendor!=='openai'&&!this.db.prepare('SELECT COUNT(*) n FROM ai_usage_vendor WHERE day=?').get(day).n&&total.calls?{calls:total.calls,reservedMicro:total.reservedMicro}:null;
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT INTO ai_usage VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,total.calls+1,total.reservedMicro+reserve);
      if(seed)this.db.prepare('INSERT INTO ai_usage_vendor VALUES(?,?,?,?) ON CONFLICT(day,vendor) DO NOTHING').run(day,'openai',seed.calls,seed.reservedMicro);
      this.db.prepare('INSERT INTO ai_usage_vendor VALUES(?,?,?,?) ON CONFLICT(day,vendor) DO UPDATE SET calls=excluded.calls,reservedMicro=excluded.reservedMicro').run(day,vendor,mine.calls+1,mine.reservedMicro+reserve);
      this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,record);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  // B2: what a Claude dry run reserves with the current settings. firstRequestUSD from the size of the latest review's
  // first request (the "Review size" log), else the first-request byte limit; upToUSD: four requests at the byte limits
  // (the first at 70,000 bytes, three continuations at 140,000), the most one dry run can reserve. blocked: the
  // provider's dollar limit is below the first request's reservation, so the run cannot start.
  // B3 review F1: the gate holds at call time too, not only when settings are saved. An agent saved on Claude while one
  // account had a completed dry run must not call Claude after the connection changes to an account without one. The
  // cached value is keyed by historyVersion, which carries the account identity through watchScope.
  claudeGateClosed(agent){return this.vendorOf(this.agentModel(agent).openaiModel)==='anthropic'&&!this.completedClaudeDryRunCached();}
  completedClaudeDryRunCached(){return this.stateCached?this.stateCached('claudeDryRun',()=>{try{return this.completedClaudeDryRun();}catch{return null;}}):null;}
  claudeReservation(model,limits){const M=require('./ai-models.cjs');const cfg={openaiModel:model,reasoningEffort:'medium'};
    let bytes=null;try{const row=this.db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.title')='Review size' ORDER BY seq DESC LIMIT 1").get();const w=row?JSON.parse(JSON.parse(row.payload).body??'{}').wireBytes:null;if(Number.isInteger(w)&&w>0)bytes=w;}catch{}
    const first=M.reservationAt(cfg,Math.min(bytes??M.reviewByteLimit({},cfg),M.reviewByteLimit({},cfg)));// Haiku compacting H-1: the condensing figure is the compacting model's when it is a Claude model (Haiku or Opus).
    const comp=(()=>{try{const c=this.agentModel('compacting');return M.vendorOf(c.openaiModel)==='anthropic'?c:cfg;}catch{return cfg;}})();const compactUpTo=M.reservationAt(comp,400000,'compact');const upTo=M.reservationAt(cfg,M.reviewByteLimit({},cfg))+3*M.reservationAt(cfg,M.reviewByteLimit({continuation:[]},cfg));
    const usd=m=>Math.round(m/1e4)/100;return {firstRequestUSD:usd(first),firstRequestBasis:bytes?`the latest review's first request, ${bytes.toLocaleString('en-US')} bytes`:'the first-request size limit',upToUSD:usd(upTo),requestsUpTo:4,compactUpToUSD:usd(compactUpTo),
      blocked:!limits.unlimitedBudget&&limits.maxUSDPerDay*1e6<first,limitUSD:limits.unlimitedBudget?null:limits.maxUSDPerDay};}
  // The card's figures and the gate are cached with stateCached: its key (historyVersion) holds the database's total
  // changes, the settings revision, the scope and the minute, so a finished dry run (a new dry_runs row), a new review
  // size line or a changed limit shows on the next state read, and otherwise they are read at most once a minute.
  // B2: the latest completed Claude dry run on this account, or null. Completed: a review-mode run on a Claude model,
  // not failed, with a decision; its account is the current one; every Claude call it made completed with usage and a
  // settled cost; at least one call; and it has the measurement block. B3 and C gate on it.
  // The failed dry run recorded since `since` (this request's own record): its refused request's local record and its
  // measurement, for the Dry-run panel (Claude refused-request design 1). Null when none was recorded.
  dryRunFailure(since){try{const row=this.db.prepare('SELECT payload FROM dry_runs WHERE timestamp>=? ORDER BY timestamp DESC LIMIT 1').get(since);if(!row)return null;const r=JSON.parse(row.payload);if(!r.review?.failed)return null;
    return {failed:r.review.failed,providerError:r.review.providerError??null,answerRule:r.review.answerRule??null,measurement:r.review.measurement??null};}catch{return null;}}
  completedClaudeDryRun(){const tag=this.accountTag();if(!tag?.key)return null;
    const rows=this.db.prepare('SELECT payload FROM dry_runs ORDER BY timestamp DESC LIMIT 50').all();
    for(const row of rows){let r;try{r=JSON.parse(row.payload);}catch{continue;}const v=r.review;
      if(r.mode!=='review'||!v||!String(v.model??'').startsWith('claude-')||v.failed||!v.decision?.action||!(v.calls>=1)||!v.measurement)continue;
      if(r.summary?.account?.key!==tag.key)continue;
      const calls=this.db.prepare('SELECT payload FROM ai_calls').all().map(c=>JSON.parse(c.payload)).filter(c=>c.reviewId===r.id&&String(c.model??'').startsWith('claude-'));
      if(!calls.length||calls.some(c=>c.status!=='completed'||!c.usage||!Number.isFinite(c.accountedMicro)))continue;
      return {id:r.id,timestamp:r.timestamp,model:v.model,calls:v.calls,costUSD:v.measurement.totals?.costUSD??v.costUSD??null,account:tag.label??null,
        appVersion:v.appVersion??null,instructions:v.instructions??null,answerForm:v.answerForm??v.measurement.requests?.at(-1)?.answerForm??null};}
    return null;}
  // Claude trading D-1 (review.md, the change to condition 1): the completed Claude dry run that allows trading on Claude,
  // or null. A record with the instructions fingerprint must match the current set's (a later text, tool or schema change
  // asks for a new dry run); one with only an app version needs 1.5.60 or later; an older-style record counts when it was
  // made at or after 1.5.60's publish time and its final request recorded its answer form (the 1.5.60 forms record it).
  claudeTradingDryRun(){const r=this.completedClaudeDryRun();if(!r)return null;
    if(r.instructions?.fingerprint)return r.instructions.fingerprint===require('./review-instructions.cjs').fingerprint()?r:null;
    if(r.appVersion)return versionAtLeast(r.appVersion,'1.5.60')?r:null;
    return r.timestamp>=CLAUDE_FORMS_SINCE&&r.answerForm?r:null;}
  // Why a Claude trading model may not trade, or null (D-0 note section 2). cfg: the settings being saved, or the saved
  // ones at review time. Conditions 4 (the limits cover one review) and 5 (the confirmation) apply only when saving; 5 only
  // when switching from another vendor's model.
  // At review time (review F1) only the gate, the key and the consent are checked: the dry run is a condition of the
  // switch, never of later reviews, so an update that changes the instructions does not stop trading (claudeTradingAdvice).
  // The first review on Claude (D-3): {state:'pending'|'done', since, doneAt?} or null, kept apart from the settings so no
  // settings save can set it. Never throws.
  // Review F1: read from the table once per run, then kept in memory; setClaudeFirstReview writes through.
  claudeFirstReview(){if(this.claudeFirstCache===undefined){try{const r=this.db.prepare('SELECT payload FROM claude_trading_state WHERE id=1').get();this.claudeFirstCache=r?JSON.parse(r.payload):null;}catch{return null;}}return this.claudeFirstCache;}
  setClaudeFirstReview(value){this.claudeFirstCache=value??null;try{if(value==null)this.db.prepare('DELETE FROM claude_trading_state WHERE id=1').run();else this.db.prepare('INSERT INTO claude_trading_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value));}catch{}}
  claudeTradingRefusal(cfg,{saving=false,switching=false}={}){const model=cfg.openaiModel;
    if(!saving&&!require('./ai-models.cjs').claudeTradingEnabled())return {code:'CLAUDE_NOT_ENABLED_FOR_TRADING',text:'Claude models run dry-run reviews only for now; trading on Claude is not enabled yet.'};
    // Haiku compacting H-1 (review C): only Claude Opus 5.5 trades; another Claude id in saved settings does not review.
    if(model!==require('./ai-models.cjs').CLAUDE_TRADING_MODEL)return {code:'CLAUDE_MODEL_NOT_FOR_TRADING',text:'Only Claude Opus 5.5 can be the trading model.'};
    if(saving&&!this.claudeTradingDryRun())return {code:'CLAUDE_TRADING_DRY_RUN',text:'Trading on Claude Opus 5.5 needs a dry run on this version first: Dashboard → Dry run → Claude Opus 5.5.'};
    if(this.missingKey(model))return {code:'CLAUDE_TRADING_KEY',text:'Load your Anthropic key in Connections first.'};
    if(cfg.shareKisWithAnthropic!==true)return {code:'CLAUDE_TRADING_CONSENT',text:'Allow sharing KIS data with Anthropic in Connections first.'};
    if(saving){const r=this.claudeReservation(model,vendorLimits(cfg,'anthropic'));const calls=cfg.anthropicUnlimitedCalls===true||cfg.anthropicCallsPerDay>=(r?.requestsUpTo??4);const usd=cfg.anthropicUnlimitedBudget===true||(Number.isFinite(r?.upToUSD)&&cfg.anthropicUSDPerDay>=r.upToUSD);
      if(!calls||!usd)return {code:'CLAUDE_TRADING_LIMITS',text:`Your Claude daily limits do not cover one review (about $${r?.upToUSD??'?'} and up to ${r?.requestsUpTo??4} requests). Raise them in Engine settings.`};
      if(switching&&cfg.claudeTradingConfirmed!==true)return {code:'CLAUDE_TRADING_CONFIRM',text:'Confirm trading on Claude Opus 5.5 first.'};}
    return null;}
  // The vendor name whose key a model needs, when that key is not connected; null when it is (Anthropic A5). A status
  // without per-vendor flags (before the provider file is read, or a test double) counts aiConnected as OpenAI.
  missingKey(model){let vendor;try{vendor=require('./ai-models.cjs').vendorOf(model);}catch{return 'AI';}const s=this.providerStatus??{};
    const ok=vendor==='anthropic'?s.anthropicConnected===true:s.openaiConnected===true||Boolean(s.aiConnected)&&s.anthropicConnected!==true;return ok?null:vendor==='anthropic'?'Anthropic':'OpenAI';}
  // The enforced decision form's two console lines (enforced-form review E1, E3): the fallback to text and a JSON-text part
  // that was not accepted, each named without any of its content.
  noteAnswerForm(r,source='review'){try{const id=require('node:crypto').randomUUID();
    if(r?.formTooLarge===true)this.log(id+':form','System','Claude form over the size limit; sent as text',`The ${source} request's enforced form counted more than Anthropic's limit allows, so it was not sent in that form; it was sent as text.`);
    else if(r?.formFallback===true)this.log(id+':form','System','Claude refused the enforced form; sent as text',`The ${source} request was refused as too large for Anthropic's answer-format check and was sent once more as text. Requests stay in the text form for the rest of the day.`);
    const parts=Array.isArray(r?.textPartsDropped)?r.textPartsDropped.filter(k=>['strategyCheck','scoutBrief','planVerdicts','moreOrders'].includes(k)):[];
    if(parts.length)this.log(id+':text','System','Claude answer: text part not accepted',`${parts.join(', ')} ${parts.length===1?'was':'were'} not valid JSON of the expected kind and ${parts.length===1?'was':'were'} dropped; the decision stands.`);}catch{}}
  async decisionWithRetry(context,options,pauseMs=3000){
    try{const r=await this.provider.request('decision',{context,options});this.noteAnswerForm(r);return r;}
    catch(error){if(!['AI_REQUEST_FAILED','AI_SERVER_ERROR','AI_TIMEOUT'].includes(error?.message)||this.disposed)throw error;await new Promise(r=>setTimeout(r,pauseMs));
      // The retry's failure follows an uncertain attempt on the same call record: settle never takes it as a certain
      // refusal at zero (Claude refused-request diff review F2).
      try{const r=await this.provider.request('decision',{context,options});this.noteAnswerForm(r);return r;}catch(retry){if(retry&&typeof retry==='object')retry.earlierUncertain=true;throw retry;}}
  }
  // Cheap-model condensation of older research results in a review near its size limit; metered like other AI calls.
  async compactResearch(reviewId,payload){
    const modelConfig=this.agentModel('compacting');const models=require('./ai-models.cjs');
    // B3: condensing on Claude needs the Anthropic key and its sharing switch (research results can carry order and holding
    // details). Refused before any request; the review then carries the result by reference, as on any condensing failure.
    if(this.vendorOf(modelConfig.openaiModel)==='anthropic'){if(this.claudeGateClosed('compacting'))throw new Error('CLAUDE_DRY_RUN_REQUIRED');if(this.missingKey(modelConfig.openaiModel))throw new Error('AI_NOT_CONNECTED');if(!this.consentFor(modelConfig.openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');}
    // Claude trading D-2: no call while the compacting model's vendor has a provider wait (an OpenAI account without
    // credit would otherwise be called, and its wait re-armed, during every Claude review). The review then carries the
    // results by reference, as on any condensing failure (context-fit.cjs).
    if(this.providerWaitFor(modelConfig.openaiModel))throw new Error('PROVIDER_WAIT');
    const reserve=models.reservation(modelConfig,payload,{maxBytes:400000,kind:'compact'});const day=seoulDate();
    
    const callId=randomUUID(),record={reviewId,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'compact'};
    this.reserveCall(modelConfig,reserve,callId,day,JSON.stringify(record));
    try{const response=await this.provider.request('compact',{payload,options:modelConfig});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');return response;}
    catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');
      // Haiku compacting H-1: a failed condensing request is said once per model and code in a run; the review goes on with
      // the older results by reference (context-fit.cjs), as on any condensing failure.
      try{const code=/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'COMPACT_FAILED',key=modelConfig.openaiModel+':'+code;this.compactFailuresShown??=new Set();
        if(!this.compactFailuresShown.has(key)){this.compactFailuresShown.add(key);const name={'claude-haiku-5-5':'Claude Haiku 5.5','claude-opus-5-5':'Claude Opus 5.5','gpt-6-luna':'GPT-6 Luna','gpt-6-sol':'GPT-6 Sol','gpt-6-astra':'GPT-6 Astra'}[modelConfig.openaiModel]??modelConfig.openaiModel;
          this.log(reviewId,'System','Context compacting failed',`${name}: ${code}. The review went on with older results by reference.`);}}catch{}
      throw error;}
  }
  // Formula inputs: the latest quotes the app holds and cached daily closes; tools may warm the cache first.
  liveQuotes(){return this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):(this.marketQuotes?.()??[]);}
  formulaData(quotes=[]){
    const live=this.liveQuotes();
    const all=[...quotes,...live];
    return {price:sym=>all.find(q=>q.symbol===sym&&Number.isFinite(q.price))?.price??null,previousClose:sym=>all.find(q=>q.symbol===sym)?.previousClose??null,closes:sym=>this.series?.closes(sym)??null};
  }
  // The price to place an order at, from a freshly read order book (electron/order-pricing.cjs): the best bid for a
  // sale, the best ask for a purchase, held at the agent's bound. Without a usable book it retries every 3 seconds for
  // up to a minute (still(): whether placing is still wanted), then gives up (null) and asks for a review.
  // The placement of one order (M-5 (a)): the first order's chain from review(), lifted as it was. base: the engine
  // assembleReviewContext chose (combined scope picks by the symbol, as before); onProposal: called when a proposal is made
  // (the review records its id). Returns {proposal, order, executionNote}; throws as the chain did.
  // M-6 (m6-plan.md section 1): several open orders allowed now on every engine a review can place in (both in combined
  // scope), from the engines themselves (the user's saved switch). False on paper and when an engine is missing.
  severalOpenNow(){if(this.config.scope==='paper')return false;const engines=this.config.scope==='both'?[this.live,this.usLive]:[this.config.scope==='us'?this.usLive:this.live];
    return engines.every(e=>{try{return e?.allowsSeveralOpen?.()===true;}catch{return false;}});}
  // n, the most orders this review may place: 1 unless several open orders are allowed now; then "Orders per review",
  // limited by the trading model's ceiling (ai-models.cjs orderCeiling). The request asks for n - 1 further orders.
  // A review can trade only the stocks it is quoted: at most 20 per market (kis-worker.cjs, kis-overseas.cjs context),
  // holdings included; so in a one-market scope n is at most 20 (the planner's p19), and combined scope has 40.
  ordersFor(modelConfig){if(!this.severalOpenNow())return 1;const saved=Number.isInteger(this.config.ordersPerReview)?this.config.ordersPerReview:1;
    return Math.max(1,Math.min(saved,require('./ai-models.cjs').orderCeiling(modelConfig,'decide'),this.universeLimit()));}
  universeLimit(){return this.config.scope==='both'?2*UNIVERSE_PER_MARKET:UNIVERSE_PER_MARKET;}
  // What the settings screen shows for "Orders per review": the most a review may place now (the trading model's ceiling
  // within the stocks a review is shown), the model, whether several open orders is on, and the scope.
  orderLimits(){try{const m=this.agentModel('trading');return {ceiling:Math.min(require('./ai-models.cjs').orderCeiling({openaiModel:m.openaiModel,reasoningEffort:m.reasoningEffort},'decide'),this.universeLimit()),model:m.openaiModel,several:this.severalOpenNow(),scope:this.config.scope};}catch{return null;}}
  // M-5 (c), several orders from one review (m5-plan.md section 3): closing orders first (sales, repayments, covers), in
  // the AI's order among themselves, then openings in the AI's order; each through placeOrder, its book read one order
  // ahead (bookFeed). An order not started within BATCH_LIMIT_MS of the decision is not sent, nor the ones after it. One
  // follow-up review is asked after the batch when an order had no book or the limit passed. Returns one row per order,
  // in the order given: {item (0 the first), symbol, action, quantity, proposal, order, executionNote}.
  // M-5 (d): each order's outcome is classed (order-outcomes.cjs). A refusal of this order (class 'order') is that order
  // only; a class 'stop' outcome, or one checked before each order (the account or saved settings changed, automatic
  // trading stopped, the batch limit), leaves the rest not sent; the orders before stand. An error the app does not know
  // stops the rest too, and after the batch the review fails with it (error.batch: every order's outcome).
  async placeBatch(orders,{id,context,watchScope,revision,costRevision,base,decidedAt,onProposal}){
    const O=require('./order-outcomes.cjs');
    const closing=o=>{try{return require('./credit-paths.cjs').effectOf({side:o.action,credit:o.credit}).opening===false;}catch{return false;}};
    const seq=[...orders.filter(closing),...orders.filter(o=>!closing(o))],feed=this.bookFeed(seq.map(o=>o.symbol),{id}),done=new Map();let stopped=null,failure=null;
    const STOPS={STALE_DECISION:'the account or saved settings changed during the batch',AUTO_TRADING_STOPPED:'automatic trading was stopped',SEVERAL_OPEN_OFF:'several open orders was turned off during the batch',BATCH_LIMIT:'the batch limit (5 minutes from the decision) passed'};
    // Automatic trading stopped during the batch: the app closed, or automation or automatic submission turned off since
    // it started (a saved change also moves the revision, which staleReason reports first).
    const started={enabled:this.config.enabled,autoSubmit:this.config.autoSubmit,several:this.severalOpenNow()},turnedOff=()=>this.disposed||started.enabled&&!this.config.enabled||started.autoSubmit&&!this.config.autoSubmit;
    for(let k=0;k<seq.length;k++){const o=seq[k],item=o.item??0;
      // A test seam (M-7 scenarios: an event "before order k", 1-based in send order); nothing in the app sets it.
      try{this.beforeBatchOrder?.(k+1,o);}catch{}
      if(!stopped){const changed=this.staleReason(watchScope,revision,costRevision);
        // M-6: several open orders turned off since the batch started: today's one-open-order rule applies at once.
        if(changed)stopped={code:'STALE_DECISION',text:STOPS.STALE_DECISION};else if(started.several&&!this.severalOpenNow())stopped={code:'SEVERAL_OPEN_OFF',text:STOPS.SEVERAL_OPEN_OFF};else if(turnedOff())stopped={code:'AUTO_TRADING_STOPPED',text:STOPS.AUTO_TRADING_STOPPED};
        else if(Date.now()-decidedAt>(this.batchLimitMs??BATCH_LIMIT_MS))stopped={code:'BATCH_LIMIT',text:STOPS.BATCH_LIMIT};}
      if(stopped){const note=`Not sent: ${o.action} ${o.quantity} ${o.symbol}: ${stopped.text}.`;this.log(id,'System','Order not sent · batch',note);done.set(o,{proposal:null,order:null,executionNote:note,outcome:{class:'stop',code:stopped.code}});feed.missed.push(`${o.action} ${o.symbol} (${stopped.code==='BATCH_LIMIT'?'batch limit':stopped.text})`);continue;}
      feed.ahead(k);feed.ahead(k+1);
      try{const r=await this.placeOrder(o,{id,context,watchScope,revision,base,onProposal:item===0?onProposal:null,price:args=>feed.price(k,args)});
        done.set(o,{...r,outcome:{class:'order',code:r.order?.reason??r.order?.status??(r.proposal?(r.proposal.reason?'BLOCKED':'PROPOSED'):'NOT_PROPOSED')}});}
      catch(error){const code=O.codeOf(error),cls=O.classOf(code);
        const note=`Not sent: ${o.action} ${o.quantity} ${o.symbol}: ${code??'an error the app does not know'}${cls==='order'?'':'; the orders after it in this review were not sent'}.`;
        this.log(id,'System',cls==='order'?'Order not sent':'Order not sent · batch stopped',note);done.set(o,{proposal:error?.proposal??null,order:null,executionNote:note,outcome:{class:cls,code}});
        if(cls!=='order'){stopped={code:code??'UNKNOWN',text:`an earlier order in this review failed (${code??'an error the app does not know'})`};feed.missed.push(`${o.action} ${o.symbol} (${code??'unknown error'})`);if(cls==='unknown')failure=error;}}}
    const missed=feed.missed;if(missed.length)this.requestReview('Orders not placed',`${missed.join('; ')}: not placed from this review; decide again.`,seq[0]?.symbol??null);
    const rows=orders.map(o=>({item:o.item??0,symbol:o.symbol,action:o.action,quantity:o.quantity,...done.get(o)}));
    if(failure)throw Object.assign(failure,{batch:rows});
    return rows;
  }
  // Order books for a batch (M-5 (c)), each read once, one order ahead of its send: ahead(k) starts order k's read; price(k,
  // args) prices order k as placementPrice prices one order (same arguments and result). A read retries every 3 seconds
  // for up to a minute from its own request; a book no longer usable when its order is priced (older than the usable age,
  // order-pricing MAX_BOOK_AGE_MS) is read again. An order with no book is listed in missed (one follow-up review).
  bookFeed(symbols,{id}){const P=require('./order-pricing.cjs'),reads=new Map(),missed=[];
    const read=k=>{const p=(async()=>{let why=null;for(let attempt=0;;attempt++){let reply=null;try{reply=await this.orderBook?.(symbols[k]);}catch(error){reply={status:'unavailable',reason:error.message};}
      if(P.usableBook(reply))return {reply};if(!why)why=reply?.reason??(reply?.status==='available'?'stale or one-sided book':'no order book');
      if(attempt>=20)return {reply:null,why};await this.wait(3000);}})();reads.set(k,p);return p;};
    return {missed,ahead:k=>{if(k<symbols.length&&!reads.has(k))read(k);},
      price:async(k,{symbol,side,bound=null,still=()=>true})=>{const market=/:/.test(symbol)?'US':'KR';let r=await (reads.get(k)??read(k)),book=r.reply?P.usableBook(r.reply):null;
        if(r.reply&&!book){r=await read(k);book=r.reply?P.usableBook(r.reply):null;}
        if(!book||!still()){if(!book){missed.push(`${side} ${symbol} (no order book: ${r.why??'unusable'})`);this.log(id,'System','Order waits for the order book',`${side} ${symbol}: ${r.why??'unusable'}; no usable book within a minute.`);}return null;}
        const t=P.target({side,book,bound,market});this.log(id,'System','Order priced',`${side} ${symbol} at ${t.price}: ${side==='Sell'?'best bid':'best ask'} ${t.best}${t.atBound?`, held at your bound ${bound}`:''} (book read ${new Date(book.retrievedAt).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST).`);return {...t,book};}};
  }
  async placeOrder(d,{id,context,watchScope,revision,base,onProposal,price=null}){
        let execution=base;
        let proposal=null,order=null,executionNote=null,pendingAlready=null,placement=null,bounds=null,checked=null,stopNow=null,lotIssue=null;
        if(context.environment==='kis-combined')execution=/^\d{6}$/.test(d.symbol)?this.live:this.usLive;
        if(context.environment==='local-paper'&&context.paperVersion!==this.paper.account().version)throw new Error('STALE_DECISION');
        const selected=context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market):context;
        // The breach is read live, as the late, unavailable and uncertain checks below are (M-5 (b)): a reading that arrived
        // during the review (or, with several orders, after an earlier one's fill) counts. Before, it was the value taken
        // when the review started (context.emergency).
        const lossNow=this.emergencyState(),lossBreached=context.environment==='kis-combined'?(lossNow.activeMarkets??[]).includes(execution.market):Boolean(lossNow.active);
        // Whether the limit is reached depends on unresolved valuation (live-engine.cjs lossOf): new buys are restricted
        // as a breach would restrict them, without claiming a loss; a short cover is not new exposure.
        const opening=(()=>{try{return require('./credit-paths.cjs').effectOf({side:d.action,credit:d.credit}).opening;}catch{return d.action==='Buy';}})();
        const creditPath=require('./credit-paths.cjs').pathStatus(d.credit,{approved:this.config.creditProtectionApproved===true});
        const lossAmbiguous=!lossBreached&&opening&&context.environment!=='local-paper'&&(this.emergencyState().ambiguousMarkets??[]).includes(execution?.market??context.market??'KR');
        // A daily-loss check that cannot be evaluated (1.5.48 audit, A4) restricts new exposure whatever the loss-limit
        // response: there is no loss to review. Sales and covers are not held back.
        const lossUnavailable=opening&&context.environment!=='local-paper'&&(this.emergencyState().unavailableMarkets??[]).includes(execution?.market??context.market??'KR');
        // A day whose basis was taken late (1.5.48 review round 2): automatic new exposure stays restricted for the day.
        const lossLate=opening&&context.environment!=='local-paper'&&(this.emergencyState().lateMarkets??[]).includes(execution?.market??context.market??'KR');
        if(opening&&lossBreached&&this.config.lossAction!=='review'){executionNote='Guardrail: new buys are blocked after the daily loss limit, and so are new short sales. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys blocked',executionNote);this.trip('buys-blocked',`Blocked a ${d.symbol} buy after the daily loss limit was reached.`);}
        else if(lossLate){executionNote='Guardrail: today\'s opening value could not be read, so whether the daily loss limit was reached before the app could measure is unknown. Automatic new buys stay restricted for the rest of the day; sales are not affected. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys restricted (late daily baseline)',executionNote);}
        else if(lossUnavailable){executionNote='Guardrail: the daily loss check cannot be evaluated right now (its data could not be read), so new buys are restricted until it can. No loss is claimed. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys restricted (loss check unavailable)',executionNote);}
        else if(lossAmbiguous&&this.config.lossAction!=='review'){executionNote='Guardrail: whether the daily loss limit is reached depends on values not yet confirmed (an estimated valuation or unresolved money changes), so new buys are restricted as a breach would restrict them. No loss is claimed. Recommendation recorded; no order proposal was made.';this.log(id,'System','Guardrail · buys restricted (loss limit uncertain)',executionNote);}
        // A credit path whose broker fields are not confirmed: the idea is kept as a draft and nothing can be approved or
        // sent (electron/credit-paths.cjs).
        else if(d.credit&&d.credit!=='none'&&!creditPath.executable){executionNote=`Draft only: ${creditPath.reason}. ${creditPath.label??''} No order proposal was made; nothing can be approved or sent on this path.`.replace(/\s+/g,' ');this.log(id,'System','Draft only · credit order',executionNote);}
        else if(d.credit&&d.credit!=='none'&&(context.environment==='local-paper'||execution.market!=='KR')){executionNote='Credit orders (margin buying, short selling) are only available for Korean live accounts. Recommendation recorded; no order proposal was made.';this.log(id,'System','Review only · credit order',executionNote);}
        else if(context.environment!=='local-paper'&&(selected?.executionEnabled===false||!execution.enabled)){executionNote=(execution.market==='US'?'U.S.':'Korea')+' trading session is off. Recommendation recorded; no order proposal or submission was made.';this.log(id,'System','Review only · execution off',executionNote);}
        // The same Buy or Sell already pending while its market is closed: one proposal, reassessed when it opens.
        // A KIS decision for a closed market places nothing: it is kept as a pending decision and reassessed when the market
        // opens (a proposal made now would expire unused, and pricing it would wait for a book that is not there).
        else if(context.environment!=='local-paper'&&!this.marketOpenIn(context)(/:/.test(d.symbol)?'US':'KR')){pendingAlready=this.pending.repeats(watchScope,d,this.marketOpenIn(context));executionNote=`The ${/:/.test(d.symbol)?'U.S.':'Korean'} market is closed: ${d.action} ${d.symbol} is kept as a pending decision${pendingAlready?` (pending since ${new Date(pendingAlready.createdAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST)`:''} and reassessed when it opens. No order was placed.`;this.log(id,'System','Pending decision kept',executionNote);}
        // KIS orders are priced from a fresh order book; without one for a minute nothing is placed and a review follows.
        // Restrictions supplied but invalid withhold the order; a stop time or cancel condition is checked again after the
        // price is read (that can take a minute), immediately before the order is proposed and submitted.
        else if(context.environment!=='local-paper'&&(checked=this.executionBounds(d,context.quotes.find(row=>row.symbol===d.symbol)?.price,id)).invalid.length){executionNote=`Execution withheld: ${d.action} ${d.symbol} came with restrictions the app cannot honour (${checked.invalid.join('; ')}). No order was placed; the next review decides again.`;}
        else if(context.environment!=='local-paper'&&(bounds=checked.bounds,stopNow=this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true}))){executionNote=`Execution withheld: ${d.action} ${d.symbol}: ${stopNow}. No order was placed.`;this.log(id,'System','Execution withheld · restriction',executionNote);}
        else if(context.environment!=='local-paper'&&!(placement=await (price??(args=>this.placementPrice(args)))({symbol:d.symbol,side:d.action,bound:bounds?.bound??null,id,still:()=>!this.disposed&&revision===this.revision&&watchScope===this.watchScope()&&!this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true})}))){stopNow=this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true});executionNote=stopNow?`Execution withheld: ${d.action} ${d.symbol}: ${stopNow} while the order book was awaited. No order was placed.`:`No usable order book for ${d.symbol} for a minute; no order was placed. A review decides again.`;if(stopNow)this.log(id,'System','Execution withheld · restriction',executionNote);}
        else if(context.environment!=='local-paper'&&(stopNow=this.restrictionStop(bounds,Date.now(),{quotes:context.quotes,strict:true}))){executionNote=`Execution withheld: ${d.action} ${d.symbol}: ${stopNow} while the order was priced. No order was placed.`;this.log(id,'System','Execution withheld · restriction',executionNote);}
        else if(pendingAlready=this.pending.repeats(watchScope,d,this.marketOpenIn(context))){executionNote=`${d.action} ${d.symbol} has been pending since ${new Date(pendingAlready.createdAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST${pendingAlready.proposalId?` (proposal ${pendingAlready.proposalId})`:''}; it is reassessed when its market opens. No new proposal was made.`;this.log(id,'System','Pending decision kept',executionNote);}
        // A closing order larger than what is free in its lot is not proposed (credit-paths.cjs, Stage 3): recorded with the
        // reason, as a decision the review made, not a failed review.
        else if(context.environment!=='local-paper'&&(lotIssue=(()=>{try{const bal=execution.riskBalance??execution.getConnection?.()?.snapshot;if(!bal?.holdings)return null;const credit=d.credit&&d.credit!=='none'?{kind:d.credit,loanDate:d.loanDate||null}:null;
          const r=require('./credit-paths.cjs').remaining(bal,{symbol:d.symbol,side:d.action,credit},execution.orders?.()??[]);return r&&d.quantity>r.available?`${r.available} free in its lot${r.reserved?` (${r.reserved} already in waiting orders)`:''}`:null;}catch(e){return e.message==='NO_SUCH_LOT'?'no lot with that loan date':null;}})())){
          executionNote=`Not proposed: ${d.action} ${d.quantity} ${d.symbol} is more than the shares it can close: ${lotIssue}. No order proposal was made.`;this.log(id,'System','Not proposed · lot',executionNote);}
        else{
        proposal=context.environment!=='local-paper'?execution.propose({...(d.credit&&d.credit!=='none'?{credit:{kind:d.credit,...(d.loanDate?{loanDate:d.loanDate}:{})}}:{}),symbol:d.symbol,side:d.action,quantity:d.quantity,limitPrice:placement.price}):this.paper.propose({symbol:d.symbol,side:d.action,quantity:d.quantity});
        onProposal?.(proposal);
        // The order carries its bounds for the tracker, saved before it can be submitted.
        if(bounds&&context.environment!=='local-paper')execution.annotate?.(proposal.id,{tracking:bounds});
        this.log(id,'Risk','Proposal result',proposal.reason??'Paper risk checks passed.');
        if(d.action==='Buy'&&(d.credit??'none')==='none'&&d.plan&&context.environment!=='local-paper')this.followPlan(watchScope,d,id,{proposalId:proposal.id,market:execution.market??null,positions:(()=>{try{const bal=execution.riskBalance??execution.getConnection?.()?.snapshot;return Object.fromEntries((bal?.holdings??[]).map(h=>[h.symbol,{quantity:h.quantity}]));}catch{return {};}})()});
        const autoEligible=this.config.autoSubmit && (context.environment==='local-paper'||execution.autoEnabled!==false) && proposal.status==='Ready' && (context.environment==='kis-combined'?context.markets.find(row=>row.market===execution.market)?.marketSession.open===true:context.marketSession?.open!==false);
        // One daily cap across reviews and conditional orders (1.5.48 audit, A6): the slot is taken before the send and
        // released only when the engine's record shows nothing was sent.
        const orderCap=this.config.maxAutoOrdersPerDay;const slot=autoEligible?this.guardrails.reserveSlot({cap:orderCap,source:'review',ref:id,closing:!opening}):null;
        if(autoEligible&&!slot){executionNote=`Guardrail: the daily limit of ${orderCap} automatic orders is reached. Proposal awaits manual approval.`;this.log(id,'System','Guardrail · order limit',executionNote);this.trip('order-limit',`Daily automatic order limit (${orderCap}) reached; later proposals need approval.`);}
        else if(autoEligible) {const statusOf=()=>{try{return context.environment==='local-paper'?null:execution.orders?.().find(r=>r.id===proposal.id)??null;}catch{return null;}};
          try{order=context.environment!=='local-paper'?await execution.autoSubmit(proposal.id):this.paper.submit(proposal.id);}catch(error){this.settleAutoSlot(slot,statusOf());throw error&&typeof error==='object'?Object.assign(error,{proposal}):error;}
          this.settleAutoSlot(slot,context.environment==='local-paper'?{status:'Filled'}:statusOf()??order);this.log(id,'Tool','Order submission',JSON.stringify(order));
          // M-1a: refused by KIS's request limit before it was sent: nothing is at KIS, trading stays on, and a review
          // decides again once KIS may be asked (on fresh prices and checks), not before.
          if(order?.status==='Rejected'&&order.reason==='ORDER_NOT_SENT'){const at=Number.isFinite(order.retryAt)?order.retryAt:Date.now()+60000;
            executionNote=`Not sent: ${order.notSentCause==='ticket-expired'?'the broker check made for':'KIS\'s request limit was reached just before'} ${d.action} ${d.quantity} ${d.symbol} ${order.notSentCause==='ticket-expired'?'expired (15 seconds) before it could go out':'went out'}, so nothing reached KIS. Trading stays on; a review decides again after ${new Date(at).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST.`;
            this.log(id,'System',order.notSentCause==='ticket-expired'?'Order not sent · check expired':'Order not sent · request limit',executionNote);this.requestReview('Order not sent',`${d.action} ${d.symbol} was not sent (${order.notSentCause==='ticket-expired'?'its broker check expired':'KIS request limit'}); decide again.`,d.symbol,{notBefore:at});}}
        if(proposal?.reason)this.db.prepare('INSERT INTO lessons(id,text) VALUES(?,?)').run(randomUUID(),`Candidate lesson: avoid proposals blocked by ${proposal.reason}. Review freshness, reservations and configured limits before retrying.`);
        if(context.environment!=='local-paper'&&this.config.autoSubmit&&execution.autoEnabled===false){executionNote=(execution.market==='US'?'U.S.':'Korea')+' automatic execution is off. Proposal awaits manual approval.';this.log(id,'System','Approval required',executionNote);}}

        return {proposal,order,executionNote};
  }
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
    if(code==='DAILY_LOSS_RESTRICTED'){this.noteTrack(o,'the daily loss check cannot clear a higher price right now (unavailable, or today\'s opening value was not read); it stays at its price');return;}
    if(code==='APPROVAL_REQUIRED'){this.noteTrack(o,'a higher price now needs your approval under the product rules; it stays at its price');return;}
    // M-1.5a: KIS's request limit refused the change before it was sent: nothing changed at KIS; tried again later.
    if(code==='ORDER_NOT_SENT'||code==='RATE_LIMITED'&&error?.notSent===true){this.noteTrack(o,'KIS\'s request limit was reached before the change was sent; nothing changed at KIS, and it is tried again');return;}
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
  // The review's quotes are only a fallback: they were read when it started, and a review can run for minutes, so a
  // condition met since then is judged on the fresh live price.
  restrictionStop(t,now=Date.now(),{quotes=[],strict=false}={}){if(!t)return null;if(t.cancelAfter&&Date.parse(t.cancelAfter)<=now)return `its stop time ${t.cancelAfter} passed`;
    if(t.cancelIf?.length){const snap=this.formulaData(quotes),live=this.liveQuotes().filter(q=>!q.stale&&Number.isFinite(q.price));
      const data={...snap,price:sym=>live.find(q=>q.symbol===sym)?.price??snap.price(sym),previousClose:sym=>live.find(q=>q.symbol===sym)?.previousClose??snap.previousClose(sym)};
      const c=require('./formula.cjs').checkConditions(t.cancelIf,'any',data);if(c.met)return 'a cancel condition was met: '+c.results.filter(r=>r.met).map(r=>`${r.expr} ${r.op} ${r.value} (now ${r.actual})`).join(', ');
      const unknown=c.results.filter(r=>r.error);if(strict&&unknown.length)return 'a cancel condition cannot be checked now: '+unknown.map(r=>`${r.expr} (${r.error})`).join(', ');}return null;}
  // A review the app asks for itself (an order that could not be priced); it starts when nothing else runs.
  // At most one per symbol every 15 minutes, so a book that stays unreadable cannot start a review a minute.
  requestReview(trigger,reason,symbol=null,{notBefore=null}={}){const now=Date.now();this.requested??=new Map();if(symbol&&now-(this.requested.get(symbol)??-Infinity)<15*60000)return false;if(symbol)this.requested.set(symbol,now);this.reviewRequested={trigger,reason,at:now,...(Number.isFinite(notBefore)?{notBefore}:{})};return true;}
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
    else if(e.type==='order'){const o=this.config.orderUpdateReviews===true?this.orderTaken?.get(e.id):null;if(o){this.orderQueue??={scope:this.config.scope,orders:new Map()};if(!this.orderQueue.orders.has(e.id))this.orderQueue.orders.set(e.id,o);}}else{this.watches.unfire(scope,e.symbol,e.revision);if(e.revision&&this.config.watchlistAlerts==='on')this.watchAlerts.restore(e.revision);if(e.revision&&(this.config.notHeldPriceReviews??'default')!=='default')this.entryLevels.restore(e.revision);}}catch{}}}
  // Events held in this scope: those a size failure already had, until it clears, and those kept after any other
  // failure, until their retry time (EVENT_RETRY_MS).
  // Q7 (fix R2): the console line for order updates that start a review. An order kept after a review that decided
  // nothing comes back as a retry with the time it was first announced, never as a new event.
  orderUpdateLine(list,t=Date.now()){const fresh=list.filter(o=>!o.announcedAt),again=list.filter(o=>o.announcedAt);for(const o of fresh)o.announcedAt=t;
    const line=o=>`${o.status}: ${o.side} ${o.symbol}, ${o.filled??0}/${o.quantity} shares`,hm=x=>new Date(x).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});
    return {title:fresh.length?'Order update':'Order update · retry',body:[fresh.length?fresh.map(line).join('; ')+'.':'',again.length?`Retrying the review for: ${again.map(o=>`${line(o)} (update at ${hm(o.announcedAt)} KST)`).join('; ')}.`:''].filter(Boolean).join(' ')+' A review starts now.'};}
  // Holds events in this scope until a time (kept with any still held): EVENT_RETRY_MS after a failure, or the end of a
  // provider wait (fix R2), whichever is later.
  holdEvents(scope,keys,until,now=Date.now()){const before=this.eventHold?.scope===scope&&now<this.eventHold.until?this.eventHold:null;this.eventHold={scope,keys:new Set([...(before?.keys??[]),...keys]),until:Math.max(until,before?.until??0)};}
  heldEvents(scope,now=Date.now()){const f=this.failedInput,h=this.eventHold;return new Set([...(f?.scope===scope?f.eventKeys??[]:[]),...(h?.scope===scope&&now<h.until?h.keys:[])]);}
  // The installed app version (a size failure is tried again after an update).
  appVersion(){try{return require('../package.json').version;}catch{return null;}}
  // A size failure's record on this computer (electron/context-failures.cjs): the input that was not sent, its sizes and
  // versions. Never fails the review path; the log names the record.
  saveSizeFailure(id,error,{report=null,steps=[],input}){try{const r=this.contextFailures.save({code:error.message,stage:error.detail?.stage??null,reviewId:id,appVersion:this.appVersion(),schema:require('./review-context.cjs').SCHEMA,report,steps,input});error.failureRecord=r.id;
    this.log(id,'System','Size failure saved',`${error.message}${error.detail?.stage?` at ${error.detail.stage}`:''}: record ${r.id} on this computer${r.count>1?` (the same failure ${r.count} times)`:''}${r.inputKept?', with the input that was not sent':'; the input was too large to keep, its sizes are'}. Nothing was uploaded.`);}catch{}}
  // Whether a market's session was open in a review's context.
  marketOpenIn(context){return market=>context.environment==='kis-combined'?context.markets?.find(row=>row.market===market)?.marketSession?.open===true:context.marketSession?.open!==false;}
  // Company research for a live review, held back by an open wait on its symbol (electron/waits.cjs): answered with the
  // wait while the review gate is on, logged as what would be held while it observes. Your own requests, emergencies
  // and anything the gate saw change about the symbol read as usual.
  // Each reply's sections are noted for the review (waits.outcomes), so a wait can hold exactly what was unavailable. A
  // request with some sections held reads the others and says which were skipped and why.
  researchFor({watchScope,trigger,emergency,gate,gateMode,id}){const note=(args,r)=>{try{const found=require('./waits.cjs').outcomes(args,r,{ttl:require('./research-service.cjs').sourceTtl});const seen=(this.researchSeen??=new Map());if(!seen.has(id))seen.set(id,[]);seen.get(id).push(...found);this.waits.available(watchScope,found);}catch{}return r;};
    // Research suppression (audit 2026-11-04, Stage 4) is its own setting: on, research the tools confirmed unavailable is
    // held whatever the review gate does; a filing or important news about the symbol since a block began releases it.
    const suppress=this.config.researchSuppression==='on';const changedSince=(symbol,t)=>{try{return this.newsEvents.list(300).some(e=>(e.symbols??[]).includes(symbol)&&(e.kind==='disclosure'||e.importance==='high')&&e.firstSeenAt>t);}catch{return false;}};
    return async args=>{
    // Without a gate result (it failed) nothing could override a wait, so nothing is held unless suppression is on.
    const held=(suppress||gateMode!=='off'&&gate)&&!emergency&&!['User request','Emergency loss response'].includes(trigger)?this.waits.guard(watchScope,args?.symbol,{sections:args?.sections,overridden:new Set(gate?.changedSymbols??[]),isOpen:m=>this.sessionOpen(m),changedSince}):null;
    if(held){const what=held.reason==='market_closed'?`market closed until it opens`:held.held.map(h=>`${h.section} (${h.unavailable}) until ${h.until}`).join(', ');
      if(gateMode==='on'||suppress){this.log(id,'System','Research waits',`${held.symbol}: ${what}${held.status==='partial'?`; reading ${held.read.join(', ')}`:''}.`);if(held.status!=='partial')return held;
        const r=note(args,await this.discovery.research({...args,sections:held.read}));return r&&typeof r==='object'?{...r,skippedSections:held.held.map(({section,unavailable,until})=>({section,unavailable,until})),skippedNote:held.note,releasedBy:held.releasedBy}:r;}
      this.log(id,'System','Research would wait',`${held.symbol}: ${what}; the review gate is observing, so it is read.`);}
    return note(args,await this.discovery.research(args));};}
  // The review gate for the settings page: its mode and what it found over the last 7 days.
  reviewGateState(){let summary=null;try{summary=this.stateCached('gateSummary',()=>this.reviewGate.summary(Date.now()-7*86400000));}catch{}return {mode:this.config.reviewGate??'off',summary};}
  // The selective alert rules for the settings page: thresholds and what observation found over the last 7 days.
  // The completed reviews since a time and the symbols each assessed (triggered by, gave a verdict on or held); reviews
  // saved before Stage 5 give their verdicts and decision symbol only. Returns assessed(symbol, from, to) for episodes.
  assessedLookup(since){const list=this.db.prepare("SELECT payload FROM reviews WHERE json_extract(payload,'$.timestamp')>=? ORDER BY json_extract(payload,'$.timestamp')").all(since).map(r=>JSON.parse(r.payload))
      .map(r=>({t:r.timestamp,symbols:new Set(r.assessed??[...(r.decision?.planVerdicts??[]).map(v=>v.symbol),r.decision?.symbol].filter(Boolean))}));
    return (symbol,from,to)=>list.find(r=>r.t>from&&r.t<=to&&r.symbols.has(symbol))?.t??null;}
  watchlistAlertsState(){const T=this.config.eventTolerancePct;let summary=null;try{summary=this.stateCached('alertSummary',()=>{const since=Date.now()-7*86400000;return this.alertObservations.summary(since,{assessed:this.assessedLookup(since)});});}catch{}
    let trial=null;try{trial=this.alertTrial.report();}catch{}
    return {mode:this.config.watchlistAlerts,holdingPct:T,watchlistPct:this.config.watchlistMovePct??2*T,summary,trial};}
  // How each watchlist symbol is monitored under the rule in force: a holding, an entry level the AI set, or watching.
  monitoring(){const scope=this.watchScope();if(!scope)return null;const notHeld=this.config.notHeldPriceReviews??'default';const held=notHeld==='default'?new Set(heldSymbols(this.brokerPositions())):this.heldNow();const watches=this.watches.list(scope);
    const T=this.config.eventTolerancePct,mode=this.config.watchlistAlerts,W=mode==='on'?this.config.watchlistMovePct??2*T:T;
    return {mode,holdingPct:T,watchlistPct:W,symbols:Object.fromEntries((this.discovery?.list?.()??[]).map(e=>{const w=watches.find(x=>x.symbol===e.symbol);
      return [e.symbol,held.has(e.symbol)?{kind:'holding',pct:w?.percent??T}:notHeld==='never'?{kind:'off'}:w?.price!=null&&!w.priceFired?{kind:'entry-level',price:w.price,direction:w.direction}:notHeld==='levels'?{kind:'off'}:{kind:'watching',pct:w?.percent??W}];}))};}
  // The price review to start, if any: the one rule for every quoted symbol (watchlistAlerts 'off'), or the selective
  // rules of electron/watch-alerts.cjs ('on'). 'observe' keeps the one rule and logs what the selective rules would do:
  // both read the watches as they were before this check, and the selective rules keep their own record of fired
  // levels, so the rule in force marking a level fired does not hide it from them.
  // skipLevels: level events held while a size failure stands (electron/size-retry.cjs); they apply to the rule in force
  // only, so observation records what its rules would do whatever happened to live reviews.
  priceTrigger(scope,quotes,now=Date.now(),{skipLevels=new Set()}={}){
    // Item 11: off the default, "Price reviews for stocks you don't hold" (priceTriggerNotHeld); the path below is today's.
    {const notHeld=this.config.notHeldPriceReviews??'default';if(notHeld!=='default')return this.priceTriggerNotHeld(scope,quotes,now,skipLevels,notHeld);}
    // The watchlist alert trial (electron/alert-trial.cjs) runs the selective rules as 'on' and the current rule in shadow.
    const trial=this.trialRunning();const mode=trial?'on':this.config.watchlistAlerts??'off';const watches=this.watches.list(scope);const current=mode==='on'?null:this.watches.detect(scope,quotes,this.lastPrices,this.config.eventTolerancePct,now,skipLevels);
    if(current?.kind==='price')this.watches.fired(scope,current.symbol);if(mode==='off')return current;
    const fresh=quotes.filter(q=>{const t=q.timestamp??q.retrievedAt;return !q.stale&&q.price>0&&Number.isFinite(t)&&t<=now+1000&&now-t<=90000&&this.sessionOpen(/:/.test(q.symbol)?'US':'KR',now);}).map(q=>({...q,timestamp:q.timestamp??q.retrievedAt}));
    const held=new Set(heldSymbols(this.brokerPositions()));const tolerance=this.config.eventTolerancePct;
    const shadow=trial?this.watches.detect(scope,quotes,this.lastPrices,tolerance,now,skipLevels):null;
    let checked;try{checked=this.watchAlerts.check({quotes:fresh,held,baselines:this.lastPrices,watches,tolerance,wide:this.config.watchlistMovePct??2*tolerance,now,ownFired:mode==='observe',skipLevels:mode==='on'?skipLevels:new Set()});}
    catch(error){if(!trial)throw error;this.endTrial('check-error');return shadow;}const {trigger,deliver}=checked;
    if(mode==='observe'){deliver();try{this.alertObservations.record(now,{current,proposed:trigger,held,scope});}catch{}return current;}
    for(const symbol of deliver())this.watches.fired(scope,symbol);
    // Shadow: what the current rule would have done, read before the selective rules mark levels fired and never acted on.
    if(trial){try{this.alertObservations.record(now,{current:shadow,proposed:trigger,held,scope,mode:'trial'});}catch{this.endTrial('shadow-log');}this.lastShadow={at:now,fired:Boolean(shadow)};this.alertTrial.check({now,shadow,proposed:trigger,held,quotes:fresh,watches});}
    return trigger;}
  // Item 11 (artifacts/reviews/2026-11-17-not-held-price-reviews/design-note.md, cleared): 'levels' or 'never'. Holdings
  // keep the rules of the "Watchlist alerts" mode; a stock not held starts a price review only by crossing a level the AI
  // set on it ('levels', the crossing rule in every mode) or not at all ('never'). Under Off and Observe the rule in force
  // sees the held quotes only (detect returns its first match, so a stock not held must not hide a holding), then the
  // entry-level tracker checks the stocks not held (under 'never' it only keeps each level's side). Observe still logs
  // both rules unfiltered, with the setting. No trial runs with this setting (setConfig).
  heldNow(){return new Set(heldSymbols(this.config.scope==='paper'?this.paper.getState().account.positions:this.brokerPositions()));}
  priceTriggerNotHeld(scope,quotes,now,skipLevels,notHeld){
    const mode=this.config.watchlistAlerts??'off',watches=this.watches.list(scope),tolerance=this.config.eventTolerancePct,held=this.heldNow(),rule=notHeld==='levels'?'levels':'none',wide=this.config.watchlistMovePct??2*tolerance;
    const fresh=quotes.filter(q=>{const t=q.timestamp??q.retrievedAt;return !q.stale&&q.price>0&&Number.isFinite(t)&&t<=now+1000&&now-t<=90000&&this.sessionOpen(/:/.test(q.symbol)?'US':'KR',now);}).map(q=>({...q,timestamp:q.timestamp??q.retrievedAt}));
    if(mode==='on'){const {trigger,deliver}=this.watchAlerts.check({quotes:fresh,held,baselines:this.lastPrices,watches,tolerance,wide,now,skipLevels,notHeld:rule});for(const symbol of deliver())this.watches.fired(scope,symbol);return trigger;}
    let trigger=this.watches.detect(scope,quotes.filter(q=>held.has(q.symbol)),this.lastPrices,tolerance,now,skipLevels);
    const entry=this.entryLevels.check({quotes:fresh.filter(q=>!held.has(q.symbol)),held:new Set(),baselines:this.lastPrices,watches,tolerance,wide,now,skipLevels,notHeld:rule});
    if(trigger?.kind==='price')this.watches.fired(scope,trigger.symbol);else if(!trigger&&entry.trigger){trigger=entry.trigger;for(const symbol of entry.deliver())this.watches.fired(scope,symbol);}
    if(mode==='observe'){const current=this.watches.detect(scope,quotes,this.lastPrices,tolerance,now,skipLevels);const checked=this.watchAlerts.check({quotes:fresh,held,baselines:this.lastPrices,watches,tolerance,wide,now,ownFired:true});checked.deliver();
      try{this.alertObservations.record(now,{current,proposed:checked.trigger,held,scope,notHeld});}catch{}}
    return trigger;}
  trialRunning(){return this.config.alertTrial==='on'&&Boolean(this.alertTrial?.current());}
  // Which price-alert rules were in force (audit 2026-11-04, Stage 5), saved on gate, schedule and review records so the
  // trial's effect on review timing is never read as review-gate or schedule performance.
  alertTag(){const trial=this.trialRunning()?this.alertTrial.current():null;return {mode:trial?'trial':this.config.watchlistAlerts??'off',rules:require('./watch-alerts.cjs').RULES_VERSION,...(trial?{trialId:trial.id}:{}),...((this.config.notHeldPriceReviews??'default')!=='default'?{notHeld:this.config.notHeldPriceReviews}:{})};}
  // Ends the trial: the setting goes back to off (price reviews from the current rule), with the reason logged and sent.
  endTrial(reason,detail=null){const t=this.alertTrial.end(reason,detail);this.config={...this.config,alertTrial:'off'};this.saveConfig();this.revision=(this.revision??0)+1;
    const why=reason==='completed'?`Completed: ${detail??''}`:`Rolled back: ${detail??require('./alert-trial.cjs').ROLLBACK[reason]??reason}`;this.log(randomUUID(),'System','Watchlist alert trial ended',`${why} Price reviews come from the current rule again.`);try{this.notify?.('alert-trial-'+(t?.id??reason),`Watchlist alert trial ended. ${why}`);}catch{}return t;}
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
  // Why a Buy of a leveraged or inverse product may not open now (fact check X2), or null: the AI may consider these
  // products only with the switch on and broker eligibility confirmed. Sells (closing or protecting) are never refused here.
  // A failure to classify leaves the Buy alone (standard Buys must not be blocked); once the product is known to be
  // leveraged or inverse, a failure to read the setting refuses it.
  leveragedEntryRefusal(engine,symbol,side){if(side!=='Buy')return null;const ex=engine?.exposure;if(!ex)return null;let product;try{product=ex.classify(symbol);}catch{return null;}if(!product||product.kind==='standard')return null;
    let access;try{access=require('./exposure.cjs').leveragedAccess(ex.policy(engine.identity()).leveragedEtps);}catch{return `A ${product.kind} product (${product.factor}x daily): could not read the leveraged-product setting; nothing was sent.`;}
    return access.allowed?null:`A ${product.kind} product (${product.factor}x daily) is not permitted for this account: ${access.reason}`;}
  // use: the review's FormulaUse counter (T0), or null; it only counts and never changes a reply.
  deskActions(scope,context,reviewId,guard,use=null){
    const count=fn=>{try{if(use)fn();}catch{}};
    const universe=(context.universe??[]).map(r=>r.symbol);const formula=require('./formula.cjs');
    return {
      compute:async args=>{
        const list=Array.isArray(args?.formulas)?args.formulas.slice(0,5):[];if(!list.length)return {status:'rejected',reason:'Give 1 to 5 formulas.'};
        const parsed=list.map(f=>{try{return {name:String(f.name??'').slice(0,40)||'value',expr:f.expr,...formula.parse(f.expr)};}catch(e){return {name:f.name,expr:f.expr,error:e.code+(e.detail?`: ${e.detail}`:'')};}});
        const symbols=[...new Set(parsed.flatMap(p=>p.symbols??[]))];if(symbols.length>6)return {status:'rejected',reason:'At most 6 symbols per call.'};
        await this.warmSeries(symbols);const data=this.formulaData(context.quotes??[]);
        const results=parsed.map(p=>{if(p.error)return {name:p.name,error:p.error};try{const v=formula.evaluate(p.ast,data);return {name:p.name,value:Math.round(v*1e6)/1e6};}catch(e){return {name:p.name,error:e.code+(e.detail?`: ${e.detail}`:'')};}});
        count(()=>use.compute(parsed,results));
        return {status:'ok',results,note:'Daily functions use completed daily closes; price() is the latest quote.'};
      },
      set_review_trigger:async args=>{guard();const reply=this.desk.setTrigger(scope,args,{universe,reviewId});if(reply.status==='saved')void this.warmSeries(reply.symbols);if(reply.status==='saved'){count(()=>use.item('trigger',reply.id,this.desk.triggers(scope).find(t=>t.id===reply.id)?.conditions));const check=formula.checkConditions(this.desk.triggers(scope).find(t=>t.id===reply.id).conditions,args.combine,this.formulaData(context.quotes??[]));reply.currentValues=check.results.map(r=>({expr:r.expr,actual:r.actual,met:r.met,...(r.error?{error:r.error}:{})}));const note=require('./not-held.cjs').triggerNote(this.config.notHeldPriceReviews,reply.symbols,this.heldNow());if(note)reply.note=note;}return reply;},
      save_assessment:async args=>{guard();return this.assessments.save(scope,args,{context,reviewId,symbols:[...new Set([...Object.keys(context.positions??{}),...(context.universe??[]).map(r=>r.symbol)])]});},
      save_note:async args=>{guard();return this.desk.saveNote(scope,args,{orderIds:this.engineOrders().filter(o=>o.symbol===String(args?.symbol??'').trim().toUpperCase()&&require('./note-staleness.cjs').OPEN.includes(o.status)).map(o=>o.id)});},
      set_conditional_order:async args=>{guard();if(args?.action!=='cancel'&&context.environment==='local-paper')return {status:'rejected',reason:'Conditional orders need a KIS account.'};
        if(args?.action!=='cancel'&&args?.side==='Buy'){const sym=String(args.symbol??'').trim().toUpperCase();const refused=this.leveragedEntryRefusal(/:/.test(sym)?this.usLive:this.live,sym,'Buy');if(refused)return {status:'rejected',reason:refused};}if(args?.trail?.atrMultiple!=null)await this.warmSeries([String(args.symbol??'')]);const reply=this.desk.setOrder(scope,args,{config:this.config,universe,quotes:context.quotes??[],reviewId,positions:context.positions??null,atr:sym=>this.trailAtr(sym),lot:args?.action!=='cancel'&&args?.credit?this.creditLot(args,{quantity:args.quantity}):null});if(reply.replaced)this.logStopReplaced(scope,reviewId,reply.replaced,reply.id);if(reply.status==='armed'){await this.warmSeries(this.desk.orders(scope).find(o=>o.id===reply.id).symbols);const o=this.desk.orders(scope).find(x=>x.id===reply.id);count(()=>use.item('conditionalOrder',reply.id,o?.conditions));const check=formula.checkConditions(o.conditions,o.combine,this.formulaData(context.quotes??[]));reply.currentValues=check.results.map(r=>({expr:r.expr,actual:r.actual,met:r.met,...(r.error?{error:r.error}:{})}));if(check.met)reply.warning='The conditions are already met; it will fire on the next check while auto trading is on and the market is open.';if(o.trail){reply.trail={level:o.trail.level,high:o.trail.high,active:o.trail.active,distance:o.trail.kind==='pct'?`${o.trail.pct}%`:o.trail.distance};if(!reply.renewed)this.log(o.id,'System',`Trailing stop armed · ${o.symbol}`,require('./trailing-stops.cjs').armedText(o));}}return reply;},
    };
  }
  // One console entry for a stop replaced in one step (step A-R): both ids and both levels. Never throws.
  logStopReplaced(scope,reviewId,oldId,newId){try{const all=this.desk.rows('conditional_orders',scope);const find=id=>all.find(o=>o.id===id);const level=o=>(o?.conditions??[]).map(c=>`${c.op} ${c.value}`).join(' and ')||'?';const n=find(newId);
    this.log(reviewId??randomUUID(),'System',`Stop loss replaced: ${oldId} → ${newId}`,`${n?.symbol??''} ${n?.side??''} ${n?.quantity??''}: ${level(find(oldId))} → ${level(n)}`.trim());}catch{}}
  // Conditional orders fire one at a time: fresh account read, conditions re-checked, then every guardrail before the normal proposal path.
  // A conditional order's credit lot against the Korean account now (audit 2026-11-04, Stage 4): its path must be
  // executable and automatic (credit-paths.cjs: confirmed broker fields and the user's Stage 3 approval), the lot must
  // exist with that loan date and source, and quantity (when given) must fit what remains after waiting orders.
  // Returns {ok, lot, available, reserved, account} or {ok:false, reason}.
  creditLot(order,{quantity=null}={}){const CP=require('./credit-paths.cjs');const c=order.credit,what=c.kind==='cover'?'cover':'margin repayment';const engine=this.live;
    if(/:/.test(order.symbol)||!engine)return {ok:false,reason:'Credit lots exist only on the Korean account.'};
    const path=CP.pathStatus(c.kind,{approved:this.config.creditProtectionApproved===true});
    if(!path.executable||!path.automatic)return {ok:false,reason:`A ${what} cannot run as a conditional order now: ${path.executable?path.label:path.reason}. The lot stays unprotected; close it in KIS if needed.`};
    const bal=engine.riskBalance??engine.getConnection?.()?.snapshot;if(!bal?.holdings)return {ok:false,reason:'The account balance is not available to check the lot.'};
    let r;try{r=CP.remaining(bal,{symbol:order.symbol,side:order.side,credit:{kind:c.kind,loanDate:c.loanDate}},engine.orders?.()??[]);}catch{return {ok:false,reason:`No ${what} lot of ${order.symbol} with loan date ${c.loanDate}.`};}
    if(r.lot.source&&r.lot.source!==c.source)return {ok:false,reason:`The ${order.symbol} lot of ${c.loanDate} is a ${r.lot.source} loan, not ${c.source}.`};
    if(quantity!=null&&quantity>r.available)return {ok:false,reason:`The ${order.symbol} lot of ${c.loanDate} has ${r.available} shares left after waiting orders (${r.reserved} reserved).`};
    return {ok:true,lot:r.lot,available:r.available,reserved:r.reserved,account:(()=>{try{return engine.identity();}catch{return null;}})()};}
  async fireConditional(order){
    const scope=this.watchScope();if(order.scope!==scope)return;const note=(status,outcome,extra={})=>{if(order.trail)outcome+=require('./trailing-stops.cjs').firedText(order);const saved=this.desk.update(order,{status,outcome,closedAt:Date.now(),...extra});this.log(order.id,'System','Conditional order · '+status,`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): ${outcome}`);
      if(status==='rejected'&&order.side==='Sell'&&order.purpose==='stop_loss')try{this.notify?.('stop-rejected-'+order.id,`Stop loss for ${order.symbol} was rejected: ${outcome} The position is not protected until a new one is armed.`);}catch{}return saved;};
    // The market comes once from the instrument (a U.S. symbol carries its exchange, as NASD:NVDA) and must be the
    // account's. Audit 2026-11-04: the Buy checks read an undeclared market, so every conditional Buy threw a
    // ReferenceError that was reported as a broker refusal.
    const market=/:/.test(order.symbol)?'US':'KR';const engine=market==='US'?this.usLive:this.live;if(!engine)return note('rejected','No account for this market.');
    if(engine.market&&engine.market!==market)return note('rejected',`Internal error (MARKET_MISMATCH): ${order.symbol} is a ${market} listing but the account trades ${engine.market}. Nothing was sent.`);
    // A proposal this order made that never reached KIS is retired before the order is retried, so a retry never leaves two
    // proposals for one order. status: the engine's record of it (null before any proposal or when the engine has none).
    let proposal=null,slot=null;const status=id=>{try{return engine.orders?.().find(r=>r.id===id)?.status??null;}catch{return null;}};
    const retire=()=>{if(proposal&&status(proposal.id)==='Ready')try{engine.annotate?.(proposal.id,{expiresAt:Date.now(),reason:'SUPERSEDED'});}catch{}};
    const BUSY='another order in progress';const busy=()=>{retire();if(order.waiting!==BUSY)this.log(order.id,'System','Conditional order · waiting',`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): another order for this market is being sent; checking again in 10 seconds.`);this.desk.update(order,{status:'armed',waiting:BUSY,nextCheckAt:Date.now()+10000});};
    // A passing refusal before anything reached KIS (rate limit, timeout, network, server): armed again for up to three
    // attempts a minute apart, each logged as not executed, then closed as rejected (temporary).
    // at: when the broker may be asked again (a request-limit refusal's retryAt, M-1a); never sooner than a minute.
    const retry=(code,at=null)=>{retire();const retries=(order.retries??0)+1;if(retries>3)return note('rejected',`Not sent: ${code} on three attempts in a row (temporary). Nothing reached the broker.`,{retries});
      const next=Math.max(Date.now()+60000,Number.isFinite(at)?at:0),when=next-Date.now()>61000?`at ${new Date(next).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST`:'in a minute';
      this.log(order.id,'System','Conditional order · waiting',`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): not executed, ${code} before anything reached the broker; trying again ${when} (attempt ${retries} of 3).`);this.desk.update(order,{status:'armed',waiting:`temporary refusal (${code})`,retries,nextCheckAt:next});};
    const closed=()=>this.desk.update(order,{status:'armed',waiting:'market closed',nextCheckAt:Date.now()+300000});
    this.desk.update(order,{status:'firing',firingAt:Date.now()});
    try{
      const ctx=await engine.context(market==='US'?await this.refreshUS():null);
      if(!ctx.marketSession?.open)return closed();
      const quote=ctx.quotes.find(q=>q.symbol===order.symbol);if(!(quote?.price>0)){this.desk.update(order,{status:'armed',waiting:'no fresh quote',nextCheckAt:Date.now()+60000});return;}
      const formula=require('./formula.cjs');const base=this.formulaData(ctx.quotes);const check=formula.checkConditions(order.conditions,order.combine,{...base,price:sym=>ctx.quotes.find(q=>q.symbol===sym)?.price??base.price(sym)});
      if(!check.met){this.desk.update(order,{status:'armed',waiting:null,retries:0,lastCheck:check.results,nextCheckAt:Date.now()+60000});return;}
      // A plan stop linked to its purchase (P1) sells at most what that purchase filled; nothing filled yet, it waits while
      // the purchase is open and closes once it ended unfilled. Shares held before the purchase are never sold by it.
      // A record that cannot be read (orders() is empty while the account identity cannot be read) is usually momentary:
      // the stop stays armed and retries; after five minutes of this it is shown on Home (review of the plan stop fixes).
      let linkedCap=null;if(order.linkedBuy){const lp=this.linkedPurchase(order);if(!lp){const since=order.unreadableSince??Date.now();this.desk.update(order,{status:'armed',waiting:'its purchase record cannot be read',unreadableSince:since,nextCheckAt:Date.now()+30000});
          if(Date.now()-since>300000&&!order.unreadableNoticeAt){this.desk.update({...order,unreadableSince:since},{status:'armed',waiting:'its purchase record cannot be read',unreadableSince:since,unreadableNoticeAt:Date.now(),nextCheckAt:Date.now()+30000});this.log(order.id,'System','Stop order cannot check its purchase',`${order.side} ${order.quantity} ${order.symbol} (${order.purpose}): the record of its purchase has not been readable for more than five minutes; it stays armed and keeps trying.`);try{this.notify?.('stop-unreadable-'+order.id,`The stop order for ${order.symbol} cannot read its purchase record; it stays armed and keeps trying.`);}catch{}}
          return;}
        if(order.unreadableSince){order={...order,unreadableSince:null,unreadableNoticeAt:null};this.desk.update(order,{status:'firing'});}
        if(lp.filled<1){if(lp.ended)return note('cancelled',`Not needed: the purchase did not fill (it was ${lp.status}${lp.reason?`: ${lp.reason}`:''}).`,{results:check.results});this.desk.update(order,{status:'armed',waiting:'its purchase has not filled',nextCheckAt:Date.now()+30000});return;}
        linkedCap=lp.filled;}
      // Priced from a fresh order book with limitPrice as the bound (a sale's floor, a purchase's cap); without a book for a
      // minute the order stays armed and a review is asked for.
      const placement=await this.placementPrice({symbol:order.symbol,side:order.side,bound:order.limitPrice??null,id:order.id,still:()=>this.watchScope()===scope});
      if(!placement){this.desk.update(order,{status:'armed',waiting:'no order book',nextCheckAt:Date.now()+60000});return;}const limit=placement.price;
      const drift=Math.abs(limit/quote.price-1)*100;if(drift>this.config.conditionalMaxSlippagePct)return note('rejected',`Limit ${limit} is ${drift.toFixed(2)}% from the price ${quote.price}, above the ${this.config.conditionalMaxSlippagePct}% limit.`,{results:check.results});
      // Another order for this market is being sent (the engine sends one at a time): the order stays armed and is checked
      // again shortly, with its conditions re-read. Checked before proposing, so no proposal is left behind.
      if(engine.busy)return busy();
      let quantity=linkedCap==null?order.quantity:Math.min(order.quantity,linkedCap);
      // A credit-lot order: the path, the account, the lot and what remains in it are checked again now; the order never
      // takes more than remains, so a partial fill or a duplicate trigger cannot sell or buy past the lot.
      if(order.credit){const lot=this.creditLot(order);if(!lot.ok)return note('rejected',`Not sent: ${lot.reason}`,{results:check.results});
        if(order.credit.account&&lot.account&&order.credit.account!==lot.account)return note('rejected','Not sent: the account changed since this order was armed.',{results:check.results});
        if(lot.available<1)return lot.reserved>0?note('cancelled',`Not needed: an order already waiting takes this lot (${lot.reserved}).`,{results:check.results}):note('rejected','The lot is already closed.',{results:check.results});
        quantity=Math.min(quantity,lot.available);}
      // No shares held on a fresh read: the stop has nothing left to protect (for example a duplicate stop after the first
      // sold the share), so it is closed as not needed, without a "not protected" alert. Only when the holdings could not
      // be read is it a rejection.
      else if(order.side==='Sell'){const known=Boolean(ctx.positions&&typeof ctx.positions==='object'),held=ctx.positions?.[order.symbol]?.quantity??0;if(held<1)return known?note('cancelled',`Not needed: no shares of ${order.symbol} are held.`,{results:check.results}):note('rejected','No shares held to sell: the holdings could not be read.',{results:check.results});
        // Only cash shares not already in a waiting sale (credit-paths.cjs, Stage 3): margin-loan shares are never sold as
        // cash, and two stops never sell the same shares. Shares a waiting sale already takes need no second order.
        let free=held,reserved=0;try{const bal=engine.riskBalance??engine.getConnection?.()?.snapshot;if(bal?.holdings){const r=require('./credit-paths.cjs').remaining(bal,{symbol:order.symbol,side:'Sell'},engine.orders?.()??[]);free=r.available;reserved=r.reserved;}}catch{}
        if(free<1)return reserved>0?note('cancelled',`Not needed: a sale already waiting takes these shares (${reserved}).`,{results:check.results}):note('rejected','No cash shares free to sell: the shares held are margin-loan lots, which only a margin repayment sale can close.',{results:check.results});
        quantity=Math.min(quantity,held,free);}
      const notional=quantity*limit;
      if(order.side==='Buy'){
        const cap=ctx.equity*this.config.conditionalMaxOrderPct/100;if(!(notional<=cap))return note('rejected',`Order value ${Math.round(notional)} is above ${this.config.conditionalMaxOrderPct}% of equity (${Math.round(cap)}).`,{results:check.results});
        if(!(ctx.cash>=notional*1.005))return note('rejected','Not enough cash for the order and fees.',{results:check.results});
        // The same rule as a review's Buy: blocked only in the market whose daily loss limit is reached.
        const emergency=order.credit?{}:this.emergencyState();if((emergency.activeMarkets??(emergency.active?[market]:[])).includes(market)&&this.config.lossAction!=='review')return note('rejected','New buys are blocked after the daily loss limit.',{results:check.results});
        if((emergency.ambiguousMarkets??[]).includes(market)&&this.config.lossAction!=='review')return note('rejected','New buys are restricted: whether the daily loss limit is reached depends on values not yet confirmed. No loss is claimed.',{results:check.results});
        if((emergency.unavailableMarkets??[]).includes(market))return note('rejected','New buys are restricted: the daily loss check cannot be evaluated right now (its data could not be read). No loss is claimed.',{results:check.results});
        if((emergency.lateMarkets??[]).includes(market))return note('rejected','New buys are restricted for the rest of the day: today\'s opening value could not be read, so an earlier loss cannot be ruled out.',{results:check.results});
        // Leveraged or inverse entries need the switch and confirmed broker eligibility (fact check X2), checked again here
        // because the setting can change after the order was armed.
        {const refused=this.leveragedEntryRefusal(engine,order.symbol,order.side);if(refused)return note('rejected',refused+' Nothing was sent.',{results:check.results});}
      }
      proposal=engine.propose({symbol:order.symbol,side:order.side,quantity,limitPrice:limit,...(order.credit?{credit:{kind:order.credit.kind,loanDate:order.credit.loanDate}}:{})});if(order.limitPrice>0)engine.annotate?.(proposal.id,{tracking:{bound:order.limitPrice}});
      // The same daily cap as reviews' (1.5.48 audit, A6), taken before the send; a closing order is not held back by it.
      const cap=this.config.maxAutoOrdersPerDay;const wanted=this.config.conditionalAutoSubmit&&this.config.autoSubmit&&engine.autoEnabled!==false&&proposal.status==='Ready'&&!proposal.requiresApproval;
      const closing=(()=>{try{return !require('./credit-paths.cjs').effectOf({side:order.side,credit:order.credit?.kind??'none'}).opening;}catch{return order.side==='Sell'&&!order.credit;}})();
      slot=wanted?this.guardrails.reserveSlot({cap,source:'conditional',ref:'conditional:'+proposal.id,closing}):null;const capReached=wanted&&!slot;const auto=wanted&&Boolean(slot);
      const waits=why=>note('proposed',`Not executed: proposal ${proposal.id} at ${limit} for ${quantity} shares ${why}. Nothing is at the broker until it is approved.`,{proposalId:proposal.id,results:check.results});
      if(!auto)return waits(capReached?'awaits your approval (daily automatic order limit reached)':'awaits your approval');
      // What KIS did with it, from the engine's record: accepted, refused, or unclear. An unclear reply is not accepted
      // or filled and is never retried here: the account takes no new order until KIS order history settles it.
      const placed=await engine.autoSubmit(proposal.id);const sent=placed?.status??'Accepted';this.settleAutoSlot(slot,engine.orders?.().find(r=>r.id===proposal.id)??placed);slot=null;
      if(placed?.reason==='APPROVAL_REQUIRED')return waits('needs your approval (extended session or product rule)');
      if(sent==='Rejected'&&placed.reason==='SESSION_CLOSED')return closed();
      // M-1a: KIS's request limit refused it before it was sent; armed again for when KIS may be asked.
      if(sent==='Rejected'&&placed.reason==='ORDER_NOT_SENT')return retry(placed.notSentCause==='ticket-expired'?'TICKET_EXPIRED':'RATE_LIMITED',placed.retryAt);
      if(sent==='Rejected')return note('rejected',`The broker rejected it (${placed.reason??'BROKER_REJECTED'}${placed.brokerCode?`, KIS ${placed.brokerCode}`:''}). No order was placed.`,{proposalId:proposal.id,orderId:placed.id??null,brokerStatus:sent,results:check.results});
      // A sale went out: the other armed cash sells of this symbol wait a minute, so the next one is judged on a balance read
      // after this fill. This narrows, not closes, the window where a fill is recorded before the balance shows it.
      if(order.side==='Sell'&&!order.credit)for(const other of this.desk.orders(scope))if(other.id!==order.id&&other.symbol===order.symbol&&other.side==='Sell'&&!other.credit)this.desk.update(other,{nextCheckAt:Math.max(other.nextCheckAt??0,Date.now()+60000)});
      if(sent==='Uncertain'||sent==='Submitting')return note('submitted',`Sent at ${limit} for ${quantity} shares, but the broker's reply was unclear (ORDER_UNCERTAIN): not confirmed as accepted or filled. New orders on this account wait until KIS order history confirms it; it is not retried.`,{proposalId:proposal.id,orderId:placed.id??null,brokerStatus:sent,unconfirmed:true,results:check.results});
      return note('submitted',`Submitted at ${limit} for ${quantity} shares.`,{proposalId:proposal.id,orderId:placed?.id??null,brokerStatus:sent,results:check.results});
    }catch(error){
      // unsent: nothing of it can be at KIS (no proposal, or the engine's record says it was never placed or was refused).
      const f=require('./broker-errors.cjs').classify(error);const at=proposal?status(proposal.id):null;const unsent=!['Submitting','Uncertain','Accepted','Partially filled','Filled','Cancellation uncertain'].includes(at);
      if(slot)this.settleAutoSlot(slot,proposal?engine.orders?.().find(r=>r.id===proposal.id)??null:null);
      if(f.code==='KIS_ORDER_BUSY')return busy();
      if(f.kind==='temporary'&&unsent)return f.code==='SESSION_CLOSED'?(retire(),closed()):retry(f.code);
      const left=proposal?` Proposal ${proposal.id} was not sent${at==='Ready'?'':` (its status: ${at??'unknown'})`}.`:' Nothing was proposed.';
      if(f.kind==='internal'){this.log(order.id,'System','Conditional order · internal error',`${order.side} ${order.quantity} ${order.symbol}: ${f.type}${f.where?` at ${f.where}`:''}. This is a fault in the app, not a broker or risk refusal.`);
        return note('rejected',unsent?`Internal error in the app (INTERNAL_ERROR, ${f.type}${f.where?` at ${f.where}`:''}).${left} Nothing was sent to the broker.`:`Internal error in the app (INTERNAL_ERROR, ${f.type}${f.where?` at ${f.where}`:''}) after proposal ${proposal.id} reached status ${at}: it may be at the broker. Check the order list before arming another.`,{failure:f});}
      if(f.kind==='uncertain'||!unsent)return note('submitted',`The broker's reply was unclear (${f.code}): not confirmed as accepted or filled. New orders on this account wait until KIS order history confirms it; it is not retried.`,{proposalId:proposal?.id??null,brokerStatus:at,unconfirmed:true,failure:f});
      if(f.kind==='broker')return note('rejected',`The broker rejected it (${f.code}${f.brokerCode?`, KIS ${f.brokerCode}`:''}).${left}`,{failure:f});
      return note('rejected',`An app order check refused it (${f.code}).${left}`,{failure:f});}
  }
  // Settles an automatic-order slot from the engine's record of the order (1.5.48 audit, A6): released only when it shows
  // nothing was sent (still Ready, waiting for approval, or refused by the app before sending); otherwise used.
  settleAutoSlot(slot,record){if(!slot)return;const s=record?.status??null,reason=record?.reason??null;
    const unsent=s==='Ready'||s==='Rejected'&&['SESSION_CLOSED','CREDIT_PATH_UNVERIFIED','ORDER_NOT_SENT'].includes(reason)||reason==='APPROVAL_REQUIRED'&&s!=='Submitting';
    this.guardrails.settleSlot(slot,unsent?'released':'used',{status:s,...(reason?{reason}:{})});}
  // ATR(14) for a trailing stop's distance (T2): completed daily bars only, so a bar of the exchange's current day is left
  // out. {value, date of the last bar used} or null.
  trailAtr(symbol){try{const T=require('./trailing-stops.cjs');const bars=this.series?.closes(symbol);if(!Array.isArray(bars))return null;const today=T.dayOf(Date.now(),T.marketOf(symbol));
    const done=bars.filter(b=>String(b?.date??'')<today);const v=require('./indicators.cjs').atr(done,14);return Number.isFinite(v)&&v>0?{value:Math.round(v*10000)/10000,date:done.at(-1)?.date??null}:null;}catch{return null;}}
  // One tracking step for every armed trailing stop (electron/trailing-stops.cjs, step T1): regular-session quotes only,
  // the two-check rule, and a row write only when the level moves by a tick. Never throws; a failure skips that order.
  trackTrailing(scope=this.watchScope(),now=Date.now()){const T=require('./trailing-stops.cjs');const {regularOpen}=require('./market-hours.cjs');this.trailMemory??=new Map();
    let quotes=[];try{quotes=this.liveQuotes();}catch{}const closed=new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]);
    // T3: trailSeen (this run, per order): when tracking last stepped, when a quote was last accepted, and since when the
    // regular session has been open, for the gap test and "not tracked since"; trailCatching: catch-ups in flight.
    this.trailSeen??=new Map();this.trailCatching??=new Set();
    for(let o of this.desk.orders(scope)){if(!o.trail)continue;try{const market=T.marketOf(o.symbol),regular=t=>regularOpen(market,t,closed);
      // A plan stop starts trailing once its purchase has filled, from the fill price (ruling 4).
      if(o.trail.awaitingFill){const lp=this.linkedPurchase(o);if(!(lp?.filled>=1))continue;o=this.desk.update(o,T.startFromFill(o,{fillPrice:Number(lp.record?.fillPrice),now}));this.trailSeen.set(o.id,{stepAt:now,acceptedAt:null,regularSince:null});continue;}
      const seen=this.trailSeen.get(o.id),gap=!seen||now-seen.stepAt>T.GAP_MS;const s={stepAt:now,acceptedAt:seen?.acceptedAt??null,regularSince:regular(now)?(seen?.regularSince??now):null};this.trailSeen.set(o.id,s);
      // After a gap (app started, auto trading resumed, a long pause), or a catch-up whose bars could not be read and whose
      // retry is due: the catch-up runs first; the order is not tracked until it is done.
      const retry=o.trail.catchUp?.status==='unavailable'&&now>=(o.trail.catchUp.retryAt??0);
      if((gap||retry)&&!this.trailCatching.has(o.id)){void this.catchUpTrail(o.id,{scope,from:gap?(seen?.stepAt??o.trail.watchedAt):null,now});continue;}
      if(this.trailCatching.has(o.id))continue;
      const quote=quotes.find(q=>q.symbol===o.symbol),accepted=T.usable(quote,{market,now,regular});if(accepted)s.acceptedAt=now;
      const r=T.step(o,quote,{now,regular,memory:this.trailMemory});
      let patch=r?.patch??null;const t=patch?.trail??o.trail;
      // "not tracked since" (review T1 note): no accepted quote for over 5 minutes inside a regular session.
      const base=Math.max(s.acceptedAt??0,s.regularSince??Infinity);
      if(!accepted&&s.regularSince!=null&&now-base>300000&&!t.notTrackedSince)patch={...(patch??{}),trail:{...t,notTrackedSince:base}};
      else if(accepted&&t.notTrackedSince){const {notTrackedSince,...rest}=t;patch={...(patch??{}),trail:rest};}
      if(!patch)continue;this.desk.update(o,patch);for(const e of r?.events??[])this.log(o.id,'System',e.title,e.body);}catch{}}}
  // The catch-up for one trailing stop (T3): its daily bars read fresh, unless a capital change is known in the gap (review
  // D, Korean listings with OpenDART filings). Never throws; the order stays armed at its level whatever happens.
  // Queued (review T3, question 2): catch-ups read their daily bars one at a time, so ten stops at Start make ten reads in
  // turn, not at once. Each order is marked at once, so it is not tracked while it waits; its stop still fires as usual.
  catchUpTrail(id,opts){this.trailCatching??=new Set();this.trailCatching.add(id);const run=()=>this.runCatchUp(id,opts);this.trailCatchChain=(this.trailCatchChain??Promise.resolve()).then(run,run);return this.trailCatchChain;}
  async runCatchUp(id,{scope,from,now=Date.now()}){const T=require('./trailing-stops.cjs');
    try{const o=this.desk.orders(scope).find(x=>x.id===id);if(!o?.trail)return;const start=T.catchUpStart(o.trail);
      const blocked=this.capitalChange(o.symbol,start,T.dayOf(now,T.marketOf(o.symbol)));let bars=null;if(!blocked)try{bars=await this.dailyBars?.(o.symbol)??null;}catch{bars=null;}
      const fresh=this.desk.orders(scope).find(x=>x.id===id);if(!fresh?.trail)return;
      let price=null;try{price=this.liveQuotes().find(q=>q.symbol===fresh.symbol)?.price??null;}catch{}
      const r=T.catchUp(fresh,bars,{now,from,price,blocked});this.desk.update(fresh,r.patch);for(const e of r.events)this.log(id,'System',e.title,e.body);}
    catch{}finally{this.trailCatching.delete(id);}}
  // A known change in the share count of a Korean listing between two days (review D): a rights issue, bonus issue,
  // capital reduction, split or reverse split filed on OpenDART from 60 days before the gap. Daily highs are adjusted
  // prices, so they are not applied across it. Returns the reason, or null (also when the filings cannot be read).
  capitalChange(symbol,from,to){try{if(/:/.test(symbol)||!from)return null;const filings=this.capitalFilings?.(symbol);if(!Array.isArray(filings))return null;
    const since=new Date(Date.parse(from+'T00:00:00Z')-60*86400000).toISOString().slice(0,10);
    const hit=filings.find(f=>f&&typeof f.date==='string'&&f.date>=since&&f.date<=to&&/유상증자|무상증자|감자|주식분할|주식병합/.test(String(f.title??'')));
    return hit?`A capital change of ${symbol} was filed on ${hit.date} (${String(hit.title).slice(0,60)}).`:null;}catch{return null;}}
  deskState(){const scope=this.watchScope();return {monitoringActive:this.conditionalMonitoringActive(),triggers:this.desk.triggers(scope),notes:this.desk.notes(scope),orders:this.desk.orders(scope),recentOrders:this.desk.recentOrders(scope,10),unprotected:this.desk.unprotected(scope,this.brokerPositions()),planStopFailures:this.desk.planStopFailures(scope),firedTriggers:this.desk.rows('agent_triggers',scope,'fired').slice(0,5)};}
  // The purchase a plan stop is linked to (P1): its engine record, the shares it filled, and whether it has ended (filled,
  // cancelled, rejected, or a proposal that expired unsent). null when the record cannot be read.
  linkedPurchase(order,now=Date.now()){const l=order?.linkedBuy;if(!l)return null;const engine=(l.market??(/:/.test(order.symbol)?'US':'KR'))==='US'?this.usLive:this.live;let rec=null;try{rec=engine?.orders?.().find(r=>r.id===l.id)??null;}catch{rec=null;}if(!rec)return null;
    const ended=['Filled','Canceled','Rejected'].includes(rec.status)||rec.status==='Ready'&&Number.isFinite(rec.expiresAt)&&now>rec.expiresAt;return {record:rec,filled:Math.max(0,Number(rec.filled)||0),ended,status:rec.status==='Ready'&&ended?'expired':String(rec.status).toLowerCase(),reason:rec.reason??null};}
  // Linked stops follow their purchase once it ends (P1): nothing filled, the stop is cancelled with the reason; partly
  // filled, its quantity becomes what was bought. Unlinked orders are not touched.
  syncLinkedStops(scope=this.watchScope()){for(const o of this.desk.orders(scope)){if(!o.linkedBuy||o.side!=='Sell')continue;const p=this.linkedPurchase(o);if(!p||!p.ended)continue;
      if(p.filled<1){this.desk.update(o,{status:'cancelled',outcome:`Not needed: the purchase did not fill (it was ${p.status}${p.reason?`: ${p.reason}`:''}).`,closedAt:Date.now(),closedBy:'app'});this.log(o.id,'System','Conditional order · cancelled',`${o.side} ${o.quantity} ${o.symbol} (${o.purpose}): its purchase did not fill.`);}
      else if(p.filled<o.quantity){this.desk.update(o,{quantity:p.filled,resizedFrom:o.quantity});this.log(o.id,'System','Conditional order · resized',`${o.side} ${o.symbol} (${o.purpose}): now ${p.filled}, the shares its purchase bought.`);}}}
  // A Buy's plan becomes a note on the symbol, and a stop-loss order when conditional orders are allowed.
  // The stop is armed when the purchase is proposed, so protection exists the moment a fill can happen, and is linked
  // to it (plan stop fixes P1-P3, artifacts/reviews/2026-11-11-agent-tools/plan-stop-fixes.md): it never sells more than
  // that purchase filled, so shares held before it are never sold by it; it may not stack beyond the shares held plus
  // those being bought; and a stop that could not be armed is said so, on Home, by phone alert and in the next review.
  followPlan(scope,decision,reviewId,{proposalId=null,market=null,positions={}}={}){
    // A cash long entry only (Stage 3): a cover or margin trade gets no ordinary Sell stop, and a short's protection
    // would be a cover above the price on its own lot, a path not yet confirmed (electron/credit-paths.cjs).
    if(decision.action!=='Buy'||(decision.credit??'none')!=='none')return;
    const p=decision.plan;const day=seoulDate();
    const text=`Plan from ${day}: ${p.thesis} Invalid if: ${p.invalidation}. Stop ${p.stopPrice}${p.targetPrice?`, target ${p.targetPrice}`:''}, horizon ${p.horizonDays} days, confidence ${p.confidence}.`;
    const note=this.desk.saveNote(scope,{action:'set',symbol:decision.symbol,note:text,expiresInDays:Math.min(90,Math.max(1,p.horizonDays))});this.log(reviewId,'Tool','Trade plan saved',JSON.stringify(note));
    if(this.config.conditionalOrders&&p.stopPrice){const args={action:'add',id:'',symbol:decision.symbol,side:'Sell',quantity:decision.quantity,limitPrice:null,conditions:[{expr:`price("${decision.symbol}")`,op:'<=',value:p.stopPrice}],combine:'all',purpose:'stop_loss',expiresInHours:this.config.conditionalMaxHours,reason:`Stop from the trade plan of ${day}: ${p.invalidation}`.slice(0,300)};
      const opts={config:this.config,reviewId,positions:positions??{},...(proposalId?{link:{id:proposalId,market,quantity:decision.quantity}}:{})};
      // A plan whose stop trails (T3): armed with the trail, trailing from the fill. A trail that cannot be used (both
      // fields, out of bounds, no ATR or price) arms the fixed stop and says why (ruling 3); the Buy is not held back.
      const wants=require('./agent-desk.cjs').trailingAllowed(this.config)&&(p.trailPct!=null||p.trailAtrMultiple!=null);let stop,trailNotUsed=null;
      if(wants){let price=null;try{price=this.formulaData(this.liveQuotes()).price(decision.symbol);}catch{}
        stop=this.desk.setOrder(scope,{...args,trail:{pct:p.trailPct??null,atrMultiple:p.trailAtrMultiple??null,activateAt:null}},{...opts,quotes:price>0?[{symbol:decision.symbol,price}]:[],atr:sym=>this.trailAtr(sym)});
        if(stop.status!=='armed'){const fixed=this.desk.setOrder(scope,args,opts);if(fixed.status==='armed'){trailNotUsed=stop.reason??'the trail was refused';stop=fixed;}}}
      else stop=this.desk.setOrder(scope,args,opts);
      if(stop.status==='armed'){this.log(reviewId,'Tool','Stop-loss armed from the plan',JSON.stringify(stop));const o=this.desk.orders(scope).find(x=>x.id===stop.id);
        if(trailNotUsed){if(o)this.desk.update(o,{trailNotUsed});this.log(stop.id,'System','Plan stop armed without trailing',`${decision.quantity} ${decision.symbol} at ${p.stopPrice}: ${trailNotUsed}`);}
        else if(o?.trail)this.log(o.id,'System',`Trailing stop armed · ${o.symbol}`,require('./trailing-stops.cjs').armedText(o));
        return;}
      const reason=stop.reason??'the stop order was refused';this.log(reviewId,'System','Stop-loss NOT armed from the plan',`${decision.quantity} ${decision.symbol} at ${p.stopPrice}: ${reason} The purchase goes ahead without a stop order.`);
      try{this.desk.recordPlanStopFailure(scope,{symbol:decision.symbol,quantity:decision.quantity,reason,proposalId});}catch{}
      try{this.notify?.('plan-stop-'+(proposalId??reviewId),`The purchase of ${decision.quantity} ${decision.symbol} has no stop order: ${reason}`);}catch{}}
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
  // C1 (artifacts/reviews/2026-11-13-c1-replay/review.md): the change may be Claude Opus 5.5 (medium) once a Claude dry run
  // has completed on this account, with the Anthropic key and its sharing switch; every refusal comes before any request,
  // the OpenAI baseline included (R5). A Claude run fails a row, not the run, on an answer the app does not accept or a
  // refusal (R6), and stops before a request that would take its measured spending past its cap (R3).
  replayPlan(options={}){
    const R=require('./replay.cjs');const instructions=typeof options.instructions==='string'?options.instructions.trim().slice(0,R.LIMITS.instructions):'';
    const models=require('./ai-models.cjs');const modelConfig=this.agentModel('trading');
    // A model change: the variant runs on another model and effort, the baseline on the configured one.
    let model=null;if(options.model&&typeof options.model==='object'){const m={openaiModel:String(options.model.openaiModel??''),reasoningEffort:String(options.model.reasoningEffort??'')};
      let vendor=null;try{models.settings(m);vendor=models.vendorOf(m.openaiModel);if(vendor==='anthropic'?m.openaiModel!=='claude-opus-5-5'||m.reasoningEffort!=='medium':vendor!=='openai')throw 0;}catch{throw new Error('INVALID_MODEL_SETTINGS');}
      if(vendor==='anthropic'){if(!this.completedClaudeDryRun())throw new Error('CLAUDE_DRY_RUN_REQUIRED');if(this.missingKey(m.openaiModel))throw new Error('AI_NOT_CONNECTED');if(!this.consentFor(m.openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');}
      if(m.openaiModel!==modelConfig.openaiModel||m.reasoningEffort!==modelConfig.reasoningEffort)model=m;}
    // Instruction rewrite step 3: the change may be the proposed built-in text (the baseline keeps the current one).
    const variant={instructions,withoutNarrative:options.withoutNarrative===true,withoutEpisodes:options.withoutEpisodes===true,withoutRegime:options.withoutRegime===true,...(model?{model}:{}),...(options.proposedText===true?{proposedText:true}:{})};
    if(!variant.instructions&&!variant.withoutNarrative&&!variant.withoutEpisodes&&!variant.withoutRegime&&!variant.model&&!variant.proposedText)throw new Error('REPLAY_NO_CHANGE');
    const limit=Math.max(1,Math.min(R.LIMITS.reviews,Number(options.limit)||6));const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;
    const reviews=this.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 400').all().map(r=>JSON.parse(r.payload));
    const picks=R.candidates({reviews,store:this.replays,events:this.loggedEvents?.()??[],from:day(options.from),to:day(options.to),limit});if(!picks.length)throw new Error('REPLAY_NOTHING');
    // A context saved before extendedSessions existed lacks it; with the proposed text it is filled from the current
    // settings on both sides (design 2.2), and the row says so.
    if(variant.proposedText)for(const pick of picks)if(!Array.isArray(pick.context.extendedSessions)){pick.context={...pick.context,extendedSessions:this.extendedSessions()};pick.filled=['extendedSessions'];}
    // Claude trading D-2: Claude on either side (the variant, or the baseline when the trading model is Claude) takes the
    // measured Claude path with its cap; the estimate and the costs are counted by each side's vendor, not by side.
    const vModel=variant.model??modelConfig,claudeSide=models.vendorOf(vModel.openaiModel)==='anthropic'&&Boolean(variant.model)?'variant':models.vendorOf(modelConfig.openaiModel)==='anthropic'?'baseline':null;
    const claude=claudeSide!=null;
    const capMicro=claude?Math.round(Math.max(0.01,Math.min(100,Number.isFinite(Number(options.capUSD))&&Number(options.capUSD)>0?Number(options.capUSD):3))*1e6):null;
    let estimate=null;if(claude){const bytes=c=>Buffer.byteLength(JSON.stringify(c));let c=0,o=0,reserved=0;
      const isClaude=m=>models.vendorOf(m.openaiModel)==='anthropic';let firstClaude=true;
      picks.forEach(pick=>{const v=R.applyVariant(pick.context,variant);for(const [m,ctx] of [[modelConfig,pick.context],[vModel,v]]){if(isClaude(m)){c+=R.estimateMicro(m.openaiModel,bytes(ctx),{first:firstClaude})??0;firstClaude=false;reserved=Math.max(reserved,models.reservation(m,ctx,{}));}else o+=R.estimateMicro(m.openaiModel,bytes(ctx))??0;}});
      estimate={reviews:picks.length,claudeUSD:Math.round(c)/1e6,openaiUSD:Math.round(o)/1e6,totalUSD:Math.round(c+o)/1e6,reservedPerClaudeUSD:Math.round(reserved)/1e6,capUSD:capMicro/1e6,basis:R.EST.basis};}
    return {R,models,modelConfig,variant,instructions,picks,claude,claudeSide,capMicro,estimate};
  }
  // The confirmation's figures for a Claude replay, with the same refusals as the run (nothing is sent).
  replayEstimate(options={}){const blocked=this.narrativeAvailable();if(blocked)throw new Error('REPLAY_UNAVAILABLE');const plan=this.replayPlan(options);if(!plan.claude)return null;return plan.estimate;}
  async replay(options={}){
    if(this.replaying)throw new Error('REPLAY_BUSY');const blocked=this.narrativeAvailable();if(blocked)throw new Error('REPLAY_UNAVAILABLE');
    const {R,models,modelConfig,variant,instructions,picks,claude,claudeSide,capMicro,estimate}=this.replayPlan(options);
    this.replaying=true;const id=R.newId();
    const decide=async(context,config=modelConfig,set)=>{const reserve=models.reservation(config,context,{maxBytes:models.reviewByteLimit({},config)});const d=seoulDate();
      const callId=require('node:crypto').randomUUID();this.reserveCall(config,reserve,callId,d,JSON.stringify({reviewId:id,model:config.openaiModel,reasoningEffort:config.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'replay'}));
      const n=R.replayOrders(context);// M-7 (c): what the saved review asked for, never more
      try{const r=await this.provider.request('decision',{context,options:{...config,research:false,...(set?{instructionSet:set}:{}),...(n>1?{moreOrders:n-1}:{})}});require('./ai-accounting.cjs').settle(this.db,'ai_usage',d,callId,r,'completed');const row=this.db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(callId);const cost=row?JSON.parse(row.payload).accountedMicro??null:null;return {...r.decision,_usage:{model:config.openaiModel,effort:config.reasoningEffort,inputTokens:r.usage?.inputTokens??null,outputTokens:r.usage?.outputTokens??null,costMicro:cost}};}catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',d,callId,error,'failed-or-uncertain');throw error;}};
    this.log(id,'Program','Replay',`Replaying ${picks.length} saved review${picks.length===1?'':'s'} with a change: ${[instructions&&'extra instructions',variant.withoutNarrative&&'without the narrative',variant.withoutEpisodes&&'without episodes',variant.withoutRegime&&'without the regime gauge and sizing',variant.model&&`on ${variant.model.openaiModel} (${variant.model.reasoningEffort} effort) instead of ${modelConfig.openaiModel} (${modelConfig.reasoningEffort})`,variant.proposedText&&'the proposed built-in text instead of the current one'].filter(Boolean).join(', ')}. No orders are placed.`);
    if(claude)return this.replayClaude({id,R,models,modelConfig,variant,picks,capMicro,estimate,claudeSide});
    try{
      const closes=this.indexCloses?.()??{};const rows=[];
      for(const pick of picks){
        const set=variant.proposedText?'proposed':undefined;const baseline=await decide(pick.context);const changed=await decide(R.applyVariant(pick.context,variant),variant.model??modelConfig,set);
        for(const d of [baseline,changed]){const symbols=R.symbolsOf(d);if(symbols.length)await this.warmSeries(symbols);}
        const score=d=>R.outcomeAll(d,pick.day,s=>this.series?.closes(s),s=>/:/.test(s)?closes.SPX:closes.KOSPI);
        rows.push({reviewId:pick.review.id,day:pick.day,approximate:pick.approximate,...R.textOf(pick,variant),original:R.brief(pick.review.decision),baseline:{decision:R.brief(baseline),explanation:baseline?.explanation?.slice(0,1200)??null,verdicts:baseline?.planVerdicts??[],usage:baseline?._usage??null,outcome:score(baseline)},variant:{decision:R.brief(changed),explanation:changed?.explanation?.slice(0,1200)??null,verdicts:changed?.planVerdicts??[],usage:changed?._usage??null,outcome:score(changed)},changed:JSON.stringify(R.brief(baseline))!==JSON.stringify(R.brief(changed))});
      }
      const run=this.replays.saveRun({id,timestamp:Date.now(),variant,rows,summary:R.summarize(rows)});this.log(id,'System','Replay finished',JSON.stringify(run.summary));return run;
    }catch(error){this.log(id,'System','Replay failed',/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REPLAY_FAILED');throw error;}
    finally{this.replaying=false;}
  }
  // C1: a replay whose change is Claude. Each call is measured (cost, time); a failed side is kept with its reason (the
  // app's rule or the refusal record, local only) and the run goes on; the cap is checked before each request against the
  // measured spending so far plus that request's estimate; the Anthropic limit is checked by reserveCall as for any call.
  async replayClaude({id,R,models,modelConfig,variant,picks,capMicro,estimate,claudeSide='variant'}){const vModel=variant.model??modelConfig;
    const {settle}=require('./ai-accounting.cjs');const bytes=c=>Buffer.byteLength(JSON.stringify(c));let spentMicro=0,stopped=null;const rows=[];
    const call=async(context,config,set)=>{const reserve=models.reservation(config,context,{maxBytes:models.reviewByteLimit({},config)});const d=seoulDate();const callId=require('node:crypto').randomUUID();
      this.reserveCall(config,reserve,callId,d,JSON.stringify({reviewId:id,model:config.openaiModel,reasoningEffort:config.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'replay'}));
      const t0=Date.now();const record=()=>{const r=this.db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(callId);return r?JSON.parse(r.payload):null;};
      const n=R.replayOrders(context);
      try{const r=await this.provider.request('decision',{context,options:{...config,research:false,...(set?{instructionSet:set}:{}),...(n>1?{moreOrders:n-1}:{})}});settle(this.db,'ai_usage',d,callId,r,'completed');const rec=record();
        if(models.vendorOf(config.openaiModel)==='anthropic')this.noteAnswerForm(r,'replay');
        return {decision:r.decision,usage:{model:config.openaiModel,effort:config.reasoningEffort,inputTokens:r.usage?.inputTokens??null,outputTokens:r.usage?.outputTokens??null,costMicro:rec?.accountedMicro??null,ms:Date.now()-t0,...(r.answerForm?{answerForm:r.answerForm}:{}),...(r.formFallback?{formFallback:true}:{}),...(r.textPartsDropped?.length?{textPartsDropped:r.textPartsDropped}:{})}};}
      catch(error){settle(this.db,'ai_usage',d,callId,error,'failed-or-uncertain');const rec=record();const usage={model:config.openaiModel,effort:config.reasoningEffort,inputTokens:rec?.usage?.inputTokens??null,outputTokens:rec?.usage?.outputTokens??null,costMicro:rec?.accountedMicro??null,ms:Date.now()-t0,...(error?.formFallback?{formFallback:true}:{}),...(['enforced','text'].includes(error?.answerForm)?{answerForm:error.answerForm}:{})};
        const code=/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'AI_REQUEST_FAILED';
        if(rec?.status==='refused'&&rec.providerError)return {failure:{kind:'refused',code,providerError:rec.providerError},usage};
        const rule=answerRule(error);if(rule)return {failure:{kind:'not-accepted',...rule},usage};
        return {failure:{kind:'uncertain',code},usage};}};
    const side=(res,score)=>res.failure?{decision:null,explanation:null,verdicts:[],usage:res.usage,outcome:{excessPct:null,basis:'failed'},failure:res.failure}
      :{decision:R.brief(res.decision),explanation:res.decision?.explanation?.slice(0,1200)??null,verdicts:res.decision?.planVerdicts??[],usage:res.usage,outcome:score(res.decision)};
    const blockedSide=kind=>({decision:null,explanation:null,verdicts:[],usage:null,outcome:{excessPct:null,basis:'failed'},failure:{kind,code:kind==='limit'?'AI_BUDGET_EXHAUSTED':'REPLAY_CAP'}});
    try{
      const closes=this.indexCloses?.()??{};
      for(const [i,pick] of picks.entries()){
        const vctx=R.applyVariant(pick.context,variant);const score=d=>R.outcomeAll(d,pick.day,s=>this.series?.closes(s),s=>/:/.test(s)?closes.SPX:closes.KOSPI);
        if(spentMicro+(R.estimateMicro(modelConfig.openaiModel,bytes(pick.context))??0)>capMicro){stopped={reason:'cap',left:picks.length-i};break;}
        let base;try{base=await call(pick.context,modelConfig);}catch(error){if(error?.message==='AI_BUDGET_EXHAUSTED'){stopped={reason:'limit',left:picks.length-i};break;}throw error;}
        spentMicro+=base.usage?.costMicro??0;
        let changed=null;
        if(spentMicro+(R.estimateMicro(vModel.openaiModel,bytes(vctx),{first:i===0})??0)>capMicro){stopped={reason:'cap',left:picks.length-i-1};changed=blockedSide('stopped');}
        else{try{changed=await call(vctx,vModel,variant.proposedText?'proposed':undefined);spentMicro+=changed.usage?.costMicro??0;}catch(error){if(error?.message!=='AI_BUDGET_EXHAUSTED')throw error;stopped={reason:'limit',left:picks.length-i-1};changed=blockedSide('limit');}}
        for(const r of [base,changed]){const symbols=R.symbolsOf(r?.decision);if(symbols.length)await this.warmSeries(symbols);}
        const b=side(base,score),v=changed.failure&&!changed.usage?changed:side(changed,score);
        rows.push({reviewId:pick.review.id,day:pick.day,approximate:pick.approximate,...R.textOf(pick,variant),original:R.brief(pick.review.decision),baseline:b,variant:v,changed:Boolean(b.decision&&v.decision)&&JSON.stringify(b.decision)!==JSON.stringify(v.decision)});
        if(stopped)break;
      }
      const claudeResult=R.claudeSummary(rows,{estimate,stopped,capMicro,claudeSide});
      const run=this.replays.saveRun({id,timestamp:Date.now(),variant,rows,summary:{...R.summarize(rows),claude:claudeResult}});
      // The log line carries counts only: the rule texts stay on the stored run (local only, review R6).
      const {byRule:_rules,...counts}=claudeResult.answers;this.log(id,'System','Replay finished',JSON.stringify({reviews:rows.length,changed:run.summary.changed,claude:{answers:counts,basis:claudeResult.basis,formatFailures:claudeResult.formatFailures,measured:claudeResult.measured,...(stopped?{stopped}:{})}}));return run;
    }catch(error){this.log(id,'System','Replay failed',/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REPLAY_FAILED');throw error;}
    finally{this.replaying=false;}
  }
  // Market narrative and similar past episodes, as the agents read them.
  storyContext(){const n=require('./narrative.cjs');const latest=this.narratives.latest();const view=n.agentView(latest);if(!view)return {};const vix=this.indexCloses?.()?.VIX?.at(-1)?.close??null;return {marketNarrative:view,similarEpisodes:this.episodes.similar(latest,{vix})};}
  // B3: the narrative's own model's key; it carries no account data, so no sharing switch (tests/claude-agents pins that).
  narrativeAvailable(){if(this.config.provider!=='openai')return 'Choose the AI as the decision maker';const missing=this.missingKey(this.agentModel('narrative').openaiModel);if(missing)return `Add an ${missing} key in Connections`;if(this.claudeGateClosed('narrative'))return CLAUDE_GATE_REASON;return null;}
  // Builds the narrative from recent headlines and numeric signals; metered like any other AI call.
  async buildNarrative(trigger='User request'){
    if(this.narrating)throw new Error('NARRATIVE_BUSY');const blocked=this.narrativeAvailable();if(blocked){this.narrativeError=blocked;throw new Error('NARRATIVE_UNAVAILABLE');}
    if(trigger!=='User request'&&this.providerWaitFor(this.agentModel('narrative').openaiModel))throw new Error('PROVIDER_WAIT');// fix R2
    this.narrating=true;const id=require('node:crypto').randomUUID();const n=require('./narrative.cjs');
    try{
      const closes=this.indexCloses?.()??{};const labels=Object.fromEntries(Object.entries(require('./performance.cjs').INDEXES).map(([k,v])=>[k,v.label]));
      const signalList=n.signals({indexCloses:closes,labels,macro:this.macro?.get?.()??null,market:this.marketOverviewCache?.()??null});
      const stories=this.topStories();const storyItems=stories.flatMap((s,k)=>s.headlines.map(h=>({title:h.title,source:h.source,published:h.published,symbols:s.symbols??[],story:k})));
      const headlineList=n.headlines([...storyItems,...this.newsEvents.list(300),...this.news.map(item=>({...item,symbols:[]}))]);
      const previous=this.narratives.latest();
      const context={today:seoulDate(),signals:signalList,headlines:headlineList.map(({url,...h})=>h),...(stories.length?{topStories:stories.map((s,k)=>({story:k,terms:s.terms,outlets:s.outlets,timesUsual:s.timesUsual,firstSeen:s.firstSeen,latest:s.latest}))}:{}),previousNarrative:previous?{asOf:new Date(previous.timestamp).toISOString(),drivers:previous.drivers.map(({id,kind,title,themes,since})=>({id,kind,title,themes,since}))}:null};
      this.log(id,'Program',trigger==='User request'?'Market narrative':'Market narrative · '+trigger,`Summarizing ${headlineList.length} recent headlines against ${signalList.length} market signals.`);
      const modelConfig=this.agentModel('narrative');const models=require('./ai-models.cjs');
      const reserve=models.reservation(modelConfig,context,{maxBytes:120000,kind:'narrative'});const day=seoulDate();
      
      const callId=require('node:crypto').randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'narrative'};
      this.reserveCall(modelConfig,reserve,callId,day,JSON.stringify(record));
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
    if(this.config.provider!=='openai')return 'Choose the AI as the decision maker';
    {const missing=this.missingKey(this.agentModel('scout').openaiModel);if(missing)return `Add an ${missing} key in Connections`;}
    if(this.claudeGateClosed('scout'))return CLAUDE_GATE_REASON;
    if(this.config.scope==='paper')return 'The scout works with KIS accounts';
    if(!this.consentFor(this.agentModel('scout').openaiModel))return `Allow sharing KIS data with ${VENDOR_NAMES[this.vendorOf(this.agentModel('scout').openaiModel)]}`;
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
      ...(this.config.scoutEnabled?{scheduledRuns:require('./scout-timing.cjs').nextTimes(this.config,this.scoutMarkets(),Date.now(),this.scoutSessionOpts()).map(x=>x.text+' KST')}:{}),openBriefs:open.map(b=>({id:b.id,asOf:new Date(b.timestamp).toISOString(),asked:b.asked.slice(0,200)}))};
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
  // Scout timing (step A4): the markets a scheduled run can be for, and the calendar options its times are read with.
  // One check for a due scheduled scout run (called from the tick); returns what it did, for tests.
  scoutTick(now=Date.now()){if(!(this.config.scoutEnabled&&!this.backgroundPaused&&!this.scouting&&!this.scoutAvailable()))return null;const scope=this.watchScope();const timing=require('./scout-timing.cjs');const opts=this.scoutSessionOpts();const slot=timing.dueSlot(this.config,this.scoutMarkets(),now,opts);if(slot&&this.scoutStore.lastSlot(scope)!==slot.id&&now-(this.lastScoutAttempt??0)>=600000){this.scoutStore.markSlot(scope,slot.id);const late=timing.lateness(slot,now,opts);if(!late.onTime){this.log(randomUUID(),'Program','Scout run dropped · '+slot.label,late.reason);return {slot,dropped:late.reason};}const rule=timing.skipRule(slot,this.lastScoutRun(scope,opts),now,opts);if(rule.skip){this.log(randomUUID(),'Program','Scout run skipped · '+slot.label,rule.reason);return {slot,skipped:rule.reason};}
    {const wait=this.providerWaitFor(this.agentModel('scout').openaiModel,{},now);if(wait){const why=this.providerWaitText(this.agentModel('scout').openaiModel,wait);this.log(randomUUID(),'Program','Scout run skipped · '+slot.label,why);return {slot,skipped:why};}}// fix R2
    this.lastScoutAttempt=now;const note=[late.note,rule.reason].filter(Boolean).join('. ');void this.scout('Scheduled',{slot:{market:slot.market,label:slot.label,...(note?{note}:{})}}).catch(()=>{});return {slot,ran:true};}return null;}
  // The latest scout run for the skip rule: when it finished and which markets its research covered. Plans saved before
  // A4 have no focus recorded; theirs is the clock rule at the time they finished (what those runs used).
  lastScoutRun(scope,opts=this.scoutSessionOpts()){const p=this.scoutStore.latest(scope);if(!p)return null;return {finishedAt:p.timestamp,focus:Array.isArray(p.focus)?p.focus:require('./scout.cjs').researchFocus(this.scoutMarkets(),p.timestamp,opts).markets};}
  scoutMarkets(){return this.config.scope==='kis'?['KR']:this.config.scope==='us'?['US']:['KR','US'];}
  scoutSessionOpts(){return {closedDays:new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])])};}
  scoutState(){const scope=this.watchScope();const timing=require('./scout-timing.cjs');const due=timing.dueSlot(this.config,this.scoutMarkets(),Date.now(),this.scoutSessionOpts());return {enabled:this.config.scoutEnabled,times:timing.nextTimes(this.config,this.scoutMarkets(),Date.now(),this.scoutSessionOpts()).map(x=>x.text),busy:Boolean(this.scouting),blocked:this.scoutAvailable(),lastError:this.scoutError??null,lastErrorDetail:this.scoutErrorDetail??null,failedAfter:this.scoutStore.failedAfter(scope),lastSlot:this.scoutStore.lastSlot(scope),dueSlot:due?.id??null,latest:this.scoutStore.latest(scope),briefs:this.briefs.open(scope).map(({id,timestamp,request,asked})=>({id,timestamp,request,asked})),scorecard:this.scoutScorecardState(scope)};}
  scoutScorecardState(scope){return this.stateCached('scoutScorecard:'+scope,()=>this.scoutScorecardUncached(scope));}
  scoutScorecardUncached(scope){try{const board=this.scoutScorecard.build(scope,this.briefs.feedback(scope,0));return {summary:board.summary,minSample:board.minSample,picks:board.picks.slice(0,20).map(({symbol,name,role,pickedAt,endedAt,benchmark,horizons,acted,feedback})=>({symbol,name,role,pickedAt,endedAt,benchmark,horizons,acted,feedback}))};}catch{return null;}}
  async scoutAccount(){
    // What each account may buy: cash in its own currency and whether leveraged or inverse products are allowed.
    const products=engine=>{try{const p=engine?.exposure?.policy(engine.identity());const access=require('./exposure.cjs').leveragedAccess(p?.leveragedEtps);return p?{leveragedOrInverseEtps:access.allowed?{allowed:true,maxPctOfEquity:p.leveragedEtps.maxPctOfEquity,maxHoldingDays:p.leveragedEtps.maxHoldingDays}:{allowed:false,reason:access.reason}}:null;}catch{return null;}};
    const pick=(c,engine)=>({market:c.market??'KR',currency:c.currency,equity:c.equity,cash:c.cash,...(c.buyingPower?{buyingPowerUSD:c.buyingPower.usd,integratedMargin:c.buyingPower.integratedMargin}:{}),...(products(engine)?{products:products(engine)}:{}),...((c.market??'KR')==='US'&&!((c.buyingPower?.usd??c.cash)>0)?{note:'No U.S. buying power: U.S. purchases need USD cash, or integrated margin with KRW cash.'}:(c.market??'KR')==='US'&&c.buyingPower?.integratedMargin?{note:'U.S. buys draw on KRW cash through integrated margin; that is the same money as the Korean account cash, so plan both markets from one pool.'}:{}),positions:Object.entries(c.positions??{}).map(([symbol,p])=>{const q=c.quotes?.find(x=>x.symbol===symbol);const value=q?q.price*p.quantity:null;return {symbol,name:c.universe?.find(u=>u.symbol===symbol)?.name??symbol,quantity:p.quantity,value,weightPct:value&&c.equity?Math.round(value/c.equity*1000)/10:null};})});
    if(this.config.scope==='kis')return [pick(await this.live.context(),this.live)];
    if(this.config.scope==='us')return [pick(await this.usLive.context(await this.refreshUS()),this.usLive)];
    // With both markets, a failed U.S. account check leaves the scout researching Korea instead of stopping it.
    const kr=pick(await this.live.context(),this.live);let us;try{us=pick(await this.usLive.context(await this.refreshUS()),this.usLive);}catch(error){us={market:'US',currency:'USD',status:'unavailable',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED'};}return [kr,us];
  }
  async scout(trigger='User request',{slot=null}={}){
    if(this.scouting)throw new Error('SCOUT_BUSY');const blocked=this.scoutAvailable();if(blocked){this.scoutError=blocked;throw new Error('SCOUT_UNAVAILABLE');}
    // The provider wait (fix R2): an automatic scout run does not call a waiting provider; your own run still does.
    if(trigger!=='User request'&&this.providerWaitFor(this.agentModel('scout').openaiModel))throw new Error('PROVIDER_WAIT');
    this.scouting=true;const id=randomUUID();const scope=this.watchScope();
    try{
      const previous=this.scoutStore.latest(scope);
      const accounts=await this.scoutAccount();
      // Research only markets open or near their open or close; the others keep their previous targets.
      const scoutLib=require('./scout.cjs');const markets=[...new Set(accounts.filter(a=>a.status!=='unavailable').map(a=>a.market))];const focus=scoutLib.researchFocus(markets.length?markets:['KR'],Date.now(),{...(slot?{slot}:{}),closedDays:new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]),environment:this.live?.getConnection?.()?.snapshot?.environment??'mock',enabled:this.sessionOptions()});
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
      this.log(id,'Program',trigger==='User request'?'Scout run':'Scout run · '+trigger+(slot?' · '+slot.label:''),'Researching the market to update the shortlist and the portfolio plan. The scout does not trade.'+(slot?.note?' '+slot.note+'.':''));
      this.log(id,'Context','Supplied context',loggableContext(context));
      const modelConfig=this.agentModel('scout');
      const request=async({final,continuation})=>{
        const options={final,continuation,...modelConfig,maxBytes:scoutLib.SCOUT_REQUEST_BYTES};const models=require('./ai-models.cjs');
        const reserve=models.reservation(modelConfig,context,{...options,kind:'scout'});
        const day=seoulDate();
        
        const callId=randomUUID(),record={reviewId:id,model:modelConfig.openaiModel,reasoningEffort:modelConfig.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now(),kind:'scout'};
        this.reserveCall(modelConfig,reserve,callId,day,JSON.stringify(record));
        try{const response=await this.provider.request('scout',{context,options:{final,continuation,...modelConfig}});require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,response,'completed');this.noteAnswerForm(response,'scout');return response;}
        catch(error){require('./ai-accounting.cjs').settle(this.db,'ai_usage',day,callId,error,'failed-or-uncertain');throw error;}
      };
      const tools=scoutLib.focusTools(this.discovery,focus,{reassess:(context.carriedNeedingReassessment??[]).map(s=>s.symbol),guard:()=>{if(this.disposed||scope!==this.watchScope())throw new Error('STALE_DECISION');}});
      // An answer that says nothing (no summary or focus, or no target for a focused market you hold stocks in) is refused
      // and asked for once more; a second refusal fails the run and the previous plan stays (2026-11-18).
      const heldMarkets=accounts.filter(a=>a.status!=='unavailable'&&(a.positions?.length??0)>0).map(a=>a.market);
      const result=await scoutLib.runScout({request,tools,overheadBytes:require('./ai-client.cjs').scoutOverheadBytes(),watched:context.watchlist.map(e=>e.symbol),log:(kind,title,body)=>this.log(id,kind,title,body),
        check:plan=>scoutLib.planProblem(plan,{focus:focus.markets,heldMarkets})});
      if(this.disposed||scope!==this.watchScope())throw new Error('STALE_DECISION');
      const answered=this.briefs.answer(scope,result.plan.briefAnswers);const plan=scoutLib.carryForward(this.priceTargets(result.plan),previous,focus.deferred,Date.now(),{reassessed:(context.carriedNeedingReassessment??[]).map(x=>x.symbol)});
      const saved=this.scoutStore.save(scope,plan,{runId:id,trigger,focus:focus.markets,instructions:require('./review-instructions.cjs').scoutRecord(context),model:result.model??modelConfig.openaiModel,usage:result.usage,research:result.metrics??null,rounds:result.rounds,...(result.retried?{retried:true}:{}),answered});this.scoutScorecard.record(scope,result.plan,saved.timestamp);
      this.log(id,'Agent','Scout plan',JSON.stringify(plan,null,2));this.log(id,'System','Review completed',JSON.stringify(result.usage));if(result.metrics)this.log(id,'System','Research metrics',JSON.stringify(result.metrics));
      this.scoutError=null;return saved;
    }catch(error){this.scoutError=require('./ai-errors.cjs').publicCode(error)??(/^[A-Z_]{3,40}$/.test(error.message)?error.message:'SCOUT_FAILED');this.scoutErrorDetail=typeof error.detail==='string'?error.detail:null;this.log(id,'System','Scout failed',this.scoutError+(this.scoutErrorDetail?' · '+this.scoutErrorDetail:''));try{this.scoutStore.noteFailure(scope,{reason:this.scoutError,trigger});}catch{}if(error?.metrics)this.log(id,'System','Research metrics',JSON.stringify(error.metrics));throw error;}
    finally{this.scouting=false;}
  }
  syncLearning(){try{if(!this.learningSynced||this.stateCacheOff||this.learningSynced!==this.learningKey()){this.outcomes.sync();this.memory.sync();this.reflections.sync();this.learningSynced=this.learningKey();}this.trials.observe(this.paper.getState().quotes,'paper');
      for(const [engine,quotes] of [[this.live,this.marketQuotes?.()??[]],[this.usLive,this.usQuotes??[]]]){if(engine){try{this.trials.observe(quotes,'broker',engine.identity());}catch(error){if(!['KIS_NOT_CONNECTED','ACCOUNT_CHANGED'].includes(error.message))throw error;}}}this.learningLastRun=Date.now();this.learningError=null;}catch{this.learningError='LOCAL_EVALUATION_FAILED';}}
  tick() {
    this.restoreClock();
    this.checkAiAlerts();// fix R3: one alert per AI outage or stall while a market is open
    if(!this.learningLastRun||Date.now()-this.learningLastRun>=15000)this.syncLearning();
    if(!this.busy&&!this.learningError&&!this.backgroundPaused&&!this.providerWaitFor(this.agentModel('reflection').openaiModel))void this.reflections.tick({...this.config,...this.agentModel('reflection'),shareKisAllowed:this.consentFor(this.agentModel('reflection').openaiModel),providerBudget:this.reflectionProviderBudget()},this.providerStatus.aiConnected,this.provider,this.log).catch(()=>{this.reflections.reason='Local reflection error';});
    const emergency=this.emergencyState();
    this.observeEmergency(emergency);
    if(emergency.active&&this.config.lossAction==='stop'&&(this.config.enabled||this.config.autoSubmit)&&!this.busy)this.trip('auto-stopped',`Auto trading stopped: daily loss limit reached in ${this.config.scope==='paper'?'the paper portfolio':emergency.activeMarkets.map(m=>m==='US'?'U.S.':'Korea').join(' and ')}. Positions and accepted broker orders are unchanged.`);
    this.digest.tick(this);
    for(const row of this.db.prepare('SELECT id,payload FROM paper_fills WHERE id NOT IN (SELECT id FROM reviewed_fills) ORDER BY seq LIMIT 20').all()) {
      const fill=JSON.parse(row.payload);this.db.prepare('INSERT INTO reviewed_fills VALUES(?)').run(row.id);
      if(fill.side==='Sell'&&fill.realized<0&&!this.db.prepare('SELECT id FROM paper_orders WHERE id=?').get(fill.orderId??''))this.db.prepare('INSERT INTO lessons(id,text) VALUES(?,?)').run(randomUUID(),`Candidate lesson: paper sale ${fill.symbol} realized a loss of KRW ${Math.abs(fill.realized)} after simulated fees. Inspect the linked decision, entry cost, slippage and market movement before drawing a causal conclusion. A loss alone does not establish a decision mistake.`);
    }
    // The narrative refreshes before the Korean open and after the close on weekdays, once per slot.
    if(this.config.narrativeEnabled&&!this.backgroundPaused&&!this.narrating&&!this.narrativeAvailable()){const slot=require('./scout.cjs').dueSlot('narrative');const last=this.db.prepare('SELECT slot FROM narrative_slots WHERE id=1').get()?.slot;if(slot&&slot!==last&&Date.now()-(this.lastNarrativeAttempt??0)>=600000){this.lastNarrativeAttempt=Date.now();this.db.prepare('INSERT INTO narrative_slots VALUES(1,?) ON CONFLICT(id) DO UPDATE SET slot=excluded.slot').run(slot);{const wait=this.providerWaitFor(this.agentModel('narrative').openaiModel);if(wait)this.log(randomUUID(),'Program','Market narrative skipped · '+slot,this.providerWaitText(this.agentModel('narrative').openaiModel,wait));else void this.buildNarrative('Scheduled').catch(()=>{});}}}
    // Scout runs follow their own weekday schedule, independent of trading reviews; each slot runs once.
    // Scheduled scout runs (step A4): the most recent switched-on slot of today from the session calendar, once. A slot
    // shortly after another scout run is skipped and logged, unless its market opened in between (scout-timing.cjs).
    this.scoutTick();
    // Desk checks every 5 seconds: conditional orders while auto trading is on, one at a time.
    // Schedule observation every 30 seconds while auto trading runs on KIS: records only (electron/schedule-observer.cjs).
    // The watchlist alert trial's rollback and completion checks, every 10 seconds while auto trading runs.
    // The check gap counts only from when auto trading is running (it pauses after a restart until resumed).
    if(!(this.sessionArmed&&this.config.enabled))this.trialWatchSince=null;
    if(this.trialRunning()&&this.sessionArmed&&this.config.enabled&&Date.now()-(this.lastTrialCheck??0)>=10000){this.lastTrialCheck=Date.now();this.trialWatchSince??=Date.now();try{const scope=this.watchScope();
      const {regularOpen}=require('./market-hours.cjs');const closedDays=new Set([...(this.closedDays??[]),...(this.officialClosedDays?.()??[])]);this.alertTrial.cover({regularOpen,closedDays});this.alertTrial.judge({regularOpen,closedDays});
      const r=this.alertTrial.monitor({busy:this.busy,since:this.trialWatchSince,held:Boolean(this.failedInput?.scope===scope)||emergency.active,marketsOpen:require('./market-hours.cjs').marketsFor(this.config.scope).some(m=>this.sessionOpen(m))});if(r)this.endTrial(r.end,r.detail);}catch{}}
    if(this.sessionArmed&&this.config.enabled&&this.config.scope!=='paper'&&Date.now()-(this.lastScheduleObservation??0)>=30000){this.lastScheduleObservation=Date.now();try{this.scheduleObserver.observe(this.scheduleState());}catch{}}
    const deskDue=Date.now()-(this.lastDeskCheck??0)>=5000;if(deskDue)this.lastDeskCheck=Date.now();
    if(deskDue&&this.config.scope!=='paper')try{this.syncLinkedStops();}catch{}
    if(deskDue&&this.conditionalMonitoringActive()&&!this.firing){
      const scope=this.watchScope();const data=this.formulaData();const formula=require('./formula.cjs');
      // Trailing stops move their level first (T1), so the check below reads the level as of this quote.
      if(this.config.trailingStops===true)this.trackTrailing(scope);
      for(const order of this.desk.orders(scope)){if(order.nextCheckAt>Date.now())continue;const check=formula.checkConditions(order.conditions,order.combine,data);if(check.met){this.firing=true;void this.fireConditional(order).catch(()=>{}).finally(()=>{this.firing=false;});break;}}
    }
    // Open app orders follow the best bid or ask every 3 seconds while the app runs, auto trading on or not.
    if(this.config.orderTracking!==false&&this.config.scope!=='paper'&&!this.trackingOrders&&Date.now()-(this.lastTrack??0)>=3000){this.lastTrack=Date.now();this.trackingOrders=true;void this.trackOrders().catch(()=>{}).finally(()=>{this.trackingOrders=false;});}
    if(this.schedulerStatus().label!=='Monitoring')return;
    if(this.reviewRequested&&!this.busy&&this.config.scope!=='paper'&&Date.now()>=(this.reviewRequested.notBefore??0)){const r=this.reviewRequested;this.reviewRequested=null;this.triggerEvidence={kind:'placement',reason:r.reason};this.log(randomUUID(),'System',r.trigger,r.reason);void this.review(r.trigger).catch(()=>{});return;}
    // Order updates are noted every 5 seconds, also while markets are closed, and start a review when one can run.
    // Each order keeps its latest update; the queue belongs to the scope it was noted in.
    // M-1b: with "Review after an order update" off (the default), updates are still noted (so turning it on later starts
    // no review for old ones) but start no review of their own; the next scheduled or triggered review sees them.
    if(deskDue&&this.config.scope!=='paper'){const events=this.orderEvents();if(this.config.orderUpdateReviews!==true)this.orderQueue=null;else if(events.length){if(this.orderQueue?.scope!==this.config.scope)this.orderQueue={scope:this.config.scope,orders:new Map()};for(const o of events)this.orderQueue.orders.set(o.id,o);}}
    if(this.orderQueue&&this.orderQueue.scope!==this.config.scope)this.orderQueue=null;
    // While every market in scope is closed, nothing can execute: scheduled, news and agent-trigger reviews wait,
    // except one review shortly before the next open (unless set otherwise). Emergencies and your own requests still run.
    if(!emergency.active&&this.config.closedMarketReviews!=='keep'){const hours=this.marketHours();if(!hours.open){
      if(this.config.closedMarketReviews==='pre-open'&&hours.preOpen&&this.preOpenKey!==hours.preOpen.key&&!this.busy){this.preOpenKey=hours.preOpen.key;this.saveClock();void this.review('Pre-open review').catch(()=>{});}
      return;}}
    if(this.orderQueue?.orders.size&&!this.busy&&Date.now()-this.lastRun>=30000&&(held=>[...this.orderQueue.orders.values()].some(o=>!held.has(require('./size-retry.cjs').orderEventKey(o))))(this.heldEvents(this.watchScope()))){const list=[...this.orderQueue.orders.values()];this.orderQueue=null;this.orderTaken=new Map(list.map(o=>[o.id,o]));
      this.triggerEvidence={kind:'order',orders:list.map(o=>({id:o.id,symbol:o.symbol,market:o.market??'KR',side:o.side,quantity:o.quantity,filled:o.filled??0,status:o.status,fillPrice:o.fillPrice??null,placedAt:o.createdAt?new Date(o.createdAt).toISOString():null}))};
      {const {title,body}=this.orderUpdateLine(list);this.log(list[0].id,'System',title,body);}void this.review('Order update').catch(()=>{});return;}
    // Agent triggers: met conditions start a review with the values that met them.
    if(deskDue&&!this.busy&&this.config.scope!=='paper'&&Date.now()-this.lastRun>=60000){const open={KR:this.sessionOpen('KR'),US:this.sessionOpen('US')};const held=this.heldEvents(this.watchScope());const holding=this.config.notHeldPriceReviews==='never'?this.heldNow():null;const hit=this.desk.checkTriggers(this.watchScope(),this.formulaData(),t=>(!holding||require('./not-held.cjs').triggerLive('never',t.symbols,holding))&&!held.has('agent:'+t.id)&&(t.symbols??[]).every(sym=>open[/:/.test(sym)?'US':'KR']));if(hit){this.triggerEvidence={kind:'agent-trigger',trigger:{id:hit.trigger.id,name:hit.trigger.name,reason:hit.trigger.reason},results:hit.results};this.log(hit.trigger.id,'System','Agent trigger met',`${hit.trigger.name}: ${hit.results.map(r=>`${r.expr} = ${r.actual} (${r.op} ${r.value})`).join('; ')}`);void this.review('Agent trigger').catch(()=>{});return;}}
    const elapsed=Date.now()-this.lastRun;
    if(emergency.active){if((this.lastEmergencyAttempt??0)<this.emergencyStartedAt||elapsed>=60000){this.lastEmergencyAttempt=Date.now();void this.review('Emergency loss response').catch(()=>{});}return;}
    if(elapsed<60000)return;
    const quotes=this.config.scope==='both'?[...(this.usQuotes??[]),...(this.marketQuotes?.()??[])]:this.config.scope==='us'?(this.usQuotes??[]):this.config.scope==='kis'?(this.marketQuotes?.()??[]):this.paper.getState().quotes;
    const scope=this.watchScope();if(this.lastWatchScope!==scope){this.lastPrices.clear();this.watchAlerts.clear();this.entryLevels.clear();this.lastWatchScope=scope;}
    let drift=this.priceTrigger(scope,quotes,Date.now(),{skipLevels:this.heldEvents(scope)});
    const sizeFailed=this.failedInput?.scope===scope?this.failedInput:null;
    if(drift&&sizeFailed&&!require('./size-retry.cjs').priceTriggerMoved(sizeFailed,drift,{tolerance:this.config.eventTolerancePct??3})){this.restoreEvents(scope,drift);if(!sizeFailed.priceHeld){sizeFailed.priceHeld=true;this.log(randomUUID(),'System','Price trigger held · size failure',`A price trigger (${drift.symbol??(drift.alerts??[]).map(a=>a.symbol).join(', ')}) was not rebuilt into a review: since the size failure at ${new Date(sizeFailed.at).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul'})} KST its price has not moved past the review gate's limit. Logged once.`);}drift=null;}
    if(drift)this.triggerEvidence=drift;
    if(!drift&&this.config.newsTrigger!=='off'&&Date.now()-(this.lastNewsTrigger??0)>=600000){const held=this.heldEvents(scope);const pending=this.newsEvents.pending(this.config.newsTrigger).filter(event=>!held.has('news:'+event.id)).slice(0,5);if(pending.length){this.lastNewsTrigger=Date.now();this.newsEvents.markTriggered(pending.map(event=>event.id));this.triggerEvidence={kind:'news',events:pending.map(({id,title,source,published,symbols,importance})=>({id,title,source,published,symbols,importance}))};void this.review('News event trigger').catch(()=>{});return;}}
    // Near the daily AI budget, scheduled reviews run at twice the interval instead of stopping.
    const interval=this.reviewInterval.get(this.watchScope(),this.config).minutes*60000*this.slowFactor();
    if(!drift&&elapsed>=interval){const defer=this.deferForPendingOrder();if(defer){if(this.deferredAfter!==this.lastRun){this.deferredAfter=this.lastRun;const o=defer.orders[0];
      this.log(o.id,'System','Review waits for the pending order',`${o.side} ${o.quantity} ${o.symbol} is waiting at the broker (${o.status}${defer.orders.length>1?`, with ${defer.orders.length-1} more`:''}). The next review starts ${this.config.orderUpdateReviews===true?'when it fills, partly fills or is cancelled':'at the scheduled time once it has filled or been cancelled'}, on a price, news or agent trigger, when a market opens or closes, or at ${new Date(defer.until).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})} KST at the latest.`);}return;}}
    if(elapsed>=interval||drift)void this.review(drift?'Price movement trigger':this.firstAfterStart?'Auto trading started':'Scheduled review').catch(()=>{});
  }
  approveLesson(id,approved){if(typeof id!=='string'||typeof approved!=='boolean')throw new Error('INVALID_REQUEST');this.syncLearning();if(this.learningError)throw new Error('LESSON_REVIEW_FAILED');const lifecycle=this.memory.lifecycle(id);if(lifecycle)this.memory.review(id,{expectedSignature:lifecycle.signature,action:approved?'approve':'retire'});else this.db.prepare('UPDATE lessons SET approved=? WHERE id=?').run(approved?1:0,id);return this.getState();}
}
module.exports={loggableContext,dryRunSummary,dryRunMeasurement,answerRule,Automation,DEFAULTS};
