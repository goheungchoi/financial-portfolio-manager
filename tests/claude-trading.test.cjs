'use strict';
// Trading on Claude Opus 5.5, step D-1 (artifacts/reviews/2026-11-15-claude-trading: d0/note.md sections 0 to 4, review.md):
// the dry-run record's version fields, the save conditions, the check at review time, and the Claude 429 reads. The gate
// constant stays false; these tests open it with the test-only override. No network: every provider is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const M=require('../electron/ai-models.cjs');const RI=require('../electron/review-instructions.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};const SINCE=Date.parse('2026-11-15T11:36:26Z');

function harness(){const db=new DatabaseSync(':memory:');const events=[],sent=[],alerts=[];
  const provider={request:async(op,payload)=>{sent.push(op);return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,(id,kind,title,body)=>events.push({id,kind,title,body}));
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium'});
  a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};a.notify=(key,text)=>alerts.push([key,text]);
  return {a,db,events,sent,alerts};}
const dry=(extra={})=>({id:'D1',timestamp:SINCE+3600000,model:'claude-opus-5-5',calls:3,costUSD:0.42,account:'KIS live',appVersion:null,instructions:null,answerForm:'enforced',...extra});

test('D-1: the dry run that allows trading: the fingerprint where recorded, else the app version, else made after 1.5.60 with its answer form',()=>{
  const {a}=harness();const use=r=>{a.completedClaudeDryRun=()=>r;return a.claudeTradingDryRun();};
  assert.equal(use(null),null,'none');
  assert.ok(use(dry({appVersion:'1.5.61',instructions:{version:RI.INSTRUCTIONS_VERSION,fingerprint:RI.fingerprint()}})),'the current fingerprint');
  assert.equal(use(dry({appVersion:'1.5.61',instructions:{version:'review 2026-11-13',fingerprint:'d50342a570a47586'}})),null,'another fingerprint: a new dry run is needed');
  assert.ok(use(dry({appVersion:'1.5.60'})));assert.ok(use(dry({appVersion:'1.6.0'})));assert.equal(use(dry({appVersion:'1.5.59'})),null);
  assert.ok(use(dry()),'the user\'s 21:38 KST record: after the publish time, with its answer form');
  assert.equal(use(dry({timestamp:SINCE-1})),null,'before 1.5.60 was published');assert.equal(use(dry({answerForm:null})),null,'no answer form recorded');
});

test('D-1: completedClaudeDryRun carries the version fields, and an older record\'s answer form from its final request',()=>{
  const {a,db}=harness();a.accountTag=()=>({key:'acct',label:'KIS live'});
  const put=(id,review,ts)=>{db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run(id,ts,JSON.stringify({id,timestamp:ts,mode:'review',summary:{account:{key:'acct'}},review}));
    db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id+'-c',`2026-11-15`,JSON.stringify({reviewId:id,model:'claude-opus-5-5',status:'completed',usage:{inputTokens:1},accountedMicro:1}));};
  const base={model:'claude-opus-5-5',decision:{action:'Hold'},calls:3,costUSD:0.42,measurement:{requests:[{answerForm:null},{answerForm:'enforced'}],totals:{costUSD:0.42}}};
  put('old',base,SINCE+1000);let r=a.completedClaudeDryRun();assert.equal(r.answerForm,'enforced');assert.equal(r.appVersion,null);assert.equal(r.instructions,null);
  put('new',{...base,appVersion:'1.5.61',instructions:{version:'v',fingerprint:'f'},answerForm:'text'},SINCE+2000);r=a.completedClaudeDryRun();assert.deepEqual([r.id,r.appVersion,r.instructions.fingerprint,r.answerForm],['new','1.5.61','f','text']);
});

