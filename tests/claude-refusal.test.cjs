'use strict';
// A refused Claude request (artifacts/reviews/2026-11-12-claude-dry-run, design.md and review.md C1 to C7): the reason
// is kept on this computer only, a certain refusal settles at zero, and nothing else changes. No network: every
// transport and provider is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');
require('./fixtures/order-book.cjs');
const A=require('../electron/anthropic-client.cjs');const Rt=require('../electron/ai-router.cjs');const ER=require('../electron/provider-error-reply.cjs');const {settle}=require('../electron/ai-accounting.cjs');
const KEY='sk-ant-fixture-refusal-key-0000';const OAI='sk-openai-fixture-refusal-0000';const OPTS={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const CTX={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:217000}]};
// The provider's message, with the loaded keys, a credential shape, control characters and more than 300 characters.
const SECRET_MSG=`output_config.format.schema: Schema is too complex for compilation. key ${KEY} other ${OAI} Bearer abc.def\u0007 ${'a1'.repeat(20)} ${'tail '.repeat(120)}`;
const MARK='Schema is too complex for compilation';
const answer=(status,body,ct='application/json')=>{const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':ct,'request-id':'req_refusal_fixture_01'}});};fn.sent=sent;return fn;};
const anthropicError=(type,message)=>({type:'error',error:{type,message},request_id:'req_refusal_fixture_01'});
const METHODS=[['decide',c=>c.decide(CTX,OPTS)],['narrative',c=>c.narrative({headlines:[]},OPTS)],['compact',c=>c.compact({items:['x']},OPTS)],['reflect',c=>c.reflect({evidence:{}},OPTS)],['scout',c=>c.scout({brief:'x'},OPTS)]];

test('a 4xx keeps status, type, request id and the cut, redacted message on a separate local field; the code and detail never carry it (C1, C2)',async()=>{
  for(const [name,run] of METHODS){const t=answer(400,anthropicError('invalid_request_error',SECRET_MSG));
    const e=await run(new A.AnthropicClient(KEY,t)).then(()=>null,x=>x);assert.ok(e,name);
    assert.equal(e.message,'AI_BAD_REQUEST',name+': the code alone');
    const p=e.providerError;assert.equal(p.status,400);assert.equal(p.errorType,'invalid_request_error');assert.equal(p.requestId,'req_refusal_fixture_01');assert.equal(p.anthropicError,true);assert.equal(p.contentType,'application/json');assert.equal(p.noCharge,true,name);
    assert.ok(p.message.startsWith('output_config.format.schema: '+MARK),name);assert.ok(p.message.length<=300);
    for(const leak of [KEY,'Bearer abc','\u0007','a1'.repeat(20)])assert.ok(!p.message.includes(leak),`${name}: ${leak.slice(0,12)} removed`);
    assert.ok(!JSON.stringify({message:e.message,detail:e.detail??null}).includes(MARK),name+': not in the code or detail');
    assert.ok(e.requestSizes?.totalBytes>0,name+': the measured request sizes go with it');}
});

test('which statuses keep the message: every 4xx except 401 and 429; a 5xx is not a certain refusal; a non-Anthropic body is marked and its text kept (ruling 1, design 3)',async()=>{
  const at=async(status,body,ct)=>new A.AnthropicClient(KEY,answer(status,body,ct)).decide(CTX,OPTS).then(()=>null,e=>e);
  for(const [status,type,code] of [[401,'authentication_error','AI_AUTH_FAILED'],[429,'rate_limit_error','AI_RATE_LIMITED']]){const e=await at(status,anthropicError(type,SECRET_MSG));
    assert.equal(e.message,code);assert.equal(e.providerError.message,undefined,`${status}: no message`);assert.equal(e.providerError.noCharge,true);assert.equal(e.providerError.requestId,'req_refusal_fixture_01');}
  for(const [status,type] of [[403,'permission_error'],[404,'not_found_error'],[413,'request_too_large'],[422,'invalid_request_error'],[418,'invalid_request_error']]){const e=await at(status,anthropicError(type,'beta not available for this account'));
    assert.equal(e.providerError.message,'beta not available for this account',String(status));assert.equal(e.providerError.noCharge,true,String(status));}
  const five=await at(500,anthropicError('api_error','Internal error'));assert.equal(five.providerError.noCharge,false);assert.equal(five.providerError.message,undefined);
  const html=await at(403,'<html><body>Forbidden by proxy</body></html>','text/html; charset=utf-8');
  assert.equal(html.providerError.anthropicError,false);assert.equal(html.providerError.contentType,'text/html; charset=utf-8');assert.match(html.providerError.message,/Forbidden by proxy/);
  const network=await new A.AnthropicClient(KEY,async()=>{throw new TypeError('fetch failed');}).decide(CTX,OPTS).then(()=>null,e=>e);assert.equal(network.providerError,undefined,'no answer, no record');
});

test('the worker reply carries the record, the sizes and the stop reason, with every loaded key removed by value; the router redacts through each client (C2)',async()=>{
  const router=Rt.createRouter({openai:new (require('../electron/ai-client.cjs').AiClient)(OAI,async()=>{throw 0;}),anthropic:Rt.claudeClient(KEY,answer(400,{}))});
  assert.equal(router.redact(`a ${KEY} b ${OAI} c`),'a [redacted] b [redacted] c');
  for(const op of ['decision','scout','narrative','compact','reflection']){
    const error=Object.assign(new Error('AI_BAD_REQUEST'),{usage:null,model:'claude-opus-5-5',responseChars:251,requestSizes:{totalBytes:110000,inputBytes:50000,'bad key':1},stopReason:'refusal!',providerError:{status:400,errorType:'invalid_request_error',requestId:'req_1',anthropicError:true,contentType:'application/json',message:`quoted ${OAI} here`,noCharge:true,extra:'dropped'}});
    const r=ER.errorReply(op,error,{redact:t=>router.redact(t)});
    assert.deepEqual(r.providerError,{status:400,requestId:'req_1',errorType:'invalid_request_error',anthropicError:true,contentType:'application/json',message:'quoted [redacted] here',noCharge:true},op);
    assert.deepEqual(r.requestSizes,{totalBytes:110000,inputBytes:50000});assert.equal(r.stopReason,'refusal');
    assert.ok(!JSON.stringify({code:r.code,detail:r.detail}).includes('quoted'),op+': the code and detail stay without it');}
  assert.equal(ER.errorReply('dart-company',Object.assign(new Error('x'),{providerError:{status:400,noCharge:true}})).providerError,undefined,'only AI operations');
  assert.equal(ER.providerError({status:200}),null);assert.equal(ER.providerError({status:503,noCharge:true}).noCharge,false,'a 5xx is never no-charge');
});

// Settle: the reservation is released for a certain refusal; nothing else changes.
function ledger(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_calls(id TEXT PRIMARY KEY,day TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT PRIMARY KEY,calls INTEGER,reservedMicro REAL);CREATE TABLE reflection_usage(day TEXT PRIMARY KEY,calls INTEGER,reservedMicro REAL);CREATE TABLE ai_usage_vendor(day TEXT,vendor TEXT,calls INTEGER,reservedMicro REAL,PRIMARY KEY(day,vendor))');
  const reserve=(id,day,micro,model='claude-opus-5-5')=>{db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,day,JSON.stringify({reviewId:'r',model,reservedMicro:micro,status:'pending'}));
    for(const [t] of [['ai_usage']])db.prepare(`INSERT INTO ${t} VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1,reservedMicro=reservedMicro+excluded.reservedMicro`).run(day,micro);
    db.prepare("INSERT INTO ai_usage_vendor VALUES(?,?,1,?) ON CONFLICT(day,vendor) DO UPDATE SET calls=calls+1,reservedMicro=reservedMicro+excluded.reservedMicro").run(day,model.startsWith('claude-')?'anthropic':'openai',micro);};
  const row=(t,day,vendor)=>({...(vendor?db.prepare(`SELECT calls,reservedMicro FROM ${t} WHERE day=? AND vendor=?`).get(day,vendor):db.prepare(`SELECT calls,reservedMicro FROM ${t} WHERE day=?`).get(day))});
  const call=id=>JSON.parse(db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(id).payload);return {db,reserve,row,call};}
