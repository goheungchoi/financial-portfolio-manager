// OpenAI refusal fix, step R1 (artifacts/reviews/2026-11-13-openai-rate-limit: design.md sections 2 to 4, review.md):
// an OpenAI refusal keeps its reason on this computer, the billing codes are told from a rate limit, and a certain
// refusal settles at zero. No network: every transport is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const C=require('../electron/ai-client.cjs');const E=require('../electron/ai-errors.cjs');const ER=require('../electron/provider-error-reply.cjs');const {settle}=require('../electron/ai-accounting.cjs');
const KEY='sk-proj-'+'Q'.repeat(12)+'fixtureKey0123456789';
// A fake OpenAI error response: status, JSON body and headers (a Map, as the app's fakes use, and Headers alike).
const reply=(status,body,headers={})=>({ok:false,status,text:async()=>typeof body==='string'?body:JSON.stringify(body),headers:new Headers({'content-type':'application/json',...headers})});
const RATE={error:{message:'Rate limit reached for gpt-6-sol in organization org-x on tokens per day (TPD): Limit 100000, Used 99990.',type:'requests',param:null,code:'rate_limit_exceeded'}};
const LIMIT_HEADERS={'x-request-id':'req_0a1b2c3d','retry-after':'56','x-ratelimit-limit-requests':'60','x-ratelimit-remaining-requests':'59','x-ratelimit-reset-requests':'1s','x-ratelimit-limit-tokens':'150000','x-ratelimit-remaining-tokens':'0','x-ratelimit-reset-tokens':'6m0s','x-ratelimit-reset-project-tokens':'3s'};

