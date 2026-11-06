// Stage 3.4: consumers of the settlement treatment (performance.cjs analyze/reviewSummary/returnReliability,
// restatement-view.cjs, daily-digest.cjs, phone-snapshot.cjs). Unavailable days stay unavailable everywhere, corrections are
// kept out of investment figures, previews write nothing, a stale approval needs a fresh preview, and the account and the
// approver come from the main process.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory,reviewSummary,returnReliability}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');const {SettlementRestatements}=require('../electron/valuation-corrections.cjs');
const {restatementActions}=require('../electron/restatement-view.cjs');const {buildDigest}=require('../electron/daily-digest.cjs');const {portfolioFigures}=require('../electron/phone-snapshot.cjs');
const MIN=60000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-02',...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
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
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});}};
  return w;}
// A $100 fill paid on U.S. settlement date 2026-11-04 (inside day 2's interval in both clocks), reconciled on day 3.
// Before approval days 2-3 have no return (the misstatement window); day 1 is ordinary.
function scenario({route='USD'}={}){const w=world();w.see([]);const A=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([A]);w.record();
  w.at(Date.parse('2026-11-03T14:00:00Z'));w.us.price=1010;w.record();w.at(Date.parse('2026-11-04T12:00:00Z'));w.us.cash=400;
  w.at(Date.parse('2026-11-05T06:00:00Z'));w.us.price=1020;w.record();w.at(Date.parse('2026-11-06T06:00:00Z'));const r=w.reconcile('A',{settledOn:'2026-11-04',route});w.record();return {w,r};}
const identity=()=>({by:'owner (this computer)',session:'main-session'});
const approvals=w=>w.db.prepare("SELECT COUNT(*) n FROM valuation_settlement_approvals").get().n;

