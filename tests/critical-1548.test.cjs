// 1.5.48 critical audit (artifacts/reviews/2026-11-09-critical-bugs-and-ui-handoff.md): regression tests asserting the safe
// outcome of each reproduced defect (A1-A6). The diagnostic probes in 2026-11-09-critical-audit-repro.cjs assert the
// defective behaviour and are kept as evidence; these assert the repair. Real modules, in-memory databases, fake brokers
// and transports; no provider or broker calls.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const row=(orderId,extra={})=>({orderId,originalOrderId:null,kind:'order',symbol:'005930',side:'Buy',quantity:1,filled:0,remaining:1,orderPrice:1000,fillPrice:null,status:'Accepted',...extra});
// One Korean engine with the shared funding ledger over a fake broker; limits as given.
function world({limits={},cash=10000,db=new DatabaseSync(':memory:'),configure=true,during=null}={}){const calls=[];
  const balance={accountKey:'audit',environment:'mock',cash,settledCash:cash,reportedTotal:cash,holdings:[],timestamp:new Date().toISOString()};
  const broker={reply:async op=>{if(op==='revise-order')return {brokerOrderId:'R'+calls.length};if(op==='orders')return {orders:broker.history??[]};throw new Error('unexpected '+op);},request:async(op,payload)=>{calls.push({op,payload});return broker.reply(op,payload);}};
  const engine=new LiveEngine(db,broker,()=>({status:'connected',snapshot:balance}));
  const ledger=new FundingLedger(db,{fresh:async m=>{if(during)during();return m==='KR'?{...balance,timestamp:new Date().toISOString()}:null;}});engine.funding=ledger;ledger.init();
  if(configure)engine.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30},...limits},'ENABLE MOCK');
  const order=(extra={})=>{const o={id:'o1',accountKey:'audit',market:'KR',environment:'mock',symbol:'005930',side:'Buy',quantity:1,limitPrice:1000,notional:1000,filled:0,status:'Accepted',brokerOrderId:'1',day:engine.day(),createdAt:Date.now(),costEstimate:{netCash:-1000},...extra};engine.save(o);return o;};
  const revises=()=>calls.filter(c=>c.op==='revise-order').length,krw=()=>ledger.commitments('audit').krw;
  return {db,engine,ledger,balance,broker,calls,order,revises,krw};}

