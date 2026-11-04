// Size-failure records (audit 2026-11-04, Stage 1): the input that was not sent, kept locally with its sizes and
// versions, deduplicated, without credentials, within 30 days, 20 records and a byte limit.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {ContextFailures,LIMITS,redact}=require('../electron/context-failures.cjs');
const failure=(n,extra={})=>({code:'CONTEXT_OVER_BUDGET',stage:'first request',reviewId:'R'+n,appVersion:'1.5.47',schema:'review-context 2026-11-04',report:{wireBytes:70208,limitBytes:70000,largest:['agentDesk:8689']},steps:[{section:'news',kind:'summary',bytesSaved:10}],input:{quotes:[{symbol:'005930',price:n}]},...extra});
test('a failure keeps its code, stage, versions, sizes and input; the same failure again is counted, not duplicated',()=>{
  let now=Date.parse('2026-11-04T04:42:16Z');const store=new ContextFailures(new DatabaseSync(':memory:'),()=>now);
  const first=store.save(failure(1));assert.equal(first.count,1);assert.equal(first.inputKept,true);
  now+=600000;const again=store.save({...failure(1),reviewId:'R1b'});assert.equal(again.id,first.id);assert.equal(again.count,2);
  const [r]=store.list();assert.equal(store.list().length,1);assert.equal(r.count,2);assert.equal(r.firstAt,Date.parse('2026-11-04T04:42:16Z'));assert.equal(r.lastAt,now);
  assert.deepEqual(r.reviewIds,['R1','R1b']);assert.equal(r.code,'CONTEXT_OVER_BUDGET');assert.equal(r.stage,'first request');assert.equal(r.appVersion,'1.5.47');assert.equal(r.schema,'review-context 2026-11-04');
  assert.deepEqual(r.report.largest,['agentDesk:8689']);assert.deepEqual(r.input,{quotes:[{symbol:'005930',price:1}]});assert.ok(r.inputBytes>0);
  store.save(failure(2));assert.equal(store.list().length,2,'a different input is its own record');
  store.save({...failure(1),stage:'research continuation'});assert.equal(store.list().length,3,'and so is a different stage');
});
test('credentials are never stored: secret names and key-like values are replaced',()=>{
  const input={appKey:'PSabc',appsecret:'x',nested:{authorization:'Bearer abcdefghijklmnopqrstuvwxyz',password:'p',ok:'kept'},text:'key sk-abcdefghijklmnop1234 inside',usage:{inputTokens:5,tokens:'t'},list:[{access_token:'a'}]};
  const r=redact(input);assert.equal(r.appKey,'[redacted]');assert.equal(r.appsecret,'[redacted]');assert.equal(r.nested.authorization,'[redacted]');assert.equal(r.nested.password,'[redacted]');assert.equal(r.nested.ok,'kept');
  assert.equal(r.text,'[redacted]');assert.equal(r.usage.inputTokens,5,'token counts are not secrets');assert.equal(r.usage.tokens,'t');assert.equal(r.list[0].access_token,'[redacted]');
  const store=new ContextFailures(new DatabaseSync(':memory:'));store.save(failure(1,{input}));const raw=JSON.stringify(store.list());
  for(const secret of ['PSabc','abcdefghijklmnopqrstuvwxyz','sk-abcdefghijklmnop1234'])assert.ok(!raw.includes(secret),secret);
});
test('retention: at most 20 records, none older than 30 days, and a total byte limit',()=>{
  let now=Date.parse('2026-11-04T00:00:00Z');const db=new DatabaseSync(':memory:');const store=new ContextFailures(db,()=>now);
  for(let i=0;i<25;i++){now+=1000;store.save(failure(i));}assert.equal(store.list().length,LIMITS.records);assert.deepEqual(store.list().map(r=>r.reviewIds[0]).slice(-1),['R5'],'the oldest five went first');
  now+=31*86400000;store.save(failure(100));assert.deepEqual(store.list().map(r=>r.reviewIds[0]),['R100'],'older than 30 days: deleted');
  const big=n=>failure(200+n,{input:{n,text:'가'.repeat(120000)}});for(let i=0;i<12;i++){now+=1000;store.save(big(i));}
  assert.ok(store.totalBytes()<=LIMITS.maxBytes,`${store.totalBytes()} within ${LIMITS.maxBytes}`);assert.ok(store.list().length<12);assert.equal(store.list()[0].reviewIds[0],'R211','the newest is kept');assert.equal(store.list().length,Math.floor(LIMITS.maxBytes/store.list()[0].bytes),'as many of the newest as fit');
  now+=1000;const huge=store.save(failure(300,{input:{text:'x'.repeat(LIMITS.inputBytes+1)}}));assert.equal(huge.inputKept,false);const [r]=store.list();assert.match(r.inputOmitted,/only the sizes are kept/);assert.equal(r.input,undefined);assert.deepEqual(r.report.largest,['agentDesk:8689']);
});
test('a review whose mandatory part is over the limit fails before any model call, saves its input and records no decision',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  let calls=0;const logs=[];
  const provider={request:async()=>{calls++;return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,(id,kind,title,body)=>logs.push({id,title,body}));a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  // 900 quotes: a snapshot that is never shortened and is over the limit on its own.
  const assemble=a.assembleReviewContext.bind(a);a.assembleReviewContext=async(...x)=>{const r=await assemble(...x);r.context.quotes=Array.from({length:900},(_,i)=>({symbol:String(100000+i),price:1000+i,previousClose:999,changePct:0.1,timestamp:1,stale:false}));return r;};
  a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',unlimitedBudget:true,unlimitedCalls:true});
  await assert.rejects(a.review('User request'));assert.equal(calls,0,'no model call');assert.equal(a.lastError,'CONTEXT_MANDATORY_TOO_LARGE');
  assert.equal(db.prepare('SELECT count(*) n FROM reviews').get().n,0,'no Hold or other decision recorded');assert.equal(db.prepare('SELECT count(*) n FROM ai_calls').get().n,0,'no model charge');
  const [r]=a.contextFailures.list();assert.ok(r,'a record was saved');assert.equal(r.code,a.lastError);assert.equal(r.stage,'first request');assert.equal(r.schema,require('../electron/review-context.cjs').SCHEMA);assert.equal(r.appVersion,require('../package.json').version);
  assert.equal(r.input.quotes.length,900,'the assembled input that was not sent');assert.ok(r.report.mandatoryBytes>70000);assert.ok(Array.isArray(r.steps));
  const saved=logs.find(l=>l.title==='Size failure saved');assert.ok(saved);assert.match(saved.body,new RegExp(r.id));assert.match(saved.body,/Nothing was uploaded/);
  assert.ok(logs.findIndex(l=>l.title==='Size failure saved')<logs.findIndex(l=>l.title==='Review failed'),'saved before the failure is reported');
});
test('a research round that does not fit saves the continuation it would have sent',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const big='가'.repeat(60000);let round=0;
  const provider={request:async(op,payload)=>{round++;const prior=payload.options?.continuation??[{role:'user',content:'context'}];
    if(round<6)return {toolCalls:[{name:'get_context_detail',callId:'c'+round,args:{section:'none',part:'',from:0}}],continuation:[...prior,{role:'assistant',content:big},{type:'function_call',call_id:'c'+round,name:'get_context_detail',arguments:'{}'}],usage:{inputTokens:1,outputTokens:1}};
    return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',unlimitedBudget:true,unlimitedCalls:true});
  await assert.rejects(a.review('User request'));assert.equal(a.lastError,'CONTINUATION_OVER_BUDGET');
  const [r]=a.contextFailures.list();assert.equal(r.code,'CONTINUATION_OVER_BUDGET');assert.equal(r.stage,'research continuation');assert.ok(Array.isArray(r.input)&&r.input.length>2,'the continuation items');assert.equal(db.prepare('SELECT count(*) n FROM reviews').get().n,0);
});
test('a request the client refuses for size after shaping is recorded with the first request of the review',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const provider={request:async()=>{throw Object.assign(new Error('CONTEXT_OVER_BUDGET'),{detail:{limit:'app bytes',stage:'first request (request check)',wireBytes:70100,limitBytes:70000}});}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',unlimitedBudget:true,unlimitedCalls:true});
  await assert.rejects(a.review('User request'));const [r]=a.contextFailures.list();assert.equal(r.code,'CONTEXT_OVER_BUDGET');assert.equal(r.stage,'first request (request check)');
  assert.ok(Array.isArray(r.input.firstRequest.universe),'the first request that was sent');assert.match(r.input.note,/not returned by the provider worker/);
});
