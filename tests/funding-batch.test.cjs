// M-1.6b (multi-order design c1 half 2; condition R2): U.S. buys KIS reports as a batch are booked as one group (the
// whole set, or the one fitting prefix by fill time) when no unique set fits; a batch settled in parts is split by fill
// time. Reconcilable at every reading: the booked groups' KRW plus the provisional amount equals what KIS reports;
// nothing is lost or counted twice. The recorder alone, as funding-transfers.test.cjs drives it.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {FundingTransfers}=require('../electron/funding-transfers.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const A='acct',FX=1340,T0=Date.parse('2026-11-09T23:40:00+09:00');
function world(){const db=new DatabaseSync(':memory:');let t=T0-3600000;const clock=()=>t;const perf=new PerformanceHistory(db,clock);const rec=new FundingTransfers(db,{performance:perf,clock});
  const read=({cash,R,orders,at})=>{t=at;const ts=new Date(t).toISOString();return rec.observeUS(A,{us:{accountKey:A+':US',environment:'live',timestamp:ts,cash,unsettled:{buyKRW:R,sellKRW:0}},orders,fx:FX,openOrderIds:new Set(),openBuysUSD:0});};
  // The recorder's first reading, before the buys (at a first reading, buys already there are history: M5).
  read({cash:2000,R:0,orders:[],at:T0-3600000});
  return {db,rec,perf,read,clock:()=>t};}
// Order ids as long as the app's (UUIDs, 36 characters), so a batch's key needs the digest.
const id=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const buy=(i,u)=>({id:id(i),market:'US',symbol:'NYSE:X'+i,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:u,resultCosts:{netCash:-u},createdAt:T0+i*1000,filledObservedAt:T0+i*1000});
const groups=w=>w.rec.rows(A).filter(r=>['us','krw','kr-paid'].includes(r.state));
// M4 / R2: every won KIS reports is in exactly one place.
const reconciles=(w,R,label)=>{const c=w.rec.current(A);assert.equal(c.krwKRW+c.usReportedKRW+c.provisionalKRW,Math.round(R),`${label}: groups ${c.krwKRW}+${c.usReportedKRW} + provisional ${c.provisionalKRW} = KIS ${R}`);};
const H=3600000;

