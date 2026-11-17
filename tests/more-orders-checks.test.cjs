// M-4 part 2 (multi-order, artifacts/reviews/2026-11-16-multi-order/m4-plan.md section 4; D2, D8): the further orders,
// each checked alone by the first order's own checks (checkOrder), a failing one held back with its reason and the others
// standing; duplicates; the further orders past the first order's later checks (position memory, the stop's side); D8 at
// the decision. At one order per review nothing changes (tests/single-order-pins.test.cjs).
const test=require('node:test');const assert=require('node:assert/strict');
const C=require('../electron/ai-client.cjs');const PM=require('../electron/position-memory.cjs');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const DAY=86400000,T=Date.parse('2026-10-27T01:00:00Z'),ACCOUNT='acct',SYMBOLS=['990060','000660','005930'];
const planOf=stop=>({strategy:'swing',thesis:'margin recovery',invalidation:'margin falls',stopPrice:stop,targetPrice:null,horizonDays:60,confidence:'medium',
  portfolioImpact:{weightBeforePct:0,weightAfterPct:5,related:[],relatedBeforePct:0,relatedAfterPct:5,equityReliable:true,why:'small position'},evidence:[{claim:'profit up',source:'release',verified:true}],valuation:null,uncertainty:null});
const order=(symbol,{action='Buy',quantity=1,stop=1000,plan=planOf(stop)}={})=>({action,symbol,quantity,credit:'none',loanDate:'',plan,execution:null,reversal:null});
const first={...order('005930'),explanation:'Buy Samsung.'};
const decide=(moreOrders,{more=3,memory=null}={})=>C.validateDecision({...first,moreOrders},SYMBOLS,{requirePlan:true,memory,quotes:[],now:T,more});
test('at one order per review an answer carrying moreOrders is refused as an unexpected field, as before M-4',()=>{
  assert.throws(()=>C.validateDecision({...first,moreOrders:[]},SYMBOLS,{requirePlan:true}),e=>e.message==='INVALID_AI_RESPONSE'&&/unexpected moreOrders/.test(e.detail.rule));
});
test('a good and a bad further order: the bad one held back with its reason, the good one and the first standing',()=>{
  const d=decide([order('000660'),order('990060',{plan:null})]);
  assert.equal(d.action,'Buy');assert.equal(d.symbol,'005930');assert.deepEqual(d.moreOrders.map(o=>[o.item,o.action,o.symbol]),[[1,'Buy','000660']]);
  assert.deepEqual(d.moreWithheld,[{item:2,action:'Buy',symbol:'990060',quantity:1,reason:'no trade plan',kind:'plan'}]);
  assert.ok(!('explanation' in d.moreOrders[0]),'a further order has no explanation of its own');
});
test('the same checks as the first: a further order checked alone gives what checkOrder gives the first (no drift)',()=>{
  const o=order('000660',{quantity:7});const d=decide([o]);const alone=C.checkOrder({...o,explanation:''},SYMBOLS,{requirePlan:true,now:T});
  const {item,...got}=d.moreOrders[0];const {explanation:_,...want}=alone.decision;assert.deepEqual(got,{...want,plan:alone.plan});assert.equal(item,1);
});
test('D2: a text that is not a JSON list holds back every further order and leaves the first standing; never repaired',()=>{
  const d=decide({unparsed:true});assert.equal(d.action,'Buy');assert.deepEqual(d.moreOrders,[]);assert.deepEqual(d.moreWithheld,[{item:0,action:'',symbol:'',quantity:0,reason:'the further orders were not a JSON list',kind:'unparsed'}]);
  assert.equal(decide({action:'Buy'}).moreWithheld[0].kind,'shape','an object, not a list');
});
test('an order past the count asked for, an invalid order and a Hold are each held back alone',()=>{
  const d=decide([order('000660'),order('990060',{quantity:0}),{...order('990060'),action:'Hold'},order('990060',{quantity:5000})],{more:3});
  assert.deepEqual(d.moreOrders.map(o=>o.symbol),['000660']);
  assert.deepEqual(d.moreWithheld.map(w=>[w.item,w.kind]),[[2,'invalid'],[3,'invalid'],[4,'count']]);
  assert.match(d.moreWithheld[0].reason,/^not a valid order: a Buy quantity outside 1 to 1,000/);
  assert.match(decide([order('999999')]).moreWithheld[0].reason,/outside this review's tradable list/);
  assert.match(decide([{...order('000660'),extra:1}]).moreWithheld[0].reason,/unexpected extra/);
});
test('duplicates: a stock appears once across the first and the further orders; a Buy and a Sell of one stock is a duplicate',()=>{
  const d=decide([order('005930'),order('000660'),order('000660',{action:'Sell',plan:null})]);
  assert.deepEqual(d.moreOrders.map(o=>o.symbol),['000660']);
  assert.deepEqual(d.moreWithheld.map(w=>[w.item,w.kind,w.reason]),[[1,'duplicate','005930 already has a Buy in this review'],[3,'duplicate','000660 already has a Buy in this review']]);
  // The first order counts as written, even when it is itself held back.
  const held=C.validateDecision({...first,plan:null,moreOrders:[order('005930'),order('000660')]},SYMBOLS,{requirePlan:true,more:3});
  assert.equal(held.action,'Hold');assert.equal(held.withheld.symbol,'005930');assert.deepEqual(held.moreOrders.map(o=>o.symbol),['000660'],'the others stand while the first is held back');assert.equal(held.moreWithheld[0].kind,'duplicate');
  // A U.S. symbol written with and without its exchange is the same stock.
  const us=C.validateDecision({...first,symbol:'NASD:AAPL',moreOrders:[order('NASD:AAPL')]},['NASD:AAPL'],{requirePlan:true,more:1});assert.equal(us.moreWithheld[0].kind,'duplicate');
});
test('the reversal rule on a further order alone: held back as a reversal while the first stands',()=>{
  const out=(id,side,effect,at,price)=>({id:'broker:'+id,orderId:id,reviewId:id,source:'broker',accountKey:ACCOUNT,symbol:'990060',side,effect,status:'Filled',quantity:1,requested:1,averagePrice:price,timestamp:at,decision:{action:side,explanation:'x',plan:null},reviewEvidence:{quote:{symbol:'990060',price}}});
  const memory=PM.build([out('R1','Buy','OPEN_LONG',T-8*DAY,106000),out('R3','Sell','CLOSE_LONG',T-DAY,86300)],{accounts:[ACCOUNT],positions:{},reviewAt:new Map([['R1',T-8*DAY],['R3',T-DAY]]),reviewsSince:()=>1,now:T});
  const d=decide([order('990060'),order('000660')],{memory});assert.equal(d.action,'Buy');assert.deepEqual(d.moreOrders.map(o=>o.symbol),['000660']);
  assert.equal(d.moreWithheld[0].kind,'reversal');assert.match(d.moreWithheld[0].reason,/reverses the filled sale/);
});
// Through the app (an injected decision, as the harness gives: no provider call).
const harness=(open=[])=>{const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'000660':200000}});const h=appHarness({mock:m}).enable();h.automation();h.a.pendingOrders=()=>open;return h;};
const review=async(h,decision)=>{h.decide(decision);await h.a.review('User request').catch(()=>{});return JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload).decision;};
const kr=(symbol,opts)=>{const {item,...o}={...order(symbol,opts),item:opts?.item};return {...o,...(item?{item}:{})};};
test('D8 at the decision: an order (first or further) for a stock with an app order still open is held back, named in the record and the log',async()=>{
  const h=harness([{symbol:'000660',side:'Buy',status:'Accepted',market:'KR'}]);
  const d=await review(h,{...kr('005930',{stop:60000}),explanation:'two buys',moreOrders:[{...kr('000660',{stop:150000}),item:1},{...kr('990060',{stop:1}),item:2}],moreWithheld:[]});
  assert.equal(d.action,'Buy');assert.deepEqual(d.moreOrders.map(o=>o.symbol),['990060']);
  assert.deepEqual(d.moreWithheld,[{item:1,action:'Buy',symbol:'000660',quantity:1,reason:'an order for this stock is still open',kind:'open-order'}]);
  assert.ok(h.logs.some(x=>x[2]==='Further order held back'&&x[3]==='Order 2: Buy 1 000660: an order for this stock is still open.'));
  // The first order, when further orders came with it.
  const g=harness([{symbol:'005930',side:'Sell',status:'Accepted',market:'KR'}]);
  const e=await review(g,{...kr('005930',{stop:60000}),explanation:'two buys',moreOrders:[{...kr('000660',{stop:150000}),item:1}],moreWithheld:[]});
  assert.equal(e.action,'Hold');assert.deepEqual(e.withheld,{symbol:'005930',quantity:1,reason:'an order for this stock is still open',kind:'open-order'});assert.deepEqual(e.moreOrders.map(o=>o.symbol),['000660']);
  assert.ok(g.logs.some(x=>x[2]==='Order held back · order still open'));
});
test('the stop\'s side on a further order alone; a first order held back for its stop keeps the further orders',async()=>{
  const h=harness();
  const d=await review(h,{...kr('005930',{stop:80000}),explanation:'stop above price',moreOrders:[{...kr('000660',{stop:250000}),item:1},{...kr('990060',{stop:1}),item:2}],moreWithheld:[{item:3,action:'Buy',symbol:'',quantity:0,reason:'r',kind:'invalid'}]});
  assert.equal(d.action,'Hold');assert.equal(d.withheld.reason,'stop not below price','the first, as today');
  assert.deepEqual(d.moreOrders.map(o=>o.symbol),['990060']);
  assert.deepEqual(d.moreWithheld.map(w=>[w.item,w.kind,w.reason]),[[1,'stop-side','stop not below price'],[3,'invalid','r']]);
});
test('the execution boundary: position memory is checked again on each further order, as on the first',()=>{
  const {Automation}=require('../electron/automation.cjs');const a=Object.create(Automation.prototype);const lines=[];a.log=(...x)=>lines.push(x);a.pendingOrders=()=>[];a.scopedOrders=()=>[];
  const out=(id,side,effect,at,price)=>({id:'broker:'+id,orderId:id,reviewId:id,source:'broker',accountKey:ACCOUNT,symbol:'990060',side,effect,status:'Filled',quantity:1,requested:1,averagePrice:price,timestamp:at,decision:{action:side,explanation:'x',plan:null},reviewEvidence:{quote:{symbol:'990060',price}}});
  const positionMemory=PM.build([out('R1','Buy','OPEN_LONG',Date.now()-8*DAY,106000),out('R3','Sell','CLOSE_LONG',Date.now()-DAY,86300)],{accounts:[ACCOUNT],positions:{},reviewAt:new Map(),reviewsSince:()=>1,now:Date.now()});
  const context={environment:'kis-combined',positionMemory,quotes:[]};const decision={...kr('005930'),explanation:'x',moreOrders:[{...kr('990060'),item:1},{...kr('000660'),item:2}],moreWithheld:[]};
  const d=a.furtherAtDecision('r',{moreOrders:decision.moreOrders,moreWithheld:[]},{provider:'openai',decision},context);
  assert.deepEqual(d.moreOrders.map(o=>o.symbol),['000660']);assert.equal(d.moreWithheld[0].kind,'reversal');
  assert.equal(a.furtherAtDecision('r',{moreOrders:decision.moreOrders,moreWithheld:[]},{provider:'openai',decision},{...context,environment:'local-paper'}).moreOrders.length,2,'not on the paper engine, as for the first');
});
test('F2: D8 counts an unclear order as open (Submitting, Uncertain, Cancellation uncertain), for the first and a further order',()=>{
  const {Automation}=require('../electron/automation.cjs');
  for(const status of ['Uncertain','Submitting','Cancellation uncertain']){const a=Object.create(Automation.prototype);a.log=()=>{};a.pendingOrders=()=>[];a.config={scope:'kis'};
    a.scopedOrders=()=>[{symbol:'005930',side:'Buy',status},{symbol:'990060',side:'Buy',status:'Filled'}];
    const decision={...kr('005930'),explanation:'x',moreOrders:[{...kr('000660'),item:1},{...kr('005930'),item:2},{...kr('990060'),item:3}],moreWithheld:[]};
    const d=a.furtherAtDecision('r',{moreOrders:decision.moreOrders,moreWithheld:[]},{provider:'external',decision},{environment:'kis'});
    assert.equal(d.withheld?.kind,'open-order',`${status}: the first`);assert.deepEqual(d.moreWithheld.map(w=>[w.item,w.kind]),[[2,'open-order']],`${status}: the further one of that stock only`);
    assert.deepEqual(d.moreOrders.map(o=>o.symbol),['000660','990060'],'a filled order is not open');}
});
test('a single order keeps today\'s path: no D8 at the decision, no further-order fields',async()=>{
  const h=harness([{symbol:'005930',side:'Sell',status:'Accepted',market:'KR'}]);
  const d=await review(h,{...kr('005930',{stop:60000}),explanation:'one buy'});assert.equal(d.action,'Buy');assert.ok(!('moreOrders' in d)&&!('moreWithheld' in d));
});
