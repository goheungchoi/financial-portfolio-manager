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

// R4 (round 2): whether a submission is automatic belongs to that call; a competing call refused as busy cannot change it.
// A gate that pauses one step of the first submission until released.
function gate(){let release,entered;const paused=new Promise(r=>release=r),reached=new Promise(r=>entered=r);return {release,reached,wait:async()=>{entered();await paused;}};}
function pauseFunds(w){const g=gate(),real=w.engine.funding.admit.bind(w.engine.funding);w.engine.funding.admit=async a=>{await g.wait();return real(a);};return g;}
test('R4: an overlapping automatic call refused as busy cannot switch off the first one\'s final approval check (unclassified)',async()=>{
  const w=withMaster(world({funding:true}));w.engine.enableAuto('ENABLE AUTO MOCK');const g=pauseFunds(w);
  const p=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000}),p2=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});
  const first=w.engine.autoSubmit(p.id);await g.reached;
  await assert.rejects(w.engine.autoSubmit(p2.id),/KIS_ORDER_BUSY/);assert.equal('submittingAutomatically' in w.engine,false,'no engine-wide mode exists to be cleared');
  w.db.exec('DELETE FROM securities');g.release();const r=await first;
  assert.equal(r.reason,'APPROVAL_REQUIRED');assert.equal(w.places(),0,'nothing sent');const o=w.engine.orders().find(x=>x.id===p.id);assert.equal(o.status,'Ready');assert.equal(o.requiresApproval,true);
  assert.equal(w.engine.funding.commitments('audit').krw,0,'its reservation is released as unsent');
});
test('R4: the same overlap with a leveraged policy changed to approval-only while the first waits',async()=>{
  const w=withMaster(world({funding:true}),[['122630','KODEX Leverage','KODEX Leverage','KOSPI','etf']]);const x=w.engine.exposure;x.setOverride('122630',2);x.savePolicy('audit',{leveragedEtps:{enabled:true,auto:true,maxPctOfEquity:100}});
  w.engine.enableAuto('ENABLE AUTO MOCK');const g=pauseFunds(w);
  const p=w.engine.propose({symbol:'122630',side:'Buy',quantity:1,limitPrice:1000}),p2=w.engine.propose({symbol:'122630',side:'Buy',quantity:1,limitPrice:1000});
  const first=w.engine.autoSubmit(p.id);await g.reached;await assert.rejects(w.engine.autoSubmit(p2.id),/KIS_ORDER_BUSY/);
  x.savePolicy('audit',{leveragedEtps:{auto:false}});g.release();const r=await first;
  assert.equal(r.reason,'APPROVAL_REQUIRED');assert.equal(w.places(),0);assert.equal(w.engine.funding.commitments('audit').krw,0);
});
test('R4: an automatic extended-session order still waits for approval under an overlap at prepare-order',async()=>{
  const w=withMaster(world());w.engine.enableAuto('ENABLE AUTO MOCK');const g=gate(),request=w.engine.broker.request;
  w.engine.broker.request=async(op,payload)=>{if(op==='prepare-order'){const r=await request(op,payload);await g.wait();return {...r,session:{id:'pre-market',regular:false,approval:true}};}return request(op,payload);};
  const p=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000}),p2=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});
  const first=w.engine.autoSubmit(p.id);await g.reached;await assert.rejects(w.engine.autoSubmit(p2.id),/KIS_ORDER_BUSY/);g.release();
  const r=await first;assert.equal(r.reason,'APPROVAL_REQUIRED');assert.equal(w.places(),0);assert.equal(w.engine.orders().find(x=>x.id===p.id).status,'Ready');
});
test('R4: a manual submission stays manual through an overlapping automatic call; it is your approval and is sent',async()=>{
  const w=withMaster(world({funding:true}));w.engine.enableAuto('ENABLE AUTO MOCK');const g=pauseFunds(w);
  const p=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000}),p2=w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});
  const manual=w.engine.submit(p.id,'PLACE MOCK ORDER');await g.reached;await assert.rejects(w.engine.autoSubmit(p2.id),/KIS_ORDER_BUSY/);
  w.db.exec('DELETE FROM securities');g.release();const r=await manual;assert.equal(r.status,'Accepted');assert.equal(w.places(),1);
  // The refused automatic one, retried after the order above is reconciled, is held as an automatic order must be.
  w.engine.writeOrder({...w.engine.orders().find(x=>x.id===p.id),status:'Filled',filled:1});
  const again=await w.engine.autoSubmit(p2.id);assert.equal(again.reason,'APPROVAL_REQUIRED');assert.equal(w.places(),1);
});

