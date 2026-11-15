// S3a G1 (settlement clean-up, s3/design.md and s3/review.md ruling R2; S3a-2): a funding-transfer leg carries the
// window in which its own market's loss value moved, so the loss check places it against the day's baseline: after (it
// moves the baseline with the value), before (in it already), or uncertain. G2 is in tests/us-hold-engine.test.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FundingTransfers}=require('../electron/funding-transfers.cjs');
const MIN=60000,FX=1340;
// The recorder alone, as funding-transfers.test.cjs drives it; every reading's time is kept (at.us[i], at.kr[i]).
function lone(start=Date.parse('2026-11-09T14:40:00Z'),{strip=false}={}){const db=new DatabaseSync(':memory:');let t=start;const clock=()=>t;const perf=new PerformanceHistory(db,clock);const f=new FundingTransfers(db,{performance:perf,clock});
  // strip: the code before S3a (no window), for the "changes nothing else" comparison.
  if(strip){const book=f.book.bind(f);f.book=(a,k,l,o)=>book(a,k,l,{...o,by:o.at,after:null});}
  const at={us:[],kr:[]};const b=(id,usd)=>({id,side:'Buy',filled:1,fillPrice:usd,market:'US',accountKey:'A:US',createdAt:t,filledObservedAt:t,resultCosts:{netCash:-usd}});
  return {db,f,perf,b,at,later:ms=>{t+=ms;},
    us:(cash,buyKRW,orders,x={})=>{at.us.push(t);const r=f.observeUS('A',{us:{cash,pendingSaleProceeds:x.pending??0,unsettled:{buyKRW,sellKRW:0}},orders,fx:FX,openOrderIds:new Set(x.open??[]),openBuysUSD:x.openUSD??0});t+=MIN;return r;},
    kr:settled=>{at.kr.push(t);const r=f.observeKR('A',{korea:{cash:settled,settledCash:settled}});t+=MIN;return r;},
    flows:()=>db.prepare('SELECT id,payload FROM cash_flows').all().map(r=>({id:r.id,...JSON.parse(r.payload)})),
    // Where the loss check puts the market's funding flows for a baseline taken at `since`.
    side:(market,since)=>{const s=perf.flowsSince('A',market,since);return {after:s.confirmed,uncertain:s.uncertain.confirmed};}};}
const flow=(w,leg)=>w.flows().find(f=>f.id.endsWith(':'+leg));
// K1: the report of a buy no U.S. money can pay. U.S. readings us[0] (nothing), us[1] (the fill), Korean kr[0] (after
// the fill), then us[2] reports 134,000: Korea -134,000, U.S. +100.
function k1(){const w=lone();w.us(0,0,[]);const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});w.kr(3000000);w.us(0,134000,o);w.kr(3000000);return {w,o};}

test('G1/R2 K1: each leg\'s window is its own market\'s; a Korean baseline between the U.S. readings, before or after the report',()=>{
  const {w}=k1();const out=flow(w,'out'),inn=flow(w,'in');
  // The Korean figure's U.S.-buy deduction is computed from the U.S. reading: it moved after the later of the previous
  // U.S. and Korean readings (kr[0]), by the reporting U.S. reading (us[2]). The U.S. leg's window is the U.S. pair.
  assert.deepEqual([out.occurredAfter,out.occurredBy],[w.at.kr[0],w.at.us[2]]);assert.deepEqual([inn.occurredAfter,inn.occurredBy],[w.at.us[1],w.at.us[2]]);
  // Korean baseline at the Korean reading between the U.S. readings, before the report: the leg is after it (confirmed),
  // so it moves the baseline with the Korean loss value, which deducts the unpaid KRW from the report (S3a-2;
  // tests/loss-funding-e2e.test.cjs checks the loss itself through the real valuation).
  assert.deepEqual(w.side('KR',w.at.kr[0]),{after:-134000,uncertain:0});
  // Korean baseline at the Korean reading after the report: already in it.
  assert.deepEqual(w.side('KR',w.at.kr[1]),{after:0,uncertain:0});
  // U.S. baselines at the U.S. readings: before the report, after; at the reporting reading, in it.
  assert.deepEqual(w.side('US',w.at.us[1]),{after:100,uncertain:0});assert.deepEqual(w.side('US',w.at.us[2]),{after:0,uncertain:0});
  // A baseline inside the window (not at a reading the recorder saw, e.g. an order-path reading) stays uncertain.
  assert.deepEqual(w.side('US',w.at.us[1]+30000),{after:0,uncertain:100});
});

