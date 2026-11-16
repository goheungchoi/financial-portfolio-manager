// M-1.6c2 (multi-order, artifacts/reviews/2026-11-16-multi-order/m1/m1-6c-design.md R3, R4; m1-6c1-report.md C1-C3):
// a batch of U.S. buys or sales over the tracker's bound (BOUND 12) settling. The tracker alone, reading by reading:
// the zero-report rule (R3) and its marks (C1, C2), the paired credit (R4), the groups KIS settled through the KRW route,
// and the sale rule (C3). End to end figures are in loss-funding-e2e.test.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight}=require('../electron/valuation.cjs');
const MIN=60000,FX=1340;
function tracker(){let t=Date.parse('2026-11-09T14:00:00Z');const db=new DatabaseSync(':memory:');const f=new InFlight(db,()=>t);
  return {see:(us,orders=[],krwGroups=null)=>{const r=f.observe('a',{us:{timestamp:new Date(t).toISOString(),...us},orders,fx:FX,krwGroups});t+=MIN;return r;},
    state:()=>JSON.parse(db.prepare('SELECT payload FROM inflight_settlement').get().payload).a??JSON.parse(db.prepare('SELECT payload FROM inflight_settlement').get().payload),
    events:kind=>f.evidence.events('a').filter(e=>!kind||e.kind===kind),explained:()=>f.explained('a',{since:0}).usd};}
const U=(buyKRW,sellKRW=0)=>({unsettled:{buyKRW,sellKRW}});
// n buys of $10, $11, ... (13 buys: $208; 25: $550), filled together.
const batch=(n,side='Buy')=>Array.from({length:n},(_,i)=>({id:(side==='Buy'?'B':'S')+i,side,filled:1,fillPrice:10+i}));
const total=o=>o.reduce((n,x)=>n+x.fillPrice,0);
// Filled, then KIS reports them together: the 13 are flagged (the reported rise fits no unique set over the bound).
function reported(n=13,cash=2000){const x=tracker(),o=batch(n),T=total(o);x.see({cash,...U(0)});x.see({cash,...U(0)},o);const r=x.see({cash,...U(Math.round(T*FX))},o);
  assert.ok(r.open.every(p=>p.unresolved?.why==='reported total moved by an unmatched amount'),'flagged');return {x,o,T,cash};}
const credit=x=>InFlight.creditCents(x.state(),'Buy')/100;
const zeroMarks=x=>x.events('flag').filter(e=>e.why==='zero-report').length;

