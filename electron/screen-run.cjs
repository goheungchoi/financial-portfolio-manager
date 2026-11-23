'use strict';
// Live prices in screens (note 6, addition; the user: "Live prices may be needed. Separate the live price fetch method and
// the yesterday's close price fetch method."; planner's rulings of 2026-11-23). formula-script.run stays synchronous and
// pure, so a script runs twice:
// - pass 1 plans: live() records its stock and answers "unknown"; a value that depends on an unknown is unknown, both
//   sides of and/or are visited, a filter on an unknown condition keeps every stock, a ranking with unknown values or an
//   unknown n keeps every candidate, an unknown count is unknown, and every live("code") written in the text is recorded
//   as well. So pass 1's set covers every stock pass 2 can ask for, by construction;
// - the quotes are read from KIS, awaited as promises (the main process is never blocked);
// - pass 2 runs the same script with the quotes. A stock pass 2 asks for that pass 1 did not record is "no live price";
//   there is never a second round of reads.
// Bounds: at most 60 Korean and 20 U.S. stocks a script and 120 and 40 a scout run (the run's state is owned by the caller
// that opens the run: openRun); a script that asks for more stops before any read, with words telling the author to
// narrow the universe first. A script that cannot be parsed reads nothing. The reads have 30 seconds a script; the
// 2-second bound of each pass covers computing only.
// Korea is read 30 stocks a request (intstock-multprice, verified on a live account 2026-11-23); the U.S. one a request
// (the last price KIS gives: no volume, so it cannot be checked for a halt). A read is sent only while no app order is
// being sent or cancelled and nothing waits in the KIS queue; once an order starts being sent, or KIS answers with a rate
// limit, the run's live reads stop and the lines say why. Quotes are kept 60 seconds. A Korean quote with no volume
// during a session (perhaps a halt) is "no live price". A read time outside the last 60 seconds is replaced by the app's.
const {run,parseScript,stopFor}=require('./formula-script.cjs');
const LIVE_LIMITS=Object.freeze({script:Object.freeze({KR:60,US:20}),run:Object.freeze({KR:120,US:40})});
const READ_MS=30000,CACHE_MS=60000,BATCH=30,WAIT_STEP_MS=200;
const marketOf=s=>/:/.test(s)?'US':'KR';
const KR_CODE=/^\d{6}$/,US_CODE=/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/;
const STOPPED={CANCELLED:'live reads stopped: the run was stopped',WAIT:'live reads stopped: this run spent its waiting time',ORDER:'live reads stopped: an order was being sent',RATE_LIMITED:'live reads stopped: KIS asked the app to slow down',FAILURES:'live reads stopped: three requests in a row failed'};
// The KIS queue's own bound on a request (kis-service.cjs: the worker request is dropped after 90 seconds).
const QUEUE_TIMEOUT_MS=90000;
// The run's state across its scripts: the live stocks left and why the reads stopped, if they did.
// A run waits at most RUN_WAIT_MS in all for orders and live reads, across its scripts.
const RUN_WAIT_MS=60000;
const newRun=()=>({left:{...LIVE_LIMITS.run},stoppedBy:null,failedInRow:0,waitLeft:RUN_WAIT_MS,cancelled:()=>false});
// Every live("code") written in the text, so a short cut in pass 1 can never leave one out.
function writtenCodes(statements){const out=[];const walk=n=>{if(!n||typeof n!=='object')return;
  if(n.t==='call'){if(n.fn==='live'&&n.args[0]?.t==='str')out.push(n.args[0].v.trim().toUpperCase());n.args.forEach(walk);n.named.forEach(([,v])=>walk(v));}
  else if(n.t==='op'){walk(n.a);walk(n.b);}else if(n.t==='list')n.items.forEach(walk);};
  for(const st of statements)walk(st.expr);return out.filter(s=>KR_CODE.test(s)||US_CODE.test(s));}
