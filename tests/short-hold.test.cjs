// Item 9 (artifacts/reviews/2026-11-17-deposit-detection/design-note.md and the planner's ruling R1-R4, cleared): a rise
// nothing else can explain is recorded after 10 minutes instead of 2 hours; a record made early is taken back into
// pending by any later change in its market or the other market (R1), so every sequence ends as the 2-hour hold would
// have left it; your confirm or remove stands (R2); a rise that keeps the long hold says why (R3); a change held before
// the upgrade counts the other market's reads from then (R4). No AI call, no broker.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {FlowDetector,SHORT_MS,HOLD_MS}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const T0=Date.parse('2026-11-10T10:00:00+09:00'),MIN=60000,FX=1300;
// A run: each step {m: minutes after T0, kr, us, usRead (default: read now), krRead}; `short` passes the snapshots' read times.
function run(steps,{short=true,notes=[]}={}){let now=T0;const db=new DatabaseSync(':memory:'),perf=new PerformanceHistory(db,()=>now),d=new FlowDetector(db,perf,()=>now);d.onNote=(title,body)=>notes.push({title,body,at:now});
  let usAt=null;const out=[];
  // usSnap: a U.S. snapshot read now whose cash is not passed (as main.cjs does while it is provisional).
  for(const s of steps){now=T0+s.m*MIN;if(s.act){s.act(perf,d);continue;}if(s.usRead!==false&&(s.us!==undefined&&s.us!==null||s.usSnap))usAt=now;
    const r=d.observe('A',{krCash:s.kr,usCash:s.us===undefined?null:s.us,fx:FX,...(s.provisional?{provisionalKRW:s.provisional,unsettledKRW:s.provisional}:{}),...(short?{readAt:{KR:now,US:usAt}}:{})});out.push(...r.map(f=>({...f,m:s.m})));}
  return {d,perf,out,notes,flows:perf.flows('A')};}
