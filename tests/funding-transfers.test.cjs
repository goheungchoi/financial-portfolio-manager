// C1d-2 (settlement clean-up, c1/c1d2-design.md; review M1-M8): the KRW part of each U.S. buy is booked once as a
// transfer where KIS's figures show it, the U.S. side carries the buy until then, and nothing is ever a detected flow.
// The harness feeds KIS readings through the path main.cjs wires (U.S. hold, funding tracker, settlement tracker,
// recorder, flow detector, the day's record), once as the code was before this step ("old") and once as it is now.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight}=require('../electron/valuation.cjs');const {FundingTracker,settlement}=require('../electron/integrated-settlement.cjs');
const {combinePortfolio}=require('../electron/portfolio-view.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {FlowDetector}=require('../electron/flow-detector.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');
const {UsBalanceHold}=require('../electron/settlement-check.cjs');const {FundingTransfers,uniqueSet}=require('../electron/funding-transfers.cjs');
const A='acct',K=s=>Date.parse(s+'+09:00'),r2=v=>Math.round(v*100)/100;
function world({old=false,db=new DatabaseSync(':memory:')}={}){let t=0;const clock=()=>t;
  const perf=new PerformanceHistory(db,clock),fd=new FlowDetector(db,perf,clock),ft=new FundingTracker(db,clock),hold=new UsBalanceHold({clock});
  let f=new InFlight(db,clock),rec=old?null:new FundingTransfers(db,{performance:perf,clock});
  const sc=performanceCorrections(db,{inFlight:f});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>f.snapshot(a);
  const notes=[],seen={us:[]};fd.onNote=(a,b)=>notes.push(a);let used=null,lastKR=null;const out=[];
  const step=r=>{t=r.at;const ts=new Date(t).toISOString();
    const raw={accountKey:A+':US',environment:'live',timestamp:ts,cash:r.us.cash,...(r.us.pending?{pendingSaleProceeds:r.us.pending}:{}),fx:{usdKRW:r.fx,timestamp:ts},holdings:r.us.holdings,unsettled:{buyKRW:r.us.buyKRW??0,sellKRW:0},raw:{}};
    const h=hold.accept(raw);if(!h.held&&!h.provisional){ft.annotate(raw,r.fx);used=raw;}
    const korea={accountKey:A,environment:'live',timestamp:ts,cash:r.kr.settled,settledCash:r.kr.settled,holdings:r.kr.holdings??[]};
    if(!h.held){f.observe(A,{us:used,orders:r.orders,fx:r.fx});if(rec&&!h.provisional){seen.us.push(t);const tr=f.current(A);rec.observeUS(A,{us:used,orders:r.orders,fx:r.fx,openOrderIds:new Set(tr.open.filter(p=>p.side==='Buy').map(p=>String(p.id))),openBuysUSD:tr.buysUSD});}}
    if(rec&&(!lastKR||lastKR.settled!==r.kr.settled||r.krRead)){lastKR=r.kr;rec.observeKR(A,{korea,orders:r.krOrders??[]});}
    const fund=settlement(used),route=rec?rec.current(A):null,tr=f.current(A);
    const flows=fd.observe(A,{krCash:korea.settledCash-(route?route.krwKRW:fund.confirmedKRW),usCash:used.cash+(used.pendingSaleProceeds??0)-(tr.buysUSD??0)+(tr.sellsUSD??0)-(route?.usUSD??0),fx:r.fx,orders:[...r.orders,...(r.krOrders??[])],provisionalKRW:route?route.provisionalKRW:fund.uncertainKRW,unsettledKRW:fund.unsettledKRW,usExplained:x=>f.explained(A,x),usReview:tr.review,...(route?{funding:route.explained}:{})});
    const st=combinePortfolio(korea,used,used.fx,{},{inFlight:tr,...(route?{funding:route}:{}),now:t});perf.record(A,st);
    const V=st.valuation;out.push({at:t,low:V.combined.low,high:V.combined.high,KR:V.markets.KR.equity,US:V.markets.US.equity,split:route,total:fund.unsettledKRW,flows,used:st});};
  return {db,perf,fd,notes,seen,out,step,restart:()=>{f=new InFlight(db,clock);if(rec)rec=new FundingTransfers(db,{performance:perf,clock});},later:(ms)=>{t+=ms;},flows:()=>perf.flows(A),series:k=>perf.series(A,k)};}
const run=(readings,opts)=>{const w=world(opts);for(const r of readings)w.step(r);
  // Later readings, so the detector's held changes resolve (it holds an unexplained change for 2 hours).
  const last=readings.at(-1);for(const h of [3,8,30])w.step({...last,at:last.at+h*3600000});return w;};
const pnl=(w,k)=>Object.fromEntries(w.series(k).slice(1).map(p=>[p.day.slice(5),p.pnl==null?null:k==='USD'?r2(p.pnl):Math.round(p.pnl)]));
const flowList=w=>w.flows().map(x=>[x.day.slice(5),x.market,x.amount,x.transfer?'transfer':'',x.detected?'detected':'']);
const usBuy=(id,usd,at)=>({id,market:'US',symbol:'NASD:'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:-usd},createdAt:at,filledObservedAt:at});
const usSell=(id,usd,at)=>({id,market:'US',symbol:'NASD:'+id,side:'Sell',status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:usd},createdAt:at,filledObservedAt:at});
// P2 (a): 10-23 to 10-27, KRW-funded with U.S. cash 0 (holdings at fixed prices).
const SEA=[{symbol:'028050',quantity:3,price:59100}],G={symbol:'NASD:GOOGL',quantity:1,price:320.21},N={symbol:'NASD:NVDA',quantity:1,price:210.96};
const g=usBuy('GOOGL',324.44,K('2026-10-24T00:36:00')),n=usBuy('NVDA',213.26,K('2026-10-24T01:38:00'));
const R=(at,note,fx,kr,us,orders)=>({at:K(at),note,fx,kr:{settled:kr,holdings:SEA},us,orders});
const P2A=dense=>[R('2026-10-23T23:00:00','before',1324.6,1319081,{cash:0,holdings:[]},[]),R('2026-10-24T00:40:00','GOOGL',1324.6,1319081,{cash:0,holdings:[G]},[g]),R('2026-10-24T01:42:00','NVDA',1324.6,1319081,{cash:0,holdings:[G,N]},[g,n]),
  ...(dense?[R('2026-10-24T11:27:00','a minute before',1324.6,1319081,{cash:0,holdings:[G,N]},[g,n])]:[]),
  R('2026-10-24T11:28:00','report',1324.6,1319081,{cash:0,holdings:[G,N],buyKRW:712237},[g,n]),R('2026-10-25T12:00:00','weekend',1324.6,1319081,{cash:0,holdings:[G,N],buyKRW:712237},[g,n]),
  R('2026-10-26T12:00:00','monday',1324.3,1319081,{cash:0,holdings:[G,N],buyKRW:712237},[g,n]),R('2026-10-27T08:20:00','before settlement',1322.6,1319081,{cash:0,holdings:[G,N],buyKRW:712237},[g,n]),
  R('2026-10-27T08:24:52','debit',1322.6,1319081,{cash:-537.7,holdings:[G,N],buyKRW:0},[g,n]),R('2026-10-27T08:25:37','exchange',1322.6,603241,{cash:0,holdings:[G,N],buyKRW:0},[g,n]),R('2026-10-27T23:00:00','end',1322.6,603241,{cash:0,holdings:[G,N],buyKRW:0},[g,n])];
