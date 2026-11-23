// AI scout: an occasional research run that studies the market, keeps the watchlist as a shortlist and writes a portfolio plan for trading reviews.
const {randomUUID}=require('node:crypto');
const ROLES=['hold','add','candidate','trim','exit'];
const SCHEMA={type:'object',properties:{
  summary:{type:'string'},cashTargetPct:{type:['number','null']},focus:{type:'string'},
  targets:{type:'array',items:{type:'object',properties:{symbol:{type:'string'},name:{type:'string'},role:{type:'string',enum:ROLES},targetWeightPct:{type:['number','null']},thesis:{type:'string'},risks:{type:'string'}},required:['symbol','name','role','targetWeightPct','thesis','risks'],additionalProperties:false}},
  briefAnswers:{type:'array',items:{type:'object',properties:{briefId:{type:'string'},answer:{type:'string'}},required:['briefId','answer'],additionalProperties:false}},
  retrospective:{type:'string'},
  // Stocks set aside because one share is too large for the allocation or the buying power, and the affordable
  // instruments checked in their place (chosen, rejected or not researched), with the exposure each keeps.
  substitutions:{type:'array',items:{type:'object',properties:{forSymbol:{type:'string'},why:{type:'string'},alternatives:{type:'array',items:{type:'object',properties:{symbol:{type:'string'},exposure:{type:'string'},verdict:{type:'string',enum:['chosen','rejected','not-researched']},reason:{type:'string'}},required:['symbol','exposure','verdict','reason'],additionalProperties:false}}},required:['forSymbol','why','alternatives'],additionalProperties:false}}
},required:['summary','cashTargetPct','focus','targets','briefAnswers','retrospective','substitutions'],additionalProperties:false};
const RESEARCH_SECTIONS=['overview','about','analysts','estimates','financials','dividends','events','release','flows','risk','valuation','peers','fund','holdings','factors','fairvalue'];
const MARKET_TOOL={type:'function',name:'get_market_overview',description:'Read the Korean market today: KOSPI and KOSDAQ level, advancers versus decliners, limit moves, KOSPI sector index moves, and the stocks foreigners and institutions are buying most (preliminary intraday tallies). Read-only; no parameters.',strict:true,parameters:{type:'object',properties:{},required:[],additionalProperties:false}};
const RESEARCH_TOOL={type:'function',name:'get_company_research',description:'Read research on one stock: a Korean 6-digit code, or a U.S. symbol such as NASD:AAPL (U.S. stocks have overview, risk, and with SEC access financials, dividends, events and release). sections picks what to read; an empty list returns overview, analysts, estimates and dividends for stocks, and overview, fund, holdings and risk for Korean ETFs and ETNs. fund (ETFs and ETNs only): issuer, underlying index, leverage factor (negative = inverse), NAV and premium or discount, tracking error, net assets, distribution cycle, and for leveraged or inverse products the estimated annual volatility drag. holdings (ETFs only): constituents with weights, top-5 and top-10 concentration and sector mix; funds holding foreign assets or futures may list none. overview: price, PER/PBR, market cap, 52-week range, foreign ownership. analysts: ratings and target prices by brokerage (180 days), recent target raises or cuts, and how the median target and EPS estimate changed over 1 and 3 months once the app has tracked them. estimates: consensus revenue, profit, EPS, PER and ROE for the next two years. financials: revenue, operating and net profit, margins, ROE, ROA, debt and liquidity ratios, growth and EV/EBITDA for recent years (the latest period may be year to date). dividends: per-share dividends by record date, trailing yield, frequency, and the annual report table (payout ratio, yield). events: upcoming record dates, shareholder meetings, estimated next earnings date, the figures of the latest preliminary-earnings filing (Korean stocks, read from the filing; undisclosed figures are null and listed as not disclosed) and recent material filings (earnings, buybacks, capital raises, contracts, lawsuits). about: what the company does, the opening of the business section of its latest annual report (10-K Item 1 or DART 사업의 개요), with the source. release: the latest earnings release as the company filed it, read from the document (U.S.: the 8-K exhibit 99.1 with its results and guidance sentences, source, filing date and text; Korean stocks: the DART preliminary-earnings figures); use it to verify figures and guidance before relying on a headline. flows: net buying by foreigners, institutions and individuals over 5 and 20 days, short-selling share of volume, margin loans outstanding and program trading. risk: volatility, beta and correlation to the market, 1- and 3-month returns versus the market and sector, drawdown, distance from moving averages, average daily traded value, and daily technicals (RSI, MACD, ATR, ADX, CCI, stochastic RSI, ultimate oscillator). factors: value, momentum, quality, growth and low-volatility percentiles against the largest same-sector stocks. fairvalue: a fair value range from analyst targets and peer and own-history multiples, with an uncertainty level. valuation: year-end PER and PBR over up to six years, where current multiples sit against that range, and 1-, 3- and 5-year returns. peers: the largest stocks in the same sector with market cap, PER and PBR, and the premium or discount to their median. Read-only. Ask only for sections you need.',strict:true,parameters:{type:'object',properties:{symbol:{type:'string'},sections:{type:'array',items:{type:'string',enum:RESEARCH_SECTIONS}}},required:['symbol','sections'],additionalProperties:false}};
// Trading reviews brief the scout in their decision: criteria, exclusions, questions and feedback on plan targets.
// "note" waits for the next run; "run" also asks for a run now, limited per account and Seoul day.
const REQUEST_LIMITS={perDay:3,gapMinutes:120};
const BRIEF_SCHEMA={type:'object',properties:{
  request:{type:'string',enum:['none','note','run']},reason:{type:'string'},lookingFor:{type:'string'},avoid:{type:'string'},questions:{type:'string'},
  feedback:{type:'array',items:{type:'object',properties:{symbol:{type:'string'},verdict:{type:'string',enum:['acted','passed','waiting']},reason:{type:'string'}},required:['symbol','verdict','reason'],additionalProperties:false}}
},required:['request','reason','lookingFor','avoid','questions','feedback'],additionalProperties:false};
const validSymbol=s=>typeof s==='string'&&(/^\d{6}$/.test(s)||/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(s));
const cut=(text,limit)=>{const t=String(text??'').trim();if(t.length<=limit)return t;const room=t.slice(0,limit-1);const end=Math.max(room.lastIndexOf('. '),room.lastIndexOf('다. '));return (end>limit/2?room.slice(0,end+1):room).trimEnd()+'…';};
const pct=v=>v==null?null:Number.isFinite(v)&&v>=0&&v<=100?Math.round(v*10)/10:undefined;
// skipped (2026-11-18, artifacts/reviews/2026-11-18-empty-scout-plan): an array that receives each target left out and why,
// so the run can say so; the plan itself is unchanged.
function validatePlan(value,skipped=null){
  if(!value||typeof value!=='object'||typeof value.summary!=='string'||typeof value.focus!=='string'||!Array.isArray(value.targets))throw new Error('INVALID_AI_RESPONSE');
  const cash=pct(value.cashTargetPct);if(cash===undefined)throw new Error('INVALID_AI_RESPONSE');
  const seen=new Set();const targets=[];const skip=(t,reason)=>{if(skipped)skipped.push({symbol:typeof t?.symbol==='string'?t.symbol.slice(0,24):null,reason});};
  if(skipped&&value.targets.length>12)for(const t of value.targets.slice(12))skip(t,'over 12 targets');
  for(const t of value.targets.slice(0,12)){
    if(!t||!validSymbol(t.symbol)){skip(t,'not a symbol');continue;}if(!ROLES.includes(t.role)){skip(t,'unknown role');continue;}if(seen.has(t.symbol)){skip(t,'listed twice');continue;}
    const weight=pct(t.targetWeightPct);if(weight===undefined){skip(t,'weight not a percent');continue;}seen.add(t.symbol);
    targets.push({symbol:t.symbol,name:cut(t.name,60),role:t.role,targetWeightPct:weight,thesis:cut(t.thesis,400),risks:cut(t.risks,300)});
  }
  const briefAnswers=(Array.isArray(value.briefAnswers)?value.briefAnswers:[]).filter(a=>a&&typeof a.briefId==='string'&&typeof a.answer==='string'&&a.answer.trim()).slice(0,8).map(a=>({briefId:a.briefId.trim().slice(0,20),answer:cut(a.answer,400)}));
  const unique=(rows,key)=>{const seen=new Set();return rows.filter(r=>{const k=key(r);if(seen.has(k))return false;seen.add(k);return true;});};
  const substitutions=unique((Array.isArray(value.substitutions)?value.substitutions:[]).filter(s=>s&&typeof s.forSymbol==='string'&&s.forSymbol.trim()&&Array.isArray(s.alternatives)),s=>s.forSymbol.trim()).slice(0,4).map(s=>({forSymbol:s.forSymbol.trim().slice(0,24),why:cut(s.why,200),
    alternatives:unique(s.alternatives.filter(a=>a&&typeof a.symbol==='string'&&a.symbol.trim()&&['chosen','rejected','not-researched'].includes(a.verdict)),a=>a.symbol.trim()).slice(0,3).map(a=>({symbol:a.symbol.trim().slice(0,24),exposure:cut(a.exposure,160),verdict:a.verdict,reason:cut(a.reason,240)}))}));
  return {summary:cut(value.summary,900),cashTargetPct:cash,focus:cut(value.focus,400),targets,briefAnswers,retrospective:cut(typeof value.retrospective==='string'?value.retrospective:'',500),...(substitutions.length?{substitutions}:{})};
}
// Why a well-formed plan says nothing, or null (2026-11-18 empty plan: an answer with an empty summary and focus and
// no Korean target replaced the plan on a Korean run). focus: the run's focused markets; heldMarkets: markets where the
// account holds stocks (a holding always gets a hold, trim or exit target, so a plan that sells everything still lists them).
const MARKET_NAME={KR:'Korea',US:'the U.S.'};
function planProblem(plan,{focus=[],heldMarkets=[]}={}){
  const reasons=[];if(!String(plan?.summary??'').trim())reasons.push('no summary');if(!String(plan?.focus??'').trim())reasons.push('no focus');
  const markets=new Set((plan?.targets??[]).map(t=>marketOf(t.symbol)));
  for(const m of focus)if(heldMarkets.includes(m)&&!markets.has(m))reasons.push(`no target for ${MARKET_NAME[m]??m}, where you hold stocks`);
  return reasons.length?reasons.join('; '):null;
}
// The skipped targets as one short line: "2 targets left out: 1 unknown role, 1 weight not a percent (005930, XYZ)".
function skippedLine(skipped){if(!skipped?.length)return null;const counts=new Map();for(const s of skipped)counts.set(s.reason,(counts.get(s.reason)??0)+1);
  const symbols=skipped.map(s=>s.symbol).filter(Boolean).slice(0,6);
  return `${skipped.length} target${skipped.length===1?'':'s'} left out: ${[...counts].map(([r,n])=>`${n} ${r}`).join(', ')}${symbols.length?` (${symbols.join(', ')})`:''}`;}
