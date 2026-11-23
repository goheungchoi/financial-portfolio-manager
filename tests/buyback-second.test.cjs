// The buy-back block, second review: readiness that goes stale, the start latch, scope, the block's own cancel step, a
// conditional buy waiting while the list is unknown, an account switch, the refusal reply, and open outside orders by the
// market's own day. Made-up symbols, order numbers, days and amounts.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const B=require('../electron/buyback.cjs');const at=s=>Date.parse(s);
test('ready only while the history is complete up to a recent time; it goes stale when reads fail',()=>{
  const e={missedRead:true,historyKey:'acct',identity:()=>'acct',historyReadAt:at('2026-10-05T10:00:00+09:00')};
  assert.equal(B.historyReady(e,'KR',{now:at('2026-10-05T10:04:00+09:00')}),true);
  assert.equal(B.historyReady(e,'KR',{now:at('2026-10-05T10:20:00+09:00')}),false,'reads failing for 20 minutes: not ready, buys wait');
  e.historyReadAt=at('2026-10-05T20:05:00+09:00');assert.equal(B.historyReady(e,'KR',{now:at('2026-10-06T02:00:00+09:00')}),true,'after the day\'s last fill: complete until the next session');
  assert.equal(B.historyReady({...e,missedRead:false},'KR',{now:at('2026-10-05T20:06:00+09:00')}),false,'the missed days not read');
  assert.equal(B.historyReady({...e,historyKey:'other'},'KR',{now:at('2026-10-05T20:06:00+09:00')}),false,'another account');
  const u={missedRead:true,historyKey:'acct:US',identity:()=>'acct:US',historyReadAt:at('2026-10-05T23:30:00+09:00')};
  assert.equal(B.historyReady(u,'US',{now:at('2026-10-05T23:33:00+09:00'),sessionOpen:()=>true}),true);assert.equal(B.historyReady(u,'US',{now:at('2026-10-05T23:40:00+09:00'),sessionOpen:()=>true}),false,'U.S. open: older than 4 minutes');
  assert.equal(B.historyReady(u,'US',{now:at('2026-10-06T08:00:00+09:00'),sessionOpen:()=>false,lastOpenAt:at('2026-10-05T23:20:00+09:00')}),true,'closed, read after the session');
  assert.equal(B.historyReady({identity(){throw new Error('NO_US');}},'US',{}),false);
});
test('the start latch keeps the reading before the start, whatever is saved after; with none, 31 days back',()=>{
  let last=at('2026-10-01T15:00:00+09:00');const l=B.startLatch(()=>last);const day=t=>new Date(t+9*3600000).toISOString().slice(0,10);
  l.latch('acct');last=at('2026-10-05T09:00:00+09:00');assert.equal(l.from('acct',day),'2026-10-01','the first reading of this start does not move it');
  const none=B.startLatch(()=>null);assert.equal(none.from('acct',day,at('2026-10-31T12:00:00+09:00')),'2026-09-30');assert.equal(none.from(null,day),undefined,'no account yet');
  const ny=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t));const us=B.startLatch(()=>at('2026-10-06T03:00:00+09:00'));assert.equal(us.from('acct',ny),'2026-10-05','the U.S. counts from the New York day');
});
test('only markets in scope and connected count (a Korea-only user has nothing to wait for in the U.S.)',()=>{
  assert.deepEqual(B.marketsInScope({scope:'kis',kr:true,us:false}),['KR']);assert.deepEqual(B.marketsInScope({scope:'both',kr:true,us:false}),['KR']);
  assert.deepEqual(B.marketsInScope({scope:'both',kr:true,us:true}),['KR','US']);assert.deepEqual(B.marketsInScope({scope:'paper',kr:true,us:true}),[]);
});
test('open outside orders by the market\'s own day: a U.S. order of the New York day across KST midnight',()=>{
  const rows=[{orderId:'0000011',symbol:'NASD:NWTH',side:'Sell',quantity:3,remaining:2,status:'Partially filled',day:'2026-10-05',timestamp:at('2026-10-06T00:30:00+09:00')}];
  assert.equal(B.openOutsideOrders({market:'US',rows,intents:[]},'2026-10-05').length,1,'the New York day');assert.equal(B.openOutsideOrders({market:'US',rows,intents:[]},'2026-10-06').length,0);
});
test('a refused order returns its dated words to the order handlers',()=>{
  const e=Object.assign(new Error('BUYBACK_UNKNOWN'),{detail:'Not sent: the app has not yet read …'});assert.deepEqual(B.refusalReply(e,()=>false),{error:'BUYBACK_UNKNOWN',detail:'Not sent: the app has not yet read …'});
  assert.deepEqual(B.refusalReply(new Error('ORDER_SIZE_LIMIT'),c=>c==='ORDER_SIZE_LIMIT'),{error:'ORDER_SIZE_LIMIT'});assert.deepEqual(B.refusalReply(new Error('X'),()=>false),{error:null});
});
function setup(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'123450',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));a.config.scope='kis';a.usLive=null;
  let orders=[];const calls=[];const engine={market:'KR',identity:()=>'acct',orders:()=>orders,busy:false,annotate(id,p){orders=orders.map(o=>o.id===id?{...o,...p}:o);},async revise(id,o){calls.push([id,o]);if(engine.fail)throw new Error(engine.fail);},buybackBlock:()=>({symbol:'123450',soldOn:'2026-10-05',blockedUntil:'2026-11-04'})};
  a.live=engine;return {a,engine,events,calls,set:o=>{orders=o;},get:()=>orders};}
