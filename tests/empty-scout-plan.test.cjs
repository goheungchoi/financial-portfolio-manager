// The nearly empty scout plan of 2026-11-18 08:40 (artifacts/reviews/2026-11-18-empty-scout-plan, cause note cleared): a
// well-formed answer that says nothing (no summary or focus, or no target for a focused market you hold stocks in) is
// refused, asked for once more, and on a second refusal the run fails and the previous plan stays. Targets the check
// leaves out are logged with their reasons. A trading review sees scoutPlan.lastRunFailed after a failed automatic run.
// Fake providers only; no AI call, no broker.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const S=require('../electron/scout.cjs');
const full={summary:'Chips lead; hold the leaders.',cashTargetPct:20,focus:'Memory prices.',targets:[{symbol:'005930',name:'Samsung',role:'hold',targetWeightPct:10,thesis:'t',risks:''}],briefAnswers:[],retrospective:'',substitutions:[]};
const empty={summary:'',cashTargetPct:null,focus:'',targets:[],briefAnswers:[],retrospective:'',substitutions:[]};
const plan=v=>{const skipped=[];return {plan:S.validatePlan(v,skipped),answer:v,skippedTargets:skipped,usage:{inputTokens:10,outputTokens:5,cachedTokens:8}};};
test('planProblem: blank summary, blank focus, a focused market you hold stocks in with no target; exits only and an unheld market pass',()=>{
  assert.equal(S.planProblem(S.validatePlan(full),{focus:['KR'],heldMarkets:['KR']}),null);
  assert.equal(S.planProblem(S.validatePlan(empty),{focus:['KR'],heldMarkets:['KR','US']}),'no summary; no focus; no target for Korea, where you hold stocks','the 08:40 plan');
  assert.equal(S.planProblem({...full,targets:[{symbol:'NASD:NVDA',role:'hold'}]},{focus:['KR'],heldMarkets:['KR']}),'no target for Korea, where you hold stocks','a U.S. target does not cover Korea');
  assert.equal(S.planProblem({...full,targets:[{symbol:'005930',role:'exit'}]},{focus:['KR'],heldMarkets:['KR']}),null,'a plan that sells everything lists its exits');
  assert.equal(S.planProblem({...full,targets:[]},{focus:['KR'],heldMarkets:[]}),null,'no holdings in the focused market: no target is allowed');
  assert.equal(S.planProblem({...full,targets:[]},{focus:['US'],heldMarkets:['KR']}),null,'the held market is not in focus');
  assert.equal(S.planProblem({...full,summary:'  '},{}),'no summary');assert.equal(S.planProblem({...full,focus:''},{}),'no focus');});
test('validatePlan reports each target it leaves out, and the plan is unchanged',()=>{
  const skipped=[];const v={...full,targets:[{symbol:'BAD SYMBOL!',name:'x',role:'hold',targetWeightPct:1,thesis:'',risks:''},{symbol:'000660',name:'x',role:'buy-now',targetWeightPct:1,thesis:'',risks:''},
    {symbol:'005930',name:'x',role:'hold',targetWeightPct:150,thesis:'',risks:''},{symbol:'005930',name:'x',role:'hold',targetWeightPct:5,thesis:'',risks:''},{symbol:'005930',name:'x',role:'hold',targetWeightPct:5,thesis:'',risks:''}]};
  const p=S.validatePlan(v,skipped);assert.deepEqual(p,S.validatePlan(v),'the same plan with or without the report');assert.deepEqual(p.targets.map(t=>t.symbol),['005930']);
  assert.deepEqual(skipped.map(s=>s.reason),['not a symbol','unknown role','weight not a percent','listed twice']);
  assert.equal(S.skippedLine(skipped),'4 targets left out: 1 not a symbol, 1 unknown role, 1 weight not a percent, 1 listed twice (BAD SYMBOL!, 000660, 005930, 005930)');assert.equal(S.skippedLine([]),null);});
// A run of the shape of 08:40: one research round, then the final answer.
function fakeRun(answers){const calls=[];const logs=[];let i=0;
  const request=async({final,continuation})=>{calls.push({final,continuation});const a=answers[i++];if(a==='tools')return {toolCalls:[{name:'probe',callId:'c'+i,args:{}}],continuation:[...(continuation??[{role:'user',content:'{}'}]),{type:'function_call',call_id:'c'+i,name:'probe',arguments:'{}'}],usage:{inputTokens:10,outputTokens:5,cachedTokens:0}};return typeof a==='function'?a():a;};
  return {calls,logs,run:opts=>S.runScout({request,tools:{probe:async()=>({ok:true})},log:(k,t,b)=>logs.push([t,b]),check:p=>S.planProblem(p,{focus:['KR'],heldMarkets:['KR']}),...opts})};}
