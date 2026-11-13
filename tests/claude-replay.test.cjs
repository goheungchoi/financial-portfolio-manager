'use strict';
// C1, replay on Claude (artifacts/reviews/2026-11-13-c1-replay/review.md, R1 to R8). Saved reviews are replayed with Claude
// Opus 5.5 as the change: the Claude answers run through the real AnthropicClient over a fake transport and the provider
// worker's error mapping; the OpenAI baseline is a fake. No network.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');
const {adapt}=require('./fixtures/claude-flat.cjs');// the enforced Claude decision form: nested fixture answers sent flat
require('./fixtures/order-book.cjs');
const A=require('../electron/anthropic-client.cjs');const ER=require('../electron/provider-error-reply.cjs');const R=require('../electron/replay.cjs');
const KEY='sk-ant-fixture-replay-key-0000';const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const HOLD={action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'No trade.'};
const ok=t=>({status:200,body:{id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},{type:'text',text:t}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:30000,output_tokens:2000,service_tier:'standard'},input_transformations:[]}});
const ANSWERS={accepted:ok(JSON.stringify({...HOLD,explanation:'**Hold.**\n- nothing changed'})),prose:ok('I would hold for now.'),refused:{status:400,body:{type:'error',error:{type:'invalid_request_error',message:'fixture refusal'},request_id:'req_fixture_1'}},overloaded:{status:503,body:{type:'error',error:{type:'overloaded_error',message:'busy'}}},grammar:{status:0}};
// As the provider worker and kis-service turn a client error into the error the engine sees.
const viaWorker=error=>{const r=ER.errorReply('decision',error);const e=new Error(r.code);Object.assign(e,{usage:r.usage,model:r.model,...(Number.isInteger(r.responseChars)?{responseChars:r.responseChars}:{}),...(r.detail?{detail:r.detail}:{}),...(r.requestSizes?{requestSizes:r.requestSizes}:{}),...(r.stopReason?{stopReason:r.stopReason}:{}),...(r.formFallback?{formFallback:true}:{}),...(r.answerForm?{answerForm:r.answerForm}:{})});const P=ER.providerError(r.providerError);if(P)e.providerError=P;return e;};
function world({answers=[],gate=true,key=true,share=true,limitUSD=20}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));
  const sent={openai:0,claude:0};const queue=[...answers];
  const provider={request:async(op,payload)=>{const claude=String(payload?.options?.openaiModel??'').startsWith('claude-');
    if(!claude){sent.openai++;return {decision:HOLD,usage:{inputTokens:10,outputTokens:2},provider:'openai'};}
    sent.claude++;const a=ANSWERS[queue.shift()??'accepted'];
    // "grammar": Anthropic refuses the enforced form and the client sends the same request once more as text.
    const answer=(url,init)=>{const b=JSON.parse(init.body);if(a===ANSWERS.grammar)return b.output_config?.format?{status:400,body:{type:'error',error:{type:'invalid_request_error',message:'The compiled grammar is too large, which would cause performance issues.'}}}:ANSWERS.accepted;return a.status===200?{status:200,body:adapt(a.body,b)}:a;};
    try{return await new A.AnthropicClient(KEY,async(url,init)=>{const r=answer(url,init);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json','request-id':'req_fixture_1'}});}).decide(payload.context,payload.options);}catch(error){throw viaWorker(error);}}};
  const events=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,(id,kind,title,body)=>events.push({id,kind,title,body}));
  a.live=live;a.providerStatus={...a.providerStatus,aiConnected:true,openaiConnected:true,anthropicConnected:key};a.evidence={get:async()=>({})};a.series={closes:()=>null,ensure:async()=>{}};a.indexCloses=()=>({});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:share,anthropicUSDPerDay:limitUSD,openaiModel:'gpt-6-sol',reasoningEffort:'low',guidelines:'Grow.'});
  if(gate)a.completedClaudeDryRun=()=>({id:'d',model:'claude-opus-5-5'});
  for(let i=0;i<3;i++){const id='rev-'+i;db.prepare('INSERT INTO reviews(id,payload) VALUES(?,?)').run(id,JSON.stringify({id,timestamp:Date.now()-i*3600000,provider:'openai',decision:HOLD}));a.replays.saveContext(id,{universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:100}],userGuidelines:'Grow.'});}
  const counts=()=>Object.fromEntries(['reviews','live_intents','review_watches','agent_notes','agent_triggers','conditional_orders','paper_orders'].map(t=>{try{return [t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n];}catch{return [t,null];}}));
  return {a,db,sent,events,counts};
}