// (S3a's second test, the K1 loss check with netEquityOf set by hand, is replaced by tests/loss-funding-e2e.test.cjs,
// which runs the real valuation: review F1 of S3a round 1.)

test('G1/R2 K2: the Korean leg between two Korean readings, the U.S. leg at the U.S. settlement reading\'s pair',()=>{
  // The U.S. side carries the buy ($50 of U.S. cash), KIS settles: $50 in USD, $50 short, exchanged at the next
  // Korean reading (67,000). Korean readings: kr[0] before the settlement, kr[1] between it and the exchange, kr[2].
  const w=lone();w.us(50,0,[]);const o=[w.b('o1',100)];w.us(50,0,o,{open:['o1'],openUSD:100});w.us(50,134000,o);assert.equal(w.f.rows('A')[0].state,'us');
  w.kr(3000000);w.us(0,0,o);assert.equal(w.f.rows('A')[0].state,'awaiting-krw');w.kr(3000000);w.kr(2933000);
  const out=flow(w,'out'),inn=flow(w,'in');assert.equal(out.amount,-67000);assert.equal(inn.amount,50);
  assert.deepEqual([out.occurredAfter,out.occurredBy],[w.at.kr[1],w.at.kr[2]]);
  assert.deepEqual([inn.occurredAfter,inn.occurredBy],[w.at.us[2],w.at.us[3]],'the U.S. figure rose by the shortfall at the settlement reading');
  assert.equal(inn.day,out.day,'booked on the day of the reading that booked it');
  // Korean baselines: before the exchange (kr[0], kr[1]) after; at the exchange reading, in it.
  for(const b of [w.at.kr[0],w.at.kr[1]])assert.deepEqual(w.side('KR',b),{after:-67000,uncertain:0});assert.deepEqual(w.side('KR',w.at.kr[2]),{after:0,uncertain:0});
  // U.S. baselines: before the settlement reading after; at it, in it (the exchange reading changes no U.S. figure).
  assert.deepEqual(w.side('US',w.at.us[2]),{after:50,uncertain:0});assert.deepEqual(w.side('US',w.at.us[3]),{after:0,uncertain:0});
});

