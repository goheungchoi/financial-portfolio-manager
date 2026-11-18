// An order that was not sent (artifacts/reviews/2026-11-18-order-not-sent): F1 the other market is read
// before the broker check, F2 its balance alone, F3 the KIS queue is held from the check to the placement, F6 timings and
// what the order waited behind on the order record. Fake broker and fake balances only.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {takeTicket,TICKET_MS}=require('../electron/order-tickets.cjs');const {KisService}=require('../electron/kis-service.cjs');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
// A KisService whose worker is a function: send(operation, payload) is recorded and answered by answer().
function service(answer,calls){const s=new KisService();s.send=async(operation,payload)=>{calls.push(operation);return answer(operation,payload);};return s;}
const outside=(s,fn)=>s.als.exit(fn);// a request made by other work, not by the order holding the queue
const now=()=>new Date().toISOString();
const KR={accountKey:'acct',environment:'live',reportedTotal:1000000,cash:1000000,settledCash:1000000,holdings:[]};
const US={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[],unsettled:{buyKRW:0,sellKRW:0}};
function engine(broker,ledger,snapshot=KR){const db=ledger.db;const kr=new LiveEngine(db,broker,()=>({status:'connected',snapshot}));kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  kr.funding=ledger;kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');return kr;}
function ledgerOf(db,calls,{other=()=>({...US,timestamp:now(),fx:{usdKRW:1300,timestamp:Date.now()}})}={}){
  const l=new FundingLedger(db,{fresh:async()=>{throw new Error('fresh must not be read for an order');},balance:async m=>{calls.push('balance '+m);return other(m);},fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});l.init();return l;}

test('a ticket reports its age when taken, and when refused as expired; a missing one has none',()=>{
  const t=1_000_000;const map=new Map([['a',{command:{},expiresAt:t+TICKET_MS-4000}],['b',{command:{},expiresAt:t-3000}]]);
  assert.equal(takeTicket(map,'a','KR',t).ageMs,4000);
  const e=(()=>{try{takeTicket(map,'b','KR',t);}catch(x){return x;}})();assert.equal(e.code,'TICKET_EXPIRED');assert.equal(e.ticketAgeMs,18000);
  const m=(()=>{try{takeTicket(map,'none','KR',t);}catch(x){return x;}})();assert.equal(m.code,'TICKET_EXPIRED');assert.equal('ticketAgeMs' in m,false);
});

test('a Korean buy: the U.S. balance is read before the check, and nothing runs between the check and the placement',async()=>{
  const calls=[];let svc;
  svc=service(async op=>{if(op==='prepare-order'){outside(svc,()=>void svc.request('quotes').catch(()=>{}));await delay(20);return {ticket:'t',balance:{...KR,timestamp:now()},checkedAt:Date.now()};}
    if(op==='place-order')return {brokerOrderId:'1',ticketAgeMs:25};return [];},calls);
  const db=new DatabaseSync(':memory:');const ledger=ledgerOf(db,calls);const kr=engine(svc,ledger);
  const o=kr.propose({symbol:'005930',side:'Buy',quantity:10,limitPrice:1000});const r=await kr.submit(o.id,'PLACE LIVE ORDER');
  assert.equal(r.status,'Accepted');await delay(10);
  assert.deepEqual(calls,['balance US','prepare-order','place-order','quotes'],'the other market first; the quote request queued during the check waits until the order is placed');
  assert.equal(ledger.commitments('acct').krw>0,true,'reserved as before');
  const T=r.timings;for(const k of ['otherMarketMs','holdWaitMs','checkMs','checksMs','fundingMs','placeMs'])assert.equal(Number.isFinite(T[k]),true,k);
  assert.equal(T.ticketAgeMs,25);assert.deepEqual(T.aheadOfPlace,{length:0,operations:[]});assert.deepEqual(T.aheadOfCheck,{length:0,operations:[]});
  assert.equal('ticketAgeMs' in r,false,'the age is in timings, not loose on the order');assert.equal(svc.isBusy,false);
});

test('what the order waited behind is recorded by name, and an expired ticket keeps its age',async()=>{
  const calls=[];let release;const slow=new Promise(r=>{release=r;});let svc;
  svc=service(async op=>{if(op==='research-section')return slow;if(op==='prepare-order')return {ticket:'t',balance:{...KR,timestamp:now()}};
    if(op==='place-order'){const e=new Error('TICKET_EXPIRED');e.ticketAgeMs=18200;throw e;}return [];},calls);
  const db=new DatabaseSync(':memory:');const ledger=ledgerOf(db,calls);const kr=engine(svc,ledger);
  void svc.request('research-section').catch(()=>{});void svc.request('chart-bars').catch(()=>{});
  const o=kr.propose({symbol:'005930',side:'Buy',quantity:10,limitPrice:1000});const pending=kr.submit(o.id,'PLACE LIVE ORDER');
  await delay(10);release({});const r=await pending;
  assert.deepEqual([r.status,r.reason,r.notSentCause],['Rejected','ORDER_NOT_SENT','ticket-expired']);assert.equal(ledger.commitments('acct').krw,0,'released as before');
  assert.equal(r.timings.ticketAgeMs,18200);assert.deepEqual(r.timings.aheadOfCheck.operations,['research-section','chart-bars']);
  assert.equal(calls.indexOf('chart-bars')<calls.indexOf('prepare-order'),true,'requests already in line run before the hold');
});

test('the hold: taken in turn, its own requests go straight, others wait; ahead() names the line',async()=>{
  const calls=[];const svc=service(async op=>{await delay(5);return op;},calls);
  const first=svc.request('quotes');let inside,during;
  const held=svc.hold(async h=>{assert.equal(Number.isFinite(h.waitedMs),true);during=outside(svc,()=>svc.request('refresh'));await delay(5);
    inside=svc.ahead();assert.equal(await svc.request('prepare-order'),'prepare-order');await delay(20);assert.equal(await svc.request('place-order'),'place-order');return 'done';},{label:'Buy 1 005930'});
  assert.deepEqual(svc.ahead().operations,['quotes','hold: Buy 1 005930']);
  assert.equal(await held,'done');await first;await during;
  assert.deepEqual(calls,['quotes','prepare-order','place-order','refresh']);assert.deepEqual(inside,{length:0,operations:[]});
  const outsideView=outside(svc,()=>svc.ahead());assert.deepEqual(outsideView,{length:0,operations:[]});assert.equal(svc.isBusy,false);
});

test('the hold is released after its limit and logged; on an error it is released at once',async()=>{
  const calls=[];const svc=service(async op=>op,calls);const told=[];svc.onHoldLimit=x=>told.push(x);
  let other;const held=svc.hold(async h=>{other=outside(svc,()=>svc.request('quotes'));await delay(80);assert.equal(h.released(),true);await svc.request('place-order');return 1;},{label:'Sell 3 000660',limitMs:30});
  await delay(50);assert.deepEqual(calls,['quotes'],'after the limit other work runs');await held;await other;
  assert.deepEqual(calls,['quotes','place-order'],'the order\'s later request waits in line');assert.equal(told.length,1);assert.equal(told[0].label,'Sell 3 000660');assert.equal(told[0].limitMs,30);
  await assert.rejects(svc.hold(async()=>{throw new Error('LIMIT_CHANGED');}),/LIMIT_CHANGED/);
  assert.equal(await svc.request('refresh'),'refresh','nothing waits behind a hold that ended in an error');assert.equal(svc.holding,null);assert.equal(svc.isBusy,false);
});

test('a given other-market reading is held to the same rules, and nothing is read for it',async()=>{
  const db=new DatabaseSync(':memory:');const calls=[];const ledger=ledgerOf(db,calls);
  const order={id:'o1',accountKey:'acct',market:'KR',side:'Buy',symbol:'005930',quantity:10,limitPrice:1000,notional:10000};
  const base={order,market:'KR',cost:10000,balance:{...KR,timestamp:now()},environment:'live'};
  await ledger.admit({...base,other:{...US,timestamp:now()}});assert.deepEqual(calls,[],'given: not read again');
  await assert.rejects(ledger.admit({...base,order:{...order,id:'o2'},other:{...US,timestamp:new Date(Date.now()-180000).toISOString()}}),e=>e.message==='FUNDING_BALANCE_STALE');
  await assert.rejects(ledger.admit({...base,order:{...order,id:'o3'},other:{...US,accountKey:'other:US',timestamp:now()}}),e=>e.message==='ACCOUNT_CHANGED');
  await ledger.admit({...base,order:{...order,id:'o4'},other:null});// no U.S. account: as a missing reading before
});

test('otherReading reads the other market\'s balance alone; a failed read gives null',async()=>{
  const db=new DatabaseSync(':memory:');const calls=[];const ledger=ledgerOf(db,calls,{other:m=>{if(m==='KR')throw new Error('REQUEST_FAILED');return {...US,timestamp:now()};}});
  assert.equal((await ledger.otherReading('KR')).accountKey,'acct:US');assert.equal(await ledger.otherReading('US'),null);assert.deepEqual(calls,['balance US','balance KR']);
  const plain=new FundingLedger(db,{fresh:async m=>({market:m})});assert.deepEqual(await plain.otherReading('US'),{market:'KR'},'without a balance-only read, fresh as before');
});

test('a sale reads no other market and still holds the queue',async()=>{
  const held={...KR,holdings:[{symbol:'005930',quantity:10,availableQuantity:10,price:1000,marketValue:10000}]};
  const calls=[];let svc;svc=service(async op=>{if(op==='prepare-order'){outside(svc,()=>void svc.request('quotes').catch(()=>{}));return {ticket:'t',balance:{...held,timestamp:now()}};}if(op==='place-order')return {brokerOrderId:'2',ticketAgeMs:3};return [];},calls);
  const db=new DatabaseSync(':memory:');const ledger=ledgerOf(db,calls);const kr=engine(svc,ledger,held);
  const o=kr.propose({symbol:'005930',side:'Sell',quantity:5,limitPrice:1000});const r=await kr.submit(o.id,'PLACE LIVE ORDER');await delay(5);
  assert.equal(r.status,'Accepted');assert.deepEqual(calls,['prepare-order','place-order','quotes']);assert.equal('otherMarketMs' in r.timings,false);
});
