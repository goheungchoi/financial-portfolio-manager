// Stage 3.3 review fixes (stage3-3-independent-review.md): the settlement-date interval, the fingerprint of an approval
// made on the resolution day, the preview binding, and an approval releasing only the days it restates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const E='../electron/';
const {InFlight,value}=require(E+'valuation.cjs');const {FundingLedger}=require(E+'funding-ledger.cjs');const {PerformanceHistory}=require(E+'performance.cjs');
const {Reconciliation}=require(E+'settlement-reconciliation.cjs');const {performanceCorrections}=require(E+'performance-corrections.cjs');const {SettlementRestatements}=require(E+'valuation-corrections.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-02',...extra});
function world(){const db=new DatabaseSync(':memory:');let t=TRACKING;const clock=()=>t;const rate=1300;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sc=performanceCorrections(db,{inFlight:f,reconciliation:rec});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>f.snapshot(a);
  const s=new SettlementRestatements(db,{inFlight:f,reconciliation:rec,performance:perf,corrections:sc,clock});
  const us={cash:500,price:1000};let seq=0;
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
  const w={db,f,perf,rec,s,us,clock,at:ms=>{t=ms;},later:ms=>{t+=ms;},
    see:list=>{f.observe('a',{us:U(),orders:list,fx:rate});t+=MIN;},
    record:()=>{const v=value({us:U(),inFlight:f.current('a'),fx:{usdKRW:rate,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity.low;perf.record('a',{totals:{USD:v,KRW:1000000,equityKRW:1000000+v*rate},fx:{usdKRW:rate}});t+=MIN;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    points:()=>perf.series('a','USD')};
  return w;}
const approval={by:'reviewer',note:'checked'};
// A fill seen on day 0, paid on U.S. settlement date 2026-11-04, reconciled on Seoul day 2026-11-06. Recordings:
// day 0 Seoul 11-02 14:0x; day 1 Seoul 11-04 05:00 (2026-11-03T20:00Z); day 2 Seoul 11-05 15:00 (2026-11-05T06:00Z),
// whose interval wholly contains New York 2026-11-04; day 3 Seoul 11-06 (the reconciliation). Tests 2-3 record day 1
// at Seoul 11-03 23:00 instead, so day 2's interval holds the whole settlement date in both clocks: an eligible candidate.
function scenario({paidAt,day1=Date.parse('2026-11-03T20:00:00Z'),route='USD'}){const w=world();w.see([]);const A=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([A]);w.record();
  w.at(paidAt);w.us.cash=400; // the payment: the cash falls, the tracker sees no reading that matches it
  w.at(day1);w.record();w.at(Date.parse('2026-11-05T06:00:00Z'));w.record();
  w.at(Date.parse('2026-11-06T06:00:00Z'));const r=w.reconcile('A',{settledOn:'2026-11-04',route});w.record();return {w,r};}

test('Stage 3.3 review P1: an audited settlement date does not show whether the KIS debit fell before New York midnight; the candidate must not assume it',()=>{
  // KIS debits on the settlement date in Korean time: Seoul 2026-11-04 01:00 (2026-11-03T16:00Z) is the settlement
  // date in Seoul and still 2026-11-03 in New York. The fall is in day 1's interval, not day 2's.
  const {w,r}=scenario({paidAt:Date.parse('2026-11-03T16:00:00Z')});
  const c=w.s.candidates('a').find(x=>x.id===r.id);
  if(c){const p=w.s.preview('a',r.id);w.s.approve({account:'a',candidateId:r.id,requestId:'q1',binding:p.binding,approval});}
  const [,d1,d2,d3]=w.points();
  // True returns are 0 on every day (prices unchanged; the payment only settles the obligation).
  for(const d of [d1,d2,d3])assert.ok(d.dailyReturn==null||Math.abs(d.dailyReturn)<1e-9,`${d.day}: an approved restatement shows ${d.dailyReturn==null?'n/a':(d.dailyReturn*100).toFixed(2)+'%'} for a day with no investment change`);
});

test('Stage 3.3 review P1: an approval made on the resolution day is dropped by the next ordinary reading of that day',()=>{
  const {w,r}=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z')}); // in day 2's interval: an eligible candidate
  const p=w.s.preview('a',r.id);w.s.approve({account:'a',candidateId:r.id,requestId:'q1',binding:p.binding,approval});
  assert.equal(w.s.inForce('a',w.perf.history('a')).length,1,'in force right after approval');
  w.later(10*MIN);w.us.price=1001;w.record(); // the app records every minute; same Seoul day
  assert.equal(w.s.inForce('a',w.perf.history('a')).length,1,'a later reading of the resolution day is not new historical evidence, yet the approval became inactive');
});

test('Stage 3.3 review P2: the preview binding covers today\'s live value, so any one-minute reading makes the confirmation stale',()=>{
  const {w,r}=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z')});
  w.at(Date.parse('2026-11-07T06:00:00Z'));w.record(); // a later day: the historical window is closed
  const p=w.s.preview('a',r.id);w.later(MIN);w.us.price=1001;w.record(); // the next routine reading
  assert.doesNotThrow(()=>w.s.approve({account:'a',candidateId:r.id,requestId:'q1',binding:p.binding,approval}),'nothing in D..R changed; a routine reading of today should not require a new preview');
});

test('Stage 3.3 review P1: an approval releases only the days it restates; the rest of the misstatement window stays unavailable',()=>{
  const {w,r}=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z')});
  const sc=w.perf.corrections;const rows=w.perf.history('a');
  // Before approval, the 3.2 window covers days 2-3 (from Seoul midnight of the settlement date).
  assert.deepEqual(w.points().filter(p=>(p.unavailable??[]).some(x=>/misstatement window/.test(x))).map(p=>p.day),[rows[2].day,rows[3].day]);
  // An approval whose restated days start later than the window (a narrower evidenced interval) leaves the earlier day withheld.
  const s=w.s;const real=s.inForce.bind(s);s.inForce=()=>[{id:r.id,pieceId:r.pieceId,usd:100,days:[],paymentDay:rows[3].day,resolutionDay:rows[3].day}];
  const pts=w.points();assert.ok(pts[2].unavailable.some(x=>/misstatement window/.test(x)),'day 2 is outside the approved days');assert.ok(!(pts[3].unavailable??[]).some(x=>/misstatement window/.test(x)));
  s.inForce=real;void sc;
});
test('Stage 3.3 review: a changed historical reading of D-1 or R-1 still invalidates an approval',()=>{
  for(const k of [1,2]){const {w,r}=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z')});
    const p=w.s.preview('a',r.id);w.s.approve({account:'a',candidateId:r.id,requestId:'q1',binding:p.binding,approval});assert.equal(w.s.inForce('a',w.perf.history('a')).length,1);
    const row=w.perf.history('a')[k];row.USD.equity+=1;w.db.prepare('UPDATE nav_history SET payload=? WHERE account=? AND day=?').run(JSON.stringify(row),'a',row.day);
    assert.equal(w.s.inForce('a',w.perf.history('a')).length,0,`row ${k} changed`);}
});
test('Stage 3.3 review: a change to the resolution day\'s correction after the preview makes it stale',()=>{
  const {w,r}=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z')});const p=w.s.preview('a',r.id);
  // Another fill from before tracking is first listed on day R: a cash-free change of R's basis.
  w.see([order('B',50,{createdAt:TRACKING-DAY,filledObservedAt:TRACKING-DAY})]);w.record();
  assert.throws(()=>w.s.approve({account:'a',candidateId:r.id,requestId:'q1',binding:p.binding,approval}),/PREVIEW_MISMATCH/);assert.equal(w.s.records('a').length,0);
});
test('Stage 3.3 review of ca1aa11, P1: a buy paid from Korean cash, or by an unknown route, gets no U.S. restatement; its days stay unavailable',()=>{
  // The review's case: $100 paid from KRW on settlement date 2026-11-04; U.S. cash and every price unchanged.
  const w=world();let krw=1000000;
  const record=()=>{const timestamp=new Date(w.clock()).toISOString();
    const v=value({korea:{cash:krw,settledCash:krw,holdings:[],timestamp},us:{cash:w.us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:1000}],timestamp},inFlight:w.f.current('a'),fx:{usdKRW:1300,timestamp},now:w.clock()});
    w.perf.record('a',{totals:{USD:v.markets.US.equity.low,KRW:v.markets.KR.equity.low,equityKRW:v.combined.low},fx:{usdKRW:1300}});w.later(MIN);};
  w.see([]);w.see([order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()})]);record();
  w.at(Date.parse('2026-11-03T14:00:00Z'));record();w.at(Date.parse('2026-11-04T12:00:00Z'));krw-=130000;w.at(Date.parse('2026-11-05T06:00:00Z'));record();
  w.at(Date.parse('2026-11-06T06:00:00Z'));const r=w.reconcile('A',{settledOn:'2026-11-04',route:'KRW'});record();
  assert.deepEqual(w.s.candidates('a'),[]);assert.throws(()=>w.s.preview('a',r.id),/HISTORICAL_TIMING_UNPROVEN/);
  const pts=w.points();for(const d of pts.slice(2))assert.equal(d.dailyReturn,null,`${d.day} stays unavailable`);
  // The same payment with the route unknown; and the eligible U.S.-cash case still gives a candidate.
  const u=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z'),route:'unknown'});assert.deepEqual(u.w.s.candidates('a'),[]);
  const usd=scenario({paidAt:Date.parse('2026-11-04T12:00:00Z'),day1:Date.parse('2026-11-03T14:00:00Z')});assert.equal(usd.w.s.candidates('a').length,1);
});