function usesLive(statements){let found=false;const walk=n=>{if(found||!n||typeof n!=='object')return;if(n.t==='call'){if(n.fn==='live'){found=true;return;}n.args.forEach(walk);n.named.forEach(([,v])=>walk(v));}else if(n.t==='op'){walk(n.a);walk(n.b);}else if(n.t==='list')n.items.forEach(walk);};for(const st of statements)walk(st.expr);return found;}
// The two passes as pure, synchronous steps, so they run where the caller chooses: in a worker thread in the app
// (screen-worker.cjs; the Electron main process never runs a model's script), or in process in tests.
function planStep(text,ctx){const base=ctx&&typeof ctx==='object'?ctx:{};
  // A script that cannot be parsed is not run and reads nothing: its error is the answer.
  let statements;try{statements=parseScript(text);}catch(error){return {parseStop:stopFor(error,null)};}
  const uses=usesLive(statements);if(!uses)return {uses:false,asked:[],assumed:false,planStop:null};
  const asked=[],seen=new Set();const note=s=>{if(!seen.has(s)){seen.add(s);asked.push(s);}};
  let assumed=false;const plan=run(text,{...base,livePlan:note,livePlanAssumed:()=>{assumed=true;}});// A written code outside a review's stocks never joins the reads (the final pass refuses it in words).
  const allow=s=>{try{return typeof base.allowSymbol!=='function'||base.allowSymbol(s)===true;}catch{return false;}};for(const s of writtenCodes(statements))if(allow(s))note(s);
  return {uses:true,asked,assumed,planStop:plan.stopped??null};}
function finalStep(text,ctx,{quotes=[],why=null}={}){const base=ctx&&typeof ctx==='object'?ctx:{};const map=new Map(Array.isArray(quotes)?quotes:[]);
  const quoteOf=s=>{const q=map.get(s);return q&&!q.missing?q:null;};
  return run(text,{...base,live:quoteOf,liveWhy:s=>map.get(s)?.missing??why??null,...(why?{liveStopped:why}:{})});}
// exec(kind, payload) for a context built in this process (tests; the worker builds its own).
const localExec=ctx=>async(kind,payload)=>kind==='plan'?planStep(payload.text,ctx):finalStep(payload.text,ctx,payload);
const CODES={ORDER:'LIVE_STOPPED_BY_ORDER',RATE_LIMITED:'LIVE_RATE_LIMITED',FAILURES:'LIVE_READS_FAILED',CANCELLED:'LIVE_CANCELLED',WAIT:'LIVE_WAIT_SPENT'};
// One script: the plan, the bounds, the reads (within the run's wait budget), the final pass. orderSending(): while an
// order is being sent a script waits before each pass, within the same budget.
async function runWith(text,exec,{readLive,runState=newRun(),orderSending=()=>false,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),cancelled=null}={}){
  const mine=()=>{try{return Boolean(cancelled?.());}catch{return true;}};const CUT={lines:[],coverage:[],live:null,stopped:{code:'SCRIPT_CANCELLED',line:null,detail:null,words:'the script was stopped before it finished'}};
  const pause=async()=>{const start=clock();while(orderSending()&&clock()-start<runState.waitLeft&&!runState.cancelled?.()&&!mine())await sleep(WAIT_STEP_MS);runState.waitLeft-=clock()-start;};
  await pause();if(mine())return CUT;const p=await exec('plan',{text});
  if(p.parseStop)return {lines:[],coverage:[],stopped:p.parseStop,live:null};
  // Pass 2 never runs on an incomplete plan: a first pass that stopped (a bound, which it has twice of, or an error) is the
  // script's answer, with no reads.
  if(p.planStop)return {lines:[],coverage:[],live:{asked:p.asked.length,read:0},stopped:{code:'PLAN_FAILED',line:p.planStop.line,detail:p.planStop.words,
    words:`${p.planStop.line?`line ${p.planStop.line}: `:''}the live prices could not be planned, so none were read (${p.planStop.words})`}};
  if(!p.asked.length){await pause();if(mine())return CUT;const r=await exec('final',{text,quotes:[],why:null});return {...r,live:null};}
  const asked=p.asked;const count={KR:asked.filter(s=>marketOf(s)==='KR').length,US:asked.filter(s=>marketOf(s)==='US').length};
  const limit={KR:Math.min(LIVE_LIMITS.script.KR,runState.left.KR),US:Math.min(LIVE_LIMITS.script.US,runState.left.US)};
  if(count.KR>limit.KR||count.US>limit.US){const left=runState.left.KR<LIVE_LIMITS.script.KR||runState.left.US<LIVE_LIMITS.script.US?` (${runState.left.KR} Korean and ${runState.left.US} U.S. left in this run)`:'';
    return {lines:[],coverage:[],live:{asked:asked.length,read:0},stopped:{code:'LIVE_TOO_MANY',line:null,detail:null,
      words:`live(S) for ${count.KR} Korean and ${count.US} U.S. stocks${p.assumed?' (the plan assumed every candidate, because n or top_cap depends on a live price)':''}; at most ${LIVE_LIMITS.script.KR} Korean and ${LIVE_LIMITS.script.US} U.S. a script${left}: a universe can be reduced with filter, top or bottom before live(S) is used`}};}
  if(mine())return CUT;runState.left.KR-=count.KR;runState.left.US-=count.US;
  if(runState.cancelled?.())runState.stoppedBy??='CANCELLED';if(runState.waitLeft<=0)runState.stoppedBy??='WAIT';
  let quotes=new Map();if(!runState.stoppedBy){const start=clock();
    try{const got=typeof readLive==='function'?await readLive(asked,{runState,deadline:clock()+Math.min(READ_MS,runState.waitLeft),cancelled:mine}):null;if(got instanceof Map)quotes=got;}catch{quotes=new Map();}
    runState.waitLeft-=clock()-start;}
  const why=runState.stoppedBy?STOPPED[runState.stoppedBy]??null:null;
  await pause();if(mine())return CUT;const r=await exec('final',{text,quotes:[...quotes.entries()],why});
  return {...r,live:{asked:asked.length,read:asked.filter(s=>{const q=quotes.get(s);return q&&!q.missing;}).length,...(why?{stopped:{code:CODES[runState.stoppedBy],words:why}}:{})}};}
