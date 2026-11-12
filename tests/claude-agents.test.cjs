'use strict';
// Release B, step B3 (artifacts/reviews/2026-11-12-engine-settings/b3-design.md and its review): Claude Opus 5.5 for the
// scout, the market narrative, context compacting and reflection, behind the completed-dry-run gate. No network: every
// transport and provider is a fake. No real call.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const A=require('../electron/anthropic-client.cjs');const M=require('../electron/ai-models.cjs');const R=require('../electron/ai-router.cjs');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const KEY='sk-ant-fixture-key-0000';const OPTS={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const reply=(content,extra={})=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},...content],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:100,output_tokens:50,service_tier:'standard'},input_transformations:[],...extra});
const text=o=>({type:'text',text:JSON.stringify(o)});
const transport=(...replies)=>{const sent=[];const fn=async(url,init)=>{sent.push({url,body:JSON.parse(init.body),headers:new Headers(init.headers)});const r=replies.length>1?replies.shift():replies[0];return new Response(JSON.stringify(r),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;};
const NARR={summary:'Quiet.',regime:'neutral',drivers:[]};const REFL={facts:'f',uncertainty:'u',hypothesis:'h',lesson:'l',applicability:'a'};
const plan={summary:'Hold cash.',cashTargetPct:50,focus:'f',targets:[],briefAnswers:[],retrospective:'',substitutions:[]};

test('each agent\'s request: model, adaptive thinking, effort, json_schema, its output cap, never a forced tool, no sampling or fallbacks',async()=>{
  const nt=transport(reply([text(NARR)]));const n=await new A.AnthropicClient(KEY,nt).narrative({headlines:[]},OPTS);assert.deepEqual(n.narrative,NARR);
  const ct=transport(reply([text({summaries:[]})]));await new A.AnthropicClient(KEY,ct).compact({items:[]},OPTS);
  const rt=transport(reply([text(REFL)]));const r=await new A.AnthropicClient(KEY,rt).reflect({evidence:{}},OPTS);assert.equal(r.reflection.lesson,'l');
  for(const [kind,t,cap] of [['narrative',nt,8000],['compact',ct,16000],['reflect',rt,8000]]){const b=t.sent[0].body;
    assert.equal(b.model,'claude-opus-5-5',kind);assert.equal(b.max_tokens,cap,kind);assert.deepEqual(b.thinking,{type:'adaptive'},kind+': no history replayed, so no binding');
    assert.equal(b.output_config.effort,'medium');assert.equal(b.output_config.format.type,'json_schema');assert.equal(b.service_tier,'standard_only');
    for(const k of ['tools','tool_choice','temperature','top_p','top_k','fallbacks','betas'])assert.equal(b[k],undefined,`${kind}: ${k}`);
    assert.equal(t.sent[0].headers.get('anthropic-beta'),A.BETA,kind+': the locked client sends the one documented beta on every Messages request (not in the body)');}
  assert.deepEqual(M.CLAUDE_OUTPUT,{decide:32000,scout:32000,compact:16000,narrative:8000,reflect:8000});
  assert.deepEqual({...R.CLAUDE_TIMEOUT_MS},{decide:300000,scout:300000,narrative:240000,compact:450000,reflect:240000});
});

test('the scout: tools with auto, then the plan with none on the final round; thinking bound with drop_block and its beta; the continuation stays append-only',async()=>{
  const t=transport(reply([{type:'tool_use',id:'tu1',name:'screen_market',input:{market:'KR'}}],{stop_reason:'tool_use'}),reply([text(plan)]));const c=new A.AnthropicClient(KEY,t);
  const first=await c.scout({brief:'x'},OPTS);assert.equal(first.toolCalls[0].name,'screen_market');assert.equal(first.stopReason,'tool_use');
  const b1=t.sent[0].body;assert.equal(b1.max_tokens,32000);assert.deepEqual(b1.tool_choice,{type:'auto'});assert.ok(b1.tools.length>0);assert.deepEqual(b1.thinking,{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}});assert.equal(t.sent[0].headers.get('anthropic-beta'),A.BETA);
  const cont=[...first.continuation,{type:'function_call_output',call_id:'tu1',output:'{"rows":[]}'}];
  const last=await c.scout({brief:'x'},{...OPTS,continuation:cont,final:true});assert.deepEqual(last.plan.targets,[]);
  const b2=t.sent[1].body;assert.deepEqual(b2.tool_choice,{type:'none'});assert.deepEqual(b2.messages.slice(0,b1.messages.length),b1.messages,'the earlier messages are sent unchanged');assert.deepEqual(b2.cache_control,{type:'ephemeral'});
  for(const k of ['any','tool'])assert.ok(!JSON.stringify([b1,b2]).includes(`"type":"${k}"`),'never a forced tool_choice');
  await assert.rejects(new A.AnthropicClient(KEY,transport(reply([{type:'tool_use',id:'x',name:'screen_market',input:{}}],{stop_reason:'tool_use'}))).scout({},{...OPTS,final:true}),e=>e.message==='INVALID_AI_RESPONSE');
});

test('stop reasons per agent: max_tokens, refusal with its category, a tool request from an agent without tools',async()=>{
  for(const m of ['narrative','compact','reflect']){
    await assert.rejects(new A.AnthropicClient(KEY,transport(reply([],{stop_reason:'max_tokens'})))[m]({},OPTS),e=>e.message==='AI_OUTPUT_LIMIT'&&e.stopReason==='max_tokens',m);
    await assert.rejects(new A.AnthropicClient(KEY,transport(reply([],{stop_reason:'refusal',stop_details:{category:'cyber'}})))[m]({},OPTS),e=>e.message==='AI_REFUSED'&&/cyber/.test(e.detail.rule),m);
    await assert.rejects(new A.AnthropicClient(KEY,transport(reply([{type:'tool_use',id:'x',name:'y',input:{}}],{stop_reason:'tool_use'})))[m]({},OPTS),e=>e.message==='INVALID_AI_RESPONSE',m);}
});

test('the four schemas lose no keyword in the conversion to Claude\'s structured outputs',()=>{
  const schemas={scout:require('../electron/scout.cjs').SCHEMA,narrative:require('../electron/narrative.cjs').SCHEMA,compact:require('../electron/context-fit.cjs').COMPACT_SCHEMA,reflect:require('../electron/reflection.cjs').SCHEMA};
  const keys=o=>o&&typeof o==='object'?Object.entries(o).flatMap(([k,v])=>[k,...keys(v)]):[];
  for(const [k,s] of Object.entries(schemas)){const lost=keys(s).filter(x=>A.UNSUPPORTED.includes(x));assert.deepEqual(lost,[],k);}
});

test('reservations per agent at their caps; OpenAI reservations are unchanged',()=>{
  const usd=(bytes,kind)=>M.reservationAt(OPTS,bytes,kind)/1e6;
  assert.deepEqual([usd(180000,'scout'),usd(120000,'narrative'),usd(400000,'compact'),usd(70000,'reflect')],[1.728,0.864,2.4,0.624]);
  const sol={openaiModel:'gpt-6-sol',reasoningEffort:'medium'};for(const k of ['decide','scout','compact','narrative','reflect'])assert.equal(M.reservationAt(sol,50000,k),M.reservationAt(sol,50000),k);
});

// The engine: the gate, consent, availability, no fallback.
function world({claudeRun=false,anthropic=true,share=true}={}){const db=new DatabaseSync(':memory:');const ops=[];
  const provider={request:async(op,payload)=>{ops.push({op,model:payload?.options?.openaiModel??null});if(op==='compact')return {summaries:[],usage:{inputTokens:1,outputTokens:1},model:payload.options.openaiModel};throw new Error('NOT_IN_TEST');}};
  const a=new Automation(db,new PaperEngine(db,[],()=>[]),provider,()=>{});a.configure({scope:'paper',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:share,openaiModel:'gpt-6-sol',reasoningEffort:'medium'});
  a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:anthropic};if(claudeRun)a.completedClaudeDryRun=()=>({id:'d',timestamp:1,model:'claude-opus-5-5',calls:2,costUSD:0.3,account:'Paper'});return {a,db,ops};}
