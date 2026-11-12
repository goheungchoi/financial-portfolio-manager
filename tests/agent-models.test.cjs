// Per-agent model and effort (step A2, artifacts/reviews/2026-11-12-engine-settings/plan.md): one resolver for the
// trading review, scout, market narrative, context compacting and post-trade reflection. On an upgraded profile every
// agent resolves to what it ran on before; each agent's requests, AI call records and budget reservations use its
// resolved model.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const M=require('../electron/agent-models.cjs');const {Automation,DEFAULTS}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const models=require('../electron/ai-models.cjs');
const pair=(openaiModel,reasoningEffort)=>({openaiModel,reasoningEffort});

// What each agent ran on at 410d5b6, written out from that code: the trading model and effort for the review and
// reflection, the same with 'none' raised to 'low' for the scout and the narrative, and routineModel/routineEffort for
// compacting.
const before=c=>({trading:pair(c.openaiModel,c.reasoningEffort),scout:pair(c.openaiModel,c.reasoningEffort==='none'?'low':c.reasoningEffort),narrative:pair(c.openaiModel,c.reasoningEffort==='none'?'low':c.reasoningEffort),compacting:pair(c.routineModel,c.routineEffort),reflection:pair(c.openaiModel,c.reasoningEffort)});

test('the defaults follow the trading agent; compacting keeps its own model; the agents are the five in the plan',()=>{
  assert.deepEqual(M.AGENTS,['trading','scout','narrative','compacting','reflection']);
  for(const k of ['scoutModel','scoutEffort','narrativeModel','narrativeEffort','reflectionModel','reflectionEffort'])assert.equal(DEFAULTS[k],'same',k);
  assert.equal(DEFAULTS.routineModel,'gpt-6-luna');assert.equal(DEFAULTS.routineEffort,'none');
});

test('an upgraded profile: every agent resolves to what it ran on before, for every trading model and effort',()=>{
  for(const [model,efforts] of [['gpt-6-luna',['none','low','medium','high']],['gpt-6-sol',['none','low','medium','high']],['gpt-6-astra',['low','medium','high']]])
    for(const effort of efforts)for(const [rm,re] of [['gpt-6-luna','none'],['gpt-6-sol','low'],['gpt-6-astra','high']]){
      // A saved row from before A2 has none of the new keys: loading fills them from DEFAULTS.
      const saved={openaiModel:model,reasoningEffort:effort,routineModel:rm,routineEffort:re};const config={...DEFAULTS,...saved};
      assert.deepEqual(M.agentModels(config),before(config),`${model} ${effort}, compacting ${rm} ${re}`);}
});

test('the live profile as saved loads with every agent on its model of today',()=>{
  // The live settings row (A0 copy): gpt-6-sol medium, routine gpt-6-luna none, none of the new keys.
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE automation_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');
  db.prepare('INSERT INTO automation_settings VALUES(1,?)').run(JSON.stringify({provider:'openai',scope:'both',openaiModel:'gpt-6-sol',reasoningEffort:'medium',routineModel:'gpt-6-luna',routineEffort:'none',modelRouting:'fixed',shadowEvaluation:false,degradeNearBudget:true}));
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  assert.deepEqual(a.getState().agentModels,{trading:pair('gpt-6-sol','medium'),scout:pair('gpt-6-sol','medium'),narrative:pair('gpt-6-sol','medium'),compacting:pair('gpt-6-luna','none'),reflection:pair('gpt-6-sol','medium')});
});

test('choices: a model of its own, an effort of its own, or both; "same" follows a later change of the trading agent',()=>{
  const c={...DEFAULTS,openaiModel:'gpt-6-sol',reasoningEffort:'medium'};
  assert.deepEqual(M.agentModel({...c,scoutModel:'gpt-6-luna'},'scout'),pair('gpt-6-luna','medium'),'own model, trading effort');
  assert.deepEqual(M.agentModel({...c,narrativeEffort:'high'},'narrative'),pair('gpt-6-sol','high'),'trading model, own effort');
  assert.deepEqual(M.agentModel({...c,reflectionModel:'gpt-6-luna',reflectionEffort:'none'},'reflection'),pair('gpt-6-luna','none'));
  assert.deepEqual(M.agentModel({...c,routineModel:'same',routineEffort:'same'},'compacting'),pair('gpt-6-sol','medium'),'compacting may follow too');
  assert.deepEqual(M.agentModel({...c,openaiModel:'gpt-6-astra',reasoningEffort:'high'},'scout'),pair('gpt-6-astra','high'));
  assert.deepEqual(M.agentModel({...c,scoutModel:'gpt-6-luna',reasoningEffort:'none'},'scout'),pair('gpt-6-luna','low'),'the raise applies to a followed effort');
  assert.throws(()=>M.agentModel(c,'other'),/UNKNOWN_AGENT/);
});

