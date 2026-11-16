// M-1.5a (A12 item 2): a revision or cancellation the KIS request limit refused before it left the app was not sent: the
// order is restored as after a refusal (no unconfirmed state, tracking goes on, its funds as before), not marked
// unclear. A rate limit KIS returns for the request itself still leaves the change unconfirmed. Switch off (the app).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const credentials={environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{tr_cont:''}});
const iso=()=>new Date().toISOString();

test('the client: a revision refused by the request-limit window is ORDER_NOT_SENT and never posted; a limit KIS returns for it stays unclear',async()=>{
  let posts=0,answer=()=>reply({rt_cd:'0',output:{ODNO:'77',KRX_FWDG_ORD_ORGNO:'f'}});
  const c=new KisReadOnlyClient(credentials,async url=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('order-rvsecncl')){posts++;return answer();}throw new Error(url);},async()=>{});
  const cmd={originalOrderId:'42',organization:'1',price:1100};assert.equal((await c.reviseOrder(cmd)).brokerOrderId,'77');
  c.rateLimitedUntil=Date.now()+60000;const e=await c.reviseOrder(cmd).catch(x=>x);assert.equal(e.code,'ORDER_NOT_SENT');assert.equal(posts,1,'not posted');
  c.rateLimitedUntil=0;answer=()=>reply({rt_cd:'1',msg_cd:'EGW00201'},500);assert.equal((await c.reviseOrder(cmd).catch(x=>x)).code,'ORDER_UNCERTAIN','sent, then limited: unclear');
});
function world(){const db=new DatabaseSync(':memory:');const s={accountKey:'acct',environment:'live',reportedTotal:1000000,cash:1000000,settledCash:1000000,holdings:[]};const us={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}};
  const st={revise:null};const broker={request:async(op,p)=>{if(op==='prepare-order')return {ticket:'t',balance:{...s,timestamp:iso()}};if(op==='place-order')return {brokerOrderId:'42',organization:'1'};if(op==='revise-order')return st.revise(p);throw new Error('unexpected '+op);}};
  const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot:s}));e.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const ledger=new FundingLedger(db,{fresh:async m=>m==='US'?{...us,timestamp:iso(),fx:{usdKRW:1300,timestamp:Date.now()},brokerBuyingPower:null}:{...s,timestamp:iso()},fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});ledger.init();e.funding=ledger;
  e.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');return {e,st,ledger};}
const thrown=(m,extra={})=>()=>{throw Object.assign(new Error(m),extra);};
test('the engine: a raise or a cancellation not sent is restored, with no unconfirmed state, its funds as before',async()=>{
  for(const [why,fail,code] of [['from the worker',thrown('ORDER_NOT_SENT'),'ORDER_NOT_SENT'],['the service cooldown',thrown('RATE_LIMITED',{notSent:true,retryAt:Date.now()+60000}),'RATE_LIMITED']])for(const cancel of [false,true]){
    const w=world();const o=w.e.propose({symbol:'005930',side:'Buy',quantity:100,limitPrice:1000});await w.e.submit(o.id,'PLACE LIVE ORDER');const before=w.ledger.commitments('acct').krw;
    w.st.revise=fail;await assert.rejects(w.e.revise(o.id,cancel?{cancel:true}:{price:1100}),new RegExp(code));
    const after=w.e.orders()[0],label=`${why}, ${cancel?'cancel':'raise'}`;
    for(const k of ['pendingRevision','unconfirmed','trackingStopped','cancelRequestedAt'])assert.equal(after[k],undefined,`${label}: no ${k}`);
    assert.equal(after.notional,100000,label+': its cost as before');assert.equal(after.status,'Accepted');near(w.ledger.commitments('acct').krw,before,label+': funds as before');
    w.st.revise=()=>({brokerOrderId:'78',organization:'1'});const again=await w.e.revise(o.id,cancel?{cancel:true}:{price:1100});assert.equal(again.currentBrokerOrderId,'78',label+': the next try goes through');}
});
function near(a,b,label){assert.ok(Math.abs(a-b)<=1,`${label}: ${a} ≈ ${b}`);}
test('the engine (unchanged): a request limit without the not-sent mark leaves the raise unconfirmed and stops its tracking',async()=>{
  const w=world();const o=w.e.propose({symbol:'005930',side:'Buy',quantity:100,limitPrice:1000});await w.e.submit(o.id,'PLACE LIVE ORDER');
  w.st.revise=thrown('RATE_LIMITED');await assert.rejects(w.e.revise(o.id,{price:1100}),/RATE_LIMITED/);const after=w.e.orders()[0];
  assert.equal(after.unconfirmed.price,1100);assert.ok(after.trackingStopped);assert.equal(after.pendingRevision,undefined);
});
test('the tracker notes a change not sent and logs no failure; it is tried again',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const lines=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>lines.push({title,body}));
  const o={id:'o1',side:'Buy',symbol:'005930'};
  await a.trackFailed({reconcile:async()=>{throw new Error('no');}},o,new Error('ORDER_NOT_SENT'));await a.trackFailed({},{...o,id:'o2'},Object.assign(new Error('RATE_LIMITED'),{notSent:true}));
  assert.deepEqual(lines.map(l=>l.title),['Order tracking','Order tracking']);assert.match(lines[0].body,/request limit was reached before the change was sent; nothing changed at KIS, and it is tried again\.$/);
});
