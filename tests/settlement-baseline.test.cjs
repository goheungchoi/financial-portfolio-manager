// Stage 2b.4: the U.S. daily-loss baseline follows settlement corrections, and the flow detector takes the tracker's own
// changes as explained (electron/settlement-baseline.cjs, InFlight.explainedSince; stage2b-spec.md B1-B8, F1-F3;
// design tests T25b/T44, T26 (restated under E8), T27, T28, T46, plus the false-deposit case CN2/CN5/CN25).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value,VERSION}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');
const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
const MIN=60000,HOUR=3600000,DAY=86400000,D='2026-11-05',SCOPE={account:'a',environment:'live',market:'US'},W={start:'2026-10-01',end:'2026-11-09'};
const k=(extra={})=>({tradeDate:D,settlementDate:'2026-11-06',ticker:'TEST',side:'Buy',quantity:1,price:100,grossUSD:100,settlementUSD:100,settlementKRW:130000,feesUSD:0,exchangeRate:1300,...extra});
const order=(id,extra={})=>({id,symbol:'NASD:'+(extra.ticker??'TEST'),side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'live',accountKey:'a:US',market:'US',day:D,createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
// The tracker, reconciliation, baseline, a U.S. engine whose loss is measured on the valuation, and the flow detector,
// on one database and one clock. The engine stamps its baseline with the real time, so the test clock runs around it.
function world({limit=30}={}){const db=new DatabaseSync(':memory:');let t=Date.now()-6*HOUR;const clock=()=>t;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock),rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sb=new SettlementBaseline(db,{inFlight:f,clock}),fd=new FlowDetector(db,perf,clock);let day=D,us={cash:500,holdings:[]};const flows={confirmed:0,unresolved:0};
  const snap=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:us.holdings,reportedTotal:us.cash,timestamp:new Date(t).toISOString()});
  const e=new LiveEngine(db,{request:async()=>{}},()=>({status:'connected',snapshot:snap()}),{market:'US'});e.day=()=>day;
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:limit}},'ENABLE LIVE');
  e.netEquityOf=s=>({...value({us:s,inFlight:f.current('a'),fx:{usdKRW:1300},now:t}).markets.US.equity,version:VERSION});
  e.baselineTaken=p=>sb.take('a',p.day,p.baselineAt);e.settlementAdjustments=p=>sb.adjustments('a',p);e.flowsSince=()=>flows;
  let seq=0;const w={db,f,funding,perf,rec,sb,fd,e,flows,clock,us,ledger:f.evidence,
    see:(orders=[],extra={})=>{const r=f.observe('a',{us:{...snap(),...extra},orders,fx:1300});t+=MIN;return r;},
    // A day's baseline, taken on the valuation (the first reading of a day sets the version, the next the baseline).
    baseline:d=>{day='2026-11-03';e.observeBalance(snap());day=d;e.observeBalance(snap());t=Math.max(t,Date.now())+HOUR;return e.policy();},
    loss:()=>e.lossOf(e.policy(),snap()),later:ms=>{t+=ms;},setDay:d=>{day=d;},pid:(id='A')=>f.current('a').open.find(p=>p.id===id)?.pid,
    open:(...orders)=>{w.see();for(const o of orders)funding.track(o);w.see(orders);return orders;},
    reconcile:(extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(),cents:10000,explanation:'settled',route:'USD',kisReference:'KIS',note:'checked',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    reverse:id=>{const q={requestId:'v'+(++seq),account:'a',reconciliationId:id,note:'wrong'};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},
    detect:(orders=[])=>{const v=f.current('a');return fd.observe('a',{krCash:1000000,usCash:us.cash-v.buysUSD+v.sellsUSD,fx:1300,orders,usExplained:range=>f.explained('a',range),usReview:v.review});}};
  return w;}