test('A1: a buy revised above its order cap is refused before any broker call; within the cap it is sent and its cost follows',async()=>{
  const w=world({limits:{maxOrderKRW:1000}});w.order();
  await assert.rejects(w.engine.revise('o1',{price:2000}),/ORDER_SIZE_LIMIT/);assert.equal(w.revises(),0);assert.equal(w.krw(),1000,'nothing extra reserved');assert.equal(w.engine.orders()[0].notional,1000);
  const ok=world({limits:{maxOrderKRW:3000}});ok.order();await ok.engine.revise('o1',{price:1500});assert.equal(ok.revises(),1);const o=ok.engine.orders()[0];assert.equal(o.currentPrice,1500);assert.equal(o.notional,1500,'the cost later checks read');assert.equal(ok.krw(),1500);
});
test('A1: partial fills count at their price and the rest at the new one; concentration and turnover limits apply to the raise',async()=>{
  // 3 shares, 1 filled at 1,000: raising the rest to 1,050 makes 1,000 + 2 x 1,050 = 3,100.
  const p=world({limits:{maxOrderKRW:3000}});p.order({quantity:3,notional:3000,filled:1,fillPrice:1000,status:'Partially filled',costEstimate:{netCash:-3000}});
  await assert.rejects(p.engine.revise('o1',{price:1050}),/ORDER_SIZE_LIMIT/);assert.equal(p.revises(),0);
  const q=world({limits:{maxOrderKRW:3200}});q.order({quantity:3,notional:3000,filled:1,fillPrice:1000,status:'Partially filled',costEstimate:{netCash:-3000}});await q.engine.revise('o1',{price:1050});assert.equal(q.engine.orders()[0].notional,3100,'filled turnover counted once');
  // Concentration: 1,500 of a 10,000 account is 15%, above a 10% cap.
  const c=world({limits:{maxCompanyPct:10}});c.order();await assert.rejects(c.engine.revise('o1',{price:1500}),/CONCENTRATION_LIMIT/);assert.equal(c.revises(),0);
  // Turnover: 1,000 already traded today; 1,000 + 1,600 is above 2,500, 1,000 + 1,400 is not.
  const t=world({limits:{maxDailyTurnoverKRW:2500}});t.engine.writeOrder({id:'done',accountKey:'audit',market:'KR',symbol:'000270',side:'Buy',quantity:1,limitPrice:1000,notional:1000,filled:1,status:'Filled',day:t.engine.day()});t.order();
  await assert.rejects(t.engine.revise('o1',{price:1600}),/DAILY_TURNOVER_LIMIT/);await t.engine.revise('o1',{price:1400});assert.equal(t.revises(),1);
});
test('A1: a cap changed while the funds are read is honoured; a stopped engine lowers but never raises (1,000 -> 500 -> 900)',async()=>{
  let w;w=world({limits:{maxOrderKRW:3000},during:()=>{const p=w.engine.policy();w.db.prepare('UPDATE live_policy SET payload=? WHERE accountKey=?').run(JSON.stringify({...p,maxOrderKRW:1200}),'audit');}});w.order();
  await assert.rejects(w.engine.revise('o1',{price:2000}),/ORDER_SIZE_LIMIT/);assert.equal(w.revises(),0,'rechecked after the asynchronous read');assert.equal(w.krw(),1000,'the reservation is recomputed without it');
  const s=world({limits:{maxOrderKRW:3000}});s.order();s.engine.stop();await s.engine.revise('o1',{price:500});assert.equal(s.revises(),1,'a lower price is not held back');
  await assert.rejects(s.engine.revise('o1',{price:900}),/DISABLED_OR_EXPIRED/);assert.equal(s.revises(),1,'raising from the effective 500 needs trading on, though 900 is below the reservation');
});
test('A2: a lost revision reply keeps its terms and the larger reservation through root-only, empty and incomplete listings and a restart',async()=>{
  const db=new DatabaseSync(':memory:');const w=world({db,limits:{maxOrderKRW:5000}});w.order();w.broker.reply=async()=>{throw new Error('ORDER_UNCERTAIN');};
  await assert.rejects(w.engine.revise('o1',{price:2000}),/ORDER_UNCERTAIN/);assert.equal(w.krw(),2000);
  for(const listing of [[row('1')],[],[row('1',{status:'Pending'})]]){w.engine.applyHistory(w.engine.orders()[0],listing);const o=w.engine.orders()[0];assert.equal(o.unconfirmed?.price,2000,'still unconfirmed');assert.ok(o.trackingStopped);assert.equal(w.krw(),2000,'the extra 1,000 is kept');}
  // Restart: a new engine over the same database.
  const again=new LiveEngine(db,w.broker,()=>({status:'connected',snapshot:w.balance}));again.funding=new FundingLedger(db,{fresh:async()=>w.balance});assert.equal(again.orders()[0].unconfirmed.price,2000);assert.equal(again.funding.commitments('audit').krw,2000);
  await assert.rejects(again.revise('o1',{price:2500}),/TRACKING_STOPPED/,'automatic tracking does not resume from absence');
  // A uniquely linked revision at the asked price: adopted with no gap in the reservation.
  again.applyHistory(again.orders()[0],[row('1',{remaining:0,status:'Canceled'}),row('R9',{originalOrderId:'1',kind:'revision',orderPrice:2000,remaining:1})]);const o=again.orders()[0];
  assert.equal(o.unconfirmed,undefined);assert.equal(o.trackingStopped,undefined);assert.equal(o.currentPrice,2000);assert.equal(again.funding.commitments('audit').krw,2000);assert.deepEqual(o.brokerOrderIds,['1','R9']);
});
test('A2: a lost cancellation reply stays unconfirmed on a root-only listing; a refused request and a fully filled original settle it',async()=>{
  const w=world({limits:{maxOrderKRW:5000}});w.order();w.broker.reply=async()=>{throw new Error('ORDER_UNCERTAIN');};await assert.rejects(w.engine.revise('o1',{cancel:true}));
  w.engine.applyHistory(w.engine.orders()[0],[row('1')]);assert.equal(w.engine.orders()[0].unconfirmed.cancel,true);assert.ok(w.engine.orders()[0].trackingStopped);
  // The original filled in full: no unfilled share was left for the request to change.
  w.engine.applyHistory(w.engine.orders()[0],[row('1',{filled:1,remaining:0,fillPrice:1000,status:'Filled'})]);assert.equal(w.engine.orders()[0].unconfirmed,undefined);assert.equal(w.engine.orders()[0].status,'Filled');
  // KIS refused the request (the documented conclusive rejection): nothing pending, the reservation is the original's.
  const r=world({limits:{maxOrderKRW:5000}});r.order();r.broker.reply=async()=>{throw new Error('BROKER_REJECTED');};await assert.rejects(r.engine.revise('o1',{price:2000}),/BROKER_REJECTED/);
  assert.equal(r.engine.orders()[0].unconfirmed,undefined);assert.equal(r.engine.orders()[0].pendingRevision,undefined);assert.equal(r.engine.orders()[0].notional,1000);assert.equal(r.krw(),1000);
});
function lossWorld(){const w=world({configure:false});w.engine.netEquityOf=()=>({low:950,high:950,version:'audit-net'});
  w.engine.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');
  // Today's baseline: 1,000 on the account valuation (as taken at the day boundary); now 950, with KIS's total at 1,300.
  const p={...w.engine.policy(),baseline:1000,baselineHigh:1000,baselineAt:Date.now()-1000,valuation:'audit-net',dayPeakEquity:1000};w.db.prepare('UPDATE live_policy SET payload=? WHERE accountKey=?').run(JSON.stringify(p),'audit');w.balance.reportedTotal=1300;return w;}
