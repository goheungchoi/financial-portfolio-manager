// Stage 2b.4: the U.S. daily-loss baseline follows settlement corrections, and the flow detector takes the tracker's own
// changes as explained (electron/settlement-baseline.cjs, InFlight.explainedSince; stage2b-spec.md B1-B8, F1-F3;
// design tests T25b/T44, T26 (restated under E8), T27, T28, T46, plus the false-deposit case CN2/CN5/CN25).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value,VERSION}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');
const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
// Deterministic time (1.5.48 audit): the fixtures run around the engine's own Date.now() stamp, so Date.now runs from a
// fixed midday in Seoul on D. A run late in the U.S. afternoon used to cross a Seoul day boundary and fail F5.
{const realNow=Date.now,startReal=realNow(),FIXED=Date.parse('2026-10-29T03:00:00Z');Date.now=()=>FIXED+(realNow()-startReal);}
const MIN=60000,HOUR=3600000,DAY=86400000,D='2026-10-29',SCOPE={account:'a',environment:'live',market:'US'},W={start:'2026-10-01',end:'2026-11-02'};
const k=(extra={})=>({tradeDate:D,settlementDate:'2026-10-30',ticker:'TEST',side:'Buy',quantity:1,price:100,grossUSD:100,settlementUSD:100,settlementKRW:130000,feesUSD:0,exchangeRate:1300,...extra});
const order=(id,extra={})=>({id,symbol:'NASD:'+(extra.ticker??'TEST'),side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'live',accountKey:'a:US',market:'US',day:D,createdAt:Date.parse('2026-10-25T15:00:00Z'),...extra});
// The tracker (S4b-2: its pieces settle by KIS evidence; the reconciliation is gone), the baseline, a U.S. engine whose loss is measured on the valuation, and the flow detector,
// on one database and one clock. The engine stamps its baseline with the real time, so the test clock runs around it.
function world({limit=30}={}){const db=new DatabaseSync(':memory:');let t=Date.now()-6*HOUR;const clock=()=>t;
  const f=new InFlight(db,clock,{settleDays:null}/* age rule off until S3/S4 removes these tests */),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock);
  const sb=new SettlementBaseline(db,{inFlight:f,clock}),fd=new FlowDetector(db,perf,clock);let day=D,us={cash:500,holdings:[]};const flows={confirmed:0,unresolved:0};
  const snap=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:us.holdings,reportedTotal:us.cash,timestamp:new Date(t).toISOString()});
  const e=new LiveEngine(db,{request:async()=>{}},()=>({status:'connected',snapshot:snap()}),{market:'US'});e.day=()=>day;
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:limit}},'ENABLE LIVE');
  e.netEquityOf=s=>({...value({us:s,inFlight:f.current('a'),fx:{usdKRW:1300},now:t}).markets.US.equity,version:VERSION});
  e.baselineTaken=p=>sb.take('a',p.day,p.baselineAt);e.settlementAdjustments=p=>sb.adjustments('a',p);e.flowsSince=()=>flows;
  const w={db,f,funding,perf,sb,fd,e,flows,clock,us,ledger:f.evidence,
    see:(orders=[],extra={})=>{const r=f.observe('a',{us:{...snap(),...extra},orders,fx:1300});t+=MIN;return r;},
    // A day's baseline, taken on the valuation (the first reading of a day sets the version, the next the baseline).
    baseline:d=>{day='2026-10-27';e.observeBalance(snap());day=d;e.observeBalance(snap());t=Math.max(t,Date.now())+HOUR;return e.policy();},
    loss:()=>e.lossOf(e.policy(),snap()),later:ms=>{t+=ms;},setDay:d=>{day=d;},pid:(id='A')=>f.current('a').open.find(p=>p.id===id)?.pid,
    open:(...orders)=>{w.see();for(const o of orders)funding.track(o);w.see(orders);return orders;},
    // KIS U.S. cash falls by the payment: the tracker allocates that evidence to the order (it settles by evidence).
    pay:(orders,usd=100)=>{us.cash-=usd;return w.see(orders);},
    detect:(orders=[])=>{const v=f.current('a');return fd.observe('a',{krCash:1000000,usCash:us.cash-v.buysUSD+v.sellsUSD,fx:1300,orders,usExplained:range=>f.explained('a',range)});}};
  return w;}

