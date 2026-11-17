// M-7 (a) (multi-order, artifacts/reviews/2026-11-16-multi-order/m7-plan.md section 1): an injected review through the
// real AI client. The scenario's answers are what the model would return; a fake network gives them to the real OpenAI
// client (AiClient.decide), so the request, validateDecision with its further orders, the correction round, the app's
// checks, the batch on the mock KIS, the record and the readers are the app's own. Nothing reaches a real service.
//
// A scenario is strict: a key the runner does not know, anywhere, fails the run (so nothing is silently ignored).
//   name           text
//   description    text (optional)
//   account        {kr:{cash, settledCash?, holdings?:[{symbol, quantity, price}]}, us?:{cash, holdings?}, prices:{symbol: price}}
//   config         {ordersPerReview: 1-22, severalOpenOrders?: true (default) | false, lossAction?, maxAutoOrdersPerDay?}
//                  On OpenAI every model's ceiling is 1, so the runner sets n from ordersPerReview (1 when the switch
//                  is off); the ceiling itself is tested in tests/more-orders-format.test.cjs and tests/orders-setting.
//   answers        [answer, ...]: one per AI request, in order (the decision request; a correction round's answer next).
//                  An answer is the decision JSON as the model returns it (tests/fixtures/m7/TEMPLATE.json).
//   broker         [{op, call, fault}, ...] (optional): the mock KIS fails the call-th call (1 = the first) of op, one of
//                  prepare-order | place-order | revise-order | orders, with fault: "lost" (sent, reply lost), "lost-unplaced"
//                  (reply lost, not placed), "not-sent" (KIS's request limit), "session-closed", {"reject": "<KIS code>"}
//                  or {"fail": "<APP_CODE>"} (the call throws that code, for example INSUFFICIENT_CAPACITY).
//   marketClosed   true (optional): the Korean market is closed for the review.
//   expect         what the runner checks; each field optional; any other field fails:
//     requests      number: decision requests sent to the AI (2 when a correction round ran).
//     sent          ["Buy 005930", ...]: the orders that reached KIS, in the order they were sent (exactly these).
//     first         {action, symbol?, withheldKind?, notePrefix?}: the recorded first order: its action and symbol, the kind
//                   it was held back for (plan, reversal, permission, open-order, ...), the start of its execution note.
//     orders        [{item, class?, code?, notePrefix?, sent?}]: every further order row of the record, in item order
//                   (exactly these items): its outcome class (order | stop | unknown) and code, the start of its note, and
//                   whether it reached KIS.
//     withheld      [{item, kind}]: every further order held back by the checks (exactly these).
//     reviewFailed  true | false: the review failed (an error the app does not know).
//     followUps     number: follow-up reviews asked for after the batch.
//     pending       ["Buy 005930", ...]: the pending decisions open after the review (any order).
//     journalTitle  text: the Journal's title for the review.
const assert=require('node:assert/strict');const path=require('node:path');
const {MockKis}=require('./mock-kis.cjs');const {appHarness}=require('./app-harness.cjs');
const KEYS={top:['name','description','account','config','answers','broker','marketClosed','expect'],account:['kr','us','prices'],market:['cash','settledCash','holdings'],
  config:['ordersPerReview','severalOpenOrders','lossAction','maxAutoOrdersPerDay'],broker:['op','call','fault'],
  expect:['requests','sent','first','orders','withheld','reviewFailed','followUps','pending','journalTitle'],first:['action','symbol','withheldKind','notePrefix'],
  order:['item','class','code','notePrefix','sent'],withheld:['item','kind']};
const OPS=['prepare-order','place-order','revise-order','orders'],FAULTS=['lost','lost-unplaced','not-sent','session-closed'];
function strict(obj,allowed,where){if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error(`${where}: not an object`);const extra=Object.keys(obj).filter(k=>!allowed.includes(k));if(extra.length)throw new Error(`${where}: unknown field${extra.length>1?'s':''} ${extra.join(', ')}`);}
function validate(s){strict(s,KEYS.top,'scenario');if(typeof s.name!=='string'||!s.name)throw new Error('scenario: name is required');
  strict(s.account,KEYS.account,'account');strict(s.account.kr,KEYS.market,'account.kr');if(s.account.us)strict(s.account.us,KEYS.market,'account.us');
  strict(s.config,KEYS.config,'config');if(!Number.isInteger(s.config.ordersPerReview)||s.config.ordersPerReview<1||s.config.ordersPerReview>22)throw new Error('config.ordersPerReview: 1 to 22');
  if(!Array.isArray(s.answers)||!s.answers.length)throw new Error('answers: at least one');
  for(const [i,b] of (s.broker??[]).entries()){strict(b,KEYS.broker,`broker[${i}]`);if(!OPS.includes(b.op))throw new Error(`broker[${i}].op: one of ${OPS.join(', ')}`);if(!Number.isInteger(b.call)||b.call<1)throw new Error(`broker[${i}].call: 1 or more`);
    if(!(FAULTS.includes(b.fault)||b.fault&&typeof b.fault==='object'&&(Object.keys(b.fault).join()==='reject'||Object.keys(b.fault).join()==='fail')))throw new Error(`broker[${i}].fault: one of ${FAULTS.join(', ')}, {reject}, {fail}`);}
  strict(s.expect,KEYS.expect,'expect');if(s.expect.first)strict(s.expect.first,KEYS.first,'expect.first');
  for(const [i,o] of (s.expect.orders??[]).entries())strict(o,KEYS.order,`expect.orders[${i}]`);for(const [i,w] of (s.expect.withheld??[]).entries())strict(w,KEYS.withheld,`expect.withheld[${i}]`);}
