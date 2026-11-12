'use strict';
// Short gate 1.5.56, note 2 (artifacts/reviews/2026-11-12-claude-dry-run/review.md): when the app does not accept a Claude
// answer, the failed dry run keeps the app's own rule and the stop reason, and the Dry-run panel shows them. Local only.
// The Claude answer runs through the real AnthropicClient over a fake transport, and its error through the provider
// worker's reply, as in the app. No network.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');
require('./fixtures/order-book.cjs');
const A=require('../electron/anthropic-client.cjs');const ER=require('../electron/provider-error-reply.cjs');const {answerRule}=require('../electron/automation.cjs');
const KEY='sk-ant-fixture-answer-rule-0000';const CLAUDE={model:{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}};
const reply=t=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},{type:'text',text:t}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:1000,output_tokens:50,service_tier:'standard'},input_transformations:[]});
// As the provider worker and kis-service turn a client error into the error the engine sees.
const viaWorker=error=>{const r=ER.errorReply('decision',error);const e=new Error(r.code);Object.assign(e,{usage:r.usage,model:r.model,...(Number.isInteger(r.responseChars)?{responseChars:r.responseChars}:{}),...(r.detail?{detail:r.detail}:{}),...(r.requestSizes?{requestSizes:r.requestSizes}:{}),...(r.stopReason?{stopReason:r.stopReason}:{})});return e;};
function harness(answer){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const events=[];
  const provider={request:async(op,payload)=>{supplied.push({op,payload:JSON.stringify(payload)});
    if(String(payload?.options?.openaiModel??'').startsWith('claude-')){try{return await new A.AnthropicClient(KEY,async()=>new Response(JSON.stringify(reply(answer)),{status:200,headers:{'content-type':'application/json'}})).decide(payload.context,payload.options);}catch(error){throw viaWorker(error);}}
    return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({id,kind,title,body}));a.live=live;a.providerStatus={...a.providerStatus,aiConnected:true,openaiConnected:true,anthropicConnected:true};a.evidence={get:async()=>({})};
  a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,anthropicUSDPerDay:20,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  return {a,db,supplied,events};
}
const HOLD={action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'No trade.'};
const CASES=[
  ['a prose answer','I would hold for now because the evidence is mixed.',/^a decision that is not valid JSON$/],
  ['an unknown top-level key',JSON.stringify({...HOLD,harnessUnknownField:true}),/^decision fields unexpected harnessUnknownField$/],
  ['a wrong core type',JSON.stringify({...HOLD,quantity:'0'}),/^a quantity that is not a whole number$/]];

test('a Claude answer the app does not accept: the dry run keeps the app\'s rule and the stop reason, and returns them for the panel',async()=>{
  for(const [name,answer,rule] of CASES){const {a}=harness(answer);const started=Date.now();
    await assert.rejects(a.dryRun('review',CLAUDE),/INVALID_AI_RESPONSE/,name);
    const f=a.dryRunFailure(started);assert.equal(f.failed,'INVALID_AI_RESPONSE',name);assert.equal(f.providerError,null,name+': not a refusal');
    assert.match(f.answerRule.rule,rule,name);assert.equal(f.answerRule.stopReason,'end_turn',name);assert.equal(f.answerRule.code,'INVALID_AI_RESPONSE');
    assert.equal(f.measurement.requests[0].model,'claude-opus-5-5');assert.ok(f.measurement.totals.costUSD>0,name+': the tokens of an answer are charged');
    assert.equal(a.completedClaudeDryRun(),null,name+': the gate stays closed');}
});

test('the rule is bounded and stays local: control characters removed, 200 characters at most; not in the events, phone outbox, digest or a later request',async()=>{
  assert.equal(answerRule(Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule:'decision fields unexpected a\u0007b'+'x'.repeat(400),status:'end_turn'}})).rule.length,200);
  assert.ok(!answerRule(Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule:'a\u0007b'}})).rule.includes('\u0007'));
  assert.equal(answerRule(Object.assign(new Error('AI_BAD_REQUEST'),{detail:{rule:'x'}})),null,'only an answer the app did not accept');
  assert.equal(answerRule(Object.assign(new Error('AI_TIMEOUT'),{})),null);
  const {a,db,supplied,events}=harness(JSON.stringify({...HOLD,harnessUnknownField:true}));const MARK='harnessUnknownField';
  await a.dryRun('review',CLAUDE).catch(()=>{});const before=supplied.length;await a.review('User request').catch(()=>{});assert.ok(supplied.length>before,'a later request was made');
  assert.ok(!supplied.slice(before).map(s=>s.payload).join('\n').includes(MARK),'not in a later request');
  assert.ok(!JSON.stringify(events).includes(MARK),'not in the events');
  for(const t of ['notification_outbox','digests'])try{assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()).includes(MARK),t);}catch(e){if(e instanceof assert.AssertionError)throw e;}
  try{assert.ok(!JSON.stringify(a.digest.list()).includes(MARK),'digest');}catch(e){if(e instanceof assert.AssertionError)throw e;}
  assert.ok(JSON.stringify(db.prepare('SELECT payload FROM dry_runs').all()).includes(MARK),'kept on the dry-run record');
});

test('the Dry-run panel shows "Claude\'s answer was not accepted: <rule>." beside the measured cost',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/Dashboard.tsx'),'utf8');
  assert.ok(src.includes("{dryFailure?.answerRule&&<p role=\"status\" className=\"small-line notice\" aria-label=\"Answer not accepted\">{answerRuleText(dryFailure.answerRule,dryFailure.measurement?.requests?.[0]?.model)}</p>}{dryFailure?.measurement&&<Measurement m={dryFailure.measurement}/>}"));
  assert.ok(src.includes("was not accepted: ${a.rule??a.code}${a.stopReason?` (stop: ${a.stopReason})`:''}."));
  const main=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');assert.ok(main.includes('answerRule:r.review.answerRule??null'),'returned with the failure');
});
