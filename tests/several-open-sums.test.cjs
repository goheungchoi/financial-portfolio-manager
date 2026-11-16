// M-1.4 (artifacts/reviews/2026-11-16-multi-order, A2; D3, D5, D6; matrix rows 3-7): with severalOpen on, every limit
// counts the other open orders: the app's, and yours in KIS from the preparation. With the switch off the lists are
// empty and every number is as before (the pins in tests/several-open.test.cjs; the whole suite).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {Exposure}=require('../electron/exposure.cjs');
const iso=()=>new Date().toISOString();
// One Korean account, the real funding ledger; prepare returns `yours` as KIS's other open orders and an optional session.
function account({krw=1000000,limits={},severalOpen=true,holdings=[]}={}){const db=new DatabaseSync(':memory:');
  const s={kr:{accountKey:'acct',environment:'mock',reportedTotal:krw,cash:krw,settledCash:krw,holdings},us:{accountKey:'acct:US',environment:'mock',reportedTotal:0,cash:0,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}},yours:[],session:null,posts:0};
  const krFresh=()=>({...structuredClone(s.kr),timestamp:iso()}),usFresh=()=>({...structuredClone(s.us),timestamp:iso(),fx:{usdKRW:1300,timestamp:Date.now()},brokerBuyingPower:null});
  const broker={request:async op=>{if(op==='prepare-order')return {ticket:'t',balance:krFresh(),...(s.yours.length?{openOrders:s.yours}:{}),...(s.session?{session:s.session}:{})};if(op==='place-order'){s.posts++;return {brokerOrderId:String(1000+s.posts)};}throw new Error('unexpected '+op);}};
  const ledger=new FundingLedger(db,{fresh:async m=>m==='KR'?krFresh():usFresh(),fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});ledger.init();
  const kr=new LiveEngine(db,broker,()=>({status:'connected',snapshot:s.kr}),{severalOpen});kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};kr.funding=ledger;
  kr.configure({symbols:[],lossLimit:{mode:'off',value:0},...limits},'ENABLE MOCK');
  const buy=async(symbol,quantity,price=1000)=>{const o=kr.propose({symbol,side:'Buy',quantity,limitPrice:price});try{return (await kr.submit(o.id,'PLACE MOCK ORDER')).status;}catch(e){return e.message;}};
  const set=(symbol,patch)=>{const o=kr.orders().find(r=>r.symbol===symbol);kr.writeOrder({...o,...patch});};
  return {db,s,kr,ledger,buy,set};}
const yours=(orderId,symbol,remaining,price,side='Buy')=>({orderId,symbol,side,remaining,price});

