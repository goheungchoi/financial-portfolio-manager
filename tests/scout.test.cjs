const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {normalizeOpinion,analystSummary,estimates,ratios}=require('../electron/kis-research.cjs');
const {validatePlan,dueSlot,runScout,reviewContext,ScoutStore}=require('../electron/scout.cjs');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');

test('analyst ratings normalize across languages and keep the latest view per brokerage',()=>{
  assert.deepEqual(['BUY','매수','Strong Buy','Outperform','Hold','중립','Marketperform','Sell','매도','Underperform','Not Rated',''].map(normalizeOpinion),['Buy','Buy','Buy','Buy','Hold','Hold','Hold','Sell','Sell','Sell',null,null]);
  const rows=[{stck_bsop_date:'20261001',mbcr_name:'A',invt_opnn:'BUY',hts_goal_prc:'120'},{stck_bsop_date:'20260901',mbcr_name:'A',invt_opnn:'HOLD',hts_goal_prc:'90'},{stck_bsop_date:'20260915',mbcr_name:'B',invt_opnn:'중립',hts_goal_prc:'100'},{stck_bsop_date:'20260920',mbcr_name:'C',invt_opnn:'매도',hts_goal_prc:'80'},{stck_bsop_date:'20250101',mbcr_name:'D',invt_opnn:'Buy',hts_goal_prc:'500'}];
  const s=analystSummary(rows,100,'2026-10-16');
  assert.equal(s.brokerages,3,'old opinions fall outside the window');assert.deepEqual([s.buy,s.hold,s.sell],[1,1,1]);assert.equal(s.medianTarget,100);assert.equal(s.upsideToMedianPct,0);
  assert.deepEqual(s.latest[0],{date:'2026-10-01',firm:'A',opinion:'Buy',target:120},'newest first, latest per firm');
});
test('estimate rows map to labelled figures with KIS scaling; missing rows are left out',()=>{
  const body={output1:{rcmd_name:'매수',estdate:'20260730'},output4:[{dt:'2025.12'},{dt:'2026.12E'}],output2:[{data1:'3336059.0',data2:'7109715.0'},{data1:'109.0',data2:'1131.0'}],output3:[{data1:'905276',data2:'4269289'},{data1:'66050',data2:'462090'},{data1:'334',data2:'5996'},{data1:'182',data2:'45'}]};
  const e=estimates(body);
  assert.deepEqual(e.years,['2025-12','2026-12E']);assert.deepEqual(e.forecastYears,['2026-12E']);
  assert.deepEqual(e.revenue,[3336059,7109715]);assert.deepEqual(e.revenueGrowthPct,[10.9,113.1]);assert.deepEqual(e.eps,[6605,46209]);assert.deepEqual(e.per,[18.2,4.5]);
  assert.equal(e.operatingProfit,undefined,'rows the broker did not send are absent, not zero');assert.equal(e.reportOpinion,'매수');
  assert.deepEqual(ratios([{stac_yymm:'202512',grs:'10.88',roe_val:'10.85',eps:'6564',bps:'63997',lblt_rate:'29.94'}])[0],{period:'2025-12',revenueGrowthPct:10.9,operatingProfitGrowthPct:null,roePct:10.9,eps:6564,bps:63997,debtRatioPct:29.9});
});
test('plans are validated: bad targets dropped, text shortened, duplicates removed',()=>{
  const plan=validatePlan({summary:'View. '.repeat(400),cashTargetPct:20,focus:'Watch earnings.',targets:[{symbol:'005930',name:'Samsung',role:'add',targetWeightPct:30,thesis:'Memory upcycle.',risks:'Cycle.'},{symbol:'005930',name:'dup',role:'hold',targetWeightPct:10,thesis:'',risks:''},{symbol:'BAD',name:'x',role:'add',targetWeightPct:5,thesis:'',risks:''},{symbol:'NASD:NVDA',name:'NVIDIA',role:'trim',targetWeightPct:150,thesis:'',risks:''},{symbol:'NYSE:KO',name:'Coca-Cola',role:'candidate',targetWeightPct:null,thesis:'Defensive.',risks:''}]});
  assert.ok(plan.summary.length<=900);assert.deepEqual(plan.targets.map(t=>t.symbol),['005930','NYSE:KO']);
  assert.throws(()=>validatePlan({summary:'',focus:'',cashTargetPct:120,targets:[]}),/INVALID_AI_RESPONSE/);
});
test('scout slots run on weekdays at the preset Seoul times, once each',()=>{
  const at=iso=>Date.parse(iso);
  assert.equal(dueSlot('twice',at('2026-10-16T00:05:00Z')),null,'Friday 09:05 KST is before the first slot');
  assert.equal(dueSlot('twice',at('2026-10-16T00:15:00Z')),'2026-10-16 09:10');
  assert.equal(dueSlot('twice',at('2026-10-16T06:00:00Z')),'2026-10-16 13:00','the latest passed slot');
  assert.equal(dueSlot('kr-us',at('2026-10-16T14:00:00Z')),'2026-10-16 22:40');
  assert.equal(dueSlot('daily',at('2026-10-17T02:00:00Z')),null,'Saturday');
});
test('the research loop runs tools until the plan, reports tool failures as data and enforces limits',async()=>{
  const calls=[];let round=0;const logs=[];
  const request=async({final,continuation})=>{calls.push({final,length:continuation?.length??0});round++;
    if(round===1)return {toolCalls:[{name:'get_company_research',callId:'a',args:{symbol:'005930'}},{name:'screen_market',callId:'b',args:{market:'KR'}}],continuation:['input'],usage:{inputTokens:10,outputTokens:2}};
    return {plan:{summary:'s',cashTargetPct:null,focus:'f',targets:[]},usage:{inputTokens:20,outputTokens:3},model:'m'};};
  const result=await runScout({request,tools:{get_company_research:async()=>({price:1}),screen_market:async()=>{throw new Error('RATE_LIMITED');}},log:(kind,title,body)=>logs.push([kind,title,body])});
  assert.equal(result.rounds,2);assert.deepEqual(result.usage,{inputTokens:30,outputTokens:5});assert.equal(calls[1].length,3,'two tool outputs appended');
  assert.ok(logs.some(([,title,body])=>title==='Scout result · screen_market'&&body.includes('RATE_LIMITED')));
  let sent;let ran=0;const burst=await runScout({request:async({continuation})=>{if(!continuation)return {toolCalls:[1,2,3,4,5,6,7,8].map(i=>({name:'search_securities',callId:String(i),args:{query:String(i)}})),continuation:[]};sent=continuation;return {plan:{summary:'s',cashTargetPct:null,focus:'',targets:[]}};},tools:{search_securities:async()=>{ran++;return {rows:[]};}},log:()=>{}});
  assert.equal(burst.rounds,2);assert.equal(ran,6,'six requests run per round');assert.equal(sent.length,8,'every request is answered');assert.equal(sent.filter(o=>o.output.includes('skipped')).length,2,'the rest are told to ask again');
  const unknown=await runScout({request:async({continuation})=>continuation?{plan:{summary:'s',cashTargetPct:null,focus:'',targets:[]}}:{toolCalls:[{name:'unknown:web_search',callId:'u',args:{}}],continuation:[]},tools:{},log:()=>{}});assert.equal(unknown.rounds,2,'an unknown tool is answered, not fatal');
  await assert.rejects(runScout({request:async()=>({usage:{}}),tools:{},log:()=>{}}),error=>error.detail==='the model returned neither a plan nor a tool request');
  let finals=0;await assert.rejects(runScout({request:async({final})=>{if(final)finals++;return {toolCalls:[{name:'x',callId:'1',args:{}}],continuation:[]};},tools:{},log:()=>{},maxRounds:3}),/INVALID_AI_RESPONSE/);assert.equal(finals,1,'only the last round is final');
});
test('a scout run is metered, saves the plan and the next trading review receives it',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:70000,retrievedAt:1}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  let step=0;const supplied=[];const events=[];
  const provider={request:async(operation,payload)=>{supplied.push([operation,payload]);
    if(operation==='scout'){step++;if(step===1)return {toolCalls:[{name:'get_company_research',callId:'r1',args:{symbol:'005930'}},{name:'update_watchlist',callId:'w1',args:{action:'add',entries:[{symbol:'005930',reason:'Consensus upside'}]}}],continuation:[{role:'user',content:'x'}],usage:{inputTokens:100,outputTokens:20},model:'gpt-6-sol'};
      return {plan:{summary:'Tilt to memory.',cashTargetPct:30,focus:'Earnings in late October.',targets:[{symbol:'005930',name:'Samsung',role:'candidate',targetWeightPct:25,thesis:'Upcycle.',risks:'Cycle.'}]},usage:{inputTokens:200,outputTokens:50},model:'gpt-6-sol'};}
    if(operation==='decision')return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Waiting for entry.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const automation=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({id,kind,title,body}));automation.live=live;automation.providerStatus.aiConnected=true;
  const watch=[];automation.discovery={list:()=>watch,symbols:()=>watch.map(w=>w.symbol),screen_market:async()=>({rows:[]}),search_securities:async()=>({rows:[]}),research:async({symbol})=>({symbol,analysts:{brokerages:3}}),update_watchlist:async args=>{watch.push(...args.entries.map(e=>({symbol:e.symbol,name:'Samsung',source:'ai',reason:e.reason})));return {results:[{symbol:'005930',status:'added'}]};}};
  assert.match(automation.getState().scout.blocked,/OpenAI/,'needs the OpenAI decision maker');
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'none'});
  assert.equal(automation.getState().scout.blocked,null);
  const saved=await automation.scout();
  assert.equal(saved.plan.targets[0].symbol,'005930');assert.equal(saved.rounds,2);assert.deepEqual(watch.map(w=>w.symbol),['005930']);
  const scoutCalls=supplied.filter(([op])=>op==='scout');assert.equal(scoutCalls[0][1].options.reasoningEffort,'low','the scout never runs at effort none');assert.equal(scoutCalls[1][1].options.continuation.length,3,'tool results are passed back');
  assert.equal(db.prepare('SELECT calls FROM ai_usage').get().calls,2,'each scout call counts toward the daily AI budget');
  assert.ok(events.some(e=>e.title==='Scout plan')&&events.some(e=>e.title==='Supplied context'));
  await automation.review();const sent=supplied.find(([op])=>op==='decision')[1].context;
  assert.equal(sent.scoutPlan.targets[0].role,'candidate');assert.equal(sent.scoutPlan.cashTargetPct,30);
  assert.equal(sent.discovery.watchlist[0].reason,'Consensus upside');
});
test('scheduled scout runs once per slot and stores the slot',()=>{
  const db=new DatabaseSync(':memory:');const store=new ScoutStore(db);store.markSlot('kis:a','2026-10-16 09:10');assert.equal(store.lastSlot('kis:a'),'2026-10-16 09:10');assert.equal(store.lastSlot('kis:b'),null);
  const first=store.save('kis:a',{summary:'a',cashTargetPct:null,focus:'',targets:[]});assert.equal(store.latest('kis:a').id,first.id);assert.equal(reviewContext(first,first.timestamp+37*3600000),null);
});
test('the scout request offers research and discovery tools, asks for a plan and forbids tools on the final round',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const bodies=[];
  const reply=output=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:5,output_tokens:2},output}));
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{const body=JSON.parse(options.body);bodies.push(body);
    if(bodies.length===1)return reply([{type:'function_call',name:'get_company_research',call_id:'c1',arguments:JSON.stringify({symbol:'005930'})}]);
    return reply([{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'s',cashTargetPct:10,focus:'f',targets:[]})}]}]);});
  const first=await client.scout({today:'2026-10-16'},{openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  assert.equal(first.toolCalls[0].name,'get_company_research');
  assert.deepEqual(bodies[0].tools.map(t=>t.name).sort(),['get_company_research','screen_market','search_securities','update_watchlist']);assert.equal(bodies[0].text.format.name,'portfolio_plan');assert.equal(bodies[0].tool_choice,'auto');
  const second=await client.scout({},{openaiModel:'gpt-6-sol',reasoningEffort:'low',final:true,continuation:first.continuation});
  assert.equal(bodies[1].tool_choice,'none');assert.equal(second.plan.cashTargetPct,10);
});
test('the scout client accepts several tool requests at once and explains malformed replies',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');let output;
  const client=new AiClient('sk-fixture-key-123',async()=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:1,output_tokens:1},output})));
  output=[1,2,3,4,5].map(i=>({type:'function_call',name:i===5?'web_search':'screen_market',call_id:'c'+i,arguments:JSON.stringify({market:'KR'})}));
  const reply=await client.scout({},{openaiModel:'gpt-6-sol',reasoningEffort:'low'});assert.equal(reply.toolCalls.length,5);assert.equal(reply.toolCalls[4].name,'unknown:web_search');
  output=[{type:'function_call',name:'screen_market',call_id:'c1',arguments:'{not json'}];await assert.rejects(client.scout({},{openaiModel:'gpt-6-sol',reasoningEffort:'low'}),error=>error.message==='INVALID_AI_RESPONSE'&&error.detail==='tool arguments were not valid JSON');
  output=[{type:'message',content:[{type:'output_text',text:'{"summary":"s"}'}]}];await assert.rejects(client.scout({},{openaiModel:'gpt-6-sol',reasoningEffort:'low'}),error=>error.detail==='the plan did not match the required format');
});
test('AI scout requests are limited to three a day, two hours apart, per account',()=>{
  const store=new ScoutStore(new DatabaseSync(':memory:'));const t0=Date.parse('2026-10-16T01:00:00Z');
  assert.deepEqual(store.requests('kis:a','2026-10-16',t0),{remainingToday:3,nextAllowedAt:null});
  store.noteRequest('kis:a','2026-10-16',t0);let s=store.requests('kis:a','2026-10-16',t0+60000);assert.equal(s.remainingToday,2);assert.equal(s.nextAllowedAt,t0+7200000);
  assert.equal(store.requests('kis:a','2026-10-16',t0+7200000).nextAllowedAt,null,'allowed again after two hours');
  store.noteRequest('kis:a','2026-10-16',t0+7200000);store.noteRequest('kis:a','2026-10-16',t0+14400000);assert.equal(store.requests('kis:a','2026-10-16',t0+30000000).remainingToday,0);
  assert.equal(store.requests('kis:a','2026-10-17',t0+90000000).remainingToday,3,'a new Seoul day resets the count');assert.equal(store.requests('kis:b','2026-10-16',t0).remainingToday,3,'per account');
});
test('a trading review can brief the scout and ask for a run, which starts after the review ends',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];let reviewRound=0;let scoutStarted;const scoutDone=new Promise(resolve=>{scoutStarted=resolve;});
  const provider={request:async(operation,payload)=>{supplied.push([operation,payload]);
    if(operation==='decision'){reviewRound++;if(reviewRound===1)return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'No plan yet.',credit:'none',loanDate:'',scoutBrief:{request:'run',reason:'No plan yet and the market moved 3%.',lookingFor:'Dividend payers below book value',avoid:'',questions:'',feedback:[]}},usage:{inputTokens:1,outputTokens:1},provider:'openai'};return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Waiting for the scout.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}
    if(operation==='scout'){scoutStarted();const id=payload.context.briefs[0].id;return {plan:{summary:'s',cashTargetPct:null,focus:'',targets:[],briefAnswers:[{briefId:id,answer:'Found two banks below book.'},{briefId:'B-nope',answer:'x'}],retrospective:''},usage:{inputTokens:1,outputTokens:1}};}}};
  const automation=new Automation(db,paper,provider,()=>{});automation.live=live;automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>({})};
  automation.discovery={list:()=>[],symbols:()=>[],screen_market:async()=>({}),search_securities:async()=>({}),research:async()=>({}),update_watchlist:async()=>({})};
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  await automation.review();
  const first=supplied.find(([op])=>op==='decision')[1];assert.equal(first.context.scoutBrief.runAllowed,true);assert.equal(first.context.scoutBrief.remainingRunsToday,3);
  await scoutDone;await new Promise(resolve=>setImmediate(resolve));
  assert.ok(supplied.some(([op])=>op==='scout'),'the requested scout ran');
  const scoutContext=supplied.find(([op])=>op==='scout')[1].context;assert.equal(scoutContext.briefs[0].lookingFor,'Dividend payers below book value');assert.equal(scoutContext.briefs[0].reason,'No plan yet and the market moved 3%.');
  const scope=automation.watchScope();const latest=automation.scoutStore.latest(scope);assert.deepEqual(latest.answered.map(a=>a.answer),['Found two banks below book.'],'unknown brief ids are ignored');
  assert.equal(automation.briefs.open(scope).length,0,'answered briefs close');
  const again=automation.briefScout(scope,{request:'run',reason:'Again',lookingFor:'',avoid:'',questions:'',feedback:[]});assert.equal(again.status,'saved');assert.match(again.run,/too soon/,'a run is refused but the brief is kept');
  assert.equal(automation.briefScout(scope,{request:'note',reason:'',lookingFor:'',avoid:'',questions:'',feedback:[]}).status,'rejected','an empty brief is rejected');
  await automation.review();const second=supplied.filter(([op])=>op==='decision').at(-1)[1].context;assert.equal(second.scoutPlan.briefAnswers[0].answer,'Found two banks below book.','the review sees the answer');assert.equal(second.scoutBrief.openBriefs.length,1);
  automation.configure({scoutAiRequests:false});const off=automation.scoutBriefState(scope);assert.equal(off.runAllowed,false);assert.equal(off.runRequests,'turned off','notes stay available while run requests are off');
});
test('decisions carry a scout brief only when the scout is in use; a bad brief never invalidates the decision',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const bodies=[];
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok',scoutBrief:{request:'note',reason:'',lookingFor:'',avoid:'',questions:'Kia dividend policy?',feedback:[]}})}]}]}));});
  const withBrief=await client.decide({universe:[],scoutBrief:{runAllowed:false,openBriefs:[]}},{research:true});await client.decide({universe:[]},{research:true});
  assert.ok(bodies[0].text.format.schema.required.includes('scoutBrief'));assert.ok(!bodies[1].text.format.schema.required.includes('scoutBrief'));
  assert.ok(!bodies[0].tools.some(t=>t.name==='brief_scout'),'no separate tool or round');assert.equal(withBrief.decision.scoutBrief.questions,'Kia dividend policy?');
  const {validateDecision}=require('../electron/ai-client.cjs');const base={action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'x'};
  assert.deepEqual(validateDecision({...base,scoutBrief:{request:'none',reason:'',lookingFor:'',avoid:'',questions:'',feedback:[]}},[]),base,'none leaves no brief');
  assert.deepEqual(validateDecision({...base,scoutBrief:{request:'note',reason:'',lookingFor:'',avoid:'',questions:'',feedback:[]}},[]),base,'an empty brief is dropped');
  assert.deepEqual(validateDecision({...base,scoutBrief:'garbage'},[]),base,'a malformed brief is dropped');
  assert.throws(()=>validateDecision({...base,quantity:3,scoutBrief:{request:'note',questions:'q'}},[]),/INVALID_AI_RESPONSE/,'decision checks still apply');
});
test('the scout reports a disconnected KIS account instead of starting',()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const automation=new Automation(db,paper,{request:async()=>{throw new Error('unexpected');}},()=>{});automation.providerStatus.aiConnected=true;automation.discovery={list:()=>[]};
  automation.live=new LiveEngine(db,{request:async()=>{throw new Error('unexpected');}},()=>({status:'disconnected',snapshot:null}));
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  assert.equal(automation.getState().scout.blocked,'Connect your KIS account');assert.rejects(automation.scout(),/SCOUT_UNAVAILABLE/);
});
test('with both markets, a failed U.S. account check does not stop the scout',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));
  let context;const provider={request:async(operation,payload)=>{context=payload.context;return {plan:{summary:'Korea only today.',cashTargetPct:null,focus:'',targets:[]},usage:{inputTokens:1,outputTokens:1}};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.live=live;automation.usLive={identity:()=>'acct:US',context:async()=>({}),getState:()=>({})};automation.refreshUS=async()=>{throw new Error('US_CASH_BROKER_REJECTED');};automation.providerStatus.aiConnected=true;
  automation.discovery={list:()=>[],symbols:()=>[]};
  automation.configure({scope:'both',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  const saved=await automation.scout();assert.equal(saved.plan.summary,'Korea only today.');
  assert.deepEqual(context.accounts.map(a=>a.market),['KR','US']);assert.equal(context.accounts[1].status,'unavailable');assert.equal(context.accounts[1].reason,'US_CASH_BROKER_REJECTED');
});
test('briefs are normalized, expire after three days and keep at most six open per account',()=>{
  const {normalizeBrief,BriefStore}=require('../electron/scout-feedback.cjs');
  assert.equal(normalizeBrief({request:'note',reason:'',lookingFor:' ',avoid:'',questions:'',feedback:[]}),null,'nothing to act on');
  assert.equal(normalizeBrief({request:'run',reason:'Market fell 4%.',lookingFor:'',avoid:'',questions:'',feedback:[]}).request,'run','a run request with a reason is enough');
  const b=normalizeBrief({request:'note',reason:'',lookingFor:'x'.repeat(500),avoid:'Batteries',questions:'',feedback:[{symbol:'000660',verdict:'passed',reason:'Too extended'},{symbol:'BAD',verdict:'passed',reason:''},{symbol:'005930',verdict:'maybe',reason:''}]});
  assert.ok(b.lookingFor.length<=300);assert.deepEqual(b.feedback.map(f=>f.symbol),['000660'],'bad symbols and verdicts are dropped');
  let now=Date.parse('2026-10-16T01:00:00Z');const store=new BriefStore(new DatabaseSync(':memory:'),()=>now);
  const first=store.add('kis:a',b);assert.ok(first.asked.includes('Avoid: Batteries'));assert.ok(first.asked.includes('000660 passed (Too extended)'));
  for(let i=0;i<6;i++){now+=1000;store.add('kis:a',normalizeBrief({request:'note',reason:'',lookingFor:'n'+i,avoid:'',questions:'',feedback:[]}));}
  assert.equal(store.open('kis:a').length,6);assert.ok(!store.open('kis:a').some(r=>r.id===first.id),'the oldest is dropped');assert.equal(store.open('kis:b').length,0,'per account');
  assert.equal(store.feedback('kis:a',0).get('000660').verdict,'passed','feedback outlives the brief');
  now+=3*86400000+10000;assert.equal(store.open('kis:a').length,0,'stale briefs expire');
});
test('scout picks are tracked from the first plan that names them and scored against the benchmark',()=>{
  const {ScoutScorecard}=require('../electron/scout-feedback.cjs');const {Scoreboard}=require('../electron/scoreboard.cjs');
  const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-01T01:00:00Z');const board=new Scoreboard(db,()=>now);
  db.exec('CREATE TABLE benchmark_closes(idx TEXT,day TEXT,close REAL);CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT)');
  const days=Array.from({length:30},(_,i)=>new Date(Date.parse('2026-09-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
  board.saveCloses('005930',days.map((day,i)=>({day,close:100+i})));for(const [i,day] of days.entries())db.prepare('INSERT INTO benchmark_closes VALUES(?,?,?)').run('KOSPI',day,1000+i*5);
  const card=new ScoutScorecard(db,board,()=>now);
  const plan=targets=>({summary:'',cashTargetPct:null,focus:'',targets:targets.map(([symbol,role])=>({symbol,name:symbol,role,targetWeightPct:null,thesis:'t',risks:''}))});
  card.record('kis:a',plan([['005930','candidate'],['000660','trim']]),now);
  assert.deepEqual(card.rows('kis:a').map(r=>r.symbol),['005930'],'only candidate and add targets are picks');
  now+=3600000;card.record('kis:a',plan([['005930','hold']]),now);assert.equal(card.rows('kis:a').length,1,'a pick the trader bought stays the same pick');
  db.prepare('INSERT INTO reviews VALUES(?,?)').run('r1',JSON.stringify({timestamp:now,decision:{action:'Buy',symbol:'005930'},proposalId:'p',orderId:'o'}));
  now+=3600000;card.record('kis:a',plan([]),now);assert.ok(card.rows('kis:a')[0].endedAt,'dropped from the plan');
  const built=card.build('kis:a',new Map([['005930',{verdict:'acted',reason:'Bought on the dip',at:now}]]));const pick=built.picks[0];
  assert.equal(pick.acted,'bought');assert.equal(pick.feedback.reason,'Bought on the dip');
  assert.equal(pick.horizons[5].stockReturn,0.05);assert.equal(pick.horizons[5].benchmarkReturn,0.025);assert.equal(pick.horizons[5].excess,0.025);
  assert.deepEqual(built.summary[20],{scored:1,beatBenchmark:1,meanExcess:0.1});
  const context=card.context('kis:a',new Map());assert.equal(context.picks[0].excess20,0.1);assert.equal(context.picks[0].active,false);assert.ok(context.note.includes('mostly noise'));
  card.record('kis:a',plan([['000660','add']]),now);assert.deepEqual(card.pendingSymbols(10,0),['000660'],'only picks without a 20-day result need prices');
});
test('the scout reads its scorecard and earlier self-reviews, and plans carry answers and a self-review',async()=>{
  const plan=validatePlan({summary:'s',cashTargetPct:null,focus:'',targets:[],briefAnswers:[{briefId:'B-1',answer:'Done.'},{briefId:'B-2',answer:'  '}],retrospective:'Weight valuation more.'});
  assert.deepEqual(plan.briefAnswers,[{briefId:'B-1',answer:'Done.'}]);assert.equal(plan.retrospective,'Weight valuation more.');
  const old=validatePlan({summary:'s',cashTargetPct:null,focus:'',targets:[]});assert.deepEqual(old.briefAnswers,[]);assert.equal(old.retrospective,'','earlier plans without the new fields still load');
  const {SCHEMA,INSTRUCTIONS}=require('../electron/scout.cjs');assert.ok(SCHEMA.required.includes('briefAnswers')&&SCHEMA.required.includes('retrospective'));assert.ok(INSTRUCTIONS.includes('too few to judge'));
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const contexts=[];let n=0;const provider={request:async(operation,payload)=>{contexts.push(payload.context);n++;return {plan:{summary:'s'+n,cashTargetPct:null,focus:'',targets:[{symbol:'005930',name:'Samsung',role:'candidate',targetWeightPct:10,thesis:'Upside.',risks:''}],briefAnswers:[],retrospective:n===1?'Too few results to judge yet.':''},usage:{inputTokens:1,outputTokens:1}};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.live=live;automation.providerStatus.aiConnected=true;automation.discovery={list:()=>[],symbols:()=>[]};
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  await automation.scout();assert.equal(contexts[0].scorecard,undefined,'no picks yet');assert.equal(contexts[0].retrospectives,undefined);
  await automation.scout();assert.equal(contexts[1].scorecard.picks[0].symbol,'005930');assert.equal(contexts[1].scorecard.picks[0].tradingReviews,'not yet');assert.equal(contexts[1].retrospectives[0].note,'Too few results to judge yet.');
  const state=automation.getState().scout;assert.equal(state.scorecard.picks.length,1,'the same pick across runs');assert.deepEqual(state.briefs,[]);
});
