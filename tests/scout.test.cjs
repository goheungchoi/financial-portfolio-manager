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
test('a trading review can ask for a scout run, which starts after the review ends',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];let reviewRound=0;let scoutStarted;const scoutDone=new Promise(resolve=>{scoutStarted=resolve;});
  const provider={request:async(operation,payload)=>{supplied.push([operation,payload]);
    if(operation==='decision'){reviewRound++;if(reviewRound===1)return {toolCalls:[{name:'request_scout',callId:'q1',args:{reason:'No plan yet and the market moved 3%.'}}],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}};return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Waiting for the scout.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}
    if(operation==='scout'){scoutStarted();return {plan:{summary:'s',cashTargetPct:null,focus:'',targets:[]},usage:{inputTokens:1,outputTokens:1}};}}};
  const automation=new Automation(db,paper,provider,()=>{});automation.live=live;automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>({})};
  automation.discovery={list:()=>[],symbols:()=>[],screen_market:async()=>({}),search_securities:async()=>({}),research:async()=>({}),update_watchlist:async()=>({})};
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  await automation.review();
  const first=supplied.find(([op])=>op==='decision')[1];assert.equal(first.context.scoutRequests.allowed,true);assert.equal(first.context.scoutRequests.remainingToday,3);
  await scoutDone;await new Promise(resolve=>setImmediate(resolve));
  assert.ok(supplied.some(([op])=>op==='scout'),'the requested scout ran');
  const scope=automation.watchScope();assert.equal(automation.requestScout(scope,{reason:'Again'}).status,'rejected','too soon after the last request');
  assert.equal(automation.requestScout(scope,{reason:''}).status,'rejected');
  automation.configure({scoutAiRequests:false});assert.equal(automation.scoutRequestState(scope),null,'can be turned off');
});
test('reviews are offered request_scout only when a request is allowed',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const bodies=[];
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok'})}]}]}));});
  await client.decide({universe:[],scoutRequests:{allowed:true,remainingToday:3}},{research:true});await client.decide({universe:[],scoutRequests:{allowed:false,remainingToday:0}},{research:true});
  assert.ok(bodies[0].tools.some(t=>t.name==='request_scout'));assert.ok(!bodies[1].tools.some(t=>t.name==='request_scout'));
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
