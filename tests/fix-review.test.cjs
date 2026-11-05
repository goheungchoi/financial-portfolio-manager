// Fix review of 1.5.48-stage5.2 (2026-11-05): regressions for its findings 1-3, each checked through its consumers
// (the valuation, the flow detector, flowsSince and the daily loss check), not only the stored fields.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const {settlement}=require('../electron/integrated-settlement.cjs');
const MIN=60000,HOUR=3600000,DAY=86400000,at=s=>Date.parse(s);

// The U.S. settlement tracker, reading by reading a minute apart; fx 1300, so a reported ₩130,000 is $100.
function tracker(){let t=at('2026-11-05T14:00:00Z');const db=new DatabaseSync(':memory:');let f=new InFlight(db,()=>t);
  return {see:(us,orders=[])=>{const r=f.observe('a',{us:{timestamp:new Date(t).toISOString(),...us},orders,fx:1300});t+=MIN;return r;},
    raw:(us,orders=[])=>f.observe('a',{us,orders,fx:1300}),restart:()=>{f=new InFlight(db,()=>t);},state:()=>JSON.parse(db.prepare('SELECT payload FROM inflight_settlement').get().payload),now:()=>t};}
const R=usd=>({buyKRW:usd*1300,sellKRW:0,krwFundedKRW:0});
const A={id:'A',side:'Buy',filled:1,fillPrice:100},B={id:'B',side:'Buy',filled:1,fillPrice:100};