test('D-1: a dry run records the app version, the instructions of its context and the form of its final answer',async()=>{
  const {a,db}=harness();a.live={identity:()=>'acct',context:async()=>({}),getState:()=>({})};a.accountTag=()=>({key:'acct',label:'KIS live'});
  a.assembleReviewContext=async()=>({context:{environment:'kis',universe:[{symbol:'005930'}],positions:{},quotes:[{symbol:'005930',price:100}]}});
  await a.dryRun('review');const row=JSON.parse(db.prepare('SELECT payload FROM dry_runs ORDER BY timestamp DESC LIMIT 1').get().payload);
  assert.equal(row.review.appVersion,require('../package.json').version);assert.equal(row.review.instructions.version,RI.INSTRUCTIONS_VERSION);assert.equal(row.review.instructions.fingerprint,RI.fingerprint());
  assert.ok('answerForm' in row.review,'recorded, null for a request without a form');
});

test('D-1: the save conditions, each with its code, before anything is saved; switching back is always allowed',()=>{
  M.setClaudeTradingForTests(true);try{
    const {a}=harness();const save=(extra={})=>()=>a.configure({...CLAUDE,...extra});const ok=dry({appVersion:'1.5.60'});
    a.completedClaudeDryRun=()=>null;assert.throws(save({claudeTradingConfirmed:true}),/^Error: CLAUDE_TRADING_DRY_RUN$/);assert.equal(a.config.openaiModel,'gpt-6-sol','nothing saved');
    a.completedClaudeDryRun=()=>ok;a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:false};assert.throws(save({claudeTradingConfirmed:true}),/CLAUDE_TRADING_KEY/);
    a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};assert.throws(save({claudeTradingConfirmed:true,shareKisWithAnthropic:false}),/CLAUDE_TRADING_CONSENT/);
    a.configure({anthropicUnlimitedCalls:false,anthropicUnlimitedBudget:false,anthropicCallsPerDay:10,anthropicUSDPerDay:1});assert.throws(save({claudeTradingConfirmed:true}),/CLAUDE_TRADING_LIMITS/,'$1 does not cover one review');
    const r=a.claudeReservation('claude-opus-5-5',{});assert.equal(r.requestsUpTo,4);assert.ok(r.upToUSD>1);
    assert.throws(save({claudeTradingConfirmed:true,anthropicUSDPerDay:Math.ceil(r.upToUSD),anthropicCallsPerDay:3}),/CLAUDE_TRADING_LIMITS/,'3 requests do not cover one review');
    assert.throws(save({anthropicUSDPerDay:Math.ceil(r.upToUSD)}),/CLAUDE_TRADING_CONFIRM/,'switching needs the confirmation');
    a.configure({...CLAUDE,anthropicUSDPerDay:Math.ceil(r.upToUSD),claudeTradingConfirmed:true});assert.equal(a.config.openaiModel,'claude-opus-5-5');assert.equal('claudeTradingConfirmed' in a.config,false,'never stored');
    a.configure({intervalMinutes:20});assert.equal(a.config.openaiModel,'claude-opus-5-5','a later save on Claude needs no new confirmation');
    a.configure({anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true,anthropicCallsPerDay:1,anthropicUSDPerDay:0.01});assert.equal(a.config.anthropicUSDPerDay,0.01,'unlimited covers a review');
    a.completedClaudeDryRun=()=>null;a.configure({openaiModel:'gpt-6-sol',reasoningEffort:'medium'});assert.equal(a.config.openaiModel,'gpt-6-sol','switching back needs nothing');
  }finally{M.setClaudeTradingForTests(null);}
  const {a}=harness();a.completedClaudeDryRun=()=>dry({appVersion:'1.5.60'});assert.throws(()=>a.configure({...CLAUDE,claudeTradingConfirmed:true}),/CLAUDE_NOT_ENABLED_FOR_TRADING/,'the gate is still closed');
  const ui=require('fs').readFileSync(require('path').join(__dirname,'../src/RuntimeSettings.tsx'),'utf8');for(const c of ['DRY_RUN','KEY','CONSENT','LIMITS','CONFIRM'])assert.match(ui,new RegExp(`CLAUDE_TRADING_${c}:'`),c+' has words in the settings window');
});

