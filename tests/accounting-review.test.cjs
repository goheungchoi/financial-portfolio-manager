// Independent accounting review of 162d7c9 (2026-11-05): regressions for its three findings, checked through their
// consumers (the valuation, the sizing base, the flow detector and the daily loss check).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value,MAX_DAYS}=require('../electron/valuation.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const HOUR=3600000,DAY=86400000,at=s=>Date.parse(s),fx={usdKRW:1300};
// The tracker and the value on one database: read() records a U.S. balance reading and returns the value with it
// (with an empty Korean balance, so the combined value covers both markets and can be exact).
function account(start='2026-11-05T14:00:00Z'){let t=at(start);const db=new DatabaseSync(':memory:');let f=new InFlight(db,()=>t);
  const read=(us,orders=[])=>{const s={pendingSaleProceeds:0,holdings:[],...us,timestamp:new Date(t).toISOString()};const r=f.observe('a',{us:s,orders,fx:1300});const korea={cash:0,settledCash:0,holdings:[],timestamp:s.timestamp};const v=value({korea,us:s,fx,inFlight:f.current('a'),now:t});return {r,v,us:v.markets.US};};
  return {read,db,restart:()=>{f=new InFlight(db,()=>t);},later:ms=>{t+=ms;},now:()=>t,state:()=>f.state('a'),explained:range=>f.explained('a',range)};}
const share=(usd,s='NYSE:X')=>({symbol:s,quantity:1,price:usd});const base=v=>LiveEngine.prototype.exposureBase.call({netEquityOf:()=>({low:v.markets.US.equity.low})},{reportedTotal:Infinity});

// 1. The first reading does not assume settlement.
test('first launch: a recent unreflected buy stays an obligation; the value is a range, not exact, and sizing does not grow',()=>{
  const a=account();const recent={id:'B',side:'Buy',filled:1,fillPrice:100,createdAt:a.now()-HOUR};
  const {r,v}=a.read({cash:500,holdings:[share(100)]},[recent]);
  assert.equal(r.buysUSD,100);assert.equal(r.unresolved.buysUSD,100);assert.equal(v.combined.low,650000,'conservative');assert.equal(v.combined.high,780000);assert.equal(v.combined.exact,false);
  assert.ok(v.combined.reasons.some(x=>/unresolved/.test(x)));assert.equal(base(v),500,'the sizing base is the low value');
  assert.equal(a.state().evidence.find(e=>e.kind==='first reading').flagged[0],'B','recorded as evidence');
  // Restart during the bootstrap: the obligation is kept.
  a.restart();a.later(60000);assert.equal(a.read({cash:500,holdings:[share(100)]},[recent]).v.combined.low,650000);
});
test('first launch: a fill past the age rule closes at once (C1b); a reported buy of unknown funding and a sale without proceeds stay open',()=>{
  // A buy filled ten days ago: opened awaiting verification and closed by age at the same first reading (settlement
  // clean-up C1b, W3): it is not in the low bound and the value is exact. Nothing else is history by schedule.
  let a=account();let {r,v}=a.read({cash:400,holdings:[share(100)]},[{id:'H',side:'Buy',filled:1,fillPrice:100,createdAt:a.now()-10*DAY}]);
  assert.equal(r.buysUSD,0);assert.equal(v.combined.low,650000);assert.equal(v.combined.high,650000);
  assert.ok(r.notes.some(n=>/settled by age/.test(n)));assert.equal(a.state().evidence.find(e=>e.kind==='history'),undefined,'nothing is history by schedule');
  // A buy filled an hour ago: still awaiting verification (stage 2b S1), in the low bound, and the value is provisional.
  a=account();({r,v}=a.read({cash:400,holdings:[share(100)]},[{id:'H2',side:'Buy',filled:1,fillPrice:100,createdAt:a.now()-HOUR}]));
  assert.equal(r.buysUSD,100);assert.equal(r.open[0].unresolved.why,'awaiting verification');assert.equal(v.combined.low,520000);assert.equal(v.combined.exact,false);
  assert.ok(v.combined.reasons.some(x=>/1 pre-tracking U.S. fill awaiting verification: the value is provisional/.test(x)));
  // KIS reports $100 awaiting settlement, funding unknown: possibly this buy, unproven; both obligations in the low bound.
  a=account();const korea={cash:1300000,settledCash:1300000,holdings:[],timestamp:new Date(a.now()).toISOString()};
  const us={cash:500,pendingSaleProceeds:0,holdings:[share(100)],unsettled:{buyKRW:130000,sellKRW:0,krwFundedKRW:0},timestamp:new Date(a.now()).toISOString()};
  const f=new InFlight(a.db,()=>a.now());const rr=f.observe('a',{us,orders:[{id:'R',side:'Buy',filled:1,fillPrice:100,createdAt:a.now()-HOUR}],fx:1300});
  assert.equal(rr.open[0].unresolved.why,'reported before seen');const vv=value({korea,us,fx,inFlight:f.current('a'),now:a.now()});
  assert.equal(vv.combined.low,1300000-130000+(500+100-100)*1300,'the reported total and the fill both count in the low bound');assert.equal(vv.combined.exact,false);
  // A recent sale whose proceeds KIS does not show: the high bound may include them, the low bound does not.
  a=account();({r,v}=a.read({cash:500,holdings:[]},[{id:'S',side:'Sell',filled:1,fillPrice:100,createdAt:a.now()-HOUR}]));
  assert.equal(r.unresolved.sellsUSD,100);assert.equal(v.combined.low,650000);assert.equal(v.combined.high,780000);assert.equal(v.combined.exact,false);
});
test('first launch: order history arriving after the balance is held to the same rule',()=>{
  const a=account();a.read({cash:500,holdings:[share(100),share(50,'NYSE:Y')]},[]);a.later(60000);
  const late=[{id:'B',side:'Buy',filled:1,fillPrice:100,createdAt:a.now()-2*HOUR},{id:'H',side:'Buy',filled:1,fillPrice:50,createdAt:a.now()-10*DAY}];
  const {r,v}=a.read({cash:500,holdings:[share(100),share(50,'NYSE:Y')]},late);
  // S1a: the recent one stays in flight, awaiting verification; the one filled ten days ago is settled by age.
  assert.deepEqual(r.open.map(f=>[f.id,f.unresolved.why]),[['B','awaiting verification']]);assert.ok(r.notes.some(n=>/^Buy H .*settled by age/.test(n)));
  assert.equal(v.combined.low,(500+150-100)*1300);assert.equal(v.combined.exact,false);
});

