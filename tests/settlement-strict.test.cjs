// Stage 2b step 1: bootstrap B1, strict uniqueness (A5) and exact amounts in the U.S. settlement tracker
// (artifacts/reviews/2026-11-05-accounting/stage2b-spec.md S1-S4; design tests T1, T11, T12, T14-T18, T45).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value,BOUND}=require('../electron/valuation.cjs');
const MIN=60000,DAY=86400000;
// The tracker, reading by reading a minute apart, at the given rate.
function tracker(fx=1300){let t=Date.parse('2026-11-05T14:00:00Z');const db=new DatabaseSync(':memory:');let f=new InFlight(db,()=>t);
  return {see:(us,orders=[])=>{const r=f.observe('a',{us:{timestamp:new Date(t).toISOString(),...us},orders,fx});t+=MIN;return r;},
    later:ms=>{t+=ms;},ledger:()=>f.evidence,restart:()=>{f=new InFlight(db,()=>t);},evidence:()=>JSON.parse(db.prepare('SELECT payload FROM inflight_settlement').get().payload).evidence,now:()=>t};}
const buy=(id,usd,extra={})=>({id,side:'Buy',filled:1,fillPrice:usd,...extra}),sell=(id,usd)=>({id,side:'Sell',filled:1,fillPrice:usd});
const R=(usd,fx=1300)=>({buyKRW:Math.round(usd*fx),sellKRW:0});

