// The account valuation contract (audit 2026-11-04, Stage 2): each component once, bounds that cover what funding
// could have been, credit accounts on broker net assets, and an incomplete or partial value said plainly.
const test=require('node:test');const assert=require('node:assert/strict');const {value,STALE_MS}=require('../electron/valuation.cjs');
const now=Date.parse('2026-11-04T11:39:00Z'),ts=new Date(now-60000).toISOString(),fx={usdKRW:1341.2,source:'KIS',timestamp:ts};
const kr=(extra={})=>({timestamp:ts,cash:407651,settledCash:407651,reportedTotal:705451,holdings:[{symbol:'000270',quantity:1,price:97100},{symbol:'028050',quantity:3,price:66900}],...extra});
const us=(extra={})=>({timestamp:ts,cash:182.19,reportedTotal:559.34,holdings:[{symbol:'NASD:NVDA',quantity:1,price:209.16},{symbol:'NYSE:PNR',quantity:1,price:70.38},{symbol:'NYSE:RDDT',quantity:1,price:97.61}],...extra});
const close=(a,b,msg)=>assert.ok(Math.abs(a-b)<0.01,`${msg??''} ${a} vs ${b}`);
test('the Stage 0 worksheet: exact, complete, both markets, and the same total',()=>{
  const v=value({korea:kr(),us:us(),fx,now});assert.equal(v.combined.complete,true);assert.equal(v.combined.exact,true);assert.deepEqual(v.combined.scope,['KR','US']);
  close(v.markets.KR.equity.low,705451);close(v.markets.US.equity.low,559.34);close(v.combined.headline,1455637.808,'₩1,455,637.81 in the worksheet');
  assert.ok(v.markets.KR.components.every(c=>['observed','derived'].includes(c.basis)&&c.source));assert.equal(v.version,'net-equity 2026-11-05');
});
test('a cash-only deposit or withdrawal moves equity by exactly the flow, in both bounds',()=>{
  const base=value({korea:kr(),us:us({unsettled:{buyKRW:50000,sellKRW:0,krwFundedKRW:10000}}),fx,now}).combined;
  for(const d of [1000000,-250000]){const v=value({korea:kr({cash:407651+d,settledCash:407651+d}),us:us({unsettled:{buyKRW:50000,sellKRW:0,krwFundedKRW:10000}}),fx,now}).combined;close(v.low-base.low,d);close(v.high-base.high,d);}
});
test('a U.S. buy is counted once whether KRW or USD paid for it, and the bounds cover both',()=>{
  const A=130591;const shares={symbol:'NYSE:RDDT',quantity:1,price:97.61};const before=value({korea:kr(),us:us({holdings:us().holdings.filter(h=>h.symbol!=='NYSE:RDDT'),cash:182.19+97.66}),fx,now}).combined.low;
  // KRW-funded and known: KIS keeps the KRW until settlement and reports it awaiting settlement: subtracted once, exact.
  const krwPaid=value({korea:kr(),us:us({holdings:[...us().holdings.filter(h=>h.symbol!=='NYSE:RDDT'),shares],cash:182.19+97.66,unsettled:{buyKRW:A,sellKRW:0,krwFundedKRW:A}}),fx,now}).combined;
  assert.equal(krwPaid.exact,true);close(krwPaid.low,before+97.61*1341.2-A,'KRW-funded');
  // USD-funded, cash already reduced, but KIS cannot say which: the true value is the high bound; the low bound subtracts it again.
  const usdPaid=value({korea:kr(),us:us({unsettled:{buyKRW:A,sellKRW:0,krwFundedKRW:0}}),fx,now}).combined;
  const truth=value({korea:kr(),us:us(),fx,now}).combined.low;assert.equal(usdPaid.exact,false);assert.ok(usdPaid.low<=truth&&truth<=usdPaid.high+0.01,'USD-funded truth inside the range');close(usdPaid.high-usdPaid.low,A);
  // KRW-funded but unknown: truth is the low bound.
  const krwUnknown=value({korea:kr(),us:us({holdings:[...us().holdings.filter(h=>h.symbol!=='NYSE:RDDT'),shares],cash:182.19+97.66,unsettled:{buyKRW:A,sellKRW:0,krwFundedKRW:0}}),fx,now}).combined;
  close(krwUnknown.low,krwPaid.low,'truth at the low bound');assert.ok(krwUnknown.high>=krwUnknown.low);
});
test('2026-10-30: a U.S. buy paid from unsettled sale proceeds, in no KIS figure yet, is outside the high bound only',()=>{
  // Cash 0, $279.85 proceeds pending, the RDDT share counted, nothing reported awaiting settlement.
  const gap=us({cash:0,pendingSaleProceeds:279.85,holdings:[{symbol:'NYSE:RDDT',quantity:1,price:97.61}]});
  const blind=value({korea:kr(),us:gap,fx,now}).combined;const seen=value({korea:kr(),us:gap,fx,inFlight:{buysUSD:97.66},now}).combined;
  close(blind.low-seen.low,97.66*1341.2,'the buy is subtracted in the low bound');close(seen.high,blind.high,'and not in the high bound');assert.equal(seen.exact,false);
  const settled=value({korea:kr(),us:us({cash:182.19,holdings:[{symbol:'NYSE:RDDT',quantity:1,price:97.61}]}),fx,now}).combined;close(settled.low,seen.low,'after settlement the value is the old low bound');
  // Once KIS reports it awaiting settlement the tracker no longer holds it in flight, and the low bound is unchanged:
  // the obligation moves from the fill to KIS's figure, counted once (fix review of 34474f7: never netted by aggregate).
  const reported=value({korea:kr(),us:{...gap,unsettled:{buyKRW:97.66*1341.2,sellKRW:0,krwFundedKRW:0}},fx,inFlight:{buysUSD:0},now});assert.ok(!reported.markets.US.components.some(c=>c.name==='inFlightBuys'));close(reported.combined.low,seen.low);
  // Still held in flight beside a reported total (the tracker could not match them): both count in the low bound.
  close(value({korea:kr(),us:{...gap,unsettled:{buyKRW:97.66*1341.2,sellKRW:0,krwFundedKRW:0}},fx,inFlight:{buysUSD:97.66},now}).combined.low,seen.low-97.66*1341.2);
  // A filled sale not yet in KIS pending proceeds raises the high bound only.
  const sale=value({korea:kr(),us:us(),fx,inFlight:{sellsUSD:279.01},now}).markets.US;close(sale.equity.high-sale.equity.low,279.01);
});
test('a short with its proceeds in cash: the liability comes off, and the proceeds are not gain',()=>{
  const k={timestamp:ts,cash:150000,settledCash:150000,reportedTotal:95000,holdings:[],shorts:[{symbol:'005930',quantity:1,price:55000,proceeds:60000}],shortProceeds:60000,netAssets:95000,grossTotal:150000};
  const v=value({korea:k,us:null,fx,now});close(v.markets.KR.equity.low,95000,'KIS net assets, not 150,000');close(v.markets.KR.equity.high,155000,'or proceeds counted apart from cash: unconfirmed (U4)');assert.equal(v.markets.KR.exact,false,'unverified until Stage 3');assert.equal(v.markets.KR.complete,false);
  assert.equal(v.markets.KR.credit.shortLiability,55000);assert.match(v.markets.KR.reasons.join(' '),/Stage 3/);
  const none=value({korea:{...k,netAssets:null},us:null,fx,now}).markets.KR;assert.equal(none.complete,false);assert.match(none.reasons.join(' '),/net assets were not reported/);
});
test('a margin long: net assets already deduct the loan, so it is not deducted twice',()=>{
  const k={timestamp:ts,cash:100000,settledCash:100000,reportedTotal:250000,holdings:[{symbol:'005930',quantity:3,price:100000,loans:[{quantity:2,amount:150000}]}],loanTotal:150000,netAssets:250000,grossTotal:400000};
  const v=value({korea:k,us:null,fx,now}).markets.KR;close(v.equity.low,250000);close(v.credit.computedNet,250000,'the app sum agrees');assert.equal(v.components.filter(c=>c.name!=='usBuyFunding').length,1,'one figure, not loan deducted again');
});
test('missing FX, a missing market and stale balances give a partial value that says so',()=>{
  const noFx=value({korea:kr(),us:us(),fx:null,now}).combined;assert.deepEqual(noFx.scope,['KR']);assert.equal(noFx.complete,false);assert.match(noFx.reasons.join(' '),/no USD\/KRW rate/);close(noFx.low,705451,'Korea only, never called complete');
  const empty=value({korea:kr(),us:us({cash:0,holdings:[],reportedTotal:0}),fx:null,now}).combined;assert.deepEqual(empty.scope,['KR','US'],'an empty U.S. account needs no rate');
  const noUS=value({korea:kr(),us:null,fx,now}).combined;assert.equal(noUS.complete,false);assert.match(noUS.reasons.join(' '),/U\.S\. balance not loaded/);
  const old=value({korea:kr({timestamp:new Date(now-STALE_MS-60000).toISOString()}),us:us(),fx,now}).combined;assert.equal(old.stale,true);assert.match(old.reasons.join(' '),/minutes old/);
  const noSettled=value({korea:kr({settledCash:null}),us:us(),fx,now});assert.equal(noSettled.combined.complete,false);assert.match(noSettled.markets.KR.reasons[0],/not netted/);
  assert.equal(value({korea:null,us:null,fx,now}).combined.low,null);
});
test('invariants over random accounts: low never above high, flows move both bounds equally, quantities conserved',()=>{
  let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  for(let i=0;i<300;i++){
    const A=Math.round(rnd()*300000),C=Math.round(A*rnd());const k=kr({cash:Math.round(rnd()*1e6),settledCash:Math.round(rnd()*1e6),holdings:[{symbol:'005930',quantity:Math.ceil(rnd()*10),price:Math.round(rnd()*1e5)}]});
    const u=us({cash:Math.round(rnd()*1e5)/100,pendingSaleProceeds:rnd()<0.3?Math.round(rnd()*3e4)/100:0,unsettled:{buyKRW:A,sellKRW:0,krwFundedKRW:C}});const f={usdKRW:1200+rnd()*300};const inFlight={buysUSD:rnd()<0.3?Math.round(rnd()*3e4)/100:0,sellsUSD:0};
    const v=value({korea:k,us:u,fx:f,inFlight,now}).combined;assert.ok(v.low<=v.high+1e-6,`case ${i}`);
    const d=Math.round((rnd()-0.5)*1e6);const w=value({korea:{...k,settledCash:k.settledCash+d},us:u,fx:f,inFlight,now}).combined;close(w.low-v.low,d);close(w.high-v.high,d);
    const longs=value({korea:k,us:u,fx:f,inFlight,now}).markets.KR.components.find(c=>c.name==='long').amount;close(longs,k.holdings[0].quantity*k.holdings[0].price);
  }
});
test('the Korean value is bridged to the KIS total part by part, and a cash basis difference is reported',()=>{
  const raw={tot_evlu_amt:705451+300,scts_evlu_amt:297800+300,prvs_rcdl_excc_amt:407651,dnca_tot_amt:407651};
  const b=value({korea:kr({raw}),us:us({unsettled:{buyKRW:20000,sellKRW:0,krwFundedKRW:20000}}),fx,now}).markets.KR.broker.bridge;
  assert.equal(b.brokerTotal,705751);assert.equal(b.items.find(i=>i.name==='prices').amount,-300,'live prices 300 below the broker price');assert.equal(b.items.find(i=>i.name==='cashBasis').amount,0);assert.equal(b.explained,true);
  assert.equal(b.items.find(i=>i.name==='usBuyFunding').amount,-20000);
  const odd=value({korea:kr({raw:{...raw,tot_evlu_amt:raw.tot_evlu_amt+5000}}),us:us(),fx,now}).markets.KR.broker.bridge;assert.equal(odd.explained,false);assert.equal(odd.items.find(i=>i.name==='cashBasis').amount,-5000);
  assert.equal(value({korea:kr(),us:us(),fx,now}).markets.KR.broker.bridge,null,'no broker figures, no bridge');
});
test('U.S. fills in flight are decided by evidence: the RDDT gap, cash already moved, partial fills, KIS reports',()=>{
  const {InFlight,MAX_DAYS}=require('../electron/valuation.cjs');const {DatabaseSync}=require('node:sqlite');let t=Date.parse('2026-10-30T14:00:00Z');
  const fresh=()=>new InFlight(new DatabaseSync(':memory:'),()=>t);const buy=(filled=1,id='R1')=>({id,side:'Buy',filled,fillPrice:97.42,resultCosts:{netCash:-97.66*filled}});
  // 2026-10-30: proceeds pending at $279.85, the buy fills, nothing moves until settlement.
  let f=fresh();assert.match(f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[],fx:1335}).notes[0],/starts/);
  t+=3600000;assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335}).buysUSD,97.66,'in flight');
  t+=3600000;assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335}).buysUSD,97.66,'still nothing in any KIS figure');
  t+=86400000;assert.equal(f.observe('a',{us:{cash:182.19,pendingSaleProceeds:0},orders:[buy()],fx:1335}).buysUSD,0,'settled: cash plus proceeds fell by it');
  // KIS reports it awaiting settlement: no longer in flight, and not again when that report clears.
  f=fresh();f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[],fx:1335});f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335});
  assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85,unsettled:{buyKRW:97.66*1335,sellKRW:0}},orders:[buy()],fx:1335}).buysUSD,0);
  assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335}).buysUSD,0,'the same fill is not opened again');
  // USD paid at once: cash already fell by the fill at the first reading after it.
  f=fresh();f.observe('a',{us:{cash:300},orders:[],fx:1335});assert.equal(f.observe('a',{us:{cash:202.34},orders:[buy()],fx:1335}).buysUSD,0);
  // A partial fill opens its part, and the rest when it fills.
  f=fresh();f.observe('a',{us:{cash:0,pendingSaleProceeds:500},orders:[],fx:1335});const two=n=>({id:'P',side:'Buy',filled:n,fillPrice:100});
  assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:500},orders:[{...two(1),filled:1}],fx:1335}).buysUSD,100);assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:500},orders:[two(2)],fx:1335}).buysUSD,200);
  // A sale filled but not yet in pending proceeds; then KIS shows the proceeds.
  f=fresh();f.observe('a',{us:{cash:10},orders:[],fx:1335});assert.equal(f.observe('a',{us:{cash:10},orders:[{id:'S',side:'Sell',filled:1,fillPrice:279.6,resultCosts:{netCash:279.01}}],fx:1335}).sellsUSD,279.01);
  assert.equal(f.observe('a',{us:{cash:10,pendingSaleProceeds:279.01},orders:[{id:'S',side:'Sell',filled:1,fillPrice:279.6,resultCosts:{netCash:279.01}}],fx:1335}).sellsUSD,0);
  // At the first reading every fill stays in flight, awaiting verification, however old (bootstrap B1, stage 2b S1; the
  // five-day history rule of a7d075a is gone). A fill with no signal for MAX_DAYS is overdue, not dropped.
  const old={...buy(),createdAt:t-10*86400000};f=fresh();const o1=f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[old],fx:1335});assert.equal(o1.buysUSD,97.66,'ten days old: still awaiting verification');assert.equal(o1.open[0].unresolved.why,'awaiting verification');assert.equal(o1.pretracking.count,1);
  f=fresh();const first=f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[{...buy(),createdAt:t-3600000}],fx:1335});assert.equal(first.buysUSD,97.66);assert.equal(first.unresolved.buysUSD,97.66);
  f=fresh();f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[],fx:1335});f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335});
  t+=(MAX_DAYS+1)*86400000;const late=f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335});assert.equal(late.buysUSD,97.66,'still owed');assert.equal(late.overdue.buysUSD,97.66);assert.match(late.notes[0],/no settlement evidence after 7 days/);
  assert.equal(f.observe('a',{us:{cash:0,pendingSaleProceeds:279.85},orders:[buy()],fx:1335}).notes.length,0,'noted once');
});
