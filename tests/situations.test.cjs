// M-3.5 (multi-order, m3-plan.md): the four situations where several orders are open with one order per review (M-0 A5),
// end to end: the real automation (conditional orders, injected reviews through a stub provider: no provider call) over
// the real engines on the mock broker, with the switch on (severalOpen) and off (today's one-open-order rule).
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const PRICES={'005930':70000,'000660':200000,'035420':200000,'NASD:AAPL':200};
const rig=(severalOpen,config={})=>{const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'000660',name:'B',quantity:5,cost:200000,price:200000}]},us:{cash:5000},prices:PRICES});
  const h=appHarness({mock:m,severalOpen}).enable();h.automation(config);return h;};
const statusOf=(h,symbol)=>h.kr.orders().find(o=>o.symbol===symbol);
const stop=h=>h.arm({symbol:'000660',side:'Sell',quantity:5,conditions:[{expr:'price("000660")',op:'<=',value:210000}],purpose:'stop_loss'});
const entry=h=>h.arm({symbol:'035420',side:'Buy',quantity:1,conditions:[{expr:'price("035420")',op:'>=',value:190000}],purpose:'entry'});

test('situation 1: a review\'s buy rests and a stop fires: on, the stop is sent; off (today), it is refused and the position waits unprotected',async()=>{
  for(const on of [true,false]){const h=rig(on);h.decide({action:'Buy',symbol:'005930',quantity:10});await h.a.review('User request');assert.equal(statusOf(h,'005930').status,'Accepted');
    const s=await h.fire(stop(h).id);
    if(on){assert.equal(s.status,'submitted');assert.equal(statusOf(h,'000660').status,'Accepted');}
    else{assert.equal(s.status,'rejected');assert.match(s.outcome,/RECONCILIATION_REQUIRED/);assert.equal(h.mock.book.KR.length,1,'nothing more reached KIS');}}
});
test('situation 2: a later review decides another stock while the earlier order rests: on, placed; off, refused as today',async()=>{
  for(const on of [true,false]){const h=rig(on);h.decide({action:'Buy',symbol:'005930',quantity:10});await h.a.review('User request');
    // Off: the engine's one-open-order rule refuses the send, and the review fails as it does today (REVIEW_FAILED).
    h.decide({action:'Buy',symbol:'035420',quantity:1});const r=await h.a.review('Price movement trigger').then(()=>null,e=>e.message);const o=statusOf(h,'035420');
    if(on){assert.equal(r,null);assert.equal(o.status,'Accepted');}else{assert.equal(r,'REVIEW_FAILED');assert.notEqual(o?.status??'none','Accepted');}
    assert.equal(statusOf(h,'005930').status,'Accepted','the first order is untouched');}
});
test('situation 3: two conditional orders fire within minutes: on, both sent; off, the second is refused',async()=>{
  for(const on of [true,false]){const h=rig(on);const a=await h.fire(stop(h).id),b=await h.fire(entry(h).id);
    assert.equal(a.status,'submitted');assert.equal(b.status,on?'submitted':'rejected');if(!on)assert.match(b.outcome,/RECONCILIATION_REQUIRED/);}
});
test('situation 4: your own order in KIS rests while the app trades: on, another stock is placed and yours of the same stock blocks it (D3); off, any open order at KIS refuses',async()=>{
  for(const on of [true,false]){const h=rig(on);h.mock.userOrder('KR',{symbol:'035420',side:'Buy',quantity:1,orderPrice:200000});
    h.decide({action:'Buy',symbol:'005930',quantity:10});const r=await h.a.review('User request').then(()=>null,e=>e.message);assert.equal(statusOf(h,'005930')?.status==='Accepted',on,'another stock');
    if(!on)assert.equal(r,'REVIEW_FAILED','off: KIS lists an open order, so the preparation refuses (as today)');
    if(on){h.decide({action:'Buy',symbol:'035420',quantity:1});await h.a.review('Price movement trigger').catch(()=>{});assert.notEqual(statusOf(h,'035420')?.status??'none','Accepted','your open order of the stock blocks it');}}
});
test('row 32: at the daily automatic order cap, a fired entry waits for your approval while a protective sale is still sent',async()=>{
  const h=rig(true,{maxAutoOrdersPerDay:1});h.decide({action:'Buy',symbol:'005930',quantity:10});await h.a.review('User request');assert.equal(statusOf(h,'005930').status,'Accepted');
  const b=await h.fire(entry(h).id);assert.equal(b.status,'proposed');assert.match(b.outcome,/daily automatic order limit/);
  const s=await h.fire(stop(h).id);assert.equal(s.status,'submitted','a closing order is admitted at the cap');
});
test('row 35: each fill is its own order event; reviews after an order update are off by default; routine reviews still wait while another order rests',async()=>{
  const h=rig(true);assert.notEqual(h.a.config.orderUpdateReviews,true,'off unless you turn it on');
  const a=await h.send('KR','005930','Buy',10,70000),b=await h.send('KR','035420','Buy',1,200000);h.a.orderEvents();
  h.mock.fill('KR',a.brokerOrderId);await h.reconcile('KR');assert.deepEqual(h.a.orderEvents().map(o=>[o.symbol,o.status]),[['005930','Filled']],'the fill, of that order only');
  h.a.lastRun=Date.now();const d=h.a.deferForPendingOrder();assert.deepEqual(d?.orders.map(o=>o.symbol),['035420'],'a scheduled review waits for the other resting order');
});
