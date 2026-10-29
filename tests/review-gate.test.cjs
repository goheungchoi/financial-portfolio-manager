const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {ReviewGate,decisionState,compare,newsKey}=require('../electron/review-gate.cjs');
const t0=Date.parse('2026-10-29T05:00:00Z'),min=n=>t0+n*60000;const config={eventTolerancePct:3,maxSkipMinutes:120};
// A context shaped like the saved 2026-10-29 ones: Samsung E&A and Kia held, Hyundai Rotem a scout candidate.
function ctx(over={}){const q=(symbol,price,extra={})=>({symbol,price,retrievedAt:t0,timestamp:t0,previousClose:price,changePct:0,volume:100000,stale:false,market:/:/.test(symbol)?'US':'KR',...extra});
  return {environment:'kis-combined',equity:1500000,cash:{KRW:414148,USD:0},fx:{usdKRW:1336.3,timestamp:t0},userGuidelines:'Goal: aggressive growth',
    positions:{'028050':{quantity:3,costTotal:180900},'000270':{quantity:1,costTotal:106000}},
    quotes:[q('028050',60300),q('000270',107600),q('064350',380000),q('NASD:GOOGL',290)],
    markets:[{market:'KR',marketSession:{open:true},executionEnabled:true,automaticExecutionEnabled:true},{market:'US',marketSession:{open:false},executionEnabled:true,automaticExecutionEnabled:true}],
    emergency:{active:false,loss:{breached:false,lossPct:2}},risk:{markets:{KR:{lossLimit:{mode:'off',value:0},dayPeakEquity:797731}}},
    portfolioExposure:{investedPct:72.7,largest:{weightPct:28.6}},scoutPlan:{targets:[{symbol:'064350',role:'candidate'},{symbol:'005930',role:'exit'},{symbol:'028050',role:'hold'}]},
    agentDesk:{conditionalOrders:{armed:[{id:'C-1',symbol:'028050'}],recent:[],unprotected:[]}},reviewWatches:[],marketNarrative:{summary:'Risk-on'},...over};}
const quote=(c,symbol,patch)=>({...c,quotes:c.quotes.map(q=>q.symbol===symbol?{...q,...patch}:q)});
const gate=(base,next,opts={})=>compare(base,decisionState(next),{config,now:min(10),...opts});
const settled=(c=ctx(),extra={})=>({...decisionState(c),at:t0,decision:null,seen:[],...extra});

