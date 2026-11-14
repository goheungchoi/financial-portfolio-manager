'use strict';
// Risk figures D1 and D4 (artifacts/reviews/2026-11-12-risk-figures/design.md and its review).
// D1: the review's performance section gives no peak, trough, drawdown, volatility or best and worst day computed
// across days whose value is not valid; the last clean run is given on its own.
// D4: a KIS Korean reading taken while KIS moves last night's settlement (the narrow state) is held: the last
// consistent reading stays in use and the reading sets no baseline, peak, high, low or graph point; a general relation
// only logs.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {analyze,reviewSummary,riskBreak}=require('../electron/performance.cjs');
const {krCheck,BalanceHold,BOUND_MS}=require('../electron/settlement-check.cjs');
const src=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8').replace(/\r\n/g,'\n');

// ---------- D1 ----------
// The U.S. record shape of 2026-11-12 (artifacts/reviews/2026-11-12-us-drawdown.md): two days with a negative value
// (the low end of a range stored as the value), then a day whose start value is not positive.
function series(rows){let index=1;let prev=null;return rows.map(([day,value,extra={}])=>{const p={day,value,flow:0,pnl:prev==null?0:value-prev,...extra};
  if(prev==null){p.dailyReturn=null;}else if(!('dailyReturn' in extra)){p.dailyReturn=prev>0?(value-prev)/prev:null;}
  if(Number.isFinite(p.dailyReturn))index*=1+p.dailyReturn;p.index=index;prev=value;return p;});}
const NO_BASE=['the day\'s starting value was not positive'];
const US=series([['2026-10-28',606.75],['2026-10-29',557.60],['2026-10-30',648.46],['2026-11-02',650.42],['2026-11-03',554.25],['2026-11-04',560.03],
  ['2026-11-09',-165.02],['2026-11-10',-173.15,{unavailable:NO_BASE,dailyReturn:null}],['2026-11-11',524.49,{unavailable:NO_BASE,dailyReturn:null}],['2026-11-12',529.08]]);
const summary=points=>({kind:'USD',benchmark:'SPX',start:points[0].day,end:points.at(-1).day,periods:[],points,analytics:{All:analyze(points,points[0].day)}});

test('D1: across the negative U.S. days no peak, trough, drawdown, volatility or best and worst day; the reason, and the clean run since',()=>{
  const before=analyze(US,US[0].day);assert.equal(before.peak.value,650.42,'what the model was given before: the peak');assert.equal(before.worstDay.returnPct,-129.47,'and the worst day');
  const r=reviewSummary(summary(US)).risk;
  for(const k of ['peak','trough','maxDrawdownPct','currentDrawdownPct','volatilityPct','bestDay','worstDay','positiveDaysPct'])assert.equal(r[k],null,k);
  assert.equal(r.returnChainBrokenFrom,'2026-11-09');
  assert.equal(r.riskUnavailable,"Return chain broken from 2026-11-09 (2026-11-09: value not positive; 2026-11-10: the day's starting value was not positive; 2026-11-11: the day's starting value was not positive). Peak, trough, drawdowns, volatility and best and worst days would mix values across it; do not derive them from other figures.");
  assert.deepEqual(r.sinceChainResumed,{from:'2026-11-11',to:'2026-11-12',days:2,peak:{value:529,day:'2026-11-12'},trough:{value:524,day:'2026-11-11'},maxDrawdownPct:0,currentDrawdownPct:0,note:'1 day return since the chain resumed; volatility and best and worst days need 5'});
  assert.ok(!JSON.stringify(r).includes('650'),'the overstated 11-02 peak is not given');
});