// P2 (b): 10-30 to 11-03, RDDT from pending GOOGL proceeds, paid in USD.
const KS=[{symbol:'000270',quantity:1,price:94800},{symbol:'028050',quantity:3,price:60600}],NV={symbol:'NASD:NVDA',quantity:1,price:206.95},PN={symbol:'NYSE:PNR',quantity:1,price:65.94},RD={symbol:'NYSE:RDDT',quantity:1,price:97.66};
const sg=usSell('GOOGLs',279.85,K('2026-10-30T00:18:00')),rd=usBuy('RDDT',97.66,K('2026-10-30T23:12:00'));
const B=(at,fx,us,orders)=>({at:K(at),fx,kr:{settled:414148,holdings:KS},us,orders});
const P2B=[B('2026-10-30T08:50:00',1335.3,{cash:0,pending:279.85,holdings:[NV,PN]},[sg]),B('2026-10-30T23:42:00',1335.3,{cash:0,pending:279.85,holdings:[NV,PN,RD]},[sg,rd]),B('2026-10-31T12:00:00',1335.3,{cash:0,pending:279.85,holdings:[NV,PN,RD]},[sg,rd]),
  B('2026-11-02T08:49:00',1337.2,{cash:0,pending:279.85,holdings:[NV,PN,RD]},[sg,rd]),B('2026-11-02T08:50:00',1337.2,{cash:279.85,holdings:[NV,PN,RD],buyKRW:130590},[sg,rd]),B('2026-11-02T23:00:00',1337.2,{cash:279.85,holdings:[NV,PN,RD],buyKRW:130590},[sg,rd]),
  B('2026-11-03T08:50:00',1341,{cash:182.19,holdings:[NV,PN,RD],buyKRW:0},[sg,rd]),B('2026-11-03T23:00:00',1341,{cash:182.19,holdings:[NV,PN,RD],buyKRW:0},[sg,rd])];