test('D-1: at review time a Claude trading model needs the gate, the key and the consent; nothing is sent otherwise, said once per cause',async()=>{
  const {a,events,sent,alerts}=harness();a.config.openaiModel='claude-opus-5-5';a.config.reasoningEffort='medium';a.completedClaudeDryRun=()=>dry({appVersion:'1.5.60'});
  const lines=()=>events.filter(e=>e.title==='Claude review not started').map(e=>e.body);
  // The gate closed (the constant false): a Claude model in the saved settings is refused at review time (review F1).
  await assert.rejects(a.review('Scheduled review'),/CLAUDE_TRADING_BLOCKED/);await assert.rejects(a.review('User request'),/CLAUDE_TRADING_BLOCKED/,'your own review too: nothing to send it to');
  assert.deepEqual(sent,[],'no provider call, no fallback');assert.deepEqual(lines(),['Claude models run dry-run reviews only for now; trading on Claude is not enabled yet.'],'once per cause');assert.equal(alerts.length,1);
  M.setClaudeTradingForTests(true);try{
    a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:false};await assert.rejects(a.review('Scheduled review'),/CLAUDE_TRADING_BLOCKED/);
    assert.equal(lines().at(-1),'Load your Anthropic key in Connections first.','a new cause, a new line');
    a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};a.config.shareKisWithAnthropic=false;await assert.rejects(a.review('Scheduled review'),/CLAUDE_TRADING_BLOCKED/);assert.equal(lines().at(-1),'Allow sharing KIS data with Anthropic in Connections first.');
    a.config.shareKisWithAnthropic=true;a.config.anthropicUnlimitedBudget=false;a.config.anthropicUSDPerDay=0.01;assert.equal(a.claudeTradingRefusal(a.config),null,'limits are not a review-time condition: each request is reserved against them');
    a.completedClaudeDryRun=()=>null;assert.equal(a.claudeTradingRefusal(a.config),null,'nor is the dry run (review F1): it is a condition of the switch only');
  }finally{M.setClaudeTradingForTests(null);}
  const b=harness();await b.a.review('User request').catch(()=>{});assert.ok(!b.events.some(e=>e.title==='Claude review not started'),'an OpenAI trading model is not checked');
});

test('D-1 F1: after an update that changes the instructions, Claude reviews go on, with one line and one alert advising a dry run',async()=>{
  M.setClaudeTradingForTests(true);try{
    const {a,events,alerts}=harness();a.config.openaiModel='claude-opus-5-5';a.config.reasoningEffort='medium';
    a.completedClaudeDryRun=()=>dry({appVersion:'1.5.61',instructions:{version:'review 2026-11-13',fingerprint:'d50342a570a47586'}});
    const advised=()=>events.filter(e=>e.title==='Claude dry run advised').map(e=>e.body);
    for(let i=0;i<3;i++){const r=await a.review('Scheduled review').then(()=>null,e=>e.message);assert.notEqual(r,'CLAUDE_TRADING_BLOCKED','the review is not stopped');}
    assert.deepEqual(advised(),['The review instructions changed in this version; a Claude dry run on it is advised (Dashboard → Dry run).'],'once');assert.equal(alerts.filter(([k])=>k==='claude-dry-run-advised').length,1);
    assert.ok(!events.some(e=>e.title==='Claude review not started'));
    const c=harness();c.a.config.openaiModel='claude-opus-5-5';c.a.config.reasoningEffort='medium';c.a.completedClaudeDryRun=()=>dry({appVersion:'1.5.61',instructions:{version:RI.INSTRUCTIONS_VERSION,fingerprint:RI.fingerprint()}});
    await c.a.review('Scheduled review').catch(()=>{});assert.ok(!c.events.some(e=>e.title==='Claude dry run advised'),'a dry run on the current instructions: no advice');
  }finally{M.setClaudeTradingForTests(null);}
});