// The connection changes to an account with no completed Claude dry run (the cached gate is keyed by the account).
const closeGate=a=>{a.completedClaudeDryRun=()=>null;a.stateCache?.clear();};
test('the gate: Claude for the four agents only after a completed dry run on this account; the trading model stays refused; "Same" follows the trading model',()=>{
  const closed=world().a;for(const k of ['scoutModel','narrativeModel','reflectionModel'])assert.throws(()=>closed.configure({[k]:'claude-opus-5-5'}),/CLAUDE_DRY_RUN_REQUIRED/,k);
  assert.throws(()=>closed.configure({routineModel:'claude-opus-5-5',routineEffort:'low'}),/CLAUDE_DRY_RUN_REQUIRED/);
  const open=world({claudeRun:true}).a;open.configure({scoutModel:'claude-opus-5-5',narrativeModel:'claude-opus-5-5',reflectionModel:'claude-opus-5-5',routineModel:'claude-opus-5-5',routineEffort:'low'});
  assert.equal(open.agentModel('scout').openaiModel,'claude-opus-5-5');assert.equal(open.agentModel('compacting').openaiModel,'claude-opus-5-5');
  assert.throws(()=>open.configure({openaiModel:'claude-opus-5-5'}),/CLAUDE_NOT_ENABLED_FOR_TRADING/,'trading waits for C2');
  const same=world().a;same.configure({scoutModel:'same'});assert.equal(same.agentModel('scout').openaiModel,'gpt-6-sol','an agent left on Same stays on the trading model, OpenAI');
  const other=world().a;other.db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run('d',1,JSON.stringify({id:'d',timestamp:1,mode:'review',summary:{account:{key:'another'}},review:{model:'claude-opus-5-5',decision:{action:'Hold'},calls:1,measurement:{totals:{}}}}));
  assert.throws(()=>other.configure({scoutModel:'claude-opus-5-5'}),/CLAUDE_DRY_RUN_REQUIRED/,'a run on another account does not open it');
});

