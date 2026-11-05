// Shared funding protection, Stage 1 (electron/funding-ledger.cjs; the rules are in
// artifacts/reviews/2026-11-05-accounting/stage1-funding-spec.md). Korean and U.S. buys run through both engines'
// submit(), including the final broker preparation and the shared ledger. The fake brokers return what KIS would show;
// U.S. buying power is wired as electron/main.cjs wires it. Expected amounts are worked by hand: U.S. fees are 0.25%
// (TradingCosts defaults) and Korean fees 0 here, the rate is 1,300 and the buffer 2% (ρ = 1,326).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {TradingCosts}=require('../electron/trading-costs.cjs');const {usBuyingPower}=require('../electron/buying-power.cjs');
const {FundingLedger}=require('../electron/funding-ledger.cjs');
const iso=(ms=Date.now())=>new Date(ms).toISOString();
function account({krw=1000000,usd=0,integratedUSD=null,regime=null,rate=1300,db=new DatabaseSync(':memory:'),holdings=[]}={}){
  const s={kr:{accountKey:'acct',environment:'mock',reportedTotal:krw,cash:krw,settledCash:krw,holdings},us:{accountKey:'acct:US',environment:'mock',reportedTotal:usd,cash:usd,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}},
    integratedUSD:integratedUSD??Math.floor(krw/rate+usd),rate,fxAge:0,krAge:0,posts:[],revisions:[],place:null,revise:null,orders:[]};
  s.krSnapshot=structuredClone(s.kr);
  const usFresh=()=>({...structuredClone(s.us),timestamp:iso(),fx:{usdKRW:s.rate,timestamp:Date.now()-s.fxAge},brokerBuyingPower:s.integratedUSD==null?null:{foreignUSD:s.us.cash,integratedUSD:s.integratedUSD,rate:s.rate}});
  const krFresh=()=>({...structuredClone(s.kr),timestamp:iso(Date.now()-s.krAge)});
  const broker=market=>({request:async(op,payload)=>{if(op==='prepare-order')return {ticket:'t',balance:market==='KR'?krFresh():usFresh()};
    if(op==='place-order'){if(s.place)return s.place(market);s.posts.push(market);return {brokerOrderId:String(s.posts.length)};}
    if(op==='revise-order'){if(s.revise)return s.revise(payload);s.revisions.push(payload.command);return {brokerOrderId:'r'+s.revisions.length};}
    if(op==='orders')return {orders:s.orders};throw new Error('unexpected '+op);}});
  const ledger=new FundingLedger(db,{fresh:async m=>m==='KR'?krFresh():usFresh(),fx:()=>({usdKRW:s.rate,timestamp:Date.now()-s.fxAge}),regime});ledger.init();
  const make=()=>{const kr=new LiveEngine(db,broker('KR'),()=>({status:'connected',snapshot:s.kr}));kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
    const us=new LiveEngine(db,broker('US'),()=>({status:'connected',snapshot:usFresh()}),{market:'US'});us.costs=new TradingCosts(db);
    us.buyingPower=balance=>usBuyingPower({usdCash:balance?.cash??0,broker:balance?.brokerBuyingPower??null,krwCash:s.krSnapshot.settledCash,usdKRW:s.rate});
    kr.funding=us.funding=ledger;return {kr,us};};
  const {kr,us}=make();kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');us.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  const submit=async(engine,symbol,side,quantity,limitPrice)=>{const o=engine.propose({symbol,side,quantity,limitPrice});try{return (await engine.submit(o.id,'PLACE MOCK ORDER')).status;}catch(e){return e.message;}};
  const a={s,db,kr,us,ledger,make,submit,buyKR:(q,p=1000)=>submit(a.kr,'005930','Buy',q,p),buyUS:(q,p=100)=>submit(a.us,'NASD:AAPL','Buy',q,p),
    committed:()=>a.ledger.commitments('acct'),capacity:async market=>a.ledger.capacity({account:'acct',market,inputs:await a.ledger.inputs(market,null)})};
  return a;}
const near=(a,b,eps=1)=>assert.ok(Math.abs(a-b)<=eps,`${a} ≈ ${b}`);

