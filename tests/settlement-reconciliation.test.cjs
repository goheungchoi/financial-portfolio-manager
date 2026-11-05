// Stage 2b.3: the manual reconciliation backend (electron/settlement-reconciliation.cjs; stage2b-spec.md R1-R10;
// design tests T2, T3 (v3), T13, T15, T16, T17, T18 (v2), T25a/T43, T29, T30, T38, T42 (v3.2), plus atomicity,
// append-only records, rounding and the funding alignment).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');
const MIN=60000,D='2026-11-05',SCOPE={account:'a',environment:'live',market:'US'},W={start:'2026-10-01',end:'2026-11-05'};
const k=(ticker='TEST',extra={})=>({tradeDate:D,settlementDate:'2026-11-06',ticker,side:'Buy',quantity:1,price:100,grossUSD:100,settlementUSD:100,settlementKRW:130000,feesUSD:0,exchangeRate:1300,...extra});
// A U.S. buy as the engine lists it; the same record enters the funding ledger.
const order=(id,extra={})=>({id,symbol:'NASD:'+(extra.ticker??'TEST'),side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'live',accountKey:'a:US',market:'US',day:D,createdAt:Date.parse(D+'T15:00:00Z'),...extra});
const INPUTS={kCash:1000000,uCash:500,reportedKRW:0,rate:1300};
function world({regime=null,u6=false,db=new DatabaseSync(':memory:')}={}){let t=Date.parse(D+'T20:00:00Z');const clock=()=>t;
  let f=new InFlight(db,clock),funding=new FundingLedger(db,{clock,regime}),perf=new PerformanceHistory(db,clock);
  const make=()=>new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'tester',session:'s1'},u6Verified:u6});let rec=make();
  const w={db,clock,get rec(){return rec;},get f(){return f;},get funding(){return funding;},get perf(){return perf;},get ledger(){return f.evidence;},
    see:(us,orders=[])=>{const r=f.observe('a',{us:{timestamp:new Date(t).toISOString(),environment:'live',...us},orders,fx:1300});t+=MIN;return r;},
    current:()=>f.current('a'),pid:(id='A')=>f.current('a').open.find(p=>p.id===id)?.pid,later:ms=>{t+=ms;},
    restart:()=>{f=new InFlight(db,clock);funding=new FundingLedger(db,{clock,regime});perf=new PerformanceHistory(db,clock);rec=make();},
    // An open $100 buy piece for each order: tracking starts, then the fills appear with cash unchanged.
    open:(...orders)=>{w.see({cash:500});for(const o of orders)funding.track(o);w.see({cash:500},orders);return orders;},
    req:(extra={})=>({requestId:'r'+Math.random().toString(36).slice(2),account:'a',pieceId:w.pid(),cents:10000,explanation:'settled',route:'USD',kisReference:'KIS 2026-11-06 settlement 0001',note:'checked in the KIS app',...extra}),
    // Preview, then confirm what was previewed.
    reconcile:(extra={},ctx={})=>{const q=w.req(extra);const p=rec.preview(q,ctx);return {preview:p,record:rec.confirm({...q,stateVersion:p.stateVersion},ctx),request:q};},
    reverse:(id,extra={})=>{const q={requestId:'v'+Math.random().toString(36).slice(2),account:'a',reconciliationId:id,note:'entered against the wrong order',...extra};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion});},
    count:table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n,allocatedTo:pid=>f.evidence.allocatedToPiece(pid)};
  return w;}
const code=(fn,c)=>assert.throws(fn,e=>e.code===c||e.message===c,c);