test('R5: each refusal before any request, the OpenAI baseline included',async()=>{
  for(const [opts,model,code] of [[{gate:false},CLAUDE,/CLAUDE_DRY_RUN_REQUIRED/],[{key:false},CLAUDE,/AI_NOT_CONNECTED/],[{share:false},CLAUDE,/DATA_SHARING_NOT_ENABLED/],[{},{openaiModel:'claude-opus-5-5',reasoningEffort:'high'},/INVALID_MODEL_SETTINGS/]]){
    const {a,sent}=world(opts);await assert.rejects(a.replay({model,limit:3}),code,JSON.stringify(opts));assert.throws(()=>a.replayEstimate({model,limit:3}),code);
    assert.deepEqual(sent,{openai:0,claude:0},'no request of any kind');}
  const {a}=world();assert.equal(a.replayEstimate({model:{openaiModel:'gpt-6-luna',reasoningEffort:'low'},limit:2}),null,'an OpenAI change has no Claude estimate');
});

test('R4: the estimate is labelled, Claude and OpenAI apart, with the cap and the reservation per Claude request',()=>{
  const {a}=world();const e=a.replayEstimate({model:CLAUDE,limit:3,capUSD:2});
  assert.equal(e.basis,'Estimate from one measured Claude run (2026-11-13)');assert.equal(e.reviews,3);assert.equal(e.capUSD,2);
  assert.ok(e.claudeUSD>0&&e.openaiUSD>0&&Math.abs(e.totalUSD-(e.claudeUSD+e.openaiUSD))<1e-6);assert.ok(e.reservedPerClaudeUSD>0.5,'the cap reservation per Claude request');
  assert.equal(a.replayEstimate({model:CLAUDE,limit:3}).capUSD,3,'default cap $3.00');
});

test('R1, R2, R6, R8: a not-accepted answer and a refusal fail their rows; the run continues; the summary gives counts from the replayed answers, without research rounds',async()=>{
  const {a,sent,events,counts}=world({answers:['accepted','prose','refused']});const before=counts();
  const run=await a.replay({model:CLAUDE,limit:3});
  assert.deepEqual(sent,{openai:3,claude:3});assert.equal(run.rows.length,3);
  const [r1,r2,r3]=run.rows;assert.equal(r1.variant.decision.action,'Hold');assert.equal(r1.variant.failure,undefined);
  assert.deepEqual([r2.variant.failure.kind,r2.variant.failure.rule,r2.variant.failure.stopReason],['not-accepted','a decision that is not valid JSON','end_turn']);
  assert.equal(r3.variant.failure.kind,'refused');assert.equal(r3.variant.failure.providerError.status,400);assert.equal(r3.variant.usage.costMicro,0,'a refusal costs nothing');
  const c=run.summary.claude;assert.deepEqual({received:c.answers.received,accepted:c.answers.accepted,notAccepted:c.answers.notAccepted,refused:c.answers.refused},{received:2,accepted:1,notAccepted:1,refused:1});
  assert.equal(c.basis,'From 2 replayed answers, without research rounds');assert.equal(c.formatFailures,'1 of 2');assert.deepEqual(c.answers.byRule,{'a decision that is not valid JSON':1});
  assert.equal(c.comparison,'Too few to compare');assert.equal(c.markdown,'1 of 1','the accepted explanation used Markdown');
  assert.ok(c.measured.claudeUSD>0);assert.ok(c.estimate.claudeUSD>0);assert.ok(!/%/.test(JSON.stringify({b:c.basis,f:c.formatFailures,m:c.markdown})),'counts, never a bare percentage');
  assert.deepEqual(counts(),before,'a replay writes no review, order, watch or note');
  const line=events.find(e=>e.title==='Replay finished');assert.ok(line&&!line.body.includes('not valid JSON')&&!line.body.includes('fixture refusal'),'the log line carries counts, not the rule or the message');
});