// 2. Settlement by age (S1a; it replaces "time is not settlement evidence").
test('ten days without broker change, weekend and restart included: settled by age after 3 business days, as a correction, no flow',()=>{
  // From Friday 2026-11-06 for ten days, the same balance every day.
  const a=account('2026-11-06T15:00:00Z');let t0=a.now();const db=a.db;const perf=new PerformanceHistory(db,()=>a.now());const det=new FlowDetector(db,perf,()=>a.now());
  const fill={id:'B',side:'Buy',filled:1,fillPrice:100,createdAt:t0,filledObservedAt:t0};const us={cash:500,holdings:[share(100)]};
  a.read(us,[]);a.later(60000);const lows=[],notes=[];
  // Trade date Fri 11-06 (New York): business days Mon 9, Tue 10, Wed 11; the reading of Wed 11-11 (day 5) closes it.
  const exact=[],bases=[];
  for(let d=0;d<10;d++){if(d===4)a.restart();const {r,v}=a.read(us,[fill]);lows.push(v.combined.low);exact.push(v.combined.exact);notes.push(...r.notes);
    det.observe('a',{usExplained:a.explained,krCash:1000000,usCash:us.cash-r.buysUSD+r.sellsUSD,fx:1300,orders:[{...fill,market:'US',symbol:'X',status:'Filled'}]});bases.push(base(v));a.later(DAY);}
  assert.deepEqual(bases,[500,500,500,500,500,600,600,600,600,600],'the U.S. basis follows');
  assert.deepEqual(lows,[650000,650000,650000,650000,650000,780000,780000,780000,780000,780000],'the obligation leaves the low bound on day 5: '+lows.join(','));
  assert.deepEqual(exact,[false,false,false,false,false,true,true,true,true,true]);
  assert.equal(notes.filter(n=>/settled by age, 3 U\.S\. business days after its trade date 2026-11-06/.test(n)).length,1,'noted once');
  assert.equal(perf.flows('a').length,0,'no inferred flow: the age close is explained, not a deposit');
  // The close is a cash-free basis change of +$100 (a buy leaving the obligation).
  const ev=a.db.prepare("SELECT payload FROM settlement_events WHERE account='a' AND kind='piece-closed'").all().map(x=>JSON.parse(x.payload));assert.equal(ev.length,1);assert.equal(ev[0].why,'age');assert.equal(ev[0].side,'Buy');
});

