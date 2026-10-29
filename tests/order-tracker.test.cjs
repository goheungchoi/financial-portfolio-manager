const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
// The tracker with a real LiveEngine over a fake KIS broker, a controllable order book and an open U.S. session.
function setup({market='US',history={orders:[]},revise}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const sent=[];const events=[];let n=0;
  const snapshot={accountKey:market==='US'?'acct:US':'acct',environment:'mock',reportedTotal:1e6,cash:1e6,holdings:[]};
  const engine=new LiveEngine(db,{request:async(op,data)=>{sent.push([op,data?.command??data]);if(op==='orders')return history;if(op==='revise-order'){if(revise)return revise(data.command);n++;return {brokerOrderId:'R'+n};}return {};}},()=>({status:'connected',snapshot}),{market});
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({id,title,body}));
  if(market==='US')a.usLive=engine;else a.live=engine;a.config.scope=market==='US'?'us':'kis';a.sessionOpen=()=>true;
  const book={bid:285.32,ask:285.48};a.orderBook=async()=>book.bid==null?{status:'unavailable'}:{status:'available',retrievedAt:Date.now(),data:{bid:book.bid,ask:book.ask}};
  const add=(extra={})=>{const o={id:'o1',accountKey:snapshot.accountKey,symbol:market==='US'?'NASD:GOOGL':'005930',side:'Sell',quantity:1,limitPrice:287.64,status:'Accepted',brokerOrderId:'B1',day:engine.day(),market,...extra};engine.save(o);return o;};
  const revisions=()=>sent.filter(s=>s[0]==='revise-order').map(s=>s[1].cancel?'cancel':s[1].price);
  return {a,engine,sent,events,book,add,revisions,history};}

