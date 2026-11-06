// Stage 3.5 gate: T19-T24, T40 and T41 (replaced) under the final rules (design v3.3 §3, v3.1 §5; stage3-spec.md), each run
// through the composition the app wires (electron/main.cjs) and checked for agreement across every consumer:
// - the performance series and summary (Performance page and Home trend: PerformanceHistory with the correction hook from
//   performanceCorrections and the tracker snapshot recorded with each day, as main sets them);
// - the daily digest (buildDigest with todayFigures, main's automation.performanceToday);
// - the AI review context (reviewPerformance, main's automation.performanceSummary, and the context summarizer and
//   compactor of review-context.cjs);
// - the phone figures (portfolioFigures with the combined series);
// - historical restatements (SettlementRestatements and restatement-view.cjs, main's IPC).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory,reviewPerformance,todayFigures}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');const {SettlementRestatements}=require('../electron/valuation-corrections.cjs');
const {restatementActions}=require('../electron/restatement-view.cjs');const {buildDigest}=require('../electron/daily-digest.cjs');const {portfolioFigures}=require('../electron/phone-snapshot.cjs');
const {SUMMARIES,COMPRESS}=require('../electron/review-context.cjs');const {seoulDate}=require('../electron/kis-activity.cjs');
const MIN=60000,DAY=86400000,TRACKING=Date.parse('2026-11-02T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-01',createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
const identity=()=>({by:'owner (this computer)',session:'gate'});
// As main.cjs wires it.
function world({start=TRACKING,file=':memory:'}={}){const db=new DatabaseSync(file);let t=start;const clock=()=>t;let rate=1300;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sc=performanceCorrections(db,{inFlight:f,reconciliation:rec});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>f.snapshot(a);
  const s=new SettlementRestatements(db,{inFlight:f,reconciliation:rec,performance:perf,corrections:sc,clock});const view=restatementActions({restatements:s,reconciliation:rec,identity});
  const us={cash:500,price:1000};let seq=0,orders=[];
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
  const w={db,f,perf,rec,s,view,us,clock,at:ms=>{t=ms;},later:ms=>{t+=ms;},setRate:r=>{rate=r;},nextDay:()=>{t=Math.ceil((t-start)/DAY)*DAY+start;},
    see:(list=orders)=>{orders=list;f.observe('a',{us:U(),orders:list,fx:rate});t+=MIN;},
    valueNow:()=>value({us:U(),inFlight:f.current('a'),fx:{usdKRW:rate,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity,
    record:()=>{const v=w.valueNow().low;perf.record('a',{totals:{USD:v,KRW:1000000,equityKRW:1000000+v*rate},fx:{usdKRW:rate}});t+=MIN;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});},
    reverse:rid=>{const q={requestId:'v'+(++seq),account:'a',reconciliationId:rid,note:'wrong'};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},
    points:(kind='USD')=>perf.series('a',kind),summary:(kind='USD')=>perf.summary('a',kind,kind==='USD'?'SPX':'KOSPI'),all:(kind='USD')=>w.summary(kind).periods.find(p=>p.label==='All')};
  return w;}
const digestDb=()=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');return db;};
const digestFor=(w,day)=>buildDigest({db:digestDb(),config:{scope:'us'},paper:{orders:()=>[]},live:null,usLive:{getState:()=>({loss:null}),orders:()=>[]},guardrails:{eventsOn:()=>[],failuresOn:()=>0},accountValues:()=>[],performanceToday:d=>todayFigures(w.perf,'a',d)},Date.parse(day+'T12:00:00+09:00'));
const near=(a,b)=>a==null||b==null?a===b:Math.abs(a-b)<0.011;
// Every consumer reads the same thing for every recorded day and period, in the U.S. and combined series.
function agree(w,label){let checked=0;
  for(const kind of ['USD','COMBINED']){const s=w.summary(kind),ai=reviewPerformance(s);
    for(const p of s.periods.filter(p=>p.start!==p.end)){const a=ai.timeWeightedReturns.find(x=>x.period===p.label),an=s.analytics[p.label];const tag=`${label} ${kind} ${p.label}`;
      assert.ok(near(a.returnPct,p.twr==null?null:p.twr*100),tag);assert.equal(Boolean(a.unavailable),Boolean(p.unavailable),tag);assert.deepEqual(a.settlementAffected??null,p.settlementAffected??null,tag);
      assert.equal(Boolean(a.returnRangePct),Boolean(p.twrRange),tag);if(p.unavailable){assert.equal(an.twrPct,null,tag);assert.equal(an.gain,null,tag);}
      if(p.twr!=null)assert.ok(near(an.twrPct,p.twr*100),tag);else assert.equal(an.twrPct,null,tag);checked++;}
    const aff=(s.analytics['3M']??s.analytics.All)?.settlementAffected??null;assert.equal(ai.returnReliability.reliable,!aff,`${label} ${kind} reliability`);
    for(const g of SUMMARIES.performance({history:{X:ai}}).history.X.timeWeightedReturns)if(g.returnPct==null&&g.period.split('/').some(l=>s.periods.find(p=>p.label===l)?.unavailable))assert.ok(g.unavailable?.[0],`${label} ${kind}: the summarizer keeps the reason`);
    assert.deepEqual(COMPRESS.find(x=>x[0]==='performance')[1]({history:{X:ai}}).history.X.returnReliability,ai.returnReliability);
    for(const p of s.points.slice(1)){const tag=`${label} ${kind} ${p.day}`;
      if(kind==='USD'){const t=todayFigures(w.perf,'a',p.day).find(x=>x.market==='US');assert.equal(t.dailyReturn,p.dailyReturn,tag);assert.equal(t.pnl,p.pnl??null,tag);assert.equal(t.correction,p.correction??0,tag);assert.deepEqual(t.unavailable,p.unavailable??null,tag);assert.deepEqual(t.settlement,p.settlement??[],tag);
        const text=digestFor(w,p.day).text;
        if(p.unavailable)assert.match(text,/U\.S\. unavailable/,tag);else if(p.bounded)assert.match(text,/range: one uncertain U\.S\. obligation/,tag);else if(p.dailyReturn!=null)assert.ok(text.includes(`U.S. ${p.dailyReturn>=0?'+':''}${(p.dailyReturn*100).toFixed(2)}%`),tag);
        assert.equal(/not verified/.test(text),Boolean(p.settlement?.length&&p.dailyReturn!=null),tag);assert.equal(/accounting correction/.test(text),Boolean(p.correction),tag);}
      const d=ai.recentDailyPnl.find(x=>x.day===p.day);if(d){assert.equal(Boolean(d.unavailable),Boolean(p.unavailable),tag);assert.equal(d.pnl,p.pnl==null?null:Math.round(p.pnl),tag);}
      if(kind==='COMBINED'){const fig=portfolioFigures({portfolio:{totals:{equityKRW:p.value},cash:{KRW:0,USD:0},fx:{usdKRW:1300},rows:[]},daily:s.points,today:p.day});assert.equal(/settlement-affected, not a return/.test(fig.fields[0].value),Boolean(p.settlement?.length),tag);}
      checked++;}}
  assert.ok(checked>0);return checked;}
const fresh=w=>order('B',100,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02'});

test('T19: payment and resolution in one reading: no correction, the day\'s return is the market\'s only (shown, not verified while the buy was counted)',()=>{
  const w=world();w.see([]);const B=fresh(w);w.see([B]);w.record();w.nextDay();w.us.cash=400;w.us.price=1010;w.see([B]);w.record();
  const [,d]=w.points();assert.equal(d.correction,undefined);close(d.dailyReturn,10/1400);close(d.pnl,10);assert.equal(d.unavailable,undefined);assert.deepEqual(d.settlement,['pending']);
  assert.deepEqual(w.view.state('a').candidates,[],'no restatement candidate');agree(w,'T19');
});
test('T20: a payment on D recorded as a detected withdrawal, reclassified at R: D..R provisional, a candidate exists, and once approved the period return over D..R is the market\'s',()=>{
  const w=world();w.see([]);const B=fresh(w);w.see([B]);w.record();const d0=w.perf.history('a')[0].at;
  w.nextDay();w.us.cash=400;w.us.price=1010;const at=w.clock();const flow=w.perf.addFlow('a',{day:seoulDate(at),market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:d0+1,occurredBy:at});w.record();
  w.nextDay();w.us.price=1020;const r=w.reconcile('B',{flowId:flow.id});w.record();
  assert.deepEqual(w.perf.flows('a'),[],'the flow is reclassified');const [,D,R]=w.points();
  for(const p of [D,R]){assert.equal(p.dailyReturn,null);assert.match(p.unavailable.join(';'),/misstatement window/);}
  assert.equal(D.correction,-100);assert.equal(R.correction,100);assert.equal(R.correctionLabel,'accounting correction, not investment return');assert.equal(w.all().twr,null);
  const [c]=w.view.state('a').candidates;assert.deepEqual([c.id,c.paymentDay,c.resolutionDay,c.source],[r.id,D.day,R.day,'reclassified flow']);agree(w,'T20 before');
  const p=w.view.preview('a',r.id);w.view.approve('a',{candidateId:r.id,requestId:'gate-T20',binding:p.binding,note:'payment seen as the detected withdrawal'});
  const [,d,rr]=w.points();close(d.dailyReturn,1410/1400-1);close(rr.dailyReturn,1420/1410-1);close(w.all().twr,1420/1400-1,'the market return over D..R');assert.equal(d.restated,100);agree(w,'T20 after');
});
test('T21: same-day creation and resolution with no payment: the corrections net to zero; the obligation was uncertain, so the day is unavailable (v3.3 §3)',()=>{
  const w=world();w.see([]);w.record();w.nextDay();w.see([order('A',100)]);w.reconcile('A',{settledOn:'2026-11-01'});w.record();
  const [,d]=w.points();assert.equal(d.correction,undefined,'the opening and the resolution net out');assert.equal(d.dailyReturn,null);assert.match(d.unavailable.join(';'),/uncertain U\.S\. buy obligations this day: \$100\.00/);
  assert.equal(d.pnl,null,'not a zero P/L');agree(w,'T21');
});
test('T22: a sale resolved: the high bound falls, the low bound and the low series\' returns are unaffected',()=>{
  const S=order('S',80,{side:'Sell',costEstimate:undefined,resultCosts:{netCash:80}});const w=world();w.see([]);w.see([S]);w.record();const before=w.valueNow();
  w.nextDay();w.reconcile('S',{route:undefined,settledOn:'2026-11-01'});const after=w.valueNow();assert.equal(after.low,before.low);assert.equal(after.high,before.high-80);w.us.price=1010;w.record();
  const [,d]=w.points();assert.equal(d.correction,undefined);close(d.dailyReturn,10/1500);assert.equal(d.settlement,undefined,'a sale is no buy obligation');agree(w,'T22');
});
test('T23: FX moves on the day: the U.S. return is unaffected, the combined series converts the correction at that day\'s rate',()=>{
  // A $0.40 fill closed by a rounding record on a day the rate moves from 1,300 to 1,350.
  const w=world();w.see([]);const E=order('E',0.4,{createdAt:w.clock(),filledObservedAt:w.clock(),day:'2026-11-02',resultCosts:{netCash:-0.4},costEstimate:{netCash:-0.4}});w.see([E]);w.record();
  w.nextDay();w.setRate(1350);w.reconcile('E',{explanation:'rounding',route:undefined});w.record();
  const usd=w.points('USD')[1],krw=w.points('COMBINED')[1];close(usd.correction,0.4);close(usd.dailyReturn,0,'no U.S. return');close(krw.correction,0.4*1350,'at that day\'s rate');
  close(krw.pnl,1499.6*1350-1499.6*1300,'the combined P/L is the FX move on the U.S. value only');assert.equal(w.points('KRW')[1].correction,undefined);agree(w,'T23');
});
test('T24: a genuine 1% move on a resolution day: the return shows the move; the correction is labelled only where the payment timing makes one',()=>{
  // Paid within the day (its settlement date wholly inside the interval): correction 0, return 1%.
  const w=world();w.see([]);const B=fresh(w);w.see([B]);w.record();w.nextDay();w.later(DAY);w.us.cash=400;w.us.price=1014;w.reconcile('B',{settledOn:'2026-11-03'});w.record();
  const [,d]=w.points();close(d.dailyReturn,0.01);assert.deepEqual(d.correctionItems.map(i=>[i.kind,i.usd]),[['reconciliation paid that day',0]]);assert.equal(d.unavailable,undefined);agree(w,'T24 paid that day');
  // Paid before the day (a reclassified flow on day 1): the day's +$100 is a correction, out of the return.
  const x=world();x.see([]);x.see([fresh(x)]);x.record();const d0=x.perf.history('a')[0].at;x.nextDay();x.us.cash=400;const at=x.clock();const flow=x.perf.addFlow('a',{day:seoulDate(at),market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:d0+1,occurredBy:at});x.record();
  x.nextDay();x.us.price=1014;const r=x.reconcile('B',{flowId:flow.id});x.record();const p=x.view.preview('a',r.id);x.view.approve('a',{candidateId:r.id,requestId:'gate-T24',binding:p.binding,note:'checked'});
  const [,,R]=x.points();close(R.dailyReturn,0.01,'the 1% move');assert.equal(R.correction,0,'the recovery correction is removed with the restatement');agree(x,'T24 restated');
});
function t40(file){
  // v3.1 §5 worked example: payment on D (day 1) while still counted, a deposit on D, a withdrawal on day 2, resolution on
  // day 3. The payment is the detector's -$100 change, reclassified (a supported source).
  const w=world({file});w.see([]);const a=fresh(w);w.see([a]);w.us.price=600;w.record();const d0=w.perf.history('a')[0].at;
  w.nextDay();w.perf.addFlow('a',{day:'2026-11-03',market:'US',amount:500,note:'deposit'});const paid=w.perf.addFlow('a',{day:'2026-11-03',market:'US',amount:-100,detected:true,note:'Detected',occurredAfter:d0+1,occurredBy:w.clock()});w.us.cash=900;w.us.price=630;w.record();
  w.nextDay();w.perf.addFlow('a',{day:'2026-11-04',market:'US',amount:-200,note:'withdrawal'});w.us.cash=700;w.us.price=616.7;w.record();
  w.nextDay();w.us.price=629.867;const rec=w.reconcile('B',{flowId:paid.id});w.record();return {w,rec};}
test('T40: the correction is shown; days 1-3 provisional; the period return unavailable with +1.99% as the "if approved" preview; after approval +2%, -1%, +1%; restart keeps it',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage3-gate-')),file=path.join(dir,'p.sqlite');const {w,rec}=t40(file);
  const pts=w.points();assert.equal(pts[3].correction,100);for(const p of pts.slice(1))assert.equal(p.dailyReturn,null);assert.equal(w.all().twr,null);agree(w,'T40 before');
  const p=w.view.preview('a',rec.id);close(p.live.series.USD.resolutionDay.after.through.twr,0.019898,'+1.99% if approved');close(p.historical.USD.after.days[0].dailyReturn,0.02);close(p.historical.USD.after.days[1].dailyReturn,-0.01);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM valuation_settlement_approvals').get().n,0,'the preview writes nothing');
  w.view.approve('a',{candidateId:rec.id,requestId:'gate-T40',binding:p.binding,note:'payment matched the detected withdrawal'});
  const after=w.points();close(after[1].dailyReturn,0.02);close(after[2].dailyReturn,-0.01);close(after[3].dailyReturn,0.01);close(w.all().twr,0.019898);assert.equal(after[3].correction,0);agree(w,'T40 after');
  // Restart: new instances over the same file derive the same series, approvals and restatement state.
  const series=JSON.stringify(['USD','COMBINED','KRW'].map(k=>w.summary(k))),state=JSON.stringify(w.view.state('a'));w.db.close();
  const x=world({file,start:w.clock()});x.at(w.clock());assert.equal(JSON.stringify(['USD','COMBINED','KRW'].map(k=>x.summary(k))),series);assert.equal(JSON.stringify(x.view.state('a')),state);agree(x,'T40 restart');x.db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
test('T41 (a): while an uncertain obligation is unresolved, affected days and periods are unavailable in every consumer',()=>{
  const w=world();w.see([]);w.see([order('A',100)]);w.record();w.nextDay();w.us.price=1010;w.record();
  const [,d]=w.points();assert.equal(d.dailyReturn,null);assert.match(d.unavailable[0],/awaiting verification/);assert.equal(w.all().twr,null);agree(w,'T41a');
});
test('T41 (b): a settlement without timing evidence leaves them unavailable',()=>{
  const w=world();w.see([]);w.see([order('A',100)]);w.record();w.nextDay();w.us.price=1010;w.record();w.nextDay();w.reconcile('A');w.record();w.nextDay();w.us.price=1020;w.record();
  const [,d1,d2,d3]=w.points();for(const d of [d1,d2])assert.equal(d.dailyReturn,null);assert.notEqual(d3.dailyReturn,null);assert.deepEqual(w.view.state('a').candidates,[],'no evidenced payment day');agree(w,'T41b');
});
test('T41 (c): showing restated returns requires an approval record: none before, in force after, gone when its reconciliation is reversed',()=>{
  // A fill paid on settlement date 2026-11-04 (wholly inside day 2's interval in both clocks), reconciled on day 3.
  const w=world();w.see([]);const B=fresh(w);w.see([B]);w.record();w.at(Date.parse('2026-11-03T14:00:00Z'));w.us.price=1010;w.record();w.at(Date.parse('2026-11-04T12:00:00Z'));w.us.cash=400;
  w.at(Date.parse('2026-11-05T06:00:00Z'));w.us.price=1020;w.record();w.at(Date.parse('2026-11-06T06:00:00Z'));const r=w.reconcile('B',{settledOn:'2026-11-04'});w.record();
  const off=()=>w.points().slice(2).map(p=>p.dailyReturn);assert.deepEqual(off(),[null,null],'no record: unavailable');agree(w,'T41c none');
  const p=w.view.preview('a',r.id);assert.deepEqual(off(),[null,null],'a preview is not a record');
  w.view.approve('a',{candidateId:r.id,requestId:'gate-T41c',binding:p.binding,note:'checked'});assert.ok(off().every(v=>v!=null),'restated with the record in force');assert.equal(w.s.records('a').length,1);agree(w,'T41c approved');
  // Reversed: the approval no longer applies. The restated values are gone; the obligation counts again, so those days
  // show their recorded figures as not verified (CN5), never as restated.
  w.at(Date.parse('2026-11-07T06:00:00Z'));w.reverse(r.id);w.record();assert.ok(w.points().slice(2,4).every(p=>!p.restated&&p.settlement?.includes('pending')),'the record no longer applies');assert.equal(w.view.state('a').records[0].status,'inactive');agree(w,'T41c reversed');
});
test('T41 (d): the one defined bounded case shows its range in every consumer; the combined series stays unavailable',()=>{
  const FRI=Date.parse('2026-11-06T16:00:00Z'),FILL=Date.parse('2026-11-06T15:00:00Z');
  const w=world({start:FRI});w.see([]);w.see([order('A',100,{createdAt:FILL,filledObservedAt:FILL,day:'2026-11-06'})]);w.record();w.nextDay();w.us.price=1010;w.record();
  const [,d]=w.points();assert.ok(d.bounded);close(d.bounded.returnRange.low,10/1500);close(d.bounded.returnRange.high,10/1400);assert.equal(w.points('COMBINED')[1].dailyReturn,null);
  const all=w.all();close(all.twrRange.low,10/1500);agree(w,'T41d');
});
test('harness wiring: main.cjs builds the consumers from the same functions the harness checks',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');
  for(const [re,what] of [[/performanceCorrections\(store\.db,\{inFlight,reconciliation\}\)/,'the correction hook'],[/performance\.settlement=account=>inFlight\.snapshot\(account\)/,'the snapshot recorded with each day'],
    [/performance\.restatements=new \(require\('\.\/valuation-corrections\.cjs'\)\.SettlementRestatements\)/,'the restatements'],[/restatementActions\(\{restatements:performance\.restatements,reconciliation,identity:/,'the restatement view'],
    [/automation\.performanceToday=day=>\{[^\n]*todayFigures\(performance,account,day\)/,'the digest figures'],[/automation\.performanceSummary=[^\n]*reviewPerformance\(s,\{/,'the review context']])assert.match(src,re,what);
});
