// Safe outcomes for the independent review of the 1.5.48 fixes (artifacts/reviews/2026-11-10-1548-fixes/independent-review.md).
// The review's diagnostic probes (artifacts/reviews/2026-11-10-independent-fixes-repro.cjs) asserted each defect; these
// assert the fixed behaviour: R1 a new day whose valuation cannot be read is pending, never KIS's total, and recovers
// with a labelled late basis; R2 an approval the product or credit rules require at submission holds an automatic order
// (and an automatic raise), while manual approval and protective orders go through; R3 a configured today-flow reader
// returning nothing is unavailable, not zero.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {Exposure}=require('../electron/exposure.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');

function world({db=new DatabaseSync(':memory:'),cash=10000,net=null,configure=true,limits={},during=null,funding=false}={}){
  const calls=[];const balance={accountKey:'audit',environment:'mock',cash,settledCash:cash,reportedTotal:cash,holdings:[],timestamp:new Date().toISOString()};
  const broker={request:async(op,payload)=>{calls.push({op,payload});if(op==='prepare-order')return {balance,ticket:'fake'};if(op==='place-order')return {brokerOrderId:'fake-1'};if(op==='revise-order')return {brokerOrderId:'R1'};throw new Error('unexpected '+op);}};
  const engine=new LiveEngine(db,broker,()=>({status:'connected',snapshot:balance}));let day='2030-01-10';engine.day=()=>day;
  if(net)engine.netEquityOf=net;
  if(funding){const ledger=new FundingLedger(db,{fresh:async m=>{if(during)during();return m==='KR'?{...balance,timestamp:new Date().toISOString()}:null;}});ledger.init();engine.funding=ledger;}
  const taken=[];engine.baselineTaken=p=>taken.push(p.baselineAt);
  if(configure)engine.configure({symbols:[],maxOrderKRW:5000,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30},...limits},'ENABLE MOCK');
  const places=()=>calls.filter(c=>c.op==='place-order').length;
  return {db,calls,balance,engine,taken,places,setDay:d=>{day=d;}};}
const failing=()=>{throw new Error('READ_FAILED');};