// The late-basis decision (round 2): with a loss limit on, automatic new exposure stays restricted for the rest of the day.
function lateDay(limits={}){const w=world({net:()=>({low:1000,high:1000,version:'net-test'}),limits});w.setDay('2030-01-11');w.engine.netEquityOf=failing;w.engine.observeBalance(w.balance);
  w.engine.netEquityOf=()=>({low:950,high:950,version:'net-test'});w.engine.observeBalance(w.balance);assert.ok(w.engine.policy().baselineLate);return w;}
test('late basis: the loss since it is shown and new exposure stays restricted for the day; the next day clears it; no limit restricts nothing',()=>{
  const w=lateDay();let l=w.engine.currentLoss();assert.equal(l.loss,0,'still measured');assert.equal(l.restrictedForDay,true);assert.ok(l.reasons.some(r=>/rest of the day/.test(r)));
  w.engine.netEquityOf=()=>({low:1000,high:1000,version:'net-test'});assert.equal(w.engine.currentLoss().restrictedForDay,true,'a later gain does not lift it');
  w.setDay('2030-01-12');w.engine.observeBalance(w.balance);l=w.engine.currentLoss();assert.equal(l.restrictedForDay,undefined);assert.equal(l.late,undefined);
  const off=lateDay({lossLimit:{mode:'off',value:0}});assert.equal(off.engine.currentLoss().late,true);assert.equal(off.engine.currentLoss().restrictedForDay,undefined,'a deliberately disabled limit is its own policy');
});
test('late basis: automatic raises are held, lower prices still go; automation blocks conditional buys but not sales',async()=>{
  const w=lateDay();w.engine.save({id:'o1',accountKey:'audit',market:'KR',environment:'mock',symbol:'005930',side:'Buy',quantity:1,limitPrice:1000,notional:1000,filled:0,status:'Accepted',brokerOrderId:'1',day:w.engine.day(),createdAt:Date.now()});
  await assert.rejects(w.engine.revise('o1',{price:1100}),/DAILY_LOSS_RESTRICTED/);await w.engine.revise('o1',{price:900});assert.equal(w.calls.filter(c=>c.op==='revise-order').length,1);
  const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'Audit',price:1000}],()=>[]),{},()=>{});let proposed=0;
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true,lossAction:'review'});
  a.marketQuotes=()=>[{symbol:'005930',price:1000,timestamp:Date.now()}];a.placementPrice=async()=>({price:1000});const loss=w.engine.currentLoss();
  a.live={market:'KR',identity:()=>'audit',autoEnabled:true,enabled:true,getState:()=>({loss}),orders:()=>[],
    context:async()=>({marketSession:{open:true},quotes:a.marketQuotes(),positions:{'005930':{quantity:5}},equity:100000,cash:100000}),propose:()=>({id:'p'+(++proposed),status:'Ready'}),autoSubmit:async id=>({id,status:'Accepted'})};
  assert.deepEqual(a.emergencyState().lateMarkets,['KR']);assert.deepEqual(a.emergencyState().unavailableMarkets,[]);
  const arm=side=>{const r=a.desk.setOrder(a.watchScope(),{action:'add',symbol:'005930',side,quantity:1,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:2000}],combine:'all',purpose:side==='Buy'?'entry':'stop_loss',expiresInHours:1,reason:'test'},{config:a.config,universe:['005930'],quotes:a.marketQuotes()});return a.desk.orders(a.watchScope()).find(x=>x.id===r.id);};
  const buy=await a.fireConditional(arm('Buy'));assert.equal(proposed,0,'no automatic buy, though the loss-limit response is review');assert.match(JSON.stringify(buy??a.desk.recentOrders(a.watchScope(),5)),/rest of the day/);
  await a.fireConditional(arm('Sell'));assert.equal(proposed,1,'a protective sale is not held back');
});