// The five reproduced defects, now ordinary tests (shared-pool rule: U.S. commitments may be paid entirely in KRW).
test('F1: a Korean buy cannot reuse KRW committed to an unsettled U.S. buy',async()=>{
  const a=account();assert.equal(await a.buyUS(7),'Accepted');a.s.us.unsettled={buyKRW:910000,sellKRW:0,krwFundedKRW:910000};
  assert.equal(await a.buyKR(900),'INSUFFICIENT_CAPACITY');assert.deepEqual(a.s.posts,['US'],'nothing sent for the Korean buy');
});
test('F2: a U.S. buy cannot reuse KRW reserved by an open Korean order, whatever the broker figure says',async()=>{
  const a=account();assert.equal(await a.buyKR(900),'Accepted');assert.equal(await a.buyUS(7),'INSUFFICIENT_CAPACITY');assert.deepEqual(a.s.posts,['KR']);
});
test('F3: the open remainder of a partly filled or uncertainly cancelled Korean order stays reserved',async()=>{
  for(const status of ['Partially filled','Cancellation uncertain']){const a=account();assert.equal(await a.buyKR(900),'Accepted');const o=a.kr.orders()[0];a.kr.save({...o,status,filled:450,fillPrice:1000});
    a.s.kr.settledCash=a.s.krSnapshot.settledCash=550000;assert.equal(await a.buyUS(3),'INSUFFICIENT_CAPACITY',status);assert.equal(a.committed().krw,900000,'filled 450 and unfilled 450 both committed');}
});
test('F4: a Korean buy cannot reuse KRW of an open U.S. order',async()=>{
  const a=account();assert.equal(await a.buyUS(7),'Accepted');assert.equal(await a.buyKR(900),'INSUFFICIENT_CAPACITY');
});
test('F5: two affordable orders prepared at once are both accepted; two that together exceed funds: exactly one',async()=>{
  // ₩400,000 + $300.75 × 1,326 = ₩798,794.50 ≤ ₩1,000,000.
  let a=account();let r=await Promise.all([a.buyKR(400),a.buyUS(3)]);assert.deepEqual(r,['Accepted','Accepted']);
  // ₩600,000 + $401.00 × 1,326 = ₩1,131,726 > ₩1,000,000.
  a=account();r=await Promise.all([a.buyKR(600),a.buyUS(4)]);assert.equal(r.filter(x=>x==='Accepted').length,1,r.join(' / '));assert.equal(r.filter(x=>x==='INSUFFICIENT_CAPACITY').length,1);assert.equal(a.s.posts.length,1);
});

test('baseline: U.S. capacity on the KRW pool; the existing broker caps still apply; within a market an open order holds the next',async()=>{
  const a=account();assert.equal(await a.buyUS(7),'Accepted','$701.75 × 1,326 = ₩930,520.50');near(await a.capacity('KR'),1000000-930520.5);
  assert.equal(await account().buyUS(8),'INSUFFICIENT_CAPACITY');assert.equal(await account({integratedUSD:300}).buyUS(4),'INSUFFICIENT_CAPACITY','KIS\'s own figure');
  const b=account();assert.equal(await b.buyUS(1),'Accepted');assert.equal(await b.buyUS(1),'RECONCILIATION_REQUIRED');
});
test('regime: equal integrated and foreign figures do not make the pools independent; only a verified regime does',async()=>{
  // $600 USD; KIS's integrated figure equals the foreign one. Still one pool: $501.25 × 1,326 = ₩664,657.50 of KRW.
  let a=account({usd:600,integratedUSD:600});assert.equal(a.ledger.regime(),'unknown');assert.equal(await a.buyUS(5),'Accepted');assert.equal(await a.buyKR(400),'INSUFFICIENT_CAPACITY');
  a=account({usd:600,integratedUSD:600,regime:'separate'});assert.equal(await a.buyUS(5),'Accepted');assert.equal(await a.buyKR(400),'Accepted','verified separate pools');
  // Verified "USD first, KRW for the shortfall": $401 of $500 USD leaves the KRW pool whole.
  a=account({usd:500,regime:'integrated-usd-first'});assert.equal(await a.buyUS(4),'Accepted');assert.equal(await a.buyKR(999),'Accepted');
});
test('FX: outstanding U.S. commitments are revalued at the fresh rate on every check; a stale rate refuses',async()=>{
  // At 1,300: ₩600,000 + $300.75 × 1,326 = ₩998,794.50 fits. At 1,400: + $300.75 × 1,428 = ₩1,029,471 does not.
  let a=account();assert.equal(await a.buyUS(3),'Accepted');assert.equal(await a.buyKR(600),'Accepted');
  a=account();assert.equal(await a.buyUS(3),'Accepted');a.s.rate=1400;assert.equal(await a.buyKR(600),'INSUFFICIENT_CAPACITY');near(await a.capacity('KR'),1000000-300.75*1428);
  // A rate older than two minutes: refused before anything is sent, whenever a U.S. amount is involved.
  a=account();assert.equal(await a.buyUS(3),'Accepted');a.s.fxAge=3*60000;assert.equal(await a.buyKR(1),'FX_STALE');assert.deepEqual(a.s.posts,['US']);
  a=account();a.s.fxAge=3*60000;assert.equal(await a.buyKR(1),'Accepted','no U.S. commitment, no rate needed');
});
test('KIS\'s reported unsettled U.S. total counts once, as a U.S. commitment',async()=>{
  // ₩130,000 reported at 1,300 = $100; × 1,326 = ₩132,600 held back: ₩867,000 fits, ₩868,000 does not.
  const a=account();a.s.us.unsettled={buyKRW:130000,sellKRW:0,krwFundedKRW:0};assert.equal(await a.buyKR(867),'Accepted');
  const b=account();b.s.us.unsettled={buyKRW:130000,sellKRW:0,krwFundedKRW:0};assert.equal(await b.buyKR(868),'INSUFFICIENT_CAPACITY');
});

