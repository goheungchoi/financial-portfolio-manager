const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {ScheduleObserver,reasons,decisionChanges}=require('../electron/schedule-observer.cjs');
const T=Date.parse('2026-10-23T09:00:00+09:00'),M=60000;
const kr=(at,open=true)=>({KR:{open,startAt:T,endAt:T+390*M}});
const state=(at,extra={})=>({at,markets:kr(at),prices:{'028050':60300},watched:['028050'],holdings:{'028050':3},orders:[],reconciliation:null,regime:'risk_off',stories:[],scoutPlanAsOf:1,...extra});
const rules=list=>list.map(r=>r.rule);
test('moves are measured from the last proposed run, so small moves add up and are timed when observed',()=>{
  const o=new ScheduleObserver(new DatabaseSync(':memory:'),{clock:()=>0});o.observe(state(T+5*M));
  assert.deepEqual(o.observe(state(T+10*M,{prices:{'028050':60300*1.006}})),[]);assert.deepEqual(o.observe(state(T+15*M,{prices:{'028050':60300*1.012}})),[]);
  const why=o.observe(state(T+20*M,{prices:{'028050':60300*1.018}}));assert.deepEqual(rules(why),['price move']);assert.equal(why[0].pct,1.8,'three 0.6% moves cross 1.5% together');
  const run=o.db.prepare("SELECT payload FROM schedule_observations WHERE kind='proposed-run' ORDER BY at DESC").get();assert.equal(JSON.parse(run.payload).at,T+20*M,'the crossing time, not a later review');assert.equal(JSON.parse(run.payload).minutesSinceLast,15);
});
test('session open, the closing window and the backstop use live times; account and order changes fire',()=>{
  const base=state(T-10*M,{markets:kr(T-10*M,false)});
  assert.deepEqual(rules(reasons(base,state(T+M))),['session open']);
  const mid=state(T+300*M);assert.deepEqual(rules(reasons(mid,state(T+361*M))),['session close']);
  assert.deepEqual(rules(reasons(state(T+100*M),state(T+190*M))),['backstop']);assert.deepEqual(reasons(state(T+100*M),state(T+189*M)),[]);
  assert.deepEqual(reasons(state(T+100*M,{markets:kr(0,false)}),state(T+300*M,{markets:kr(0,false)})),[],'no backstop while markets are closed');
  assert.deepEqual(rules(reasons(state(T),state(T+M,{holdings:{'028050':6}}))),['holdings changed']);
  assert.deepEqual(rules(reasons(state(T),state(T+M,{orders:[{id:'o1',status:'Accepted',filled:0}]}))),['orders changed']);
  assert.deepEqual(rules(reasons(state(T),state(T+M,{reconciliation:'unconfirmed'}))),['order confirmation changed']);
  assert.deepEqual(rules(reasons(state(T),state(T+M,{regime:'neutral'}))),['regime change']);assert.deepEqual(rules(reasons(state(T),state(T+M,{scoutPlanAsOf:2}))),['new scout plan']);
});
test('only relevant top stories count',()=>{
  assert.deepEqual(reasons(state(T),state(T+M,{stories:[{key:'보령',relevant:false}]})),[],'unrelated story');
  assert.deepEqual(rules(reasons(state(T),state(T+M,{stories:[{key:'사이드카',relevant:true}]}))),['new top story']);
  assert.deepEqual(reasons(state(T,{stories:[{key:'사이드카',relevant:true}]}),state(T+M,{stories:[{key:'사이드카',relevant:true}]})),[],'not new');
});
test('decision changes separate material from wording; the summary reports savings and uncovered material reassessments apart',()=>{
  const v=(verdict,kind,recheck='next session')=>({symbol:'028050',verdict,condition:{kind,unresolved:'u',evidence:'e',recheck},dataGap:null});
  const hold=(verdicts,plan={thesis:'t',invalidation:'i'})=>({decision:{action:'Hold',symbol:'',quantity:0,planVerdicts:verdicts,plan}});
  assert.deepEqual(decisionChanges(hold([v('waiting','market')]),hold([v('waiting','event')])).material,['028050 condition market → event']);
  assert.deepEqual(decisionChanges(hold([v('waiting','market')]),hold([v('waiting','market','Oct 29')],{thesis:'t2',invalidation:'i'})),{material:[],text:['028050 recheck','thesis']});
  assert.deepEqual(decisionChanges(hold([]),{decision:{action:'Buy',symbol:'028050',quantity:3,planVerdicts:[]}}).material,['trade Hold → Buy 028050 3']);
  const db=new DatabaseSync(':memory:');const o=new ScheduleObserver(db);o.observe(state(T));
  o.recordReview({id:'r1',timestamp:T+M,trigger:'Scheduled review',...hold([v('waiting','market')])},0.1);
  o.recordReview({id:'r2',timestamp:T+20*M,trigger:'Scheduled review',...hold([v('passed','none')])},0.12);
  o.recordReview({id:'r3',timestamp:T+40*M,trigger:'Scheduled review',...hold([v('passed','none','later')])},0.08);
  const s=o.summary(0);assert.equal(s.actualReviews,3);assert.equal(s.proposedRuns,1);assert.equal(s.actualCostUSD,0.3);assert.equal(s.projectedCostUSD,0.1,'one proposed run at the median cost');
  assert.deepEqual(s.uncoveredMaterial.map(r=>r.reviewId),['r2'],'a verdict change the proposed schedule would have skipped');assert.equal(s.uncoveredTextOnly,1);assert.equal(s.uncovered,2);
});
test('in the app, observation records only: no AI or broker calls, no schedule change, nothing in review inputs',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'S',quantity:10,cost:200000,price:217000}]};
  let brokerCalls=0;const live=new LiveEngine(db,{request:async()=>{brokerCalls++;return {balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}};}},()=>({status:'connected',snapshot}));
  const supplied=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:1}],()=>[]),{request:async(op,p)=>{supplied.push(op);return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}},()=>{});
  a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',enabled:true,narrativeEnabled:false,scoutEnabled:false});a.sessionArmed=true;
  const lastRun=a.lastRun,next=a.nextReviewAt();a.tick();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schedule_observations WHERE kind='proposed-run'").get().n,1,'first observation recorded');
  assert.equal(supplied.length,0,'no AI call');assert.equal(brokerCalls,0,'no broker call');assert.equal(a.lastRun,lastRun);assert.equal(a.nextReviewAt(),next,'the schedule is unchanged');
  await a.review('User request');assert.equal(db.prepare("SELECT COUNT(*) n FROM schedule_observations WHERE kind='proposed-run'").get().n,2,'an event-triggered review is a proposed run');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schedule_observations WHERE kind='review'").get().n,1,'the actual review is logged');
  const ctx=JSON.parse(db.prepare('SELECT payload FROM review_contexts').get()?.payload??'{}');assert.ok(!/schedule_observation|proposed-run|scheduleObserver/.test(JSON.stringify(ctx)),'nothing reaches review inputs');
});
