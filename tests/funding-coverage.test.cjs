// M-1.6c1 (multi-order design, Alt 3): buys still in flight that the tracker flags as possibly reported may join a batch
// group, and an in-flight piece a reported group carries is not deducted again in the value (coverage, capped per group
// at the group's reported KRW). InFlight is unchanged. The end-to-end figures are in tests/loss-funding-e2e.test.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {coveredInFlight,splitContext,reportedOpenIds}=require('../electron/valuation.cjs');const {FundingTransfers}=require('../electron/funding-transfers.cjs');
const RATE=1340,piece=(id,usd,why='reported total moved by an unmatched amount')=>({id,side:'Buy',usd,...(why?{unresolved:{why}}:{})});

test('coverage: a group carries its pieces once, capped at its reported KRW; pieces of no group stay deducted',()=>{
  const inFlight={buysUSD:330,open:[piece('a',100),piece('b',200),piece('c',30),{id:'s',side:'Sell',usd:500}]};
  assert.equal(coveredInFlight(inFlight,{reportedGroups:[{orders:['a','b'],reportedKRW:300*RATE}]},RATE),300,'both pieces of the group');
  assert.equal(Math.round(coveredInFlight(inFlight,{reportedGroups:[{orders:['a','b','c'],reportedKRW:300*RATE}]},RATE)*100)/100,300,'capped: the $30 buy KIS has not reported stays deducted');
  assert.equal(coveredInFlight(inFlight,{reportedGroups:[]},RATE),0);assert.equal(coveredInFlight(inFlight,{reportedGroups:[{orders:['a'],reportedKRW:100*RATE}]},null),0,'no rate: nothing covered');
  assert.equal(coveredInFlight(inFlight,{reportedGroups:[{orders:['s'],reportedKRW:500*RATE}]},RATE),0,'a sale is never covered');
});
test('the split context: covered pieces leave the money and the flagged amount; a flagged piece with no group keeps its double count (unchanged)',()=>{
  const inFlight={buysUSD:300,open:[piece('a',100),piece('b',200)]};
  const none=splitContext({cash:1000},inFlight,{reportedGroups:[]},RATE);assert.deepEqual([none.usMoneyUSD,none.reportedInFlightUSD],[700,300],'no group: as M-1.6a');
  const g=splitContext({cash:1000},inFlight,{reportedGroups:[{orders:['a'],reportedKRW:100*RATE}],usReportedKRW:100*RATE},RATE);
  assert.deepEqual([Math.round(g.usMoneyUSD),g.reportedInFlightUSD],[700,200],'a: covered by its group (whose own U.S. obligation is deducted instead); b: still flagged');
  assert.deepEqual([...reportedOpenIds({open:[piece('a',1),piece('b',1,'ambiguous evidence'),piece('c',1,null),{id:'s',side:'Sell',unresolved:{why:'reported before seen'}}]})],['a'],'only flagged buys');
});
const T0=Date.parse('2026-11-09T23:40:00+09:00'),H=3600000;
const id=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),buy=(i,u)=>({id:id(i),market:'US',symbol:'NYSE:X'+i,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:u,resultCosts:{netCash:-u},createdAt:T0+i*1000,filledObservedAt:T0+i*1000});
function recorder(){const db=new DatabaseSync(':memory:');let t=T0-H;const rec=new FundingTransfers(db,{clock:()=>t});
  const read=(x)=>{t=x.at;return rec.observeUS('a',{us:{accountKey:'a:US',environment:'live',timestamp:new Date(t).toISOString(),cash:x.cash,unsettled:{buyKRW:x.R,sellKRW:0}},orders:x.orders,fx:RATE,openOrderIds:new Set(x.open??[]),openBuysUSD:x.openUSD??0,reportedOpenIds:new Set(x.flagged??[])});};
  read({cash:x0,R:0,orders:[],at:T0-H});return {rec,read};}
let x0=2000;
test('the recorder: flagged in-flight buys join a batch, never a unique set; their own USD does not count against U.S. money',()=>{
  const o=Array.from({length:13},(_,i)=>buy(i,10+i)),ids=o.map(x=>x.id),T=o.reduce((n,x)=>n+x.fillPrice,0),R=Math.round(T*RATE);
  x0=150;let w=recorder();w.read({cash:150,R:0,orders:o,at:T0+H,open:ids,openUSD:T});w.read({cash:150,R,orders:o,at:T0+10*H,open:ids,openUSD:T,flagged:ids});
  let g=w.rec.current('a').reportedGroups;assert.equal(g.length,1);assert.equal(g[0].orders.length,13);
  // K1 step (m1/k1-design.md): $150 of U.S. cash pays $150 of the $208 batch, USD first (its own in-flight USD is not
  // another claim; counted, it would read as all KRW); only the rest is KRW, booked as the pair.
  {const c=w.rec.current('a');assert.equal(g[0].state,'krw');assert.equal(c.usUSD,150,'the U.S. part');assert.equal(c.krwKRW,R-150*RATE,'the KRW part, KIS\'s KRW less the U.S. part at the rate');}
  x0=600;w=recorder();w.read({cash:600,R:0,orders:o,at:T0+H,open:ids,openUSD:T});w.read({cash:600,R,orders:o,at:T0+10*H,open:ids,openUSD:T});
  assert.equal(w.rec.current('a').reportedGroups.length,0,'not flagged: in-flight buys are not candidates (as before)');
  x0=2000;w=recorder();const three=o.slice(0,3);w.read({cash:2000,R:0,orders:three,at:T0+H,open:three.map(x=>x.id),openUSD:33});w.read({cash:2000,R:Math.round(33*RATE),orders:three,at:T0+10*H,open:three.map(x=>x.id),openUSD:33,flagged:three.map(x=>x.id)});
  assert.equal(w.rec.current('a').reportedGroups[0]?.orders.length,3);assert.equal(w.rec.rows('a').find(r=>r.state==='us')?.via,'batch','a unique set never takes in-flight buys; they joined through the batch path');
});