test('delayed fill: a cancellation reporting 3 of 10 leaves all 10 committed; a later 5 of 10 changes nothing; more than 10 is over-commitment',async()=>{
  const a=account({holdings:[{symbol:'005930',quantity:20,availableQuantity:20,price:50000}]});assert.equal(await a.buyKR(10,50000),'Accepted');
  const o=a.kr.orders()[0];a.kr.save({...o,status:'Canceled',filled:3,fillPrice:50000});assert.equal(a.committed().krw,500000);
  // An order using the apparent seven-share remainder (₩850,000 = ₩500,000 free + ₩350,000) is refused.
  assert.equal(await a.buyKR(17,50000),'INSUFFICIENT_CAPACITY');assert.equal(await a.buyKR(10,50000),'Accepted','₩500,000 is genuinely free');
  a.kr.save({...a.kr.orders().find(x=>x.id===o.id),filled:5});assert.equal(a.committed().krw,1000000,'unchanged by the later fills');
  // A broker correction to 12 of 10: over-committed; new buys refused, a protective sale still goes through.
  // (The second order closes first: an open order holds back every new order in its market, sales included.)
  const second=a.kr.orders().find(x=>x.id!==o.id);a.kr.save({...second,status:'Filled',filled:10,fillPrice:50000});
  a.kr.save({...a.kr.orders().find(x=>x.id===o.id),filled:12});assert.equal(a.committed().overCommitted,true);
  a.s.kr.cash=a.s.kr.settledCash=5000000;assert.equal(await a.buyKR(1,50000),'FUNDING_OVERCOMMITTED');const sent=a.s.posts.length;
  assert.equal(await a.submit(a.kr,'005930','Sell',5,50000),'Accepted');assert.equal(a.s.posts.length,sent+1);
});
test('crash and restart: never sent is released; may have reached KIS stays reserved until a conclusive outcome',async()=>{
  // Reserved, then a crash before the order was marked Submitting: provably never sent.
  let a=account();const o=a.kr.propose({symbol:'005930',side:'Buy',quantity:900,limitPrice:1000});await a.ledger.admit({order:o,market:'KR',cost:900000,balance:null});assert.equal(a.committed().krw,900000);
  let ledger=new FundingLedger(a.db,{fresh:a.ledger.fresh,fx:a.ledger.fxSource});ledger.init();assert.equal(ledger.commitments('acct').krw,0);
  // Sent, the reply lost: Uncertain. Kept across a restart, an empty listing, and a later listing until linked.
  a=account();a.s.place=()=>{throw new Error('NETWORK_UNAVAILABLE');};assert.equal(await a.buyKR(900),'Uncertain');assert.equal(a.committed().krw,900000);
  ledger=new FundingLedger(a.db,{fresh:a.ledger.fresh,fx:a.ledger.fxSource});ledger.init();assert.equal(ledger.commitments('acct').krw,900000);
  const {kr}=a.make();kr.funding=ledger;await kr.reconcile();assert.equal(ledger.commitments('acct').krw,900000,'an empty listing is not proof');
  a.s.orders=[{orderId:'77',symbol:'005930',side:'Buy',quantity:900,orderPrice:1000,filled:900,fillPrice:1000,status:'Filled'}];await kr.reconcile();assert.equal(ledger.commitments('acct').krw,900000,'listed later but not linked: kept');
  // The acknowledgement was lost after execution: linked, it is filled; the commitment moves to filled-unpaid, never released.
  kr.enabled=true;await kr.linkUncertain(kr.orders()[0].id,'77','LINK BROKER ORDER');const c=ledger.commitments('acct');assert.equal(c.krw,900000);assert.equal(c.rows[0].state,'filled-unpaid');
  // A confirmed rejection with no shares filled releases.
  a=account();a.s.place=()=>{throw new Error('BROKER_REJECTED');};assert.equal(await a.buyKR(900),'Rejected');assert.equal(a.committed().krw,0);
  a.s.place=null;a.kr.enabled=true;assert.equal(await a.buyKR(900),'Accepted','the released ₩900,000 is usable again');
});
test('revisions: a higher price is checked and reserved before sending; an uncertain or interrupted one keeps the higher price',async()=>{
  let a=account();assert.equal(await a.buyKR(10,50000),'Accepted');let id=a.kr.orders()[0].id;let seen=null;
  a.s.revise=p=>{seen=JSON.parse(a.db.prepare('SELECT payload FROM live_intents WHERE id=?').get(id).payload).pendingRevision;a.s.revisions.push(p.command);return {brokerOrderId:'r1'};};
  await a.kr.revise(id,{price:60000});assert.equal(seen.price,60000,'the marker was written before the request');assert.equal(a.committed().krw,600000);
  // Over capacity: refused, nothing sent.
  a=account();assert.equal(await a.buyUS(3),'Accepted');assert.equal(await a.buyKR(10,50000),'Accepted');id=a.kr.orders().find(o=>o.side==='Buy').id;
  await assert.rejects(a.kr.revise(id,{price:70000}),/INSUFFICIENT_CAPACITY/);assert.equal(a.s.revisions.length,0);
  // KIS did not confirm: unconfirmed, the higher price committed.
  a=account();assert.equal(await a.buyKR(10,50000),'Accepted');id=a.kr.orders()[0].id;a.s.revise=()=>{throw new Error('ORDER_UNCERTAIN');};
  await assert.rejects(a.kr.revise(id,{price:60000}),/ORDER_UNCERTAIN/);assert.equal(a.kr.orders()[0].unconfirmed.price,60000);assert.equal(a.committed().krw,600000);
  // The app stopped while the revision was in flight: after a restart it is unconfirmed, the higher price still committed.
  a=account();assert.equal(await a.buyKR(10,50000),'Accepted');id=a.kr.orders()[0].id;a.s.revise=()=>new Promise(()=>{});void a.kr.revise(id,{price:60000});await new Promise(r=>setImmediate(r));
  const {kr}=a.make();assert.equal(kr.orders()[0].unconfirmed.price,60000);assert.equal(a.committed().krw,600000);
});
test('first start: orders already recorded enter the ledger by the same rules; a second start changes nothing',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,payload TEXT NOT NULL)');const put=o=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(o.id,o.accountKey,JSON.stringify(o));
  const base={side:'Buy',limitPrice:1000,quantity:10,costEstimate:{netCash:-10000}};
  put({...base,id:'kr-filled',accountKey:'acct',status:'Filled',filled:10,fillPrice:1000,createdAt:Date.parse('2026-09-01')});
  put({...base,id:'us-filled',accountKey:'acct:US',status:'Filled',filled:1,quantity:1,limitPrice:100,fillPrice:100,costEstimate:{netCash:-100.25},resultCosts:{netCash:-100.25}});
  put({...base,id:'kr-cancel',accountKey:'acct',status:'Canceled',filled:4,fillPrice:1000});put({...base,id:'kr-rejected',accountKey:'acct',status:'Rejected',filled:0});
  put({...base,id:'kr-ready',accountKey:'acct',status:'Ready',filled:0});put({...base,id:'kr-open',accountKey:'acct',status:'Accepted',filled:0});put({...base,id:'kr-sell',accountKey:'acct',side:'Sell',status:'Filled',filled:10,fillPrice:1000});
  const l=new FundingLedger(db);l.init();const c=l.commitments('acct');
  assert.equal(c.krw,10000+10000+10000,'the old fill (no five-day assumption), the cancelled order (all 10) and the open one');assert.equal(c.usd,100.25);
  assert.ok(c.rows.every(r=>r.pretracking));assert.deepEqual(c.rows.map(r=>r.orderId).sort(),['kr-cancel','kr-filled','kr-open','us-filled']);
  const events=db.prepare('SELECT count(*) AS n FROM funding_events').get().n,rows=JSON.stringify(db.prepare('SELECT * FROM funding_commitments ORDER BY orderId').all());
  new FundingLedger(db).init();assert.equal(db.prepare('SELECT count(*) AS n FROM funding_events').get().n,events);assert.equal(JSON.stringify(db.prepare('SELECT * FROM funding_commitments ORDER BY orderId').all()),rows);
});
test('automatic U.S. buys are blocked; automatic sales and Korean buys still go through the ledger',async()=>{
  const a=account();a.us.autoEnabled=true;a.kr.autoEnabled=true;const o=a.us.propose({symbol:'NASD:AAPL',side:'Buy',quantity:1,limitPrice:100});
  await assert.rejects(a.us.autoSubmit(o.id),/INTEGRATED_MARGIN_AUTOMATION_BLOCKED/);assert.equal(a.s.posts.length,0);
  const k=a.kr.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000});assert.equal((await a.kr.autoSubmit(k.id)).status,'Accepted');
});
test('order POSTs are never retried by the transport; reads are',async()=>{
  const {KisReadOnlyClient}=require('../electron/kis-client.cjs');let orders=0,reads=0;
  const client=new KisReadOnlyClient({environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'},async url=>{
    if(url.endsWith('/oauth2/tokenP'))return new Response(JSON.stringify({access_token:'t',expires_in:3600}));if(url.includes('order-cash')){orders++;throw new TypeError('fetch failed');}reads++;throw new TypeError('fetch failed');},async()=>{});
  await assert.rejects(client.request('/uapi/domestic-stock/v1/trading/order-cash',{method:'POST',headers:{},body:'{}'}));assert.equal(orders,1);
  await assert.rejects(client.request('/uapi/domestic-stock/v1/quotations/inquire-price',{method:'GET',headers:{}}));assert.equal(reads,2);
});

