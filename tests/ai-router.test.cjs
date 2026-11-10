// Anthropic provider, step A2: the provider file accepts an optional anthropicApiKey, the worker picks the AI client
// from each call's model id (ai-router.cjs), and the status flags say which vendors are connected. Until the Claude
// client exists (A3), a Claude call is refused before anything is sent.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const R=require('../electron/ai-router.cjs');const E=require('../electron/ai-errors.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');
const fake=name=>({name,decide:async()=>name,scout:async()=>name,narrative:async()=>name,compact:async()=>name,reflect:async()=>name});
const OPENAI_KEY='sk-proj-'+'a'.repeat(40),CLAUDE_KEY='sk-ant-api03-'+'b'.repeat(40);

test('the model id picks the client; no model means OpenAI; a vendor without a key is not connected',()=>{
  const both=R.createRouter({openai:fake('openai'),anthropic:fake('anthropic')});
  assert.equal(both.clientFor('gpt-6-sol').name,'openai');assert.equal(both.clientFor('gpt-6-sol-2026-10-01').name,'openai');assert.equal(both.clientFor(undefined).name,'openai','older callers without a model');assert.equal(both.clientFor(null).name,'openai');
  assert.equal(both.clientFor('claude-opus-5-5').name,'anthropic');
  for(const bad of ['claude-opus-5-5-20260101','claude-haiku-5-5','gpt-7',''])assert.throws(()=>both.clientFor(bad),/INVALID_MODEL_SETTINGS/,bad);
  const openaiOnly=R.createRouter({openai:fake('openai')});assert.throws(()=>openaiOnly.clientFor('claude-opus-5-5'),/AI_NOT_CONNECTED/);assert.equal(openaiOnly.clientFor('gpt-6-luna').name,'openai');
  const claudeOnly=R.createRouter({anthropic:fake('anthropic')});assert.throws(()=>claudeOnly.clientFor('gpt-6-sol'),/AI_NOT_CONNECTED/);assert.throws(()=>claudeOnly.clientFor(undefined),/AI_NOT_CONNECTED/);
  assert.throws(()=>R.createRouter().clientFor('gpt-6-sol'),/AI_NOT_CONNECTED/,'before any import');
});
test('status flags: aiConnected when either vendor is connected, plus one flag per vendor',()=>{
  assert.deepEqual(R.createRouter().flags(),{aiConnected:false,openaiConnected:false,anthropicConnected:false});
  assert.deepEqual(R.createRouter({openai:fake('o')}).flags(),{aiConnected:true,openaiConnected:true,anthropicConnected:false});
  assert.deepEqual(R.createRouter({anthropic:fake('a')}).flags(),{aiConnected:true,openaiConnected:false,anthropicConnected:true});
  assert.deepEqual(R.createRouter({openai:fake('o'),anthropic:fake('a')}).flags(),{aiConnected:true,openaiConnected:true,anthropicConnected:true});
});
test('the provider file: anthropicApiKey is accepted alone or beside the others; anything unknown or malformed rejects the whole file',()=>{
  const parse=v=>R.parseProviderFile(JSON.stringify(v));
  assert.deepEqual(parse({anthropicApiKey:CLAUDE_KEY}),{openaiApiKey:null,anthropicApiKey:CLAUDE_KEY,dartApiKey:null,pushURL:null,ecosApiKey:null,fredApiKey:null,secContactEmail:null});
  const all=parse({openaiApiKey:OPENAI_KEY,anthropicApiKey:CLAUDE_KEY,dartApiKey:'d'.repeat(40),pushWebhookURL:'https://example.test/hook',ecosApiKey:'E'.repeat(20),fredApiKey:'f'.repeat(32),secContactEmail:'someone@example.test'});
  assert.equal(all.openaiApiKey,OPENAI_KEY);assert.equal(all.anthropicApiKey,CLAUDE_KEY);assert.equal(all.pushURL,'https://example.test/hook');
  assert.equal(parse({openaiApiKey:'',anthropicApiKey:''}).openaiApiKey,null,'an empty key is no key, as before');assert.equal(parse({}).anthropicApiKey,null);
  for(const bad of [{anthropicApiKey:'short'},{anthropicApiKey:'has space '+'x'.repeat(20)},{anthropicApiKey:42},{anthropicApiKey:'x'.repeat(513)},{openaiApiKey:'bad key!'+'x'.repeat(10)},{claudeApiKey:CLAUDE_KEY},{openaiApiKey:OPENAI_KEY,extra:1},{pushWebhookURL:'http://example.test'},{dartApiKey:'short'},{secContactEmail:'nope'}])
    assert.throws(()=>parse(bad),/INVALID_PROVIDER_FILE|Invalid URL/,JSON.stringify(Object.keys(bad)));
  assert.throws(()=>R.parseProviderFile('not json'));assert.throws(()=>R.parseProviderFile('null'),/INVALID_PROVIDER_FILE/);
  assert.ok(R.FILE_KEYS.includes('anthropicApiKey'));
});
test('until A3 a Claude call is refused as an unavailable model with a named rule, before anything is sent',async()=>{
  const c=R.pendingClaudeClient();assert.equal(c.pending,true);assert.ok(!JSON.stringify(c).includes('sk-'),'it holds no key');
  for(const op of ['decide','scout','narrative','compact','reflect'])await assert.rejects(c[op]({},{openaiModel:'claude-opus-5-5'}),e=>e.message==='AI_MODEL_UNAVAILABLE'&&e.detail.rule==='Claude calls are not built yet',op);
  // Through the worker reply and the review log line.
  const err=await c.decide().catch(e=>e);const reply=errorReply('decision',err);assert.equal(reply.code,'AI_MODEL_UNAVAILABLE');assert.deepEqual(reply.detail,{rule:'Claude calls are not built yet'});
  assert.match(E.detail(reply.code,'AI research and decision',Object.assign(new Error(reply.code),{detail:reply.detail})),/unavailable.*Rule: Claude calls are not built yet\./);
});
test('a missing key reaches the review as AI_NOT_CONNECTED with a vendor-neutral message',()=>{
  assert.equal(errorReply('decision',new Error('AI_NOT_CONNECTED')).code,'AI_NOT_CONNECTED');assert.equal(errorReply('compact',new Error('AI_NOT_CONNECTED')).code,'AI_NOT_CONNECTED');
  assert.match(E.messages.AI_NOT_CONNECTED,/No API key is connected/);
  for(const [code,text] of Object.entries(E.messages))assert.doesNotMatch(text,/OpenAI/,code);
});
test('the worker routes all five AI calls through the router by the call\'s model and builds it from the parsed file',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../electron/provider-worker.cjs'),'utf8');
  for(const [op,method,arg] of [['decision','decide','context'],['reflection','reflect','context'],['scout','scout','context'],['narrative','narrative','context'],['compact','compact','payload']])
    assert.ok(src.includes(`data.operation==='${op}') {result=await router.clientFor(data.options?.openaiModel).${method}(data.${arg},data.options);}`),op);
  assert.ok(src.includes('R.parseProviderFile(text)'));assert.ok(src.includes('anthropic:value.anthropicApiKey?R.claudeClient(value.anthropicApiKey):null'));assert.ok(src.includes('result={...router.flags(),'));
  assert.doesNotMatch(src,/\bai\.(decide|reflect|scout|narrative|compact)\(/,'no call bypasses the router');
});