// The market narrative's times in Seoul on weekdays: [hour, minute]. The scout's scheduled runs follow the session
// calendar instead (scout-timing.cjs, step A4).
const SCHEDULES={narrative:[[8,30],[16,30]]};
// The most recent slot today that has passed, or null; a slot runs once even if the app opens late.
function dueSlot(schedule,now=Date.now()){
  const local=new Date(now+9*3600000);const day=local.toISOString().slice(0,10);if([0,6].includes(local.getUTCDay()))return null;
  const minutes=local.getUTCHours()*60+local.getUTCMinutes();const passed=(SCHEDULES[schedule]??[]).filter(([h,m])=>h*60+m<=minutes);
  if(!passed.length)return null;const [h,m]=passed.at(-1);return `${day} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
class ScoutStore {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS scout_plans(id TEXT PRIMARY KEY,scope TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS scout_slots(scope TEXT PRIMARY KEY,slot TEXT NOT NULL);CREATE TABLE IF NOT EXISTS scout_requests(scope TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,lastAt INTEGER NOT NULL,PRIMARY KEY(scope,day))');}
  requests(scope,day,now=Date.now()){const row=this.db.prepare('SELECT count,lastAt FROM scout_requests WHERE scope=? AND day=?').get(scope,day);const last=this.db.prepare('SELECT MAX(lastAt) AS lastAt FROM scout_requests WHERE scope=?').get(scope)?.lastAt??null;const remainingToday=Math.max(0,REQUEST_LIMITS.perDay-(row?.count??0));const nextAllowedAt=last?last+REQUEST_LIMITS.gapMinutes*60000:null;return {remainingToday,nextAllowedAt:nextAllowedAt&&nextAllowedAt>now?nextAllowedAt:null};}
  noteRequest(scope,day,now=Date.now()){this.db.prepare('INSERT INTO scout_requests VALUES(?,?,1,?) ON CONFLICT(scope,day) DO UPDATE SET count=count+1,lastAt=excluded.lastAt').run(scope,day,now);}
  save(scope,plan,meta={}){const record={id:randomUUID(),scope,timestamp:Date.now(),...meta,plan};this.db.prepare('INSERT INTO scout_plans VALUES(?,?,?,?)').run(record.id,scope,record.timestamp,JSON.stringify(record));this.db.prepare('DELETE FROM scout_plans WHERE scope=? AND id NOT IN (SELECT id FROM scout_plans WHERE scope=? ORDER BY timestamp DESC LIMIT 30)').run(scope,scope);return record;}
  latest(scope){const row=this.db.prepare('SELECT payload FROM scout_plans WHERE scope=? ORDER BY timestamp DESC LIMIT 1').get(scope);return row?JSON.parse(row.payload):null;}
  // The scout's own notes from earlier runs, newest first.
  retrospectives(scope,limit=3){return this.db.prepare('SELECT payload FROM scout_plans WHERE scope=? ORDER BY timestamp DESC LIMIT 15').all(scope).map(r=>JSON.parse(r.payload)).filter(r=>r.plan.retrospective).slice(0,limit).map(r=>({asOf:new Date(r.timestamp).toISOString(),note:r.plan.retrospective}));}
  lastSlot(scope){return this.db.prepare('SELECT slot FROM scout_slots WHERE scope=?').get(scope)?.slot??null;}
  markSlot(scope,slot){this.db.prepare('INSERT INTO scout_slots VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET slot=excluded.slot').run(scope,slot);}
  // The latest failed scout run of a scope (2026-11-18): {at, reason, trigger}. Kept until a later failure replaces it;
  // it matters only while it is newer than the latest plan (failedAfter).
  // The latest run's screens, plan or failure, in their own row: the panel asks for them; nothing else reads them.
  saveScreens(scope,{runId,at=Date.now(),failed=false,screens=[]}){this.db.exec('CREATE TABLE IF NOT EXISTS scout_screens(scope TEXT PRIMARY KEY,runId TEXT,at INTEGER NOT NULL,failed INTEGER NOT NULL,count INTEGER NOT NULL,payload TEXT NOT NULL)');
    const kept=(Array.isArray(screens)?screens:[]).slice(0,SCREENS_KEPT);this.db.prepare('INSERT INTO scout_screens VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET runId=excluded.runId,at=excluded.at,failed=excluded.failed,count=excluded.count,payload=excluded.payload').run(scope,runId??null,at,failed?1:0,kept.length,JSON.stringify(kept));}
  screensSummary(scope){try{const r=this.db.prepare('SELECT runId,at,failed,count FROM scout_screens WHERE scope=?').get(scope);return r?{runId:r.runId,at:r.at,failed:Boolean(r.failed),count:r.count}:null;}catch{return null;}}
  latestScreens(scope){try{const r=this.db.prepare('SELECT runId,at,failed,payload FROM scout_screens WHERE scope=?').get(scope);return r?{runId:r.runId,at:r.at,failed:Boolean(r.failed),screens:JSON.parse(r.payload)}:null;}catch{return null;}}
  noteFailure(scope,{at=Date.now(),reason,trigger=null}){this.db.exec('CREATE TABLE IF NOT EXISTS scout_failures(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    this.db.prepare('INSERT INTO scout_failures VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload').run(scope,JSON.stringify({at,reason:String(reason??'SCOUT_FAILED').slice(0,60),trigger:trigger==null?null:String(trigger).slice(0,40)}));}
  lastFailure(scope){try{const row=this.db.prepare('SELECT payload FROM scout_failures WHERE scope=?').get(scope);return row?JSON.parse(row.payload):null;}catch{return null;}}
  // The failure newer than the latest plan, or null.
  failedAfter(scope,record=this.latest(scope)){const f=this.lastFailure(scope);return f&&(!record||f.at>record.timestamp)?f:null;}
}
// The plan as trading reviews see it: recent plans only, compact.
// stale: carried targets that need reassessment (staleCarried), shown on their targets.
// failed (2026-11-18): a scheduled scout run that failed after this plan ({at, reason}); the review then sees
// lastRunFailed, so it knows the plan predates that run. Absent otherwise.
function reviewContext(record,now=Date.now(),{stale=[],failed=null}={}){
  if(!record||now-record.timestamp>36*3600000)return null;const p=record.plan;const flagged=new Map(stale.map(s=>[s.symbol,s.reasons]));
  const lastRunFailed=failed&&Number.isFinite(failed.at)&&failed.at>record.timestamp?{at:new Date(failed.at).toISOString(),reason:String(failed.reason??'SCOUT_FAILED').slice(0,60)}:null;
  return {asOf:new Date(record.timestamp).toISOString(),...(lastRunFailed?{lastRunFailed}:{}),summary:p.summary,cashTargetPct:p.cashTargetPct,focus:p.focus,targets:p.targets.map(({symbol,name,role,targetWeightPct,thesis,carriedFrom})=>({symbol,name,role,targetWeightPct,thesis,...(carriedFrom?{setAt:carriedFrom}:{}),...(carriedFrom&&flagged.has(symbol)?{needsReassessment:flagged.get(symbol)}:{})})),...(record.answered?.length?{briefAnswers:record.answered}:{}),...(p.substitutions?.length?{substitutions:p.substitutions}:{})};
}
// Research rounds: the AI calls tools until it writes a plan; the last round must answer.
// Three rounds of at most six requests: two research rounds (up to 12 tool calls), then the plan. maxBytes is the whole
// request as sent: overheadBytes (instructions, tool definitions and the plan schema) plus the conversation. Each
// result is kept whole for this run (review-context.cjs resultStore) and sent bounded to its share of the room left, at
// most 12 KB: valid JSON, whole parts in order, pinned identity, next-session and instrument parts, and the paths of what
// was cut, readable with get_context_detail. A detail read is one of the round's requests and shares its room, but reads
// no source, so it never spends a next-session read. Before each request older results are referenced (pointing at their
// stored section) until the request fits; one that still does not fit is not sent.
const SCOUT_REQUEST_BYTES=180000;
// check (2026-11-18, artifacts/reviews/2026-11-18-empty-scout-plan): plan -> the reason it says nothing (planProblem), or
// null. A plan with a reason is refused: its answer goes into the log (at most 4 KB), and the final call is asked once
// more, with the same history and one sentence appended (the cached prefix is unchanged). A second refused plan fails
// the run with SCOUT_EMPTY_PLAN, so the previous plan stays. Targets left out of any answer are logged with their reasons.
const RETRY_NOTE=reason=>`Your answer had no plan (${reason}). Write the full plan now from the research above; tools are off.`;
async function acceptPlan(result,{check,log,retry}){
  const line=skippedLine(result.skippedTargets);if(line)log('System','Scout targets left out',line);
  const reason=check?check(result.plan):null;if(!reason)return result;
  log('System','Scout answer refused',`${reason}. Answer: ${JSON.stringify(result.answer??result.plan).slice(0,4096)}`);
  if(!retry)throw Object.assign(new Error('SCOUT_EMPTY_PLAN'),{detail:reason});
  const again=await retry(reason);return acceptPlan(again,{check,log,retry:null});}
async function runScout({request,tools,log,maxRounds=3,maxCalls=6,maxBytes=SCOUT_REQUEST_BYTES,overheadBytes=0,watched=[],check=null}){
  let continuation,lastFrom=0;const usage={inputTokens:0,outputTokens:0,cachedTokens:0};const cache=new Map();let model=null;
  const rc=require('./review-context.cjs'),cf=require('./context-fit.cjs'),store=rc.resultStore(),meter=require('./research-meter.cjs').createMeter();
  const room=Math.floor(maxBytes*0.9)-overheadBytes;
  const fitted=async(keepFrom,targetBytes)=>{if(cf.size(continuation)<=targetBytes)return;const out=await cf.fit(continuation,{keepFrom,targetBytes,refs:store.refs()});continuation=out.items;log('System','Scout context condensed',JSON.stringify(out.steps));};
  // A failed run still reports what it researched (error.metrics).
  try{
  for(let round=0;round<maxRounds;round++){
    // The latest round's results give way only after every older one.
    if(continuation){await fitted(lastFrom,room);await fitted(continuation.length,room);const total=overheadBytes+cf.size(continuation);
      if(total>maxBytes)throw Object.assign(new Error('CONTEXT_OVER_BUDGET'),{detail:`the scout request would be ${total} bytes, over its ${maxBytes}-byte limit`});}
    let result=await request({final:round===maxRounds-1,continuation});model=result.model??model;
    usage.inputTokens+=result.usage?.inputTokens??0;usage.outputTokens+=result.usage?.outputTokens??0;usage.cachedTokens+=result.usage?.cachedTokens??0;
    // A tool request on the final round (both clients return it flagged): each call is answered "no tools in this round"
    // and one more final request is made; a tool request in that one fails the run, as before.
    if(result.finalToolUse&&result.toolCalls?.length&&Array.isArray(result.continuation)){
      log('System','Tool request on the final round',`${result.toolCalls.length} (${[...new Set(result.toolCalls.map(c=>String(c.name).slice(0,40)))].slice(0,8).join(', ')}): answered "no tools in this round"; one more request`);
      continuation=[...result.continuation,...result.toolCalls.map(c=>({type:'function_call_output',call_id:c.callId,output:JSON.stringify({status:'error',words:'no tools in this round: give your answer now'})}))];
      const replace=new Map();for(const c of result.toolCalls)if(c.name==='run_screen')replace.set(c.callId,screenStandIn(c.args,{reason:'no tools in the final round'}));shrinkCalls(continuation,replace);
      await fitted(continuation.length,room);result=await request({final:true,continuation});model=result.model??model;
      usage.inputTokens+=result.usage?.inputTokens??0;usage.outputTokens+=result.usage?.outputTokens??0;usage.cachedTokens+=result.usage?.cachedTokens??0;
      if(result.toolCalls?.length)throw Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:'the model asked for a tool on the final round'});}
    if(result.plan){let retried=false;const sent=continuation;
      // The retry needs the history the final call was sent; a plan from the very first call (no history) is not retried.
      const retry=sent?async reason=>{retried=true;const again=await request({final:true,continuation:[...sent,{role:'user',content:RETRY_NOTE(reason)}]});model=again.model??model;
        usage.inputTokens+=again.usage?.inputTokens??0;usage.outputTokens+=again.usage?.outputTokens??0;usage.cachedTokens+=again.usage?.cachedTokens??0;
        if(!again.plan)throw Object.assign(new Error('SCOUT_EMPTY_PLAN'),{detail:`${reason}; the second answer had no plan`});return again;}:null;
      const final=await acceptPlan(result,{check,log,retry});
      return {plan:final.plan,usage,model,rounds:round+1,metrics:meter.summary(watched),...(retried?{retried:true}:{})};}
    if(!result.toolCalls?.length||!Array.isArray(result.continuation))throw Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:'the model returned neither a plan nor a tool request'});
    continuation=result.continuation;const keepFrom=continuation.length;lastFrom=keepFrom;
    // Every call needs an answer; requests beyond the per-round limit are told to wait for the next round.
    for(const call of result.toolCalls.slice(maxCalls))continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify({status:'skipped',reason:`At most ${maxCalls} tool requests per round; ask again in the next round if still needed.`})});
    // The scripts are read from the calls; in the conversation each is a stand-in from now on (skipped calls keep no
    // arguments), so the room for this round's results is counted without them.
    {const replace=new Map();result.toolCalls.forEach((call,i)=>{if(call.name==='run_screen')replace.set(call.callId,screenStandIn(call.args,{skipped:i>=maxCalls}));});shrinkCalls(continuation,replace);}
    // Older results give way first, so this round's results get at least 4 KB each.
    const calls=Math.max(1,Math.min(maxCalls,result.toolCalls.length));await fitted(keepFrom,room-calls*4000);
    const perCall=Math.max(1500,Math.min(12000,Math.floor((room-cf.size(continuation))/calls)-200));
    for(const call of result.toolCalls.slice(0,maxCalls)){
      log('Agent','Scout request · '+call.name,JSON.stringify(call.args));
      if(call.name==='get_context_detail'){const value=store.read(call.args,Math.min(8000,perCall),call.callId),sent=rc.bound(value,perCall);meter.call(call.name,call.args,value,sent);
        log('Tool','Context detail · '+String(call.args?.section??'')+(call.args?.part?' · '+call.args.part:''),value.status??(value.complete?'complete':'partial'));continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(sent)});continue;}
      const tool=tools[call.name];const key=call.name==='update_watchlist'?null:call.name+JSON.stringify(call.args);let value=key?cache.get(key):undefined;const reused=value!==undefined;
      // A screen whose result would leave no room for the plan round is answered, not run.
      const noRoom=!value&&call.name==='run_screen'&&tool&&cf.size(continuation)+perCall>room;
      if(!value){if(!tool)value={status:'unavailable',reason:'UNKNOWN_TOOL'};else{try{value=await tool(call.args,noRoom?{noRoom:true}:undefined);}catch(error){value={status:'unavailable',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DATA_SOURCE_UNAVAILABLE'};}}if(key&&!noRoom)cache.set(key,value);}
      log('Tool','Scout result · '+call.name,JSON.stringify(value));
      const sent=store.keep(call.callId,value,perCall);meter.call(call.name,call.args,value,sent,{runCache:reused});
      continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(sent)});
    }
  }
  throw Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:`no plan after ${maxRounds} research rounds`});
  }catch(error){if(error&&typeof error==='object'&&!error.metrics)error.metrics=meter.summary(watched);throw error;}
}
// The scout's text with every part (instruction rewrite): the size bound and older readers. Requests send scoutText.
const INSTRUCTIONS=require('./review-instructions.cjs').SCOUT_ALL;

// Research focus: markets whose regular session is open or within 30 minutes of its open or close. Outside those
// windows, a market where the app can trade an extended session now; failing both, every market. A scheduled run
// (step A4) focuses on its slot's market, whatever the clock distance to its session.
const GRACE=30*60000;
function researchFocus(markets,now=Date.now(),opts={}){
  if(opts.slot&&markets.includes(opts.slot.market))return {markets:[opts.slot.market],deferred:markets.filter(m=>m!==opts.slot.market),basis:`scheduled run: ${opts.slot.label}`};
  const S=require('./market-sessions.cjs');
  const nearRegular=m=>{const tz=m==='KR'?'Asia/Seoul':'America/New_York';const days=[...new Set([-1,0,1].map(i=>S.localDay(now+i*86400000,tz)))];
    return days.flatMap(d=>S.sessionsOn(m,d,opts)).some(x=>x.regular&&x.startAt-GRACE<=now&&now<x.endAt+GRACE);};
  let focus=markets.filter(nearRegular),basis='regular session (30-minute grace)';
  if(!focus.length){focus=markets.filter(m=>S.tradableNow(m,now,opts));basis='extended session the app trades';}
  if(!focus.length){focus=[...markets];basis='no market open';}
  return {markets:focus,deferred:markets.filter(m=>!focus.includes(m)),basis};
}
const marketOf=symbol=>/^\d{6}$/.test(symbol)?'KR':'US';
// The scout's tools, limited to the research focus. In a deferred (closed) market screening and the market overview are
// refused, but a few company reads are answered for next-session candidates (for example the fund details, holdings and
// leverage of a sector ETF on a lead), marked as last-session data awaiting the open, and a watchlist entry added for
// that market is labeled the same way. Nothing here trades; plan targets for deferred markets still carry forward.
const SCREENS_KEPT=12;
const NEXT_SESSION_READS=3,NEXT_SESSION_LABEL='Next session, confirm at the open: ';
// The screening tool (note 5, S3): one script a call, run by formula-script.cjs through the scout run's own screen run
// (main.cjs openScreenRun: one live-price bound per scout run). Its description is the language's own help: what it
// computes, its functions, bounds and universes, with no suggested screen or strategy.
const SCREEN_TOOL={type:'function',name:'run_screen',strict:true,description:'Runs one screening script over universes you choose and returns its printed lines, with the coverage of each screen (how many stocks were evaluated, had no history, were stale, could not be computed or had no live price) and the day each market\'s closes are as of. '+require('./formula-script.cjs').HELP,
  parameters:{type:'object',properties:{script:{type:'string',description:'The script, as lines separated by line breaks.'}},required:['script'],additionalProperties:false}};
// A run_screen request as the model sent it (a JSON text from OpenAI, an object from Claude), read without ever failing
// the run: anything over SCREEN_REQUEST_BYTES or not of the form {"script": "..."} becomes {invalid: words}, which the
// tool answers as an error the model can correct.
const SCREEN_REQUEST_BYTES=6000;
function screenArgs(raw){let obj=raw;
  if(typeof raw==='string'){const n=Buffer.byteLength(raw);if(n>SCREEN_REQUEST_BYTES)return {invalid:`the request is ${n} bytes; at most ${SCREEN_REQUEST_BYTES}`};try{obj=JSON.parse(raw);}catch{return {invalid:'the request was not valid JSON'};}}
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return {invalid:'the request was not an object with a script'};
  let n=0;try{n=Buffer.byteLength(JSON.stringify(obj));}catch{return {invalid:'the request could not be read'};}if(n>SCREEN_REQUEST_BYTES)return {invalid:`the request is ${n} bytes; at most ${SCREEN_REQUEST_BYTES}`};
  if(typeof obj.script!=='string')return {invalid:'the request had no script text'};return {script:obj.script};}
// The script as kept for the panel: control, direction and other invisible characters replaced as in printed text, line
// breaks kept, cut on whole characters at 4,000 with "… cut".
function keptScript(script){const {clean}=require('./formula-script.cjs');const lines=String(script??'').replace(/\r\n?/g,'\n').split('\n').map(l=>clean(l,400));
  const chars=Array.from(lines.join('\n'));return chars.length>4000?chars.slice(0,4000).join('')+'\n… cut':chars.join('');}
// Once a screen is answered, its script in the conversation is replaced by a short stand-in on both continuation shapes
// (OpenAI function_call arguments, Claude tool_use input), so a long script costs its bytes once; the result keeps what
// it printed. A request answered as skipped keeps no arguments.
function screenStandIn(args,{skipped=false,reason=null}={}){const s=typeof args?.script==='string'?args.script:'';
  if(!s)return {script:`# not run: ${String(args?.invalid??'no script').slice(0,80)}`};
  const first=(s.split('\n').find(l=>l.trim())??'').slice(0,60);return {script:`# ${reason?`not run (${reason})`:skipped?'not run (over this round\'s tool limit)':'answered above'}: ${first} (${Buffer.byteLength(s)} bytes, sha256 ${require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0,8)})`};}