const buy=extra=>({id:'o1',symbol:'123450',side:'Buy',quantity:3,filled:1,status:'Partially filled',brokerOrderId:'0000021',madeBy:'review',day:'2026-10-05',...extra});
test('the block\'s cancel is its own step: tracking off, taken over, stopped; a failing cancel retried with words; what filled is said',async()=>{
  for(const extra of [{},{handsOff:{at:1,changes:[]}},{trackingStopped:{at:1,reason:'x'}}]){const s=setup();s.a.config.orderTracking=false;s.set([buy(extra)]);await s.a.cancelBlockedBuys(at('2026-10-05T10:00:00+09:00'));
    assert.deepEqual(s.calls,[['o1',{cancel:true,block:true}]],JSON.stringify(extra));assert.ok(s.events.some(e=>/cancel sent for the remaining 2 of 3 shares \(1 filled so far\)/.test(e.body)));}
  const f=setup();f.engine.fail='BROKER_REJECTED';f.set([buy()]);const t0=at('2026-10-05T10:00:00+09:00');await f.a.cancelBlockedBuys(t0);await f.a.cancelBlockedBuys(t0+30000);assert.equal(f.calls.length,1,'waits 1 minute after a failure');
  await f.a.cancelBlockedBuys(t0+61000);assert.equal(f.calls.length,2);assert.ok(f.events.some(e=>/the cancel failed \(BROKER_REJECTED\); trying again/.test(e.body)));
  const x=setup();x.engine.fail='FEATURE_UNAVAILABLE';x.set([buy({session:'kr-after'})]);await x.a.cancelBlockedBuys(t0);assert.ok(x.events.some(e=>/cannot be cancelled by the app: cancel it in the KIS app/.test(e.body)));
  const d=setup();d.set([buy()]);await d.a.cancelBlockedBuys(t0);d.set(d.get().map(o=>({...o,status:'Filled',filled:3})));await d.a.cancelBlockedBuys(t0+20000);assert.ok(d.events.some(e=>/none of it was left to cancel; 3 filled before the cancel/.test(e.body)),'a fill meanwhile is said');
  const k=setup();k.set([buy({madeBy:'ticket'}),buy({id:'o2',credit:{kind:'cover'}}),buy({id:'o3',side:'Sell'})]);await k.a.cancelBlockedBuys(t0);assert.deepEqual(k.calls,[],'your ticket, a cover and a sale are not cancelled');
  const u=setup();u.engine.buybackBlock=()=>({unknown:true,market:'KR',why:'not read yet'});u.set([buy()]);await u.a.cancelBlockedBuys(t0);assert.deepEqual(u.calls,[],'an unknown list cancels nothing');
  const r=setup();r.set([{id:'p1',symbol:'123450',side:'Buy',quantity:1,status:'Ready',expiresAt:t0+60000,madeBy:'review'}]);await r.a.cancelBlockedBuys(t0);assert.equal(r.get()[0].reason,'BUYBACK_BLOCKED');assert.ok(r.events.some(e=>/ended unsent/.test(e.body)));
});
test('an account switch reads the history at once',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'123450',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  let id='acct';const reads=[];a.config.scope='kis';a.usLive=null;a.sessionOpen=()=>false;a.live={identity:()=>id,day:()=>'2026-10-05',historyReadAt:undefined,async syncHistory(){reads.push(id);this.historyReadAt=Date.now();},syncMissed:async()=>{},refreshOutsideCharges:async()=>{}};
  const t=Date.now();await a.syncHistories(t);assert.deepEqual(reads,['acct']);id='other';a.live.historyReadAt=undefined;await a.syncHistories(t+5000);assert.deepEqual(reads,['acct','other'],'not after the 60-second gap: at once');
});
test('a conditional buy that fires while the list is unknown stays armed, with one line; a known block rejects it',async()=>{
  for(const [err,status] of [['BUYBACK_UNKNOWN','armed'],['BUYBACK_BLOCKED','rejected']]){const s=setup();const {a,engine,events}=s;
    engine.context=async()=>({marketSession:{open:true},quotes:[{symbol:'123450',price:50000}],positions:{},equity:1e7,cash:1e7});engine.propose=()=>{throw Object.assign(new Error(err),{detail:'Not sent: words'});};
    a.placementPrice=async()=>({price:50000});a.config.conditionalOrders=true;a.config.conditionalMaxSlippagePct=5;a.config.conditionalMaxOrderPct=50;a.emergencyState=()=>({});a.leveragedEntryRefusal=()=>null;
    const o=a.desk.write('conditional_orders',{id:'c1',scope:a.watchScope(),status:'armed',side:'Buy',symbol:'123450',quantity:1,purpose:'entry',conditions:[{expr:'price("123450")',op:'<=',value:60000}],combine:'all',limitPrice:null,createdAt:Date.now(),expiresAt:Date.now()+3600000});
    await a.fireConditional(o);const after=[...a.desk.orders(a.watchScope()),...a.desk.recentOrders(a.watchScope(),10)].find(x=>x.id==='c1');assert.equal(after.status,status,err);
    if(err==='BUYBACK_UNKNOWN'){assert.ok(events.some(e=>/stays armed and fires once they are/.test(e.body)));const n=events.length;await a.fireConditional(after);assert.equal(events.length,n,'one line, not one per check');}}
});
