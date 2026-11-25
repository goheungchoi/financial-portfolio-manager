// Hourly-cache stage A (handoff 2026-11-25): the scheduled interval counts from the start of the last review that ran
// or was skipped, not from its end (the user: "measured from the start of the review not after the review finished");
// the agent's own interval is compared the same way; a failed review counts from its failure; the 60-second rest and the
// order waits stay counted from the end; Home's next review is the moment the tick uses; the start survives a restart.
// Paper account, fake provider, a moved Date.now. No AI call, no broker.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const MIN=60000;const realNow=Date.now;let now=realNow();
test.beforeEach(()=>{now=realNow();Date.now=()=>now;});test.afterEach(()=>{Date.now=realNow;});
const settle=async a=>{await new Promise(r=>setTimeout(r,20));while(a.busy)await new Promise(r=>setImmediate(r));};
const openNow=()=>({open:true,markets:[],preOpen:null,next:null});
// took: minutes the provider takes (the fake clock moves by it); fail: the provider throws.
function fixture({db=new DatabaseSync(':memory:'),took=1,fail=false}={}){
  const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:50000}],()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}]);
  paper.saveAccount({...paper.account(),paused:false});const calls=[];
  const provider={request:async op=>{if(op!=='decision')return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'x'}};calls.push(now);now+=took*MIN;
    if(fail)throw new Error('AI_REQUEST_FAILED');return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'x'}};}};
  const a=new Automation(db,paper,provider,()=>{});a.providerStatus.aiConnected=true;a.notify=()=>{};
  a.configure({provider:'openai',intervalMinutes:60,closedMarketReviews:'keep'});a.marketHours=openNow;a.config.enabled=true;a.sessionArmed=true;return {db,a,calls};
}
const at=async(a,t)=>{now=t;a.tick();await settle(a);};

for(const took of [1,4])test(`a review that took ${took} minute(s): the next scheduled review starts one interval after its start`,async()=>{
  const {db,a,calls}=fixture({took});try{const t0=now;await a.review('Scheduled review').catch(()=>{});
    assert.equal(a.lastStart,t0);assert.equal(a.lastRun,t0+took*MIN);assert.equal(a.nextReviewAt(),t0+60*MIN,'Home shows the moment the tick uses');
    await at(a,t0+60*MIN-1000);assert.equal(a.lastStart,t0,'not before');await at(a,t0+60*MIN);assert.equal(a.lastStart,t0+60*MIN,'at start + interval (run or skipped by the gate)');}finally{db.close();}});

test('a review longer than its interval: the next one after the 60-second rest, never at once',async()=>{
  const {db,a,calls}=fixture({took:12});try{a.configure({intervalMinutes:10});const t0=now;await a.review('Scheduled review').catch(()=>{});
    const end=t0+12*MIN;assert.equal(a.nextReviewAt(),end+MIN);await at(a,end+30000);assert.equal(a.lastStart,t0,'the rest');await at(a,end+MIN);assert.equal(a.lastStart,end+MIN);}finally{db.close();}});

test("the agent's shorter interval is counted from the start too",async()=>{
  const {db,a,calls}=fixture({took:2});try{a.reviewInterval.get=()=>({minutes:15});const t0=now;await a.review('Scheduled review').catch(()=>{});
    assert.equal(a.nextReviewAt(),t0+15*MIN);await at(a,t0+15*MIN-1000);assert.equal(a.lastStart,t0);await at(a,t0+15*MIN);assert.equal(a.lastStart,t0+15*MIN);}finally{db.close();}});

test('a trigger-started review resets the schedule at its start; a failed review counts from its failure',async()=>{
  {const {db,a}=fixture({took:3});try{const t0=now;await a.review('Price movement trigger').catch(()=>{});assert.equal(a.lastStart,t0);assert.equal(a.nextReviewAt(),t0+60*MIN);}finally{db.close();}}
  {const {db,a}=fixture({took:3,fail:true});try{const t0=now;await a.review('Scheduled review').catch(()=>{});
    assert.ok(a.lastRun>=t0+3*MIN);assert.equal(a.lastStart,a.lastRun,'from the failure');assert.equal(a.nextReviewAt(),a.lastRun+60*MIN);}finally{db.close();}}
});

test('the start survives a restart; an old saved clock without it counts from its end',async()=>{
  const db=new DatabaseSync(':memory:');try{const {a}=fixture({db,took:4});const t0=now;await a.review('Scheduled review').catch(()=>{});
    const saved=JSON.parse(db.prepare('SELECT payload FROM review_clock WHERE scope=?').get('paper').payload);assert.deepEqual([saved.lastStart,saved.lastRun],[t0,t0+4*MIN]);
    now=t0+20*MIN;const b=fixture({db}).a;b.restoreClock();assert.deepEqual([b.lastStart,b.lastRun],[t0,t0+4*MIN]);assert.equal(b.nextReviewAt(),t0+60*MIN,'mid-interval restart');
    db.prepare('UPDATE review_clock SET payload=? WHERE scope=?').run(JSON.stringify({lastRun:t0+4*MIN,preOpenKey:null}),'paper');
    const c=fixture({db}).a;c.restoreClock();assert.equal(c.lastStart,t0+4*MIN);assert.equal(c.nextReviewAt(),t0+64*MIN,'old row: as before');
  }finally{db.close();}});
