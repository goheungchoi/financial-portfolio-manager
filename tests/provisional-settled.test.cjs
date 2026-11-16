// P1 (multi-order, artifacts/reviews/2026-11-16-multi-order/m1/p1-design.md, cleared with C1 and C2): KRW KIS settled for
// U.S. buys no recorder group explains (provisional: a buy placed in KIS outside the app, or a report the batch path could
// not attribute) stays deducted until it is seen leaving. By USD first, the part U.S. cash still holds is owed by the
// U.S. side until KIS's debit (C1); the rest is Korean until its Korean fall, matched with the flow detector's own
// tolerance (C2), or until one Korean business day passes.
const test=require('node:test');const assert=require('node:assert/strict');
const {e2e}=require('./loss-funding-e2e.test.cjs');
const K=s=>Date.parse(s+'+09:00'),FX=1340,KR0=3000000,A='acct';
// One U.S. buy you place yourself in KIS ($100, ₩134,000): no app order, its shares in the holdings.
const H=[{symbol:'NYSE:OWN',quantity:1,price:100}];
const step=(at,note,kr,us)=>({at:K(at),note,fx:FX,kr:{settled:kr,holdings:[]},us:{holdings:H,...us},orders:[]});
const combined=r=>r.value.KR.low+r.value.US.low*FX;
const route=(seq,i)=>e2e(seq.slice(0,i+1)).rec.current(A);

test('P1, one buy you place in KIS, paid in KRW: deducted in Korea from the report to the Korean fall, with no gap reading, and no flow',()=>{
  const seq=[step('2026-11-09T23:00:00','before',KR0,{cash:0,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:0}),
    step('2026-11-10T09:00:00','report',KR0,{cash:0,buyKRW:134000}),step('2026-11-11T08:25:00','settled (report 0)',KR0,{cash:0,buyKRW:0}),
    step('2026-11-11T08:26:00','Korean fall',KR0-134000,{cash:0,buyKRW:0}),step('2026-11-12T09:00:00','next day',KR0-134000,{cash:0,buyKRW:0})];
  const run=e2e(seq);const truth=KR0;   // the shares are worth what they cost: the value stays at the start
  for(const r of run.out.slice(2))assert.ok(Math.abs(combined(r)-truth)<=2,`${r.note}: ${combined(r)}`);
  assert.equal(route(seq,3).krwSettledUnpaidKRW,134000,'held at the settlement reading');assert.equal(route(seq,4).krwSettledUnpaidKRW,0,'gone with the Korean fall');
  // The daily-loss value is unchanged by P1: it subtracts the funding component whole, and the entries are not in
  // krwUnpaidKRW (the flow detector's Korean basis; its settlement evidence handles this KRW, so that would count it twice).
  const loss=note=>run.out.find(r=>r.note===note).loss.KR.low;assert.equal(loss('settled (report 0)'),loss('report'),'the loss value does not move at the settlement');
  assert.deepEqual(run.flows().filter(f=>f.detected),[],'no detected flow');
});

test('P1 C1, U.S. cash left: the part U.S. cash can pay is owed by the U.S. side until KIS debits it; nothing is Korean',()=>{
  const seq=[step('2026-11-09T23:00:00','before',KR0,{cash:500,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:500}),
    step('2026-11-10T09:00:00','report',KR0,{cash:500,buyKRW:134000}),step('2026-11-11T08:25:00','report 0, no debit yet',KR0,{cash:500,buyKRW:0}),
    step('2026-11-11T09:25:00','KIS debits $100',KR0,{cash:400,buyKRW:0}),step('2026-11-12T09:00:00','next day',KR0,{cash:400,buyKRW:0})];
  const run=e2e(seq);const truth=KR0+500*FX;
  for(const r of run.out.slice(2))assert.ok(Math.abs(combined(r)-truth)<=2,`${r.note}: ${combined(r)} vs ${truth}`);
  const at=route(seq,3);assert.equal(at.usAwaitingUSD,100,'owed by the U.S. side');assert.equal(at.krwSettledUnpaidKRW,0,'nothing Korean');
  assert.equal(route(seq,4).usAwaitingUSD,0,'ends at the debit');assert.deepEqual(run.flows().filter(f=>f.detected),[],'no detected flow');
});

test('P1 C1, U.S. cash used up: $30 debited with the settlement, the rest is Korean until its fall',()=>{
  const k=134000-30*FX;
  const seq=[step('2026-11-09T23:00:00','before',KR0,{cash:30,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:30}),
    step('2026-11-10T09:00:00','report',KR0,{cash:30,buyKRW:134000}),step('2026-11-11T08:25:00','settled, $30 taken',KR0,{cash:0,buyKRW:0}),
    step('2026-11-11T08:26:00','Korean fall',KR0-k,{cash:0,buyKRW:0}),step('2026-11-12T09:00:00','next day',KR0-k,{cash:0,buyKRW:0})];
  const run=e2e(seq),truth=KR0+30*FX;
  for(const r of run.out.slice(2))assert.ok(Math.abs(combined(r)-truth)<=2,`${r.note}: ${combined(r)} vs ${truth}`);
  const at=route(seq,3);assert.equal(at.krwSettledUnpaidKRW,k,'all Korean');assert.equal(at.usAwaitingUSD,0);assert.equal(route(seq,4).krwSettledUnpaidKRW,0);
});

