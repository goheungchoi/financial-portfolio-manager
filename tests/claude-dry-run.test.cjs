'use strict';
// Release B, step B2 (artifacts/reviews/2026-11-12-engine-settings/b2-design.md and its review): the measured Claude
// dry run. max_tokens 32,000 and a 300 s decision timeout; the stop reason, request sizes and service tier recorded per
// request; the measurement block on every dry run; the reservation figures; completedClaudeDryRun, the gate for B3 and
// C. No network: every transport is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const A=require('../electron/anthropic-client.cjs');const M=require('../electron/ai-models.cjs');const R=require('../electron/ai-router.cjs');
const {Automation,dryRunMeasurement}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {settle}=require('../electron/ai-accounting.cjs');
const KEY='sk-ant-fixture-key-0000';const OPTS={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};const CTX={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:217000}]};
const reply=(extra={})=>({id:'msg_fixture',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},{type:'text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,explanation:'No trade.'})}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:1200,cache_read_input_tokens:9000,cache_creation_input_tokens:3000,output_tokens:400,service_tier:'standard'},input_transformations:[],...extra});
const transport=r=>{const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));return new Response(JSON.stringify(r),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;};

test('max_tokens 32,000 for a Claude decision, the reservation follows it, and a 300 s decision timeout',async()=>{
  const t=transport(reply());await new A.AnthropicClient(KEY,t).decide(CTX,OPTS);
  assert.equal(t.sent[0].max_tokens,32000);assert.equal(t.sent[0].service_tier,'standard_only');assert.equal(t.sent[0].fallbacks,undefined,'no fallbacks: a refusal stays visible');
  assert.equal(M.settings(OPTS).maxOutput,32000);
  assert.equal(M.reservationAt(OPTS,59277),1148530,'about $1.15 at today\'s first-request size');assert.equal(M.reservationAt(OPTS,70000),1200000);assert.equal(M.reservationAt(OPTS,140000),1536000);
  assert.equal(R.CLAUDE_TIMEOUT_MS.decide,300000);assert.equal(R.workerCapMs('decision',{options:OPTS}),315000);
});

test('each Claude reply carries its stop reason and request sizes; a stop at max_tokens or a refusal keeps them on the failure',async()=>{
  const ok=await new A.AnthropicClient(KEY,transport(reply())).decide(CTX,OPTS);
  assert.equal(ok.stopReason,'end_turn');assert.ok(ok.requestSizes.totalBytes>0&&ok.requestSizes.inputBytes>0&&ok.requestSizes.instructionsBytes>0);
  assert.equal(ok.usage.serviceTier,'standard');assert.equal(ok.usage.cachedTokens,9000);assert.equal(ok.usage.cacheWriteTokens,3000);
  await assert.rejects(new A.AnthropicClient(KEY,transport(reply({stop_reason:'max_tokens'}))).decide(CTX,OPTS),e=>e.message==='AI_OUTPUT_LIMIT'&&e.stopReason==='max_tokens'&&e.requestSizes.totalBytes>0);
  await assert.rejects(new A.AnthropicClient(KEY,transport(reply({stop_reason:'refusal',stop_details:{category:'cyber'}}))).decide(CTX,OPTS),e=>e.message==='AI_REFUSED'&&e.stopReason==='refusal'&&/cyber/.test(e.detail.rule));
});

function world(){const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[],()=>[]),{request:async()=>({})},()=>{});a.configure({scope:'paper'});return {a,db};}
const call=(db,id,reviewId,p)=>db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'2026-11-12',JSON.stringify({reviewId,reservedMicro:1148530,timestamp:1,...p}));

