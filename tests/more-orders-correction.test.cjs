// M-4 part 3 (multi-order, artifacts/reviews/2026-11-16-multi-order/m4-plan.md section 4): the correction round with
// several held-back orders. One request names every order that can be corrected (plan or reversal, first or further),
// each with its reason; each corrected order is accepted or not alone, by stock; orders that stood are never re-asked.
// The single-order round is unchanged (tests/plan-correction.test.cjs).
const test=require('node:test');const assert=require('node:assert/strict');
const {researchReview}=require('../electron/research-review.cjs');const C=require('../electron/ai-client.cjs');
const SYMBOLS=['005930','000660','990060','035720'];const context={universe:SYMBOLS.map(symbol=>({symbol})),quotes:[]};
const planOf=()=>({strategy:'swing',thesis:'margin recovery',invalidation:'margin falls',stopPrice:1000,targetPrice:null,horizonDays:60,confidence:'medium',
  portfolioImpact:{weightBeforePct:0,weightAfterPct:5,related:[],relatedBeforePct:0,relatedAfterPct:5,equityReliable:true,why:'small position'},evidence:[{claim:'profit up',source:'release',verified:true}],valuation:null,uncertainty:null});
const order=(symbol,complete=true)=>({action:'Buy',symbol,quantity:2,credit:'none',loanDate:'',plan:complete?planOf():null,execution:null,reversal:null});
const answer=(firstOrder,more,explanation='my orders')=>{const decision=C.validateDecision({...firstOrder,explanation,moreOrders:more},SYMBOLS,{requirePlan:true,more:3});return {decision,usage:{inputTokens:10,outputTokens:5},...(C.correctable(decision)?{continuation:[{role:'user',content:'context'}]}:{})};};
const run=async replies=>{const asked=[],logs=[];const r=await researchReview({context,evidence:null,request:async o=>{asked.push(o);return replies.shift();},log:(k,t,b)=>logs.push([t,b])});return {r,asked,logs};};
test('two held-back orders: one request names both with their reasons; each is accepted alone; the order that stood is not re-asked',async()=>{
  const {r,asked,logs}=await run([answer(order('005930'),[order('000660',false),order('990060'),order('035720',false)]),answer(order('000660'),[order('035720',false)])]);
  assert.equal(asked.length,2,'one extra request');const ask=asked[1].continuation.at(-1).content;
  assert.match(ask,/held back 2 of your orders:\n1\. Buy 2 000660: no trade plan\.\n2\. Buy 2 035720: no trade plan\./);assert.match(ask,/do not repeat them/);
  const d=r.decision;assert.equal(d.action,'Buy');assert.equal(d.symbol,'005930');assert.equal(d.explanation,'my orders','the first stood: kept as it was');
  assert.deepEqual(d.moreOrders.map(o=>[o.item,o.symbol,o.planCorrected?.missing??null]),[[1,'000660','no trade plan'],[2,'990060',null]]);
  assert.deepEqual(d.moreWithheld.map(w=>[w.item,w.symbol,w.correctionTried]),[[3,'035720',true]]);
  assert.ok(logs.some(([t,b])=>t==='Plan correction accepted'&&b==='Buy 000660 2'));assert.ok(logs.some(([t,b])=>t==='Plan correction not accepted'&&/^Buy 2 035720: no trade plan/.test(b)));
  assert.deepEqual(r.usage,{inputTokens:20,outputTokens:10,cachedTokens:0});assert.equal('continuation' in r,false);
});
test('the first order held back and corrected: it takes the corrected order and the answer\'s explanation; the further order that stood stays',async()=>{
  const {r,asked}=await run([answer(order('005930',false),[order('000660')]),answer(order('005930'),[],'corrected plan')]);
  assert.equal(r.decision.explanation,'corrected plan');
  assert.match(asked[1].continuation.at(-1).content,/held back one of your orders:\n1\. 2 005930: no trade plan\./);
  const d=r.decision;assert.equal(d.action,'Buy');assert.equal(d.symbol,'005930');assert.deepEqual(d.planCorrected,{missing:'no trade plan'});assert.equal(d.withheld,undefined);
  assert.deepEqual(d.moreOrders.map(o=>o.symbol),['000660']);assert.ok(!('moreWithheld' in d));
});
test('not correctable: a duplicate, an invalid order or one past the count is never re-asked; no extra request',async()=>{
  const {r,asked}=await run([answer(order('005930'),[order('005930'),{...order('000660'),quantity:0}])]);
  assert.equal(asked.length,1);assert.deepEqual(r.decision.moreWithheld.map(w=>w.kind),['duplicate','invalid']);
});
test('an answer\'s order for another stock is not taken; a failed correction request leaves every target held back, marked',async()=>{
  {const {r,logs}=await run([answer(order('005930'),[order('000660',false)]),answer(order('035720'),[order('000660')])]);
    assert.deepEqual(r.decision.moreOrders.map(o=>o.symbol),['000660'],'the target is taken');
    assert.deepEqual(logs.filter(([t])=>t==='Correction order not taken'),[['Correction order not taken','Buy 2 035720: not asked for; not taken.']],'the other stock is named once, not taken');}
  {const {r}=await run([answer(order('005930'),[order('000660',false)]),answer(order('035720'),[])]);
    assert.deepEqual(r.decision.moreOrders.map(o=>o.symbol),[]);assert.equal(r.decision.moreWithheld[0].correctionTried,true);}
  {const replies=[answer(order('005930',false),[order('000660',false)])];const logs=[];
    const r=await researchReview({context,evidence:null,request:async()=>{if(replies.length)return replies.shift();throw new Error('PROVIDER_TIMEOUT');},log:(k,t,b)=>logs.push([t,b])});
    assert.equal(r.decision.action,'Hold');assert.equal(r.decision.withheld.correctionTried,true);assert.equal(r.decision.moreWithheld[0].correctionTried,true);
    assert.ok(logs.some(([t,b])=>t==='Plan correction failed'&&b==='PROVIDER_TIMEOUT'));}
});
test('a corrected order still held back in the answer stays held back with the answer\'s reason',async()=>{
  const {r,logs}=await run([answer(order('005930'),[order('000660',false)]),answer(order('000660',false),[])]);
  assert.equal(r.decision.moreWithheld[0].correctionTried,true);assert.ok(logs.some(([t,b])=>t==='Plan correction not accepted'&&b==='Buy 2 000660: no trade plan'));
  // Held back as a further order of the answer: not taken either.
  const two=await run([answer(order('005930'),[order('000660',false)]),answer(order('035720'),[order('000660',false)])]);
  assert.deepEqual(two.r.decision.moreOrders,[]);assert.equal(two.r.decision.moreWithheld[0].correctionTried,true);
});
test('the clients keep the conversation whenever an order can be corrected: a held-back first (not for permission) as today, or a further order held back for its plan or reversal',()=>{
  assert.equal(C.correctable({action:'Hold',withheld:{symbol:'x',quantity:1,reason:'r'}}),true,'today');assert.equal(C.correctable({action:'Hold',withheld:{symbol:'x',quantity:1,reason:'r',kind:'permission'}}),false,'today');
  assert.equal(C.correctable({action:'Buy'}),false);assert.equal(C.correctable({action:'Buy',moreOrders:[],moreWithheld:[{item:1,kind:'reversal'}]}),true);
  assert.equal(C.correctable({action:'Buy',moreOrders:[],moreWithheld:[{item:1,kind:'duplicate'},{item:2,kind:'open-order'},{item:0,kind:'unparsed'}]}),false);
});
