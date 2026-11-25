// Hourly cache, stage B (handoff 2026-11-25; Anthropic's prompt-caching page read 2026-11-25): when the engine expects the
// next scheduled review within the hour in an open session, the review's system blocks are marked {type:'ephemeral',
// ttl:'1h'}; the context block and the top-level continuation mark stay five minutes, after them (a longer lifetime must
// come before a shorter one); at most 4 marks. Without the option every request is as before. The one-hour write is priced
// at its own rate from usage.cache_creation. Fake transports only: no request leaves the process.
const test=require('node:test'),assert=require('node:assert/strict');
const {adapt}=require('./fixtures/claude-flat.cjs');
const {AnthropicClient}=require('../electron/anthropic-client.cjs');const {researchReview}=require('../electron/research-review.cjs');
const RI=require('../electron/review-instructions.cjs');const M=require('../electron/ai-models.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const USAGE={input_tokens:1200,cache_read_input_tokens:9000,cache_creation_input_tokens:3000,output_tokens:400};
const thinking=n=>({type:'thinking',thinking:'',signature:'sig_'+n});const text=t=>({type:'text',text:t});
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const evidenceCall=id=>({type:'tool_use',id,name:'get_market_evidence',input:{symbol:'005930',dataset:'company'}});
const reply=({content=[thinking('f'),text(JSON.stringify(hold))],stop_reason='end_turn'}={})=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content,stop_reason,stop_details:null,usage:USAGE,input_transformations:[]});
function transport(...replies){const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));const r=replies.length>1?replies.shift():replies[0];return new Response(JSON.stringify(adapt(r,JSON.parse(init.body))),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
const WITH_PARTS={ordersPerReview:2,universe:[{symbol:'005930'},{symbol:'NASD:NVDA'}],quotes:[{symbol:'005930',price:217000}],agentDesk:{conditionalOrders:{allowed:true}},discovery:{enabled:true,watchlist:[]},reviewInterval:{auto:true}};
const NO_PARTS={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:217000}]};
// Every mark in the order Anthropic renders the prefix: tools, system, messages, then the top-level (automatic) mark last.
const marksInOrder=body=>[...(body.tools??[]).map(t=>t.cache_control).filter(Boolean),...(body.system??[]).map(b=>b.cache_control).filter(Boolean),
  ...body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).map(b=>b?.cache_control).filter(Boolean),...(body.cache_control?[body.cache_control]:[])];
const check=(body,{hour})=>{const marks=marksInOrder(body);assert.ok(marks.length<=4,'at most 4 marks');
  const ttl=marks.map(m=>m.ttl??'5m');const firstShort=ttl.indexOf('5m');if(firstShort>=0)assert.ok(!ttl.slice(firstShort).includes('1h'),'no one-hour mark after a five-minute one: '+ttl);
  for(const b of body.system.filter(b=>b.cache_control))assert.deepEqual(b.cache_control,hour?{type:'ephemeral',ttl:'1h'}:{type:'ephemeral'});
  for(const b of body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b?.cache_control))assert.deepEqual(b.cache_control,{type:'ephemeral'},'the context block stays five minutes');
  if(body.cache_control)assert.deepEqual(body.cache_control,{type:'ephemeral'},'the top-level mark stays five minutes');return ttl;};

for(const hour of [true,false])for(const [name,ctx] of [['with part text',WITH_PARTS],['without part text',NO_PARTS]])
test(`a research review ${name}, cacheHour ${hour}: system marks ${hour?'one hour':'five minutes'}, the rest five minutes, in order, at most 4`,async()=>{
  const t=transport(...[1,2].map(n=>reply({content:[thinking(n),evidenceCall('toolu_'+n)],stop_reason:'tool_use'})),reply());const c=new AnthropicClient(KEY,t);
  const r=await researchReview({context:ctx,evidence:{get:async()=>({status:'ok',data:'fixture'})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),request:opts=>c.decide(ctx,{...CLAUDE,...opts,...(hour?{cacheHour:true}:{})})});
  assert.equal(r.decision.action,'Hold');assert.equal(t.sent.length,3);
  const ttls=t.sent.map(b=>check(b,{hour}));if(hour)assert.deepEqual(ttls[1].slice(0,RI.reviewBlocks(RI.partsFor(ctx)).parts?2:1),RI.reviewBlocks(RI.partsFor(ctx)).parts?['1h','1h']:['1h']);
  // The system blocks are the same bytes in every call of the review (the prefix the next review reads).
  assert.equal(new Set(t.sent.map(b=>JSON.stringify(b.system))).size,1);});

test('one-call reviews, the text form, a correction and a replay: every shape keeps the order and the count',async()=>{
  for(const hour of [true,false]){const opt=hour?{cacheHour:true}:{};
    {const t=transport(reply());await new AnthropicClient(KEY,t).decide(WITH_PARTS,{...CLAUDE,...opt});check(t.sent[0],{hour});assert.ok(!('tools' in t.sent[0]));}
    {const t=transport(reply());await new AnthropicClient(KEY,t).decideAs(WITH_PARTS,{...CLAUDE,research:true,...opt},'text');check(t.sent[0],{hour});}
    {const t=transport(reply());await new AnthropicClient(KEY,t).decide(WITH_PARTS,{...CLAUDE,research:true,instructionSet:'proposed',...opt});check(t.sent[0],{hour});}
    {const t=transport(reply({content:[thinking(1),evidenceCall('toolu_1')],stop_reason:'tool_use'}),reply());const c=new AnthropicClient(KEY,t);
      const first=await c.decide(WITH_PARTS,{...CLAUDE,research:true,...opt});
      await c.decide(WITH_PARTS,{...CLAUDE,research:false,final:true,...opt,continuation:[...first.continuation,{type:'function_call_output',call_id:'toolu_1',output:'{}'},{role:'user',content:'The app held back one of your orders.'}]});
      check(t.sent[1],{hour});assert.ok(t.sent[1].cache_control,'the correction carries the top-level mark');}}
});