test('R1/T13: required fields are enforced, and a buy settled needs its funding route',()=>{
  const w=world();w.open(order('A'));const q=w.req();
  for(const [field,c] of [['requestId','REQUEST_ID_REQUIRED'],['pieceId','PIECE_REQUIRED'],['cents','AMOUNT_REQUIRED'],['explanation','EXPLANATION_REQUIRED'],['kisReference','KIS_REFERENCE_REQUIRED'],['note','NOTE_REQUIRED']])code(()=>w.rec.preview({...q,[field]:field==='cents'?0:'  '}),c);
  code(()=>w.rec.preview({...q,route:undefined}),'ROUTE_REQUIRED');code(()=>w.rec.preview({...q,route:'EUR'}),'ROUTE_INVALID');code(()=>w.rec.preview({...q,settledOn:'2026-13-40'}),'SETTLED_ON_INVALID');
  code(()=>w.rec.preview({...q,pieceId:'nope'}),'PIECE_NOT_OPEN');code(()=>w.rec.confirm(q),'STATE_VERSION_REQUIRED');
  assert.equal(w.count('settlement_reconciliations'),0);assert.equal(w.current().buysUSD,100,'nothing applied');
});
test('T25a/T43: $40 and $40 accepted, a further $40 refused before any preview, $20 after an explicit preview; the piece resolved, allocations $100',()=>{
  const w=world();w.open(order('A'));const pid=w.pid();
  w.reconcile({cents:4000});w.reconcile({cents:4000});assert.equal(w.current().buysUSD,20);
  const events=w.count('settlement_events');assert.throws(()=>w.rec.preview(w.req({cents:4000})),e=>e.code==='AMOUNT_EXCEEDS_REMAINING'&&e.remainingCents===2000);assert.equal(w.count('settlement_events'),events,'refused before the preview: nothing written');
  const {preview}=w.reconcile({cents:2000});assert.equal(preview.after.tracker.buysUSD,0);
  assert.equal(w.current().buysUSD,0);assert.equal(w.current().open.length,0);assert.equal(w.allocatedTo(pid),10000,'Σ allocations = $100');assert.equal(w.rec.active('a').length,3);
});
test('T13: the preview equals the effect applied; a reading between preview and confirmation refuses it, and the refreshed preview applies',()=>{
  const w=world();w.open(order('A'));const q=w.req({cents:6000});const p=w.rec.preview(q,{inputs:INPUTS,balances:{us:{cash:500,timestamp:new Date(w.clock()).toISOString()},fx:{usdKRW:1300}}});
  assert.equal(p.before.tracker.buysUSD,100);assert.equal(p.after.tracker.buysUSD,40);assert.equal(p.before.funding.USD,100);assert.equal(p.after.funding.USD,40);
  assert.equal(p.before.valuation.US.low,400);assert.equal(p.after.valuation.US.low,460);assert.equal(w.count('settlement_reconciliations'),0,'a preview writes nothing');
  w.see({cash:500},[order('A')]);
  assert.throws(()=>w.rec.confirm({...q,stateVersion:p.stateVersion}),e=>e.code==='STATE_CHANGED'&&e.preview&&e.preview.stateVersion!==p.stateVersion);
  assert.equal(w.count('settlement_reconciliations'),0);let fresh;try{w.rec.confirm({...q,stateVersion:p.stateVersion});}catch(e){fresh=e.preview;}
  const ctx={inputs:INPUTS};const p2=w.rec.preview(q,ctx);assert.equal(p2.stateVersion,fresh.stateVersion);const r=w.rec.confirm({...q,stateVersion:p2.stateVersion},ctx);
  assert.deepEqual(r.preview.after,p2.after,'the record keeps the preview');assert.deepEqual(w.rec.values('a',ctx),p2.after,'the state after equals the preview');
  assert.equal(r.confirmedBy.user,'tester');assert.equal(r.kisReference,'KIS 2026-11-06 settlement 0001');assert.equal(r.evidence.piece.usd,100);
});
test('T15: a repeated confirmation (same request id, or same content previewed on the same state) has one effect; a reused id for other content is refused',()=>{
  const w=world();w.open(order('A'));const q=w.req({cents:3000});const p=w.rec.preview(q);const a=w.rec.confirm({...q,stateVersion:p.stateVersion});
  const events=w.count('settlement_events');const again=w.rec.confirm({...q,stateVersion:p.stateVersion});assert.equal(again.repeat,true);assert.equal(again.id,a.id);
  const other=w.rec.confirm({...q,requestId:'another',stateVersion:p.stateVersion});assert.equal(other.repeat,true);assert.equal(other.id,a.id,'same content hash, new request id');
  assert.equal(w.count('settlement_events'),events);assert.equal(w.current().buysUSD,70,'one effect');
  code(()=>w.rec.confirm({...q,cents:1000,stateVersion:p.stateVersion}),'REQUEST_ID_REUSED');
  // A second, deliberate $30 (a new preview, so a new state version) is a record of its own.
  w.reconcile({cents:3000});assert.equal(w.current().buysUSD,40);assert.equal(w.rec.active('a').length,2);
});
test('T16: a restart between preview and confirmation, and after it: the same values from the records',()=>{
  const w=world();w.open(order('A'));const q=w.req({cents:2500});const p=w.rec.preview(q,{inputs:INPUTS});
  w.restart();assert.equal(w.rec.preview(q,{inputs:INPUTS}).stateVersion,p.stateVersion,'the state version is the stored state');
  w.rec.confirm({...q,stateVersion:p.stateVersion},{inputs:INPUTS});const after=w.rec.values('a',{inputs:INPUTS});
  w.restart();assert.deepEqual(w.rec.values('a',{inputs:INPUTS}),after);assert.deepEqual(after,p.after);assert.equal(w.current().buysUSD,75);
});
test('T2 (v3): a K row is shown, not used; reconciled with route USD, the obligation resolves and capacity rises by that amount only',()=>{
  const w=world();const [A,B]=w.open(order('A'),order('B',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}}));
  w.ledger.importK(SCOPE,W,[k()]);assert.equal(w.ledger.links('a',[A,B]).get('A').state,'linked');assert.equal(w.see({cash:500},[A,B]).buysUSD,150,'K resolves nothing');
  const cap=()=>({KR:w.funding.capacity({account:'a',market:'KR',inputs:INPUTS}),US:w.funding.capacity({account:'a',market:'US',inputs:INPUTS})});const c0=cap();
  const g=w.ledger.links('a',[A]).get('A');const {record}=w.reconcile({citation:{groupId:g.groupId,version:g.version}});
  assert.equal(w.current().buysUSD,50,'A resolved; B open');assert.equal(record.effects.funding.cents,10000);assert.ok(record.effects.citationId);
  const c=w.funding.commitments('a');assert.equal(c.usd,50);assert.equal(c.rows.find(x=>x.orderId==='B').amount,50,'other commitments unchanged');
  const c1=cap();assert.ok(Math.abs(c1.US-c0.US-100)<0.01,`U.S. capacity +$100 (${c0.US} → ${c1.US})`);assert.ok(Math.abs(c1.KR-c0.KR-100*1326)<1,'Korean capacity +$100 at ρ');
  assert.equal(w.ledger.citations('a').length,1);assert.deepEqual(w.ledger.underReview('a'),[]);
});
test('T3 (v3): "settled, route unknown" resolves the valuation, and the commitment stays for capacity',()=>{
  const w=world();w.open(order('A'));const before=w.funding.commitments('a').usd;const {record}=w.reconcile({route:'unknown'});
  assert.equal(w.current().buysUSD,0);assert.equal(w.current().unresolved.buysUSD,0);assert.equal(record.effects.funding.cents,0);assert.match(record.effects.funding.reason,/route unknown/);
  assert.equal(w.funding.commitments('a').usd,before);assert.equal(w.count('funding_releases'),0);
});
test('R9: the whole order reconciled with named routes releases the rest of its filled part, the difference recorded as an alignment; route unknown blocks it',()=>{
  // The live case: the funding estimate is a cent above the tracker's net cash.
  const w=world();w.open(order('A',{costEstimate:{netCash:-100.01}}));assert.equal(w.funding.commitments('a').usd,100.01);
  const {record}=w.reconcile();assert.equal(record.effects.funding.cents,10001);assert.equal(record.effects.funding.alignmentCents,1);assert.equal(w.funding.commitments('a').usd,0);
  // Two parts, both named: the second releases the rest.
  const x=world();x.open(order('A',{costEstimate:{netCash:-100.01}}));x.reconcile({cents:6000,route:'USD'});assert.equal(x.funding.commitments('a').usd,40.01);
  const second=x.reconcile({cents:4000,route:'KRW'}).record;assert.equal(second.effects.funding.alignmentCents,1);assert.equal(x.funding.commitments('a').usd,0);
  // One part with its route unknown: nothing more than the named part is released.
  const y=world();y.open(order('A',{costEstimate:{netCash:-100.01}}));y.reconcile({cents:6000,route:'USD'});y.reconcile({cents:4000,route:'unknown'});assert.equal(y.funding.commitments('a').usd,40.01);
});
test('T38: planned USD, paid in KRW: the release follows the actual route, once, and free funds are right after settlement',()=>{
  const w=world({regime:'integrated-usd-first'});w.open(order('A',{quantity:5,filled:5,costEstimate:{netCash:-500},resultCosts:{netCash:-500}}));
  // Before settlement: USD-first plan, $500 USD cash covers it.
  assert.equal(w.funding.capacity({account:'a',market:'KR',inputs:INPUTS}),1000000);
  // Paid in KRW (₩650,000): Korean cash falls, U.S. cash does not; reconciled with route KRW.
  const after={...INPUTS,kCash:350000};const {record}=w.reconcile({cents:50000,route:'KRW'});assert.equal(record.route,'KRW');assert.equal(record.effects.funding.cents,50000);
  assert.equal(w.funding.releasedCents('A'),50000);code(()=>w.rec.preview(w.req({pieceId:record.pieceId,cents:100})),'PIECE_NOT_OPEN');assert.equal(w.funding.releasedCents('A'),50000,'nothing released twice');
  assert.equal(w.funding.capacity({account:'a',market:'KR',inputs:after}),350000);assert.ok(Math.abs(w.funding.capacity({account:'a',market:'US',inputs:after})-(500+350000/1326))<0.01,'USD free again: it was not spent');
});
test('T29: standby K coverage is not consumed; reversing the reconciliation promotes it, with no double allocation; consumed elsewhere, the piece reopens',()=>{
  const run=({consume=false,u6=true}={})=>{const w=world({u6});const [A]=w.open(order('A'));w.ledger.importK(SCOPE,W,[k()]);const pid=w.pid();const {record}=w.reconcile();
    const s=w.rec.corroborate('a',[A]);const g=w.ledger.links('a',[A]).get('A');
    if(u6){assert.equal(s.length,1);assert.equal(w.ledger.allocated(g.groupId,g.version),0,'standby, not consumed');}else assert.equal(s.length,0,'K is not valid evidence before U6');
    if(consume)w.ledger.allocate({account:'a',evidenceId:g.groupId,version:g.version,pieceId:'elsewhere',orderId:'Z',cents:10000,rule:'test'});
    const v=w.reverse(record.id);return {w,pid,v,g};};
  const ok=run();assert.equal(ok.v.effects.reopenedCents,0);assert.equal(ok.w.current().buysUSD,0,'stays resolved');assert.equal(ok.w.allocatedTo(ok.pid),10000,'K now, M reversed: no double allocation');
  assert.equal(ok.w.ledger.standbyFor(ok.pid)[0].promotedCents,10000);
  const gone=run({consume:true});assert.equal(gone.v.effects.reopenedCents,10000);assert.equal(gone.w.current().buysUSD,100,'reopens');assert.match(gone.v.effects.promoted[0].reason,/consumed elsewhere/);
  // Without U6 a K standby is never recorded, and one recorded anyway is not promoted.
  const off=run({u6:false});assert.equal(off.w.current().buysUSD,100);
  const x=world();x.open(order('A'));x.ledger.importK(SCOPE,W,[k()]);const g=x.ledger.links('a',[order('A')]).get('A');const {record}=x.reconcile();x.ledger.standby({account:'a',evidenceId:g.groupId,version:g.version,pieceId:record.pieceId,cents:10000});
  const v=x.reverse(record.id);assert.equal(v.effects.reopenedCents,10000);assert.match(v.effects.promoted[0].reason,/U6/);
});
test('T30/T17: $60 reconciled, a later cash settlement covers $40, reversing the reconciliation reopens $60 only; both records kept; no reversal of a reversal',()=>{
  const w=world();const [A]=w.open(order('A'));const pid=w.pid();const {record}=w.reconcile({cents:6000});
  const r=w.see({cash:460},[A]);assert.equal(r.buysUSD,0,'the $40 cash fall settles the rest');
  const v=w.reverse(record.id);assert.equal(v.effects.reopenedCents,6000);assert.equal(w.current().buysUSD,60);assert.equal(w.allocatedTo(pid),4000,'the cash settlement stays');
  assert.equal(w.current().open[0].pid,pid);assert.equal(w.current().open[0].unresolved.why,'awaiting verification','the piece as it was before the record');
  assert.equal(w.rec.records('a').length,2);assert.equal(w.rec.active('a').length,0);
  code(()=>w.reverse(v.id),'REVERSAL_OF_REVERSAL');code(()=>w.reverse(record.id),'ALREADY_REVERSED');
  // Reconciling again after the reversal works as a new record.
  w.reconcile({pieceId:pid,cents:6000});assert.equal(w.current().buysUSD,0);
  // The funding release followed: released, reinstated, released again.
  assert.equal(w.funding.releasedCents('A'),6000);
});
test('T18: a detected withdrawal that was the payment is reclassified in the same transaction; the reversal restores it',()=>{
  const w=world();w.open(order('A'));const flow=w.perf.addFlow('a',{day:D,market:'US',amount:-100,detected:true,note:'Detected: U.S. cash fell'});
  code(()=>w.rec.preview(w.req({flowId:flow.id,cents:6000})),'FLOW_SPLIT_REQUIRED');
  const {preview,record}=w.reconcile({flowId:flow.id});assert.deepEqual(preview.after.flows,[]);assert.deepEqual(w.perf.flows('a'),[]);
  assert.equal(record.effects.effect.correctionCents,0,'E = 0: cash −$100 against an obligation of +$100');assert.equal(record.effects.effect.basis,'settlement in a tracked pair');
  w.reverse(record.id);assert.deepEqual(w.perf.flows('a'),[flow],'restored as it was');assert.equal(w.current().buysUSD,100);
  code(()=>w.rec.preview(w.req({flowId:flow.id,explanation:'rounding',cents:100})),'FLOW_NEEDS_SETTLEMENT');
});
test('T42 (v3.2): payment, deposit and an unrelated fill in one pair: the manual split replaces the held +$400 exactly; a split of $390 is refused, or kept with $10 unexplained',()=>{
  const w=world();w.open(order('A'));
  // The flow detector held +$400 (observed +$200, explained −$200 by the unrelated buy) and recorded it as detected.
  const flow=w.perf.addFlow('a',{day:D,market:'US',amount:400,detected:true,note:'Detected: U.S. cash rose',occurredAfter:1,occurredBy:2});
  const bad=[{kind:'settlement',cents:-10000},{kind:'deposit',cents:49000}];
  assert.throws(()=>w.rec.preview(w.req({flowId:flow.id,split:bad})),e=>e.code==='FLOW_SPLIT_MISMATCH'&&e.flowCents===40000&&e.splitCents===39000&&e.differenceCents===1000);
  code(()=>w.rec.preview(w.req({flowId:flow.id,split:[{kind:'settlement',cents:-9000},{kind:'deposit',cents:49000}]})),'FLOW_SETTLEMENT_MISMATCH');
  code(()=>w.rec.preview(w.req({flowId:flow.id,split:[{kind:'settlement',cents:-10000},{kind:'deposit',cents:-50000},{kind:'unexplained',cents:100000}]})),'FLOW_SPLIT_SIGN');
  const {record}=w.reconcile({flowId:flow.id,split:[{kind:'settlement',cents:-10000},{kind:'deposit',cents:50000,kisReference:'KIS deposit 0042'}]});
  const flows=w.perf.flows('a');assert.equal(flows.length,1);assert.equal(flows[0].amount,500);assert.ok(!flows[0].detected,'a recorded deposit');assert.match(flows[0].note,/KIS deposit 0042/);
  assert.equal(flows[0].occurredBy,2);const split=record.effects.flows;assert.equal(split.added.reduce((n,a)=>n+a.cents,0)+split.settlementCents,40000,'the entries sum to the held amount, to the cent');
  assert.equal(50000-10000-20000,20000,'with the unrelated −$200 fill: the observed +$200');assert.equal(record.effects.effect.correctionCents,0,'E = 0');
  // Kept with $10 unexplained, by explicit choice: a detected flow again, still held.
  const x=world();x.open(order('A'));const f2=x.perf.addFlow('a',{day:D,market:'US',amount:400,detected:true,note:'Detected'});
  x.reconcile({flowId:f2.id,split:[...bad,{kind:'unexplained',cents:1000}]});const kept=x.perf.flows('a');
  assert.deepEqual(kept.map(f=>[f.amount,Boolean(f.detected)]).sort(),[[10,true],[490,false]]);assert.equal(kept.reduce((n,f)=>n+Math.round(f.amount*100),0)-10000,40000,'flows and the settlement sum to the held amount');
});
test('R1: rounding closes only a remainder under $1, exactly, and releases funding only when it completes a fully reconciled order',()=>{
  const w=world();const [A]=w.open(order('A'));w.see({cash:400.4},[A]);const r=w.current();assert.equal(r.open[0].unresolved.why,'evidence short');assert.equal(r.buysUSD,0.4);
  code(()=>w.rec.preview(w.req({explanation:'rounding',cents:30})),'ROUNDING_NOT_REMAINDER');const {record}=w.reconcile({explanation:'rounding',cents:40,route:undefined});
  assert.equal(w.current().buysUSD,0);assert.equal(record.effects.effect.basis,'rounding');assert.equal(record.effects.funding.cents,0,'evidence, not a reconciliation, covered the rest: nothing released');
  const y=world();y.open(order('A'));y.reconcile({cents:9960});const last=y.reconcile({explanation:'rounding',cents:40,route:undefined}).record;assert.equal(last.effects.funding.cents,40,'the whole order reconciled: its last cents released');assert.equal(y.funding.commitments('a').usd,0);
});
test('R4 atomicity: a failure inside the apply transaction leaves nothing written',()=>{
  const w=world();w.open(order('A'));w.ledger.importK(SCOPE,W,[k('TEST',{settlementUSD:50,grossUSD:50})]);const g=w.ledger.kGroups('a')[0];
  const before=['settlement_events','settlement_allocations','settlement_evidence','settlement_reconciliations','settlement_citations','funding_releases'].map(w.count);const state=JSON.stringify(w.current());
  const q=w.req({citation:{groupId:g.id,version:1}});code(()=>w.rec.preview(q),'CITATION_EXCEEDS_ROW');const p=w.rec.stateVersion('a').id;code(()=>w.rec.confirm({...q,stateVersion:p}),'CITATION_EXCEEDS_ROW');
  assert.deepEqual(['settlement_events','settlement_allocations','settlement_evidence','settlement_reconciliations','settlement_citations','funding_releases'].map(w.count),before);assert.equal(JSON.stringify(w.current()),state);
});
test('R4/R7: records and funding releases are append-only; a reversed record\'s evidence cannot be allocated again',()=>{
  const w=world();w.open(order('A'));const {record}=w.reconcile();
  assert.throws(()=>w.db.prepare('UPDATE settlement_reconciliations SET kind=?').run('x'),/append-only/);assert.throws(()=>w.db.prepare('DELETE FROM settlement_reconciliations').run(),/append-only/);
  assert.throws(()=>w.db.prepare('DELETE FROM funding_releases').run(),/append-only/);w.reverse(record.id);
  code(()=>w.ledger.allocate({account:'a',evidenceId:record.effects.evidenceId,pieceId:record.pieceId,orderId:'A',cents:100}),'EVIDENCE_REVERSED');
  assert.deepEqual(w.ledger.events('a').filter(e=>['reconciliation','reconciliation-reversed','allocation-reversed','piece-reopened'].includes(e.kind)).map(e=>e.kind),['reconciliation','allocation-reversed','piece-reopened','reconciliation-reversed']);
  assert.equal(w.funding.commitments('a').usd,100,'the release is reinstated');
});
test('R7: reversing a reconciliation that cited a K row withdraws the citation; a review piece is not reconciled here',()=>{
  const w=world();const [A]=w.open(order('A'));w.ledger.importK(SCOPE,W,[k()]);const g=w.ledger.links('a',[A]).get('A');const {record}=w.reconcile({citation:{groupId:g.groupId,version:g.version}});
  // The row disappears from a later complete window: the citation is under review, so $100 counts as unresolved again.
  w.ledger.importK(SCOPE,W,[]);assert.equal(w.current().unresolved.buysUSD,100);const review=w.current().open.find(p=>p.unresolved?.why==='under review');
  code(()=>w.rec.preview(w.req({pieceId:review.pid})),'PIECE_UNDER_REVIEW');
  w.reverse(record.id);assert.equal(w.ledger.citations('a').length,0);assert.equal(w.ledger.citations('a',{all:true}).length,1);assert.equal(w.current().buysUSD,100,'the piece itself, once: not also under review');
});
test('R1/R8/R9: a sale needs no route, commits no funding, and its proceeds reclassify a detected rise',()=>{
  const w=world();const S=order('S',{side:'Sell',costEstimate:undefined,resultCosts:{netCash:279.85},fillPrice:279.85,limitPrice:279.85});w.see({cash:500});w.see({cash:500},[S]);
  assert.equal(w.current().sellsUSD,279.85);const flow=w.perf.addFlow('a',{day:D,market:'US',amount:279.85,detected:true,note:'Detected: U.S. cash rose'});
  const {record}=w.reconcile({pieceId:w.pid('S'),cents:27985,route:undefined,flowId:flow.id});assert.equal(record.route,null);assert.equal(record.effects.funding.cents,0);assert.match(record.effects.funding.reason,/sale/);
  assert.equal(w.current().sellsUSD,0);assert.deepEqual(w.perf.flows('a'),[]);assert.equal(record.effects.effect.correctionCents,0);
  code(()=>w.rec.preview(w.req({pieceId:'x',flowId:flow.id,split:[{kind:'settlement',cents:-100}]})),'PIECE_NOT_OPEN');
});
// Step 2b.4 dependency (spec CN2/CN5, a release dependency): the reconciliation changes the tracker's U.S. basis, which
// the flow detector does not yet receive as an explained adjustment, so it would hold the change as a deposit.
test('2b.4 dependency: a reconciliation is not yet an explained adjustment for the flow detector',{todo:'step 2b.4 passes reconciliation effects to the flow detector'},()=>{
  const {FlowDetector}=require('../electron/flow-detector.cjs');const w=world();const [A]=w.open(order('A'));let t0=w.clock();const fd=new FlowDetector(w.db,w.perf,()=>t0);
  const usCash=()=>500-w.current().buysUSD;fd.observe('a',{krCash:1000000,usCash:usCash(),fx:1300,orders:[A]});w.reconcile();
  t0+=60000;fd.observe('a',{krCash:1000000,usCash:usCash(),fx:1300,orders:[A]});t0+=3*3600000;const flows=fd.observe('a',{krCash:1000000,usCash:usCash(),fx:1300,orders:[A]});
  assert.deepEqual(flows,[],'no detected deposit from a reconciliation');
});
test('R7/E8: a KIS record raised later never restores coverage from a reversed reconciliation',()=>{
  const w=world();const [A]=w.open(order('A'));const first=w.reconcile().record;
  // KIS records $97: $3 of the reconciliation's allocation is released as reduced coverage.
  w.ledger.importK(SCOPE,W,[k('TEST',{settlementUSD:97,grossUSD:97,price:97})]);w.see({cash:500},[A]);assert.equal(w.current().reducedCoverage[0].usd,3);
  // Reversed, then reconciled again for the $97 KIS shows.
  w.reverse(first.id);assert.equal(w.current().buysUSD,97);w.reconcile({cents:9700});assert.equal(w.current().buysUSD,0);
  // KIS raises it to $100: the released $3 belonged to the reversed record, so it is not restored; $3 is a conflict.
  w.ledger.importK(SCOPE,W,[k('TEST',{settlementUSD:100,grossUSD:100,price:100,settlementDate:'2026-11-09'})]);const r=w.see({cash:500},[A]);
  assert.equal(r.buysUSD,3);assert.equal(r.open[0].unresolved.why,'conflict');assert.ok(w.ledger.events('a').some(e=>e.kind==='release-used-elsewhere'));
});
test('R9: a release never exceeds the commitment\'s filled part, and a reversal reinstates exactly what was released',()=>{
  // The funding ledger committed $90 (an earlier record of the order); the tracker holds $100.
  const w=world();const A=order('A');w.see({cash:500});w.funding.track(order('A',{fillPrice:90,limitPrice:90,costEstimate:{netCash:-90},resultCosts:{netCash:-90}}));w.see({cash:500},[A]);
  const {record}=w.reconcile({cents:9500});assert.equal(record.effects.funding.cents,9000);assert.equal(w.funding.releasedCents('A'),9000);assert.equal(w.funding.commitments('a').usd,0);
  w.reverse(record.id);assert.equal(w.funding.releasedCents('A'),0);assert.equal(w.funding.commitments('a').usd,90);
});
