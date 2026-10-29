const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {FlowDetector,flowsFrom}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const at=s=>Date.parse(s);
function setup(){let now=at('2026-10-23T08:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);return {d,perf,tick:s=>{now=at(s);}};}
const buy=(createdAt,filled,price,extra={})=>({market:'KR',side:'Buy',status:'Filled',filled,fillPrice:price,createdAt:at(createdAt),...extra});
test('a deposit no trade explains is recorded as a detected flow once it has stood; a reconciled buy is not',()=>{
  const {d,perf,tick}=setup();assert.deepEqual(d.observe('acct',{krCash:500001}),[],'the first reading only sets the baseline');
  tick('2026-10-23T09:50:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1500001}),[],'held as provisional first');assert.deepEqual(d.pending('acct').map(p=>[p.market,p.amount]),[['KR',1000000]]);
  tick('2026-10-23T11:50:00+09:00');const [flow]=d.observe('acct',{krCash:1500001});assert.deepEqual(d.pending('acct'),[]);
  assert.deepEqual({day:flow.day,market:flow.market,amount:flow.amount,detected:flow.detected},{day:'2026-10-23',market:'KR',amount:1000000,detected:true});assert.match(flow.note,/Korean cash rose/);
  // The 10:03 buy: cash falls by its net cost, explained by the reconciled fill.
  tick('2026-10-23T12:10:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1319074,orders:[buy('2026-10-23T12:03:41+09:00',3,60300,{resultCosts:{netCash:-180927}})]}),[]);
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
  tick('2026-10-23T11:00:00+09:00');assert.deepEqual(d.observe('acct',{krCash:700000,usCash:0}),[]);tick('2026-10-23T13:00:00+09:00');const [w]=d.observe('acct',{krCash:700000,usCash:0});assert.equal(w.amount,-300000);
  tick('2026-10-23T14:00:00+09:00');assert.deepEqual(d.observe('acct',{krCash:700500,usCash:0}),[],'₩500 (for example a small dividend) is below the threshold');
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
  const {d,perf,tick}=setup();d.observe('acct',{krCash:500001});tick('2026-10-23T09:50:00+09:00');d.observe('acct',{krCash:1500001});tick('2026-10-23T12:00:00+09:00');const [flow]=d.observe('acct',{krCash:1500001});
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
// The Oct 26-27 readings: KIS exchanged ₩715,840 into $537.70 (at ₩1,331.3) to settle the Oct 23 U.S. buys. The
// two sides arrived 45 seconds apart; the old detector reported a deposit and a withdrawal.
function settling(){let now=at('2026-10-27T08:20:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);const notes=[];d.onNote=t=>notes.push(t);
  const read=(s,v)=>{now=at(s);return d.observe('acct',{fx:1331.3,orders:[],...v});};return {d,perf,read,notes};}
const UNSETTLED=714383,UNKNOWN=712078;
test('fix: an automatic exchange that completes a transfer already recorded is not counted again',()=>{
  const {perf,read,notes}=settling();
  perf.addFlow('acct',{day:'2026-10-24',market:'KR',amount:-714383,transfer:true,note:'recorded at your request'});perf.addFlow('acct',{day:'2026-10-24',market:'US',amount:539.32,transfer:true,note:'recorded at your request'});
  const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  assert.deepEqual(read('2026-10-27T08:20:00+09:00',{krCash:1213071,usCash:0,...base}),[]);
  assert.deepEqual(read('2026-10-27T08:24:52+09:00',{krCash:1213071,usCash:537.7,...base}),[],'the U.S. side alone is held, not a deposit');
  assert.deepEqual(read('2026-10-27T08:25:37+09:00',{krCash:497231,usCash:537.7,...base}),[],'the Korean side offsets it at the rate');
  assert.deepEqual(read('2026-10-27T08:25:58+09:00',{krCash:497231,usCash:0,provisionalKRW:0,unsettledKRW:0}),[],'settlement spends the dollars');
  assert.deepEqual(read('2026-10-27T12:00:00+09:00',{krCash:497231,usCash:0}),[]);
  const flows=perf.flows('acct');assert.equal(flows.length,2,'only the recorded pair');assert.ok(flows.every(f=>f.exchangedAt&&f.exchange.KRW===-715840&&f.exchange.USD===537.7),'marked as exchanged');
  assert.ok(notes.includes('Currency exchange matched'));
});
test('fix: without a recorded transfer the same exchange is one transfer pair, and nothing is detected',()=>{
  const {perf,read}=settling();const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  read('2026-10-27T08:20:00+09:00',{krCash:1213071,usCash:0,...base});read('2026-10-27T08:24:52+09:00',{krCash:1213071,usCash:537.7,...base});
  const pair=read('2026-10-27T08:25:37+09:00',{krCash:497231,usCash:537.7,...base});assert.deepEqual(pair.map(f=>[f.market,f.amount,f.transfer,f.source]),[['KR',-715840,true,'exchange'],['US',537.7,true,'exchange']]);
  read('2026-10-27T08:25:58+09:00',{krCash:497231,usCash:0,provisionalKRW:0,unsettledKRW:0});read('2026-10-27T12:00:00+09:00',{krCash:497231,usCash:0});
  assert.equal(perf.flows('acct').filter(f=>f.detected).length,0);
});
test('fix: a Korean payment for U.S. buys whose funding was unknown waits for the settlement it matches',()=>{
  const {perf,read,notes}=settling();const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  read('2026-10-27T08:20:00+09:00',{krCash:1213071,usCash:0,...base});
  assert.deepEqual(read('2026-10-27T08:25:00+09:00',{krCash:497231,usCash:0,...base}),[]);
  assert.deepEqual(read('2026-10-27T11:00:00+09:00',{krCash:497231,usCash:0,...base}),[],'past the hold, but it could still be the settlement');
  assert.deepEqual(read('2026-10-27T11:05:00+09:00',{krCash:497231,usCash:0,provisionalKRW:0,unsettledKRW:0}),[],'the settlement explains it');
  assert.ok(notes.includes('Settlement matched'));assert.equal(perf.flows('acct').length,0);
});
test('fix: a balance that returns to where it was leaves nothing to record (Oct 26, +/- ₩180,920)',()=>{
  const {perf,read,notes}=settling();read('2026-10-26T00:00:00+09:00',{krCash:497231,usCash:0});
  assert.deepEqual(read('2026-10-26T00:06:21+09:00',{krCash:678151,usCash:0}),[]);assert.deepEqual(read('2026-10-26T00:52:22+09:00',{krCash:497231,usCash:0}),[]);
  read('2026-10-26T06:00:00+09:00',{krCash:497231,usCash:0});assert.equal(perf.flows('acct').length,0);assert.ok(notes.includes('Cash change reversed'));
});
test('fix: deposits and withdrawals that coincide are still recorded; an exchange is not swallowed by an earlier one',()=>{
  const {perf,read}=settling();read('2026-10-28T09:00:00+09:00',{krCash:500000,usCash:100});
  read('2026-10-28T09:01:00+09:00',{krCash:1000000,usCash:100});read('2026-10-28T09:02:00+09:00',{krCash:1000000,usCash:-100});
  const found=read('2026-10-28T11:30:00+09:00',{krCash:1000000,usCash:-100});assert.deepEqual(found.map(f=>[f.market,f.amount,f.detected]),[['KR',500000,true],['US',-200,true]],'₩500,000 in and $200 out do not offset at the rate');
  // Two identical manual exchanges with no U.S. settlement in view: each is its own transfer.
  read('2026-10-28T12:00:00+09:00',{krCash:861000,usCash:4.4});const again=read('2026-10-28T13:00:00+09:00',{krCash:722000,usCash:108.8});
  assert.deepEqual(again.map(f=>[f.market,f.amount,f.transfer]),[['KR',-139000,true],['US',104.4,true]]);
  assert.equal(perf.flows('acct').filter(f=>f.transfer).length,4);
});
// Review of 4b05851..77a5c4f.
test('review P1: a settlement paid in the reading where it settles leaves no evidence to hide a later withdrawal',()=>{
  const {perf,read}=settling();const due={provisionalKRW:100000,unsettledKRW:100000},done={provisionalKRW:0,unsettledKRW:0};
  read('2026-10-28T08:00:00+09:00',{krCash:1000000,usCash:0,...due});
  assert.deepEqual(read('2026-10-28T09:00:00+09:00',{krCash:900000,usCash:0,...done}),[],'the ₩100,000 settlement');
  assert.deepEqual(read('2026-10-28T10:00:00+09:00',{krCash:800000,usCash:0,...done}),[],'a real withdrawal, held first');
  const [w]=read('2026-10-28T12:30:00+09:00',{krCash:800000,usCash:0,...done});assert.deepEqual([w.market,w.amount,w.detected],['KR',-100000,true],'and recorded: the old code discarded it as settlement');
});
test('review P1: a payment seen after its settlement uses the outstanding amount once; a fall that does not match is kept',()=>{
  const due={provisionalKRW:100000,unsettledKRW:100000},done={provisionalKRW:0,unsettledKRW:0};
  {const {perf,read,notes}=settling();read('2026-10-28T08:00:00+09:00',{krCash:1000000,usCash:0,...due});read('2026-10-28T09:00:00+09:00',{krCash:1000000,usCash:0,...done});
    read('2026-10-28T09:05:00+09:00',{krCash:900000,usCash:0,...done});assert.ok(notes.includes('Settlement matched'));
    read('2026-10-28T10:00:00+09:00',{krCash:800000,usCash:0,...done});const [w]=read('2026-10-28T12:30:00+09:00',{krCash:800000,usCash:0,...done});assert.equal(w.amount,-100000,'the record was used up');assert.equal(perf.flows('acct').length,1);}
  {const {perf,read,notes}=settling();read('2026-10-28T08:00:00+09:00',{krCash:1000000,usCash:0,...due});read('2026-10-28T09:00:00+09:00',{krCash:1000000,usCash:0,...done});
    read('2026-10-28T09:05:00+09:00',{krCash:700000,usCash:0,...done});const [w]=read('2026-10-28T11:30:00+09:00',{krCash:700000,usCash:0,...done});
    assert.equal(w.amount,-300000,'₩300,000 does not match ₩100,000 outstanding: kept, not deleted');assert.ok(!notes.includes('Settlement matched'));}
  {const {perf,read}=settling();read('2026-10-28T08:00:00+09:00',{krCash:1000000,usCash:0,...due});read('2026-10-28T09:00:00+09:00',{krCash:1000000,usCash:0,...done});
    read('2026-10-29T10:00:00+09:00',{krCash:900000,usCash:0,...done});const [w]=read('2026-10-29T12:30:00+09:00',{krCash:900000,usCash:0,...done});assert.equal(w.amount,-100000,'evidence older than a day explains nothing');}
});
test('review P1: dollars from an exchange spent at settlement reverse the held U.S. rise; the Korean side is the payment',()=>{
  const {perf,read}=settling();const base={provisionalKRW:UNKNOWN,unsettledKRW:UNSETTLED};
  read('2026-10-27T08:20:00+09:00',{krCash:1213071,usCash:0,...base});read('2026-10-27T08:24:52+09:00',{krCash:1213071,usCash:537.7,...base});
  assert.deepEqual(read('2026-10-27T08:25:37+09:00',{krCash:497231,usCash:0,provisionalKRW:0,unsettledKRW:0}),[]);
  read('2026-10-27T12:00:00+09:00',{krCash:497231,usCash:0});read('2026-10-27T13:00:00+09:00',{krCash:400000,usCash:0});const [w]=read('2026-10-27T15:30:00+09:00',{krCash:400000,usCash:0});
  assert.equal(perf.flows('acct').filter(f=>f.amount!==-97231).length,0,'nothing recorded for the exchange or the settlement');assert.equal(w.amount,-97231,'and no evidence left to hide a later withdrawal');
});
test('review P2: a held change returned gradually in small steps leaves nothing, in both currencies; a partial return is recorded net',()=>{
  const {perf,read,notes}=settling();const at=(h,m)=>`2026-10-28T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`;
  read(at(9,0),{krCash:500000,usCash:100});read(at(9,1),{krCash:600000,usCash:200});
  for(let k=1;k<=20;k++)read(at(9,1+k*3),{krCash:600000-k*5000,usCash:200-k*5});
  assert.deepEqual(read(at(12,0),{krCash:500000,usCash:100}),[],'₩100,000 and $100 returned in ₩5,000 and $5 steps');assert.equal(perf.flows('acct').length,0);assert.ok(notes.includes('Cash change reversed'));
  const half=settling();half.read(at(9,0),{krCash:500000,usCash:100});half.read(at(9,1),{krCash:600000,usCash:200});
  for(let k=1;k<=10;k++)half.read(at(9,1+k*3),{krCash:600000-k*5000,usCash:200-k*5});
  assert.deepEqual(half.read(at(12,0),{krCash:550000,usCash:150}).map(f=>[f.market,f.amount]),[['KR',50000],['US',50]],'the accumulated difference, not the first jump');
});
// Oct 28: the one-share Pentair buy was proposed at 00:25:20, submitted at 00:25:26 and filled at about 03:45. A reading
// saved while it was only proposed put its creation time before the comparison window, so the fill was never matched
// and the KRW funding (₩81,855) was recorded as a withdrawal at 05:46.
const pnr=(status,filled)=>({id:'pnr',market:'US',side:'Buy',symbol:'NYSE:PNR',status,filled,fillPrice:filled?61.56:null,...(filled?{resultCosts:{netCash:-61.71},filledObservedAt:at('2026-10-28T03:45:19+09:00')}:{}),createdAt:at('2026-10-28T00:25:20+09:00')});
test('fills are matched by what changed since the last reading: a fill hours after the order is still explained (Pentair)',()=>{
  const {perf,read}=settling();
  read('2026-10-28T00:20:00+09:00',{krCash:497231,usCash:0});
  assert.deepEqual(read('2026-10-28T00:25:23+09:00',{krCash:497231,usCash:0,orders:[pnr('Ready',0)]}),[],'a reading between proposal and submission');
  assert.deepEqual(read('2026-10-28T01:00:00+09:00',{krCash:497231,usCash:0,orders:[pnr('Accepted',0)]}),[],'waits while open');
  const found=read('2026-10-28T03:45:30+09:00',{krCash:497231-81855,usCash:0,unsettledKRW:81855,orders:[pnr('Filled',1)]});
  assert.deepEqual(found.map(f=>[f.market,f.amount,f.transfer,f.awaitingExchange]),[['KR',-81855,true,true],['US',61.71,true,true]],'integrated-margin funding, not a withdrawal');
  assert.deepEqual(read('2026-10-28T06:00:00+09:00',{krCash:497231-81855,usCash:0,unsettledKRW:81855,orders:[pnr('Filled',1)]}),[],'the same fill is not explained twice');
  assert.equal(perf.flows('acct').filter(f=>f.detected).length,0);
});
test('fills matched by change: an order filled before it was tracked is not counted again; readings from before fills were kept still work',()=>{
  {const {perf,read}=settling();read('2026-10-28T09:00:00+09:00',{krCash:500000,usCash:0});
    // The U.S. orders were not loaded at the first reading; the Pentair order had already been seen filled before it.
    const late={...pnr('Filled',1),filledObservedAt:at('2026-10-28T08:00:00+09:00')};
    assert.deepEqual(read('2026-10-28T09:01:00+09:00',{krCash:500000,usCash:0,orders:[late]}),[]);read('2026-10-28T11:30:00+09:00',{krCash:500000,usCash:0,orders:[late]});
    assert.equal(perf.flows('acct').length,0,'no phantom U.S. deposit from an old fill');}
  {const db=new DatabaseSync(':memory:');let now=at('2026-10-28T09:00:00+09:00');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);
    db.prepare('INSERT INTO flow_watch VALUES(?,?)').run('acct',JSON.stringify({at:now,krCash:1000000,usCash:0,basis:'net-of-confirmed',provisionalKRW:0,unsettledKRW:0}));now+=60000;
    const kr={id:'k',market:'KR',side:'Buy',symbol:'005930',status:'Filled',filled:1,fillPrice:200000,resultCosts:{netCash:-200030},createdAt:now-30000};
    assert.deepEqual(d.observe('acct',{krCash:799970,usCash:0,orders:[kr]}),[],'an older saved reading falls back to orders placed in between');
    now+=60000;assert.deepEqual(d.observe('acct',{krCash:799970,usCash:0,orders:[kr]}),[]);now+=3*3600000;assert.deepEqual(d.observe('acct',{krCash:799970,usCash:0,orders:[kr]}),[]);}
});
// Review of 40d7666..c276de6 (accounting). P1: after a restart the U.S. orders are not loaded until the U.S. balance is;
// a reading saved then (no U.S. cash, only Korean fills) made a partly filled, cancelled U.S. order look new, and with
// no U.S. cash in that reading detection waited forever. A ₩1,000,000 deposit was never recorded.
test('review P1: a restart before the U.S. account loads does not stop detection',()=>{
  const {perf,read}=settling();const cancelled={id:'gx',market:'US',symbol:'NASD:GOOGL',side:'Buy',quantity:2,filled:1,fillPrice:320,status:'Canceled',resultCosts:{netCash:-320.5},createdAt:at('2026-10-27T23:00:00+09:00')};
  read('2026-10-28T08:00:00+09:00',{krCash:500000,usCash:100,orders:[cancelled]});
  read('2026-10-28T10:00:00+09:00',{krCash:500000,usCash:null,orders:[]});
  read('2026-10-28T10:01:00+09:00',{krCash:500000,usCash:100,orders:[cancelled]});
  read('2026-10-28T11:00:00+09:00',{krCash:1500000,usCash:100,orders:[cancelled]});
  const found=read('2026-10-28T15:30:00+09:00',{krCash:1500000,usCash:100,orders:[cancelled]});assert.deepEqual(found.map(f=>[f.market,f.amount,f.detected]),[['KR',1000000,true]]);
  // Never seen before at all (filled before fills were kept), first seen with the U.S. account: a new U.S. baseline.
  const t=settling();t.read('2026-10-28T10:00:00+09:00',{krCash:500000,usCash:null,orders:[]});t.read('2026-10-28T10:01:00+09:00',{krCash:500000,usCash:100,orders:[cancelled]});
  t.read('2026-10-28T11:00:00+09:00',{krCash:1500000,usCash:100,orders:[cancelled]});assert.deepEqual(t.read('2026-10-28T15:30:00+09:00',{krCash:1500000,usCash:100,orders:[cancelled]}).map(f=>[f.market,f.amount]),[['KR',1000000]]);
  assert.equal(perf.flows('acct').filter(f=>f.market==='US').length,0,'the old U.S. fill is not a deposit');
});
// Review of 7dc8395, P1: the first reading with U.S. cash reset the whole comparison, so a Korean deposit in the same
// interval was lost.
test('review P1: the reading where the U.S. balance first loads still compares Korean cash',()=>{
  const {d,perf,read}=settling();read('2026-10-28T10:00:00+09:00',{krCash:1000000,usCash:null});
  assert.deepEqual(read('2026-10-28T10:01:00+09:00',{krCash:1500000,usCash:0}),[]);
  assert.deepEqual(d.pending('acct').map(p=>[p.market,p.amount,p.usBalanceUnseen]),[['KR',500000,true]],'held, marked as seen without the U.S. side');
  const found=read('2026-10-28T12:30:00+09:00',{krCash:1500000,usCash:0});assert.deepEqual(found.map(f=>[f.market,f.amount,f.detected]),[['KR',500000,true]]);
  assert.match(found[0].note,/U\.S\. balance was not loaded/,'the user is told the U.S. side was not seen');
  assert.equal(perf.flows('acct').filter(f=>f.market==='US').length,0,'the U.S. baseline starts here');
  // A U.S. fill in the same interval is still not judged against U.S. cash; the Korean side alone is compared.
  const t=settling();const g={id:'g',market:'US',symbol:'NASD:GOOGL',side:'Buy',quantity:1,filled:1,fillPrice:300,status:'Filled',createdAt:at('2026-10-28T09:59:00+09:00')};
  t.read('2026-10-28T10:00:00+09:00',{krCash:1000000,usCash:null});t.read('2026-10-28T10:01:00+09:00',{krCash:1000000,usCash:200,orders:[g]});
  assert.deepEqual(t.read('2026-10-28T12:30:00+09:00',{krCash:1000000,usCash:200,orders:[g]}),[],'no change, nothing recorded');
  // A later U.S. change is compared against the new baseline.
  assert.deepEqual(t.read('2026-10-28T12:31:00+09:00',{krCash:1000000,usCash:700,orders:[g]}),[]);assert.deepEqual(t.d.pending('acct').map(p=>[p.market,p.amount]),[['US',500]]);
});
// Review of 844904c, P2: at the first U.S. reading the U.S. side of a settlement is not seen, but it was taken as zero,
// so the whole settled amount became evidence that later hid a real withdrawal of the same size.
test('review P2: a settlement at the first U.S. reading leaves no evidence that could hide a withdrawal',()=>{
  const {perf,read,notes}=settling();read('2026-10-28T10:00:00+09:00',{krCash:5000000,usCash:null,provisionalKRW:1400000,unsettledKRW:1400000});
  read('2026-10-28T10:01:00+09:00',{krCash:5000000,usCash:300,provisionalKRW:0,unsettledKRW:0});
  read('2026-10-28T11:00:00+09:00',{krCash:3600000,usCash:300});const found=read('2026-10-28T14:00:00+09:00',{krCash:3600000,usCash:300});
  assert.deepEqual(found.map(f=>[f.market,f.amount,f.detected]),[['KR',-1400000,true]],'the withdrawal is recorded');assert.ok(!notes.includes('Settlement matched'));
  assert.equal(perf.flows('acct').length,1);
  // An open U.S. order at that reading still means it cannot be judged: nothing is held until it closes.
  const t=settling();const open={id:'o',market:'US',symbol:'NASD:NVDA',side:'Buy',quantity:1,filled:0,status:'Accepted',createdAt:at('2026-10-28T09:59:00+09:00')};
  t.read('2026-10-28T10:00:00+09:00',{krCash:1000000,usCash:null});assert.deepEqual(t.read('2026-10-28T10:01:00+09:00',{krCash:1500000,usCash:0,orders:[open]}),[]);
  assert.deepEqual(t.d.pending('acct'),[],'not compared while the order is open');
  t.read('2026-10-28T10:05:00+09:00',{krCash:1500000,usCash:0,orders:[{...open,status:'Canceled'}]});assert.deepEqual(t.d.pending('acct').map(p=>[p.market,p.amount]),[['KR',500000]],'compared once it closes');
});
test('an order cancelled or rejected after partial fills records when it was seen with its fills',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const broker={request:async op=>op==='orders'?{orders:[{orderId:'B1',filled:1,fillPrice:100,status:'Cancelled'}]}:{balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}}};
  const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot}));const order={id:'o1',symbol:'005930',side:'Buy',quantity:2,limitPrice:100,status:'Accepted',brokerOrderId:'B1',createdAt:Date.now()-60000,day:require('../electron/kis-activity.cjs').seoulDate(),accountKey:'acct',environment:'mock',market:'KR'};
  db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');try{e.save(order);}catch{db.prepare('INSERT OR REPLACE INTO live_intents VALUES(?,?)').run(order.id,JSON.stringify(order));}
  try{await e.reconcile();}catch{}const saved=e.orders().find(o=>o.id==='o1');
  assert.equal(saved?.status,'Canceled');assert.ok(Number.isFinite(saved.filledObservedAt),'fills seen with the cancellation are timed');
});
test('an unsettled U.S. sale is not a withdrawal: the U.S. reading counts its pending proceeds, so settlement is not a deposit either',()=>{
  // 2026-10-30: after the GOOGL sale filled ($279.85 net in the app's estimate) KIS kept the proceeds out of the deposit
  // (pending $279.01); reading cash alone, the detector recorded "U.S. cash fell with no matching trade", -$279.85.
  const sale={id:'g1',market:'US',side:'Sell',symbol:'NASD:GOOGL',status:'Filled',filled:1,fillPrice:280.56,resultCosts:{netCash:279.85},createdAt:at('2026-10-29T22:31:00+09:00')};
  const run=usCashAfter=>{const {d,tick}=setup();tick('2026-10-29T22:20:00+09:00');d.observe('acct',{krCash:414148,usCash:0,fx:1336.3,orders:[]});
    const out=[];for(const [time,usCash] of [['2026-10-30T00:20:00+09:00',usCashAfter],['2026-10-30T02:30:00+09:00',usCashAfter],['2026-10-30T05:00:00+09:00',usCashAfter],['2026-10-31T09:00:00+09:00',279.01]]){tick(time);out.push(...d.observe('acct',{krCash:414148,usCash,fx:1336.3,orders:[{...sale,filledObservedAt:at('2026-10-30T00:18:39+09:00')}]}));}
    return {flows:out,pending:d.pending('acct')};};
  const before=run(0);assert.equal(before.flows[0]?.amount,-279.85,'cash alone: the false withdrawal, reproduced');
  const now=run(0+279.01);assert.deepEqual(now.flows,[],'cash plus pending proceeds: nothing to record, through the sale and its settlement');assert.deepEqual(now.pending,[]);
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');assert.match(src,/usCash:usSnapshot\?\.accountKey===s\.accountKey\+':US'\?usSnapshot\.cash\+\(usSnapshot\.pendingSaleProceeds\?\?0\):null/);
});