test('R6: a timeout or 5xx on Claude fails its row as uncertain, keeps its reservation, and the run continues',async()=>{
  const {a,db}=world({answers:['overloaded','accepted']});const run=await a.replay({model:CLAUDE,limit:2});
  assert.equal(run.rows[0].variant.failure.kind,'uncertain');assert.equal(run.rows[1].variant.decision.action,'Hold');
  const replayCalls=db.prepare('SELECT payload FROM ai_calls').all().map(r=>JSON.parse(r.payload)).filter(c=>c.kind==='replay'&&c.model==='claude-opus-5-5');
  const failed=replayCalls.find(c=>c.status==='failed-or-uncertain');assert.ok(failed);assert.equal(failed.accountedMicro,failed.reservedMicro,'the reservation is kept');
});

test('R3: the cap stops before a request that would pass it (measured so far plus the estimate); completed rows stay; the Anthropic limit stops a Claude request too',async()=>{
  {const {a,sent}=world();const run=await a.replay({model:CLAUDE,limit:3,capUSD:0.01});assert.deepEqual(sent,{openai:0,claude:0});assert.equal(run.rows.length,0);assert.deepEqual(run.summary.claude.stopped,{reason:'cap',left:3});}
  {const {a,sent}=world();const capUSD=(R.estimateMicro('gpt-6-sol',200)+20000)/1e6;const run=await a.replay({model:CLAUDE,limit:3,capUSD});
    assert.deepEqual(sent,{openai:1,claude:0},'the baseline fits, the Claude request would pass the cap');assert.equal(run.rows.length,1);assert.equal(run.rows[0].variant.failure.kind,'stopped');assert.deepEqual(run.summary.claude.stopped,{reason:'cap',left:2});}
  {const {a,sent}=world({limitUSD:0.5});const run=await a.replay({model:CLAUDE,limit:3});
    assert.deepEqual(sent,{openai:1,claude:0},'the reservation does not fit under the Anthropic limit');assert.equal(run.rows[0].variant.failure.kind,'limit');assert.deepEqual(run.summary.claude.stopped,{reason:'limit',left:2});}
});

test('R7: an OpenAI change replays as before; trading on Claude stays refused',async()=>{
  const {a,sent}=world();const run=await a.replay({model:{openaiModel:'gpt-6-luna',reasoningEffort:'low'},limit:2});
  assert.deepEqual(sent,{openai:4,claude:0});assert.equal(run.summary.claude,undefined);assert.equal(run.rows[0].variant.failure,undefined);
  assert.throws(()=>a.configure({openaiModel:'claude-opus-5-5'}),/CLAUDE_NOT_ENABLED_FOR_TRADING/);
});

test('the panel: a Claude replay is confirmed with its estimate and cap; failed rows say why; the summary says it cannot rank the models',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ReplayPanel.tsx'),'utf8');
  for(const s of ["['claude-opus-5-5/medium','Claude Opus 5.5 · medium']",'aria-label="Replay confirmation"','The saved account data of these reviews goes to Anthropic. Nothing is traded.','The replay stops before a request that would take its measured spending past',
    'of room under your Anthropic daily limit while it runs','Answers not accepted: <b>{c.formatFailures}</b>','With this few reviews the results do not show which model is better.','{c.comparison}'])assert.ok(src.includes(s),s);
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.ok(main.includes("ipcMain.handle('replay:estimate'"));
});

test('C1 with the enforced form: the summary counts answers in the enforced form and those sent as text after a refusal',async()=>{
  const {a}=world({answers:['accepted','grammar','prose']});const run=await a.replay({model:CLAUDE,limit:3});
  assert.deepEqual(run.rows.map(r=>r.variant.usage?.answerForm??null),['enforced','text','enforced']);assert.equal(run.rows[1].variant.usage.formFallback,true);assert.equal(run.rows[1].variant.decision.action,'Hold');
  assert.deepEqual(run.summary.claude.form,{enforced:'2 of 3',fellBack:1,textPartsDropped:{}});
});
