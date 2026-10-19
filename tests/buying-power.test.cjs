const test=require('node:test');const assert=require('node:assert/strict');
const {brokerFigures,integratedOn,usBuyingPower}=require('../electron/buying-power.cjs');
// The figures KIS returned for the mock account on 2026-10-19 (USD deposit 0, KRW cash 10,000,000).
const mock=brokerFigures({ord_psbl_frcr_amt:'99784.21',frcr_ord_psbl_amt1:'213781.833719',ord_psbl_qty:'461',ovrs_max_ord_psbl_qty:'998',exrt:'1342.4000000000'});
test('integrated margin is detected when the integrated figure exceeds the foreign-only one',()=>{
  assert.equal(integratedOn(mock),true);assert.equal(integratedOn(brokerFigures({ord_psbl_frcr_amt:'500',frcr_ord_psbl_amt1:'500'})),false);assert.equal(brokerFigures(null),null);
});
test('U.S. buying power is capped at real cash: USD plus KRW only with integrated margin',()=>{
  const p=usBuyingPower({usdCash:0,broker:mock,krwCash:10000000,usdKRW:1342.4});
  assert.equal(p.usd,7449.34,'₩10M at 1,342.4 instead of the mock 213,781 USD');assert.equal(p.integratedMargin,true);assert.equal(p.fromKRWUSD,7449.34);assert.equal(p.brokerUSD,213781.83);
  const off=usBuyingPower({usdCash:0,broker:brokerFigures({ord_psbl_frcr_amt:'99784.21',frcr_ord_psbl_amt1:'99784.21'}),krwCash:10000000,usdKRW:1342.4});
  assert.equal(off.usd,0,'without integrated margin KRW does not count, whatever the broker reports');
  assert.equal(usBuyingPower({usdCash:500,broker:null}).usd,500,'unknown broker figure falls back to USD cash');
  assert.equal(usBuyingPower({usdCash:500,broker:brokerFigures({ord_psbl_frcr_amt:'300',frcr_ord_psbl_amt1:'300'})}).usd,300,'never above what KIS allows');
});
test('the agents are told about the shared pool only when integrated margin is on',()=>{
  const {combinedContext}=require('../electron/combined-context.cjs');const base=m=>({market:m,currency:m==='US'?'USD':'KRW',universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:true},equity:1,cash:0});
  const on=combinedContext(base('KR'),{...base('US'),buyingPower:usBuyingPower({usdCash:0,broker:mock,krwCash:1e7,usdKRW:1342.4})},{usdKRW:1342.4});
  assert.match(on.objective,/same money as Korea cash/);assert.equal(on.markets[1].buyingPower.usd,7449.34);
  const off=combinedContext(base('KR'),base('US'),{usdKRW:1342.4});assert.match(off.objective,/Never spend KRW cash on a USD order/);
});