test('B1: the day\'s baseline saves the tracker\'s pieces, once',()=>{
  const w=world();w.open(order('A'));const p=w.baseline(D);const s=w.sb.get('a',D);assert.equal(s.at,p.baselineAt);assert.deepEqual(Object.values(s.pieces).map(x=>[x.side,x.cents,x.orderId]),[['Buy',10000,'A']]);
  assert.deepEqual(s.orders,['A']);assert.equal(p.baseline,400,'the valuation\'s low bound: $500 cash less the $100 in flight');
  w.reconcile({settledOn:'2026-11-04'});w.sb.take('a',D,p.baselineAt+1);assert.deepEqual(Object.keys(w.sb.get('a',D).pieces).length,1,'the first snapshot stands');
});
test('T25b/T44: paid before the baseline: $40, $40 and $20 move it +40, +40, +20; reversing the second moves it -40; cumulative $60; no false gain',()=>{
  const w=world();w.open(order('A'));w.baseline(D);const adj=()=>w.sb.adjustments('a',w.e.policy()).certain.low;
  const r=[];for(const [c,want] of [[4000,40],[4000,80],[2000,100]]){r.push(w.reconcile({cents:c,settledOn:'2026-11-04'}));assert.equal(adj(),want);assert.equal(w.loss().loss,0,'the value rose with the baseline');}
  w.reverse(r[1].id);assert.equal(adj(),60);assert.equal(w.loss().loss,0);
  // A genuine $35 U.S. market loss the same day stays visible, and breaches the $30 limit.
  w.us.holdings=[{symbol:'X',quantity:1,price:-35}];const l=w.loss();assert.equal(l.loss,35);assert.equal(l.breached,true);assert.match(l.reasons.join(' '),/baseline adjusted for settlement corrections: low \+60\.00/);
});
test('T25 (v3): the adjustment of one piece never exceeds what the baseline included of it; a piece opened after the baseline adjusts nothing',()=>{
  const w=world();w.open(order('A'));w.reconcile({cents:4000,settledOn:'2026-11-02'});w.baseline(D);assert.equal(w.sb.get('a',D).pieces[w.pid()].cents,6000);
  w.reconcile({cents:6000,settledOn:'2026-11-04'});assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,60,'$60 included, $60 adjusted');assert.equal(w.loss().loss,0);
  // A fill after the baseline: its piece was never in the baseline (paid after it, by construction).
  const x=world();x.open();x.baseline(D);const B=order('B',{createdAt:x.clock(),filledObservedAt:x.clock()});x.see([B]);x.reconcile({pieceId:x.pid('B'),settledOn:'2026-11-05'});
  const a=x.sb.adjustments('a',x.e.policy());assert.equal(a.certain.low,0);assert.equal(a.withUnknown,null,'basis 0: nothing to adjust in either scenario');
});
test('B2: a payment after the baseline adjusts nothing (the value already fell with it); a reclassified flow\'s window decides',()=>{
  const w=world();w.open(order('A'));w.baseline(D);const at=w.e.policy().baselineAt;
  const after=w.perf.addFlow('a',{day:D,market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:at+1,occurredBy:at+2});w.us.cash=400;
  w.reconcile({flowId:after.id});const a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,0);assert.equal(a.items.find(i=>i.kind==='reconciliation').timing,'after');assert.equal(w.loss().loss,0,'cash -100, obligation +100');
  const x=world();x.open(order('A'));x.baseline(D);const at2=x.e.policy().baselineAt;const before=x.perf.addFlow('a',{day:D,market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:at2-HOUR,occurredBy:at2-1});x.us.cash=400;
  // The cash fell before the baseline: the baseline had cash -100 and the obligation still counted.
  x.reconcile({flowId:before.id});assert.equal(x.sb.adjustments('a',x.e.policy()).certain.low,100);
});
test('T27: a reversal the same day removes its adjustment; a reversal the next day of an earlier record moves the new baseline back, and a re-resolution moves it at most that much',()=>{
  const w=world();w.open(order('A'));w.baseline(D);const r=w.reconcile({cents:4000,settledOn:'2026-11-04'});assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,40);
  w.reverse(r.id);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,0);assert.equal(w.loss().loss,0);
  const x=world();x.open(order('A'));x.baseline('2026-11-04');const r1=x.reconcile({cents:4000,settledOn:'2026-11-03'});x.baseline(D);assert.equal(x.sb.get('a',D).pieces[x.pid()].cents,6000);
  x.reverse(r1.id);const a=x.sb.adjustments('a',x.e.policy());assert.equal(a.certain.low,-40,'an obligation the baseline never counted');assert.equal(x.loss().loss,0,'no invented breach');
  x.reconcile({cents:10000,settledOn:'2026-11-03'});assert.equal(x.sb.adjustments('a',x.e.policy()).certain.low,60,'-40, then +100: the basis is 60 + 40');assert.equal(x.loss().loss,0);
});
test('T28/T46: unknown payment timing keeps both scenarios with their assumptions; a held deposit and a genuine loss stay visible, no breach is invented; when they disagree, ambiguous',()=>{
  const w=world({limit:30});w.us.holdings=[{symbol:'X',quantity:10,price:100}];w.open(order('A'));w.baseline(D);
  // Reconciled with no settlement date: was the obligation paid before the baseline (adjust) or after it (do not)?
  w.reconcile();const a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,0);assert.equal(a.withUnknown.low,100);assert.equal(a.items.find(i=>i.kind==='reconciliation').timing,'unknown');
  // A held $500 deposit (unresolved) with its cash, and a genuine $25 market loss.
  w.flows.unresolved=500;w.us.cash=1000;w.us.holdings=[{symbol:'X',quantity:10,price:97.5}];let l=w.loss();
  assert.equal(l.breached,false);assert.equal(l.ambiguous,false,'no scenario breaches: no breach invented');
  const named=l.scenarios.map(s=>[s.name,s.loss]);assert.ok(named.some(([n,v])=>/paid before the baseline/.test(n)&&v===25),'the $25 loss is visible under the adjusted assumption');
  assert.equal(l.settlement.assumption,'not adjusted: paid after the baseline');
  // A $40 genuine loss: breached only if the payment was before the baseline: ambiguous (new buys restricted, a protective sale allowed: automation's ambiguous rule).
  w.us.holdings=[{symbol:'X',quantity:10,price:96}];l=w.loss();assert.equal(l.breached,false);assert.equal(l.ambiguous,true);assert.match(l.reasons[0],/breached only with settlement of unknown timing adjusted \(paid before the baseline\)/);
  // Today's settlement date is also unknown relative to the baseline.
  const x=world();x.open(order('A'));x.baseline(D);x.reconcile({settledOn:D});assert.equal(x.sb.adjustments('a',x.e.policy()).items.find(i=>i.kind==='reconciliation').timing,'unknown');
});
test('T26 (restated under E8): reduced coverage moves no baseline; a KIS record above the allocation for an order known at the baseline moves it with the value, and back',()=>{
  const w=world();const [A]=w.open(order('A'));w.reconcile({settledOn:'2026-11-02'});w.ledger.importK(SCOPE,W,[k()]);w.see([A]);w.baseline(D);
  w.ledger.importK(SCOPE,W,[k({settlementUSD:97,grossUSD:97,price:97})]);w.see([A]);assert.equal(w.f.current('a').reducedCoverage[0].usd,3);
  let a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,0);assert.equal(w.loss().loss,0,'reduced coverage changes no value');
  w.ledger.importK(SCOPE,W,[k({settlementUSD:103,grossUSD:103,price:103,settlementDate:'2026-11-09'})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,3);
  a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,-3);assert.equal(w.loss().loss,0,'the correction is not a loss');
  w.ledger.importK(SCOPE,W,[k({settlementUSD:100,grossUSD:100,price:100,settlementDate:'2026-11-10'})]);w.see([A]);assert.equal(w.f.current('a').buysUSD,0);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,0);assert.equal(w.loss().loss,0);
});
test('B5/B7: a pre-tracking fill listed after the baseline, and coverage going under review, move the baseline with the value',()=>{
  const w=world();w.open(order('A'));w.baseline(D);w.see([order('A'),order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}})]);
  assert.equal(w.f.current('a').buysUSD,150);assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,-50);assert.equal(w.loss().loss,0);
  // Its later reconciliation (paid before the baseline) moves it back by its basis.
  w.reconcile({pieceId:w.pid('B'),cents:5000,settledOn:'2026-11-01'});assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,0);assert.equal(w.loss().loss,0);
  const x=world();const [A]=x.open(order('A'));x.ledger.importK(SCOPE,W,[k()]);const g=x.ledger.links('a',[A]).get('A');x.reconcile({settledOn:'2026-11-02',citation:{groupId:g.groupId,version:g.version}});x.baseline(D);
  x.ledger.importK(SCOPE,W,[]);assert.equal(x.f.current('a').buysUSD,100);assert.equal(x.sb.adjustments('a',x.e.policy()).certain.low,-100);assert.equal(x.loss().loss,0);
});
test('B8: with no snapshot for the day, every adjustment is of unknown timing, uncapped',()=>{
  const w=world();w.open(order('A'));w.e.baselineTaken=null;w.baseline(D);assert.equal(w.sb.get('a',D),null);w.reconcile({settledOn:'2026-11-04'});
  const a=w.sb.adjustments('a',w.e.policy());assert.equal(a.snapshot,false);assert.equal(a.certain.low,0);assert.equal(a.withUnknown.low,100);
});
test('F1-F3 (CN2, CN5, CN25): the tracker\'s own changes are explained to the flow detector: no false deposit or withdrawal; a real deposit still is one',()=>{
  const w=world();const [A]=w.open(order('A'));w.detect([A]);w.later(MIN);
  // A reconciliation: the basis rises by $100 with no money moving.
  const r=w.reconcile();w.later(MIN);w.detect([A]);w.later(3*HOUR);assert.deepEqual(w.detect([A]),[],'no deposit from a reconciliation');
  // Its reversal reopens $100: no withdrawal.
  w.reverse(r.id);w.later(MIN);w.detect([A]);w.later(3*HOUR);assert.deepEqual(w.detect([A]),[],'no withdrawal from a reversal');
  // A pre-tracking fill listed late lowers the basis: no withdrawal.
  const B=order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});w.see([A,B]);w.later(MIN);w.detect([A,B]);w.later(3*HOUR);assert.deepEqual(w.detect([A,B]),[],'no withdrawal from a late pre-tracking fill');
  // A reconciliation and a real $200 deposit between the same readings: the deposit alone is detected.
  w.reconcile({pieceId:w.pid('B'),cents:5000});w.us.cash+=200;w.later(MIN);w.detect([A,B]);w.later(3*HOUR);const found=w.detect([A,B]);assert.deepEqual(found.map(x=>[x.market,x.amount,Boolean(x.detected)]),[['US',200,true]]);
});
test('F2: coverage under review and its return are explained to the flow detector',()=>{
  const w=world();const [A]=w.open(order('A'));w.ledger.importK(SCOPE,W,[k()]);const g=w.ledger.links('a',[A]).get('A');w.reconcile({citation:{groupId:g.groupId,version:g.version}});
  w.detect([A]);w.later(MIN);w.ledger.importK(SCOPE,W,[]);assert.equal(w.f.current('a').review.buysUSD,100);w.detect([A]);w.later(3*HOUR);assert.deepEqual(w.detect([A]),[],'no withdrawal while under review');
  w.ledger.importK(SCOPE,W,[k()]);w.later(MIN);w.detect([A]);w.later(3*HOUR);assert.deepEqual(w.detect([A]),[],'no deposit when it holds again');
});
test('F3: explainedSince counts only non-cash, non-fill changes after the time given',()=>{
  const w=world();const t0=w.clock();const [A]=w.open(order('A'));assert.equal(w.f.explainedSince('a',t0-1),-100,'the pre-tracking piece');
  const t1=w.clock();w.see([A],{cash:400});assert.equal(w.f.current('a').buysUSD,0,'settled by cash');assert.equal(w.f.explainedSince('a',t1),0,'cash evidence is not explained here: the detector sees the cash');
});
test('F4: the first tracking reading opens pre-tracking fills the detector already saw: explained, no withdrawal (the live case); one it sees for the first time is explained once',()=>{
  // The detector read the account (and the filled orders) before the tracker's first reading, as on the live profile.
  const w=world();const A=order('A'),S=order('S',{side:'Sell',fillPrice:279.85,limitPrice:279.85,costEstimate:undefined,resultCosts:{netCash:279.85}});
  w.detect([A,S]);w.later(MIN);w.see();w.see([A,S]);assert.equal(w.f.current('a').buysUSD,100);assert.equal(w.f.current('a').sellsUSD,279.85);
  w.detect([A,S]);w.later(3*HOUR);assert.deepEqual(w.detect([A,S]),[],'the tracker opening its pieces is no flow');
  // An order listed for the first time with its pre-tracking fill: the detector explains the fill itself; not twice.
  const B=order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});w.see([A,S,B]);w.later(MIN);w.detect([A,S,B]);w.later(3*HOUR);assert.deepEqual(w.detect([A,S,B]),[]);
});
test('B2: cumulative and capped per piece: a piece grown after the baseline (fees finalised) adjusts at most what the baseline included',()=>{
  const w=world();const [A]=w.open(order('A'));w.baseline(D);w.see([order('A',{resultCosts:{netCash:-110}})]);assert.equal(w.f.current('a').buysUSD,110);
  w.reconcile({cents:6000,settledOn:'2026-11-04'});let a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,60);
  w.reconcile({cents:5000,settledOn:'2026-11-04'});a=w.sb.adjustments('a',w.e.policy());assert.equal(a.certain.low,100,'$60, then $40 of the $50: the baseline included $100');
  assert.deepEqual(a.items.filter(i=>i.kind==='reconciliation').map(i=>i.adjustsUSD),[60,40]);
});
test('B6: a conflict for an order the baseline did not know moves nothing',()=>{
  const w=world();w.open();w.baseline(D);const B=order('B',{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([B]);w.see([B],{cash:400});assert.equal(w.f.current('a').buysUSD,0,'settled by cash after the baseline');
  w.ledger.importK(SCOPE,W,[k({tradeDate:require('../electron/settlement-evidence.cjs').usTradeDate(B),settlementUSD:103,grossUSD:103,price:103})]);w.see([B],{cash:400});
  assert.equal(w.f.current('a').buysUSD,3,'a conflict piece');assert.equal(w.sb.adjustments('a',w.e.policy()).certain.low,0,'its fill came after the baseline');
});
test('B1/B8: after the baseline is decided by the ledger event, not the clock; with no snapshot, a late pre-tracking fill is of unknown timing',()=>{
  const B=()=>order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});
  // A tracker reading in the same millisecond as the baseline, after it.
  const w=world();w.open(order('A'));const at=w.clock();w.sb.take('a',D,at);w.see([order('A'),B()]);
  assert.equal(w.sb.adjustments('a',{day:D,baselineAt:at}).certain.low,-50,'opened after the snapshot, at the same time');
  const x=world();x.open(order('A'));x.e.baselineTaken=null;x.baseline(D);x.see([order('A'),B()]);const a=x.sb.adjustments('a',x.e.policy());
  assert.equal(a.certain.low,0);assert.equal(a.withUnknown.low,-50);
});