// 1. Settlement evidence is used once, never before the fill it would clear.
test('finding 1: an unmatched reported total before a new fill is not its settlement; the fill stays in flight, unresolved',()=>{
  const x=tracker();x.see({cash:500});const before=x.see({cash:500,unsettled:R(100)});assert.equal(before.buysUSD,0);
  const r=x.see({cash:500,unsettled:R(100)},[A]);assert.equal(r.buysUSD,100,'the new $100 is kept');assert.equal(r.unresolved.buysUSD,100,'marked unresolved');
  assert.match(r.notes.join(' '),/before the app saw this fill/);
  const e=x.state().evidence;const unmatched=e.find(v=>v.kind==='unmatched');assert.equal(unmatched.channel,'reported');assert.deepEqual(unmatched.open,[],'no fill was open when it was seen');assert.deepEqual(unmatched.flagged,['A']);
  // The valuation does not count it twice while KIS reports $100: the in-flight part is beyond what KIS reports.
  const us={cash:500,unsettled:R(100),holdings:[],timestamp:new Date(x.now()).toISOString()};
  assert.equal(value({us,fx:{usdKRW:1300},inFlight:x.raw(us,[A]),now:x.now()}).markets.US.components.find(c=>c.name==='inFlightBuys'),undefined);
  // KIS settles the reported buy: cash and the reported total fall together, which resolves it.
  assert.equal(x.see({cash:400,unsettled:R(0)},[A]).buysUSD,0);assert.equal(x.state().evidence.at(-1).kind,'reported settlement');assert.deepEqual(x.state().evidence.at(-1).allocated.map(a=>a.id),['A']);
});
test('finding 1: a reported rise and a cash fall in one reading may be one purchase: one fill clears, the other stays unresolved',()=>{
  const x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);const r=x.see({cash:400,unsettled:R(100)},[A,B]);
  assert.equal(r.buysUSD,100,'not both cleared');assert.equal(r.unresolved.buysUSD,100);assert.equal(r.open[0].id,'B');assert.equal(r.open[0].unresolved.why,'cash and reported moved together');
  const kinds=x.state().evidence.map(e=>e.kind);assert.deepEqual(kinds,['settled','ambiguous']);
  // A later cash fall on its own is a separate event: it clears the remaining fill.
  assert.equal(x.see({cash:300,unsettled:R(100)},[A,B]).buysUSD,0);
});
test('finding 1: separate settlements in separate readings clear separate fills; a reported buy settling is not evidence for another',()=>{
  let x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);assert.equal(x.see({cash:500,unsettled:R(100)},[A,B]).buysUSD,100,'reported only: A');
  assert.equal(x.see({cash:400,unsettled:R(100)},[A,B]).buysUSD,0,'cash only, reported unchanged: B');
  x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);x.see({cash:500,unsettled:R(100)},[A,B]);
  const r=x.see({cash:400,unsettled:R(0)},[A,B]);assert.equal(r.buysUSD,100,'cash and reported fall together: A settling, not B');assert.equal(x.state().evidence.at(-1).kind,'reported settlement');
  // Cash-only and reported-only updates on their own.
  x=tracker();x.see({cash:500});x.see({cash:500},[A]);assert.equal(x.see({cash:400},[A]).buysUSD,0,'cash only');
  x=tracker();x.see({cash:500});x.see({cash:500},[A]);assert.equal(x.see({cash:500,unsettled:R(100)},[A]).buysUSD,0,'reported only');
  // Sales: the reported sale total rising clears an open sale; one that matches nothing is not carried forward.
  const S={id:'S',side:'Sell',filled:1,fillPrice:100};x=tracker();x.see({cash:500});x.see({cash:500,unsettled:{buyKRW:0,sellKRW:130000}});
  const s=x.see({cash:500,unsettled:{buyKRW:0,sellKRW:130000}},[S]);assert.equal(s.sellsUSD,100);assert.equal(s.unresolved.sellsUSD,100);
});
test('finding 1: repeated and out-of-order readings, and a restart between the two channels',()=>{
  let x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);x.see({cash:500,unsettled:R(100)},[A,B]);
  for(let i=0;i<3;i++)assert.equal(x.see({cash:500,unsettled:R(100)},[A,B]).buysUSD,100,'the same reading again changes nothing');
  const old=x.raw({cash:400,unsettled:R(100),timestamp:new Date(x.now()-HOUR).toISOString()},[A,B]);assert.equal(old.buysUSD,100);assert.match(old.notes[0],/older than the last one was ignored/);
  // Restart, then the reported buy settles (not evidence for B); restart, then B's own cash movement.
  x.restart();assert.equal(x.see({cash:400,unsettled:R(0)},[A,B]).buysUSD,100);x.restart();assert.equal(x.see({cash:300,unsettled:R(0)},[A,B]).buysUSD,0);
  const e=x.state().evidence;assert.ok(e.every(v=>Number.isFinite(v.at)&&v.id&&Array.isArray(v.open)&&Array.isArray(v.allocated)),'each piece of evidence keeps its time, the fills open then and its allocation');
  // State saved before readings were kept: its old reported baseline is not used as evidence.
  const db=new DatabaseSync(':memory:');let t=at('2026-11-05T14:00:00Z');db.exec('CREATE TABLE inflight_settlement(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO inflight_settlement VALUES(?,?)').run('a',JSON.stringify({basis:500,seen:{},open:[],reported:{buys:0,sells:0}}));const f=new InFlight(db,()=>t);
  assert.equal(f.observe('a',{us:{cash:500,unsettled:R(100)},orders:[A],fx:1300}).buysUSD,100,'the first reading after the upgrade takes the reported total as its baseline');
});
test('finding 1, consumer: a fill seen after KIS reported it, then settled, records no deposit or withdrawal',()=>{
  let t=at('2026-11-05T22:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>t);const inflight=new InFlight(db,()=>t);const det=new FlowDetector(db,perf,()=>t);
  const order=(o)=>({...o,market:'US',symbol:'X',status:'Filled',createdAt:at('2026-11-05T22:10:00+09:00')});
  const read=(cash,usd,orders=[])=>{const us={cash,pendingSaleProceeds:0,unsettled:R(usd),timestamp:new Date(t).toISOString()};inflight.observe('a',{us,orders,fx:1300});const f=inflight.current('a');const s=settlement(us);
    det.observe('a',{krCash:1000000,usCash:cash-f.buysUSD+f.sellsUSD,fx:1300,orders,provisionalKRW:s.uncertainKRW,unsettledKRW:s.unsettledKRW});t+=30*MIN;};
  read(500,0);read(500,100);for(let i=0;i<6;i++)read(500,100,[order(A)]);assert.equal(inflight.current('a').buysUSD,100);
  read(400,0,[order(A)]);assert.equal(inflight.current('a').buysUSD,0,'settled');for(let i=0;i<5*48;i++)read(400,0,[order(A)]);
  assert.deepEqual(perf.flows('a'),[],'no detected flow');
  // Two fills, two separate settlements: no flow either.
  t=at('2026-11-12T22:00:00+09:00');const db2=new DatabaseSync(':memory:');const perf2=new PerformanceHistory(db2,()=>t);const in2=new InFlight(db2,()=>t);const det2=new FlowDetector(db2,perf2,()=>t);
  const read2=(cash,usd,orders=[])=>{const us={cash,pendingSaleProceeds:0,unsettled:R(usd),timestamp:new Date(t).toISOString()};in2.observe('a',{us,orders,fx:1300});const f=in2.current('a');const s=settlement(us);
    det2.observe('a',{krCash:1000000,usCash:cash-f.buysUSD+f.sellsUSD,fx:1300,orders,provisionalKRW:s.uncertainKRW,unsettledKRW:s.unsettledKRW});t+=30*MIN;};
  const both=[order(A),order(B)];read2(500,0);read2(500,0,both);read2(400,0,both);read2(300,0,both);assert.equal(in2.current('a').buysUSD,0);for(let i=0;i<5*48;i++)read2(300,0,both);
  assert.deepEqual(perf2.flows('a'),[]);
});

// 2. A held change keeps each movement's own window.
function detector(start){let t=at(start);const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>t);let d=new FlowDetector(db,perf,()=>t);
  return {db,perf,read:(time,kr,us=null)=>{t=at(time);return d.observe('a',{krCash:kr,usCash:us,fx:1300});},restart:()=>{d=new FlowDetector(db,perf,()=>t);}};}
