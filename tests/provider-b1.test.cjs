'use strict';
// Release B, step B1 (artifacts/reviews/2026-11-12-engine-settings/b1-design.md and its review): data sharing and
// daily limits per AI provider, and the key Test. No network: every transport is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Automation,DEFAULTS}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const {AiClient}=require('../electron/ai-client.cjs');const {AnthropicClient}=require('../electron/anthropic-client.cjs');const R=require('../electron/ai-router.cjs');
const K=require('../electron/key-test.cjs');const {settle}=require('../electron/ai-accounting.cjs');
const src=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8').replace(/\r\n/g,'\n');
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
function automation(saved){const db=new DatabaseSync(':memory:');new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  if(saved)db.prepare('UPDATE automation_settings SET payload=? WHERE id=1').run(JSON.stringify(saved));
  const logs=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>logs.push([title,body]));return {a,db,logs};}
const old={...DEFAULTS};delete old.shareKisWithOpenAI;delete old.shareKisWithAnthropic;

test('upgrade: the one sharing switch becomes the OpenAI one; Anthropic starts off; the old key is ignored when sent',()=>{
  for(const [saved,openai] of [[true,true],[false,false]]){const {a,db}=automation({...old,shareKisWithAI:saved});
    assert.equal(a.config.shareKisWithOpenAI,openai);assert.equal(a.config.shareKisWithAnthropic,false);assert.equal(Object.hasOwn(a.config,'shareKisWithAI'),false);
    a.configure({});assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT payload FROM automation_settings WHERE id=1').get().payload),'shareKisWithAI'),false,'gone after the first save');
    const before=JSON.stringify(a.config);a.configure({shareKisWithAI:!saved});assert.equal(JSON.stringify(a.config),before,'a sent legacy value changes nothing');}
  assert.deepEqual([DEFAULTS.anthropicCallsPerDay,DEFAULTS.anthropicUSDPerDay,DEFAULTS.anthropicUnlimitedCalls,DEFAULTS.anthropicUnlimitedBudget],[10,1,false,false]);
  const {a}=automation();for(const bad of [{anthropicCallsPerDay:0},{anthropicCallsPerDay:201},{anthropicUSDPerDay:0},{anthropicUnlimitedCalls:'yes'},{shareKisWithAnthropic:1}])assert.throws(()=>a.configure(bad),/INVALID_SETTINGS/,JSON.stringify(bad));
});

test('gap: a Claude dry run under the OpenAI consent is refused (B1 review condition g)',async()=>{
  const {a}=automation();a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:false,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};
  await assert.rejects(a.dryRun('review',{model:{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}}),/DATA_SHARING_NOT_ENABLED/,'Anthropic would receive account data under the consent given for OpenAI');
  assert.equal(a.consentFor('claude-opus-5-5'),false);assert.equal(a.consentFor('gpt-6-sol'),true);
  assert.equal(a.consentMessage('claude-opus-5-5'),'Allow sharing KIS data with Anthropic in Connections.');
});

test('dry runs: paper still gives DRY_RUN_NEEDS_KIS; a KIS dry run on the trading model now needs the OpenAI consent (B1 review F3)',async()=>{
  const paper=automation().a;paper.configure({scope:'paper',provider:'openai',shareKisWithOpenAI:false});paper.providerStatus={aiConnected:true,openaiConnected:true};
  await assert.rejects(paper.dryRun('review'),/DRY_RUN_NEEDS_KIS/,'the paper scope is refused before the consent check, as before B1');
  const kis=automation().a;kis.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:false,openaiModel:'gpt-6-sol',reasoningEffort:'low'});kis.providerStatus={aiConnected:true,openaiConnected:true};
  await assert.rejects(kis.dryRun('review'),/DATA_SHARING_NOT_ENABLED/,'before B1 this ran without the switch (the old check needed an override): account data went to OpenAI with sharing off');
  await assert.rejects(kis.dryRun('inputs'),/DATA_SHARING_NOT_ENABLED/,'inputs only: refused by the consent check in the context assembly, as before B1');
});

