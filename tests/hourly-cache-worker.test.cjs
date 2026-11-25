// Hourly cache, stages B and C through the real provider worker (the planner's question: do the options reach
// AnthropicClient.decide untouched, and does the keep-alive operation reach the client): the worker is driven with a
// stand-in parentPort, and fetch is replaced, so no request leaves the process. This test fails if cacheHour is dropped
// on the way, or if the router does not expose keepAlive.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {adapt}=require('./fixtures/claude-flat.cjs');
const KEY='sk-ant-api03-'+'w'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const REVIEW={id:'m',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'s'},{type:'text',text:JSON.stringify(hold)}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:24800,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:24800},output_tokens:50},input_transformations:[]};
const PING={id:'p',type:'message',role:'assistant',model:'claude-opus-5-5',content:[],stop_reason:'max_tokens',stop_details:null,usage:{input_tokens:12,cache_read_input_tokens:24800,cache_creation_input_tokens:0,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0},output_tokens:1}};

test('the worker passes cacheHour to the client and carries the keep-alive to it',async()=>{
  const sent=[],replies=[];let handler=null;const answers=[REVIEW,PING];
  globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);sent.push({url:String(url),body});const r=answers.shift();
    return new Response(JSON.stringify(r===PING?r:adapt(r,body)),{status:200,headers:{'content-type':'application/json'}});};
  process.parentPort={on:(event,fn)=>{if(event==='message')handler=fn;},postMessage:m=>replies.push(m)};
  require('../electron/provider-worker.cjs');assert.ok(handler,'the worker listens');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fpm-worker-'));const file=path.join(dir,'provider.json');fs.writeFileSync(file,JSON.stringify({anthropicApiKey:KEY}));
  try{
    await handler({data:{id:1,operation:'import',path:file}});assert.equal(replies.at(-1).ok,true);
    await handler({data:{id:2,operation:'decision',context:{universe:[{symbol:'990001'}],quotes:[{symbol:'990001',price:10000}]},options:{...CLAUDE,cacheHour:true,keepPrefix:true}}});
    assert.equal(replies.at(-1).ok,true,JSON.stringify(replies.at(-1)).slice(0,300));assert.ok(sent[0].url.startsWith('https://api.anthropic.com/'));
    assert.match(JSON.stringify(sent[0].body.system),/"ttl":"1h"/,'cacheHour reached the client through the worker');
    await handler({data:{id:3,operation:'keep-alive',options:{openaiModel:'claude-opus-5-5'}}});
    const r=replies.at(-1);assert.equal(r.ok,true,JSON.stringify(r).slice(0,300));assert.deepEqual(r.snapshot.cache,{read:24800,write:0,write5m:0,write1h:0});
    assert.equal(sent.length,2);assert.equal(sent[1].body.max_tokens,1);assert.equal(JSON.stringify(sent[1].body.system),JSON.stringify(sent[0].body.system));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('review 6: a refused keep-alive crosses the worker with its HTTP status and error type, nothing else',()=>{
  const {errorReply}=require('../electron/provider-error-reply.cjs');
  const r=errorReply('keep-alive',Object.assign(new Error('KEEP_ALIVE_FAILED'),{detail:{status:400,type:'invalid_request_error',extra:'x'},usage:{inputTokens:1}}));
  assert.deepEqual(r.detail,{status:400,type:'invalid_request_error'});assert.equal(r.usage,null);
  assert.deepEqual(errorReply('keep-alive',Object.assign(new Error('x'),{detail:{status:400,type:'Bad Type!'}})).detail,{status:400,type:null},'a type outside the pattern is dropped');
});
