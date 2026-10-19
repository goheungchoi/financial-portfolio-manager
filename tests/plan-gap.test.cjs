const test=require('node:test');const assert=require('node:assert/strict');
const {planGap,missingVerdicts}=require('../electron/plan-gap.cjs');
const context=()=>({markets:[{market:'KR',equity:10000000,cash:7000000},{market:'US',equity:2000,cash:0}],positions:{'068270':{quantity:10,market:'KR'},'NASD:NVDA':{quantity:10,market:'US'}},
  quotes:[{symbol:'068270',price:200000},{symbol:'NASD:NVDA',price:200}],universe:[{symbol:'105560',price:120000}],
  scoutPlan:{asOf:'2026-10-19T00:13:43Z',cashTargetPct:60,targets:[{symbol:'068270',name:'Celltrion',role:'candidate',targetWeightPct:15},{symbol:'105560',name:'KB',role:'candidate',targetWeightPct:10},{symbol:'NASD:NVDA',name:'NVIDIA',role:'hold',targetWeightPct:100},{symbol:'005930',name:'Samsung',role:'candidate',targetWeightPct:null}]}});
test('the gap compares each target with its own market and reports cash and invested share per market',()=>{
  const g=planGap(context());
  assert.deepEqual(g.markets,[{market:'KR',cashPct:70,investedPct:30,plannedInvestedPct:25},{market:'US',cashPct:0,investedPct:100,plannedInvestedPct:100}]);
  assert.deepEqual(g.targets.map(t=>[t.symbol,t.targetPct,t.heldPct,t.gapPct]),[['068270',15,20,-5],['105560',10,0,10],['NASD:NVDA',100,100,0],['005930',null,0,null]]);
  assert.equal(g.planCashTargetPct,60);assert.equal(planGap({...context(),scoutPlan:null}),null);
});
test('targets without a verdict are listed; no plan means nothing to list',()=>{
  assert.deepEqual(missingVerdicts(context(),{planVerdicts:[{symbol:'068270',verdict:'waiting',reason:'Earnings on 10-23'}]}),['105560','NASD:NVDA','005930']);
  assert.deepEqual(missingVerdicts({...context(),scoutPlan:null},{}),[],'no plan, nothing to account for');
});
test('verdicts are a required, validated part of the decision only when a plan with targets exists',()=>{
  const {validateDecision}=require('../electron/ai-client.cjs');
  const d=validateDecision({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.',planVerdicts:[{symbol:'068270',verdict:'waiting',reason:'Earnings first.'},{symbol:'x',verdict:'maybe',reason:'bad'}]},['068270']);
  assert.deepEqual(d.planVerdicts,[{symbol:'068270',verdict:'waiting',reason:'Earnings first.'}]);
});
test('a momentary OpenAI failure is retried once; other errors are not',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');let calls=0,fail=['AI_REQUEST_FAILED'];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>{calls++;const e=fail.shift();if(e)throw new Error(e);return {decision:{action:'Hold'}};}},()=>{});
  assert.equal((await a.decisionWithRetry({},{},1)).decision.action,'Hold');assert.equal(calls,2);
  calls=0;fail=['AI_AUTH_FAILED'];await assert.rejects(a.decisionWithRetry({},{},1),/AI_AUTH_FAILED/);assert.equal(calls,1);
  calls=0;fail=['AI_TIMEOUT','AI_TIMEOUT'];await assert.rejects(a.decisionWithRetry({},{},1),/AI_TIMEOUT/);assert.equal(calls,2,'only one retry');
});