test('each consent check asks the provider of the model it is about to use',()=>{
  const s=src('electron/automation.cjs');
  for(const line of ["if(this.config.scope!=='paper'&&this.config.provider==='openai'&&!this.consentFor(this.config.openaiModel))return {label:'Data sharing required',detail:this.consentMessage(this.config.openaiModel)};",
    "if(mode==='review'&&!this.consentFor((override??this.agentModel('trading')).openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');",
    "if(this.config.provider==='openai'&&!this.consentFor(this.agentModel('trading').openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');",
    "if(!this.consentFor(this.agentModel('scout').openaiModel))return",
    "shareKisAllowed:this.consentFor(this.agentModel('reflection').openaiModel)"])assert.ok(s.includes(line),line);
  assert.ok(src('electron/reflection.cjs').includes('config.shareKisAllowed===true'));assert.ok(src('electron/auto-launch.cjs').includes('a.consentFor(a.config.openaiModel)'));
  for(const f of ['electron/reflection.cjs','electron/auto-launch.cjs','src/EngineSettings.tsx','src/ProviderCards.tsx','src/RuntimeSettings.tsx','src/Connections.tsx'])assert.ok(!src(f).includes('shareKisWithAI'),f);
  const {a}=automation();a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:false});a.providerStatus={aiConnected:true,openaiConnected:true};
  assert.deepEqual(a.launchState?undefined:undefined,undefined);assert.match(a.scoutAvailable()??'',/Allow sharing KIS data with OpenAI/);
});

test('budget: per provider; OpenAI keeps today\'s keys; a call counts for its own provider and the total',()=>{
  const {a,db}=automation();a.configure({maxCallsPerDay:3,anthropicCallsPerDay:2});const day=today();const rec=m=>JSON.stringify({model:m,reservedMicro:1000,status:'pending'});
  for(let i=0;i<3;i++)a.reserveCall({openaiModel:'gpt-6-sol'},1000,'o'+i,day,rec('gpt-6-sol'));
  assert.throws(()=>a.reserveCall({openaiModel:'gpt-6-sol'},1000,'o3',day,rec('gpt-6-sol')),/AI_BUDGET_EXHAUSTED/,'OpenAI at its limit');
  a.reserveCall({openaiModel:'claude-opus-5-5'},1000,'c0',day,rec('claude-opus-5-5'));a.reserveCall({openaiModel:'claude-opus-5-5'},1000,'c1',day,rec('claude-opus-5-5'));
  assert.throws(()=>a.reserveCall({openaiModel:'claude-opus-5-5'},1000,'c2',day,rec('claude-opus-5-5')),/AI_BUDGET_EXHAUSTED/,'Anthropic at its own limit');
  assert.deepEqual(a.usageByVendor(day),{openai:{calls:3,reservedMicro:3000},anthropic:{calls:2,reservedMicro:2000}});
  assert.deepEqual({...db.prepare('SELECT calls,reservedMicro FROM ai_usage WHERE day=?').get(day)},{calls:5,reservedMicro:5000},'the total');
});

test('upgrade day (condition a): today\'s calls before B1 count as OpenAI\'s, also when Anthropic is used first',()=>{
  const {a,db}=automation();const day=today();db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run(day,7,700000);
  assert.deepEqual(a.vendorUsage('openai',day),{calls:7,reservedMicro:700000});assert.deepEqual(a.vendorUsage('anthropic',day),{calls:0,reservedMicro:0});
  a.reserveCall({openaiModel:'claude-opus-5-5'},1000,'c0',day,JSON.stringify({model:'claude-opus-5-5',reservedMicro:1000}));
  assert.deepEqual(a.usageByVendor(day),{openai:{calls:7,reservedMicro:700000},anthropic:{calls:1,reservedMicro:1000}},'the OpenAI row was seeded in the same write');
  a.configure({maxCallsPerDay:8});a.reserveCall({openaiModel:'gpt-6-sol'},1,'o0',day,'{}');assert.throws(()=>a.reserveCall({openaiModel:'gpt-6-sol'},1,'o1',day,'{}'),/AI_BUDGET_EXHAUSTED/,'the OpenAI limit counts the earlier calls');
});

test('a failure inside the reservation leaves both usage tables unchanged (condition e)',()=>{
  const {a,db}=automation();const day=today();a.reserveCall({openaiModel:'gpt-6-sol'},1000,'same-id',day,'{}');
  const snap=()=>JSON.stringify([db.prepare('SELECT * FROM ai_usage').all(),db.prepare('SELECT * FROM ai_usage_vendor').all(),db.prepare('SELECT COUNT(*) n FROM ai_calls').get()]);const before=snap();
  assert.throws(()=>a.reserveCall({openaiModel:'gpt-6-sol'},1000,'same-id',day,'{}'),/UNIQUE|constraint/i,'the call record fails (duplicate id) after both usage writes');
  assert.equal(snap(),before);
});