test('consent: the scout, compacting and reflection need sharing with Anthropic; each refuses with its reason and no request of any kind is made',async()=>{
  const {a,ops}=world({claudeRun:true,share:false});a.configure({scoutModel:'claude-opus-5-5',reflectionModel:'claude-opus-5-5',routineModel:'claude-opus-5-5',routineEffort:'low'});
  a.config.scope='kis';assert.match(a.scoutAvailable(),/Allow sharing KIS data with Anthropic/);a.config.scope='paper';
  await assert.rejects(a.compactResearch('r',{items:['x']}),/DATA_SHARING_NOT_ENABLED/);assert.deepEqual(ops,[],'no Claude request, and no OpenAI request in its place');
  const keyless=world({claudeRun:true,anthropic:false});keyless.a.configure({routineModel:'claude-opus-5-5',routineEffort:'low',narrativeModel:'claude-opus-5-5'});
  await assert.rejects(keyless.a.compactResearch('r',{items:['x']}),/AI_NOT_CONNECTED/);assert.equal(keyless.a.narrativeAvailable(),'Add an Anthropic key in Connections');assert.deepEqual(keyless.ops,[]);
  // The reverse: a failing OpenAI condensing makes no Claude request.
  const oa=world({claudeRun:true});oa.a.provider={request:async(op,p)=>{oa.ops.push({op,model:p.options.openaiModel});throw new Error('AI_TIMEOUT');}};await assert.rejects(oa.a.compactResearch('r',{items:['x']}));assert.deepEqual(oa.ops.map(o=>o.model),['gpt-6-luna']);
});