test('settle keeps the stop reason, request sizes and dropped thinking on the call record; the measurement reads them',()=>{
  const {db}=world();db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run('2026-11-12',1,1148530);
  call(db,'c1','dry1',{model:'claude-opus-5-5',status:'pending',kind:'dry-run'});
  settle(db,'ai_usage','2026-11-12','c1',{model:'claude-opus-5-5',usage:{inputTokens:13200,outputTokens:400,cachedTokens:9000,cacheWriteTokens:3000,serviceTier:'standard'},stopReason:'tool_use',requestSizes:{totalBytes:61000,inputBytes:58000,instructionsBytes:2000,toolsBytes:1000,'bad key':5},droppedThinking:1,responseChars:900},'completed');
  call(db,'c2','dry1',{model:'gpt-6-luna',status:'completed',kind:'compact',accountedMicro:2000,usage:{inputTokens:500,outputTokens:50,cachedTokens:0}});
  const rec=JSON.parse(db.prepare("SELECT payload FROM ai_calls WHERE id='c1'").get().payload);
  assert.equal(rec.stopReason,'tool_use');assert.deepEqual(rec.requestSizes,{totalBytes:61000,inputBytes:58000,instructionsBytes:2000,toolsBytes:1000},'only well-formed size fields');assert.equal(rec.droppedThinking,1);
  const m=dryRunMeasurement(db,'dry1');
  assert.equal(m.requests.length,2);assert.deepEqual([m.requests[0].kind,m.requests[0].stopReason,m.requests[0].cacheReadTokens,m.requests[0].cacheWriteTokens,m.requests[0].serviceTier,m.requests[0].requestBytes,m.requests[0].droppedThinking],['dry-run','tool_use',9000,3000,'standard',61000,1]);
  assert.equal(m.requests[1].kind,'compact');assert.equal(m.totals.requests,2);assert.equal(m.totals.cacheReadTokens,9000);assert.ok(m.totals.costUSD>0);
  assert.deepEqual(dryRunMeasurement(db,'none'),{requests:[],totals:{requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,reservedUSD:0,costUSD:0}});
});

test('the reservation figures: the first request from the latest review size, up to four at the byte limits; blocked below the limit',()=>{
  const {a,db}=world();db.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)");
  const limits=open=>({maxUSDPerDay:open,unlimitedBudget:false});
  let r=a.claudeReservation('claude-opus-5-5',limits(1));assert.equal(r.firstRequestUSD,1.2);assert.equal(r.firstRequestBasis,'the first-request size limit');assert.equal(r.upToUSD,5.81);assert.equal(r.requestsUpTo,4);assert.equal(r.blocked,true,'$1.00 is below one request');
  db.prepare('INSERT INTO events(id,payload) VALUES(?,?)').run('e1',JSON.stringify({title:'Review size',body:JSON.stringify({wireBytes:59277})}));
  r=a.claudeReservation('claude-opus-5-5',limits(1));assert.equal(r.firstRequestUSD,1.15);assert.match(r.firstRequestBasis,/59,277 bytes/);
  assert.equal(a.claudeReservation('claude-opus-5-5',limits(1.2)).blocked,false);assert.equal(a.claudeReservation('claude-opus-5-5',{maxUSDPerDay:1,unlimitedBudget:true}).blocked,false);
  assert.equal(JSON.stringify(a.config.anthropicUSDPerDay),'1','never changed by the app');
});