test('A3: editing limits, stopping and starting, and a restart keep the day\'s baseline; the 50 loss stays a breach',()=>{
  const w=lossWorld();const loss=()=>w.engine.lossOf(w.engine.policy(),w.balance);assert.equal(loss().loss,50);assert.equal(loss().breached,true);
  w.engine.configure({symbols:[],maxOrderKRW:5000,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');
  let p=w.engine.policy();assert.deepEqual([p.baseline,p.baselineHigh,p.valuation,p.dayPeakEquity],[1000,1000,'audit-net',1000]);assert.ok(Number.isFinite(p.baselineAt));assert.equal(loss().loss,50);assert.equal(p.maxOrderKRW,5000,'the limits did change');
  // Stop and start, as auto-launch does: the saved limits are configured again.
  w.engine.stop();const saved=w.engine.policy();w.engine.configure(Object.fromEntries(['symbols','maxOrderKRW','maxDailyTurnoverKRW','maxCompanyPct','maxDailyLossKRW','lossLimit'].filter(k=>saved[k]!==undefined).map(k=>[k,saved[k]])),'ENABLE MOCK');assert.equal(loss().breached,true);
  // A percentage limit is measured on the same baseline.
  w.engine.configure({symbols:[],lossLimit:{mode:'percent',value:4}},'ENABLE MOCK');p=w.engine.policy();assert.equal(p.maxDailyLossKRW,40);assert.equal(loss().breached,true,'50 against 4% of 1,000');
  // Restart: a new engine over the same database.
  const again=new LiveEngine(w.db,w.broker,()=>({status:'connected',snapshot:w.balance}));again.netEquityOf=w.engine.netEquityOf;assert.equal(again.lossOf(again.policy(),w.balance).breached,true);
});
test('A3: a new day takes its baseline from the valuation with its snapshot; a baseline never meets a value of another valuation',()=>{
  const w=lossWorld();let day='2030-01-10';w.engine.day=()=>day;const taken=[];w.engine.baselineTaken=p=>taken.push(p.baselineAt);
  w.engine.observeBalance(w.balance);let p=w.engine.policy();assert.deepEqual([p.day,p.baseline,p.valuation],['2030-01-10',950,'audit-net']);assert.equal(taken.length,1);
  // Configured on a day with no policy yet: the same valuation, not KIS's 1,300.
  day='2030-01-11';w.engine.configure({symbols:[],lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');p=w.engine.policy();assert.deepEqual([p.day,p.baseline,p.valuation],['2030-01-11',950,'audit-net']);assert.equal(taken.length,2);
  // The valuation unavailable later that day: unavailable, not a comparison with KIS's total.
  w.engine.netEquityOf=()=>{throw new Error('VALUATION_FAILED');};const l=w.engine.lossOf(p,w.balance);assert.equal(l.unavailable,true);assert.equal(l.loss,null);assert.equal(l.ambiguous,true);assert.match(l.reasons[0],/the account valuation could not be read \(VALUATION_FAILED\)/);
  // A settlement-adjusted baseline survives an edit too.
  const s=lossWorld();s.engine.settlementAdjustments=()=>({certain:{low:100,high:100},items:[]});s.engine.netEquityOf=()=>({low:1060,high:1060,version:'audit-net'});
  assert.equal(s.engine.lossOf(s.engine.policy(),s.balance).loss,40);s.engine.configure({symbols:[],lossLimit:{mode:'amount',value:30}},'ENABLE MOCK');assert.equal(s.engine.lossOf(s.engine.policy(),s.balance).breached,true);
});
test('A4: a failed or malformed settlement or flow reader makes the loss check unavailable, never zero; it recovers when the reader does',()=>{
  const w=lossWorld();w.engine.netEquityOf=()=>({low:1060,high:1060,version:'audit-net'});const check=()=>w.engine.lossOf(w.engine.policy(),w.balance);
  w.engine.settlementAdjustments=()=>({certain:{low:100,high:100},items:[]});assert.equal(check().loss,40);
  for(const bad of [()=>{throw new Error('UNREADABLE_SETTLEMENT_STATE');},()=>null,()=>({certain:{low:'x'}}),()=>({certain:{low:1,high:1},withUnknown:{low:NaN,high:1}})]){w.engine.settlementAdjustments=bad;const l=check();
    assert.equal(l.unavailable,true);assert.equal(l.loss,null);assert.equal(l.breached,false);assert.equal(l.ambiguous,true,'restricts new buys');assert.match(l.reasons[0],/settlement corrections|settlement snapshot/);}
  w.engine.settlementAdjustments=()=>({certain:{low:100,high:100},items:[]});assert.equal(check().breached,true,'recovers');
  w.engine.flowsSince=()=>({confirmed:0,unresolved:100,range:{low:0,high:100}});const amb=check();assert.equal(amb.unavailable,undefined);
  for(const bad of [()=>{throw new Error('UNREADABLE_FLOW_STATE');},()=>null,()=>({confirmed:0,range:{low:0}}),()=>({confirmed:'0'})]){w.engine.flowsSince=bad;const l=check();assert.equal(l.unavailable,true);assert.match(l.reasons[0],/deposits and withdrawals/);}
  // A configured flowsToday that fails is unavailable too; an engine with no reader configured counts nothing.
  delete w.engine.flowsSince;w.engine.flowsToday=()=>{throw new Error('X');};assert.equal(check().unavailable,true);delete w.engine.flowsToday;delete w.engine.settlementAdjustments;assert.equal(check().loss,0,'no readers: 1,060 against 1,000');
  // With the limit off there is nothing to check.
  w.engine.flowsSince=()=>{throw new Error('X');};const off={...w.engine.policy(),lossLimit:{mode:'off',value:0}};assert.equal(w.engine.lossOf(off,w.balance).unavailable,undefined);
});
test('A4: a baseline whose settlement snapshot could not be saved is unavailable, through a restart; a buy needs a readable valuation, a sale does not',()=>{
  const w=lossWorld();w.engine.day=()=>'2030-01-10';w.engine.baselineTaken=()=>{throw new Error('SNAPSHOT_WRITE_FAILED');};w.engine.settlementAdjustments=()=>({certain:{low:0,high:0},items:[]});
  w.engine.observeBalance(w.balance);const p=w.engine.policy();assert.equal(p.baselineSnapshot.error,'SNAPSHOT_WRITE_FAILED');const l=w.engine.lossOf(p,w.balance);assert.equal(l.unavailable,true);assert.match(l.reasons[0],/snapshot/);
  const again=new LiveEngine(w.db,w.broker,()=>({status:'connected',snapshot:w.balance}));again.day=()=>'2030-01-10';again.netEquityOf=w.engine.netEquityOf;again.settlementAdjustments=w.engine.settlementAdjustments;assert.equal(again.lossOf(again.policy(),w.balance).unavailable,true);
  // Exposure base: a buy with the valuation unreadable is refused; a sale keeps KIS's total.
  w.engine.netEquityOf=()=>{throw new Error('VALUATION_FAILED');};assert.throws(()=>w.engine.exposureBase(w.balance,{buy:true}),/RISK_DATA_UNAVAILABLE/);assert.equal(w.engine.exposureBase(w.balance),1300);
});
test('A4: automation restricts new buys while the loss check is unavailable, whatever the loss-limit response; sales still pass',async()=>{
  const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'Audit',price:1000}],()=>[]),{},()=>{});let proposed=0;
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true,lossAction:'review'});
  a.marketQuotes=()=>[{symbol:'005930',price:1000,timestamp:Date.now()}];a.placementPrice=async()=>({price:1000});
  a.live={market:'KR',identity:()=>'audit',autoEnabled:true,enabled:true,getState:()=>({loss:{unavailable:true,ambiguous:true,breached:false,loss:null,reasons:['the daily loss cannot be checked']}}),orders:()=>[],
    context:async()=>({marketSession:{open:true},quotes:a.marketQuotes(),positions:{'005930':{quantity:5}},equity:100000,cash:100000}),propose:()=>({id:'p'+(++proposed),status:'Ready'}),autoSubmit:async id=>({id,status:'Accepted'})};
  assert.deepEqual(a.emergencyState().unavailableMarkets,['KR']);
  const arm=side=>{const r=a.desk.setOrder(a.watchScope(),{action:'add',symbol:'005930',side,quantity:1,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:2000}],combine:'all',purpose:side==='Buy'?'entry':'stop_loss',expiresInHours:1,reason:'test'},{config:a.config,universe:['005930'],quotes:a.marketQuotes()});return a.desk.orders(a.watchScope()).find(x=>x.id===r.id);};
  const buy=await a.fireConditional(arm('Buy'));assert.equal(proposed,0,'no buy proposed');assert.match(JSON.stringify(buy??a.desk.recentOrders(a.watchScope(),5)),/loss check cannot be evaluated/);
  await a.fireConditional(arm('Sell'));assert.equal(proposed,1,'a protective sale is not held back');
});
function capWorld({cap=1}={}){const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'Audit',price:1000}],()=>[]),{},()=>{});const store=new Map();let n=0,submits=0;const outcome={next:'Accepted'};
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true,maxAutoOrdersPerDay:cap});
  a.marketQuotes=()=>[{symbol:'005930',price:1000,timestamp:Date.now()}];a.placementPrice=async()=>({price:1000});a.emergencyState=()=>({active:false});
  a.live={market:'KR',identity:()=>'audit',autoEnabled:true,enabled:true,getState:()=>({}),orders:()=>[...store.values()],
    context:async()=>({marketSession:{open:true},quotes:a.marketQuotes(),positions:{'005930':{quantity:5}},equity:100000,cash:100000}),
    propose:c=>{const o={id:'p'+(++n),status:'Ready',...c};store.set(o.id,o);return o;},
    autoSubmit:async id=>{await new Promise(r=>setTimeout(r,5));const o=store.get(id);if(outcome.next==='throw-unsent')throw new Error('LIMIT_CHANGED');if(outcome.next==='throw-uncertain'){store.set(id,{...o,status:'Uncertain'});throw new Error('ORDER_UNCERTAIN');}submits++;const s={...o,status:outcome.next};store.set(id,s);return s;}};
  const arm=(side='Buy')=>{const r=a.desk.setOrder(a.watchScope(),{action:'add',symbol:'005930',side,quantity:1,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:2000}],combine:'all',purpose:side==='Buy'?'entry':'stop_loss',expiresInHours:1,reason:'cap test'},{config:a.config,universe:['005930'],quotes:a.marketQuotes()});return a.desk.orders(a.watchScope()).find(x=>x.id===r.id);};
  return {a,db,arm,outcome,submits:()=>submits};}