test('row 3, turnover: an order whose cancellation is unconfirmed still counts toward the day\'s turnover',async()=>{
  const a=account({limits:{maxDailyTurnoverKRW:500000}});assert.equal(await a.buy('005930',300),'Accepted');a.set('005930',{status:'Cancellation uncertain'});
  assert.equal(await a.buy('035420',300),'DAILY_TURNOVER_LIMIT','₩300,000 + ₩300,000 > ₩500,000');assert.equal(await a.buy('035420',200),'Accepted','₩500,000 fits');
});
test('row 4, company share: the stock\'s other open buys count (the app\'s unfilled shares, and yours in KIS)',async()=>{
  const a=account({limits:{maxCompanyPct:10}});assert.equal(await a.buy('005930',60),'Accepted');
  assert.equal(await a.buy('005930',50),'CONCENTRATION_LIMIT','(60 + 50) × ₩1,000 = 11% of ₩1,000,000');assert.equal(await a.buy('005930',40),'Accepted','(60 + 40) = 10% fits');
  const b=account({limits:{maxCompanyPct:10}});assert.equal(await b.buy('005930',60),'Accepted');b.set('005930',{status:'Partially filled',filled:30});
  assert.equal(await b.buy('005930',75),'CONCENTRATION_LIMIT','30 unfilled + 75 > 100 shares');
  const c=account({limits:{maxCompanyPct:10}});c.s.yours=[yours('900','005930',70,1000)];assert.equal(await c.buy('005930',40),'CONCENTRATION_LIMIT','your 70 in KIS + 40');assert.equal(await c.buy('005930',30),'Accepted');
});
test('row 5 and D3: your own open buys at KIS must fit beside a new buy in the funding check, and are not reserved',async()=>{
  const a=account();a.s.yours=[yours('900','035420',500,1000)];assert.equal(await a.buy('005930',600),'INSUFFICIENT_CAPACITY','₩500,000 yours + ₩600,000 > ₩1,000,000');
  assert.equal(await a.buy('005930',400),'Accepted');assert.equal(a.ledger.commitments('acct').krw,400000,'only the app\'s order is committed');
  a.s.yours=[yours('900','035420',500,1000,'Sell')];assert.equal(await a.buy('000660',500),'Accepted','your sale takes no cash');
});
test('row 7: the leveraged, margin and short caps count open orders of their kind (pending)',()=>{
  const e=new Exposure(new DatabaseSync(':memory:'));e.setOverride('122630',2);e.setOverride('252670',-2);e.setOverride('005930',1);
  e.savePolicy('a',{leveragedEtps:{enabled:true,auto:true,maxPctOfEquity:10},margin:{enabled:true,auto:true,maxLoanPctOfEquity:15},short:{enabled:true,auto:true,maxGrossPctOfEquity:10}});
  const base={account:'a',symbol:'122630',side:'Buy',equity:10000000,holdings:[]};
  assert.ok(e.check({...base,notional:600000}),'alone: 6%');
  assert.throws(()=>e.check({...base,notional:600000,pending:[{symbol:'252670',side:'Buy',notional:500000}]}),/LEVERAGED_EXPOSURE_LIMIT/,'with an open inverse buy: 11%');
  assert.ok(e.check({...base,notional:600000,pending:[{symbol:'005930',side:'Buy',notional:5000000},{symbol:'252670',side:'Sell',notional:500000}]}),'a standard buy and a sale do not count');
  assert.throws(()=>e.check({...base,notional:600000,pending:[{symbol:'999999',side:'Buy',notional:500000}]}),/LEVERAGED_EXPOSURE_LIMIT/,'an open buy the master cannot classify counts (it could be leveraged)');
  const balance={environment:'live',reportedTotal:10000000,cash:2000000,loanTotal:1000000,holdings:[],shorts:[]};const credit={account:'a',symbol:'005930',equity:10000000,balance};
  assert.ok(e.checkCredit({...credit,kind:'margin-buy',notional:400000}),'loans 1,000,000 + 400,000 = 14%');
  assert.throws(()=>e.checkCredit({...credit,kind:'margin-buy',notional:400000,pending:[{symbol:'000660',side:'Buy',credit:'margin-buy',notional:200000}]}),/MARGIN_LIMIT/);
  assert.ok(e.checkCredit({...credit,kind:'short',notional:600000}),'6%');assert.throws(()=>e.checkCredit({...credit,kind:'short',notional:600000,pending:[{symbol:'000660',side:'Sell',credit:'short',notional:500000}]}),/SHORT_LIMIT/);
  assert.ok(e.checkCredit({...credit,kind:'short',notional:600000,pending:[{symbol:'000660',side:'Sell',credit:null,notional:5000000}]}),'a cash sale is no short');
});
test('D6: the extended-session size limit is summed across the app\'s open extended-session orders',async()=>{
  const a=account();a.kr.extendedMaxOrderPct=()=>5;a.s.session={id:'kr-nxt-pre',regular:false,approval:false};
  assert.equal(await a.buy('005930',30),'Accepted','₩30,000 of the ₩50,000 cap');assert.equal(a.kr.orders()[0].session,'kr-nxt-pre');
  assert.equal(await a.buy('035420',30),'EXTENDED_SIZE_LIMIT','₩30,000 + ₩30,000 > ₩50,000');assert.equal(await a.buy('035420',20),'Accepted');
  a.s.session=null;assert.equal(await a.buy('000660',300),'Accepted','a regular-session order is not capped by them');
});
test('D5: a raise counts the stock\'s other open buys at their full quantity, not their remainder',()=>{
  const a=account({limits:{maxCompanyPct:10}});const put=(id,patch)=>a.kr.writeOrder({id,accountKey:'acct',symbol:'005930',side:'Buy',quantity:40,filled:0,limitPrice:1000,notional:40000,status:'Accepted',day:a.kr.day(),createdAt:Date.now(),...patch});
  put('A',{});put('B',{filled:30,status:'Partially filled'});const A=a.kr.orders().find(o=>o.id==='A');
  assert.equal(a.kr.revisionStop(A,{price:1500,remaining:40,notional:60000}),'CONCENTRATION_LIMIT','(B\'s 40 + A\'s 40) × ₩1,500 = 12%');
  assert.equal(a.kr.revisionStop(A,{price:1240,remaining:40,notional:49600}),null,'80 × ₩1,240 = 9.9%: with B\'s remainder (10) it would also pass at ₩1,500');
});
test('F2: your own open orders count at their full ordered quantity (a fill between the balance and history reads is in neither)',async()=>{
  const q=(orderId,symbol,quantity,remaining,price,side='Buy')=>({orderId,symbol,side,quantity,remaining,price});
  const a=account({limits:{maxCompanyPct:10}});a.s.yours=[q('900','005930',100,40,500)];
  assert.equal(await a.buy('005930',1),'CONCENTRATION_LIMIT','(100 ordered + 1) × ₩1,000 > 10%, though only 40 remain');
  const b=account();b.s.yours=[q('900','035420',100,40,5000)];
  assert.equal(await b.buy('005930',600),'INSUFFICIENT_CAPACITY','yours: 100 × ₩5,000 = ₩500,000 (not 40 × ₩5,000) + ₩600,000');assert.equal(await b.buy('005930',500),'Accepted');
  const c=account();c.s.yours=[q('900','035420',undefined,40,5000)];assert.equal(c.kr.pendingOrders({id:'x'},{openOrders:c.s.yours}).find(o=>o.yours).quantity,40,'no ordered quantity listed: the remainder');
});
test('F1: a raise checks the leveraged cap with the other open buys at their full quantity',()=>{
  const a=account();const e=new Exposure(a.db);e.setOverride('122630',2);e.savePolicy('acct',{leveragedEtps:{enabled:true,auto:true,maxPctOfEquity:10}});a.kr.exposure=e;
  const put=(id,patch)=>a.kr.writeOrder({id,accountKey:'acct',symbol:'122630',side:'Buy',quantity:40,filled:0,limitPrice:1000,notional:40000,status:'Accepted',day:a.kr.day(),createdAt:Date.now(),...patch});
  put('A',{});put('B',{quantity:60,filled:50,notional:60000,status:'Partially filled'});const A=a.kr.orders().find(o=>o.id==='A');
  assert.equal(a.kr.revisionStop(A,{price:1000,remaining:40,notional:45000}),'LEVERAGED_EXPOSURE_LIMIT','B\'s 60 × ₩1,000 + ₩45,000 = 10.5% of ₩1,000,000');
  a.kr.writeOrder({...a.kr.orders().find(o=>o.id==='B'),quantity:50,notional:50000});assert.equal(a.kr.revisionStop(A,{price:1000,remaining:40,notional:45000}),null,'B\'s 50 × ₩1,000 + ₩45,000 = 9.5%; on B\'s remainder (0) it would always pass');
});
test('with the switch off, no list is built and nothing is added (same numbers as before)',async()=>{
  const a=account({severalOpen:false,limits:{maxCompanyPct:10}});assert.equal(await a.buy('005930',60),'Accepted');
  assert.deepEqual(a.kr.pendingOrders({id:'x'},{openOrders:[yours('900','005930',70,1000)]}),[],'nothing from the app or from KIS');
  const A=a.kr.orders()[0];a.kr.writeOrder({...a.kr.orders()[0],id:'B',brokerOrderId:'2000'});assert.equal(a.kr.revisionStop(A,{price:1500,remaining:60,notional:90000}),null,'off: 60 × ₩1,500 = 9% (B not counted)');
});