test('settling a call corrects its provider\'s row as it corrects the total',()=>{
  const {a,db}=automation();const day=today();a.reserveCall({openaiModel:'claude-opus-5-5'},50000,'c0',day,JSON.stringify({model:'claude-opus-5-5',reservedMicro:50000,status:'pending'}));
  settle(db,'ai_usage',day,'c0',{model:'claude-opus-5-5',usage:{inputTokens:1000,outputTokens:100}},'completed');
  const total=db.prepare('SELECT reservedMicro FROM ai_usage WHERE day=?').get(day).reservedMicro,mine=a.vendorUsage('anthropic',day).reservedMicro;assert.equal(mine,total);assert.ok(mine<50000);
});

test('the slowdown near the budget follows the trading model\'s provider (condition b)',()=>{
  const {a}=automation();a.configure({provider:'openai',degradeNearBudget:true,maxCallsPerDay:10,anthropicCallsPerDay:2});const day=today();
  for(let i=0;i<2;i++)a.reserveCall({openaiModel:'claude-opus-5-5'},1,'c'+i,day,'{}');assert.equal(a.slowFactor(),1,'Anthropic at its limit does not slow the OpenAI reviews');
  for(let i=0;i<8;i++)a.reserveCall({openaiModel:'gpt-6-sol'},1,'o'+i,day,'{}');assert.equal(a.slowFactor(),2,'OpenAI at 80%');
  const s=src('electron/automation.cjs');assert.equal((s.match(/this\.reserveCall\(/g)??[]).length,6,'the six call sites');assert.ok(!/budgetExceeded\(this\.config,usage/.test(s));
});

test('the key Test: one request, fixed answers, the key never in an answer or a log (condition d)',async()=>{
  const KEY='sk-fixture-key-123456';const seen=[];
  for(const [status,want] of [[200,'ok'],[401,'refused'],[403,'refused'],[429,'limited'],[500,'unreachable']]){
    const c=new AiClient(KEY,async(url,init)=>{seen.push(url);return new Response('{"error":{"message":"raw body with '+KEY+'"}}',{status});});const r=await c.testKey();assert.deepEqual(r,{result:want},String(status));
    const anth=new AnthropicClient(KEY,async(url,init)=>{seen.push(url);const h=new Headers(init.headers);assert.ok(!h.has('x-api-key'));assert.equal(h.get('authorization'),'Bearer '+KEY,'the documented form for API version 2026-10-21');assert.ok(!h.has('anthropic-beta'),'no beta header on the model list');return new Response('{"type":"error","error":{"message":"raw '+KEY+'"}}',{status,headers:{'content-type':'application/json'}});});
    assert.deepEqual(await anth.testKey(),{result:want},'Anthropic '+status);}
  assert.deepEqual(await new AiClient(KEY,async()=>{throw new Error('ECONNRESET '+KEY);}).testKey(),{result:'unreachable'});
  assert.deepEqual([...new Set(seen)],['https://api.openai.com/v1/models','https://api.anthropic.com/v1/models?limit=1'],'the model lists only');
  assert.equal(seen.length,10,'one request each');
  assert.deepEqual(await R.createRouter({}).testKey('anthropic'),{result:'missing'});
  for(const r of K.RESULTS)for(const v of ['openai','anthropic'])assert.ok(!K.text(v,r).includes(KEY));
  assert.equal(K.text('anthropic','unreachable'),'Could not reach Anthropic');assert.equal(K.text('openai','something else'),'Could not reach OpenAI');
  const m=src('electron/main.cjs');assert.equal((m.match(/'test-key'/g)??[]).length,1,'requested from one place');assert.ok(m.includes("ipcMain.handle('providers:test',"),'the user\'s click only');
  assert.ok(m.includes('return {vendor,result,text:K.text(vendor,result)};'),'the renderer gets the fixed text');
});

test('still refused after B1: a Claude model for any agent',()=>{
  const {a}=automation();a.configure({shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium'});
  // B3: the trading model stays refused until C2; the other agents are refused until a completed Claude dry run.
  for(const k of ['openaiModel','scoutModel','narrativeModel','reflectionModel','routineModel'])assert.throws(()=>a.configure({[k]:'claude-opus-5-5',...(k==='openaiModel'?{reasoningEffort:'medium'}:{})}),k==='openaiModel'?/CLAUDE_NOT_ENABLED_FOR_TRADING/:k==='routineModel'?/INVALID_MODEL_SETTINGS|CLAUDE_DRY_RUN_REQUIRED/:/CLAUDE_DRY_RUN_REQUIRED/,k);
});
