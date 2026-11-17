// M-6 part 0 (a finding in released code, the M-6 plan note section 4): the Journal's pill and Order fact said "Order
// submitted" for every review whose order had an id, including an order refused before it left the app (KIS's request
// limit, an expired check: Rejected ORDER_NOT_SENT, saved with an id) and one KIS rejected. The review record now keeps
// the engine's status and reason of its order (orderOutcome), and the pill reads it; an older record falls back on its note.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const load=()=>import(require('node:url').pathToFileURL(path.join(__dirname,'../src/journalTabs.ts')).href);
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
test('the pill from the order\'s status and reason',async()=>{const J=await load();const at=(status,reason=null)=>J.orderPill({orderId:'o',orderOutcome:{status,reason}});
  assert.equal(at('Accepted'),'Order sent');assert.equal(at('Filled'),'Order sent');assert.equal(at('Partially filled'),'Order sent');
  assert.equal(at('Rejected','ORDER_NOT_SENT'),'Not sent');assert.equal(at('Rejected','SESSION_CLOSED'),'Not sent');assert.equal(at('Rejected','CREDIT_PATH_UNVERIFIED'),'Not sent');
  assert.equal(at('Rejected','BROKER_REJECTED'),'Rejected by KIS');assert.equal(at('Uncertain','ORDER_UNCERTAIN'),'Unclear: check KIS');assert.equal(at('Submitting'),'Unclear: check KIS');
  assert.equal(J.orderPill({proposalId:'p'}),'Proposal created');assert.equal(J.orderPill({}),'No order');
  // A record from before the fix: its note decides.
  assert.equal(J.orderPill({orderId:'o',executionNote:'Not sent: KIS\'s request limit was reached just before Buy 1 005930 went out, so nothing reached KIS.'}),'Not sent');
  assert.equal(J.orderPill({orderId:'o',executionNote:null}),'Order sent');
  assert.deepEqual(J.decisionFacts({orderId:'o',orderOutcome:{status:'Rejected',reason:'ORDER_NOT_SENT'},decision:{plan:null}})[0],{label:'Order',value:'Not sent'});
});
const review=async place=>{const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});if(place)m.fault('place-order',place);
  const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};h.decide({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'one'});
  await a.review('User request').catch(()=>{});return JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);};
test('through the app: a review whose order was refused by the request limit records it and reads "Not sent"; a sent one "Order sent"',async()=>{
  const J=await load();
  {const r=await review('not-sent');assert.ok(r.orderId,'the engine saved the order with an id');assert.deepEqual(r.orderOutcome,{status:'Rejected',reason:'ORDER_NOT_SENT'});assert.equal(J.orderPill(r),'Not sent');}
  {const r=await review({reject:'APBK0919'});assert.deepEqual(r.orderOutcome,{status:'Rejected',reason:'BROKER_REJECTED'});assert.equal(J.orderPill(r),'Rejected by KIS');}
  {const r=await review('lost');assert.equal(r.orderOutcome.status,'Uncertain');assert.equal(J.orderPill(r),'Unclear: check KIS');}
  {const r=await review(null);assert.equal(r.orderOutcome.status,'Accepted');assert.equal(J.orderPill(r),'Order sent');}
});
test('F1: an order unclear when recorded and later linked by you: the review\'s outcome follows it and the pill reads "Order sent"',async()=>{
  const J=await load();const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});m.fault('place-order','lost');
  const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};h.decide({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'one'});
  await a.review('User request').catch(()=>{});
  const stored=()=>JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);
  assert.equal(J.orderPill(a.reviewHistory()[0]),'Unclear: check KIS');
  // The lost reply left an order at KIS: you link it by its number (the engine's own path).
  const row=m.book.KR.find(x=>x.kind==='order');const order=h.kr.orders().find(o=>o.symbol==='005930');
  await h.kr.linkUncertain(order.id,row.orderId,'LINK BROKER ORDER').catch(()=>{});
  assert.notEqual(h.kr.orders().find(o=>o.id===order.id).status,'Uncertain','linked');
  const seen=a.reviewHistory()[0];assert.equal(J.orderPill(seen),'Order sent');assert.equal(stored().orderOutcome.status,seen.orderOutcome.status,'written back');
  // An order whose outcome is settled is never rewritten.
  const before=h.db.prepare('SELECT total_changes() AS n').get().n;a.reviewHistory();assert.equal(h.db.prepare('SELECT total_changes() AS n').get().n,before);
});
// F3 (planner, after the M-7 (d) desktop run): a further order with no order id reads its recorded outcome. A proposal
// refused for capacity (proposal saved, no order) read "Proposal created" beside "Not sent: ... INSUFFICIENT_CAPACITY".
test('F3: a further order without an order id: PROPOSED reads "Proposal created", NOT_PROPOSED "No order", any other recorded code "Not sent"; the note is the fallback',async()=>{const J=await load();
  const row=(code,extra={})=>J.orderPill({proposalId:'p',orderId:null,outcome:code?{class:'order',code}:null,...extra});
  assert.equal(row('PROPOSED'),'Proposal created','waiting for your approval');
  for(const code of ['INSUFFICIENT_CAPACITY','APPROVAL_REQUIRED','BLOCKED','RATE_LIMITED'])assert.equal(row(code),'Not sent',code);
  assert.equal(J.orderPill({proposalId:null,orderId:null,executionNote:'Not proposed: …',outcome:{class:'order',code:'NOT_PROPOSED'}}),'No order','the engine made no proposal');
  assert.equal(J.orderPill({proposalId:null,orderId:null,executionNote:'Not sent: Buy 1 005930: the batch limit.',outcome:{class:'stop',code:'BATCH_LIMIT'}}),'Not sent','a stopped order');
  // The first order and older records have no outcome: the note's start, then the proposal.
  assert.equal(row(null,{executionNote:'Not sent: Buy 2 035720: INSUFFICIENT_CAPACITY.'}),'Not sent');assert.equal(row(null),'Proposal created');assert.equal(J.orderPill({}),'No order');
  // An order id: the order's own status, as before (the outcome does not override it).
  assert.equal(J.orderPill({orderId:'o',orderOutcome:{status:'Accepted'},outcome:{class:'order',code:'Accepted'}}),'Order sent');
});
test('F3 on the order-class scenario: the refused order reads "Not sent", the one after it "Order sent"',async()=>{const J=await load();const fs=require('node:fs');
  const {runScenario}=require('./helpers/scenario.cjs');const run=await runScenario(JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/m7/order-class.json'),'utf8')));
  const r=JSON.parse(run.h.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get().payload);
  const rows=require('../electron/review-orders.cjs').ordersOfReview(r);
  assert.deepEqual(rows.map(o=>[o.item,o.symbol,J.orderPill(o)]),[[0,'005930','Order sent'],[1,'035720','Not sent'],[2,'000099','Order sent']]);
  assert.deepEqual(rows[1].outcome,{class:'order',code:'INSUFFICIENT_CAPACITY'},'the window gets the recorded outcome');
});