test('KRW-paid, 12 buys reported together: one batch group, the transfer pair booked once with a deterministic id; reconciles',()=>{
  const w=world(),o=Array.from({length:12},(_,i)=>buy(i,10+i)),total=o.reduce((n,x)=>n+x.fillPrice,0),R=Math.round(total*FX);
  w.read({cash:0,R:0,orders:o,at:T0+H});w.read({cash:0,R,orders:o,at:T0+10*H});reconciles(w,R,'report');
  const g=groups(w);assert.equal(g.length,1);assert.equal(g[0].state,'krw');assert.equal(g[0].via,'batch');assert.equal(g[0].orders.length,12);assert.equal(g[0].reportedKRW,R,'KIS\'s KRW, exact');assert.equal(g[0].usd,total);
  const flows=w.perf.flows(A);assert.equal(flows.length,2,'the K1 pair');assert.ok(flows.every(f=>/^funding:g[0-9a-f]{32}:(out|in)$/.test(f.id)),'a digest key keeps the ids deterministic');
  w.read({cash:0,R,orders:o,at:T0+11*H});assert.equal(w.perf.flows(A).length,2,'a repeat writes nothing');
});
test('reported in two parts: the first part is the one fitting prefix by fill time, the rest the second report; reconciles at each',()=>{
  const w=world(),o=Array.from({length:12},(_,i)=>buy(i,10+i)),head=o.slice(0,5).reduce((n,x)=>n+x.fillPrice,0),total=o.reduce((n,x)=>n+x.fillPrice,0);
  w.read({cash:0,R:0,orders:o,at:T0+H});const R1=Math.round(head*FX);w.read({cash:0,R:R1,orders:o,at:T0+10*H});reconciles(w,R1,'first part');
  assert.deepEqual(groups(w).map(g=>g.orders.length),[5]);assert.deepEqual(groups(w)[0].orders,[0,1,2,3,4].map(id),'the earliest five');
  const R2=Math.round(total*FX);w.read({cash:0,R:R2,orders:o,at:T0+11*H});reconciles(w,R2,'second part');assert.deepEqual(groups(w).map(g=>g.orders.length).sort((a,b)=>a-b),[5,7]);
});
test('F1: a group\'s orders are stored sorted, as before (a unique-set group byte for byte)',()=>{
  const w=world(),o=[buy(3,30),buy(1,10),buy(2,20)];w.read({cash:0,R:0,orders:o,at:T0+H});w.read({cash:0,R:Math.round(60*FX),orders:o,at:T0+10*H});
  const g=groups(w)[0];assert.equal(g.via,'report','a unique set, not a batch');assert.deepEqual(g.orders,[id(1),id(2),id(3)]);assert.equal(g.key,[id(1),id(2),id(3)].join('+'),'the old key');
  // A batch is chosen by fill time; here the fills run against the ids, and the stored list is still sorted.
  const v=world(),late=i=>({...buy(i,10+i),createdAt:T0+(20-i)*1000,filledObservedAt:T0+(20-i)*1000}),p=Array.from({length:12},(_,i)=>late(i));
  v.read({cash:0,R:0,orders:p,at:T0+H});v.read({cash:0,R:Math.round(p.reduce((n,x)=>n+x.fillPrice,0)*FX),orders:p,at:T0+10*H});
  const b=groups(v)[0];assert.equal(b.via,'batch');assert.deepEqual(b.orders,[...b.orders].sort(),'sorted, not in fill order');
});
test('equal amounts: the prefix by fill time is the one booked',()=>{
  const w=world(),o=Array.from({length:12},(_,i)=>buy(i,20));w.read({cash:0,R:0,orders:o,at:T0+H});const R=Math.round(100*FX);w.read({cash:0,R,orders:o,at:T0+10*H});
  reconciles(w,R,'report');assert.deepEqual(groups(w)[0].orders,[0,1,2,3,4].map(id));
});
test('a part report two different prefixes fit: nothing is assumed; it stays provisional (reconciles)',()=>{
  const w=world(),o=[...Array.from({length:9},(_,i)=>buy(i,100)),buy(9,1),buy(10,100)];w.read({cash:0,R:0,orders:o,at:T0+H});
  const R=Math.round(900*FX);w.read({cash:0,R,orders:o,at:T0+10*H});assert.equal(groups(w).length,0,'9 or 10 buys (the $1 one) both fit: no booking');assert.equal(w.rec.current(A).provisionalKRW,R);reconciles(w,R,'ambiguous');
});
test('one candidate under 5% missing from the report: the whole set is booked (KRW exact, USD over by the small one); its later report joins that group; never twice',()=>{
  const w=world(),o=[...Array.from({length:12},(_,i)=>buy(i,100)),buy(12,3)];w.read({cash:0,R:0,orders:o,at:T0+H});
  const R1=Math.round(1200*FX);w.read({cash:0,R:R1,orders:o,at:T0+10*H});reconciles(w,R1,'report without the $3 buy');
  const g=groups(w)[0];assert.equal(g.orders.length,13);assert.equal(g.reportedKRW,R1,'the KRW booked is KIS\'s');assert.equal(g.usd,1203,'the U.S. leg includes the $3 buy (stated)');
  // No candidate is left, and the change is within the band: the existing rescaling rule (KIS revaluing at a day's rate)
  // folds it into the group, which already holds the $3 buy. Its KRW is then KIS's whole report; booked once.
  const R2=R1+Math.round(3*FX);w.read({cash:0,R:R2,orders:o,at:T0+11*H});reconciles(w,R2,'the $3 reported later');
  assert.equal(w.rec.current(A).provisionalKRW,0);assert.equal(groups(w)[0].reportedKRW,R2,'the group now carries KIS\'s whole report');assert.equal(w.perf.flows(A).length,2,'no second booking');
});
test('a later report that does not fit what remains: provisional, never lost',()=>{
  const w=world(),o=Array.from({length:12},(_,i)=>buy(i,10+i));w.read({cash:0,R:0,orders:o,at:T0+H});const R1=Math.round(o.slice(0,5).reduce((n,x)=>n+x.fillPrice,0)*FX);
  w.read({cash:0,R:R1,orders:o,at:T0+10*H});const R2=R1+Math.round(500*FX);w.read({cash:0,R:R2,orders:o,at:T0+11*H});
  reconciles(w,R2,'an unrelated $500 report');assert.equal(groups(w).length,1,'only the first part is booked');assert.equal(w.rec.current(A).provisionalKRW,R2-R1);
});
test('a USD-paid batch settled in parts: the group splits by fill time, each part settles with KIS\'s figure; reconciles throughout',()=>{
  const w=world(),o=Array.from({length:12},(_,i)=>buy(i,10+i)),total=o.reduce((n,x)=>n+x.fillPrice,0),R=Math.round(total*FX),head=o.slice(0,5).reduce((n,x)=>n+x.fillPrice,0);
  w.read({cash:2000,R:0,orders:o,at:T0+H});w.read({cash:2000,R,orders:o,at:T0+10*H});assert.equal(groups(w)[0].state,'us');reconciles(w,R,'report');
  const left=R-Math.round(head*FX);w.read({cash:2000-head,R:left,orders:o,at:T0+30*H});reconciles(w,left,'first part settled');
  const rest=groups(w);assert.equal(rest.length,1);assert.equal(rest[0].orders.length,7,'the later seven remain');assert.equal(rest[0].reportedKRW,left);
  w.read({cash:2000-total,R:0,orders:o,at:T0+31*H});reconciles(w,0,'all settled');assert.equal(groups(w).length,0);
});
