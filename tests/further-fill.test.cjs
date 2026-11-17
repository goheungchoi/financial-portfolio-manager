// M-6 parts 3-4 through the app (the planner's request): a further order of a batch fills at the broker. The outcome
// ledger's row, position memory built from it, the learning record's review link and the phone's trade snapshot carry
// that order's own decision and plan, never the first order's.
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const {OutcomeLedger}=require('../electron/outcome-ledger.cjs');const PM=require('../electron/position-memory.cjs');const ROE=require('../electron/review-orders.cjs');const phone=require('../electron/phone-snapshot.cjs');
const planOf=(thesis,stopPrice)=>({strategy:'swing',thesis,invalidation:`${thesis} fails`,stopPrice,targetPrice:null,horizonDays:30,confidence:'medium'});
test('a further order\'s fill: the ledger, position memory and the phone snapshot carry its own plan',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'035720':50000}});const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};
  h.decide({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'two buys',plan:planOf('first thesis',60000),
    moreOrders:[{item:1,action:'Buy',symbol:'035720',quantity:2,credit:'none',loanDate:'',plan:planOf('second thesis',45000)}],moreWithheld:[]});
  await a.review('User request');const review=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);
  const kis=m.book.KR.find(r=>r.symbol==='035720'&&r.kind==='order');assert.ok(kis,'the further order is at KIS');
  m.fill('KR',kis.orderId);await h.reconcile('KR');
  const engine=h.kr.orders().find(o=>o.symbol==='035720');assert.ok(engine.filled>0,'filled');
  // The outcome ledger.
  new OutcomeLedger(h.db).sync();const rows=h.db.prepare('SELECT payload FROM trade_outcomes').all().map(r=>JSON.parse(r.payload));
  const out=rows.find(r=>r.symbol==='035720');assert.ok(out);assert.equal(out.reviewId,review.id,'linked to its review (the learning record reads this link)');
  assert.equal(out.decision.plan.thesis,'second thesis');assert.equal(out.decision.plan.stopPrice,45000);assert.equal(out.decision.symbol,'035720');
  assert.equal(out.reviewEvidence.quote,null,'no borrowed quote of 005930');
  // Position memory from the ledger.
  const memory=PM.build(rows,{accounts:[out.accountKey],positions:{},reviewAt:new Map([[review.id,review.timestamp]]),reviewsSince:()=>0,now:Date.now()});
  const entry=memory.find(r=>r.symbol==='035720').lastEntry;assert.equal(entry.decisionId,review.id);assert.equal(entry.stopPrice,45000);assert.equal(entry.invalidation,'second thesis fails');
  // The phone's trade snapshot for that fill.
  const r=ROE.reviewForOrder(h.db,engine);assert.equal(r.id,review.id);assert.equal(r.decision.plan.thesis,'second thesis');
  const snap=phone.tradeSnapshot({order:{...engine,source:'kis'},review:r,figures:{fields:[]}});const text=JSON.stringify(snap);
  assert.match(text,/Stop 45000/);assert.doesNotMatch(text,/Stop 60000/,'not the first order\'s plan');
  // The first order still reads as today.
  const first=h.kr.orders().find(o=>o.symbol==='005930');assert.equal(ROE.reviewForOrder(h.db,first).decision.plan.thesis,'first thesis');
});
