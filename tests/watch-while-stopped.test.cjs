// Orders while stopped, B-3: the setting, its consent and the switches record (electron/watch-while-stopped.cjs), the
// watch rule, a restart, Stop everything, question A (the loss limit's "stop": Sells keep working, Buys wait), each
// guardrail while stopped for a Sell and a Buy, and the off pin. A real LiveEngine on a fake broker; made-up account,
// symbol, prices and days. No AI call is made (the provider counts its calls).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const AL=require('../electron/auto-launch.cjs');const WS=require('../electron/watch-while-stopped.cjs');
const SYM='123450';
// db: pass one to model a restart (a second app over the same database).
function world({db=new DatabaseSync(':memory:'),place=()=>({brokerOrderId:'9001'}),config={},hooks={}}={}){
  let snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:10000000,settledCash:10000000,holdings:[{symbol:SYM,name:'F',quantity:10,cost:1000,price:1000}]};
  const placed=[];const broker={request:async(op)=>{if(op==='prepare-order'){await hooks.prepare?.();}if(op==='place-order')await hooks.place?.();if(op==='prepare-order')return {ticket:'t',balance:{...snapshot,timestamp:new Date().toISOString()},checkedAt:Date.now()};if(op==='place-order'){const r=place();if(r instanceof Error)throw r;placed.push(r);return r;}return {};}};
  const live=new LiveEngine(db,broker,()=>({status:'connected',snapshot}));
  live.context=async()=>({environment:'kis',market:'KR',currency:'KRW',equity:10000000,cash:10000000,positions:Object.fromEntries(snapshot.holdings.map(h=>[h.symbol,{quantity:h.quantity}])),universe:[{symbol:SYM,price:1000}],quotes:[{symbol:SYM,price:1000,timestamp:Date.now(),stale:false}],orders:[],marketSession:{open:true,status:'open'}});
  const ai={calls:0};const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:SYM,name:'F',price:1000}],()=>[]),{request:async()=>{ai.calls++;throw new Error('no AI call expected');}},(id,kind,title,body)=>events.push({title,body}));
  a.live=live;a.usLive=null;const priced={n:0};a.placementPrice=async()=>{priced.n++;return {price:1000};};a.emergencyState=()=>({active:false});const price={now:1000};a.marketQuotes=()=>[{symbol:SYM,price:price.now,timestamp:Date.now()}];
  a.configure({scope:'kis',conditionalOrders:true,conditionalAutoSubmit:true,...config});
  const policy=()=>live.configure({symbols:[SYM],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  // Start, as auto-launch.start does it, without its AI and budget checks.
  const start=()=>{policy();live.enableAuto('ENABLE AUTO MOCK');a.configure({enabled:true,autoSubmit:true});a.sessionArmed=true;a.pausedByRestart=false;a.watchStarted();};
  const arm=(side,{purpose=side==='Buy'?'entry':'stop_loss'}={})=>{a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:SYM,side,quantity:1,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:side==='Buy'?'>=':'<=',value:side==='Buy'?999:1001}],combine:'all',purpose,expiresInHours:24,reason:'Fixture'},{config:a.config,universe:[SYM]});
    return a.desk.orders(a.watchScope()).filter(o=>o.side===side).at(-1);};
  const fire=async order=>{a.syncConditionalPermits();await a.fireConditional(order);return a.desk.rows('conditional_orders',a.watchScope()).find(o=>o.id===order.id);};
  return {db,a,live,ai,events,placed,priced,price,start,policy,arm,fire,on:()=>a.setWatchWhileStopped(true,'WATCH WHILE STOPPED MOCK'),setSnapshot:s=>{snapshot={...snapshot,...s};}};
}
// The Stop reply of 1.5.73, for the off pin.
const reply173=n=>`Auto trading stopped. Orders already at KIS stay. Your ${n} armed ${n===1?'stop':'stops'} (${SYM}) ${n===1?'is':'are'} not watched until you start it again.`;

