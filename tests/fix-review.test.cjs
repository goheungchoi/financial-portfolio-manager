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
  // The valuation keeps the uncertainty: both obligations in the low bound, the fill out of the high bound, not exact.
  const us={cash:500,unsettled:R(100),holdings:[],timestamp:new Date(x.now()).toISOString()};const v=value({us,fx:{usdKRW:1300},inFlight:x.raw(us,[A]),now:x.now()}).markets.US;
  assert.equal(v.equity.low,400);assert.equal(v.equity.high,500);assert.equal(v.exact,false);assert.ok(v.reasons.some(r=>/unresolved/.test(r)));
  // KIS settles the reported buy: cash and the reported total fall together, which resolves it.
  assert.equal(x.see({cash:400,unsettled:R(0)},[A]).buysUSD,0);assert.equal(x.state().evidence.at(-1).kind,'reported settlement');assert.deepEqual(x.state().evidence.at(-1).allocated.map(a=>a.id),['A']);
});
// C: a fill of a distinct amount, so the pairing between channels is tested where strict A5 can tell fills apart.
const C={id:'C',side:'Buy',filled:1,fillPrice:130};
test('finding 1: a reported rise and a cash fall in one reading may be one purchase: never both cleared',()=>{
  // Two equal fills (stage 2b S2): each channel fits A or B, so nothing is cleared, and the candidates are recorded.
  const x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);const r=x.see({cash:400,unsettled:R(100)},[A,B]);
  assert.equal(r.buysUSD,200,'not both cleared, nor one');assert.equal(r.unresolved.buysUSD,200);
  const e=x.state().evidence;assert.deepEqual(e.map(v=>v.kind),['ambiguous fit','ambiguous fit']);assert.deepEqual(e[0].ambiguousCandidates,[['A'],['B']]);
  assert.equal(x.see({cash:300,unsettled:R(100)},[A,B]).buysUSD,200,'a later equal cash fall is no less ambiguous');
  // Distinct amounts: the reported rise settles A, and the cash fall of the same amount is paired with it, not taken as C's.
  const y=tracker();y.see({cash:500});y.see({cash:500},[A,C]);const p=y.see({cash:400,unsettled:R(100)},[A,C]);
  assert.equal(p.buysUSD,130);const pe=y.state().evidence;assert.deepEqual(pe.map(v=>v.kind),['settled','paired']);assert.equal(pe[0].pairedWith,pe[1].id,'the two allocations are paired');
  // A later cash fall on its own is a separate event: it clears the remaining fill.
  assert.equal(y.see({cash:270,unsettled:R(100)},[A,C]).buysUSD,0);
});
test('finding 1: a time gap alone does not make two channels two events; a reported buy settling with its payment does; it is not evidence for another',()=>{
  // Equal fills (stage 2b S2): no channel tells A from B, so nothing resolves; identity waits for a reconciliation.
  let x=tracker();x.see({cash:500});x.see({cash:500},[A,B]);assert.equal(x.see({cash:500,unsettled:R(100)},[A,B]).buysUSD,200,'reported $100: A or B, so neither');
  assert.equal(x.see({cash:400,unsettled:R(100)},[A,B]).buysUSD,200);assert.equal(x.see({cash:300,unsettled:R(0)},[A,B]).buysUSD,200,'the reported buy settling fits A or B: neither');
  // Distinct amounts: the reported rise settles A; cash of the same amount a reading later is that purchase, not C.
  x=tracker();x.see({cash:500});x.see({cash:500},[A,C]);assert.equal(x.see({cash:500,unsettled:R(100)},[A,C]).buysUSD,130,'reported only: A');
  const later=x.see({cash:400,unsettled:R(100)},[A,C]);assert.equal(later.buysUSD,130,'cash a reading later, same amount: paired with A');assert.equal(x.state().evidence.at(-1).kind,'paired');
  assert.equal(x.see({cash:400,unsettled:R(0)},[A,C]).buysUSD,130,'the reported buy settling: A, already paid');assert.equal(x.see({cash:270,unsettled:R(0)},[A,C]).buysUSD,0,'C settles by its own cash');
  x=tracker();x.see({cash:500});x.see({cash:500},[A,C]);x.see({cash:500,unsettled:R(100)},[A,C]);
  const r=x.see({cash:400,unsettled:R(0)},[A,C]);assert.equal(r.buysUSD,130,'cash and reported fall together: A settling, not C');assert.equal(x.state().evidence.at(-1).kind,'reported settlement');
  // Cash-only and reported-only updates on their own.
  x=tracker();x.see({cash:500});x.see({cash:500},[A]);assert.equal(x.see({cash:400},[A]).buysUSD,0,'cash only');
  x=tracker();x.see({cash:500});x.see({cash:500},[A]);assert.equal(x.see({cash:500,unsettled:R(100)},[A]).buysUSD,0,'reported only');
  // Sales: the reported sale total rising clears an open sale; one that matches nothing is not carried forward.
  const S={id:'S',side:'Sell',filled:1,fillPrice:100};x=tracker();x.see({cash:500});x.see({cash:500,unsettled:{buyKRW:0,sellKRW:130000}});
  const s=x.see({cash:500,unsettled:{buyKRW:0,sellKRW:130000}},[S]);assert.equal(s.sellsUSD,100);assert.equal(s.unresolved.sellsUSD,100);
});
test('finding 1: repeated and out-of-order readings, and a restart between the two channels',()=>{
  let x=tracker();x.see({cash:500});x.see({cash:500},[A,C]);x.see({cash:500,unsettled:R(100)},[A,C]);
  for(let i=0;i<3;i++)assert.equal(x.see({cash:500,unsettled:R(100)},[A,C]).buysUSD,130,'the same reading again changes nothing');
  const old=x.raw({cash:400,unsettled:R(100),timestamp:new Date(x.now()-HOUR).toISOString()},[A,C]);assert.equal(old.buysUSD,130);assert.match(old.notes[0],/older than the last one was ignored/);
  // Restart, then the reported buy settles (not evidence for C); restart, then C's own cash movement.
  x.restart();assert.equal(x.see({cash:400,unsettled:R(0)},[A,C]).buysUSD,130);x.restart();assert.equal(x.see({cash:270,unsettled:R(0)},[A,C]).buysUSD,0);
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
  // Distinct amounts, so each settlement fits one fill (stage 2b S2; equal fills stay unresolved until reconciled).
  const both=[order(A),order(C)];read2(500,0);read2(500,0,both);read2(400,0,both);read2(270,0,both);assert.equal(in2.current('a').buysUSD,0);for(let i=0;i<5*48;i++)read2(270,0,both);
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
  x=detector('2026-11-05T10:30:00+09:00');x.db.prepare('INSERT INTO flow_watch VALUES(?,?)').run('a',JSON.stringify({at:at('2026-11-05T09:30:00+09:00'),krCash:2000000,usCash:null,basis:require('../electron/flow-detector.cjs').BASIS,provisionalKRW:0,unsettledKRW:0,fills:{},
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
test('finding 1: a cash fall a reading before a fill is seen may be its payment or a withdrawal: the fill stays in flight, unresolved',()=>{
  let x=tracker();x.see({cash:500});x.see({cash:400});let r=x.see({cash:400},[A]);assert.equal(r.buysUSD,100);assert.equal(r.unresolved.buysUSD,100);assert.equal(r.open[0].unresolved.why,'paid before seen');
  // Stage 2b (design v2 T11, v3 T17): the earlier fall may have been this fill's payment, so a later fall is no proof
  // either way; only a reconciliation (or A1 once U6 is verified) resolves it.
  const later=x.see({cash:300},[A]);assert.equal(later.buysUSD,100,'a later cash fall does not clear it');assert.equal(later.open[0].unresolved.why,'paid before seen');
  // Two readings earlier is not considered: the fill is in flight and not flagged by it.
  x=tracker();x.see({cash:500});x.see({cash:400});x.see({cash:400});r=x.see({cash:400},[A]);assert.equal(r.buysUSD,100);assert.equal(r.unresolved.buysUSD,0);
});

// Fix review of 34474f7: the settlement tracker and the valuation as one contract. With no quote or rate change a
// purchase never raises the conservative (low) value, an unresolved match never becomes exact, and once every purchase
// is settled the value is back where it started. Checked on the combined value, the U.S. market value the loss and
// exposure checks use, the portfolio view and the sizing base.
const {combinePortfolio}=require('../electron/portfolio-view.cjs');
function account({krwCash=1300000,usCash=500,holdings=[],unsettled={buyKRW:0,sellKRW:0,krwFundedKRW:0}}={}){
  let t=at('2026-11-05T14:00:00Z');const db=new DatabaseSync(':memory:');let f=new InFlight(db,()=>t);const fx={usdKRW:1300};
  const s={kr:{cash:krwCash,settledCash:krwCash,holdings:[]},us:{cash:usCash,pendingSaleProceeds:0,holdings:[...holdings],unsettled:{...unsettled}},orders:[]};
  const stamp=()=>({kr:{...s.kr,timestamp:new Date(t).toISOString()},us:{...s.us,unsettled:{...s.us.unsettled},holdings:[...s.us.holdings],timestamp:new Date(t).toISOString()}});
  const mark=()=>{const {kr,us}=stamp();const inFlight=f.current('a');const v=value({korea:kr,us,fx,inFlight,now:t});const view=combinePortfolio(kr,us,fx,{},{inFlight,now:t});
    const base=LiveEngine.prototype.exposureBase.call({netEquityOf:()=>({low:v.markets.US.equity.low})},{reportedTotal:Infinity});
    return {low:v.combined.low,high:v.combined.high,exact:v.combined.exact,usLow:v.markets.US.equity.low,view:view.totals.equityKRW,base,reasons:v.combined.reasons,inFlight};};
  return {s,mark,read:()=>{const {us}=stamp();const r=f.observe('a',{us,orders:s.orders,fx:1300});t+=30*MIN;return r;},restart:()=>{f=new InFlight(db,()=>t);},later:ms=>{t+=ms;},state:()=>f.state('a')};}
const buy=(id,usd)=>({id,side:'Buy',filled:1,fillPrice:usd});const share=(id,usd)=>({symbol:'NYSE:'+id,quantity:1,price:usd,cost:usd});
const krw=(s,usd,sign=1)=>{s.us.unsettled.buyKRW+=sign*usd*1300;s.us.unsettled.krwFundedKRW+=sign*usd*1300;};
test('contract: an older reported purchase and a distinct new one: the low value is unchanged, the range is not exact',()=>{
  const a=account({holdings:[share('OLD',100)]});a.read();
  krw(a.s,100);a.read();const before=a.mark();assert.equal(before.low,1950000);assert.equal(before.exact,true);
  a.s.us.holdings.push(share('NEW',100));a.s.orders=[buy('new',100)];a.read();const after=a.mark();
  assert.equal(after.low,1950000,'a purchase alone creates no wealth');assert.equal(after.high,2080000,'unless the reported total was this purchase');assert.equal(after.exact,false);
  assert.ok(after.reasons.some(r=>/unresolved/.test(r)));assert.equal(after.view,1950000,'the portfolio view shows the low value');assert.equal(after.usLow,600,'the U.S. value the loss and sizing checks use keeps the obligation: $500 cash and two $100 shares less the $100 in flight');assert.equal(after.base,600);
});
test('contract: a fill and KIS reporting it, in either order, are counted once; when it settles the value is where it started, exact',()=>{
  for(const lag of [0,1]){const a=account();a.read();const e0=a.mark().low;assert.equal(e0,1950000);
    // lag 0: the app sees the fill before KIS reports it; lag 1: KIS reports it (with its shares) before the app sees it.
    a.s.us.holdings.push(share('A',100));if(lag)krw(a.s,100);else a.s.orders=[buy('A',100)];a.read();assert.ok(a.mark().low<=e0);
    if(lag)a.s.orders=[buy('A',100)];else krw(a.s,100);a.read();const covered=a.mark();
    if(lag){assert.ok(covered.low<=e0);assert.equal(covered.high,e0);assert.equal(covered.exact,false,'reported before seen: unresolved until it settles');}else{assert.equal(covered.low,e0);assert.equal(covered.high,e0);assert.equal(covered.exact,true,'KIS reports it');}
    a.s.kr.cash-=130000;a.s.kr.settledCash-=130000;krw(a.s,100,-1);a.read();const done=a.mark();assert.equal(done.low,e0);assert.equal(done.exact,true);assert.equal(done.inFlight.buysUSD,0);}
});
test('contract: reported before the fill was seen, then settled; paid at once in USD; several trades partly covered',()=>{
  // KIS reports the purchase (and its shares) a reading before the app sees the fill.
  let a=account();a.read();const e0=a.mark().low;a.s.us.holdings.push(share('A',100));krw(a.s,100);a.read();assert.equal(a.mark().low,e0);
  a.s.orders=[buy('A',100)];a.read();const unsure=a.mark();assert.ok(unsure.low<=e0);assert.equal(unsure.high,e0);assert.equal(unsure.exact,false);
  a.s.kr.cash-=130000;a.s.kr.settledCash-=130000;krw(a.s,100,-1);a.read();assert.deepEqual([a.mark().low,a.mark().exact],[e0,true]);
  // Paid from U.S. cash at the fill.
  a=account();a.read();a.s.us.holdings.push(share('A',100));a.s.us.cash-=100;a.s.orders=[buy('A',100)];a.read();assert.deepEqual([a.mark().low,a.mark().exact],[e0,true]);
  // Two fills, $100 and $50; KIS reports $120 for them (it matches neither): both stay in flight, unresolved; then $150.
  a=account();a.read();a.s.us.holdings.push(share('A',100),share('B',50));a.s.orders=[buy('A',100),buy('B',50)];a.read();
  a.s.us.unsettled.buyKRW=120*1300;a.s.us.unsettled.krwFundedKRW=120*1300;a.read();const part=a.mark();assert.ok(part.low<=e0);assert.equal(part.exact,false);assert.equal(part.inFlight.unresolved.buysUSD,150);
  a.s.us.unsettled.buyKRW=150*1300;a.s.us.unsettled.krwFundedKRW=150*1300;a.read();assert.ok(a.mark().low<=e0,'a further $30 is no match either: still conservative');
});
test('contract: a new fill reflected in cash while the reported total rises keeps a possible $100 obligation',()=>{
  // The review's case: A open; B appears with cash down $100 and the reported total up $100.
  let a=account();a.read();const e0=a.mark().low;a.s.us.holdings.push(share('A',100));a.s.orders=[buy('A',100)];a.read();
  a.s.us.holdings.push(share('B',100));a.s.orders=[buy('A',100),buy('B',100)];a.s.us.cash-=100;krw(a.s,100);const r=a.read();
  // Strict A5 (stage 2b S2, S4): A and B are both $100, so neither channel can say which it was: both stay, more than
  // the possible $100 the review required.
  assert.equal(r.buysUSD,200);assert.equal(r.unresolved.buysUSD,200);assert.ok(a.mark().low<=e0);assert.equal(a.mark().exact,false);
  let ev=a.state().evidence;assert.deepEqual(ev.map(e=>e.kind),['ambiguous fit','ambiguous fit']);
  // Distinct amounts (A $130): the cash is B's at once, and the reported rise of the same amount is paired with it.
  a=account();a.read();a.s.us.holdings.push(share('A',130));a.s.orders=[buy('A',130)];a.read();
  a.s.us.holdings.push(share('B',100));a.s.orders=[buy('A',130),buy('B',100)];a.s.us.cash-=100;krw(a.s,100);const d=a.read();assert.equal(d.buysUSD,130);assert.ok(a.mark().low<=e0);
  ev=a.state().evidence;assert.deepEqual(ev.map(e=>e.kind),['reflected at once','paired']);assert.deepEqual(ev[0].allocated.map(x=>x.id),['B'],'the cash allocation to the new fill is logged');assert.equal(ev[0].pairedWith,ev[1].id);
  // The same in the other order across readings (cash for B first, the reported rise later), with a restart between.
  a=account();a.read();a.s.us.holdings.push(share('A',100));a.s.orders=[buy('A',100)];a.read();a.s.us.holdings.push(share('B',100));a.s.orders=[buy('A',100),buy('B',100)];a.s.us.cash-=100;a.read();
  a.restart();a.later(DAY);krw(a.s,100);const later=a.read();assert.equal(later.unresolved.buysUSD,200,'a time gap alone does not make them two events');
  // Two new fills in one reading with both channels, and a new partial-fill piece.
  a=account();a.read();a.s.us.holdings.push(share('A',100),share('B',100));a.s.orders=[buy('A',100),buy('B',100)];a.s.us.cash-=100;krw(a.s,100);assert.equal(a.read().unresolved.buysUSD,200);
  a=account();a.read();a.s.us.holdings.push(share('P',100));a.s.orders=[{id:'P',side:'Buy',filled:1,fillPrice:100}];a.read();a.s.us.holdings=[{...share('P',100),quantity:2}];a.s.orders=[{id:'P',side:'Buy',filled:2,fillPrice:100}];a.s.us.cash-=100;krw(a.s,100);
  assert.equal(a.read().unresolved.buysUSD,200,'the new piece equals the open one: neither is settled');assert.ok(a.mark().low<=e0);
  // Different amounts through the two channels are two events.
  a=account();a.read();a.s.us.holdings.push(share('A',60));a.s.orders=[buy('A',60)];a.read();a.s.us.holdings.push(share('B',100));a.s.orders=[buy('A',60),buy('B',100)];a.s.us.cash-=100;krw(a.s,60);
  const two=a.read();assert.deepEqual([two.buysUSD,two.unresolved.buysUSD],[0,0]);assert.deepEqual([a.mark().low,a.mark().exact],[e0,true]);
});
test('contract: random purchase lifecycles conserve equity and log every allocation',t=>{let leftover=0;
  let seed=11;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;const pick=a=>a[Math.floor(rnd()*a.length)];
  for(let c=0;c<150;c++){const a=account({usCash:2000});a.read();const e0=a.mark().low;const buys=[];const n=1+Math.floor(rnd()*3);const amounts=[100,150,230].sort(()=>rnd()-0.5);
    for(let i=0;i<n;i++)buys.push({id:'X'+i,usd:amounts[i],mode:pick(['cash','krw','usd']),fill:1+Math.floor(rnd()*4),lag:Math.floor(rnd()*2)});
    for(let step=1;step<=10;step++){for(const b of buys){if(step===b.fill){a.s.us.holdings.push(share(b.id,b.usd));if(b.mode==='cash')a.s.us.cash-=b.usd;else if(b.mode==='krw')krw(a.s,b.usd);else a.s.us.unsettled.buyKRW+=b.usd*1300;}
        if(step===b.fill+b.lag)a.s.orders=[...a.s.orders,buy(b.id,b.usd)];
        if(step===b.fill+3&&b.mode!=='cash'){if(b.mode==='krw'){a.s.kr.cash-=b.usd*1300;a.s.kr.settledCash-=b.usd*1300;krw(a.s,b.usd,-1);}else{a.s.us.cash-=b.usd;a.s.us.unsettled.buyKRW-=b.usd*1300;}}}
      if(rnd()<0.2)a.restart();a.read();const m=a.mark();assert.ok(m.low<=e0+1,`case ${c} step ${step}: ${m.low} > ${e0} ${JSON.stringify(buys)}`);assert.ok(m.high>=m.low-1);assert.ok(!(m.exact&&m.inFlight.unresolved.buysUSD>0),'unresolved is never exact');}
    // Settlement by age (S1a, replacing "time alone changes nothing"): what amounts alone could not tie to its settlement
    // (a payment seen before its order; a new report netted against another's settlement in one reading) is settled
    // after 3 U.S. business days. Eight more days with no broker change: nothing is left in flight, the value is the
    // start value again, exact, and the rise is the amount that was still open.
    const settledLow=a.mark().low,before=a.state().open.filter(f=>f.side==='Buy').reduce((n,f)=>n+f.usd,0);if(before>0)leftover++;
    a.later(8*DAY);a.read();const end=a.mark();assert.equal(a.state().open.length,0,`case ${c}: everything settles by age`);assert.equal(end.exact,true,`case ${c}: exact`);
    assert.ok(Math.abs(end.low-e0)<=1,`case ${c}: back to the start value`);assert.ok(Math.abs(end.low-settledLow-Math.round(before*1300))<=1,`case ${c}: the rise is what was open`);
    const allocated=a.state().evidence.flatMap(e=>e.allocated.map(x=>x.id));assert.equal(new Set(allocated).size,allocated.length,`case ${c}: no fill allocated twice`);}
  t.diagnostic(`${leftover} of 150 lifecycles needed the age rule to settle a fill`);
});
