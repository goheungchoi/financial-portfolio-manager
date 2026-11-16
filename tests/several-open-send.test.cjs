// M-1.2 (artifacts/reviews/2026-11-16-multi-order, rule U; matrix rows 2, 9-13): with severalOpen on, the engine sends an
// order while others are open, and an order whose state is not known blocks only its own stock. The fixture is
// tests/shared-funding.test.cjs's (both engines, the real shared funding ledger; U.S. fees 0.25%, rate 1,300, buffer 2%,
// ρ = 1,326). The switch-off behaviour is pinned in tests/several-open.test.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {TradingCosts}=require('../electron/trading-costs.cjs');const {usBuyingPower}=require('../electron/buying-power.cjs');
const {FundingLedger}=require('../electron/funding-ledger.cjs');
const iso=(ms=Date.now())=>new Date(ms).toISOString();
function account({krw=1000000,usd=0,rate=1300}={}){const db=new DatabaseSync(':memory:');
  const s={kr:{accountKey:'acct',environment:'mock',reportedTotal:krw,cash:krw,settledCash:krw,holdings:[{symbol:'000660',quantity:10,availableQuantity:10,cost:1000}]},us:{accountKey:'acct:US',environment:'mock',reportedTotal:usd,cash:usd,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}},
    integratedUSD:Math.floor(krw/rate+usd),rate,posts:[],place:null,prepares:0};s.krSnapshot=structuredClone(s.kr);
  const usFresh=()=>({...structuredClone(s.us),timestamp:iso(),fx:{usdKRW:s.rate,timestamp:Date.now()},brokerBuyingPower:{foreignUSD:s.us.cash,integratedUSD:s.integratedUSD,rate:s.rate}});
  const krFresh=()=>({...structuredClone(s.kr),timestamp:iso()});
  const broker=market=>({request:async(op)=>{if(op==='prepare-order'){s.prepares++;return {ticket:'t',balance:market==='KR'?krFresh():usFresh()};}
    if(op==='place-order'){if(s.place)return s.place(market);s.posts.push(market);return {brokerOrderId:String(s.posts.length)};}throw new Error('unexpected '+op);}});
  const ledger=new FundingLedger(db,{fresh:async m=>m==='KR'?krFresh():usFresh(),fx:()=>({usdKRW:s.rate,timestamp:Date.now()})});ledger.init();
  const kr=new LiveEngine(db,broker('KR'),()=>({status:'connected',snapshot:s.kr}),{severalOpen:true});kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const us=new LiveEngine(db,broker('US'),()=>({status:'connected',snapshot:usFresh()}),{market:'US',severalOpen:true});us.costs=new TradingCosts(db);
  us.buyingPower=balance=>usBuyingPower({usdCash:balance?.cash??0,broker:balance?.brokerBuyingPower??null,krwCash:s.krSnapshot.settledCash,usdKRW:s.rate});
  kr.funding=us.funding=ledger;kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');us.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  const send=async(engine,symbol,side,quantity,limitPrice)=>{const o=engine.propose({symbol,side,quantity,limitPrice});try{return (await engine.submit(o.id,'PLACE MOCK ORDER')).status;}catch(e){return e.message;}};
  const a={s,db,kr,us,ledger,send,buyKR:(q,p=1000,sym='005930')=>send(kr,sym,'Buy',q,p),sellKR:(q,p=1000,sym='000660')=>send(kr,sym,'Sell',q,p),buyUS:(q,p=100,sym='NASD:AAPL')=>send(us,sym,'Buy',q,p),
    committed:()=>ledger.commitments('acct'),set:(engine,symbol,patch)=>{const o=engine.orders().find(r=>r.symbol===symbol);engine.writeOrder({...o,...patch});}};
  return a;}
const near=(a,b,eps=1)=>assert.ok(Math.abs(a-b)<=eps,`${a} ≈ ${b}`);

