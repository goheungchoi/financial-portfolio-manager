// Step A1 (artifacts/reviews/2026-11-12-engine-settings/plan.md): shadow evaluation and model routing are removed.
// Every review runs on the configured model; saved values of the removed settings are ignored; the stored evaluation
// records stay in place, unwritten, and the contexts they refer to are still kept from pruning. "Save near the budget"
// is now "Slow down near the budget": it doubles the interval and never changes the model.
// The regression on the live profile's 434 saved review contexts is in the step's report (scratch harness).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),path=require('node:path');const src=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const {Automation,DEFAULTS}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const REMOVED=['modelRouting','complexityThreshold','spotCheckPct','lunaMaxRuns','lunaMaxMinutes','shadowEvaluation','shadowPct','shadowUSDPerDay'];

function harness({saved=null,prepare=()=>{}}={}){
  const db=new DatabaseSync(':memory:');prepare(db);
  if(saved){db.exec('CREATE TABLE IF NOT EXISTS automation_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');db.prepare('INSERT INTO automation_settings VALUES(1,?)').run(JSON.stringify(saved));}
  const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const calls=[];let decide=()=>({action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''});
  const provider={request:async(op,payload)=>{calls.push({op,model:payload?.options?.openaiModel,effort:payload?.options?.reasoningEffort,confirmation:payload?.context?.confirmation});if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');return {decision:decide(),usage:{inputTokens:1,outputTokens:1},provider:'openai',model:payload?.options?.openaiModel};}};
  const logs=[];const a=new Automation(db,paper,provider,(id,kind,title,body)=>logs.push({kind,title,body}));a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({status:'ok'})};
  a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',autoSubmit:false,skipUnchanged:false});
  return {a,db,calls,logs,setDecision:f=>{decide=f;}};
}

test('the removed settings are gone from the defaults; saved values are ignored on load and when sent',()=>{
  for(const k of REMOVED)assert.equal(k in DEFAULTS,false,k);
  assert.equal(DEFAULTS.degradeNearBudget,true,'"Slow down near the budget" stays, on by default');assert.equal(DEFAULTS.routineModel,'gpt-6-luna','the condensing model stays');
  const saved={...Object.fromEntries(REMOVED.map(k=>[k,k==='modelRouting'?'complexity':k==='shadowEvaluation'?true:7])),openaiModel:'gpt-6-sol',reasoningEffort:'medium'};
  const {a,db}=harness({saved});for(const k of REMOVED)assert.equal(k in a.config,false,`${k} not loaded`);
  a.configure({modelRouting:'auto',shadowEvaluation:true,shadowPct:100});for(const k of REMOVED)assert.equal(k in a.config,false,`${k} not taken from the window`);
  const row=JSON.parse(db.prepare('SELECT payload FROM automation_settings WHERE id=1').get().payload);for(const k of REMOVED)assert.equal(k in row,false,`${k} not saved again`);
});

test('every trigger runs one request on the configured model; no confirmation, spot check or routing record',async()=>{
  const {a,calls,logs,setDecision}=harness();
  for(const trigger of ['Scheduled review','User request','Price movement trigger']){calls.length=0;await a.review(trigger);assert.equal(a.lastError,null,a.lastErrorDetail);
    assert.deepEqual(calls.map(c=>[c.op,c.model,c.effort]),[['decision','gpt-6-sol','medium']],trigger);}
  // A trade is decided once: no cheaper model proposes it and nothing confirms it.
  setDecision(()=>({action:'Buy',symbol:'005930',quantity:1,explanation:'Buy.',credit:'none',loanDate:''}));calls.length=0;await a.review('Scheduled review');
  assert.equal(calls.length,1);assert.equal(calls[0].confirmation,undefined);
  const row=JSON.parse(a.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get().payload);assert.equal('routing' in row,false);assert.equal(row.model,'gpt-6-sol');
  for(const gone of ['Model routing','Trade confirmation','Spot check','Spot check result','Verdict change','Cheaper model failed','Shadow review','Routing assessment skipped'])assert.ok(!logs.some(l=>l.title===gone),gone);
  assert.ok(logs.some(l=>l.title==='Model used'&&l.body==='gpt-6-sol · medium'));
});

test('near the budget the configured model still decides and the interval doubles; with the switch off it does not',async()=>{
  const {a,db,calls}=harness();a.configure({unlimitedCalls:false,maxCallsPerDay:50,unlimitedBudget:true});
  db.prepare('INSERT INTO ai_usage VALUES(?,?,?)').run(require('../electron/kis-activity.cjs').seoulDate(),40,1000);
  assert.equal(a.slowFactor(),2);await a.review('Scheduled review');assert.equal(a.lastError,null,a.lastErrorDetail);assert.deepEqual(calls.map(c=>c.model),['gpt-6-sol']);
  a.configure({degradeNearBudget:false});assert.equal(a.slowFactor(),1);
});

test('the stored evaluation records stay and are not written; the contexts they refer to are still kept from pruning',async()=>{
  const {a,db}=harness({prepare:db=>{db.exec('CREATE TABLE routing_eval(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,account TEXT,payload TEXT NOT NULL);CREATE TABLE shadow_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL,reservedMicro INTEGER NOT NULL)');
    db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('old',1,null,'{"triage":"same"}');db.prepare('INSERT INTO shadow_usage VALUES(?,?,?)').run('2026-11-10',3,1000);}});
  await a.review('Scheduled review');
  assert.deepEqual(db.prepare('SELECT id,payload FROM routing_eval').all().map(r=>({...r})),[{id:'old',payload:'{"triage":"same"}'}]);assert.equal(db.prepare('SELECT COUNT(*) n FROM shadow_usage').get().n,1);
  assert.equal(a.getState().tokenSaving.shadow,undefined,'no shadow totals in the state');
  // A new profile: no shadow_usage or routing_pass tables are created; routing_eval exists because the replay store pins by it.
  const fresh=harness();const names=fresh.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  assert.ok(!names.includes('shadow_usage')&&!names.includes('routing_pass'));assert.ok(names.includes('routing_eval'));
  // Moved from complexity.test.cjs: the pin itself (the planner's A0 decision: it stays until the records are archived to a file).
  const R=require('../electron/replay.cjs');const d=new DatabaseSync(':memory:');let t=0;const store=new R.ReplayStore(d,()=>++t);
  store.saveContext('kept',{universe:[]});d.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('kept',0,null,'{}');
  for(let i=0;i<R.LIMITS.keepContexts+5;i++)store.saveContext('c'+i,{universe:[]});assert.ok(store.context('kept'));assert.equal(store.context('c0'),null);
});

test('the routing and shadow code is gone; what other code uses stays',()=>{
  for(const f of ['electron/routing-sim.cjs','electron/evidence-anchor.cjs','scripts/routing-report.cjs','docs/ROUTING-EVALUATION.md'])assert.equal(fs.existsSync(path.join(__dirname,'..',f)),false,f);
  assert.match(src('docs/archive/ROUTING-EVALUATION.md'),/^# Model routing evaluation protocol\r?\n\r?\n> Archived 2026-11-12/);
  assert.deepEqual(Object.keys(require('../electron/complexity.cjs')).sort(),['equityKRW','marketsOf','rows','usdKrw'],'plan-gap.cjs helpers only');
  assert.equal(require('../electron/token-saver.cjs').route,undefined);assert.equal(typeof require('../electron/token-saver.cjs').nearBudget,'function');
  assert.equal(typeof require('../electron/ai-router.cjs').workerCapMs,'function','ai-router.cjs (provider by model id) stays');
  const auto=src('electron/automation.cjs');for(const gone of ['routingInputs','routingEligibility','recordRoutingPass','shadowRun','recordShadow','routingEvalState','bothRuns','saver.route('])assert.ok(!auto.includes(gone),gone);
  assert.throws(()=>require('../electron/ai-accounting.cjs').settle(new DatabaseSync(':memory:'),'shadow_usage','d','c',{},'completed'),/INVALID_USAGE_TABLE/,'nothing writes shadow usage');
  // The helpers plan-gap uses still read both list shapes (moved from complexity-shapes.test.cjs).
  const C=require('../electron/complexity.cjs');assert.deepEqual(C.rows([1]),[1]);assert.deepEqual(C.rows({items:3}),[]);assert.deepEqual(C.rows({focusRows:[2]}),[2]);assert.deepEqual(C.rows('x'),[]);
  assert.equal(C.usdKrw({macro:{indicators:{focusRows:[{name:'USD/KRW',value:1380}]}}}),1380);assert.equal(C.equityKRW({equity:1000,currency:'KRW'}),1000);
});

test('Engine settings: the shadow and routing rows are gone; "Slow down near the budget" and the condensing model remain',()=>{
  const ui=src('src/TokenSaving.tsx');for(const gone of ['Shadow evaluation','Reviews to shadow','Shadow budget','Main model from','Spot checks','Cheaper model limit','"Routine reviews"','Model routing','Save near the budget'])assert.ok(!ui.includes(gone),gone);
  assert.ok(ui.includes('<Row title="Slow down near the budget" hint="At 80% of the daily budget, scheduled reviews run half as often">'));// Step A3: the condensing model is the Context compacting agent on the Agents tab.
  const engine=src('src/EngineSettings.tsx');assert.ok(engine.includes('<Card id="eng-compacting" title="Context compacting" hint="Shrinks research results that grow too large for a review.">'));assert.ok(engine.includes('<AgentModelRows agent="compacting"'));
  const types=src('src/RuntimeSettings.tsx');for(const k of REMOVED)assert.ok(!types.includes(k+':'),k);assert.ok(!/shadow\?:\{pairs/.test(types));
});
