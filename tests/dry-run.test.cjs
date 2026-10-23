const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
// A KIS-scope automation with a fake provider: queued replies script the model's tool calls and decision.
function harness(){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const events=[];const queue=[];
  const provider={request:async(op,payload)=>{supplied.push([op,payload]);const next=queue.shift();return next?next(payload):{decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const automation=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({id,kind,title,body}));automation.live=live;automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>({})};
  automation.series={closes:()=>null,ensure:async()=>{}};automation.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});
  const calls={propose:0,submit:0};for(const k of ['propose','autoSubmit','submit']){const orig=live[k].bind(live);live[k]=(...args)=>{calls[k==='propose'?'propose':'submit']++;return orig(...args);};}
  return {automation,supplied,events,queue,db,calls};
}
const TABLES=['agent_notes','agent_triggers','conditional_orders','review_watches','review_intervals','reviews','live_intents','paper_orders','lessons','routing_eval','scout_briefs'];
const counts=db=>Object.fromEntries(TABLES.map(t=>{try{return [t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n];}catch{return [t,null];}}));
const call=(name,args,id)=>({name,callId:id,args});
test('checking inputs builds the review inputs through the normal path and makes no AI call',async()=>{
  const {automation,supplied,db,calls}=harness();const before=counts(db);const lastRun=automation.lastRun;
  const r=await automation.dryRun('inputs');
  assert.equal(supplied.filter(([op])=>op==='decision').length,0,'no AI call');assert.equal(r.mode,'inputs');assert.equal(r.review,undefined);
  assert.deepEqual(r.summary.positions,[{symbol:'005930',quantity:10}]);assert.deepEqual(r.summary.openOrders,[]);assert.equal(r.summary.orderReconciliation,null);
  assert.equal(r.summary.conditionalOrders.monitoring,'inactive: auto trading is paused, so armed orders do not fire until it is started');
  assert.deepEqual(counts(db),before,'nothing else changed');assert.equal(automation.lastRun,lastRun,'the schedule is untouched');assert.deepEqual(calls,{propose:0,submit:0});
  assert.equal(automation.dryRuns()[0].id,r.id);
});
test('a dry-run review answers every state-changing tool with not applied and never proposes or submits',async()=>{
  const {automation,supplied,events,queue,db,calls}=harness();const before=counts(db);const lastRun=automation.lastRun;
  queue.push(()=>({toolCalls:[
    call('save_note',{action:'set',symbol:'005930',note:'x',expiresInDays:7},'n'),
    call('set_review_trigger',{action:'add',id:'',name:'t',conditions:[{expr:'price("005930")',op:'>=',value:1}],combine:'all',expiresInHours:1,reason:'r'},'t'),
    call('set_conditional_order',{action:'add',id:'',symbol:'005930',side:'Sell',quantity:1,limitPrice:null,purpose:'stop-loss',conditions:[{expr:'price("005930")',op:'<=',value:1}],combine:'all',expiresInHours:1,reason:'r'},'c'),
    call('set_review_watch',{symbol:'005930',kind:'price',above:300000,below:null,reason:'r'},'w')],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}}));
  queue.push(()=>({decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Would buy one.',credit:'none',loanDate:'',plan:{thesis:'t',invalidation:'i',stopPrice:200000,targetPrice:null,horizonDays:30,confidence:'low'}},usage:{inputTokens:1,outputTokens:1},provider:'openai'}));
  const r=await automation.dryRun('review');
  const outputs=supplied.filter(([op])=>op==='decision')[1][1].options.continuation.filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output));
  assert.equal(outputs.length,4);assert.ok(outputs.every(o=>o.status==='not-applied'&&/Dry run/.test(o.reason)),JSON.stringify(outputs));
  assert.equal(r.review.decision.action,'Buy');assert.equal(r.review.calls,2);
  assert.deepEqual(calls,{propose:0,submit:0},'order submission is never reached');assert.deepEqual(counts(db),before,'no notes, triggers, conditional orders, watches, reviews, orders, lessons or evaluation records');
  assert.equal(automation.lastRun,lastRun);assert.equal(automation.reviewHistory(10,true).length,0,'not in the journal');
  const accounted=db.prepare('SELECT payload FROM ai_calls').all().map(x=>JSON.parse(x.payload));assert.equal(accounted.length,2);assert.ok(accounted.every(c=>c.kind==='dry-run'),'cost is accounted as usual, tagged dry-run');
  assert.ok(events.some(e=>e.title==='Dry-run review · nothing applied'));
});
test('dry runs refuse while a review is running and outside KIS',async()=>{
  const {automation}=harness();automation.busy=true;await assert.rejects(automation.dryRun('inputs'),/REVIEW_BUSY/);automation.busy=false;
  await assert.rejects(automation.dryRun('other'),/INVALID_REQUEST/);automation.configure({scope:'paper'});await assert.rejects(automation.dryRun('inputs'),/DRY_RUN_NEEDS_KIS/);
});