test('markers and admission on the other revision paths; a stale balance refuses before anything is sent',async()=>{
  // A cancellation request writes its marker before it is sent, and the commitment does not fall on the request.
  let a=account();assert.equal(await a.buyKR(10,50000),'Accepted');let id=a.kr.orders()[0].id;let seen=null;
  a.s.revise=p=>{seen=JSON.parse(a.db.prepare('SELECT payload FROM live_intents WHERE id=?').get(id).payload).pendingRevision;return {brokerOrderId:'c1'};};
  await a.kr.revise(id,{cancel:true});assert.equal(seen.cancel,true);assert.equal(a.committed().krw,500000,'cancellation requested, not yet final');
  // A U.S. price revision is admitted through the same ledger: $5 × 1.0025 more per share on 3 shares = $15.04 more.
  a=account();assert.equal(await a.buyUS(3),'Accepted');id=a.us.orders()[0].id;await a.us.revise(id,{price:105});near(a.committed().usd,315.79,0.01);
  // A Korean balance read more than two minutes before the check: refused, nothing sent.
  a=account();a.s.krAge=3*60000;assert.equal(await a.buyUS(1),'FUNDING_BALANCE_STALE');assert.equal(a.s.posts.length,0);
});

// Stage 1 review (8836d45), P1 1-3: what can change while the ledger reads balances.
const during=(a,fn)=>{const fresh=a.ledger.fresh;a.ledger.fresh=async m=>{await fn(m);return fresh(m);};};
test('review P1-1: trading stopped, account switched, order expired or limits changed during the funding check: not sent, reservation released',async()=>{
  let a=account();during(a,()=>a.kr.stop());assert.equal(await a.buyKR(100),'DISABLED_OR_EXPIRED');assert.equal(a.s.posts.length,0);assert.equal(a.committed().krw,0,'released');
  // The U.S. engine's account changes while the Korean balance is read.
  a=account();during(a,m=>{if(m==='KR')a.s.us.accountKey='other:US';});assert.equal(await a.buyUS(1),'ACCOUNT_CHANGED');assert.equal(a.s.posts.length,0);assert.equal(a.committed().usd,0);
  // Expires while the check waits.
  a=account();let o=a.kr.propose({symbol:'005930',side:'Buy',quantity:100,limitPrice:1000});a.kr.save({...o,expiresAt:Date.now()+30});during(a,()=>new Promise(r=>setTimeout(r,60)));
  await assert.rejects(a.kr.submit(o.id,'PLACE MOCK ORDER'),/DISABLED_OR_EXPIRED/);assert.equal(a.s.posts.length,0);assert.equal(a.committed().krw,0);
  // The symbol is no longer allowed by the limits saved during the check.
  a=account();during(a,()=>{const p=a.kr.policy();a.db.prepare('UPDATE live_policy SET payload=? WHERE accountKey=?').run(JSON.stringify({...p,anyStock:false,symbols:['000660']}),'acct');});
  assert.equal(await a.buyKR(100),'LIMIT_CHANGED');assert.equal(a.s.posts.length,0);assert.equal(a.committed().krw,0);
  // A revision: stopped during its funding check, so not sent and its commitment back to the old price; a cancellation still goes through.
  a=account();assert.equal(await a.buyKR(10,50000),'Accepted');const id=a.kr.orders()[0].id;during(a,()=>a.kr.stop());
  await assert.rejects(a.kr.revise(id,{price:60000}),/DISABLED_OR_EXPIRED/);assert.equal(a.s.revisions.length,0);assert.equal(a.committed().krw,500000);
  a.ledger.fresh=async m=>m==='KR'?{...a.s.kr,timestamp:new Date().toISOString()}:null;await a.kr.revise(id,{cancel:true});assert.equal(a.s.revisions.length,1,'the cancellation was sent');
});
test('review P1-2: commitments that change while balances are read are counted; so is over-commitment',async()=>{
  // The review's case: a Korean commitment rises to ₩900,000 during the read; the $300.75 U.S. buy (₩398,794.50) no longer fits.
  let a=account();assert.equal(await a.buyKR(100),'Accepted');let o=a.kr.orders()[0];during(a,()=>a.kr.save({...o,currentPrice:9000}));
  assert.equal(await a.buyUS(3),'INSUFFICIENT_CAPACITY');assert.equal(a.s.posts.length,1);assert.ok(a.committed().krw+a.committed().usd*1326<=1000000);
  // Over-committed during the read.
  a=account();assert.equal(await a.buyKR(100),'Accepted');o=a.kr.orders()[0];during(a,()=>a.kr.save({...o,status:'Filled',filled:150,fillPrice:1000}));assert.equal(await a.buyUS(1),'FUNDING_OVERCOMMITTED');
  // A revision whose increase no longer fits once another commitment rose during its read.
  a=account();assert.equal(await a.buyKR(10,50000),'Accepted');assert.equal(await a.buyUS(1),'Accepted');const k=a.kr.orders()[0],u=a.us.orders()[0];
  // ₩600,000 + $401.00 × 1,326 = ₩1,131,726 > ₩1,000,000 once the U.S. order is at $400.
  during(a,()=>a.us.save({...u,currentPrice:400}));await assert.rejects(a.kr.revise(k.id,{price:60000}),/INSUFFICIENT_CAPACITY/);assert.equal(a.s.revisions.length,0);
});
test('review P1-3: balances of another account or environment never fund a check',async()=>{
  // The review's case: a fresh ₩1,000,000 Korean balance of another account.
  let a=account({krw:100000});const fresh=a.ledger.fresh;a.ledger.fresh=async m=>m==='KR'?{...(await fresh(m)),accountKey:'other-account',cash:1000000,settledCash:1000000}:fresh(m);
  a.s.integratedUSD=1000;a.s.krSnapshot.settledCash=1000000;assert.equal(await a.buyUS(3),'ACCOUNT_CHANGED');assert.equal(a.s.posts.length,0);
  // The live environment's balance for a mock order.
  a=account();const f2=a.ledger.fresh;a.ledger.fresh=async m=>m==='US'?{...(await f2(m)),environment:'live'}:f2(m);assert.equal(await a.buyKR(1),'ACCOUNT_CHANGED');
  // A U.S. balance of another account for a Korean buy.
  a=account();const f3=a.ledger.fresh;a.ledger.fresh=async m=>m==='US'?{...(await f3(m)),accountKey:'other:US'}:f3(m);assert.equal(await a.buyKR(1),'ACCOUNT_CHANGED');
  // A matching account and environment still pass.
  assert.equal(await account().buyKR(1),'Accepted');
});