test('an empty final answer is refused, logged with what it said, and asked for once more with one appended sentence',async()=>{
  const f=fakeRun(['tools',plan(empty),plan(full)]);const r=await f.run();
  assert.equal(r.plan.summary,full.summary);assert.equal(r.retried,true);assert.equal(f.calls.length,3);
  const [,answer,retry]=f.calls;assert.equal(retry.final,true,'the retry is a final call: tools off');
  assert.deepEqual(retry.continuation.slice(0,-1),answer.continuation,'the history as the final call was sent, byte for byte');
  assert.deepEqual(retry.continuation.at(-1),{role:'user',content:'Your answer had no plan (no summary; no focus; no target for Korea, where you hold stocks). Write the full plan now from the research above; tools are off.'});
  const refused=f.logs.find(([t])=>t==='Scout answer refused');assert.ok(refused,'logged');assert.match(refused[1],/^no summary; no focus; no target for Korea, where you hold stocks\. Answer: \{"summary":"","cashTargetPct":null/);
  assert.deepEqual(r.usage,{inputTokens:30,outputTokens:15,cachedTokens:16},'the retry is counted');});
test('a second empty answer fails the run with SCOUT_EMPTY_PLAN; so does a retry with no plan; a first-call plan is not retried',async()=>{
  for(const second of [plan(empty),plan({...full,summary:''})]){const f=fakeRun(['tools',plan(empty),second]);const e=await f.run().catch(x=>x);
    assert.equal(e.message,'SCOUT_EMPTY_PLAN');assert.equal(f.calls.length,3,'one retry only');assert.equal(f.logs.filter(([t])=>t==='Scout answer refused').length,2);}
  const noPlan=fakeRun(['tools',plan(empty),{toolCalls:[],usage:{}}]);const e2=await noPlan.run().catch(x=>x);assert.equal(e2.message,'SCOUT_EMPTY_PLAN');assert.match(e2.detail,/the second answer had no plan/);
  const first=fakeRun([plan(empty)]);const e3=await first.run().catch(x=>x);assert.equal(e3.message,'SCOUT_EMPTY_PLAN');assert.equal(first.calls.length,1,'no history to retry with');
  const long=fakeRun(['tools',plan({...empty,targets:Array.from({length:3},(_,i)=>({symbol:'00010'+i,name:'n',role:'nope',targetWeightPct:1,thesis:'x'.repeat(3000),risks:''}))}),plan(full)]);await long.run();
  assert.ok(long.logs.find(([t])=>t==='Scout answer refused')[1].length<=4096+120,'the logged answer is bounded to 4 KB');
  assert.equal(long.logs.find(([t])=>t==='Scout targets left out')[1],'3 targets left out: 3 unknown role (000100, 000101, 000102)');});
test('a full answer goes through unchanged: no retry, nothing refused',async()=>{
  const f=fakeRun(['tools',plan(full)]);const r=await f.run();assert.equal(r.retried,undefined);assert.equal(f.calls.length,2);assert.deepEqual(f.logs.filter(([t])=>/refused|left out/.test(t)),[]);});
test('Claude: a user sentence after tool results joins that user turn, after the results; other turns are as before',()=>{
  const {toMessages}=require('../electron/anthropic-client.cjs');
  const base=[{role:'user',content:'{"a":1}'},{type:'anthropic_turn',content:[{type:'tool_use',id:'t1',name:'probe',input:{}}]},{type:'function_call',call_id:'t1',name:'probe',arguments:'{}',vendor:'anthropic'},{type:'function_call_output',call_id:'t1',output:'{"ok":true}'}];
  const before=toMessages(base),after=toMessages([...base,{role:'user',content:'Write the plan.'}]);
  assert.deepEqual(after.slice(0,-1),before.slice(0,-1),'earlier turns unchanged');assert.deepEqual(after.at(-1),{role:'user',content:[...before.at(-1).content,{type:'text',text:'Write the plan.'}]});
  assert.equal(after.length,before.length,'still alternating');
  const correction=toMessages([{role:'user',content:'{}'},{type:'anthropic_turn',content:[{type:'text',text:'{}'}]},{role:'user',content:'Fix it.'}]);assert.deepEqual(correction.at(-1),{role:'user',content:'Fix it.'},'a correction after an assistant turn is its own turn, as before');});
test('a failed run is recorded; the trading review sees lastRunFailed only while it is newer than the plan, and only for automatic runs',()=>{
  const db=new DatabaseSync(':memory:');const store=new S.ScoutStore(db);assert.equal(store.failedAfter('kis:a'),null,'no table yet: nothing');
  const saved=store.save('kis:a',S.validatePlan(full));const keys=Object.keys(S.reviewContext(saved,saved.timestamp+1000));
  assert.deepEqual(keys,['asOf','summary','cashTargetPct','focus','targets'],'the review\'s scoutPlan keys without a failure (pin)');
  store.noteFailure('kis:a',{at:saved.timestamp+60000,reason:'SCOUT_EMPTY_PLAN',trigger:'Scheduled'});const f=store.failedAfter('kis:a');assert.deepEqual(f,{at:saved.timestamp+60000,reason:'SCOUT_EMPTY_PLAN',trigger:'Scheduled'});
  const ctx=S.reviewContext(saved,saved.timestamp+120000,{failed:f});assert.deepEqual(Object.keys(ctx),['asOf','lastRunFailed','summary','cashTargetPct','focus','targets']);
  assert.deepEqual(ctx.lastRunFailed,{at:new Date(saved.timestamp+60000).toISOString(),reason:'SCOUT_EMPTY_PLAN'});
  assert.equal(S.reviewContext(saved,saved.timestamp+1000,{failed:{at:saved.timestamp-1,reason:'X'}}).lastRunFailed,undefined,'an older failure is not shown');
  const later=store.save('kis:a',S.validatePlan(full));later.timestamp=f.at+1;db.prepare('UPDATE scout_plans SET timestamp=?,payload=? WHERE id=?').run(later.timestamp,JSON.stringify(later),later.id);assert.equal(store.failedAfter('kis:a'),null,'a newer plan clears it');
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.ok(main.includes("failed:(()=>{const f=this.scoutStore.failedAfter(watchScope,latestPlan);return f&&f.trigger!=='User request'?f:null;})()"),'the review passes automatic failures only');
  assert.ok(main.includes("try{this.scoutStore.noteFailure(scope,{reason:this.scoutError,trigger});"),'every failed run is recorded (its screens are kept apart, S3)');});
test('through the app: an empty answer twice keeps the previous plan, records the failure, and the card state carries it',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:500000,holdings:[{symbol:'005930',name:'Samsung',quantity:5,averagePrice:100,price:100}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  let n=0;const provider={request:async(op,payload)=>{n++;if(n===1)return {plan:S.validatePlan(full),answer:full,skippedTargets:[],usage:{inputTokens:1,outputTokens:1}};
    if(!payload.options.continuation)return {toolCalls:[{name:'get_market_overview',callId:'c'+n,args:{}}],continuation:[{role:'user',content:'{}'},{type:'function_call',call_id:'c'+n,name:'get_market_overview',arguments:'{}'}],usage:{inputTokens:1,outputTokens:1}};
    return {plan:S.validatePlan(empty),answer:empty,skippedTargets:[],usage:{inputTokens:1,outputTokens:1}};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.live=live;automation.providerStatus.aiConnected=true;automation.discovery={list:()=>[],symbols:()=>[],marketOverview:()=>({})};
  automation.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  const first=await automation.scout();const scope=automation.watchScope();assert.equal(automation.scoutStore.latest(scope).id,first.id);
  const e=await automation.scout('Scheduled').catch(x=>x);assert.equal(e.message,'SCOUT_EMPTY_PLAN');
  assert.equal(automation.scoutStore.latest(scope).id,first.id,'the previous plan stays the latest');assert.equal(automation.scoutStore.latest(scope).plan.summary,full.summary);
  const state=automation.getState().scout;assert.equal(state.lastError,'SCOUT_EMPTY_PLAN');assert.equal(state.failedAfter.reason,'SCOUT_EMPTY_PLAN');assert.equal(state.failedAfter.trigger,'Scheduled');
  assert.equal(n,4,'the first run, then research, the empty answer and one retry');});
