// M-6 part 3 (multi-order, artifacts/reviews/2026-11-16-multi-order/m6-plan.md section 4): every reader of a review
// record sees each of its orders (electron/review-orders.cjs), and a single-order record reads exactly as today.
const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const ROE=require('../electron/review-orders.cjs');
const plan=thesis=>({thesis,stopPrice:1,horizon:'swing'});
const single={id:'r1',timestamp:1,decision:{action:'Buy',symbol:'005930',quantity:2,explanation:'one',plan:plan('A')},proposalId:'p1',orderId:'o1',executionNote:null,contextEvidence:{quote:{symbol:'005930',price:70000}}};
const batch=(first)=>({id:'r2',timestamp:2,decision:{...first,explanation:'three',moreOrders:[{item:1,action:'Buy',symbol:'035720',quantity:3,credit:'none',plan:plan('B')},{item:2,action:'Sell',symbol:'000660',quantity:1,credit:'none',plan:null}]},
  proposalId:first.action==='Hold'?null:'p0',orderId:first.action==='Hold'?null:'o0',executionNote:null,contextEvidence:{quote:{symbol:first.symbol||'005930',price:70000}},
  orders:[{item:1,symbol:'035720',action:'Buy',quantity:3,proposalId:'p1b',orderId:'o1b',executionNote:null,outcome:{class:'order',code:'Accepted'},orderOutcome:{status:'Accepted',reason:null}},
    {item:2,symbol:'000660',action:'Sell',quantity:1,proposalId:null,orderId:null,executionNote:'Not proposed: …',outcome:{class:'order',code:'NOT_PROPOSED'}}]});
