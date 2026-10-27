const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {FlowDetector,flowsFrom}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const at=s=>Date.parse(s);
function setup(){let now=at('2026-10-16T08:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);return {d,perf,tick:s=>{now=at(s);}};}
const buy=(createdAt,filled,price,extra={})=>({market:'KR',side:'Buy',status:'Filled',filled,fillPrice:price,createdAt:at(createdAt),...extra});
test('a deposit no trade explains is recorded as a detected flow once it has stood; a reconciled buy is not',()=>{
  const {d,perf,tick}=setup();assert.deepEqual(d.observe('acct',{krCash:505000}),[],'the first reading only sets the baseline');
  tick('2026-10-16T09:50:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1505000}),[],'held as provisional first');assert.deepEqual(d.pending('acct').map(p=>[p.market,p.amount]),[['KR',1000000]]);
  tick('2026-10-16T11:50:00+09:00');const [flow]=d.observe('acct',{krCash:1505000});assert.deepEqual(d.pending('acct'),[]);
  assert.deepEqual({day:flow.day,market:flow.market,amount:flow.amount,detected:flow.detected},{day:'2026-10-16',market:'KR',amount:1000000,detected:true});assert.match(flow.note,/Korean cash rose/);
  // The 10:03 buy: cash falls by its net cost, explained by the reconciled fill.
  tick('2026-10-16T12:10:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1328873,orders:[buy('2026-10-16T12:03:30+09:00',3,58700,{resultCosts:{netCash:-176127}})]}),[]);
  assert.equal(perf.flows('acct').length,1);
});
test('detection waits while an order is open, then explains the fill',()=>{
  const {d,tick}=setup();d.observe('acct',{krCash:1505000});
  tick('2026-10-16T10:04:00+09:00');const order=buy('2026-10-16T10:03:30+09:00',3,58700,{status:'Accepted',filled:0});
  assert.deepEqual(d.observe('acct',{krCash:1328873,orders:[order]}),[],'an unreconciled fill is never a withdrawal');
  tick('2026-10-16T10:05:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1328873,orders:[{...order,status:'Filled',filled:3}]}),[],'explained once reconciled, against the reading before the order');
});
test('withdrawals are detected; small amounts and currency conversions are not flows',()=>{
  const {d,tick}=setup();d.observe('acct',{krCash:1000000,usCash:0});
  tick('2026-10-16T11:00:00+09:00');assert.deepEqual(d.observe('acct',{krCash:700000,usCash:0}),[]);tick('2026-10-16T13:00:00+09:00');const [w]=d.observe('acct',{krCash:700000,usCash:0});assert.equal(w.amount,-300000);
  tick('2026-10-16T14:00:00+09:00');assert.deepEqual(d.observe('acct',{krCash:700500,usCash:0}),[],'₩500 (for example a small dividend) is below the threshold');
  // Integrated margin: KRW pays for a U.S. buy while USD cash stays at zero.
  tick('2026-10-16T23:40:00+09:00');const funding=d.observe('acct',{krCash:700500-347000,usCash:0,fx:1388,orders:[{market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:250,createdAt:at('2026-10-16T23:35:00+09:00')}]});
  assert.deepEqual(funding.map(f=>[f.market,f.amount,f.transfer,f.detected]),[['KR',-347000,true,undefined],['US',250,true,undefined]],'KRW funding a U.S. buy is a transfer between markets, not a deposit');
  // A manual exchange of ₩139,000 into $100 is also a conversion.
  tick('2026-10-17T00:10:00+09:00');assert.deepEqual(d.observe('acct',{krCash:353500-139000,usCash:100,fx:1390}).map(f=>[f.market,f.amount,f.transfer]),[['KR',-139000,true],['US',100,true]],'a currency exchange is a transfer');
});
test('a U.S. fill without both U.S. readings is not judged; a U.S. deposit is recorded in dollars',()=>{
  const {d,tick}=setup();d.observe('acct',{krCash:500000});
  tick('2026-10-16T23:40:00+09:00');assert.deepEqual(d.observe('acct',{krCash:153000,orders:[{market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:250,createdAt:at('2026-10-16T23:35:00+09:00')}]}),[],'waits for U.S. cash');
  assert.deepEqual(flowsFrom({KR:0,US:500},1390),[{market:'US',amount:500}]);
});
test('confirming a detected flow keeps it and clears the flag; day sums count deposits less withdrawals',()=>{
  const {d,perf,tick}=setup();d.observe('acct',{krCash:505000});tick('2026-10-16T09:50:00+09:00');d.observe('acct',{krCash:1505000});tick('2026-10-16T12:00:00+09:00');const [flow]=d.observe('acct',{krCash:1505000});
  perf.confirmFlow('acct',flow.id);const saved=perf.flows('acct')[0];assert.equal(saved.detected,undefined);assert.ok(saved.confirmedAt);
  perf.addFlow('acct',{day:'2026-10-16',market:'KR',amount:-200000,note:'Withdrawal'});assert.equal(perf.flowsOn('acct','2026-10-16','KR'),800000);assert.equal(perf.flowsOn('acct','2026-10-16','US'),0);
  assert.throws(()=>perf.confirmFlow('acct','missing'),/INVALID_FLOW/);
});
test('the daily loss baseline includes the day\'s deposits, so a deposit does not hide a loss',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const snapshot={accountKey:'acct:KR',environment:'live',reportedTotal:500000,cash:500000,holdings:[]};
  const e=new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>{}},()=>({status:'connected',snapshot}),{market:'KR'});
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30000}},'ENABLE LIVE');
  e.flowsToday=()=>1000000;e.observeBalance({...snapshot,reportedTotal:1450000});
  const loss=e.getState().loss;assert.equal(loss.loss,50000,'₩1.5m deposited-adjusted start, ₩1.45m now');assert.equal(loss.breached,true);
});
// KIS exchanges won into dollars to settle U.S. buys bought with KRW funding. The two sides can arrive
// seconds apart; the old detector reported a deposit and a withdrawal.
function settling(){let now=at('2026-10-20T08:20:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);const notes=[];d.onNote=t=>notes.push(t);
  const read=(s,v)=>{now=at(s);return d.observe('acct',{fx:1331.3,orders:[],...v});};return {d,perf,read,notes};}
const UNSETTLED=728915,UNKNOWN=726610;
test('fix: an automatic exchange that completes a transfer already recorded is not counted again',()=>{
  const {perf,read,notes}=settling();
  perf.addFlow('acct',{day:'2026-10-17',market:'KR',amount:-728915,transfer:true,note:'recorded at your request'});perf.addFlow('acct',{day:'2026-10-17',market:'US',amount:533.84,transfer:true,note:'recorded at your request'});
  const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  assert.deepEqual(read('2026-10-20T08:20:00+09:00',{krCash:1236450,usCash:0,...base}),[]);
  assert.deepEqual(read('2026-10-20T08:24:30+09:00',{krCash:1236450,usCash:543.69,...base}),[],'the U.S. side alone is held, not a deposit');
  assert.deepEqual(read('2026-10-20T08:25:30+09:00',{krCash:512640,usCash:543.69,...base}),[],'the Korean side offsets it at the rate');
  assert.deepEqual(read('2026-10-20T08:26:00+09:00',{krCash:512640,usCash:0,provisionalKRW:0,unsettledKRW:0}),[],'settlement spends the dollars');
  assert.deepEqual(read('2026-10-20T12:00:00+09:00',{krCash:512640,usCash:0}),[]);
  const flows=perf.flows('acct');assert.equal(flows.length,2,'only the recorded pair');assert.ok(flows.every(f=>f.exchangedAt&&f.exchange.KRW===-723810&&f.exchange.USD===543.69),'marked as exchanged');
  assert.ok(notes.includes('Currency exchange matched'));
});
test('fix: without a recorded transfer the same exchange is one transfer pair, and nothing is detected',()=>{
  const {perf,read}=settling();const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  read('2026-10-20T08:20:00+09:00',{krCash:1236450,usCash:0,...base});read('2026-10-20T08:24:30+09:00',{krCash:1236450,usCash:543.69,...base});
  const pair=read('2026-10-20T08:25:30+09:00',{krCash:512640,usCash:543.69,...base});assert.deepEqual(pair.map(f=>[f.market,f.amount,f.transfer,f.source]),[['KR',-723810,true,'exchange'],['US',543.69,true,'exchange']]);
  read('2026-10-20T08:26:00+09:00',{krCash:512640,usCash:0,provisionalKRW:0,unsettledKRW:0});read('2026-10-20T12:00:00+09:00',{krCash:512640,usCash:0});
  assert.equal(perf.flows('acct').filter(f=>f.detected).length,0);
});
test('fix: a Korean payment for U.S. buys whose funding was unknown waits for the settlement it matches',()=>{
  const {perf,read,notes}=settling();const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  read('2026-10-20T08:20:00+09:00',{krCash:1236450,usCash:0,...base});
  assert.deepEqual(read('2026-10-20T08:25:00+09:00',{krCash:512640,usCash:0,...base}),[]);
  assert.deepEqual(read('2026-10-20T11:00:00+09:00',{krCash:512640,usCash:0,...base}),[],'past the hold, but it could still be the settlement');
  assert.deepEqual(read('2026-10-20T11:05:00+09:00',{krCash:512640,usCash:0,provisionalKRW:0,unsettledKRW:0}),[],'the settlement explains it');
  assert.ok(notes.includes('Settlement matched'));assert.equal(perf.flows('acct').length,0);
});
test('fix: a balance that returns to where it was leaves nothing to record (a rise and the same fall)',()=>{
  const {perf,read,notes}=settling();read('2026-10-19T00:00:00+09:00',{krCash:512640,usCash:0});
  assert.deepEqual(read('2026-10-19T00:06:00+09:00',{krCash:693780,usCash:0}),[]);assert.deepEqual(read('2026-10-19T00:52:00+09:00',{krCash:512640,usCash:0}),[]);
  read('2026-10-19T06:00:00+09:00',{krCash:512640,usCash:0});assert.equal(perf.flows('acct').length,0);assert.ok(notes.includes('Cash change reversed'));
});
test('fix: deposits and withdrawals that coincide are still recorded; an exchange is not swallowed by an earlier one',()=>{
  const {perf,read}=settling();read('2026-10-21T09:00:00+09:00',{krCash:500000,usCash:100});
  read('2026-10-21T09:01:00+09:00',{krCash:1000000,usCash:100});read('2026-10-21T09:02:00+09:00',{krCash:1000000,usCash:-100});
  const found=read('2026-10-21T11:30:00+09:00',{krCash:1000000,usCash:-100});assert.deepEqual(found.map(f=>[f.market,f.amount,f.detected]),[['KR',500000,true],['US',-200,true]],'₩500,000 in and $200 out do not offset at the rate');
  // Two identical manual exchanges with no U.S. settlement in view: each is its own transfer.
  read('2026-10-21T12:00:00+09:00',{krCash:861000,usCash:4.4});const again=read('2026-10-21T13:00:00+09:00',{krCash:722000,usCash:108.8});
  assert.deepEqual(again.map(f=>[f.market,f.amount,f.transfer]),[['KR',-139000,true],['US',104.4,true]]);
  assert.equal(perf.flows('acct').filter(f=>f.transfer).length,4);
});