test('R3: a 0 KIS returned, after a positive total, in an accepted reading: every flagged buy closes against the cash that paid it',()=>{
  for(const n of [13,25]){const {x,o,T,cash}=reported(n);const r=x.see({cash:cash-T,...U(0)},o);
    assert.equal(r.buysUSD,0,`${n}: nothing left in flight`);assert.equal(r.open.length,0);
    assert.equal(x.events('piece-closed').filter(e=>e.why==='zero-report').length,n,`${n}: each closed by the zero-report rule`);}
});
test('R3: no zero without KIS\'s unsettled block, in a held or provisional reading, at the first reading, or after a 0',()=>{
  // The block missing: no zero, and no credit either (an absent field is not a fall).
  let {x,o,T,cash}=reported();let r=x.see({cash:cash-T},o);assert.equal(zeroMarks(x),0,'block missing');assert.equal(r.open.length,13);assert.equal(credit(x),0,'no credit without the block');
  for(const flag of ['settlementHeld','settlementProvisional']){({x,o,T,cash}=reported());r=x.see({cash:cash-T,...U(0),[flag]:true},o);assert.equal(zeroMarks(x),0,flag);assert.equal(r.open.length,13,flag);}
  // A 0 at the first reading: nothing was reported before, so nothing has fallen to it.
  x=tracker();o=batch(13);r=x.see({cash:2000,...U(0)},o);assert.equal(zeroMarks(x),0,'0 at the first reading');
  // 0 after 0: the second 0 adds no mark.
  ({x,o,T,cash}=reported());x.see({cash,...U(0)},o);assert.equal(zeroMarks(x),13);x.see({cash,...U(0)},o);assert.equal(zeroMarks(x),13,'0 after 0 marks nothing new');
});
test('R3: flagged buys worth more than KIS reported cannot all be in the total that fell to 0: no marks (T16 at batch size)',()=>{
  // 13 buys ($208) filled; KIS reports only $100 of them, then 0.
  const x=tracker(),o=batch(13);x.see({cash:2000,...U(0)});x.see({cash:2000,...U(0)},o);x.see({cash:2000,...U(100*FX)},o);
  const r=x.see({cash:1900,...U(0)},o);assert.equal(zeroMarks(x),0);assert.ok(r.buysUSD>=208-100-0.01,'at most the $100 paid leaves in flight');
});
test('C1: a marked buy closes against a group whose KRW Korea carries, with no U.S. cash; with no such group it waits',()=>{
  const ids=batch(13).map(b=>b.id);
  // A K1 group (krw) known at the zero reading: all close, no cash moved.
  let {x,o,cash}=reported();let r=x.see({cash,...U(0)},o,[{key:'g',orders:ids,state:'krw',settled:false}]);assert.equal(r.buysUSD,0,'closed against the group');
  assert.ok(x.events('piece-closed').every(e=>e.zeroClose?.group==='g'));
  // No group and no cash: marked, still in flight.
  ({x,o,cash}=reported());r=x.see({cash,...U(0)},o);assert.equal(r.open.length,13);assert.equal(zeroMarks(x),13);
  // The group known a reading late (InFlight observes before the recorder): the marked buys close then.
  r=x.see({cash,...U(0)},o,[{key:'g',orders:ids,state:'booked',settled:true}]);assert.equal(r.buysUSD,0,'closed a reading later');
  // awaiting-krw: its shortfall is deducted nowhere before the exchange, so the buys do not close against it.
  ({x,o,cash}=reported());r=x.see({cash,...U(0)},o,[{key:'g',orders:ids,state:'awaiting-krw',settled:false}]);assert.equal(r.open.length,13,'not against awaiting-krw');
});
test('C2: the zero in reading n, KIS\'s debit in n + 1 closes the marked buys; a withdrawal between them does not',()=>{
  let {x,o,T,cash}=reported();x.see({cash,...U(0)},o);let r=x.see({cash:cash-T,...U(0)},o);assert.equal(r.buysUSD,0,'closed at n + 1, not at age');
  // $300 withdrawn between: it fits nothing marked, so it pays nothing; the debit then closes them.
  ({x,o,T,cash}=reported());x.see({cash,...U(0)},o);r=x.see({cash:cash-300,...U(0)},o);assert.equal(r.open.length,13,'the withdrawal pays no buy');
  r=x.see({cash:cash-300-T,...U(0)},o);assert.equal(r.buysUSD,0,'the debit closes them');
  // A part of the batch's amount (not a fit) pays nothing either.
  ({x,o,T,cash}=reported());x.see({cash,...U(0)},o);r=x.see({cash:cash-100,...U(0)},o);assert.equal(r.open.length,13);
});
test('R4: the paired credit: given when cash and the report agree, or U.S. cash ran out (the USD part); otherwise none',()=>{
  const o=batch(13),half=o.filter((_,i)=>i%2===0),H=total(half),T=total(o);
  // Agree: half settles, U.S. cash falls by its amount; credit H.
  let {x,cash}=reported();x.see({cash:cash-H,...U(Math.round((T-H)*FX))},o);assert.equal(credit(x),H,'agree');
  // Mixed funding: U.S. cash $40 runs out paying part of the half (KIS takes KRW for the rest): credit 40.
  ({x}=reported(13,40));x.see({cash:0,...U(Math.round((T-H)*FX))},o);assert.equal(credit(x),40,'cash exhausted: the USD part');
  // A withdrawal in the same reading as a KRW-paid settlement: they disagree and cash is not exhausted: none.
  ({x,cash}=reported());x.see({cash:cash-300,...U(Math.round((T-H)*FX))},o);assert.equal(credit(x),0,'withdrawal and KRW settlement');
  // A cash fall alone: none.
  ({x,cash}=reported());x.see({cash:cash-H,...U(Math.round(T*FX))},o);assert.equal(credit(x),0,'cash fall alone');
});
test('R4: the credit is used as the batch closes, and trimmed when the pieces it stood for close by other evidence',()=>{
  const o=batch(13),half=o.filter((_,i)=>i%2===0),H=total(half),T=total(o);
  // Agree on half, then the rest settles with KIS's zero: the credit pays the first half; nothing is left.
  let {x,cash}=reported();x.see({cash:cash-H,...U(Math.round((T-H)*FX))},o);let r=x.see({cash:cash-T,...U(0)},o);assert.equal(r.buysUSD,0);assert.equal(credit(x),0,'used');
  assert.ok(r.open.length===0);
  // The credit's pieces close against a settled KRW group instead: the group's USD part is what the credit stood for.
  ({x,cash}=reported(13,40));x.see({cash:0,...U(Math.round((T-H)*FX))},o);assert.equal(credit(x),40);
  r=x.see({cash:0,...U(Math.round((T-H)*FX))},o,[{key:'g',orders:half.map(b=>b.id),state:'booked',settled:true,paidUSD:40}]);
  assert.equal(credit(x),0,'used by the group close, so it cannot lower the other half');assert.equal(r.open.length,13-half.length);
  // The pieces close by other evidence that uses no credit (a settled group with no USD part): the credit ($112) is
  // then above the open half ($96) and is trimmed to it, never above the open unresolved buys.
  ({x,cash}=reported());x.see({cash:cash-H,...U(Math.round((T-H)*FX))},o);assert.equal(credit(x),H);
  r=x.see({cash:cash-H,...U(Math.round((T-H)*FX))},o,[{key:'g',orders:half.map(b=>b.id),state:'awaiting-kr',settled:true,paidUSD:0}]);
  assert.equal(r.open.length,13-half.length);assert.equal(credit(x),T-H,'trimmed to the open buys');
  assert.ok(x.events('credit-trimmed').length>=1);
});
test('C1 outside a zero: the flagged buys of a group KIS settled through the KRW route close against it',()=>{
  const o=batch(13),half=o.filter((_,i)=>i%2===0),T=total(o),H=total(half);
  const {x,cash}=reported(13,0);
  // KIS settles half from KRW (its report falls, U.S. cash does not move); the recorder books the group; InFlight learns it
  // a reading later.
  x.see({cash,...U(Math.round((T-H)*FX))},o);const r=x.see({cash,...U(Math.round((T-H)*FX))},o,[{key:'g',orders:half.map(b=>b.id),state:'awaiting-kr',settled:true}]);
  assert.equal(r.open.length,13-half.length);assert.ok(x.events('piece-closed').every(e=>e.why==='krw-route'));
  // Not explained as cash-free: the group's coverage carried them (coveredInFlight), so the U.S. basis does not move.
  assert.equal(x.explained(),0);
});
test('C3: KIS shows no sale proceeds pending and no sale reported, after either was positive: the flagged sales close',()=>{
  for(const n of [13,25]){const x=tracker(),o=batch(n,'Sell'),T=total(o);x.see({cash:1000,...U(0)});
    // Proceeds shown at the fill (pending), then reported, then settled into cash.
    x.see({cash:1000,pendingSaleProceeds:T,...U(0)},o);x.see({cash:1000,pendingSaleProceeds:T,...U(0,Math.round(T*FX))},o);
    const r=x.see({cash:1000+T,...U(0,0)},o);assert.equal(r.open.filter(p=>p.side==='Sell').length,0,`${n}: closed`);assert.equal(r.sellsUSD,0);
    // Not while either is still positive.
    const y=tracker();y.see({cash:1000,...U(0)});y.see({cash:1000,pendingSaleProceeds:T,...U(0)},o);y.see({cash:1000,pendingSaleProceeds:T,...U(0,Math.round(T*FX))},o);
    assert.ok(y.see({cash:1000,pendingSaleProceeds:T,...U(0,0)},o).open.some(p=>p.side==='Sell'),`${n}: proceeds still pending`);}
  // A sale closed with no cash in its reading (its proceeds were already counted pending): the basis change is explained.
  const x=tracker(),o=batch(13,'Sell'),T=total(o);x.see({cash:1000,...U(0)});x.see({cash:1000,...U(0)},o);x.see({cash:1000,pendingSaleProceeds:T,...U(0)},o);
  const before=x.explained();x.see({cash:1000+T,...U(0)},o);assert.ok(x.explained()<=before,'a cash-free close is explained (never a detected flow)');
});