const refusedError=(status=400)=>Object.assign(new Error('AI_BAD_REQUEST'),{usage:null,model:'claude-opus-5-5',responseChars:251,providerError:{status,errorType:'invalid_request_error',requestId:'req_1',anthropicError:true,message:'m',noCharge:true}});

test('a certain refusal settles at zero as "refused", one call still counted; a timeout, a 5xx or an answer with usage keep today\'s accounting (ruling 2)',()=>{
  const {db,reserve,row,call}=ledger();reserve('c1','2026-11-12',1168517);
  settle(db,'ai_usage','2026-11-12','c1',refusedError(),'failed-or-uncertain');
  const c=call('c1');assert.equal(c.status,'refused');assert.equal(c.accountedMicro,0);assert.equal(c.estimatedMicro,0);assert.equal(c.providerError.requestId,'req_1');
  assert.deepEqual(row('ai_usage','2026-11-12'),{calls:1,reservedMicro:0});assert.deepEqual(row('ai_usage_vendor','2026-11-12','anthropic'),{calls:1,reservedMicro:0});
  for(const status of [401,403,404,413,422,429]){const id='s'+status;reserve(id,'2026-11-12',1000);settle(db,'ai_usage','2026-11-12',id,refusedError(status),'failed-or-uncertain');assert.equal(call(id).status,'refused',String(status));}
  reserve('t','2026-11-12',500000);settle(db,'ai_usage','2026-11-12','t',Object.assign(new Error('AI_TIMEOUT'),{usage:null,model:'claude-opus-5-5'}),'failed-or-uncertain');assert.equal(call('t').status,'failed-or-uncertain');assert.equal(call('t').accountedMicro,500000);
  reserve('f','2026-11-12',500000);settle(db,'ai_usage','2026-11-12','f',Object.assign(new Error('AI_REQUEST_FAILED'),{usage:null,model:'claude-opus-5-5',providerError:{status:529,noCharge:false}}),'failed-or-uncertain');assert.equal(call('f').accountedMicro,500000,'529 keeps its reservation');
  reserve('u','2026-11-12',500000);settle(db,'ai_usage','2026-11-12','u',Object.assign(new Error('AI_OUTPUT_LIMIT'),{usage:{inputTokens:1000,outputTokens:100},model:'claude-opus-5-5',providerError:{status:400,noCharge:true}}),'failed-or-uncertain');
  assert.notEqual(call('u').status,'refused','an answer with usage is charged its cost');assert.ok(call('u').accountedMicro>0);
  // OpenAI: unchanged (C7).
  reserve('o','2026-11-12',300000,'gpt-6-sol');settle(db,'ai_usage','2026-11-12','o',Object.assign(new Error('AI_BAD_REQUEST'),{usage:null,model:'gpt-6-sol'}),'failed-or-uncertain');assert.equal(call('o').status,'failed-or-uncertain');assert.equal(call('o').accountedMicro,300000);
});

