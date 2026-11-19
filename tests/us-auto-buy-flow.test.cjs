// Automatic U.S. buys, step 4 (artifacts/reviews/2026-11-19-us-auto-buys/decision.md): with R15 removed, the paths
// that were never run for an automatic U.S. buy since 11-05 run end to end, on the real engines, ledger and automation
// over the mock broker (no provider call): a U.S. conditional entry fires and is sent; one that does not fit the won
// rule is refused before KIS; a review's U.S. buy with a plan arms its plan stop and trailing stop, which start from
// the fill; and an automatic buy's funding and settlement follow exactly the path of the same buy sent by hand.
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const PRICES={'005930':70000,'NASD:AAPL':200};
const rig=({krCash=10000000,config={}}={})=>{const m=new MockKis({kr:{cash:krCash},us:{cash:5000},prices:PRICES});const h=appHarness({mock:m,severalOpen:true}).enable();h.automation({scope:'us',...config});
  // The U.S. reading with a quote of the stock (the app's refresh reads the policy's symbols and the holdings).
  h.a.refreshUS=async()=>m.request('US','context',{symbols:['NASD:AAPL']});
  h.a.usQuotes=[{symbol:'NASD:AAPL',price:200,timestamp:Date.now(),retrievedAt:Date.now()}];return h;};
const usOrder=(h,symbol='NASD:AAPL')=>h.us.orders().find(o=>o.symbol===symbol&&o.side==='Buy');
const plan={horizon:'swing',thesis:'Thesis for NASD:AAPL',invalidation:'Below 180',stopPrice:180,targetPrice:null,horizonDays:60,confidence:'medium',
  portfolioImpact:{weightBeforePct:0,weightAfterPct:1,related:[],relatedBeforePct:0,relatedAfterPct:1,equityReliable:true,why:'A small position.'},
  evidence:[{claim:'Thesis for NASD:AAPL is supported',source:'Q3 release',verified:true}],valuation:null,uncertainty:null};

test('a U.S. conditional entry fires and is sent automatically (automation.cjs fireConditional → autoSubmit)',async()=>{
  const h=rig();const e=h.arm({symbol:'NASD:AAPL',side:'Buy',quantity:1,conditions:[{expr:'price("NASD:AAPL")',op:'>=',value:190}],purpose:'entry'});
  const r=await h.fire(e.id);assert.equal(r.status,'submitted',r.outcome);const o=usOrder(h);
  assert.equal(o.status,'Accepted');assert.equal(o.sentBy,'auto');assert.equal(o.madeBy,'conditional');assert.equal(h.mock.book.US.filter(x=>x.kind==='order').length,1);});

test('a U.S. conditional entry that does not fit the won rule is refused before KIS, with dollars in the U.S. account',async()=>{
  // ₩200,000 at ρ (rate 1,340 × 1.02 = 1,366.8) holds about $146; $200 plus fees does not fit, though $5,000 is in USD.
  const h=rig({krCash:200000});const e=h.arm({symbol:'NASD:AAPL',side:'Buy',quantity:1,conditions:[{expr:'price("NASD:AAPL")',op:'>=',value:190}],purpose:'entry'});
  const r=await h.fire(e.id);assert.equal(r.status,'rejected');assert.match(r.outcome,/INSUFFICIENT_CAPACITY/);
  assert.equal(h.mock.book.US.filter(x=>x.kind==='order').length,0,'nothing reached KIS');});

test('a review\'s automatic U.S. buy with a plan: its plan stop (trailing) is armed for the fill and starts from it',async()=>{
  const h=rig({config:{trailingStops:true}});h.decide({action:'Buy',symbol:'NASD:AAPL',quantity:2,credit:'none',loanDate:'',plan:{...plan,trailPct:6}});
  await h.a.review('User request');const o=usOrder(h);assert.equal(o.status,'Accepted');assert.equal(o.sentBy,'auto');
  const stop=()=>h.a.desk.orders(h.a.watchScope()).find(x=>x.symbol==='NASD:AAPL'&&x.side==='Sell');
  assert.ok(stop(),'the plan stop is armed');assert.equal(stop().linkedBuy.id,o.id);assert.equal(stop().trail.awaitingFill,true);
  h.mock.fill('US',o.brokerOrderId,2,201);await h.reconcile('US');assert.equal(h.order('US',o.id).status,'Filled');
  h.a.trackTrailing(h.a.watchScope(),Date.now());const t=stop().trail;assert.equal(t.awaitingFill,false,'started from the fill');assert.ok(t.active);assert.ok(t.level>=180,'never below the plan stop');});

test('an automatic U.S. buy is funded and settled exactly as the same buy sent by hand',async()=>{
  const run=async automatic=>{const h=rig();const s=await h.send('US','NASD:AAPL','Buy',3,200,{automatic});assert.equal(s.status,'Accepted');const id=s.id;
    const reserved=h.ledger.row(id);h.mock.fill('US',s.brokerOrderId);await h.reconcile('US');h.reading();const filled=h.ledger.row(id);
    h.mock.settle('US');h.reading();await h.reconcile('US');const after=h.ledger.row(id);
    const strip=c=>c&&{state:c.state,amount:c.amount,committedQty:c.committedQty,filledQty:c.filledQty,currency:c.currency,market:c.market};
    return {sentBy:h.order('US',id).sentBy,reserved:strip(reserved),filled:strip(filled),after:strip(after),usd:h.ledger.commitments('acct').usd,flows:h.flows.length};};
  const hand=await run(false),auto=await run(true);
  assert.equal(hand.sentBy,'you');assert.equal(auto.sentBy,'auto');
  for(const k of ['reserved','filled','after','usd','flows'])assert.deepEqual(auto[k],hand[k],k);
  assert.equal(auto.filled.state,'filled-unpaid');assert.equal(auto.flows,0,'no detected flow');});