// P2 (c) and the K2 case: a $97.66 buy with U.S. cash $c; at settlement KIS debits the cash and exchanges the shortfall.
const X={symbol:'NYSE:X',quantity:1,price:97.66};
const C=(cash,{exchange})=>{const xb=usBuy('X',97.66,K('2026-11-16T23:40:00')),c=(at,kr,us,o=[xb])=>({at:K(at),fx:1340,kr:{settled:kr,holdings:[]},us,orders:o});
  return [c('2026-11-16T23:00:00',1000000,{cash,holdings:[]},[]),c('2026-11-16T23:45:00',1000000,{cash,holdings:[X]}),c('2026-11-17T08:59:00',1000000,{cash,holdings:[X]}),c('2026-11-17T09:00:00',1000000,{cash,holdings:[X],buyKRW:130866}),
    c('2026-11-18T08:24:00',1000000,{cash:exchange.debitCash,holdings:[X],buyKRW:0}),c('2026-11-18T08:25:00',1000000-exchange.krw,{cash:exchange.afterCash,holdings:[X],buyKRW:0}),c('2026-11-18T23:00:00',1000000-exchange.krw,{cash:exchange.afterCash,holdings:[X],buyKRW:0})];};
const P2C=C(50,{exchange:{debitCash:-47.66,krw:63864,afterCash:0}});
const K2=C(300,{exchange:{debitCash:300,krw:130866,afterCash:300}});

