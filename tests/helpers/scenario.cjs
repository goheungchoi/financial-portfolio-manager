// M-7 (multi-order, artifacts/reviews/2026-11-16-multi-order/m7-plan.md section 1): an injected review through the real
// AI client. The scenario's answers are what the model would return; a fake network gives them to the real OpenAI client
// (AiClient.decide), so the request, validateDecision with its further orders, the correction round, the app's checks,
// the batch on the mock KIS, the record and the readers are the app's own. Nothing reaches a real service.
//
// A scenario is strict: a key the runner does not know, anywhere, fails the run (so nothing is silently ignored).
//   name           text
//   description    text (optional)
//   account        {kr:{cash, settledCash?, holdings?:[{symbol, quantity, price}]}, us?:{cash, holdings?, fx?},
//                  prices:{symbol: price}}: Korean symbols are six digits, U.S. ones EXCH:TICKER (NASD:AAPL).
//   config         {ordersPerReview: 1-22, scope?: "kr" (default) | "us" | "both", severalOpenOrders?: true (default) |
//                  false, lossAction?, maxAutoOrdersPerDay?}. The funding regime is always the app's (unknown): a U.S.
//                  buy is counted against Korean won cash at the rate plus 2% (the usFunding option was removed with
//                  the U.S. buy block, 2026-11-19). On OpenAI every model's ceiling is 1, so the runner sets n
//                  from ordersPerReview (1 when the switch is off); the ceiling is tested in more-orders-format and
//                  orders-setting.
//   broker         [{op, call, fault}] (optional): the mock KIS fails the call-th call (1 = the first, counted over the
//                  whole scenario) of op, one of prepare-order | place-order | revise-order | orders, with fault: "lost"
//                  (sent, reply lost), "lost-unplaced" (reply lost, not placed), "not-sent" (KIS's request limit),
//                  "session-closed", {"reject": "<KIS code>"} or {"fail": "<APP_CODE>"} (that call throws the code).
//   marketClosed   true (optional): the Korean market is closed from the start.
//   One review:    answers [answer, ...] and expect {...} at the top level (as in the first scenarios), or
//   several steps: steps [step, ...] instead, each one of:
//     {"review": {"answers": [...], "during"?: [{"before": k, "event": E}], "expect"?: {...}}}: a review; during its
//        batch, before the k-th order in send order (1-based), the event E: "severalOpenOff" (you turn the switch
//        off), "settingSaved" (you save a setting), "batchLimitPassed" (the clock passes the 5-minute limit) or
//        "lossBreach" (the next reading shows the daily loss limit reached in Korea).
//     {"fill": {"symbol": S, "quantity"?: q, "price"?: p}}: KIS fills the latest open order of S (all, or q shares),
//        then one reading (the engines read the order history).
//     {"fills": [{"symbol", "quantity"?, "price"?}, ...]}: several fills, then one reading.
//     {"userOrder": {"symbol", "side", "quantity", "price"}}: your own order appears in KIS, then one reading.
//     {"marketClosed": true | false}: the Korean market closes or opens.
//     {"wait": {"minutes": m}}: time passes for the review clock (the last review ran m minutes earlier).
//     {"check": {"expect": {...}}}: the expect fields, checked at that point.
//   An answer is the decision JSON as the model returns it (tests/fixtures/m7/TEMPLATE.json).
//   expect (each field optional; any other field fails):
//     requests      number: decision requests the review sent to the AI (2 with a correction round).
//     sent          ["Buy 005930", ...]: exactly the orders that reached KIS so far, in send order (both markets).
//     first         {action, symbol?, withheldKind?, notePrefix?}: the latest review's first order: its action and symbol
//                   (the held-back symbol if held back), the kind it was held back for (plan, reversal, permission,
//                   open-order, ...), the start of its execution note.
//     orders        [{item, class?, code?, notePrefix?, sent?}]: exactly the latest review's further order rows, in item
//                   order: outcome class (order | stop | unknown) and code, the start of the note, whether it reached KIS
//                   (and is not Rejected, Uncertain or Submitting).
//     withheld      [{item, kind}]: exactly the further orders the checks held back (kind open-order is D8).
//     reviewFailed  true | false: the latest review failed (an error the app does not know).
//     followUps     number: follow-up reviews asked for so far.
//     pending       ["Buy 005930", ...]: the pending decisions open now (any order).
//     journalTitle  text: the Journal's title for the latest review.
//     openOrders    [{symbol, side, status, quantity?, filled?}]: exactly the app's open orders now (Submitting, Uncertain,
//                   Accepted, Partially filled, Cancellation uncertain), sorted by symbol then side.
//     counted       [{symbol, side, quantity, fullQuantity?}]: exactly the open orders the engines count in their limits
//                   and sums now (pendingOrders; an unclear order counts in full), sorted by symbol then side.
//     deferred      null | ["Buy 035720", ...]: what a scheduled review would wait for now (none: null).
const assert=require('node:assert/strict');const path=require('node:path');
const {MockKis}=require('./mock-kis.cjs');const {appHarness}=require('./app-harness.cjs');
const EXPECT=['requests','sent','first','orders','withheld','reviewFailed','followUps','pending','journalTitle','openOrders','counted','deferred','forms','maxItems'];
const MODELS=['gpt','claude-opus-5-5'];
const KEYS={top:['name','description','account','config','answers','broker','marketClosed','expect','steps'],account:['kr','us','prices'],market:['cash','settledCash','holdings','fx'],
  config:['ordersPerReview','model','scope','severalOpenOrders','lossAction','maxAutoOrdersPerDay'],broker:['op','call','fault'],expect:EXPECT,first:['action','symbol','withheldKind','notePrefix'],
  order:['item','class','code','notePrefix','sent'],withheld:['item','kind'],step:['review','fill','fills','userOrder','marketClosed','wait','check'],review:['answers','during','expect'],during:['before','event'],
  fill:['symbol','quantity','price'],userOrder:['symbol','side','quantity','price'],wait:['minutes'],check:['expect'],open:['symbol','side','status','quantity','filled'],counted:['symbol','side','quantity','fullQuantity']};
