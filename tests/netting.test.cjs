// Same-reading netting (multi-order, artifacts/reviews/2026-11-16-multi-order/m1/netting-design.md, cleared with C1-C3):
// KIS reports one figure, so a reading where one trade date settles and the next is reported moves it by the net. The
// recorder splits it into the settlement of the one oldest-first prefix of due groups the reading's U.S. cash fall pays
// (USD first) plus a new report a set of buys fits; the settlement tracker reads the same split first (peekNet). Several
// such prefixes, or none: nothing is split (never a gain). A withdrawal in that reading splits nothing.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FundingTransfers}=require('../electron/funding-transfers.cjs');
const {e2e}=require('./loss-funding-e2e.test.cjs');const {check}=require('./multi-order-random.test.cjs');
const FX=1340,KR0=3000000,K=s=>Date.parse(s+'+09:00');
const order=(id,usd,at)=>({id,market:'US',symbol:'NYSE:'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:-usd},createdAt:at,filledObservedAt:at});
const H=os=>os.map(o=>({symbol:o.symbol,quantity:1,price:o.fillPrice}));
const st=(at,note,cash,buyKRW,kr,os)=>({at:K(at),note,fx:FX,kr:{settled:kr,holdings:[]},us:{cash,holdings:H(os),buyKRW},orders:os});
// One buy a day: A ($100, ₩134,000) fills day 1, is reported 09:00; B ($75, ₩100,500) fills day 2; A settles in the 08:25
// reading that reports B; B settles the next morning. U.S. cash `cash`; KRW for what it cannot pay, its Korean fall a
// minute after each settlement.
function oneADay(cash){const A=order('A',100,K('2026-11-09T23:45:00')),B=order('B',75,K('2026-11-10T23:45:00'));
  const aUS=Math.min(cash,100),bUS=Math.min(Math.max(0,cash-aUS),75),aKR=Math.round((100-aUS)*FX),bKR=Math.round((75-bUS)*FX);
  return [st('2026-11-09T23:00:00','before',cash,0,KR0,[]),st('2026-11-09T23:50:00','A filled',cash,0,KR0,[A]),st('2026-11-10T09:00:00','A reported',cash,134000,KR0,[A]),
    st('2026-11-10T23:50:00','B filled',cash,134000,KR0,[A,B]),st('2026-11-11T08:25:00','A settled + B reported',cash-aUS,100500,KR0,[A,B]),st('2026-11-11T08:26:00','Korean fall for A',cash-aUS,100500,KR0-aKR,[A,B]),
    st('2026-11-11T12:00:00','later',cash-aUS,100500,KR0-aKR,[A,B]),st('2026-11-12T08:25:00','B settled',cash-aUS-bUS,0,KR0-aKR,[A,B]),st('2026-11-12T08:26:00','Korean fall for B',cash-aUS-bUS,0,KR0-aKR-bKR,[A,B]),
    st('2026-11-12T12:00:00','later',cash-aUS-bUS,0,KR0-aKR-bKR,[A,B]),st('2026-11-23T12:00:00','after age',cash-aUS-bUS,0,KR0-aKR-bKR,[A,B])];}
test('one buy a day (USD, KRW, mixed): A settles in the reading that reports B: right at every reading, no detected flow, both groups booked',()=>{
  for(const cash of [500,0,50]){const run=e2e(oneADay(cash)),label=`U.S. cash ${cash}`,combined=KR0+cash*FX;
    for(const r of run.out)assert.ok(Math.abs(r.value.KR.low+r.value.US.low*FX-combined)<=2,`${label} at ${r.note}: ${r.value.KR.low+r.value.US.low*FX} vs ${combined}`);
    assert.deepEqual(run.flows().filter(f=>f.detected).map(f=>[f.market,f.amount]),[],label+': no detected flow');
    assert.deepEqual(run.rec.rows('acct').filter(r=>r.orders.length&&r.state!=='booked').map(r=>[r.key,r.state]),[],label+': every group booked');}
});
test('seeds 19 (USD) and 1 (KRW, KIS\'s debit below zero), the \'same\' morning: no safety failure, no flow, right at settlement',()=>{
  for(const seed of [19,1]){const r=check(seed,'Buy','plain-overlap');assert.equal(r.desc.overlap,'same');assert.deepEqual(r.safety,[],`seed ${seed}`);assert.equal(r.flowsOff,null,`seed ${seed}`);assert.ok(r.settledRight,`seed ${seed}`);}
});
test('a withdrawal in the split reading (U.S. cash falls by more than the due groups owe): nothing is split, never above the true value',()=>{
  const seq=oneADay(500).map(x=>x.at>=K('2026-11-11T08:25:00')?{...x,us:{...x.us,cash:x.us.cash-50}}:x),run=e2e(seq);
  for(const [i,r] of run.out.entries()){const truth=KR0+(seq[i].at>=K('2026-11-11T08:25:00')?450:500)*FX;assert.ok(r.value.KR.low+r.value.US.low*FX<=truth+2,`at ${r.note}`);}
  const mid=e2e(seq.slice(0,5));assert.equal(mid.rec.rows('acct').find(r=>r.key==='A').state,'us','A not settled by the split');assert.ok(!mid.rec.rows('acct').some(r=>r.key==='B'),'B not booked by the split');
});
// The recorder alone (no tracker): two K1 groups due and two new buys, each prefix with its own fitting remainder.
function rig(){const db=new DatabaseSync(':memory:');let t=K('2026-11-09T23:00:00');const clock=()=>t,perf=new PerformanceHistory(db,clock),f=new FundingTransfers(db,{performance:perf,clock});
  return {f,to:s=>{t=K(s);},us:(cash,R,orders,open=[])=>f.observeUS('A',{us:{cash,unsettled:{buyKRW:R,sellKRW:0}},orders,fx:FX,openOrderIds:new Set(open),openBuysUSD:0}),
    kr:v=>f.observeKR('A',{korea:{cash:v,settledCash:v}}),rows:()=>f.rows('A').map(r=>[r.key,r.state]).sort(),flows:()=>perf.flows('A').map(x=>x.id)};}
