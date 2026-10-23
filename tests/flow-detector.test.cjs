const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {FlowDetector,flowsFrom}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const at=s=>Date.parse(s);
function setup(){let now=at('2026-10-23T08:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);return {d,perf,tick:s=>{now=at(s);}};}
const buy=(createdAt,filled,price,extra={})=>({market:'KR',side:'Buy',status:'Filled',filled,fillPrice:price,createdAt:at(createdAt),...extra});
test('a deposit no trade explains is recorded as a detected flow; a reconciled buy is not',()=>{
  const {d,perf,tick}=setup();assert.deepEqual(d.observe('acct',{krCash:500001}),[],'the first reading only sets the baseline');
  tick('2026-10-23T09:50:00+09:00');const [flow]=d.observe('acct',{krCash:1500001});
  assert.deepEqual({day:flow.day,market:flow.market,amount:flow.amount,detected:flow.detected},{day:'2026-10-23',market:'KR',amount:1000000,detected:true});assert.match(flow.note,/Korean cash rose/);
  // The 10:03 buy: cash falls by its net cost, explained by the reconciled fill.
  tick('2026-10-23T10:10:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1319074,orders:[buy('2026-10-23T10:03:41+09:00',3,60300,{resultCosts:{netCash:-180927}})]}),[]);
  assert.equal(perf.flows('acct').length,1);
});
test('detection waits while an order is open, then explains the fill',()=>{
  const {d,tick}=setup();d.observe('acct',{krCash:1500001});
  tick('2026-10-23T10:04:00+09:00');const order=buy('2026-10-23T10:03:41+09:00',3,60300,{status:'Accepted',filled:0});
  assert.deepEqual(d.observe('acct',{krCash:1319074,orders:[order]}),[],'an unreconciled fill is never a withdrawal');
  tick('2026-10-23T10:05:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1319074,orders:[{...order,status:'Filled',filled:3}]}),[],'explained once reconciled, against the reading before the order');
});
test('withdrawals are detected; small amounts and currency conversions are not flows',()=>{
  const {d,tick}=setup();d.observe('acct',{krCash:1000000,usCash:0});
  tick('2026-10-23T11:00:00+09:00');const [w]=d.observe('acct',{krCash:700000,usCash:0});assert.equal(w.amount,-300000);
  tick('2026-10-23T12:00:00+09:00');assert.deepEqual(d.observe('acct',{krCash:700500,usCash:0}),[],'₩500 (for example a small dividend) is below the threshold');
  // Integrated margin: KRW pays for a U.S. buy while USD cash stays at zero.
  tick('2026-10-23T23:40:00+09:00');const funding=d.observe('acct',{krCash:700500-347000,usCash:0,fx:1388,orders:[{market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:250,createdAt:at('2026-10-23T23:35:00+09:00')}]});
  assert.deepEqual(funding.map(f=>[f.market,f.amount,f.transfer,f.detected]),[['KR',-347000,true,undefined],['US',250,true,undefined]],'KRW funding a U.S. buy is a transfer between markets, not a deposit');
  // A manual exchange of ₩139,000 into $100 is also a conversion.
  tick('2026-10-24T00:10:00+09:00');assert.deepEqual(d.observe('acct',{krCash:353500-139000,usCash:100,fx:1390}).map(f=>[f.market,f.amount,f.transfer]),[['KR',-139000,true],['US',100,true]],'a currency exchange is a transfer');
});
test('a U.S. fill without both U.S. readings is not judged; a U.S. deposit is recorded in dollars',()=>{
  const {d,tick}=setup();d.observe('acct',{krCash:500000});
  tick('2026-10-23T23:40:00+09:00');assert.deepEqual(d.observe('acct',{krCash:153000,orders:[{market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:250,createdAt:at('2026-10-23T23:35:00+09:00')}]}),[],'waits for U.S. cash');
  assert.deepEqual(flowsFrom({KR:0,US:500},1390),[{market:'US',amount:500}]);
});
test('confirming a detected flow keeps it and clears the flag; day sums count deposits less withdrawals',()=>{
  const {d,perf,tick}=setup();d.observe('acct',{krCash:500001});tick('2026-10-23T09:50:00+09:00');const [flow]=d.observe('acct',{krCash:1500001});
  perf.confirmFlow('acct',flow.id);const saved=perf.flows('acct')[0];assert.equal(saved.detected,undefined);assert.ok(saved.confirmedAt);
  perf.addFlow('acct',{day:'2026-10-23',market:'KR',amount:-200000,note:'Withdrawal'});assert.equal(perf.flowsOn('acct','2026-10-23','KR'),800000);assert.equal(perf.flowsOn('acct','2026-10-23','US'),0);
  assert.throws(()=>perf.confirmFlow('acct','missing'),/INVALID_FLOW/);
});
test('the daily loss baseline includes the day\'s deposits, so a deposit does not hide a loss',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const snapshot={accountKey:'acct:KR',environment:'live',reportedTotal:500000,cash:500000,holdings:[]};
  const e=new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>{}},()=>({status:'connected',snapshot}),{market:'KR'});
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30000}},'ENABLE LIVE');
  e.flowsToday=()=>1000000;e.observeBalance({...snapshot,reportedTotal:1450000});
  const loss=e.getState().loss;assert.equal(loss.loss,50000,'₩1.5m deposited-adjusted start, ₩1.45m now');assert.equal(loss.breached,true);
});
