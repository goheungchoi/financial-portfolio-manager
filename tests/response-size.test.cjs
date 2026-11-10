// 2026-11-10 incident: 13 final decisions in two days failed as INVALID_AI_RESPONSE with no usage and no rule. The
// whole response body was refused above 100,000 characters before it was parsed, and the Responses API echoes the
// request's instructions, tools and schema (about 79,000 characters for a review), so a long final decision crossed the
// cap. The decision itself was never looked at. Now the body limit only guards memory, the model's own output is
// bounded separately, every refusal carries usage, and each call records its response size.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const C=require('../electron/ai-client.cjs');const {AiClient,RESPONSE_CHAR_LIMIT,DECISION_OUTPUT_CHAR_LIMIT}=C;
const E=require('../electron/ai-errors.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');
const USAGE={input_tokens:30000,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens:2300,output_tokens_details:{reasoning_tokens:300}};
const hold=(explanation='No trade.')=>({action:'Hold',symbol:'',quantity:0,explanation});
const message=text=>({type:'message',content:[{type:'output_text',text}]});
// A Responses-shaped body that echoes the request, pretty-printed as the API does, padded to `size` characters with an
// opaque reasoning item (the part the app never reads).
function apiEcho(request,{output=[],status='completed',extra={},size=0}={}){
  const value={id:'resp_fixture',object:'response',status,model:'gpt-6-sol',instructions:request.instructions,tools:request.tools??[],text:request.text,output:[{type:'reasoning',id:'rs_fixture',summary:[],encrypted_content:''},...output],usage:USAGE,...extra};
  let text=JSON.stringify(value,null,2);if(size>text.length){value.output[0].encrypted_content='x'.repeat(size-text.length);text=JSON.stringify(value,null,2);}
  return text;
}
const client=(build,seen={})=>new AiClient('fixture_key_123',async(_url,init)=>{const request=JSON.parse(init.body);seen.request=request;const text=build(request);seen.chars=text.length;return {ok:true,text:async()=>text};});
const ctx={universe:[{symbol:'005930'}],quotes:[]};

