// K1 step (multi-order, artifacts/reviews/2026-11-16-multi-order/m1/k1-design.md, cleared with C1-C3): a U.S. buy KIS
// reports is owed in the U.S. for the part U.S. money can pay, USD first (cash and pending proceeds less only what settles
// before or with it); only the rest of KIS's KRW is the KRW part, booked at the report as the transfer pair. At
// settlement the U.S. part settles as a 'us' group, the KRW part as K1. The provisional pair: a U.S. buy outside the app
// that KIS paid in KRW is booked as a transfer only at the Korean fall that pays its P1 entry.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FundingTransfers}=require('../electron/funding-transfers.cjs');
const FX=1340,K=s=>Date.parse(s+'+09:00');
function rig(){const db=new DatabaseSync(':memory:');let t=K('2026-11-09T23:00:00');const clock=()=>t,notes=[];const perf=new PerformanceHistory(db,clock);
  const f=new FundingTransfers(db,{performance:perf,clock,log:(a,b)=>notes.push(b)});
  const b=(id,usd)=>({id,side:'Buy',filled:1,fillPrice:usd,market:'US',accountKey:'A:US',createdAt:t,filledObservedAt:t,resultCosts:{netCash:-usd}});
  return {db,f,notes,b,to:s=>{t=K(s);},
    us:(cash,buyKRW,orders,x={})=>f.observeUS('A',{us:{cash,pendingSaleProceeds:x.pending??0,unsettled:{buyKRW,sellKRW:0}},orders,fx:FX,openOrderIds:new Set(x.open??[]),openBuysUSD:x.openUSD??0}),
    kr:settled=>f.observeKR('A',{korea:{cash:settled,settledCash:settled}}),
    row:k=>f.rows('A').find(r=>r.key===k),flows:()=>perf.flows('A').map(x=>[x.id.replace('funding:',''),x.market,x.amount])};}
// One $100 buy (₩134,000 at 1,340) with U.S. cash `cash`, reported the next morning.
function reported(cash){const w=rig();w.us(cash,0,[]);w.kr(3000000);w.to('2026-11-09T23:41:00');const o=w.b('o1',100);w.us(cash,0,[o],{open:['o1'],openUSD:100});
  w.to('2026-11-10T09:00:00');w.us(cash,134000,[o]);return {w,o};}