test('without cacheHour nothing in the request carries a ttl (as before)',async()=>{
  const t=transport(reply());await new AnthropicClient(KEY,t).decide(WITH_PARTS,{...CLAUDE,research:true});assert.doesNotMatch(JSON.stringify(t.sent[0]),/"ttl"/);});

test('accounting: the one-hour write is priced at its own rate from usage.cache_creation; old usage is unchanged',()=>{
  const u=M.normalizeUsage({usage:{...USAGE,cache_creation:{ephemeral_5m_input_tokens:1000,ephemeral_1h_input_tokens:2000}}},'anthropic');
  assert.equal(u.cacheWrite1hTokens,2000);assert.equal(u.cacheWriteTokens,3000);
  const d=M.costDetails('claude-opus-5-5',u);assert.equal(d.cacheWriteMicro,1000*5+2000*8);assert.equal(d.rates.write1h,8);assert.equal(d.cacheWrite1hTokens,2000);
  const old=M.normalizeUsage({usage:USAGE},'anthropic');assert.equal('cacheWrite1hTokens' in old,false,'no field without a one-hour write');assert.equal(M.costDetails('claude-opus-5-5',old).cacheWriteMicro,3000*5);
  assert.equal(M.costDetails('claude-opus-5-5',{...u,cacheWrite1hTokens:4000}),null,'more one-hour than all writes: unknown');
  assert.equal(M.normalizeUsage({usage:{...USAGE,cache_creation:{ephemeral_1h_input_tokens:-1}}},'anthropic').cacheWrite1hTokens,null);
});

test('the engine: one hour only on Claude, running, an interval of an hour or less, a session open when the next review starts',()=>{
  const {Automation}=require('../electron/automation.cjs');const a=Object.create(Automation.prototype);let open=true,minutes=60,factor=1,emergency=false;
  a.config={enabled:true,scope:'kis',openaiModel:'claude-opus-5-5'};a.sessionArmed=true;a.vendorOf=m=>String(m).startsWith('claude')?'anthropic':'openai';
  a.emergencyState=()=>({active:emergency});a.reviewInterval={get:()=>({minutes})};a.slowFactor=()=>factor;a.watchScope=()=>'kis:x';a.scoutMarkets=()=>['KR'];let askedAt=null;a.sessionOpen=(m,at)=>{askedAt=at;return open;};
  const t0=1795600000000;assert.equal(a.cacheHourFor(t0),true);assert.equal(askedAt,t0+3600000,'the session at the next scheduled start');
  assert.equal(a.cacheHourFor(t0,'gpt-6-sol'),false,'OpenAI: no change');
  open=false;assert.equal(a.cacheHourFor(t0),false,'closed at the next review');open=true;
  minutes=61;assert.equal(a.cacheHourFor(t0),false,'over an hour');minutes=60;factor=2;assert.equal(a.cacheHourFor(t0),false,'doubled near the budget');factor=1;
  minutes=15;assert.equal(a.cacheHourFor(t0),true,"the agent's shorter interval");
  emergency=true;assert.equal(a.cacheHourFor(t0),false);emergency=false;
  a.config.enabled=false;assert.equal(a.cacheHourFor(t0),false,'stopped');a.config.enabled=true;a.config.scope='paper';assert.equal(a.cacheHourFor(t0),false,'paper');
});

// The engine end to end with a fake provider (the dry-run test's harness): the review decides once and every call of it
// carries the same cacheHour; the dry run sends the one-hour form on Claude.
function harness(){require('./fixtures/order-book.cjs');
  const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const queue=[];
  const provider={request:async(op,payload)=>{supplied.push([op,payload]);const next=queue.shift();return next?next(payload):{decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.live=live;automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>({})};
  automation.series={closes:()=>null,ensure:async()=>{}};automation.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  automation.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  return {automation,supplied,queue,db};}
const toolRound=()=>({toolCalls:[{name:'save_note',callId:'n',args:{action:'set',symbol:'005930',note:'x',expiresInDays:7}}],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}});

test('a review decides the lifetime once and sends it in every call; without it no call carries it',async()=>{
  for(const value of [true,false]){const {automation,supplied,queue,db}=harness();let asked=0;automation.cacheHourFor=()=>{asked++;return value;};
    queue.push(toolRound);await automation.review('User request');
    const opts=supplied.filter(([op])=>op==='decision').map(([,p])=>p.options);assert.equal(opts.length,2);assert.equal(asked,1,'decided once per review');
    assert.deepEqual(opts.map(o=>o.cacheHour===true),[value,value]);db.close();}
});

test('the dry run sends the one-hour form on Claude, and not on OpenAI',async()=>{
  for(const [model,want] of [['claude-opus-5-5',true],['gpt-6-sol',false]]){const {automation,supplied,db}=harness();
    automation.providerStatus.anthropicConnected=true;automation.providerStatus.openaiConnected=true;automation.consentFor=()=>true;await automation.dryRun('review',{model:{openaiModel:model,reasoningEffort:'medium'}}).catch(e=>assert.fail(e.message));
    const opts=supplied.filter(([op])=>op==='decision').map(([,p])=>p.options);assert.ok(opts.length>=1,model+': a dry-run request was made');
    assert.ok(opts.every(o=>(o.cacheHour===true)===want),model);db.close();}
});
