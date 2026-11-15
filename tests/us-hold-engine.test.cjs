// S3a G2 (settlement clean-up, s3/design.md, s3/review.md rulings R3-R5): a U.S. reading passes through the settlement
// hold once, and the U.S. engine never takes a held or provisional reading as its risk balance, baseline or peak; the
// review context shows the accepted reading. R5: the Korean hold holds only readings observeBalance refuses.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {UsBalanceHold,BalanceHold}=require('../electron/settlement-check.cjs');
const MIN=60000;
// G2. A U.S. engine over a mock balance; the hold as main.cjs useUs uses it (one acceptance per reading).
function usWorld(){const db=new DatabaseSync(':memory:');let now=Date.parse('2026-10-20T08:00:00+09:00');const clock=()=>now;
  const hold=new UsBalanceHold({clock});let accepts=0;
  const useUs=s=>{accepts++;const r=hold.accept(s);const shown=r.provisional?{...r.balance,settlementProvisional:r.reason}:r.balance;return {snapshot:shown,engine:r.held?{...r.balance,settlementHeld:r.reason}:shown,...(r.held?{heldReading:s}:{})};};
  const reading=(cash,buyKRW)=>({accountKey:'A:US',environment:'mock',cash,reportedTotal:1000+cash,holdings:[],pendingSaleProceeds:0,unsettled:{buyKRW,sellKRW:0},timestamp:new Date(now).toISOString()});
  let connection=reading(100,712000);const broker={raw:null,request:async op=>{if(op==='live-context')return {balance:broker.raw,quotes:[],marketSession:{open:true}};throw new Error('unexpected '+op);}};
  const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot:connection}),{market:'US'});
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');
  // The refresh path as main.cjs wires it (S3a): accept once, the engine gets the accepted view, callers get it too.
  const refresh=raw=>{const h=useUs(raw);e.observeBalance(h.engine);return {balance:h.engine,quotes:[],marketSession:{open:true}};};
  return {db,e,hold,useUs,reading,refresh,broker,accepts:()=>accepts,later:ms=>{now+=ms;},setConnection:s=>{connection=s;}};}

test('G2/R3: a held U.S. reading never becomes the engine\'s risk balance; the same reading through the refresh and the review context is accepted once',()=>{
  const w=usWorld();const ok=w.reading(100,712000);w.refresh(ok);assert.equal(w.e.riskBalance.cash,100);
  // The debit state: U.S. cash at the debit, the amount awaiting settlement gone.
  const debit=w.reading(-537.7,0);const supplied=w.refresh(debit);assert.equal(w.accepts(),2);assert.equal(supplied.balance.settlementHeld!=null,true);
  assert.equal(w.e.riskBalance.cash,100,'the risk balance is still the last consistent reading');
  const state=JSON.stringify({heldSince:w.hold.heldSince,consistent:w.hold.consistent?.cash});
  return w.e.context(supplied).then(ctx=>{
    assert.equal(w.accepts(),2,'the review context does not accept the reading again');assert.equal(JSON.stringify({heldSince:w.hold.heldSince,consistent:w.hold.consistent?.cash}),state,'the hold is as after the refresh alone');
    // R4: the review sees the accepted (last consistent) reading, without the hold's marks; before S3a it saw -537.70.
    assert.equal(ctx.depositCash,100);assert.equal(JSON.stringify(ctx).includes('settlementHeld'),false);assert.equal(JSON.stringify(ctx).includes('-537.7'),false);
    assert.equal(w.e.riskBalance.cash,100);});
});