test('T1: four pre-tracking buys and one sale, none verified: buys in the low bound, the sale in the high bound only; provisional, never exact',()=>{
  const x=tracker();const orders=[buy('G',323.64,{createdAt:Date.parse('2026-10-23T15:00:00Z')}),buy('N',212.73),buy('P',150),buy('R',97.66),sell('S',279.01)];
  const us={cash:500,pendingSaleProceeds:0,holdings:[{symbol:'NASD:X',quantity:1,price:1000}]};const r=x.see(us,orders);
  assert.equal(r.open.length,5);assert.ok(r.open.every(f=>f.pretracking&&f.unresolved.why==='awaiting verification'),'no age, order time or K record makes history');
  assert.deepEqual(r.pretracking,{count:5,buysUSD:784.03,sellsUSD:279.01});
  const v=value({us:{...us,timestamp:new Date(x.now()).toISOString()},fx:{usdKRW:1300},inFlight:r,now:x.now()}).markets.US;
  assert.equal(v.equity.low,1500-784.03,'the four buys lower the low bound');assert.equal(v.equity.high,1500+279.01,'the sale raises only the high bound');
  assert.equal(v.exact,false);assert.ok(v.reasons.includes('5 pre-tracking U.S. fills awaiting verification: the value is provisional'));
  // S1a: the first reading never settles by age (bootstrap B1); ten days later, after a restart, every one of them is
  // settled by age, buys and the sale alike, and the value is exact again.
  x.later(10*DAY);x.restart();const again=x.see(us,orders);assert.equal(again.buysUSD,0);assert.equal(again.sellsUSD,0);assert.equal(again.notes.filter(n=>/settled by age/.test(n)).length,5);
});
test('T11: a $95 cash fall against a $100 obligation allocates $95; $5 stays until the order\'s own amount is corrected to $95',()=>{
  const x=tracker();x.see({cash:500});const a=buy('A',100,{resultCosts:{netCash:-100}});x.see({cash:500},[a]);
  const r=x.see({cash:405},[a]);assert.equal(r.buysUSD,5);assert.deepEqual([r.open[0].unresolved.why,r.open[0].unresolved.shortUSD],['evidence short',5]);
  const e=x.evidence().at(-1);assert.deepEqual(e.allocated,[{id:'A',pid:'A#1',usd:95}]);assert.equal(e.kind,'settled');
  // KIS finalises the fees: the order's amount becomes $95, and the remainder closes by that correction, not by write-off.
  assert.equal(x.see({cash:405},[{...a,resultCosts:{netCash:-95}}]).buysUSD,0);
});
// Release gate H1 (1.5.50): a remainder within the fee bound (the larger of $1.00 and 0.5% of the fill) is the app's fee
// estimate against what KIS charged: it closes with its evidence, the difference recorded. A larger one stays open.
test('T12 (H1): a $0.40 remainder is within the fee bound and settles with its evidence; a $5 shortfall stays open and settles by age after 3 U.S. business days',()=>{
  const y=tracker();y.see({cash:500});const b=buy('B',100);y.see({cash:500},[b]);const s=y.see({cash:400.4},[b]);assert.equal(s.buysUSD,0);assert.ok(s.notes.some(n=>/\$0\.40 difference is within the fee bound/.test(n)));
  const ev=y.ledger().events('a').filter(e=>e.kind==='piece-closed');assert.deepEqual(ev.map(e=>[e.why,e.feeUSD]),[['evidence',0.4]]);
  const x=tracker();x.see({cash:500});const a=buy('A',100);x.see({cash:500},[a]);assert.equal(x.see({cash:405},[a]).buysUSD,5,'beyond the bound: stays open');
  // Opened Thu 2026-11-05 (New York): Fri 6, Mon 9 and Tue 10 are its business days; Sat and Sun do not count.
  const left=[];for(let i=0;i<8;i++){x.later(DAY);left.push(x.see({cash:405},[a]).buysUSD);}
  assert.deepEqual(left,[5,5,5,5,0,0,0,0]);const r=x.see({cash:405},[a]);assert.equal(r.overdue.buysUSD,0,'nothing is overdue any more');
});
test('T14 (H1): KRW evidence is converted at the reading\'s rate, the KRW and rate recorded; the $0.20 difference is within the fee bound and recorded on the close',()=>{
  const x=tracker(1306.5);x.see({cash:500});const a=buy('A',100.2);x.see({cash:500},[a]);
  const r=x.see({cash:500,unsettled:{buyKRW:130650,sellKRW:0}},[a]);assert.equal(r.buysUSD,0);assert.equal(r.open.length,0);assert.deepEqual(x.ledger().events('a').filter(e=>e.kind==='piece-closed').map(e=>e.feeUSD),[0.2]);
  const e=x.evidence().at(-1);assert.deepEqual([e.channel,e.amount,e.krw,e.rate,e.allocated],['reported',100,130650,1306.5,[{id:'A',pid:'A#1',usd:100}]]);
});
test('T15: two $100 fills and one $100 movement: nothing applied, both unresolved, the candidates recorded; a $100 and a $150 fill: unique',()=>{
  let x=tracker();x.see({cash:500});const A=buy('A',100),B=buy('B',100);x.see({cash:500},[A,B]);
  const r=x.see({cash:400},[A,B]);assert.equal(r.buysUSD,200);assert.equal(r.unresolved.buysUSD,200);assert.ok(r.open.every(f=>f.unresolved.why==='ambiguous evidence'));
  const e=x.evidence().at(-1);assert.equal(e.kind,'ambiguous fit');assert.deepEqual(e.ambiguousCandidates,[['A'],['B']]);assert.deepEqual(e.allocated,[]);
  // The same through the reported total.
  x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);assert.equal(x.see({cash:500,unsettled:R(100)},[A,B]).buysUSD,200);
  // $100 and $150: only {A} fits $100.
  x=tracker();x.see({cash:500});const C=buy('C',150);x.see({cash:500},[A,C]);assert.equal(x.see({cash:400},[A,C]).buysUSD,150);
  // A new fill reflected at once is no exception: an open $100 fill makes the new one's $100 ambiguous too.
  x=tracker();x.see({cash:500});x.see({cash:500},[A]);assert.equal(x.see({cash:400},[A,B]).buysUSD,200);
});
test('T16: a split $330 resolves {230, 100} only when it is the unique fitting set',()=>{
  // Both were reported before tracking ($330 awaiting settlement at the first reading); then KIS settles them: the
  // reported total falls by $330 and U.S. cash by the USD-paid $100.
  let x=tracker();const K=buy('K',230),U=buy('U',100);const first=x.see({cash:500,unsettled:R(330)},[K,U]);assert.ok(first.open.every(f=>f.unresolved.why==='reported before seen'));
  assert.equal(x.see({cash:400,unsettled:R(0)},[K,U]).buysUSD,0,'{230, 100} is the only set that fits $330');
  // With a third flagged $330 fill also open, {330} fits as well: nothing resolves.
  x=tracker();const T=buy('T',330);x.see({cash:500,unsettled:R(330)},[K,U,T]);const r=x.see({cash:400,unsettled:R(0)},[K,U,T]);assert.equal(r.buysUSD,660);
});
test('T17: evidence before the order history: a reported rise resolves by a unique reported fall; a cash fall only by reconciliation',()=>{
  let x=tracker();const A=buy('A',100);x.see({cash:500});x.see({cash:500,unsettled:R(100)});const flagged=x.see({cash:500,unsettled:R(100)},[A]);
  assert.equal(flagged.open[0].unresolved.why,'reported before seen');assert.equal(x.see({cash:400,unsettled:R(0)},[A]).buysUSD,0,'A4: the unique reported fall');
  x=tracker();x.see({cash:500});x.see({cash:400});const paid=x.see({cash:400},[A]);assert.equal(paid.open[0].unresolved.why,'paid before seen');
  // Neither a reported rise nor a later cash fall of its amount clears it.
  assert.equal(x.see({cash:400,unsettled:R(100)},[A]).buysUSD,100);assert.equal(x.see({cash:300,unsettled:R(100)},[A]).buysUSD,100);assert.equal(x.see({cash:200,unsettled:R(0)},[A]).buysUSD,100);
});
test('T18: a reported fall plus a cash fall equal to an unflagged fill does not resolve it (netting waits for A1 or a reconciliation)',()=>{
  const x=tracker();const A=buy('A',100);x.see({cash:500,unsettled:R(100)});x.see({cash:500,unsettled:R(100)},[A]);
  const r=x.see({cash:400,unsettled:R(0)},[A]);assert.equal(r.buysUSD,100);assert.equal(x.evidence().at(-1).kind,'reported settlement');assert.deepEqual(x.evidence().at(-1).allocated,[]);
});
test('T45: more than 12 open candidate pieces on one side: nothing applied to any; with 12, ordinary strict matching',()=>{
  const big=n=>Array.from({length:n},(_,i)=>buy('Z'+i,5000+137*i));const A=buy('A',1000);
  let x=tracker();x.see({cash:200000});const twelve=[A,...big(BOUND-1)];x.see({cash:200000},twelve);assert.equal(BOUND,12);
  assert.equal(x.see({cash:199000},twelve).open.some(f=>f.id==='A'),false,'12: {A} is the unique fit');
  x=tracker();x.see({cash:200000});const thirteen=[A,...big(BOUND)];x.see({cash:200000},thirteen);const r=x.see({cash:199000},thirteen);
  assert.ok(r.open.some(f=>f.id==='A'),'13: nothing applied');assert.equal(r.open.length,13);const e=x.evidence().at(-1);assert.equal(e.overBound,13);assert.deepEqual(e.allocated,[]);
  assert.ok(r.open.every(f=>f.unresolved?.why==='ambiguous evidence'),'the whole set stays uncertain, not just the first 12');
});
// Review of 2d297f9 (P1 ×2; artifacts/reviews/stage2b1-independent-repro.cjs): a cash movement while buys and sales are
// both in flight is never divided, the new ones included.
test('review 2b.1: an exact net match of new buys and sales is not a unique allocation; it stays unresolved',()=>{
  // An older $50 buy is open; a new $100 buy and $50 sale arrive with a $50 cash fall: the older buy alone fits, and so
  // does the new pair.
  let x=tracker();x.see({cash:500});const old=buy('old',50);x.see({cash:500},[old]);
  let r=x.see({cash:450},[old,buy('nb',100),sell('ns',50)]);assert.deepEqual([r.buysUSD,r.sellsUSD],[150,50]);assert.ok(!x.evidence().some(e=>e.kind==='reflected at once'),'nothing reflected at once');
  // With no older fill open the exact net is still no allocation: buys and sales net, and cannot be divided.
  x=tracker();x.see({cash:500});r=x.see({cash:450},[buy('nb',100),sell('ns',50)]);assert.deepEqual([r.buysUSD,r.sellsUSD],[100,50]);
});
test('review 2b.1: a movement the new buys and sales do not match is not allocated to one side',()=>{
  let x=tracker();x.see({cash:500});let r=x.see({cash:405},[buy('b',100),sell('s',50)]);assert.deepEqual([r.buysUSD,r.sellsUSD],[100,50],'not $95 to the buy');
  assert.equal(x.evidence().length,0,'no allocation recorded');
  // An older open sale and a new buy: both sides are in flight, so a fall of the new buy's own $100 is not allocated
  // either, at once or later.
  x=tracker();x.see({cash:500});x.see({cash:500},[sell('s',50)]);r=x.see({cash:400},[sell('s',50),buy('b',100)]);assert.deepEqual([r.buysUSD,r.sellsUSD],[100,50]);
  r=x.see({cash:300},[sell('s',50),buy('b',100)]);assert.deepEqual([r.buysUSD,r.sellsUSD],[100,50],'a later fall while both are open: still not divided');
  // One side only: ordinary strict matching (the same new buy, no sale in flight).
  x=tracker();x.see({cash:500});assert.equal(x.see({cash:400},[buy('b',100)]).buysUSD,0,'reflected at once');
});
