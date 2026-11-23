// The buy-back block, third review: readiness across the Korean night and the 5-minute windows, order numbers with leading
// zeros, the tracker after a block is lifted, a lost cancel reply and a taken-over order, and a first start through the
// flow detector. Made-up symbols, order numbers, days and amounts.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const B=require('../electron/buyback.cjs');const at=s=>Date.parse(s);
const kr=readAt=>({missedRead:true,historyKey:'acct',identity:()=>'acct',historyReadAt:at(readAt)});
test('Korea stays ready through the night: a read after midnight or before the morning covers until 08:00',()=>{
  assert.equal(B.historyReady(kr('2026-10-06T00:01:00+09:00'),'KR',{now:at('2026-10-06T03:00:00+09:00')}),true,'the day-change read');
  assert.equal(B.historyReady(kr('2026-10-06T06:30:00+09:00'),'KR',{now:at('2026-10-06T07:50:00+09:00')}),true,'a start before 08:00');
  assert.equal(B.historyReady(kr('2026-10-06T06:30:00+09:00'),'KR',{now:at('2026-10-06T08:20:00+09:00')}),false,'past 08:00 a new read is needed');
});
test('the 5-minute windows allow two missed reads; the open session allows a few',()=>{
  assert.equal(B.historyReady(kr('2026-10-05T16:00:00+09:00'),'KR',{now:at('2026-10-05T16:09:00+09:00')}),true,'one read missed after the session');
  assert.equal(B.historyReady(kr('2026-10-05T16:00:00+09:00'),'KR',{now:at('2026-10-05T16:12:00+09:00')}),false,'two or more missed');
  assert.equal(B.historyReady(kr('2026-10-05T10:00:00+09:00'),'KR',{now:at('2026-10-05T10:07:00+09:00')}),false,'open: 6 minutes');
});
test('order numbers with leading zeros: the app\'s own open order is never told as made outside the app',()=>{
  const rows=[{orderId:'0000031',symbol:'123450',side:'Buy',quantity:2,remaining:2,status:'Pending',day:'2026-10-05',timestamp:at('2026-10-05T09:30:00+09:00')}];
  assert.deepEqual(B.openOutsideOrders({market:'KR',rows,intents:[{market:'KR',brokerOrderId:'31',day:'2026-10-05'}]},'2026-10-05'),[]);
  assert.equal(B.openOutsideOrders({market:'KR',rows,intents:[]},'2026-10-05')[0].orderId,'31','the number as the app writes it');
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','buyback.cjs'),'utf8');assert.doesNotMatch(src,/\(\?=d\)/,'no lost backslash');
});
function setup(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'123450',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));a.config.scope='kis';a.usLive=null;
  let orders=[];const calls=[];let block={symbol:'123450',soldOn:'2026-10-05',blockedUntil:'2026-11-04'};
  const engine={market:'KR',identity:()=>'acct',orders:()=>orders,busy:false,day:()=>'2026-10-05',annotate(id,p){orders=orders.map(o=>o.id===id?{...o,...p}:o);},async revise(id,o){calls.push([id,o]);if(engine.fail)throw new Error(engine.fail);},buybackBlock:()=>block};
  a.live=engine;return {a,engine,events,calls,set:o=>{orders=o;},get:()=>orders,lift:()=>{block=null;}};}
const buy=extra=>({id:'o1',symbol:'123450',side:'Buy',quantity:3,filled:0,status:'Accepted',brokerOrderId:'0000021',madeBy:'review',day:'2026-10-05',...extra});
test('the tracker picks an open buy up again once its block is lifted (after a failed cancel)',async()=>{
  const s=setup();s.engine.fail='BROKER_REJECTED';s.set([buy()]);await s.a.cancelBlockedBuys(at('2026-10-05T10:00:00+09:00'));assert.ok(s.get()[0].buybackCancel);
  s.lift();s.a.sessionOpen=()=>true;s.a.syncHistories=async()=>{};s.a.restrictionStop=()=>null;let tracked=false;s.a.orderBook=async()=>{tracked=true;return {status:'unavailable'};};
  await s.a.trackOrders(at('2026-10-05T10:05:00+09:00'));assert.equal(s.get()[0].buybackCancel,null,'cleared once the block is gone');assert.ok(tracked,'tracked again');
});
test('a lost cancel reply waits for the history; a taken-over order is tried once on its current number, then named for you',async()=>{
  const s=setup();s.set([buy({unconfirmed:{cancel:true,from:'0000021'}})]);await s.a.cancelBlockedBuys(at('2026-10-05T10:00:00+09:00'));assert.deepEqual(s.calls,[],'unconfirmed: no second cancel');
  const t=setup();t.engine.fail='ORDER_NOT_OPEN';t.set([buy({handsOff:{at:1,changes:[]},currentBrokerOrderId:'0000077'})]);const t0=at('2026-10-05T10:00:00+09:00');
  await t.a.cancelBlockedBuys(t0);assert.equal(t.calls.length,1);assert.ok(t.events.some(e=>/you changed this order in KIS and the app could not cancel it \(ORDER_NOT_OPEN\); cancel it in the KIS app/.test(e.body)));
  await t.a.cancelBlockedBuys(t0+3600000);assert.equal(t.calls.length,1,'not retried every 15 minutes');
});
test('a first-ever start with 31 days of outside history books no flow',()=>{
  const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');let now=at('2026-10-31T10:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);
  const fills=Array.from({length:20},(_,i)=>({id:'kis:'+i,market:'KR',side:i%2?'Buy':'Sell',symbol:'123450',filled:1,fillPrice:50000,status:'Filled',createdAt:at('2026-10-01T09:00:00+09:00')+i*86400000,resultCosts:{netCash:i%2?-50010:49890,basis:'broker'},outside:{orderId:String(i),kind:'cash'}}));
  d.observe('acct',{krCash:1000000,outside:fills,ordersThrough:now});now+=3*3600000;d.observe('acct',{krCash:1000000,outside:fills,ordersThrough:now});assert.deepEqual(perf.flows('acct'),[]);assert.deepEqual(d.pending('acct'),[]);
});
