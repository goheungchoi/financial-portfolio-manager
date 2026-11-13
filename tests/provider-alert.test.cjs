// OpenAI refusal fix, step R3 (artifacts/reviews/2026-11-13-openai-rate-limit: design 6, review Q1, Q3, Q5, Q6 and the
// notes to R2/R3): a console line when a wait starts or grows, one alert per outage or stall while a market is open,
// one recovery notice, and the wait on Home and in the notice list. No network: the provider is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const MIN=60000,T0=Date.parse('2026-11-13T01:05:00Z');
function world({open=true}={}){const db=new DatabaseSync(':memory:');const logs=[],sent=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>logs.push({title,body}));
  a.random=()=>0;a.configure({scope:'kis'});a.sessionOpen=()=>a.isOpen;a.isOpen=open;a.notify=(id,message)=>sent.push({id,message});return {a,db,logs,sent};}
const fail=(code,p=null)=>Object.assign(new Error(code),p?{providerError:p}:{});
const RATE=fail('AI_RATE_LIMITED',{status:429,errorCode:'rate_limit_exceeded',requestId:'req_r',message:'Rate limit reached for gpt-6-sol on tokens per day (TPD): Limit 100000, Used 100000.'});
const QUOTA=fail('AI_QUOTA_EXHAUSTED',{status:429,errorCode:'credit_balance_exhausted',requestId:'req_q'});