const OPS=['prepare-order','place-order','revise-order','orders'],FAULTS=['lost','lost-unplaced','not-sent','session-closed'],EVENTS=['severalOpenOff','settingSaved','batchLimitPassed','lossBreach'],SCOPES={kr:'kis',us:'us',both:'both'};
function strict(obj,allowed,where){if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error(`${where}: not an object`);const extra=Object.keys(obj).filter(k=>!allowed.includes(k));if(extra.length)throw new Error(`${where}: unknown field${extra.length>1?'s':''} ${extra.join(', ')}`);}
function validExpect(e,where){strict(e,KEYS.expect,where);if(e.first)strict(e.first,KEYS.first,where+'.first');
  for(const [i,o] of (e.orders??[]).entries())strict(o,KEYS.order,`${where}.orders[${i}]`);for(const [i,w] of (e.withheld??[]).entries())strict(w,KEYS.withheld,`${where}.withheld[${i}]`);
  for(const [i,o] of (e.openOrders??[]).entries())strict(o,KEYS.open,`${where}.openOrders[${i}]`);for(const [i,o] of (e.counted??[]).entries())strict(o,KEYS.counted,`${where}.counted[${i}]`);
  if('deferred' in e&&e.deferred!==null&&!Array.isArray(e.deferred))throw new Error(`${where}.deferred: null or a list`);}