test('the zero settle goes to the reservation\'s own day after midnight KST and never takes a row below zero (C4)',()=>{
  const {db,reserve,row}=ledger();reserve('late','2026-11-12',1168517);reserve('next','2026-11-13',2000);
  settle(db,'ai_usage','2026-11-12','late',refusedError(),'failed-or-uncertain');
  assert.deepEqual(row('ai_usage','2026-11-12'),{calls:1,reservedMicro:0});assert.deepEqual(row('ai_usage','2026-11-13'),{calls:1,reservedMicro:2000},'the next day is untouched');
  assert.deepEqual(row('ai_usage_vendor','2026-11-13','anthropic'),{calls:1,reservedMicro:2000});
  db.prepare("UPDATE ai_usage SET reservedMicro=100 WHERE day='2026-11-13'").run();db.prepare("UPDATE ai_usage_vendor SET reservedMicro=100 WHERE day='2026-11-13'").run();
  settle(db,'ai_usage','2026-11-13','next',refusedError(),'failed-or-uncertain');assert.equal(row('ai_usage','2026-11-13').reservedMicro,0,'clamped at zero');assert.equal(row('ai_usage_vendor','2026-11-13','anthropic').reservedMicro,0);
});

// The engine: a Claude dry run whose request is refused (the provider fake throws what the worker reply becomes).
function harness(){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const events=[];let refuse=true;
  const provider={request:async(op,payload)=>{supplied.push({op,payload:JSON.stringify(payload)});const claude=String(payload?.options?.openaiModel??'').startsWith('claude-');
    if(claude&&refuse){const e=new Error('AI_BAD_REQUEST');Object.assign(e,{usage:null,model:'claude-opus-5-5',responseChars:251,requestSizes:{totalBytes:63441},detail:{requestId:'req_1',errorType:'invalid_request_error'},providerError:ER.providerError({status:400,errorType:'invalid_request_error',requestId:'req_1',anthropicError:true,contentType:'application/json',message:SECRET_MSG.replace(KEY,'[redacted]').replace(OAI,'[redacted]').slice(0,300),noCharge:true})});throw e;}
    if(op==='compact')return {summaries:[],usage:{inputTokens:1,outputTokens:1},model:payload.options.openaiModel};
    if(op==='narrative')return {narrative:{summary:'s',regime:'neutral',drivers:[]},usage:{inputTokens:1,outputTokens:1},model:payload.options.openaiModel};
    return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai',model:payload?.options?.openaiModel};}};
  const automation=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({id,kind,title,body}));automation.live=live;automation.providerStatus={...automation.providerStatus,aiConnected:true,openaiConnected:true,anthropicConnected:true};automation.evidence={get:async()=>({})};
  automation.series={closes:()=>null,ensure:async()=>{}};automation.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];automation.indexCloses=()=>({});automation.news=[{title:'KOSPI rises',url:'https://example.com/a',published:new Date().toISOString(),source:'x'}];
  automation.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,anthropicUSDPerDay:20,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  return {automation,db,supplied,events,setRefuse:v=>{refuse=v;}};
}
const CLAUDE={model:{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}};