// Stage 1 review (6420091): a price increase judged against the effective price; input age measured after the reads.
test('review P1: raising a buy above its effective price needs trading on, even when its reservation already covers it',async()=>{
  // The review's case: limit ₩1,000, revised to ₩500, trading stopped, then ₩900: refused, nothing sent.
  let a=account();assert.equal(await a.buyKR(100,1000),'Accepted');const id=a.kr.orders()[0].id;await a.kr.revise(id,{price:500});a.kr.stop();
  await assert.rejects(a.kr.revise(id,{price:900}),/DISABLED_OR_EXPIRED/);assert.deepEqual(a.s.revisions.map(r=>r.price),[500]);
  // A genuine reduction and a cancellation while stopped still go through.
  await a.kr.revise(id,{price:400});await a.kr.revise(id,{cancel:true});assert.deepEqual(a.s.revisions.map(r=>r.cancel?'cancel':r.price),[500,400,'cancel']);
  assert.equal(a.committed().krw,100000,'the original ₩1,000 limit stays reserved');
  // Trading on: ₩500 → ₩900 is sent, the existing ₩100,000 reservation already covering it.
  a=account();assert.equal(await a.buyKR(100,1000),'Accepted');const k=a.kr.orders()[0].id;await a.kr.revise(k,{price:500});await a.kr.revise(k,{price:900});
  assert.deepEqual(a.s.revisions.map(r=>r.price),[500,900]);assert.equal(a.committed().krw,100000);
});
test('review P2: balances and the rate are aged after every read, so a slow read cannot pass old inputs',async()=>{
  // The U.S. read takes three minutes (the ledger's clock moves on); balances keep the time they were read.
  const slow=a=>{let offset=0;a.ledger.clock=()=>Date.now()+offset;const fresh=a.ledger.fresh;a.ledger.fresh=async m=>{const b=await fresh(m);if(m==='US')offset+=180000;return b;};};
  // A submission whose own balance was read before a three-minute read of the other market.
  let a=account();slow(a);assert.equal(await a.buyKR(100),'FUNDING_BALANCE_STALE');assert.equal(a.s.posts.length,0);
  // A revision whose Korean balance aged during the U.S. read.
  a=account();assert.equal(await a.buyKR(10,50000),'Accepted');const id=a.kr.orders()[0].id;slow(a);
  await assert.rejects(a.kr.revise(id,{price:60000}),/FUNDING_BALANCE_STALE/);assert.equal(a.s.revisions.length,0);
  // A revision whose balances are both read last (fresh), but whose rate dates from before the three-minute read:
  // FX_STALE, since a U.S. commitment is involved; nothing sent.
  a=account();assert.equal(await a.buyUS(1),'Accepted');assert.equal(await a.buyKR(10,50000),'Accepted');const k=a.kr.orders()[0].id;
  let offset=0;a.ledger.clock=()=>Date.now()+offset;const f=a.ledger.fresh,rateAt=Date.now();
  a.ledger.fresh=async m=>{const b=await f(m);if(m==='KR')offset+=180000;return {...b,timestamp:new Date(Date.now()+offset).toISOString(),...(b.fx?{fx:{usdKRW:1300,timestamp:rateAt}}:{})};};
  a.ledger.fxSource=()=>({usdKRW:1300,timestamp:rateAt});const before=a.s.revisions.length;
  await assert.rejects(a.kr.revise(k,{price:60000}),/FX_STALE/);assert.equal(a.s.revisions.length,before);
  // The review's direct case: inputs() measured after the reads.
  a=account();let t=Date.now();a.ledger.clock=()=>t;const own={...a.s.kr,timestamp:new Date(t).toISOString()};
  a.ledger.fresh=async()=>{t+=180000;return {...a.s.us,timestamp:own.timestamp,fx:{usdKRW:1300,timestamp:Date.parse(own.timestamp)}};};
  await assert.rejects(a.ledger.inputs('KR',own,{account:'acct',environment:'mock'}),/FUNDING_BALANCE_STALE/);
});
