// M-1.6a (artifacts/reviews/2026-11-16-multi-order/m1/m1-6-design.md, condition R1): the reported amount no tracked buy
// explains (provisional) is split as KIS pays: from U.S. money first, KRW for the shortfall, less the U.S. buys InFlight
// still holds as possibly reported. The combined value counts it once. Before: all of it on the Korean side, which made a
// false U.S. gain whenever U.S. money paid it (9-12 U.S. buys reported together; your own U.S. buy placed in KIS).
const test=require('node:test');const assert=require('node:assert/strict');
const {fundingSplit,splitContext,value,marketValue}=require('../electron/valuation.cjs');
const RATE=1340;

test('the split: U.S. money first, the shortfall Korean; without a rate or U.S. money, as before; always summing to the total',()=>{
  const total=268000,f={provisionalKRW:268000,krwKRW:0,usReportedKRW:0},cases=[
    ['no context (as before)',null,{krLow:268000,usLowKRW:0}],
    ['U.S. money covers it',{rate:RATE,usMoneyUSD:2000,reportedInFlightUSD:0},{krLow:0,usLowKRW:268000}],
    ['U.S. money covers half',{rate:RATE,usMoneyUSD:100,reportedInFlightUSD:0},{krLow:134000,usLowKRW:134000}],
    ['no U.S. money (KRW-paid, as before)',{rate:RATE,usMoneyUSD:0,reportedInFlightUSD:0},{krLow:268000,usLowKRW:0}],
    ['negative money counts as none',{rate:RATE,usMoneyUSD:-50,reportedInFlightUSD:0},{krLow:268000,usLowKRW:0}],
    ['the in-flight buys already carry it',{rate:RATE,usMoneyUSD:1740,reportedInFlightUSD:200},{krLow:268000,usLowKRW:0}],
    ['in flight carries part',{rate:RATE,usMoneyUSD:1740,reportedInFlightUSD:50},{krLow:67000,usLowKRW:201000}],
    ['the 13-together report: in flight carries all of it',{rate:RATE,usMoneyUSD:2000-200,reportedInFlightUSD:200},{krLow:268000,usLowKRW:0}],
    ['F1: in flight first, then money pays the rest ($250 cash, $100 flagged in flight, P $200)',{rate:RATE,usMoneyUSD:150,reportedInFlightUSD:100},{krLow:134000,usLowKRW:134000}],
    ['money short of the rest after in flight',{rate:RATE,usMoneyUSD:50,reportedInFlightUSD:100},{krLow:201000,usLowKRW:67000}],
    ['no rate',{rate:null,usMoneyUSD:2000,reportedInFlightUSD:0},{krLow:268000,usLowKRW:0}]];
  for(const [name,ctx,want] of cases){const s=fundingSplit(f,total,0,ctx);assert.equal(s.krLow,want.krLow,name+': Korean low');assert.equal(s.usLowKRW,want.usLowKRW,name+': U.S. low');assert.equal(s.krLow+s.usLowKRW,total,name+': counted once');}
  const g={provisionalKRW:100000,krwKRW:50000,usReportedKRW:30000};const s=fundingSplit(g,180000,40000,{rate:RATE,usMoneyUSD:1000,reportedInFlightUSD:0});
  assert.deepEqual([s.krLow,s.usLowKRW],[50000,130000],'the groups keep their places; only the provisional amount moves');assert.equal(s.krHigh,40000,'the Korean high: the confirmed KRW, at most its low');
});
test('the context: U.S. cash and pending proceeds, less buys in flight and U.S. groups; flagged in-flight buys counted apart',()=>{
  const inFlight={buysUSD:300,open:[{side:'Buy',usd:200,unresolved:{why:'reported before seen'}},{side:'Buy',usd:100,unresolved:{why:'ambiguous evidence'}},{side:'Sell',usd:40,unresolved:{why:'reported before seen'}}]};
  const c=splitContext({cash:1000,pendingSaleProceeds:50},inFlight,{usReportedKRW:134000},RATE);
  assert.deepEqual(c,{rate:RATE,usMoneyUSD:1000+50-300-100,reportedInFlightUSD:200});
  assert.equal(splitContext({cash:1000},null,null,null),null,'no rate: no context');
});
// Your own U.S. buy placed in KIS ($100), while U.S. cash ($500) covers it: KIS reports it awaiting settlement, no tracked
// buy explains it (provisional), and it settles from USD the next morning.
const input=()=>{const ts=new Date('2026-11-10T00:00:00Z').toISOString();return {now:Date.parse(ts),fx:{usdKRW:RATE,timestamp:Date.parse(ts),source:'fixture'},
  korea:{accountKey:'a',environment:'live',timestamp:ts,cash:3000000,settledCash:3000000,holdings:[]},
  us:{accountKey:'a:US',environment:'live',timestamp:ts,cash:500,holdings:[{symbol:'NYSE:X',quantity:1,price:100,cost:100}],unsettled:{buyKRW:134000,sellKRW:0,krwFundedKRW:0}},
  inFlight:{buysUSD:0,sellsUSD:0,unresolved:{buysUSD:0,sellsUSD:0},overdue:{buysUSD:0,sellsUSD:0},open:[]},funding:{provisionalKRW:134000,krwKRW:0,usReportedKRW:0,krwUnpaidKRW:0}};};