function validate(s){strict(s,KEYS.top,'scenario');if(typeof s.name!=='string'||!s.name)throw new Error('scenario: name is required');
  strict(s.account,KEYS.account,'account');strict(s.account.kr,KEYS.market,'account.kr');if(s.account.us)strict(s.account.us,KEYS.market,'account.us');
  strict(s.config,KEYS.config,'config');if(!Number.isInteger(s.config.ordersPerReview)||s.config.ordersPerReview<1||s.config.ordersPerReview>22)throw new Error('config.ordersPerReview: 1 to 22');
  if('scope' in s.config&&!(s.config.scope in SCOPES))throw new Error('config.scope: one of kr, us, both');
  if('model' in s.config&&!MODELS.includes(s.config.model))throw new Error(`config.model: one of ${MODELS.join(', ')}`);
  for(const [i,b] of (s.broker??[]).entries()){strict(b,KEYS.broker,`broker[${i}]`);if(!OPS.includes(b.op))throw new Error(`broker[${i}].op: one of ${OPS.join(', ')}`);if(!Number.isInteger(b.call)||b.call<1)throw new Error(`broker[${i}].call: 1 or more`);
    if(!(FAULTS.includes(b.fault)||b.fault&&typeof b.fault==='object'&&(Object.keys(b.fault).join()==='reject'||Object.keys(b.fault).join()==='fail')))throw new Error(`broker[${i}].fault: one of ${FAULTS.join(', ')}, {reject}, {fail}`);}
  if(s.steps){if('answers' in s||'expect' in s)throw new Error('scenario: steps replace the top-level answers and expect');if(!Array.isArray(s.steps)||!s.steps.length)throw new Error('steps: at least one');
    for(const [i,st] of s.steps.entries()){strict(st,KEYS.step,`steps[${i}]`);const kinds=Object.keys(st);if(kinds.length!==1)throw new Error(`steps[${i}]: exactly one of ${KEYS.step.join(', ')}`);const w=`steps[${i}].${kinds[0]}`;
      if(st.review){strict(st.review,KEYS.review,w);if(!Array.isArray(st.review.answers)||!st.review.answers.length)throw new Error(`${w}.answers: at least one`);
        for(const [j,d] of (st.review.during??[]).entries()){strict(d,KEYS.during,`${w}.during[${j}]`);if(!Number.isInteger(d.before)||d.before<1)throw new Error(`${w}.during[${j}].before: 1 or more`);if(!EVENTS.includes(d.event))throw new Error(`${w}.during[${j}].event: one of ${EVENTS.join(', ')}`);}
        if(st.review.expect)validExpect(st.review.expect,w+'.expect');}
      if(st.fill)strict(st.fill,KEYS.fill,w);if(st.fills){if(!Array.isArray(st.fills)||!st.fills.length)throw new Error(`${w}: at least one`);st.fills.forEach((f,j)=>strict(f,KEYS.fill,`${w}[${j}]`));}
      if(st.userOrder)strict(st.userOrder,KEYS.userOrder,w);if(st.wait){strict(st.wait,KEYS.wait,w);if(!(st.wait.minutes>0))throw new Error(`${w}.minutes: more than 0`);}
      if('marketClosed' in st&&typeof st.marketClosed!=='boolean')throw new Error(`${w}: true or false`);if(st.check){strict(st.check,KEYS.check,w);validExpect(st.check.expect,w+'.expect');}}}
  else{if(!Array.isArray(s.answers)||!s.answers.length)throw new Error('answers: at least one');validExpect(s.expect,'expect');}}
