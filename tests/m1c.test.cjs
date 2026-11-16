// M-1c (artifacts/reviews/2026-11-16-multi-order/m1a-m1b/m1c-report.md): an expired prepare ticket is "not sent"; an
// order whose cancellation is unconfirmed keeps reserving its lot; the detected-flow Journal line says what the figures do.
// (The duplicate deposit is in tests/flow-detector.test.cjs.)
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {takeTicket}=require('../electron/order-tickets.cjs');const C=require('../electron/credit-paths.cjs');const {classify}=require('../electron/broker-errors.cjs');const {publicUSCode}=require('../electron/us-errors.cjs');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');

test('a ticket is used once, for its own market, within its time; otherwise TICKET_EXPIRED, marked not sent',()=>{
  const now=1_000_000;const map=new Map([['k',{command:{},expiresAt:now+15000}],['u',{command:{},market:'US',expiresAt:now+15000}],['old',{command:{},expiresAt:now-1}]]);
  assert.ok(takeTicket(map,'k','KR',now));assert.equal(map.has('k'),false,'used once');
  for(const [ticket,market] of [['k','KR'],['u','KR'],['old','KR'],['none','US']]){const e=(()=>{try{takeTicket(map,ticket,market,now);}catch(x){return x;}})();assert.equal(e?.code,'TICKET_EXPIRED',ticket);assert.equal(e.notSent,true);}
  const us=new Map([['u',{market:'US',expiresAt:now}]]);assert.ok(takeTicket(us,'u','US',now),'at its last millisecond it is still valid (as before)');
  assert.equal(publicUSCode('TICKET_EXPIRED'),'TICKET_EXPIRED');assert.equal(classify(new Error('TICKET_EXPIRED')).kind,'temporary');
});
test('the engine records an expired ticket as not sent: funds released, trading on, with its cause',async()=>{
  const db=new DatabaseSync(':memory:');const s={accountKey:'acct',environment:'live',reportedTotal:1000000,cash:1000000,settledCash:1000000,holdings:[]};let place=async()=>{throw new Error('TICKET_EXPIRED');};
  const kr=new LiveEngine(db,{request:async op=>op==='prepare-order'?{ticket:'t',balance:{...s,timestamp:new Date().toISOString()}}:op==='place-order'?place():null},()=>({status:'connected',snapshot:s}));kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const us={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}};
  const ledger=new FundingLedger(db,{fresh:async m=>m==='US'?{...us,timestamp:new Date().toISOString(),fx:{usdKRW:1300,timestamp:Date.now()},brokerBuyingPower:null}:{...s,timestamp:new Date().toISOString()},fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});ledger.init();kr.funding=ledger;kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  const o=kr.propose({symbol:'005930',side:'Buy',quantity:900,limitPrice:1000});const r=await kr.submit(o.id,'PLACE LIVE ORDER');
  assert.deepEqual([r.status,r.reason,r.notSentCause],['Rejected','ORDER_NOT_SENT','ticket-expired']);assert.equal(ledger.commitments('acct').krw,0);assert.equal(kr.enabled,true);
  place=async()=>({brokerOrderId:'1'});assert.equal((await kr.submit(kr.propose({symbol:'005930',side:'Buy',quantity:900,limitPrice:1000}).id,'PLACE LIVE ORDER')).status,'Accepted');
});
test('a review and a conditional order name the expired check, not the request limit',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const store=new Map();const events=[];
  const live={market:'KR',enabled:true,autoEnabled:true,identity:()=>'acct',getState:()=>({loss:null}),orders:()=>[...store.values()],
    context:async()=>({environment:'kis',market:'KR',currency:'KRW',equity:1000000,cash:500000,positions:{'005930':{quantity:10}},universe:[{symbol:'005930',price:1000}],quotes:[{symbol:'005930',price:1000,stale:false}],orders:[],risk:{baseline:1000000,lossLimit:{mode:'off',value:0}},marketSession:{open:true,status:'open'}}),
    propose:c=>{const o={id:'P'+(store.size+1),status:'Ready',...c};store.set(o.id,o);return o;},annotate:()=>{},autoSubmit:async id=>{const o={...store.get(id),status:'Rejected',reason:'ORDER_NOT_SENT',notSentCause:'ticket-expired'};store.set(id,o);return o;}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]),{request:async()=>({provider:'openai',decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Fixture.'}})},(id,kind,title,body)=>events.push({title,body}));
  a.live=live;a.providerStatus.aiConnected=true;a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:999,ask:1000}});a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});
  const review=await a.review();assert.match(review.executionNote,/^Not sent: the broker check made for Buy 1 005930 expired \(15 seconds\) before it could go out, so nothing reached KIS\. Trading stays on/);
  assert.ok(events.some(e=>e.title==='Order not sent · check expired'));assert.match(a.reviewRequested.reason,/its broker check expired/);
  a.marketQuotes=()=>[{symbol:'005930',price:1000,timestamp:Date.now()}];a.placementPrice=async()=>({price:1000});a.emergencyState=()=>({active:false});
  const r=a.desk.setOrder(a.watchScope(),{action:'add',symbol:'005930',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:2000}],combine:'all',purpose:'stop_loss',expiresInHours:1,reason:'fixture'},{config:a.config,universe:['005930'],quotes:a.marketQuotes()});
  await a.fireConditional(a.desk.orders(a.watchScope()).find(x=>x.id===r.id));const armed=a.desk.rows('conditional_orders',a.watchScope()).find(x=>x.id===r.id);
  assert.equal(armed.status,'armed');assert.equal(armed.waiting,'temporary refusal (TICKET_EXPIRED)');db.close();
});
test('an order whose cancellation is unconfirmed keeps reserving its lot',()=>{
  const balance={holdings:[{symbol:'005930',quantity:5,availableQuantity:5}]};
  const r=C.remaining(balance,{symbol:'005930',side:'Sell'},[{symbol:'005930',side:'Sell',quantity:3,filled:1,status:'Cancellation uncertain'}]);assert.deepEqual([r.available,r.reserved],[3,2]);
  assert.throws(()=>C.check(balance,{symbol:'005930',side:'Sell',quantity:4},[{symbol:'005930',side:'Sell',quantity:3,filled:1,status:'Cancellation uncertain'}]),/EXCEEDS_LOT/,'never sells shares that may still be sold');
});
test('the detected-flow Journal line says the main figures leave it out until it is confirmed',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const lines=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>lines.push({title,body}));
  a.noteDetectedFlow({id:'f',market:'KR',currency:'KRW',amount:3250000,day:'2026-11-02'});a.noteDetectedFlow({id:'g',market:'US',currency:'USD',amount:-120.5,day:'2026-11-02'});
  assert.deepEqual(lines.map(l=>l.title),['Deposit detected','Withdrawal detected']);
  assert.equal(lines[0].body,'Deposit detected: Korean cash rose by ₩5,000,000 with no matching trade on 2026-11-16. Until you confirm it, it is left out of the main return figures, which show as provisional; confirm or remove it under Performance → Deposits & withdrawals.');
  assert.doesNotMatch(lines[1].body,/treat it as/);db.close();
});