test('one console line when a wait starts and when it grows; none for a retry inside the same call',()=>{
  const {a,logs}=world();a.noteProviderOutcome('openai',RATE,T0);a.noteProviderOutcome('openai',RATE,T0+3000);a.noteProviderOutcome('openai',RATE,T0+3*MIN);
  const lines=logs.filter(l=>/^AI provider wait/.test(l.title));assert.deepEqual(lines.map(l=>l.title),['AI provider wait','AI provider wait longer']);
  assert.match(lines[0].body,/^OpenAI is limiting requests \(rate_limit_exceeded\)\. Automatic AI calls to OpenAI wait until 10:07 KST \(failure 1 in a row\)\. Your own requests still run; stops and loss limits continue\.$/);
});
test('a rate limit alerts once at the third failure while a market is open, with the kept message in the console; never again for the same outage',()=>{
  const {a,sent,logs}=world();let t=T0;
  for(let i=0;i<2;i++){a.noteProviderOutcome('openai',RATE,t);a.checkAiAlerts(t);t=a.providerBackoff('openai').until;}assert.equal(sent.length,0,'not at one or two');
  a.noteProviderOutcome('openai',RATE,t);for(let i=0;i<179;i++)a.checkAiAlerts(t+i*90000);
  assert.equal(sent.length,1);assert.equal(sent[0].id,`ai-outage:openai:${T0}`);
  assert.match(sent[0].message,/^AI reviews are failing: OpenAI is limiting requests \(rate_limit_exceeded\) since 10:05 KST; last completed review none today\. Next try \d\d:\d\d KST\. Stops and loss limits still run\.$/);
  assert.match(logs.find(l=>l.title==='AI provider alert').body,/Message: Rate limit reached for gpt-6-sol on tokens per day \(TPD\)/,'a daily limit shows its message line');
});
test('used-up credit (Q1) and an unfamiliar 429 code (Q6) alert at the first failure, naming the code',()=>{
  const {a,sent}=world();a.noteProviderOutcome('openai',QUOTA,T0);a.checkAiAlerts(T0);
  assert.equal(sent.length,1);assert.match(sent[0].message,/OpenAI refuses requests: the account credit or spend limit is used up \(credit_balance_exhausted\).*Add credit or raise the limit on the provider account\./);
  const {a:b,sent:s2}=world();b.noteProviderOutcome('openai',fail('AI_RATE_LIMITED',{status:429,errorCode:'some_new_billing_code'}),T0);b.checkAiAlerts(T0);
  assert.equal(s2.length,1);assert.match(s2[0].message,/OpenAI refused requests with an unfamiliar code \(some_new_billing_code\)/);
});
test('no alert while every market of the scope is closed; it comes at the open',()=>{
  const {a,sent}=world({open:false});a.noteProviderOutcome('openai',QUOTA,T0);a.checkAiAlerts(T0);assert.equal(sent.length,0);
  a.isOpen=true;a.checkAiAlerts(T0+MIN);assert.equal(sent.length,1);
});
test('a connection failure without a provider record names its code and does not say the provider is down',()=>{
  const {a,sent}=world();let t=T0;for(let i=0;i<3;i++){a.noteProviderOutcome('openai',fail('AI_REQUEST_FAILED'),t);t=a.providerBackoff('openai').until;}a.checkAiAlerts(t);
  assert.match(sent[0].message,/AI reviews are failing: AI requests are failing \(AI_REQUEST_FAILED\)/);assert.ok(!/unavailable|limiting/.test(sent[0].message));
  const {a:b}=world();b.noteProviderOutcome('openai',fail('AI_SERVER_ERROR',{status:503,errorCode:'server_is_overloaded'}),T0);assert.equal(b.providerReason('openai').text,'OpenAI is unavailable');
});
test('one recovery notice after an alerted outage; none when no alert was sent',async()=>{
  const {a,sent,logs}=world();a.noteProviderOutcome('openai',QUOTA,T0);a.checkAiAlerts(T0);a.noteProviderOutcome('openai',null,T0+65*MIN);a.noteProviderOutcome('openai',null,T0+70*MIN);
  assert.deepEqual(sent.map(s=>s.id),[`ai-outage:openai:${T0}`,`ai-recovered:openai:${T0}`]);assert.equal(sent[1].message,'AI reviews are running again: OpenAI failed from 10:05 to 10:05 KST (1 attempt).');
  assert.ok(logs.some(l=>l.title==='AI provider recovered'));
  const {a:b,sent:s2}=world();b.noteProviderOutcome('openai',RATE,T0);b.noteProviderOutcome('openai',null,T0+5*MIN);assert.equal(s2.length,0,'one failure, no alert, no recovery notice');
});
test('Q3: one alert when no review has completed for 30 minutes of an open session after a failed attempt, unless an outage alert covers it',()=>{
  const {a,sent}=world();a.lastSuccess=0;a.lastErrorAt=T0;a.lastError='STALE_DECISION';
  a.checkAiAlerts(T0+10*MIN);assert.equal(sent.length,0);a.lastErrorAt=T0+20*MIN;a.checkAiAlerts(T0+31*MIN);a.checkAiAlerts(T0+40*MIN);
  assert.equal(sent.length,1);assert.equal(sent[0].id,`ai-stalled:${T0}`);assert.match(sent[0].message,/^No AI review has completed for 30 minutes while the Korean market is open \(last completed review none today; last error STALE_DECISION\)\./);
  a.lastSuccess=T0+45*MIN;a.checkAiAlerts(T0+46*MIN);assert.equal(a.stallFrom,null,'a completed review ends the stall');
  const {a:b,sent:s2}=world();b.noteProviderOutcome('openai',QUOTA,T0);b.lastErrorAt=T0;b.checkAiAlerts(T0);b.checkAiAlerts(T0+40*MIN);assert.deepEqual(s2.map(s=>s.id),[`ai-outage:openai:${T0}`],'covered by the outage alert');
});
test('Q5: the wait is in the state Home reads, with the next try and the details behind More',()=>{
  const {a}=world();a.noteProviderOutcome('openai',RATE,Date.now());const [w]=a.getState().providerWait;
  assert.equal(w.name,'OpenAI');assert.equal(w.kind,'rate');assert.equal(w.code,'rate_limit_exceeded');assert.equal(w.requestId,'req_r');assert.match(w.message,/tokens per day/);assert.match(w.summary,/^OpenAI is limiting requests\. Next try \d\d:\d\d\.$/);
  const {a:q}=world();q.noteProviderOutcome('openai',QUOTA,Date.now());assert.match(q.getState().providerWait[0].summary,/^OpenAI refuses requests: the account credit or spend limit is used up\. Add credit or raise the limit; next check \d\d:\d\d\.$/);
  const {a:none}=world();assert.deepEqual(none.getState().providerWait,[]);
  // Home and the notice list read it (source checks; the screenshot is in the R3 evidence).
  const fs=require('node:fs'),path=require('node:path');const home=fs.readFileSync(path.join(__dirname,'../src/Dashboard.tsx'),'utf8'),main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.ok(home.includes('const blocks=[...waits.map(w=>w.summary)'));assert.ok(main.includes("id:'provider-wait-'+w.vendor"));
});
