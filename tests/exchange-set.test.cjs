// M-3.3 (multi-order, artifacts/reviews/2026-11-16-multi-order/m3-3-design.md, cleared): one Korean fall paying several
// exchanges KIS made between two Korean readings. When no single awaiting row fits (nor a split group's two parts, nor a
// set of K1 groups' Korean payments), the first set by firstSet whose needs total the fall within 5% is paid, each row its
// share of KIS's fall, the legs totalling it. Matrix row 25.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FundingTransfers}=require('../electron/funding-transfers.cjs');
const K=s=>Date.parse(s+'+09:00'),KR0=3000000;
function rig(rows){const db=new DatabaseSync(':memory:');let t=K('2026-11-11T08:00:00');const perf=new PerformanceHistory(db,()=>t);const f=new FundingTransfers(db,{performance:perf,clock:()=>t});
  f.observeKR('A',{korea:{cash:KR0,settledCash:KR0}});const settledAt=K('2026-11-11T08:25:00');
  for(const [i,r] of rows.entries())f.put('A',r.key,{orders:[r.key],usd:100,reportedKRW:134000,reportedAt:K('2026-11-10T09:00:00'),settledAt:settledAt+i,fx:1340,...r});
  return {f,perf,to:s=>{t=K(s);},kr:v=>f.observeKR('A',{korea:{cash:v,settledCash:v}}),row:k=>f.rows('A').find(r=>r.key===k),
    legs:()=>perf.flows('A').map(x=>[x.id.replace('funding:',''),x.market,x.amount])};}
const short=(key,usd,extra={})=>({key,state:'awaiting-krw',shortfallUSD:usd,paidUSD:0,...extra});
test('row 25: two shortfalls exchanged in one Korean fall are both paid, each its share; the legs total KIS\'s fall',()=>{
  const w=rig([short('a',50),short('b',30)]);w.to('2026-11-11T08:30:00');w.kr(KR0-107000);
  assert.deepEqual([w.row('a').state,w.row('b').state],['booked','booked']);
  const legs=w.legs(),kr=legs.filter(l=>l[1]==='KR').reduce((n,l)=>n+l[2],0);assert.equal(kr,-107000,'the Korean legs total the fall');
  assert.deepEqual(legs.filter(l=>l[1]==='US').map(l=>l[2]).sort(),[30,50],'each U.S. leg its shortfall');
  assert.deepEqual(legs.find(l=>l[0]==='a:out'),['a:out','KR',-66875],'a: 107,000 × 67,000 / 107,200');
});
test('a shortfall and a reversal in one fall: both paid',()=>{
  const w=rig([short('a',50),{key:'b',state:'awaiting-reversal',paidUSD:60}]);w.to('2026-11-11T08:30:00');w.kr(KR0-120600);
  assert.deepEqual([w.row('a').state,w.row('b').state,w.row('b').via],['booked','booked','reversal']);assert.equal(w.row('b').exchangedKRW+w.row('a').exchangedKRW,120600);
});
test('several sets fit: the first by firstSet (fewest, then earliest); a single fit wins over any set; no set: nothing paid, each expires as today',()=>{
  {const w=rig([short('a',30),short('b',20),short('c',20),short('d',30)]);w.to('2026-11-11T08:30:00');w.kr(KR0-67000);
    assert.deepEqual(['a','b','c','d'].map(k=>w.row(k).state),['booked','booked','awaiting-krw','awaiting-krw'],'a and b: the earliest pair');}
  {const w=rig([short('a',50),short('b',30),short('c',20)]);w.to('2026-11-11T08:30:00');w.kr(KR0-67000);
    assert.deepEqual(['a','b','c'].map(k=>w.row(k).state),['booked','awaiting-krw','awaiting-krw'],'a alone fits: no set');}
  {const w=rig([short('a',50),short('b',30)]);w.to('2026-11-11T08:30:00');w.kr(KR0-90000);assert.deepEqual([w.row('a').state,w.row('b').state],['awaiting-krw','awaiting-krw']);
    w.to('2026-11-20T09:00:00');w.kr(KR0-90000);assert.deepEqual([w.row('a').state,w.row('b').state],['unmatched','unmatched']);}
});
test('a fall a set of K1 groups\' Korean payments fits keeps that match; the exchanges wait',()=>{
  const w=rig([short('a',50),short('b',30),{key:'k',state:'awaiting-kr',reportedKRW:107200,filledAt:K('2026-11-09T23:40:00')}]);w.to('2026-11-11T08:30:00');w.kr(KR0-107200);
  assert.deepEqual([w.row('k').state,w.row('a').state,w.row('b').state],['booked','awaiting-krw','awaiting-krw']);
});
test('the legs total KIS\'s fall exactly when the shares round (the last row takes the remainder)',()=>{
  const w=rig([short('a',29.85),short('b',29.85),short('c',29.85)]);w.to('2026-11-11T08:30:00');w.kr(KR0-120001);
  assert.equal(w.legs().filter(l=>l[1]==='KR').reduce((n,l)=>n+l[2],0),-120001);
});
test('a split group\'s joint match (its U.S. part\'s shortfall and its KRW part in one fall) wins over a set that also fits',()=>{
  // o1's U.S. part ($20 short, 26,800) and its KRW part (67,000) await one fall; x awaits 67,000 too: 93,800 fits both.
  const w=rig([short('o1#us',20,{splitOf:'o1'}),{key:'o1',state:'awaiting-kr',reportedKRW:67000,filledAt:K('2026-11-11T08:00:00')},short('x',50)]);w.to('2026-11-11T08:30:00');w.kr(KR0-93800);
  assert.deepEqual([w.row('o1#us').state,w.row('o1').state,w.row('x').state],['booked','booked','awaiting-krw']);
});
