const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Exposure}=require('../electron/exposure.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
function db(){const d=new DatabaseSync(':memory:');d.exec("CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT,isin TEXT,industry TEXT);INSERT INTO securities VALUES('122630','KODEX 레버리지','','KOSPI','etf','',NULL),('252670','KODEX 200선물인버스2X','','KOSPI','etf','',NULL),('005930','삼성전자레버리지테스트','','KOSPI','stock','',NULL),('NYSE:SHV','iShares Short Treasury Bond ETF','iShares Short Treasury Bond ETF','NYSE','etf','',NULL),('AMEX:SPXU','ProShares UltraPro Short S&P500','ProShares UltraPro Short S&P500','AMEX','etf','',NULL)");return d;}
test('classification uses ETF names, known tickers and overrides; ordinary stocks are never leveraged',()=>{
  const e=new Exposure(db());
  assert.deepEqual([e.classify('122630').factor,e.classify('252670').factor,e.classify('005930').factor,e.classify('NYSE:SHV').factor,e.classify('AMEX:SPXU').factor,e.classify('NASD:TQQQ').factor],[2,-2,1,1,-3,3]);
  assert.equal(e.classify('252670').kind,'leveraged-inverse');assert.equal(e.classify('NASD:UNKNOWN').source,'Unknown product');
  e.setOverride('NYSE:SHV',-1);assert.equal(e.classify('NYSE:SHV').source,'Your setting');e.setOverride('NYSE:SHV',null);assert.equal(e.classify('NYSE:SHV').factor,1);
  assert.throws(()=>e.setOverride('NASD:X',0),/INVALID_REQUEST/);assert.throws(()=>e.setOverride('bad',2),/INVALID_REQUEST/);
});
test('policy defaults off, validates limits and turns automatic mode off with the switch',()=>{
  const e=new Exposure(db());assert.equal(e.policy('a').leveragedEtps.enabled,false);
  assert.throws(()=>e.savePolicy('a',{leveragedEtps:{maxPctOfEquity:0}}),/INVALID_SETTINGS/);assert.throws(()=>e.savePolicy('a',{other:{}}),/INVALID_SETTINGS/);
  e.savePolicy('a',{leveragedEtps:{enabled:true,auto:true,maxPctOfEquity:25}});assert.equal(e.policy('a').leveragedEtps.auto,true);assert.equal(e.policy('b').leveragedEtps.enabled,false,'per account');
  e.savePolicy('a',{leveragedEtps:{enabled:false}});assert.equal(e.policy('a').leveragedEtps.auto,false);
});
test('orders: blocked when off, capped by share of account, approval unless automatic; sales always allowed',()=>{
  const e=new Exposure(db());const holdings=[{symbol:'122630',quantity:10,marketValue:150000}];const base={account:'a',side:'Buy',equity:1000000,holdings};
  assert.throws(()=>e.check({...base,symbol:'122630',notional:10000}),/LEVERAGED_NOT_ENABLED/);
  assert.equal(e.check({...base,symbol:'122630',side:'Sell',notional:10000}).requiresApproval,false);assert.equal(e.check({...base,symbol:'005930',notional:10000}).product.kind,'standard');
  e.savePolicy('a',{leveragedEtps:{enabled:true,maxPctOfEquity:20}});
  assert.equal(e.check({...base,symbol:'252670',notional:40000}).requiresApproval,true);assert.throws(()=>e.check({...base,symbol:'252670',notional:60000}),/LEVERAGED_EXPOSURE_LIMIT/);
  e.savePolicy('a',{leveragedEtps:{auto:true}});assert.equal(e.check({...base,symbol:'252670',notional:40000}).requiresApproval,false);
  const s=e.summary([{symbol:'122630',quantity:10,marketValue:100000},{symbol:'252670',quantity:5,marketValue:50000},{symbol:'005930',quantity:1,marketValue:850000}],1000000);
  assert.equal(s.leveragedPct,15);assert.equal(s.effectivePct,(200000-100000+850000)/10000);
});
test('live engine: leveraged proposal waits for approval in automatic mode; AI context flags products and long holds',async()=>{
  const d=db();const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,settledCash:1000000,holdings:[{symbol:'252670',name:'KODEX 200선물인버스2X',quantity:10,cost:3000,price:3000,marketValue:30000}]};let posts=0;
  const live=new LiveEngine(d,{request:async op=>{if(op==='prepare-order')return {ticket:'t',balance:snapshot};if(op==='place-order'){posts++;return {brokerOrderId:'1'};}if(op==='live-context')return {balance:snapshot,quotes:[{symbol:'122630',price:15000,retrievedAt:Date.now()}],marketSession:{open:true}};throw new Error(op);}},()=>({status:'connected',snapshot}));
  live.exposure=new Exposure(d);live.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');live.enableAuto('ENABLE AUTO MOCK');
  assert.throws(()=>live.propose({symbol:'122630',side:'Buy',quantity:1,limitPrice:15000}),/LEVERAGED_NOT_ENABLED/);
  live.exposure.savePolicy('acct',{leveragedEtps:{enabled:true,maxPctOfEquity:10}});
  const order=live.propose({symbol:'122630',side:'Buy',quantity:2,limitPrice:15000});assert.equal(order.requiresApproval,true);assert.equal(order.product.factor,2);
  const held=await live.autoSubmit(order.id);assert.equal(held.reason,'APPROVAL_REQUIRED');assert.equal(held.status,'Ready');assert.equal(posts,0);
  assert.equal((await live.submit(order.id,'PLACE MOCK ORDER')).status,'Accepted',"the user's approval submits it");assert.equal(posts,1);
  live.save({...live.orders()[0],status:'Filled',filled:2});live.save({id:'old',accountKey:'acct',symbol:'252670',side:'Buy',filled:10,status:'Filled',createdAt:Date.now()-20*86400000,day:'2026-09-26'});
  const context=await live.context();assert.deepEqual(context.productRisk.products.map(p=>p.symbol+':'+p.factor).sort(),['122630:2','252670:-2']);assert.equal(context.productRisk.warnings.length,1);assert.match(context.productRisk.warnings[0],/252670/);
  assert.throws(()=>live.propose({symbol:'122630',side:'Buy',quantity:6,limitPrice:15000}),/LEVERAGED_EXPOSURE_LIMIT/);
});