// completedClaudeDryRun: one condition broken at a time.
function stored(db,id,{mode='review',model='claude-opus-5-5',failed,decision={action:'Hold'},calls=2,measurement={totals:{costUSD:0.31}},account={key:'paper',label:'Paper'},ts=Date.now(),callRows}={}){
  db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run(id,ts,JSON.stringify({id,timestamp:ts,mode,summary:{account},...(mode==='review'?{review:{model,...(failed?{failed}:{}),...(decision?{decision}:{}),calls,costUSD:0.3,...(measurement?{measurement}:{})}}:{})}));
  for(const [i,c] of (callRows??[{status:'completed',usage:{inputTokens:1},accountedMicro:150000},{status:'completed',usage:{inputTokens:1},accountedMicro:160000}]).entries())call(db,`${id}-${i}`,id,{model:model,...c});
}
test('completedClaudeDryRun: a complete run counts; each broken condition does not; the latest valid one is returned',()=>{
  const cases=[
    ['complete',{},true],['inputs only',{mode:'inputs'},false],['a GPT model',{model:'gpt-6-sol'},false],['failed',{failed:'AI_OUTPUT_LIMIT'},false],
    ['no decision',{decision:null},false],['no calls',{calls:0},false],['no measurement (made before B2)',{measurement:null},false],
    ['another account',{account:{key:'other-account',label:'KIS live'}},false],['no account',{account:null},false],
    ['a call not completed',{callRows:[{status:'completed',usage:{inputTokens:1},accountedMicro:1},{status:'failed-or-uncertain',usage:null,accountedMicro:1148530}]},false],
    ['a call without usage',{callRows:[{status:'completed',usage:null,accountedMicro:1}]},false],
    ['a call without a settled cost',{callRows:[{status:'completed',usage:{inputTokens:1}}]},false],
    ['no Claude call recorded',{callRows:[]},false]];
  for(const [name,opts,want] of cases){const {a,db}=world();stored(db,'d1',opts);const r=a.completedClaudeDryRun();assert.equal(Boolean(r),want,name);if(want){assert.equal(r.id,'d1');assert.equal(r.costUSD,0.31);assert.equal(r.calls,2);}}
  const {a,db}=world();stored(db,'old',{ts:1000});stored(db,'newer-failed',{ts:3000,failed:'AI_REFUSED'});stored(db,'new',{ts:2000});
  assert.equal(a.completedClaudeDryRun().id,'new','the latest complete one, skipping a later failed one');
  assert.equal(a.getState().claudeDryRun?.id,'new','on the state for the card');
});

test('the screens: the card line and the pre-run warning come from the engine figures; older records open without a measurement',()=>{
  const src=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  const cards=src('src/ProviderCards.tsx'),dash=src('src/Dashboard.tsx');
  assert.ok(cards.includes('One dry run of up to {r.requestsUpTo} requests can reserve up to ${r.upToUSD.toFixed(2)}'));assert.ok(cards.includes('so a dry run cannot start until you raise it'));
  assert.ok(dash.includes("disabled={busy||state?.busy||(dryModel==='claude-opus-5-5'&&Boolean(estimate.claude?.blocked))}"),'the run waits for the user to raise the limit');
  assert.ok(dash.includes('{dryRecord?.review?.measurement&&<Measurement m={dryRecord.review.measurement}/>}'),'shown only when the record has one');
  assert.ok(!/configureRuntime\(/.test(cards.split('const save=')[1]?.split('\n')[0].replace(/api\.configureRuntime\(patch\)/,'')??''),'the card saves only what the user changed');
});

test('the OpenAI client reports its status and request sizes too; settle adds exactly those two fields to its call record',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');
  const c=new AiClient('sk-fixture-key-123',async()=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:10,output_tokens:5},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok'})}]}]})));
  const r=await c.decide({universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:1}]},{openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  assert.equal(r.stopReason,'completed');assert.ok(r.requestSizes&&r.requestSizes.totalBytes>0);
  const {db}=world();db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run('2026-11-12',1,50000);call(db,'g1','rev',{model:'gpt-6-sol',status:'pending'});
  const before={...r};delete before.stopReason;delete before.requestSizes;
  settle(db,'ai_usage','2026-11-12','g1',before,'completed');const without=JSON.parse(db.prepare("SELECT payload FROM ai_calls WHERE id='g1'").get().payload);
  db.prepare('UPDATE ai_calls SET payload=? WHERE id=?').run(JSON.stringify({reviewId:'rev',reservedMicro:1148530,timestamp:1,model:'gpt-6-sol',status:'pending'}),'g1');db.prepare("UPDATE ai_usage SET reservedMicro=50000").run();
  settle(db,'ai_usage','2026-11-12','g1',r,'completed');const withFields=JSON.parse(db.prepare("SELECT payload FROM ai_calls WHERE id='g1'").get().payload);
  const added=Object.keys(withFields).filter(k=>!(k in without));assert.deepEqual(added.sort(),['requestSizes','stopReason']);
  for(const k of Object.keys(without))assert.deepEqual(withFields[k],without[k],k);
});