test('a refused Claude dry run: the record keeps the refusal and a $0 measurement; the console line has no message; the gate stays null; nothing retried (C3, C5, C6)',async()=>{
  const {automation,db,supplied,events}=harness();const started=Date.now();
  await assert.rejects(automation.dryRun('review',CLAUDE),/AI_BAD_REQUEST/);
  assert.equal(supplied.filter(s=>s.op==='decision').length,1,'one attempt: a certain refusal is not retried');
  const f=automation.dryRunFailure(started);assert.equal(f.failed,'AI_BAD_REQUEST');assert.equal(f.providerError.status,400);assert.ok(f.providerError.message.includes(MARK));
  assert.equal(f.measurement.requests[0].status,'refused');assert.equal(f.measurement.requests[0].costUSD,0);assert.equal(f.measurement.totals.costUSD,0);
  const line=events.find(e=>e.title==='Dry-run review · request refused');assert.equal(line.body,'400 invalid_request_error · request req_1');
  assert.equal(automation.completedClaudeDryRun(),null,'a run with a refused call opens no gate');
  assert.equal(automation.vendorUsage('anthropic').reservedMicro,0,'the reservation was released');
  // Every reader of a call status: the estimate counts completed calls only; the state's recent calls show "refused".
  assert.equal(automation.dryRunEstimate({model:'claude-opus-5-5'}).estimateUSD,null);
  assert.ok(automation.getState().aiCalls.some(c=>c.status==='refused'));
  for(const code of ['AI_BAD_REQUEST','AI_AUTH_FAILED','AI_MODEL_UNAVAILABLE','AI_RATE_LIMITED','CONTEXT_TOO_LARGE','AI_CONTEXT_LIMIT'])
    assert.ok(!['AI_REQUEST_FAILED','AI_SERVER_ERROR','AI_TIMEOUT'].includes(code),code+' is not among the retried codes');
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');assert.ok(src.includes("if(!['AI_REQUEST_FAILED','AI_SERVER_ERROR','AI_TIMEOUT'].includes(error?.message)||this.disposed)throw error;"),'the retry list is unchanged');
});

test('the message stays local: not in the code, lastErrorDetail, the log, the phone outbox, the digest, the review context or any later request, on every Claude path (C1)',async()=>{
  const {automation,db,supplied,events,setRefuse}=harness();
  await automation.dryRun('review',CLAUDE).catch(e=>assert.equal(e.message,'AI_BAD_REQUEST'));
  automation.configure({routineModel:'gpt-6-luna',routineEffort:'none'});
  // The other paths with Claude refused: condensing, the narrative (gate opened only for this check).
  automation.completedClaudeDryRun=()=>({id:'d'});automation.stateCache?.clear?.();automation.configure({routineModel:'claude-opus-5-5',routineEffort:'low',narrativeModel:'claude-opus-5-5'});
  await automation.compactResearch('rev',{items:['x']}).catch(()=>{});await automation.buildNarrative().catch(()=>{});
  // Then ordinary requests follow, and a review: none may carry the message.
  setRefuse(false);const before=supplied.length;automation.configure({routineModel:'gpt-6-luna',routineEffort:'none',narrativeModel:'same'});await automation.review('User request').catch(()=>{});await automation.compactResearch('rev2',{items:['y']}).catch(()=>{});await automation.buildNarrative().catch(()=>{});
  assert.ok(supplied.length>before,'later requests were made');
  const later=supplied.slice(before).map(s=>s.payload).join('\n');assert.ok(!later.includes(MARK),'no later request carries it');
  const places={lastError:String(automation.lastError??''),lastErrorDetail:String(automation.lastErrorDetail??''),events:JSON.stringify(events),narrativeError:String(automation.narrativeError??''),scoutError:String(automation.scoutError??'')};
  for(const t of ['notification_outbox','digests','events'])try{places[t]=JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());}catch{places[t]='(no table)';}
  try{places.digest=JSON.stringify(automation.digest.list());}catch{}
  for(const [k,v] of Object.entries(places))assert.ok(!v.includes(MARK),k);
  // Where it is kept: the call records and the dry-run record only.
  assert.ok(JSON.stringify(db.prepare('SELECT payload FROM ai_calls').all()).includes(MARK));assert.ok(JSON.stringify(db.prepare('SELECT payload FROM dry_runs').all()).includes(MARK));
  // In the code: only these files read providerError.
  const readers=fs.readdirSync(path.join(__dirname,'../electron')).filter(f=>f.endsWith('.cjs')&&fs.readFileSync(path.join(__dirname,'../electron',f),'utf8').includes('providerError')).sort();
  assert.deepEqual(readers,['ai-accounting.cjs','anthropic-client.cjs','automation.cjs','kis-service.cjs','provider-error-reply.cjs']);
});

