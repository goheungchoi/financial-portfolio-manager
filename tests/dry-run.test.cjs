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
  assert.deepEqual(r.summary.positions.map(p=>[p.symbol,p.quantity]),[['005930',10]]);assert.deepEqual(r.summary.openOrders,[]);assert.equal(r.summary.orderReconciliation,null);
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
// A KIS-scope automation whose engine is a stub, so a normal review can reach order proposal and submission.
function engineHarness(){
  const h=harness();const calls={propose:[],submit:[]};
  const ctx=()=>({environment:'kis',market:'KR',currency:'KRW',executionEnabled:true,automaticExecutionEnabled:true,marketSession:{open:true,status:'open'},equity:10000000,cash:5000000,positions:{},
    universe:[{symbol:'005930',name:'Samsung',price:217000}],quotes:[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now(),stale:false}],orders:[],
    risk:{symbols:[],anyStock:true,maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,baseline:10000000,dayPeakEquity:10000000,lossLimit:{mode:'off',value:0}}});
  h.automation.live={identity:()=>'acct',autoEnabled:true,enabled:true,market:'KR',context:async()=>ctx(),orderReconciliation:()=>null,propose:cmd=>{calls.propose.push(cmd);return {id:'P1',status:'Ready'};},autoSubmit:async id=>{calls.submit.push(id);return {id:'O1',status:'Accepted'};},getState:()=>({}),orders:()=>[]};
  return {...h,calls};
}
const buy={decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Buy one.',credit:'none',loanDate:'',plan:{thesis:'t',invalidation:'i',stopPrice:200000,targetPrice:240000,horizonDays:30,confidence:'medium'}},usage:{inputTokens:1,outputTokens:1},provider:'openai'};
test('after the shared-input refactor a normal review still reaches proposal and submission, recording its trigger and lessons',async()=>{
  const {automation,supplied,queue,calls}=engineHarness();queue.push(()=>buy);
  await automation.review('Scheduled review');
  assert.equal(calls.propose.length,1,'proposed');assert.deepEqual(calls.submit,['P1'],'submitted');
  const r=automation.reviewHistory(1,true)[0];assert.equal(r.trigger,'Scheduled review');assert.ok(Array.isArray(r.contextEvidence.lessonIds),'lesson ids recorded');
  const given=supplied.find(([op])=>op==='decision')[1].context;assert.equal(given.agentDesk.conditionalOrders.monitoring.startsWith('inactive'),true,'paused: monitoring stated inactive');
});
test('a dry run is never the next review\'s baseline and never reaches the engine',async()=>{
  const {automation,queue,calls}=engineHarness();await automation.review('Scheduled review');const baseline=automation.lastFingerprint;assert.ok(baseline);
  queue.push(()=>buy);const r=await automation.dryRun('review');assert.equal(r.review.decision.action,'Buy');
  assert.equal(automation.lastFingerprint,baseline,'the skip baseline is still the last real review');assert.deepEqual(calls,{propose:[],submit:[]});
});
test('conditional-order monitoring is stated active only when orders can actually fire',async()=>{
  const {automation}=harness();assert.equal(automation.conditionalMonitoringActive(),false,'paused');
  automation.configure({enabled:true});automation.sessionArmed=true;assert.equal(automation.conditionalMonitoringActive(),true);assert.equal(automation.deskState().monitoringActive,true);
  automation.configure({scope:'paper'});assert.equal(automation.conditionalMonitoringActive(),false,'the paper account never fires them');
});
test('checking inputs reports the assembled snapshot and keeps the full inputs for inspection; the estimate shows budget impact',async()=>{
  const {automation,db}=harness();const r=await automation.dryRun('inputs');const s=r.summary;
  assert.ok(Date.parse(s.assembledAt)>0);assert.equal(s.scope,'kis');assert.equal(s.account?.label,'KIS mock');assert.equal(s.environment,'kis');assert.equal(s.sessions.KR,'open');
  assert.equal(s.quotes.count,1);assert.ok(s.quotes.newest);assert.deepEqual(s.positions.map(p=>[p.symbol,p.quantity,p.price]),[['005930',10,217000]]);
  const stored=JSON.parse(db.prepare('SELECT payload FROM dry_runs WHERE id=?').get(r.id).payload);assert.ok(stored.snapshot.universe.length>0,'full inputs saved');assert.equal('snapshot' in automation.dryRuns()[0],false,'not sent to the screen');
  db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('a','2026-10-23',JSON.stringify({reviewId:'r1',model:'gpt-6-sol',status:'completed',accountedMicro:60000,timestamp:1}));
  db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('b','2026-10-23',JSON.stringify({reviewId:'r1',model:'gpt-6-sol',status:'completed',accountedMicro:40000,timestamp:2}));
  db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('c','2026-10-23',JSON.stringify({reviewId:'r2',model:'gpt-6-sol',status:'completed',accountedMicro:80000,timestamp:3,kind:'shadow'}));
  const e=automation.dryRunEstimate();assert.equal(e.estimateUSD,0.1,'one review of two requests; shadow calls excluded');assert.deepEqual(e.requests,{min:2,max:2});assert.equal(e.today.maxCalls,automation.config.maxCallsPerDay);assert.match(e.note,/same daily AI limits/);
});
// 1.5.37 validation: the dry run did not log Review size and kept only tool titles containing "request", so detail
// reads and condensing could not be checked afterwards.
const fcall=(name,args,id)=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
test('a dry-run review logs Review size and keeps every request size and detail read with its record',async()=>{
  const {automation,events,queue,db}=harness();
  const ask={section:'performance',part:'',from:0};
  queue.push(()=>({toolCalls:[call('get_context_detail',ask,'d1')],continuation:[{role:'user',content:'x'},fcall('get_context_detail',ask,'d1')],usage:{inputTokens:1,outputTokens:1}}));
  const r=await automation.dryRun('review');
  const size=events.find(e=>e.title==='Review size');assert.ok(size,'logged as a live review is');const logged=JSON.parse(size.body);assert.equal(logged.dryRun,true);assert.equal(logged.limitBytes,70000);assert.ok(logged.wireBytes>0);
  assert.deepEqual(r.review.requests.map(q=>[q.call,q.followUp,q.limitBytes]),[[1,false,70000],[2,true,140000]]);assert.ok(r.review.requests.every(q=>q.bytes>0&&q.bytes<=q.limitBytes));
  assert.equal(r.review.size.wireBytes,logged.wireBytes);assert.equal(r.review.detailReads.length,1);assert.match(r.review.detailReads[0],/^performance → /);
  assert.ok(r.review.transcript.some(t=>t.title.startsWith('Context detail')),'the full transcript, not only titles with "request"');
  const stored=JSON.parse(db.prepare('SELECT payload FROM dry_runs WHERE id=?').get(r.id).payload);assert.deepEqual(stored.review.requests,r.review.requests);
  assert.ok(events.some(e=>e.id===r.id&&e.title.startsWith('Context detail')),'tool steps also reach the Console');
});
test('a dry-run review condenses older results like a live review, accounts that call, and records it',async()=>{
  const {automation,queue,db}=harness();const old='{"q":"'+'"'.repeat(10000)+'"}';
  queue.push(()=>({toolCalls:[call('get_context_detail',{section:'x',part:'',from:0},'d2')],continuation:[{role:'user',content:'x'.repeat(110000)},fcall('get_company_research',{symbol:'005930',sections:['a']},'old'),{type:'function_call_output',call_id:'old',output:old},fcall('get_context_detail',{section:'x',part:'',from:0},'d2')],usage:{inputTokens:1,outputTokens:1}}));
  queue.push(()=>({summaries:[{callId:'old',summary:'Samsung research, condensed.'}],usage:{inputTokens:1,outputTokens:1}}));
  const r=await automation.dryRun('review');
  assert.ok(r.review.condensed.length>=1,'condensing recorded');assert.match(r.review.condensed[0],/compact/);
  assert.ok(r.review.requests.filter(q=>q.followUp).every(q=>q.bytes<=140000*0.9),'follow-ups within the fitting point: '+r.review.requests.map(q=>q.bytes).join(','));
  const kinds=db.prepare('SELECT payload FROM ai_calls').all().map(x=>JSON.parse(x.payload)).filter(c=>c.reviewId===r.id).map(c=>c.kind);assert.deepEqual(kinds.sort(),['compact','dry-run','dry-run']);
});
test('a failed dry-run review keeps its diagnostics: sizes, transcript and the reason',async()=>{
  const {automation,queue,db}=harness();
  queue.push(()=>({toolCalls:[call('get_context_detail',{section:'x',part:'',from:0},'d3')],continuation:[{role:'user',content:'"'.repeat(80000)},fcall('get_context_detail',{section:'x',part:'',from:0},'d3')],usage:{inputTokens:1,outputTokens:1}}));
  await assert.rejects(automation.dryRun('review'),/CONTEXT_OVER_BUDGET/);
  const stored=db.prepare('SELECT payload FROM dry_runs').all().map(x=>JSON.parse(x.payload)).at(-1);assert.equal(stored.review.failed,'CONTEXT_OVER_BUDGET');
  assert.equal(stored.review.requests.length,1,'the follow-up was not sent');assert.ok(stored.review.transcript.some(t=>t.title.startsWith('Context detail')));assert.ok(stored.review.size.wireBytes>0);
  assert.equal(automation.busy,false);
});
// Review of Oct 27-28: while the one-share Pentair order waited at the broker (00:25 to 03:45), four scheduled reviews
// re-decided it ("do not submit a second buy while the order is pending"). Pending orders now wait for their fill or
// cancellation, with backstops, and an order update starts a review at once.
function scheduler(){
  const h=harness();const a=h.automation;let orders=[];const reviews=[];a.live.orders=()=>orders;a.review=async trigger=>{reviews.push({trigger,evidence:a.triggerEvidence});a.lastRun=Date.now();a.reviewSessionKey=a.sessionKey();};
  a.schedulerStatus=()=>({label:'Monitoring'});let open=true;a.marketHours=()=>({open,markets:[{market:'US',open}],preOpen:null,next:null});a.reviewInterval.get=()=>({minutes:30});
  const order=(status,filled=0)=>({id:'pnr',market:'US',symbol:'NYSE:PNR',side:'Buy',quantity:1,filled,status,fillPrice:filled?61.56:null,createdAt:Date.now()-60000});
  return {a,reviews,set:list=>{orders=list;},order,setOpen:v=>{open=v;},tick:()=>{a.lastDeskCheck=0;a.tick();}};
}
test('a pending order defers routine reviews until it fills or is cancelled, with backstops',()=>{
  const s=scheduler();s.set([s.order('Accepted')]);s.a.reviewSessionKey=s.a.sessionKey();
  s.a.lastRun=Date.now()-45*60000;s.tick();assert.deepEqual(s.reviews,[],'a 30-minute schedule waits for the pending order');
  assert.ok(s.a.nextReviewAt()===null||s.a.nextReviewAt()>=s.a.lastRun+120*60000-1000,'the next review shown is the backstop');
  s.a.lastRun=Date.now()-121*60000;s.tick();assert.deepEqual(s.reviews.map(r=>r.trigger),['Scheduled review'],'after two hours the backstop review runs');
  const t=scheduler();t.set([t.order('Accepted')]);t.a.reviewSessionKey='US:closed';t.a.lastRun=Date.now()-45*60000;t.tick();assert.deepEqual(t.reviews.map(r=>r.trigger),['Scheduled review'],'a market opening or closing since the last review is a backstop');
  const u=scheduler();u.set([]);u.a.lastRun=Date.now()-45*60000;u.tick();assert.deepEqual(u.reviews.map(r=>r.trigger),['Scheduled review'],'without a pending order the schedule is unchanged');
});
test('an order fill or cancellation starts a review at once with the order as evidence; first sightings do not',()=>{
  const s=scheduler();s.set([s.order('Accepted')]);s.a.lastRun=Date.now()-5*60000;s.tick();assert.deepEqual(s.reviews,[],'first seen: recorded only');
  s.set([s.order('Filled',1)]);s.tick();assert.deepEqual(s.reviews.map(r=>r.trigger),['Order update']);
  assert.deepEqual(s.reviews[0].evidence,{kind:'order',orders:[{symbol:'NYSE:PNR',market:'US',side:'Buy',quantity:1,filled:1,status:'Filled',fillPrice:61.56,placedAt:s.reviews[0].evidence.orders[0].placedAt}]});
  s.a.lastRun=Date.now()-60000;s.tick();assert.equal(s.reviews.length,1,'once per change');
  const c=scheduler();c.a.lastRun=Date.now()-5*60000;c.set([c.order('Accepted')]);c.tick();c.a.busy=true;c.set([c.order('Canceled')]);c.tick();assert.equal(c.reviews.length,0,'waits while a review runs');c.a.busy=false;c.a.lastRun=Date.now()-60000;c.tick();assert.deepEqual(c.reviews.map(r=>r.trigger),['Order update'],'then runs');
  const closed=scheduler();closed.set([closed.order('Accepted')]);closed.setOpen(false);closed.a.config.closedMarketReviews='pre-open';closed.tick();closed.set([closed.order('Canceled')]);closed.tick();assert.equal(closed.reviews.length,0,'markets closed: noted, not reviewed');
  closed.setOpen(true);closed.a.lastRun=Date.now()-60000;closed.tick();assert.deepEqual(closed.reviews.map(r=>r.trigger),['Order update'],'reviewed once a market is open');
});
test('the review is told how a pending order is followed',async()=>{
  const {automation}=harness();automation.live.orders=()=>[{id:'o',market:'KR',symbol:'005930',side:'Buy',quantity:1,filled:0,status:'Accepted',createdAt:Date.now()}];
  const {context}=await automation.assembleReviewContext({watchScope:automation.watchScope(),trigger:'Scheduled review',setStage:()=>{}});
  assert.deepEqual(context.orderFollowUp.orders,[{symbol:'005930',side:'Buy',quantity:1,filled:0,status:'Accepted'}]);assert.match(context.orderFollowUp.note,/Do not re-decide a pending order in each review/);
});
// Review of 40d7666..7e2539f: the order-update review reached the model without the order (context assembly passed
// trigger evidence only for price, news and agent triggers), and orders of a market outside the review delayed it.
test('an order-update review gives the model the order: status, filled quantity and fill price (end to end)',async()=>{
  const {automation:a,supplied}=harness();const order=(status,filled)=>({id:'kia',market:'KR',symbol:'005930',side:'Buy',quantity:2,filled,status,fillPrice:filled?217000:null,createdAt:Date.now()-60000});
  let orders=[order('Accepted',0)];const realOrders=a.live.orders.bind(a.live);a.live.orders=()=>[...realOrders(),...orders];
  a.schedulerStatus=()=>({label:'Monitoring'});a.marketHours=()=>({open:true,markets:[{market:'KR',open:true}],preOpen:null,next:null});a.lastRun=Date.now()-5*60000;
  a.lastDeskCheck=0;a.tick();orders=[order('Filled',2)];a.lastDeskCheck=0;a.tick();
  for(let i=0;i<200&&!supplied.some(([op])=>op==='decision');i++)await new Promise(r=>setTimeout(r,10));
  const call=supplied.find(([op])=>op==='decision');assert.ok(call,'a review reached the provider');
  const context=call[1].context;assert.deepEqual(context.triggerEvidence.orders.map(o=>({...o,placedAt:undefined})),[{symbol:'005930',market:'KR',side:'Buy',quantity:2,filled:2,status:'Filled',fillPrice:217000,placedAt:undefined}]);assert.equal(context.triggerEvidence.kind,'order');
  for(let i=0;i<200&&a.busy;i++)await new Promise(r=>setTimeout(r,10));
});
test('only orders of the markets a review covers defer it, start it or appear in its follow-up (Korea-only and U.S.-only)',async()=>{
  const {automation:a}=harness();const kr={id:'k',market:'KR',symbol:'005930',side:'Buy',quantity:1,filled:0,status:'Accepted',createdAt:Date.now()};const us={id:'u',market:'US',symbol:'NYSE:PNR',side:'Buy',quantity:1,filled:0,status:'Accepted',createdAt:Date.now()};
  let usOrders=[us],krOrders=[];a.live.orders=()=>krOrders;a.usLive={orders:()=>usOrders};a.marketHours=()=>({open:true,markets:[{market:'KR',open:true}],preOpen:null,next:null});a.lastRun=Date.now()-45*60000;a.reviewSessionKey=a.sessionKey();
  assert.equal(a.config.scope,'kis');assert.equal(a.deferForPendingOrder(),null,'a pending U.S. order does not delay a Korea-only review');
  a.orderEvents();usOrders=[{...us,status:'Filled',filled:1,fillPrice:61.56}];assert.deepEqual(a.orderEvents(),[],'nor does its fill start one');
  usOrders=[us];let {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'Scheduled review',setStage:()=>{}});assert.equal(context.orderFollowUp,undefined);
  krOrders=[kr];assert.equal(a.deferForPendingOrder().orders[0].symbol,'005930','a Korean order does');
  a.config={...a.config,scope:'us'};assert.deepEqual(a.deferForPendingOrder().orders.map(o=>o.symbol),['NYSE:PNR'],'U.S.-only: only the U.S. order');
  a.config={...a.config,scope:'both'};assert.deepEqual(a.deferForPendingOrder().orders.map(o=>o.symbol).sort(),['005930','NYSE:PNR'],'both markets: both');
  a.config={...a.config,scope:'paper'};assert.equal(a.deferForPendingOrder(),null);
});
test('reviews get the other market sector moves as leads for the next session; a failing source leaves them out',async()=>{
  const {automation:a}=harness();const leads={us:{asOf:'2026-10-28T20:05:00.000Z',indices:[{label:'Nasdaq-100',changePct:1.8}],sectors:[{sector:'Technology',etf:'AMEX:XLK',changePct:2.4}]},note:'n'};const asked=[];
  a.sectorLeads=async scope=>{asked.push(scope);return leads;};let {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'Scheduled review',setStage:()=>{}});
  assert.deepEqual(context.sectorLeads,leads);assert.deepEqual(asked,['kis'],'asked for the review scope');
  a.sectorLeads=async()=>{throw new Error('KIS down');};({context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'Scheduled review',setStage:()=>{}}));assert.equal(context.sectorLeads,undefined);
});
// Review of 40d7666..c276de6 (scheduling).
test('review: an order left from an earlier trading day no longer holds reviews back or appears as pending',async()=>{
  const {automation:a}=harness();const {seoulDate}=require('../electron/kis-activity.cjs');const today=seoulDate();
  const old={id:'old',market:'KR',symbol:'005930',side:'Buy',quantity:1,filled:0,status:'Accepted',day:'2026-10-23',createdAt:Date.parse('2026-10-23T01:00:00Z')};
  a.live.orders=()=>[old];a.marketHours=()=>({open:true,markets:[{market:'KR',open:true}],preOpen:null,next:null});a.lastRun=Date.now()-45*60000;a.reviewSessionKey=a.sessionKey();
  assert.ok(today>'2026-10-23');assert.equal(a.deferForPendingOrder(),null,'an expired day order does not defer');
  const {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'Scheduled review',setStage:()=>{}});assert.equal(context.orderFollowUp,undefined);
  a.live.orders=()=>[{...old,day:today}];assert.equal(a.deferForPendingOrder().orders.length,1,'a current day order still does');
});
test('review: every order update is queued and reaches the review together; a queue from another scope is dropped',async()=>{
  const {automation:a}=harness();const o=(id,symbol,status,filled=0)=>({id,market:'KR',symbol,side:'Buy',quantity:2,filled,status,fillPrice:filled?100:null,createdAt:Date.now()-60000});
  let orders=[o('a','005930','Accepted'),o('b','000660','Accepted'),o('c','035420','Accepted')];a.live.orders=()=>orders;const reviews=[];a.review=async trigger=>{reviews.push({trigger,evidence:a.triggerEvidence});a.lastRun=Date.now();};
  a.schedulerStatus=()=>({label:'Monitoring'});let open=true;a.marketHours=()=>({open,markets:[{market:'KR',open}],preOpen:null,next:null});a.reviewInterval.get=()=>({minutes:600});a.lastRun=Date.now()-5*60000;
  const tick=()=>{a.lastDeskCheck=0;a.tick();};tick();
  open=false;a.config={...a.config,closedMarketReviews:'pre-open'};orders=[o('a','005930','Filled',2),o('b','000660','Canceled'),o('c','035420','Accepted')];tick();orders=[o('a','005930','Filled',2),o('b','000660','Canceled'),o('c','035420','Rejected')];tick();
  assert.equal(reviews.length,0,'markets closed: noted only');open=true;tick();
  assert.deepEqual(reviews.map(r=>r.trigger),['Order update']);assert.deepEqual(reviews[0].evidence.orders.map(e=>[e.symbol,e.status]),[['005930','Filled'],['000660','Canceled'],['035420','Rejected']]);
  const b=harness().automation;let list=[o('x','005930','Accepted')];b.live.orders=()=>list;const seen=[];b.review=async t=>{seen.push(t);b.lastRun=Date.now();};b.schedulerStatus=()=>({label:'Monitoring'});b.marketHours=()=>({open:false,markets:[{market:'KR',open:false}],preOpen:null,next:null});b.reviewInterval.get=()=>({minutes:600});b.lastRun=Date.now()-5*60000;
  b.config={...b.config,closedMarketReviews:'pre-open'};b.lastDeskCheck=0;b.tick();list=[o('x','005930','Filled',2)];b.lastDeskCheck=0;b.tick();b.config={...b.config,scope:'paper'};
  b.marketHours=()=>({open:true,markets:[{market:'KR',open:true}],preOpen:null,next:null});b.lastDeskCheck=0;b.tick();assert.ok(!seen.includes('Order update'),'a Korean update noted under kis does not fire under another scope');
});
