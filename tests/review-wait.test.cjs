// M-6 part 4 (multi-order, m6-plan.md section 5; the user's "Wait 30 min for new orders"): while orders rest at the
// broker, a scheduled review waits. With several open orders on, only for the orders the latest review placed (its first
// and further orders), at most 30 minutes after it; older resting orders no longer hold reviews back. Off: today's rule
// (any resting order, up to the 2-hour backstop), unchanged.
const test=require('node:test');const assert=require('node:assert/strict');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
const MIN=60000;
const rig=({several,resting})=>{const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'A'}],()=>[]),{request:async()=>({})},()=>{});
  a.severalOpenNow=()=>several;a.pendingOrders=()=>resting.map(id=>({id,symbol:id,side:'Buy',quantity:1,status:'Accepted'}));a.accountTag=()=>null;
  // The latest review placed o0 (its first order) and o1 (a further one); 'old' is an earlier review's.
  db.prepare('INSERT INTO reviews VALUES(?,?)').run('r',JSON.stringify({id:'r',timestamp:Date.now(),decision:{action:'Buy',symbol:'A',quantity:1},orderId:'o0',orders:[{item:1,action:'Buy',symbol:'B',quantity:1,orderId:'o1'}]}));
  a.lastRun=Date.now();a.reviewSessionKey=null;return a;};
test('switch on: waits for the latest review\'s orders, first or further, at most 30 minutes',()=>{
  for(const id of ['o0','o1']){const a=rig({several:true,resting:[id]});const d=a.deferForPendingOrder(a.lastRun+5*MIN);assert.deepEqual(d.orders.map(o=>o.id),[id]);assert.equal(d.until,a.lastRun+30*MIN);
    assert.equal(a.deferForPendingOrder(a.lastRun+30*MIN),null,'not after 30 minutes');}
});
test('switch on: an earlier review\'s resting order does not hold the review back',()=>{
  const a=rig({several:true,resting:['old']});assert.equal(a.deferForPendingOrder(a.lastRun+5*MIN),null);
  const b=rig({several:true,resting:['old','o1']});assert.deepEqual(b.deferForPendingOrder(b.lastRun+5*MIN).orders.map(o=>o.id),['o1'],'only its own orders are waited for');
});
test('switch off: today\'s rule: any resting order, up to the 2-hour backstop',()=>{
  const a=rig({several:false,resting:['old']});const d=a.deferForPendingOrder(a.lastRun+45*MIN);assert.deepEqual(d.orders.map(o=>o.id),['old']);assert.equal(d.until,a.lastRun+120*MIN);
  assert.equal(a.deferForPendingOrder(a.lastRun+120*MIN),null);
});
test('a market opening or closing ends the wait, on or off, as today',()=>{
  for(const several of [true,false]){const a=rig({several,resting:['o0']});a.reviewSessionKey='KR:open';a.sessionKey=()=>'KR:closed';assert.equal(a.deferForPendingOrder(a.lastRun+5*MIN),null,String(several));}
});
