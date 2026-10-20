const test=require('node:test');const assert=require('node:assert/strict');
const {score}=require('../electron/complexity.cjs');const {route}=require('../electron/token-saver.cjs');
const {Automation}=require('../electron/automation.cjs');const {DatabaseSync}=require('node:sqlite');const {PaperEngine}=require('../electron/paper-engine.cjs');
const now=Date.parse('2026-10-21T11:00:00+09:00');
const base=(extra={})=>({markets:[{market:'KR',executionEnabled:true,marketSession:{open:true,status:'open'}}],positionSizing:{rows:[{symbol:'005930',maxShares:1}]},quotes:[{symbol:'005930',price:100,changePct:-1}],scoutPlan:{asOf:'a',targets:[{symbol:'005930'}]},universe:[{symbol:'005930'},{symbol:'NASD:META'}],...extra});
test('stakes, change since the last main-model review, and ambiguity add up, each capped',()=>{
  const quiet=score(base(),{now});assert.equal(quiet.score,18);assert.deepEqual(quiet.parts,{stakes:18,change:0,ambiguity:0});
  const moved=score(base({quotes:[{symbol:'005930',price:104,changePct:4}],marketRegime:{regime:'risk_off',components:[{name:'KOSPI advancers %',value:10},{name:'VIX 5-day change %',value:25}]}}),{previous:base({marketRegime:{regime:'neutral',components:[{name:'KOSPI advancers %',value:50}]}}),now});
  assert.ok(moved.reasons.some(r=>/005930 moved 4\.0%/.test(r)));assert.ok(moved.reasons.some(r=>/regime changed/.test(r)));assert.ok(moved.reasons.some(r=>/on the day/.test(r)));assert.ok(moved.reasons.some(r=>/VIX/.test(r)));
  assert.ok(moved.score>=50,`a sharp, changed market scores high (${moved.score})`);
  const stale=score(base({quotes:[{symbol:'005930',price:100,changePct:-5,stale:true}]}),{now});assert.ok(!stale.reasons.some(r=>/on the day/.test(r)),'stale closing moves do not count');
});
test('earnings within a day count for holdings always and for candidates only when their market can trade',()=>{
  const cal=[{date:'2026-10-21',kind:'earnings',symbol:'NASD:META'}];
  assert.ok(!score(base({eventCalendar:cal}),{now}).reasons.some(r=>/earnings/.test(r)),'U.S. not tradable now');
  const us=base({eventCalendar:cal,markets:[{market:'US',executionEnabled:true,marketSession:{open:true,session:{id:'us-daytime',regular:false}}}]});assert.ok(score(us,{now}).reasons.some(r=>/candidate \(NASD:META\)/.test(r)));
  const held=base({eventCalendar:[{date:'2026-10-22',kind:'earnings',symbol:'005930'}],positions:{'005930':{quantity:3}}});assert.ok(score(held,{now}).reasons.some(r=>/holding \(005930\)/.test(r)));
});
test('the agent rating counts fully from the main model and only upward from the cheaper one',()=>{
  const ctx=base();const rule=score(ctx,{now}).score;
  const solLow=score(ctx,{previousReview:{decision:{complexity:{score:0}},routing:{model:'gpt-6-sol'}},strongModel:'gpt-6-sol',now});assert.ok(solLow.score<rule,'the main model can lower it');
  const lunaLow=score(ctx,{previousReview:{decision:{complexity:{score:0}},routing:{model:'gpt-6-luna'}},strongModel:'gpt-6-sol',now});assert.equal(lunaLow.score,rule,'the cheaper model cannot lower it');
  const lunaHigh=score(ctx,{previousReview:{decision:{complexity:{score:100}},routing:{model:'gpt-6-luna'}},strongModel:'gpt-6-sol',now});assert.ok(lunaHigh.score>rule,'but can raise it');assert.equal(lunaHigh.agent.counted,'upward only');
});
test('complexity routing: a hard rule or a score at the threshold uses the main model',()=>{
  const config={openaiModel:'gpt-6-sol',reasoningEffort:'medium',routineModel:'gpt-6-luna',routineEffort:'none',modelRouting:'complexity',complexityThreshold:40,degradeNearBudget:true};
  assert.equal(route(config,{trigger:'Scheduled review',complexity:{score:39}}).openaiModel,'gpt-6-luna');assert.equal(route(config,{trigger:'Scheduled review',complexity:{score:40}}).openaiModel,'gpt-6-sol');
  assert.equal(route(config,{trigger:'Scheduled review',complexity:{score:5},hardRule:'first review after starting'}).reason,'first review after starting');
  assert.equal(route(config,{trigger:'User request',complexity:{score:5}}).openaiModel,'gpt-6-sol','user requests stay escalated');
});
function engine(decide){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:50000}],()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}]);paper.saveAccount({...paper.account(),paused:false});
  const requests=[];const provider={request:async(_op,payload)=>{requests.push(payload);return {provider:'openai',model:payload.options.openaiModel,decision:decide(payload,requests.length),usage:{inputTokens:100,outputTokens:10}};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.providerStatus.aiConnected=true;
  automation.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'medium',modelRouting:'complexity',complexityThreshold:90,spotCheckPct:0,lunaMaxRuns:2,skipUnchanged:false});return {automation,requests};
}
const hold=(verdict='waiting',extra={})=>({action:'Hold',symbol:'',quantity:0,explanation:'Hold.',planVerdicts:[{symbol:'005930',verdict,reason:'r'}],complexity:{score:10,reason:'quiet'},...extra});
const models=requests=>requests.map(r=>r.options.openaiModel);
test('the main model takes the first review, the cheaper model the quiet ones, and the main model again after the run limit',async()=>{
  const {automation,requests}=engine(()=>hold());
  const first=await automation.review('Auto trading started');assert.equal(first.routing.hardRule,'first review after starting');
  await automation.review('Scheduled review');await automation.review('Scheduled review');const fourth=await automation.review('Scheduled review');
  assert.deepEqual(models(requests),['gpt-6-sol','gpt-6-luna','gpt-6-luna','gpt-6-sol']);assert.match(fourth.routing.hardRule,/2 reviews in a row on the cheaper model/);
  assert.equal(typeof first.routing.complexity.score,'number');assert.deepEqual(first.decision.complexity,{score:10,reason:'quiet'});
});
test('a cheaper-model verdict change goes to the main model; spot checks use the main model when they disagree',async()=>{
  const {automation,requests}=engine(({options})=>options.openaiModel==='gpt-6-luna'?hold('passed'):hold('waiting'));
  await automation.review('Auto trading started');const changed=await automation.review('Scheduled review');
  assert.deepEqual(models(requests),['gpt-6-sol','gpt-6-luna','gpt-6-sol']);assert.equal(changed.decision.planVerdicts[0].verdict,'waiting','the main model decides');assert.equal(changed.routing.verdictChange.agreed,false);
  const buy={action:'Buy',symbol:'005930',quantity:1,explanation:'Buy.',plan:{thesis:'t',invalidation:'i',stopPrice:40000,targetPrice:60000,horizonDays:10,confidence:'medium'},planVerdicts:[{symbol:'005930',verdict:'waiting',reason:'r'}],complexity:{score:30,reason:'r'}};
  const b=engine(({options})=>options.openaiModel==='gpt-6-luna'?hold():buy);
  b.automation.configure({spotCheckPct:0});await b.automation.review('Auto trading started');b.automation.configure({spotCheckPct:100});b.requests.length=0;
  const spot=await b.automation.review('Scheduled review');assert.deepEqual(models(b.requests),['gpt-6-luna','gpt-6-sol']);assert.equal(spot.routing.spotCheck.agreed,false);assert.equal(spot.decision.action,'Buy','the main model decision is used');
  assert.equal(b.automation.getState().tokenSaving.today['spot-check'],1);
});