test('several prefixes fit (each with a new report that fits): nothing is split; a remainder below -₩10,000 splits nothing',()=>{
  const w=rig();w.us(0,0,[]);w.kr(KR0);const a=order('a',100,K('2026-11-09T23:40:00')),b=order('b',60,K('2026-11-09T23:41:00'));w.to('2026-11-09T23:45:00');w.us(0,0,[a,b],['a','b']);
  w.to('2026-11-10T09:00:00');w.us(0,134000,[a,b],['b']);w.to('2026-11-10T09:30:00');w.us(0,214400,[a,b]);
  const c=order('c',70,K('2026-11-10T23:40:00')),d=order('d',130,K('2026-11-10T23:41:00'));w.to('2026-11-10T23:45:00');w.us(0,214400,[a,b,c,d]);
  const before=w.rows();w.to('2026-11-11T08:25:00');w.us(0,174400,[a,b,c,d]);// ₩40,000 down: [a] + c (₩93,800), or [a, b] + d (₩174,200)
  assert.deepEqual(w.rows(),before,'nothing settled, nothing booked');
  // USD: the due group owes $100 and U.S. cash fell $100, but KIS's total fell ₩150,000 (₩166,000 of it unattributed): the
  // remainder is -₩16,000: nothing is split, the group is not settled.
  const v=rig();v.us(500,0,[]);v.kr(KR0);const x=order('x',100,K('2026-11-09T23:40:00'));v.to('2026-11-09T23:45:00');v.us(500,0,[x],['x']);v.to('2026-11-10T09:00:00');v.us(500,134000,[x]);
  v.to('2026-11-10T20:00:00');v.us(500,300000,[x]);v.to('2026-11-11T08:25:00');v.us(400,150000,[x]);assert.equal(v.f.rows('A').find(r=>r.key==='x').state,'us','not settled by a split');
});
test('peekNet: the split the reading would make, with nothing written',()=>{
  const seq=oneADay(500),w=rig();w.us(500,0,[]);w.kr(KR0);const [A,B]=seq.at(-1).orders;w.to('2026-11-09T23:50:00');w.us(500,0,[A],['A']);w.to('2026-11-10T09:00:00');w.us(500,134000,[A]);
  w.to('2026-11-10T23:50:00');w.us(500,134000,[A,B],['B']);w.to('2026-11-11T08:25:00');const rows=w.rows(),meta=JSON.stringify(w.f.meta('A'));
  const input={us:{cash:400,unsettled:{buyKRW:100500,sellKRW:0}},orders:[A,B],fx:FX,openOrderIds:new Set(['B']),openBuysUSD:75};
  assert.deepEqual(w.f.peekNet('A',input),{settledKRW:134000,newKRW:100500});assert.deepEqual(w.rows(),rows);assert.equal(JSON.stringify(w.f.meta('A')),meta);assert.deepEqual(w.flows(),[]);
  w.f.observeUS('A',input);assert.deepEqual(w.rows(),[['A','booked'],['B','us']]);
});
test('a fall KIS\'s settlement of whole groups explains is settled as before, though an older due group plus a new buy would also fit',()=>{
  // KRW groups a ($100) and b ($60), both due; c ($40) filled, not reported. KIS settles b (₩80,400): b settles; the split
  // ([a] with c as the new report) is not taken.
  const w=rig();w.us(0,0,[]);w.kr(KR0);const a=order('a',100,K('2026-11-09T23:40:00')),b=order('b',60,K('2026-11-09T23:41:00'));w.to('2026-11-09T23:45:00');w.us(0,0,[a,b],['a','b']);
  w.to('2026-11-10T09:00:00');w.us(0,134000,[a,b],['b']);w.to('2026-11-10T09:30:00');w.us(0,214400,[a,b]);const c=order('c',40,K('2026-11-10T23:40:00'));w.to('2026-11-10T23:45:00');w.us(0,214400,[a,b,c]);
  w.to('2026-11-11T08:25:00');w.us(0,134000,[a,b,c]);assert.deepEqual(w.rows(),[['a','krw'],['b','awaiting-kr'],['o:c','filled']]);
});
test('seed 1 (KIS\'s debit below zero in the split reading): the below-zero part is the KRW exchange, not a USD payment: no reversal booked',()=>{
  const {generate}=require('./multi-order-random.test.cjs'),g=generate(1,'Buy','plain-overlap'),run=e2e(g.steps.map(({truth,zero,...s})=>s));
  assert.deepEqual(run.flows().filter(f=>f.transfer).map(f=>f.id.split(':').at(-1)),['out','in','out','in']);
});
