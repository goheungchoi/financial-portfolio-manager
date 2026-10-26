const test=require('node:test');const assert=require('node:assert/strict');
const rc=require('../electron/review-context.cjs');const {reviewByteLimit}=require('../electron/ai-models.cjs');
// A combined Korea + U.S. review shaped and sized like the one that failed on 2026-10-26 (78.6 KB against 70 KB): each
// market's trading costs also inside markets[], a long scout plan with brief answers, performance history, notes.
// Synthetic (the real one holds the account's data and this repository is public); n scales the portfolio.
const text=(n,seed='')=>(seed+' lorem ipsum dolor sit amet').repeat(Math.ceil(n/27)).slice(0,n);
function failedLike(n=1){
  const kr=Array.from({length:6*n},(_,i)=>String(100000+i)),us=Array.from({length:6*n},(_,i)=>`NASD:T${i}`),all=[...kr,...us];
  const tc=market=>({market,settings:{krCommissionPct:0.015,usCommissionPct:0.25,taxYear:2026,taxMethod:'moving-average'},krSaleTaxPct:0.2,acquisitionFeeAssumption:text(180),taxModel:text(1000,'tax'),tax:{ruleVersion:'kr-tax-2026-10-25',applicability:{status:'estimated'},classification:Object.fromEntries((market==='US'?us:kr).map(s=>[s,{instrument:'x',transactionTax:'taxable',incomeTax:'y'}]))},
    heldSale:(market==='US'?us:kr).slice(0,2).map(s=>({symbol:s,quantity:1,netCash:100,taxableGainKRW:-5000,incomeTax:{status:'incomplete',missingInputs:['gains realized at other brokers this year']}})),
    oneShare:(market==='US'?us:kr).map(s=>({symbol:s,buy:{gross:100,commission:0.25,netCash:-100.25},sell:{gross:100,commission:0.25,transactionTax:0.2,netCash:99.55,incomeTax:{status:'incomplete',missingInputs:['x'],assumptions:[text(420)],ruleVersion:'r',asOf:'2026-10-26T00:00:00Z',sourceIds:['a','b']}}}))});
  const markets=[{market:'KR',currency:'KRW',equity:776000,cash:500995,unsettledUSBuysKRW:712078,cashNote:text(220),marketSession:{open:true,status:'open'},executionEnabled:true,automaticExecutionEnabled:true,tradingCosts:tc('KR'),productRisk:{leveragedEtps:{allowed:false}}},
    {market:'US',currency:'USD',equity:531,cash:0,marketSession:{open:false,status:'closed'},executionEnabled:true,automaticExecutionEnabled:true,tradingCosts:tc('US'),buyingPower:{usd:378,integratedMargin:true,fromKRWUSD:378}}];
  return {environment:'kis-combined',currency:'MULTI',baseCurrency:'KRW',equity:1487823,cash:{KRW:500995,USD:0},equityUncertainty:{understatedUpToKRW:712078,reasons:['funding of ₩712,078 of unsettled U.S. buys is not yet known (KRW or USD)']},equityReliability:{reliable:false,reasons:['funding of ₩712,078 of unsettled U.S. buys is not yet known (KRW or USD)']},
    positions:Object.fromEntries(all.slice(0,4*n).map(s=>[s,{quantity:1,costTotal:100,market:s.includes(':')?'US':'KR'}])),orders:[{symbol:kr[0],side:'Buy',quantity:1,status:'Accepted',orderId:'1'}],orderReconciliation:[{market:'KR',status:'unconfirmed'}],
    universe:all.map(s=>({symbol:s,name:'Name '+s,price:100,market:s.includes(':')?'US':'KR'})),quotes:all.map(s=>({symbol:s,price:100,previousClose:101,changePct:-1,timestamp:1,stale:false})),markets,
    risk:{markets:{KR:{baseline:1,lossLimit:{mode:'off'}},US:null}},emergency:{active:false,loss:null},marketSession:{open:true,status:'mixed'},triggerEvidence:{kind:'price',symbol:kr[0],movePct:2.1},fx:{usdKRW:1324.6},
    userGuidelines:text(4300,'guide'),objective:text(700),tradingCosts:{markets:[{...tc('KR')},{...tc('US')}]},
    scoutPlan:{asOf:'2026-10-26',summary:text(470),focus:text(370),targets:all.slice(0,10).map(s=>({symbol:s,role:'candidate',targetWeightPct:10,thesis:text(220),watch:text(60)})),briefAnswers:Array.from({length:6},(_,i)=>({briefId:'B-'+i,asked:text(600,'q'+i),answer:text(500,'a'+i)}))},
    agentDesk:{notes:all.slice(0,6).map(s=>({symbol:s,note:text(560),updatedAt:'2026-10-26T00:00:00Z'})),conditionalOrders:{allowed:true,monitoring:'active',orders:[]}},
    performance:{history:{KR:{since:'2026-10-19',currency:'KRW',benchmark:'KOSPI',timeWeightedReturns:['1W','1M','3M','YTD','1Y','All'].map(p=>({period:p,from:'2026-10-19',partial:p!=='1W',returnPct:0.18,benchmarkPct:-3.77})),risk:{maxDrawdownPct:-0.24,currentDrawdownPct:0,volatilityPct:2.5,bestDay:{day:'2026-10-24'}},daily:text(3000)},US:{since:'2026-10-24',timeWeightedReturns:[],risk:{}}}},
    marketNarrative:{asOf:'2026-10-25',regime:'risk_off',summary:text(900),drivers:Array.from({length:5},(_,i)=>({kind:'background',title:'Driver '+i,summary:text(420),signals:[text(80)]}))},
    positionSizing:{riskPerTradePct:10,rows:all.map(s=>({symbol:s,price:100,atr:4.1,stopDistance:8.2,suggestedStop:91.8,maxShares:4,limitedBy:'cash',maxValueKRW:400,maxWeightPct:28}))},
    macro:{series:Array.from({length:8},(_,i)=>({id:'M'+i,value:1,date:'2026-10-22',history:Array.from({length:12},(_,j)=>({date:'d'+j,value:j}))}))},
    similarEpisodes:Array.from({length:3},(_,i)=>({day:'2026-10-2'+i,title:'Episode '+i,kind:'selloff',similarity:0.4,sharedThemes:['a','b'],drivers:[text(120),text(120),text(120)],forward:{d1:0.1,d5:0.5,d20:1}})),
    planGap:{targets:all.slice(0,8).map(s=>({symbol:s,plannedWeightPct:10,heldWeightPct:0,minimumPosition:{feasible:true,weightPct:7,detail:text(80)}}))},
    news:Array.from({length:14},(_,i)=>({title:i%4===0?'Chip stocks fall':'Story '+i,published:'Mon',symbols:[all[i%all.length]],importance:'normal'})),
    eventCalendar:Array.from({length:8},(_,i)=>({date:'2026-10-3'+(i%2),kind:'earnings',title:'Event '+i+' '+text(60),symbol:all[i]})),
    orderBooks:{readAt:'t',staleAfterSeconds:300,delay:text(90),books:all.map(s=>({symbol:s,bid:99,ask:100,bidSize:400,askSize:500,spreadPct:0.1,quoteTime:'12:57',ageSeconds:3,stale:false}))},
    discovery:{enabled:true,watchlist:all.map(s=>({symbol:s,reason:text(60)}))},reviewWatches:Array.from({length:6},(_,i)=>({symbol:all[i],kind:'price',reason:text(120)}))};
}
const MANDATORY_SAME=['positions','cash','equity','orders','orderReconciliation','equityReliability','equityUncertainty','quotes','universe','triggerEvidence','risk','emergency','marketSession','fx','userGuidelines'];
test('the failed review shape fits once duplication is removed and background starts as summaries; nothing mandatory is lost',()=>{
  const ctx=failedLike();const limit=reviewByteLimit({});assert.ok(rc.wire(ctx)>limit,`the fixture is oversized like the real one (${rc.wire(ctx)})`);
  const combined={...ctx,...rc.combineTradingCosts(ctx.markets)};assert.ok(combined.markets.every(m=>!m.tradingCosts),'trading costs stated once');assert.equal(typeof combined.tradingCosts.taxModel,'string');assert.ok(combined.tradingCosts.markets.every(m=>!m.taxModel),'the tax model once for both markets');
  const s=rc.shape(combined);assert.ok(s.fits,`fits: ${s.report.wireBytes} of ${limit}`);
  for(const k of MANDATORY_SAME)assert.deepEqual(s.context[k],ctx[k],`${k} untouched`);
  assert.deepEqual(s.context.markets.map(m=>Object.keys(m)),ctx.markets.map(m=>Object.keys(m).filter(k=>k!=='tradingCosts')),'execution restrictions and buying power kept');
  assert.deepEqual(s.context.tradingCosts.markets.map(m=>m.heldSale),ctx.tradingCosts.markets.map(m=>m.heldSale),'computed tax estimates and their completeness kept');
  assert.ok(s.context.detailAvailable.includes('scoutPlan.briefAnswers'));assert.deepEqual(s.detail['scoutPlan.briefAnswers'],ctx.scoutPlan.briefAnswers,'the full answers stay readable');
  assert.deepEqual(s.context.scoutPlan.briefAnswers.map(b=>b.briefId),ctx.scoutPlan.briefAnswers.map(b=>b.briefId),'ids kept in the summary');
});
test('section compression keeps every symbol and the binding facts; summaries keep ids, dates and distinct events',()=>{
  const big=failedLike(2);const combined={...big,...rc.combineTradingCosts(big.markets)};assert.ok(rc.shape(combined).fits,'twice the portfolio fits the real limit');
  // A tighter budget forces section compression, to check what each compressor keeps.
  const s=rc.shape(combined,{limit:Math.round(rc.wire(combined)*0.75)});
  const sizing=s.context.positionSizing.rows;assert.deepEqual(sizing.map(r=>r.symbol),big.positionSizing.rows.map(r=>r.symbol),'no sizing row dropped');assert.deepEqual(Object.keys(sizing[0]).sort(),['limitedBy','maxShares','maxWeightPct','suggestedStop','symbol']);
  const books=s.context.orderBooks.books;assert.equal(books.length,big.orderBooks.books.length);assert.deepEqual(Object.keys(books[0]).sort(),['ageSeconds','ask','askSize','bid','bidSize','stale','symbol']);
  assert.ok(s.steps.some(x=>x.section==='positionSizing'&&x.kind==='compressed'),JSON.stringify(s.steps));assert.ok(s.detail.positionSizing,'full sizing readable on request');
  const news=s.context.news;assert.equal(news.filter(n=>n.title==='Chip stocks fall').length,1,'duplicate coverage merged');assert.equal(news.find(n=>n.title==='Chip stocks fall').outlets,4);assert.equal(news.length,big.news.length-3,'distinct stories kept');
  const perf=s.context.performance.history.KR.timeWeightedReturns;assert.ok(perf.some(p=>p.period.includes('/')),'identical periods stated once');assert.equal(perf.reduce((n,p)=>n+p.period.split('/').length,0),6);
  for(const k of MANDATORY_SAME)assert.deepEqual(s.context[k],big[k],`${k} untouched under compression`);
});
test('if the mandatory snapshot alone cannot fit, the review is not sent and nothing mandatory is cut',()=>{
  const huge=failedLike(12);const combined={...huge,...rc.combineTradingCosts(huge.markets)};const s=rc.shape(combined);
  assert.equal(s.fits,false);assert.ok(s.mandatoryBytes>0);for(const k of MANDATORY_SAME)assert.deepEqual(s.context[k],huge[k]);
  assert.match(require('../electron/ai-errors.cjs').messages.CONTEXT_OVER_BUDGET,/mandatory review data alone exceeds/);
});
test('the agent reads a summarized section in full with get_context_detail; unknown sections are refused',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');let round=0,outputs=[];
  const request=async({continuation})=>{round++;if(round===1)return {toolCalls:[{name:'get_context_detail',callId:'d1',args:{section:'scoutPlan.briefAnswers'}},{name:'get_context_detail',callId:'d2',args:{section:'secrets'}}],continuation:[{role:'user',content:'{}'},{type:'function_call',call_id:'d1',name:'get_context_detail',arguments:'{}'},{type:'function_call',call_id:'d2',name:'get_context_detail',arguments:'{}'}],usage:{}};
    outputs=continuation.filter(i=>i.type==='function_call_output').map(i=>JSON.parse(i.output));return {decision:{action:'Hold'},usage:{}};};
  await researchReview({context:{universe:[]},detail:{'scoutPlan.briefAnswers':[{briefId:'B-1',answer:'full answer'}]},evidence:{get:async()=>({})},request,log:()=>{}});
  assert.deepEqual(outputs[0],{section:'scoutPlan.briefAnswers',data:[{briefId:'B-1',answer:'full answer'}]});assert.equal(outputs[1].status,'rejected');assert.match(outputs[1].reason,/available: scoutPlan.briefAnswers/);
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','ai-client.cjs'),'utf8');assert.match(src,/detailAvailable lists sections given as summaries/);assert.match(src,/get_context_detail'\.split/);
});
test('a size failure is not retried on the same inputs; the user, an emergency or a material change still runs',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');let calls=0,fail=true;const logs=[];
  const provider={request:async()=>{calls++;if(fail)throw new Error('CONTEXT_TOO_LARGE');return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);const a=new Automation(db,paper,provider,(id,kind,title,body)=>logs.push(title+' '+body));a.providerStatus.aiConnected=true;
  a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',unlimitedBudget:true,unlimitedCalls:true});
  await assert.rejects(a.review('Scheduled review'));assert.equal(calls,1);
  const skipped=await a.review('Price movement trigger');assert.equal(skipped.skipped,true);assert.equal(calls,1,'same inputs: no second attempt');assert.ok(logs.some(l=>l.startsWith('Review skipped · same inputs as a failed review')));
  fail=false;const user=await a.review('User request');assert.equal(user.decision.action,'Hold');assert.equal(calls,2,'the user can always run it');
  assert.equal(a.failedInput,null,'a completed review clears the memory');
  const {responseError}=require('../electron/ai-errors.cjs');const e=await responseError({status:400,text:async()=>JSON.stringify({error:{code:'context_length_exceeded'}})});assert.equal(e.message,'AI_CONTEXT_LIMIT','the model limit is told apart from the app limit');
});
test('an over-limit request reports which limit rejected it and its largest sections; sizes of every part are kept',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');let sent=null;
  const client=new AiClient('sk-test-0123456789abcdefghij',async(url,init)=>{sent=init;return {ok:false,status:400,text:async()=>JSON.stringify({error:{code:'context_length_exceeded'}})};});
  const ctx={universe:[],quotes:[],positions:{},scoutPlan:{notes:'x'.repeat(80000)}};
  const e=await client.decide(ctx,{openaiModel:'gpt-6-sol',reasoningEffort:'low'}).catch(x=>x);assert.equal(e.message,'CONTEXT_TOO_LARGE');assert.equal(e.detail.limit,'app bytes');assert.match(e.detail.largest[0],/^scoutPlan:/);assert.equal(sent,null,'nothing was sent');
  const m=await client.decide({universe:[],quotes:[],positions:{}},{openaiModel:'gpt-6-sol',reasoningEffort:'low'}).catch(x=>x);assert.equal(m.message,'AI_CONTEXT_LIMIT');assert.equal(m.detail.limit,'model context window');
  assert.ok(client.lastRequestSizes.instructionsBytes>1000&&client.lastRequestSizes.inputBytes>0,'instructions and input measured apart');
});
