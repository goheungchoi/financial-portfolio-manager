// Stage 3.1: the accounting-correction component of the performance series (electron/performance-corrections.cjs,
// PerformanceHistory.series; stage3-spec.md C1-C8; design tests T19, T21, T22, T23).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');const {SettlementCorrections}=require('../electron/performance-corrections.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-10-26T05:00:00Z');
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
  const w=world();w.see([]);const B=order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-10-26'});w.see([B]);w.record();
  w.nextDay();w.us.cash=400;w.us.price=1010;w.see([B]);w.record();const [,d]=w.points();assert.equal(d.correction,undefined);close(d.dailyReturn,10/1400,'market only');
  // (S4b-1: case (b), a reconciliation whose timing was resolved "paid in this interval", went with C3.)
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
test('C1/C7: events belong to the first recorded day whose last reading follows them; the derivation is stable and rewrites nothing',()=>{
  const w=started();w.nextDay();w.record();w.later(MIN);w.reconcile('A',{settledOn:'2026-11-01'});// after day 1's last reading
  w.nextDay();w.record();const [,d1,d2]=w.points();assert.equal(d1.correction,undefined);assert.equal(d2.correction,100);
  const rows=JSON.stringify(w.perf.history('a'));assert.deepEqual(w.points(),w.points());assert.equal(JSON.stringify(w.perf.history('a')),rows,'nothing recorded is rewritten');
  // Valuation corrections (approved adjustments) still apply on top (C8).
  w.perf.adjustments=()=>[{day:d2.day,market:'US',currency:'USD',amount:5}];const [,,a2]=w.points();assert.equal(a2.adjustment,5);assert.equal(a2.correction,100);
});
test('C9 (review of 093b44f, P2): a correction read that fails, or returns something unreadable, leaves every U.S. and combined return unavailable with the reason; never zero',()=>{
  const w=started();w.nextDay();w.reconcile('A',{settledOn:'2026-11-01'});w.record();w.nextDay();w.us.price=1010;w.record();
  for(const broken of [()=>{throw new Error('disk I/O error');},()=>null,()=>({})]){w.perf.corrections=broken;
    for(const kind of ['USD','COMBINED']){const [,d1,d2]=w.points(kind);for(const d of [d1,d2]){assert.equal(d.dailyReturn,null,kind);assert.equal(d.pnl,null,kind);assert.match(d.unavailable[0],/settlement corrections could not be read/);assert.equal(d.pnlRange,undefined);}
      const all=w.summary(kind).periods.find(x=>x.label==='All');assert.equal(all.twr,null);assert.equal(all.gain,null);}
    assert.notEqual(w.points('KRW')[1].dailyReturn,null,'the Korean series reads no U.S. correction');}
  // (S4b-1: the corrupt stored timing record case went with C3, which read it.)
});