// R5 (round 3): the daily-loss restriction is rechecked at the send boundary, after every asynchronous step, for an
// automatic order that opens exposure.
function r5(){const w=world({funding:true,net:()=>({low:10000,high:10000,version:'net-test'})});w.engine.enableAuto('ENABLE AUTO MOCK');assert.equal(w.engine.currentLoss().unavailable,undefined);return w;}
const buy=w=>w.engine.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});
function refusedUnsent(w,id,result){assert.equal(w.places(),0,'place-order was not called');const o=w.engine.orders().find(x=>x.id===id);assert.equal(o.status,'Ready','still yours to approve');assert.equal(o.reason,'DAILY_LOSS_RESTRICTED');assert.equal(w.engine.funding.commitments('audit').krw,0,'released as unsent');}
test('R5: loss data unreadable during the funds check: refused at the send boundary, nothing sent, funds released',async()=>{
  const w=r5(),p=buy(w),real=w.engine.funding.admit.bind(w.engine.funding);w.engine.funding.admit=async a=>{const r=await real(a);w.engine.flowsSince=()=>{throw new Error('READ_FAILED');};return r;};
  await assert.rejects(w.engine.autoSubmit(p.id),/DAILY_LOSS_RESTRICTED/);refusedUnsent(w,p.id);assert.equal(w.engine.currentLoss().unavailable,true);
});
test('R5: prepare-order crossing into a day with a late basis: refused; a pending day under prepare-order too',async()=>{
  const w=r5(),p=buy(w),request=w.engine.broker.request;
  w.engine.broker.request=async(op,payload)=>{if(op==='prepare-order'){w.setDay('2030-01-11');w.engine.netEquityOf=failing;w.engine.observeBalance(w.balance);w.engine.netEquityOf=()=>({low:10000,high:10000,version:'net-test'});}return request(op,payload);};
  await assert.rejects(w.engine.autoSubmit(p.id),/DAILY_LOSS_RESTRICTED/);assert.equal(w.engine.currentLoss().restrictedForDay,true);assert.equal(w.places(),0);assert.equal(w.engine.funding.commitments('audit').krw,0);
  // Still failing when prepare-order returns: the day stays pending, and the order is refused the same way.
  const v=r5(),q=buy(v),rq=v.engine.broker.request;v.engine.broker.request=async(op,payload)=>{if(op==='prepare-order'){v.setDay('2030-01-11');v.engine.netEquityOf=failing;}return rq(op,payload);};
  // (the new-exposure base itself is unreadable then, so the earlier A4 refusal may come first: either way, nothing is sent)
  await assert.rejects(v.engine.autoSubmit(q.id),/DAILY_LOSS_RESTRICTED|RISK_DATA_UNAVAILABLE/);assert.equal(v.places(),0);assert.equal(v.engine.funding.commitments('audit').krw,0);
});
test('R5: a change after automation\'s early check (during placement pricing, before autoSubmit) is refused by the engine',async()=>{
  const w=r5(),p=buy(w);w.engine.flowsSince=()=>({confirmed:Number.NaN,unresolved:0});
  await assert.rejects(w.engine.autoSubmit(p.id),/DAILY_LOSS_RESTRICTED/);refusedUnsent(w,p.id);
});
test('R5: unchanged inputs still send; manual submissions, sales and covers are not held; a disabled limit is its own policy',async()=>{
  const ok=r5(),p=buy(ok);assert.equal((await ok.engine.autoSubmit(p.id)).status,'Accepted');assert.equal(ok.places(),1);
  // Manual: your confirmation is the authorization, even while the check is unavailable.
  const m=r5(),q=buy(m);m.engine.flowsSince=()=>{throw new Error('READ_FAILED');};assert.equal((await m.engine.submit(q.id,'PLACE MOCK ORDER')).status,'Accepted');
  // A protective sale while the day is restricted.
  const s=r5();s.balance.holdings=[{symbol:'005930',name:'Samsung',quantity:2,cost:900,price:1000,marketValue:2000}];const sale=s.engine.propose({symbol:'005930',side:'Sell',quantity:1,limitPrice:1000});
  s.engine.flowsSince=()=>{throw new Error('READ_FAILED');};assert.equal((await s.engine.autoSubmit(sale.id)).status,'Accepted');
  // The position-effect rules: a cover closes, a short opens; a plain sale closes.
  assert.equal(s.engine.lossRestriction({side:'Buy',credit:{kind:'cover'}}),null);assert.equal(s.engine.lossRestriction({side:'Sell',credit:{kind:'short'}}),'DAILY_LOSS_RESTRICTED');
  assert.equal(s.engine.lossRestriction({side:'Sell',credit:{kind:'margin-sell'}}),null);assert.equal(s.engine.lossRestriction({side:'Sell'}),null);assert.equal(s.engine.lossRestriction({side:'Buy',credit:{kind:'margin-buy'}}),'DAILY_LOSS_RESTRICTED');
  // No loss limit: a late day restricts nothing at the send boundary.
  const off=lateDay({lossLimit:{mode:'off',value:0}});off.engine.funding=new FundingLedger(off.db,{fresh:async m=>m==='KR'?{...off.balance,timestamp:new Date().toISOString()}:null});off.engine.funding.init();off.engine.enableAuto('ENABLE AUTO MOCK');assert.equal(off.engine.currentLoss().late,true);
  assert.equal((await off.engine.autoSubmit(buy(off).id)).status,'Accepted');
});
test('R5: restart and next day: the restriction follows the saved day; the slot of a refused automatic order is released',async()=>{
  const db=new DatabaseSync(':memory:');const w=world({db,funding:true,net:()=>({low:10000,high:10000,version:'net-test'})});w.setDay('2030-01-11');w.engine.netEquityOf=failing;w.engine.observeBalance(w.balance);
  // Restart on the pending day; the valuation reads again (a late basis): the new engine refuses an automatic buy; the next day with a readable valuation sends.
  const e2=new LiveEngine(db,w.engine.broker,()=>({status:'connected',snapshot:w.balance}));let day='2030-01-11';e2.day=()=>day;e2.netEquityOf=()=>({low:10000,high:10000,version:'net-test'});e2.funding=w.engine.funding;e2.configure({symbols:[],maxOrderKRW:5000,lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');e2.enableAuto('ENABLE AUTO MOCK');
  const p=e2.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});await assert.rejects(e2.autoSubmit(p.id),/DAILY_LOSS_RESTRICTED/);assert.equal(w.places(),0);
  // The automatic-order slot follows the unsent outcome.
  const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');const adb=new DatabaseSync(':memory:');const a=new Automation(adb,new PaperEngine(adb,[{symbol:'005930',name:'Audit',price:1000}],()=>[]),{},()=>{});
  const slot=a.guardrails.reserveSlot({cap:1,source:'review',ref:p.id});assert.ok(slot);a.settleAutoSlot(slot,e2.orders().find(x=>x.id===p.id));assert.equal(a.guardrails.autoOrdersToday(),0,'released: nothing was sent');
  day='2030-01-12';e2.netEquityOf=()=>({low:10000,high:10000,version:'net-test'});e2.observeBalance(w.balance);const q=e2.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});
  assert.equal((await e2.autoSubmit(q.id)).status,'Accepted');assert.equal(w.places(),1);
});
