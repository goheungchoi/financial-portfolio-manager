// Item 12 step 2 (a) (artifacts/reviews/2026-11-17-review-cost/step2-note.md, cleared): in a research review on Claude the
// context is one text block with a cache mark, built once and sent byte for byte in every call of the review, so a
// second call reads it from the cache. At most 4 marks per request (3 explicit + the automatic one). Without research
// the context stays the plain string. OpenAI requests unchanged. Fake transports only: no request leaves the process.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {adapt}=require('./fixtures/claude-flat.cjs');
const {AnthropicClient}=require('../electron/anthropic-client.cjs');const {AiClient}=require('../electron/ai-client.cjs');const {researchReview}=require('../electron/research-review.cjs');
const RI=require('../electron/review-instructions.cjs');const M=require('../electron/ai-models.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const USAGE={input_tokens:1200,cache_read_input_tokens:9000,cache_creation_input_tokens:3000,output_tokens:400};
const thinking=n=>({type:'thinking',thinking:'',signature:'sig_'+n});const text=t=>({type:'text',text:t});
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const evidenceCall=id=>({type:'tool_use',id,name:'get_market_evidence',input:{symbol:'005930',dataset:'company'}});
const reply=({content=[thinking('f'),text(JSON.stringify(hold))],stop_reason='end_turn'}={})=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content,stop_reason,stop_details:null,usage:USAGE,input_transformations:[]});
function transport(...replies){const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));const r=replies.length>1?replies.shift():replies[0];return new Response(JSON.stringify(adapt(r,JSON.parse(init.body))),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
// A context with part text (further orders), so the core block carries its own mark (the most marks a request can have).
const CTX={ordersPerReview:2,universe:[{symbol:'005930'},{symbol:'NASD:NVDA'}],quotes:[{symbol:'005930',price:217000}],agentDesk:{conditionalOrders:{allowed:true}},discovery:{enabled:true,watchlist:[]},reviewInterval:{auto:true}};
const MARKED={role:'user',content:[{type:'text',text:JSON.stringify(CTX),cache_control:{type:'ephemeral'}}]};
const marks=body=>(body.system??[]).filter(b=>b.cache_control).length+body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b?.cache_control).length+(body.cache_control?1:0);
const run=t=>{const c=new AnthropicClient(KEY,t);return researchReview({context:CTX,evidence:{get:async()=>({status:'ok',data:'fixture'})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),request:opts=>c.decide(CTX,{...CLAUDE,...opts})});};
test('a research review: the first call marks the context; every later call (research rounds and the final round) sends it byte for byte; at most 4 marks',async()=>{
  assert.ok(RI.reviewBlocks(RI.partsFor(CTX)).parts,'the fixture has part text (core block marked)');
  const t=transport(...[1,2,3].map(n=>reply({content:[thinking(n),evidenceCall('toolu_'+n)],stop_reason:'tool_use'})),reply());const r=await run(t);
  assert.equal(r.decision.action,'Hold');assert.equal(t.sent.length,4);assert.deepEqual(t.sent.map(b=>b.tool_choice.type),['auto','auto','auto','none']);
  for(const body of t.sent)assert.equal(JSON.stringify(body.messages[0]),JSON.stringify(MARKED),'message 0 identical in every call, mark included');
  assert.deepEqual(t.sent.map(marks),[3,4,4,4],'core + last system + context; the automatic mark from the second call on');
  assert.deepEqual(t.sent.map(b=>Boolean(b.cache_control)),[false,true,true,true],'the automatic mark as before (no change for the final round)');
  for(const body of t.sent){const msgs=body.messages;assert.ok(!msgs.at(-1).content?.at?.(-1)?.cache_control||msgs.length===1,'the context is never the last block when the automatic mark is set');}
});
test('a correction after a tool round, the text form and a replay keep the same marked block; no more than 4 marks',async()=>{
  const t=transport(reply({content:[thinking(1),evidenceCall('toolu_1')],stop_reason:'tool_use'}),reply());const c=new AnthropicClient(KEY,t);
  const first=await c.decide(CTX,{...CLAUDE,research:true});const ask={role:'user',content:'The app held back one of your orders.'};
  await c.decide(CTX,{...CLAUDE,research:false,final:true,continuation:[...first.continuation,{type:'function_call_output',call_id:'toolu_1',output:'{}'},ask]});
  const correction=t.sent[1];assert.equal(JSON.stringify(correction.messages[0]),JSON.stringify(MARKED));assert.ok(marks(correction)<=4);assert.equal(correction.tool_choice.type,'none');
  const tt=transport(reply());await new AnthropicClient(KEY,tt).decideAs(CTX,{...CLAUDE,research:true},'text');assert.deepEqual(tt.sent[0].messages,[MARKED],'text form');assert.ok(marks(tt.sent[0])<=4);
  const tr=transport(reply());await new AnthropicClient(KEY,tr).decide(CTX,{...CLAUDE,research:true,instructionSet:'proposed'});assert.deepEqual(tr.sent[0].messages,[MARKED],'replay with the proposed text');
});
test('without research the context is the plain string it was (no second call can follow)',async()=>{
  const t=transport(reply());await new AnthropicClient(KEY,t).decide(CTX,{...CLAUDE});
  assert.deepEqual(t.sent[0].messages,[{role:'user',content:JSON.stringify(CTX)}]);assert.ok(!('tools' in t.sent[0]));assert.ok(marks(t.sent[0])<=2);
});
test('OpenAI: the review request body is unchanged (pinned)',async()=>{
  const bodies=[];const openai=new AiClient('fixture_key_123',async(url,init)=>{bodies.push(init.body);return {ok:true,text:async()=>JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(hold)}]}],usage:{input_tokens:1,output_tokens:1}})};});
  await openai.decide(CTX,{openaiModel:'gpt-6-sol',reasoningEffort:'low',research:true});
  // Leveraged products held up to maxHoldingDays (A) and S4's run_screen pieces: the earlier text put back, every other
  // byte compared.
  const sha=crypto.createHash('sha256').update(require('./fixtures/leveraged-text-a.cjs').earlierLeveragedText(require('./fixtures/s4-text.cjs').beforeS4(bodies[0]))).digest('hex').slice(0,16);assert.equal(sha,OPENAI_PIN,'the OpenAI request body, byte for byte');
});
const OPENAI_PIN='d8b41c7f7d274c88';// computed with electron/ai-client.cjs as at b0f86b6 (unchanged by this step)
test('the expected cost on Claude Opus 5.5 (the measured shape: prefix 20,946, context 26,200, tool round 2,800 tokens)',()=>{
  const cost=u=>{const d=M.costDetails('claude-opus-5-5',M.normalizeUsage({usage:u},'anthropic'));return {...d,micro:Math.round(d.micro)};};const P=20946,X=26200,D=2800;
  // One-call review: the prefix and the context written (was: prefix written, context plain).
  const one=cost({input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:P+X,output_tokens:0}),oneBefore=cost({input_tokens:X,cache_read_input_tokens:0,cache_creation_input_tokens:P,output_tokens:0});
  assert.equal(one.micro,235730);assert.equal(oneBefore.micro,209530);assert.equal(one.micro-oneBefore.micro,26200,'+$0.026 on a one-call review');
  // Two-call review: call 2 reads the prefix and the context and writes the tool round (was: reads the prefix, writes the context and the tool round).
  const second=cost({input_tokens:0,cache_read_input_tokens:P+X,cache_creation_input_tokens:D,output_tokens:0}),secondBefore=cost({input_tokens:0,cache_read_input_tokens:P,cache_creation_input_tokens:X+D,output_tokens:0});
  assert.equal(second.micro,23429);assert.equal(secondBefore.micro,149189);
  assert.equal((oneBefore.micro+secondBefore.micro)-(one.micro+second.micro),99560,'−$0.100 on a two-call review');
});
// 4.4 (cleared, its own commit): a correction after a one-call research review has no tool calls in its conversation, but
// the first call was sent with tools; it sends the same tools (tool_choice none), so the prefix it reads is the same.
test('4.4: a correction after a one-call research review sends the first call\'s tools (none chosen); without research it sends none',async()=>{
  const t=transport(reply(),reply());const c=new AnthropicClient(KEY,t);
  await c.decide(CTX,{...CLAUDE,research:true});
  // The conversation a correctable answer returns (anthropic-client.cjs: the input and the answer turn).
  const answered=input=>[input,{type:'anthropic_turn',content:[thinking('f'),text(JSON.stringify(hold))]}];
  const ask={role:'user',content:'The app held back one of your orders.'};
  await c.decide(CTX,{...CLAUDE,research:false,final:true,continuation:[...answered(MARKED),ask]});
  const [a,b]=t.sent;assert.ok(!b.messages.some(m=>Array.isArray(m.content)&&m.content.some(x=>x.type==='tool_use'||x.type==='tool_result')),'no tool calls in the conversation');
  assert.equal(JSON.stringify(b.tools),JSON.stringify(a.tools),'the same tools, byte for byte');assert.equal(JSON.stringify(b.system),JSON.stringify(a.system),'the same system');
  assert.equal(b.tool_choice.type,'none');assert.equal(JSON.stringify(b.messages[0]),JSON.stringify(MARKED));assert.ok(marks(b)<=4);
  // A review without research: its correction sends no tools, as before.
  const u=transport(reply(),reply());const d=new AnthropicClient(KEY,u);await d.decide(CTX,{...CLAUDE});assert.deepEqual(u.sent[0].messages,[{role:'user',content:JSON.stringify(CTX)}]);
  await d.decide(CTX,{...CLAUDE,research:false,final:true,continuation:[...answered({role:'user',content:JSON.stringify(CTX)}),ask]});
  assert.ok(!('tools' in u.sent[1])&&!('tool_choice' in u.sent[1]),'no tools without research');
});