test('your own U.S. buy in KIS, paid from U.S. cash: owed by the U.S. account, not a U.S. gain; the combined value unchanged',()=>{
  const v=value(input());assert.equal(Math.round(v.markets.US.equity.low*100)/100,500,'U.S.: $500 cash + $100 stock − $100 owed');assert.equal(v.markets.KR.equity.low,3000000,'Korea: nothing taken');
  const before=3000000-134000+600*RATE;assert.equal(Math.round(v.combined.low),before,'combined: the amount counted once, as before');
  const us=marketValue('US',input());assert.equal(Math.round(us.loss.low*100)/100,500,'the U.S. daily-loss value has no false gain');
  const noCash={...input(),us:{...input().us,cash:0}};const k=value(noCash);assert.equal(k.markets.KR.equity.low,2866000,'with no U.S. money it stays Korean, as before');
});
test('F1 end to end: $250 U.S. cash, an app buy of $100 in flight flagged reported, your own $100 buy; KIS reports both ($200)',()=>{
  const x=input();const ts=x.us.timestamp;
  const v=value({...x,us:{...x.us,cash:250,holdings:[{symbol:'NYSE:X',quantity:1,price:100,cost:100},{symbol:'NYSE:Y',quantity:1,price:100,cost:100}],unsettled:{buyKRW:268000,sellKRW:0,krwFundedKRW:0}},
    inFlight:{buysUSD:100,sellsUSD:0,unresolved:{buysUSD:100,sellsUSD:0},overdue:{buysUSD:0,sellsUSD:0},open:[{side:'Buy',usd:100,unresolved:{why:'reported before seen',at:Date.parse(ts)}}]},funding:{provisionalKRW:268000,krwKRW:0,usReportedKRW:0,krwUnpaidKRW:0}});
  assert.equal(Math.round(v.markets.US.equity.low*100)/100,250,'U.S. low: $250 cash + $200 stock − $100 in flight − $100 owed (no false gain of $50)');
  assert.equal(v.markets.KR.equity.low,3000000-134000,'Korea keeps only the in-flight buy\'s share of the report');
  // The combined low as before the change (all of P Korean: 2,732,000 + $350 at the rate): the flagged in-flight buy counts
  // both as its piece and in the report, as unresolved pieces always do in the low bound (valuation.cjs, inFlightBuys).
  assert.equal(Math.round(v.combined.low),3000000-268000+350*RATE,'combined low unchanged by the split');
});