test('M6 and P2 (a) dense: exactly one transfer pair on 10-24, booked by the recorder; series as today with the hold',()=>{
  const w=run(P2A(true)),o=run(P2A(true),{old:true});
  assert.deepEqual(flowList(w),[['10-24','KR',-712237,'transfer',''],['10-24','US',537.7,'transfer','']],'one pair, not two');
  assert.ok(w.flows().every(x=>x.source==='funding'&&x.id.startsWith('funding:')),'booked by the recorder');
  assert.deepEqual(flowList(o).map(x=>x.slice(0,4)),flowList(w).map(x=>x.slice(0,4)),'the same pair as the detector booked before this step');
  for(const k of ['KRW','USD','COMBINED'])assert.deepEqual(pnl(w,k),pnl(o,k),k);
  const kr=pnl(w,'KRW');assert.deepEqual(['10-24','10-25','10-26','10-27'].map(d=>kr[d]),[0,0,0,-3603]);assert.equal(pnl(w,'USD')['10-24'],-6.53);
});
test('P2 (a) with an app start between fill and report: the same as dense (K1 needs no fresh reading)',()=>{
  const dense=run(P2A(true)),w=world();const rs=P2A(false);for(const [i,r] of rs.entries()){if(i===3)w.restart();w.step(r);}for(const h of [3,8,30])w.step({...rs.at(-1),at:rs.at(-1).at+h*3600000});
  assert.deepEqual(flowList(w),flowList(dense));for(const k of ['KRW','USD'])assert.deepEqual(pnl(w,k),pnl(dense,k),k);
  const old=run(P2A(false),{old:true});assert.notDeepEqual(pnl(old,'KRW'),pnl(w,'KRW'),'before this step the sparse case showed the funding as P/L');
});
test('P2 (b) USD-paid: no flow, no non-market P/L, the days marked as an estimate',()=>{
  const w=run(P2B);assert.deepEqual(flowList(w),[]);
  for(const k of ['KRW','USD'])for(const [d,v] of Object.entries(pnl(w,k)))assert.ok(Math.abs(v)<0.01,`${k} ${d} ${v}`);
  const day=w.series('USD').find(p=>p.day==='2026-11-02');assert.equal(day.fundingRouteOpen,true);assert.ok(day.settlement.includes('pending'),'an estimate');
  assert.equal(w.series('USD').find(p=>p.day==='2026-11-03').fundingRouteOpen,undefined,'settled: no longer marked');
  const old=run(P2B,{old:true});assert.equal(pnl(old,'KRW')['11-02'],-130590,'W4 before this step');
});
test('P2 (c) partly USD-paid: nothing booked at the report; the exchange is booked at KIS\'s amounts; no non-market P/L',()=>{
  const w=run(P2C);assert.deepEqual(flowList(w),[['11-18','KR',-63864,'transfer',''],['11-18','US',47.66,'transfer','']]);
  for(const k of ['KRW','USD'])for(const [d,v] of Object.entries(pnl(w,k)))assert.ok(Math.abs(v)<0.01,`${k} ${d} ${v}`);
});
test('the K2 case (KIS takes KRW although U.S. cash could pay): booked at settlement; no non-market P/L',()=>{
  const w=run(K2);assert.deepEqual(flowList(w),[['11-18','KR',-130866,'transfer',''],['11-18','US',97.66,'transfer','']]);
  for(const k of ['KRW','USD'])for(const [d,v] of Object.entries(pnl(w,k)))assert.ok(Math.abs(v)<0.01,`${k} ${d} ${v}`);
});
test('M3: K1 at the report, then USD arriving, then a partly USD settlement: a reversal entry; no non-market P/L; both kept',()=>{
  const xb=usBuy('X',97.66,K('2026-11-16T23:40:00')),Z={symbol:'NYSE:Z',quantity:1,price:60},zs=usSell('Z',60,K('2026-11-17T23:40:00'));
  const c=(at,kr,us,o)=>({at:K(at),fx:1340,kr:{settled:kr,holdings:[]},us,orders:o});
  const rs=[c('2026-11-16T23:00:00',1000000,{cash:0,holdings:[Z]},[]),c('2026-11-16T23:45:00',1000000,{cash:0,holdings:[Z,X]},[xb]),c('2026-11-17T09:00:00',1000000,{cash:0,holdings:[Z,X],buyKRW:130866},[xb]),
    c('2026-11-17T23:45:00',1000000,{cash:0,pending:60,holdings:[X],buyKRW:130866},[xb,zs]),c('2026-11-18T08:20:00',1000000,{cash:60,holdings:[X],buyKRW:130866},[xb,zs]),
    c('2026-11-18T08:24:00',1000000,{cash:-37.66,holdings:[X],buyKRW:0},[xb,zs]),c('2026-11-18T08:25:00',1000000,{cash:0,holdings:[X],buyKRW:0},[xb,zs]),c('2026-11-18T08:26:00',949536,{cash:0,holdings:[X],buyKRW:0},[xb,zs]),c('2026-11-18T23:00:00',949536,{cash:0,holdings:[X],buyKRW:0},[xb,zs])];
  const w=run(rs);const f=flowList(w);
  assert.deepEqual(f.slice(0,2),[['11-17','KR',-130866,'transfer',''],['11-17','US',97.66,'transfer','']],'K1 kept');
  assert.deepEqual(f.slice(2).map(x=>x.slice(1,3)).sort(),[['KR',80402],['US',-60]].sort(),'the reversal, its own entry');
  assert.ok(!f.some(x=>x[4]==='detected'));for(const k of ['KRW','USD'])for(const [d,v] of Object.entries(pnl(w,k)))assert.ok(Math.abs(v)<0.01,`${k} ${d} ${v}`);
});
test('M2: no Korean fall at all gives no flow of any kind; a fall outside the band goes through the detector as usual',()=>{
  const none=C(50,{exchange:{debitCash:-47.66,krw:0,afterCash:0}});const w=run(none);
  assert.deepEqual(flowList(w),[],'no flow, no false deposit');assert.ok(!w.notes.length,'no note');
  // A Korean withdrawal of ₩200,000 the same day, far outside the band: the detector records it as it would without the recorder.
  const far=C(50,{exchange:{debitCash:-47.66,krw:200000,afterCash:0}});const v=run(far);const d=flowList(v);
  assert.ok(d.some(x=>x[1]==='KR'&&x[4]==='detected'&&x[2]===-200000),JSON.stringify(d));assert.ok(!d.some(x=>x[3]==='transfer'),'not taken for the exchange');
});
test('M4: while KIS reports an amount, every won is a U.S. obligation, a Korean deduction or provisional; and M1 for these replays',()=>{
  for(const rs of [P2A(true),P2A(false),P2B,P2C,K2]){const w=run(rs),o=run(rs,{old:true});
    for(const [i,x] of w.out.entries()){if(x.total>0){const kr=x.used.committedKRW??0,us=x.split.usReportedKRW;assert.equal(Math.round(kr+us),Math.round(x.total),`reading ${i}`);}
      assert.ok(Math.abs(x.low-o.out[i].low)<=2&&Math.abs(x.high-o.out[i].high)<=2,`combined at reading ${i}: ${x.low}/${x.high} against ${o.out[i].low}/${o.out[i].high}`);}}
});
test('M4: a report the rule cannot attribute (one of two equal buys) is provisional, Korean; a report present at the first reading is attributed',()=>{
  assert.equal(uniqueSet([{v:50},{v:50}],50,x=>x.v),null,'two equal sets: none');
  const a=usBuy('A',50,K('2026-11-16T23:40:00')),b=usBuy('B',50,K('2026-11-16T23:41:00')),H={symbol:'NYSE:H',quantity:2,price:50};
  const c=(at,us,o=[a,b])=>({at:K(at),fx:1340,kr:{settled:1000000,holdings:[]},us,orders:o});
  const rs=[c('2026-11-16T23:00:00',{cash:20,holdings:[]},[]),c('2026-11-16T23:45:00',{cash:20,holdings:[H]}),c('2026-11-17T08:59:00',{cash:20,holdings:[H]}),c('2026-11-17T09:00:00',{cash:20,holdings:[H],buyKRW:67000})];
  const w=world(),o=world({old:true});for(const r of rs){w.step(r);o.step(r);}const x=w.out.at(-1);
  assert.equal(x.split.provisionalKRW,67000);assert.equal(x.split.usReportedKRW,0);assert.equal(x.used.committedKRW,67000,'the Korean low deducts it, as before this step');
  assert.ok(Math.abs(x.low-o.out.at(-1).low)<=2&&Math.abs(x.high-o.out.at(-1).high)<=2);assert.deepEqual(flowList(w),[]);
  // A report already present at the first reading: the settlement tracker holds the young buy in flight (reported
  // before seen), so the report is not attributed to it: provisional, Korean, as before this step. Every won has a home.
  const y=world(),z=world({old:true});const d=usBuy('D',97.66,K('2026-11-16T23:40:00')),first={at:K('2026-11-17T09:00:00'),fx:1340,kr:{settled:1000000,holdings:[]},us:{cash:0,holdings:[X],buyKRW:130866},orders:[d]};
  y.step(first);z.step(first);const q=y.out.at(-1);assert.equal(q.split.provisionalKRW+q.split.krwKRW+q.split.usReportedKRW,130866);assert.equal(q.split.provisionalKRW,130866);
  assert.ok(Math.abs(q.low-z.out.at(-1).low)<=2&&Math.abs(q.high-z.out.at(-1).high)<=2);
});
test('restart and repeat: a fresh recorder on the same database, reading the same again, books nothing new',()=>{
  const w=run(P2A(true));const before=flowList(w);const rs=P2A(true),last=rs.at(-1);w.restart();
  // The same reading again after the restart (as when the app restarts and KIS returns an unchanged balance), then later ones.
  for(const h of [30,30,31,40])w.step({...last,at:last.at+h*3600000});assert.deepEqual(flowList(w),before);
  // And at the report itself: a fresh recorder that sees the report reading again books no second pair.
  const v=world();for(const r of rs.slice(0,5))v.step(r);const one=flowList(v);v.restart();v.step({...rs[4],at:rs[4].at+60000});assert.deepEqual(flowList(v),one);assert.equal(one.length,2);
});
test('M7: neither a held nor a provisional U.S. reading reaches the recorder',()=>{
  const w=run(P2A(true));const debit=K('2026-10-27T08:24:52');assert.ok(!w.seen.us.includes(debit),'the held debit reading');assert.ok(w.seen.us.includes(K('2026-10-27T08:25:37')));
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.ok(main.includes('if(!us.settlementProvisional)try{const t=inFlightOf(s.accountKey);fundingTransfers.observeUS('),'provisional readings skipped');
  assert.ok(main.includes('if(s!==lastFundingKR&&!s.settlementProvisional){lastFundingKR=s;'),'Korean provisional readings skipped');
});
test('the funding check before an order never reads the recorder; the valuation note says the route is assumed (K1)',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/funding-ledger.cjs'),'utf8');assert.ok(!/funding-transfers|fundingOf|fundingSplit/.test(src));
  const w=run(P2B);const x=w.out.find(o=>o.split?.usOrders>0);const c=x.used.valuation.markets.US.components.find(c=>c.name==='fundingRouteOpen');
  assert.equal(c.note,'assumed paid from U.S. cash or proceeds; KIS may take KRW');assert.ok(c.low<0&&c.high===0);assert.ok(x.used.valuation.markets.US.reasons.some(r=>/funding route not yet shown by KIS/.test(r)));
});
// M1 over generated sequences: buys of random size and cash, reports with and without a reading just before, settlements
// as KIS does them (U.S. cash first, the shortfall exchanged), restarts, in mixed order.
test('M1: over 120 generated sequences the combined low and high at every reading equal the code before this step, to ₩2',()=>{
  let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  for(let k=0;k<120;k++){const fx=1300+Math.round(rnd()*80),cash0=[0,0,20,50,150,400][Math.floor(rnd()*6)],price=40+Math.round(rnd()*400*100)/100,start=K('2026-11-16T22:00:00');
    const buy=usBuy('B'+k,price,start+20*60000),H={symbol:'NYSE:B',quantity:1,price},rep=Math.round(price*fx),paid=Math.min(cash0,price),short=r2(price-paid),krw=Math.round(short*(fx+Math.round((rnd()-0.5)*6)));
    const kr0=2000000,c=(dt,kr,us,o=[buy])=>({at:start+dt*60000,fx,kr:{settled:kr,holdings:[]},us,orders:o});
    const rs=[c(0,kr0,{cash:cash0,holdings:[]},[]),c(21,kr0,{cash:cash0,holdings:[H]}),...(rnd()<0.5?[c(600,kr0,{cash:cash0,holdings:[H]})]:[]),c(601,kr0,{cash:cash0,holdings:[H],buyKRW:rep}),
      c(1500,kr0,{cash:cash0,holdings:[H],buyKRW:rep}),c(2000,kr0,{cash:r2(cash0-price),holdings:[H],buyKRW:0}),c(2001,kr0-krw,{cash:r2(Math.max(0,cash0-price)),holdings:[H],buyKRW:0}),c(2400,kr0-krw,{cash:r2(Math.max(0,cash0-price)),holdings:[H],buyKRW:0})];
    const w=world(),o=world({old:true});const restartAt=Math.floor(rnd()*rs.length);
    for(const [i,r] of rs.entries()){if(i===restartAt)w.restart();w.step(r);o.step(r);const a=w.out.at(-1),b=o.out.at(-1);
      assert.ok(Math.abs(a.low-b.low)<=2&&Math.abs(a.high-b.high)<=2,`sequence ${k} reading ${i}: ${a.low}/${a.high} against ${b.low}/${b.high}`);}
    assert.ok(!w.flows().some(x=>x.detected),`sequence ${k}: no detected flow`);}
});