test('G1/R2 reversal pairs: the full reversal at a U.S. reading; the partial one\'s U.S. leg at the U.S. settlement reading, its Korean leg at the Korean pair',()=>{
  // Full: K1, then KIS pays the whole buy in USD (the F1 sequence).
  {const w=lone();w.us(0,0,[]);const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});w.us(0,134000,o);w.kr(3000000);w.later(20*3600000);w.us(150,134000,o);w.us(50,0,o);
    const ro=flow(w,'reversal-out'),ri=flow(w,'reversal-in');assert.deepEqual([ro.occurredAfter,ro.occurredBy],[w.at.us[3],w.at.us[4]]);assert.deepEqual([ri.occurredAfter,ri.occurredBy],[w.at.us[3],w.at.us[4]],'later of the previous U.S. and Korean readings');
    // Korean baseline at kr[0], after the report (K1 out in it) and before the reversal: the reversal's +134,000 is after
    // it, as the Korean deduction ended after the baseline (the value rose by it).
    assert.deepEqual(w.side('KR',w.at.kr[0]),{after:134000,uncertain:0});
    assert.deepEqual(w.side('KR',w.at.us[1]),{after:0,uncertain:0},'a baseline before the report: out and back, both after, net 0');}
  // Partial: K1, then $60 arrives and KIS pays $60 in USD, exchanging 53,600 at the next Korean reading (the F2 sequence).
  {const w=lone();w.us(0,0,[]);const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});w.us(0,134000,o);w.kr(3000000);w.later(20*3600000);w.us(60,134000,o);w.us(0,0,o);w.kr(3000000);w.kr(3000000-53600);
    const ro=flow(w,'reversal-out'),ri=flow(w,'reversal-in');assert.equal(ri.amount,80400);
    assert.deepEqual([ro.occurredAfter,ro.occurredBy],[w.at.us[3],w.at.us[4]],'the U.S. cash fell at the U.S. settlement reading');
    // S3a-2: the U.S. leg is booked at the U.S. settlement reading itself, not at the Korean reading.
    assert.ok(ro.createdAt<ri.createdAt&&ro.createdAt<=w.at.us[4],'booked at the U.S. settlement reading');
    // S3a-2: the reported KRW stays deducted until the Korean exchange is read (krwUnpaidKRW), so the Korean loss value
    // moves at that reading only, by +134,000 - 53,600: the Korean leg's window is the Korean pair.
    assert.deepEqual([ri.occurredAfter,ri.occurredBy],[w.at.kr[1],w.at.kr[2]]);
    assert.deepEqual(w.side('KR',w.at.kr[0]),{after:80400,uncertain:0},'baseline after the report, before the exchange: the reversal is after');
    assert.deepEqual(w.side('KR',w.at.us[1]),{after:-134000+80400,uncertain:0},'baseline before the report: K1 out and the reversal in, both after');
    assert.deepEqual(w.side('KR',w.at.kr[1]),{after:80400,uncertain:0},'baseline between the U.S. settlement and the exchange: after (the loss value had not moved)');}
});

test('G1/R2: the window changes nothing else: ids, days, amounts and states equal the code before S3a; the series day and the detector do not read it',()=>{
  const run=strip=>{const w=lone(undefined,{strip});w.us(0,0,[]);const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});w.us(0,134000,o);w.kr(3000000);w.later(20*3600000);w.us(60,134000,o);w.us(0,0,o);w.kr(3000000);w.kr(3000000-53600);
    const p=w.us(0,0,o);return {flows:w.flows().map(({occurredAfter:_a,occurredBy:_b,createdAt:_c,...f})=>f).sort((a,b)=>a.id.localeCompare(b.id)),rows:w.f.rows('A').map(({window:_w,...r})=>r),current:p};};
  assert.deepEqual(run(false),run(true));
  // occurredAfter is read only where a loss check places a flow (PerformanceHistory.flowsSince) and by the settlement
  // records of S4 (reconciliations and restatements, for flows they reclassify; funding flows are never reclassified).
  const read=f=>fs.readFileSync(path.join(__dirname,'..','electron',f),'utf8');
  const perf=read('performance.cjs').split('\n').filter(l=>l.includes('occurredAfter'));assert.equal(perf.length,2);assert.ok(perf.some(l=>l.includes('addFlow')||l.includes('...(Number.isFinite(value.occurredAfter)')));assert.ok(perf.some(l=>l.includes('const side=f=>')));
  assert.ok(read('flow-detector.cjs').split('\n').filter(l=>l.includes('occurredAfter')).every(l=>/addFlow|spanOf/.test(l)),'the detector only writes it, on its own detected flows');
});

test('G1/R2: a leg whose earlier reading cannot be named stays of uncertain timing (the recorder\'s first reading)',()=>{
  // The report is already there at the recorder's first U.S. reading of a new buy: no previous U.S. reading.
  const w=lone();const o=[w.b('o1',100)];w.us(0,0,o,{open:['o1'],openUSD:100});const first=w.flows();assert.equal(first.length,0);
  // A fresh database whose first U.S. reading books K1 is not possible (the buy is history at the first reading, M5), so
  // the case is the book() call itself with no previous reading.
  const f=w.f.book('A','x','out',{market:'KR',amount:-1000,day:'2026-11-09',at:Date.parse('2026-11-09T15:00:00Z'),after:null,note:'x'});assert.equal('occurredAfter' in f,false);
  assert.deepEqual(w.side('KR',Date.parse('2026-11-09T14:00:00Z')),{after:0,uncertain:-1000});
});