async function runScreen(text,ctx,opts={}){return runWith(text,localExec(ctx),opts);}
// A run of several scripts sharing one live bound and one wait budget (a scout run, a review): the caller opens it; no
// caller passes a state. exec runs the two passes (the app's is the worker); finish(missing) records the symbols named
// without history for the next night.
function openRun({readLive,exec,finish=null,orderSending,cancelled}){const runState=newRun();if(typeof cancelled==='function')runState.cancelled=cancelled;
  // An engine that fails or takes too long is the script's answer, in the app's own words; the run goes on.
  return async(text,{cancelled=null}={})=>{const r=await runWith(text,exec,{readLive,runState,orderSending,cancelled}).catch(error=>({lines:[],coverage:[],live:null,stopped:{code:error?.code==='SCREEN_ENGINE_TIMEOUT'?'SCREEN_ENGINE_TIMEOUT':'SCREEN_ENGINE_FAILED',line:null,detail:null,
      words:error?.code==='SCREEN_ENGINE_TIMEOUT'?'the script could not be run: the screening engine took too long':'the script could not be run: the screening engine did not answer'}}));if(Array.isArray(r.missing)&&typeof finish==='function'){try{finish(r.missing);}catch{}}const {missing:_,...rest}=r;return rest;};}
// deps: {request(operation, payload): Promise, allowed(): no order being sent or cancelled and nothing queued,
// orderSending(): an engine is sending, sessionOpen(market, t), clock, sleep(ms)}.
function makeLiveReader({request,allowed,orderSending,sessionOpen,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){const cache=new Map();let inflight=null,inflightAt=0;
  const keep=(s,q)=>{cache.set(s,q);return q;};
  const readTime=t=>{const now=clock();return Number.isFinite(t)&&t<=now&&t>=now-CACHE_MS?t:now;};
  const quoteOf=(market,price,readAt,volume)=>{if(!(typeof price==='number'&&Number.isFinite(price)&&price>0))return null;const open=Boolean(sessionOpen?.(market,readAt));
    if(open&&market==='KR'&&!(typeof volume==='number'&&volume>0))return {missing:'no trade yet today'};return {price,readAt,closed:!open};};
  return async(symbols,{runState=newRun(),deadline=clock()+READ_MS,cancelled=null}={})=>{const out=new Map();const mine=()=>{try{return Boolean(cancelled?.());}catch{return true;}};
    // A request left over from an earlier script (it timed out) is awaited, up to this script's bound, before any other.
    // The wait ends with the queue's own timeout: a request older than that is treated as gone.
    if(inflight&&clock()-inflightAt<QUEUE_TIMEOUT_MS){const until=Math.min(deadline,inflightAt+QUEUE_TIMEOUT_MS);await Promise.race([inflight,new Promise(r=>setTimeout(r,Math.max(0,until-clock())).unref?.())]);}
    if(inflight&&clock()-inflightAt>=QUEUE_TIMEOUT_MS)inflight=null;
    const need=[];for(const s of symbols){const c=cache.get(s);if(c&&clock()-c.readAt<CACHE_MS)out.set(s,c);else if(KR_CODE.test(s)||US_CODE.test(s))need.push(s);}
    const kr=need.filter(s=>marketOf(s)==='KR'),us=need.filter(s=>marketOf(s)==='US');
    const batches=[];for(let i=0;i<kr.length;i+=BATCH)batches.push({op:'quotes-multi',payload:{symbols:kr.slice(i,i+BATCH)}});for(const s of us)batches.push({op:'us-quote',payload:{symbol:s}});
    for(const b of batches){
      if(runState.stoppedBy||mine())break;
      let go=false;for(;;){if(mine())break;if(runState.cancelled?.()){runState.stoppedBy='CANCELLED';break;}if(orderSending()){runState.stoppedBy='ORDER';break;}if(clock()>=deadline)break;if(allowed()){go=true;break;}await sleep(WAIT_STEP_MS);}
      if(!go)break;
      const sent=Promise.resolve().then(()=>request(b.op,b.payload));const tracked=sent.then(()=>{},()=>{}).finally(()=>{if(inflight===tracked)inflight=null;});inflight=tracked;inflightAt=clock();
      let res;try{res=await Promise.race([sent,new Promise((_,reject)=>setTimeout(()=>reject(new Error('TIMEOUT')),Math.max(0,deadline-clock())).unref?.())]);}
      catch(error){const code=error?.code??error?.message;const why=code==='TIMEOUT'?'the read took too long':'the read failed';
        for(const sym of b.op==='quotes-multi'?b.payload.symbols:[b.payload.symbol])if(!out.has(sym))out.set(sym,{missing:why});
        if(code==='RATE_LIMITED')runState.stoppedBy='RATE_LIMITED';else if(++runState.failedInRow>=3)runState.stoppedBy='FAILURES';continue;}
      runState.failedInRow=0;
      if(b.op==='quotes-multi'){for(const r of Array.isArray(res)?res:[]){if(!b.payload.symbols.includes(r?.symbol))continue;const q=quoteOf('KR',r.price,readTime(r.readAt),r.volume);if(q?.missing)out.set(r.symbol,q);else if(q)out.set(r.symbol,keep(r.symbol,q));}}
      else{const s=b.payload.symbol;const q=res&&res.symbol===s?quoteOf('US',res.price,readTime(res.retrievedAt),null):null;if(q)out.set(s,keep(s,q));}}
    return out;};}
// A review's live() reader (S4): a quote from the review's own context counts when it is fresh by the app's own rule (not
// stale, a price, read at most 90 s ago, its session open); the rest go through readLive. A dry run reads nothing: the
// rest come back missing.
const REVIEW_QUOTE_MS=90000;
function reviewReader({quotes=[],dryRun=false,sessionOpen,readLive,clock=Date.now}){return async(symbols,opts)=>{const out=new Map();const rest=[];const now=clock();
  for(const s of symbols){const q=(Array.isArray(quotes)?quotes:[]).find(x=>x?.symbol===s);const at=q?.timestamp??q?.retrievedAt;const market=String(s).includes(':')?'US':'KR';
    let open=false;try{open=Boolean(sessionOpen?.(market,now));}catch{open=false;}
    if(q&&!q.stale&&q.price>0&&Number.isFinite(at)&&now-at>=0&&now-at<=REVIEW_QUOTE_MS&&open)out.set(s,{price:q.price,readAt:at,closed:false});else rest.push(s);}
  if(rest.length){if(dryRun||typeof readLive!=='function')for(const s of rest)out.set(s,{missing:dryRun?'no live price (dry run)':'no live price'});else{if(opts?.cancelled?.())return out;const more=await readLive(rest,opts);if(more instanceof Map)for(const [k,v] of more)out.set(k,v);}}
  return out;};}
module.exports={reviewReader,REVIEW_QUOTE_MS,runScreen,runWith,planStep,finalStep,localExec,openRun,RUN_WAIT_MS,makeLiveReader,newRun,writtenCodes,usesLive,LIVE_LIMITS,READ_MS,CACHE_MS,BATCH,STOPPED,QUEUE_TIMEOUT_MS};