function shrinkCalls(items,replace){if(!replace.size)return;for(const it of items){
  if(it?.type==='function_call'&&replace.has(it.call_id))it.arguments=JSON.stringify(replace.get(it.call_id));
  else if(it?.type==='anthropic_turn'&&Array.isArray(it.content))it.content=it.content.map(b=>b?.type==='tool_use'&&replace.has(b.id)?{...b,input:replace.get(b.id)}:b);}}
// The run_screen tool for the scout and the review (S4): every failure of a script comes back as a result with words, and
// the run or review goes on; it never throws. The account guard is the same as update_watchlist's, answered in words.
// screens: the scout run's kept scripts (12 at most); onRecord(script, facts): the review's formula-use record.
function screenTool({screen,screens=null,guard=()=>{},onRecord=null,noRoomWords='the script was not run: this run has no room left for another screen result; write the plan with what you have'}){const usage=' (a script is at most 40 lines and 4,000 characters, sent as {"script": "..."})';
  const record=(facts,script)=>{try{if(Array.isArray(screens)&&screens.length<SCREENS_KEPT)screens.push({at:Date.now(),script:keptScript(script),...facts});onRecord?.(script,facts);}catch{}return facts;};
  const stale=()=>{try{guard();return false;}catch{return true;}};const STALE='the script was not run: the account or scope changed during this run';
  return async(args,{noRoom=false,notRun=null}={})=>{
    if(typeof notRun==='string')return record({status:'error',words:`the script was not run: ${notRun}`},typeof args?.script==='string'?args.script:'');
    if(stale())return record({status:'error',words:STALE},typeof args?.script==='string'?args.script:'');
    if(noRoom)return record({status:'error',words:noRoomWords},typeof args?.script==='string'?args.script:'');
    if(args?.invalid)return record({status:'error',words:`the script was not run: ${args.invalid}${usage}`},'');
    if(typeof args?.script!=='string')return record({status:'error',words:`the script was not run: the request had no script text${usage}`},'');
    if(typeof screen!=='function')return record({status:'error',words:'the script was not run: screens are not available in this run'},args.script);
    let r;try{r=await screen(args.script);}catch(error){if(typeof error?.words==='string')return record({status:'error',words:`the script was not run: ${error.words.slice(0,200)}`},args.script);const code=/^[A-Z_]{3,40}$/.test(String(error?.code??error?.message??''))?(error.code??error.message):'SCREEN_FAILED';return record({status:'error',words:`the script could not be run (${code})`},args.script);}
    if(stale())return record({status:'error',words:STALE},args.script);return record(screenFacts(r),args.script);};}