test('ordersOfReview: one row for a single trade, none for a Hold; the first and each further order for a batch, each with its own decision',()=>{
  assert.deepEqual(ROE.ordersOfReview(single).map(o=>[o.item,o.symbol,o.orderId]),[[0,'005930','o1']]);
  assert.deepEqual(ROE.ordersOfReview({decision:{action:'Hold'}}),[]);
  const b=ROE.ordersOfReview(batch({action:'Buy',symbol:'005930',quantity:1,plan:plan('A')}));
  assert.deepEqual(b.map(o=>[o.item,o.action,o.symbol]),[[0,'Buy','005930'],[1,'Buy','035720'],[2,'Sell','000660']]);
  assert.equal(b[1].decision.plan.thesis,'B','the further order\'s own plan');
  // The first held back (a Hold): only the further orders.
  assert.deepEqual(ROE.ordersOfReview(batch({action:'Hold',symbol:'',quantity:0})).map(o=>o.item),[1,2]);
});
test('reviewOfOrder: today\'s match on the first order first; a further order matched with its own decision and no borrowed quote',()=>{
  const b=batch({action:'Hold',symbol:'',quantity:0});const reviews=[single,b];
  assert.deepEqual(ROE.reviewOfOrder(reviews,{orderId:'o1'}),{review:single,order:null});
  const m=ROE.reviewOfOrder(reviews,{orderId:'o1b'});assert.equal(m.review.id,'r2');assert.equal(m.order.item,1);
  const f=ROE.furtherEvidence(m.review,m.order);assert.equal(f.decision.plan.thesis,'B');assert.equal(f.decision.explanation,'three');assert.equal(f.evidence.quote,null,'the first order\'s quote is another stock');
  assert.equal(ROE.reviewOfOrder(reviews,{orderId:'nope'}),null);
});
test('Home and runtime state: a single order\'s brief is today\'s; a batch\'s carries each order, sent or not',()=>{
  const {briefReview}=require('../electron/runtime-state.cjs');assert.ok(!('orders' in briefReview(single)));
  assert.deepEqual(briefReview(batch({action:'Buy',symbol:'005930',quantity:1})).orders,[{item:0,action:'Buy',symbol:'005930',quantity:1,sent:true},{item:1,action:'Buy',symbol:'035720',quantity:3,sent:true},{item:2,action:'Sell',symbol:'000660',quantity:1,sent:false}]);
});
test('the Journal: a batch\'s title, filter and Orders fact; a single order reads as today',async()=>{
  const J=await import(require('node:url').pathToFileURL(path.join(__dirname,'../src/journalTabs.ts')).href);
  const allOrders=ROE.ordersOfReview(batch({action:'Hold',symbol:'',quantity:0})).map(({decision:_,...o})=>o);const r={allOrders,decision:{action:'Hold',plan:null}};
  // The batch fixture's first is a plain Hold (the AI's own): no "held back" (F1, scenario p06); with withheld it is.
  assert.equal(J.batchTitle(r),'2 orders');assert.equal(J.batchTitle({...r,decision:{action:'Hold',withheld:{symbol:'005930',quantity:1,reason:'no trade plan'}}}),'2 orders, first held back');
  assert.equal(J.batchTitle({allOrders:allOrders.slice(0,1),decision:{action:'Hold'}}),'1 order');assert.equal(J.batchTitle({decision:{action:'Buy'}}),null);
  assert.equal(J.matchesAction(r,'Buy'),true);assert.equal(J.matchesAction(r,'Sell'),true);assert.equal(J.matchesAction(r,'Hold'),false,'a review that placed orders is not a Hold');
  assert.equal(J.matchesAction({decision:{action:'Hold'}},'Hold'),true,'today');
  assert.deepEqual(J.decisionFacts(r)[0],{label:'Orders',value:'1 of 2 sent'});assert.equal(J.orderPill(allOrders[1]),'No order');
  assert.deepEqual(J.decisionFacts({orderId:'o',decision:{plan:null}})[0],{label:'Order',value:'Order sent'},'today');
});
test('the daily digest counts each order of a batch; a single review counts as before',()=>{
  const {decisionCounts}=require('../electron/daily-digest.cjs');
  assert.deepEqual(decisionCounts([single,batch({action:'Hold',symbol:'',quantity:0}),{decision:{action:'Hold'}}]),{Buy:2,Sell:1,Hold:1},'the held-back first of the batch is not a Hold');
  assert.deepEqual(decisionCounts([single,{decision:{action:'Hold'}}]),{Buy:1,Sell:0,Hold:1},'today');
});
test('the review gate: the review\'s own further orders are not "New order" changes; further orders change the decision; trades count each',()=>{
  const RG=require('../electron/review-gate.cjs');
  const change=RG.decisionChange({action:'Buy',symbol:'A',quantity:1},{action:'Buy',symbol:'A',quantity:1,moreOrders:[{action:'Buy',symbol:'B',quantity:1}]});assert.ok(change.parts.includes('further orders'));
  assert.equal(RG.decisionChange({action:'Buy',symbol:'A',quantity:1},{action:'Buy',symbol:'A',quantity:1}).changed,false,'today');
});
test('the schedule observer: further orders are a material change',()=>{
  const SO=require('../electron/schedule-observer.cjs');
  const c=SO.decisionChanges({decision:{action:'Buy',symbol:'A',quantity:1}},{decision:{action:'Buy',symbol:'A',quantity:1,moreOrders:[{action:'Sell',symbol:'B',quantity:2}]}});
  assert.ok(c.material.some(m=>/^further orders none → Sell B 2$/.test(m)));
});
test('scout feedback: a pick bought as a further order reads bought',()=>{
  const {ScoutScorecard}=require('../electron/scout-feedback.cjs');const acted=ScoutScorecard.prototype.acted;
  assert.equal(acted.call({},'035720',0,[batch({action:'Hold',symbol:'',quantity:0})]),'bought');assert.equal(acted.call({},'005930',0,[single]),'bought','today');
  assert.equal(acted.call({},'000660',0,[batch({action:'Hold',symbol:'',quantity:0})]),'not yet','a Sell is not a Buy');
});
test('the previous review\'s shortened form keeps its further orders',()=>{
  const rc=require('../electron/review-context.cjs');const fn=rc.KEEP.previousReview;assert.equal(typeof fn,'function');
  assert.deepEqual(fn({action:'Buy',symbol:'A',quantity:1,verdicts:{},explanation:'x',moreOrders:[{action:'Sell',symbol:'B',quantity:1,sent:true}]},null,null,100).moreOrders,[{action:'Sell',symbol:'B',quantity:1,sent:true}]);
});
// F4 (planner): a review with several orders is named by its counts, not by its first order's action.
test('F4: a batch reads by counts ("2 buys, 1 sale"), its tag is the shared action or Mixed; a single order is unchanged',async()=>{
  const J=await import(require('node:url').pathToFileURL(path.join(__dirname,'../src/journalTabs.ts')).href);
  const o=(item,action)=>({item,action,symbol:'S'+item,quantity:1});
  const mixed={allOrders:[o(0,'Buy'),o(1,'Buy'),o(2,'Sell')],decision:{action:'Buy'}};
  assert.equal(J.batchCounts(mixed),'2 buys, 1 sale');assert.equal(J.batchAction(mixed),'Mixed');
  assert.equal(J.batchCounts({allOrders:[o(0,'Buy'),o(1,'Buy'),o(2,'Buy')],decision:{action:'Buy'}}),'3 buys');assert.equal(J.batchAction({allOrders:[o(0,'Sell'),o(1,'Sell')]}),'Sell');
  assert.equal(J.batchCounts({allOrders:[o(1,'Sell')],decision:{action:'Hold',withheld:{symbol:'X'}}}),'1 sale, first held back');
  assert.equal(J.batchCounts({allOrders:[o(0,'Buy')],decision:{action:'Buy'}}),'1 buy');
  assert.equal(J.batchCounts({decision:{action:'Buy'}}),null);assert.equal(J.batchAction({allOrders:[]}),null,'a single order: no batch name or tag');
});