const loss=(flows,{baseline,equity})=>LiveEngine.prototype.lossOf.call({flows:()=>flows},{baseline,baselineHigh:baseline,valuation:'broker-total',lossLimit:{mode:'amount',value:30000}},{reportedTotal:equity});
test('finding 2: deposits on both sides of the baseline stay two flows; the ₩50,000 loss is not hidden',()=>{
  const since=at('2026-11-05T09:00:00+09:00');
  for(const reading of [true,false]){const x=detector('2026-11-05T08:00:00+09:00');x.read('2026-11-05T08:00:00+09:00',1000000);x.read('2026-11-05T08:30:00+09:00',1500000);
    if(reading)x.read('2026-11-05T09:00:00+09:00',1500000);x.read('2026-11-05T09:30:00+09:00',2000000);const found=x.read('2026-11-05T10:30:00+09:00',2000000);
    assert.deepEqual(found.map(f=>[f.amount,new Date(f.occurredBy).toISOString()]),[[500000,'2026-11-04T23:30:00.000Z'],[500000,'2026-11-05T00:30:00.000Z']],'each with its own window');
    const f=x.perf.flowsSince('a','KR',since);const l=loss(f,{baseline:1500000,equity:1950000});
    if(reading){assert.equal(f.unresolved,500000,'the later deposit is after the baseline');assert.equal(f.uncertain.unresolved,0);}
    else{assert.equal(f.unresolved,0);assert.equal(f.uncertain.unresolved,500000,'without a reading at the baseline, the later one straddles it: uncertain');}
    assert.ok(l.breached||l.ambiguous,'the loss is detected or explicitly ambiguous, never hidden');assert.equal(l.scenarios.find(s=>s.breached).loss,50000);
    // Once confirmed, the loss is plain.
    if(reading){for(const d of x.perf.flows('a'))x.perf.confirmFlow('a',d.id);const c=x.perf.flowsSince('a','KR',since);assert.equal(c.confirmed,500000,'confirmation does not move when it happened');assert.equal(loss(c,{baseline:1500000,equity:1950000}).breached,true);}}
});
test('finding 2: two withdrawals, and changes in both directions',()=>{
  const since=at('2026-11-05T09:00:00+09:00');let x=detector('2026-11-05T08:00:00+09:00');
  x.read('2026-11-05T08:00:00+09:00',1000000);x.read('2026-11-05T08:30:00+09:00',700000);x.read('2026-11-05T09:00:00+09:00',700000);x.read('2026-11-05T09:30:00+09:00',400000);
  assert.deepEqual(x.read('2026-11-05T10:30:00+09:00',400000).map(f=>f.amount),[-300000,-300000]);const w=x.perf.flowsSince('a','KR',since);assert.equal(w.unresolved,-300000);
  // A true market loss of ₩20,000 (under the ₩30,000 limit): with the withdrawal after the baseline, a ₩320,000 loss is
  // not asserted; it is ambiguous until the withdrawal is confirmed.
  const l=loss(w,{baseline:700000,equity:380000});assert.equal(l.breached,false,'not a ₩320,000 loss: ₩300,000 of it was withdrawn');assert.equal(l.ambiguous,true);
  assert.equal(l.scenarios.find(s=>s.name==='unresolved money changes counted').loss,20000);
  // +₩500k before the baseline, -₩300k after it: one net flow whose window covers both, so its side is uncertain.
  x=detector('2026-11-05T08:00:00+09:00');x.read('2026-11-05T08:00:00+09:00',1000000);x.read('2026-11-05T08:30:00+09:00',1500000);x.read('2026-11-05T09:00:00+09:00',1500000);x.read('2026-11-05T09:30:00+09:00',1200000);
  const net=x.read('2026-11-05T10:30:00+09:00',1200000);assert.deepEqual(net.map(f=>f.amount),[200000]);assert.equal(net[0].occurredAfter,at('2026-11-05T08:00:00+09:00'));assert.equal(net[0].occurredBy,at('2026-11-05T09:30:00+09:00'));
  assert.match(net[0].note,/both directions/);assert.equal(x.perf.flowsSince('a','KR',since).uncertain.unresolved,200000);
});
test('finding 2: the hold runs from the first change; a restart during the hold keeps every window; a small change joins its neighbour',()=>{
  let x=detector('2026-11-05T08:00:00+09:00');x.read('2026-11-05T08:00:00+09:00',1000000);x.read('2026-11-05T08:30:00+09:00',1500000);x.restart();
  x.read('2026-11-05T10:00:00+09:00',2000000);x.restart();const found=x.read('2026-11-05T10:30:00+09:00',2000000);
  assert.equal(found.length,2,'recorded two hours after the first change, not after the second');assert.equal(found[1].occurredAfter,at('2026-11-05T08:30:00+09:00'));assert.equal(found[1].occurredBy,at('2026-11-05T10:00:00+09:00'));
  // ₩5,000 more after a ₩500,000 deposit is not a flow of its own: it widens the deposit's window.
  x=detector('2026-11-05T08:00:00+09:00');x.read('2026-11-05T08:00:00+09:00',1000000);x.read('2026-11-05T08:30:00+09:00',1500000);x.read('2026-11-05T09:30:00+09:00',1505000);
  const one=x.read('2026-11-05T10:30:00+09:00',1505000);assert.deepEqual(one.map(f=>[f.amount,f.occurredAfter,f.occurredBy]),[[505000,at('2026-11-05T08:00:00+09:00'),at('2026-11-05T09:30:00+09:00')]]);
});
test('finding 2: across Korean midnight, a U.S. session baseline, a transfer pair, and a change held before parts were kept',()=>{
  let x=detector('2026-11-04T23:30:00+09:00');x.read('2026-11-04T23:30:00+09:00',1000000);x.read('2026-11-04T23:50:00+09:00',1500000);x.read('2026-11-05T00:20:00+09:00',2000000);
  assert.deepEqual(x.read('2026-11-05T01:50:00+09:00',2000000).map(f=>f.day),['2026-11-04','2026-11-05'],'each on the Seoul day it happened');
  // U.S. baseline at 23:40 KST (09:40 New York): $500 before it and $500 after it.
  x=detector('2026-11-04T23:00:00+09:00');x.read('2026-11-04T23:00:00+09:00',1000000,1000);x.read('2026-11-04T23:30:00+09:00',1000000,1500);x.read('2026-11-04T23:40:00+09:00',1000000,1500);x.read('2026-11-04T23:50:00+09:00',1000000,2000);
  assert.equal(x.read('2026-11-05T01:40:00+09:00',1000000,2000).length,2);const us=x.perf.flowsSince('a','US',at('2026-11-04T23:40:00+09:00'));assert.equal(us.unresolved,500);assert.equal(us.uncertain.unresolved,0);
  // Money moved between the markets in two readings: the pair's window covers both changes.
  x=detector('2026-11-05T08:00:00+09:00');x.read('2026-11-05T08:00:00+09:00',1000000,0);x.read('2026-11-05T08:30:00+09:00',870000,0);const pair=x.read('2026-11-05T09:30:00+09:00',870000,100);
  assert.deepEqual(pair.map(f=>[f.market,f.transfer,f.occurredAfter,f.occurredBy]),[['KR',true,at('2026-11-05T08:00:00+09:00'),at('2026-11-05T09:30:00+09:00')],['US',true,at('2026-11-05T08:00:00+09:00'),at('2026-11-05T09:30:00+09:00')]]);
  // Held by an earlier build (one amount, no parts): its window runs to the last reading, so it straddles the baseline.
  x=detector('2026-11-05T10:30:00+09:00');x.db.prepare('INSERT INTO flow_watch VALUES(?,?)').run('a',JSON.stringify({at:at('2026-11-05T09:30:00+09:00'),krCash:2000000,usCash:null,basis:{KR:'net-of-confirmed',US:'with-pending-and-in-flight'},provisionalKRW:0,unsettledKRW:0,fills:{},
    pending:{KR:{amount:1000000,since:at('2026-11-05T08:30:00+09:00'),after:at('2026-11-05T08:00:00+09:00'),funding:false}},settled:[]}));
  const old=x.read('2026-11-05T10:30:00+09:00',2000000);assert.deepEqual(old.map(f=>[f.amount,f.occurredBy]),[[1000000,at('2026-11-05T09:30:00+09:00')]]);
  assert.equal(x.perf.flowsSince('a','KR',at('2026-11-05T09:00:00+09:00')).uncertain.unresolved,1000000);
});

