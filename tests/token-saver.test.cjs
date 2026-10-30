const test=require('node:test');const assert=require('node:assert/strict');
const {fingerprint,shouldSkip,compact,route,nearBudget}=require('../electron/token-saver.cjs');
const {DEFAULTS,Automation}=require('../electron/automation.cjs');const {DatabaseSync}=require('node:sqlite');const {PaperEngine}=require('../electron/paper-engine.cjs');
function engine(decide){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:50000}],()=>[{symbol:'005930',price:50000,sequence:1,timestamp:Date.now(),volume:10,stale:false}]);paper.saveAccount({...paper.account(),paused:false});
  const requests=[];const provider={request:async(_op,payload)=>{requests.push(payload);return {provider:'openai',model:payload.options.openaiModel,decision:decide(payload),usage:{inputTokens:100,outputTokens:10}};}};
  const automation=new Automation(db,paper,provider,()=>{});automation.providerStatus.aiConnected=true;return {automation,requests,paper};
}
const hold={action:'Hold',symbol:'',quantity:0,explanation:'Nothing changed.'};
test('a repeated scheduled review with unchanged state makes no AI call; a user request still does',async()=>{
  const {automation,requests}=engine(()=>hold);automation.configure({provider:'openai'});
  await automation.review('Scheduled review');assert.equal(requests.length,1);
  const skipped=await automation.review('Scheduled review');assert.equal(skipped.skipped,true);assert.equal(requests.length,1);
  await automation.review('User request');assert.equal(requests.length,2);
  assert.equal(automation.getState().tokenSaving.today.skipped,1);assert.ok(!('performance' in requests[0].context&&requests[0].context.performance==null),'compact context');
});
test('auto routing: routine reviews use the cheap model and a proposed trade is confirmed by the configured model',async()=>{
  const {automation,requests}=engine(({options,context})=>context.confirmation?{action:'Buy',symbol:'005930',quantity:1,explanation:'Confirmed.'}:options.openaiModel==='gpt-6-luna'?{action:'Buy',symbol:'005930',quantity:2,explanation:'Cheap model idea.'}:hold);
  automation.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'medium',modelRouting:'auto'});
  const review=await automation.review('Scheduled review');
  assert.deepEqual(requests.map(r=>r.options.openaiModel),['gpt-6-luna','gpt-6-sol']);assert.equal(requests[1].context.confirmation.decision.quantity,2);
  assert.equal(review.decision.quantity,1,'the confirming model decides');assert.equal(review.routing.confirmed,false);assert.equal(review.routing.tier,'routine');
  requests.length=0;await automation.review('User request');assert.deepEqual(requests.map(r=>r.options.openaiModel),['gpt-6-sol'],'user requests are escalated');
  assert.throws(()=>automation.configure({modelRouting:'smart'}),/INVALID_SETTINGS/);assert.throws(()=>automation.configure({routineModel:'gpt-6-astra',routineEffort:'none'}),/INVALID_MODEL_SETTINGS/);
});
const base=()=>({environment:'kis',market:'KR',universe:[{symbol:'005930',price:70000}],quotes:[{symbol:'005930',price:70000,retrievedAt:1}],positions:{'005930':{quantity:10,costTotal:650000}},cash:1000000,news:[{title:'A',published:'20261016',symbols:[],importance:'normal'}],reviewedLessons:[],marketSession:{open:true},emergency:{active:false},performance:{currentEquity:1700000},timestamp:'x'});
const skip=(next,config={...DEFAULTS},now=60*60000,trigger='Scheduled review')=>shouldSkip({trigger,config,fingerprint:fingerprint(next),last:{...fingerprint(base()),completedAt:0},now});
test('unchanged state is skipped despite timestamps, small moves and routine headlines; holdings, important news, sessions and larger moves are not',()=>{
  const moved=base();moved.quotes[0].price=70300;moved.universe[0].price=70300;moved.quotes[0].retrievedAt=999;moved.performance.currentEquity=1;moved.timestamp='y';moved.cash=1005000;
  assert.equal(skip(moved),true,'0.4% price and 0.5% cash moves are within half the 3% tolerance');
  const big=base();big.quotes[0].price=71400;assert.equal(skip(big),false,'a 2% move exceeds 1.5%');
  const sold=base();sold.positions['005930'].quantity=5;assert.equal(skip(sold),false);
  const news=base();news.news.push({title:'B',symbols:['005930'],importance:'normal'});assert.equal(skip(news),true,'routine headlines, even about held stocks, do not block a skip');
  const important=base();important.news.push({title:'C',symbols:['005930'],importance:'high'});assert.equal(skip(important),false);
  const background=base();background.marketNarrative={drivers:[1]};background.eventCalendar=[{date:'2026-10-20'}];background.marketRegime={regime:'neutral',score:0.1};const later=base();later.marketRegime={regime:'neutral',score:0.3};
  assert.equal(shouldSkip({trigger:'Scheduled review',config:{...DEFAULTS},fingerprint:fingerprint(later),last:{...fingerprint(background),completedAt:0},now:60*60000}),true,'background and regime score changes do not block a skip');
  const riskOff=base();riskOff.marketRegime={regime:'risk-off'};assert.equal(shouldSkip({trigger:'Scheduled review',config:{...DEFAULTS},fingerprint:fingerprint(riskOff),last:{...fingerprint(later),completedAt:0},now:60*60000}),false,'a regime change does');
  const closed=base();closed.marketSession.open=false;assert.equal(skip(closed),false);
});
test('only scheduled reviews are skipped, within the maximum skip age',()=>{
  assert.equal(skip(base()),true);assert.equal(skip(base(),{...DEFAULTS},121*60000),false,'a full review at least every 2 hours');
  for(const trigger of ['User request','News event trigger','Price movement trigger','Emergency loss response'])assert.equal(skip(base(),{...DEFAULTS},1,trigger),false,trigger);
  assert.equal(skip(base(),{...DEFAULTS,skipUnchanged:false}),false);
});
test('compact drops empty values, rounds decimals, keeps universe and puts stable parts first',()=>{
  const value=compact({quotes:[{symbol:'NASD:A',price:123.456789,note:null}],universe:[],userGuidelines:'Keep cash',reviewedLessons:[],environment:'kis',news:[{title:'x'.repeat(300),url:'https://example.com',source:'RSS',symbols:[],importance:'normal'}]});
  assert.deepEqual(Object.keys(value).slice(0,2),['environment','userGuidelines']);assert.equal(value.quotes[0].price,123.4568);assert.equal('note' in value.quotes[0],false);
  assert.deepEqual(value.universe,[]);assert.equal('reviewedLessons' in value,false);assert.equal(value.news[0].title.length,160);assert.equal('url' in value.news[0],false);
});
test('routing: fixed keeps the configured model; auto sends routine reviews to the cheap model and escalates important ones',()=>{
  const config={...DEFAULTS,openaiModel:'gpt-6-sol',reasoningEffort:'medium'};
  assert.deepEqual(route(config,{trigger:'Scheduled review'}),{openaiModel:'gpt-6-sol',reasoningEffort:'medium',tier:'fixed',reason:'fixed model'});
  assert.equal(route(config,{trigger:'Scheduled review',nearBudget:true}).openaiModel,'gpt-6-luna','near the budget even fixed mode degrades');
  const auto={...config,modelRouting:'auto'};assert.equal(route(auto,{trigger:'Scheduled review'}).openaiModel,'gpt-6-luna');assert.equal(route(auto,{trigger:'Price movement trigger'}).tier,'routine');
  assert.equal(route(auto,{trigger:'Scheduled review',emergencyActive:true}).reason,'emergency');assert.equal(route(auto,{trigger:'User request'}).openaiModel,'gpt-6-sol');
  assert.equal(route(auto,{trigger:'News event trigger',triggerEvidence:{kind:'news',events:[{importance:'high'}]}}).reason,'important disclosure');assert.equal(route(auto,{trigger:'News event trigger',triggerEvidence:{kind:'news',events:[{importance:'normal'}]}}).tier,'routine');
  assert.equal(nearBudget({...DEFAULTS,maxUSDPerDay:1},{calls:0,reservedMicro:800000}),true);assert.equal(nearBudget({...DEFAULTS,maxCallsPerDay:20},{calls:15,reservedMicro:0}),false);assert.equal(nearBudget({...DEFAULTS,unlimitedBudget:true,unlimitedCalls:true},{calls:1e6,reservedMicro:1e12}),false);
});
// Review of 8ef1be1, P2: the skip compared every field outside a background list exactly, so volume 1,000 -> 1,001
// with an unchanged price and portfolio forced another paid scheduled review.
test('the skip compares an explicit list: volume-only and derived updates skip; price moves, account changes, risk events and triggers do not',()=>{
  const ctx=(over={})=>({environment:'kis-combined',currency:'MULTI',cash:500000,equity:1400000,positions:{'005930':{quantity:3,costTotal:180000}},
    quotes:[{symbol:'005930',price:60000,previousClose:59500,changePct:0.84,volume:1000,timestamp:1,stale:false},{symbol:'NASD:GOOGL',price:280,changePct:-0.4,volume:5000,timestamp:1,stale:false}],
    marketSession:{open:true,status:'open'},markets:[{market:'KR',cash:500000,equity:900000,marketSession:{open:true,status:'open'},executionEnabled:true}],
    emergency:{active:false,scope:'both',loss:{policy:{mode:'percent',value:3},baseline:1400000,equity:1400000,loss:0,lossPct:0,breached:false}},
    tradingCosts:{markets:[{market:'KR',settings:{krCommissionPct:0.015},oneShare:[{symbol:'005930',buy:{gross:60000,commission:9,netCash:-60009}}],heldSale:[{symbol:'005930',quantity:3,netCash:179600,annualTaxChangeKRW:0}]}]},
    news:[{title:'Routine story',importance:'normal'}],...over});
  const config={skipUnchanged:true,maxSkipMinutes:60,eventTolerancePct:3},last={...fingerprint(ctx()),completedAt:Date.now()-60000};
  const skip=(c,trigger='Scheduled review')=>shouldSkip({trigger,config,fingerprint:fingerprint(c),last});
  const q=(i,patch)=>{const c=ctx();c.quotes=c.quotes.map((x,j)=>j===i?{...x,...patch}:x);return c;};
  assert.equal(skip(q(0,{volume:1001})),true,'volume 1,000 -> 1,001: skipped');
  assert.equal(skip(q(1,{volume:9000,changePct:-0.41,timestamp:2})),true,'volume, change % and quote time only');
  // Derived figures recomputed from a small price move do not block a skip either.
  const small=q(0,{price:60100,changePct:1.01});small.tradingCosts.markets[0].oneShare[0].buy={gross:60100,commission:9.02,netCash:-60109.02};small.emergency.loss={...small.emergency.loss,loss:300,lossPct:0.02};
  assert.equal(skip(small),true,'0.17% move with its recomputed costs and loss: within tolerance');
  assert.equal(skip(ctx({news:[{title:'Routine story',importance:'normal'},{title:'Another routine story',importance:'normal'}]})),true,'an ordinary headline');
  // What must still run.
  assert.equal(skip(q(0,{price:61500})),false,'a 2.5% move, past half the 3% tolerance');
  assert.equal(skip(ctx({positions:{'005930':{quantity:2,costTotal:120000}}})),false,'a fill changed the holding');
  assert.equal(skip(ctx({cash:400000})),false,'cash moved 20%');
  assert.equal(skip(ctx({emergency:{...ctx().emergency,loss:{...ctx().emergency.loss,breached:true}}})),false,'the loss limit breached');
  assert.equal(skip(ctx({emergency:{...ctx().emergency,active:true}})),false,'an emergency');
  assert.equal(skip(ctx({markets:[{...ctx().markets[0],executionEnabled:false}]})),false,'execution switched off');
  assert.equal(skip(q(0,{stale:true})),false,'a quote went stale');
  assert.equal(skip(ctx({news:[{title:'Merger filing',importance:'high'}]})),false,'an important filing');
  assert.equal(skip(ctx({tradingCosts:{markets:[{market:'KR',settings:{krCommissionPct:0.02}}]}})),false,'the fee plan changed');
  for(const trigger of ['Price movement trigger','Agent trigger','News event trigger','Order update','User request'])assert.equal(skip(q(0,{volume:1001}),trigger),false,`${trigger} is never skipped`);
  // Volume stays in what the model reads.
  assert.equal(compact(q(0,{volume:1001})).quotes[0].volume,1001,'kept in the model input');
});
