// Settlement simplification S2 (design section 3, decision D3; it replaces stage 3.2's "unavailable unless bounded",
// rules U1-U3): no day is unavailable for a settlement reason. A day whose interval had a U.S. buy in flight shows its
// return with the estimate tag (settlement 'pending') while that buy is still open, and plainly once it closed, by KIS
// evidence or by age (3 U.S. business days). A piece's opening and its age close are accounting corrections (C2), never
// return. U4 stays: a day the tracker's state was not recorded for, or could not be read, has no return.
// (electron/performance-corrections.cjs SettlementUncertainty.estimates; PerformanceHistory.series/summary.)
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-01',createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
const estimate=p=>(p.settlement??[]).includes('pending');
// As main wires it: the correction hook from performanceCorrections (S2 default), and the tracker's snapshot recorded with each day.
function world(start=TRACKING){const db=new DatabaseSync(':memory:');let t=start;const clock=()=>t;let rate=1300;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sc=performanceCorrections(db,{inFlight:f,reconciliation:rec});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>f.snapshot(a);
  const us={cash:500,price:1000};let orders=[],seq=0;
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
  const w={db,f,perf,rec,sc,us,clock,later:ms=>{t+=ms;},
    see:(list=orders)=>{orders=list;const r=f.observe('a',{us:U(),orders:list,fx:rate});t+=MIN;return r;},
    record:()=>{const v=value({us:U(),inFlight:f.current('a'),fx:{usdKRW:rate,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity.low;const row=perf.record('a',{totals:{USD:v,KRW:1000000,equityKRW:1000000+v*rate},fx:{usdKRW:rate}});t+=MIN;return row;},
    nextDay:()=>{t=Math.ceil((t-start)/DAY)*DAY+start;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    points:(kind='USD')=>perf.series('a',kind),all:(kind='USD')=>perf.summary('a',kind,null).periods.find(x=>x.label==='All')};
  return w;}
// Day 0: tracking starts with a pre-tracking $100 buy (awaiting verification): value 1,400.
function started(){const w=world();w.see([]);w.see([order('A',100)]);w.record();assert.equal(w.points()[0].value,1400);return w;}

test('S2: a day with a U.S. buy in flight has its return, tagged as an estimate while the buy is open; plain once it settled by age',()=>{
  const w=started();w.nextDay();w.us.price=1010;w.record();const [,d]=w.points();
  assert.equal(d.unavailable,undefined,'never unavailable for settlement');close(d.dailyReturn,10/1500 /* S2b: base without the open correction */);close(d.pnl,10);assert.ok(estimate(d),'estimate while A is open');assert.equal(d.pendingObligation.usd,100);
  const all=w.all();close(all.twr,10/1500 /* S2b: base without the open correction */);close(all.gain,10);assert.equal(all.unavailable,undefined);assert.equal(all.settlementAffected.pending,1);assert.equal(all.twrRange,undefined);
  assert.equal(estimate(w.points('KRW')[1]),false,'the Korean series is unaffected');assert.ok(estimate(w.points('COMBINED')[1]),'the combined series shows the same estimate, with a return');assert.notEqual(w.points('COMBINED')[1].dailyReturn,null);
  // The buy settles by age at a later reading (3 U.S. business days after it opened): its close is a correction of +$100.
  let closedOn=null;for(let i=0;i<5&&!closedOn;i++){w.nextDay();const r=w.see();w.record();if(r.notes.some(n=>/settled by age/.test(n)))closedOn=w.points().at(-1).day;}
  assert.ok(closedOn,'closed by age within the week');const c=w.points().find(p=>p.day===closedOn);
  close(c.correction,100,'the close raises the low bound with no cash: a correction');close(c.dailyReturn,0,'no market move: a zero return, not +7%');assert.equal(c.unavailable,undefined);
  // Every day is plain now: no piece of their interval is still open.
  for(const p of w.points().slice(1))assert.equal(estimate(p),false,p.day);assert.equal(w.all().settlementAffected?.pending??0,0);close(w.all().twr,10/1500 /* S2b: base without the open correction */);close(w.all().gain,10);
});
test('S2: a fill seen after tracking started is an estimate while in flight, plain once KIS evidence settles it (a cash move, no correction)',()=>{
  const x=world();x.see([]);const B=order('B',100,{createdAt:x.clock(),filledObservedAt:x.clock(),day:'2026-11-02'});x.see([B]);x.record();x.nextDay();x.us.price=1010;x.see([B]);x.record();
  const [,e]=x.points();assert.equal(e.unavailable,undefined);close(e.dailyReturn,10/1400);assert.ok(estimate(e));
  x.nextDay();x.us.cash=400;x.see([B]);assert.equal(x.f.current('a').open.length,0,'settled by evidence');x.record();
  const [,e1,e2]=x.points();assert.equal(estimate(e1),false);assert.equal(estimate(e2),false);assert.equal(e2.correction,undefined);close(e2.dailyReturn,0);close(x.all().twr,10/1400);
});
test('S2: the former bounded case (a weekend with one fixed obligation) is an ordinary return with the estimate tag, in every series; no ranges',()=>{
  const FRI=Date.parse('2026-11-06T16:00:00Z'),FILL=Date.parse('2026-11-06T15:00:00Z');const w=world(FRI);w.see([]);w.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);w.record();
  w.nextDay();w.us.price=1010;w.record();const [,d]=w.points();assert.equal(d.bounded,undefined);close(d.dailyReturn,10/1500 /* S2b: base without the open correction */);assert.ok(estimate(d));
  assert.equal(w.all().twrRange,undefined);close(w.all().twr,10/1500 /* S2b: base without the open correction */);const c=w.points('COMBINED')[1];assert.equal(c.unavailable,undefined);assert.notEqual(c.dailyReturn,null);
  // A second obligation the same day: still a return.
  w.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'}),order('B',50,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);w.nextDay();w.us.price=1020;w.record();
  const m=w.points()[2];assert.equal(m.unavailable,undefined);assert.notEqual(m.dailyReturn,null);assert.ok(estimate(m));assert.notEqual(w.all().twr,null);
});
test('S2: coverage under review, a flag or an overdue mark tag the day only while a piece of it is still open',()=>{
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();w.nextDay();
  let review=[{orderId:'B',citationId:'C1',side:'Buy',usd:60,reason:'the row is missing from a later complete history window'}];w.f.evidence.underReview=()=>review;w.us.price=1010;w.record();
  const [,d]=w.points();assert.equal(d.unavailable,undefined);assert.notEqual(d.dailyReturn,null,'a return, not unavailable');assert.ok(estimate(d));
  // The review clears and B settles by evidence: the day is plain.
  review=[];w.nextDay();w.us.cash=400;w.see([B]);w.record();assert.equal(estimate(w.points()[1]),false);
  for(const kind of ['flag','overdue']){const x=world();x.see([]);const C=order('C',100,{createdAt:x.clock(),filledObservedAt:x.clock(),day:'2026-11-02'});x.see([C]);x.record();x.nextDay();
    const pid=x.pid('C');x.f.evidence.event('a',kind,kind==='flag'?{pieces:[pid],why:'ambiguous evidence'}:{pieceId:pid,orderId:'C',usd:100});x.us.price=1010;x.record();
    assert.ok(estimate(x.points()[1]),kind);assert.equal(x.points()[1].unavailable,undefined);x.us.cash=400;x.see([C]);assert.equal(estimate(x.points()[1]),false,kind+': settled, plain');}
});
test('S2: a reconciliation leaves no misstatement window; one with a settlement date is a correction on an available day',()=>{
  const w=started();w.nextDay();w.us.price=1010;w.record();w.nextDay();w.reconcile('A',{settledOn:'2026-11-01'});w.record();w.nextDay();w.us.price=1020;w.record();
  const [,d1,d2,d3]=w.points();for(const d of [d1,d2,d3])assert.equal(d.unavailable,undefined,d.day);
  assert.equal(d2.correction,100);close(d2.dailyReturn,0);close(d3.dailyReturn,10/1510);assert.equal(estimate(d1),false,'A is closed: plain');assert.notEqual(w.all().twr,null);
});
test('C3 stays until S3 removes reconciliation: a manual reconciliation with no payment timing at all leaves its day without a return',()=>{
  // Manual reconciliation has never been used on the live account; S3 removes it with this rule.
  const w=started();w.nextDay();w.us.price=1010;w.reconcile('A');w.record();const [,d]=w.points();assert.match(d.unavailable.join(';'),/was paid on this day or earlier is not known/);
});
test('U4: after tracking starts, a day whose tracker state was not recorded or could not be read is unavailable; before it nothing is tracked',()=>{
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();
  w.nextDay();w.perf.settlement=()=>{throw new Error('disk I/O error');};w.record();w.nextDay();w.perf.settlement=a=>w.f.snapshot(a);w.record();w.nextDay();delete w.perf.settlement;w.record();
  const [,d1,d2,d3]=w.points();assert.match(d1.unavailable[0],/could not be read when this day was recorded \(disk I\/O error\)/);assert.match(d2.unavailable[0],/not recorded at the previous day's last reading/);assert.match(d3.unavailable[0],/was not recorded for this day/);
  const y=world();y.see([]);y.record();y.nextDay();y.perf.settlement=()=>null;y.record();y.perf.settlement=a=>y.f.snapshot(a);y.record();assert.match(y.points()[1].unavailable[0],/SNAPSHOT_INVALID/);
  const x=world();x.record();x.nextDay();x.us.price=1010;x.record();close(x.points()[1].dailyReturn,10/1500);
  const z=world();delete z.perf.settlement;z.record();z.nextDay();z.us.price=1010;z.record();z.perf.settlement=a=>z.f.snapshot(a);z.nextDay();z.see([]);z.us.price=1020;z.record();
  const [,e1,e2]=z.points();close(e1.dailyReturn,10/1500);close(e2.dailyReturn,10/1510);assert.equal(e2.unavailable,undefined);
});
test('S2: restatements are off: no candidates, no previews, no approvals; the card is hidden; the stage 3.2 rules only on request',()=>{
  const w=started();w.nextDay();w.us.price=1010;w.record();w.nextDay();w.reconcile('A',{settledOn:'2026-11-01'});w.record();
  const {SettlementRestatements}=require('../electron/valuation-corrections.cjs');const s=new SettlementRestatements(w.db,{inFlight:w.f,reconciliation:w.rec,performance:w.perf,corrections:w.sc,clock:w.clock});
  assert.deepEqual(s.candidates('a'),[]);assert.throws(()=>s.preview('a','anything'),/HISTORICAL_TIMING_UNPROVEN/);assert.deepEqual(s.inForce('a',w.perf.history('a')),[]);
  const fs=require('node:fs'),path=require('node:path'),src=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  assert.ok(!/<Restatements[\s/]/.test(src('src/AccountPerformance.tsx')),'the Restatements card is not rendered');assert.ok(!/enabled:true/.test(src('electron/main.cjs').match(/SettlementRestatements\)\([^\n]*/)[0]),'the app does not turn them on');
  assert.ok(src('electron/main.cjs').includes('performanceCorrections(store.db,{inFlight,reconciliation})'),'the app uses the S2 default, not strict');
  // strict: the stage 3.2 rules, for the tests of the code S4 removes.
  const sc=performanceCorrections(w.db,{inFlight:w.f,reconciliation:w.rec,strict:true});w.perf.corrections=(a,rows)=>sc.byDay(a,rows);assert.ok(w.points().some(p=>p.unavailable?.some(x=>/misstatement window/.test(x))));
});

// S2b (review of S2, finding 1-3): the return base leaves out the corrections still open; a day whose return cannot be
// computed makes period figures unavailable, never a silent 0%; corrections that net to zero leave no estimate tag.
test('S2b (a): the live shape: pre-tracking buys open as a correction on day 1 make the recorded value negative; returns use the base without them',()=>{
  // Day 0 $560 with nothing pending; tracking then finds $697.07 of pre-tracking buys (value -$137.07); two days later they
  // settle by age. The planner's figures: 11-10 -8.13 / 532.05, 11-11 -1.73 / 523.92 (here with this fixture's prices).
  const w=world(Date.parse('2026-11-04T05:00:00Z'));w.us.cash=0;w.us.price=560;w.record();w.nextDay();
  // C1b: a fill already past the age rule now closes at the first reading itself, so this fixture's fill is younger
  // (New York 11-03): open from tracking's start on day 1, settled by age at day 3's reading. The mechanism is the same.
  const old=Date.parse('2026-11-03T15:00:00Z');w.see([order('P',697.07,{createdAt:old,filledObservedAt:old,day:'2026-11-03'})]);w.record();
  w.nextDay();w.us.price=551.87;w.record();w.nextDay();w.us.price=550.14;w.see();w.record();
  const [,d1,d2,d3]=w.points();assert.equal(Math.round(d1.value*100)/100,-137.07);assert.equal(d1.correction,-697.07);close(d1.dailyReturn,0,'the opening is a correction, not a loss');
  close(d2.pnl,-8.13);assert.equal(Math.round(d2.returnBase*100)/100,560);close(d2.dailyReturn,-8.13/560);assert.equal(d2.unavailable,undefined);
  assert.equal(d3.correction,697.07,'settled by age: the matching correction');close(d3.dailyReturn,-1.73/551.87);
  const all=w.all();close(all.twr,(1-8.13/560)*(1-1.73/551.87)-1);assert.equal(all.unavailable,undefined);
  for(const p of [d1,d2,d3])assert.equal(w.points().find(x=>x.day===p.day).correctionOpen,undefined,'netted to zero: no estimate from corrections');assert.equal(all.settlementAffected?.corrected??0,0);
});
test('S2b (b): a day whose starting value is still not positive has no return; the period has none either (never 0%), its gain stays',()=>{
  const db=new DatabaseSync(':memory:');let t=Date.parse('2026-11-02T05:00:00Z');const perf=new PerformanceHistory(db,()=>t);
  for(const v of [100,-20,-25,40]){perf.record('a',{totals:{USD:v,KRW:1,equityKRW:1}});t+=DAY;}
  const pts=perf.series('a','USD');assert.equal(pts[2].dailyReturn,null);assert.deepEqual(pts[2].unavailable,["the day's starting value was not positive"]);close(pts[2].pnl,-5,'the P/L is still shown');
  assert.equal(pts[3].dailyReturn,null,'from -25: not positive either');
  const s=perf.summary('a','USD',null),all=s.periods.find(p=>p.label==='All');assert.equal(all.twr,null,'not a silent 0%');assert.match(all.unavailable.join(';'),/starting value was not positive/);close(all.gain,-60,'the gain stays');
  assert.equal(s.analytics.All.maxDrawdownPct,null);assert.equal(s.analytics.All.currentDrawdownPct,null);
  // A zero base with zero P/L (nothing invested, nothing gained) is a 0% day, not a missing one.
  const db2=new DatabaseSync(':memory:');let u=Date.parse('2026-11-02T05:00:00Z');const p2=new PerformanceHistory(db2,()=>u);for(const v of [0,0,0]){p2.record('a',{totals:{USD:v,KRW:1,equityKRW:1}});u+=DAY;}
  assert.deepEqual(p2.series('a','USD').slice(1).map(p=>[p.dailyReturn,p.unavailable]),[[0,undefined],[0,undefined]]);
});
test('S2b (a, hindsight): a pre-tracking buy later closed by KIS evidence was paid while tracked: it never lowered the base',()=>{
  const w=started();w.nextDay();w.us.price=1010;w.record();assert.ok(Math.abs(w.points()[1].dailyReturn-10/1500)<1e-9,'while open: the base adds it back');
  w.nextDay();w.us.cash=400;w.see();w.record();assert.equal(w.f.current('a').open.length,0,'closed by evidence');
  close(w.points()[1].dailyReturn,10/1400,'in hindsight it was unpaid at day 0: the recorded base was right');
});
test('S2b (c): corrections that do not net to zero keep their days an estimate; corrections that net to zero do not',()=>{
  // +$100 from a reconciliation with no opening correction (paid before tracking, settlement date known): not netted.
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();w.nextDay();w.us.price=1010;w.reconcile('B',{settledOn:'2026-11-01'});w.record();
  const p=w.points()[1];assert.ok(p.correctionOpen,'not netted');assert.equal(w.all().settlementAffected.corrected,1);
});
// Release gate Q1 run: a day whose valuation range narrowed, with no money change awaiting the user, makes the summary
// provisional with range changes only: no unresolved list and no "included" scenario. The Performance page read
// pv.included.find and went blank (since bc52739); it now shows the money-change notice only when there are some.
test('a provisional summary may carry range changes only, with no unresolved changes or included scenario',()=>{
  const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>Date.parse('2026-11-11T03:00:00Z'));perf.history('a');
  const row=(day,low,narrowed)=>db.prepare('INSERT INTO nav_history VALUES(?,?,?)').run('a',day,JSON.stringify({day,at:Date.parse(day+'T05:00:00Z'),USD:{equity:low,cash:low},KRW:{equity:1,cash:1},equityKRW:1,fx:{usdKRW:1300},valuation:{ranges:{USD:{narrowed}}}}));
  row('2026-11-09',500,0);row('2026-11-10',510,40);
  const s=perf.summary('a','USD',null);assert.ok(s.provisional,'provisional');assert.ok(Array.isArray(s.provisional.rangeChanges)&&s.provisional.rangeChanges.length===1);
  assert.equal(s.provisional.unresolved,undefined);assert.equal(s.provisional.included,undefined,'no included scenario: the page must not read it');
  const page=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/AccountPerformance.tsx'),'utf8');assert.ok(page.includes('provisional?.unresolved?.length>0&&')&&page.includes('pv.included?.find'),'the page guards on unresolved changes');
});
