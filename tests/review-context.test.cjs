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
test('point 1: detail is read in bounded, selectable parts; a large section never brings the overflow back',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');
  const big=failedLike(20);const combined={...big,...rc.combineTradingCosts(big.markets)};const shaped=rc.shape(combined,{limit:Math.round(rc.wire(combined)*0.6)});
  assert.ok(rc.bytes(shaped.detail.positionSizing)>4*8000,`a section larger than a round of detail replies (${rc.bytes(shaped.detail.positionSizing)})`);
  const d=rc.detailPart(shaped.detail,{section:'positionSizing',part:'',page:1});assert.equal(d.complete,false);assert.deepEqual(d.parts.map(p=>p.part),['riskPerTradePct','rows'],'a large object lists its parts');
  const p1=rc.detailPart(shaped.detail,{section:'positionSizing',part:'rows',page:1});assert.ok(rc.bytes(p1)<=8000);assert.ok(p1.pages>1);assert.equal(p1.totalItems,big.positionSizing.rows.length);assert.equal(p1.complete,false);
  const pages=Array.from({length:p1.pages},(_,k)=>rc.detailPart(shaped.detail,{section:'positionSizing',part:'rows',page:k+1}));assert.deepEqual(pages.flatMap(x=>x.data).map(r=>r.symbol),big.positionSizing.rows.map(r=>r.symbol),'every row reachable, none twice');
  const one=rc.detailPart(shaped.detail,{section:'positionSizing',part:'NASD:T3',page:1});assert.equal(one.complete,true);assert.deepEqual(one.data,big.positionSizing.rows.filter(r=>r.symbol==='NASD:T3'),'rows about one symbol');
  assert.equal(rc.detailPart(shaped.detail,{section:'secrets',part:'',page:1}).status,'rejected');
  // Through a review: four detail requests in one round on top of a first request at the limit stay under the follow-up limit.
  const sent=[];let round=0;const base='c'.repeat(69000);
  const request=async({continuation})=>{if(continuation)sent.push(cf.size(continuation));round++;if(round===1){const calls=[1,2,3,4].map(k=>({name:'get_context_detail',callId:'d'+k,args:{section:'positionSizing',part:'rows',page:k}}));
    return {toolCalls:calls,continuation:[{role:'user',content:base},...calls.map(c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)}))],usage:{}};}
    return {decision:{action:'Hold'},usage:{}};};
  await researchReview({context:{universe:[]},detail:shaped.detail,evidence:{get:async()=>({})},request,log:()=>{}});assert.ok(sent.every(n=>n<=cf.LIMIT*cf.TARGET),'within the budget: '+sent.join(','));
});
test('point 2: three research rounds of four maximum-size responses fit on top of a first request at the limit',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');
  const huge=k=>({overview:{price:216000+k},a:'a'.repeat(15000),b:'b'.repeat(15000),c:'c'.repeat(15000)});const sent=[];let round=0;let fetched=0;
  const request=async({continuation})=>{if(continuation)sent.push(cf.size(continuation));round++;const prior=continuation??[{role:'user',content:'x'.repeat(69500)}];
    if(round<4){const calls=[0,1,2,3].map(k=>({name:'get_company_research',callId:`r${round}${k}`,args:{symbol:'005930',sections:['s'+round+k]}}));return {toolCalls:calls,continuation:[...prior,...calls.map(c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)}))],usage:{}};}
    return {decision:{action:'Hold'},usage:{}};};
  const r=await researchReview({context:{universe:[{symbol:'005930'}],discovery:{enabled:true}},evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:async a=>{fetched++;return huge(fetched);}}});
  assert.equal(r.decision.action,'Hold');assert.equal(sent.length,3);assert.ok(sent.every(n=>n<=cf.LIMIT),'every follow-up within the limit: '+sent.join(','));
  const top=sent.map(n=>n<=cf.LIMIT*cf.TARGET);assert.ok(top.every(Boolean),'and within the fitting point: '+sent.join(','));
});
test('point 3: compacted evidence stays reachable in the same review, and what was left out stays marked',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');
  let round=0,fetched=0;const seen=[];const big={overview:{price:216000},closes:'c'.repeat(13000)};
  const request=async({continuation})=>{round++;const prior=continuation??[{role:'user',content:'x'.repeat(69500)}];if(continuation)seen.push(continuation.filter(i=>i.type==='function_call_output').map(i=>JSON.parse(i.output)));
    const mk=(id,sym)=>({name:'get_company_research',callId:id,args:{symbol:sym,sections:['all']}});
    const calls=round===1?[0,1,2,3].map(k=>mk('a'+k,'00593'+k)):round===2?[0,1,2,3].map(k=>mk('b'+k,'00594'+k)):round===3?[mk('again','005930')]:null;
    if(calls)return {toolCalls:calls,continuation:[...prior,...calls.map(c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)}))],usage:{}};return {decision:{action:'Hold'},usage:{}};};
  await researchReview({context:{universe:['005930','005931','005932','005933','005940','005941','005942','005943'].map(s=>({symbol:s})),discovery:{enabled:true}},evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:async()=>{fetched++;return {...big,extra:'e'.repeat(20000)};}}});
  const afterTwo=seen[1];assert.ok(afterTwo.some(o=>o.reference===true&&o.request.name==='get_company_research'),'older results became references naming their request');
  assert.ok(afterTwo.filter(o=>!o.reference).every(o=>Array.isArray(o.omittedParts)&&o.omittedParts.includes('extra')),'parts left out are named on every bounded result');
  const again=seen[2].at(-1);assert.equal(again.overview.price,216000,'the referenced result is read again');assert.equal(fetched,8,'from the review cache, not fetched again');
});
test('point 4: a size failure is not retried on the same inputs, but fills, cancellations, cash, important news and sessions are material',()=>{
  const saver=require('../electron/token-saver.cjs');const base=failedLike();const mk=c=>({...saver.fingerprint(c),cash:rc.cashOf(c)});const failed=mk(base);
  assert.equal(rc.sameInputs(failed,mk(structuredClone(base)),3),true,'identical inputs are suppressed');
  const priceWithin=structuredClone(base);priceWithin.quotes[0].price=100.5;assert.equal(rc.sameInputs(failed,mk(priceWithin),3),true,'a price move within the tolerance');
  const changes={
    'a fill':c=>{c.positions[Object.keys(c.positions)[0]].quantity=2;},
    'a cancellation':c=>{c.orders[0].status='Canceled';},
    'changed cash':c=>{c.cash.KRW+=1000;},
    'changed market cash':c=>{c.markets[0].cash+=1000;},
    'fresh important news':c=>{c.news=[...c.news,{title:'Earnings warning',published:'Mon',symbols:['100000'],importance:'high'}];},
    'a session transition':c=>{c.marketSession={open:false,status:'closed'};},
    'a price move beyond the tolerance':c=>{c.quotes[0].price=110;},
    'new trigger evidence':c=>{c.triggerEvidence={kind:'news',events:[{title:'x'}]};},
    'settlement clearing uncertainty':c=>{c.equityReliability={reliable:true};delete c.equityUncertainty;}};
  for(const [name,change] of Object.entries(changes)){const c=structuredClone(base);change(c);assert.equal(rc.sameInputs(failed,mk(c),3),false,name+' runs again');}
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
