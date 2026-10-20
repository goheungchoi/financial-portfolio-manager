const test=require('node:test');const assert=require('node:assert/strict');
const {assess,consequence,triage}=require('../electron/complexity.cjs');const {route}=require('../electron/token-saver.cjs');
const {Automation}=require('../electron/automation.cjs');const {DatabaseSync}=require('node:sqlite');const {PaperEngine}=require('../electron/paper-engine.cjs');
const now=Date.parse('2026-10-21T11:00:00+09:00');
const base=(extra={})=>({equity:1000000,markets:[{market:'KR',currency:'KRW',equity:1000000,executionEnabled:true,marketSession:{open:true,status:'open'}}],positionSizing:{rows:[{symbol:'005930',maxShares:1,maxWeightPct:10}]},quotes:[{symbol:'005930',price:100,changePct:-1}],scoutPlan:{asOf:'a',targets:[{symbol:'005930',role:'candidate',targetWeightPct:10}]},universe:[{symbol:'005930'},{symbol:'NASD:META'}],...extra});
test('one event counts once within its group; distinct groups add; the trigger adds nothing',()=>{
  assert.equal(assess(base(),{now}).score,0,'quiet');
  const shock=base({quotes:[{symbol:'005930',price:104,changePct:4}]});const s=assess(shock,{baseline:base(),now});
  assert.equal(s.groups.price,15,'a 4% move since the baseline and 4% on the day are one event');assert.deepEqual(s.features.filter(f=>f.group==='price').map(f=>f.source).sort(),['baseline','snapshot']);
  const stressed=assess({...shock,marketRegime:{regime:'risk_off',components:[{name:'KOSPI advancers %',value:10},{name:'VIX 5-day change %',value:25}]}},{baseline:{...base(),marketRegime:{regime:'neutral',components:[{name:'KOSPI advancers %',value:50}]}},now});
  assert.equal(stressed.groups.market,8,'regime, breadth and VIX are one market picture');assert.equal(stressed.score,23,'price and market corroborate');
  assert.equal(assess({...shock,triggerEvidence:{kind:'price'}},{baseline:base(),now}).score,s.score);
  assert.ok(!assess(base({quotes:[{symbol:'005930',price:100,changePct:-5,stale:true}]}),{now}).features.length,'stale closing moves do not count');
});
test('the consequence gate uses total equity and needs a market that can trade, never a model proposal',()=>{
  const held=base({positions:{'005930':{quantity:3000,costTotal:290000,currency:'KRW'}}});
  assert.deepEqual(consequence(held).reasons,['005930 is 30% of equity']);
  assert.equal(consequence({...held,markets:[{...held.markets[0],marketSession:{open:false}}]}).gate,false,'nothing can trade now');
  assert.match(consequence(base({positionSizing:{rows:[{symbol:'005930',maxShares:1,maxWeightPct:42}]}})).reasons[0],/new 005930 position could be 42% of equity/);
  const us=consequence({markets:[{market:'KR',currency:'KRW',equity:500000,executionEnabled:false,marketSession:{open:false}},{market:'US',currency:'USD',equity:100,executionEnabled:true,marketSession:{open:true}}],macro:{indicators:[{name:'USD/KRW',value:1300}]},positions:{'NASD:A':{quantity:1,currency:'USD'}},quotes:[{symbol:'NASD:A',price:100}]});
  assert.equal(Math.round(us.largestHeldPct),21,'USD positions converted against total KRW equity');assert.equal(us.gate,true);
});
test('the previous rating only raises the score, from either model, and expires after a material change',()=>{
  const ctx=base({eventCalendar:[{date:'2026-10-21',kind:'macro',title:'FOMC decision'}]});const rule=assess(ctx,{now}).score;
  for(const model of ['gpt-6-sol','gpt-6-luna'])assert.equal(assess(ctx,{previousReview:{decision:{complexity:{score:0}},routing:{model}},now}).score,rule,`${model} cannot lower it`);
  const high={decision:{complexity:{score:90,reason:'earnings tomorrow'}},routing:{model:'gpt-6-luna'}};const raised=assess(ctx,{previousReview:high,now});assert.ok(raised.score>rule);assert.equal(raised.agent.reasons,'earnings tomorrow');
  const moved=assess(base({quotes:[{symbol:'005930',price:104,changePct:-1}]}),{baseline:base(),previousReview:high,now});assert.equal(moved.agent.expired,true);assert.equal(moved.score,moved.rule);
});
test('differences are triaged into candidates for adjudication',()=>{
  const h={action:'Hold',symbol:'',quantity:0,explanation:'a',planVerdicts:[{symbol:'005930',verdict:'waiting'}]};
  assert.equal(triage(h,h),'same');assert.equal(triage(h,{...h,explanation:'b'}),'wording');assert.equal(triage(h,{...h,planVerdicts:[{symbol:'005930',verdict:'passed'}]}),'verdict');
  const b={...h,action:'Buy',symbol:'005930',quantity:10};assert.equal(triage(h,b),'action');assert.equal(triage(b,{...b,symbol:'000270'}),'symbol');assert.equal(triage(b,{...b,quantity:7}),'size');assert.equal(triage(b,{...b,quantity:9},{equityKRW:1e6,price:100}),'same');
});
test('size triage converts U.S. prices to won before comparing with equity',()=>{
  const b={action:'Buy',symbol:'NASD:A',quantity:100,explanation:'x',planVerdicts:[]};
  assert.equal(triage(b,{...b,quantity:80},{equityKRW:1e8,priceKRW:500*1300}),'size','20 shares at $500 and 1,300 won is 13% of equity');
  assert.equal(triage(b,{...b,quantity:99},{equityKRW:1e8,priceKRW:500*1300}),'same','1 share is 0.65%');
});
const cfg={openaiModel:'gpt-6-sol',reasoningEffort:'medium',routineModel:'gpt-6-luna',routineEffort:'none',modelRouting:'complexity',complexityThreshold:40,degradeNearBudget:true};
test('routing order: shadow evaluation keeps the main model even near the budget; hard rules come before the budget fallback; complexity needs a recorded pass',()=>{
  assert.equal(route(cfg,{trigger:'Scheduled review',complexity:{score:5}}).reason,'complexity routing not validated','not eligible: main model');
  assert.equal(route(cfg,{trigger:'Scheduled review',complexity:{score:39},eligible:true}).openaiModel,'gpt-6-luna');assert.equal(route(cfg,{trigger:'Scheduled review',complexity:{score:40},eligible:true}).openaiModel,'gpt-6-sol');
  assert.equal(route(cfg,{trigger:'Scheduled review',complexity:{score:5},hardRule:'first review after starting',nearBudget:true,eligible:true}).openaiModel,'gpt-6-sol','a hard rule beats the budget fallback');
  for(const modelRouting of ['fixed','auto','complexity'])assert.equal(route({...cfg,modelRouting,shadowEvaluation:true},{trigger:'Scheduled review',complexity:{score:0},nearBudget:true,eligible:true}).openaiModel,'gpt-6-sol',`shadow evaluation forces the main model (${modelRouting})`);
});
function engine(decide,settings={}){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:50000}],()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}]);paper.saveAccount({...paper.account(),paused:false});
  const requests=[];const provider={request:async(_op,payload)=>{requests.push(payload);const r=decide(payload,requests.length);return r.toolCalls?{usage:{inputTokens:5,outputTokens:1},...r}:{provider:'openai',model:payload.options.openaiModel,decision:r,usage:{inputTokens:100,outputTokens:10}};}};
  let evidenceCalls=0;const automation=new Automation(db,paper,provider,()=>{});automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>{evidenceCalls++;await new Promise(r=>setTimeout(r,5));return {status:'available',calls:evidenceCalls};}};
  automation.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'medium',complexityThreshold:90,spotCheckPct:0,lunaMaxRuns:2,skipUnchanged:false,...settings});return {automation,requests,db,evidence:()=>evidenceCalls};
}
const hold=(verdict='waiting',extra={})=>({action:'Hold',symbol:'',quantity:0,explanation:'Hold.',planVerdicts:[{symbol:'005930',verdict,reason:'r'}],complexity:{score:10,reason:'quiet'},...extra});
const models=requests=>requests.map(r=>r.options.openaiModel);
const sim=require('../electron/routing-sim.cjs');
const validPass=a=>({verdict:'pass',prospective:true,freeze:{evaluationStart:'2026-10-21T00:00:00Z'},checks:Object.fromEntries(sim.REQUIRED_CHECKS.map(k=>[k,{pass:true}])),binding:sim.binding(a.config)});
const judgedOk=id=>({reviewId:id,outcome:'both-defensible',reason:'Both held for the same stated, evidence-based reasons.',judgedAt:'2026-10-25',missedActionChecked:true});
test('selecting complexity routing without a recorded pass keeps every review on the main model',async()=>{
  const {automation,requests}=engine(()=>hold(),{modelRouting:'complexity'});
  await automation.review('Auto trading started');const r=await automation.review('Scheduled review');assert.deepEqual(models(requests),['gpt-6-sol','gpt-6-sol']);assert.equal(r.routing.reason,'complexity routing not validated');
});
test('after a recorded pass, live complexity routing keeps its hard rules and verdict-change escalation',async()=>{
  const {automation,requests}=engine(({options})=>options.openaiModel==='gpt-6-luna'?hold('passed'):hold('waiting'),{modelRouting:'complexity'});automation.recordRoutingPass(validPass(automation));
  const first=await automation.review('Auto trading started');assert.equal(first.routing.hardRule,'first review after starting');
  const changed=await automation.review('Scheduled review');assert.deepEqual(models(requests),['gpt-6-sol','gpt-6-luna','gpt-6-sol']);assert.equal(changed.decision.planVerdicts[0].verdict,'waiting');
});
test('shadow evaluation: same frozen inputs, shared evidence, full transcripts, no side effects, its own budget',async()=>{
  const ask={name:'get_market_evidence',callId:'e1',args:{symbol:'005930',dataset:'daily_technicals'}};
  const {automation,requests,db,evidence}=engine(({options})=>{
    if(!options.continuation)return {toolCalls:options.openaiModel==='gpt-6-luna'?[ask,{name:'set_review_interval',callId:'c1',args:{minutes:5,reason:'r'}}]:[ask],continuation:[{type:'function_call',call_id:'x'}]};
    return options.openaiModel==='gpt-6-luna'?hold('passed'):hold('waiting');},{shadowEvaluation:true,shadowPct:100,modelRouting:'auto'});
  const live=await automation.review('Scheduled review');await automation.shadowTask;
  assert.deepEqual(models(requests).filter(m=>m==='gpt-6-sol').length,2,'the live review stays on the main model even with routing set to auto');assert.equal(models(requests).filter(m=>m==='gpt-6-luna').length,2);
  const first=m=>requests.find(r=>r.options.openaiModel===m&&!r.options.continuation);assert.deepEqual(first('gpt-6-luna').context,first('gpt-6-sol').context,'identical frozen inputs');
  assert.equal(evidence(),1,'the same evidence request is fetched once and shared');
  const row=JSON.parse(db.prepare('SELECT payload FROM routing_eval').get().payload);
  const ev=t=>t.find(x=>x.tool==='get_market_evidence');assert.equal(ev(row.live.transcript).key,ev(row.shadow.transcript).key);assert.notEqual(ev(row.live.transcript).reused,ev(row.shadow.transcript).reused,'one fetched, the other reused');
  assert.ok(row.evidence[ev(row.live.transcript).key].value.includes('available'),'the shared result is stored');
  const write=row.shadow.transcript.find(x=>x.tool==='set_review_interval');assert.equal(write.write,true);assert.equal(write.result.status,'not-applied');
  assert.equal(row.triage,'verdict');assert.equal(live.decision.planVerdicts[0].verdict,'waiting');
  assert.equal(db.prepare('SELECT calls FROM ai_usage').get().calls,2,'the live budget counts only live calls');assert.equal(db.prepare('SELECT calls FROM shadow_usage').get().calls,2,'shadow calls use their own allowance');
  assert.ok(!automation.reviewHistory(10).some(r=>r.model==='gpt-6-luna'),'no shadow decision enters the review history');
  automation.configure({shadowUSDPerDay:0.1});db.prepare('UPDATE shadow_usage SET reservedMicro=?').run(100000);
  await automation.review('Scheduled review');await automation.shadowTask;assert.equal(JSON.parse(db.prepare('SELECT payload FROM routing_eval ORDER BY timestamp DESC').get().payload).shadow.error,'SHADOW_BUDGET_EXHAUSTED','a spent shadow allowance stops the shadow, not the live review');
});
test('the routing simulation keeps its own baseline, streak and previous decision',()=>{
  const {simulate}=require('../electron/routing-sim.cjs');const t0=Date.parse('2026-10-24T10:00:00+09:00');const ctx={markets:[{market:'KR',currency:'KRW',equity:1e6,executionEnabled:false,marketSession:{open:false}}],quotes:[{symbol:'005930',price:100}],scoutPlan:{asOf:'p',targets:[{symbol:'005930',role:'candidate'}]}};
  const dec=v=>({action:'Hold',symbol:null,quantity:0,planVerdicts:[{symbol:'005930',verdict:v}]});
  const rec=(i,trigger='Scheduled review',luna=dec('waiting'))=>({reviewId:'r'+i,timestamp:t0+i*30*60000,account:'a',trigger,triage:'same',live:{model:'gpt-6-sol',decision:dec('waiting'),usage:{micro:80000}},shadow:{model:'gpt-6-luna',decision:luna,usage:{micro:2400}}});
  const records=[rec(0,'Auto trading started'),rec(1),rec(2),rec(3),rec(4),rec(5,'Scheduled review',dec('passed'))];
  const sim=simulate(records,{contextOf:()=>ctx,threshold:40,maxRuns:2,spotCheckPct:0,markets:['KR']});
  assert.deepEqual(sim.rows.map(r=>r.decided),['main','cheaper','cheaper','main','cheaper','main']);assert.match(sim.rows[3].reason,/2 reviews in a row/);assert.equal(sim.rows[5].escalated,'verdict change');
  assert.equal(sim.summary.savingsPct,Math.round((1-(80000*2+2400*3+82400)/(80000*6))*1000)/10);
});
test('the report applies the approved criteria: zero high misses, a 2% upper bound, coverage, a complete queue, savings',()=>{
  const {report,upperBound,audited}=require('../scripts/routing-report.cjs');
  assert.ok(upperBound(0,149)<=0.02&&upperBound(0,148)>0.02,'zero misses need 149 situations');assert.ok(Math.abs(upperBound(1,20)-0.2161)<0.001);
  assert.equal(typeof audited('r1'),'boolean');
  const out=report({records:[],contextOf:()=>null});assert.equal(out.verdict,'inconclusive','no data is not a pass');
});
test('frozen contexts behind shadow pairs survive context pruning',()=>{
  const R=require('../electron/replay.cjs');const db=new DatabaseSync(':memory:');let t=0;const store=new R.ReplayStore(db,()=>++t);
  store.saveContext('kept',{universe:[]});db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('kept',0,null,'{}');
  for(let i=0;i<R.LIMITS.keepContexts+5;i++)store.saveContext('c'+i,{universe:[]});assert.ok(store.context('kept'));assert.equal(store.context('c0'),null);
});
test('review fixes: no budget fallback without a valid pass; only a valid, current pass unlocks routing',async()=>{
  assert.equal(route({...cfg,modelRouting:'complexity'},{trigger:'Scheduled review',nearBudget:true,hardRule:'consequence: x',eligible:false}).openaiModel,'gpt-6-sol','not eligible: the budget fallback does not apply');
  const {automation}=engine(()=>hold(),{modelRouting:'complexity'});
  for(const bad of [{verdict:'fail'},{...validPass(automation),verdict:'fail'},{...validPass(automation),prospective:false},{...validPass(automation),checks:{a:{pass:false}}},{...validPass(automation),binding:{...validPass(automation).binding,code:'other'}}])assert.throws(()=>automation.recordRoutingPass(bad),/INVALID_ROUTING_PASS/);
  assert.equal(automation.routingEligibility().eligible,false);automation.recordRoutingPass(validPass(automation));assert.equal(automation.routingEligibility().eligible,true);
  automation.configure({complexityThreshold:50});assert.equal(automation.routingEligibility().eligible,false,'a settings change invalidates the pass');assert.match(automation.routingEligibility().reason,/does not match/);
});
test('review fixes: a failed cheaper model falls back to the main model live',async()=>{
  const {automation,requests}=engine(({options})=>{if(options.openaiModel==='gpt-6-luna')throw new Error('AI_SERVER_ERROR');return hold();},{modelRouting:'complexity'});automation.recordRoutingPass(validPass(automation));
  await automation.review('Auto trading started');requests.length=0;const r=await automation.review('Scheduled review');
  assert.deepEqual([...new Set(models(requests))],['gpt-6-luna','gpt-6-sol']);assert.equal(r.routing.reason,'cheaper model failed');
});
test('review fixes: the simulation applies sampled spot checks to history, keeps failures and counts missing contexts',()=>{
  const t0=Date.parse('2026-10-24T10:00:00+09:00');const ctx={markets:[{market:'KR',currency:'KRW',equity:1e6,executionEnabled:false,marketSession:{open:false}}],quotes:[]};const dec={action:'Hold',symbol:null,quantity:0,planVerdicts:[]};
  const rec=(i,extra={})=>({reviewId:'r'+i,timestamp:t0+i*1800000,account:'a',trigger:i?'Scheduled review':'Auto trading started',triage:'same',live:{model:'gpt-6-sol',decision:dec,usage:{micro:80000}},shadow:{model:'gpt-6-luna',decision:dec,usage:{micro:2400}},...extra});
  const all=sim.simulate([0,1,2,3,4,5].map(i=>rec(i)),{contextOf:()=>ctx,maxRuns:99,spotCheckPct:100,markets:['KR']});assert.equal(all.summary.cheaper,0,'100% spot checks leave nothing to the cheaper model');assert.ok(all.rows.slice(1).every(r=>r.escalated==='spot check'));
  const failed=sim.simulate([rec(0),rec(1,{shadow:{model:'gpt-6-luna',decision:null,error:'AI_TIMEOUT',usage:{micro:1000}}}),rec(2)],{contextOf:id=>id==='r2'?null:ctx,maxRuns:99,spotCheckPct:0,markets:['KR']});
  assert.equal(failed.rows[1].escalated,'cheaper model failed');assert.equal(failed.rows[1].costMicro,81000);assert.equal(failed.summary.failedShadows,1);assert.equal(failed.summary.missingContexts,1);
});
test('review fixes: the report counts only prospective live records after the freeze, and only fully adjudicated situations',()=>{
  const {report}=require('../scripts/routing-report.cjs');const t0=Date.parse('2026-10-24T10:00:00+09:00');const b=sim.binding({...require('../electron/automation.cjs').DEFAULTS,spotCheckPct:0});
  const ctx={markets:[{market:'KR',currency:'KRW',equity:1e6,executionEnabled:false,marketSession:{open:false}}],quotes:[]};const dec={action:'Hold',symbol:null,quantity:0,planVerdicts:[]};
  const rec=(i,extra={})=>({reviewId:'r'+i,timestamp:t0+i*1800000,account:'acct',environment:'kis-combined',provenance:{broker:'live',connection:'live'},binding:b,trigger:i?'Scheduled review':'Auto trading started',triage:'same',live:{model:'gpt-6-sol',decision:dec,usage:{micro:80000}},shadow:{model:'gpt-6-luna',decision:dec,usage:{micro:2400}},...extra});
  assert.equal(report({records:[rec(0)],contextOf:()=>ctx}).verdict,'inconclusive','no freeze, no pass');
  const freeze={evaluationStart:new Date(t0).toISOString(),binding:b};
  const paperOnly=[0,1,2,3].map(i=>rec(i,{account:'paper',environment:'local-paper',provenance:{broker:'paper',connection:'paper'}}));const p=report({records:paperOnly,contextOf:()=>ctx,freeze,currentBinding:b});
  assert.notEqual(p.verdict,'pass');assert.equal(p.supplementary.records,4);assert.equal(p.simulation.reviews,0,'paper records never count');
  const r=report({records:[rec(-1),rec(0),rec(1),rec(2)],contextOf:()=>ctx,freeze,currentBinding:b});assert.equal(r.simulation.reviews,3,'records before the freeze are excluded');
  assert.equal(r.checks.highSeverity.pass,false,'unjudged cheaper situations do not count as successes');assert.match(r.checks.highSeverity.detail,/in 0 fully adjudicated/);
  const judged=report({records:[rec(0),rec(1),rec(2)],contextOf:()=>ctx,freeze,currentBinding:b,adjudications:['r1','r2'].map(judgedOk)});assert.match(judged.checks.highSeverity.detail,/in 1 fully adjudicated/);
  assert.equal(report({records:[rec(0)],contextOf:()=>ctx,freeze,currentBinding:{...b,threshold:99}}).checks.bindingCurrent.pass,false);
});
test('third review: a pass needs every named check; blank adjudications stay pending; mock accounts never count',()=>{
  const {automation}=engine(()=>hold(),{modelRouting:'complexity'});const ok=validPass(automation);
  for(const checks of [{},{bindingCurrent:{pass:true}},{...ok.checks,savings:{pass:false}}])assert.throws(()=>automation.recordRoutingPass({...ok,checks}),/INVALID_ROUTING_PASS/);
  assert.throws(()=>automation.recordRoutingPass({...ok,freeze:{evaluationStart:'not a date'}}),/INVALID_ROUTING_PASS/);
  const {report,validAdjudication}=require('../scripts/routing-report.cjs');
  assert.equal(validAdjudication({reviewId:'r1'}),false);assert.equal(validAdjudication(judgedOk('r1')),true);
  assert.equal(validAdjudication({...judgedOk('r1'),outcome:'sol-better'}),false,'a worse side needs category and severity');
  assert.equal(validAdjudication({...judgedOk('r1'),outcome:'sol-better',category:'missed-action',severity:'high'}),false,'high severity needs the user');
  assert.equal(validAdjudication({...judgedOk('r1'),outcome:'sol-better',category:'missed-action',severity:'high',confirmedByUser:true}),true);
  const t0=Date.parse('2026-10-24T10:00:00+09:00');const b=sim.binding({...require('../electron/automation.cjs').DEFAULTS,spotCheckPct:0});const ctx={markets:[{market:'KR',currency:'KRW',equity:1e6,executionEnabled:false,marketSession:{open:false}}],quotes:[]};const dec={action:'Hold',symbol:null,quantity:0,planVerdicts:[]};
  const rec=(i,prov)=>({reviewId:'r'+i,timestamp:t0+i*1800000,account:'acct',provenance:prov,binding:b,trigger:i?'Scheduled review':'Auto trading started',triage:'same',live:{model:'gpt-6-sol',decision:dec,usage:{micro:80000}},shadow:{model:'gpt-6-luna',decision:dec,usage:{micro:2400}}});
  const freeze={evaluationStart:new Date(t0).toISOString(),binding:b};
  const blank=report({records:[0,1,2].map(i=>rec(i,{broker:'live',connection:'live'})),contextOf:()=>ctx,freeze,currentBinding:b,adjudications:['r1','r2'].map(id=>({reviewId:id}))});
  assert.match(blank.checks.highSeverity.detail,/in 0 fully adjudicated/,'blank records are not judgments');assert.match(blank.checks.adjudicationComplete.detail,/2 incomplete records ignored/);
  for(const prov of [{broker:'mock',connection:'mock'},{broker:'unknown',connection:'unknown'},undefined,{broker:'live',connection:'mock'}]){const r=report({records:[0,1,2].map(i=>rec(i,prov)),contextOf:()=>ctx,freeze,currentBinding:b});assert.equal(r.simulation.reviews,0,JSON.stringify(prov));assert.equal(r.supplementary.records,3);}
});
test('third review: the simulation runs the live routing function, escalations included, and validated routing has no budget fallback',()=>{
  const t0=Date.parse('2026-10-24T10:00:00+09:00');const ctx={markets:[{market:'KR',currency:'KRW',equity:1e6,executionEnabled:false,marketSession:{open:false}}],quotes:[]};const dec={action:'Hold',symbol:null,quantity:0,planVerdicts:[]};
  const rec=(i,routeInputs={},trigger='Scheduled review')=>({reviewId:'r'+i,timestamp:t0+i*1800000,account:'a',trigger:i?trigger:'Auto trading started',routeInputs,triage:'same',live:{model:'gpt-6-sol',decision:dec,usage:{micro:80000}},shadow:{model:'gpt-6-luna',decision:dec,usage:{micro:2400}}});
  const out=sim.simulate([rec(0),rec(1,{emergencyActive:true}),rec(2,{},'User request'),rec(3,{triggerEvidence:{kind:'news',events:[{importance:'high'}]}}),rec(4,{nearBudget:true})],{contextOf:()=>ctx,maxRuns:99,spotCheckPct:0,markets:['KR']}).rows;
  assert.deepEqual(out.map(r=>r.reason),['first review after starting','emergency','user request','important disclosure','complexity 0 < 40']);
  const live={...cfg,modelRouting:'complexity'};assert.equal(route(live,{trigger:'Scheduled review',complexity:{score:90},nearBudget:true,eligible:true}).openaiModel,'gpt-6-sol','near the budget a high score still uses the main model');
  assert.equal(route({...cfg,modelRouting:'fixed'},{trigger:'Scheduled review',nearBudget:true}).openaiModel,'gpt-6-luna','the budget fallback remains for the other modes');
});