// R1 — the daily-loss basis when the account valuation cannot be read.
test('R1: a failed valuation at a new day leaves the day pending, never on KIS\'s total; the loss check is unavailable',()=>{
  for(const bad of [failing,()=>null,()=>undefined,()=>({low:'x',high:1,version:'net'}),()=>({low:2,high:1,version:'net'}),()=>({low:1,high:1}),()=>({low:1,high:1,version:'broker-total'})]){
    const w=world({net:()=>({low:1000,high:1000,version:'net-test'})});assert.equal(w.engine.policy().valuation,'net-test');assert.equal(w.taken.length,1);
    w.setDay('2030-01-11');w.engine.netEquityOf=bad;w.engine.observeBalance(w.balance);
    const p=w.engine.policy();assert.equal(p.day,'2030-01-11');assert.equal(p.baseline,null);assert.equal(p.valuation,null,'not broker-total');assert.ok(p.baselinePending?.reason);
    assert.equal(w.taken.length,1,'no settlement snapshot for a basis that does not exist');
    const l=w.engine.currentLoss();assert.equal(l.unavailable,true);assert.equal(l.loss,null);assert.equal(l.breached,false);assert.match(l.reasons[0],/the day's opening value could not be read/);assert.match(l.reasons[1],/new buys are restricted/);
    // The context the AI reads carries no invented baseline.
    assert.equal(w.engine.adjustedBaseline(p),null);}
});
test('R1: configure on a new day with an unreadable valuation is pending too; a percentage limit is not computed on nothing',()=>{
  const w=world({net:failing,limits:{lossLimit:{mode:'percent',value:3}}});const p=w.engine.policy();
  assert.equal(p.baseline,null);assert.equal(p.valuation,null);assert.equal(p.maxDailyLossKRW,null);assert.match(p.baselinePending.reason,/READ_FAILED/);assert.equal(w.taken.length,0);
  assert.equal(w.engine.currentLoss().unavailable,true);
  // Configured again while still failing: still pending, from when it began.
  const since=p.baselinePending.since;w.engine.configure({symbols:[],lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');assert.equal(w.engine.policy().baselinePending.since,since);assert.equal(w.engine.policy().baseline,null);
});
test('R1: a pending day stays pending across a restart and recovers with a late basis that says it is not the opening',()=>{
  const db=new DatabaseSync(':memory:');const w=world({db,net:()=>({low:1000,high:1000,version:'net-test'})});w.setDay('2030-01-11');w.engine.netEquityOf=failing;w.engine.observeBalance(w.balance);
  const since=w.engine.policy().baselinePending.since;
  // Restart: a new engine over the same database, the valuation still failing.
  const again=new LiveEngine(db,{request:async()=>{throw new Error('unexpected');}},()=>({status:'connected',snapshot:w.balance}));again.day=()=>'2030-01-11';again.netEquityOf=failing;const taken=[];again.baselineTaken=p=>taken.push(p.baselineAt);
  assert.equal(again.currentLoss().unavailable,true);again.observeBalance(w.balance);assert.equal(again.policy().baseline,null);assert.equal(again.policy().baselinePending.since,since,'the pending state keeps when it began');
  // Recovered at 950 while KIS's total is unchanged: the basis is taken now and labelled late, never KIS's total.
  again.netEquityOf=()=>({low:950,high:950,version:'net-test'});again.observeBalance(w.balance);
  const p=again.policy();assert.deepEqual([p.baseline,p.valuation],[950,'net-test']);assert.equal(p.baselinePending,undefined);assert.equal(p.baselineLate.openingFailedAt,since);assert.match(p.baselineLate.reason,/READ_FAILED/);assert.equal(taken.length,1,'its settlement snapshot is taken with it');
  let l=again.currentLoss();assert.equal(l.unavailable,undefined);assert.equal(l.loss,0);assert.equal(l.late,true);assert.ok(l.reasons.some(r=>/not since the day's opening/.test(r)),'it does not claim the loss since the opening');
  // A loss after the late basis is measured, and a breach is a breach (at least that much was lost today).
  again.netEquityOf=()=>({low:900,high:900,version:'net-test'});l=again.currentLoss();assert.equal(l.loss,50);assert.equal(l.breached,true);
  // The next day starts normally, with no late label.
  again.day=()=>'2030-01-12';again.observeBalance(w.balance);assert.equal(again.policy().baselineLate,undefined);assert.equal(again.policy().baseline,900);assert.equal(again.currentLoss().late,undefined);
});
test('R1: configure on a pending day takes the late basis once the valuation reads again',()=>{
  const w=world({net:failing});assert.equal(w.engine.policy().baseline,null);const since=w.engine.policy().baselinePending.since;
  w.engine.netEquityOf=()=>({low:980,high:990,version:'net-test'});w.engine.configure({symbols:[],lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');
  const p=w.engine.policy();assert.deepEqual([p.baseline,p.baselineHigh,p.valuation],[980,990,'net-test']);assert.equal(p.baselineLate.openingFailedAt,since);assert.equal(w.taken.length,1);
});
test('R1: a known day keeps its basis and peak through a failed reading; with no valuation configured KIS\'s total is the basis',()=>{
  const w=world({net:()=>({low:1000,high:1000,version:'net-test'})});w.engine.netEquityOf=failing;w.engine.observeBalance(w.balance);
  const p=w.engine.policy();assert.deepEqual([p.baseline,p.valuation,p.dayPeakEquity],[1000,'net-test',1000]);assert.equal(w.engine.currentLoss().unavailable,true);
  const plain=world();assert.equal(plain.engine.policy().valuation,'broker-total');assert.equal(plain.engine.policy().baseline,10000);assert.equal(plain.engine.currentLoss().loss,0);
  plain.setDay('2030-01-11');plain.engine.observeBalance(plain.balance);assert.equal(plain.engine.policy().valuation,'broker-total');assert.equal(plain.engine.policy().baselinePending,undefined);
});

// R2 — approvals required at submission.
function withMaster(w,rows=[['005930','Samsung','Samsung','KOSPI','stock']]){w.db.exec('CREATE TABLE IF NOT EXISTS securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT)');for(const r of rows)w.db.prepare('INSERT INTO securities VALUES(?,?,?,?,?)').run(...r);w.engine.exposure=new Exposure(w.db);return w;}
test('R2: a product unclassifiable at submission holds the automatic order for approval; nothing is sent',async()=>{
  const w=withMaster(world());w.engine.enableAuto('ENABLE AUTO MOCK');const p=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});assert.ok(!p.requiresApproval);
  w.db.exec('DELETE FROM securities');const r=await w.engine.autoSubmit(p.id);
  assert.equal(w.places(),0,'place-order was not called');assert.equal(r.reason,'APPROVAL_REQUIRED');assert.equal(r.status,'Ready');
  const o=w.engine.orders()[0];assert.equal(o.requiresApproval,true,'the new requirement is saved');assert.match(o.approvalReason,/cannot classify/);assert.equal(o.product.kind,'unclassified');assert.equal(o.status,'Ready');
  // Asked again automatically: it waits (the saved requirement), still nothing sent.
  assert.equal((await w.engine.autoSubmit(p.id)).reason,'APPROVAL_REQUIRED');assert.equal(w.places(),0);
  // Your deliberate approval (the confirmation phrase) sends it.
  const sent=await w.engine.submit(p.id,'PLACE MOCK ORDER');assert.equal(sent.status,'Accepted');assert.equal(w.places(),1);
});
test('R2: a leveraged-product policy changed from automatic to approval-only holds an automatic order proposed before',async()=>{
  const w=withMaster(world(),[['122630','KODEX Leverage','KODEX Leverage','KOSPI','etf']]);const x=w.engine.exposure;x.setOverride('122630',2);x.savePolicy('audit',{leveragedEtps:{enabled:true,auto:true,maxPctOfEquity:100}});
  w.engine.enableAuto('ENABLE AUTO MOCK');const p=w.engine.propose({symbol:'122630',side:'Buy',quantity:1,limitPrice:1000});assert.equal(p.requiresApproval,false);
  x.savePolicy('audit',{leveragedEtps:{auto:false}});const r=await w.engine.autoSubmit(p.id);
  assert.equal(w.places(),0);assert.equal(r.reason,'APPROVAL_REQUIRED');assert.match(w.engine.orders()[0].approvalReason,/leveraged rule requires your approval/);
});
test('R2: a change during the funds check (an asynchronous boundary) is caught before sending, and the reservation released',async()=>{
  let w;w=withMaster(world({funding:true,during:()=>w.db.exec('DELETE FROM securities')}));w.engine.enableAuto('ENABLE AUTO MOCK');
  const p=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});const r=await w.engine.autoSubmit(p.id);
  assert.equal(w.places(),0,'rechecked after the funds were admitted');assert.equal(r.reason,'APPROVAL_REQUIRED');assert.equal(w.engine.funding.commitments('audit').krw,0,'nothing stays reserved');
});
test('R2: a protective sale of an unclassifiable product is still sent automatically',async()=>{
  const w=withMaster(world());w.balance.holdings=[{symbol:'005930',name:'Samsung',quantity:2,cost:900,price:1000,marketValue:2000}];w.engine.enableAuto('ENABLE AUTO MOCK');
  const p=w.engine.propose({symbol:'005930',side:'Sell',quantity:1,limitPrice:1000});w.db.exec('DELETE FROM securities');
  const r=await w.engine.autoSubmit(p.id);assert.equal(r.status,'Accepted');assert.equal(w.places(),1);
});
test('R2: automatic tracking does not raise a buy whose product now needs approval; a lower price still goes',async()=>{
  const w=withMaster(world(),[['122630','KODEX Leverage','KODEX Leverage','KOSPI','etf']]);const x=w.engine.exposure;x.setOverride('122630',2);x.savePolicy('audit',{leveragedEtps:{enabled:true,auto:false,maxPctOfEquity:100}});
  w.engine.save({id:'o1',accountKey:'audit',market:'KR',environment:'mock',symbol:'122630',side:'Buy',quantity:1,limitPrice:1000,notional:1000,filled:0,status:'Accepted',brokerOrderId:'1',day:w.engine.day(),createdAt:Date.now()});
  await assert.rejects(w.engine.revise('o1',{price:1100}),/APPROVAL_REQUIRED/);assert.equal(w.calls.filter(c=>c.op==='revise-order').length,0);
  await w.engine.revise('o1',{price:900});assert.equal(w.calls.filter(c=>c.op==='revise-order').length,1,'a reduction is not held back');
});

// R3 — a configured today-flow reader.
test('R3: a configured today-flow reader returning nothing or a non-number is unavailable; a number is used; no reader is zero',()=>{
  const w=world();for(const value of [null,undefined,'12',NaN,Infinity,{}]){w.engine.flowsToday=()=>value;const l=w.engine.currentLoss();assert.equal(l.unavailable,true,String(value));assert.equal(l.loss,null);assert.match(l.reasons[0],/today's deposits and withdrawals could not be read/);}
  w.engine.flowsToday=()=>0;assert.equal(w.engine.currentLoss().unavailable,undefined);assert.equal(w.engine.currentLoss().loss,0);
  w.engine.flowsToday=()=>500;w.balance.reportedTotal=10500;assert.equal(w.engine.currentLoss().loss,0,'a deposit is not gain');
  delete w.engine.flowsToday;w.balance.reportedTotal=10000;assert.equal(w.engine.currentLoss().loss,0);assert.equal(w.engine.currentLoss().unavailable,undefined);
});