test('row 2: orders of different stocks are sent while others are open, each counted in the funding ledger',async()=>{
  const a=account();assert.equal(await a.buyKR(100,1000,'005930'),'Accepted');assert.equal(await a.buyKR(100,1000,'035420'),'Accepted');assert.equal(await a.sellKR(5),'Accepted','a sale too');
  assert.deepEqual(a.kr.orders().map(o=>o.status),['Accepted','Accepted','Accepted']);assert.equal(a.committed().krw,200000,'both buys committed; the sale commits nothing');assert.equal(a.s.posts.length,3);
});
test('an accepted or partly filled order of the same stock does not block here (sums and the decision rules decide)',async()=>{
  for(const status of ['Accepted','Partially filled']){const a=account();await a.buyKR(100);a.set(a.kr,'005930',{status,filled:status==='Accepted'?0:40});assert.equal(await a.buyKR(50),'Accepted',status);}
});
test('row 9: an unclear buy of A does not block B; it stays committed in full and the market stays on',async()=>{
  const a=account();a.s.place=()=>{throw new Error('ORDER_UNCERTAIN');};assert.equal(await a.buyKR(300,1000,'005930'),'Uncertain');assert.equal(a.kr.enabled,true,'the market stays on');
  a.s.place=null;assert.equal(await a.buyKR(300,1000,'035420'),'Accepted');assert.equal(a.committed().krw,600000,'the unclear ₩300,000 still counts');
  assert.equal(await a.buyKR(500,1000,'051910'),'INSUFFICIENT_CAPACITY','₩1,000,000 − ₩600,000 committed leaves ₩400,000');
});
test('rows 10-12: an order whose state is not known blocks every new order of its stock, either side, and nothing else',async()=>{
  const cases=[['Uncertain',{status:'Uncertain'}],['Submitting',{status:'Submitting'}],['Cancellation uncertain',{status:'Cancellation uncertain'}],
    ['an unconfirmed revision',{status:'Accepted',unconfirmed:{from:'1',cancel:false,price:1100},trackingStopped:{at:1,reason:'x'}}],['a revision in flight',{status:'Accepted',pendingRevision:{at:1,from:'1',cancel:false,price:1100,notional:10000}}]];
  for(const [name,patch] of cases){const a=account();await a.sellKR(5);a.set(a.kr,'000660',patch);const before=a.s.prepares;
    assert.equal(await a.sellKR(3),'RECONCILIATION_REQUIRED',name+': a sale of the stock');assert.equal(await a.buyKR(1,1000,'000660'),'RECONCILIATION_REQUIRED',name+': a buy of the stock');
    assert.equal(a.s.prepares,before,name+': nothing prepared');assert.equal(await a.buyKR(10,1000,'005930'),'Accepted',name+': another stock');}
  const a=account();await a.sellKR(5);a.set(a.kr,'000660',{status:'Uncertain'});const o=a.kr.propose({symbol:'000660',side:'Sell',quantity:1,limitPrice:1000});
  const err=await a.kr.submit(o.id,'PLACE MOCK ORDER').catch(e=>e);assert.match(err.detail,/^000660 has an order whose state is not confirmed \(Uncertain\)$/);
});
test('row 13: while order history cannot be read and an order is open, nothing is sent, protective sales included; with nothing open it does not block',async()=>{
  const a=account();await a.buyKR(10);a.kr.reconcileHealth={failures:2,since:Date.now(),error:'RECONCILE_FAILED'};
  assert.equal(await a.buyKR(10,1000,'035420'),'RECONCILIATION_REQUIRED');assert.equal(await a.sellKR(1),'RECONCILIATION_REQUIRED','a sale too (D4)');
  const b=account();b.kr.reconcileHealth={failures:2,since:Date.now(),error:'RECONCILE_FAILED'};assert.equal(await b.buyKR(10),'Accepted','nothing open: nothing to confirm');
});
test('F1: the check fails closed: an order record that does not parse, or a failing read, refuses the send',async()=>{
  const a=account();await a.buyKR(10);a.db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('bad','acct:US','{not json');
  const o=a.kr.propose({symbol:'035420',side:'Buy',quantity:1,limitPrice:1000});const e=await a.kr.submit(o.id,'PLACE MOCK ORDER').catch(x=>x);
  assert.equal(e.message,'RECONCILIATION_REQUIRED');assert.equal(e.detail,'the app\'s order records could not be read');assert.equal(a.s.posts.length,1,'nothing more sent');
  const b=account();await b.buyKR(10);const prepare=b.db.prepare.bind(b.db);b.db.prepare=sql=>sql==='SELECT payload FROM live_intents'?{all:()=>{throw new Error('SQLITE_IOERR');}}:prepare(sql);
  const p=b.kr.propose({symbol:'035420',side:'Buy',quantity:1,limitPrice:1000});const f=await b.kr.submit(p.id,'PLACE MOCK ORDER').catch(x=>x);
  assert.equal(f.message,'RECONCILIATION_REQUIRED');assert.equal(f.detail,'the app\'s order records could not be read');assert.equal(b.s.posts.length,1);
});
test('closed orders block nothing: filled, cancelled, rejected',async()=>{
  for(const status of ['Filled','Canceled','Rejected']){const a=account();await a.buyKR(10);a.set(a.kr,'005930',{status,filled:status==='Filled'?10:0});assert.equal(await a.buyKR(10),'Accepted',status);}
});
test('across the accounts: an unclear U.S. buy blocks only its own stock; its KRW stays committed against a Korean buy',async()=>{
  const a=account();a.s.place=()=>{throw new Error('ORDER_UNCERTAIN');};assert.equal(await a.buyUS(7),'Uncertain','$701.75 at ρ 1,326 = ₩930,520.50 of the KRW pool');a.s.place=null;
  assert.equal(a.us.enabled,true);assert.equal(await a.buyUS(1),'RECONCILIATION_REQUIRED','the same U.S. stock');
  assert.equal(await a.buyKR(600),'INSUFFICIENT_CAPACITY','₩600,000 does not fit beside the unclear buy\'s ₩930,520.50');
  assert.equal(await a.buyKR(60),'Accepted','₩60,000 does: the Korean market is not blocked by the U.S. order');near(a.committed().krw,60000);
  assert.ok(a.committed().rows.some(c=>c.market==='US'&&c.state==='uncertain'),'the U.S. order is committed as uncertain');
});
test('the switch off keeps the one-order rule here too (the same fixture): a second order of another stock is refused',async()=>{
  const a=account();const db=a.db;const off=new LiveEngine(db,a.kr.broker,a.kr.getConnection);off.costs=a.kr.costs;off.funding=a.ledger;off.enabled=true;
  assert.equal(await a.buyKR(10),'Accepted');const o=off.propose({symbol:'035420',side:'Buy',quantity:1,limitPrice:1000});await assert.rejects(off.submit(o.id,'PLACE MOCK ORDER'),/RECONCILIATION_REQUIRED/);
});