test('P1: no entry when U.S. cash paid it all with the settlement',()=>{
  const seq=[step('2026-11-09T23:00:00','before',KR0,{cash:500,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:500}),
    step('2026-11-10T09:00:00','report',KR0,{cash:500,buyKRW:134000}),step('2026-11-11T08:25:00','settled in USD',KR0,{cash:400,buyKRW:0})];
  const at=route(seq,3);assert.equal(at.krwSettledUnpaidKRW,0);assert.equal(at.usAwaitingUSD,0);
});

test('P1: no Korean fall seen: the entry expires at the next Korean business day\'s reading, with one System line',()=>{
  const seq=[step('2026-11-09T23:00:00','before',KR0,{cash:0,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:0}),
    step('2026-11-10T09:00:00','report',KR0,{cash:0,buyKRW:134000}),step('2026-11-11T08:25:00','settled',KR0,{cash:0,buyKRW:0}),
    step('2026-11-11T15:00:00','same Korean day',KR0,{cash:0,buyKRW:0}),step('2026-11-12T10:00:00','next Korean day',KR0,{cash:0,buyKRW:0})];
  assert.equal(route(seq,4).krwSettledUnpaidKRW,134000,'still held the same day');
  const run=e2e(seq);assert.equal(run.rec.current(A).krwSettledUnpaidKRW,0,'expired');
  assert.equal(run.notes.filter(n=>/not seen leaving Korean cash/.test(n.body)).length,1,'one System line');
});

test('P1 C2: one Korean fall, two readers: within the detector\'s tolerance both take it; just outside it, neither does',()=>{
  // The detector's tolerance for a settlement's payment: max(₩10,000, 3%); at ₩134,000 the floor applies.
  const run=off=>e2e([step('2026-11-09T23:00:00','before',KR0,{cash:0,holdings:[]}),step('2026-11-09T23:45:00','bought',KR0,{cash:0}),
    step('2026-11-10T09:00:00','report',KR0,{cash:0,buyKRW:134000}),step('2026-11-11T08:25:00','settled',KR0,{cash:0,buyKRW:0}),
    step('2026-11-11T08:26:00','Korean fall',KR0-134000-off,{cash:0,buyKRW:0}),step('2026-11-11T12:00:00','later',KR0-134000-off,{cash:0,buyKRW:0})]);
  const inside=run(9900);assert.equal(inside.rec.current(A).krwSettledUnpaidKRW,0,'the recorder takes it');
  assert.deepEqual(inside.flows().filter(f=>f.detected),[],'and the detector does (no flow)');
  const outside=run(10100);assert.equal(outside.rec.current(A).krwSettledUnpaidKRW,134000,'the recorder does not: the entry waits for expiry');
  // Neither takes it: the detector does not match the fall to its settlement evidence either, and records it as a
  // detected flow for you to confirm (its own call on a fall that differs from what was owed, as before P1). P1 adds
  // nothing to it (no booking); its only effect is the entry held until expiry (a false loss, never a gain).
  assert.deepEqual(outside.flows().filter(f=>f.detected).map(f=>[f.market,f.amount]),[['KR',-144100]],'the detector did not take it either');
});

test('P1 F1: U.S. cash another buy already claims cannot pay it: $100 cash, a $100 app buy in flight, $100 settled provisional: Korean',()=>{
  // The app's own $100 buy (filled, not yet reported or settled) claims the $100; your $100 buy placed in KIS settles from KRW.
  const app={id:'APP',market:'US',symbol:'NYSE:APP',side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,resultCosts:{netCash:-100},createdAt:K('2026-11-10T23:40:00'),filledObservedAt:K('2026-11-10T23:40:00')};
  const both=[...H,{symbol:'NYSE:APP',quantity:1,price:100}],s=(at,note,kr,us,o=[])=>({...step(at,note,kr,us),orders:o});
  const seq=[s('2026-11-09T23:00:00','before',KR0,{cash:100,holdings:[]}),s('2026-11-09T23:45:00','yours bought',KR0,{cash:100}),
    s('2026-11-10T09:00:00','yours reported',KR0,{cash:100,buyKRW:134000}),s('2026-11-10T23:45:00','app buy filled',KR0,{cash:100,holdings:both,buyKRW:134000},[app]),
    s('2026-11-11T08:25:00','yours settled',KR0,{cash:100,holdings:both,buyKRW:0},[app])];
  const at=route(seq,4);assert.equal(at.usAwaitingUSD,0,'no U.S. money left for it');assert.equal(at.krwSettledUnpaidKRW,134000,'all Korean');
});