test('M5: at the first reading, buys already past the age rule (or any, with nothing reported) are history, never matched later',()=>{
  const db=new DatabaseSync(':memory:');let now=K('2026-11-14T10:00:00');const perf=new PerformanceHistory(db,()=>now),rec=new FundingTransfers(db,{performance:perf,clock:()=>now});
  const old=usBuy('OLD',97.66,K('2026-10-30T23:12:00'));const us=(buyKRW,cash=354.09)=>({cash,unsettled:{buyKRW,sellKRW:0},holdings:[]});
  rec.observeUS(A,{us:us(0),orders:[old],fx:1332.4});assert.deepEqual(rec.rows(A).map(r=>[r.key,r.state]),[['o:OLD','none']]);
  // A later report of the same size (a new buy outside the list, or a coincidence) is never attributed to the old one.
  now+=86400000;rec.observeUS(A,{us:us(130000,0),orders:[old],fx:1332.4});assert.equal(rec.current(A).provisionalKRW,130000);assert.deepEqual(perf.flows(A),[]);
});

// C1d-2b (review findings F1-F5): the recorder on its own (no detector), as the planner's sequences S1-S6 drove it.
function lone(start=Date.parse('2026-11-16T14:40:00Z')){const db=new DatabaseSync(':memory:');let t=start;const clock=()=>t;const perf=new PerformanceHistory(db,clock);const f=new FundingTransfers(db,{performance:perf,clock});
  const b=(id,usd)=>({id,side:'Buy',filled:1,fillPrice:usd,market:'US',accountKey:'A:US',createdAt:t,filledObservedAt:t,resultCosts:{netCash:-usd}});
  return {db,f,perf,b,later:ms=>{t+=ms;},us:(cash,buyKRW,orders,x={})=>{const r=f.observeUS('A',{us:{cash,pendingSaleProceeds:x.pending??0,unsettled:{buyKRW,sellKRW:0}},orders,fx:1340,openOrderIds:new Set(x.open??[]),openBuysUSD:x.openUSD??0});t+=60000;return r;},
    kr:settled=>{const r=f.observeKR('A',{korea:{cash:settled,settledCash:settled}});t+=60000;return r;},flows:()=>db.prepare('SELECT id,payload FROM cash_flows').all().map(r=>({id:r.id,...JSON.parse(r.payload)})),state:k=>f.rows('A').find(r=>r.key===k)?.state};}
