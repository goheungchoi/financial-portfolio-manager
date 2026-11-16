// P2 (multi-order, artifacts/reviews/2026-11-16-multi-order/m1/p2-design.md, cleared with its condition): the flow
// detector compares the reading where unattributed (provisional) KRW settles, instead of skipping it. Only the falls the
// settlement can explain leave the comparison, USD first; the rest of it is kept as settlement evidence; anything else is a
// change held 2 hours, then a flow. P1 and P2 read the same settlement: the detector's bases hold neither P1 figure (the
// U.S. basis subtracts only the 'us' groups' USD, the Korean basis only krwUnpaidKRW); P1's Korean entry lives as long as
// the detector's evidence (24 hours).
const test=require('node:test');const assert=require('node:assert/strict');
const {e2e}=require('./loss-funding-e2e.test.cjs');const {check}=require('./multi-order-random.test.cjs');
const K=s=>Date.parse(s+'+09:00'),FX=1340,KR0=3000000,A='acct';
// One U.S. buy you place yourself in KIS ($100, ₩134,000): no app order, its shares in the holdings.
const H=[{symbol:'NYSE:OWN',quantity:1,price:100}];
const step=(at,note,kr,us)=>({at:K(at),note,fx:FX,kr:{settled:kr,holdings:[]},us:{holdings:H,...us},orders:[]});
const flows=run=>run.flows().filter(f=>f.detected).map(f=>[f.market,f.amount]);
const lead=cash=>[step('2026-11-09T23:00:00','before',KR0,{cash,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash}),step('2026-11-10T09:00:00','report',KR0,{cash,buyKRW:134000})];

test('P2: seeds 90, 129 and 132 (a withdrawal in a settlement reading where unattributed KRW settles): exactly one flow, the withdrawal',()=>{
  for(const seed of [90,129,132,164,201])assert.equal(check(seed,'Buy').flowsOff,null,`seed ${seed}`);
});
test('P2: a buy you place in KIS, paid in USD, with a $150 withdrawal in the settlement reading: the settlement takes $100, the flow is -$150, after the hold',()=>{
  const seq=[...lead(500),step('2026-11-11T08:25:00','settled in USD + withdrawal',KR0,{cash:250,buyKRW:0}),
    step('2026-11-11T09:00:00','half an hour',KR0,{cash:250,buyKRW:0}),step('2026-11-11T10:30:00','2 hours on',KR0,{cash:250,buyKRW:0})];
  assert.deepEqual(flows(e2e(seq.slice(0,5))),[],'held, not recorded at once');
  assert.deepEqual(flows(e2e(seq)),[['US',-150]],'one flow after the 2-hour hold');
});
test('P2, the stated limit: a KRW-paid settlement with a larger Korean withdrawal in the same reading: right in total, the flow a reading late',()=>{
  // KIS settles ₩134,000 from KRW (paid a reading later); ₩500,000 is withdrawn from Korean cash in the settlement reading.
  const seq=[...lead(0),step('2026-11-11T08:25:00','settled + withdrawal',KR0-500000,{cash:0,buyKRW:0}),
    step('2026-11-11T08:26:00','Korean fall',KR0-634000,{cash:0,buyKRW:0}),step('2026-11-11T12:00:00','later',KR0-634000,{cash:0,buyKRW:0})];
  const f=flows(e2e(seq));assert.equal(f.reduce((n,x)=>n+x[1],0),-500000,`the flows total the withdrawal: ${JSON.stringify(f)}`);
});
test('P2: a deposit in a settlement reading is never taken out',()=>{
  const seq=[...lead(0),step('2026-11-11T08:25:00','settled + deposit',KR0+500000,{cash:0,buyKRW:0}),
    step('2026-11-11T08:26:00','Korean fall',KR0+366000,{cash:0,buyKRW:0}),step('2026-11-11T12:00:00','later',KR0+366000,{cash:0,buyKRW:0})];
  assert.deepEqual(flows(e2e(seq)),[['KR',500000]]);
});
test('P2: unattributed KRW settling over two readings, each paid from KRW a reading later: no flow',()=>{
  const seq=[step('2026-11-09T23:00:00','before',KR0,{cash:0,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:0}),
    step('2026-11-10T09:00:00','report',KR0,{cash:0,buyKRW:134000}),step('2026-11-11T08:25:00','half settled',KR0,{cash:0,buyKRW:67000}),
    step('2026-11-11T08:26:00','Korean fall 1',KR0-67000,{cash:0,buyKRW:67000}),step('2026-11-12T08:25:00','rest settled',KR0-67000,{cash:0,buyKRW:0}),
    step('2026-11-12T08:26:00','Korean fall 2',KR0-134000,{cash:0,buyKRW:0}),step('2026-11-12T12:00:00','later',KR0-134000,{cash:0,buyKRW:0})];
  assert.deepEqual(flows(e2e(seq)),[]);
});
test('P1 and P2 read one settlement: (a) U.S. cash left, KIS debits a reading later; (b) the Korean entry and its fall: no flow at any reading',()=>{
  const a=[...lead(500),step('2026-11-11T08:25:00','report 0, no debit yet',KR0,{cash:500,buyKRW:0}),step('2026-11-11T09:25:00','KIS debits',KR0,{cash:400,buyKRW:0}),step('2026-11-11T13:00:00','later',KR0,{cash:400,buyKRW:0})];
  assert.deepEqual(flows(e2e(a)),[],'(a)');
  const b=[...lead(0),step('2026-11-11T08:25:00','settled',KR0,{cash:0,buyKRW:0}),step('2026-11-11T08:26:00','Korean fall',KR0-134000,{cash:0,buyKRW:0}),step('2026-11-11T13:00:00','later',KR0-134000,{cash:0,buyKRW:0})];
  assert.deepEqual(flows(e2e(b)),[],'(b)');
});
test('P1 and P2 read one settlement: (c) the Korean fall after both have forgotten it (24 hours): detected once, never twice',()=>{
  const seq=[...lead(0),step('2026-11-11T08:25:00','settled',KR0,{cash:0,buyKRW:0}),step('2026-11-12T09:00:00','next morning, no fall',KR0,{cash:0,buyKRW:0}),
    step('2026-11-12T09:30:00','the fall, late',KR0-134000,{cash:0,buyKRW:0}),step('2026-11-12T13:00:00','later',KR0-134000,{cash:0,buyKRW:0})];
  const run=e2e(seq);assert.equal(run.rec.current(A).krwSettledUnpaidKRW,0,'P1 forgot it');
  assert.deepEqual(flows(run),[['KR',-134000]],'the detector, without its evidence, records the fall once, for you to confirm or remove');
});
// Seed 252: the unattributed KRW is the app's own buys in flight, paid by KIS's U.S. debit (the settlement tracker closes them);
// that part of the settlement's evidence can be paid only by a Korean fall, so the withdrawal in the debit's reading is not
// matched as their payment: it is detected (off only by the batch band, the false-flow (a) class).
test('P2: the evidence of unattributed buys in flight is Korean-only: a withdrawal in their U.S. debit reading is still detected (seed 252)',()=>{
  const {generate}=require('./multi-order-random.test.cjs'),g=generate(252,'Buy'),run=e2e(g.steps.map(({truth,zero,...x})=>x));
  const total=run.flows().filter(f=>f.detected).reduce((n,f)=>n+(f.market==='US'?f.amount:f.amount/FX),0);
  assert.ok(Math.abs(total+g.desc.W)<=0.05*g.desc.T,`the withdrawal is detected: ${total} for ${g.desc.W}`);
});
