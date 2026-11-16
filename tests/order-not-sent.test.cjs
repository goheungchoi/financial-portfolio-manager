// M-1a (artifacts/reviews/2026-11-16-multi-order, A12 item 1; matrix rows 14 and 15): a KIS request limit met before
// an order request leaves the app is "not sent" (nothing at KIS, funds released, trading stays on, tried again once KIS
// may be asked); a request limit KIS returns for the order request itself stays uncertain, as before.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {KisReadOnlyClient,orderError}=require('../electron/kis-client.cjs');const {publicUSCode}=require('../electron/us-errors.cjs');const {classify}=require('../electron/broker-errors.cjs');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const credentials={environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{tr_cont:''}});
const command={symbol:'005930',side:'Buy',quantity:2,limitPrice:100};

function client(orderReply){const calls=[];const c=new KisReadOnlyClient(credentials,async(url,options)=>{calls.push(url);
  if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'fixture-token',expires_in:3600});if(url.includes('order-cash'))return orderReply();throw new Error('Unexpected request '+url);},async()=>{});return {c,calls};}

test('row 14: an order refused by the request-limit window before it is sent is ORDER_NOT_SENT, with when to try again; nothing is posted',async()=>{
  const {c,calls}=client(()=>reply({rt_cd:'0',output:{ODNO:'42',KRX_FWDG_ORD_ORGNO:'f'}}));
  assert.equal((await c.placeOrder(command)).brokerOrderId,'42','signed in and placed once');
  const until=Date.now()+60000;c.rateLimitedUntil=until;
  const error=await c.placeOrder(command).then(()=>null,e=>e);assert.equal(error.code,'ORDER_NOT_SENT');assert.equal(error.retryAt,until);
  assert.equal(calls.filter(u=>u.includes('order-cash')).length,1,'the second order request never left the app');
});
test('row 15: a request limit KIS returns for the order request itself stays ORDER_UNCERTAIN (the request was sent), and later requests wait',async()=>{
  const {c,calls}=client(()=>reply({rt_cd:'1',msg_cd:'EGW00201',msg1:'too many'},500));
  const error=await c.placeOrder(command).then(()=>null,e=>e);assert.equal(error.code,'ORDER_UNCERTAIN');assert.equal(calls.filter(u=>u.includes('order-cash')).length,1,'sent once, never retried');
  assert.ok(c.rateLimitedUntil>Date.now(),'the window is set for what follows');
  const next=await c.placeOrder(command).then(()=>null,e=>e);assert.equal(next.code,'ORDER_NOT_SENT','the next one is refused before sending');assert.equal(calls.filter(u=>u.includes('order-cash')).length,1);
});
test('the mapping: refused by KIS, not sent, or possibly at KIS; ORDER_NOT_SENT passes the U.S. error filter and is temporary',()=>{
  assert.equal(orderError({code:'BROKER_REJECTED'}).code,'BROKER_REJECTED');
  const n=orderError({code:'RATE_LIMITED',notSent:true,retryAt:5});assert.equal(n.code,'ORDER_NOT_SENT');assert.equal(n.retryAt,5);
  for(const e of [{code:'RATE_LIMITED'},{code:'REQUEST_TIMEOUT'},{code:'NETWORK_UNAVAILABLE'},new Error('x'),{code:'INVALID_RESPONSE',notSent:false}])assert.equal(orderError(e).code,'ORDER_UNCERTAIN');
  assert.equal(publicUSCode('ORDER_NOT_SENT'),'ORDER_NOT_SENT');assert.equal(classify(new Error('ORDER_NOT_SENT')).kind,'temporary');
});

// The engine with the shared funding ledger, as tests/shared-funding.test.cjs builds it (Korean and U.S. accounts).
function world(place){const db=new DatabaseSync(':memory:');const s={kr:{accountKey:'acct',environment:'live',reportedTotal:1000000,cash:1000000,settledCash:1000000,holdings:[]},us:{accountKey:'acct:US',environment:'live',reportedTotal:10000,cash:10000,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}},posts:0};
  const usFresh=()=>({...structuredClone(s.us),timestamp:new Date().toISOString(),fx:{usdKRW:1300,timestamp:Date.now()},brokerBuyingPower:null});const krFresh=()=>({...structuredClone(s.kr),timestamp:new Date().toISOString()});
  const broker=market=>({request:async op=>{if(op==='prepare-order')return {ticket:'t',balance:market==='KR'?krFresh():usFresh()};if(op==='place-order'){if(place.next)return place.next();s.posts++;return {brokerOrderId:String(s.posts)};}throw new Error('unexpected '+op);}});
  const ledger=new FundingLedger(db,{fresh:async m=>m==='KR'?krFresh():usFresh(),fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});ledger.init();
  const kr=new LiveEngine(db,broker('KR'),()=>({status:'connected',snapshot:s.kr}));kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const us=new LiveEngine(db,broker('US'),()=>({status:'connected',snapshot:usFresh()}),{market:'US'});us.buyingPower=b=>({usd:b?.cash??0,fromKRWUSD:0});
  kr.funding=us.funding=ledger;kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');us.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  const send=async(engine,symbol,quantity,price)=>{const o=engine.propose({symbol,side:'Buy',quantity,limitPrice:price});try{return await engine.submit(o.id,'PLACE LIVE ORDER');}catch(e){return {error:e.message};}};
  return {s,kr,us,ledger,send,committed:()=>ledger.commitments('acct')};}
