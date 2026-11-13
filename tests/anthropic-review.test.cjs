// Anthropic provider, step A4: whole simulated reviews on Claude through researchReview and Automation, on fake
// transports and the paper and mock engines only. Design: artifacts/reviews/2026-11-10-anthropic-provider/.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {adapt}=require('./fixtures/claude-flat.cjs');// the enforced Claude decision form: nested fixture answers sent flat
const {AnthropicClient}=require('../electron/anthropic-client.cjs');const {AiClient}=require('../electron/ai-client.cjs');const {researchReview}=require('../electron/research-review.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const USAGE={input_tokens:1200,cache_read_input_tokens:9000,cache_creation_input_tokens:3000,output_tokens:400};
const thinking=n=>({type:'thinking',thinking:'',signature:'sig_'+n});const text=t=>({type:'text',text:t});
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const evidenceCall=(id,symbol='005930')=>({type:'tool_use',id,name:'get_market_evidence',input:{symbol,dataset:'company'}});
const reply=({content=[thinking('f'),text(JSON.stringify(hold))],stop_reason='end_turn',input_transformations=[]}={})=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content,stop_reason,stop_details:null,usage:USAGE,input_transformations});
function transport(...replies){const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));const r=replies.length>1?replies.shift():replies[0];const status=r.status??200;return new Response(JSON.stringify(r.status?r.body:adapt(r,JSON.parse(init.body))),{status,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
// The worker's path: the client's error becomes the reply the main process rebuilds (provider-error-reply.cjs, kis-service.cjs).
const viaWorker=async fn=>{try{return await fn();}catch(e){const r=errorReply('decision',e);throw Object.assign(new Error(r.code),{usage:r.usage,model:r.model,responseChars:r.responseChars,...(r.detail?{detail:r.detail}:{})});}};
const CTX={universe:[{symbol:'005930'},{symbol:'NASD:GOOGL'}],quotes:[{symbol:'005930',price:217000},{symbol:'NASD:GOOGL',price:323.68}]};
const run=(t,{context=CTX,evidence={get:async()=>({status:'ok',data:'fixture'})},log=()=>{},compact=async x=>x}={})=>{const c=new AnthropicClient(KEY,t);return researchReview({context,evidence,log,compact,detail:()=>({status:'complete',complete:true}),request:opts=>c.decide(context,{...CLAUDE,...opts})});};

test('A4: four rounds (three tool rounds and a final decision) sum usage; metrics have the OpenAI shape plus droppedThinking',async()=>{
  const t=transport(...[1,2,3].map(n=>reply({content:[thinking(n),evidenceCall('toolu_'+n)],stop_reason:'tool_use'})),reply());
  const r=await run(t);
  assert.equal(r.decision.action,'Hold');assert.equal(r.vendor,'anthropic');assert.equal(t.sent.length,4);
  assert.deepEqual(r.usage,{inputTokens:13200*4,outputTokens:400*4,cachedTokens:9000*4});
  assert.deepEqual(t.sent.map(b=>b.tool_choice.type),['auto','auto','auto','none'],'the fourth round is final');
  assert.deepEqual(t.sent.map(b=>Boolean(b.cache_control)),[false,true,true,true],'rounds 2 to 4 cache the conversation');
  assert.deepEqual(t.sent.map(b=>b.messages.length),[1,3,5,7]);assert.deepEqual(t.sent[3].messages.filter(m=>m.role==='assistant').map(m=>m.content[0].signature),['sig_1','sig_2','sig_3'],'every earlier turn replayed');
  // The same review on OpenAI: identical metric keys, Claude adds droppedThinking.
  let n=0;const openai=new AiClient('fixture_key_123',async()=>{n++;const out=n<4?[{type:'function_call',call_id:'c'+n,name:'get_market_evidence',arguments:JSON.stringify({symbol:'005930',dataset:'company'})}]:[{type:'message',content:[{type:'output_text',text:JSON.stringify(hold)}]}];return {ok:true,text:async()=>JSON.stringify({status:'completed',output:out,usage:{input_tokens:1,output_tokens:1}})};});
  const o=await researchReview({context:CTX,evidence:{get:async()=>({status:'ok',data:'fixture'})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),request:opts=>openai.decide(CTX,{openaiModel:'gpt-6-sol',reasoningEffort:'low',...opts})});
  assert.deepEqual(Object.keys(r.metrics).filter(k=>k!=='droppedThinking').sort(),Object.keys(o.metrics).sort());assert.equal(r.metrics.droppedThinking,0);assert.ok(!('droppedThinking' in o.metrics),'OpenAI metrics unchanged');
  assert.equal(r.metrics.toolCalls,o.metrics.toolCalls);
});
test('A4: condensing mid-review rewrites older results only; the turns stay byte-identical; drop_block is sent; drops are counted',async()=>{
  // Large results so the third round's request passes the condensing point (90% of 140,000 bytes).
  const big={get:async()=>({status:'ok',rows:Array.from({length:400},(_,i)=>({i,note:'evidence row '.repeat(8)}))})};
  const four=n=>Array.from({length:4},(_,i)=>evidenceCall(`toolu_${n}_${i}`,i%2?'NASD:GOOGL':'005930'));
  const turns=[1,2,3].map(n=>[thinking(n),...four(n)]);
  const t=transport(...turns.map(content=>reply({content,stop_reason:'tool_use'})),reply({input_transformations:[{type:'thinking_dropped',path:'messages.1.content.0',reason:'prefix_binding_mismatch'},{type:'thinking_dropped',path:'messages.3.content.0',reason:'prefix_binding_mismatch'}]}));
  const logs=[];const r=await run(t,{evidence:big,log:(k,title,body)=>logs.push([title,body])});
  assert.equal(r.decision.action,'Hold');assert.ok(logs.some(([title])=>title==='Research context condensed'),'condensing ran');
  const last=t.sent.at(-1);
  for(const body of t.sent)assert.ok(Buffer.byteLength(JSON.stringify(body.messages))<=140000+20000,'each request within the budget plus the turn blocks');
  const assistants=last.messages.filter(m=>m.role==='assistant');assert.deepEqual(assistants.map(m=>m.content),turns,'every turn byte-identical after condensing');
  const results=last.messages.filter(m=>m.role==='user'&&Array.isArray(m.content)).flatMap(m=>m.content);
  assert.equal(results.length,12);assert.ok(results.some(b=>/"reference":true|"compacted":true/.test(b.content)),'an older result was condensed');
  assert.ok(results.slice(-4).every(b=>!/"reference":true/.test(b.content)),'the latest round is kept in full');
  assert.deepEqual(last.thinking,{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}});
  assert.equal(r.metrics.droppedThinking,2,'drops from input_transformations reach the review metrics');
});
test('A4: plan correction on Claude: a withheld Buy, one correction request that keeps the tools, a corrected decision',async()=>{
  const raw=horizon=>({action:'Buy',symbol:'NASD:GOOGL',quantity:1,explanation:'Buy one Alphabet share.',credit:'none',loanDate:'',plan:{strategy:'long-term',thesis:'Cash generation and AI demand',invalidation:'Earnings show cash flow falling',stopPrice:300,targetPrice:370,horizonDays:horizon,confidence:'medium',portfolioImpact:{weightBeforePct:0,weightAfterPct:28.5,related:['NASD:GOOGL'],relatedBeforePct:0,relatedAfterPct:28.5,equityReliable:true,why:'Acceptable concentration for this growth goal.'},evidence:[{claim:'FY2025 free cash flow grew',source:'SEC 10-K FY2025 via get_company_research financials',verified:true}],valuation:{method:'P/E',inputs:'FY2026 EPS estimate $14.10 x 26',justification:'26x is the five-year median P/E'},uncertainty:null}});
  const first=[thinking(1),evidenceCall('toolu_1','NASD:GOOGL')];const withheld=[thinking(2),text(JSON.stringify(raw(null)))];
  const t=transport(reply({content:first,stop_reason:'tool_use'}),reply({content:withheld}),reply({content:[thinking(3),text(JSON.stringify(raw(365)))]}));
  const logs=[];const r=await run(t,{log:(k,title)=>logs.push(title)});
  assert.ok(logs.includes('Plan correction requested')&&logs.includes('Plan correction accepted'),logs.join(', '));
  assert.equal(r.decision.action,'Buy');assert.equal(r.decision.plan.horizonDays,365);assert.deepEqual(r.decision.planCorrected,{missing:'no horizon'});
  const fix=t.sent[2];assert.ok(Array.isArray(fix.tools)&&fix.tools.length>0,'the correction keeps the tools: the history holds tool calls');assert.deepEqual(fix.tool_choice,{type:'none'},'and calls none');
  // The withheld turn as the client received it (in the enforced form the fake answered flat) is replayed as it was.
  assert.deepEqual(fix.messages.at(-2),{role:'assistant',content:adapt(reply({content:withheld}),t.sent[1]).content},'the withheld turn is replayed as it was');assert.equal(fix.messages.at(-1).role,'user');assert.match(fix.messages.at(-1).content,/held back your Buy of 1 NASD:GOOGL because its plan is incomplete: no horizon/);
  assert.deepEqual(fix.tools,t.sent[1].tools,'the same tools as the review rounds');
  // A plain review without research or tool history sends no tools on its correction.
  const t2=transport(reply({content:withheld}),reply({content:[thinking(3),text(JSON.stringify(raw(365)))]}));const c2=new AnthropicClient(KEY,t2);
  const r2=await researchReview({context:CTX,evidence:null,log:()=>{},request:opts=>c2.decide(CTX,{...CLAUDE,...opts})});assert.equal(r2.decision.plan.horizonDays,365);assert.ok(!('tools' in t2.sent[1]));
});

// Automation with a Claude provider: the worker path in-process (errors rebuilt as the worker replies), mock live engine.
function automation(t){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const claude=new AnthropicClient(KEY,t);const ops=[];
  const provider={request:async(op,payload)=>{ops.push(op);if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');return viaWorker(()=>claude.decide(payload.context,{...payload.options,...CLAUDE}));}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({status:'ok'})};
  a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:false});
  return {a,db,ops};
}
test('A4: decisionWithRetry retries one AI_REQUEST_FAILED on Claude and never an INVALID_AI_RESPONSE',async()=>{
  const t=transport({status:529,body:{type:'error',error:{type:'overloaded_error',message:'Overloaded'}}},reply());const {a}=automation(t);
  const r=await a.decisionWithRetry(CTX,{research:false},0);assert.equal(r.decision.action,'Hold');assert.equal(t.sent.length,2);
  const bad=transport(reply({content:[text('not json')]}));const {a:b}=automation(bad);
  await assert.rejects(b.decisionWithRetry(CTX,{research:false},0),e=>e.message==='INVALID_AI_RESPONSE'&&/not valid JSON/.test(e.detail.rule)&&e.usage?.outputTokens===400);assert.equal(bad.sent.length,1,'not retried');
});
test('A4: settle stores vendor, responseChars and the real Opus cost for a completed and a failed call',async()=>{
  const {settle}=require('../electron/ai-accounting.cjs');const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ai_usage(day TEXT PRIMARY KEY,calls INTEGER,reservedMicro INTEGER);CREATE TABLE ai_calls(id TEXT PRIMARY KEY,day TEXT,payload TEXT)');db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run('d',2,1000000);
  for(const id of ['ok','bad','gpt'])db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'d',JSON.stringify({model:id==='gpt'?'gpt-6-sol':'claude-opus-5-5',reservedMicro:500000}));
  const done=await new AnthropicClient(KEY,transport(reply())).decide(CTX,CLAUDE);const rec=settle(db,'ai_usage','d','ok',done,'completed');
  assert.equal(rec.vendor,'anthropic');assert.equal(rec.responseChars,done.responseChars);assert.equal(rec.cost.micro,1200*4+9000*0.2+3000*5+400*20);assert.equal(rec.accountedMicro,rec.cost.micro);
  const failed=await viaWorker(()=>new AnthropicClient(KEY,transport(reply({stop_reason:'max_tokens',content:[thinking(1)]}))).decide(CTX,CLAUDE)).catch(e=>e);
  assert.equal(failed.message,'AI_OUTPUT_LIMIT');const f=settle(db,'ai_usage','d','bad',failed,'failed-or-uncertain');assert.equal(f.vendor,'anthropic','from the model when the error carries none');assert.ok(f.cost&&f.cost.micro>0,'a failed call with usage costs its real amount, not the reservation');
  assert.equal(settle(db,'ai_usage','d','gpt',{usage:{inputTokens:1,outputTokens:1,cachedTokens:0,cacheWriteTokens:0}},'completed').vendor,'openai');
  const total=db.prepare('SELECT reservedMicro FROM ai_usage WHERE day=?').get('d').reservedMicro;assert.ok(total<1000000,'reservations replaced by real costs');
});
test('A4: position-memory enforcement runs on a Claude decision (provider stays "openai", design T2)',async()=>{
  const pm=require('../electron/position-memory.cjs');const original=pm.enforce;const seen=[];pm.enforce=(decision,...rest)=>{seen.push(decision.action);return original(decision,...rest);};
  try{const t=transport(reply());const {a,ops}=automation(t);const r=await a.review('User request').catch(e=>{throw new Error(a.lastError+' '+a.lastErrorDetail);});
    assert.ok(ops.includes('decision'));assert.ok(t.sent.length>=1,'the Claude transport was used');assert.deepEqual(seen,['Hold'],'enforce saw the Claude decision');assert.equal(r.provider,'openai');}
  finally{pm.enforce=original;}
});
test('A4: a Claude format failure counts toward the review backoff; a completed review clears it',async()=>{
  const bad=()=>reply({content:[text('not json')]});
  const t=transport(bad(),reply(),bad(),bad());const {a}=automation(t);
  await assert.rejects(a.review('User request'));assert.equal(a.lastError,'INVALID_AI_RESPONSE');assert.equal(a.reviewBackoff().count,1);assert.equal(a.reviewBackoff().until,0,'one failure: no pause');
  await a.review('User request');assert.equal(a.lastError,null);assert.equal(a.reviewBackoff().count,0,'cleared by a completed review');
  await assert.rejects(a.review('User request'));await assert.rejects(a.review('User request'));const b=a.reviewBackoff();assert.equal(b.count,2);assert.ok(b.until>Date.now()+14*60000,'two in a row pause automatic reviews');assert.match(b.lastRule??'',/not valid JSON/);
});