test('F1: K1, then KIS pays the whole buy in USD: the full reversal at that U.S. reading; explained back to 0',()=>{
  const w=lone();w.us(0,0,[]);const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});w.us(0,134000,o);w.kr(3000000);w.later(20*3600000);w.us(150,134000,o);const c=w.us(50,0,o);
  assert.equal(w.state('o1'),'booked');assert.deepEqual(c.explained,{KR:0,US:0});
  assert.deepEqual(w.flows().map(x=>[x.id,x.market,x.amount]),[['funding:o1:out','KR',-134000],['funding:o1:in','US',100],['funding:o1:reversal-out','US',-100],['funding:o1:reversal-in','KR',134000]]);
});
test('F2: every leg has its deterministic id and source, an order id with an s included; a repeat books nothing',()=>{
  const w=lone();w.us(0,0,[]);const o=[w.b('sell-side-s1',100)];w.us(0,0,o,{open:['sell-side-s1'],openUSD:100});w.us(0,134000,o);w.kr(3000000);w.later(20*3600000);w.us(60,134000,o);w.us(0,0,o);w.kr(3000000-53600);
  const f=w.flows();assert.deepEqual(f.map(x=>x.id),['funding:sell-side-s1:out','funding:sell-side-s1:in','funding:sell-side-s1:reversal-out','funding:sell-side-s1:reversal-in']);assert.ok(f.every(x=>x.source==='funding'&&x.transfer));
  for(const leg of ['out','in','reversal-out','reversal-in'])assert.equal(w.f.book('A','sell-side-s1',leg,{market:'KR',amount:1,day:'2026-11-17',note:'x',at:0}),null,leg);assert.equal(w.flows().length,4);
  assert.equal(w.perf.addFlow('A',{id:'funding:has space',day:'2026-11-17',market:'KR',amount:1,transfer:true,source:'funding'}).id.startsWith('funding:'),false,'an id with a space is never kept');
});
test('F3: a buy filling while another settles in USD is no part of what the settlement took: no phantom shortfall',()=>{
  const w=lone();w.us(500,0,[]);const o1=w.b('o1',100);w.us(500,0,[o1],{open:['o1'],openUSD:100});w.us(500,134000,[o1]);assert.equal(w.state('o1'),'us');w.later(20*3600000);
  const o2=w.b('o2',80);const c=w.us(400,0,[o1,o2],{open:['o2'],openUSD:80});assert.equal(w.state('o1'),'booked');assert.deepEqual(c.explained,{KR:0,US:0});assert.deepEqual(w.flows(),[]);
});
test('F4: a failure after the first leg leaves nothing behind; the next reading books the pair once',()=>{
  const w=lone();w.us(0,0,[]);const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});const real=w.perf.addFlow.bind(w.perf);let n=0;w.perf.addFlow=(...a)=>{if(++n===2)throw new Error('DISK');return real(...a);};
  assert.throws(()=>w.us(0,134000,o),/DISK/);w.perf.addFlow=real;assert.deepEqual(w.flows(),[]);assert.equal(w.state('o:o1'),'filled');assert.equal(w.f.current('A').explained.KR,0);
  w.us(0,134000,o);assert.deepEqual(w.flows().map(x=>x.id),['funding:o1:out','funding:o1:in']);
});
test('F5: a filled buy KIS never reported ages to history, with its reason; a later buy of the same size is attributed',()=>{
  const w=lone();w.us(0,0,[]);const o1=w.b('o1',100);w.us(0,0,[o1],{open:['o1'],openUSD:100});w.later(10*86400000);const o2=w.b('o2',100);w.us(0,0,[o1,o2],{open:['o2'],openUSD:100});
  const r=w.f.rows('A').find(x=>x.key==='o:o1');assert.equal(r.state,'none');assert.match(r.reason,/settled by age without a KIS report/);
  w.us(0,134000,[o1,o2]);assert.equal(w.state('o2'),'krw');assert.equal(w.f.current('A').provisionalKRW,0);
});
// The generated sequences, extended (C1d-2b): K1 then full USD, K1 then partial USD, a second buy filling during the
// first's settlement, and the USD-first settlement, with restarts. Checked at every reading: combined low and high as
// before this step. At the end: no detected flow; the explained amounts equal the booked flows plus the observed U.S.
// settlements (KR: every funding flow; U.S.: K1 and reversal flows plus the shortfalls observed at settlement, whose
// exchange legs are not explained again); every group ends booked (with how), none or unmatched (with a reason).
test('generated sequences (C1d-2b): no detected flow, explained = booked + observed, every group closed with a reason',()=>{
  let seed=11;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  for(let k=0;k<100;k++){const kind=k%4,fx=1300+Math.round(rnd()*80),price=40+Math.round(rnd()*300*100)/100,start=K('2026-11-16T22:00:00'),buy=usBuy('B'+k,price,start+20*60000),H={symbol:'NYSE:B',quantity:1,price};
    const kr0=2000000,c=(dt,kr,us,o=[buy])=>({at:start+dt*60000,fx,kr:{settled:kr,holdings:[]},us,orders:o}),rep=Math.round(price*fx);let rs;
    if(kind===0){const cash0=[0,20,50,150,400][Math.floor(rnd()*5)],paid=Math.min(cash0,price),krw=Math.round(r2(price-paid)*fx);
      rs=[c(0,kr0,{cash:cash0,holdings:[]},[]),c(21,kr0,{cash:cash0,holdings:[H]}),c(600,kr0,{cash:cash0,holdings:[H]}),c(601,kr0,{cash:cash0,holdings:[H],buyKRW:rep}),c(2000,kr0,{cash:r2(cash0-price),holdings:[H],buyKRW:0}),c(2001,kr0-krw,{cash:r2(Math.max(0,cash0-price)),holdings:[H],buyKRW:0}),c(2400,kr0-krw,{cash:r2(Math.max(0,cash0-price)),holdings:[H],buyKRW:0})];}
    else if(kind===1||kind===2){// K1 (no USD at the report); USD arrives (a sale's proceeds), then KIS pays all (1) or part (2) in USD.
      const Z={symbol:'NYSE:Z',quantity:1,price:kind===1?r2(price+10):r2(price/2)},zs=usSell('Z'+k,Z.price,start+900*60000),cashIn=Z.price,paid=Math.min(cashIn,price),krw=Math.round(r2(price-paid)*fx),o2=[buy,zs];
      rs=[c(0,kr0,{cash:0,holdings:[Z]},[]),c(21,kr0,{cash:0,holdings:[Z,H]}),c(600,kr0,{cash:0,holdings:[Z,H]}),c(601,kr0,{cash:0,holdings:[Z,H],buyKRW:rep}),c(901,kr0,{cash:0,pending:cashIn,holdings:[H],buyKRW:rep},o2),c(1500,kr0,{cash:cashIn,holdings:[H],buyKRW:rep},o2),
        c(2000,kr0,{cash:r2(cashIn-price),holdings:[H],buyKRW:0},o2),c(2001,kr0,{cash:r2(Math.max(0,cashIn-price)),holdings:[H],buyKRW:0},o2),c(2002,kr0-krw,{cash:r2(Math.max(0,cashIn-price)),holdings:[H],buyKRW:0},o2),c(2400,kr0-krw,{cash:r2(Math.max(0,cashIn-price)),holdings:[H],buyKRW:0},o2)];}
    else{// A second buy fills while the first settles in USD.
      const b2=usBuy('C'+k,60,start+1999*60000),H2={symbol:'NYSE:C',quantity:1,price:60},cash0=r2(price+200);
      rs=[c(0,kr0,{cash:cash0,holdings:[]},[]),c(21,kr0,{cash:cash0,holdings:[H]}),c(600,kr0,{cash:cash0,holdings:[H]}),c(601,kr0,{cash:cash0,holdings:[H],buyKRW:rep}),c(2000,kr0,{cash:r2(cash0-price),holdings:[H,H2],buyKRW:0},[buy,b2]),c(2400,kr0,{cash:r2(cash0-price),holdings:[H,H2],buyKRW:0},[buy,b2])];}
    const w=world(),o=world({old:true});const restartAt=1+Math.floor(rnd()*(rs.length-1));
    for(const [i,r] of rs.entries()){if(i===restartAt)w.restart();w.step(r);o.step(r);const a=w.out.at(-1),b=o.out.at(-1);
      assert.ok(Math.abs(a.low-b.low)<=2&&Math.abs(a.high-b.high)<=2,`kind ${kind} sequence ${k} reading ${i}: ${a.low}/${a.high} against ${b.low}/${b.high}`);}
    // Then five days on, so a buy still waiting for KIS's report ages by the rule.
    for(const h of [3,8,30,120])w.step({...rs.at(-1),at:rs.at(-1).at+h*3600000});
    assert.ok(!w.flows().some(x=>x.detected),`kind ${kind} sequence ${k}: a detected flow ${JSON.stringify(flowList(w))}`);
    const rec=new FundingTransfers(w.db),cur=rec.current(A),rows=rec.rows(A),ff=w.flows().filter(x=>x.source==='funding');
    const byLeg=(m,pred)=>ff.filter(x=>x.market===m&&pred(x)).reduce((n,x)=>n+x.amount,0),viaOf=x=>rows.find(r=>x.id.startsWith('funding:'+r.key+':'))?.via;
    assert.ok(Math.abs(cur.explained.KR-byLeg('KR',()=>true))<=1,`kind ${kind} ${k}: explained KR ${cur.explained.KR} vs booked ${byLeg('KR',()=>true)}`);
    const usExpected=byLeg('US',x=>viaOf(x)!=='exchange')+rows.reduce((n,r)=>n+(r.shortfallUSD??0),0);
    assert.ok(Math.abs(cur.explained.US-usExpected)<=0.02,`kind ${kind} ${k}: explained US ${cur.explained.US} vs booked and observed ${usExpected}`);
    for(const r of rows)assert.ok(r.state==='booked'&&r.via||(r.state==='none'||r.state==='unmatched')&&r.reason,`kind ${kind} ${k}: ${r.key} ends ${r.state} ${r.reason??r.via??''}`);}
});