// The review's run_screen (S4): the same tool over the review's own stocks; its description is facts only.
// The review's help: the language's HELP with the review's own run named, every replacement checked.
const REVIEW_HELP=(()=>{let h=require('./formula-script.cjs').HELP;for(const [a,b] of [['Live reads stop for the rest of the scout run','Live reads stop for the rest of this review'],['120 and 40 a scout run','120 and 40 a review'],['Universes: universe(market=…, type=…, top_cap=…, own=…)','Universes: universe(own=…, market=…, type=…, top_cap=…) with own always given']]){if(h.split(a).length!==2)throw new Error('REVIEW_HELP: '+a);h=h.replace(a,b);}
  return h+' In a review, its scripts share 60 seconds of script time, daily reads included; after that a script is answered without being run. Before a script that reads daily history, the history of the review\'s stocks it names by code (up to 6 a script) and, for a universe, of the review\'s stocks (up to 24 a review) is read when the stored history is not current. In a review: ret and change of the live quote are written with live(S) in place of the last close: (live(S) / close(S, n-1) - 1) * 100 is the % return from the close n sessions before today to the live quote, and (live(S) / close(S, 0) - 1) * 100 today\'s change; zscore and ratio_z of the live quote cannot be written, as no function gives the standard deviation of closes. A trigger or conditional order evaluates its formula on the latest quote, so a level read from a script\'s close-based value is compared there with the live one.';})();
