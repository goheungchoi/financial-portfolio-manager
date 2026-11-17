// M-3.3, matrix row 25, end to end (the planner's addition): two U.S. buys whose USD KIS did not have at settlement (a
// sale's proceeds still pending), exchanged by KIS in one Korean fall. Through the readings path main.cjs wires (the
// loss-funding harness): no detected flow at any reading, both exchanges booked (the Korean legs totalling the fall), and
// the combined value right at every reading.
const test=require('node:test');const assert=require('node:assert/strict');const {e2e}=require('./loss-funding-e2e.test.cjs');
const K=s=>Date.parse(s+'+09:00'),FX=1340,KR0=3000000;
const fill=(id,side,usd,at)=>({id,market:'US',symbol:'NASD:'+id,side,status:'Filled',quantity:1,filled:1,fillPrice:usd,resultCosts:{netCash:side==='Buy'?-usd:usd},createdAt:K(at),filledObservedAt:K(at)});
const Z=fill('Z','Sell',200,'2026-11-09T23:10:00'),A=fill('A','Buy',100,'2026-11-09T23:40:00'),B=fill('B','Buy',100,'2026-11-09T23:41:00');
const H=os=>os.filter(o=>o.side==='Buy').map(o=>({symbol:o.symbol,quantity:1,price:o.fillPrice}));
const at=(t,note,kr,us,orders)=>({at:K(t),note,fx:FX,kr:{settled:kr,holdings:[]},us:{holdings:H(orders),...us},orders});
const seq=[at('2026-11-09T23:00:00','before',KR0,{cash:0,holdings:[{symbol:'NASD:Z',quantity:1,price:200}]},[]),
  at('2026-11-09T23:15:00','Z sold (proceeds pending)',KR0,{cash:0,pending:200},[Z]),
  at('2026-11-09T23:45:00','A and B filled',KR0,{cash:0,pending:200},[Z,A,B]),
  at('2026-11-10T09:00:00','A reported',KR0,{cash:0,pending:200,buyKRW:134000},[Z,A,B]),
  at('2026-11-10T09:30:00','B reported',KR0,{cash:0,pending:200,buyKRW:268000},[Z,A,B]),
  at('2026-11-11T08:25:00','settled, no USD (proceeds still pending)',KR0,{cash:0,pending:200,buyKRW:0},[Z,A,B]),
  at('2026-11-11T08:30:00','one Korean fall: both exchanges',KR0-268000,{cash:0,pending:200,buyKRW:0},[Z,A,B]),
  at('2026-11-11T23:00:00','proceeds settle',KR0-268000,{cash:200},[Z,A,B]),
  at('2026-11-12T12:00:00','later',KR0-268000,{cash:200},[Z,A,B]),at('2026-11-23T12:00:00','after age',KR0-268000,{cash:200},[Z,A,B])];
test('row 25 end to end: two exchanges in one Korean fall: no detected flow, both booked, the combined value right at every reading',()=>{
  const run=e2e(seq),combined=KR0+200*FX;
  assert.deepEqual(run.flows().filter(f=>f.detected).map(f=>[f.market,f.amount]),[],'no detected flow');
  const legs=run.flows().filter(f=>f.transfer);assert.equal(legs.filter(f=>f.market==='KR').reduce((n,f)=>n+f.amount,0),-268000,'the Korean legs total the fall');
  assert.deepEqual(legs.filter(f=>f.market==='US').map(f=>f.amount).sort(),[100,100]);
  assert.deepEqual(run.rec.rows('acct').filter(r=>r.orders?.length&&r.state!=='none').map(r=>[r.state,r.via]),[['booked','exchange'],['booked','exchange']]);
  for(const r of run.out){const low=r.value.KR.low+r.value.US.low*FX;assert.ok(low<=combined+2,`${r.note}: ${low} above ${combined}`);}
  for(const r of run.out.slice(run.out.findIndex(x=>x.note.startsWith('one Korean fall'))))assert.ok(Math.abs(r.value.KR.low+r.value.US.low*FX-combined)<=2,`${r.note}: right`);
});
