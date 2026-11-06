// Stage 3.2: performance is unavailable unless bounded (electron/performance-corrections.cjs SettlementUncertainty,
// PerformanceHistory.series/summary; stage3-spec.md U1-U6; design v3.3 §3, T41 replaced).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {performanceCorrections,earliestPayment}=require('../electron/performance-corrections.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-01',createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
// As main wires it: the correction hook from performanceCorrections, and the tracker's snapshot recorded with each day.
function world(start=TRACKING,db=new DatabaseSync(':memory:')){let t=start;const clock=()=>t;let rate=1300;
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
const {SettlementRestatements}=require('../electron/valuation-corrections.cjs');
test('a settlement date includes the complete New York day across both clock changes',()=>{
  const {paymentDateInterval}=require('../electron/settlement-restatements.cjs');
  // From Seoul midnight of the date (stage 3.3 review, P1) to the end of the New York day, across both clock changes.
  assert.deepEqual(paymentDateInterval('2026-11-01'),[Date.parse('2026-10-31T15:00:00Z'),Date.parse('2026-11-02T05:00:00Z')-1]);
  assert.deepEqual(paymentDateInterval('2026-03-08'),[Date.parse('2026-03-07T15:00:00Z'),Date.parse('2026-03-09T04:00:00Z')-1]);
});
function service(w){return new SettlementRestatements(w.db,{inFlight:w.f,reconciliation:w.rec,performance:w.perf,corrections:w.sc,clock:w.clock});}
function example({unknown=false,other=false}={}){
  // T40: payment on D, recovery on R, start-of-day deposit and withdrawal.
  const w=world();w.see([]);const a=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});w.see([a]);
  w.us.price=600;w.record(); // 500 + 600 - 100 = 1000
  if(other)w.see([a,order('B',50)]);
  // Day 1 (D): the $100 payment falls from U.S. cash while the obligation is still counted. A real supported source
  // (stage 3.3 review of ca1aa11): the flow detector's -$100 change, with its recorded interval, later reclassified as
  // the payment. Without it (unknown), there is no evidenced payment interval.
  const day0=w.perf.history('a')[0].at;w.nextDay();w.perf.addFlow('a',{day:'2026-11-03',market:'US',amount:500,note:'deposit'});
  const paid=unknown?null:w.perf.addFlow('a',{day:'2026-11-03',market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:day0+1,occurredBy:w.clock()});
  w.us.cash=900;w.us.price=630;w.record(); // 1430
  w.nextDay();w.perf.addFlow('a',{day:'2026-11-04',market:'US',amount:-200,note:'withdrawal'});w.us.cash=700;w.us.price=616.7;w.record(); // 1216.70
  w.nextDay();w.us.price=629.867;const rec=w.reconcile('A',paid?{flowId:paid.id}:{});w.record(); // 1329.867
  return {w,rec,s:service(w)};
}
const approve=(s,p,id='approve1')=>s.approve({account:'a',candidateId:p.candidate.id,requestId:id,binding:p.binding,approval:{by:'reviewer',note:'Checked payment and historical values'}});
test('T20/T24/T40: preview is read-only; explicit approval restates D..R-1 and removes the recovery correction together',()=>{
  const {w,rec,s}=example();const before=JSON.stringify(w.perf.history('a'));assert.equal(s.candidates('a')[0].source,'reclassified flow');const p=s.preview('a',rec.id);
  assert.equal(p.label,'if approved');assert.equal(s.records('a').length,0);assert.equal(JSON.stringify(w.perf.history('a')),before);
  const all=x=>x.periods.find(p=>p.label==='All');assert.equal(all(p.before.USD).twr,null);
  const pts=p.after.USD.points;close(pts[1].dailyReturn,.02);close(pts[2].dailyReturn,-.01);close(pts[3].dailyReturn,.01, 'day R');
  close(all(p.after.USD).twr,.019898);assert.equal(pts[3].correction,0);assert.equal(pts[1].adjustment,100);
  const r=approve(s,p);assert.equal(r.version,1);assert.deepEqual(r.preview.after,p.after);assert.deepEqual(w.summary().points,p.after.USD.points);assert.equal(JSON.stringify(w.perf.history('a')),before);
  assert.equal(approve(s,p).id,r.id);assert.equal(s.records('a').length,1);
});
test('approval requires identity, note and preview binding; stale flow or historical reading refuses atomically',()=>{
  const {w,rec,s}=example();const p=s.preview('a',rec.id);
  assert.throws(()=>s.approve({account:'a',candidateId:rec.id,requestId:'x',binding:p.binding}),/APPROVAL_REQUIRED/);
  w.perf.addFlow('a',{day:'2026-11-04',market:'US',amount:1,note:'late flow'});
  assert.throws(()=>approve(s,p),/PREVIEW_MISMATCH/);assert.equal(s.records('a').length,0);
  assert.throws(()=>s.preview('b',rec.id),/HISTORICAL_TIMING_UNPROVEN/);
});
test('unknown timing creates no candidate and cannot be approved',()=>{const {w,rec,s}=example({unknown:true});assert.deepEqual(s.candidates('a'),[]);assert.throws(()=>s.preview('a',rec.id),/HISTORICAL_TIMING_UNPROVEN/);assert.equal(w.all().twr,null);});
test('reversal invalidates an approval without deleting it; unrelated uncertainty stays unavailable',()=>{
  const {w,rec,s}=example();approve(s,s.preview('a',rec.id));w.nextDay();w.reverse(rec.id);w.record();assert.equal(s.inForce('a').length,0);assert.equal(s.records('a').length,1);
  const x=example({other:true});const p=x.s.preview('a',x.rec.id);assert.equal(p.after.USD.periods.find(p=>p.label==='All').twr,null);
});
test('approved overlays convert each day at its recorded FX; Korea unchanged; append-only migration repeated',()=>{
  const {w,rec,s}=example();const p=s.preview('a',rec.id);assert.deepEqual(p.before.KRW,p.after.KRW);close(p.after.COMBINED.points[1].adjustment,130000);
  approve(s,p);assert.throws(()=>w.db.exec('DELETE FROM valuation_settlement_approvals'),/append-only/);const again=service(w);assert.equal(again.records('a').length,1);assert.equal(again.inForce('a').length,1);
});
test('calendar evidence must fit wholly inside a recorded interval; paid earlier alone is not enough',()=>{
  const w=world();w.see([]);w.see([order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()})]);w.record();
  w.nextDay();w.later(DAY);w.us.cash=400;w.record();w.nextDay();const r=w.reconcile('A',{settledOn:'2026-11-03'});w.record();const s=service(w);
  assert.equal(s.candidates('a')[0].source,'audited settlement date');const p=s.preview('a',r.id);assert.equal(p.after.USD.points.at(-1).correction,0);approve(s,p);
  const x=example({unknown:true});x.w.sc.timing=()=>[{candidate:x.rec.id,paidHere:false,entry:{after:x.w.perf.history('a')[1].at,by:x.w.perf.history('a')[2].at}}];assert.deepEqual(x.s.candidates('a'),[]);
});
test('reclassified payment removes its negative correction as well as the reconciliation correction',()=>{
  const w=world();w.see([]);w.see([order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()})]);w.record();w.nextDay();
  const previous=w.perf.history('a')[0].at;w.us.cash=400;
  const f=w.perf.addFlow('a',{day:'2026-11-03',market:'US',amount:-100,detected:true,note:'payment',occurredAfter:previous+1,occurredBy:w.clock()});w.record();
  w.nextDay();const r=w.reconcile('A',{flowId:f.id});w.record();const s=service(w),p=s.preview('a',r.id);
  assert.equal(p.after.USD.points[1].correction,undefined);close(p.after.USD.points[1].pnl,0);close(p.after.USD.points[2].pnl,0);close(p.after.USD.periods.find(x=>x.label==='All').twr,0);
});
test('overlapping partial approvals add amounts once; another open portion keeps uncertainty',()=>{
  // Paid on settlement date 2026-11-03, wholly inside day 1's interval in both clocks (day 1 is recorded two days on).
  const w=world();w.see([]);w.see([order('A',100)]);w.record();w.nextDay();w.later(DAY);w.us.cash=400;w.record();w.nextDay();
  const r1=w.reconcile('A',{cents:6000,settledOn:'2026-11-03'});const r2=w.reconcile('A',{cents:4000,settledOn:'2026-11-03'});w.record();const s=service(w);
  assert.deepEqual(s.candidates('a').map(c=>[c.id,c.source,c.usd]),[[r1.id,'audited settlement date',60],[r2.id,'audited settlement date',40]]);
  const p1=s.preview('a',r1.id);approve(s,p1,'part1');assert.equal(w.points()[1].dailyReturn,null);
  const p2=s.preview('a',r2.id);approve(s,p2,'part2');assert.equal(w.points()[1].adjustment,100);close(w.points()[1].dailyReturn,0);close(w.points()[2].dailyReturn,0);
  assert.throws(()=>s.preview('a',r1.id),/ALREADY_APPROVED/);assert.equal(s.records('a').length,2);
});
test('failed approval writes nothing; historical values and existing approved adjustments stay intact',()=>{
  const {w,rec,s}=example();const p=s.preview('a',rec.id);
  w.db.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON valuation_settlement_approvals WHEN NEW.requestId NOT LIKE 'preview:%' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(()=>approve(s,p),/injected/);assert.equal(s.records('a').length,0);w.db.exec('DROP TRIGGER fail_approval');approve(s,p);
  const {ValuationCorrections}=require('../electron/valuation-corrections.cjs');const legacy=new ValuationCorrections(w.db,w.clock);w.perf.adjustments=a=>legacy.inForce(a);
  legacy.apply('a',[{day:w.perf.history('a')[1].day,market:'US',amount:5,reason:'separate',evidence:'record'}],{by:'reviewer'});
  assert.equal(w.points()[1].adjustment,105);assert.equal(s.inForce('a').length,1);
});
test('file-backed restart reloads approvals and the exact derived history; repeated schema setup is harmless',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restatement-')),file=path.join(dir,'test.sqlite');
  const w=world(TRACKING,new DatabaseSync(file));w.see([]);w.see([order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()})]);w.record();w.nextDay();w.later(DAY);w.us.cash=400;w.record();w.nextDay();
  const r=w.reconcile('A',{settledOn:'2026-11-03'});w.record();const s=service(w);approve(s,s.preview('a',r.id));const before=w.points();w.db.close();
  const x=world(TRACKING,new DatabaseSync(file));const reopened=service(x);assert.equal(reopened.records('a').length,1);assert.deepEqual(x.points(),before);service(x);assert.deepEqual(x.points(),before);x.db.close();fs.rmSync(dir,{recursive:true});
});
test('identical K imports preserve approval; coverage review invalidates it and restoration requires a new approval',()=>{
  const w=world();w.see([]);w.see([order('A',100)]);w.record();w.nextDay();w.later(DAY);w.us.cash=400;w.record();w.nextDay();
  const scope={account:'a',environment:'live',market:'US'},win={start:'2026-11-01',end:'2026-11-01'};
  const row={ticker:'TA',side:'Buy',tradeDate:'2026-11-01',quantity:1,price:100,grossUSD:100,settlementUSD:100,settlementDate:'2026-11-03',exchangeRate:1300};
  w.f.evidence.importK(scope,win,[row]);const g=w.f.evidence.kGroups('a')[0];const r=w.reconcile('A',{settledOn:'2026-11-03',citation:{groupId:g.id,version:1}});w.record();
  const s=service(w);approve(s,s.preview('a',r.id));w.later(MIN);w.f.evidence.importK(scope,win,[row]);assert.equal(s.inForce('a').length,1);
  w.f.evidence.importK(scope,win,[]);assert.equal(s.inForce('a').length,0);w.f.evidence.importK(scope,win,[row]);assert.equal(s.inForce('a').length,0);
  const p=s.preview('a',r.id);approve(s,p,'new-approval');assert.equal(s.records('a').length,2);assert.equal(s.inForce('a').length,1);
});