const REVIEW_SCREEN_TOOL={type:'function',name:'run_screen',strict:true,description:'Runs one screening script over this review\'s own stocks and returns its printed lines, with the coverage of each screen and the day each market\'s closes are as of. In a review the universes are universe(own="review") (this review\'s stocks), universe(own="holdings"), universe(own="watchlist"), universe(own="plan") and universe(own="allowlist") limited to them, and list("code", …) or ["code", …] of them; a stock outside them is refused, and universe(market=…) is not used. A stock whose nightly history is not yet stored (or stored only up to an older day) is read from this review\'s own daily history when that is newer, and marked with its own as-of day. '+REVIEW_HELP,
  parameters:{type:'object',properties:{script:{type:'string',description:'The script, as lines separated by line breaks.'}},required:['script'],additionalProperties:false}};
// What the scout gets back from a script: facts only, in a fixed order (status, the stop, the lines, the coverage, the days).
function screenFacts(r){const out={status:r?.stopped?'stopped':'ok'};if(r?.stopped)out.stopped={line:r.stopped.line??null,words:String(r.stopped.words??'')};
  out.lines=Array.isArray(r?.lines)?r.lines:[];out.coverage=(Array.isArray(r?.coverage)?r.coverage:[]).map(c=>({line:c.line,universe:c.universe,size:c.size,evaluated:c.evaluated,noHistory:c.noHistory,stale:c.stale,errors:c.errors,noLive:c.noLive??0}));
  if(r?.asOf)out.asOf=r.asOf;if(r?.live)out.live={asked:r.live.asked,read:r.live.read,...(r.live.stopped?{stopped:r.live.stopped.words}:{})};return out;}
