// Found in live use (the planner's note on the fault): the price-alert baseline
// of a stock a review trades is the price its order was placed at, then its fill price, never the review-time quote
// (a review-time quote well away from the order book started a false price review). Real engines over the mock broker, no
// provider call, made-up values.
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');

test('a traded stock: baseline at the placed price after the review, at the fill price once it fills',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'000660':200000}});const h=appHarness({mock:m,severalOpen:true}).enable();h.automation();
  // The review quotes 005930 at 70,000 (mock), but the book prices the order at 69,300.
  const place=h.a.placementPrice.bind(h.a);h.a.placementPrice=async args=>({...(await place(args)),price:69300});
  h.decide({action:'Buy',symbol:'005930',quantity:2,credit:'none',loanDate:''});await h.a.review('User request');
  const o=h.kr.orders().find(x=>x.symbol==='005930'&&x.side==='Buy');assert.ok(o,'proposed');
  assert.equal(h.a.lastPrices.get('005930'),69300,'the placed price, not the review quote');
  const scope=h.a.watchScope();h.a.applyFillBaselines(scope);assert.equal(h.a.lastPrices.get('005930'),69300,'not filled yet: unchanged');
  assert.ok(o.brokerOrderId,'sent to the broker: '+o.status+' '+(o.reason??''));h.mock.fill('KR',o.brokerOrderId,2,69200);await h.reconcile('KR');h.a.applyFillBaselines(scope);
  assert.equal(h.a.lastPrices.get('005930'),69200,'the fill price');assert.equal(h.a.tradedBaselines.size,0,'done');
});

test('a review that trades nothing: the baseline is the review quote, as before',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m,severalOpen:true}).enable();h.automation();
  h.decide({action:'Hold',symbol:'005930',quantity:0,credit:'none',loanDate:''});await h.a.review('User request');
  assert.equal(h.a.lastPrices.get('005930'),70000);assert.equal(h.a.tradedBaselines.size,0);
});