test('only timestamps, cumulative volume, derived percentages and summaries change: skip',()=>{
  const next=ctx({fx:{usdKRW:1336.3,timestamp:min(9)},marketNarrative:{summary:'Reworded'},quotes:ctx().quotes.map(q=>({...q,retrievedAt:min(9),timestamp:min(9),volume:q.volume*3,changePct:.4}))});
  const r=gate(settled(),next);assert.equal(r.needsReview,false,JSON.stringify(r.reasons));assert.deepEqual(r.reasons,[]);assert.equal(r.nextBackstopAt,min(120));
});
test('prices: within the limit skip; small moves that add up past it since the decision review',()=>{
  const base=settled();assert.equal(gate(base,quote(ctx(),'028050',{price:60300*1.01})).needsReview,false,'+1% on a holding');
  assert.equal(gate(base,quote(ctx(),'028050',{price:60300*1.014})).needsReview,false,'+1.4%');
  const r=gate(base,quote(ctx(),'028050',{price:60300*1.016}));assert.equal(r.needsReview,true,'+1.6% cumulatively, past half the 3% trigger');assert.deepEqual(r.changedSymbols,['028050']);assert.equal(r.reasons[0].kind,'price');
  assert.equal(gate(base,quote(ctx(),'064350',{price:380000*1.02})).needsReview,false,'a candidate uses the full trigger');assert.equal(gate(base,quote(ctx(),'064350',{price:380000*1.031})).needsReview,true);
  assert.equal(gate(base,quote(ctx(),'NASD:GOOGL',{price:400})).needsReview,false,'other quoted symbols are left to the price alerts');
});
test('fills, partial fills, cancellations and rejections review',()=>{
  const order=(status,filled=0)=>({orderFollowUp:{orders:[{symbol:'000270',side:'Buy',quantity:2,filled,status}]}});
  const base=settled(ctx(order('Accepted')));
  assert.equal(gate(base,ctx(order('Accepted'))).needsReview,false,'unchanged order');
  assert.equal(gate(base,ctx(order('Partially filled',1))).reasons[0].kind,'order','partial fill');
  assert.equal(gate(base,ctx({orderFollowUp:{orders:[]}})).reasons[0].detail,'Buy 000270: Accepted → closed','filled or cancelled: gone from pending');
  assert.equal(gate(base,ctx({...order('Canceled'),positions:ctx().positions})).reasons[0].kind,'order');
  assert.equal(gate(settled(),ctx({positions:{...ctx().positions,'000270':{quantity:2}}})).reasons[0].kind,'holdings','a fill changes holdings');
  const rejected=ctx({agentDesk:{conditionalOrders:{armed:[],recent:[{id:'C-1',symbol:'028050',purpose:'stop_loss',status:'rejected',at:new Date(min(5)).toISOString()}],unprotected:[{symbol:'028050'}]}}});
  const r=gate(settled(),rejected);assert.deepEqual(r.reasons.map(x=>x.kind),['protection','protection'],'stop rejected and position unprotected');
  assert.equal(gate(settled(rejected,{at:min(6)}),rejected).needsReview,false,'a rejection the decision already saw is not new');
});
test('cash: a change that affects what is affordable, or a large one, reviews; small ones do not',()=>{
  const base=settled();assert.equal(gate(base,ctx({cash:{KRW:400000,USD:0}})).needsReview,false,'-14,148 KRW is under 2% of equity');
  const r=gate(base,ctx({cash:{KRW:370000,USD:0}}));assert.equal(r.needsReview,true);assert.match(r.reasons.map(x=>x.detail).join(';'),/064350 is no longer affordable/);
  assert.equal(gate(base,ctx({cash:{KRW:414148,USD:300}})).reasons[0].kind,'cash','a U.S. deposit worth more than 2% of equity');
});
test('a risk boundary crossed on a small price move reviews; so do execution and session changes',()=>{
  const r=gate(settled(),quote(ctx({emergency:{active:true,loss:{breached:true,lossPct:5.1}}}),'028050',{price:60400}));assert.deepEqual(r.reasons.map(x=>x.kind),['risk']);
  assert.equal(gate(settled(),ctx({risk:{markets:{KR:{lossLimit:{mode:'percent',value:5}}}}})).reasons[0].kind,'risk','loss limit settings');
  assert.equal(gate(settled(),ctx({risk:{markets:{KR:{lossLimit:{mode:'off',value:0},dayPeakEquity:800000}}}})).needsReview,false,'a new day peak is not a boundary');
  const exec=ctx();exec.markets=[{...exec.markets[0],automaticExecutionEnabled:false},exec.markets[1]];assert.equal(gate(settled(),exec).reasons[0].kind,'execution');
  assert.equal(gate(settled(),ctx({portfolioExposure:{investedPct:79,largest:{weightPct:28.6}}})).reasons[0].kind,'exposure');
  assert.equal(gate(settled(),ctx({portfolioExposure:{investedPct:74,largest:{weightPct:30}}})).needsReview,false,'exposure within 5 points');
  assert.equal(gate(settled(),ctx({userGuidelines:'Goal: capital preservation'})).reasons[0].kind,'instructions');
});
test('filings: a new receipt with an unchanged headline reviews; the same filing again does not',()=>{
  const filing=(receipt,id)=>({id,kind:'disclosure',source:'DART',title:'삼성E&A 단일판매ㆍ공급계약체결',receipt,symbols:['028050'],importance:'high'});
  const base=settled(ctx(),{seen:[newsKey(filing('20261029000100','u1'))]});
  assert.equal(gate(base,ctx(),{events:[filing('20261029000100','u1')]}).needsReview,false,'known at the decision');
  assert.equal(gate(base,ctx(),{events:[filing('20261029000100','https://m.dart.fss.or.kr/x')]}).needsReview,false,'same receipt, another URL');
  const r=gate(base,ctx(),{events:[filing('20261029000200','u2'),filing('20261029000200','u3')]});assert.equal(r.reasons.length,1,'one reason for one filing');assert.deepEqual(r.requiredEvidence,['filing:20261029000200']);
  assert.equal(gate(base,ctx(),{events:[{id:'n1',kind:'headline',title:'Hyundai Rotem wins order',symbols:['064350'],importance:'normal'}]}).needsReview,false,'an ordinary headline');
  assert.equal(gate(base,ctx(),{events:[{...filing('20261029000300','u4'),symbols:['005930']}]}).needsReview,false,'not about a holding or candidate');
});
test('a stale or missing quote is degraded evidence, not a review; its return is a review',()=>{
  const r=gate(settled(),quote(ctx(),'028050',{stale:true,price:61500}));assert.equal(r.needsReview,false);assert.deepEqual(r.degraded,['028050']);
  assert.deepEqual(gate(settled(),ctx({quotes:ctx().quotes.filter(q=>q.symbol!=='000270')})).degraded,['000270'],'missing');
  assert.deepEqual(gate(settled(),ctx({equityReliability:{reliable:false}})).degraded,['equity']);
  assert.equal(gate(settled(quote(ctx(),'028050',{stale:true})),ctx()).reasons[0].kind,'quote','price available again');
});
test('entry levels known at the decision review when crossed; the backstop reviews; other triggers always run',()=>{
  const w={symbol:'064350',price:385000,direction:'above',reason:'r',priceFired:false};const base=settled(ctx({reviewWatches:[w]}));
  assert.equal(gate(base,quote(ctx({reviewWatches:[w]}),'064350',{price:386000})).reasons[0].kind,'level');
  assert.equal(gate(base,quote(ctx({reviewWatches:[{...w,price:390000}]}),'064350',{price:386000})).needsReview,false,'a level set after the decision is not a crossing');
  assert.equal(compare(settled(),decisionState(ctx()),{config,now:min(120)}).reasons[0].kind,'backstop');
  assert.equal(gate(settled(),ctx(),{trigger:'User request'}).reasons[0].kind,'trigger');assert.equal(compare(null,decisionState(ctx()),{config,now:t0}).reasons[0].kind,'baseline');
});
test('a decision the closed market could not carry out reviews when it opens',()=>{
  // 2026-10-29: five Sell NASD:GOOGL decisions while the U.S. market was closed, none with an order.
  const base=settled();const pending=[{symbol:'NASD:GOOGL',action:'Sell'}];const open=ctx();open.markets=[open.markets[0],{...open.markets[1],marketSession:{open:true}}];
  assert.deepEqual(gate(base,open,{pending}).reasons.map(r=>r.kind),['session','pending-decision']);assert.equal(gate(base,ctx(),{pending}).needsReview,false,'still closed');
});
test('baselines persist per scope, across restarts; the log summarizes what the gate would do',()=>{
  const db=new DatabaseSync(':memory:');const g=new ReviewGate(db);g.settle('kis:a',decisionState(ctx()),{at:t0,decision:{action:'Hold',symbol:''},events:[{receipt:'1'}]});
  const again=new ReviewGate(db);assert.equal(again.baseline('kis:a').at,t0);assert.deepEqual(again.baseline('kis:a').seen,['dart:1']);assert.equal(again.baseline('us:b'),null,'no leak between accounts');
  db.exec("CREATE TABLE ai_calls(id TEXT,day TEXT,payload TEXT)");db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('c','d',JSON.stringify({reviewId:'R2',timestamp:min(5),cost:{micro:150000}}));
  const no={needsReview:false,reasons:[],degraded:[]},yes={needsReview:true,reasons:[{kind:'backstop'}],degraded:[]};
  g.log(min(1),{trigger:'Scheduled review',oldSkip:true,ran:false,gate:no});g.log(min(5),{trigger:'Scheduled review',oldSkip:false,ran:true,reviewId:'R2',gate:no});
  g.log(min(9),{trigger:'Scheduled review',oldSkip:false,ran:true,reviewId:'R3',gate:yes});g.log(min(9),{trigger:'User request',oldSkip:false,ran:true,gate:yes});
  assert.deepEqual(g.summary(t0),{since:new Date(t0).toISOString(),checks:4,scheduled:3,ran:2,oldSkips:1,gateSkips:2,wouldAvoid:1,estimatedUSD:.15,backstops:1,riskReasons:0,degraded:0});
});