test('D1: a clean window is exactly as before',()=>{
  const clean=series([['2026-10-01',100],['2026-10-02',102],['2026-10-03',99],['2026-10-06',101],['2026-10-07',104],['2026-10-08',103],['2026-10-09',105]]);
  assert.equal(riskBreak(clean,clean[0].day,clean.at(-1).day),null);
  const a=analyze(clean,clean[0].day);const r=reviewSummary(summary(clean)).risk;
  assert.deepEqual(Object.keys(r),['window','peak','trough','maxDrawdownPct','currentDrawdownPct','maxDrawdown1mPct','volatilityPct','bestDay','worstDay','positiveDaysPct','daysWithReturn','daysWithoutReturn'],'the same fields, in the same order, as at 6c76b62');
  assert.deepEqual([r.peak,r.trough,r.maxDrawdownPct,r.volatilityPct,r.positiveDaysPct],[{value:105,day:'2026-10-09'},{value:99,day:'2026-10-03'},a.maxDrawdownPct,a.volatilityPct,a.positiveDaysPct]);
});

test('D1: the clean run gives volatility and best and worst day from 5 returns; a bounded day breaks the chain; the first day only needs a value',()=>{
  const more=series([...US.map(p=>[p.day,p.value,p.unavailable?{unavailable:p.unavailable,dailyReturn:null}:{}]),['2026-11-13',535],['2026-11-16',530],['2026-11-17',540],['2026-11-18',538]]);
  const r=reviewSummary(summary(more)).risk.sinceChainResumed;assert.equal(r.days,6);assert.ok(Number.isFinite(r.volatilityPct));assert.equal(r.bestDay.day,'2026-11-17');assert.equal(r.worstDay.day,'2026-11-16');assert.equal(r.note,undefined);
  const bounded=series([['2026-10-01',100],['2026-10-02',101,{bounded:{returnRange:{low:0,high:.02},states:{real:0,notReal:.02}},dailyReturn:null}],['2026-10-03',102],['2026-10-06',103]]);
  const b=riskBreak(bounded,'2026-10-01','2026-10-06');assert.match(b.text,/2026-10-02: a range, not one value/);assert.equal(b.resumed.from,'2026-10-03','a bounded day is not a starting value');
  const startsUnavailable=series([['2026-10-01',100,{unavailable:NO_BASE,dailyReturn:null}],['2026-10-02',101],['2026-10-03',102]]);
  assert.equal(riskBreak(startsUnavailable,'2026-10-01','2026-10-03'),null,'the first day of a window only needs a positive value');
  const emptyFirst=series([['2026-10-19',0],['2026-10-20',0],['2026-10-24',539.32],['2026-10-27',545],['2026-10-28',606.75]]);
  assert.equal(riskBreak(emptyFirst,'2026-10-19','2026-10-28'),null,'days at 0 before the account first holds money are not bad records');
  assert.match(riskBreak([...emptyFirst,...series([['2026-10-29',-5]]).map(p=>({...p,dailyReturn:null}))],'2026-10-19','2026-10-29').text,/^Return chain broken from 2026-10-29 \(2026-10-29: value not positive\)/,'a negative day still counts');
  assert.match(riskBreak(series([['2026-10-19',100],['2026-10-20',0],['2026-10-21',100]]),'2026-10-19','2026-10-21').text,/2026-10-20: value not positive/,'a 0 after money arrived counts');
});

test('D1: the change is in the review section only; the analytics the screens use are unchanged',()=>{
  const perf=src('electron/performance.cjs');assert.ok(perf.includes('const broken=riskBreak(s.points,a.from,a.to);'));
  const a=analyze(US,US[0].day);assert.equal(a.peak.value,650.42,'analyze (Performance page, Home) still has its peak');
});

// ---------- D4 ----------
// The two stored readings of 2026-11-12 (broker_balances, raw summary fields as recorded).
const R0004={dnca_tot_amt:3407651,nxdy_excc_amt:3407651,prvs_rcdl_excc_amt:3407651,bfdy_buy_amt:137750,thdt_buy_amt:0,bfdy_sll_amt:0,thdt_sll_amt:0,bfdy_tlex_amt:20,thdt_tlex_amt:0,scts_evlu_amt:434450,tot_evlu_amt:3842101};
const R0056={...R0004,nxdy_excc_amt:3269881,prvs_rcdl_excc_amt:3269881,tot_evlu_amt:3704331};
const snap=(raw,at,extra={})=>({accountKey:'ACC',environment:'live',source:'kis',timestamp:at,raw,...(krCheck(raw)?{settlementCheck:krCheck(raw)}:{}),cash:raw.dnca_tot_amt,settledCash:raw.prvs_rcdl_excc_amt,reportedTotal:raw.tot_evlu_amt,holdings:[{symbol:'005930',quantity:2,availableQuantity:2,price:217000,cost:200000,marketValue:434000}],...extra});