// 3. Held cash changes count for the loss check at once.
function desk(){let t=at('2026-11-05T08:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>t);let det=new FlowDetector(db,perf,()=>t);
  return {perf,read:(time,kr,us=null)=>{t=at(time);return det.observe('a',{krCash:kr,usCash:us,fx:1300});},restart:()=>{det=new FlowDetector(db,perf,()=>t);},det:()=>det};}
const since=at('2026-11-05T09:00:00+09:00');
const loss=(x,market,{baseline,equity})=>LiveEngine.prototype.lossOf.call({flowsSince:()=>x.det().flowsSince('a',market,since),flows:LiveEngine.prototype.flows},{baseline,baselineHigh:baseline,valuation:'broker-total',lossLimit:{mode:'amount',value:30000}},{reportedTotal:equity});
test('a held deposit is a loss scenario at once, the same after it is recorded, plain once confirmed, gone once removed',()=>{
  const x=desk();x.read('2026-11-05T09:00:00+09:00',1000000);x.read('2026-11-05T09:30:00+09:00',1100000);
  let l=loss(x,'KR',{baseline:1000000,equity:1050000});assert.equal(l.breached,false);assert.equal(l.ambiguous,true,'during the hold');assert.equal(l.scenarios.find(s=>s.name==='unresolved money changes counted').loss,50000);
  x.restart();assert.equal(loss(x,'KR',{baseline:1000000,equity:1050000}).ambiguous,true,'after a restart');
  const found=x.read('2026-11-05T11:30:00+09:00',1100000);assert.equal(found.length,1);assert.ok(found[0].pendingIds.length);
  const f=x.det().flowsSince('a','KR',since);assert.equal(f.unresolved,100000,'counted once after it is recorded');l=loss(x,'KR',{baseline:1000000,equity:1050000});assert.equal(l.ambiguous,true);
  x.perf.confirmFlow('a',found[0].id);l=loss(x,'KR',{baseline:1000000,equity:1050000});assert.equal(l.breached,true,'confirmed: the ₩50,000 loss is plain');
  x.perf.removeFlow('a',found[0].id);l=loss(x,'KR',{baseline:1000000,equity:1050000});assert.equal(l.breached,false);assert.equal(l.ambiguous,false,'removed: no money moved, and equity rose');
});
test('held withdrawals, changes both ways, both sides of the baseline, a transfer leg, and no double count while recording',()=>{
  // A held ₩100,000 withdrawal and a ₩50,000 market loss: breached in every scenario.
  let x=desk();x.read('2026-11-05T09:00:00+09:00',1000000);x.read('2026-11-05T09:30:00+09:00',900000);assert.equal(loss(x,'KR',{baseline:1000000,equity:850000}).breached,true);
  // +₩100,000 then -₩40,000, both after the baseline: ₩60,000 unresolved.
  x=desk();x.read('2026-11-05T09:00:00+09:00',1000000);x.read('2026-11-05T09:30:00+09:00',1100000);x.read('2026-11-05T10:00:00+09:00',1060000);assert.equal(x.det().flowsSince('a','KR',since).unresolved,60000);
  // One part before the baseline, one after (no reading at the baseline): the earlier is left out, the later uncertain.
  x=desk();x.read('2026-11-05T08:00:00+09:00',1000000);x.read('2026-11-05T08:30:00+09:00',1100000);x.read('2026-11-05T09:30:00+09:00',1200000);
  const f=x.det().flowsSince('a','KR',since);assert.equal(f.unresolved,0);assert.equal(f.uncertain.unresolved,100000);
  // A Korean leg of a transfer whose U.S. side has not been seen yet is money moving for Korea: a scenario too.
  x=desk();x.read('2026-11-05T09:00:00+09:00',1000000,500);x.read('2026-11-05T09:30:00+09:00',870000,500);assert.equal(x.det().flowsSince('a','KR',since).unresolved,-130000);
  // Both legs seen: a recorded transfer, counted once and not as a held change.
  x.read('2026-11-05T09:40:00+09:00',870000,600);const kr=x.det().flowsSince('a','KR',since);assert.equal(kr.confirmed,-130000);assert.equal(kr.unresolved,0);assert.equal(x.det().flowsSince('a','US',since).confirmed,100);
  // A held part whose id is already on a recorded flow is not counted twice.
  x=desk();x.read('2026-11-05T09:00:00+09:00',1000000);x.read('2026-11-05T09:30:00+09:00',1100000);const det=x.det();const row=JSON.parse(det.db.prepare('SELECT payload FROM flow_watch').get().payload);
  x.perf.addFlow('a',{day:'2026-11-05',market:'KR',amount:100000,detected:true,occurredAfter:since,occurredBy:since+HOUR,pendingIds:row.pending.KR.parts.map(p=>p.id),note:'promoted'});
  assert.equal(det.flowsSince('a','KR',since).unresolved,100000);
});
