// Shared KRW funding across markets (independent accounting review of 162d7c9, "Other requested checks"): Korean and
// U.S. buys drawing on one KRW pool through integrated margin, run through both engines' submit(), which includes the
// final broker preparation check. The fake brokers return what KIS would show at preparation; U.S. buying power is
// wired as electron/main.cjs wires it (usBuyingPower with the last Korean snapshot's settled cash). Cases the app
// guards today are ordinary tests; defects are todo tests asserting the safe behaviour (reported, not failing the suite).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {TradingCosts}=require('../electron/trading-costs.cjs');const {usBuyingPower}=require('../electron/buying-power.cjs');
const RATE=1300;
// One account in two markets. kr/us: what KIS shows at preparation (fresh); krSnapshot: the Korean balance the app
// last read (kisState.snapshot), which U.S. buying power uses; integratedUSD: KIS's integrated U.S. buying power.
function account({krw=1000000,usd=0,integratedUSD=null}={}){
  const db=new DatabaseSync(':memory:');const s={kr:{accountKey:'acct',environment:'mock',reportedTotal:krw,cash:krw,settledCash:krw,holdings:[]},
    us:{accountKey:'acct:US',environment:'mock',reportedTotal:usd,cash:usd,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}},integratedUSD:integratedUSD??Math.floor(krw/RATE+usd),posts:[]};
  s.krSnapshot=structuredClone(s.kr);
  const usFresh=()=>({...structuredClone(s.us),brokerBuyingPower:s.integratedUSD==null?null:{foreignUSD:s.us.cash,integratedUSD:s.integratedUSD,rate:RATE}});
  const broker=market=>({request:async op=>{if(op==='prepare-order')return {ticket:'t',balance:market==='KR'?structuredClone(s.kr):usFresh()};
    if(op==='place-order'){s.posts.push(market);return {brokerOrderId:String(s.posts.length)};}throw new Error('unexpected '+op);}});
  const kr=new LiveEngine(db,broker('KR'),()=>({status:'connected',snapshot:s.kr}));kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const us=new LiveEngine(db,broker('US'),()=>({status:'connected',snapshot:usFresh()}),{market:'US'});us.costs=new TradingCosts(db);
  us.buyingPower=balance=>usBuyingPower({usdCash:balance?.cash??0,broker:balance?.brokerBuyingPower??null,krwCash:s.krSnapshot.settledCash,usdKRW:RATE});
  kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');us.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  const buy=async(engine,symbol,quantity,limitPrice)=>{const o=engine.propose({symbol,side:'Buy',quantity,limitPrice});try{return (await engine.submit(o.id,'PLACE MOCK ORDER')).status;}catch(e){return e.message;}};
  return {s,kr,us,buyKR:(q,p=1000)=>buy(kr,'005930',q,p),buyUS:(q,p=100)=>buy(us,'NASD:AAPL',q,p)};}

test('a U.S. buy may use KRW through integrated margin up to what KIS allows and the KRW the account has',async()=>{
  assert.equal(await account().buyUS(7),'Accepted','$700 of ₩1,000,000 at 1,300');assert.equal(await account().buyUS(8),'INSUFFICIENT_CAPACITY','$800 is more than the KRW covers');
  // Within one market an open order already holds back the next until it is reconciled.
  const a=account();assert.equal(await a.buyUS(1),'Accepted');assert.equal(await a.buyUS(1),'RECONCILIATION_REQUIRED');
  const b=account({integratedUSD:300});assert.equal(await b.buyUS(4),'INSUFFICIENT_CAPACITY','KIS\'s own figure caps it');
});
test('with KIS\'s integrated figure reflecting a Korean order or fill, a U.S. buy cannot reuse that KRW (the broker cap)',async()=>{
  // Open Korean order: KIS reserves its KRW, so the integrated figure falls; the app's KRW term (settled cash) does not.
  let a=account();assert.equal(await a.buyKR(900),'Accepted');a.s.integratedUSD=Math.floor(100000/RATE);assert.equal(await a.buyUS(7),'INSUFFICIENT_CAPACITY');
  // A Korean fill after the app's last Korean reading: the snapshot is stale, the broker figure is not.
  a=account();a.s.kr.settledCash=100000;a.s.integratedUSD=Math.floor(100000/RATE);assert.equal(await a.buyUS(7),'INSUFFICIENT_CAPACITY');
  // Without a broker figure, only USD cash counts.
  a=account();a.s.integratedUSD=null;const us=a.us.buyingPower({cash:0,brokerBuyingPower:null});assert.equal(us.usd,0);
});
// Defects: the app's own guard does not reserve KRW across markets; it relies on KIS figures whose meaning for this
// case is not verified (Korean nrcvb_buy_amt queried with OVRS_ICLD_YN 'N'; the integrated U.S. figure). Proposed fix:
// one shared KRW ledger used by both final preparation checks, under one lock (artifacts/reviews/2026-11-05-accounting/
// reconciliation-design.md, section 7).
test('a Korean buy does not reuse KRW committed to an unsettled U.S. buy',{todo:'defect: the Korean check uses projected settled cash, which still holds KRW committed to unsettled U.S. buys'},async()=>{
  const a=account();assert.equal(await a.buyUS(7),'Accepted');
  // Filled, awaiting settlement: KIS reports it awaiting settlement, KRW-funded; the Korean deposit keeps the KRW until then.
  a.s.us.unsettled={buyKRW:910000,sellKRW:0,krwFundedKRW:910000};
  assert.equal(await a.buyKR(900),'INSUFFICIENT_CAPACITY','only ₩90,000 is not committed');
});
test('a U.S. buy does not reuse KRW reserved by an open Korean order when the broker figure does not reflect it',{todo:'defect: the U.S. check counts the Korean settled cash, which an open order does not reduce, and has only the broker cap'},async()=>{
  const a=account();assert.equal(await a.buyKR(900),'Accepted');assert.equal(await a.buyUS(7),'INSUFFICIENT_CAPACITY','₩900,000 is reserved by the open Korean order');
});
test('the open remainder of a partly filled or uncertainly cancelled Korean order stays reserved',{todo:'defect: open and uncertain Korean remainders are not reserved for U.S. buys'},async()=>{
  for(const status of ['Partially filled','Cancellation uncertain']){const a=account();assert.equal(await a.buyKR(900),'Accepted');const o=a.kr.orders()[0];a.kr.save({...o,status,filled:450});
    a.s.kr.settledCash=a.s.krSnapshot.settledCash=550000;assert.equal(await a.buyUS(3),'INSUFFICIENT_CAPACITY',`${status}: ₩450,000 still reserved, ₩100,000 left`);}
});
test('a Korean buy does not reuse KRW reserved by an open U.S. order funded from KRW',{todo:'defect: open U.S. buys funded from KRW are not reserved for Korean buys'},async()=>{
  const a=account();assert.equal(await a.buyUS(7),'Accepted');assert.equal(await a.buyKR(900),'INSUFFICIENT_CAPACITY');
});
test('two preparations at once cannot both claim the same KRW',{todo:'defect: Korean and U.S. preparations are not serialized against one funding pool'},async()=>{
  const a=account();const [k,u]=await Promise.all([a.buyKR(900),a.buyUS(7)]);assert.ok([k,u].includes('INSUFFICIENT_CAPACITY'),`${k} / ${u}`);
});
