// Stage 2b.5: the U.S. settlement panel, its Home summary, Check again and the overdue notice
// (electron/settlement-panel.cjs; stage2b-spec.md P1-P7; design tests T5 and T6 through the stage 2a history jobs).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');
const {InFlight}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');const {SettlementPanel,CHECK_PAGES}=require('../electron/settlement-panel.cjs');
const {TradingCosts,DEFAULT_COSTS}=require('../electron/trading-costs.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');
const MIN=60000,DAY=86400000,D='2026-11-05',TODAY='2026-11-06';
const order=(id,extra={})=>({id,symbol:'NASD:'+(extra.ticker??'TEST'),side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'live',accountKey:'a:US',market:'US',day:D,brokerOrderId:'0030'+id.charCodeAt(0),createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
// A CTOS4001R row (stage 2a test shape) and a fake KIS serving rows of the requested dates, one row a page.
const raw=(day,ticker,qty=1,price=100,side='02')=>({trad_dt:day.replaceAll('-',''),sttl_dt:day.replaceAll('-',''),sll_buy_dvsn_cd:side,pdno:ticker,ccld_qty:String(qty),ft_ccld_unpr2:String(price),tr_frcr_amt2:String(qty*price),frcr_excc_amt_1:String(qty*price),wcrc_excc_amt:String(qty*price*1400),dmst_frcr_fee1:'0',frcr_fee1:'',crcy_cd:'USD',erlm_exrt:'1400'});
function kis(all){const calls=[];const client=new OverseasClient({overseasIdentity:()=>({environment:'live'}),overseasRequest:async(p,trId,params)=>{calls.push([params.ERLM_STRT_DT,params.ERLM_END_DT]);
  const d=v=>`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`;const rows=all.filter(r=>d(r.trad_dt)>=d(params.ERLM_STRT_DT)&&d(r.trad_dt)<=d(params.ERLM_END_DT));const page=params.CTX_AREA_NK100?Number(params.CTX_AREA_NK100.slice(1)):0,more=page+1<rows.length;
  return {body:{output1:rows.slice(page,page+1),ctx_area_fk100:more?'f':'',ctx_area_nk100:more?'p'+(page+1):''},continuation:more?'M':''};}});return {fetch:(a,b,o)=>client.trades(a,b,o),calls};}
function world(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');let t=Date.parse('2026-11-06T03:00:00Z');const clock=()=>t;
  const f=new InFlight(db,clock,{settleDays:null}/* age rule off until S3/S4 removes these tests */),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock),rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const fd=new FlowDetector(db,perf,clock),costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});costs.save({...DEFAULT_COSTS,taxYear:2026,annualRealizedKRW:0});
  const panel=new SettlementPanel({inFlight:f,reconciliation:rec,flowDetector:fd,costs,clock});const us={cash:500};let seq=0,orders=[];
  const snap=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[],reportedTotal:us.cash,timestamp:new Date(t).toISOString()});
  const w={db,f,funding,perf,rec,fd,costs,panel,us,clock,later:ms=>{t+=ms;},
    see:(list=orders)=>{const r=f.observe('a',{us:snap(),orders:list,fx:1300});t+=MIN;return r;},
    open:(...os)=>{orders=os;w.see([]);for(const o of os)funding.track(o);w.see();return os;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,view:()=>panel.view('a',{orders,environment:'live'}),orders:()=>orders,
    reconcile:(extra={})=>{const q={requestId:'r'+(++seq),account:'a',cents:10000,explanation:'settled',route:'USD',kisReference:'KIS',note:'checked',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    reverse:id=>{const q={requestId:'v'+(++seq),account:'a',reconciliationId:id,note:'wrong'};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},
    detect:()=>{const v=f.current('a');return fd.observe('a',{krCash:1000000,usCash:us.cash-v.buysUSD+v.sellsUSD,fx:1300,orders,usExplained:range=>f.explained('a',range),usReview:v.review});},
    check:(fetch,extra={})=>panel.checkAgain('a',w.pid('A'),{orders,fetch,environment:'live',today:TODAY,...extra})};
  return w;}

test('P1: each open piece shows its order, signed amount, why and since when, the evidence, and what is unknown',()=>{
  const w=world();w.open(order('A'),order('S',{side:'Sell',ticker:'SOLD',resultCosts:{netCash:250},costEstimate:undefined,fillPrice:250,limitPrice:250}));const v=w.view();
  const a=v.pieces.find(p=>p.orderId==='A'),s=v.pieces.find(p=>p.orderId==='S');
  assert.deepEqual([a.side,a.symbol,a.shares,a.orderNumber,a.usd,a.signedUSD,a.basis,a.state,a.why],['Buy','NASD:TEST',1,'003065',100,-100,'net','unresolved','awaiting verification']);
  assert.deepEqual([s.signedUSD,s.state],[250,'unresolved'],'a sale\'s proceeds are positive');assert.ok(a.since>0);assert.equal(a.pretracking,true);
  assert.deepEqual(a.evidence.k,{state:'none'});assert.equal(a.evidence.allocatedUSD,0);assert.equal(a.evidence.historyGap,null);
  assert.ok(a.unknown.some(u=>/before tracking started/.test(u)));assert.ok(a.unknown.some(u=>/USD or KRW is unknown/.test(u)),'a buy\'s funding route is unknown');
  assert.ok(!s.unknown.some(u=>/USD or KRW/.test(u)),'not for a sale');assert.ok(a.unknown.some(u=>/No KIS settled record/.test(u)));assert.equal(a.reconcilable,true);
  // A trade-history gap around the order's date is named.
  w.costs.gaps.record('a',{start:'2026-11-04',end:'2026-11-06',complete:false,reason:'PAGE_LIMIT'},w.clock());const g=w.view().pieces.find(p=>p.orderId==='A');
  assert.deepEqual(g.evidence.historyGap,{start:'2026-11-04',end:'2026-11-06',reason:'PAGE_LIMIT'});assert.ok(g.unknown.some(u=>/could not be read completely/.test(u)));
});
test('P2/P3: every reconciliation by its id with its signed amount, and the timing still open for each, candidate by candidate; resolving and reversing update the panel',()=>{
  // A $100 buy and a $100 sale reconciled in one interval, cash unchanged (the round-5 case): -$100 to +$100.
  const S=()=>order('S',{side:'Sell',fillPrice:100,limitPrice:100,costEstimate:undefined,resultCosts:{netCash:100}});
  const w=world();w.open(order('A'),S());w.detect();w.later(MIN);const ra=w.reconcile({pieceId:w.pid('A')}).id,rs=w.reconcile({pieceId:w.pid('S'),route:undefined}).id;w.later(MIN);w.detect();
  const v=w.view();assert.equal(v.pieces.length,0);assert.deepEqual(v.reconciliations.map(r=>[r.id,r.side,r.signedUSD,r.route,r.kisReference,r.reversed]),[[rs,'Sell',100,null,'KIS',null],[ra,'Buy',-100,'USD','KIS',null]],'newest first, each by id, signed');
  assert.deepEqual(v.reconciliations.find(r=>r.id===ra).confirmedBy,{user:'t',session:'s'});
  const [e]=v.timing;assert.deepEqual(e.candidates.map(c=>[c.reconciliationId,c.side,c.paymentUSD,c.ifPaidEarlierUSD]),[[ra,'Buy',-100,-100],[rs,'Sell',100,100]]);
  assert.deepEqual([e.observedUSD,e.low,e.high],[0,-100,100]);assert.deepEqual(v.summary.timingRange,{low:-100,high:100});
  assert.deepEqual(v.reconciliations.find(r=>r.id===ra).timing.map(t=>[t.entryId,t.ifPaidHereUSD,t.ifPaidEarlierUSD]),[[e.id,0,-100]]);
  assert.match(v.home.detail,/1 payment timing to confirm \(−\$100\.00 to \+\$100\.00\)/);
  // The sale paid earlier: its timing closes; the buy's stays open, 0 to +$100.
  w.fd.resolveTiming('a',e.id,{reconciliationId:rs,paidHere:false});const v2=w.view();assert.deepEqual(v2.reconciliations.find(r=>r.id===rs).timing,[]);
  assert.deepEqual(v2.timing[0].candidates.map(c=>c.reconciliationId),[ra]);assert.deepEqual(v2.summary.timingRange,{low:0,high:100});
  // Reversing the buy's record: shown reversed, by which record; its timing is no longer listed against it.
  const back=w.reverse(ra);const v3=w.view(),r3=v3.reconciliations.find(r=>r.id===ra);assert.equal(r3.reversed.id,back.id);assert.deepEqual(r3.timing,[]);assert.deepEqual(v3.pieces.find(p=>p.orderId==='A').signedUSD,-100,'reopened');assert.equal(v3.pieces.find(p=>p.orderId==='A').state,'unresolved','reopened as it was, awaiting verification');
});
test('P4: the Home summary shows only when unresolved amounts affect equity or buying capacity, or timing is open',()=>{
  const w=world();assert.equal(w.view().home,null,'nothing open');
  w.open(order('A'));const h=w.view().home;assert.equal(h.title,'1 older U.S. trade needs settlement confirmation (−$100.00)','1.5.48: the title counts the trades and their signed total');assert.equal(h.detail,'$100.00 lowers equity and buying capacity');assert.equal(h.tone,'warning');
  const x=world();x.open(order('S',{side:'Sell',resultCosts:{netCash:80},costEstimate:undefined,fillPrice:80,limitPrice:80}));assert.deepEqual(x.view().home,{title:'1 older U.S. trade needs settlement confirmation (+$80.00)',detail:'$80.00 of sale proceeds not counted',tone:'info'});
  // Reconciled with a settlement date before the interval: nothing open, no timing: hidden.
  w.later(MIN);w.reconcile({pieceId:w.pid('A'),settledOn:'2026-11-01'});w.detect();assert.equal(w.view().home,null);
  // A fill in flight but not unresolved (settling normally) is not a Home row either.
  const n=world();n.see([]);const N=order('N',{createdAt:n.clock(),filledObservedAt:n.clock()});n.open(N);n.see([N]);const p=n.view().pieces.find(q=>q.orderId==='N');
  assert.equal(p.state,'in flight');assert.equal(p.why,null);assert.equal(n.view().home,null);
  assert.equal(SettlementPanel.home({unresolved:{buysUSD:0,sellsUSD:0},overdue:{buysUSD:0,sellsUSD:0},timingOpen:0,timingRange:{low:0,high:0}}),null);
  assert.match(SettlementPanel.home({unresolved:{buysUSD:10,sellsUSD:0},overdue:{buysUSD:10,sellsUSD:0},timingOpen:0,timingRange:{low:0,high:0}}).detail,/\$10\.00 overdue/);
});
test('T6 (P5): Check again is one bounded job across several pages for the order\'s dates, within the page cap, with no AI; K rows it reads stay supporting only',async()=>{
  const w=world();w.open(order('A'));const k=kis([raw('2026-11-05','TEST'),raw('2026-11-05','OTHER'),raw('2026-11-06','MORE')]);
  const r=await w.check(k.fetch);assert.equal(r.done,true);assert.deepEqual(r.read,[{start:'2026-11-04',end:'2026-11-06',complete:true,reason:null}]);
  assert.equal(k.calls.length,3,'three pages of one range');assert.ok(k.calls.every(([s,e])=>s==='20261104'&&e==='20261106'),'only the order\'s dates (trade date ±1 day, to today)');
  const p=w.view().pieces[0];assert.equal(p.evidence.k.state,'linked');assert.equal(p.evidence.k.supportingOnly,true);assert.equal(p.state,'unresolved','A1 off: a K row resolves nothing');
  assert.equal(p.check.last.done,true);assert.equal(w.costs.jobs.get(SettlementPanel.checkKey('a','A')),null,'a finished job is cleared');
  // The page cap: a range over the limit is read in halves until the budget stops the job, never past CHECK_PAGES.
  const x=world();x.open(order('A'));const pages=[];const big=async(s,e,o)=>{pages.push(o.maxPages);return s<e?{rows:[],complete:false,reason:'PAGE_LIMIT',pages:o.maxPages}:{rows:[],complete:true,reason:null,pages:1};};
  const y=await x.check(big);assert.equal(y.done,false);assert.equal(y.stopped,'BUDGET');assert.ok(pages.reduce((n,p)=>n+p,0)<=CHECK_PAGES);assert.equal(pages.length,2);
  const stored=x.costs.jobs.get(SettlementPanel.checkKey('a','A'));assert.deepEqual(stored.queue.map(q=>[q.start,q.end]),[['2026-11-04','2026-11-04'],['2026-11-05','2026-11-05'],['2026-11-06','2026-11-06']]);
  // The next Check again resumes from the stored queue, not from the whole window.
  const seen=[];const z=await x.check(async(s,e)=>{seen.push([s,e]);return {rows:[],complete:true,reason:null,pages:1};});assert.equal(z.done,true);assert.deepEqual(seen,[['2026-11-04','2026-11-04'],['2026-11-05','2026-11-05'],['2026-11-06','2026-11-06']]);
  // No AI: the panel module reaches nothing that can start a review.
  const src=fs.readFileSync(path.join(__dirname,'../electron/settlement-panel.cjs'),'utf8');for(const m of src.matchAll(/require\('([^']+)'\)/g))assert.ok(!/ai-|automation|research|review|provider|scout/.test(m[1]),m[1]);
});
test('T5 (P5): a rate limit and a restart during a window: the job\'s state is kept, it backs off, and it resumes; one run per order at a time; live only',async()=>{
  const w=world();w.open(order('A'));const key=SettlementPanel.checkKey('a','A');
  const failed=await w.check(async()=>{throw new Error('RATE_LIMITED');});assert.equal(failed.stopped,'FAILED');assert.equal(failed.code,'RATE_LIMITED');
  const j=w.costs.jobs.get(key);assert.equal(j.state,'paused');assert.ok(j.nextAt>w.clock());assert.deepEqual(w.view().pieces[0].check.job.code,'RATE_LIMITED');
  let calls=0;const ok=async()=>{calls++;return {rows:[],complete:true,reason:null,pages:1};};
  assert.equal((await w.check(ok)).skipped,'BACKOFF','waits out the backoff');assert.equal(calls,0);
  assert.equal(w.costs.jobs.get('a'),null,'the account\'s tax job is untouched');
  // A restart while a run is under way: the stored job is marked interrupted and resumed from its queue.
  w.later(16*MIN);let release;const hang=()=>new Promise(r=>{release=r;});const first=w.check(hang);await new Promise(r=>setImmediate(r));
  assert.equal((await w.check(ok)).busy,true,'one run per order at a time');assert.equal(calls,0);
  assert.equal(w.costs.jobs.get(key).state,'running');
  const restarted=new TradingCosts(w.db);assert.equal(restarted.jobs.get(key).state,'paused');assert.equal(restarted.jobs.get(key).stopped,'INTERRUPTED');
  restarted.currentAccount=()=>({accountKey:'a',environment:'live'});const panel=new SettlementPanel({inFlight:w.f,reconciliation:w.rec,flowDetector:w.fd,costs:restarted,clock:w.clock});
  const seen=[];const r=await panel.checkAgain('a',w.pid('A'),{orders:w.orders(),fetch:async(s,e)=>{seen.push([s,e]);return {rows:[],complete:true,reason:null,pages:1};},environment:'live',today:TODAY});
  assert.equal(r.done,true);assert.deepEqual(seen,[['2026-11-04','2026-11-06']],'resumed from the stored queue');release({rows:[],complete:true,reason:null,pages:1});await first.catch(()=>{});
  await assert.rejects(w.panel.checkAgain('a',w.pid('A'),{orders:w.orders(),fetch:ok,environment:'mock',today:TODAY}),/CHECK_LIVE_ONLY/);
  await assert.rejects(w.panel.checkAgain('a','nope',{orders:w.orders(),fetch:ok,environment:'live',today:TODAY}),/PIECE_NOT_OPEN/);
  await assert.rejects(w.panel.checkAgain('a',w.pid('A'),{orders:[],fetch:ok,environment:'live',today:TODAY}),/ORDER_UNKNOWN/);
});
// S1a: the overdue state is gone (a fill is settled by age after 3 business days), so the tracker reports no overdue
// piece and the panel's overdue notice has nothing to send. The notice itself goes with the panel in S4.
test('P6 (S1a): nothing becomes overdue; with the age rule an old fill is settled by age and no overdue notice is sent',()=>{
  const w=world();const O=order('O',{createdAt:w.clock()-10*DAY,day:'2026-10-27'});w.see([]);
  const f=new (require('../electron/valuation.cjs').InFlight)(w.db??w.f.db,w.clock);
  const r=f.observe('a',{us:{accountKey:'a:US',environment:'live',cash:500,pendingSaleProceeds:0,holdings:[],timestamp:new Date(w.clock()).toISOString()},orders:[O],fx:1300});
  assert.deepEqual(r.newlyOverdue,[]);assert.equal(r.overdue.buysUSD,0);assert.ok(!r.notes.some(n=>/no settlement evidence after/.test(n)));
  const sent=[];w.panel.overdueNotice('a',r.newlyOverdue,(id,m)=>sent.push([id,m]));assert.equal(sent.length,0);
});
test('P7: syncHistory with a key keeps the check apart from the account\'s tax job, and an exact plan reads dates of gaps not yet due',async()=>{
  const w=world();w.costs.gaps.record('a',{start:'2026-11-05',end:'2026-11-05',complete:false,reason:'PAGE_LIMIT'},w.clock());const seen=[];
  const fetch=async(s,e)=>{seen.push([s,e]);return {rows:[],complete:true,reason:null,pages:1};};
  await w.costs.syncHistory('a',fetch,{plan:()=>[{start:'2026-11-04',end:'2026-11-06'}],clock:w.clock});assert.deepEqual(seen,[['2026-11-04','2026-11-04'],['2026-11-06','2026-11-06']],'the tax job leaves a gap in backoff out');
  seen.length=0;await w.costs.syncHistory('a',fetch,{plan:()=>[{start:'2026-11-04',end:'2026-11-06'}],key:'a#settlement-check:A',exact:true,clock:w.clock});assert.deepEqual(seen,[['2026-11-04','2026-11-06']],'the check reads them');
  assert.deepEqual(w.costs.gaps.list('a'),[],'its complete read clears the gap for the account');
});
test('P5: the check reads the order\'s dates as asked (never after today, a gap in backoff included); a KIS row two app orders share is shown as uncertain, with the reason',async()=>{
  const w=world();w.open(order('A',{day:TODAY}));w.costs.gaps.record('a',{start:'2026-11-06',end:'2026-11-06',complete:false,reason:'READ_FAILED'},w.clock());assert.ok(w.costs.gaps.list('a')[0].nextAt>w.clock(),'the gap waits out its backoff');
  const seen=[];await w.check(async(s,e)=>{seen.push([s,e]);return {rows:[],complete:true,reason:null,pages:1};});assert.deepEqual(seen,[['2026-11-05','2026-11-06']],'trade date -1 day to today; the gap\'s date is read');
  assert.deepEqual(w.costs.gaps.list('a'),[]);
  // Two identical app orders and one KIS row: possibly either, so neither is linked.
  const x=world();x.open(order('A'),order('B'));const k=kis([raw('2026-11-05','TEST')]);await x.check(k.fetch);
  const p=x.view().pieces.find(q=>q.orderId==='A');assert.equal(p.evidence.k.state,'uncertain');assert.match(p.evidence.k.reason,/several app orders/);assert.ok(p.unknown.some(u=>/not with certainty/.test(u)));assert.equal(p.state,'unresolved');
});
test('R1 (review of 9ef95fe, P1): a reversal withdraws its reconciliation from open timing in the same transaction; other candidates stay; a stale resolution is refused',()=>{
  // The reviewer's case: $100 reconciled, reversed, then "paid in this interval" from a page not yet refreshed.
  const w=world();w.open(order('A'));w.detect();w.later(MIN);const m=w.reconcile({pieceId:w.pid('A')});w.later(MIN);w.detect();const [e]=w.fd.timing('a');assert.deepEqual(e.candidates.map(c=>c.id),[m.id]);
  const q={requestId:'v1',account:'a',reconciliationId:m.id,note:'wrong'};const p=w.rec.previewReversal(q);
  assert.deepEqual(p.effects.timing.map(t=>[t.entryId,t.candidateUSD,t.observedBefore,t.observedAfter,t.closed,t.flow]),[[e.id,100,100,0,true,null]],'shown in the preview');assert.equal(w.fd.timing('a').length,1,'a preview changes nothing');
  w.rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});assert.deepEqual(w.fd.timing('a'),[]);assert.deepEqual(w.view().timing,[]);assert.equal(w.view().summary.timingOpen,0);
  for(const paidHere of [true,false])assert.throws(()=>w.fd.resolveTiming('a',e.id,{reconciliationId:m.id,paidHere}),/TIMING_CANDIDATE_REVERSED/);assert.equal(w.perf.flows('a').length,0,'no false flow');
  // The next interval explains the reopening; nothing is left over.
  w.later(MIN);w.detect();assert.deepEqual(w.fd.timing('a'),[]);assert.equal(w.perf.flows('a').length,0);assert.deepEqual(w.fd.pending('a'),[]);
  assert.throws(()=>w.fd.resolveTiming('a',e.id,{reconciliationId:m.id,paidHere:true}),/TIMING_CANDIDATE_REVERSED/,'remembered across later readings');
  // Opposite candidates: reversing the sale leaves the buy's candidate, its reading taken out (0 - (-100) = +100).
  const S=()=>order('S',{side:'Sell',fillPrice:100,limitPrice:100,costEstimate:undefined,resultCosts:{netCash:100}});
  const x=world();x.open(order('A'),S());x.detect();x.later(MIN);const ra=x.reconcile({pieceId:x.pid('A')}).id,rs=x.reconcile({pieceId:x.pid('S'),route:undefined}).id;x.later(MIN);x.detect();const [g]=x.fd.timing('a');
  x.reverse(rs);const [h]=x.fd.timing('a');assert.equal(h.id,g.id);assert.deepEqual(h.candidates.map(c=>[c.id,c.usd]),[[ra,100]]);assert.deepEqual([h.observed,h.low,h.high],[100,0,100]);
  x.later(MIN);x.detect();assert.throws(()=>x.fd.resolveTiming('a',g.id,{reconciliationId:rs,paidHere:false}),/TIMING_CANDIDATE_REVERSED/);const ok=x.fd.resolveTiming('a',g.id,{reconciliationId:ra,paidHere:true});assert.equal(ok.flow.amount,100);
  // Reconciled and reversed within one interval: never a candidate, never a flow.
  const y=world();y.open(order('A'));y.detect();y.later(MIN);const r=y.reconcile({pieceId:y.pid('A')});y.reverse(r.id);y.later(MIN);y.detect();assert.deepEqual(y.fd.timing('a'),[]);assert.equal(y.perf.flows('a').length,0);assert.deepEqual(y.fd.pending('a'),[]);
});
test('R1: the withdrawal is atomic with the reversal; the last candidate leaves a real unexplained change as a detected flow',()=>{
  // Paid in the interval as reconciled (cash fell $100), then reversed: the fall has no explanation left.
  const w=world();w.open(order('A'));w.detect();w.later(MIN);const m=w.reconcile({pieceId:w.pid('A')});w.us.cash-=100;w.later(MIN);w.detect();const e=w.fd.timing('a')[0];
  assert.deepEqual([e.observed,e.candidates[0].usd],[0,100]);
  const add=w.perf.addFlow.bind(w.perf);w.perf.addFlow=()=>{throw new Error('DISK_FULL');};
  const q={requestId:'v1',account:'a',reconciliationId:m.id,note:'wrong'};assert.throws(()=>{const p=w.rec.previewReversal(q);w.rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},/DISK_FULL/);
  assert.equal(w.rec.reversalOf(m.id),null,'nothing reversed');assert.deepEqual(w.fd.timing('a').map(x=>x.candidates.length),[1],'the entry unchanged');assert.equal(w.view().reconciliations[0].reversed,null);
  w.perf.addFlow=add;const b=w.reverse(m.id);assert.equal(b.effects.timing[0].flow.amount,-100);assert.deepEqual(w.perf.flows('a').map(f=>[f.amount,f.detected]),[[-100,true]]);assert.deepEqual(w.fd.timing('a'),[]);
});
test('R2 (review of 9ef95fe, P2): funding still committed after a reconciliation is shown and keeps the Home row: route unknown, or the estimate above the reconciled amount',()=>{
  const w=world();w.open(order('A'));w.later(MIN);w.reconcile({pieceId:w.pid('A'),route:'unknown',settledOn:'2026-11-01'});w.detect();
  const v=w.view();assert.equal(v.pieces.length,0);assert.equal(w.funding.commitments('a').usd,100);
  assert.deepEqual(v.funding.map(f=>[f.orderId,f.retainedUSD,f.reason]),[['A',100,'route unknown']]);assert.equal(v.summary.fundingRetainedUSD,100);
  assert.deepEqual(v.home,{title:'$100.00 of U.S. buy funding still reserved',detail:'$100.00 of buy funding still committed after reconciliation',tone:'warning'});
  // A named route releases it: nothing retained, no row.
  const n=world();n.open(order('A'));n.later(MIN);n.reconcile({pieceId:n.pid('A'),settledOn:'2026-11-01'});n.detect();assert.deepEqual(n.view().funding,[]);assert.equal(n.view().home,null);
  // The estimate ($101 at the fill price) above the $100 reconciled: the $1 difference stays committed and is shown.
  const x=world();x.open(order('A',{fillPrice:101}));x.later(MIN);x.reconcile({pieceId:x.pid('A'),settledOn:'2026-11-01'});x.detect();
  assert.deepEqual(x.view().funding.map(f=>[f.retainedUSD,f.reason]),[[1,'estimate above reconciled']]);assert.match(x.view().home.detail,/\$1\.00 of buy funding still committed/);
  // Partly reconciled with the route unknown: what the open piece still owes is not counted twice.
  const y=world();y.open(order('A'));y.later(MIN);y.reconcile({pieceId:y.pid('A'),cents:4000,route:'unknown',settledOn:'2026-11-01'});const f=y.view();
  assert.deepEqual(f.funding.map(z=>z.retainedUSD),[40]);assert.equal(f.pieces[0].usd,60);
  // Reversed: the record no longer holds anything; the piece is open again.
  y.reverse(f.reconciliations[0].id);assert.deepEqual(y.view().funding,[]);
});
test('R3 (review of 9ef95fe, P2): a preview carries each market\'s daily-loss check before and after, computed in the preview\'s transaction and bound',()=>{
  const w=world();w.open(order('A'));
  const loss=account=>{const t=w.f.current(account);return {KR:null,US:{loss:t.buysUSD,limitKRW:30,baseline:500,equity:500-t.buysUSD,breached:t.buysUSD>30,ambiguous:false,settlement:{adjustment:{low:0,high:0}},scenarios:[{name:'low bounds',loss:t.buysUSD,breached:t.buysUSD>30}]}};};
  const rec=new Reconciliation(w.db,{inFlight:w.f,funding:w.funding,performance:w.perf,clock:w.clock,who:{user:'t',session:'s'},loss});
  const q={requestId:'L1',account:'a',pieceId:w.pid('A'),cents:10000,explanation:'settled',route:'USD',kisReference:'KIS',note:'n'};const p=rec.preview(q);
  assert.deepEqual([p.before.loss.US.loss,p.before.loss.US.breached,p.after.loss.US.loss,p.after.loss.US.breached],[100,true,0,false],'the after state is the applied one');assert.equal(p.before.loss.KR,null);
  assert.deepEqual(p.after.loss.US.scenarios,[{name:'low bounds',loss:0,breached:false}]);assert.deepEqual(p.after.loss.US.adjustment,{low:0,high:0});
  // A different loss result at confirmation applies nothing.
  let skew=0;const rec2=new Reconciliation(w.db,{inFlight:w.f,funding:w.funding,performance:w.perf,clock:w.clock,who:{user:'t',session:'s'},loss:a=>{const r=loss(a);r.US.loss+=skew;return r;}});
  const p2=rec2.preview(q);skew=1;assert.throws(()=>rec2.confirm({...q,stateVersion:p2.stateVersion,binding:p2.binding}),/PREVIEW_MISMATCH/);assert.equal(w.f.current('a').open.length,1);
  skew=0;const done=rec2.confirm({...q,stateVersion:p2.stateVersion,binding:p2.binding});assert.equal(done.preview.after.loss.US.loss,0);
  // The UI no longer promises that returns are unchanged.
  const ui=fs.readFileSync(path.join(__dirname,'../src/SettlementPanel.tsx'),'utf8');assert.ok(!/no flow or return changes/.test(ui));assert.match(ui,/not finished yet \(Stage 3\)/);
});
test('R4: a fill dated before the daily KIS history read says only Check again reads it',()=>{
  const w=world();w.open(order('A',{day:'2024-12-30',createdAt:Date.parse('2024-12-30T15:00:00Z')}));const p=w.view().pieces[0];
  assert.equal(p.evidence.inDailyRead,false);assert.ok(p.unknown.some(u=>/before 2025-01-01.*only Check again/.test(u)));
  const x=world();x.open(order('A'));assert.equal(x.view().pieces[0].evidence.inDailyRead,true);
});