// The scheduler: observation leaves the old skip deciding; the baseline moves only after a successful decision.
function harness(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const queue=[];const events=[];
  const provider={request:async()=>{const next=queue.shift();if(next)return next();return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]),provider,(id,kind,title,body)=>events.push({title,body}));
  a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low'});return {a,db,queue,events};}
test('through the scheduler: a failed review leaves the baseline; a successful one sets it; observe never skips on its own',async()=>{
  const {a,db,queue,events}=harness();assert.equal(a.config.reviewGate,'observe','observing by default');
  queue.push(()=>{throw new Error('PROVIDER_REQUEST_FAILED');});await a.review('Scheduled review').catch(()=>{});
  assert.equal(a.reviewGate.baseline(a.watchScope()),null,'failed: no baseline');
  await a.review('Scheduled review');const base=a.reviewGate.baseline(a.watchScope());assert.ok(base?.at,'set after the decision');assert.equal(base.decision.action,'Hold');
  a.configure({skipUnchanged:false});await a.review('Scheduled review');
  const rows=db.prepare('SELECT payload FROM review_gate_log ORDER BY id').all().map(r=>JSON.parse(r.payload));assert.equal(rows.at(-1).gate.needsReview,false);assert.equal(rows.at(-1).ran,true,'observing: the review still ran');
  assert.ok(events.some(e=>e.title==='Review gate · would skip'));
  queue.push(()=>{throw new Error('PROVIDER_REQUEST_FAILED');});a.configure({reviewGate:'on'});const before=a.reviewGate.baseline(a.watchScope()).at;
  const skipped=await a.review('Scheduled review');assert.equal(skipped.skipped,true,'on: nothing changed, skipped');assert.ok(events.some(e=>e.title==='Review skipped · nothing decision-relevant changed'));
  await a.review('User request').catch(()=>{});assert.equal(a.reviewGate.baseline(a.watchScope()).at,before,'a failed review after a poll leaves the baseline');
  assert.throws(()=>a.configure({reviewGate:'maybe'}),/INVALID_SETTINGS/);
});
test('a filing that arrives while a review runs is not marked seen by it',async()=>{
  const {a,queue}=harness();const filing={id:'u9',source:'DART',kind:'disclosure',title:'Contract',receipt:'20261029000900',symbols:['005930'],importance:'high',firstSeenAt:Date.now(),triggeredAt:null};
  queue.push(()=>{a.newsEvents.save(filing);return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};});
  await a.review('Scheduled review');const base=a.reviewGate.baseline(a.watchScope());assert.ok(base);assert.equal(base.seen.includes(newsKey(filing)),false);
  await a.review('Scheduled review');assert.equal(a.reviewGate.baseline(a.watchScope()).seen.includes(newsKey(filing)),true,'the next review saw it');
});
test('review findings: cash flips need a cash change, mid-review closes count, new orders count, duplicates and missing markets',()=>{
  // 2026-10-29 replay: GOOGL near $310 with ~$310 of KRW cash flipped "affordable" on price jitter with cash unchanged.
  const google=c=>({...c,positions:{...c.positions,'NASD:GOOGL':{quantity:1}}});const base=settled(google(quote(ctx(),'NASD:GOOGL',{price:309})));
  assert.equal(gate(base,google(quote(ctx(),'NASD:GOOGL',{price:311}))).needsReview,false,'price jitter alone');
  const desk=recent=>ctx({agentDesk:{conditionalOrders:{armed:[],recent,unprotected:[]}}});const closed=(id,status,at)=>({id,symbol:'028050',purpose:'stop_loss',status,at:new Date(at).toISOString()});
  const during=settled(desk([]),{at:min(3),contextAt:min(1)});
  assert.equal(gate(during,desk([closed('C-1','expired',min(2))])).reasons[0]?.kind,'protection','a stop that expired while the review ran');
  assert.equal(gate(during,desk([closed('C-1','cancelled',min(2))])).needsReview,false,'cancelled by the review itself');
  assert.equal(gate(during,desk([closed('C-0','expired',min(0))])).needsReview,false,'closed before the review read its context');
  assert.equal(gate(during,desk([{...closed('C-2','firing',min(2))}])).needsReview,false,'firing is not closed');
  const order=(list)=>({orderFollowUp:{orders:list}});const o=(symbol,side,status='Accepted')=>({symbol,side,quantity:1,filled:0,status});
  assert.equal(gate(settled(),ctx(order([o('028050','Sell')]))).reasons[0].detail,'New Sell order for 028050: Accepted','placed outside the decision');
  assert.equal(gate(settled(ctx(),{decision:{action:'Sell',symbol:'028050',orderId:'O1'}}),ctx(order([o('028050','Sell')]))).needsReview,false,'the decision’s own order');
  assert.equal(gate(settled(ctx(order([o('000270','Buy'),o('000270','Buy')]))),ctx(order([o('000270','Buy')]))).reasons[0].kind,'order','one of two identical orders gone');
  const noUS=ctx();noUS.markets=[noUS.markets[0]];assert.equal(gate(settled(),noUS).needsReview,false,'U.S. data missing is not a session change');
});
test('review scope: routine reviews get what changed; starts, requests, the backstop and no baseline are broad',()=>{
  const {reviewScope}=require('../electron/review-gate.cjs');const base=settled();
  const moved=gate(base,quote(ctx(),'028050',{price:60300*1.02}));const s=reviewScope(moved,'Scheduled review',base);
  assert.equal(s.kind,'routine');assert.equal(s.since,new Date(t0).toISOString());assert.deepEqual(s.changedSymbols,['028050']);assert.match(s.changes[0],/028050 \+2%/);
  assert.equal(reviewScope(gate(base,ctx(),{trigger:'User request'}),'User request',base).kind,'broad');
  assert.equal(reviewScope(compare(base,decisionState(ctx()),{config,now:min(120)}),'Scheduled review',base).why,'No full review for 120 minutes');
  assert.equal(reviewScope(compare(null,decisionState(ctx()),{config,now:t0}),'Scheduled review',null).kind,'broad');
  const price=gate(base,quote(ctx(),'028050',{price:60300*1.02}),{trigger:'Price movement trigger'});assert.deepEqual(reviewScope(price,'Price movement trigger',base).changes,[price.reasons[1].detail],'the trigger itself is not a change');
});
test('through the scheduler: focused routine reviews carry reviewScope; full ones do not; carried is a strategy verdict',async()=>{
  const contexts=[];const {a}=harness();a.provider.request=async(op,payload)=>{contexts.push(payload.context);return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};};
  a.configure({skipUnchanged:false});await a.review('Scheduled review');assert.equal(contexts.at(-1).reviewScope,undefined,'full by default');
  a.configure({routineReviews:'focused'});await a.review('Scheduled review');assert.deepEqual(contexts.at(-1).reviewScope.kind,'routine');
  await a.review('User request');assert.equal(contexts.at(-1).reviewScope.kind,'broad');assert.throws(()=>a.configure({routineReviews:'narrow'}),/INVALID_SETTINGS/);
  const {decisionSchema,validateDecision}=require('../electron/ai-client.cjs');assert.match(JSON.stringify(decisionSchema(['005930'])),/"carried"/);
  assert.equal(validateDecision({action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:'',strategyCheck:[{strategy:'long-term',idea:'',verdict:'carried',reason:'Routine review'}]},['005930']).strategyCheck[0].verdict,'carried');
});
