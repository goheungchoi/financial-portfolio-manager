'use strict';
// Audit item 16 (artifacts/reviews/2026-11-19-order-rule-audit): every agent call that sends KIS data checks the key
// and the sharing switch of the vendor of the model actually called. An agent on "same" follows the trading model; an
// agent with its own model follows its own vendor. Each agent is tested with the two vendors crossed. Before, context
// compacting checked only Claude's (an OpenAI compacting model under a Claude review was sent research results with
// OpenAI sharing off), and a replay checked neither the trading model's switch nor the key of an OpenAI variant.
// The market narrative sends no KIS data (headlines and market signals), so it checks the key only.
// Fake providers only: no network, no real call.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const GPT='gpt-6-sol',LUNA='gpt-6-luna',OPUS='claude-opus-5-5',HAIKU='claude-haiku-5-5';
function world({openai=true,anthropic=true,openaiKey=true,anthropicKey=true,...config}={}){const db=new DatabaseSync(':memory:');const ops=[];
  const provider={request:async(op,payload)=>{ops.push({op,model:payload?.options?.openaiModel??null});if(op==='compact')return {summaries:[],usage:{inputTokens:1,outputTokens:1},model:payload.options.openaiModel};throw new Error('NOT_IN_TEST');}};
  const a=new Automation(db,new PaperEngine(db,[],()=>[]),provider,()=>{});a.completedClaudeDryRun=()=>({id:'d',timestamp:1,model:OPUS,calls:2,costUSD:0.3,account:'Paper'});
  a.providerStatus={aiConnected:openaiKey||anthropicKey,openaiConnected:openaiKey,anthropicConnected:anthropicKey};
  a.configure({scope:'paper',provider:'openai',shareKisWithOpenAI:openai,shareKisWithAnthropic:anthropic,openaiModel:GPT,reasoningEffort:'medium',...config});return {a,db,ops};}

test('compacting: its own vendor\'s switch and key, whichever vendor (an OpenAI compacting model with OpenAI sharing off is refused)',async()=>{
  const off=world({routineModel:LUNA,routineEffort:'none',openai:false,anthropic:true});
  await assert.rejects(off.a.compactResearch('r',{items:['x']}),/DATA_SHARING_NOT_ENABLED/);assert.deepEqual(off.ops,[],'no request');
  const keyless=world({routineModel:LUNA,routineEffort:'none',openaiKey:false});await assert.rejects(keyless.a.compactResearch('r',{items:['x']}),/AI_NOT_CONNECTED/);assert.deepEqual(keyless.ops,[]);
  const claude=world({routineModel:HAIKU,routineEffort:'low',openai:true,anthropic:false});await assert.rejects(claude.a.compactResearch('r',{items:['x']}),/DATA_SHARING_NOT_ENABLED/);assert.deepEqual(claude.ops,[]);
  const ok=world({routineModel:LUNA,routineEffort:'none',openai:true,anthropic:false});await ok.a.compactResearch('r',{items:['x']});assert.deepEqual(ok.ops.map(o=>o.model),[LUNA],'OpenAI on, Anthropic off: the OpenAI call goes');});

test('the scout: on "same" the trading model\'s vendor; with its own model, its own vendor',()=>{
  assert.match(world({scope:'kis',openai:false,anthropic:true}).a.scoutAvailable(),/Allow sharing KIS data with OpenAI/,'"same": OpenAI trading model');
  assert.match(world({scope:'kis',scoutModel:OPUS,scoutEffort:'medium',openai:true,anthropic:false}).a.scoutAvailable(),/Allow sharing KIS data with Anthropic/);
  assert.doesNotMatch(world({scope:'kis',scoutModel:OPUS,scoutEffort:'medium',openai:false,anthropic:true}).a.scoutAvailable()??'',/sharing/,'its own vendor on, the trading vendor off: allowed');
  assert.match(world({scope:'kis',scoutModel:OPUS,scoutEffort:'medium',anthropicKey:false}).a.scoutAvailable(),/Anthropic key/);});

test('reflection: the switch passed to it is its own model\'s vendor\'s',()=>{
  const s=w=>w.a.consentFor(w.a.agentModel('reflection').openaiModel);
  assert.equal(s(world({openai:false,anthropic:true})),false,'"same": OpenAI');assert.equal(s(world({reflectionModel:OPUS,reflectionEffort:'medium',openai:false,anthropic:true})),true);
  assert.equal(s(world({reflectionModel:OPUS,reflectionEffort:'medium',openai:true,anthropic:false})),false);
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.ok(src.includes("shareKisAllowed:this.consentFor(this.agentModel('reflection').openaiModel)"),'what tick passes');});

test('the trading review and its replay: the trading model\'s vendor; a replay\'s other model: its own vendor\'s key and switch',()=>{
  assert.throws(()=>world({openai:false,anthropic:true}).a.replayPlan({}),/DATA_SHARING_NOT_ENABLED/,'the baseline: OpenAI trading model, OpenAI sharing off (before: not checked)');
  assert.throws(()=>world({openai:true,anthropic:false}).a.replayPlan({model:{openaiModel:OPUS,reasoningEffort:'medium'}}),/DATA_SHARING_NOT_ENABLED/,'a Claude variant');
  assert.throws(()=>world({openai:true,anthropic:true,openaiKey:false}).a.replayPlan({model:{openaiModel:LUNA,reasoningEffort:'none'}}),/AI_NOT_CONNECTED/,'an OpenAI variant without an OpenAI key (before: not checked)');
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');
  assert.ok(src.includes("if(require('./ai-models.cjs').decisionMaker(this.config)==='ai'&&!this.consentFor(this.agentModel('trading').openaiModel))throw new Error('DATA_SHARING_NOT_ENABLED');"),'the review itself');});

test('the market narrative sends no KIS data: the key of its own vendor only, no sharing switch',()=>{
  assert.equal(world({openai:false,anthropic:false}).a.narrativeAvailable(),null,'both switches off: still allowed');
  assert.equal(world({narrativeModel:OPUS,narrativeEffort:'medium',anthropicKey:false}).a.narrativeAvailable(),'Add an Anthropic key in Connections');});
