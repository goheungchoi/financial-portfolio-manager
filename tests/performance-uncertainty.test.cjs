// Stage 3.2: performance is unavailable unless bounded (electron/performance-corrections.cjs SettlementUncertainty,
// PerformanceHistory.series/summary; stage3-spec.md U1-U6; design v3.3 §3, T41 replaced).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {performanceCorrections,earliestPayment}=require('../electron/performance-corrections.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-01',createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
// As main wires it: the correction hook from performanceCorrections, and the tracker's snapshot recorded with each day.
function world(start=TRACKING){const db=new DatabaseSync(':memory:');let t=start;const clock=()=>t;let rate=1300;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sc=performanceCorrections(db,{inFlight:f,reconciliation:rec});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>f.snapshot(a);
  const us={cash:500,price:1000};let orders=[],seq=0;
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
  const w={db,f,perf,rec,sc,us,clock,later:ms=>{t+=ms;},setRate:r=>{rate=r;},
    see:(list=orders)=>{orders=list;f.observe('a',{us:U(),orders:list,fx:rate});t+=MIN;},
    valueNow:()=>value({us:U(),inFlight:f.current('a'),fx:{usdKRW:rate,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity,
    record:()=>{const v=w.valueNow().low;const row=perf.record('a',{totals:{USD:v,KRW:1000000,equityKRW:1000000+v*rate},fx:{usdKRW:rate}});t+=MIN;return row;},
    nextDay:()=>{t=Math.ceil((t-start)/DAY)*DAY+start;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    reverse:rid=>{const q={requestId:'v'+(++seq),account:'a',reconciliationId:rid,note:'wrong'};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},
    points:(kind='USD')=>perf.series('a',kind),summary:(kind='USD')=>perf.summary('a',kind,null),all:(kind='USD')=>perf.summary('a',kind,null).periods.find(x=>x.label==='All')};
  return w;}
// Day 0: tracking starts with a pre-tracking $100 buy (awaiting verification, an uncertain obligation): value 1,400.
function started(){const w=world();w.see([]);w.see([order('A',100)]);w.record();assert.equal(w.points()[0].value,1400);return w;}
const UNCERTAIN=/uncertain U\.S\. buy obligations this day: \$100\.00 \(awaiting verification\)/;

test('T41 (a): while an uncertain buy obligation is open, the day and every period through it have no return and no P/L; a day without one is ordinary',()=>{
  const w=started();w.nextDay();w.us.price=1010;w.record();const [,d]=w.points();
  assert.equal(d.dailyReturn,null);assert.equal(d.pnl,null);assert.equal(d.pnlRange,undefined);assert.match(d.unavailable.join(';'),UNCERTAIN);
  const all=w.all();assert.equal(all.twr,null);assert.equal(all.gain,null);assert.equal(all.twrRange,undefined);assert.match(all.unavailable[0],UNCERTAIN);
  // The tracker's uncertainty is recorded with each day: the piece, and the unresolved and under-review totals.
  const row=w.perf.history('a')[1];assert.deepEqual(row.settlement.last.pieces.map(p=>[p.orderId,p.side,p.usd,p.why,p.review]),[['A','Buy',100,'awaiting verification',false]]);
  assert.deepEqual(row.settlement.last.totals,{unresolved:{buysUSD:100,sellsUSD:0},review:{buysUSD:0,sellsUSD:0}});
  assert.notEqual(w.points('KRW')[1].dailyReturn,null,'the Korean series is unaffected');
  // A fill the app saw after tracking started is in flight, not uncertain: its days are ordinary.
  const x=world();x.see([]);const B=order('B',100,{createdAt:x.clock(),filledObservedAt:x.clock(),day:'2026-11-02'});x.see([B]);x.record();x.nextDay();x.us.price=1010;x.see([B]);x.record();
  const [,e]=x.points();assert.equal(e.unavailable,undefined);close(e.dailyReturn,10/1400);close(x.all().twr,10/1400);assert.deepEqual(x.perf.history('a')[1].settlement.last.pieces,[]);
});
test('T41 (b): a settlement without timing evidence leaves the affected days unavailable; with a settlement date it is still not restated; the next day is ordinary',()=>{
  for(const settledOn of [undefined,'2026-11-01']){const w=started();w.nextDay();w.us.price=1010;w.record();w.nextDay();w.reconcile('A',settledOn?{settledOn}:{});w.record();
    const before=JSON.stringify(w.perf.history('a'));w.nextDay();w.us.price=1020;w.record();const [,d1,d2,d3]=w.points();
    for(const d of [d1,d2]){assert.equal(d.dailyReturn,null,settledOn);assert.equal(d.pnl,null);assert.match(d.unavailable.join(';'),/misstatement window/);assert.match(d.unavailable.join(';'),UNCERTAIN,'open at the previous reading');assert.equal(d.pnlRange,undefined,'no range unless bounded');}
    assert.match(d1.unavailable.join(';'),UNCERTAIN,'resolution does not restore the affected day');assert.match(d1.unavailable.join(';'),/stays so after they are resolved/);
    if(settledOn){assert.equal(d2.correction,100,'the correction component is unchanged');}
    else assert.match(d2.unavailable.join(';'),/was paid on this day or earlier is not known/);
    // Day 3: nothing uncertain at either reading, no window: an ordinary return.
    assert.equal(d3.unavailable,undefined);close(d3.dailyReturn,10/1510);close(d3.pnl,10);
    assert.equal(w.all().twr,null);assert.equal(JSON.stringify(w.perf.history('a').slice(0,3)),before,'nothing recorded is rewritten');}
});
test('U1: a piece made uncertain and resolved between two recordings still affects the day (the ledger events between them)',()=>{
  // A pre-tracking fill first listed on day 1 and reconciled as paid before tracking before day 1 is recorded: no
  // snapshot holds it, the ledger does.
  const w=world();w.see([]);w.record();w.nextDay();w.see([order('A',100)]);w.reconcile('A',{settledOn:'2026-11-01'});w.record();
  assert.deepEqual(w.perf.history('a')[1].settlement.seen,[]);const [,d]=w.points();assert.equal(d.dailyReturn,null);assert.match(d.unavailable.join(';'),UNCERTAIN);
});
test('U1: coverage under review is an uncertain obligation; its totals are recorded with the day',()=>{
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();w.nextDay();
  w.f.evidence.underReview=()=>[{orderId:'B',citationId:'C1',side:'Buy',usd:60,reason:'the row is missing from a later complete history window'}];w.us.price=1010;w.record();
  const row=w.perf.history('a')[1];assert.deepEqual(row.settlement.last.totals.review,{buysUSD:60,sellsUSD:0});assert.ok(row.settlement.last.pieces.some(p=>p.review&&p.usd===60));
  const [,d]=w.points();assert.equal(d.dailyReturn,null);assert.match(d.unavailable.join(';'),/\$60\.00 \(coverage under review\)/);
});
test('U2: a misstatement window runs from the settlement date to the reconciliation day; a payment on the reconciliation\'s own day has none',()=>{
  // A fill seen on day 0, settled on 2026-11-04 (U.S.), reconciled on day 3: days 2-3 unavailable, day 1 ordinary.
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();
  for(const p of [1010,1020])w.nextDay(),w.us.price=p,w.record();w.nextDay();const r=w.reconcile('B',{settledOn:'2026-11-04'});w.record();
  const [,d1,d2,d3]=w.points();assert.equal(d1.unavailable,undefined);close(d1.dailyReturn,10/1400);
  for(const d of [d2,d3]){assert.equal(d.dailyReturn,null);assert.match(d.unavailable.join(';'),new RegExp(`\\$100\\.00 \\(reconciliation ${r.id.slice(0,10)}\\).*between ${d2.day} and ${d3.day} \\(a misstatement window\\)`));}
  // Without a settlement date the window starts at the piece's opening (day 1, the first day after it).
  const y=world();y.see([]);const C=order('C',100,{createdAt:y.clock(),filledObservedAt:y.clock(),day:'2026-11-02'});y.see([C]);y.record();y.nextDay();y.us.price=1010;y.record();y.nextDay();y.reconcile('C');y.record();
  const [,e1,e2]=y.points();for(const d of [e1,e2])assert.match(d.unavailable.join(';'),/misstatement window/);
  // Paid within the reconciliation's own day (its settlement date wholly inside the interval): correction 0, no window.
  const x=world();x.see([]);const D=order('D',100,{createdAt:x.clock(),filledObservedAt:x.clock(),day:'2026-11-02'});x.see([D]);x.record();x.nextDay();x.later(DAY);
  x.us.cash=400;x.us.price=1010;x.reconcile('D',{settledOn:'2026-11-03'});x.record();const [,p]=x.points();
  assert.deepEqual(p.correctionItems.map(i=>i.kind),['reconciliation paid that day']);assert.equal(p.unavailable,undefined);close(p.dailyReturn,10/1400);
  // A rounding record makes no payment: no window.
  const z=world();z.see([]);const E=order('E',0.4,{createdAt:z.clock(),filledObservedAt:z.clock(),day:'2026-11-02',resultCosts:{netCash:-0.4},costEstimate:{netCash:-0.4}});z.see([E]);z.record();z.nextDay();z.reconcile('E',{explanation:'rounding',route:undefined});z.record();
  const [,q]=z.points();assert.equal(q.unavailable,undefined);close(q.correction,0.4);close(q.dailyReturn,0);
});
// The one bounded case: a fill on Friday 2026-11-06 (New York), pre-tracking, awaiting verification. Its U.S. settlement
// cannot be paid before Monday 2026-11-09 (Seoul midnight: 2026-11-08T15:00Z), so the weekend days are bounded.
const FRI=Date.parse('2026-11-06T16:00:00Z'),FILL=Date.parse('2026-11-06T15:00:00Z');
const weekend=()=>{const w=world(FRI);w.see([]);w.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);w.record();return w;};
test('T41 (d), U3: the one bounded case shows its range; the combined series, a payable day and a second obligation do not',()=>{
  assert.equal(earliestPayment(FILL),Date.parse('2026-11-08T15:00:00Z'));
  const w=weekend();w.nextDay();w.us.price=1010;w.record();const [,d]=w.points();
  assert.equal(d.unavailable,undefined);assert.equal(d.dailyReturn,null,'no single return');close(d.pnl,10,'the P/L is the same in both states');
  close(d.bounded.states.real,10/1400,'real: the recorded value');close(d.bounded.states.notReal,10/1500,'not real: $100 more at both ends');
  close(d.bounded.returnRange.low,10/1500);close(d.bounded.returnRange.high,10/1400);assert.match(d.bounded.label,/one uncertain obligation of \$100\.00/);
  const all=w.all();assert.equal(all.twr,null);close(all.twrRange.low,10/1500);close(all.twrRange.high,10/1400);close(all.gain,10);
  // The combined series: the funding route and FX exposure are not bounded.
  const c=w.points('COMBINED')[1];assert.equal(c.dailyReturn,null);assert.equal(c.bounded,undefined);assert.match(c.unavailable[0],/funding route and FX exposure are not bounded/);assert.equal(w.all('COMBINED').twr,null);
  // Monday: the settlement can have been paid that day; unavailable, and so is the period through it.
  w.nextDay();w.us.price=1020;w.record();const m=w.points()[2];assert.equal(m.bounded,undefined);assert.equal(m.dailyReturn,null);assert.match(m.unavailable.join(';'),UNCERTAIN);
  assert.equal(w.all().twr,null);assert.equal(w.all().twrRange,undefined);
  // A second uncertain obligation the same day.
  const x=weekend();x.nextDay();x.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'}),order('B',50,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);x.record();
  const [,e]=x.points();assert.equal(e.bounded,undefined);assert.equal(e.dailyReturn,null);assert.match(e.unavailable.join(';'),/\$100\.00 \(awaiting verification\), \$50\.00 \(awaiting verification\)/);
  // A piece first listed during the day: not open at the previous day's last reading, so its existence window is not known.
  const y=world(FRI);y.see([]);y.record();y.nextDay();y.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);y.record();assert.equal(y.points()[1].bounded,undefined);assert.equal(y.points()[1].dailyReturn,null);
  // A fill time not known: its existence window is not known.
  const z=world(FRI);z.see([order('A',100,{createdAt:undefined,day:'2026-11-06'})]);z.record();z.nextDay();z.record();assert.equal(z.points()[1].bounded,undefined);assert.match(z.points()[1].unavailable.join(';'),UNCERTAIN);
});
test('U3: the bounded case needs the obligation unchanged and nothing else that day',()=>{
  // The piece flagged during the day (a ledger change to it): unavailable.
  const w=weekend();w.nextDay();const pid=w.pid('A');w.f.evidence.event('a','flag',{pieces:[pid],why:'ambiguous evidence'});w.record();
  assert.equal(w.points()[1].bounded,undefined);assert.match(w.points()[1].unavailable.join(';'),/uncertain U\.S\. buy obligations this day/);
  // A different amount at the day's readings (the piece corrected): unavailable.
  const x=weekend();x.nextDay();const st=x.f.state('a');st.open[0].usd=90;x.f.save('a',st);x.record();assert.equal(x.points()[1].bounded,undefined);assert.equal(x.points()[1].dailyReturn,null);
  // Another correction the same day (a rounding record of another fill): unavailable.
  const y=world(FRI);y.see([]);y.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);
  y.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'}),order('E',0.4,{createdAt:y.clock(),filledObservedAt:y.clock(),day:'2026-11-06',resultCosts:{netCash:-0.4},costEstimate:{netCash:-0.4}})]);
  y.record();y.nextDay();
  y.reconcile('E',{explanation:'rounding',route:undefined});y.record();const [,p]=y.points();assert.equal(p.bounded,undefined);assert.match(p.unavailable.join(';'),/with other changes the same day/);
});
test('U3: a period with bounded days of two different obligations has no consistent range',()=>{
  const db=new DatabaseSync(':memory:');let t=Date.parse('2026-11-02T05:00:00Z');const perf=new PerformanceHistory(db,()=>t);
  for(const v of [1000,1010,1020]){perf.record('a',{totals:{USD:v,KRW:1,equityKRW:1}});t+=DAY;}const days=perf.history('a').map(r=>r.day);
  perf.corrections=()=>new Map([[days[1],{usd:0,items:[],unknown:[],bounded:{pieceId:'A#1',usd:100}}],[days[2],{usd:0,items:[],unknown:[],bounded:{pieceId:'B#2',usd:50}}]]);
  const s=perf.summary('a','USD',null),all=s.periods.find(x=>x.label==='All');assert.equal(all.twr,null);assert.equal(all.twrRange,undefined);assert.match(all.unavailable[0],/2 uncertain obligations in the period/);
  // One obligation on both days chains each state.
  perf.corrections=()=>new Map([[days[1],{usd:0,items:[],unknown:[],bounded:{pieceId:'A#1',usd:100}}],[days[2],{usd:0,items:[],unknown:[],bounded:{pieceId:'A#1',usd:100}}]]);
  const one=perf.summary('a','USD',null).periods.find(x=>x.label==='All');close(one.twrRange.high,1020/1000-1);close(one.twrRange.low,(1110/1100)*(1120/1110)-1);
});
test('U4: after tracking starts, a day whose uncertainty was not recorded or could not be read is unavailable; before it nothing is tracked',()=>{
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();
  w.nextDay();w.perf.settlement=()=>{throw new Error('disk I/O error');};w.record();w.nextDay();w.perf.settlement=a=>w.f.snapshot(a);w.record();w.nextDay();delete w.perf.settlement;w.record();
  const [,d1,d2,d3]=w.points();assert.match(d1.unavailable[0],/could not be read when this day was recorded \(disk I\/O error\)/);assert.match(d2.unavailable[0],/not recorded at the previous day's last reading/);assert.match(d3.unavailable[0],/was not recorded for this day/);
  // One failed reading during a day is kept for the day, even if a later one succeeds.
  const y=world();y.see([]);y.record();y.nextDay();y.perf.settlement=()=>null;y.record();y.perf.settlement=a=>y.f.snapshot(a);y.record();assert.match(y.points()[1].unavailable[0],/SNAPSHOT_INVALID/);
  // Before tracking starts there is no tracker: those days are ordinary.
  const x=world();x.record();x.nextDay();x.us.price=1010;x.record();close(x.points()[1].dailyReturn,10/1500);
});
test('3.1 examples under 3.2: the correction component is unchanged and the uncertain days have no return',()=>{
  const w=started();w.nextDay();w.us.price=1010;w.reconcile('A',{settledOn:'2026-11-01'});w.record();const [,p]=w.points();
  assert.equal(p.correction,100);assert.equal(p.correctionLabel,'accounting correction, not investment return');assert.equal(p.dailyReturn,null);assert.equal(p.pnl,null);
  assert.match(p.unavailable.join(';'),UNCERTAIN);assert.match(p.unavailable.join(';'),/misstatement window/);
  assert.deepEqual(w.points(),w.points(),'the derivation is stable');
});
test('U1: a flag or an overdue mark between two recordings affects the day, even when the piece is resolved before the next one',()=>{
  for(const kind of ['flag','overdue']){const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();w.nextDay();w.later(DAY);
    const pid=w.pid('B');w.f.evidence.event('a',kind,kind==='flag'?{pieces:[pid],why:'ambiguous evidence'}:{pieceId:pid,orderId:'B',usd:100});w.us.cash=400;w.reconcile('B',{settledOn:'2026-11-03'});w.record();
    const [,d]=w.points();assert.deepEqual(d.correctionItems.map(i=>i.kind),['reconciliation paid that day']);assert.equal(d.dailyReturn,null,kind);assert.match(d.unavailable.join(';'),new RegExp(`\\$100\\.00 \\(${kind==='flag'?'ambiguous evidence':'overdue'}\\)`));}
});
test('U2: a reversed reconciliation made no payment: no window; a reclassified flow\'s window starts on the flow\'s day',()=>{
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();w.nextDay();w.us.price=1010;w.record();
  w.nextDay();const r=w.reconcile('B',{settledOn:'2026-11-01'});w.record();assert.match(w.points()[2].unavailable.join(';'),/misstatement window/);
  w.nextDay();w.reverse(r.id);w.record();const [,,d2]=w.points();assert.ok(!(d2.unavailable??[]).some(x=>/misstatement window/.test(x)),'a reversed record has no window');assert.equal(d2.correction,100);
  // Reclassified: the payment fell as a detected flow on day 2; the window is days 2-3, day 1 ordinary.
  const x=world();x.see([]);const C=order('C',100,{createdAt:x.clock(),filledObservedAt:x.clock(),day:'2026-11-02'});x.see([C]);x.record();x.nextDay();x.us.price=1010;x.record();
  x.nextDay();x.us.cash=400;const at=x.clock();const flow=x.perf.addFlow('a',{day:require('../electron/kis-activity.cjs').seoulDate(at),market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:at-MIN,occurredBy:at});x.record();
  x.nextDay();x.reconcile('C',{flowId:flow.id});x.record();const [,e1,e2,e3]=x.points();
  assert.equal(e1.unavailable,undefined);close(e1.dailyReturn,10/1400);for(const d of [e2,e3])assert.match(d.unavailable.join(';'),new RegExp(`between ${e2.day} and ${e3.day} \\(a misstatement window\\)`));
});
test('U4: days recorded before tracking started are not tracked, with or without a snapshot',()=>{
  const w=world();delete w.perf.settlement;w.record();w.nextDay();w.us.price=1010;w.record();w.perf.settlement=a=>w.f.snapshot(a);w.nextDay();w.see([]);w.us.price=1020;w.record();
  const [,d1,d2]=w.points();close(d1.dailyReturn,10/1500);close(d2.dailyReturn,10/1510);assert.equal(d2.unavailable,undefined);
});