const thrown=(code,extra={})=>()=>{throw Object.assign(new Error(code),extra);};

test('row 14 in the engine: not sent is Rejected ORDER_NOT_SENT with its retry time, funds released, trading on, the next order goes',async()=>{
  for(const [why,make] of [['from the worker',thrown('ORDER_NOT_SENT',{retryAt:Date.now()+120000})],['the service cooldown',thrown('RATE_LIMITED',{retryAt:Date.now()+120000,notSent:true})]]){
    const place={next:make};const w=world(place);const o=await w.send(w.kr,'005930',900,1000);
    assert.equal(o.status,'Rejected',why);assert.equal(o.reason,'ORDER_NOT_SENT',why);assert.ok(o.retryAt>Date.now(),why);
    assert.equal(w.committed().krw,0,why+': the ₩900,000 reserved for it is released');assert.equal(w.kr.enabled,true,why+': the market stays on');
    place.next=null;assert.equal((await w.send(w.kr,'005930',900,1000)).status,'Accepted',why+': the released funds and the market are usable again');}
  const place={next:thrown('ORDER_NOT_SENT',{retryAt:Date.now()+60000})};const w=world(place);const o=await w.send(w.us,'NASD:AAPL',10,100);
  assert.equal(o.status,'Rejected');assert.equal(o.reason,'ORDER_NOT_SENT');assert.equal(w.committed().usd,0);assert.equal(w.us.enabled,true,'the U.S. engine too');
});
test('row 15 in the engine: a request limit without the not-sent mark stays Uncertain, keeps its funds and stops the market, as before',async()=>{
  const w=world({next:thrown('RATE_LIMITED',{retryAt:Date.now()+60000})});const o=await w.send(w.kr,'005930',900,1000);
  assert.equal(o.status,'Uncertain');assert.equal(o.reason,'ORDER_UNCERTAIN');assert.equal(w.committed().krw,900000);assert.equal(w.kr.enabled,false);
});

function automation(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));return {a,db,events};}
test('a review whose order was not sent says so, asks for a review no sooner than KIS may be asked, and starts no order-update review',async()=>{
  const db=new DatabaseSync(':memory:');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const retryAt=Date.now()+180000;const store=new Map();
  const live={market:'KR',enabled:true,autoEnabled:true,identity:()=>'acct',getState:()=>({loss:null}),orders:()=>[...store.values()],
    context:async()=>({environment:'kis',market:'KR',currency:'KRW',equity:1000000,cash:500000,positions:{},universe:[{symbol:'005930',price:1000}],quotes:[{symbol:'005930',price:1000,stale:false}],orders:[],risk:{baseline:1000000,lossLimit:{mode:'off',value:0}},marketSession:{open:true,status:'open'}}),
    propose:c=>{const o={id:'P1',status:'Ready',...c};store.set('P1',o);return o;},autoSubmit:async id=>{const o={...store.get(id),status:'Rejected',reason:'ORDER_NOT_SENT',retryAt};store.set(id,o);return o;}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]),{request:async()=>({provider:'openai',decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'Fixture.'}})},()=>{});
  a.live=live;a.providerStatus.aiConnected=true;a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:999,ask:1000}});a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true});
  a.orderEvents();const review=await a.review();
  assert.match(review.executionNote,/^Not sent: KIS's request limit was reached just before Buy 1 005930 went out, so nothing reached KIS\. Trading stays on/);
  assert.equal(a.reviewRequested.trigger,'Order not sent');assert.equal(a.reviewRequested.notBefore,retryAt);
  assert.equal(a.guardrails.autoOrdersToday(),0,'its automatic-order slot is released');db.close();
});
test('a not-sent rejection is not an order update; a broker rejection still is',()=>{
  const {a}=automation();let list=[{id:'X',status:'Ready'},{id:'Y',status:'Ready'}];a.scopedOrders=()=>list;assert.deepEqual(a.orderEvents(),[],'first seen: recorded only');
  list=[{id:'X',status:'Rejected',reason:'ORDER_NOT_SENT'},{id:'Y',status:'Rejected',reason:'BROKER_REJECTED'}];assert.deepEqual(a.orderEvents().map(o=>o.id),['Y']);
});
test('a requested review waits for its notBefore time, then starts once',()=>{
  const {a}=automation();const started=[];a.review=async trigger=>{started.push(trigger);};a.schedulerStatus=()=>({label:'Monitoring'});a.config.scope='kis';a.lastRun=Date.now();
  let clock=Date.now();const realNow=Date.now;Date.now=()=>clock;
  try{a.requestReview('Order not sent','x','005930',{notBefore:clock+120000});a.tick();assert.equal(started.filter(t=>t==='Order not sent').length,0,'not before');
    clock+=120000;a.tick();assert.equal(started.filter(t=>t==='Order not sent').length,1,'then once');a.tick();assert.equal(started.filter(t=>t==='Order not sent').length,1);}finally{Date.now=realNow;}
});