test('K1 step at the report: $50 of U.S. cash pays $50 (owed in the U.S.); the rest of KIS\'s KRW is the pair, booked now',()=>{
  const {w}=reported(50),c=w.f.current('A'),r=w.row('o1');
  assert.equal(r.state,'krw');assert.equal(r.usOwedUSD,50);assert.equal(c.usUSD,50,'the U.S. part with the U.S. groups');assert.equal(c.usReportedKRW,67000);
  assert.equal(c.krwKRW,67000,'the KRW part');assert.equal(c.krwUnpaidKRW,67000,'deducted in Korea until its fall');
  assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50]]);assert.deepEqual(c.explained,{KR:-67000,US:50});
  // The ends are today's branches: all U.S. money (no pair), none (the whole K1 pair).
  assert.equal(reported(500).w.row('o1').state,'us');assert.deepEqual(reported(500).w.flows(),[]);
  {const {w:v}=reported(0);assert.equal(v.row('o1').state,'krw');assert.equal(v.row('o1').usShare,undefined);assert.deepEqual(v.flows(),[['o1:out','KR',-134000],['o1:in','US',100]]);}
});
test('K1 step settlement, y = u: the U.S. part paid by KIS\'s $50 debit; the KRW part by the Korean fall; nothing else booked',()=>{
  const {w,o}=reported(50);w.to('2026-11-11T08:25:00');w.us(0,0,[o]);
  assert.equal(w.row('o1#us').state,'booked');assert.equal(w.row('o1#us').via,'usd');assert.equal(w.row('o1').state,'awaiting-kr');assert.equal(w.f.current('A').krwUnpaidKRW,67000);
  w.to('2026-11-11T08:30:00');w.kr(2933000);assert.equal(w.row('o1').state,'booked');assert.equal(w.row('o1').via,'krw');assert.equal(w.f.current('A').krwUnpaidKRW,0);
  assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50]]);
});
test('K1 step settlement, y > u: KIS paid it all in USD after all (a deposit before settlement): the pair is reversed in full',()=>{
  const {w,o}=reported(50);w.to('2026-11-10T20:00:00');w.us(150,134000,[o]);w.to('2026-11-11T08:25:00');w.us(50,0,[o]);
  assert.equal(w.row('o1#us').state,'booked');assert.equal(w.row('o1').state,'booked');assert.equal(w.row('o1').via,'reversal');
  assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50],['o1:reversal-out','US',-50],['o1:reversal-in','KR',67000]]);assert.equal(w.f.current('A').krwUnpaidKRW,0);
});
test('K1 step settlement, y < u with U.S. cash used up: the rest of the U.S. part is exchanged with the KRW part, one Korean fall pays both',()=>{
  const {w,o}=reported(50);w.to('2026-11-10T20:00:00');w.us(30,134000,[o]);w.to('2026-11-11T08:25:00');w.us(0,0,[o]);
  assert.equal(w.row('o1#us').state,'awaiting-krw');assert.equal(w.row('o1#us').shortfallUSD,20);assert.equal(w.row('o1').state,'awaiting-kr');
  w.to('2026-11-11T08:30:00');w.kr(3000000-67000-26800);
  assert.equal(w.row('o1#us').state,'booked');assert.equal(w.row('o1#us').via,'exchange');assert.equal(w.row('o1').state,'booked');assert.equal(w.row('o1').via,'krw');
  assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50],['o1#us:out','KR',-26800],['o1#us:in','US',20]]);
});
test('K1 step settlement, y < u with U.S. cash left: the U.S. part waits for KIS\'s late debit; the KRW part for its fall',()=>{
  const {w,o}=reported(50);w.to('2026-11-11T08:20:00');w.us(50,0,[o]);assert.equal(w.row('o1#us').state,'awaiting-krw');assert.equal(w.f.current('A').usAwaitingUSD,50,'still owed in the U.S.');
  w.to('2026-11-11T08:24:00');w.us(0,0,[o]);assert.equal(w.row('o1#us').state,'booked');assert.equal(w.row('o1#us').via,'usd');
  w.to('2026-11-11T08:30:00');w.kr(2933000);assert.equal(w.row('o1').state,'booked');assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50]]);
});
test('K1 step, KIS debits the whole buy below zero and credits the exchange a reading later (W6): the U.S. part is paid by its own amount',()=>{
  const {w,o}=reported(50);w.to('2026-11-11T08:20:00');w.us(50,0,[o]);w.to('2026-11-11T08:24:00');w.us(-50,0,[o]);assert.equal(w.row('o1#us').state,'booked');
  w.to('2026-11-11T08:26:00');w.us(0,0,[o]);w.kr(2933000);assert.equal(w.row('o1').state,'booked');assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50]]);
});
test('K1 step: KIS exchanges a KRW part different from the one booked at the report: the difference is booked at that fall',()=>{
  const {w,o}=reported(50);w.to('2026-11-11T08:25:00');w.us(0,0,[o]);w.to('2026-11-11T08:30:00');w.kr(3000000-66500);
  assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50],['o1:kr-adjust','KR',500]]);assert.equal(w.f.current('A').explained.KR,-66500);
});
test('K1 step claims: only what settles before or with the set: not its own pieces, not buys filled after it',()=>{
  // $150 of U.S. cash; the $100 buy reported with its own piece still in flight, and a $120 buy filled after it.
  const w=rig();w.us(150,0,[]);w.kr(3000000);w.to('2026-11-09T23:41:00');const o=w.b('o1',100);w.us(150,0,[o],{open:['o1'],openUSD:100});
  w.to('2026-11-10T23:41:00');const p=w.b('o2',120);w.us(150,0,[o,p],{open:['o1','o2'],openUSD:220});
  w.to('2026-11-11T09:00:00');w.us(150,134000,[o,p],{open:['o2'],openUSD:120});assert.equal(w.row('o1').state,'us','all of it U.S.: the later buy settles after it');
  // A buy filled before the set and not yet reported is a claim: $150 less $80 leaves $70 for the set.
  const v=rig();v.us(150,0,[]);v.kr(3000000);v.to('2026-11-09T23:30:00');const q=v.b('q0',80);v.us(150,0,[q],{open:['q0'],openUSD:80});v.to('2026-11-09T23:41:00');const o1=v.b('o1',100);
  v.us(150,0,[q,o1],{open:['q0','o1'],openUSD:180});v.to('2026-11-10T09:00:00');v.us(150,134000,[q,o1],{open:['q0'],openUSD:80});assert.equal(v.row('o1').usOwedUSD,70);
  assert.deepEqual(v.flows(),[['o1:out','KR',-40200],['o1:in','US',30]]);
});
// C2: groups the released version stored (no usShare) settle exactly as before.
test('C2: a \'us\' and a \'krw\' group stored by 1.5.64 settle after the update exactly as 1.5.64 settles them',()=>{
  const at=K('2026-11-10T09:00:00');
  {const w=rig();w.kr(3000000);w.to('2026-11-10T09:00:00');w.f.put('A','o1',{state:'us',orders:['o1'],usd:100,reportedKRW:134000,reportedAt:at});w.f.put('A','#meta',{...w.f.meta('A'),explainedKR:0,explainedUS:0,provisionalKRW:0,startedAt:at-86400000,reportedKRW:134000,cash:50,pending:0,effects:{},usAt:at});
    const o=w.b('o1',100);w.to('2026-11-11T08:25:00');w.us(0,0,[o]);assert.equal(w.row('o1').state,'awaiting-krw');assert.equal(w.row('o1').shortfallUSD,50);
    w.to('2026-11-11T08:30:00');w.kr(2933000);assert.equal(w.row('o1').state,'booked');assert.equal(w.row('o1').via,'exchange');assert.deepEqual(w.flows(),[['o1:out','KR',-67000],['o1:in','US',50]]);}
  {const w=rig();w.kr(3000000);w.to('2026-11-10T09:00:00');w.f.put('A','o1',{state:'krw',orders:['o1'],usd:100,reportedKRW:134000,reportedAt:at,via:'report',filledAt:K('2026-11-09T23:41:00')});
    w.f.put('A','#meta',{...w.f.meta('A'),explainedKR:-134000,explainedUS:100,provisionalKRW:0,startedAt:at-86400000,reportedKRW:134000,cash:0,pending:0,effects:{},usAt:at});
    const o=w.b('o1',100);w.to('2026-11-11T08:25:00');w.us(0,0,[o]);assert.equal(w.row('o1').state,'awaiting-kr');assert.equal(w.f.current('A').krwUnpaidKRW,134000);
    w.to('2026-11-11T08:30:00');w.kr(2866000);assert.equal(w.row('o1').state,'booked');assert.equal(w.row('o1').via,'krw');assert.deepEqual(w.flows(),[]);}
});
// The provisional pair (P1's finding): a U.S. buy the user places in KIS, paid by KIS in KRW.
const {e2e}=require('./loss-funding-e2e.test.cjs');
const step=(at,note,kr,us)=>({at:K(at),note,fx:FX,kr:{settled:kr,holdings:[]},us:{holdings:[{symbol:'NYSE:OWN',quantity:1,price:100}],...us},orders:[]});
const lead=cash=>[step('2026-11-09T23:00:00','before',3000000,{cash,holdings:[]}),step('2026-11-09T23:45:00','bought',3000000,{cash}),step('2026-11-10T09:00:00','report',3000000,{cash,buyKRW:134000})];
const bookings=run=>run.flows().map(f=>[f.market,f.amount,f.transfer?'transfer':f.detected?'detected':'']);
test('the provisional pair: booked at the Korean fall that pays a P1 entry; not for a U.S.-paid part, not on expiry; never a detected flow',()=>{
  const paid=e2e([...lead(0),step('2026-11-11T08:25:00','settled',3000000,{cash:0,buyKRW:0}),step('2026-11-11T08:26:00','Korean fall',2866000,{cash:0,buyKRW:0}),step('2026-11-11T13:00:00','later',2866000,{cash:0,buyKRW:0})]);
  assert.deepEqual(bookings(paid),[['KR',-134000,'transfer'],['US',100,'transfer']]);
  const usd=e2e([...lead(500),step('2026-11-11T08:25:00','report 0, no debit yet',3000000,{cash:500,buyKRW:0}),step('2026-11-11T09:25:00','KIS debits',3000000,{cash:400,buyKRW:0}),step('2026-11-11T13:00:00','later',3000000,{cash:400,buyKRW:0})]);
  assert.deepEqual(bookings(usd),[],'paid in USD: no transfer');
  const late=e2e([...lead(0),step('2026-11-11T08:25:00','settled',3000000,{cash:0,buyKRW:0}),step('2026-11-12T09:00:00','next morning, no fall',3000000,{cash:0,buyKRW:0}),
    step('2026-11-12T09:30:00','the fall, late',2866000,{cash:0,buyKRW:0}),step('2026-11-12T13:00:00','later',2866000,{cash:0,buyKRW:0})]);
  assert.deepEqual(bookings(late),[['KR',-134000,'detected']],'expired: no pair; the fall is the detector\'s, once');
});
// The design note's seeds: 39 (plain, the report a reading before the settlement) and 22 (two batches, $125.19 of cash).
test('seeds 39 and 22: the U.S. low at its USD-first value at every reading; the KRW booked is the Korean fall KIS makes; no reversal',()=>{
  const {generate,check}=require('./multi-order-random.test.cjs');
  for(const [seed,profile,krw] of [[39,'plain-overlap',18385],[22,'mix',267397]]){assert.deepEqual(check(seed,'Buy',profile).safety,[],`seed ${seed}`);
    const g=generate(seed,'Buy',profile),run=e2e(g.steps.map(({truth,zero,...s})=>s)),legs=run.flows().filter(f=>f.transfer);
    assert.equal(-legs.filter(f=>f.market==='KR'&&f.amount<0).reduce((n,f)=>n+f.amount,0),krw,`seed ${seed}: the KRW booked`);
    assert.ok(!run.flows().some(f=>/reversal/.test(f.id)),`seed ${seed}: no reversal`);}
});