test('D-1: an Anthropic 429 keeps its retry-after, and one that is not rate_limit_error is unfamiliar',()=>{
  const A=require('../electron/anthropic-client.cjs');const S=require('@anthropic-ai/sdk');const E=(S.default??S.Anthropic??S).APIError;
  const rec=A.refusalRecord(new E(429,{type:'error',error:{type:'rate_limit_error',message:'slow'}},'m',new Headers({'retry-after':'42'})),{errorBody:'{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}'});
  assert.equal(rec.retryAfterSec,42);assert.equal(A.refusalRecord(new E(429,{},'m',new Headers({'retry-after':'soon'})),{}).retryAfterSec,undefined,'only whole seconds');
  const {a}=harness();const why=lastRefusal=>a.providerReason('anthropic',{kind:'rate',count:1,lastRefusal});
  assert.equal(why({status:429,errorType:'rate_limit_error'}).unknown,false);assert.equal(why({status:429,errorType:'billing_threshold_error'}).unknown,true);assert.match(why({status:429,errorType:'billing_threshold_error'}).text,/unfamiliar code/);
  assert.equal(a.providerReason('openai',{kind:'rate',count:1,lastRefusal:{status:429,errorType:'tokens'}}).unknown,false,'OpenAI is judged by its codes, as before');
});

test('D-2: compacting makes no call while its vendor has a provider wait; the review carries results by reference',async()=>{
  const {a,db,sent}=harness();const calls=()=>db.prepare("SELECT COUNT(*) n FROM ai_calls").get().n;const before=calls();
  a.providerWaitFor=m=>m==='gpt-6-luna'?Date.now()+3600000:0;await assert.rejects(a.compactResearch('R1',{items:[]}),/PROVIDER_WAIT/);
  assert.equal(calls(),before,'nothing reserved');assert.deepEqual(sent,[],'nothing sent');
  a.providerWaitFor=()=>0;await a.compactResearch('R1',{items:[]});assert.deepEqual(sent,['compact'],'without a wait it runs as before');
});

test('D-2: the cost estimate for Claude counts its dry runs until a live Claude review exists',()=>{
  const {a,db}=harness();const put=(id,kind,micro,review)=>db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'2026-11-15',JSON.stringify({reviewId:review,model:'claude-opus-5-5',status:'completed',accountedMicro:micro,...(kind?{kind}:{})}));
  let e=a.dryRunEstimate({model:'claude-opus-5-5'});assert.equal(e.estimateUSD,null);assert.equal(e.ran,false);
  put('d1','dry-run',214102,'D');put('d2','dry-run',159626,'D');put('d3','dry-run',43109,'D');
  e=a.dryRunEstimate({model:'claude-opus-5-5'});assert.equal(e.estimateUSD,0.416837,'the 21:38 dry run');assert.equal(e.basis,'1 recent claude-opus-5-5 dry run');assert.deepEqual(e.requests,{min:3,max:3});
  put('l1',null,500000,'L');e=a.dryRunEstimate({model:'claude-opus-5-5'});assert.equal(e.estimateUSD,0.5,'a live review replaces the dry runs');assert.equal(e.basis,'1 recent claude-opus-5-5 review');
  assert.equal(a.dryRunEstimate().basis.endsWith('reviews'),true,'OpenAI: live reviews only, as before');
});

test('D-2: scout, narrative and reflection follow a Claude trading model ("same"); compacting stays on the routine model',()=>{
  const {a}=harness();a.config.openaiModel='claude-opus-5-5';a.config.reasoningEffort='medium';
  for(const agent of ['scout','narrative','reflection'])assert.equal(a.agentModel(agent).openaiModel,'claude-opus-5-5',agent);
  assert.equal(a.agentModel('compacting').openaiModel,'gpt-6-luna');a.completedClaudeDryRun=()=>null;assert.equal(a.claudeGateClosed('scout'),true,'each helper keeps its call-time gate');
});