// The model's answer as OpenAI's Responses API returns it.
const responseOf=answer=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:1000,output_tokens:400},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}]}));
const marketOf=symbol=>symbol.includes(':')?'US':'KR';
function setup(s){const {AiClient}=require('../../electron/ai-client.cjs');
  const m=new MockKis({kr:s.account.kr,us:s.account.us??{cash:5000},prices:s.account.prices});
  const byOp={};for(const b of s.broker??[])(byOp[b.op]??=[]).push(b);
  for(const [op,list] of Object.entries(byOp)){const last=Math.max(...list.map(b=>b.call));for(let c=1;c<=last;c++){const b=list.find(x=>x.call===c);m.fault(op,b?b.fault:null);}}
  if(s.marketClosed)m.sessionOpen.KR=false;
  const h=appHarness({mock:m}).enable();const {ordersPerReview,model='gpt',severalOpenOrders=true,scope='kr',...rest}=s.config;const a=h.automation({...rest,scope:SCOPES[scope]});
  const claude=model==='claude-opus-5-5';
  // The U.S. quotes the review gets: every U.S. symbol the scenario prices (main.cjs: holdings and the watchlist).
  a.refreshUS=async()=>m.request('US','context',{symbols:Object.keys(s.account.prices).filter(x=>x.includes(':'))});
  if(severalOpenOrders===false){for(const e of [h.kr,h.us]){e.severalOpenFixed=false;e.severalOpenSetting=()=>a.config.severalOpenOrders===true;}a.config={...a.config,severalOpenOrders:false};}
  else for(const e of [h.kr,h.us]){e.severalOpenFixed=false;e.severalOpenSetting=()=>a.config.severalOpenOrders===true;}
  if(severalOpenOrders!==false)a.config={...a.config,severalOpenOrders:true};
  a.config={...a.config,ordersPerReview};
  const run={s,m,h,a,followUps:[],bodies:[],answers:[],reviews:0,lastRequests:0};a.requestReview=(...x)=>run.followUps.push(x);
  let client;
  if(claude){
    // Claude Opus 5.5 trades: the app's own n (the switch, the model's ceiling of 22, the stocks shown), the enforced
    // form with the moreOrders text part, the size guard and the text form. The Claude gates (a completed dry run, the
    // Anthropic key and consent) are passed here; they are tested in claude-trading and provider-b1.
    const agentModel=a.agentModel.bind(a);a.agentModel=agent=>agent==='trading'?{...agentModel(agent),openaiModel:'claude-opus-5-5',reasoningEffort:'high'}:agentModel(agent);
    a.claudeTradingRefusal=()=>null;a.missingKey=()=>null;a.config={...a.config,shareKisWithAnthropic:true};
    const {AnthropicClient}=require('../../electron/anthropic-client.cjs');const {adapt}=require('../fixtures/claude-flat.cjs');
    client=new AnthropicClient('sk-ant-api03-'+'k'.repeat(40),async(url,o)=>{const body=JSON.parse(o.body);run.bodies.push(body);run.lastRequests++;const next=run.answers.shift();if(!next)throw new Error('SCENARIO_NO_MORE_ANSWERS');
      // The model's answer: the scenario's decision, in the form the request asked for (the enforced flat form, or text).
      const reply={id:'msg_fixture',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'text',text:JSON.stringify(next)}],stop_reason:'end_turn',usage:{input_tokens:1000,output_tokens:400},input_transformations:[]};
      return new Response(JSON.stringify(adapt(reply,body)),{status:200,headers:{'content-type':'application/json'}});});}
  else{
    // OpenAI: every model's ceiling is 1, so ordersPerReview stands in for it; the switch and the stocks a review is shown
    // (20 per market) apply as in the app.
    a.ordersFor=()=>a.severalOpenNow()?Math.min(ordersPerReview,a.universeLimit?.()??ordersPerReview):1;
    client=new AiClient('sk-fixture-key-123',async(url,o)=>{run.bodies.push(JSON.parse(o.body));run.lastRequests++;const next=run.answers.shift();if(!next)throw new Error('SCENARIO_NO_MORE_ANSWERS');return responseOf(next);});}
  const provider=a.provider;a.provider={...provider,request:async(op,payload)=>op==='decision'?client.decide(payload.context,payload.options):provider.request(op,payload)};
  return run;}