test('a sale follows the best bid down on every 0.2% move, without limit, however fast the price falls',async()=>{
  // 2026-10-29: GOOGL at $287.64 while the bid fell from $285.32 to below $280.
  const {a,engine,book,add,revisions,events}=setup();add();
  await a.trackOrders();assert.deepEqual(revisions(),[285.32]);assert.equal(engine.orders()[0].currentPrice,285.32);
  book.bid=285.0;await a.trackOrders();assert.deepEqual(revisions(),[285.32],'0.11%: unchanged');
  book.bid=284.7;await a.trackOrders();assert.deepEqual(revisions(),[285.32,284.7],'0.22% from the order price');
  for(const p of [280,271.5,250.25])book.bid=p;await a.trackOrders();assert.deepEqual(revisions(),[285.32,284.7,250.25],'a sharp drop: straight to the bid');
  book.bid=262;await a.trackOrders();assert.equal(revisions().at(-1),262,'and back up when the bid rises');
  assert.ok(events.some(e=>e.title==='Order revised'&&/287.64 → 285.32 \(best bid 285.32\)/.test(e.body)));
});
test('a purchase follows the best ask; the agent’s bound holds a floor or cap; partial fills revise what is left',async()=>{
  const b=setup();b.add({side:'Buy',limitPrice:100,quantity:5,filled:2,status:'Partially filled'});b.book.bid=100.5;b.book.ask=101;await b.a.trackOrders();
  assert.deepEqual(b.revisions(),[101]);assert.equal(b.sent.find(s=>s[0]==='revise-order')[1].quantity,3,'3 of 5 left');
  const f=setup();f.add({tracking:{bound:280}});f.book.bid=275;await f.a.trackOrders();assert.deepEqual(f.revisions(),[280],'held at the floor');
  f.book.bid=270;await f.a.trackOrders();await f.a.trackOrders();assert.deepEqual(f.revisions(),[280],'not below it');assert.equal(f.events.filter(e=>e.title==='Order tracking'&&/held at your bound 280/.test(e.body)).length,1,'noted once');
  f.book.bid=283;await f.a.trackOrders();assert.deepEqual(f.revisions(),[280,283],'above the floor again: the bid');
  const c=setup();c.add({side:'Buy',limitPrice:100,tracking:{bound:101.2}});c.book.ask=103;c.book.bid=102.9;await c.a.trackOrders();assert.deepEqual(c.revisions(),[101.2],'held at the cap');
});
test('the agent’s stop time and cancel conditions cancel the order',async()=>{
  const s=setup();s.add({tracking:{cancelAfter:new Date(Date.now()-1000).toISOString()}});await s.a.trackOrders();assert.deepEqual(s.revisions(),['cancel']);assert.ok(s.engine.orders()[0].cancelRequestedAt);
  await s.a.trackOrders();assert.deepEqual(s.revisions(),['cancel'],'cancelled once');assert.ok(s.events.some(e=>e.title==='Order cancelled'&&/stop time/.test(e.body)));
  const c=setup();c.a.usQuotes=[{symbol:'NASD:GOOGL',price:300}];c.add({tracking:{cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}]}});await c.a.trackOrders();assert.deepEqual(c.revisions(),['cancel']);assert.ok(c.events.some(e=>/cancel condition was met: price\("NASD:GOOGL"\) >= 295 \(now 300\)/.test(e.body)));
  const k=setup();k.a.usQuotes=[{symbol:'NASD:GOOGL',price:290}];k.add({tracking:{cancelIf:[{expr:'price("NASD:GOOGL")',op:'>=',value:295}],cancelAfter:new Date(Date.now()+3600000).toISOString()}});await k.a.trackOrders();assert.deepEqual(k.revisions(),[285.32],'neither met: it follows the bid');
});
test('orders it must leave alone: taken over, paused, cancelling, extended session, an earlier day, closed or filled; a closed market, a busy engine or no book',async()=>{
  for(const extra of [{handsOff:{at:1,changes:[]}},{trackingStopped:{at:1,reason:'x'}},{cancelRequestedAt:1},{session:'us-pre'},{day:'2026-10-28'},{status:'Filled'},{status:'Canceled'},{brokerOrderId:null}]){
    const t=setup();t.add(extra);await t.a.trackOrders();assert.deepEqual(t.revisions(),[],JSON.stringify(extra));}
  const closed=setup();closed.a.sessionOpen=()=>false;closed.add();await closed.a.trackOrders();assert.deepEqual(closed.revisions(),[]);assert.equal(closed.sent.filter(s=>s[0]==='orders').length,0,'no history read while closed');
  const busy=setup();busy.add();busy.engine.busy=true;await busy.a.trackOrders();assert.deepEqual(busy.revisions(),[]);
  const none=setup();none.add();none.book.bid=null;await none.a.trackOrders();await none.a.trackOrders();assert.deepEqual(none.revisions(),[]);assert.equal(none.events.filter(e=>/no usable order book/.test(e.body)).length,1,'noted once');
});
test('a refusal reads the order’s status at once (it may have just filled); an unclear reply pauses it; two orders in one pass',async()=>{
  const r=setup({revise:()=>{throw new Error('BROKER_REJECTED');}});r.add();r.history.orders=[{orderId:'B1',originalOrderId:null,quantity:1,filled:1,remaining:0,fillPrice:285.1,status:'Filled'}];
  await r.a.trackOrders();assert.equal(r.engine.orders()[0].status,'Filled','checked right away');assert.ok(r.events.some(e=>e.title==='Order not revised'&&/may have just filled/.test(e.body)));
  const u=setup({revise:()=>{throw new Error('ORDER_UNCERTAIN');}});u.add();await u.a.trackOrders();await u.a.trackOrders();assert.equal(u.sent.filter(s=>s[0]==='revise-order').length,1,'paused after the unclear reply');
  const two=setup();two.add();two.engine.save({...two.engine.orders()[0],id:'o2',brokerOrderId:'B2',side:'Buy',limitPrice:280});await two.a.trackOrders();assert.deepEqual(two.revisions().sort(),[285.32,285.48].sort());
});
test('the history of every KIS order is read every 60 seconds while a market is open; the tick starts the tracker every 3 seconds unless switched off',async()=>{
  const h=setup();h.history.orders=[{orderId:'K1',originalOrderId:null,quantity:2,filled:0,remaining:2,status:'Pending',symbol:'NASD:NVDA'}];const t0=Date.now();
  await h.a.trackOrders(t0);await h.a.trackOrders(t0+30000);assert.equal(h.sent.filter(s=>s[0]==='orders').length,1,'once a minute');await h.a.trackOrders(t0+61000);assert.equal(h.sent.filter(s=>s[0]==='orders').length,2);
  assert.deepEqual(h.engine.history().map(r=>r.orderId),['K1'],'an order placed in KIS, kept');
  const k=setup();let runs=0;k.a.trackOrders=async()=>{runs++;};k.a.schedulerStatus=()=>({label:'Stopped'});k.a.tick();k.a.tick();assert.equal(runs,1,'every 3 seconds, auto trading off or not');
  k.a.lastTrack=0;k.a.configure({orderTracking:false});k.a.tick();assert.equal(runs,1,'switched off');assert.throws(()=>k.a.configure({orderTracking:'yes'}),/INVALID_SETTINGS/);
});
test('a session KIS will not revise in is noted once, not every 3 seconds',async()=>{
  const s=setup({revise:()=>{throw new Error('SESSION_CLOSED');}});s.add();for(let i=0;i<4;i++)await s.a.trackOrders();
  assert.equal(s.events.filter(e=>/regular session/.test(e.body)).length,1);assert.equal(s.events.filter(e=>e.title==='Order not revised').length,0);
});
