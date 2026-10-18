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