const reading=async run=>{run.h.refresh();for(const market of ['KR','US'])await run.h.reconcile(market);};
async function review(run,{answers,during=[]}){const {a}=run;run.answers=[...answers];run.lastRequests=0;run.reviews++;
  const saved={batchLimitMs:a.batchLimitMs,emergencyState:a.emergencyState};
  a.beforeBatchOrder=k=>{for(const d of during.filter(x=>x.before===k)){
    if(d.event==='severalOpenOff')a.config={...a.config,severalOpenOrders:false};
    else if(d.event==='settingSaved')a.revision=(a.revision??0)+1;
    else if(d.event==='batchLimitPassed')a.batchLimitMs=-1;
    else if(d.event==='lossBreach'){const s=saved.emergencyState.bind(a);a.emergencyState=()=>({...s(),active:true,activeMarkets:['KR']});}}};
  let error=null;try{await a.review('User request');}catch(e){error=e;}
  a.beforeBatchOrder=null;a.batchLimitMs=saved.batchLimitMs;a.emergencyState=saved.emergencyState;run.error=error;}
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
const bySymbol=(x,y)=>x.symbol<y.symbol?-1:x.symbol>y.symbol?1:x.side<y.side?-1:x.side>y.side?1:0;
async function check(run,e,where){const {m,h,a}=run,at=k=>`${run.s.name}: ${where}.${k}`;
  const row=h.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get(),record=row?JSON.parse(row.payload):null;
  if('requests' in e)assert.equal(run.lastRequests,e.requests,at('requests'));
  if('sent' in e)assert.deepEqual([...m.book.KR,...m.book.US].filter(x=>x.kind==='order'&&x.by!=='user').sort((x,y)=>x.at-y.at||0).map(x=>`${x.side} ${x.symbol}`),e.sent,at('sent'));
  if('reviewFailed' in e)assert.equal(a.lastError==='REVIEW_FAILED',e.reviewFailed,at('reviewFailed')+` (lastError ${a.lastError})`);
  if('followUps' in e)assert.equal(run.followUps.length,e.followUps,at('followUps'));
  if('first' in e){const d=record?.decision??{},f=e.first;assert.equal(d.action,f.action,at('first.action'));if('symbol' in f)assert.equal(d.withheld?.symbol??d.symbol,f.symbol,at('first.symbol'));
    if('withheldKind' in f)assert.equal(d.withheld?.kind??(d.withheld?'plan':null),f.withheldKind,at('first.withheldKind'));if('notePrefix' in f)assert.ok(String(record?.executionNote??'').startsWith(f.notePrefix),at('first.notePrefix')+`: ${record?.executionNote}`);}
  if('orders' in e){const rows=record?.orders??[];assert.deepEqual(rows.map(x=>x.item),e.orders.map(x=>x.item),at('orders (items)'));
    for(const want of e.orders){const got=rows.find(x=>x.item===want.item);if('class' in want)assert.equal(got.outcome?.class,want.class,at(`orders[item ${want.item}].class`));if('code' in want)assert.equal(got.outcome?.code,want.code,at(`orders[item ${want.item}].code`));
      if('notePrefix' in want)assert.ok(String(got.executionNote??'').startsWith(want.notePrefix),at(`orders[item ${want.item}].notePrefix`)+`: ${got.executionNote}`);
      if('sent' in want)assert.equal(Boolean(got.orderId)&&!['Rejected','Uncertain','Submitting'].includes(got.orderOutcome?.status),want.sent,at(`orders[item ${want.item}].sent`));}}
  if('withheld' in e)assert.deepEqual((record?.decision?.moreWithheld??[]).map(w=>({item:w.item,kind:w.kind})),e.withheld,at('withheld'));
  if('pending' in e)assert.deepEqual(h.db.prepare("SELECT payload FROM pending_decisions WHERE status='pending'").all().map(x=>JSON.parse(x.payload)).map(p=>`${p.action} ${p.symbol}`).sort(),[...e.pending].sort(),at('pending'));
  if('journalTitle' in e){const J=await import(require('node:url').pathToFileURL(path.join(__dirname,'../../src/journalTabs.ts')).href);const w=a.reviewHistory()[0]??{};
    const t=J.batchTitle(w)??(w.decision?.action==='Hold'?'No trade':`${w.decision?.symbol}${w.decision?.quantity>0?` ×${w.decision.quantity}`:''}`);assert.equal(t,e.journalTitle,at('journalTitle'));}
  if('openOrders' in e){const got=[...h.kr.orders(),...h.us.orders()].filter(o=>OPEN.includes(o.status)).map(o=>({symbol:o.symbol,side:o.side,status:o.status,quantity:o.quantity,filled:o.filled??0})).sort(bySymbol);
    const want=[...e.openOrders].sort(bySymbol);assert.deepEqual(got.map(o=>[o.symbol,o.side,o.status]),want.map(o=>[o.symbol,o.side,o.status]),at('openOrders'));
    want.forEach((w,i)=>{if('quantity' in w)assert.equal(got[i].quantity,w.quantity,at(`openOrders[${w.symbol}].quantity`));if('filled' in w)assert.equal(got[i].filled,w.filled,at(`openOrders[${w.symbol}].filled`));});}
  if('counted' in e){const got=[...h.kr.pendingOrders(null,null),...h.us.pendingOrders(null,null)].map(o=>({symbol:o.symbol,side:o.side,quantity:o.quantity,fullQuantity:o.fullQuantity})).sort(bySymbol);
    const want=[...e.counted].sort(bySymbol);assert.deepEqual(got.map(o=>[o.symbol,o.side,o.quantity]),want.map(o=>[o.symbol,o.side,o.quantity]),at('counted'));
    want.forEach((w,i)=>{if('fullQuantity' in w)assert.equal(got[i].fullQuantity,w.fullQuantity,at(`counted[${w.symbol}].fullQuantity`));});}
  // forms: the answer form of each of the latest review's requests: "enforced" (Claude's flat form), "text" (Claude's text
  // form) or "schema" (OpenAI's strict schema). maxItems: the further orders the latest review's first request asked for
  // (null when it asked for none).
  const mine=run.bodies.slice(run.bodies.length-run.lastRequests);
  if('forms' in e)assert.deepEqual(mine.map(b=>b.output_config?.format?'enforced':b.text?.format?'schema':'text'),e.forms,at('forms'));
  if('maxItems' in e){const b=mine[0];const n=b?.text?.format?.schema?.properties?.moreOrders?.maxItems??(()=>{const t=JSON.stringify(b?.system??'');const m=/a list of at most (\d+) further orders/.exec(t);return m?Number(m[1]):null;})();assert.equal(n,e.maxItems,at('maxItems'));}
  if('deferred' in e){const d=a.deferForPendingOrder();assert.deepEqual(d?d.orders.map(o=>`${o.side} ${o.symbol}`).sort():null,e.deferred===null?null:[...e.deferred].sort(),at('deferred'));}}
