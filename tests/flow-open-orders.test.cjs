// M-3.2 (multi-order, artifacts/reviews/2026-11-16-multi-order/m3-2-design.md, cleared): the flow detector compares every
// reading, orders open or not. A change an open order's fill not yet counted could explain (its direction, within the
// open orders' unfilled amount at their highest price) is held marked couldBeFill and never recorded while such orders
// are open; anything else is held 2 hours as before. When no open order can explain it, the mark clears and the hold
// runs from then. Matrix rows 23 and 24.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const T=s=>Date.parse('2026-11-10T'+s+':00+09:00');
function det(){let now=T('09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);
  const read=(s,kr,orders=[],us=null)=>{now=T(s);return d.observe('acct',{krCash:kr,usCash:us,fx:1340,orders});};
  return {d,perf,read,held:()=>d.pending('acct').map(p=>[p.market,p.amount]),marked:()=>JSON.parse(db.prepare('SELECT payload FROM flow_watch').get().payload).pending,flows:()=>perf.flows('acct').map(f=>[f.market,f.amount,f.detected?'detected':''])};}
// A Korean buy of 10 at 70,000 (open, nothing filled), and its later states.
const order=(over={})=>({id:'o1',market:'KR',symbol:'005930',side:'Buy',quantity:10,filled:0,limitPrice:70000,status:'Accepted',createdAt:T('09:00'),...over});
const C=10000000;

test('row 23: a deposit while a buy rests is held at once and recorded after 2 hours, the buy still open (a buy cannot explain a rise)',()=>{
  const w=det();w.read('09:01',C,[order()]);w.read('09:30',C+1000000,[order()]);assert.deepEqual(w.held(),[['KR',1000000]]);assert.ok(!w.marked().KR.couldBeFill);
  assert.deepEqual(w.read('11:31',C+1000000,[order()]).map(f=>[f.market,f.amount]),[['KR',1000000]]);
});
test('row 23 and the planner\'s test 1: a withdrawal the open buy could explain waits for it; cancelled with no fill, it is recorded 2 hours after',()=>{
  const w=det();w.read('09:01',C,[order()]);w.read('09:30',C-500000,[order()]);assert.equal(w.marked().KR.couldBeFill,true);
  assert.deepEqual(w.read('12:00',C-500000,[order()]),[],'not after 2 hours while the buy is open');
  w.read('13:00',C-500000,[order({status:'Canceled'})]);assert.ok(!w.marked().KR.couldBeFill,'the mark clears');assert.equal(w.marked().KR.fillClearedAt,T('13:00'));
  assert.deepEqual(w.read('14:30',C-500000,[order({status:'Canceled'})]),[],'not yet: 2 hours from the clearing');
  assert.deepEqual(w.read('15:01',C-500000,[order({status:'Canceled'})]).map(f=>[f.market,f.amount]),[['KR',-500000]]);
});
test('a fill KIS shows before the app counts it is held, and the reading that counts it returns it: nothing recorded',()=>{
  const w=det(),cost=700105;w.read('09:01',C,[order()]);w.read('09:30',C-cost,[order()]);assert.equal(w.marked().KR.couldBeFill,true);
  const filled=order({status:'Filled',filled:10,fillPrice:70000,resultCosts:{netCash:-cost}});w.read('09:35',C-cost,[filled]);
  assert.deepEqual(w.held(),[]);assert.deepEqual(w.read('12:00',C-cost,[filled]),[]);assert.deepEqual(w.flows(),[]);
});
test('row 24: a fill and a deposit in one reading: the counted fill explains its part, the deposit is detected; not yet counted, the net is held and then the deposit',()=>{
  const cost=700105,filled=order({status:'Filled',filled:10,fillPrice:70000,resultCosts:{netCash:-cost}});
  {const w=det();w.read('09:01',C,[order()]);w.read('09:30',C-cost+2000000,[filled]);assert.deepEqual(w.held(),[['KR',2000000]]);assert.deepEqual(w.read('11:31',C-cost+2000000,[filled]).map(f=>f.amount),[2000000]);}
  {const w=det();w.read('09:01',C,[order()]);w.read('09:30',C-cost+2000000,[order()]);assert.deepEqual(w.held(),[['KR',2000000-cost]]);
    w.read('09:35',C-cost+2000000,[filled]);assert.deepEqual(w.held(),[['KR',2000000]],'the counted fill completes the deposit');assert.deepEqual(w.read('11:31',C-cost+2000000,[filled]).map(f=>f.amount),[2000000]);}
});
test('the planner\'s test 2: a partial fill counted and a withdrawal inside the remaining envelope wait for the order; recorded 2 hours after it fills',()=>{
  const w=det(),part=order({status:'Partially filled',filled:4,fillPrice:70000,resultCosts:{netCash:-280042}});w.read('09:01',C,[order()]);
  w.read('09:30',C-280042-200000,[part]);assert.deepEqual(w.held(),[['KR',-200000]]);assert.equal(w.marked().KR.couldBeFill,true,'6 shares (424,200) could still explain it');
  const done=order({status:'Filled',filled:10,fillPrice:70000,resultCosts:{netCash:-700105}});w.read('10:00',C-700105-200000,[done]);assert.ok(!w.marked().KR.couldBeFill);
  assert.deepEqual(w.read('11:59',C-700105-200000,[done]),[]);assert.deepEqual(w.read('12:01',C-700105-200000,[done]).map(f=>f.amount),[-200000]);
});
test('the envelope: beyond it a change is held as before; a rise is never a buy\'s; a sale explains a rise; an unconfirmed revision counts at its higher price',()=>{
  {const w=det();w.read('09:01',C,[order()]);w.read('09:30',C-1000000,[order()]);assert.ok(!w.marked().KR.couldBeFill,'beyond 707,000');assert.deepEqual(w.read('11:31',C-1000000,[order()]).map(f=>f.amount),[-1000000]);}
  {const w=det();w.read('09:01',C,[order()]);w.read('09:30',C+500000,[order()]);assert.ok(!w.marked().KR.couldBeFill,'a rise inside the buy\'s 707,000 is still no buy\'s');
    assert.deepEqual(w.read('11:31',C+500000,[order()]).map(f=>f.amount),[500000],'recorded after 2 hours, the buy still open');}
  {const w=det(),sell=order({side:'Sell'});w.read('09:01',C,[sell]);w.read('09:30',C+500000,[sell]);assert.equal(w.marked().KR.couldBeFill,true,'a sale may explain a rise');}
  {const w=det(),rev=order({unconfirmed:{price:75000}});w.read('09:01',C,[rev]);w.read('09:30',C-750000,[rev]);assert.equal(w.marked().KR.couldBeFill,true,'757,500 at the higher price');}
  {const w=det(),us=order({market:'US',symbol:'NASD:AAPL',limitPrice:200});w.read('09:01',C,[us]);w.read('09:30',C-500000,[us]);assert.ok(!w.marked().KR.couldBeFill,'a U.S. order does not explain Korean cash');}
});
test('the former early returns: an unattributed-KRW change with an order open is saved and compared',()=>{
  let now=T('09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);
  d.observe('acct',{krCash:C,usCash:100,fx:1340,provisionalKRW:0,orders:[order()]});now=T('09:30');d.observe('acct',{krCash:C+1000000,usCash:100,fx:1340,provisionalKRW:134000,unsettledKRW:134000,orders:[order()]});
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM flow_watch').get().payload).at,T('09:30'),'saved: the next comparison starts here');
});
test('the planner\'s test 4: the daily-loss scenarios see a held change the open order could explain (unresolved, never confirmed)',()=>{
  const w=det();w.read('09:01',C,[order()]);w.read('09:30',C-500000,[order()]);const f=w.d.flowsSince('acct','KR',T('09:00'));
  assert.equal(f.unresolved,-500000);assert.equal(f.confirmed,0);
});
// ---- through the app harness: U.S. and Korean orders on the mock, the readings path main.cjs runs
const PRICES={'005930':70000,'NASD:AAPL':200};
test('the planner\'s test 3: a U.S. buy filled (and settled) is explained once: by its fill and the settlement tracker, never twice; nothing held or recorded',async()=>{
  const m=new MockKis({kr:{cash:C},us:{cash:5000},prices:PRICES}),h=appHarness({mock:m}).enable();h.reading();
  const a=await h.send('US','NASD:AAPL','Buy',3,200);h.reading();m.fill('US',a.brokerOrderId);h.reading();await h.reconcile('US');h.reading();m.settle('US',a.brokerOrderId);h.reading();h.reading();
  assert.deepEqual(h.flows,[]);assert.deepEqual(h.fd.pending('acct'),[],'nothing held');
});
test('rows 23, 24 in the app harness: a deposit while orders rest in both markets is detected; a resting buy\'s fill never is',async()=>{
  const m=new MockKis({kr:{cash:C},us:{cash:5000},prices:PRICES}),h=appHarness({mock:m}).enable();h.reading();
  const a=await h.send('KR','005930','Buy',10,70000);await h.send('US','NASD:AAPL','Buy',3,200);h.reading();
  m.fill('KR',a.brokerOrderId);m.accounts.KR.settledCash+=1500000;h.reading();
  assert.deepEqual(h.fd.pending('acct').map(p=>[p.market,p.amount]),[['KR',800000]],'the fill not yet counted nets with the deposit');
  // Counted at the app's fee estimate (₩105 over the mock's fill, which takes no fee): the deposit and that difference.
  await h.reconcile('KR');h.reading();assert.deepEqual(h.fd.pending('acct').map(p=>[p.market,p.amount]),[['KR',1500105]],'counted: the deposit alone');
});