function automation(){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:70000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const provider={request:async(op,payload)=>{supplied.push({op,options:payload?.options});const model=payload?.options?.openaiModel;
    if(op==='scout')return {plan:{summary:'Hold cash.',cashTargetPct:50,focus:'f',targets:[]},usage:{inputTokens:10,outputTokens:5},model};
    if(op==='narrative')return {narrative:{summary:'Quiet.',regime:'neutral',drivers:[]},usage:{inputTokens:10,outputTokens:5},model};
    if(op==='compact')return {summary:'short',usage:{inputTokens:10,outputTokens:5},model};
    return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai',model};}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({status:'ok'})};a.series={closes:()=>null,ensure:async()=>{}};
  a.discovery={list:()=>[],symbols:()=>[],screen_market:async()=>({rows:[]}),search_securities:async()=>({rows:[]}),research:async()=>({status:'unavailable'}),update_watchlist:async()=>({results:[]})};
  a.indexCloses=()=>({});a.news=[];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',skipUnchanged:false,scoutModel:'gpt-6-luna',scoutEffort:'high',narrativeModel:'gpt-6-astra',narrativeEffort:'same',routineModel:'gpt-6-sol',routineEffort:'low',reflectionModel:'gpt-6-luna',reflectionEffort:'none'});
  const calls=()=>db.prepare('SELECT payload FROM ai_calls ORDER BY rowid').all().map(r=>JSON.parse(r.payload));
  return {a,db,supplied,calls};
}

test('each agent sends, records and reserves with its own resolved model',async()=>{
  const {a,supplied,calls}=automation();
  await a.review('User request');assert.equal(a.lastError,null,a.lastErrorDetail);
  await a.scout();await a.buildNarrative();await a.compactResearch('r1',{items:['x']});
  const by=op=>supplied.filter(s=>s.op===op).map(s=>pair(s.options.openaiModel,s.options.reasoningEffort));
  assert.deepEqual(by('decision'),[pair('gpt-6-sol','medium')],'trading');assert.deepEqual(by('scout'),[pair('gpt-6-luna','high')],'scout');
  assert.deepEqual(by('narrative'),[pair('gpt-6-astra','medium')],'narrative: own model, the trading effort');assert.deepEqual(by('compact'),[pair('gpt-6-sol','low')],'compacting');
  // The AI call records (cost history and the daily budget) carry the same model, and the reservation is the one for it.
  const recorded=calls();
  for(const [kind,p] of [['scout',pair('gpt-6-luna','high')],['narrative',pair('gpt-6-astra','medium')],['compact',pair('gpt-6-sol','low')]]){
    const r=recorded.find(x=>x.kind===kind);assert.ok(r,kind+' recorded');assert.deepEqual(pair(r.model,r.reasoningEffort),p,kind);}
  assert.ok(recorded.some(r=>!r.kind&&r.model==='gpt-6-sol'&&r.reasoningEffort==='medium'),'the review call');
  const compact=recorded.find(x=>x.kind==='compact');assert.equal(compact.reservedMicro,models.reservation(pair('gpt-6-sol','low'),{items:['x']},{maxBytes:400000}),'reserved for the compacting model');
});

test('post-trade reflection receives its resolved model; the reflection worker records and reserves with it',()=>{
  const {a}=automation();let given=null;a.reflections.tick=async config=>{given=config;};a.learningError=null;a.busy=false;a.backgroundPaused=false;
  try{a.tick();}catch{}
  assert.ok(given,'the worker was called');assert.deepEqual(pair(given.openaiModel,given.reasoningEffort),pair('gpt-6-luna','none'));
  assert.equal(given.reflectionCallsPerDay,a.config.reflectionCallsPerDay,'the rest of the configuration is passed unchanged');assert.equal(a.config.openaiModel,'gpt-6-sol','the saved trading model is untouched');
  // reflection.cjs reads config.openaiModel and config.reasoningEffort for the request, the call record and the reservation.
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/reflection.cjs'),'utf8');
  assert.match(src,/models\.reservation\(config,context\)/);assert.match(src,/model:config\.openaiModel,reasoningEffort:config\.reasoningEffort,reservedMicro:reserve/);assert.match(src,/options:\{openaiModel:config\.openaiModel,reasoningEffort:config\.reasoningEffort\}/);
});

test('settings are checked on every agent\'s resolved model; a refused change saves nothing',()=>{
  const {a}=automation();const saved=JSON.stringify(a.config);
  const refused=[
    [{scoutModel:'gpt-7'},/INVALID_MODEL_SETTINGS/],[{scoutModel:''},/INVALID_SETTINGS/],[{narrativeEffort:'max'},/INVALID_SETTINGS/],
    [{narrativeEffort:'none'},/INVALID_SETTINGS/],[{scoutEffort:'none'},/INVALID_SETTINGS/],
    [{reflectionModel:'claude-opus-5-5',reflectionEffort:'low'},/CLAUDE_NOT_ENABLED_FOR_TRADING/],[{routineModel:'claude-opus-5-5',routineEffort:'low'},/CLAUDE_NOT_ENABLED_FOR_TRADING/],
    [{routineModel:'gpt-6-astra',routineEffort:'none'},/INVALID_MODEL_SETTINGS/],
    // Reflection follows the trading model with its own effort 'none': moving the trading agent to Astra (no 'none') is refused.
    [{reflectionModel:'same',reflectionEffort:'none',openaiModel:'gpt-6-astra',reasoningEffort:'low'},/INVALID_MODEL_SETTINGS/],
  ];
  for(const [change,why] of refused){assert.throws(()=>a.configure(change),why,JSON.stringify(change));assert.equal(JSON.stringify(a.config),saved,JSON.stringify(change)+': nothing saved');}
  a.configure({routineModel:'same',routineEffort:'same',scoutModel:'same',scoutEffort:'same'});assert.deepEqual(a.getState().agentModels.compacting,pair('gpt-6-sol','medium'));
  a.configure({openaiModel:'gpt-6-astra',reasoningEffort:'high'});assert.deepEqual(a.getState().agentModels.scout,pair('gpt-6-astra','high'),'"same" follows the trading change');
});