test('off pin: with the setting off, Stop, the watch, the permit, a fire and a restart are as in 1.5.73',async()=>{
  const w=world();w.start();assert.equal(w.a.conditionalMonitoringActive(),true,'running: watched');w.arm('Sell');
  const said=AL.stop(w.a);assert.equal(said,reply173(1));
  w.a.syncConditionalPermits();assert.equal(w.a.conditionalMonitoringActive(),false);assert.equal(w.live.conditionalPermit,null);assert.deepEqual(w.a.watchedSymbols('KR'),[]);
  assert.equal(w.a.schedulerStatus().label,'Manual reviews only');assert.equal(w.a.deskState().monitoringActive,false);
  const o=await w.fire(w.a.desk.orders(w.a.watchScope())[0]);assert.equal(o.status,'rejected');assert.match(o.outcome,/KIS_TRADING_DISABLED/);assert.equal(w.placed.length,0);
  const r=world({db:w.db});assert.equal(r.a.conditionalMonitoringActive(),false,'after a restart');assert.equal(r.a.schedulerStatus().label,'Manual reviews only');assert.equal(r.a.watchStopped.get(),null);
  // A restart while running (Windows restarted the PC): paused after restart, nothing watched.
  const run=world();run.start();run.arm('Sell');const back=world({db:run.db});back.a.tick();assert.equal(back.a.schedulerStatus().label,'Paused after restart');assert.equal(back.a.conditionalMonitoringActive(),false);assert.equal(back.live.conditionalPermit,null);
  assert.equal(w.ai.calls+r.ai.calls+run.ai.calls+back.ai.calls,0);
});
test('the consent: the phrase names the environment; it needs a connection; it is void for another account or environment',()=>{
  const w=world();assert.throws(()=>w.a.setWatchWhileStopped(true,'WATCH WHILE STOPPED LIVE'),/APPROVAL_REQUIRED/);assert.throws(()=>w.a.setWatchWhileStopped(true),/APPROVAL_REQUIRED/);
  w.on();assert.equal(w.a.watchStopped.get().account,'acct');assert.equal(w.a.watchStopped.get().environment,'mock');assert.equal(w.a.watchingWhileStopped(),true);
  // The same account key on the live environment: the mock consent does not hold, and is void.
  w.setSnapshot({environment:'live'});assert.equal(w.a.watchingWhileStopped(),false);w.a.syncConditionalPermits();assert.equal(w.a.watchStopped.get(),null,'void');
  w.setSnapshot({environment:'mock'});assert.equal(w.a.watchingWhileStopped(),false,'switching back does not restore it');
  w.on();w.setSnapshot({accountKey:'other'});w.a.syncConditionalPermits();assert.equal(w.a.watchStopped.get(),null,'another account voids it');assert.ok(w.events.some(e=>e.title==='Conditional orders · not watched while stopped'));
  const d=world();d.live.getConnection=()=>({status:'disconnected',snapshot:null});assert.throws(()=>d.on(),/KIS_NOT_CONNECTED/);
  // Disconnected and the same account back: still on (a connection drop is not a switch).
  const k=world();k.on();const real=k.live.getConnection;k.live.getConnection=()=>({status:'disconnected',snapshot:null});k.a.syncConditionalPermits();assert.ok(k.a.watchStopped.get());k.live.getConnection=real;assert.equal(k.a.watchingWhileStopped(),true);
  w.a.setWatchWhileStopped(false);assert.equal(w.a.watchStopped.get(),null);
});
test('watched while stopped: proposed only with no record; sent by itself with the record of the last Start',async()=>{
  const w=world();w.policy();w.on();assert.equal(w.a.watchStopped.get().record,null,'turned on while stopped, never started');
  let o=await w.fire(w.arm('Sell'));assert.equal(o.status,'proposed');assert.equal(w.placed.length,0);assert.equal(w.live.conditionalPermit.auto,false);
  w.start();assert.deepEqual(w.a.watchStopped.get().record.markets,{KR:true,US:false});AL.stop(w.a);
  o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted');assert.equal(w.placed.length,1);assert.equal(w.ai.calls,0);
  // A review's order and your ticket are still refused while stopped.
  assert.throws(()=>w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000}),/KIS_TRADING_DISABLED/);
});
test('the record: the live "Submit them automatically" only downgrades; a market not in scope is proposed only',async()=>{
  const w=world();w.on();w.start();AL.stop(w.a);w.a.configure({conditionalAutoSubmit:false});
  let o=await w.fire(w.arm('Sell'));assert.equal(o.status,'proposed','downgraded');
  w.a.configure({conditionalAutoSubmit:true});assert.equal(w.a.autoWhileStopped('KR'),true,'back to the record');
  // Started with it off: turning it on while stopped does not upgrade.
  const n=world({config:{conditionalAutoSubmit:false}});n.on();n.start();AL.stop(n.a);n.a.configure({conditionalAutoSubmit:true});o=await n.fire(n.arm('Sell'));assert.equal(o.status,'proposed','no upgrade');
  // Saved while running: the record follows it.
  const r=world({config:{conditionalAutoSubmit:false}});r.on();r.start();r.a.configure({conditionalAutoSubmit:true});assert.equal(r.a.watchStopped.get().record.conditionalAutoSubmit,true);
  // One market automatic, the other not; a scope that no longer holds the market.
  const row={record:{autoSubmit:true,conditionalAutoSubmit:true,markets:{KR:true,US:false},scope:'both'}};
  assert.equal(WS.autoWhileStopped(row,{conditionalAutoSubmit:true,scope:'both'},'KR'),true);assert.equal(WS.autoWhileStopped(row,{conditionalAutoSubmit:true,scope:'both'},'US'),false);
  assert.equal(WS.autoWhileStopped(row,{conditionalAutoSubmit:true,scope:'us'},'KR'),false);assert.equal(WS.autoWhileStopped(null,{conditionalAutoSubmit:true,scope:'kis'},'KR'),false);
  assert.deepEqual(WS.recordOf({config:{scope:'kis',autoSubmit:true,conditionalAutoSubmit:true},engines:{KR:{enabled:true,autoEnabled:false},US:{enabled:true,autoEnabled:true}}}).markets,{KR:false,US:false},'KR not automatic, US not in scope');
  // The record of another account is never read: a switch voids the whole row.
  w.setSnapshot({accountKey:'other'});w.a.syncConditionalPermits();assert.equal(w.a.autoWhileStopped('KR'),false);
});
test('a restart: watched at once when the consent matches, no Start and no AI call; Stop everything survives it',async()=>{
  const w=world();w.on();w.start();
  const r=world({db:w.db});r.policy();r.live.stop();assert.equal(r.a.sessionArmed,false);assert.equal(r.a.watchingWhileStopped(),true);r.a.tick();assert.ok(r.live.conditionalPermit,'the tick gives the permit');
  const o=await r.fire(r.arm('Sell'));assert.equal(o.status,'submitted');assert.equal(r.ai.calls,0);
  r.a.stopEverything();assert.equal(r.a.watchingWhileStopped(),false);assert.equal(r.live.conditionalPermit,null);
  const again=world({db:w.db});assert.equal(again.a.watchingWhileStopped(),false,'still stopped after a restart');assert.equal(again.a.conditionalMonitoringActive(),false);
  again.on();assert.equal(again.a.watchingWhileStopped(),true,'turned on again');again.a.stopEverything();again.start();assert.equal(again.a.watchStopped.get().everythingStopped,false,'Start ends it');
});
test('question A: the loss limit\'s "stop" trips; Sells keep working, Buys wait, and fire the next day; the setting off ends both',async()=>{
  const w=world({config:{lossAction:'stop'}});w.on();w.start();const sell=w.arm('Sell'),buy=w.arm('Buy');
  w.a.emergencyState=()=>({active:true,activeMarkets:['KR']});w.a.tick();assert.equal(w.a.config.enabled,false,'auto trading stopped by the trip');assert.equal(w.a.conditionalMonitoringActive(),true,'still watched');
  let b=await w.fire(buy);assert.equal(b.status,'armed');assert.equal(b.waiting,'the daily loss limit is reached');assert.ok(b.nextCheckAt>Date.now()+200000);
  const s=await w.fire(sell);assert.equal(s.status,'submitted','a stop still sells');w.live.save({...w.live.orders()[0],status:'Filled',filled:1});
  w.a.emergencyState=()=>({active:false});b=await w.fire(w.a.desk.orders(w.a.watchScope()).find(o=>o.id===buy.id));assert.equal(b.status,'submitted','the next day: sent');
  // The limit reached while already stopped: the same.
  const x=world({config:{lossAction:'stop'}});x.on();x.start();AL.stop(x.a);x.a.emergencyState=()=>({active:true,activeMarkets:['KR']});assert.equal((await x.fire(x.arm('Buy'))).waiting,'the daily loss limit is reached');
  // Setting off: the trip ends the watch as in 1.5.73.
  const off=world({config:{lossAction:'stop'}});off.start();off.a.emergencyState=()=>({active:true,activeMarkets:['KR']});off.a.tick();assert.equal(off.a.conditionalMonitoringActive(),false);
  assert.equal(w.ai.calls+x.ai.calls+off.ai.calls,0);
});
test('the other automatic stop (consecutive failed reviews) leaves the watch on with the setting on',()=>{
  const w=world({config:{maxConsecutiveFailures:1}});w.on();w.start();w.a.trip('auto-stopped','Auto trading stopped after 1 consecutive failed reviews (fixture).');
  assert.equal(w.a.autoTradingRuns(),false);assert.equal(w.a.conditionalMonitoringActive(),true);w.a.syncConditionalPermits();assert.equal(w.live.conditionalPermit?.auto,true);
});
test('guardrails while stopped, for a Sell and a Buy, as while running',async()=>{
  // The daily automatic order cap: a Buy past it is proposed; a closing Sell is not held back.
  {const w=world({config:{maxAutoOrdersPerDay:1}});w.on();w.start();AL.stop(w.a);
    assert.equal((await w.fire(w.arm('Buy'))).status,'submitted');w.live.save({...w.live.orders()[0],status:'Filled',filled:1});
    const b=await w.fire(w.arm('Buy'));assert.equal(b.status,'proposed');assert.match(b.outcome,/daily automatic order limit reached/);
    assert.equal((await w.fire(w.arm('Sell'))).status,'submitted','closing: not held');}
  // The loss limit's other responses: "block-buys" rejects the Buy and sends the Sell; "review" sends both.
  {const w=world({config:{lossAction:'block-buys'}});w.on();w.start();AL.stop(w.a);w.a.emergencyState=()=>({active:true,activeMarkets:['KR']});
    const b=await w.fire(w.arm('Buy'));assert.equal(b.status,'rejected');assert.match(b.outcome,/New buys are blocked after the daily loss limit/);
    assert.equal((await w.fire(w.arm('Sell'))).status,'submitted');}
  {const w=world({config:{lossAction:'review'}});w.on();w.start();AL.stop(w.a);w.a.emergencyState=()=>({active:true,activeMarkets:['KR']});
    assert.equal((await w.fire(w.arm('Buy'))).status,'submitted');}
  // Buys wait while the orders made outside the app are not known; a stop still sells. A known block refuses the Buy.
  {const w=world();w.on();w.start();AL.stop(w.a);w.live.buybackBlock=()=>({unknown:true,market:'KR',why:'not read yet'});
    const b=await w.fire(w.arm('Buy'));assert.equal(b.status,'armed');assert.equal(b.waiting,'the orders you made outside the app are not read yet');
    assert.equal((await w.fire(w.arm('Sell'))).status,'submitted');
    w.live.save({...w.live.orders().find(x=>x.status==='Accepted'),status:'Filled',filled:1});// the Sell done: one open order at a time
    w.live.buybackBlock=s=>s===SYM?{symbol:SYM,soldOn:'2026-10-05',blockedUntil:'2026-11-04'}:null;const k=await w.fire(w.a.desk.orders(w.a.watchScope()).find(o=>o.side==='Buy'));assert.equal(k.status,'rejected');assert.match(k.outcome,/you sold 123450 outside the app/);}
  // Expiry: an armed order past its time is not watched or fired.
  {const w=world();w.on();w.start();AL.stop(w.a);const o=w.arm('Sell');w.db.prepare("UPDATE conditional_orders SET payload=json_set(payload,'$.expiresAt',?) WHERE id=?").run(Date.now()-1000,o.id);
    assert.equal(w.a.desk.orders(w.a.watchScope()).some(x=>x.id===o.id),false,'expired: not armed');}
});
test('an unclear order: no permit for the market until KIS order history settles it, then again if the consent matches',async()=>{
  const w=world({place:()=>new Error('TIMEOUT')});w.on();w.start();AL.stop(w.a);
  const o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted');assert.equal(o.unconfirmed,true);assert.equal(w.live.conditionalPermit,null,'revoked by the halt');
  w.a.syncConditionalPermits();assert.equal(w.live.conditionalPermit,null,'not given back while unclear');
  const u=w.live.orders().find(x=>x.status==='Uncertain');w.live.save({...u,status:'Filled',filled:1});w.a.syncConditionalPermits();assert.ok(w.live.conditionalPermit,'settled: given back');
  w.setSnapshot({accountKey:'other'});w.a.syncConditionalPermits();assert.equal(w.live.conditionalPermit,null,'not for another account');
});
test('a day rollover while stopped: the engine takes the new day from the balance it reads at sending',async()=>{
  const w=world();w.on();w.start();AL.stop(w.a);const p=w.live.policy();w.live.writePolicy('acct',{...p,day:'2000-01-01'});
  const o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted');assert.notEqual(w.live.policy().day,'2000-01-01');
});
test('a watch order keeps its conditional order: annotate sets conditionalId once',()=>{
  const w=world();w.policy();const p=w.live.propose({symbol:SYM,side:'Sell',quantity:1,limitPrice:1000},{conditional:true});
  w.live.annotate(p.id,{conditionalId:'c1'});w.live.annotate(p.id,{conditionalId:'c1',tracking:{bound:900}});assert.throws(()=>w.live.annotate(p.id,{conditionalId:'c2'}),/INVALID_REQUEST/);
});
test('the setting is kept outside the saved settings: no key in the config, no change to the start token',()=>{
  const w=world();const before=AL.launchState(w.a).token;w.on();assert.equal(AL.launchState(w.a).token,before);assert.equal('watchWhileStopped' in w.a.config,false);
  assert.equal(Object.keys(w.a.config).some(k=>/WhileStopped/i.test(k)),false);
});
// B-3 review, finding 1: the record is the switches as they were when auto trading stopped.
const proposedAfter=async(w,change)=>{change();const running=await w.fire(w.arm('Sell'));assert.equal(running.status,'proposed','while running: awaits approval');
  AL.stop(w.a);const stopped=await w.fire(w.arm('Sell'));const back=world({db:w.db});back.policy();back.live.stop();const restarted=await back.fire(back.arm('Sell'));
  return [stopped.status,restarted.status,w.placed.length+back.placed.length];};