test('G2/R3: a reading the engine reads itself passes through the hold once (acceptReading); after the bound it is provisional and still sets nothing',async()=>{
  const w=usWorld();w.e.acceptReading=b=>w.useUs(b).engine;w.refresh(w.reading(100,712000));
  w.broker.raw=w.reading(-537.7,0);const ctx=await w.e.context();assert.equal(w.accepts(),2,'one acceptance for the engine\'s own reading');assert.equal(ctx.depositCash,100);assert.equal(w.e.riskBalance.cash,100);
  // Past the hold's 3-hour bound the reading is used provisionally (C1d-1): shown, but no risk balance, baseline or peak.
  w.later(3*3600000+MIN);const later=await w.e.context();assert.equal(later.depositCash,-537.7,'shown provisionally, as in C1d-1');assert.equal(JSON.stringify(later).includes('settlementProvisional'),false);assert.equal(w.e.riskBalance.cash,100);
  // Consistent again: taken.
  w.broker.raw=w.reading(160,0);await w.e.context();assert.equal(w.e.riskBalance.cash,160);
});

test('G2: a held or provisional reading takes no day\'s baseline at a day boundary; the next consistent reading does',()=>{
  const w=usWorld();w.refresh(w.reading(100,712000));
  // Yesterday's policy: the next reading would start a new day.
  const p=w.e.policy();w.db.prepare('UPDATE live_policy SET payload=? WHERE accountKey=?').run(JSON.stringify({...p,day:'2000-01-01'}),'A:US');
  w.refresh(w.reading(-537.7,0));assert.equal(w.e.policy().day,'2000-01-01','no baseline from the held reading');
  w.e.observeBalance({...w.reading(-537.7,0),settlementProvisional:'x'});assert.equal(w.e.policy().day,'2000-01-01','nor from a provisional one');
  w.refresh(w.reading(160,0));assert.equal(w.e.policy().day,w.e.day());assert.equal(w.e.policy().baseline,1160);
});

test('G2/R3: main.cjs accepts each U.S. reading once and gives the engine and its callers that result; the order path uses the same hold',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8'),engine=fs.readFileSync(path.join(__dirname,'..','electron','live-engine.cjs'),'utf8');
  const refresh=main.slice(main.indexOf('automation.refreshUS=()=>'),main.indexOf('const portfolioView=new PortfolioView'));
  assert.equal(refresh.split('useUs(').length-1,1,'one acceptance in the refresh');assert.match(refresh,/usLive\.observeBalance\(h\.engine\)/);assert.match(refresh,/return \{\.\.\.value,balance:h\.engine\}/);assert.doesNotMatch(refresh,/observeBalance\(value\.balance\)/);
  assert.match(main,/usLive\.acceptReading=balance=>useUs\(balance\)\.engine/);
  assert.match(engine,/this\.observeBalance\(this\.acceptReading\?this\.acceptReading\(prepared\.balance\):prepared\.balance\)/,'the order path');
  assert.match(engine,/if\(!supplied&&this\.acceptReading\)/,'a supplied reading is never accepted twice');
});

test('R5: a Korean reading the Korean hold holds or uses provisionally is always one observeBalance refuses (the overnight flag)',()=>{
  let now=Date.parse('2026-11-05T00:04:00+09:00');const hold=new BalanceHold({clock:()=>now});
  const kr=(cash,check)=>({accountKey:'A',cash,settledCash:cash,holdings:[],timestamp:new Date(now).toISOString(),...(check?{settlementCheck:check}:{})});
  const cases=[kr(1000),kr(1000,{overnight:false,relationOff:true,offBy:5,fields:{}}),kr(1100,{overnight:true,offBy:100,fields:{bfdy_buy_amt:100}}),kr(1100,{overnight:true,offBy:100,fields:{bfdy_buy_amt:100}})];
  for(const [i,s] of cases.entries()){if(i===3)now+=3*3600000+MIN;const r=hold.accept(s);if(r.held||r.provisional)assert.equal(s.settlementCheck?.overnight,true,`case ${i}`);else assert.notEqual(s.settlementCheck?.overnight,true);}
  // And observeBalance refuses every overnight reading before anything else (live-engine.cjs).
  const engine=fs.readFileSync(path.join(__dirname,'..','electron','live-engine.cjs'),'utf8');assert.match(engine,/observeBalance\(snapshot\)\{if\(snapshot\.accountKey!==this\.identity\(\)\)return;if\(snapshot\.settlementCheck\?\.overnight\|\|/);
});