const latestOpen=(run,symbol)=>{const rows=run.m.book[marketOf(symbol)].filter(r=>r.symbol===symbol&&r.kind!=='cancel'&&r.remaining>0);const r=rows.at(-1);if(!r)throw new Error(`${run.s.name}: no open KIS order of ${symbol} to fill`);return r;};
async function step(run,st,i){const {m}=run;
  if(st.review){await review(run,st.review);if(st.review.expect)await check(run,st.review.expect,`steps[${i}].review.expect`);}
  else if(st.fill){const r=latestOpen(run,st.fill.symbol);m.fill(marketOf(st.fill.symbol),r.orderId,st.fill.quantity??null,st.fill.price??null);await reading(run);}
  else if(st.fills){for(const f of st.fills){const r=latestOpen(run,f.symbol);m.fill(marketOf(f.symbol),r.orderId,f.quantity??null,f.price??null);}await reading(run);}
  else if(st.userOrder){const u=st.userOrder;m.userOrder(marketOf(u.symbol),{symbol:u.symbol,side:u.side,quantity:u.quantity,orderPrice:u.price});await reading(run);}
  else if('marketClosed' in st)m.sessionOpen.KR=!st.marketClosed;
  else if(st.wait)run.a.lastRun=(run.a.lastRun??Date.now())-st.wait.minutes*60000;
  else if(st.check)await check(run,st.check.expect,`steps[${i}].check.expect`);}
async function runScenario(s){validate(s);const run=setup(s);
  if(s.steps){for(const [i,st] of s.steps.entries())await step(run,st,i);}else await review(run,{answers:s.answers});
  return run;}
// Every expect field the scenario gives, checked; a failure names the scenario and the field.
async function checkScenario(s){validate(s);const run=setup(s);
  if(s.steps){for(const [i,st] of s.steps.entries())await step(run,st,i);}
  else{await review(run,{answers:s.answers});await check(run,s.expect,'expect');}
  return run;}
module.exports={runScenario,checkScenario,validate,KEYS,EVENTS};