test('B1: the day\'s baseline saves the tracker\'s pieces, once',()=>{
  const w=world();w.open(order('A'));const p=w.baseline(D);const s=w.sb.get('a',D);assert.equal(s.at,p.baselineAt);assert.deepEqual(Object.values(s.pieces).map(x=>[x.side,x.cents,x.orderId]),[['Buy',10000,'A']]);
  assert.deepEqual(s.orders,['A']);assert.equal(p.baseline,400,'the valuation\'s low bound: $500 cash less the $100 in flight');
  w.pay([order('A')]);w.sb.take('a',D,p.baselineAt+1);assert.deepEqual(Object.keys(w.sb.get('a',D).pieces).length,1,'the first snapshot stands');
});
test('T26 (restated under E8): reduced coverage moves no baseline; a KIS record above the allocation for an order known at the baseline moves it with the value, and back',()=>{
  const w=world();const [A]=w.open(order('A'));w.pay([A]);w.ledger.importK(SCOPE,W,[k()]);w.see([A]);w.baseline(D);
  w.ledger.importK(SCOPE,W,[k({settlementUSD:97,grossUSD:97,price:97})]);w.see([A]);assert.equal(w.f.current('a').reducedCoverage[0].usd,3);
  let a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,0);assert.equal(w.loss().loss,0,'reduced coverage changes no value');
  w.ledger.importK(SCOPE,W,[k({settlementUSD:103,grossUSD:103,price:103,settlementDate:'2026-11-02'})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,3);
  a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,-3);assert.equal(w.loss().loss,0,'the correction is not a loss');
  w.ledger.importK(SCOPE,W,[k({settlementUSD:100,grossUSD:100,price:100,settlementDate:'2026-11-03'})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,0);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,0);assert.equal(w.loss().loss,0);
});
test('B5: a pre-tracking fill listed after the baseline moves the baseline with the value',()=>{
  const w=world();w.open(order('A'));w.baseline(D);w.see([order('A'),order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}})]);
  assert.equal(w.f.current('a').buysUSD,150);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,-50);assert.equal(w.loss().loss,0);
  // (S3b/S4: its later reconciliation is gone. S5: B7, coverage going under review, is gone with the citations.)
});
test('S3b, R1: with no snapshot for the day, the settlement corrections are unavailable with the reason, and so is the loss check',()=>{
  const w=world();w.open(order('A'));w.e.baselineTaken=null;w.baseline(D);assert.equal(w.sb.get('a',D),null);
  const a=w.sb.adjustments('a',w.e.policy());assert.match(a.unavailable,/no settlement snapshot/);assert.equal('certain' in a,false);
  const l=w.loss();assert.equal(l.unavailable,true);assert.equal(l.loss,null);assert.equal(l.ambiguous,true,'new buys restricted');assert.match(l.reasons[0],/no settlement snapshot/);
});
test('F1-F3 (CN2, CN5): the tracker\'s own changes are explained to the flow detector: no false withdrawal; a real deposit still is one (S4b-1: the reconciliation and reversal cases went with the timing entries)',()=>{
  const w=world();const [A]=w.open(order('A'));w.detect([A]);w.later(MIN);
  // A pre-tracking fill listed late lowers the basis: no withdrawal.
  const B=order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});w.see([A,B]);w.later(MIN);w.detect([A,B]);w.later(3*HOUR);assert.deepEqual(w.detect([A,B]),[],'no withdrawal from a late pre-tracking fill');
  // A real $200 deposit: it alone is detected.
  w.us.cash+=200;w.later(MIN);w.detect([A,B]);w.later(3*HOUR);const found=w.detect([A,B]);assert.deepEqual(found.map(x=>[x.market,x.amount,Boolean(x.detected)]),[['US',200,true]]);
});
test('F3: explainedSince counts only non-cash, non-fill changes after the time given',()=>{
  const w=world();const t0=w.clock();const [A]=w.open(order('A'));assert.equal(w.f.explainedSince('a',t0-1),-100,'the pre-tracking piece');
  const t1=w.clock();w.see([A],{cash:400});assert.equal(w.f.current('a').buysUSD,0,'settled by cash');assert.equal(w.f.explainedSince('a',t1),0,'cash evidence is not explained here: the detector sees the cash');
});
test('F4: the first tracking reading opens pre-tracking fills the detector already saw: explained, no withdrawal; one it sees for the first time is explained once',()=>{
  // The detector read the account (and the filled orders) before the tracker's first reading, as an upgraded profile can.
  const w=world();const A=order('A'),S=order('S',{side:'Sell',fillPrice:268.47,limitPrice:268.47,costEstimate:undefined,resultCosts:{netCash:268.47}});
  w.detect([A,S]);w.later(MIN);w.see();w.see([A,S]);assert.equal(w.f.current('a').buysUSD,100);assert.equal(w.f.current('a').sellsUSD,268.47);
  w.detect([A,S]);w.later(3*HOUR);assert.deepEqual(w.detect([A,S]),[],'the tracker opening its pieces is no flow');
  // An order listed for the first time with its pre-tracking fill: the detector explains the fill itself; not twice.
  const B=order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});w.see([A,S,B]);w.later(MIN);w.detect([A,S,B]);w.later(3*HOUR);assert.deepEqual(w.detect([A,S,B]),[]);
});
test('B6: a conflict for an order the baseline did not know moves nothing',()=>{
  const w=world();w.open();w.baseline(D);const B=order('B',{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([B]);w.see([B],{cash:400});assert.equal(w.f.current('a').buysUSD,0,'settled by cash after the baseline');
  w.ledger.importK(SCOPE,W,[k({tradeDate:require('../electron/settlement-evidence.cjs').usTradeDate(B),settlementUSD:103,grossUSD:103,price:103})]);w.see([B],{cash:400});
  assert.equal(w.f.current('a').buysUSD,3,'a conflict piece');assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,0,'its fill came after the baseline');
});
test('The snapshot: after the baseline is decided by the ledger event, not the clock; with no snapshot, unavailable (R1)',()=>{
  const B=()=>order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});
  // A tracker reading in the same millisecond as the baseline, after it.
  const w=world();w.open(order('A'));const at=w.clock();w.sb.take('a',D,at);w.see([order('A'),B()]);
  assert.equal(w.sb.adjustments('a',{day:D,baselineAt:at}).certain.low,-50,'opened after the snapshot, at the same time');
  const x=world();x.open(order('A'));x.e.baselineTaken=null;x.baseline(D);x.see([order('A'),B()]);const a=x.sb.adjustments('a',x.e.policy());
  assert.match(a.unavailable,/no settlement snapshot/);assert.equal(x.loss().unavailable,true);
});
test('B6 (review of 06a0b95, P1): a conflict already in the baseline moves it when reduced, up to what it held',()=>{
  const w=world();const [A]=w.open(order('A'));w.pay([A]);w.ledger.importK(SCOPE,W,[k({settlementUSD:150,grossUSD:150,price:150})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,50);
  w.baseline(D);assert.equal(Object.values(w.sb.get('a',D).pieces)[0].conflict,true);
  w.ledger.importK(SCOPE,W,[k({settlementUSD:120,grossUSD:120,price:120,settlementDate:'2026-11-02'})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,20);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,30);assert.equal(w.loss().loss,0);
  w.ledger.importK(SCOPE,W,[k({settlementUSD:100,grossUSD:100,price:100,settlementDate:'2026-11-03'})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,0);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,50);
  // A genuine $35 loss on the same day stays visible.
  w.us.holdings=[{symbol:'X',quantity:1,price:-35}];assert.equal(w.loss().loss,35);
});
test('F8b: held changes widen the range part by part, each real or not (S4b-1: the timing-entry part went with the entries)',()=>{
  // A +$150 change held (under the two-hour hold) after the baseline: the range runs from 0 (not real) to +$150.
  const w=world();const [A]=w.open(order('A'));w.baseline(D);const at=w.e.policy().baselineAt;w.detect([A]);w.later(MIN);w.us.cash+=150;w.later(MIN);w.detect([A]);
  const r=w.fd.flowsSince('a','US',at);assert.deepEqual([r.range.low,r.range.high],[0,150]);
  // A later -$60 change adds a part of its own: -$60 to +$150, never netted to +$90.
  w.us.cash-=60;w.later(MIN);w.detect([A]);const h=w.fd.flowsSince('a','US',at);assert.equal(h.held.after,90);assert.deepEqual([h.range.low,h.range.high],[-60,150]);
  // On the high bounds as well: a genuine loss seen only there with a possible deposit counted is not missed.
  const e=w.e,p={...e.policy()};e.flowsSince=q=>w.fd.flowsSince('a','US',q.baselineAt);const l=e.lossOf(p,{accountKey:'a:US',environment:'live',cash:w.us.cash,holdings:[{symbol:'X',quantity:1,price:-300}],pendingSaleProceeds:0,reportedTotal:w.us.cash,timestamp:new Date(w.clock()).toISOString()});
  assert.ok(l.scenarios.some(x=>/highest total, high bounds/.test(x.name)&&x.breached));
});
