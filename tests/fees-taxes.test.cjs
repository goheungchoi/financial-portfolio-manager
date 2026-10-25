const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {buildLedger,annualTax,estimatedSettlement}=require('../electron/tax-ledger.cjs');
const {TradingCosts,DEFAULT_COSTS,estimateCosts,brokerCosts}=require('../electron/trading-costs.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const rates={'2026-03-03':1300,'2026-06-02':1400,'2026-10-16':1500,'2027-01-04':1450};const rateOn=day=>rates[day]?{rate:rates[day],source:'ECOS'}:null;
const fill=(id,side,quantity,price,tradeDate,extra={})=>({id,symbol:'NASD:TEST',side,quantity,price,feesUSD:0,tradeDate,...extra});
test('moving-average and FIFO costs differ as expected; fees and rates are in KRW',()=>{
  const fills=[fill('b1','Buy',10,100,'2026-03-02',{feesUSD:10}),fill('b2','Buy',10,200,'2026-06-01'),fill('s1','Sell',10,300,'2026-10-15',{feesUSD:5})];
  const avg=buildLedger({fills,rateOn});const fifo=buildLedger({fills,rateOn,method:'fifo'});
  const proceeds=Math.round((3000-5)*1500);assert.equal(avg.sales[0].proceedsKRW,proceeds);
  const lot1=(1000+10)*1300,lot2=2000*1400;
  assert.equal(avg.sales[0].costKRW,Math.round((lot1+lot2)/2));assert.equal(fifo.sales[0].costKRW,lot1);
  assert.equal(fifo.positions['NASD:TEST'].costKRW,lot2);assert.equal(avg.positions['NASD:TEST'].quantity,10);
  assert.equal(estimatedSettlement('2026-10-16'),'2026-10-19','Friday trades settle Monday');
});
test('settlement-date year, user basis for older shares, unknown basis and the annual deduction',()=>{
  const ledger=buildLedger({fills:[fill('s1','Sell',5,100,'2026-12-31',{settlementDate:'2027-01-04'}),fill('s2','Sell',2,100,'2026-10-15')],rateOn,userBasis:{}});
  assert.equal(ledger.sales[0].year,2026,'sorted by trade date; the October sale is 2026');assert.equal(ledger.sales[0].gainKRW,null);assert.equal(ledger.sales[0].basisSource,'Unknown basis');
  assert.equal(ledger.sales[1].year,2027,'a late-December trade settling in January is taxed next year');
  const withBasis=buildLedger({fills:[fill('s2','Sell',2,100,'2026-10-15')],rateOn,userBasis:{'NASD:TEST':100000}});assert.equal(withBasis.sales[0].gainKRW,2*100*1500-200000);
  const summary=annualTax({sales:[{year:2026,gainKRW:4000000},{year:2026,gainKRW:-500000},{year:2027,gainKRW:9e9}]},2026,1000000);
  assert.equal(summary.totalKRW,4500000);assert.equal(summary.taxableKRW,2000000);assert.equal(summary.estimatedTaxKRW,440000);assert.equal(summary.deductionRemainingKRW,0);assert.equal(summary.complete,true);
  assert.equal(annualTax({sales:[]},2026,null).complete,false,'outside-app gains not entered');
});
test('tax amounts use the settlement-date reference rate; broker KRW and rates are kept as cash evidence (tax plan PR 2)',()=>{
  // 2026-10-25 read-only check: KIS fixed 1,324.6 for Oct 23 trades settling Oct 26, before that day's rate existed.
  const ledger=buildLedger({fills:[fill('b','Buy',1,100,'2026-03-02',{settlementKRW:-131000}),fill('s','Sell',1,120,'2026-10-15',{exchangeRate:1490,feesUSD:1})],rateOn});
  assert.equal(ledger.purchases[0].costKRW,130000,'100 x 1,300 on 2026-03-03');assert.equal(ledger.purchases[0].brokerKRW,131000,'the broker figure is kept beside it');
  assert.equal(ledger.sales[0].proceedsKRW,Math.round(119*1500));assert.equal(ledger.sales[0].brokerRate,1490);assert.equal(ledger.sales[0].rateProvisional,false);
  const future=buildLedger({fills:[fill('f','Buy',1,100,'2026-10-23',{settlementDate:'2026-10-26',exchangeRate:1324.6})],rateOn:()=>null,today:'2026-10-25'});
  assert.equal(future.purchases[0].costKRW,132460);assert.equal(future.purchases[0].rateProvisional,true,'until the settlement-date rate is published');
  const past=buildLedger({fills:[fill('p','Buy',1,100,'2026-10-20',{settlementDate:'2026-10-21',exchangeRate:1324.6})],rateOn:()=>null,today:'2026-10-25'});
  assert.equal(past.purchases[0].costKRW,null,'a missing rate on a past publication day is missing, not replaced by the broker rate');
});
test('broker-reported costs: KR splits the statutory sale tax from the reported total; ETFs and ETNs pay no sale tax',()=>{
  const kr=brokerCosts({market:'KR',side:'Sell',quantity:10,price:70000,settings:DEFAULT_COSTS,reported:{charges:1505}});
  assert.equal(kr.basis,'broker');assert.equal(kr.transactionTax,1400);assert.equal(kr.commission,105);assert.equal(kr.netCash,700000-1505);
  const etf=brokerCosts({market:'KR',side:'Sell',quantity:10,price:70000,settings:DEFAULT_COSTS,reported:{charges:105},exempt:true});assert.equal(etf.transactionTax,0);assert.equal(etf.commission,105);
  assert.equal(estimateCosts({market:'KR',side:'Sell',quantity:10,price:70000,exempt:true}).transactionTax,0);assert.equal(estimateCosts({market:'KR',side:'Sell',quantity:10,price:70000}).transactionTax,1400);
  const us=brokerCosts({market:'US',side:'Sell',quantity:2,price:100,settings:DEFAULT_COSTS,reported:{feesUSD:0.51,settlementUSD:199.49,exchangeRate:1400,settlementDate:'2026-10-19'}});
  assert.equal(us.netCash,199.49);assert.equal(us.commission,0.51);assert.equal(us.settlementDate,'2026-10-19');
});
test('TradingCosts flags domestic ETFs from the security master and fills missing settlement-day rates',()=>{
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT,isin TEXT,industry TEXT);INSERT INTO securities VALUES('069500','KODEX 200','','KOSPI','etf','',NULL),('005930','Samsung','','KOSPI','stock','',NULL);CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)");
  const costs=new TradingCosts(db);assert.equal(costs.exempt('069500'),true);assert.equal(costs.exempt('005930'),false);assert.equal(costs.exempt('NASD:SPY'),false);
  costs.currentAccount=()=>({accountKey:'k',environment:'live'});db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('b','k:US',JSON.stringify({id:'b',accountKey:'k:US',environment:'live',market:'US',side:'Buy',symbol:'NASD:TEST',filled:1,fillPrice:10,day:'2026-10-16'}));
  assert.deepEqual(costs.missingRateDays(),['2026-10-19']);costs.saveRates([{date:'2026-10-19',value:1400}],'ECOS');assert.deepEqual(costs.missingRateDays(),[]);
  assert.equal(costs.rateOn('2026-10-20'),null,'a normal publication day without a rate is missing');assert.equal(costs.rateOn('2026-10-24').rate,1400,'a Saturday uses the last published rate');assert.match(costs.rateOn('2026-10-24').source,/no publication on 2026-10-24/);
  costs.krClosed=()=>new Set(['2026-10-20']);assert.equal(costs.rateOn('2026-10-20').rate,1400,'and so does a Korean holiday');assert.equal(costs.rateOn('2026-11-30'),null,'but not more than a week');
});
function engine(market,responses){
  const db=new DatabaseSync(':memory:');const calls=[];const snapshot={accountKey:'acct',environment:'live',holdings:[]};
  const live=new LiveEngine(db,{request:async(op,payload)=>{calls.push([op,payload]);const r=responses[op];if(r instanceof Error)throw r;return typeof r==='function'?r(payload):r;}},()=>({status:'connected',snapshot}),market==='US'?{market:'US'}:undefined);
  const put=o=>live.save({accountKey:live.identity(),market,currency:market==='US'?'USD':'KRW',costSettings:DEFAULT_COSTS,status:'Filled',brokerOrderId:'1',createdAt:Date.now(),...o});return {live,calls,put};
}
test('refreshCharges replaces KR estimates with the broker figure and leaves mismatched fills pending',async()=>{
  const {live,calls,put}=engine('KR',{charges:({orderId})=>orderId==='1'?{orderId,filled:10,amount:700000,charges:1505}:{orderId,filled:3,amount:0,charges:0}});
  put({id:'a',symbol:'005930',side:'Sell',quantity:10,filled:10,fillPrice:70000,day:'2026-10-16'});put({id:'b',symbol:'005930',side:'Buy',quantity:10,filled:10,fillPrice:70000,day:'2026-10-16',brokerOrderId:'2'});
  assert.equal(await live.refreshCharges(),1);const [a,b]=['a','b'].map(id=>live.orders().find(o=>o.id===id));
  assert.equal(a.resultCosts.basis,'broker');assert.equal(a.resultCosts.netCash,698495);assert.equal(b.reportedCosts.status,'pending');assert.equal(b.reportedCosts.code,'FILL_MISMATCH');
  assert.equal(await live.refreshCharges(),0,'not retried within 15 minutes');assert.equal(calls.length,2);
});
test('U.S. charges: unavailable on mock, matched by ticker/side/date on live, ambiguous when quantities differ',async()=>{
  const unavailable=Object.assign(new Error('FEATURE_UNAVAILABLE'));const mock=engine('US',{charges:unavailable});
  mock.put({id:'m',symbol:'NASD:TEST',side:'Buy',quantity:2,filled:2,fillPrice:100,day:'2026-10-15'});await mock.live.refreshCharges();assert.equal(mock.live.orders()[0].reportedCosts.status,'unavailable');
  const trades=[{tradeDate:'2026-10-15',settlementDate:'2026-10-17',ticker:'TEST',side:'Buy',quantity:2,price:100,settlementUSD:200.5,settlementKRW:281000,feesUSD:0.5,exchangeRate:1401.5},{tradeDate:'2026-10-15',ticker:'OTHER',side:'Buy',quantity:5,price:1,feesUSD:0.01}];
  const real=engine('US',{charges:trades});real.put({id:'u',symbol:'NASD:TEST',side:'Buy',quantity:2,filled:2,fillPrice:100,day:'2026-10-15'});real.put({id:'o',symbol:'NYSE:OTHER',side:'Buy',quantity:4,filled:4,fillPrice:1,day:'2026-10-15'});
  assert.equal(await real.live.refreshCharges(),1);const u=real.live.orders().find(o=>o.id==='u'),o=real.live.orders().find(o=>o.id==='o');
  assert.equal(u.resultCosts.netCash,-200.5);assert.equal(u.reportedCosts.exchangeRate,1401.5);assert.equal(u.reportedCosts.settlementKRW,281000);assert.equal(o.reportedCosts.status,'ambiguous','5 broker shares vs 4 app shares');
});