test('review fix 1: a switch turned off while running stays off after Stop and after a restart',async()=>{
  // A market's automatic switch (live:auto-off and us:auto-off update the record in main.cjs).
  let w=world();w.on();w.start();assert.deepEqual(await proposedAfter(w,()=>{w.live.autoEnabled=false;w.a.refreshWatchRecord();}),['proposed','proposed',0]);
  // Auto trading's automatic submission saved off.
  w=world();w.on();w.start();assert.deepEqual(await proposedAfter(w,()=>w.a.configure({autoSubmit:false})),['proposed','proposed',0]);
  // "Submit them automatically" saved off.
  w=world();w.on();w.start();assert.deepEqual(await proposedAfter(w,()=>w.a.configure({conditionalAutoSubmit:false})),['proposed','proposed',0]);
  const main=require('fs').readFileSync(require('path').join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(main,/const liveAction=action=>async\(event,\.\.\.args\)=>\{authorize\(event\);try\{const data=await action\(\.\.\.args\);try\{automation\.refreshWatchRecord\?\.\(\);\}catch\{\}/,'every live: switch');
  assert.match(main,/if\(\['configure','stop','auto','auto-off'\]\.includes\(name\)\)try\{automation\.refreshWatchRecord\?\.\(\);\}catch\{\}/,'every us: switch');
  assert.match(main,/ipcMain\.handle\('live:auto-off',liveAction\(/);
});
test('review fix 1: Stop and each automatic stop take the record before clearing the switches',()=>{
  // A switch changed with no refresh (the worst case): Stop still records it as it was.
  let w=world();w.on();w.start();w.live.autoEnabled=false;AL.stop(w.a);assert.equal(w.a.watchStopped.get().record.markets.KR,false,'Stop');
  w=world({config:{maxConsecutiveFailures:1}});w.on();w.start();w.live.autoEnabled=false;w.a.trip('auto-stopped','fixture');assert.equal(w.a.watchStopped.get().record.markets.KR,false,'failed reviews');
  w=world({config:{lossAction:'stop'}});w.on();w.start();w.live.autoEnabled=false;w.a.emergencyState=()=>({active:true,activeMarkets:['KR']});w.a.tick();assert.equal(w.a.config.enabled,false);assert.equal(w.a.watchStopped.get().record.markets.KR,false,'the loss limit');
  // Unchanged switches: nothing is written (no write on every refresh).
  w=world();w.on();w.start();const at=w.a.watchStopped.get().record.at;w.a.refreshWatchRecord();assert.equal(w.a.watchStopped.get().record.at,at);
});
test('review fix 2: a Buy waiting at the loss limit reads no order book and logs one line over three re-checks',async()=>{
  const w=world({config:{lossAction:'stop'}});w.on();w.start();AL.stop(w.a);w.a.emergencyState=()=>({active:true,activeMarkets:['KR']});const buy=w.arm('Buy');
  for(let i=0;i<3;i++)await w.fire(w.a.desk.orders(w.a.watchScope()).find(o=>o.id===buy.id));
  assert.equal(w.priced.n,0,'not priced');assert.equal(w.events.filter(e=>e.title==='Conditional order · waiting').length,1);
});
test('review fix 3: a stop on an account where auto trading never started stays armed; a restart on a new day with no Start sends it',async()=>{
  const w=world();w.on();const o=await w.fire(w.arm('Sell'));assert.equal(o.status,'armed');assert.equal(o.waiting,'auto trading has not been started on this account');assert.equal(w.placed.length,0);assert.equal(w.priced.n,0);
  // Started on an earlier day, stopped, then the app restarts on a new day with no Start.
  const d=world();d.on();d.start();AL.stop(d.a);d.live.writePolicy('acct',{...d.live.policy(),day:'2000-01-01'});
  const n=world({db:d.db});n.live.stop();assert.equal(n.live.policy().day,'2000-01-01');const s=await n.fire(n.arm('Sell'));assert.equal(s.status,'submitted');assert.equal(n.placed.length,1);assert.notEqual(n.live.policy().day,'2000-01-01');
});
test('review point 4: Start, Stop or Stop everything pressed while a fire is in flight',async()=>{
  const gate=()=>{let open;const p=new Promise(r=>{open=r;});return {wait:()=>p,open:()=>open()};};
  // Stop everything while KIS checks the order: nothing is sent; no permit.
  {const g=gate();const w=world({hooks:{prepare:g.wait}});w.on();w.start();AL.stop(w.a);const firing=w.fire(w.arm('Sell'));await new Promise(r=>setImmediate(r));
    w.a.stopEverything();g.open();const o=await firing;assert.equal(w.placed.length,0);assert.notEqual(o.status,'submitted');assert.equal(w.live.conditionalPermit,null);}
  // Stop (the setting on) while KIS checks it: the watch goes on, so it is sent once.
  {const g=gate();const w=world({hooks:{prepare:g.wait}});w.on();w.start();const firing=w.fire(w.arm('Sell'));await new Promise(r=>setImmediate(r));
    AL.stop(w.a);g.open();assert.equal((await firing).status,'submitted');assert.equal(w.placed.length,1);w.a.syncConditionalPermits();assert.equal(w.live.conditionalPermit?.auto,true);}
  // Start while the order is being sent: refused (the engine is busy; auto-launch.start refuses the same, "An order is
  // being processed"); the order is sent once.
  {const g=gate();const w=world({hooks:{prepare:g.wait}});w.on();w.start();AL.stop(w.a);const firing=w.fire(w.arm('Sell'));await new Promise(r=>setImmediate(r));
    assert.equal(w.live.busy,true);assert.throws(()=>w.start(),/KIS_ORDER_BUSY/);g.open();assert.equal((await firing).status,'submitted');assert.equal(w.placed.length,1);}
  // Start while the fire reads the account, before anything is proposed: sent once, under Start's switches and record.
  {const g=gate();const w=world();w.on();w.start();AL.stop(w.a);const ctx=w.live.context;w.live.context=async(...x)=>{await g.wait();return ctx(...x);};
    const firing=w.fire(w.arm('Sell'));await new Promise(r=>setImmediate(r));w.start();g.open();
    assert.equal((await firing).status,'submitted');assert.equal(w.placed.length,1);assert.equal(w.a.autoTradingRuns(),true);assert.equal(w.a.watchStopped.get().everythingStopped,false);assert.equal(w.a.watchStopped.get().record.markets.KR,true);}
  // Stop everything while the order is being placed: it was already sent, once.
  {const g=gate();const w=world({hooks:{place:g.wait}});w.on();w.start();AL.stop(w.a);const firing=w.fire(w.arm('Sell'));for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
    w.a.stopEverything();g.open();await firing;assert.equal(w.placed.length,1);assert.equal(w.live.conditionalPermit,null);}
});
// B-3 second review, finding 1: a market's trading enabled by hand after Stop keeps the record deciding.
test('review 2 fix 1: Stop, then a market\'s trading enabled by hand (live:configure, us:configure): the watch still sends by itself',async()=>{
  const w=world();w.on();w.start();AL.stop(w.a);w.policy();assert.equal(w.live.enabled,true);assert.equal(w.live.autoEnabled,false);
  const o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted');assert.equal(w.placed.length,1);
  // In that state a review's order and your ticket are as in 1.5.73: proposed, not sent by itself; the ticket is sent with your approval.
  w.live.save({...w.live.orders().find(x=>x.status==='Accepted'),status:'Filled',filled:1});
  const review=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});await assert.rejects(w.live.autoSubmit(review.id),/AUTO_KIS_DISABLED/);
  const ticket=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000},{ticket:true});assert.equal((await w.live.submit(ticket.id,'PLACE MOCK ORDER')).status,'Accepted');
  // The U.S. account the same way.
  const {LiveEngine}=require('../electron/live-engine.cjs');const US='NASD:ABCD';const usSnap={accountKey:'acct:US',environment:'mock',reportedTotal:10000,cash:10000,settledCash:10000,holdings:[{symbol:US,name:'U',quantity:5,cost:10,price:10}]};const usPlaced=[];
  const us=new LiveEngine(w.db,{request:async op=>op==='prepare-order'?{ticket:'u',balance:{...usSnap,timestamp:new Date().toISOString()},checkedAt:Date.now()}:op==='place-order'?(usPlaced.push(1),{brokerOrderId:'u1'}):{}},()=>({status:'connected',snapshot:usSnap}),{market:'US'});
  us.context=async()=>({environment:'kis',market:'US',currency:'USD',equity:10000,cash:10000,positions:{[US]:{quantity:5}},universe:[{symbol:US,price:10}],quotes:[{symbol:US,price:10,timestamp:Date.now(),stale:false}],orders:[],marketSession:{open:true,status:'open'}});
  const b=world();b.a.usLive=us;b.a.refreshUS=async()=>null;b.a.placementPrice=async()=>({price:10});b.a.configure({scope:'both'});b.on();
  const usPolicy=()=>us.configure({symbols:[US],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  b.start();usPolicy();us.enableAuto('ENABLE AUTO MOCK');b.a.refreshWatchRecord();assert.equal(b.a.watchStopped.get().record.markets.US,true);AL.stop(b.a);usPolicy();assert.equal(us.enabled,true);
  b.a.desk.setOrder(b.a.watchScope(),{action:'add',id:'',symbol:US,side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:`price("${US}")`,op:'<=',value:11}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Fixture'},{config:b.a.config,universe:[US]});
  const uo=await b.fire(b.a.desk.orders(b.a.watchScope()).find(x=>x.symbol===US));assert.equal(uo.status,'submitted');assert.equal(usPlaced.length,1);
});
// Finding 2: an engine stopped while auto trading runs (a reconnect, the unclear-order halt) leaves its market's entry.
test('review 2 fix 2: after a reconnect or the unclear-order halt while running, a handler leaves the record; the Sell is sent as before',async()=>{
  // A reconnect stops both engines and revokes the permits (main.cjs), with auto trading still running.
  let w=world();w.on();w.start();const before=JSON.stringify(w.a.watchStopped.get().record.markets);
  w.live.stop();w.live.revokeConditional();assert.equal(w.a.autoTradingRuns(),true);w.a.refreshWatchRecord();assert.equal(JSON.stringify(w.a.watchStopped.get().record.markets),before,'unchanged');
  let o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted','sent by itself, as before the reconnect');
  // The unclear-order halt, then a handler, then the order settled.
  w=world({place:()=>new Error('TIMEOUT')});w.on();w.start();const halt=await w.fire(w.arm('Sell'));assert.equal(halt.unconfirmed,true);assert.equal(w.live.enabled,false);
  w.a.refreshWatchRecord();assert.equal(w.a.watchStopped.get().record.markets.KR,true,'unchanged by the halt');
  const u=w.live.orders().find(x=>x.status==='Uncertain');w.live.save({...u,status:'Filled',filled:1});
  const w2=world({db:w.db});w2.a.sessionArmed=true;w2.a.configure({enabled:true,autoSubmit:true});w2.live.stop();o=await w2.fire(w2.arm('Sell'));assert.equal(o.status,'submitted');
  // A switch the user turns off while the market trades still writes its entry.
  w=world();w.on();w.start();w.live.autoEnabled=false;w.a.refreshWatchRecord();assert.equal(w.a.watchStopped.get().record.markets.KR,false);
});
test('review 3: while auto trading runs with the engine enabled, the live automatic switch decides, refreshed or not',async()=>{
  // The switch set off with no refresh (the record still says automatic): proposed, as in 1.5.73.
  let w=world();w.on();w.start();w.live.autoEnabled=false;assert.equal(w.a.watchStopped.get().record.markets.KR,true);
  let o=await w.fire(w.arm('Sell'));assert.equal(o.status,'proposed');assert.equal(w.placed.length,0);
  // Stop, then the market's trading enabled by hand: the record decides (sent by itself).
  w=world();w.on();w.start();AL.stop(w.a);w.policy();o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted');
  // A reconnect while running: the engine stopped, the record decides (sent by itself).
  w=world();w.on();w.start();w.live.stop();w.live.revokeConditional();o=await w.fire(w.arm('Sell'));assert.equal(o.status,'submitted');
});
// B-4: the words, the state Home reads, Stop everything, the install refusal, the start notice.
const lines=()=>import('../src/unwatched-orders.mjs');
test('B-4: the Stop reply with the setting on says what is watched and how it is sent; Stop everything has its own',async()=>{
  const w=world();w.on();w.start();w.arm('Sell');w.arm('Buy');
  assert.equal(AL.stop(w.a),'Auto trading stopped. Orders already at KIS stay. Your 2 armed orders are still watched (1 buy) and are sent by themselves if their conditions are met. To stop them too, use Stop everything.');
  const p=world({config:{conditionalAutoSubmit:false}});p.on();p.start();p.arm('Sell');
  assert.equal(AL.stop(p.a),'Auto trading stopped. Orders already at KIS stay. Your 1 armed order is still watched: if its conditions are met it is only proposed for your approval. To stop them too, use Stop everything.');
  assert.equal(w.a.stopEverything(),'Everything stopped. No order will be sent by the app; orders already at KIS stay.');
  assert.equal(AL.watchedWords({buys:1,sentByThemselves:2,proposedOnly:1,notStarted:['NASD:ABCD']}),'Your 3 armed orders are still watched (1 buy): 2 sent by themselves, 1 only proposed for your approval. Not watched until you start auto trading on this account: NASD:ABCD.');
});
test('B-4: Home: watched while stopped, the loss limit, Stop everything, not connected, the off pin, and the capacity line',async()=>{
  const {whileStoppedLines,unwatchedLine,capacityLine}=await lines();const st=w=>({config:w.a.config,desk:w.a.deskState()});
  const w=world();w.on();w.start();w.arm('Sell');AL.stop(w.a);
  assert.deepEqual(whileStoppedLines(st(w)),{block:null,info:'Auto trading is stopped. Your 1 armed order is still watched and is sent by itself if its conditions are met.'});assert.equal(unwatchedLine(st(w)),null);
  w.a.configure({conditionalAutoSubmit:false});w.a.configure({conditionalAutoSubmit:true});assert.equal(whileStoppedLines(st(w)).info.includes('takes effect'),false,'record on: nothing waits for Start');
  const l=world({config:{lossAction:'stop'}});l.on();l.start();l.arm('Sell');l.arm('Buy');AL.stop(l.a);l.a.emergencyState=()=>({active:true,activeMarkets:['KR']});
  assert.equal(whileStoppedLines(st(l)).block,'Daily loss limit reached: auto trading stopped. 1 closing order is still watched; 1 buy waits.');
  w.a.stopEverything();assert.equal(whileStoppedLines(st(w)).block,'Everything stopped: no order is watched.');assert.equal(unwatchedLine(st(w)),null);
  const d=world();d.on();d.start();d.arm('Sell');AL.stop(d.a);d.live.getConnection=()=>({status:'disconnected',snapshot:null});assert.equal(whileStoppedLines(st(d)).block,'Orders not watched: KIS is not connected.');
  // "Submit them automatically" turned on while stopped after a Start with it off: it waits for the next Start.
  const t=world({config:{conditionalAutoSubmit:false}});t.on();t.start();t.arm('Sell');AL.stop(t.a);t.a.configure({conditionalAutoSubmit:true});assert.match(whileStoppedLines(st(t)).info,/"Submit them automatically" takes effect at the next Start\.$/);
  // Off: the 1.5.73 line, and no while-stopped line.
  const o=world();o.start();o.arm('Sell');AL.stop(o.a);assert.deepEqual(whileStoppedLines(st(o)),{block:null,info:null});assert.equal(unwatchedLine(st(o)),'1 stop is not watched until auto trading is started.');
  assert.equal(o.a.deskState().whileStopped.on,false);assert.equal('watchPermit' in o.live.getState(),false,'no permit, nothing new in the engine state');
  assert.equal(capacityLine({desk:{monitoringActive:true,outsidePolls:{KR:12,US:3}}}),'Korea: 12 armed stocks are outside the app\'s price lists; about 10 can be kept current, so their prices may age.');
  assert.equal(capacityLine({desk:{monitoringActive:true,outsidePolls:{KR:10,US:0}}}),null);assert.equal(w.a.deskState().outsidePolls.KR,0,'its stock is in the polled quotes');
  const n=world();n.on();n.arm('Sell');assert.deepEqual(n.a.deskState().whileStopped.notStarted,[SYM]);assert.match(whileStoppedLines(st(n)).info??'',/Not watched until you start auto trading on this account: 123450\./);
});
test('B-4: Activity and the phone say "while auto trading was stopped"; not while it runs',async()=>{
  const sent=[];const w=world();w.a.notify=(id,m)=>sent.push(m);w.on();w.start();AL.stop(w.a);const o=await w.fire(w.arm('Sell'));
  assert.match(o.outcome,/ Sent while auto trading was stopped\.$/);assert.deepEqual(sent,['Stop for 123450 fired while auto trading was stopped: Sell 1 sent.']);
  const p=world({config:{conditionalAutoSubmit:false}});const ps=[];p.a.notify=(id,m)=>ps.push(m);p.on();p.start();AL.stop(p.a);const q=await p.fire(p.arm('Buy'));
  assert.match(q.outcome,/Proposed while auto trading was stopped\.$/);assert.deepEqual(ps,['Conditional order for 123450 fired while auto trading was stopped: Buy 1 awaits your approval.']);
  const r=world();const rs=[];r.a.notify=(id,m)=>rs.push(m);r.on();r.start();const x=await r.fire(r.arm('Sell'));assert.doesNotMatch(x.outcome,/while auto trading was stopped/);assert.deepEqual(rs,[]);
});
test('B-4: the engine state shows the permit; the start notice says the orders are watched; installs are refused while watched',()=>{
  const w=world();w.on();w.start();AL.stop(w.a);w.a.syncConditionalPermits();assert.deepEqual(w.live.getState().watchPermit,{auto:true});
  const N=require('../electron/start-notice.cjs');const notice=N.startNotice({previousStop:{kind:'windows-shutdown',at:Date.now()-60000},stops:{count:2,any:true},wasRunning:false,watched:true});
  assert.equal(notice.title,'Paused: 2 stop orders watched');assert.match(notice.message,/The app started and auto trading is paused\. 2 stop orders are watched once KIS connects, with your other armed orders\. Press Start auto trading to resume reviews\.$/);
  assert.equal(N.startNotice({previousStop:{kind:'clean',at:Date.now()},stops:{count:1,any:true},wasRunning:false}).title,'Paused: 1 stop order not watched','off: unchanged');
  const fs=require('fs'),path=require('path'),main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(main,/if\(automation\.watchingWhileStopped\(\)&&automation\.desk\.orders\(automation\.watchScope\(\)\)\.length>0\)return 'ORDERS_WATCHED';/);
  assert.match(fs.readFileSync(path.join(__dirname,'..','src','AppUpdates.tsx'),'utf8'),/ORDERS_WATCHED:'Your armed orders are being watched while auto trading is stopped, and installing closes the app\. Use Stop everything, then install\.'/);
  assert.match(main,/ipcMain\.handle\('runtime:stop-everything'/);assert.match(main,/automation\.setWatchWhileStopped\(on===true,/);
  assert.match(fs.readFileSync(path.join(__dirname,'..','src','KeepWorking.tsx'),'utf8'),/setWatchWhileStopped\(value,value\?`WATCH WHILE STOPPED \$\{env\.toUpperCase\(\)\}`:undefined\)/,'the phrase names the environment the user was shown');
  assert.match(fs.readFileSync(path.join(__dirname,'..','src','AgentDesk.tsx'),'utf8'),/' · watched while stopped'/);
});
// B-4 review: passing causes under one open order at a time keep the order armed, running or stopped, and Home says why.
test('B-4 review 1: an unclear order or another open order in the market: the order waits armed (stopped and running), and Home says why',async()=>{
  const {whileStoppedLines}=await lines();const st=w=>({config:w.a.config,desk:w.a.deskState()});
  // Stopped: an unclear order in Korea.
  let w=world({place:()=>new Error('TIMEOUT')});w.on();w.start();AL.stop(w.a);await w.fire(w.arm('Sell'));assert.equal(w.live.orders()[0].status,'Uncertain');
  let o=await w.fire(w.arm('Sell'));assert.equal(o.status,'armed');assert.equal(o.waiting,'an earlier order in Korea is unclear');assert.ok(o.nextCheckAt>Date.now()+20000);
  let s=w.a.deskState().whileStopped;assert.equal(s.sentByThemselves,0);assert.deepEqual(s.waiting,[{why:'an earlier order in Korea is unclear',orders:1}]);
  assert.equal(whileStoppedLines(st(w)).info,'Auto trading is stopped. Your 1 armed order is still watched. 1 waits: an earlier order in Korea is unclear.');
  // Stopped: another app order open.
  w=world();w.on();w.start();AL.stop(w.a);assert.equal((await w.fire(w.arm('Sell'))).status,'submitted');o=await w.fire(w.arm('Sell'));
  assert.equal(o.status,'armed','the same stock with shares left: it waits, not priced');assert.equal(o.waiting,'another order in Korea is open');assert.equal(w.priced.n,1,'only the first sale was priced');
  o=await w.fire(w.arm('Buy'));assert.equal(o.status,'armed');assert.equal(o.waiting,'another order in Korea is open');assert.equal(w.placed.length,1);
  s=w.a.deskState().whileStopped;assert.deepEqual(s.waiting,[{why:'another order in Korea is open',orders:2}]);assert.equal(s.sentByThemselves,0);
  // Running (1.5.73 closed it as rejected): the same wait.
  w=world();w.start();assert.equal((await w.fire(w.arm('Sell'))).status,'submitted');o=await w.fire(w.arm('Buy'));assert.equal(o.status,'armed');assert.equal(o.waiting,'another order in Korea is open');
  w=world({place:()=>new Error('TIMEOUT')});w.start();await w.fire(w.arm('Sell'));o=await w.fire(w.arm('Buy'));assert.equal(o.status,'armed');assert.equal(o.waiting,'an earlier order in Korea is unclear');
  // An order opened between the check and the send: the engine's refusal keeps it armed, its proposal retired.
  w=world();w.start();w.live.autoSubmit=async()=>{throw new Error('RECONCILIATION_REQUIRED');};o=await w.fire(w.arm('Sell'));assert.equal(o.status,'armed');
  assert.equal(w.live.orders().find(x=>x.status==='Ready')?.reason,'SUPERSEDED');
});
test('B-4 review 2-5: another account shows the 1.5.73 line; the loss line counts closing orders; not on paper; the confirmation says restart and closing',async()=>{
  const {unwatchedLine}=await lines();const w=world();w.on();w.start();w.arm('Sell');AL.stop(w.a);w.setSnapshot({accountKey:'other'});
  w.a.desk.orders=()=>[{symbol:SYM,side:'Sell',purpose:'stop_loss'}];assert.equal(unwatchedLine({config:w.a.config,desk:{...w.a.deskState(),monitoringActive:false}}),'1 stop is not watched until auto trading is started.','before the next sync voids the row');
  const l=world({config:{lossAction:'stop'}});l.on();l.start();AL.stop(l.a);l.a.emergencyState=()=>({active:true,activeMarkets:['KR']});
  l.a.desk.orders=()=>[{symbol:SYM,side:'Sell'},{symbol:SYM,side:'Buy',credit:{kind:'cover'}},{symbol:SYM,side:'Buy'}];assert.deepEqual(l.a.whileStoppedState().lossLimit,{closing:2,buysWait:1},'a cover is a closing order');
  const p=world({config:{scope:'paper'}});assert.throws(()=>p.on(),/PAPER_SCOPE/);
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','src','KeepWorking.tsx'),'utf8');
  assert.match(src,/Stop everything halts all of them, and so does closing the app\. After the app restarts, they are watched again as soon as KIS connects, without pressing Start\./);
});
// B-4 second review: a stop hit and held counts as not covering; a waiting re-check makes no KIS request.
test('B-4 review 2-1: a stop hit and held behind another order is an unprotected holding, running and stopped, on the Desk and Home',async()=>{
  const {heldStopsLine}=await lines();
  for(const stopped of [false,true]){const w=world();if(stopped)w.on();w.start();
    const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',brokerOrderId:'9100'});if(stopped)AL.stop(w.a);
    const o=await w.fire(w.arm('Sell'));assert.equal(o.status,'armed');assert.equal(o.waiting,'another order in Korea is open');
    const u=w.a.deskState().unprotected.find(x=>x.symbol===SYM);assert.deepEqual({held:u.held,waiting:u.waiting,quantity:u.quantity},{held:true,waiting:'another order in Korea is open',quantity:1},stopped?'stopped':'running');
    assert.equal(heldStopsLine({desk:w.a.deskState()}),'123450 has no working stop loss: its stop was hit and is waiting (another order in Korea is open).');
    // Once the other order is done the stop is sent and the holding is no longer listed.
    w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Filled',filled:1});const s=await w.fire(w.a.desk.orders(w.a.watchScope()).find(x=>x.id===o.id));assert.equal(s.status,'submitted');
    assert.equal(w.a.deskState().unprotected.some(x=>x.held),false);}
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','review-gate.cjs'),'utf8');assert.match(src,/unprotected:\(desk\.unprotected\?\?\[\]\)\.filter\(u=>!u\.held\)\.map\(u=>u\.symbol\)/);
});
test('B-4 review 2-2: a waiting re-check reads no account context (no KIS request) and does not hold the fire flag through one',async()=>{
  const w=world();w.on();w.start();let reads=0;const ctx=w.live.context;w.live.context=async(...x)=>{reads++;return ctx(...x);};
  const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',brokerOrderId:'9101'});AL.stop(w.a);
  const stop=w.arm('Sell');for(let i=0;i<3;i++){const o=await w.fire(w.a.desk.orders(w.a.watchScope()).find(x=>x.id===stop.id));assert.equal(o.waiting,'another order in Korea is open');}
  assert.equal(reads,0);assert.equal(w.priced.n,0);
});
test('B-4 review 2: a linked plan stop behind its own partly filled purchase: the row, the Desk and Home',async()=>{
  const {heldStopsLine}=await lines();const w=world();w.start();
  const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:4,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Partially filled',filled:1,brokerOrderId:'9102'});
  const stop=w.arm('Sell');w.a.desk.update(stop,{linkedBuy:{id:buy.id,market:'KR'}});const o=await w.fire(w.a.desk.orders(w.a.watchScope()).find(x=>x.id===stop.id));
  assert.equal(o.status,'armed');assert.equal(o.waiting,'its purchase is still open');
  assert.equal(heldStopsLine({desk:w.a.deskState()}),'123450 has no working stop loss: its stop was hit and is waiting (its purchase is still open).');
  // Unfilled: the earlier words, and the stop has nothing to cover yet.
  w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',filled:0});const u=await w.fire(w.a.desk.orders(w.a.watchScope()).find(x=>x.id===stop.id));assert.equal(u.waiting,'its purchase has not filled');
});
// B-4 third review: held is decided live and the stored words go when it ends; the review context and the gate get the
// held stop as facts; a review's sale cannot double up with the waiting stop.
const tickOnce=async a=>{a.lastDeskCheck=0;a.tick();for(let i=0;i<50&&a.firing;i++)await new Promise(r=>setTimeout(r,2));await new Promise(r=>setImmediate(r));};
test('B-4 review 3-1: the held line through the real tick: hit and held, price recovers, the other order fills, hit again and sent',async()=>{
  const {heldStopsLine}=await lines();
  for(const stopped of [false,true]){const w=world();if(stopped)w.on();w.start();
    const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',brokerOrderId:'9200'});if(stopped)AL.stop(w.a);
    const stop=w.arm('Sell');const row=()=>w.a.desk.rows('conditional_orders',w.a.watchScope()).find(x=>x.id===stop.id);const line=()=>heldStopsLine({desk:w.a.deskState()});
    // 1. Hit with the Buy open: held, listed, the line shown.
    await tickOnce(w.a);assert.equal(row().waiting,'another order in Korea is open');assert.match(line()??'',/123450 has no working stop loss/,'step 1');
    // 2. The price recovers above the stop, the Buy still open: not hit now, so not held; the stored words cleared.
    w.price.now=1200;await tickOnce(w.a);assert.equal(line(),null,'step 2');assert.equal(row().waiting,null);assert.equal(row().status,'armed');
    // 3. The Buy fills, the price still above: nothing.
    w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Filled',filled:1});await tickOnce(w.a);assert.equal(line(),null,'step 3');assert.equal(row().waiting,null);
    // 4. Hit again with nothing open: not held, fired at once.
    w.price.now=1000;await tickOnce(w.a);assert.equal(line(),null,'step 4');
    // 5. Sent.
    assert.equal(row().status,'submitted',stopped?'stopped':'running');assert.equal(w.placed.length,1);}
});
test('B-4 review 3-2: the review context names a held stop with its cause and the order holding it; the gate asks one review per held episode',()=>{
  const RG=require('../electron/review-gate.cjs');const w=world();w.start();const ctxOf=()=>({agentDesk:w.a.desk.context(w.a.watchScope(),w.a.config,[SYM],{[SYM]:{quantity:10}},w.a.heldStopFacts())});
  const none=ctxOf();assert.equal('heldStops' in none.agentDesk.conditionalOrders,false,'nothing held: no key, zero bytes');
  const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',brokerOrderId:'9201'});const stop=w.arm('Sell');
  w.a.syncHolds();assert.ok(w.a.desk.orders(w.a.watchScope()).find(x=>x.id===stop.id).heldSince>0,'the tick stamps the episode');
  const held=ctxOf();const h=held.agentDesk.conditionalOrders.heldStops;assert.equal(h.length,1);
  assert.deepEqual({symbol:h[0].symbol,stopOrderId:h[0].stopOrderId,quantity:h[0].quantity,waitsFor:h[0].waitsFor},{symbol:SYM,stopOrderId:stop.id,quantity:1,waitsFor:{id:buy.id,side:'Buy',symbol:SYM,status:'Accepted'}});
  assert.equal(h[0].fact,`The stop loss for 123450 was hit and is still armed; it is not sent while another order in Korea is open (order ${buy.id}, Buy 123450, Accepted).`);
  const bytes=JSON.stringify(held.agentDesk.conditionalOrders).length-JSON.stringify(none.agentDesk.conditionalOrders).length;assert.ok(bytes>0&&bytes<1000,'bytes added: '+bytes);
  // The gate: a new held episode needs a review; once a review has seen it, not again while it lasts.
  const at=Date.now();const base={...RG.decisionState(none),at},next=RG.decisionState(held);
  const first=RG.compare(base,next,{now:at+1000});assert.ok(first.reasons.some(r=>r.kind==='protection'&&/123450: stop loss hit and waiting/.test(r.detail)),JSON.stringify(first.reasons));
  const again=RG.compare({...next,at},RG.decisionState(ctxOf()),{now:at+1000});assert.equal(again.reasons.some(r=>r.kind==='protection'),false,'the same episode');
  // No instruction text: the fingerprints are pinned elsewhere; nothing here adds a note.
  assert.equal(Object.keys(h[0]).sort().join(','),'fact,heldQuantity,quantity,since,stopOrderId,symbol,waitsFor');
});
test('B-4 review 3-3: a review\'s sale cannot double up with the waiting stop',async()=>{
  // A review sells every share: the stop ends "Not needed" (the existing free-shares rule), nothing more is sent.
  let w=world();w.start();const all=w.live.propose({symbol:SYM,side:'Sell',quantity:10,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===all.id),status:'Accepted',brokerOrderId:'9300'});
  let o=await w.fire(w.arm('Sell'));assert.equal(o.status,'cancelled');assert.match(o.outcome,/Not needed: a sale already waiting takes these shares/);assert.equal(w.placed.length,0);
  // A review sells 9 of 10: the stop (2 shares) waits; once that sale fills it sends only what is left (1).
  w=world();w.start();const part=w.live.propose({symbol:SYM,side:'Sell',quantity:9,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===part.id),status:'Accepted',brokerOrderId:'9301'});
  w.a.desk.setOrder(w.a.watchScope(),{action:'add',id:'',symbol:SYM,side:'Sell',quantity:2,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value:1001}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Fixture'},{config:w.a.config,universe:[SYM]});
  const stop=w.a.desk.orders(w.a.watchScope()).find(x=>x.quantity===2);o=await w.fire(stop);assert.equal(o.status,'armed');assert.equal(o.waiting,'another order in Korea is open');
  w.live.save({...w.live.orders().find(x=>x.id===part.id),status:'Filled',filled:9});w.setSnapshot({holdings:[{symbol:SYM,name:'F',quantity:1,cost:1000,price:1000}]});w.live.riskBalance=null;
  o=await w.fire(w.a.desk.orders(w.a.watchScope()).find(x=>x.id===stop.id));assert.equal(o.status,'submitted');assert.equal(w.live.orders().find(x=>x.madeBy==='conditional').quantity,1,'only what is left');
  // A review's own order is held by the same rule while the other order is open.
  w=world();w.start();const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',brokerOrderId:'9302'});
  const sale=w.live.propose({symbol:SYM,side:'Sell',quantity:1,limitPrice:1000});await assert.rejects(w.live.submit(sale.id,'PLACE MOCK ORDER'),/RECONCILIATION_REQUIRED/);assert.equal(w.placed.length,0);
});
test('B-4 review 4: a price hovering at the stop level is one held episode: one Activity line, one stamp, the same gate key; Home follows the live state',async()=>{
  const {heldStopsLine}=await lines();const w=world();w.start();
  const buy=w.live.propose({symbol:SYM,side:'Buy',quantity:1,limitPrice:1000});w.live.save({...w.live.orders().find(x=>x.id===buy.id),status:'Accepted',brokerOrderId:'9400'});
  const stop=w.arm('Sell');const row=()=>w.a.desk.rows('conditional_orders',w.a.watchScope()).find(x=>x.id===stop.id);const stamps=new Set(),lines2=[];
  for(let i=0;i<12;i++){w.price.now=i%2?1200:1000;await tickOnce(w.a);lines2.push(Boolean(heldStopsLine({desk:w.a.deskState()})));if(row().heldSince)stamps.add(row().heldSince);}
  assert.equal(w.events.filter(e=>e.title==='Conditional order · waiting').length,1,'one Activity line');assert.equal(stamps.size,1,'one episode stamp');
  assert.deepEqual(lines2,Array.from({length:12},(_,i)=>i%2===0),'Home follows the live state');assert.equal(row().status,'armed');assert.equal(w.placed.length,0);
});
