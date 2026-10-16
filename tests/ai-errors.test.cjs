const test=require('node:test'),assert=require('node:assert/strict');
const {AiClient}=require('../electron/ai-client.cjs');
const {detail}=require('../electron/ai-errors.cjs');
test('API failures retain useful allowlisted causes without exposing response text',async()=>{
 for(const [status,code,expected] of [[401,'invalid_api_key','AI_AUTH_FAILED'],[404,'model_not_found','AI_MODEL_UNAVAILABLE'],[429,'insufficient_quota','AI_QUOTA_EXHAUSTED'],[429,'rate_limit_exceeded','AI_RATE_LIMITED'],[400,'invalid_request_error','AI_BAD_REQUEST'],[500,null,'AI_SERVER_ERROR']]){
 const client=new AiClient('fixture_private_key',async()=>new Response(JSON.stringify({error:{code,message:'fixture_private_key PRIVATE_ACCOUNT'}}),{status}));await assert.rejects(client.decide({universe:[]}),e=>e.message===expected&&!JSON.stringify(e).includes('PRIVATE_ACCOUNT'));
 }
});
test('incomplete outputs and refusals are distinguished from invalid decisions',async()=>{
 for(const [body,expected] of [[{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},'AI_OUTPUT_LIMIT'],[{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'private details'}]}]},'AI_REFUSED']]){const client=new AiClient('fixture_private_key',async()=>new Response(JSON.stringify(body)));await assert.rejects(client.decide({universe:[]}),e=>e.message===expected);}
});
test('unexpected errors expose only stage and source line',()=>{const e=new Error('secret text');e.stack='Error: secret text\n at fn (C:/private/account/electron/automation.cjs:42:7)';const value=detail('REVIEW_FAILED','Portfolio context',e);assert.match(value,/automation.cjs:42/);assert.ok(!value.includes('private')&&!value.includes('secret'));});
test('all supported models preserve complete reasoning and tool results between research requests',async()=>{
 const {researchReview}=require('../electron/research-review.cjs');
 for(const model of ['gpt-6-luna','gpt-6-sol','gpt-6-astra']){
 let calls=0;const context={universe:[{symbol:'005930'}]};const reasoning={type:'reasoning',id:'rs_fixture',summary:[],encrypted_content:'opaque_fixture'};
 const client=new AiClient('fixture_private_key',async(_url,options)=>{const body=JSON.parse(options.body);calls++;if(calls===1)return new Response(JSON.stringify({status:'completed',output:[reasoning,{type:'function_call',name:'get_market_evidence',call_id:'call_fixture',arguments:JSON.stringify({symbol:'005930',dataset:'company'})}]}));assert.deepEqual(body.input[1],reasoning);assert.equal(body.input[3].type,'function_call_output');return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,explanation:'No sufficient evidence.'})}]}]}));});
 const result=await researchReview({context,evidence:{get:async()=>({status:'unavailable'})},log:()=>{},request:opts=>client.decide(context,{...opts,openaiModel:model,reasoningEffort:'low'})});assert.equal(result.decision.action,'Hold');assert.equal(calls,2);
 }
});
