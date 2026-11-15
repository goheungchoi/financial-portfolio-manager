// Settlement simplification S2: no day is unavailable for a settlement reason (an open U.S. buy makes a day's return an
// estimate until it settles); days the tracker could not be read still have no return.
// Stage 3.4: consumers of the settlement treatment (performance.cjs analyze/reviewSummary/returnReliability,
// daily-digest.cjs, phone-snapshot.cjs). Unavailable days stay unavailable everywhere and corrections are kept out of
// investment figures. (S4a: the restatement tests went with the restatements.)
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory,reviewSummary,returnReliability}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');
const {buildDigest}=require('../electron/daily-digest.cjs');const {portfolioFigures}=require('../electron/phone-snapshot.cjs');
const MIN=60000,TRACKING=Date.parse('2026-10-26T05:00:00Z');
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-10-26',...extra});
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-9,`${m??''} ${a} vs ${b}`);
function world(){const db=new DatabaseSync(':memory:');let t=TRACKING;const clock=()=>t;const rate=1300;
  const f=new InFlight(db,clock),funding=new FundingLedger(db,{clock}),perf=new PerformanceHistory(db,clock);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'}});
  const sc=performanceCorrections(db,{inFlight:f,reconciliation:rec});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>f.snapshot(a);
  const us={cash:500,price:1000};let seq=0;
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:us.price}],reportedTotal:us.cash+us.price,timestamp:new Date(t).toISOString()});
  const w={db,f,perf,rec,us,clock,at:ms=>{t=ms;},later:ms=>{t+=ms;},
    see:list=>{f.observe('a',{us:U(),orders:list,fx:rate});t+=MIN;},
    record:()=>{const v=value({us:U(),inFlight:f.current('a'),fx:{usdKRW:rate,timestamp:new Date(t).toISOString()},now:t}).markets.US.equity.low;perf.record('a',{totals:{USD:v,KRW:1000000,equityKRW:1000000+v*rate},fx:{usdKRW:rate}});t+=MIN;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'n',...extra};const p=rec.preview(q);return rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});}};
  return w;}
// A $100 fill paid on U.S. settlement date 2026-11-04 (inside day 2's interval in both clocks), reconciled on day 3.
// S2: every day has a return. The payment fell between readings with no evidence match, so day 2 shows it as a loss and the
// reconciliation on day 3 is a +$100 correction: the period is understated by that one payment (design section 3, the known
// limit).
function scenario({route='USD'}={}){const w=world();w.see([]);const A=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([A]);w.record();
  w.at(Date.parse('2026-11-03T14:00:00Z'));w.us.price=1010;w.record();w.at(Date.parse('2026-11-04T12:00:00Z'));w.us.cash=400;
  w.at(Date.parse('2026-11-05T06:00:00Z'));w.us.price=1020;w.record();w.at(Date.parse('2026-11-06T06:00:00Z'));const r=w.reconcile('A',{settledOn:'2026-11-04',route});w.record();return {w,r};}
// Day 2 recorded while the tracker could not be read: days 2 and 3 have no return (U4); the rest of the scenario as above.
function unreadable(){const w=world();w.see([]);const A=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([A]);w.record();
  w.at(Date.parse('2026-11-03T14:00:00Z'));w.us.price=1010;w.record();w.at(Date.parse('2026-11-04T12:00:00Z'));w.us.cash=400;
  w.at(Date.parse('2026-10-29T06:00:00Z'));w.us.price=1020;const snap=w.perf.settlement;w.perf.settlement=()=>{throw new Error('disk I/O error');};w.record();w.perf.settlement=snap;
  w.at(Date.parse('2026-11-06T06:00:00Z'));w.reconcile('A',{settledOn:'2026-11-04'});w.record();return {w};}