test('D4: the 00:04 reading is the overnight state, off by ₩137,770; the 00:56 one is consistent',()=>{
  const c=krCheck(R0004);assert.equal(c.overnight,true);assert.equal(c.relationOff,true);assert.equal(c.offBy,137770);assert.equal(c.fields.tot_evlu_amt,3842101);
  assert.equal(krCheck(R0056),null);
  assert.equal(krCheck({...R0004,thdt_buy_amt:5000}).overnight,false,'a trade today is never the overnight state');
  assert.equal(krCheck({dnca_tot_amt:1}),null,'missing fields: nothing is concluded');
  assert.equal(krCheck({...R0056,bfdy_buy_amt:0,bfdy_tlex_amt:0,nxdy_excc_amt:3407651,prvs_rcdl_excc_amt:3407651}),null,'no previous-day trade: settlement cash equal to the deposit is right');
});

test('D4: the general relation alone only logs, once; the reading is used',()=>{
  const logs=[];const hold=new BalanceHold({log:(t,b)=>logs.push([t,b])});
  const odd={...R0056,thdt_buy_amt:10000,prvs_rcdl_excc_amt:3269881-10000+5000};const c=krCheck(odd);assert.equal(c.overnight,false);assert.equal(c.relationOff,true);assert.equal(c.offBy,5000);
  const s=snap(odd,'t1');const r1=hold.accept(s),r2=hold.accept(snap(odd,'t2'));
  assert.equal(r1.balance,s);assert.equal(r1.held,false);assert.equal(r1.provisional,false);assert.equal(r2.held,false);
  assert.equal(logs.length,1);assert.equal(logs[0][0],'KIS balance check (observe only)');assert.match(logs[0][1],/by \+₩5,000; the reading is used as before\. Fields: \{/);
});

test('D4: hold: the last consistent reading stays in use; a consistent reading or a trade today ends it; logs once per state',()=>{
  let now=Date.parse('2026-11-11T14:58:00Z');const logs=[];const hold=new BalanceHold({log:(t,b)=>logs.push([t,b]),clock:()=>now});
  const evening=snap(R0056,'2026-11-11T23:58:00+09:00');assert.equal(hold.accept(evening).balance,evening);
  now+=6*60000;const night=snap(R0004,'2026-11-12T00:04:30+09:00');const r=hold.accept(night);
  assert.equal(r.held,true);assert.equal(r.balance,evening);assert.equal(r.balance.reportedTotal,3704331,'the account value stays right');
  now+=10*60000;assert.equal(hold.accept(snap(R0004,'later')).balance,evening);
  assert.deepEqual(logs.map(l=>l[0]),['KIS balance reading held'],'one line for the state');assert.match(logs[0][1],/Using the reading of 2026-11-11T23:58:00\+09:00 until KIS updates it\.$/);
  now+=36*60000;const fixed=snap(R0056,'2026-11-12T00:56:34+09:00');const e=hold.accept(fixed);assert.equal(e.held,false);assert.equal(e.balance,fixed);assert.equal(logs.at(-1)[0],'KIS balance reading consistent again');
  // (a) a reading with a trade today ends a hold at once, even when the cash fields still equal the deposit.
  hold.accept(snap(R0004,'again'));assert.equal(hold.heldSince!=null,true);
  const traded=snap({...R0004,thdt_sll_amt:200000},'trade');const t=hold.accept(traded);assert.equal(t.held,false);assert.equal(t.balance,traded);assert.equal(hold.heldSince,null);
});

test('D4: with no earlier reading, or after 3 hours, the reading is used provisionally, never for the record',()=>{
  let now=0;const logs=[];const hold=new BalanceHold({log:(t,b)=>logs.push([t,b]),clock:()=>now});
  const first=hold.accept(snap(R0004,'start'));assert.equal(first.held,false);assert.equal(first.provisional,true);assert.match(logs[0][1],/No earlier reading to hold/);
  const h2=new BalanceHold({clock:()=>now});h2.accept(snap(R0056,'ok'));now=1;assert.equal(h2.accept(snap(R0004,'a')).held,true);
  now=1+BOUND_MS-1;assert.equal(h2.accept(snap(R0004,'b')).held,true);now=1+BOUND_MS;const late=h2.accept(snap(R0004,'c'));assert.equal(late.held,false);assert.equal(late.provisional,true);
  assert.equal(BOUND_MS,3*3600000);
});

test('D4: the live engine takes no baseline, peak or risk balance from an overnight reading; the review context gets the held one',async()=>{
  const {DatabaseSync}=require('node:sqlite');const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');
  let fresh=snap(R0056,'evening');const live=new LiveEngine(db,{request:async op=>op==='live-context'?{balance:fresh,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:false,status:'closed'}}:null},()=>({status:'connected',snapshot:fresh}));
  live.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:100000}},'ENABLE LIVE');
  const hold=new BalanceHold();live.balanceHold=hold;
  live.observeBalance(fresh);const p0=live.policy();assert.ok(Number.isFinite(p0.baseline));const risk0=live.riskBalance;
  const night=snap(R0004,'night');live.observeBalance(night);const p1=live.policy();
  assert.equal(p1.baseline,p0.baseline);assert.equal(p1.dayPeakEquity??null,p0.dayPeakEquity??null,'the day\'s peak is not raised to 3,842,101');assert.equal(live.riskBalance,risk0,'the loss check keeps the consistent reading');
  hold.accept(fresh);fresh=night;const ctx=await live.context();
  assert.equal(JSON.stringify(ctx).includes('3842101'),false,'the review context does not carry the overnight total');assert.equal(live.policy().dayPeakEquity??null,p0.dayPeakEquity??null);
});