const records=flows=>flows.map(f=>({day:f.day,market:f.market,amount:f.amount,detected:Boolean(f.detected),transfer:Boolean(f.transfer),source:f.source??null})).sort((a,b)=>(a.market+a.amount).localeCompare(b.market+b.amount));
const every=(from,to,f)=>Array.from({length:to-from+1},(_,i)=>f(from+i));
test('a Korean rise nothing else explains is recorded after 10 minutes, once the U.S. balance was read twice since',()=>{
  const steps=[{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,12,m=>({m,kr:6000000,us:0}))];
  const r=run(steps);assert.equal(r.out.length,1);assert.equal(r.out[0].m,11,'at 10 minutes after the change, not before');assert.equal(r.out[0].amount,5000000);assert.ok(r.out[0].detected);
  assert.ok(r.notes.some(n=>/recorded after 10 minutes/.test(n.body)));
  assert.equal(run(steps,{short:false}).out.length,0,'without read times nothing is recorded early (today: 2 h)');
  // No U.S. read after the change (a failing U.S. refresh keeps its old snapshot): no early record.
  const stale=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,30,m=>({m,kr:6000000,us:0,usRead:false}))]);assert.equal(stale.out.length,0);
  // An account whose U.S. balance was never read has no other side: recorded after 10 minutes.
  const krOnly=run([{m:0,kr:1000000},{m:1,kr:6000000},...every(2,12,m=>({m,kr:6000000}))]);assert.equal(krOnly.out[0]?.m,11);
  assert.equal(SHORT_MS,10*MIN);
  // Without read times nothing is recorded early, on an account with no U.S. side too.
  assert.equal(run([{m:0,kr:1000000},{m:1,kr:6000000},...every(2,30,m=>({m,kr:6000000}))],{short:false}).out.length,0);
  // A second part restarts the count: the U.S. reads before it do not count, and none come after it.
  const part=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},{m:2,kr:6000000,us:0},{m:3,kr:6000000,us:0},{m:4,kr:7000000,us:0,usRead:false},...every(5,30,m=>({m,kr:7000000,us:0,usRead:false}))]);
  assert.equal(part.out.length,0,'the reads before the second part do not count');
});
test('F1: a U.S. snapshot whose cash was not compared is no read (the planner\'s probe)',()=>{
  const r=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:null,usSnap:true},...every(2,60,m=>({m,kr:6000000,us:null,usSnap:true}))]);
  assert.equal(r.out.length,0,'no U.S. balance compared since the change: nothing recorded early');
  assert.equal(run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,12,m=>({m,kr:6000000,us:0}))]).out[0]?.m,11,'compared U.S. reads still count');
});
test('F2: a move under the threshold leaves an early record alone and says nothing; a 2,000,000 fall takes it back',()=>{
  const r=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,19,m=>({m,kr:6000000,us:0})),{m:20,kr:6000001,us:0},...every(21,39,m=>({m,kr:6000001,us:0})),{m:40,kr:6000002,us:0},...every(41,60,m=>({m,kr:6000002,us:0}))]);
  assert.deepEqual(r.flows.map(f=>f.amount),[5000000],'one record, not remade for a won');assert.equal(r.out.length,1);
  assert.ok(!r.notes.some(n=>n.title==='Detected change reviewed'),'no notice for a won');
  const back=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,19,m=>({m,kr:6000000,us:0})),{m:20,kr:4000000,us:0},...every(21,40,m=>({m,kr:4000000,us:0}))]);
  assert.ok(back.notes.some(n=>n.title==='Detected change reviewed'));assert.deepEqual(back.flows,[],'taken back and held again (2 h from the first change)');
});
test('falls keep the 2-hour hold; a rise that keeps it says why (R3)',()=>{
  const fall=run([{m:0,kr:6000000,us:0},{m:1,kr:1000000,us:0},...every(2,121,m=>({m,kr:1000000,us:0}))]);assert.equal(fall.out.length,1);assert.equal(fall.out[0].m,121);
  // U.S. buys settling: the rise is held 2 h, and says so on the held change and in its note.
  const settle=run([{m:0,kr:1000000,us:0,provisional:500000},{m:1,kr:6000000,us:0,provisional:500000},...every(2,121,m=>({m,kr:6000000,us:0,provisional:500000}))]);
  assert.equal(settle.out.length,1);assert.equal(settle.out[0].m,121);assert.match(settle.out[0].note,/Held 2 h: U\.S\. buys are settling/);
  // The other account changed too (no offset at the rate): held 2 h, the reason shown while held.
  const both=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:200},...every(2,15,m=>({m,kr:6000000,us:200}))]);assert.equal(both.out.length,0);
  assert.deepEqual(both.d.pending('A').find(p=>p.market==='KR').holdReason,'the U.S. account changed too');
});
// R1: each sequence ends as the 2-hour hold leaves it.
const same=(steps,what)=>{const a=run(steps),b=run(steps,{short:false});assert.deepEqual(records(a.flows),records(b.flows),what);return a;};
test('R1: a record made early is taken back by a later change, and the sequence ends as under the 2-hour hold',()=>{
  const at=(from,to,kr,us)=>every(from,to,m=>({m,kr,us}));
  // A reversal: nothing recorded.
  let a=same([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...at(2,20,6000000,0),{m:21,kr:1000000,us:0},...at(22,200,1000000,0)],'reversal');assert.deepEqual(a.flows,[]);
  assert.ok(a.notes.some(n=>n.title==='Detected change reviewed'));
  // A partial reversal (5,000,000 up, then 2,000,000 down): one net change, as the 2 h hold.
  a=same([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...at(2,20,6000000,0),{m:21,kr:4000000,us:0},...at(22,200,4000000,0)],'partial reversal');assert.equal(a.flows.reduce((n,f)=>n+f.amount,0),3000000);
  // The other side of an exchange arriving later: a transfer pair, no deposit.
  a=same([{m:0,kr:1000000,us:1000},{m:1,kr:2300000,us:1000},...at(2,20,2300000,1000),{m:21,kr:2300000,us:0},...at(22,200,2300000,0)],'exchange');
  assert.deepEqual(records(a.flows).map(f=>[f.market,f.transfer]),[['KR',true],['US',true]]);
  // A later part in the same direction: as one change, as the 2 h hold.
  a=same([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...at(2,20,6000000,0),{m:21,kr:7000000,us:0},...at(22,200,7000000,0)],'a later rise');assert.equal(a.flows.reduce((n,f)=>n+f.amount,0),6000000);
  // After 2 hours the record is final: a later change is a change of its own.
  a=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...at(2,130,6000000,0),{m:131,kr:1000000,us:0},...at(132,260,1000000,0)]);assert.deepEqual(a.flows.map(f=>f.amount).sort((x,y)=>x-y),[-5000000,5000000]);
});
test('R2: once you confirmed or removed an early record, your act stands; a later reversal or other side is held on its own and names it',()=>{
  const at=(from,to,kr,us)=>every(from,to,m=>({m,kr,us}));
  const confirm={m:15,act:(perf)=>{const f=perf.flows('A').find(x=>x.detected);perf.confirmFlow('A',f.id);}};
  let a=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...at(2,14,6000000,0),confirm,{m:16,kr:1000000,us:0},...at(17,140,1000000,0)]);
  assert.deepEqual(a.flows.map(f=>[f.amount,Boolean(f.detected)]).sort((x,y)=>x[0]-y[0]),[[-5000000,true],[5000000,false]],'your confirmed deposit stands; the fall is held and recorded on its own');
  assert.match(a.flows.find(f=>f.amount<0).note,/The earlier ₩5,000,000 record you confirmed stands\./);
  const remove={m:15,act:(perf)=>{const f=perf.flows('A').find(x=>x.detected);perf.removeFlow('A',f.id);}};
  a=run([{m:0,kr:1000000,us:1000},{m:1,kr:2300000,us:1000},...at(2,14,2300000,1000),remove,{m:16,kr:2300000,us:0},...at(17,140,2300000,0)]);
  assert.deepEqual(a.flows.map(f=>[f.market,f.amount]),[['US',-1000]],'removed: the U.S. fall is its own change');assert.match(a.flows[0].note,/you removed stands/);
  // Replaced by your own entry: the note says you recorded it yourself.
  const record={m:15,act:(perf)=>{const f=perf.flows('A').find(x=>x.detected);perf.addFlow('A',{day:f.day,market:'KR',amount:5000000,note:'mine'});}};
  a=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...at(2,14,6000000,0),record,{m:16,kr:1000000,us:0},...at(17,140,1000000,0)]);
  assert.match(a.flows.find(f=>f.amount<0).note,/The earlier ₩5,000,000 change you recorded yourself stands\./);
});
test('R4: a change held before the upgrade counts the other market\'s reads from then; nothing on the first reading',()=>{
  let now=T0;const db=new DatabaseSync(':memory:'),perf=new PerformanceHistory(db,()=>now),d=new FlowDetector(db,perf,()=>now);
  d.observe('A',{krCash:1000000,usCash:0,fx:FX});now=T0+MIN;d.observe('A',{krCash:6000000,usCash:0,fx:FX});
  // As saved by the build before: no read counts on the held change, no read times on the reading.
  const row=JSON.parse(db.prepare('SELECT payload FROM flow_watch').get().payload);delete row.readAt;delete row.usEver;delete row.krwUnpaid;for(const q of Object.values(row.pending))delete q.otherReads;
  db.prepare('UPDATE flow_watch SET payload=?').run(JSON.stringify(row));
  now=T0+30*MIN;assert.deepEqual(d.observe('A',{krCash:6000000,usCash:0,fx:FX,readAt:{KR:now,US:now}}),[],'the first reading after the upgrade: one read counted, nothing recorded');
  now=T0+31*MIN;assert.equal(d.observe('A',{krCash:6000000,usCash:0,fx:FX,readAt:{KR:now,US:now}}).length,1,'the second read: recorded');
});
test('your record replaces a detected flow it matches, so the money is counted once',()=>{
  const r=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,12,m=>({m,kr:6000000,us:0}))]);const det=r.flows[0];assert.ok(det.detected);
  const mine=r.perf.addFlow('A',{day:det.day,market:'KR',amount:5000000,note:'Monthly saving'});
  assert.deepEqual(r.perf.flows('A').map(f=>[f.amount,Boolean(f.detected)]),[[5000000,false]]);assert.deepEqual(mine.pendingIds,det.pendingIds);assert.deepEqual(mine.replaced,{id:det.id,amount:5000000});
  // A different amount or the other market is not that change.
  const r2=run([{m:0,kr:1000000,us:0},{m:1,kr:6000000,us:0},...every(2,12,m=>({m,kr:6000000,us:0}))]);r2.perf.addFlow('A',{day:r2.flows[0].day,market:'KR',amount:4000000});assert.equal(r2.perf.flows('A').length,2);
  r2.perf.addFlow('A',{day:r2.flows[0].day,market:'US',amount:5000});assert.equal(r2.perf.flows('A').length,3);
  assert.ok(HOLD_MS>SHORT_MS);
});