// The model's answer as OpenAI's Responses API returns it.
const responseOf=answer=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:1000,output_tokens:400},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}]}));
async function runScenario(s){validate(s);const {AiClient}=require('../../electron/ai-client.cjs');
  const m=new MockKis({kr:s.account.kr,us:s.account.us??{cash:5000},prices:s.account.prices});
  // The broker's faults, queued so the named call of each operation gets its fault (the calls before it run normally).
  const byOp={};for(const b of s.broker??[])(byOp[b.op]??=[]).push(b);
  for(const [op,list] of Object.entries(byOp)){const last=Math.max(...list.map(b=>b.call));for(let c=1;c<=last;c++){const b=list.find(x=>x.call===c);m.fault(op,b?b.fault:null);}}
  if(s.marketClosed)m.sessionOpen.KR=false;
  const h=appHarness({mock:m}).enable();const {ordersPerReview,severalOpenOrders=true,...rest}=s.config;const a=h.automation(rest);
  if(severalOpenOrders===false){for(const e of [h.kr,h.us]){e.severalOpenFixed=false;e.severalOpenSetting=()=>a.config.severalOpenOrders===true;}a.config={...a.config,severalOpenOrders:false};}
  a.ordersFor=()=>a.severalOpenNow()?ordersPerReview:1;
  const followUps=[];a.requestReview=(...x)=>followUps.push(x);
  // The provider: the real OpenAI client, its network answering from the scenario.
  const answers=[...s.answers],sentBodies=[];
  const client=new AiClient('sk-fixture-key-123',async(url,o)=>{sentBodies.push(JSON.parse(o.body));const next=answers.shift();if(!next)throw new Error('SCENARIO_NO_MORE_ANSWERS');return responseOf(next);});
  const provider=a.provider;a.provider={...provider,request:async(op,payload)=>op==='decision'?client.decide(payload.context,payload.options):provider.request(op,payload)};
  let error=null;try{await a.review('User request');}catch(e){error=e;}
  const row=h.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get();const record=row?JSON.parse(row.payload):null;
  return {s,m,h,a,record,error,sentBodies,followUps,window:a.reviewHistory()[0]??null};}
// Every expect field the scenario gives, checked; a failure names the scenario and the field.
async function checkScenario(s){const r=await runScenario(s),e=s.expect,at=k=>`${s.name}: expect.${k}`;
  if('requests' in e)assert.equal(r.sentBodies.length,e.requests,at('requests'));
  if('sent' in e)assert.deepEqual(r.m.book.KR.concat(r.m.book.US).filter(x=>x.kind==='order').map(x=>`${x.side} ${x.symbol}`),e.sent,at('sent'));
  if('reviewFailed' in e)assert.equal(r.a.lastError==='REVIEW_FAILED',e.reviewFailed,at('reviewFailed')+` (lastError ${r.a.lastError})`);
  if('followUps' in e)assert.equal(r.followUps.length,e.followUps,at('followUps'));
  if('first' in e){const d=r.record?.decision??{},f=e.first;assert.equal(d.action,f.action,at('first.action'));if('symbol' in f)assert.equal(d.withheld?.symbol??d.symbol,f.symbol,at('first.symbol'));
    if('withheldKind' in f)assert.equal(d.withheld?.kind??(d.withheld?'plan':null),f.withheldKind,at('first.withheldKind'));if('notePrefix' in f)assert.ok(String(r.record?.executionNote??'').startsWith(f.notePrefix),at('first.notePrefix')+`: ${r.record?.executionNote}`);}
  if('orders' in e){const rows=r.record?.orders??[];assert.deepEqual(rows.map(x=>x.item),e.orders.map(x=>x.item),at('orders (items)'));
    for(const want of e.orders){const got=rows.find(x=>x.item===want.item);if('class' in want)assert.equal(got.outcome?.class,want.class,at(`orders[item ${want.item}].class`));if('code' in want)assert.equal(got.outcome?.code,want.code,at(`orders[item ${want.item}].code`));
      if('notePrefix' in want)assert.ok(String(got.executionNote??'').startsWith(want.notePrefix),at(`orders[item ${want.item}].notePrefix`)+`: ${got.executionNote}`);
      if('sent' in want)assert.equal(Boolean(got.orderId)&&!['Rejected','Uncertain','Submitting'].includes(got.orderOutcome?.status),want.sent,at(`orders[item ${want.item}].sent`));}}
  if('withheld' in e)assert.deepEqual((r.record?.decision?.moreWithheld??[]).map(w=>({item:w.item,kind:w.kind})),e.withheld,at('withheld'));
  if('pending' in e)assert.deepEqual(r.h.db.prepare("SELECT payload FROM pending_decisions WHERE status='pending'").all().map(x=>JSON.parse(x.payload)).map(p=>`${p.action} ${p.symbol}`).sort(),[...e.pending].sort(),at('pending'));
  if('journalTitle' in e){const J=await import(require('node:url').pathToFileURL(path.join(__dirname,'../../src/journalTabs.ts')).href);const w=r.window??{};
    const t=J.batchTitle(w)??(w.decision?.action==='Hold'?'No trade':`${w.decision?.symbol}${w.decision?.quantity>0?` ×${w.decision.quantity}`:''}`);assert.equal(t,e.journalTitle,at('journalTitle'));}
  return r;}
module.exports={runScenario,checkScenario,validate,KEYS};
