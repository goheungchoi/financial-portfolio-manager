// Anthropic provider, step A5: the dry-run model override, Claude timeouts and the worker cap, vendor-aware key checks,
// vendor on saved reviews, and the refusal message for a Claude trading model. Fake transports and the mock engine only.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs'),path=require('node:path');
const {AnthropicClient}=require('../electron/anthropic-client.cjs');const R=require('../electron/ai-router.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const reply=()=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'s'},{type:'text',text:JSON.stringify(hold)}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:50},input_transformations:[]});
function transport(){const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));return new Response(JSON.stringify(reply()),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
// Automation on the mock live engine with a provider that routes each call by its model, as the worker does.
function harness(status){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const t=transport();const claude=new AnthropicClient(KEY,t);const seen=[];
  const gpt={decision:{...hold,credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai',model:'gpt-6-sol'};
  const provider={request:async(op,payload)=>{seen.push([op,payload.options?.openaiModel]);if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');
    if(String(payload.options?.openaiModel).startsWith('claude-'))try{return await claude.decide(payload.context,payload.options);}catch(e){const r=errorReply('decision',e);throw Object.assign(new Error(r.code),{usage:r.usage,model:r.model,detail:r.detail});}
    return gpt;}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;Object.assign(a.providerStatus,status);a.evidence={get:async()=>({status:'ok'})};
  a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:false});
  return {a,db,t,seen};
}
const BOTH={aiConnected:true,openaiConnected:true,anthropicConnected:true},OPENAI={aiConnected:true,openaiConnected:true,anthropicConnected:false},ONLY_CLAUDE={aiConnected:true,openaiConnected:false,anthropicConnected:true};

test('A5: the key a model needs is its own vendor\'s; an older status without per-vendor flags counts as OpenAI',()=>{
  const {a}=harness({});const cases=[[BOTH,'gpt-6-sol',null],[BOTH,'claude-opus-5-5',null],[OPENAI,'claude-opus-5-5','Anthropic'],[ONLY_CLAUDE,'gpt-6-sol','OpenAI'],[ONLY_CLAUDE,'claude-opus-5-5',null],
    [{aiConnected:true},'gpt-6-sol',null],[{aiConnected:true},'claude-opus-5-5','Anthropic'],[{aiConnected:false},'gpt-6-sol','OpenAI'],[BOTH,'gpt-7','AI']];
  for(const [status,model,missing] of cases){a.providerStatus=status;assert.equal(a.missingKey(model),missing,JSON.stringify([status,model]));}
});
test('A5: a provider file with only an Anthropic key does not look ready for a GPT model: readiness, review and launch all say so',async()=>{
  const {a}=harness(ONLY_CLAUDE);a.configure({enabled:true});a.sessionArmed=true;
  const r=a.schedulerStatus();assert.equal(r.label,'API key required');assert.match(r.detail,/OpenAI key for the selected model/);
  await assert.rejects(a.review('User request'));assert.equal(a.lastError,'AI_NOT_CONNECTED');
  const launch=require('../electron/auto-launch.cjs');await assert.rejects(launch.start(a,launch.launchState(a).token),/Import your OpenAI key in Connections first/);
  // With the OpenAI key the same review runs.
  const ok=harness(BOTH);await ok.a.review('User request');assert.equal(ok.a.lastError,null);
  // No wording names OpenAI where any provider is meant.
  const src=fs.readFileSync(path.join(__dirname,'../electron/auto-launch.cjs'),'utf8');assert.doesNotMatch(src,/Choose OpenAI|Select OpenAI|sharing with OpenAI/);
});
test('A5: a dry-run review can run once on Claude Opus 5.5 while the saved settings stay on GPT; nothing but dry_runs and ai_calls is written',async()=>{
  const {a,db,t,seen}=harness(BOTH);const tables=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>[r.name,db.prepare(`SELECT COUNT(*) n FROM "${r.name}"`).get().n]));
  const before=tables();const record=await a.dryRun('review',{model:CLAUDE});
  assert.equal(record.review.model,'claude-opus-5-5');assert.equal(record.review.effort,'medium');assert.equal(record.review.decision.action,'Hold');assert.ok(t.sent.length>=1,'the Claude transport answered');
  assert.ok(seen.some(([op,m])=>op==='decision'&&m==='claude-opus-5-5'));assert.equal(a.config.openaiModel,'gpt-6-sol','saved settings unchanged');
  const after=tables();const changed=Object.keys(after).filter(k=>after[k]!==before[k]);
  assert.ok(changed.includes('dry_runs')&&changed.includes('ai_calls'),changed.join(','));
  for(const k of ['reviews','live_intents','conditional_orders','agent_notes','agent_triggers','paper_orders','paper_proposals','pending_decisions','review_watches'])assert.equal(after[k]??0,before[k]??0,k+' unchanged');
  assert.equal(a.live.orders().length,0,'no order');
  const call=db.prepare('SELECT payload FROM ai_calls').all().map(r=>JSON.parse(r.payload)).find(p=>p.kind==='dry-run');assert.equal(call.model,'claude-opus-5-5');assert.equal(call.vendor,'anthropic');assert.ok(call.cost.micro>0);
});
test('A5: the dry-run override is refused without its key, without the sharing switch, for inputs, or with an invalid model',async()=>{
  let h=harness(OPENAI);await assert.rejects(h.a.dryRun('review',{model:CLAUDE}),/AI_NOT_CONNECTED/);assert.equal(h.t.sent.length,0);
  h=harness(BOTH);h.a.configure({shareKisWithAI:false});await assert.rejects(h.a.dryRun('review',{model:CLAUDE}),/DATA_SHARING_NOT_ENABLED/);assert.equal(h.t.sent.length,0);
  h=harness(BOTH);await assert.rejects(h.a.dryRun('inputs',{model:CLAUDE}),/INVALID_REQUEST/);
  for(const model of [{openaiModel:'claude-opus-5-5',reasoningEffort:'none'},{openaiModel:'claude-opus-5-5-20260101',reasoningEffort:'medium'},{openaiModel:'gpt-7',reasoningEffort:'low'},'claude-opus-5-5'])await assert.rejects(harness(BOTH).a.dryRun('review',{model}),/INVALID_MODEL_SETTINGS|INVALID_REQUEST/,JSON.stringify(model));
  // Without an override the dry run is as before, on the saved model.
  h=harness(OPENAI);const r=await h.a.dryRun('review');assert.equal(r.review.model,'gpt-6-sol');
  // The IPC passes only the model; preload forwards the options.
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8');
  assert.ok(main.includes("automation.dryRun(mode,options&&typeof options==='object'?{model:options.model??null}:{})"));assert.ok(preload.includes("dryRun: (mode, options) => ipcRenderer.invoke('runtime:dry-run', mode, options)"));
});
test('A5: Claude calls get their own timeout, and the worker cap leaves room for it',()=>{
  assert.deepEqual({...R.CLAUDE_TIMEOUT_MS},{decide:150000,scout:150000,narrative:120000,compact:90000,reflect:120000});assert.ok(Object.isFrozen(R.CLAUDE_TIMEOUT_MS));
  assert.equal(R.workerCapMs('decision',{options:CLAUDE}),165000);assert.equal(R.workerCapMs('compact',{options:CLAUDE}),105000);assert.equal(R.workerCapMs('reflection',{options:CLAUDE}),135000);
  for(const [op,payload] of [['decision',{options:{openaiModel:'gpt-6-sol'}}],['decision',{}],['decision',{options:{openaiModel:'gpt-7'}}],['news',{options:CLAUDE}],['import',{}]])assert.equal(R.workerCapMs(op,payload),90000,op);
  assert.equal(require('../electron/anthropic-client.cjs').TIMEOUT_MS,R.CLAUDE_TIMEOUT_MS,'one table');
  const svc=fs.readFileSync(path.join(__dirname,'../electron/kis-service.cjs'),'utf8');assert.ok(svc.includes("this.workerScript==='provider-worker.cjs'?require('./ai-router.cjs').workerCapMs(operation,payload):90000"),'only the provider worker gets the AI cap');
});
test('A5: saved reviews carry their vendor; a Claude trading model is refused with words the user can act on',async()=>{
  const {a,db}=harness(BOTH);await a.review('User request');const row=JSON.parse(db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get().payload);assert.equal(row.vendor,'openai');assert.equal(row.provider,'openai');
  // A Claude decision (as the stage D go-live will route it) is recorded as anthropic.
  const h=harness(BOTH);h.a.config.openaiModel='claude-opus-5-5';h.a.config.reasoningEffort='medium';await h.a.review('User request');const row2=JSON.parse(h.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get().payload);assert.equal(row2.vendor,'anthropic');
  assert.throws(()=>harness(BOTH).a.configure({openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}),/CLAUDE_NOT_ENABLED_FOR_TRADING/);
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.ok(main.includes("error:error?.message==='CLAUDE_NOT_ENABLED_FOR_TRADING'?error.message:'INVALID_SETTINGS'"),'the code reaches the settings page');
  const ui=fs.readFileSync(path.join(__dirname,'../src/RuntimeSettings.tsx'),'utf8');assert.match(ui,/CLAUDE_NOT_ENABLED_FOR_TRADING:'Claude models run dry-run reviews only for now; trading on Claude is not enabled yet\.'/);
});