// reassess: symbols of carried targets that need reassessment; reading them in a closed market spends no next-session read.
// screen(script): the scout run's screen runner (null when screens are not wired); screens: the run's record of them.
function focusTools(discovery,focus,{reads=NEXT_SESSION_READS,guard=()=>{},reassess=[],screen=null,screens=null}={}){
  const deferred=market=>focus.deferred.includes(market),name=market=>market==='KR'?'Korea':'The U.S.';
  const skip=market=>({status:'skipped',reason:`${name(market)} is outside this run's research focus (closed); its targets carry forward from the previous plan.`});
  let left=reads;
  const symbolOf=value=>String(value??'').trim().toUpperCase();
  // An empty reason stays empty, so it cannot replace the reason an entry already has.
  const label=entry=>{const reason=String(entry?.reason??'').trim();return reason&&deferred(marketOf(symbolOf(entry?.symbol)))&&!reason.startsWith(NEXT_SESSION_LABEL)?{...entry,reason:NEXT_SESSION_LABEL+reason}:entry;};
  return {
    screen_market:args=>deferred(args?.market)?skip(args.market):discovery.screen_market(args),
    search_securities:args=>discovery.search_securities(args),
    get_company_research:async args=>{const market=marketOf(symbolOf(args?.symbol));if(!deferred(market))return discovery.research(args);
      if(reassess.includes(symbolOf(args?.symbol))){const result=await discovery.research(args);return result?.status==='unavailable'?result:{reassessment:{market,note:`${name(market)} is closed: read to reassess a carried target. Prices are from the last session.`},...result};}
      if(left<=0)return {status:'skipped',reason:`${name(market)} is closed and this run's ${reads} next-session reads are used; its targets carry forward from the previous plan.`};
      // A read that fails (an unknown symbol, a source down) does not spend the budget. The marker comes first, so
      // bounding a long reply never drops it.
      left--;let result;try{result=await discovery.research(args);}catch(error){left++;throw error;}if(result?.status==='unavailable'){left++;return result;}
      return {nextSession:{market,awaitingOpen:true,readsLeft:left,note:`${name(market)} is closed: read for a next-session candidate only. Prices are from the last session; the candidate awaits fresh prices and confirmation at the open and gets no target in this plan.`},...result};},
    get_market_overview:()=>deferred('KR')?skip('KR'):discovery.marketOverview?discovery.marketOverview():{status:'unavailable',reason:'MARKET_OVERVIEW_UNAVAILABLE'},
    run_screen:screenTool({screen,screens,guard}),
    update_watchlist:args=>{guard();return discovery.update_watchlist(args?.action==='add'&&Array.isArray(args.entries)?{...args,entries:args.entries.map(label)}:args);},
  };
}
// Targets for deferred markets come from the previous plan, keeping the date they were set; targets older than
// three days are dropped. A deferred market the new plan does cover keeps the new targets. reassessed: carried symbols
// the run was asked to reassess; a new target for one of them replaces that target only, and the market's other
// targets still carry forward.
function carryForward(plan,previous,deferred,now=Date.now(),{reassessed=[]}={}){
  if(!previous||!deferred.length)return plan;const symbols=new Set(plan.targets.map(t=>t.symbol));const covered=new Set(plan.targets.filter(t=>!reassessed.includes(t.symbol)).map(t=>marketOf(t.symbol)));const prevAt=new Date(previous.timestamp).toISOString();
  const carried=(previous.plan?.targets??[]).filter(t=>deferred.includes(marketOf(t.symbol))&&!covered.has(marketOf(t.symbol))&&!symbols.has(t.symbol)).map(t=>({...t,carriedFrom:t.carriedFrom??prevAt})).filter(t=>now-Date.parse(t.carriedFrom)<=72*3600000);
  return carried.length?{...plan,targets:[...plan.targets,...carried].slice(0,16)}:plan;
}
// Carried targets whose thesis newer evidence contradicts: a later trading review that recommended the opposite trade or
// passed on the target, or a price move of movePct or more since the target was set. reviews: newest first, as stored.
// price(symbol): the latest price, compared with the price stored when the target was written (priceWhenSet); a target
// without one (written before it was stored) gets no price comparison.
// A morning plan once carried a hold thesis that accepted an earnings risk, after several
// trading reviews had recommended selling on those results.
const KEEPS=['hold','add','candidate'],CUTS=['trim','exit'];
function staleCarried(targets,{reviews=[],price=()=>null,movePct=6}={}){
  const day=t=>new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC';
  return (targets??[]).filter(t=>t.carriedFrom).flatMap(t=>{const since=Date.parse(t.carriedFrom);const reasons=[];
    for(const r of reviews){if(!(r.timestamp>since))continue;const d=r.decision;
      if(d?.symbol===t.symbol&&(d.action==='Sell'&&KEEPS.includes(t.role)||d.action==='Buy'&&CUTS.includes(t.role))){reasons.push(`A trading review at ${day(r.timestamp)} recommended ${d.action}.`);break;}
      const v=d?.planVerdicts?.find(x=>x.symbol===t.symbol);if(v?.verdict==='passed'&&KEEPS.includes(t.role)){reasons.push(`A trading review at ${day(r.timestamp)} passed on it: ${String(v.reason??'').slice(0,160)}`);break;}}
    const then=t.priceWhenSet,last=price(t.symbol);
    if(then>0&&last>0){const m=(last/then-1)*100;if(Math.abs(m)>=movePct)reasons.push(`The price moved ${m>0?'+':''}${m.toFixed(1)}% since the target was written (${then} at ${day(t.priceWhenSetAt)}).`);}
    return reasons.length?[{symbol:t.symbol,role:t.role,setAt:t.carriedFrom,reasons}]:[];});
}
module.exports={staleCarried,researchFocus,carryForward,marketOf,focusTools,NEXT_SESSION_LABEL,SCOUT_REQUEST_BYTES,MARKET_TOOL,RESEARCH_SECTIONS,BRIEF_SCHEMA,REQUEST_LIMITS,SCHEMA,RESEARCH_TOOL,INSTRUCTIONS,SCHEDULES,ROLES,validatePlan,planProblem,skippedLine,RETRY_NOTE,dueSlot,ScoutStore,reviewContext,runScout,SCREEN_TOOL,REVIEW_SCREEN_TOOL,REVIEW_HELP,screenTool,screenFacts,SCREENS_KEPT,screenArgs,keptScript,screenStandIn,shrinkCalls,SCREEN_REQUEST_BYTES};
