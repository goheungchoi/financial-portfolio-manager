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
test('live complexity routing: a hard rule or a score at the threshold uses the main model',()=>{
  const config={openaiModel:'gpt-6-sol',reasoningEffort:'medium',routineModel:'gpt-6-luna',routineEffort:'none',modelRouting:'complexity',complexityThreshold:40,degradeNearBudget:true};
  assert.equal(route(config,{trigger:'Scheduled review',complexity:{score:39}}).openaiModel,'gpt-6-luna');assert.equal(route(config,{trigger:'Scheduled review',complexity:{score:40}}).openaiModel,'gpt-6-sol');
  assert.equal(route(config,{trigger:'Scheduled review',complexity:{score:5},hardRule:'first review after starting'}).reason,'first review after starting');
});
function engine(decide,settings={}){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:50000}],()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}]);paper.saveAccount({...paper.account(),paused:false});
  const requests=[];const provider={request:async(_op,payload)=>{requests.push(payload);const r=decide(payload,requests.length);return r.toolCalls?r:{provider:'openai',model:payload.options.openaiModel,decision:r,usage:{inputTokens:100,outputTokens:10}};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>({})};
  automation.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'medium',complexityThreshold:90,spotCheckPct:0,lunaMaxRuns:2,skipUnchanged:false,...settings});return {automation,requests,db};
}
const hold=(verdict='waiting',extra={})=>({action:'Hold',symbol:'',quantity:0,explanation:'Hold.',planVerdicts:[{symbol:'005930',verdict,reason:'r'}],complexity:{score:10,reason:'quiet'},...extra});
const models=requests=>requests.map(r=>r.options.openaiModel);
test('live complexity routing keeps its hard rules and verdict-change escalation',async()=>{
  const {automation,requests}=engine(({options})=>options.openaiModel==='gpt-6-luna'?hold('passed'):hold('waiting'),{modelRouting:'complexity'});
  const first=await automation.review('Auto trading started');assert.equal(first.routing.hardRule,'first review after starting');
  const changed=await automation.review('Scheduled review');assert.deepEqual(models(requests),['gpt-6-sol','gpt-6-luna','gpt-6-sol']);assert.equal(changed.decision.planVerdicts[0].verdict,'waiting');
});
test('shadow evaluation: the cheaper model decides the same frozen inputs, its write tools change nothing, and the pair is stored',async()=>{
  const {automation,requests,db}=engine(({options})=>{if(options.openaiModel==='gpt-6-luna'&&!options.continuation)return {toolCalls:[{name:'set_review_interval',callId:'c1',args:{minutes:5,reason:'r'}},{name:'update_watchlist',callId:'c2',args:{action:'add',entries:[{symbol:'000270',reason:'r'}]}}],continuation:[{type:'function_call',call_id:'c1'}],usage:{inputTokens:5,outputTokens:1}};
    return options.openaiModel==='gpt-6-luna'?hold('passed'):hold('waiting');},{shadowEvaluation:true,shadowPct:100});
  const live=await automation.review('Scheduled review');await automation.shadowTask;
  assert.deepEqual(models(requests),['gpt-6-sol','gpt-6-luna','gpt-6-luna'],'live on the main model, then the shadow run');
  assert.deepEqual(requests[1].context,requests[0].context,'identical frozen inputs');assert.ok(!JSON.stringify(requests[1].context).includes('Hold.'),'the shadow never sees the live answer');
  const answers=requests[2].options.continuation.filter(x=>x.type==='function_call_output').map(x=>JSON.parse(x.output).status);assert.equal(answers[0],'not-applied');assert.ok(answers.every(x=>['not-applied','rejected'].includes(x)),'write tools are stubbed or refused, never applied');
  assert.equal(live.decision.planVerdicts[0].verdict,'waiting','the live decision is untouched');
  const row=JSON.parse(db.prepare('SELECT payload FROM routing_eval').get().payload);assert.equal(row.reviewId,live.id);assert.equal(row.triage,'verdict');assert.equal(row.shadow.toolRequests>=0,true);assert.equal(row.shadow.decision.planVerdicts[0].verdict,'passed');
  assert.ok(['main','cheaper'].includes(row.wouldRoute));assert.ok(Array.isArray(row.assessment.features));assert.equal(row.adjudication,null);
  assert.equal(automation.getState().tokenSaving.shadow.candidates,1);assert.ok(!automation.reviewHistory(10).some(r=>r.model==='gpt-6-luna'),'no shadow decision enters the review history');
});