test('the incident: a 120,000-character final response with a valid Hold is decided, with usage and its size',async()=>{
  const seen={};const r=await client(req=>apiEcho(req,{output:[message(JSON.stringify(hold()))],size:120000}),seen).decide(ctx,{research:true,final:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium'});
  assert.equal(r.decision.action,'Hold');assert.equal(r.usage.outputTokens,2300);assert.equal(r.responseChars,seen.chars);assert.ok(seen.chars>=120000);
  assert.ok(seen.request.instructions.length>20000,'the echo really contains the review instructions');
});
test('a research round with the same large echo returns its tool requests',async()=>{
  const call={type:'function_call',call_id:'c1',name:'get_context_detail',arguments:JSON.stringify({section:'performance',part:'',from:0})};
  const r=await client(req=>apiEcho(req,{output:[call],size:150000})).decide(ctx,{research:true});assert.equal(r.toolCalls.length,1);assert.ok(r.responseChars>=150000);
});
test('a body over the sanity limit is refused, names its size, and still carries usage',async()=>{
  await assert.rejects(client(req=>apiEcho(req,{output:[message(JSON.stringify(hold()))],size:RESPONSE_CHAR_LIMIT+1})).decide(ctx,{}),e=>{
    assert.equal(e.message,'INVALID_AI_RESPONSE');assert.match(e.detail.rule,/^a response of 1,001 KB, above the 1,000 KB limit$/);assert.equal(e.usage.outputTokens,2300);assert.equal(e.responseChars,RESPONSE_CHAR_LIMIT+1);
    assert.match(E.ruleDetail(e),/Rule: a response of 1,001 KB, above the 1,000 KB limit/);return true;});
  // Exactly at the limit is accepted.
  const r=await client(req=>apiEcho(req,{output:[message(JSON.stringify(hold()))],size:RESPONSE_CHAR_LIMIT})).decide(ctx,{});assert.equal(r.responseChars,RESPONSE_CHAR_LIMIT);assert.equal(r.decision.action,'Hold');
});
test('the model\'s own output is bounded at 60,000 characters, counted in characters not bytes',async()=>{
  const over=JSON.stringify(hold('a'.repeat(DECISION_OUTPUT_CHAR_LIMIT)));assert.ok(over.length>DECISION_OUTPUT_CHAR_LIMIT);
  await assert.rejects(client(req=>apiEcho(req,{output:[message(over)]})).decide(ctx,{}),e=>e.message==='INVALID_AI_RESPONSE'&&/^a decision of \d+ KB, above the 60 KB limit$/.test(e.detail.rule)&&e.usage.outputTokens===2300);
  // Split across two output_text parts, the joined text counts.
  const half=Math.ceil(over.length/2);await assert.rejects(client(req=>apiEcho(req,{output:[{type:'message',content:[{type:'output_text',text:over.slice(0,half)},{type:'output_text',text:over.slice(half)}]}]})).decide(ctx,{}),e=>/above the 60 KB limit/.test(e.detail.rule));
  // Korean text: 59,000 characters is about 177,000 bytes and is not refused for size.
  const korean=JSON.stringify(hold('보유 유지 ₩'.repeat(Math.floor((DECISION_OUTPUT_CHAR_LIMIT-200)/7))));assert.ok(korean.length<=DECISION_OUTPUT_CHAR_LIMIT&&Buffer.byteLength(korean)>DECISION_OUTPUT_CHAR_LIMIT*2);
  try{await client(req=>apiEcho(req,{output:[message(korean)]})).decide(ctx,{});}catch(e){assert.doesNotMatch(String(e.detail?.rule??''),/KB, above/,'not refused for its size');}
  // Exactly at the limit is not refused for size.
  const pad=DECISION_OUTPUT_CHAR_LIMIT-JSON.stringify(hold('')).length;const exact=JSON.stringify(hold('b'.repeat(pad)));assert.equal(exact.length,DECISION_OUTPUT_CHAR_LIMIT);
  try{await client(req=>apiEcho(req,{output:[message(exact)]})).decide(ctx,{});}catch(e){assert.doesNotMatch(String(e.detail?.rule??''),/KB, above/);}
});
test('other outcomes inside a large body keep their own codes',async()=>{
  await assert.rejects(client(req=>apiEcho(req,{status:'incomplete',extra:{incomplete_details:{reason:'max_output_tokens'}},size:130000})).decide(ctx,{}),e=>e.message==='AI_OUTPUT_LIMIT'&&e.usage.outputTokens===2300&&e.responseChars>=130000);
  await assert.rejects(client(req=>apiEcho(req,{output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}],size:130000})).decide(ctx,{}),e=>e.message==='AI_REFUSED');
  await assert.rejects(client(req=>apiEcho(req,{output:[message('not json')],size:130000})).decide(ctx,{}),e=>e.message==='INVALID_AI_RESPONSE'&&/not valid JSON/.test(e.detail.rule)&&e.usage!=null);
  // A 200 response that is not JSON is a request failure (retried once by the review), as before.
  await assert.rejects(client(()=>'<html>gateway</html>').decide(ctx,{}),e=>e.message==='AI_REQUEST_FAILED'&&e.responseChars===20&&e.usage===null);
});
test('the plan-correction and research loop run end to end over large echoes',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');let n=0;
  const c=client(req=>{n++;return n===1?apiEcho(req,{output:[{type:'function_call',call_id:'c1',name:'get_context_detail',arguments:JSON.stringify({section:'performance',part:'',from:0})}],size:110000}):apiEcho(req,{output:[message(JSON.stringify(hold()))],size:125000});});
  const done=await researchReview({context:ctx,evidence:{get:async()=>({})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),request:opts=>c.decide(ctx,{...opts})});assert.equal(done.decision.action,'Hold');assert.equal(n,2);
});
test('guard: the echo of the largest review configuration plus a full output stays under half the body limit',()=>{
  const big={universe:[{symbol:'005930'}],quotes:[],discovery:{enabled:true,watchlist:[]},agentDesk:{conditionalOrders:{allowed:true}},reviewInterval:{auto:true},scoutBrief:{},scoutPlan:{targets:Array.from({length:5},(_,i)=>({symbol:String(i)}))}};
  const echo=JSON.stringify({instructions:C.REVIEW_INSTRUCTIONS,tools:C.reviewTools(big),text:{format:{type:'json_schema',name:'portfolio_decision',strict:true,schema:C.decisionSchema(true,true)}}},null,2).length;
  assert.ok(echo>50000,'the echo is measured from the real definitions ('+echo+')');
  assert.ok(echo+8192*6<RESPONSE_CHAR_LIMIT/2,`echo ${echo} plus a full output must stay under ${RESPONSE_CHAR_LIMIT/2}`);
  assert.ok(8192*6<DECISION_OUTPUT_CHAR_LIMIT,'a full 8,192-token output fits the output limit');
  // No 100,000-character cap remains on a response body.
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/ai-client.cjs'),'utf8');assert.doesNotMatch(src,/(text|raw)\.length>\d{5,6}\)/);
});
test('the call record keeps the response size for completed and failed calls',()=>{
  const {settle}=require('../electron/ai-accounting.cjs');const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ai_usage(day TEXT PRIMARY KEY,calls INTEGER,reservedMicro INTEGER);CREATE TABLE ai_calls(id TEXT PRIMARY KEY,day TEXT,payload TEXT)');db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run('d',2,20000);
  for(const id of ['ok','bad','none'])db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'d',JSON.stringify({model:'gpt-6-sol',reservedMicro:10000}));
  const usage={inputTokens:100,outputTokens:10,cachedTokens:0,cacheWriteTokens:0};
  assert.equal(settle(db,'ai_usage','d','ok',{usage,responseChars:120345},'completed').responseChars,120345);
  const failed=Object.assign(new Error('INVALID_AI_RESPONSE'),{usage,model:'gpt-6-sol',responseChars:99});const rec=settle(db,'ai_usage','d','bad',failed,'failed-or-uncertain');assert.equal(rec.responseChars,99);assert.ok(rec.cost,'a refused call with usage is charged its real cost');
  assert.ok(!('responseChars' in settle(db,'ai_usage','d','none',{usage,responseChars:'12'},'completed')),'only a whole number is stored');
});
test('the provider worker reply keeps code, usage and size for AI operations, compact included',()=>{
  const usage={inputTokens:1,outputTokens:1};
  const compact=errorReply('compact',Object.assign(new Error('AI_OUTPUT_LIMIT'),{usage,model:'gpt-6-luna',responseChars:5000}));
  assert.deepEqual(compact,{ok:false,usage,model:'gpt-6-luna',responseChars:5000,detail:null,code:'AI_OUTPUT_LIMIT'});
  assert.equal(errorReply('compact',new Error('weird internal')).code,'PROVIDER_REQUEST_FAILED');
  const d=errorReply('decision',Object.assign(new Error('INVALID_AI_RESPONSE'),{usage,responseChars:130000,detail:{rule:'a decision of 61 KB, above the 60 KB limit',status:'completed',secret:'x'}}));
  assert.equal(d.code,'INVALID_AI_RESPONSE');assert.deepEqual(d.detail,{rule:'a decision of 61 KB, above the 60 KB limit',status:'completed'});assert.equal(d.responseChars,130000);
  const size=errorReply('decision',Object.assign(new Error('CONTEXT_OVER_BUDGET'),{detail:{limit:'app bytes',wireBytes:80000,limitBytes:70000,largest:['a:1']}}));assert.deepEqual(size.detail,{limit:'app bytes',wireBytes:80000,limitBytes:70000,largest:['a:1']});
  assert.equal(errorReply('scout',Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:'the plan was not valid JSON'})).detail,'the plan was not valid JSON');
  assert.equal(errorReply('reflection',Object.assign(new Error('REFLECTION_REQUEST_FAILED'),{usage})).usage,usage);
  // Non-AI operations get no usage, model or size, and only allowlisted codes.
  const broker=errorReply('news',Object.assign(new Error('AI_TIMEOUT'),{usage,model:'m',responseChars:5}));assert.deepEqual(broker,{ok:false,usage:null,model:null,responseChars:null,detail:null,code:'PROVIDER_REQUEST_FAILED'});
  assert.equal(errorReply('sec-filings',new Error('SEC_RATE_LIMITED')).code,'SEC_RATE_LIMITED');assert.equal(errorReply('sec-filings',new Error('sec bad')).code,'PROVIDER_REQUEST_FAILED');
  assert.equal(errorReply('decision',Object.assign(new Error('AI_TIMEOUT'),{responseChars:-1})).responseChars,null);
  assert.equal(errorReply('decision',null).code,'PROVIDER_REQUEST_FAILED');
});