test('the Dry-run panel says $0.00, refused and the reservation released; the request id is shown (C5)',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/Dashboard.tsx'),'utf8');
  assert.ok(src.includes("' $0.00, refused: the reservation was released.'"),'the text');assert.ok(src.includes('aria-label="Refused request"')&&src.includes('{p.requestId}'),'the request id');
  assert.ok(src.includes('{dryFailure?.providerError&&<Refusal p={dryFailure.providerError}/>}{dryFailure?.measurement&&<Measurement m={dryFailure.measurement}/>}'));
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.ok(main.includes('failure:automation.dryRunFailure(started)'));
});

test('the redaction keeps the diagnosis: a beta name, long field and tool names and words with "sk-" in them stay; a real-looking key goes (diff review F1)',()=>{
  const real='sk-ant-api03-Zx9Qw81LmN2pR7sT4uV6wX8yZ0aB3cD5eF7gH9iJ1kL3mN5oP7qR9sT1uV3wX5yZ7-AbCdEfGh';
  for(const m of ['Unexpected value(s) `thinking-binding-controls-2026-08-01` for the `anthropic-beta` header',
    'tools.12.input_schema.properties.maximum_position_weight_percent_value: unsupported keyword',
    'risk-adjusted_return_limit is not permitted','model claude-opus-5-5: get_company_research and set_conditional_order are fine'])
    assert.equal(A.cleanText(m,[]),m,m);
  assert.equal(A.cleanText(`key ${real} here`,[]),'key [redacted] here','by shape');
  assert.equal(A.cleanText('token 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc end',[]),'token [redacted] end','a long run of letters and digits');
  assert.equal(A.cleanText(`own ${KEY} key`,[KEY]),'own [redacted] key','the loaded key by value first');
  assert.equal(A.cleanText('Authorization: Bearer eyJhbGciOi.payload.sig',[]),'Authorization: [redacted]');
});

test('zero only when certain: a refusal on the retry after an uncertain attempt keeps its reservation; a refusal on the first attempt is not retried and settles at zero (diff review F2)',async()=>{
  const run=async sequence=>{const h=harness();const steps=[...sequence];let attempts=0;
    h.automation.provider={request:async(op,payload)=>{if(op!=='decision'||!String(payload?.options?.openaiModel??'').startsWith('claude-'))return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};
      attempts++;const kind=steps.shift();
      if(kind==='uncertain')throw Object.assign(new Error('AI_REQUEST_FAILED'),{usage:null,model:'claude-opus-5-5',providerError:ER.providerError({status:503,errorType:'overloaded_error',anthropicError:true,noCharge:false})});
      throw Object.assign(new Error('AI_BAD_REQUEST'),{usage:null,model:'claude-opus-5-5',responseChars:251,providerError:ER.providerError({status:400,errorType:'invalid_request_error',requestId:'req_1',anthropicError:true,message:'m',noCharge:true})});}};
    await h.automation.dryRun('review',CLAUDE).catch(()=>{});
    const calls=h.db.prepare('SELECT payload FROM ai_calls').all().map(r=>JSON.parse(r.payload)).filter(c=>String(c.model).startsWith('claude-'));
    return {attempts,calls,vendor:h.automation.vendorUsage('anthropic')};};
  const after=await run(['uncertain','refused']);assert.equal(after.attempts,2,'retried once after the uncertain attempt');assert.equal(after.calls.length,1);
  assert.equal(after.calls[0].status,'failed-or-uncertain');assert.equal(after.calls[0].accountedMicro,after.calls[0].reservedMicro,'the reservation is kept');assert.ok(after.vendor.reservedMicro>0);
  const first=await run(['refused']);assert.equal(first.attempts,1,'no retry');assert.equal(first.calls[0].status,'refused');assert.equal(first.calls[0].accountedMicro,0);assert.equal(first.vendor.reservedMicro,0);
});
