const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const L=require('../electron/auto-launch.cjs');
const {PRE_OPEN_MS}=require('../electron/market-hours.cjs');const {seoulDate}=require('../electron/kis-activity.cjs');
// Review of 1.5.40: the review clock and what Start says, against what the scheduler then does.
const quote=()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}];
const settle=async a=>{await new Promise(r=>setTimeout(r,20));while(a.busy)await new Promise(r=>setImmediate(r));};
// gate: when given, the provider waits for it, so a review stays in progress until the test releases it.
function fixture({db=new DatabaseSync(':memory:'),gate=null}={}){
  const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:50000}],quote);paper.saveAccount({...paper.account(),paused:false});const calls=[];
  const provider={request:async()=>{calls.push(1);if(gate)await gate;return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'x'}};}};
  const a=new Automation(db,paper,provider,()=>{});a.providerStatus.aiConnected=true;a.notify=()=>{};return {db,a,calls,paper};
}
const clock=(db,scope)=>{const row=db.prepare('SELECT payload FROM review_clock WHERE scope=?').get(scope);return row?JSON.parse(row.payload):null;};
const openNow=()=>({open:true,markets:[],preOpen:null,next:null});
const lastTrigger=db=>JSON.parse(db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get()?.payload??'null')?.trigger;

test('a review in progress when the account changes is saved under the account it reviewed; the new account keeps its own clock',async()=>{
  let release;const gate=new Promise(r=>{release=r;});const {db,a}=fixture({gate});try{
    a.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'keep'});const threeHoursAgo=Date.now()-3*3600000;
    db.prepare('INSERT INTO review_clock VALUES(?,?)').run('kr:B',JSON.stringify({lastRun:threeHoursAgo,preOpenKey:null}));
    let scope='kr:A';a.watchScope=()=>scope;const task=a.review('Scheduled review').catch(e=>e.message);await new Promise(r=>setTimeout(r,30));
    scope='kr:B';a.tick();assert.equal(a.clockScope,'kr:A','nothing changes while the review runs');
    release();await task;assert.ok(Date.now()-clock(db,'kr:A').lastRun<5000,'A gets its review time');assert.equal(clock(db,'kr:B').lastRun,threeHoursAgo,'B keeps its own');
    a.tick();a.sessionArmed=true;a.config.enabled=true;assert.equal(a.clockScope,'kr:B');assert.ok(a.nextReviewAt()<=Date.now()+1000,'B\'s overdue review is not delayed');
  }finally{release?.();db.close();}
});

test('Start near the daily budget states the slowed schedule and names no review',async()=>{
  const {db,a,calls}=fixture();try{
    a.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'keep',maxCallsPerDay:10});a.marketHours=openNow;
    db.prepare('INSERT INTO review_clock VALUES(?,?)').run('paper',JSON.stringify({lastRun:Date.now()-90*60000,preOpenKey:null}));
    db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run(seoulDate(),8,0);
    const message=await L.start(a,L.launchState(a).token);assert.match(message,/Next review at \d\d:\d\d KST, on schedule/);assert.equal(a.firstAfterStart,false);
    assert.ok(Math.abs(a.nextReviewAt()-(Date.now()+30*60000))<5000,'twice the interval after the last review');
    a.tick();await settle(a);assert.equal(calls.length,0,'and the scheduler indeed waits');
  }finally{db.close();}
});

test('Start with markets closed: the message matches the setting and whether the pre-open review already ran',async()=>{
  // The pre-open review ran before a restart: no review before the open, and the one after it is a scheduled review.
  {const {db,a,calls}=fixture();try{a.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'pre-open'});
    const openAt=Date.now()+10*60000,key='KR:'+openAt;let open=false;
    a.marketHours=()=>open?openNow():{open:false,markets:[],next:{market:'KR',at:openAt},preOpen:{market:'KR',at:openAt-PRE_OPEN_MS,key}};
    db.prepare('INSERT INTO review_clock VALUES(?,?)').run('paper',JSON.stringify({lastRun:Date.now()-2*3600000,preOpenKey:key}));
    const message=await L.start(a,L.launchState(a).token);assert.match(message,/pre-open review already ran; next review at \d\d:\d\d KST/);assert.equal(a.firstAfterStart,false);
    a.tick();await settle(a);assert.equal(calls.length,0);open=true;a.tick();await settle(a);assert.equal(calls.length,1);assert.equal(lastTrigger(db),'Scheduled review');
  }finally{db.close();}}
  // Closed-market reviews off: the first review runs at the open, and the message says so.
  {const {db,a}=fixture();try{a.configure({provider:'openai',closedMarketReviews:'off'});const openAt=Date.now()+3600000;
    a.marketHours=()=>({open:false,markets:[],next:{market:'KR',at:openAt},preOpen:null});
    assert.match(await L.start(a,L.launchState(a).token),/first review runs at the open \(\d\d:\d\d KST\)/);assert.equal(a.nextReviewAt(),openAt);
  }finally{db.close();}}
});

test('a saved review time in the future counts as now, so Start does not review again at once',async()=>{
  const {db,a,calls}=fixture();try{a.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'keep'});a.marketHours=openNow;
    db.prepare('INSERT INTO review_clock VALUES(?,?)').run('paper',JSON.stringify({lastRun:Date.now()+2*60000,preOpenKey:null}));
    assert.match(await L.start(a,L.launchState(a).token),/on schedule/);a.tick();await settle(a);assert.equal(calls.length,0);assert.ok(a.lastRun<=Date.now());
  }finally{db.close();}
});

test('a new account\'s pre-open record is saved when the pre-open review starts, so a restart does not repeat it',async()=>{
  const db=new DatabaseSync(':memory:');const first=fixture({db,gate:new Promise(()=>{})});try{const a=first.a;a.configure({provider:'openai',closedMarketReviews:'pre-open'});
    const openAt=Date.now()+10*60000,key='KR:'+openAt;const hours=()=>({open:false,markets:[],next:{market:'KR',at:openAt},preOpen:{market:'KR',at:openAt-PRE_OPEN_MS,key}});a.marketHours=hours;
    await L.start(a,L.launchState(a).token);a.tick();await new Promise(r=>setTimeout(r,30));assert.equal(a.busy,true,'the pre-open review is running');assert.equal(clock(db,'paper')?.preOpenKey,key,'its record is already saved');
    const second=fixture({db});second.a.marketHours=hours;await L.start(second.a,L.launchState(second.a).token);second.a.tick();await settle(second.a);
    assert.equal(first.calls.length+second.calls.length,1,'one pre-open review across the restart');
  }finally{db.close();}
});

test('a clock started while no account was connected is not inherited by the first account',async()=>{
  const {db,a}=fixture();try{a.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'keep'});a.marketHours=openNow;
    const threeHoursAgo=Date.now()-3*3600000;db.prepare('INSERT INTO review_clock VALUES(?,?)').run('paper',JSON.stringify({lastRun:threeHoursAgo,preOpenKey:null}));
    let scope='kis:disconnected';a.watchScope=()=>scope;await a.review('User request').catch(()=>{});assert.ok(a.lastRun>0);assert.equal(a.clockScope,'kis:disconnected');
    scope='paper';a.restoreClock();assert.equal(a.lastRun,threeHoursAgo);a.sessionArmed=true;a.config.enabled=true;assert.ok(a.nextReviewAt()<=Date.now()+1000);
    assert.equal(clock(db,'kis:disconnected'),null,'nothing saved for no account');
  }finally{db.close();}
});