test('a refused Claude condensing inside a trading review ends on the by-reference path, and the review reaches its decision',async()=>{
  // Refused for sharing off, and (B3 review F1) for the gate closing after the save: an account change.
  for(const cause of ['sharing off','gate closed']){
  const {researchReview}=require('../electron/research-review.cjs');const {a,ops}=world({claudeRun:true,share:cause!=='sharing off'});a.configure({routineModel:'claude-opus-5-5',routineEffort:'low'});
  if(cause==='gate closed')closeGate(a);
  let round=0;const logs=[];const context={universe:[{symbol:'005930'},{symbol:'000270'}],discovery:{enabled:true}};
  const request=async({continuation})=>{round++;const base=continuation??[{role:'user',content:'c'.repeat(60000)}];
    if(round<4)return {toolCalls:[0,1,2,3].map(k=>({name:'get_company_research',callId:`r${round}-${k}`,args:{symbol:k%2?'000270':'005930',sections:['s'+k]}})),continuation:[...base,...[0,1,2,3].map(k=>({type:'function_call',call_id:`r${round}-${k}`,name:'get_company_research',arguments:JSON.stringify({symbol:k%2?'000270':'005930',sections:['s'+k]})}))],usage:{}};
    return {decision:{action:'Hold'},usage:{}};};
  const result=await researchReview({context,evidence:{get:async()=>({})},request,log:(k,t,b)=>logs.push(t+' '+String(b??'')),compact:payload=>a.compactResearch('rev',payload),discovery:{get_company_research:async x=>({overview:{price:216000},notes:'n'.repeat(14000),asked:x})}});
  assert.equal(result.decision.action,'Hold',cause+': the review completes');assert.deepEqual(ops,[],cause+': no condensing request was made, on either provider');}
});

test('the gate holds at call time: each Claude agent saved while the gate was open refuses once it closes, before any reservation or request (B3 review F1)',async()=>{
  const GATE='Run one dry run on Claude on this account first';
  const make=()=>{const w=world({claudeRun:true});w.a.configure({scoutModel:'claude-opus-5-5',narrativeModel:'claude-opus-5-5',reflectionModel:'claude-opus-5-5',routineModel:'claude-opus-5-5',routineEffort:'low'});
    w.a.provider={request:async(op,p)=>{w.ops.push({op,model:p?.options?.openaiModel??null});if(op==='compact')return {summaries:[],usage:{inputTokens:1,outputTokens:1},model:p.options.openaiModel};if(op==='narrative')return {narrative:NARR,usage:{inputTokens:1,outputTokens:1},model:p.options.openaiModel};throw new Error('NOT_IN_TEST');}};
    w.a.indexCloses=()=>({});w.a.news=[{title:'KOSPI rises',url:'https://example.com/a',published:new Date().toISOString(),source:'x'}];return w;};
  // Gate open: each agent runs on Claude.
  {const {a,ops}=make();
    await a.compactResearch('r',{items:['x']});await a.buildNarrative();
    assert.deepEqual(ops.map(o=>o.op+':'+o.model),['compact:claude-opus-5-5','narrative:claude-opus-5-5']);
    assert.equal(a.narrativeAvailable(),null);a.config.scope='kis';assert.notEqual(a.scoutAvailable(),GATE);a.config.scope='paper';
    assert.equal(a.reflectionProviderBudget().gateClosed,false);}
  // Gate closed (the connection changed to an account with no completed Claude dry run).
  {const {a,ops,db}=make();closeGate(a);
    await assert.rejects(a.compactResearch('r',{items:['x']}),/^Error: CLAUDE_DRY_RUN_REQUIRED$/);
    assert.equal(a.narrativeAvailable(),GATE);await assert.rejects(a.buildNarrative(),/NARRATIVE_UNAVAILABLE/);assert.equal(a.narrativeState().blocked,GATE);
    assert.equal(a.scoutAvailable(),GATE);await assert.rejects(a.scout(),/SCOUT_UNAVAILABLE/);
    assert.equal(a.reflectionProviderBudget().gateClosed,true);
    assert.deepEqual(ops,[],'no request to either provider');assert.deepEqual(db.prepare('SELECT * FROM ai_usage_vendor').all(),[],'nothing reserved');}
  // A save with the gate closed and a Claude agent already saved names that agent.
  {const {a}=make();closeGate(a);assert.throws(()=>a.configure({skipUnchanged:!a.config.skipUnchanged}),/^Error: CLAUDE_DRY_RUN_REQUIRED:scout$/);}
  const {claudeGateText}=await import('../src/agentDraft.mjs');assert.equal(claudeGateText('scout'),'Scout is set to Claude Opus 5.5, which needs a measured dry run on this account. Run one, or choose another model for it.');
});

