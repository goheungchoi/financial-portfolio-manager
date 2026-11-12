// Anthropic provider, step A3: AnthropicClient.decide on fake transports only (no request leaves the process).
// Design: artifacts/reviews/2026-11-10-anthropic-provider/design.md sections 5 and 10.
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../electron/anthropic-client.cjs');const C=require('../electron/ai-client.cjs');const E=require('../electron/ai-errors.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);
const OPTS={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const CTX={universe:[{symbol:'005930'},{symbol:'NASD:NVDA'}],quotes:[{symbol:'005930',price:217000}]};
const FULL={...CTX,agentDesk:{conditionalOrders:{allowed:true}},discovery:{enabled:true,watchlist:[]},reviewInterval:{auto:true}};
const USAGE={input_tokens:1200,cache_read_input_tokens:9000,cache_creation_input_tokens:3000,output_tokens:400};
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const thinking={type:'thinking',thinking:'',signature:'sig_fixture_opaque'};
const text=t=>({type:'text',text:t});
const toolUse=(id,name='get_context_detail',input={section:'performance',part:'',from:0})=>({type:'tool_use',id,name,input});
function claudeReply({content=[thinking,text(JSON.stringify(hold))],stop_reason='end_turn',usage=USAGE,model='claude-opus-5-5',stop_details=null,input_transformations=[],extra={}}={}){
  return {id:'msg_fixture',type:'message',role:'assistant',model,content,stop_reason,stop_details,usage,input_transformations,...extra};
}
// A transport that answers each request with the next reply and keeps what was sent.
function transport(...replies){
  const sent=[];const fn=async(url,init)=>{const headers=new Headers(init.headers);sent.push({url,init,headers,body:JSON.parse(init.body)});const r=replies.length>1?replies.shift():replies[0];
    if(typeof r==='function')return r(init);const status=r.status??200;const body=r.status?r.body:r;return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});};
  fn.sent=sent;return fn;
}
const client=(t,opts)=>new A.AnthropicClient(KEY,t,opts);