// 3. A partial fill adds the change in the order's cumulative amount.
const P=(filled,fillPrice,extra={})=>({id:'P',side:'Buy',filled,fillPrice,...extra});
test('finding 3: an average that rises or falls after a partial fill, several partials, exact cents',()=>{
  let x=tracker();x.see({cash:1000});assert.equal(x.see({cash:1000},[P(1,100)]).buysUSD,100);assert.equal(x.see({cash:1000},[P(2,200)]).buysUSD,400,'one share at $100, then two averaging $200: $400');
  x=tracker();x.see({cash:1000});x.see({cash:1000},[P(1,100)]);assert.equal(x.see({cash:1000},[P(2,90)]).buysUSD,180);
  x=tracker();x.see({cash:1000});x.see({cash:1000},[P(1,100)]);x.see({cash:1000},[P(3,101)]);assert.equal(x.see({cash:1000},[P(5,102)]).buysUSD,510);
  x=tracker();x.see({cash:1000});for(const n of [1,2,3])x.see({cash:1000},[P(n,33.333)]);assert.deepEqual(x.state().open.map(f=>f.usd),[33.33,33.34,33.33]);assert.equal(x.see({cash:1000},[P(3,33.333)]).buysUSD,100);
  // Random sequences: the pieces sum to the final cumulative amount to the cent.
  let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  for(let i=0;i<200;i++){x=tracker();x.see({cash:1e6});let q=0,last=null;for(let k=0;k<1+Math.floor(rnd()*5);k++){q+=1+Math.floor(rnd()*4);last=P(q,Math.round((50+rnd()*100)*1000)/1000);x.see({cash:1e6},[last]);}
    assert.equal(Math.round(x.see({cash:1e6},[last]).buysUSD*100),Math.round(last.filled*last.fillPrice*100),`case ${i}`);}
});
test('finding 3: corrections without new shares, cancellation after a partial, restart, fees becoming known',()=>{
  let x=tracker();x.see({cash:1000});x.see({cash:1000},[P(2,100)]);const c=x.see({cash:1000},[P(2,99)]);assert.equal(c.buysUSD,198,'a price correction');assert.match(c.notes[0],/fell by \$2\.00/);
  x=tracker();x.see({cash:1000});x.see({cash:900},[P(1,100)]);const done=x.see({cash:900},[P(1,99)]);assert.equal(done.buysUSD,0,'reflected at once, so nothing in flight to correct');assert.match(done.notes[0],/none of it is in flight/);
  x=tracker();x.see({cash:1000});x.see({cash:1000},[P(1,100)]);assert.equal(x.see({cash:1000},[P(1,100,{status:'Cancelled'})]).buysUSD,100,'cancelled after one share: that share stays');
  x=tracker();x.see({cash:1000});x.see({cash:1000},[P(1,100)]);x.restart();assert.equal(x.see({cash:1000},[P(2,101)]).buysUSD,202,'after a restart the cumulative amount continues');
  x=tracker();x.see({cash:1000});assert.equal(x.see({cash:1000},[P(1,100)]).open[0].basis,'gross');const fees=x.see({cash:1000},[P(1,100,{resultCosts:{netCash:-100.5}})]);
  assert.equal(fees.buysUSD,100.5);assert.equal(fees.open[0].basis,'net');assert.match(fees.notes[0],/fees included/);
  // Saved by an earlier build (quantity only): the next share is taken at the current average once, as before.
  const db=new DatabaseSync(':memory:');let t=at('2026-11-05T14:00:00Z');db.exec('CREATE TABLE inflight_settlement(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO inflight_settlement VALUES(?,?)').run('a',JSON.stringify({basis:1000,seen:{P:1},open:[{id:'P',side:'Buy',usd:100,at:t}],reported:{buys:0,sells:0}}));
  assert.equal(new InFlight(db,()=>t).observe('a',{us:{cash:1000},orders:[P(2,101)],fx:1300}).buysUSD,201);
});

// The copied-profile startup check asserts the runtime pause, not the saved preference.
test('the copied-profile build check keeps the saved preference and asserts the pause, execution off and no orders',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("if(!verifyProfile&&runtime.config.enabled)throw 0;"),'only a fresh profile must have auto trading off');
  for(const s of ["runtime.sessionArmed!==false","runtime.config.enabled!==verifyStart.enabled","runtime.scheduler?.label!=='Paused after restart'","end.intents!==verifyStart.intents||end.orders!==verifyStart.orders"])assert.ok(src.includes(s),s);
  assert.ok(require('node:fs').readFileSync(require.resolve('../scripts/verify-package.cjs'),'utf8').includes("'--verify-profile'"));
});
test('finding 1: a cash fall that matched nothing (a withdrawal) does not mark a later fill unresolved',()=>{
  const x=tracker();x.see({cash:500});x.see({cash:400});const r=x.see({cash:400},[A]);assert.equal(r.buysUSD,100);assert.equal(r.unresolved.buysUSD,0);
});