test('A6: one daily cap across conditional orders, sequential or concurrent, kept across a restart',async()=>{
  const w=capWorld();await w.a.fireConditional(w.arm());await w.a.fireConditional(w.arm());assert.equal(w.submits(),1,'cap one: one of two sequential buys');assert.equal(w.a.guardrails.autoOrdersToday(),1);
  const c=capWorld();const [x,y]=[c.arm(),c.arm()];await Promise.all([c.a.fireConditional(x),c.a.fireConditional(y)]);assert.equal(c.submits(),1,'two concurrent buys cannot both take the last slot');
  const {Guardrails}=require('../electron/guardrails.cjs');assert.equal(new Guardrails(c.db).autoOrdersToday(),1,'restart reads the same count');
});
test('A6: an unsent failure releases its slot; an unclear reply keeps it; a protective sale is not held back at the cap',async()=>{
  const w=capWorld();w.outcome.next='throw-unsent';await w.a.fireConditional(w.arm());assert.equal(w.a.guardrails.autoOrdersToday(),0,'provably never sent: released');
  w.outcome.next='throw-uncertain';await w.a.fireConditional(w.arm());assert.equal(w.a.guardrails.autoOrdersToday(),1,'may be at the broker: counted');
  w.outcome.next='Accepted';await w.a.fireConditional(w.arm());assert.equal(w.submits(),0,'cap reached');
  await w.a.fireConditional(w.arm('Sell'));assert.equal(w.submits(),1,'a stop-loss sale is still sent');assert.equal(w.a.guardrails.autoOrdersToday(),2,'and counted');
});
test('A6: a review and a conditional order share the cap; legacy review records count once',()=>{
  const {Guardrails}=require('../electron/guardrails.cjs');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');const g=new Guardrails(db);
  // A review recorded before slots existed, with an order: counted once.
  db.prepare('INSERT INTO reviews VALUES(?,?)').run('old',JSON.stringify({id:'old',timestamp:Date.now(),orderId:'x'}));assert.equal(g.autoOrdersToday(),1);
  const s=g.reserveSlot({cap:2,source:'review',ref:'r1'});g.settleSlot(s,'used');db.prepare('INSERT INTO reviews VALUES(?,?)').run('r1',JSON.stringify({id:'r1',timestamp:Date.now(),orderId:'y'}));
  assert.equal(g.autoOrdersToday(),2,'the review with a slot is not counted twice');assert.equal(g.reserveSlot({cap:2,source:'conditional',ref:'conditional:p1'}),null,'the conditional order finds the cap reached');
  // A later broker link or settling again changes nothing.
  g.settleSlot(s,'released');assert.equal(g.autoOrdersToday(),2);
});
test('A5: a valid batch over the round limit runs four and answers the rest as not run; refusals name their rule',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const reply=calls=>async()=>({ok:true,text:async()=>JSON.stringify({status:'completed',output:calls,usage:{input_tokens:1,output_tokens:1}})});
  const call=(i,name='get_context_detail')=>({type:'function_call',call_id:'c'+i,name,arguments:JSON.stringify({section:'performance',part:'',from:0})});
  const r=await new AiClient('offline-audit-key',reply(Array.from({length:5},(_,i)=>call(i)))).decide({universe:[],quotes:[]},{research:true});assert.equal(r.toolCalls.length,5,'the client returns the whole well-formed batch');
  for(const [calls,opts,rule] of [[Array.from({length:13},(_,i)=>call(i)),{research:true},/ceiling of 12/],[[call(0)],{research:true,final:true},/final round/],[[call(0)],{},/without research/],[[call(0,'place_order')],{research:true},/not offered/],[[{...call(0),arguments:'{'}],{research:true},/not valid JSON/]]){
    await assert.rejects(new AiClient('offline-audit-key',reply(calls)).decide({universe:[],quotes:[]},opts),e=>e.message==='INVALID_AI_RESPONSE'&&rule.test(e.detail?.rule??'')&&Number.isInteger(e.detail.toolCount));}
  await assert.rejects(new AiClient('offline-audit-key',async()=>({ok:true,text:async()=>JSON.stringify({status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]})})).decide({universe:[],quotes:[]},{}),e=>e.message==='INVALID_AI_RESPONSE'&&/incomplete/.test(e.detail.rule));
  await assert.rejects(new AiClient('offline-audit-key',async()=>({ok:true,text:async()=>JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not json'}]}]})})).decide({universe:[],quotes:[]},{}),e=>/not valid JSON/.test(e.detail.rule));
  // The research loop: five requests, the first four run, the fifth answered as not run; the review still completes.
  const {researchReview}=require('../electron/research-review.cjs');const seen=[];let round=0;
  const request=async({continuation})=>{round++;if(round===1)return {toolCalls:Array.from({length:5},(_,i)=>({name:'get_context_detail',callId:'c'+i,args:{section:'performance'}})),continuation:[{role:'user',content:'x'}]};seen.push(continuation);return {decision:{action:'Hold'},usage:{}};};
  const logs=[];const done=await researchReview({context:{universe:[]},evidence:{get:async()=>({})},request,log:(...a)=>logs.push(a),compact:async x=>x,detail:()=>({status:'complete',complete:true})});
  assert.equal(done.decision.action,'Hold');const outs=seen[0].filter(i=>i.type==='function_call_output');assert.equal(outs.length,5);assert.equal(JSON.parse(outs[4].output).status,'not_run');assert.ok(logs.some(l=>l[1]==='Research requests over the round limit'));
  // A protocol failure in the loop names its rule and round, and reports what research had already changed.
  let r2=0;const fails=async()=>{r2++;return {toolCalls:[{name:'set_review_watch',callId:'w',args:{}}],continuation:[{role:'user',content:'x'}]};};
  await assert.rejects(researchReview({context:{universe:[]},evidence:{get:async()=>({})},request:fails,log:()=>{},compact:async x=>x,setWatch:async()=>({status:'saved',id:'watch-1'})}),e=>e.message==='INVALID_AI_RESPONSE'&&/final round/.test(e.detail.rule)&&e.detail.round===4&&e.applied.length===3&&e.applied[0].id==='watch-1');
});
test('A5: repeated format failures back off automatic reviews, persistently and with the failure cap off; your own requests still run',async()=>{
  const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const logs=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'Audit',price:1000}],()=>[]),{},(id,k,t,b)=>logs.push([t,b]));a.configure({maxConsecutiveFailures:0});
  const err=Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule:'a tool request on the final round',toolCount:1,tools:['get_context_detail'],round:4}});
  a.noteReviewOutcome('INVALID_AI_RESPONSE',err);assert.equal(a.reviewBackoff().until,0,'one failure: no pause');a.noteReviewOutcome('INVALID_AI_RESPONSE',err);const b=a.reviewBackoff();assert.ok(b.until>Date.now()+14*60000&&b.until<=Date.now()+15*60000);assert.match(b.lastRule,/final round/);
  a.noteReviewOutcome('INVALID_AI_RESPONSE',err);assert.ok(a.reviewBackoff().until>Date.now()+29*60000,'doubles');assert.ok(logs.some(l=>l[0]==='Automatic reviews paused'));
  await assert.rejects(a.review('Scheduled review'),/REVIEW_BACKOFF/);assert.equal(a.busy,false);
  // Restart: a new automation over the same database keeps the pause.
  const again=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'Audit',price:1000}],()=>[]),{},()=>{});await assert.rejects(again.review('Price movement trigger'),/REVIEW_BACKOFF/);assert.ok(again.getState().reviewBackoff.until>Date.now());
  // Other failures do not count; a completed review clears it.
  again.noteReviewOutcome('AI_SERVER_ERROR');assert.equal(again.reviewBackoff().count,3);again.noteReviewOutcome(null);assert.equal(again.reviewBackoff().until,0);assert.equal(again.getState().reviewBackoff,null);
  // The detail names the rule.
  assert.match(require('../electron/ai-errors.cjs').detail('INVALID_AI_RESPONSE','Decision',err),/Rule: a tool request on the final round \(1 tool request: get_context_detail\), round 4\./);
});
test('B1: a buy of a product the security master cannot classify waits for approval instead of passing as standard; a sale does not',()=>{
  const {Exposure}=require('../electron/exposure.cjs');const db=new DatabaseSync(':memory:');const x=new Exposure(db);
  // No securities table at all (the master was never loaded or cannot be read), and no name.
  const buy=x.check({account:'a',symbol:'252670',side:'Buy',notional:1000,equity:100000,holdings:[]});assert.equal(buy.requiresApproval,true);assert.equal(buy.product.kind,'unclassified');
  assert.equal(x.check({account:'a',symbol:'252670',side:'Sell',notional:1000,equity:100000,holdings:[]}).requiresApproval,false);
  // A classified standard stock is unchanged.
  db.exec('CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT)');db.prepare('INSERT INTO securities VALUES(?,?,?,?,?)').run('005930','삼성전자','Samsung Electronics','KOSPI','stock');
  assert.deepEqual([x.check({account:'a',symbol:'005930',side:'Buy',notional:1000,equity:100000,holdings:[]}).requiresApproval,x.classify('005930').kind],[false,'standard']);
  // Through the engine: the proposal carries the approval requirement, so automatic submission waits.
  const w=world();w.engine.exposure=x;const p=w.engine.propose({symbol:'252670',side:'Buy',quantity:1,limitPrice:1000});assert.equal(p.requiresApproval,true);assert.equal(p.product.kind,'unclassified');
});
test('B2: combined values on days without an exchange rate stay numbers; a restatement on such a day is unavailable, never NaN',()=>{
  const {PerformanceHistory,reviewSummary}=require('../electron/performance.cjs');const db=new DatabaseSync(':memory:');let t=Date.parse('2026-11-02T05:00:00Z');const p=new PerformanceHistory(db,()=>t);
  // Korea-only days first (no rate recorded), as on a profile before the U.S. account loaded, then a day with a rate.
  for(const [krw,fx] of [[1000,null],[1010,null],[1020,1300]]){p.record('a',{totals:{KRW:krw,USD:fx?0:null,equityKRW:krw},...(fx?{fx:{usdKRW:fx}}:{})});t+=86400000;}
  p.corrections=()=>new Map();const s=p.summary('a','COMBINED',null);
  assert.ok(s.points.every(x=>Number.isFinite(x.value)),'no NaN value');close2(s.points[1].dailyReturn,0.01);assert.ok(Number.isFinite(s.periods.find(x=>x.label==='All').gain));
  assert.ok(reviewSummary(s).timeWeightedReturns.every(r=>r.returnPct==null||Number.isFinite(r.returnPct)),'nor in the review context');
  // An approved restatement of $10 on the second (rate-less) day: that day is unavailable with the reason, not NaN.
  const day=s.points[1].day;p.corrections=()=>new Map([[day,{usd:0,items:[],unknown:[],adjustmentUSD:10}]]);const q=p.series('a','COMBINED');
  assert.ok(q.every(x=>Number.isFinite(x.value)));assert.equal(q[1].dailyReturn,null);assert.match(q[1].unavailable.join(';'),/no exchange rate/);
  assert.equal(p.series('a','USD').length,1,'the U.S. series has only the day with a U.S. value');
});
function close2(a,b){assert.ok(Math.abs(a-b)<1e-9,`${a} vs ${b}`);}
