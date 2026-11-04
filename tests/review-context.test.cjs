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
// Reads a part to the end by following next.from; each read may have a different size allowance.
const readAll=(detail,section,part,limits=[8000])=>{const out=[];let from=0;for(let i=0;i<10000;i++){const r=rc.detailPart(detail,{section,part,from},limits[i%limits.length]);out.push(r);if(!r.next)return out;assert.equal(r.next.from,r.to);from=r.next.from;}throw new Error('no end');};
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
  assert.match(require('../electron/ai-errors.cjs').messages.CONTEXT_OVER_BUDGET,/over the app byte limit even after shortening/);
});
test('point 1: detail is read in bounded, selectable parts; a large section never brings the overflow back',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');
  const big=failedLike(20);const combined={...big,...rc.combineTradingCosts(big.markets)};const shaped=rc.shape(combined,{limit:Math.round(rc.wire(combined)*0.6)});
  assert.ok(rc.bytes(shaped.detail.positionSizing)>4*8000,`a section larger than a round of detail replies (${rc.bytes(shaped.detail.positionSizing)})`);
  const d=rc.detailPart(shaped.detail,{section:'positionSizing',part:'',from:0});assert.equal(d.complete,false);assert.equal(d.data.riskPerTradePct,10,'small parts come inline');assert.deepEqual(d.omittedParts.map(p=>p.part),['rows'],'a large part is named by its path');
  const p1=rc.detailPart(shaped.detail,{section:'positionSizing',part:'rows',from:0});assert.ok(rc.bytes(p1)<=8000);assert.ok(p1.next.from>0);assert.equal(p1.totalItems,big.positionSizing.rows.length);assert.equal(p1.complete,false);
  const pages=readAll(shaped.detail,'positionSizing','rows');assert.deepEqual(pages.flatMap(x=>x.data).map(r=>r.symbol),big.positionSizing.rows.map(r=>r.symbol),'every row reachable, none twice');
  const one=rc.detailPart(shaped.detail,{section:'positionSizing',part:'NASD:T3',from:0});assert.equal(one.complete,true);assert.deepEqual(one.data,big.positionSizing.rows.filter(r=>r.symbol==='NASD:T3'),'rows about one symbol');
  assert.equal(rc.detailPart(shaped.detail,{section:'secrets',part:'',from:0}).status,'rejected');
  // Through a review: four detail requests in one round on top of a first request at the limit stay under the follow-up limit.
  const sent=[];let round=0;const base='c'.repeat(69000);
  const request=async({continuation})=>{if(continuation)sent.push(cf.size(continuation));round++;if(round===1){const calls=[1,2,3,4].map(k=>({name:'get_context_detail',callId:'d'+k,args:{section:'positionSizing',part:'rows',from:(k-1)*5}}));
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
  const e=await client.decide(ctx,{openaiModel:'gpt-6-sol',reasoningEffort:'low'}).catch(x=>x);assert.equal(e.message,'CONTEXT_OVER_BUDGET','a first request over the app limit');assert.equal(e.detail.limit,'app bytes');assert.match(e.detail.stage,/first request/);assert.match(e.detail.largest[0],/^scoutPlan:/);assert.equal(sent,null,'nothing was sent');
  const m=await client.decide({universe:[],quotes:[],positions:{}},{openaiModel:'gpt-6-sol',reasoningEffort:'low'}).catch(x=>x);assert.equal(m.message,'AI_CONTEXT_LIMIT');assert.equal(m.detail.limit,'model context window');
  assert.ok(client.lastRequestSizes.instructionsBytes>1000&&client.lastRequestSizes.inputBytes>0,'instructions and input measured apart');
});
// Review of 22fdc4f..4b05851, finding 1: budgets were measured before results became JSON strings inside the request,
// so quotes and backslashes (escaped twice there) made follow-ups larger than planned (174,362 bytes against 140,000).
const escaped=n=>{const unit='{"a":"\\"quoted\\" C:\\\\path\\\\x","k":"한국어 \"따옴표\""}\n\t';return unit.repeat(Math.ceil(n/unit.length)).slice(0,n);};
test('wire 1: tool results are measured as sent; four quote-heavy results on a 69.5 KB first request stay within the follow-up budget',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');
  assert.equal(rc.outBytes('"'.repeat(100)),406,'a quote costs four bytes in the request');
  // The first request: context JSON (full of quotes) inside a user message, 69.5 KB as sent.
  let ctx={notes:''};while(rc.wire(ctx)<69500)ctx.notes+='"q" \\ ';const first=[{role:'user',content:JSON.stringify(ctx)}];
  // Parts small enough for the old measure to keep, each about twice as large once sent.
  const heavy=k=>({a:'"'.repeat(3000+k),b:'\\'.repeat(3000),c:escaped(4000),d:'"'.repeat(3000),e:escaped(4000),f:'plain '.repeat(500)});
  const sent=[];let round=0;
  const request=async({continuation})=>{if(continuation)sent.push(cf.size(continuation));round++;const prior=continuation??first;
    if(round<4){const calls=[0,1,2,3].map(k=>({name:'get_company_research',callId:`w${round}${k}`,args:{symbol:'005930',sections:['s'+round+k]}}));return {toolCalls:calls,continuation:[...prior,...calls.map(c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)}))],usage:{}};}
    return {decision:{action:'Hold'},usage:{}};};
  let n=0;const r=await researchReview({context:{universe:[{symbol:'005930'}],discovery:{enabled:true}},evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:async()=>heavy(n++)}});
  assert.equal(r.decision.action,'Hold');assert.equal(sent.length,3);assert.ok(sent.every(b=>b<=cf.LIMIT*cf.TARGET),'every follow-up within the budget: '+sent.join(','));
  for(const v of [heavy(0),{only:escaped(40000)}]){const b=rc.bound(v,14000);assert.ok(rc.outBytes(b)<=14000,'bounded as sent');}
});
test('wire 2: the complete request is checked before every call; results are reduced to retrievable pieces, and a request that cannot fit is not sent',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');
  const {fitRequest}=require('../electron/research-review.cjs');const logs=[];
  const call=k=>({type:'function_call',call_id:'g'+k,name:'get_company_research',arguments:JSON.stringify({symbol:'005930',sections:['s'+k]})});
  const out=k=>({type:'function_call_output',call_id:'g'+k,output:JSON.stringify(Object.fromEntries(Array.from({length:6},(_,i)=>['part'+i,escaped(1800)])))});
  const items=[{role:'user',content:'x'.repeat(60000)},...[0,1,2,3].map(call),...[0,1,2,3].map(out)];assert.ok(cf.size(items)>cf.LIMIT*cf.TARGET,'over budget as given: '+cf.size(items));
  const fitted=await fitRequest(items,{keepFrom:1,compact:null,log:(...a)=>logs.push(a.join(' '))});assert.ok(cf.size(fitted)<=cf.LIMIT*cf.TARGET,'reduced: '+cf.size(fitted));
  const outs=fitted.filter(i=>i.type==='function_call_output').map(i=>JSON.parse(i.output));assert.ok(outs.every(o=>o.reference===true||o.omittedParts?.length>0),'what was left out is named or referenced');
  assert.ok(outs.some(o=>o.part0),'whole parts are kept where they fit');assert.ok(logs.some(l=>/rebound/.test(l)));
  // A first request that is already over the limit with the model's items: not sent.
  let calls=0;const tooBig=async({continuation})=>{calls++;if(!continuation)return {toolCalls:[{name:'get_company_research',callId:'z',args:{symbol:'005930',sections:['a']}}],continuation:[{role:'user',content:'"'.repeat(80000)},{type:'function_call',call_id:'z',name:'get_company_research',arguments:'{}'}],usage:{}};return {decision:{action:'Hold'},usage:{}};};
  await assert.rejects(researchReview({context:{universe:[{symbol:'005930'}],discovery:{enabled:true}},evidence:{get:async()=>({})},request:tooBig,log:()=>{},discovery:{get_company_research:async()=>({a:1})}}),/CONTINUATION_OVER_BUDGET/);assert.equal(calls,1,'the follow-up was not sent');
});
// Finding 2: a row larger than one reply became a placeholder marked complete, with no way to read it.
test('detail reads continue from a stable position whatever room each read has: every row and character exactly once',()=>{
  const rows=Array.from({length:100},(_,i)=>({symbol:'S'+i,note:'n'.repeat(i%7*40)}));
  const text=Array.from({length:3000},(_,i)=>String.fromCharCode(0xAC00+i%500)).join('')+'"quoted" \\ end';const detail={rows,text};
  for(const limits of [[1500,8000],[8000,1500,3000],[1600]]){
    assert.deepEqual(readAll(detail,'rows','',limits).flatMap(r=>r.data),rows,'rows with allowances '+limits);
    assert.equal(readAll(detail,'text','',limits).map(r=>r.text).join(''),text,'text with allowances '+limits);}
  // The reported case: a small first read, then a larger one, continues at the next row instead of skipping ahead.
  const first=rc.detailPart(detail,{section:'rows',part:'',from:0},1500);assert.ok(first.to<20);
  const second=rc.detailPart(detail,{section:'rows',part:'',from:first.next.from},8000);assert.equal(second.from,first.to);assert.equal(second.data[0].symbol,'S'+first.to);
  assert.equal(rc.detailPart(detail,{section:'rows',part:'',from:100}).status,'rejected','past the end');assert.equal(rc.detailPart(detail,{section:'text',part:'',from:9999}).status,'rejected');
});
test('detail: an oversized row is read in full through nested paths and pages of text; complete only when nothing is left out',()=>{
  const notes='투자 메모 "인용" C:\\data\\x — '+escaped(9000);const row={symbol:'005930',name:'Samsung Electronics',price:216000,targets:{low:180000,high:260000},notes,history:Array.from({length:60},(_,i)=>({day:'2026-08-'+String(i%30+1).padStart(2,'0'),close:200000+i,note:'"'+i+'"'}))};
  const detail={research:[{symbol:'000660',price:1},row]};
  const top=rc.detailPart(detail,{section:'research',part:'005930',from:0});assert.equal(top.complete,false,'a row was left out');assert.ok(rc.outBytes(top)<=8000);
  const ph=top.data.find(r=>r.omitted);assert.equal(ph.path,'005930/0');assert.equal(ph.symbol,'005930');
  const inside=rc.detailPart(detail,{section:'research',part:ph.path,from:0});assert.equal(inside.complete,false);assert.ok(rc.outBytes(inside)<=8000);
  assert.equal(inside.data.price,216000);assert.deepEqual(inside.data.targets,{low:180000,high:260000},'small fields inline');
  const paths=inside.omittedParts.map(p=>p.part);assert.ok(paths.includes('005930/0/notes'));
  const first=rc.detailPart(detail,{section:'research',part:'005930/0/notes',from:0});assert.ok(first.next.from>0);
  const text=readAll(detail,'research','005930/0/notes').map(r=>{assert.ok(rc.outBytes(r)<=8000,'each read within the reply limit');return r.text;}).join('');
  assert.equal(text,notes,'the oversized text, read back exactly');
  // A long list inside the row: pages, then every row equal to the original.
  if(paths.includes('005930/0/history')){const all=readAll(detail,'research','005930/0/history').flatMap(r=>r.data);assert.deepEqual(all,row.history);}
  else assert.deepEqual(inside.data.history,row.history);
  assert.equal(rc.detailPart(detail,{section:'research',part:'005930/0/nothing',from:0}).status,'rejected');
  assert.deepEqual(rc.detailPart(detail,{section:'research',part:'000660',from:0}),{section:'research',part:'000660',data:[{symbol:'000660',price:1}],complete:true});
});
// Review of 844904c, P2: when the list of cuts had to give way, list truncations went first and cuts inside rows no
// longer in the reply stayed listed, so a list shortened to 12 of 40 rows read as complete.
test('review P2: a shortened list is always named with its kept count, and cuts in removed rows are not listed',()=>{
  const rc=require('../electron/review-context.cjs');const v={a:{t:'x'.repeat(3000),u:'y'.repeat(1500),rows:Array.from({length:40},(_,i)=>({symbol:'S'+i,note:'n'.repeat(600)}))}};
  for(const limit of [3000,6000,16000]){const b=rc.bound(v,limit,{ref:'result-1'});assert.ok(rc.outBytes(b)<=limit);
    const kept=b.a.rows.length,list=b.cuts.find(c=>c.path==="a/rows");if(limit<16000)assert.ok(kept<40,"rows dropped at "+limit);if(kept<40)assert.deepEqual(list&&[list.items,list.keptItems],[40,kept],"the list cut is listed at "+limit);
    assert.ok(b.cuts.every(c=>{const m=/^a\/rows\/(\d+)\//.exec(c.path);return !m||Number(m[1])<kept;}),'no cut inside a removed row at '+limit);
    const notes=b.a.rows.filter(r=>r.note.endsWith('…')).length,listed=b.cuts.filter(c=>/^a\/rows\/\d+\/note$/.test(c.path)).length;assert.equal(listed+(b.cutsNotListed??0)>=notes,true,'every text cut is listed or counted at '+limit);}
});
// Review of 844904c (P3): a name containing '/' could not be read by its path, and a repeated call id could overwrite
// an earlier stored result.
test('review: names containing a slash are readable by their path; every stored result gets its own section',async()=>{
  const rc=require('../electron/review-context.cjs');const v={'data/P/E':{'~note':'t'.repeat(3000),rows:Array.from({length:30},(_,i)=>({symbol:'S'+i,v:'w'.repeat(300)}))}};
  const b=rc.bound(v,3000,{ref:'result-1'});const paths=[...(b.omittedParts??[]),...(b.cuts??[]).map(c=>c.path)];assert.ok(paths.length);
  for(const path of paths){const d=rc.detailPart({'result-1':v},{section:'result-1',part:path,from:0});assert.equal(d.status,undefined,'readable: '+path);}
  assert.equal(rc.detailPart({x:v},{section:'x',part:'data~1P~1E/~0note',from:0}).text?.slice(0,3)??rc.detailPart({x:v},{section:'x',part:'data~1P~1E/~0note',from:0}).data.slice(0,3),'ttt');
  const {researchReview}=require('../electron/research-review.cjs');const outputs=[];let round=0;
  const request=async({continuation})=>{round++;if(continuation)outputs.push(...continuation.filter(o=>o.type==='function_call_output'));
    if(round===1)return {toolCalls:[{name:'get_company_research',args:{symbol:'A'},callId:'same'}],continuation:[]};
    if(round===2)return {toolCalls:[{name:'get_company_research',args:{symbol:'B'},callId:'same'}],continuation:[]};
    if(round===3)return {toolCalls:[{name:'get_context_detail',args:{section:'result-1',part:'',from:0},callId:'d'}],continuation:[]};return {decision:{action:'Hold'}};};
  await researchReview({context:{universe:[]},evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:async a=>({symbol:a.symbol})}});
  assert.equal(JSON.parse(outputs.find(o=>o.call_id==='d').output).data.symbol,'A','the first result is still result-1');
});
test('the sections added for waits, pending decisions, assessments and review scope shorten when a review is over budget',()=>{
  // 2026-10-30 09:00 KST: every review failed at 71,236 of 70,000 bytes; assessments (5,428) could not be shortened.
  const {shape,wire,COMPRESS}=require('../electron/review-context.cjs');const pad=n=>'x'.repeat(n);
  for(const key of ['assessments','waits','pendingDecisions','reviewScope'])assert.ok(COMPRESS.some(([k])=>k===key),key);
  const assessment=i=>({symbol:'S'+i,updated:'2026-10-30T00:00:00Z',strategy:'long-term',horizon:'3 years',thesis:pad(500),invalidation:pad(240),evidence:Array.from({length:4},(_,k)=>({claim:pad(200),sourceId:'src'+k,published:'2026-10-28',retrieved:'2026-10-30'})),assumptions:pad(400),unresolved:[pad(200),pad(200)],nextCatalyst:{event:'Results',date:'2026-11-05'},refreshWhen:pad(200),stale:[],held:i<2});
  const context={environment:'kis',userGuidelines:pad(42000),universe:[],quotes:[],assessments:Array.from({length:8},(_,i)=>assessment(i)),waits:Array.from({length:6},(_,i)=>({symbol:'S'+i,reason:'publication_pending',question:pad(240),resolvesOn:pad(160),earliestCheck:null,expires:'2026-11-01',since:'2026-10-30',reviews:3,holdsResearch:false})),pendingDecisions:[{symbol:'S1',action:'Sell',quantity:1,since:'x',reviews:4,rationale:pad(400)}]};
  assert.ok(wire(context)>70000,'over the limit to start');const shaped=shape(context,{limit:70000});
  assert.equal(shaped.fits,true);assert.ok(shaped.detailAvailable===undefined);assert.ok(shaped.context.detailAvailable.includes('assessments'),'readable in full on request');
  assert.equal(shaped.detail.assessments[0].evidence.length,4,'the full section is kept as detail');assert.deepEqual(shaped.context.assessments[0].sourceIds,['src0','src1','src2','src3']);assert.match(shaped.context.assessments[0].full,/get_context_detail section assessments/);assert.ok(Buffer.byteLength(shaped.context.assessments[0].thesis)<=240,'clipped by bytes');
  assert.deepEqual(Object.keys(shape({...context,assessments:context.assessments.slice(0,1),userGuidelines:'g'},{limit:70000}).context.assessments[0]).includes('evidence'),true,'under budget: left whole');
});

// Stage 1 of the 2026-11-04 audit: every section has a class and a type, and allowed background always fits once the
// mandatory part does. maxContext: every section at the largest the app produces, in Korean (three bytes a character),
// for 24 symbols (12 Korean, 12 U.S.), 8 of them held; the user guidelines at their 6,000-character limit.
const ko=n=>'삼성전자 실적 발표 후 외국인 순매수 지속 여부 확인 '.repeat(Math.ceil(n/27)).slice(0,n);
function maxContext(){
  const kr=Array.from({length:12},(_,i)=>String(100100+i)),us=Array.from({length:12},(_,i)=>`NASD:U${i}`),all=[...kr,...us],held=[...kr.slice(0,4),...us.slice(0,4)];
  const at='2026-11-04T04:00:00.000Z';const cond=(s,i)=>[{expr:`price("${s}")`,op:'<=',value:100+i},{expr:`sma("${s}",20)`,op:'<',value:100},{expr:`rsi("${s}")`,op:'<',value:30},{expr:`ret("${s}",5)`,op:'<',value:-5}];
  const costs=market=>({market,settings:{krCommissionPct:0.015,usCommissionPct:0.25},tax:{applicability:{status:'estimated'},classification:Object.fromEntries((market==='US'?us:kr).map(s=>[s,{instrument:'stock',incomeTax:'taxable'}]))},
    heldSale:held.filter(s=>(market==='US')===s.includes(':')).map(s=>({symbol:s,quantity:3,netCash:300,taxableGainKRW:-5000,incomeTax:{status:'incomplete',missingInputs:['gains at other brokers']}})),
    oneShare:(market==='US'?us:kr).map(s=>({symbol:s,buy:{gross:100,commission:0.25,netCash:-100.25},sell:{gross:100,commission:0.25,transactionTax:0.2,netCash:99.55}}))});
  return {environment:'kis-combined',currency:'MULTI',baseCurrency:'KRW',equity:1455637,cash:{KRW:407651,USD:182.19},fx:{usdKRW:1341.2},
    positions:Object.fromEntries(held.map(s=>[s,{quantity:3,costTotal:300,market:s.includes(':')?'US':'KR'}])),orders:[{symbol:kr[5],side:'Buy',quantity:1,status:'Accepted',orderId:'1'}],
    universe:all.map(s=>({symbol:s,name:ko(12),price:100})),quotes:all.map(s=>({symbol:s,price:100,previousClose:101,changePct:-1,timestamp:1,stale:false})),
    markets:[{market:'KR',currency:'KRW',equity:705451,cash:407651,marketSession:{open:true},executionEnabled:true,automaticExecutionEnabled:true},{market:'US',currency:'USD',equity:559,cash:182,marketSession:{open:false},executionEnabled:true,automaticExecutionEnabled:true,buyingPower:{usd:466}}],
    risk:{markets:{KR:{baseline:1},US:null}},emergency:{active:false,activeMarkets:[]},marketSession:{open:true,status:'mixed'},triggerEvidence:{kind:'price',symbol:kr[6],movePct:2.1},
    userGuidelines:ko(6000),objective:ko(230),tradingCosts:{markets:[costs('KR'),costs('US')]},
    agentDesk:{notes:all.slice(0,15).map(s=>({symbol:s,note:ko(500),updated:at})),triggers:all.slice(0,5).map((s,i)=>({id:'T-'+i,name:ko(20),conditions:cond(s,i),combine:'all',expires:at})),
      conditionalOrders:{allowed:true,autoSubmit:true,maxActive:10,armed:held.map((s,i)=>({id:'C-'+i,symbol:s,side:'Sell',quantity:3,limitPrice:null,purpose:'stop_loss',conditions:cond(s,i).slice(0,1),combine:'all',expires:at})),
        recent:all.slice(8,13).map((s,i)=>({id:'R-'+i,symbol:s,side:'Sell',quantity:1,purpose:'stop_loss',status:'rejected',outcome:ko(60),at})),unprotected:[{symbol:held[7],orderId:'C-x',quantity:3,heldQuantity:3,coveredQuantity:0}],unprotectedNote:ko(300)}},
    reviewWatches:all.map(s=>({symbol:s,direction:'below',price:95,percent:null,reason:ko(500)})),
    scoutPlan:{asOf:at,summary:ko(300),cashTargetPct:20,focus:ko(200),targets:all.slice(0,16).map(s=>({symbol:s,name:ko(10),role:'candidate',targetWeightPct:5,thesis:ko(220)})),briefAnswers:Array.from({length:8},(_,i)=>({briefId:'B-'+i,asked:ko(200),answer:ko(300)})),
      substitutions:Array.from({length:4},(_,i)=>({forSymbol:all[i],alternatives:[{symbol:all[i+1],verdict:'rejected',why:ko(80)}]}))},
    scoutBrief:{runAllowed:true,remainingRunsToday:3,openBriefs:[{id:'B-x',asOf:at,asked:ko(150)}]},
    researchGaps:all.slice(0,10).map((s,i)=>({id:'G'+i,symbol:s,metric:ko(15),period:'fy2026 q3',document:ko(25),reviews:i,since:at,unresolved:ko(120),cause:null,sourcesTried:['get_company_research:events','get_market_evidence:order_book'],symbolWait:{dataReviews:i,since:at},status:i>2?'retry limit reached':'retrying'})),
    waits:all.slice(0,10).map(s=>({symbol:s,reason:'publication_pending',question:ko(240),resolvesOn:ko(80),earliestCheck:at,expires:at,since:at,reviews:5,holdsResearch:true})),
    pendingDecisions:[{symbol:us[5],action:'Buy',quantity:1,market:'US',since:at,reviews:2,rationale:ko(300),invalidation:ko(80)}],
    assessments:all.map(s=>({symbol:s,updated:at,strategy:'long-term',horizon:'3y',thesis:ko(500),invalidation:ko(240),evidence:[{sourceId:'s1',claim:ko(100)}],stale:s===kr[9]?['price']:[],held:held.includes(s)})),
    sectorLeads:{us:{asOf:at,indices:[{label:'S&P 500',changePct:0.3}],sectors:Array.from({length:11},(_,i)=>({sector:'S'+i,etf:'AMEX:X'+i,changePct:2-i/3}))},korea:{asOf:at,sectors:Array.from({length:30},(_,i)=>({sector:ko(6),changePct:3-i/5}))}},
    discovery:{enabled:true,watchlist:all.map(s=>({symbol:s,name:ko(8),source:'ai',reason:ko(400)}))},
    news:Array.from({length:40},(_,i)=>({title:ko(80),published:at,symbols:[all[i%24]],importance:i===23?'high':'normal'})),topStories:Array.from({length:20},(_,i)=>({title:ko(80),outlets:3,symbols:[all[i]]})),
    eventCalendar:all.map((s,i)=>({date:'2026-11-1'+(i%9),kind:'earnings',title:ko(60),symbol:s})),
    macro:{series:Array.from({length:10},(_,i)=>({id:'M'+i,value:1,date:at,history:Array.from({length:12},(_,j)=>({date:'d'+j,value:j}))}))},
    marketNarrative:{asOf:at,regime:'risk_off',summary:ko(900),drivers:Array.from({length:6},()=>({kind:'background',title:ko(30),summary:ko(300)}))},marketRegime:{regime:'risk_off',score:-2,components:Array.from({length:8},(_,i)=>({name:'c'+i,value:i,reading:ko(30)}))},
    portfolioExposure:{sectors:Array.from({length:10},()=>({sector:ko(6),weightPct:10})),beta:1.1,note:ko(150)},decisionScoreboard:{horizonTradingDays:5,scoredDecisions:5,note:ko(100)},
    performance:{dailyBaseline:1455000,dayPeakEquity:1460000,history:{KR:{since:'2026-10-19',timeWeightedReturns:[],risk:{},daily:ko(1000)},US:{since:'2026-10-24',timeWeightedReturns:[],risk:{}}}},
    positionSizing:{riskPerTradePct:1,rows:all.map(s=>({symbol:s,price:100,atr:4,stopDistance:8,suggestedStop:92,maxShares:4,limitedBy:'cash',maxValueKRW:400,maxWeightPct:28}))},
    orderBooks:{readAt:at,staleAfterSeconds:300,books:all.map(s=>({symbol:s,bid:99,ask:100,bidSize:400,askSize:500,spreadPct:0.1,ageSeconds:3,stale:false}))},
    planGap:{targets:all.slice(0,16).map(s=>({symbol:s,plannedWeightPct:5,heldWeightPct:0,minimumPosition:{feasible:true,weightPct:7,detail:ko(60)}}))},
    similarEpisodes:Array.from({length:5},(_,i)=>({day:'2026-10-2'+i,title:ko(30),similarity:0.4,drivers:[ko(120),ko(120)]})),
    reviewedLessons:Array.from({length:5},()=>ko(1000)),previousReview:{at,action:'Hold',verdicts:Object.fromEntries(all.slice(0,8).map(s=>[s,'waiting'])),explanation:ko(400)},
    reviewInterval:{auto:true,minutes:30,reason:ko(200),updatedAt:1},reviewScope:{kind:'routine',changes:[ko(100)]}};
}
const PROTECTION=c=>({triggers:c.agentDesk.triggers,conditionalOrders:c.agentDesk.conditionalOrders});
const rowsOf=(v,key)=>Array.isArray(v)?v:v[key];
test('stage 1: every section at its maximum, Korean prose, 24 symbols: fits with headroom and keeps all protection',()=>{
  const ctx=maxContext(),limit=reviewByteLimit({});assert.ok(rc.wire(ctx)>2*limit,`oversized to start: ${rc.wire(ctx)}`);
  assert.deepEqual(Object.keys(ctx).filter(k=>!rc.classOf(k)),[],'every fixture section is registered');
  const s=rc.shape(ctx);assert.equal(s.fits,true,JSON.stringify(s.report));assert.ok(s.report.wireBytes<=limit*0.92,`within the target: ${s.report.wireBytes}`);assert.deepEqual(s.unregistered,[]);assert.deepEqual(s.issues,[]);
  for(const k of [...MANDATORY_SAME,'markets','objective'])assert.deepEqual(s.context[k],ctx[k],`${k} untouched`);
  assert.deepEqual(s.context.tradingCosts.markets.map(m=>m.heldSale),ctx.tradingCosts.markets.map(m=>m.heldSale),'tax estimates and their completeness kept');
  // Protection, levels, waits, pending decisions and research-gap status survive whatever step reached them.
  assert.deepEqual(PROTECTION(s.context),PROTECTION(ctx),'armed and rejected stops, unprotected holdings and triggers are whole');
  assert.deepEqual(rowsOf(s.context.reviewWatches,'levels').map(w=>[w.symbol,w.direction,w.price]),ctx.reviewWatches.map(w=>[w.symbol,w.direction,w.price]),'every price level');
  assert.deepEqual(rowsOf(s.context.researchGaps,'gaps').map(g=>[g.id,g.symbol,g.reviews,g.status]),ctx.researchGaps.map(g=>[g.id,g.symbol,g.reviews,g.status]),'gap status and retry limits');
  assert.deepEqual(rowsOf(s.context.waits,'rows').map(w=>[w.symbol,w.reason,w.earliestCheck,w.holdsResearch]),ctx.waits.map(w=>[w.symbol,w.reason,w.earliestCheck,w.holdsResearch]));
  assert.deepEqual(rowsOf(s.context.pendingDecisions,'rows').map(p=>[p.symbol,p.action,p.quantity]),[[ctx.pendingDecisions[0].symbol,'Buy',1]]);
  // What the client reads to choose the tools and the decision schema.
  assert.equal(s.context.discovery.enabled,true);assert.equal(s.context.reviewInterval.auto,true);assert.ok(s.context.scoutBrief);assert.deepEqual(s.context.scoutPlan.targets.map(t=>t.symbol),ctx.scoutPlan.targets.map(t=>t.symbol));
  // A held stock's earnings date stays even though the calendar is an early reference; every referenced section says so.
  const held=Object.keys(ctx.positions);assert.ok(held.every(h=>rowsOf(s.context.eventCalendar,'focusRows').some(e=>e.symbol===h)),'held stocks keep their calendar entries');
  for(const st of s.steps.filter(x=>x.kind.startsWith('referenced'))){const r=s.context[st.section];assert.equal(r.incomplete,true,st.section);assert.ok(r.reference.endsWith(`get_context_detail section ${st.section}.`));assert.ok(s.context.detailAvailable.includes(st.section));}
  assert.ok(s.steps.some(x=>x.kind==='referenced'),'the fixture needed references');
  // The full sections stay readable.
  assert.deepEqual(readAll(s.detail,'agentDesk','notes').flatMap(r=>r.data),ctx.agentDesk.notes);assert.deepEqual(readAll(s.detail,'discovery','watchlist').flatMap(r=>r.data),ctx.discovery.watchlist);
});
test('stage 1: references follow the default order, lowest first, and stop as soon as the request fits',()=>{
  const ctx=maxContext();const s=rc.shape(ctx);const order=s.steps.filter(x=>x.kind==='referenced').map(x=>x.section);
  // A section is passed over only when its reference would not be smaller than what it already is.
  assert.deepEqual(order,rc.REFERENCE_ORDER.filter(k=>order.includes(k)),'in REFERENCE_ORDER: '+order.join(','));
  const last=rc.REFERENCE_ORDER.indexOf(order.at(-1));for(const k of rc.REFERENCE_ORDER.slice(0,last))if(ctx[k]!=null&&!order.includes(k))assert.ok(rc.bytes(rc.reference(k,s.detail[k]??ctx[k],rc.focusSymbols(ctx)))>=rc.bytes(s.context[k])||s.steps.some(x=>x.section===k&&x.kind==='referenced in brief'),k);
  const lighter={...ctx,userGuidelines:'g',reviewedLessons:[],assessments:[]};const fewer=rc.shape(lighter).steps.filter(x=>x.kind.startsWith('referenced'));assert.ok(fewer.length<s.steps.filter(x=>x.kind.startsWith('referenced')).length,'less pressure, fewer references');
  assert.ok(!fewer.some(x=>x.section==='agentDesk'),'the desk is the last to become a reference');
});
test('stage 1: a reference keeps timestamps, summary, flags, focus rows and protective state',()=>{
  const ctx=maxContext();const focus=rc.focusSymbols(ctx);const held=Object.keys(ctx.positions);
  assert.ok(held.every(h=>focus.has(h))&&focus.has(ctx.triggerEvidence.symbol)&&focus.has(ctx.orders[0].symbol)&&focus.has(ctx.pendingDecisions[0].symbol),'held, triggered, ordered and pending symbols');
  assert.ok(!focus.has(ctx.universe.at(-1).symbol),'not every symbol');
  const desk=rc.reference('agentDesk',ctx.agentDesk,focus);assert.deepEqual(desk.triggers,ctx.agentDesk.triggers);assert.deepEqual(desk.conditionalOrders,ctx.agentDesk.conditionalOrders);
  assert.equal(desk.notes.count,15);assert.deepEqual(desk.notes.focusNotes.map(n=>n.symbol),ctx.agentDesk.notes.filter(n=>focus.has(n.symbol)).map(n=>n.symbol),'notes on focus symbols kept in full');
  const narrative=rc.reference('marketNarrative',ctx.marketNarrative,focus);assert.equal(narrative.asOf,ctx.marketNarrative.asOf);assert.equal(narrative.regime,'risk_off');assert.ok(Buffer.byteLength(narrative.summary)<=240);assert.equal(narrative.drivers,undefined);
  const assessments=rc.reference('assessments',ctx.assessments,focus);assert.deepEqual(assessments.flagged,[{symbol:ctx.assessments[9].symbol,stale:['price']}],'a stale assessment on another symbol stays flagged');assert.equal(assessments.items,24);
  assert.ok(assessments.focusRows.every(r=>focus.has(r.symbol)));assert.equal(assessments.focusRows.length,[...focus].filter(s=>ctx.assessments.some(a=>a.symbol===s)).length);
  const news=rc.reference('news',ctx.news,focus);assert.equal(news.important.length,1);assert.ok(news.important.every(n=>n.importance==='high'),'an important headline on another symbol is kept');
  const gaps=rc.reference('researchGaps',ctx.researchGaps,focus);assert.deepEqual(gaps.gaps.map(g=>g.status),ctx.researchGaps.map(g=>g.status));assert.ok(gaps.gaps.every(g=>!('unresolved' in g)&&!('sourcesTried' in g)),'the explanation moves behind the reference');
  const text=rc.reference('unknownText','x'.repeat(5000),focus);assert.equal(text.bytes,5002);assert.ok(text.start.length<=200);
});
test('stage 1: a section nobody registered is bounded and named; a known section of the wrong type is reported',()=>{
  const ctx={...maxContext(),newExperiment:{rows:Array.from({length:50},(_,i)=>({symbol:'S'+i,text:ko(300)}))},tiny:{a:1},previousReview:'not an object'};
  const s=rc.shape(ctx);assert.deepEqual(s.unregistered,['newExperiment','tiny']);assert.deepEqual(s.report.unregistered,['newExperiment','tiny']);
  assert.equal(s.context.newExperiment.incomplete,true,'over 2,000 bytes: a reference from the start');assert.deepEqual(s.context.tiny,{a:1},'small: left as it is');assert.ok(s.steps.some(x=>x.section==='newExperiment'&&x.kind==='unregistered'));
  assert.deepEqual(s.detail.newExperiment,ctx.newExperiment,'still readable in full');assert.deepEqual(s.issues,['previousReview: string, not object']);assert.equal(s.fits,true);
  const under=rc.shape({environment:'kis',universe:[],quotes:[],later:{note:ko(3000)}});assert.equal(under.context.later.incomplete,true,'bounded even when the request is small');
});
test('stage 1: when the part that is never shortened alone is over the limit, the review fails with that reason',()=>{
  const ctx={...maxContext(),quotes:Array.from({length:900},(_,i)=>({symbol:String(200000+i),price:100,previousClose:101,changePct:-1,timestamp:1,stale:false}))};
  const s=rc.shape(ctx);assert.equal(s.fits,false);assert.ok(s.mandatoryBytes>reviewByteLimit({}));assert.equal(rc.sizeFailure(s).message,'CONTEXT_MANDATORY_TOO_LARGE');
  assert.deepEqual(s.context.quotes,ctx.quotes);assert.deepEqual(PROTECTION(s.context),PROTECTION(ctx));
});
test('stage 1: on a maximum first request, three research rounds of four large Korean replies each stay within the follow-up limit',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const cf=require('../electron/context-fit.cjs');const first=rc.shape(maxContext());assert.ok(first.fits);
  const huge=k=>({overview:{price:216000+k},a:ko(5000),b:ko(5000),c:ko(5000)});const sent=[];let round=0,fetched=0;
  const request=async({continuation})=>{if(continuation)sent.push(cf.size(continuation));round++;const prior=continuation??[{role:'user',content:JSON.stringify(first.context)}];
    if(round<4){const calls=[0,1,2,3].map(k=>({name:'get_company_research',callId:`r${round}${k}`,args:{symbol:'100100',sections:['s'+round+k]}}));return {toolCalls:calls,continuation:[...prior,...calls.map(c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)}))],usage:{}};}
    return {decision:{action:'Hold'},usage:{}};};
  const r=await researchReview({context:{universe:[{symbol:'100100'}],discovery:{enabled:true}},detail:first.detail,evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:async()=>{fetched++;return huge(fetched);}}});
  assert.equal(r.decision.action,'Hold');assert.equal(sent.length,3);assert.ok(sent.every(n=>n<=cf.LIMIT*cf.TARGET),'every follow-up within its fitting point: '+sent.join(','));
});
test('stage 1 contract: every section the review builders produce is registered with the size budget',async()=>{
  // Sections assigned while a review context is assembled (automation.cjs), and those the account engines return.
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');
  const body=src.slice(src.indexOf('async assembleReviewContext('),src.indexOf('  deskState(){'));const assigned=[...new Set([...body.matchAll(/\bcontext\.([A-Za-z]+)\s*(?:\?\?)?=(?!=)/g)].map(m=>m[1]))];
  assert.ok(assigned.includes('agentDesk')&&assigned.includes('reviewWatches')&&assigned.length>25,'the assignments are found: '+assigned.join(','));
  const {DatabaseSync}=require('node:sqlite');const {LiveEngine}=require('../electron/live-engine.cjs');const {combinedContext}=require('../electron/combined-context.cjs');
  const engine=market=>{const db=new DatabaseSync(':memory:');const symbol=market==='US'?'NASD:NVDA':'005930';
    const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,settledCash:5000000,pendingSaleProceeds:1000,holdings:[{symbol,name:'F',quantity:1,cost:100,price:100}]};
    return new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol,price:100,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}),{market});};
  const kr=await engine('KR').context(),us=await engine('US').context();const combined=combinedContext({...kr,tradingCosts:{}},{...us,tradingCosts:{},unsettledKRW:1000,unsettledUncertainKRW:500},{usdKRW:1300},{});
  const produced=[...new Set([...assigned,...Object.keys(kr),...Object.keys(us),...Object.keys(combined)])];
  assert.deepEqual(produced.filter(k=>!rc.classOf(k)),[],'unregistered: add each to review-context.cjs TYPES and a class');
  for(const k of produced)assert.ok(rc.TYPES[k],`${k} has a type`);
});
