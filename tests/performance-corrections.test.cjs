// Stage 3.1: the accounting-correction component of the performance series (electron/performance-corrections.cjs,
// PerformanceHistory.series; stage3-spec.md C1-C8; design tests T19, T21, T22, T23).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');const {SettlementCorrections}=require('../electron/performance-corrections.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-01',createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
function world(){const db=new DatabaseSync(':memory:');let t=TRACKING;const clock=()=>t;let rate=1300;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock),fd=new FlowDetector(db,perf,clock);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sc=new SettlementCorrections(db,{inFlight:f,reconciliation:rec});perf.corrections=(a,rows)=>sc.byDay(a,rows);
  const us={cash:500,price:1000};let orders=[],seq=0;
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
  const w={db,f,perf,fd,rec,sc,us,clock,later:ms=>{t+=ms;},setRate:r=>{rate=r;},
    see:(list=orders)=>{orders=list;f.observe('a',{us:U(),orders:list,fx:rate});t+=MIN;},
    valueNow:()=>value({us:U(),inFlight:f.current('a'),fx:{usdKRW:rate,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity,
    // The day's last reading: the U.S. low bound, as the app records it.
    record:()=>{const v=w.valueNow().low;const row=perf.record('a',{totals:{USD:v,KRW:1000000,equityKRW:1000000+v*rate},fx:{usdKRW:rate}});t+=MIN;return row;},
    nextDay:()=>{t=Math.ceil((t-TRACKING)/DAY)*DAY+TRACKING;},
    detect:()=>{const v=f.current('a');return fd.observe('a',{krCash:1000000,usCash:us.cash-v.buysUSD+v.sellsUSD,fx:rate,orders,usExplained:r=>f.explained('a',r),usReview:v.review});},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    reverse:rid=>{const q={requestId:'v'+(++seq),account:'a',reconciliationId:rid,note:'wrong'};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},
    points:(kind='USD')=>perf.series('a',kind),summary:(kind='USD')=>perf.summary('a',kind,null)};
  return w;}
// Day 0: tracking starts with a pre-tracking $100 buy (unresolved): recorded value 1,400.
function started(){const w=world();w.see([]);w.see([order('A',100)]);w.record();assert.equal(w.points()[0].value,1400);return w;}

test('T19: payment and resolution in one reading: no correction; the day\'s return is the market\'s only',()=>{
  // (a) by evidence: a fill seen after tracking started settles with a matching cash fall in one reading.
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([B]);w.record();
  w.nextDay();w.us.cash=400;w.us.price=1010;w.see([B]);w.record();const [,d]=w.points();assert.equal(d.correction,undefined);close(d.dailyReturn,10/1400,'market only');
  // (b) a manual reconciliation whose timing was resolved "paid in this interval" (the payment fell in that reading).
  const x=started();x.nextDay();x.detect();x.later(MIN);x.us.cash=400;x.us.price=1010;const r=x.reconcile('A');x.later(MIN);x.detect();
  const [e]=x.fd.timing('a');x.fd.resolveTiming('a',e.id,{reconciliationId:r.id,paidHere:true});x.record();
  const [,p]=x.points();assert.equal(p.correction,0);assert.deepEqual(p.correctionItems.map(i=>[i.kind,i.usd]),[['reconciliation paid that day',0]]);close(p.dailyReturn,10/1400,'market only, E = 0');close(p.pnl,10);
});
test('C3: a reconciliation of unknown payment timing leaves the day\'s return and every period through it unavailable; the P/L is a range',()=>{
  const w=started();w.nextDay();w.us.cash=400;w.us.price=1010;const r=w.reconcile('A');w.record();
  const [,p]=w.points();assert.equal(p.dailyReturn,null);assert.equal(p.pnl,null);assert.match(p.unavailable[0],/was paid on this day or earlier is not known/);
  // Paid that day: +$10 (the market; cash and obligation net out). Paid earlier: the +$100 is a correction, and the day's
  // $100 cash fall is unexplained: -$90.
  assert.deepEqual(p.pnlRange,{low:-90,high:10});
  const all=w.summary().periods.find(x=>x.label==='All');assert.equal(all.twr,null);assert.equal(all.gain,null);assert.match(all.unavailable[0],new RegExp(r.id.slice(0,10)));
});
test('T24 (correction part) and C2: a reconciliation of a payment made before the day is a correction of +$100: out of P/L and return',()=>{
  // Paid before tracking started (settlement date before the interval): the value rises $100 with no cash.
  const w=started();w.nextDay();w.us.price=1010;w.reconcile('A',{settledOn:'2026-11-01'});w.record();
  const [,p]=w.points();assert.equal(p.correction,100);assert.equal(p.correctionLabel,'accounting correction, not investment return');close(p.pnl,10);close(p.dailyReturn,10/1500 /* S2b: base without the open correction */);
  const all=w.summary().periods.find(x=>x.label==='All');close(all.gain,10,'gain leaves the correction out');assert.equal(all.corrections,100);close(all.twr,10/1500 /* S2b: base without the open correction */);
  // A rounding remainder (no payment) is a basis change too.
  const x=world();x.see([]);x.see([order('A',100.4,{resultCosts:{netCash:-100.4},costEstimate:{netCash:-100.4}})]);x.record();x.nextDay();x.reconcile('A',{cents:10000,settledOn:'2026-11-01'});x.later(MIN);x.reconcile('A',{explanation:'rounding',cents:40,route:undefined});x.record();
  assert.equal(x.points()[1].correction,100.4);close(x.points()[1].dailyReturn,0);
});
test('T21: a piece created and resolved the same day with no payment leaves the day\'s P/L unaffected',()=>{
  // A pre-tracking fill first listed on day 1 (a basis change, -$100) and reconciled the same day as paid before
  // tracking (+$100): the corrections net to zero and the value does not move.
  const w=world();w.see([]);w.record();w.nextDay();w.see([order('A',100)]);w.reconcile('A',{settledOn:'2026-11-01'});w.record();
  const [,p]=w.points();assert.equal(p.correction,undefined,'the two changes net to nothing');close(p.pnl,0);close(p.dailyReturn,0);
  // The opening alone, on its own day, is a basis change: a -$100 correction, not a loss.
  const x=world();x.see([]);x.record();x.nextDay();x.see([order('A',100)]);x.record();const [,q]=x.points();assert.equal(q.correction,-100);close(q.pnl,0);close(q.dailyReturn,0);
});
test('T22: a sale resolved lowers only the high bound; the recorded low series has no correction and its returns are unaffected',()=>{
  const S=order('S',80,{side:'Sell',costEstimate:undefined,resultCosts:{netCash:80}});const w=world();w.see([]);w.see([S]);w.record();const before=w.valueNow();
  w.nextDay();w.reconcile('S',{route:undefined,settledOn:'2026-11-01'});const after=w.valueNow();assert.equal(after.low,before.low);assert.equal(after.high,before.high-80);
  w.record();const [,p]=w.points();assert.equal(p.correction,undefined);close(p.dailyReturn,0);
});
test('T23: the combined series converts the correction at that day\'s rate; the U.S. series is unaffected by FX',()=>{
  const w=started();w.nextDay();w.setRate(1350);w.reconcile('A',{settledOn:'2026-11-01'});w.record();
  assert.equal(w.points('KRW')[1].correction,undefined,'the Korean series has no U.S. correction');close(w.points('KRW')[1].pnl,0);
  const usd=w.points('USD')[1],krw=w.points('COMBINED')[1];assert.equal(usd.correction,100);assert.equal(krw.correction,135000);close(usd.dailyReturn,0,'no U.S. return');
  // Combined: 1,400 x 1,300 -> 1,500 x 1,350; less the correction at 1,350, the rest is the FX move on 1,400.
  close(krw.pnl,1400*1350-1400*1300);
});
test('C4: a detected flow reclassified as the payment is a correction on its own day, the reconciliation one on its day; a reversal undoes both',()=>{
  // The cash fell with no tracker reading matching it to the piece (as when it cannot be told apart).
  const w=started();w.nextDay();w.us.cash=400;w.later(MIN);const at=w.clock();const flow=w.perf.addFlow('a',{day:require('../electron/kis-activity.cjs').seoulDate(at),market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:at-MIN,occurredBy:at});w.record();
  // Before reconciling: the headline leaves a detected flow out, so day 1 shows the payment as a -$100 loss.
  close(w.points()[1].pnl,-100);
  w.nextDay();const r=w.reconcile('A',{flowId:flow.id});w.record();let [,d1,d2]=w.points();
  assert.equal(d1.correction,-100);close(d1.pnl,0,'the payment is neither P/L nor a flow');assert.equal(d2.correction,100);close(d2.pnl,0);assert.equal(w.perf.flows('a').length,0);
  // Reversed on day 3: the flow comes back (detected, left out of the headline), day 2 keeps its correction and day 3
  // reopens the obligation (-$100).
  w.nextDay();w.reverse(r.id);w.record();[,d1,d2]=w.points();const d3=w.points()[3];assert.equal(d1.correction,undefined);close(d1.pnl,-100);assert.equal(d2.correction,100);assert.equal(d3.correction,-100);close(d3.pnl,0);
});
test('C1/C7: events belong to the first recorded day whose last reading follows them; the derivation is stable and rewrites nothing',()=>{
  const w=started();w.nextDay();w.record();w.later(MIN);w.reconcile('A',{settledOn:'2026-11-01'});// after day 1's last reading
  w.nextDay();w.record();const [,d1,d2]=w.points();assert.equal(d1.correction,undefined);assert.equal(d2.correction,100);
  const rows=JSON.stringify(w.perf.history('a'));assert.deepEqual(w.points(),w.points());assert.equal(JSON.stringify(w.perf.history('a')),rows,'nothing recorded is rewritten');
  // Valuation corrections (approved adjustments) still apply on top (C8).
  w.perf.adjustments=()=>[{day:d2.day,market:'US',currency:'USD',amount:5}];const [,,a2]=w.points();assert.equal(a2.adjustment,5);assert.equal(a2.correction,100);
});
test('C3 (review of 093b44f, P1): "paid earlier" places the payment before the day only when the reading it was resolved for began at or before the previous day\'s last reading',()=>{
  // The reading interval began after day 0's last reading: the payment may have been on day 1 before that reading.
  // Unknown; no loss is reported (the reviewer's case: paid after yesterday's close, before today's detector interval).
  const w=started();w.nextDay();w.us.cash=400;w.detect();w.later(MIN);w.us.price=1010;const r=w.reconcile('A');w.later(MIN);w.detect();const [e]=w.fd.timing('a');assert.ok(e.after>w.perf.history('a')[0].at);
  w.fd.resolveTiming('a',e.id,{reconciliationId:r.id,paidHere:false});w.record();const [,p]=w.points();
  assert.equal(p.dailyReturn,null);assert.equal(p.pnl,null);assert.match(p.unavailable[0],/is not known/);assert.equal(w.summary().periods.find(x=>x.label==='All').twr,null);
  // The reading interval began at or before day 0's last reading: "earlier" is before the day. A +$100 correction.
  const x=world();x.see([]);x.see([order('A',100)]);x.detect();x.later(MIN);x.record();x.nextDay();x.us.price=1010;const q=x.reconcile('A');x.later(MIN);x.detect();const [g]=x.fd.timing('a');
  assert.ok(g.after<=x.perf.history('a')[0].at,'the reading began before the day');x.fd.resolveTiming('a',g.id,{reconciliationId:q.id,paidHere:false});x.record();const [,y]=x.points();
  assert.equal(y.correction,100);assert.deepEqual(y.correctionItems.map(i=>i.kind),['reconciliation paid before the day']);close(y.pnl,10);close(y.dailyReturn,10/1500 /* S2b: base without the open correction */);
});
test('C9 (review of 093b44f, P2): a correction read that fails, or returns something unreadable, leaves every U.S. and combined return unavailable with the reason; never zero',()=>{
  const w=started();w.nextDay();w.reconcile('A',{settledOn:'2026-11-01'});w.record();w.nextDay();w.us.price=1010;w.record();
  for(const broken of [()=>{throw new Error('disk I/O error');},()=>null,()=>({})]){w.perf.corrections=broken;
    for(const kind of ['USD','COMBINED']){const [,d1,d2]=w.points(kind);for(const d of [d1,d2]){assert.equal(d.dailyReturn,null,kind);assert.equal(d.pnl,null,kind);assert.match(d.unavailable[0],/settlement corrections could not be read/);assert.equal(d.pnlRange,undefined);}
      const all=w.summary(kind).periods.find(x=>x.label==='All');assert.equal(all.twr,null);assert.equal(all.gain,null);}
    assert.notEqual(w.points('KRW')[1].dailyReturn,null,'the Korean series reads no U.S. correction');}
  // A corrupt stored timing record is an error too, not "no timing".
  const x=world();x.see([]);x.see([order('A',100)]);x.record();x.nextDay();x.detect();x.reconcile('A',{settledOn:'2026-11-01'});x.record();
  x.db.prepare("UPDATE flow_watch SET payload='{' WHERE account='a'").run();const [,d]=x.points();assert.equal(d.dailyReturn,null);assert.match(d.unavailable[0],/could not be read/);
});