test('request shape: system cached with the shape block, Claude tools, auto then none, effort without a grammar, adaptive thinking with drop_block, one beta, no fallback',async()=>{
  const t=transport(claudeReply());await client(t).decide(FULL,{...OPTS,research:true});
  const {body,headers,url}=t.sent[0];
  assert.match(url,/^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(body.model,'claude-opus-5-5');assert.equal(body.max_tokens,32000);// B2: thinking counts toward max_tokensassert.equal(body.service_tier,'standard_only');
  // Grammar design option A: the instructions, then the shape block (the app's schema with its bounds), cached together.
  assert.deepEqual(body.system,[{type:'text',text:C.REVIEW_INSTRUCTIONS},{type:'text',text:A.shapeText(A.decisionShape(C.decisionSchema(false,false))),cache_control:{type:'ephemeral'}}]);
  assert.equal(body.tools.length,C.reviewTools(FULL).length);assert.deepEqual(body.tools.map(x=>x.name),C.reviewTools(FULL).map(x=>x.name),'same tools, same order');
  for(const tool of body.tools)assert.deepEqual(Object.keys(tool).sort(),['description','input_schema','name']);
  assert.deepEqual(body.tool_choice,{type:'auto'});
  assert.deepEqual(body.thinking,{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}});
  assert.deepEqual(body.output_config,{effort:'medium'},'no output_config.format: the app checks the shape');
  assert.equal(headers.get('anthropic-beta'),'thinking-binding-controls-2026-08-01','the only beta');
  for(const k of ['fallbacks','temperature','top_p','top_k','store','prompt_cache_key','max_output_tokens','reasoning','instructions','text','input','parallel_tool_calls','betas','cache_control'])assert.ok(!(k in body),k);
  assert.ok(!('budget_tokens' in body.thinking));assert.ok(!['any','tool'].includes(body.tool_choice.type),'never forced tool choice');
  assert.deepEqual(body.messages,[{role:'user',content:JSON.stringify(FULL)}]);
  assert.ok(!init(t).body.includes(KEY),'the key is not in the body');
  // The final round keeps the same tools (cached prefix) and allows none; a review without research sends no tools.
  const f=transport(claudeReply());await client(f).decide(FULL,{...OPTS,research:true,final:true});assert.deepEqual(f.sent[0].body.tool_choice,{type:'none'});assert.deepEqual(f.sent[0].body.tools,body.tools);
  const p=transport(claudeReply());await client(p).decide(CTX,OPTS);assert.ok(!('tools' in p.sent[0].body)&&!('tool_choice' in p.sent[0].body));
  // Effort follows the settings; the scout-plan schema variant follows the context.
  const h=transport(claudeReply());await client(h).decide({...CTX,scoutBrief:{},scoutPlan:{targets:[{symbol:'x'}]}},{...OPTS,reasoningEffort:'high'}).catch(()=>{});assert.equal(h.sent[0].body.output_config.effort,'high');assert.equal(h.sent[0].body.output_config.format,undefined);assert.equal(h.sent[0].body.system[1].text,A.shapeText(A.decisionShape(C.decisionSchema(true,true))),'the shape follows the context');
});
const init=t=>t.sent[0].init;
test('every schema after translation has no unsupported keyword, no union type, and closed objects',()=>{
  const schemas=[...[[false,false],[true,false],[false,true],[true,true]].map(([b,p])=>['decision '+b+p,A.toAnthropicSchema(C.decisionSchema(b,p))]),...A.toTools(C.reviewTools(FULL)).map(t=>[t.name,t.input_schema])];
  for(const [name,schema] of schemas){
    const walk=(s,path)=>{if(!s||typeof s!=='object')return;if(Array.isArray(s)){s.forEach((x,i)=>walk(x,path+'['+i+']'));return;}
      for(const k of A.UNSUPPORTED)if(k in s)assert.fail(`${name}: ${k} at ${path}`);
      if(Array.isArray(s.type))assert.fail(`${name}: union type at ${path}`);
      if(s.type==='object')assert.equal(s.additionalProperties,false,`${name}: open object at ${path}`);
      for(const [k,v] of Object.entries(s))if(k==='properties')for(const [p,sub] of Object.entries(v))walk(sub,path+'.'+p);else if(k!=='enum'&&k!=='const')walk(v,path+'.'+k);};
    walk(schema,name);
  }
  // The conversion itself: union to anyOf with the other keywords on the non-null branch; constraints removed; a
  // property named like a keyword is kept; the original is not changed.
  const src={type:'object',properties:{minimum:{type:['number','null'],description:'A floor',minimum:0},n:{type:'integer',maximum:5},list:{type:'array',items:{type:'string',maxLength:3},maxItems:2}},required:['minimum','n','list'],additionalProperties:false};
  const out=A.toAnthropicSchema(src);
  assert.deepEqual(out.properties.minimum,{description:'A floor',anyOf:[{type:'number'},{type:'null'}]});assert.deepEqual(out.properties.n,{type:'integer'});assert.deepEqual(out.properties.list,{type:'array',items:{type:'string'}});
  assert.equal(src.properties.n.maximum,5,'input not mutated');
});
test('a Hold after a thinking block is decided, with Anthropic usage, vendor and size',async()=>{
  const t=transport(claudeReply());const r=await client(t).decide(CTX,OPTS);
  assert.equal(r.decision.action,'Hold');assert.equal(r.provider,'openai','design T2: safety code branches on provider');assert.equal(r.vendor,'anthropic');assert.equal(r.model,'claude-opus-5-5');
  assert.deepEqual(r.usage,{inputTokens:13200,outputTokens:400,cachedTokens:9000,cacheWriteTokens:3000,reasoningTokens:null,serviceTier:'standard'});
  assert.ok(r.responseChars>100);assert.equal(r.droppedThinking,0);assert.ok(!('toolCalls' in r));
  // Text split across blocks is joined; Korean text and ₩ pass through.
  const k=await client(transport(claudeReply({content:[thinking,text('{"action":"Hold","symbol":"",'),text('"quantity":0,"explanation":"기아 보유 유지, ₩95,800."}')]}))).decide(CTX,OPTS);assert.equal(k.decision.explanation,'기아 보유 유지, ₩95,800.');
});
test('a tool round returns the calls and a continuation that replays the turn byte for byte, all results in one message',async()=>{
  const blocks=[thinking,text('Checking two things.'),toolUse('toolu_1'),toolUse('toolu_2','get_market_evidence',{symbol:'005930',dataset:'company'}),toolUse('toolu_3','get_context_detail',{section:'holdings',part:'',from:0})];
  const t=transport(claudeReply({content:blocks,stop_reason:'tool_use'}),claudeReply());const c=client(t);
  const r=await c.decide(FULL,{...OPTS,research:true});
  assert.deepEqual(r.toolCalls.map(x=>[x.name,x.callId]),[['get_context_detail','toolu_1'],['get_market_evidence','toolu_2'],['get_context_detail','toolu_3']]);assert.deepEqual(r.toolCalls[1].args,{symbol:'005930',dataset:'company'});
  const turns=r.continuation.filter(i=>i.type==='anthropic_turn');assert.equal(turns.length,1);assert.deepEqual(turns[0].content,blocks);
  assert.deepEqual(r.continuation.filter(i=>i.type==='function_call').map(i=>[i.call_id,i.name,JSON.parse(i.arguments),i.vendor]),[['toolu_1','get_context_detail',blocks[2].input,'anthropic'],['toolu_2','get_market_evidence',blocks[3].input,'anthropic'],['toolu_3','get_context_detail',blocks[4].input,'anthropic']]);
  // The loop appends the results (in call order); the next request rebuilds the messages.
  const next=[...r.continuation,...['toolu_1','toolu_2','toolu_3'].map((id,i)=>({type:'function_call_output',call_id:id,output:JSON.stringify({n:i})}))];
  await c.decide(FULL,{...OPTS,research:true,continuation:next});const m=t.sent[1].body.messages;
  assert.equal(m.length,3);assert.deepEqual(m[0],{role:'user',content:JSON.stringify(FULL)});assert.deepEqual(m[1],{role:'assistant',content:blocks});
  assert.equal(JSON.stringify(m[1].content),JSON.stringify(blocks),'assistant blocks byte-identical');
  assert.deepEqual(m[2],{role:'user',content:['toolu_1','toolu_2','toolu_3'].map((id,i)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify({n:i})}))});
  assert.deepEqual(t.sent[1].body.cache_control,{type:'ephemeral'},'a research round caches the conversation so far');
  // A plan-correction message after a final turn stays a separate user message.
  const corr=[...next,{type:'anthropic_turn',content:[thinking,text(JSON.stringify(hold))]},{role:'user',content:'Add the missing plan field.'}];
  await c.decide(FULL,{...OPTS,research:true,continuation:corr}).catch(()=>{});const m2=t.sent.at(-1).body.messages;assert.deepEqual(m2.slice(-2),[{role:'assistant',content:[thinking,text(JSON.stringify(hold))]},{role:'user',content:'Add the missing plan field.'}]);
});
test('through the research loop: five calls, four run, the fifth answered as not run, all five results in one message',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');
  const five=Array.from({length:5},(_,i)=>toolUse('toolu_'+i));const t=transport(claudeReply({content:[thinking,...five],stop_reason:'tool_use'}),claudeReply());const c=client(t);
  const done=await researchReview({context:FULL,evidence:{get:async()=>({})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),request:opts=>c.decide(FULL,{...OPTS,...opts})});
  assert.equal(done.decision.action,'Hold');const last=t.sent[1].body.messages.at(-1);assert.equal(last.role,'user');assert.equal(last.content.length,5);
  assert.deepEqual(last.content.map(b=>b.tool_use_id),five.map(b=>b.id),'every tool_use has its result, in order');assert.equal(JSON.parse(last.content[4].content).status,'not_run');
});
test('protocol refusals name their rule; no order path is reached',async()=>{
  const ask=(calls,opts)=>client(transport(claudeReply({content:[thinking,...calls],stop_reason:'tool_use'}))).decide(FULL,{...OPTS,...opts});
  for(const [calls,opts,rule] of [[[toolUse('a')],{research:true,final:true},/final round/],[[toolUse('a')],{},/without research/],[[toolUse('a','place_order',{})],{research:true},/not offered/],[Array.from({length:13},(_,i)=>toolUse('t'+i)),{research:true},/ceiling of 12/],[[toolUse('a','get_context_detail',{section:'x'.repeat(2100)})],{research:true},/malformed or oversized/],[[toolUse('x'.repeat(201))],{research:true},/malformed or oversized/]])
    await assert.rejects(ask(calls,opts),e=>e.message==='INVALID_AI_RESPONSE'&&rule.test(e.detail.rule)&&Number.isInteger(e.detail.toolCount)&&e.usage?.outputTokens===400);
});
test('stop reasons: max_tokens, refusal and pause_turn; not-JSON, oversized decision and oversized body',async()=>{
  await assert.rejects(client(transport(claudeReply({stop_reason:'max_tokens',content:[thinking]}))).decide(CTX,OPTS),e=>e.message==='AI_OUTPUT_LIMIT'&&e.usage.outputTokens===400);
  await assert.rejects(client(transport(claudeReply({stop_reason:'refusal',content:[],stop_details:{type:'refusal',category:'cyber',explanation:'private words'}}))).decide(CTX,OPTS),e=>{
    assert.equal(e.message,'AI_REFUSED');assert.equal(e.detail.rule,'a refusal (cyber)');assert.ok(!JSON.stringify(e.detail).includes('private'));
    const reply=errorReply('decision',e);assert.equal(reply.code,'AI_REFUSED');assert.match(E.detail(reply.code,'AI research and decision',Object.assign(new Error(reply.code),{detail:reply.detail})),/declined.*Rule: a refusal \(cyber\)\./);return true;});
  await assert.rejects(client(transport(claudeReply({stop_reason:'pause_turn',content:[thinking]}))).decide(CTX,OPTS),e=>e.message==='INVALID_AI_RESPONSE'&&/stopped with pause_turn/.test(e.detail.rule));
  await assert.rejects(client(transport(claudeReply({content:[text('not json')]}))).decide(CTX,OPTS),e=>/not valid JSON/.test(e.detail.rule)&&e.usage!=null);
  await assert.rejects(client(transport(claudeReply({content:[thinking]}))).decide(CTX,OPTS),e=>/no decision and no tool request/.test(e.detail.rule));
  await assert.rejects(client(transport(claudeReply({content:[text(JSON.stringify({...hold,explanation:'x'.repeat(60001)}))]}))).decide(CTX,OPTS),e=>/above the 60 KB limit/.test(e.detail.rule));
  await assert.rejects(client(transport(claudeReply({extra:{padding:'p'.repeat(C.RESPONSE_CHAR_LIMIT)}}))).decide(CTX,OPTS),e=>/above the 1,000 KB limit/.test(e.detail.rule)&&e.responseChars>C.RESPONSE_CHAR_LIMIT);
  // An invalid decision still goes through the unchanged validator.
  await assert.rejects(client(transport(claudeReply({content:[text(JSON.stringify({...hold,quantity:3}))]}))).decide(CTX,OPTS),e=>e.message==='INVALID_AI_RESPONSE'&&/Hold with a quantity/.test(e.detail.rule));
});
test('dropped thinking blocks are counted from input_transformations',async()=>{
  const r=await client(transport(claudeReply({input_transformations:[{type:'thinking_dropped',path:'messages.1.content.0',reason:'prefix_binding_mismatch'},{type:'thinking_dropped',path:'messages.3.content.0',reason:'prefix_binding_mismatch'},{type:'something_new'}]}))).decide(CTX,OPTS);
  assert.equal(r.droppedThinking,2);
});
test('error mapping: each status and type to the app code; the key and the provider message never appear',async()=>{
  const err=(status,type,message='details')=>({status,body:{type:'error',error:{type,message:`${message} ${KEY}`}}});
  const cases=[[err(401,'authentication_error'),'AI_AUTH_FAILED'],[err(403,'permission_error'),'AI_MODEL_UNAVAILABLE'],[err(404,'not_found_error'),'AI_MODEL_UNAVAILABLE'],[err(429,'rate_limit_error'),'AI_RATE_LIMITED'],
    [err(400,'invalid_request_error','Your credit balance is too low to access the Anthropic API.'),'AI_QUOTA_EXHAUSTED'],[err(403,'permission_error','Your credit balance is too low'),'AI_QUOTA_EXHAUSTED'],[err(402,'billing_error'),'AI_QUOTA_EXHAUSTED'],
    [err(400,'invalid_request_error','prompt is too long: 1200000 tokens > 1000000 maximum'),'AI_CONTEXT_LIMIT'],[err(413,'request_too_large'),'CONTEXT_TOO_LARGE'],[err(400,'invalid_request_error'),'AI_BAD_REQUEST'],
    [err(500,'api_error'),'AI_REQUEST_FAILED'],[err(529,'overloaded_error'),'AI_REQUEST_FAILED']];
  for(const [reply,code] of cases)await assert.rejects(client(transport(reply)).decide(CTX,OPTS),e=>{assert.equal(e.message,code,JSON.stringify(reply.status));const all=e.message+JSON.stringify(e)+String(e.stack);assert.ok(!all.includes(KEY),'no key');
    // Claude refused-request design: the provider text stays out of the code, detail and stack; only the separate local
    // providerError.message may hold it (a 4xx other than 401 and 429), with the key removed.
    assert.ok(!(e.message+JSON.stringify(e.detail??null)+String(e.stack)).includes('details'),'no provider text in the code, detail or stack');
    if(e.providerError?.message!==undefined)assert.ok(reply.status>=400&&reply.status<500&&![401,429].includes(reply.status),'a message only for a 4xx other than 401 and 429');return true;});
  await assert.rejects(client(async()=>{throw new TypeError('fetch failed '+KEY);}).decide(CTX,OPTS),e=>e.message==='AI_REQUEST_FAILED'&&!JSON.stringify(e).includes(KEY));
  // The SDK's timeout (shortened for the test) is AI_TIMEOUT.
  const slow=(url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
  await assert.rejects(client(slow,{timeoutMs:{decide:50}}).decide(CTX,OPTS),e=>e.message==='AI_TIMEOUT');
  // A 200 that is not JSON is a request failure, retried once by the review.
  await assert.rejects(client(transport({status:200,body:'<html>gateway</html>'})).decide(CTX,OPTS),e=>e.message==='AI_REQUEST_FAILED');
});
test('item lists never cross vendors: OpenAI items refused here, Claude turns refused by AiClient',async()=>{
  for(const item of [{type:'reasoning',id:'rs_1',summary:[]},{type:'message',content:[]},{type:'function_call',call_id:'c',name:'x',arguments:'{}'}]){
    const t=transport(claudeReply());await assert.rejects(client(t).decide(CTX,{...OPTS,continuation:[{role:'user',content:'x'},item]}),e=>e.message==='INVALID_AI_RESPONSE'&&e.detail.rule==='a conversation from another provider');assert.equal(t.sent.length,0,'nothing sent');}
  let sent=0;const openai=new C.AiClient('fixture_key_123',async()=>{sent++;return {ok:true,text:async()=>'{}'};});
  for(const item of [{type:'anthropic_turn',content:[]},{type:'function_call',call_id:'c',name:'x',arguments:'{}',vendor:'anthropic'}])
    await assert.rejects(openai.decide(CTX,{openaiModel:'gpt-6-sol',reasoningEffort:'low',continuation:[{role:'user',content:'x'},item]}),e=>e.message==='INVALID_AI_RESPONSE'&&e.detail.rule==='a conversation from another provider');
  assert.equal(sent,0);
  await assert.rejects(client(transport(claudeReply())).decide(CTX,{openaiModel:'gpt-6-sol',reasoningEffort:'low'}),/INVALID_MODEL_SETTINGS/,'the Claude client refuses a GPT model');
  await assert.rejects(client(transport(claudeReply())).decide(CTX,{...OPTS,continuation:[{role:'user',content:'x'},{type:'unknown'}]}),e=>/cannot send/.test(e.detail.rule));
});
test('size limits before sending, as on OpenAI',async()=>{
  const t=transport(claudeReply());await assert.rejects(client(t).decide({...CTX,big:'x'.repeat(80000)},OPTS),e=>e.message==='CONTEXT_OVER_BUDGET'&&e.detail.limitBytes===70000);assert.equal(t.sent.length,0);
  await assert.rejects(client(t).decide(CTX,{...OPTS,continuation:[{role:'user',content:'x'.repeat(150000)}]}),e=>e.message==='CONTINUATION_OVER_BUDGET');assert.equal(t.sent.length,0);
  assert.throws(()=>new A.AnthropicClient('bad key'),/INVALID_PROVIDER_FILE/);
});
test('the worker router: every call goes to the Claude client (B3); the key is not exposed',async()=>{
  const R=require('../electron/ai-router.cjs');const t=transport(claudeReply());const claude=R.claudeClient(KEY,t);
  assert.equal(claude.pending,false);assert.ok(!JSON.stringify(claude).includes(KEY));
  const r=await R.createRouter({anthropic:claude}).clientFor('claude-opus-5-5').decide(CTX,OPTS);assert.equal(r.decision.action,'Hold');assert.equal(t.sent.length,1);
  for(const op of ['scout','narrative','compact','reflect'])assert.equal(typeof claude[op],'function',op);assert.equal(claude.pending,false);
});

// A3b (review finding 1): nothing in the environment can move a Claude request, change its credential or add a header.
const HOSTILE={ANTHROPIC_BASE_URL:'https://example.invalid',ANTHROPIC_AUTH_TOKEN:'env-token-should-not-be-used',ANTHROPIC_API_KEY:'sk-env-key-should-not-be-used',ANTHROPIC_CUSTOM_HEADERS:'x-leak: yes\nauthorization: Bearer stolen\nanthropic-beta: server-side-fallback-2026-07-01',ANTHROPIC_LOG:'debug',ANTHROPIC_PROFILE:'other',ANTHROPIC_CONFIG_DIR:'C:/nowhere',ANTHROPIC_OPEN_TELEMETRY:'true',ANTHROPIC_WEBHOOK_SIGNING_KEY:'whsec_x'};
const withEnv=async(vars,fn)=>{const old=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));Object.assign(process.env,vars);try{return await fn();}finally{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}};
test('A3b: with hostile ANTHROPIC_* variables set, the address, the credential and the headers are unchanged and nothing is logged',async()=>{
  const logged=[];const saved={};for(const m of ['log','info','warn','error','debug']){saved[m]=console[m];console[m]=(...a)=>logged.push([m,a]);}
  let t;try{await withEnv(HOSTILE,async()=>{t=transport(claudeReply());const r=await client(t).decide(CTX,OPTS);assert.equal(r.decision.action,'Hold');});}finally{Object.assign(console,saved);}
  const {url,headers}=t.sent[0];assert.match(url,/^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/);
  assert.equal(headers.get('authorization'),'Bearer '+KEY);assert.equal(headers.get('anthropic-beta'),'thinking-binding-controls-2026-08-01');assert.equal(headers.get('x-leak'),null);assert.equal(headers.get('x-api-key'),null);
  for(const name of headers.keys())assert.ok(A.HEADER_ALLOWED(name),'only allowlisted headers: '+name);
  assert.deepEqual(logged,[],'ANTHROPIC_LOG=debug logs nothing (it would print the request body)');
  // The locked options themselves.
  assert.equal(A.LOCKED.baseURL,'https://api.anthropic.com');assert.equal(A.LOCKED.authToken,null);assert.equal(A.LOCKED.webhookKey,null);assert.equal(A.LOCKED.logLevel,'off');assert.deepEqual(A.LOCKED.openTelemetry,{propagation:false,traces:false});assert.ok(Object.isFrozen(A.LOCKED));
});
test('A3b: the fetch wrapper refuses any address but the Messages endpoint, before the transport, with a named rule',async()=>{
  for(const ok of ['https://api.anthropic.com/v1/messages','https://api.anthropic.com/v1/messages?beta=true'])assert.ok(A.ENDPOINT(ok),ok);
  for(const bad of ['https://example.invalid/v1/messages','http://api.anthropic.com/v1/messages','https://api.anthropic.com/v1/messages/batches','https://api.anthropic.com/v1/files','https://api.anthropic.com.evil.test/v1/messages','https://user:pw@api.anthropic.com/v1/messages','https://api.anthropic.com/v1/messages?beta=true&x=1','https://api.anthropic.com:8443/v1/messages','not a url',''])assert.ok(!A.ENDPOINT(bad),bad);
  // The SDK pointed elsewhere after construction (as a misread base URL would): refused, nothing reaches the transport.
  class Moved extends A.AnthropicClient{client(timeout,call){return super.client(timeout,call).withOptions({baseURL:'https://example.invalid'});}}
  const t=transport(claudeReply());await assert.rejects(new Moved(KEY,t).decide(CTX,OPTS),e=>e.message==='AI_REQUEST_FAILED'&&e.detail?.rule==='a request to an unexpected address');assert.equal(t.sent.length,0);
  const reply=errorReply('decision',await new Moved(KEY,t).decide(CTX,OPTS).catch(e=>e));assert.equal(reply.detail.rule,'a request to an unexpected address');
});
test('A3b: an API error keeps its request id and error type, and nothing else from the body; other 4xx are bad requests',async()=>{
  const failing=(status,type,requestId)=>async()=>new Response(JSON.stringify({type:'error',error:{type,message:'output_config.format.schema: private text '+KEY}}),{status,headers:{'content-type':'application/json',...(requestId?{'request-id':requestId}:{})}});
  const e=await client(failing(400,'invalid_request_error','req_011CTestABC')).decide(CTX,OPTS).catch(x=>x);
  assert.equal(e.message,'AI_BAD_REQUEST');assert.deepEqual(e.detail,{requestId:'req_011CTestABC',errorType:'invalid_request_error'});
  const reply=errorReply('decision',e);assert.deepEqual(reply.detail,{requestId:'req_011CTestABC',errorType:'invalid_request_error'});assert.ok(!JSON.stringify({code:reply.code,detail:reply.detail}).includes('private')&&!JSON.stringify(reply).includes(KEY));
  // Claude refused-request design: the provider message travels only as the separate local providerError, key removed.
  assert.equal(reply.providerError.message,'output_config.format.schema: private text [redacted]');
  assert.match(E.detail(reply.code,'AI research and decision',Object.assign(new Error(reply.code),{detail:reply.detail})),/rejected the request format.*Stage: AI research and decision\. Request: req_011CTestABC \(invalid_request_error\)\.$/);
  const bad=await client(failing(400,'invalid_request_error','req <script>')).decide(CTX,OPTS).catch(x=>x);assert.deepEqual(bad.detail,{errorType:'invalid_request_error'},'a malformed request id is dropped');
  assert.equal((await client(failing(422,'invalid_request_error')).decide(CTX,OPTS).catch(x=>x)).message,'AI_BAD_REQUEST');
  assert.equal((await client(failing(409,'conflict_error')).decide(CTX,OPTS).catch(x=>x)).message,'AI_BAD_REQUEST');
  assert.equal((await client(failing(503,'overloaded_error','req_x')).decide(CTX,OPTS).catch(x=>x)).message,'AI_REQUEST_FAILED','5xx still retried once');
  // An OpenAI size failure keeps its own detail shape (unchanged).
  assert.deepEqual(errorReply('decision',Object.assign(new Error('CONTEXT_OVER_BUDGET'),{detail:{limit:'app bytes',wireBytes:9,limitBytes:8,largest:[]}})).detail,{limit:'app bytes',wireBytes:9,limitBytes:8,largest:[]});
});