test('the narrative carries no account data: no holdings, positions, orders, cash, equity or account identifier (it needs no sharing switch)',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:217000,name:'Samsung'}],()=>[]);
  const snapshot={accountKey:'ACCOUNT-SECRET-123',environment:'mock',reportedTotal:9876543,cash:1234567,holdings:[{symbol:'005930',quantity:7,marketValue:1519000,cost:200000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  let sent=null;const provider={request:async(op,payload)=>{if(op==='narrative'){sent=payload;return {narrative:{summary:'s',regime:'neutral',drivers:[]},usage:{inputTokens:1,outputTokens:1},model:payload.options.openaiModel};}throw new Error('x');}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.indexCloses=()=>({});a.news=[{title:'KOSPI rises',url:'https://example.com/a',published:new Date().toISOString(),source:'x'}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:false,openaiModel:'gpt-6-sol',reasoningEffort:'medium'});live.observeBalance(snapshot);
  await a.buildNarrative();assert.ok(sent,'the narrative ran with sharing off');
  const json=JSON.stringify(sent.context);const keys=[];const walk=o=>{if(o&&typeof o==='object')for(const [k,v] of Object.entries(o)){keys.push(k);walk(v);}};walk(sent.context);
  assert.deepEqual(keys.filter(k=>/holding|position|order|cash|equity|account|balance|quantity/i.test(k)),[],'no account field: '+keys.join(','));
  for(const v of ['ACCOUNT-SECRET-123','9876543','1234567','1519000'])assert.ok(!json.includes(v),v);
});

test('reflection on Claude: its own counter and the Anthropic row in one transaction; a failure leaves both unchanged; an OpenAI reflection never touches the provider row',async()=>{
  const {LearningMemory}=require('../electron/learning-memory.cjs');const {ReflectionQueue}=require('../electron/reflection.cjs');
  // The engine first, then the sale record, memory and queue (the reflection job is created from the record).
  const setup=(extra={})=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT,approved INTEGER);CREATE TABLE trade_outcomes(id TEXT PRIMARY KEY,payload TEXT)');
    const a=new Automation(db,new PaperEngine(db,[],()=>[]),{request:async()=>({})},()=>{});a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};a.completedClaudeDryRun=()=>({id:'d'});
    a.configure({shareKisWithAnthropic:true,reflectionModel:'claude-opus-5-5',reflectionEffort:'low',reflectionEnabled:true,anthropicUSDPerDay:5,...extra});
    const memory=new LearningMemory(db);db.prepare('INSERT OR REPLACE INTO trade_outcomes VALUES(?,?)').run('one',JSON.stringify({id:'one',side:'Sell',source:'broker',accountKey:'PRIVATE',environment:'mock',market:'US',currency:'USD',symbol:'NASD:TEST',quantity:1,status:'Filled',averagePrice:100,netCash:99,fees:1,gainAfterFees:-1,signature:'v1'}));memory.sync();
    return {db,a,q:new ReflectionQueue(db,memory)};};
  const cfg=a=>({...a.config,...a.agentModel('reflection'),shareKisAllowed:a.consentFor(a.agentModel('reflection').openaiModel),providerBudget:a.reflectionProviderBudget()});
  const provider={request:async()=>({reflection:REFL,usage:{inputTokens:10,outputTokens:10},model:'claude-opus-5-5'})};
  {const {db,a,q}=setup();await q.tick(cfg(a),true,provider);await q.tick(cfg(a),true,provider);const ru=db.prepare('SELECT calls FROM reflection_usage').get();const vu=a.vendorUsage('anthropic');assert.equal(ru.calls,1);assert.equal(vu.calls,1);}
  {const {db,a,q}=setup();const c=cfg(a);c.providerBudget={...c.providerBudget,add:()=>{throw new Error('INJECTED');}};await q.tick(c,true,provider).catch(()=>{});await q.tick(c,true,provider).catch(()=>{});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reflection_usage').get().n,0,'the reflection counter rolled back');assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_vendor').get().n,0,'the provider row was not written');}
  {const {db,a,q}=setup({reflectionModel:'same',reflectionEffort:'same',openaiModel:'gpt-6-sol',reasoningEffort:'low'});assert.equal(a.reflectionProviderBudget(),null,'OpenAI: no provider budget');await q.tick({...cfg(a),shareKisAllowed:true},true,{request:async()=>({reflection:REFL,usage:{inputTokens:1,outputTokens:1},model:'gpt-6-sol'})});await q.tick({...cfg(a),shareKisAllowed:true},true,{request:async()=>({reflection:REFL,usage:{inputTokens:1,outputTokens:1},model:'gpt-6-sol'})});
    assert.equal(db.prepare('SELECT calls FROM reflection_usage').get()?.calls,1,'the OpenAI reflection ran');assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_vendor').get().n,0,'an OpenAI reflection counts only in its own table, as before');}
  {const {a,q}=setup();a.completedClaudeDryRun=()=>null;a.stateCache?.clear();let calls=0;await q.tick(cfg(a),true,{request:async()=>{calls++;return {};}});assert.equal(calls,0);assert.equal(q.reason,'Run one dry run on Claude on this account first','B3 review F1: the gate closed after the save');}
  {const {a,q}=setup({anthropicUSDPerDay:0.01});let calls=0;await q.tick(cfg(a),true,{request:async()=>{calls++;return {};}});assert.equal(calls,0);assert.equal(q.reason,'Anthropic daily limit reached');}
});

