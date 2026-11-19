// Found in live use (the planner's note on the fault), end to end on the real engines
// over the mock broker (no provider call): a review buys a Korean stock not held before. The app's live quotes hold only
// held stocks (main.cjs trims them to the holdings at every balance), so here they are empty, as they were live. The plan
// stop is still armed with its trail, from the review's own quote, and the trail starts from the fill. Made-up values.
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const plan={horizon:'swing',thesis:'Thesis for 005930',invalidation:'Below 60,000',stopPrice:60000,targetPrice:null,horizonDays:30,confidence:'medium',
  portfolioImpact:{weightBeforePct:0,weightAfterPct:1,related:[],relatedBeforePct:0,relatedAfterPct:1,equityReliable:true,why:'A small position.'},
  evidence:[{claim:'Thesis for 005930 is supported',source:'Q3 release',verified:true}],valuation:null,uncertainty:null,trailPct:6};

test('a review\'s buy of a stock not held: the plan stop is armed with its trail although the live quotes have none, and trails from the fill',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m,severalOpen:true}).enable();
  h.automation({trailingStops:true});h.a.marketQuotes=()=>[];// as live: no quote for a stock not held
  h.decide({action:'Buy',symbol:'005930',quantity:2,credit:'none',loanDate:'',plan});await h.a.review('User request');
  const o=h.kr.orders().find(x=>x.symbol==='005930'&&x.side==='Buy');assert.ok(o,'the purchase was proposed');
  const stop=()=>h.a.desk.orders(h.a.watchScope()).find(x=>x.symbol==='005930'&&x.side==='Sell');
  assert.ok(stop(),'the plan stop is armed');assert.equal(stop().linkedBuy.id,o.id);
  assert.equal(stop().trail?.awaitingFill,true,'with its trail: '+JSON.stringify(stop().trailNotUsed??null));assert.equal(stop().trailNotUsed,undefined);
  assert.deepEqual(h.a.desk.plannedTrailsMissing(h.a.watchScope()),[]);
  h.mock.fill('KR',o.brokerOrderId,2,70000);await h.reconcile('KR');assert.equal(h.order('KR',o.id).status,'Filled');
  h.a.trackTrailing(h.a.watchScope(),Date.now());const t=stop().trail;assert.equal(t.awaitingFill,false,'started from the fill');assert.equal(t.high,70000);assert.ok(t.level>=60000);
});
