// OpenAI refusal fix, step R2 (artifacts/reviews/2026-11-13-openai-rate-limit: design 5, review Q2 and Q7, the user's
// emergency decision): one wait per AI provider, shared by every automatic path; kept triggers held until it ends; a
// retried order update says so. No network: the provider is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const MIN=60000,T0=Date.parse('2026-11-13T01:05:00Z');
function world(request=async()=>({})){const db=new DatabaseSync(':memory:');const logs=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request},(id,kind,title,body)=>logs.push({title,body}));a.random=()=>0;return {a,db,logs};}
const fail=(code,p=null)=>Object.assign(new Error(code),p?{providerError:p}:{});
const RATE=fail('AI_RATE_LIMITED',{status:429,errorCode:'rate_limit_exceeded',requestId:'req_1'}),QUOTA=fail('AI_QUOTA_EXHAUSTED',{status:429,errorCode:'credit_balance_exhausted'});

test('a rate wait grows 2, 4, 8, 16, 30, 30 minutes; failures within a minute count once; Retry-After is a minimum',()=>{
  const {a}=world();let t=T0;const waits=[];
  for(let i=0;i<6;i++){a.noteProviderOutcome('openai',RATE,t);const b=a.providerBackoff('openai');waits.push((b.until-t)/MIN);t=b.until;}
  assert.deepEqual(waits,[2,4,8,16,30,30]);
  const {a:b}=world();b.noteProviderOutcome('openai',RATE,T0);b.noteProviderOutcome('openai',fail('AI_SERVER_ERROR'),T0+3000);
  assert.equal(b.providerBackoff('openai').count,1,'a retry inside one call is one failure');assert.equal(b.providerBackoff('openai').failures,2,'both attempts are counted as attempts');
  const {a:c}=world();c.noteProviderOutcome('openai',fail('AI_RATE_LIMITED',{status:429,retryAfterSec:600}),T0);assert.equal(c.providerBackoff('openai').until-T0,600000,'Retry-After 600 s beats 2 min');
  c.random=()=>1;c.noteProviderOutcome('openai',fail('AI_RATE_LIMITED',{status:429,retryAfterSec:600}),T0+5*MIN);assert.equal(c.providerBackoff('openai').until-(T0+5*MIN),720000,'with up to 20 % jitter');
});
test('used-up credit waits a fixed 60 minutes; server errors, timeouts and connection failures wait as a rate limit; other errors do not wait',()=>{
  const {a}=world();a.noteProviderOutcome('openai',QUOTA,T0);assert.equal(a.providerBackoff('openai').kind,'quota');assert.equal(a.providerBackoff('openai').until-T0,60*MIN);
  a.noteProviderOutcome('openai',QUOTA,T0+61*MIN);assert.equal(a.providerBackoff('openai').until-(T0+61*MIN),60*MIN,'no growth');
  for(const code of ['AI_SERVER_ERROR','AI_TIMEOUT','AI_REQUEST_FAILED'])assert.equal(a.providerWaitKind(fail(code)),'rate',code);
  for(const code of ['AI_BAD_REQUEST','INVALID_AI_RESPONSE','AI_AUTH_FAILED','CONTEXT_OVER_BUDGET'])assert.equal(a.providerWaitKind(fail(code)),null,code);
  // A reflection's error keeps only its record: the record decides.
  assert.equal(a.providerWaitKind(fail('PROVIDER_REQUEST_FAILED',{status:429,errorCode:'project_spend_limit_exceeded'})),'quota');assert.equal(a.providerWaitKind(fail('PROVIDER_REQUEST_FAILED',{status:503})),'rate');
});
test('the first completed call ends the wait and keeps the outage for the recovery notice; non-AI operations are not recorded',async()=>{
  let refuse=true;const {a}=world(async op=>{if(op==='decision'&&refuse)throw RATE;return {ok:true};});
  await assert.rejects(a.provider.request('decision',{context:{},options:{openaiModel:'gpt-6-sol'}}));const b=a.providerBackoff('openai');assert.equal(b.count,1);assert.ok(b.until>Date.now());assert.equal(b.lastRefusal.requestId,'req_1');
  refuse=false;await a.provider.request('decision',{context:{},options:{openaiModel:'gpt-6-sol'}});const after=a.providerBackoff('openai');assert.equal(after.count,0);assert.equal(after.until,0);assert.equal(after.lastOutage.failures,1);assert.equal(after.lastOutage.lastCode,'AI_RATE_LIMITED');
  await a.provider.request('push',{message:'x'});assert.equal(a.providerBackoff('openai').count,0);
  // A provider assigned later (as tests and the app do) is wrapped too.
  a.provider={request:async()=>{throw QUOTA;}};await assert.rejects(a.provider.request('scout',{options:{openaiModel:'gpt-6-sol'}}));assert.equal(a.providerBackoff('openai').kind,'quota');
  // Claude has its own wait.
  assert.equal(a.providerBackoff('anthropic').count,0);
});
test('during a wait an automatic review does not start and its kept events are held until the wait ends; your own request is not stopped by it',async()=>{
  const {a}=world();a.configure({provider:'openai'});a.noteProviderOutcome('openai',RATE,Date.now());const until=a.providerBackoff('openai').until;
  a.triggerEvidence={kind:'order',orders:[{id:'O1',symbol:'005930',side:'Buy',quantity:1,filled:1,status:'Filled'}]};a.orderTaken=new Map([['O1',{id:'O1',symbol:'005930',side:'Buy',quantity:1,filled:1,status:'Filled'}]]);
  await assert.rejects(a.review('Order update'),/REVIEW_PROVIDER_WAIT/);
  assert.ok(a.heldEvents(a.watchScope()).size>=1,'the order event is held');assert.ok(a.eventHold.until>=until,'until the wait ends');
  for(const trigger of ['Scheduled review','Price movement trigger','News event trigger','Agent trigger','Pre-open review'])await assert.rejects(a.review(trigger),/REVIEW_PROVIDER_WAIT/,trigger);
  let own=null;try{await a.review('User request');}catch(e){own=e.message;}assert.notEqual(own,'REVIEW_PROVIDER_WAIT','your own request runs');
});
test('an emergency review waits at most max(Retry-After, 2 min) in a rate wait, without growth; under used-up credit it waits like the rest',()=>{
  const {a}=world();let t=T0;for(let i=0;i<5;i++){a.noteProviderOutcome('openai',RATE,t);t+=2*MIN;}const b=a.providerBackoff('openai');
  assert.ok(b.until-b.lastAt>=16*MIN,'others wait 16 min or more');assert.equal(a.providerWaitUntil('openai',{emergency:true},b.lastAt+MIN),b.lastAt+2*MIN);assert.equal(a.providerWaitUntil('openai',{emergency:true},b.lastAt+2*MIN),0,'emergency may try after 2 min');
  a.noteProviderOutcome('openai',fail('AI_RATE_LIMITED',{status:429,retryAfterSec:300}),t+5*MIN);const c=a.providerBackoff('openai');assert.equal(a.providerWaitUntil('openai',{emergency:true},c.lastAt+4*MIN),c.lastAt+5*MIN,'Retry-After is still a minimum');
  const {a:q}=world();q.noteProviderOutcome('openai',QUOTA,T0);assert.equal(q.providerWaitUntil('openai',{emergency:true},T0+5*MIN),T0+60*MIN);
});
test('worst case: a provider refusing everything for a day, tried every minute by reviews, scout, narrative and reflection, gets at most 6 calls in the first hour and 2 in each later hour',()=>{
  for(const kind of ['rate','quota']){const {a}=world();const calls=new Array(24).fill(0);
    for(let m=0;m<24*60;m++){const now=T0+m*MIN;for(const path of ['review','scout','narrative','reflection']){void path;if(a.providerWaitUntil('openai',{},now))continue;calls[Math.floor(m/60)]++;a.noteProviderOutcome('openai',kind==='rate'?fail('AI_RATE_LIMITED',{status:429}):QUOTA,now);}}
    if(kind==='rate'){assert.ok(calls[0]<=6,`hour 1: ${calls[0]}`);for(let h=1;h<24;h++)assert.ok(calls[h]<=2,`hour ${h+1}: ${calls[h]}`);assert.ok(calls.reduce((x,y)=>x+y)<=52);}
    else{for(let h=0;h<24;h++)assert.ok(calls[h]<=1,`quota hour ${h+1}: ${calls[h]}`);}}
});
test('the scout and narrative do not start automatically during a wait; your own runs and the skipped line name the wait',async()=>{
  const {a}=world();a.scoutAvailable=()=>null;a.narrativeAvailable=()=>null;a.noteProviderOutcome('openai',QUOTA,Date.now());
  await assert.rejects(a.scout('Scheduled'),/PROVIDER_WAIT/);await assert.rejects(a.buildNarrative('Scheduled'),/PROVIDER_WAIT/);
  let own=null;try{await a.scout('User request');}catch(e){own=e.message;}assert.notEqual(own,'PROVIDER_WAIT');
  assert.match(a.providerWaitText('gpt-6-sol',a.providerBackoff('openai').until),/^OpenAI is refusing requests: the account credit or spend limit is used up; automatic runs wait until \d\d:\d\d KST\.$/);
});
test('Q7: a retried order update names itself and the time of the original update',()=>{
  const {a}=world();const o={id:'0007641700',status:'Filled',side:'Buy',symbol:'005930',filled:1,quantity:1};
  assert.deepEqual(a.orderUpdateLine([o],Date.parse('2026-11-13T01:04:23Z')),{title:'Order update',body:'Filled: Buy 005930, 1/1 shares. A review starts now.'});
  assert.deepEqual(a.orderUpdateLine([o],Date.parse('2026-11-13T06:15:00Z')),{title:'Order update · retry',body:'Retrying the review for: Filled: Buy 005930, 1/1 shares (update at 10:04 KST). A review starts now.'});
  const n={id:'2',status:'Partially filled',side:'Sell',symbol:'000660',filled:1,quantity:3};
  assert.equal(a.orderUpdateLine([n,o],Date.parse('2026-11-13T06:20:00Z')).body,'Partially filled: Sell 000660, 1/3 shares. Retrying the review for: Filled: Buy 005930, 1/1 shares (update at 10:04 KST). A review starts now.');
});
test('the token-saving average counts completed calls only',()=>{
  const {a,db}=world();db.exec('CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT,payload TEXT)');
  const put=(id,review,status,micro)=>db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'2026-11-13',JSON.stringify({reviewId:review,model:'gpt-6-sol',status,timestamp:T0,reservedMicro:300000,accountedMicro:micro,estimatedMicro:status==='completed'?micro:null}));
  put('c1','r1','completed',30000);put('c2','r2','completed',40000);for(let i=0;i<5;i++)put('f'+i,'f'+i,'failed-or-uncertain',300000);put('z','z','refused',0);
  const s=a.tokenSavingState();assert.equal(s.averageMicro,35000);assert.deepEqual(s.recent.map(r=>r.reviewId).sort(),['r1','r2']);
});