test('D4: the app wiring: every Korean reading goes through the hold; the record and the graph skip it; the raw reading is still stored',()=>{
  const m=src('electron/main.cjs');
  assert.equal((m.match(/kisState=\{status:'connected',\.\.\.useKr\(snapshot\),error:null\}/g)??[]).length,2,'import and refresh');
  assert.ok(m.includes("try{brokerBalances.record(s.accountKey,'KR',kisState.heldReading??s);"),'the KIS reading itself is kept as evidence');
  assert.ok(m.includes('const recordValue=()=>{try{const account=kisState.snapshot?.accountKey;if(!account||kisState.snapshot.settlementProvisional)return;'),'the day\'s value, high and low (C1c: the same guard, written first)');
  assert.ok(m.includes('if(kisState.snapshot?.accountKey&&!kisState.heldReading&&!kisState.snapshot.settlementProvisional&&v!=null)intraday.record('),'no graph point while held or provisional');
  assert.ok(m.includes('live.balanceHold=balanceHold;'));
  const k=src('electron/kis-client.cjs');assert.ok(k.includes("settlementCheck=require('./settlement-check.cjs').krCheck(raw);")&&k.includes('...(settlementCheck?{settlementCheck}:{})'));
  // (b) Order checks read a fresh balance and KIS's orderable quantity, never the held one.
  assert.ok(k.includes("const balance=await this.getBalance();let availableQuantity;"),'prepareOrder reads a fresh balance');
  assert.ok(k.includes("availableQuantity=balance.holdings.find(row=>row.symbol===command.symbol)?.availableQuantity;if(availableQuantity==null || command.quantity>availableQuantity)throw new KisError('INSUFFICIENT_CAPACITY');"),'a sell is checked against the fresh orderable quantity');
});
