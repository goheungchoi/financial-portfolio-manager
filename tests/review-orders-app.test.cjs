// M-6 part 3 through the app (multi-order, m6-plan.md section 4; part 0's F1 for further orders): a batch's further
// orders reach the window (allOrders), the next review's previousReview, the review gate's baseline and the scoreboard,
// and a further order unclear when recorded follows its engine order when it is resolved.
const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const RG=require('../electron/review-gate.cjs');
const order=(item,symbol,action='Buy')=>({item,action,symbol,quantity:1,credit:'none',loanDate:''});
const setup=()=>{const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'035720':50000,'990060':100000}});const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};return {m,h,a};};
const batch=async(h,a,more=[order(1,'035720'),order(2,'990060')])=>{h.decide({...order(undefined,'005930'),explanation:'three',moreOrders:more,moreWithheld:[]});await a.review('User request').catch(()=>{});};
test('the window gets every order of a batch (allOrders, not stored); a single review gets none',async()=>{
  const {h,a}=setup();await batch(h,a);const [r]=a.reviewHistory();
  assert.deepEqual(r.allOrders.map(o=>[o.item,o.symbol]),[[0,'005930'],[1,'035720'],[2,'990060']]);assert.ok(!('decision' in r.allOrders[0]),'the window gets the order fields only');
  assert.ok(!('allOrders' in JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload)),'not stored');
  h.db.exec('DELETE FROM reviews');h.decide({...order(undefined,'005930'),explanation:'one'});await a.review('User request').catch(()=>{});assert.ok(!('allOrders' in a.reviewHistory()[0]));
});
test('F1 for a further order: unclear when recorded, then linked: its row follows and the Journal reads "Order sent"',async()=>{
  const J=await import(require('node:url').pathToFileURL(path.join(__dirname,'../src/journalTabs.ts')).href);
  const {m,h,a}=setup();m.fault('place-order',null).fault('place-order','lost');await batch(h,a,[order(1,'035720')]);
  const row=()=>a.reviewHistory()[0].orders.find(o=>o.item===1);assert.equal(row().orderOutcome.status,'Uncertain');assert.equal(J.orderPill(row()),'Unclear: check KIS');
  const eng=h.kr.orders().find(o=>o.symbol==='035720');const kis=m.book.KR.find(x=>x.symbol==='035720'&&x.kind==='order');await h.kr.linkUncertain(eng.id,kis.orderId,'LINK BROKER ORDER').catch(()=>{});
  assert.equal(J.orderPill(row()),'Order sent');assert.notEqual(JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload).orders[0].orderOutcome.status,'Uncertain','written back');
});
test('the next review is told the previous review\'s further orders, and whether each was sent',async()=>{
  const {h,a}=setup();await batch(h,a);let ctx=null;const provider=a.provider;a.provider={...provider,request:async(op,p)=>{if(op==='decision')ctx??=p.context;return provider.request(op,p);}};
  h.decide({action:'Hold',symbol:'',quantity:0,explanation:'hold'});await a.review('User request').catch(()=>{});
  assert.deepEqual(ctx.previousReview.moreOrders,[{action:'Buy',symbol:'035720',quantity:1,sent:true},{action:'Buy',symbol:'990060',quantity:1,sent:true}]);
});
test('the review gate: the orders the review placed itself (first and further) are not "New order" changes; another one is',()=>{
  const state=orders=>RG.decisionState({quotes:[],positions:{},cash:1000000,currency:'KRW',equity:1000000,orderFollowUp:{orders:orders.map(s=>({symbol:s,side:'Buy',quantity:1,status:'Accepted',filled:0}))}});
  const base={...state([]),at:Date.now(),decision:{action:'Buy',symbol:'005930',orderId:'o0',placed:[{symbol:'035720',action:'Buy'}]}};
  const next=state(['005930','035720','990060']);
  const g=RG.compare(base,next,{trigger:'Scheduled review'});const news=g.reasons.filter(r=>/^New /.test(r.detail)).map(r=>r.detail);
  assert.deepEqual(news,['New Buy order for 990060: Accepted']);
});
test('the scoreboard scores each order of a batch as its own decision, with that order\'s own plan and no borrowed quote',()=>{
  const {Scoreboard}=require('../electron/scoreboard.cjs');const r={id:'r',timestamp:1,account:null,contextEvidence:{environment:'kis-combined',quote:{symbol:'005930',price:70000}},orderId:'o0',decision:{action:'Buy',symbol:'005930',quantity:1,plan:{confidence:'high'},explanation:'x',moreOrders:[{item:1,action:'Sell',symbol:'035720',quantity:2,plan:{confidence:'low'}}]},
    orders:[{item:1,symbol:'035720',action:'Sell',quantity:2,orderId:'o1',proposalId:'p1'}]};
  const sb=Object.create(Scoreboard.prototype);sb.reviews=()=>[r];const c=sb.candidates();
  assert.deepEqual(c.map(x=>[x.id,x.decision.symbol,x.decision.action,x.decision.plan?.confidence,x.orderId]),[['r','005930','Buy','high','o0'],['r#1','035720','Sell','low','o1']]);
  assert.equal(c[1].contextEvidence.quote,null);assert.equal(c[0].contextEvidence.quote.price,70000);
});
