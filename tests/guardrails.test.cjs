const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {buildDigest,seoulHour}=require('../electron/daily-digest.cjs');const autoLaunch=require('../electron/auto-launch.cjs');
const quote=()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}];
// A paper account 500,000 KRW below its 10,000,000 baseline, so a 500,000 loss limit is breached.
function fixture({breached=true,decide}={}){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:50000}],quote);
  if(breached){paper.configureLoss({mode:'amount',value:500000});paper.saveAccount({...paper.account(),paused:false,cash:9000000,positions:{'005930':{quantity:10,costTotal:1000000,markPrice:50000}}});}
  else paper.saveAccount({...paper.account(),paused:false});
  const decisions=[];const provider={request:async()=>{const decision=decide?decide(decisions.length):{action:'Buy',symbol:'005930',quantity:1,explanation:'Fixture.'};decisions.push(decision);if(decision instanceof Error)throw decision;return {provider:'openai',decision};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.providerStatus.aiConnected=true;const sent=[];automation.notify=(id,message)=>sent.push({id,message});
  return {db,paper,automation,sent};
}
const settle=async a=>{while(a.busy)await new Promise(resolve=>setImmediate(resolve));};

test('guardrail settings default to advisory behavior and reject invalid values',async()=>{
  const {db,paper,automation}=fixture();try{
    assert.equal(automation.config.lossAction,'review');assert.equal(automation.config.maxAutoOrdersPerDay,0);assert.equal(automation.config.digestEnabled,false);
    for(const value of [{lossAction:'sell-all'},{maxAutoOrdersPerDay:-1},{maxAutoOrdersPerDay:1.5},{maxConsecutiveFailures:21},{digestHour:24},{digestEnabled:'yes'}])assert.throws(()=>automation.configure(value),/INVALID_SETTINGS/);
    automation.configure({provider:'openai'});await automation.review();
    assert.equal(paper.getState().proposals.length,1,'review response still proposes a buy under a breached loss limit');assert.equal(automation.getState().guardrails.events.length,0);
  }finally{db.close();}
});

test('block-buys records the decision without a proposal, alerts once per day and still allows sells',async()=>{
  let sell=false;const {db,paper,automation,sent}=fixture({decide:()=>sell?{action:'Sell',symbol:'005930',quantity:1,explanation:'Reduce.'}:{action:'Buy',symbol:'005930',quantity:1,explanation:'Add.'}});try{
    automation.configure({provider:'openai',lossAction:'block-buys'});
    const first=await automation.review();assert.match(first.executionNote,/buys are blocked/);assert.equal(first.proposalId,null);assert.equal(paper.getState().proposals.length,0);
    await automation.review();const state=automation.getState();assert.equal(state.reviews.length,2);assert.equal(state.guardrails.events.filter(e=>e.kind==='buys-blocked').length,1);assert.equal(sent.length,1);assert.match(sent[0].message,/Blocked a 005930 buy/);
    sell=true;const third=await automation.review();assert.ok(third.proposalId,'sells are still proposed');
  }finally{db.close();}
});

test('stop response halts auto trading on a breach and refuses restart that day',async()=>{
  const {db,paper,automation,sent}=fixture();try{
    automation.configure({provider:'openai',lossAction:'stop',enabled:true,autoSubmit:true,intervalMinutes:60});automation.lastRun=Date.now();
    automation.tick();await settle(automation);
    assert.equal(automation.config.enabled,false);assert.equal(automation.config.autoSubmit,false);assert.equal(paper.account().paused,true);
    const state=automation.getState();assert.equal(state.guardrails.trippedToday,true);assert.equal(state.guardrails.events[0].kind,'auto-stopped');assert.match(sent[0].message,/paper portfolio/);
    automation.tick();assert.equal(automation.getState().guardrails.events.length,1,'no repeated stop while already stopped');
    await assert.rejects(autoLaunch.start(automation,autoLaunch.launchState(automation).token),/guardrail keeps auto trading stopped/);
  }finally{db.close();}
});

test('daily automatic order cap leaves later proposals for approval and survives restart',async()=>{
  const {db,paper,automation,sent}=fixture({breached:false});try{
    automation.configure({provider:'openai',autoSubmit:true,maxAutoOrdersPerDay:1});
    const first=await automation.review();assert.ok(first.orderId,'first decision is submitted automatically');
    const second=await automation.review();assert.equal(second.orderId,null);assert.ok(second.proposalId);assert.match(second.executionNote,/limit of 1 automatic orders/);
    assert.equal(paper.getState().orders.length,1);assert.equal(sent.filter(s=>/order limit/.test(s.message)).length,1);
    const restarted=new Automation(db,paper,{},()=>{});assert.equal(restarted.getState().guardrails.autoOrdersToday,1);
  }finally{db.close();}
});

test('consecutive review failures stop auto trading; a success resets the streak',async()=>{
  const outcomes=[new Error('PROVIDER_REQUEST_FAILED'),null,new Error('PROVIDER_REQUEST_FAILED'),new Error('PROVIDER_REQUEST_FAILED')];
  const {db,automation}=fixture({breached:false,decide:i=>outcomes[i]??{action:'Hold',symbol:'',quantity:0,explanation:'Hold.'}});try{
    automation.configure({provider:'openai',enabled:true,maxConsecutiveFailures:2});
    await assert.rejects(automation.review());assert.equal(automation.getState().guardrails.failureStreak,1);
    await automation.review();assert.equal(automation.getState().guardrails.failureStreak,0);
    await assert.rejects(automation.review());assert.equal(automation.config.enabled,true);
    await assert.rejects(automation.review());assert.equal(automation.config.enabled,false);
    const event=automation.getState().guardrails.events[0];assert.equal(event.kind,'auto-stopped');assert.match(event.detail,/2 consecutive failed reviews/);
  }finally{db.close();}
});

test('daily digest is sent once per day at or after the chosen hour and summarizes the day',async()=>{
  const {db,automation,sent}=fixture({breached:false,decide:()=>({action:'Hold',symbol:'',quantity:0,explanation:'Hold.'})});try{
    automation.configure({provider:'openai'});await automation.review();
    const now=Date.now(),hour=seoulHour(now);
    assert.equal(automation.digest.tick(automation,now),null,'disabled by default');
    if(hour<23){automation.configure({digestEnabled:true,digestHour:hour+1});assert.equal(automation.digest.tick(automation,now),null,'waits for the chosen hour');}
    automation.configure({digestEnabled:true,digestHour:hour});
    const digest=automation.digest.tick(automation,now);assert.ok(digest);assert.equal(digest.reviews,1);assert.equal(digest.decisions.Hold,1);assert.match(digest.text,/1 reviews \(0 Buy, 0 Sell, 1 Hold\)/);assert.match(digest.text,/Paper ₩10,000,000/);
    assert.equal(automation.digest.tick(automation,now),null);assert.equal(sent.filter(s=>s.id.startsWith('digest:')).length,1);
    assert.equal(automation.getState().digests[0].day,digest.day);assert.equal(buildDigest(automation,now).reviews,1,'preview does not need a saved digest');
  }finally{db.close();}
});

test('KIS scope blocks AI buys after the broker daily loss limit without any order transport',async()=>{
  const db=new DatabaseSync(':memory:');try{
    const {LiveEngine}=require('../electron/live-engine.cjs');const snapshot={accountKey:'guard-account',environment:'mock',reportedTotal:10000000,cash:10000000,holdings:[]};const calls=[];
    const live=new LiveEngine(db,{request:async operation=>{calls.push(operation);if(operation!=='live-context')throw new Error('Unexpected transport');return {balance:snapshot,quotes:[{symbol:'005930',price:100,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}};}},()=>({status:'connected',snapshot}));
    live.configure({symbols:[],lossLimit:{mode:'amount',value:500000}},'ENABLE MOCK');live.enableAuto('ENABLE AUTO MOCK');snapshot.reportedTotal=9400000;
    const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[]);
    const automation=new Automation(db,paper,{request:async()=>({provider:'openai',decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Buy the dip.'}})},()=>{});automation.live=live;automation.providerStatus.aiConnected=true;
    automation.configure({provider:'openai',scope:'kis',shareKisWithAI:true,autoSubmit:true,lossAction:'block-buys'});
    const review=await automation.review();assert.equal(review.emergency,true);assert.match(review.executionNote,/buys are blocked/);assert.equal(review.orderId,null);
    assert.equal(live.orders().length,0);assert.deepEqual([...new Set(calls)],['live-context']);
  }finally{db.close();}
});
// Starting auto trading resumed nothing: it always ran a review, and after a restart the last review time was lost, so
// a review that had run minutes before ran again. The review clock is kept and Start follows the schedule.
test('Start auto trading resumes the schedule from the last review, also after a restart, instead of reviewing again',async()=>{
  const {db,paper,automation}=fixture({breached:false});try{
    automation.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'keep'});let calls=0;const request=automation.provider.request;automation.provider.request=async(...a)=>{calls++;return request(...a);};
    await automation.review('User request');const reviewedAt=automation.lastRun;assert.equal(calls,1);
    // A restart: a new engine on the same database.
    const b=new Automation(db,paper,automation.provider,()=>{});b.providerStatus.aiConnected=true;b.notify=()=>{};assert.equal(b.lastRun,0);
    const message=await autoLaunch.start(b,autoLaunch.launchState(b).token);
    assert.equal(calls,1,'Start does not run a review');assert.match(message,/Next review at \d\d:\d\d KST, on schedule/);assert.equal(b.lastRun,reviewedAt,'the last review time survives the restart');
    assert.ok(Math.abs(b.nextReviewAt()-(reviewedAt+3600000))<1000,'the next review is an interval after the last one');
    b.tick();await settle(b);assert.equal(calls,1,'nor does the scheduler before the interval');autoLaunch.stop(b);
    // A review already due starts from the scheduler, under the start name.
    db.prepare('UPDATE review_clock SET payload=?').run(JSON.stringify({lastRun:reviewedAt-2*3600000}));
    const c=new Automation(db,paper,automation.provider,()=>{});c.providerStatus.aiConnected=true;c.notify=()=>{};
    assert.match(await autoLaunch.start(c,autoLaunch.launchState(c).token),/review is due and starts shortly/);assert.equal(calls,1);
    c.tick();await settle(c);assert.equal(calls,2);assert.equal(JSON.parse(db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get().payload).trigger,'Auto trading started');
  }finally{db.close();}
});