test('the provider cards say what each provider is used for now, and the Anthropic note matches B3 (gate 1.5.54 review)',async()=>{
  const {providerUses,ANTHROPIC_NOTE}=await import('../src/providerText.mjs');
  const sol={openaiModel:'gpt-6-sol'},claude={openaiModel:'claude-opus-5-5'};
  const none={trading:sol,scout:sol,narrative:sol,compacting:{openaiModel:'gpt-6-luna'},reflection:sol};
  assert.equal(providerUses('anthropic',none),'Dry run','no agent on Claude');
  assert.equal(providerUses('openai',none),'Reviews, scout, narrative, compacting, reflection');
  const some={...none,scout:claude,reflection:claude};
  assert.equal(providerUses('anthropic',some),'Scout, reflection','the agents set to Claude, as the OpenAI card lists its own');
  assert.equal(providerUses('openai',some),'Reviews, narrative, compacting');
  assert.equal(providerUses('anthropic',null),'Dry run');assert.equal(providerUses('openai',undefined),'AI reviews');
  assert.equal(ANTHROPIC_NOTE,'Claude needs this key, this sharing switch and room in these limits. The dry run can use it now. Scout, narrative, compacting and reflection can after one completed Claude dry run on this account. Trading reviews stay on OpenAI.');
  const card=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/ProviderCards.tsx'),'utf8');
  assert.ok(card.includes('providerUses(vendor,runtime?.agentModels)')&&card.includes('{ANTHROPIC_NOTE}'),'the card shows both');
  assert.ok(!/until release B3|Every other agent stays on OpenAI/.test(card),'the old texts are gone');
});