test('a 429 rate limit keeps status, request id, type, code, message, Retry-After and the limit headers; settles as no charge',async()=>{
  const e=await E.responseError(reply(429,RATE,LIMIT_HEADERS),[KEY]);
  assert.equal(e.message,'AI_RATE_LIMITED');
  assert.deepEqual(e.providerError,{status:429,vendor:'openai',requestId:'req_0a1b2c3d',errorType:'requests',errorCode:'rate_limit_exceeded',anthropicError:false,contentType:'application/json',message:RATE.error.message,retryAfterSec:56,
    limits:{requests:{limit:60,remaining:59,reset:'1s'},tokens:{limit:150000,remaining:0,reset:'6m0s'},projectTokens:{limit:null,remaining:null,reset:'3s'}},noCharge:true});
  const none=await E.responseError(reply(429,{error:{message:'Rate limit reached for requests',type:null,code:null}}));assert.equal(none.message,'AI_RATE_LIMITED');assert.equal(none.providerError.retryAfterSec,undefined,'no Retry-After: none kept');
  const slow=await E.responseError(reply(429,{error:{message:'Slow down',type:'rate_limit_error',code:'slow_down'}}));assert.equal(slow.message,'AI_RATE_LIMITED');assert.equal(slow.providerError.errorCode,'slow_down');
});
test('the billing refusals (each code, and the type insufficient_quota with any code) are AI_QUOTA_EXHAUSTED, not a rate limit',async()=>{
  for(const code of ['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded']){
    const e=await E.responseError(reply(429,{error:{message:'m',type:'insufficient_quota',code}}));assert.equal(e.message,'AI_QUOTA_EXHAUSTED',code);assert.equal(e.providerError.errorCode,code);assert.equal(e.providerError.noCharge,true);
    const typeless=await E.responseError(reply(429,{error:{message:'m',code}}));assert.equal(typeless.message,'AI_QUOTA_EXHAUSTED',code+' without a type');}
  const unknown=await E.responseError(reply(429,{error:{message:'m',type:'insufficient_quota',code:'some_new_billing_code'}}));assert.equal(unknown.message,'AI_QUOTA_EXHAUSTED','the type decides');assert.equal(unknown.providerError.errorCode,'some_new_billing_code','named');
  const newRate=await E.responseError(reply(429,{error:{message:'m',type:'tokens',code:'an_unknown_code'}}));assert.equal(newRate.message,'AI_RATE_LIMITED','an unknown 429 code is a rate limit');assert.equal(newRate.providerError.errorCode,'an_unknown_code','with its code named');
  assert.match(E.messages.AI_QUOTA_EXHAUSTED,/credit or spend limit is used up/);
});
test('the other statuses map as before; 5xx is kept but not "no charge"; an unreadable body is not "no charge"',async()=>{
  const map=async(s,b={error:{message:'m'}})=>(await E.responseError(reply(s,b))).message;
  assert.equal(await map(401),'AI_AUTH_FAILED');assert.equal(await map(403),'AI_MODEL_UNAVAILABLE');assert.equal(await map(404),'AI_MODEL_UNAVAILABLE');assert.equal(await map(400),'AI_BAD_REQUEST');assert.equal(await map(500),'AI_SERVER_ERROR');
  assert.equal(await map(400,{error:{code:'context_length_exceeded'}}),'AI_CONTEXT_LIMIT');assert.equal(await map(404,{error:{code:'model_not_found'}}),'AI_MODEL_UNAVAILABLE');
  const overloaded=await E.responseError(reply(503,{error:{message:'overloaded',type:'service_unavailable_error',code:'server_is_overloaded'}},{'retry-after':'20'}));
  assert.equal(overloaded.message,'AI_SERVER_ERROR');assert.equal(overloaded.providerError.noCharge,false,'a 5xx stays uncertain');assert.equal(overloaded.providerError.retryAfterSec,20);
  const html=await E.responseError(reply(429,'<html>busy</html>',{'content-type':'text/html'}));assert.equal(html.message,'AI_RATE_LIMITED');assert.equal(html.providerError.noCharge,false,'no JSON body read: not certain');
});
test('nothing key-shaped is kept: the loaded key, key shapes, a key-shaped request id; a 401 keeps no message',async()=>{
  const leaky=await E.responseError(reply(429,{error:{message:`Incorrect quota for ${KEY} and sk-${'a'.repeat(30)} (Bearer abc.def)`,type:'insufficient_quota',code:'credit_balance_exhausted'}},{'x-request-id':'sk-'+'b'.repeat(40)}),[KEY]);
  const text=JSON.stringify(leaky.providerError);assert.ok(!text.includes(KEY)&&!/sk-[A-Za-z0-9_-]{16,}/.test(text)&&!/Bearer abc/.test(text),text);assert.equal(leaky.providerError.requestId,undefined,'a key-shaped request id is dropped');
  const auth=await E.responseError(reply(401,{error:{message:'Incorrect API key provided: sk-proj-****6789.'}}),[KEY]);assert.equal(auth.providerError.message,undefined);
  // The worker's check keeps the new fields and drops malformed ones.
  const P=ER.providerError({...leaky.providerError,errorCode:'BAD CODE',retryAfterSec:-1,limits:{tokens:{limit:'x',remaining:5,reset:'evil;'}}},t=>t);
  assert.equal(P.vendor,'openai');assert.equal(P.errorCode,undefined);assert.equal(P.retryAfterSec,undefined);assert.deepEqual(P.limits,{tokens:{limit:null,remaining:5,reset:null}});
});
test('every OpenAI path keeps the record: decide, scout, narrative, compact and reflect',async()=>{
  const client=()=>new C.AiClient(KEY,async()=>reply(429,{error:{message:'You have no credit',type:'insufficient_quota',code:'credit_balance_exhausted'}},{'x-request-id':'req_path'}));
  const ctx={environment:'kis',universe:[{symbol:'005930'}],positions:{}};const opts={openaiModel:'gpt-6-sol',reasoningEffort:'medium'};
  const runs={decide:c=>c.decide(ctx,{...opts,research:true}),scout:c=>c.scout(ctx,opts),narrative:c=>c.narrative({headlines:[]},opts),compact:c=>c.compact({items:[]},{openaiModel:'gpt-6-luna',reasoningEffort:'none'}),reflect:c=>c.reflect({sale:{}},opts)};
  for(const [name,run] of Object.entries(runs)){let error;try{await run(client());}catch(e){error=e;}
    assert.ok(error,name+' fails');assert.equal(error.providerError?.errorCode,'credit_balance_exhausted',name);assert.equal(error.providerError.requestId,'req_path',name);
    if(name!=='reflect')assert.equal(error.message,'AI_QUOTA_EXHAUSTED',name);else assert.equal(error.message,'REFLECTION_REQUEST_FAILED');
    // Through the worker's reply, as the main process receives it.
    const op=name==='reflect'?'reflection':name==='decide'?'decision':name;const r=ER.errorReply(op,error,{redact:t=>String(t).split(KEY).join('[redacted]')});
    assert.equal(r.providerError?.errorCode,'credit_balance_exhausted',name+' reply');assert.equal(r.providerError.noCharge,true);}
});
test('a certain OpenAI refusal settles at zero as "refused"; a 5xx, or a refusal after an uncertain attempt, keeps its reservation',async()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_calls(id TEXT PRIMARY KEY,day TEXT,payload TEXT);CREATE TABLE ai_usage(day TEXT PRIMARY KEY,calls INTEGER,reservedMicro REAL);CREATE TABLE ai_usage_vendor(day TEXT,vendor TEXT,calls INTEGER,reservedMicro REAL,PRIMARY KEY(day,vendor))');
  const reserve=(id,micro)=>{db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'2026-11-13',JSON.stringify({reviewId:'r',model:'gpt-6-sol',reservedMicro:micro,status:'pending'}));db.prepare('INSERT INTO ai_usage VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1,reservedMicro=reservedMicro+excluded.reservedMicro').run('2026-11-13',micro);db.prepare("INSERT INTO ai_usage_vendor VALUES(?,'openai',1,?) ON CONFLICT(day,vendor) DO UPDATE SET calls=calls+1,reservedMicro=reservedMicro+excluded.reservedMicro").run('2026-11-13',micro);};
  const call=id=>JSON.parse(db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(id).payload);const day=()=>({...db.prepare("SELECT calls,reservedMicro FROM ai_usage WHERE day='2026-11-13'").get()});
  const failure=async(status,body,extra={})=>{const e=await E.responseError(reply(status,body,{'x-request-id':'req_s'}),[KEY]);const r=ER.errorReply('decision',Object.assign(e,{usage:null,model:'gpt-6-sol'}));return Object.assign(new Error(r.code),{usage:r.usage,model:r.model,providerError:ER.providerError(r.providerError),...extra});};
  reserve('rate',300651);settle(db,'ai_usage','2026-11-13','rate',await failure(429,RATE),'failed-or-uncertain');
  assert.equal(call('rate').status,'refused');assert.equal(call('rate').accountedMicro,0);assert.equal(call('rate').providerError.errorCode,'rate_limit_exceeded');assert.deepEqual(day(),{calls:1,reservedMicro:0},'released, still one call');
  reserve('quota',11199);settle(db,'ai_usage','2026-11-13','quota',await failure(429,{error:{type:'insufficient_quota',code:'project_spend_limit_exceeded',message:'m'}}),'failed-or-uncertain');assert.equal(call('quota').status,'refused');assert.equal(call('quota').accountedMicro,0);
  reserve('5xx',50000);settle(db,'ai_usage','2026-11-13','5xx',await failure(500,{error:{message:'server'}}),'failed-or-uncertain');assert.equal(call('5xx').status,'failed-or-uncertain');assert.equal(call('5xx').accountedMicro,50000);
  reserve('after',70000);settle(db,'ai_usage','2026-11-13','after',await failure(429,RATE,{earlierUncertain:true}),'failed-or-uncertain');assert.equal(call('after').status,'failed-or-uncertain','a retry after an uncertain attempt keeps it');assert.equal(call('after').accountedMicro,70000);
  assert.deepEqual(day(),{calls:4,reservedMicro:120000});
});
test('the review failure line names the request id and the code',async()=>{
  const e=await E.responseError(reply(429,{error:{message:'m',type:'insufficient_quota',code:'credit_balance_exhausted'}},{'x-request-id':'req_line'}));
  assert.match(E.detail('AI_QUOTA_EXHAUSTED','AI research and decision',e),/Request: req_line \(credit_balance_exhausted\)\./);
});