test('analytics: a day without a return breaks the chain; return, drawdowns and gain are unavailable, never read from the flat index or raw values',()=>{
  const {w}=scenario();const s=w.perf.summary('a','USD','SPX'),a=s.analytics.All,days=s.points.map(p=>p.day);
  assert.equal(a.twrPct,null);assert.equal(a.gain,null);assert.equal(a.maxDrawdownPct,null);assert.equal(a.currentDrawdownPct,null);assert.equal(a.chainBrokenFrom,days[2]);
  assert.deepEqual(a.drawdown.map(d=>d.drawdownPct==null),[false,false,true,true]);assert.equal(a.returnDays,1);assert.deepEqual(a.unavailableDays.map(d=>d.day),[days[2],days[3]]);
  const d2=a.dailyPnl.find(p=>p.day===days[2]);assert.equal(d2.pnl,null,'no P/L, not zero');assert.ok(d2.unavailable.length);
  assert.deepEqual(s.periods.find(p=>p.label==='All').settlementAffected,{pending:3,corrected:1,restated:0,unavailable:2,bounded:0});
});
test('analytics: accounting corrections are kept out of the gain',()=>{
  // A rounding record of a $0.40 fill: a +$0.40 basis change, no payment, an ordinary day.
  const w=world();w.see([]);const E=order('E',0.4,{createdAt:w.clock(),filledObservedAt:w.clock(),resultCosts:{netCash:-0.4},costEstimate:{netCash:-0.4}});w.see([E]);w.record();
  w.at(Date.parse('2026-11-03T06:00:00Z'));w.reconcile('E',{explanation:'rounding',route:undefined});w.record();
  const s=w.perf.summary('a','USD',null);close(s.points[1].correction,0.4);close(s.analytics.All.gain,0,'not the raw +$0.40');close(s.analytics.All.corrections,0.4);close(s.periods.find(p=>p.label==='All').gain,0);
});
test('AI review context: unavailable periods are listed with reasons, never dropped or numbered; returns are flagged unverified',()=>{
  const {w}=scenario();const s=w.perf.summary('a','USD','SPX'),r=reviewSummary(s);const all=r.timeWeightedReturns.find(p=>p.period==='All');
  assert.equal(all.returnPct,null);assert.ok(all.unavailable[0].length>0);assert.deepEqual(all.settlementAffected,{pending:3,corrected:1,restated:0,unavailable:2,bounded:0});
  assert.equal(r.risk.maxDrawdownPct,null);assert.equal(r.risk.daysWithoutReturn,2);assert.ok(r.recentDailyPnl.filter(p=>p.unavailable).every(p=>p.pnl==null));
  assert.equal(r.settlement.daysWithoutReturn.length,2);assert.match(r.settlement.label,/unknown, not zero/);
  const rel=returnReliability({settlement:s.analytics['3M'].settlementAffected});assert.equal(rel.reliable,false);assert.match(rel.reasons.join(' '),/2 recorded days have no return/);assert.match(rel.reasons.join(' '),/accounting corrections, kept out of returns/);
  // The summarized and compacted context keep them.
  const ctx=require('../electron/review-context.cjs');const p={history:{US:{...r,returnReliability:rel}}};const sum=ctx.SUMMARIES.performance(p).history.US.timeWeightedReturns.find(x=>x.period.split('/').includes('All'));
  assert.equal(sum.returnPct,null);assert.ok(sum.unavailable[0].length>0,'the reason survives grouping');assert.ok(sum.settlementAffected);
  const cmp=ctx.COMPRESS.find(x=>x[0]==='performance')[1](p).history.US;assert.equal(cmp.settlement.daysWithoutReturn.length,2);assert.equal(cmp.risk.daysWithoutReturn,2);assert.equal(cmp.returnReliability.reliable,false);
});
test('digest and AI context agree on a day without a return; corrections are named, not counted as return',()=>{
  const {w}=scenario();const series=w.perf.series('a','USD'),last=series.at(-1),day=last.day;
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');
  const performanceToday=d=>[['US','USD','U.S.']].flatMap(([market,currency,label])=>{const p=w.perf.series('a',currency).find(x=>x.day===d);return p?[{market,currency,label,dailyReturn:p.dailyReturn,pnl:p.pnl??null,correction:p.correction??0,unavailable:p.unavailable??null,returnRange:p.bounded?.returnRange??null,settlement:p.settlement??[]}]:[];});
  const a={db,config:{scope:'us'},paper:{orders:()=>[]},live:null,usLive:{getState:()=>({loss:{baseline:1500,equity:1520}}),orders:()=>[]},guardrails:{eventsOn:()=>[],failuresOn:()=>0},performanceToday};
  const d=buildDigest(a,Date.parse(day+'T12:00:00+09:00'));
  assert.match(d.text,/U\.S\. \$1520\.00 \(\+\$20\.00, \+1\.33% value change today\)/,'the engine baseline change is a value change');
  assert.match(d.text,/Investment return today: U\.S\. unavailable · accounting correction \+\$100\.00 \(not investment return\)/);
  assert.match(d.text,new RegExp(`U\\.S\\. return unavailable: ${last.unavailable[0].slice(0,40).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
  const ai=reviewSummary(w.perf.summary('a','USD','SPX')).recentDailyPnl.find(p=>p.day===day);assert.equal(ai.unavailable,true);assert.equal(ai.pnl,null);assert.equal(d.performance[0].dailyReturn,null);
  assert.equal(ai.accountingCorrection,100);assert.equal(d.performance[0].correction,100);
  // An ordinary day reads the same return in both.
  const first=series[1];const d1=buildDigest({...a,performanceToday},Date.parse(first.day+'T12:00:00+09:00'));
  assert.match(d1.text,new RegExp(`Investment return today: U\\.S\\. \\+${(first.dailyReturn*100).toFixed(2)}%`));
});
test('phone snapshot: a settlement-affected day\'s change is a value change, not a return',()=>{
  const {w}=scenario();const daily=w.perf.series('a','COMBINED'),today=daily.at(-1).day;
  const f=portfolioFigures({portfolio:{totals:{equityKRW:3000000},cash:{KRW:0,USD:0},fx:{usdKRW:1300},rows:[]},daily,today});
  assert.match(f.fields[0].value,/value change today \(settlement-affected, not a return\)/);
});
test('restatements: preview writes nothing; approval needs binding, request id and note; account and approver are the main process\'s',()=>{
  const {w,r}=scenario();const v=restatementActions({restatements:w.s,reconciliation:w.rec,identity});
  const st=v.state('a');assert.deepEqual(st.candidates.map(c=>[c.id,c.paymentDay,c.label]),[[r.id,w.perf.history('a')[2].day,'if approved']]);assert.equal(approvals(w),0,'discovery writes nothing');
  const nav=JSON.stringify(w.perf.history('a'));const p=v.preview('a',r.id);assert.equal(p.written,false);assert.equal(approvals(w),0,'preview writes nothing');assert.equal(JSON.stringify(w.perf.history('a')),nav);
  // The historical change (bound) and the live figures (not bound) are apart.
  // Bound: the restated days D..R-1 with their chained return, and day R's correction (+$100 before, $0 after approval).
  const H=w.perf.history('a');assert.deepEqual(p.historical.USD.after.days.map(d=>d.day),[H[2].day]);assert.equal(p.historical.USD.before.twr,null);assert.notEqual(p.historical.USD.after.twr,null);
  assert.deepEqual([p.historical.USD.before.resolution.day,p.historical.USD.before.resolution.correction,p.historical.USD.after.resolution.correction],[H[3].day,100,0]);
  // Live (stage 3.4 review, P2): day R's own return and P/L, the return through R, and periods ending today.
  assert.match(p.live.note,/not part of what you approve/);assert.deepEqual(p.live.series.USD.periods.map(l=>l.label),['All','1M']);
  assert.equal(p.live.series.USD.resolutionDay.after.day,H[3].day);assert.equal(p.live.series.USD.resolutionDay.after.through.from,H[1].day);assert.equal(p.live.series.USD.resolutionDay.before.dailyReturn,null);
  for(const [req,code] of [[{candidateId:r.id,requestId:'req-00001',binding:p.binding,note:'  '},'NOTE_REQUIRED'],[{candidateId:r.id,requestId:'req-00001',note:'n'},'PREVIEW_REQUIRED'],[{candidateId:r.id,binding:p.binding,note:'n'},'PREVIEW_REQUIRED'],[{candidateId:r.id,requestId:'req-00001',binding:123,note:'n'},'PREVIEW_REQUIRED'],[null,'INVALID_REQUEST']])
    assert.throws(()=>v.approve('a',req),new RegExp(code));
  assert.equal(approvals(w),0);
  // Renderer-supplied account and identity are ignored.
  const done=v.approve('a',{candidateId:r.id,requestId:'req-00001',binding:p.binding,note:'Checked the KIS statement',account:'b',by:'mallory',approval:{by:'mallory',note:'x'}});
  const [rec]=w.s.records('a');assert.equal(rec.id,done.recordId);assert.deepEqual(rec.approval,{by:'owner (this computer)',session:'main-session',note:'Checked the KIS statement'});assert.equal(w.s.records('b').length,0);
  const after=v.state('a');assert.deepEqual(after.records.map(x=>[x.status,x.approval.by]),[['active','owner (this computer)']]);assert.deepEqual(after.candidates,[],'an approved candidate is no longer offered');
  assert.equal(v.approve('a',{candidateId:r.id,requestId:'req-00001',binding:p.binding,note:'Checked the KIS statement'}).recordId,done.recordId,'a repeat returns the same record');
  assert.throws(()=>v.approve('a',{candidateId:r.id,requestId:'req-00002',binding:p.binding,note:'again'}),/ALREADY_APPROVED/);
});
test('restatements: a stale preview is refused with a fresh one, which needs its own confirmation; nothing is applied meanwhile',()=>{
  const {w,r}=scenario();const v=restatementActions({restatements:w.s,reconciliation:w.rec,identity});const p=v.preview('a',r.id);
  // A deposit recorded on the payment day changes the historical figures.
  w.perf.addFlow('a',{day:w.perf.history('a')[2].day,market:'US',amount:5,note:'late deposit'});
  let err=null;try{v.approve('a',{candidateId:r.id,requestId:'req-stale1',binding:p.binding,note:'checked'});}catch(e){err=e;}
  assert.equal(err?.code,'PREVIEW_MISMATCH');assert.ok(err.preview&&err.preview.binding!==p.binding,'a fresh preview comes back');assert.equal(approvals(w),0,'nothing applied');
  assert.equal(v.state('a').records.length,0,'and nothing approved by refreshing');
  v.approve('a',{candidateId:r.id,requestId:'req-fresh1',binding:err.preview.binding,note:'checked again'});assert.equal(v.state('a').records[0].status,'active');
  // A routine reading of a later day does not make a preview stale (3.3 binding).
  const {w:x,r:q}=scenario();const vx=restatementActions({restatements:x.s,reconciliation:x.rec,identity});x.at(Date.parse('2026-11-07T06:00:00Z'));x.record();const px=vx.preview('a',q.id);x.later(MIN);x.us.price=1030;x.record();
  assert.equal(vx.preview('a',q.id).binding,px.binding);
  // The bound part ends the day before the resolution day; day R and later days are live figures only.
  const HX=x.perf.history('a').map(r=>r.day);assert.equal(px.historical.USD.after.days.at(-1).day,HX[HX.indexOf(px.candidate.resolutionDay)-1]);assert.equal(px.historical.USD.after.resolution.day,px.candidate.resolutionDay);assert.ok(HX.at(-1)>px.candidate.resolutionDay);
  // The review's case: a routine reading of day R itself changes only live figures, never the bound part.
  const {w:y,r:ry}=scenario();const vy=restatementActions({restatements:y.s,reconciliation:y.rec,identity});const p0=vy.preview('a',ry.id);y.later(MIN);y.us.price+=100;y.record();const p1=vy.preview('a',ry.id);
  assert.equal(p1.binding,p0.binding);assert.deepEqual(p1.historical,p0.historical);assert.notDeepEqual(p1.live.series.USD.resolutionDay.after,p0.live.series.USD.resolutionDay.after);
});
test('restatements: unsupported routes are listed and never offered; a reversed record shows as not in force, and nothing restores it',()=>{
  const {w}=scenario({route:'KRW'});const v=restatementActions({restatements:w.s,reconciliation:w.rec,identity});const st=v.state('a');
  assert.deepEqual(st.candidates,[]);assert.deepEqual(st.unsupported.map(u=>[u.route,u.usd]),[['KRW',100]]);assert.match(st.unsupported[0].reason,/Korean cash/);
  const {w:u}=scenario({route:'unknown'});assert.deepEqual(restatementActions({restatements:u.s,reconciliation:u.rec,identity}).state('a').unsupported.map(x=>x.route),['unknown']);
  const {w:x,r}=scenario();const vx=restatementActions({restatements:x.s,reconciliation:x.rec,identity});const p=vx.preview('a',r.id);vx.approve('a',{candidateId:r.id,requestId:'req-revers',binding:p.binding,note:'ok'});
  x.at(Date.parse('2026-11-07T06:00:00Z'));const q={requestId:'v1',account:'a',reconciliationId:r.id,note:'wrong'};const pr=x.rec.previewReversal(q);x.rec.reverse({...q,stateVersion:pr.stateVersion,binding:pr.binding});x.record();
  const st2=vx.state('a');assert.deepEqual(st2.records.map(z=>z.status),['inactive']);assert.match(st2.records[0].reason,/reversed/);assert.equal(approvals(x),1,'the record stays');
  assert.equal(x.s.inForce('a',x.perf.history('a')).length,0);
});
test('CN5 (stage 3.4 review, P1): a payment while a U.S. buy is still counted is not presented as verified, before any reconciliation',()=>{
  // The review's case: a fill seen after tracking started, paid two days later without a matching reading.
  const w=world();w.see([]);const A=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([A]);w.record();
  w.at(Date.parse('2026-11-04T06:00:00Z'));w.us.cash=400;w.record();
  const s=w.perf.summary('a','USD','SPX'),p=s.points.at(-1);close(p.pnl,-100);assert.ok(p.settlement.includes('pending'));assert.equal(p.pendingObligation.usd,100);
  const rel=returnReliability({settlement:s.analytics.All.settlementAffected});assert.equal(rel.reliable,false);assert.match(rel.reasons[0],/awaiting settlement evidence/);
  assert.equal(reviewSummary(s).timeWeightedReturns.find(x=>x.period==='All').settlementAffected.pending,1);
  // Digest: the day's return is shown with "not verified"; phone: a value change, not a return.
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');
  const performanceToday=d=>{const x=w.perf.series('a','USD').find(q=>q.day===d);return x?[{market:'US',currency:'USD',label:'U.S.',dailyReturn:x.dailyReturn,pnl:x.pnl,correction:x.correction??0,unavailable:x.unavailable??null,returnRange:null,settlement:x.settlement??[]}]:[];};
  const d=buildDigest({db,config:{scope:'us'},paper:{orders:()=>[]},live:null,usLive:{getState:()=>({loss:null}),orders:()=>[]},guardrails:{eventsOn:()=>[],failuresOn:()=>0},performanceToday,accountValues:()=>[]},Date.parse(p.day+'T12:00:00+09:00'));
  assert.match(d.text,/U\.S\. -7\.14% · not verified \(settlement-affected\)/);
  const f=portfolioFigures({portfolio:{totals:{equityKRW:3000000},cash:{KRW:0,USD:0},fx:{usdKRW:1300},rows:[]},daily:w.perf.series('a','COMBINED'),today:p.day});assert.match(f.fields[0].value,/settlement-affected, not a return/);
  // Control: with no U.S. buy open, the day is verified as before.
  const x=world();x.see([]);x.record();x.at(Date.parse('2026-11-03T06:00:00Z'));x.us.price=1010;x.record();const q=x.perf.summary('a','USD','SPX');
  assert.equal(q.points.at(-1).settlement,undefined);assert.equal(returnReliability({settlement:q.analytics.All.settlementAffected}).reliable,true);
  // A snapshot that does not say what was open (recorded before this field existed) is pending too, as unknown.
  const y=world();y.see([]);y.record();const row=y.perf.history('a')[0];delete row.settlement.last.open;y.db.prepare('UPDATE nav_history SET payload=? WHERE day=?').run(JSON.stringify(row),row.day);
  y.at(Date.parse('2026-11-03T06:00:00Z'));y.record();assert.deepEqual(y.perf.series('a','USD')[1].pendingObligation,{usd:0,unknown:true});
  // An obligation open at a reading of the day, with no ledger opening in the interval (coverage under review counts in
  // the open total): the day's largest open total marks it pending.
  const z=world();z.see([]);z.record();z.at(Date.parse('2026-11-03T06:00:00Z'));const snap=z.perf.settlement;z.perf.settlement=a=>({...snap(a),open:{buysUSD:50,buys:1}});z.record();z.perf.settlement=snap;z.later(MIN);z.record();
  assert.deepEqual(z.perf.series('a','USD')[1].pendingObligation,{usd:50},'the most open at any reading of the day');
});
test('values on restated days are flagged as including the approved overlay',()=>{
  const {w,r}=scenario();const v=restatementActions({restatements:w.s,reconciliation:w.rec,identity});const p=v.preview('a',r.id);v.approve('a',{candidateId:r.id,requestId:'req-overlay',binding:p.binding,note:'ok'});
  const s=w.perf.summary('a','USD','SPX'),pts=s.points,a=s.analytics.All;assert.ok(pts.some(x=>x.restated===100));
  for(const k of [a.peak,a.trough])assert.equal(k.restated,pts.find(x=>x.day===k.day).restated);
  const restatedDay=pts.find(x=>x.restated);assert.equal(restatedDay.value-restatedDay.restated,restatedDay.recorded,'the recorded value stays apart');
});