test('analytics (S2): settlement-affected days keep their returns; a day the tracker could not be read still breaks the chain',()=>{
  const {w}=scenario();const s=w.perf.summary('a','USD','SPX'),a=s.analytics.All;
  assert.notEqual(a.twrPct,null);assert.notEqual(a.gain,null);assert.notEqual(a.maxDrawdownPct,null);assert.equal(a.chainBrokenFrom,undefined);assert.deepEqual(a.unavailableDays,[]);assert.equal(a.returnDays,3);
  assert.deepEqual(s.periods.find(p=>p.label==='All').settlementAffected,{pending:0,corrected:1,unavailable:0},'A was resolved: plain days, one correction');
  // The known limit: the payment is a loss on day 2 and its resolution a correction on day 3, so the gain is $100 lower.
  close(s.periods.find(p=>p.label==='All').gain,-80);
  const u=unreadable().w.perf.summary('a','USD','SPX'),b=u.analytics.All,days=u.points.map(p=>p.day);
  assert.equal(b.twrPct,null);assert.equal(b.gain,null);assert.equal(b.maxDrawdownPct,null);assert.equal(b.chainBrokenFrom,days[2]);assert.deepEqual(b.drawdown.map(d=>d.drawdownPct==null),[false,false,true,true]);
  assert.deepEqual(b.unavailableDays.map(d=>d.day),[days[2],days[3]]);const d2=b.dailyPnl.find(p=>p.day===days[2]);assert.equal(d2.pnl,null,'no P/L, not zero');assert.match(d2.unavailable[0],/could not be read/);
});
test('analytics: accounting corrections are kept out of the gain',()=>{
  // A rounding record of a $0.40 fill: a +$0.40 basis change, no payment, an ordinary day.
  const w=world();w.see([]);const E=order('E',0.4,{createdAt:w.clock(),filledObservedAt:w.clock(),resultCosts:{netCash:-0.4},costEstimate:{netCash:-0.4}});w.see([E]);w.record();
  w.at(Date.parse('2026-11-03T06:00:00Z'));w.reconcile('E',{explanation:'rounding',route:undefined});w.record();
  const s=w.perf.summary('a','USD',null);close(s.points[1].correction,0.4);close(s.analytics.All.gain,0,'not the raw +$0.40');close(s.analytics.All.corrections,0.4);close(s.periods.find(p=>p.label==='All').gain,0);
});
test('AI review context (S2): returns of settlement days are given, corrections named; days that could not be read are listed with reasons, never numbered',()=>{
  const {w}=scenario();const s=w.perf.summary('a','USD','SPX'),r=reviewSummary(s);const all=r.timeWeightedReturns.find(p=>p.period==='All');
  assert.notEqual(all.returnPct,null);assert.equal(all.unavailable,undefined);assert.equal(r.risk.daysWithoutReturn,0);assert.deepEqual(r.settlement.daysWithoutReturn,[]);assert.deepEqual(r.settlement.accountingCorrections.map(c=>c.amount),[100]);
  assert.match(r.settlement.label,/not investment return; days without a return could not be read/);
  const rel=returnReliability({settlement:s.analytics['3M'].settlementAffected});assert.deepEqual(rel.reasons,['1 day includes accounting corrections, kept out of returns']);
  const u=unreadable().w.perf.summary('a','USD','SPX'),ru=reviewSummary(u),au=ru.timeWeightedReturns.find(p=>p.period==='All');assert.equal(au.returnPct,null);assert.match(au.unavailable[0],/could not be read/);
  assert.equal(ru.risk.maxDrawdownPct,null);assert.equal(ru.risk.daysWithoutReturn,2);assert.ok(ru.recentDailyPnl.filter(p=>p.unavailable).every(p=>p.pnl==null));
  const relu=returnReliability({settlement:u.analytics['3M'].settlementAffected});assert.match(relu.reasons.join(' '),/2 recorded days have no return \(the account or the settlement tracker could not be read then\)/);
  // The summarized and compacted context keep them.
  const ctx=require('../electron/review-context.cjs');const p={history:{US:{...ru,returnReliability:relu}}};const sum=ctx.SUMMARIES.performance(p).history.US.timeWeightedReturns.find(x=>x.period.split('/').includes('All'));
  assert.equal(sum.returnPct,null);assert.ok(sum.unavailable[0].length>0,'the reason survives grouping');
  const cmp=ctx.COMPRESS.find(x=>x[0]==='performance')[1](p).history.US;assert.equal(cmp.settlement.daysWithoutReturn.length,2);assert.equal(cmp.risk.daysWithoutReturn,2);assert.equal(cmp.returnReliability.reliable,false);
});
test('digest and AI context agree (S2): a correction day has its return with the correction named; a day that could not be read has none in both',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');
  const today=w=>d=>[['US','USD','U.S.']].flatMap(([market,currency,label])=>{const p=w.perf.series('a',currency).find(x=>x.day===d);return p?[{market,currency,label,dailyReturn:p.dailyReturn,pnl:p.pnl??null,correction:p.correction??0,unavailable:p.unavailable??null,settlement:p.settlement??[]}]:[];});
  const ctx=w=>({db,config:{scope:'us'},paper:{orders:()=>[]},live:null,usLive:{getState:()=>({loss:{baseline:1500,equity:1520}}),orders:()=>[]},guardrails:{eventsOn:()=>[],failuresOn:()=>0},performanceToday:today(w)});
  const {w}=scenario();const last=w.perf.series('a','USD').at(-1);const d=buildDigest(ctx(w),Date.parse(last.day+'T12:00:00+09:00'));
  assert.match(d.text,/U\.S\. \$1520\.00 \(\+\$20\.00, \+1\.33% value change today\)/,'the engine baseline change is a value change');
  assert.match(d.text,/Investment return today: U\.S\. \+0\.00% · accounting correction \+\$100\.00 \(not investment return\)/);
  const ai=reviewSummary(w.perf.summary('a','USD','SPX')).recentDailyPnl.find(p=>p.day===last.day);assert.equal(ai.unavailable,undefined);assert.equal(ai.returnPct,0);assert.equal(ai.accountingCorrection,100);assert.equal(d.performance[0].correction,100);
  const {w:u}=unreadable();const day=u.perf.series('a','USD')[2];const du=buildDigest(ctx(u),Date.parse(day.day+'T12:00:00+09:00'));
  assert.match(du.text,new RegExp(`U\\.S\\. return unavailable: ${day.unavailable[0].slice(0,40).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
  const aiu=reviewSummary(u.perf.summary('a','USD','SPX')).recentDailyPnl.find(p=>p.day===day.day);assert.equal(aiu.unavailable,true);assert.equal(aiu.pnl,null);assert.equal(du.performance[0].dailyReturn,null);
  // An ordinary day reads the same return in both.
  const first=w.perf.series('a','USD')[1];const d1=buildDigest(ctx(w),Date.parse(first.day+'T12:00:00+09:00'));
  assert.match(d1.text,new RegExp(`Investment return today: U\\.S\\. \\+${(first.dailyReturn*100).toFixed(2)}%`));
});
test('phone snapshot: a settlement-affected day\'s change is a value change, not a return',()=>{
  const {w}=scenario();const daily=w.perf.series('a','COMBINED'),today=daily.at(-1).day;
  const f=portfolioFigures({portfolio:{totals:{equityKRW:3000000},cash:{KRW:0,USD:0},fx:{usdKRW:1300},rows:[]},daily,today});
  assert.match(f.fields[0].value,/value change today \(settlement-affected, not a return\)/);
});
test('CN5 under S2: a payment while a U.S. buy is still counted is an estimate, not a verified return, while the buy is open',()=>{
  // The review's case: a fill seen after tracking started, paid two days later without a matching reading.
  const w=world();w.see([]);const A=order('A',100,{createdAt:w.clock(),filledObservedAt:w.clock()});w.see([A]);w.record();
  w.at(Date.parse('2026-10-28T06:00:00Z'));w.us.cash=400;w.record();
  const s=w.perf.summary('a','USD','SPX'),p=s.points.at(-1);close(p.pnl,-100);assert.ok(p.settlement.includes('pending'));assert.equal(p.pendingObligation.usd,100);
  const rel=returnReliability({settlement:s.analytics.All.settlementAffected});assert.equal(rel.reliable,false);assert.match(rel.reasons[0],/1 day has a U\.S\. buy still awaiting settlement: that return is an estimate until it settles/);
  assert.equal(reviewSummary(s).timeWeightedReturns.find(x=>x.period==='All').settlementAffected.pending,1);
  // Digest: the day's return is shown with "not verified"; phone: a value change, not a return.
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT,calls INTEGER,reservedMicro INTEGER)');
  const performanceToday=d=>{const x=w.perf.series('a','USD').find(q=>q.day===d);return x?[{market:'US',currency:'USD',label:'U.S.',dailyReturn:x.dailyReturn,pnl:x.pnl,correction:x.correction??0,unavailable:x.unavailable??null,returnRange:null,settlement:x.settlement??[]}]:[];};
  const d=buildDigest({db,config:{scope:'us'},paper:{orders:()=>[]},live:null,usLive:{getState:()=>({loss:null}),orders:()=>[]},guardrails:{eventsOn:()=>[],failuresOn:()=>0},performanceToday,accountValues:()=>[]},Date.parse(p.day+'T12:00:00+09:00'));
  assert.match(d.text,/U\.S\. -7\.14% · not verified \(settlement-affected\)/);
  const f=portfolioFigures({portfolio:{totals:{equityKRW:3000000},cash:{KRW:0,USD:0},fx:{usdKRW:1300},rows:[]},daily:w.perf.series('a','COMBINED'),today:p.day});assert.match(f.fields[0].value,/settlement-affected, not a return/);
  // Control: with no U.S. buy open, the day is verified as before.
  const x=world();x.see([]);x.record();x.at(Date.parse('2026-10-27T06:00:00Z'));x.us.price=1010;x.record();const q=x.perf.summary('a','USD','SPX');
  assert.equal(q.points.at(-1).settlement,undefined);assert.equal(returnReliability({settlement:q.analytics.All.settlementAffected}).reliable,true);
  // A snapshot that does not say what was open (recorded before this field existed) is an estimate while a buy opened by then
  // is still open; with nothing open now, the day is plain.
  const y=world();y.see([]);y.record();const row=y.perf.history('a')[0];delete row.settlement.last.open;y.db.prepare('UPDATE nav_history SET payload=? WHERE day=?').run(JSON.stringify(row),row.day);
  y.at(Date.parse('2026-10-27T06:00:00Z'));y.record();assert.equal(y.perf.series('a','USD')[1].pendingObligation,undefined,'nothing open now');
  const v=world();v.see([]);const B=order('B',40,{createdAt:v.clock(),filledObservedAt:v.clock()});v.see([B]);v.record();const vr=v.perf.history('a')[0];delete vr.settlement.last.open;v.db.prepare('UPDATE nav_history SET payload=? WHERE day=?').run(JSON.stringify(vr),vr.day);
  v.at(Date.parse('2026-10-27T06:00:00Z'));v.record();assert.deepEqual(v.perf.series('a','USD')[1].pendingObligation,{usd:40,estimate:true,unknown:true},'B still open: an estimate');
  // An open total at a reading of the day with no piece named and nothing open now: plain (the obligation has gone).
  const z=world();z.see([]);z.record();z.at(Date.parse('2026-10-27T06:00:00Z'));const snap=z.perf.settlement;z.perf.settlement=a=>({...snap(a),open:{buysUSD:50,buys:1}});z.record();z.perf.settlement=snap;z.later(MIN);z.record();
  assert.equal(z.perf.series('a','USD')[1].pendingObligation,undefined);
});
