// A first order held back after the AI answered (at the position-memory boundary, or for its stop's side) becomes a Hold
// that keeps what the decision carries beside its order: the plan verdicts, the strategy check, the scout brief and any
// further orders. Until 2026-11-17 the rebuilt Hold dropped them (the M-4 part 2 report's finding): the brief was never
// saved and verdicts the AI gave were logged as missing. The order's own fields still go with the order.
const test=require('node:test');const assert=require('node:assert/strict');const PM=require('../electron/position-memory.cjs');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const DAY=86400000,ACCOUNT='acct';
const beside={planVerdicts:[{symbol:'000660',verdict:'waiting',reason:'results due'}],strategyCheck:[{horizon:'swing',instrument:'stock',direction:'long',funding:'cash',idea:'x',verdict:'acted',reason:'y'}],scoutBrief:{request:'more',focus:'chips'}};
const planOf=stop=>({strategy:'swing',thesis:'t',invalidation:'i',stopPrice:stop,targetPrice:null,horizonDays:60,confidence:'medium'});
test('the position-memory boundary: the Hold keeps the verdicts, the strategy check and the brief; the order\'s own fields go',()=>{
  const now=Date.now(),out=(id,side,effect,at,price)=>({id:'broker:'+id,orderId:id,reviewId:id,source:'broker',accountKey:ACCOUNT,symbol:'990060',side,effect,status:'Filled',quantity:1,requested:1,averagePrice:price,timestamp:at,decision:{action:side,explanation:'x',plan:null},reviewEvidence:{quote:{symbol:'990060',price}}});
  const memory=PM.build([out('R1','Buy','OPEN_LONG',now-8*DAY,106000),out('R3','Sell','CLOSE_LONG',now-DAY,86300)],{accounts:[ACCOUNT],positions:{},reviewAt:new Map(),reviewsSince:()=>1,now});
  const d=PM.enforce({action:'Buy',symbol:'990060',quantity:1,credit:'none',loanDate:'',explanation:'re-enter',plan:planOf(80000),execution:{bound:1},reversal:null,reversalFlag:{reason:'r'},...beside},memory,{now});
  assert.equal(d.action,'Hold');assert.equal(d.withheld.kind,'reversal');assert.deepEqual(d.plan,planOf(80000),'the plan stays, as before');
  for(const k of Object.keys(beside))assert.deepEqual(d[k],beside[k],k);
  for(const k of ['execution','reversal','reversalFlag'])assert.ok(!(k in d),k);
  // The keys before the kept ones are today's, in today's order.
  assert.deepEqual(Object.keys(d).slice(0,8),['action','symbol','quantity','credit','loanDate','plan','explanation','withheld']);
});
test('every decision key is named as an order field or as kept: a new key forces a choice',()=>{
  const C=require('../electron/ai-client.cjs'),A=require('../electron/anthropic-client.cjs');const keys=new Set();
  for(const b of [false,true])for(const p of [false,true])for(const t of [false,true])for(const more of [0,3]){
    Object.keys(C.decisionSchema(b,p,t,more).properties).forEach(k=>keys.add(k));
    // The Claude form's flat keys (plan_thesis, execution_bound, ...) rebuild into their top-level field.
    Object.keys(A.flatDecisionSchema(b,p,t,more).properties).forEach(k=>keys.add(k.split('_')[0]));}
  // Keys the app adds to a decision after the AI answered.
  for(const k of ['withheld','reversalFlag','portfolioImpactCheck','planCorrected','moreWithheld'])keys.add(k);
  const unnamed=[...keys].filter(k=>!PM.ORDER_FIELDS.has(k)&&!PM.KEPT_FIELDS.has(k));assert.deepEqual(unnamed,[],'name each in ORDER_FIELDS or KEPT_FIELDS (position-memory.cjs)');
  assert.deepEqual([...PM.ORDER_FIELDS].filter(k=>PM.KEPT_FIELDS.has(k)),[],'never both');
  // keptBeside keeps exactly the kept ones.
  const all=Object.fromEntries([...keys].map(k=>[k,1]));assert.deepEqual(Object.keys(PM.keptBeside(all)).sort(),[...PM.KEPT_FIELDS].filter(k=>keys.has(k)).sort());
});
test('the stop\'s side: the Hold keeps the verdicts and the strategy check in the review record',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m}).enable();h.automation();
  h.decide({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'stop above',plan:planOf(80000),execution:{bound:72000,cancelAfter:'',cancelIf:[]},...beside});
  await h.a.review('User request').catch(()=>{});const d=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload).decision;
  assert.equal(d.action,'Hold');assert.equal(d.withheld.reason,'stop not below price');
  assert.deepEqual(d.planVerdicts,beside.planVerdicts);assert.deepEqual(d.strategyCheck,beside.strategyCheck);assert.ok(!('execution' in d));
  assert.ok(!('scoutBrief' in d),'the brief is taken off the record and saved for the scout, as for any decision');
});
