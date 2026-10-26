const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {annualTax,marginalTax,buildLedger}=require('../electron/tax-ledger.cjs');const rules=require('../electron/tax-rules.cjs');
const {TradingCosts,DEFAULT_COSTS,estimateCosts,migrate}=require('../electron/trading-costs.cjs');const {classify}=require('../electron/security-tax-classification.cjs');
const {applicability,validateProfile,DEFAULT_PROFILE}=require('../electron/tax-profile.cjs');
// Acceptance cases from docs/KOREAN-TAX-IMPLEMENTATION-PLAN.md section 5 (PR 1: certainty and classification).
test('foreign-share gains 4m and losses 1m with complete inputs: taxable 500,000, national 100,000, local 10,000',()=>{
  const y=annualTax({sales:[{year:2026,gainKRW:4000000},{year:2026,gainKRW:-1000000}]},2026,0);
  assert.equal(y.taxableKRW,500000);assert.equal(y.nationalTaxKRW,100000);assert.equal(y.localTaxKRW,10000);assert.equal(y.estimatedTaxKRW,110000);
  assert.equal(y.result.status,'estimated');assert.equal(y.result.value,110000);assert.equal(y.result.ruleVersion,rules.RULE_VERSION);assert.ok(y.result.assumptions.some(a=>/below 10 won/.test(a)),'rounding is stated, not assumed silently');
});
test('one sale with unknown basis: the annual and marginal tax are unknown; the known subtotal is kept and labeled',()=>{
  const y=annualTax({sales:[{year:2026,gainKRW:5000000},{year:2026,gainKRW:null}]},2026,0);
  assert.equal(y.complete,false);assert.equal(y.estimatedTaxKRW,null);assert.equal(y.totalKRW,null);assert.equal(y.result.status,'incomplete');assert.equal(y.result.value,null);
  assert.equal(y.knownTotalKRW,5000000);assert.equal(y.knownRecordsTaxKRW,550000);assert.equal(y.result.knownSubtotal,550000);assert.deepEqual(y.result.missingInputs,['acquisition basis or exchange rate']);
  assert.equal(marginalTax(y,1000000),null,'no marginal estimate from a partial year');
  assert.equal(annualTax({sales:[]},2026,null).result.missingInputs[0],'gains realized at other brokers this year (enter 0 if none)');
});
test('losses: no refund and no carryforward; the deduction left is capped and loss offset is separate',()=>{
  const y=annualTax({sales:[{year:2026,gainKRW:1000000},{year:2026,gainKRW:-3000000}]},2026,0);
  assert.equal(y.estimatedTaxKRW,0);assert.equal(y.deductionRemainingKRW,2500000,'never more than the statutory deduction');assert.equal(y.lossOffsetKRW,2000000);
  assert.equal(marginalTax(annualTax({sales:[{year:2026,gainKRW:1000000}]},2026,0),-500000),0,'a loss below the deduction is no cash credit');
  assert.equal(annualTax({sales:[{year:2026,gainKRW:-2000000}]},2027,0).totalKRW,0,'the 2026 loss does not reach 2027');
});
test('Korean sale taxes are dated statutory components; an override is labeled',()=>{
  assert.deepEqual([rules.krSaleTax('KOSPI',1000000,'2026-10-26').securitiesTransactionTax,rules.krSaleTax('KOSPI',1000000,'2026-10-26').ruralSpecialTax],[500,1500]);
  assert.equal(rules.krSaleTax('KOSPI',1000000,'2025-06-02').total,1500,'2025: no KOSPI transaction tax, rural special tax only');assert.equal(rules.krSaleTax('KOSDAQ',1000000,'2024-06-03').total,1800);assert.equal(rules.krSaleTax('KONEX',1000000,'2026-10-26').total,1000);
  const samsung=classify('005930',{market:'KOSPI',type:'stock'});const sell=estimateCosts({market:'KR',side:'Sell',quantity:1,price:1000000,classification:samsung,day:'2026-10-26'});
  assert.equal(sell.transactionTax,2000);assert.equal(sell.saleTax.securitiesTransactionTax,500);assert.equal(sell.saleTax.ruralSpecialTax,1500);
  const over=estimateCosts({market:'KR',side:'Sell',quantity:1,price:1000000,classification:samsung,settings:{...DEFAULT_COSTS,krSellTaxOverridePct:0.18},day:'2026-10-26'});assert.equal(over.transactionTax,1800);assert.equal(over.saleTax.basis,'override');assert.ok(over.incomeTax.assumptions.includes('your saved sale-tax override'));
  assert.deepEqual(migrate({krSellTaxPct:0.2,krCommissionPct:0.01}),{krCommissionPct:0.01},'the old default is the statutory rate');assert.deepEqual(migrate({krSellTaxPct:0.18}),{krSellTaxOverridePct:0.18},'a changed rate is kept as an override');
});
test('ETFs: no sale tax, but income tax on gains stays unknown rather than zero; Korean listed shares owe none',()=>{
  const etf=classify('069500',{market:'KOSPI',type:'etf'}),overseasEtf=classify('360750',{market:'KOSPI',type:'etf'}),share=classify('005930',{market:'KOSPI',type:'stock'});
  for(const c of [etf,overseasEtf]){assert.equal(c.transactionTax,'exempt');assert.equal(c.incomeTax,'unknown');}
  const sale=c=>estimateCosts({market:'KR',side:'Sell',quantity:10,price:20000,costPerShare:15000,classification:c,day:'2026-10-26'});
  assert.equal(sale(etf).transactionTax,0);assert.equal(sale(etf).capitalGainsTaxKRW,null);assert.equal(sale(etf).gainAfterEstimatedTax,null);assert.equal(sale(etf).incomeTax.status,'incomplete');assert.deepEqual(sale(etf).incomeTax.missingInputs,['ETF income-tax classification and taxable NAV']);
  assert.equal(sale(share).capitalGainsTaxKRW,0);assert.equal(sale(share).gainAfterEstimatedTax,sale(share).gainAfterFees);assert.equal(sale(share).incomeTax.status,'estimated');
  assert.equal(classify('NASD:SPY',{market:'NASD',type:'etf'}).incomeTax,'overseas-capital-gains','a U.S.-listed ETF is in the overseas-share bucket');
  assert.equal(classify('NASD:XYZ',{market:'NASD',type:'warrant'}).incomeTax,'unknown');assert.match(classify('NASD:ABC',null).assumption,/ordinary foreign-company share/);
});
test('special accounts, non-residents and major shareholders are declined instead of using the ordinary formula',()=>{
  const live={accountKey:'acct',environment:'live'};
  assert.equal(applicability(DEFAULT_PROFILE,live,'US').status,'estimated');assert.ok(applicability(DEFAULT_PROFILE,live,'US').assumptions.includes('Korean tax resident individual (not confirmed)'));
  for(const type of ['isa','pension','corporate','ria'])assert.equal(applicability({...DEFAULT_PROFILE,accounts:{acct:{type,linked:true}}},live,'US').status,'unsupported',type);
  assert.equal(applicability({...DEFAULT_PROFILE,residency:'non-resident'},live,'US').status,'unsupported');assert.equal(applicability({...DEFAULT_PROFILE,majorShareholder:true},live,'KR').status,'unsupported');assert.equal(applicability({...DEFAULT_PROFILE,majorShareholder:true},live,'US').status,'estimated');
  assert.equal(applicability({residency:'resident',longTermResident:true,majorShareholder:false,accounts:{acct:{type:'ordinary',linked:true}}},live,'US').status,'supported');
  const y=annualTax({sales:[{year:2026,gainKRW:4000000}]},2026,0,{applicability:applicability({...DEFAULT_PROFILE,accounts:{acct:{type:'isa',linked:true}}},live,'US')});assert.equal(y.result.status,'unsupported');assert.equal(y.estimatedTaxKRW,null);
  const isa={...DEFAULT_COSTS,krTaxStatus:applicability({...DEFAULT_PROFILE,majorShareholder:true},live,'KR')};const kr=estimateCosts({market:'KR',side:'Sell',quantity:1,price:10000,costPerShare:9000,classification:classify('005930',{market:'KOSPI',type:'stock'}),settings:isa});
  assert.equal(kr.incomeTax.status,'unsupported');assert.equal(kr.gainAfterEstimatedTax,null);
  assert.throws(()=>validateProfile({residency:'maybe'}),/INVALID_TAX_PROFILE/);assert.throws(()=>validateProfile({accounts:{acct:{type:'ordinary'}}}),/INVALID_TAX_PROFILE/);assert.throws(()=>validateProfile({name:'x'}),/INVALID_TAX_PROFILE/,'no identifiers are collected');
});
test('the tax ledger takes live accounts of this taxpayer only; lots stay per account; mock and paper are excluded',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});
  costs.profile.save({accounts:{b:{type:'ordinary',linked:true},c:{type:'ordinary',linked:false}}});costs.saveRates([{date:'2026-03-03',value:1200},{date:'2026-10-16',value:1400}],'test');
  const put=(id,account,environment,side,price,day)=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(id,account+':US',JSON.stringify({id,accountKey:account+':US',environment,market:'US',side,symbol:'NASD:TEST',filled:10,fillPrice:price,day,createdAt:day==='2026-03-02'?1:2,resultCosts:{commission:0,transactionTax:0}}));
  for(const [account,env] of [['a','live'],['b','live'],['c','live'],['a','mock']]){put(account+env+'b',account,env,'Buy',100,'2026-03-02');put(account+env+'s',account,env,'Sell',100,'2026-10-15');}
  put('a-extra','a','live','Buy',200,'2026-03-02');
  const ledger=costs.ledger();assert.deepEqual(ledger.accounts.sort(),['a','b'],'unlinked account c and the mock trades are excluded');assert.equal(ledger.sales.length,2);
  // Each pool averages only its own lots: account a holds 20 shares at USD 150, b held 10 at USD 100.
  const gain=s=>ledger.sales.find(x=>x.account===s).gainKRW;assert.equal(gain('b'),10*100*1400-10*100*1200,'USD 1,000 bought at 1,200 and sold at 1,400: KRW 200,000 despite no USD gain');assert.equal(gain('a'),10*100*1400-10*150*1200);
  const year=annualTax(ledger,2026,0);assert.equal(year.knownTotalKRW,gain('a')+gain('b'),'one shared deduction for the taxpayer');db.close();
});
test('reviews get each symbol\'s classification, the rule version and the year status',()=>{
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT,isin TEXT,industry TEXT);INSERT INTO securities VALUES('069500','KODEX 200','','KOSPI','etf','',NULL)");
  const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});
  const kr=costs.context('KR',[{symbol:'069500',price:30000}],{'069500':{quantity:1,costTotal:25000}});assert.equal(kr.tax.ruleVersion,rules.RULE_VERSION);assert.deepEqual(kr.tax.classification['069500'],{instrument:'kr-etf',transactionTax:'exempt',incomeTax:'unknown'});
  assert.equal(kr.oneShare[0].sell.transactionTax,0);assert.equal(kr.oneShare[0].sell.incomeTax.status,'incomplete');assert.match(kr.taxModel,/unknown \(not zero\)/);assert.equal(kr.krSaleTaxPct,0.2);
  const us=costs.context('US',[{symbol:'NASD:AAPL',price:200}],{});assert.equal(us.tax.annual.status,'incomplete','outside gains not entered');assert.equal(us.oneShare[0].sell.capitalGainsTaxKRW,null);db.close();
});
// PR 2: the capital-gains ledger.
const RATES={'2026-03-03':1200,'2026-06-02':1300,'2026-10-16':1400,'2026-10-26':1400,'2027-01-04':1450};const rateOn=day=>RATES[day]?{rate:RATES[day],source:'test'}:null;
const f=(id,side,quantity,price,tradeDate,extra={})=>({id,symbol:'NASD:TEST',side,quantity,price,feesUSD:0,tradeDate,...extra});
test('opening 10 shares at 100,000 plus 10 at 200,000, sell 10: moving average 1.5m, FIFO 1m',()=>{
  const opening=[{id:'o',symbol:'NASD:TEST',quantity:10,acquiredOn:'2025-05-02',costKRW:1000000,expensesIncluded:true}];
  const fills=[f('b','Buy',10,2000000/10/1200,'2026-03-02'),f('s','Sell',10,150,'2026-10-15')];
  const avg=buildLedger({fills,rateOn,openingLots:opening}),fifo=buildLedger({fills,rateOn,openingLots:opening,method:'fifo'});
  assert.equal(avg.purchases[0].costKRW,2000000);assert.equal(avg.sales[0].costKRW,1500000);assert.equal(fifo.sales[0].costKRW,1000000,'the earlier opening lot goes first');assert.equal(fifo.sales[0].basisSource,'Records + opening lots');
  assert.equal(fifo.positions['NASD:TEST'].costKRW,2000000);assert.equal(avg.positions['NASD:TEST'].costKRW,1500000);
});
test('a quote for a FIFO sale crossing two lots uses the same basis as the executed ledger',()=>{
  const {quoteDisposal}=require('../electron/tax-ledger.cjs');const buys=[f('b1','Buy',3,100,'2026-03-02'),f('b2','Buy',5,200,'2026-06-01')];
  const before=buildLedger({fills:buys,rateOn,method:'fifo'});const q=quoteDisposal(before.positions['NASD:TEST'],5,'fifo');
  const after=buildLedger({fills:[...buys,f('s','Sell',5,250,'2026-10-15')],rateOn,method:'fifo'});
  assert.equal(Math.round(q.costKRW),after.sales[0].costKRW);assert.equal(after.sales[0].costKRW,3*100*1200+2*200*1300,'not one averaged basis');
  const settings={...DEFAULT_COSTS,usdKRW:1400,annualRealizedKRW:0,taxYear:new Date().getFullYear(),taxLots:{'NASD:TEST':{method:'fifo',lots:before.positions['NASD:TEST'].lots}}};
  const est=estimateCosts({market:'US',side:'Sell',quantity:5,price:250,symbol:'NASD:TEST',settings,classification:classify('NASD:TEST',{market:'NASD',type:'stock'})});
  assert.equal(est.taxableGainKRW,Math.round(est.netCash*1400-after.sales[0].costKRW));assert.equal(est.gainAfterFees,Math.round((est.netCash-(3*100+2*200))*100)/100,'economic gain from the recorded USD cost, no re-estimated commission');
  assert.ok(!est.incomeTax.assumptions.includes('acquisition commission estimated from the current fee plan'));
});
test('USD 1,000 bought at 1,200 and sold at 1,400 with no fees: KRW 200,000 gain',()=>{
  const l=buildLedger({fills:[f('b','Buy',10,100,'2026-03-02'),f('s','Sell',10,100,'2026-10-15')],rateOn});assert.equal(l.sales[0].gainKRW,200000);
});
test('a year-end trade settles in the next year by the U.S. calendar; the broker date replaces the estimate',()=>{
  const {estimatedSettlement}=require('../electron/tax-ledger.cjs');assert.equal(estimatedSettlement('2026-12-31'),'2027-01-04','New Year holiday, then the weekend');assert.equal(estimatedSettlement('2026-11-25'),'2026-11-27','Thanksgiving');
  assert.equal(estimatedSettlement('2026-10-23'),'2026-10-26','matches KIS for the Oct 23 buys');assert.equal(estimatedSettlement('2026-10-23',{krClosed:new Set(['2026-10-26'])}),'2026-10-27','a Korean holiday moves the KRW settlement');
  const sale=buildLedger({fills:[f('b','Buy',1,100,'2026-03-02'),f('s','Sell',1,100,'2026-12-31')],rateOn}).sales[0];assert.equal(sale.year,2027);assert.equal(sale.settlementEstimated,true);
  const confirmed=buildLedger({fills:[f('b','Buy',1,100,'2026-03-02'),f('s','Sell',1,100,'2026-12-31',{settlementDate:'2027-01-04'})],rateOn}).sales[0];assert.equal(confirmed.settlementEstimated,false);
});
function ledgerDb(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});costs.saveRates(Object.entries(RATES).map(([date,value])=>({date,value})),'test');return {db,costs};}
const row=(side,quantity,price,tradeDate,settlementDate,extra={})=>({ticker:'TEST',side,quantity,price,tradeDate,settlementDate,feesUSD:0,settlementKRW:null,exchangeRate:1324.6,...extra});
test('broker trade history is the record: re-imports and amended fees replace rows; app fills fill only the gaps',()=>{
  const {db,costs}=ledgerDb();const app=(id,side,qty,price,day)=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(id,'a:US',JSON.stringify({id,accountKey:'a:US',environment:'live',market:'US',side,symbol:'NASD:TEST',filled:qty,fillPrice:price,day,createdAt:1,resultCosts:{commission:0,transactionTax:0}}));
  app('app-buy','Buy',10,100,'2026-03-02');app('app-sell','Sell',4,150,'2026-10-23');
  assert.equal(costs.importTrades('a',[row('Buy',10,100,'2026-03-02','2026-03-03'),row('Buy',5,120,'2026-06-01','2026-06-02')]),2,'the app buy and a manual buy');
  assert.equal(costs.importTrades('a',[row('Buy',10,100,'2026-03-02','2026-03-03',{feesUSD:2.5}),row('Buy',5,120,'2026-06-01','2026-06-02')]),0,'re-import: nothing added');
  const fills=costs.fills();assert.deepEqual(fills.map(x=>[x.source,x.side,x.quantity]).sort(),[['App order','Sell',4],['KIS trade history','Buy',10],['KIS trade history','Buy',5]],'the app buy is not counted twice; the unsettled app sale stays until the broker lists it');
  assert.equal(fills.find(x=>x.quantity===10).feesUSD,2.5,'the amended fee replaced the row');assert.ok(fills.every(x=>x.symbol==='NASD:TEST'),'one pool per ticker');
  costs.importTrades('a',[row('Sell',4,150,'2026-10-23','2026-10-26')]);assert.equal(costs.fills().filter(x=>x.side==='Sell').map(x=>x.source).join(),'KIS trade history','once listed, the broker row replaces the app fill');
  db.close();
});
test('a share count that differs from the broker (split, transfer, missing record) makes that basis unknown, not doubled',()=>{
  const {db,costs}=ledgerDb();costs.importTrades('a',[row('Buy',10,100,'2026-03-02','2026-03-03')]);let held=[{symbol:'NASD:TEST',quantity:10}];costs.holdings=()=>held;
  const sell=()=>estimateCosts({market:'US',side:'Sell',quantity:10,price:60,symbol:'NASD:TEST',settings:{...costs.get(),usdKRW:1400,annualRealizedKRW:0,taxStatus:null},classification:classify('NASD:TEST',{market:'NASD',type:'stock'})});
  assert.notEqual(sell().taxableGainKRW,null,'counts agree');assert.deepEqual(costs.reconciliation(costs.ledger()),[]);
  held=[{symbol:'NASD:TEST',quantity:20}];assert.deepEqual(costs.reconciliation(costs.ledger()),[{symbol:'NASD:TEST',brokerQuantity:20,ledgerQuantity:10}]);
  const after=sell();assert.equal(after.taxableGainKRW,null);assert.match(after.incomeTax.missingInputs[0],/share count differs from the broker \(10 recorded, 20 held\)/);
  held=[{symbol:'NASD:TEST',quantity:10},{symbol:'NASD:OLD',quantity:3}];assert.match(costs.get().taxLots['NASD:OLD'].invalid,/3 shares held with no acquisition record or opening lot/);
  costs.addOpeningLot({symbol:'NASD:OLD',quantity:3,acquiredOn:'2025-02-03',costKRW:450000,expensesIncluded:false});assert.equal(costs.get().taxLots['NASD:OLD'].invalid,undefined,'an opening lot reconciles it');
  assert.throws(()=>costs.addOpeningLot({symbol:'NASD:OLD',quantity:3,acquiredOn:'2999-01-01',costKRW:1,expensesIncluded:true}),/INVALID_OPENING_LOT/);db.close();
});
// PR 3: Korean fund taxes and investment-income events.
const income=require('../electron/income-events.cjs');
test('taxable ETF: gain 100,000 and taxable-NAV increase 60,000 give 9,240 withholding; without the NAVs it is unknown',()=>{
  const r=income.etfSaleWithholding({gainKRW:100000,quantity:10,taxableNavBuy:10000,taxableNavSell:16000,day:'2026-10-26'});assert.equal(r.status,'estimated');assert.equal(r.value,9240);
  const lowerGain=income.etfSaleWithholding({gainKRW:30000,quantity:10,taxableNavBuy:10000,taxableNavSell:16000,day:'2026-10-26'});assert.equal(lowerGain.value,4620,'the lower of the two');
  const none=income.etfSaleWithholding({gainKRW:100000,quantity:10,day:'2026-10-26'});assert.equal(none.status,'incomplete');assert.equal(none.value,null);
});
test('a domestic-equity ETF and a taxable ETF both pay no sale tax, but their income tax differs',()=>{
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT,isin TEXT,industry TEXT);INSERT INTO securities VALUES('069500','KODEX 200','','KOSPI','etf','',NULL),('360750','TIGER S&P500','','KOSPI','etf','',NULL)");
  const costs=new TradingCosts(db);costs.setFundClass('069500','domestic-equity');costs.setFundClass('360750','taxable');assert.throws(()=>costs.setFundClass('360750','tax-free'),/INVALID_FUND_CLASS/);
  const sale=s=>estimateCosts({market:'KR',side:'Sell',quantity:10,price:20000,costPerShare:15000,classification:costs.classify(s),day:'2026-10-26'});
  assert.equal(sale('069500').transactionTax,0);assert.equal(sale('360750').transactionTax,0);
  assert.equal(sale('069500').capitalGainsTaxKRW,0);assert.equal(sale('069500').incomeTax.status,'estimated');assert.ok(sale('069500').incomeTax.assumptions.includes('domestic-equity ETF (classified by you)'));
  assert.equal(sale('360750').capitalGainsTaxKRW,null);assert.deepEqual(sale('360750').incomeTax.missingInputs,['taxable NAV (과표기준가격) at purchase and sale']);
  costs.setFundClass('360750',null);assert.equal(costs.classify('360750').incomeTax,'unknown');db.close();
});
test('a foreign dividend: gross and net reconcile, and the foreign tax is credited rather than adding 15.4%',()=>{
  const usd=income.validate({symbol:'NASD:AAPL',category:'dividend',payDate:'2026-11-13',currency:'USD',country:'US',gross:100,foreignWithholding:15,krNational:0,krLocal:0,net:85});assert.deepEqual(income.reconcile(usd),{status:'reconciled',difference:0});
  assert.deepEqual(income.reconcile({...usd,net:72.4}),{status:'differs',difference:12.6},'a difference is reported, not forced');
  assert.equal(income.expectedWithholding({gross:132460,foreignWithholding:19869,country:'US',day:'2026-11-13'}).total,0,'15% U.S. tax exceeds the 14% Korean rate');
  assert.equal(income.expectedWithholding({gross:100000,country:'KR',day:'2026-11-13'}).total,15400,'domestic 14% + 1.4%');
  assert.equal(income.expectedWithholding({gross:100000,foreignWithholding:10000,country:'JP',day:'2026-11-13'}).total,4400,'10% abroad: 4% national + 0.4% local here');
});
test('financial income is its own annual summary: incomplete until declared, flagged above 20m, never netted with gains',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});
  costs.addIncome({symbol:'005930',category:'dividend',payDate:'2026-04-17',currency:'KRW',country:'KR',gross:100000,foreignWithholding:0,krNational:14000,krLocal:1400,net:84600});
  let s=costs.incomeSummary(2026);assert.equal(s.grossKRW,100000);assert.equal(s.withheldKRW,15400);assert.equal(s.totalKRW,null);assert.equal(s.result.status,'incomplete');assert.deepEqual(s.result.missingInputs,['interest and dividends received outside these records']);
  assert.ok(s.result.assumptions[0].includes('high-dividend separate-tax regime is not applied'),'no preferential rate is assumed');
  costs.income.declare(2026,25000000);s=costs.incomeSummary(2026);assert.equal(s.totalKRW,25100000);assert.match(s.comprehensiveReview,/comprehensive taxation applies/);
  assert.equal(costs.taxSummary().year.knownTotalKRW,0,'dividends are not capital gains');
  costs.currentAccount=()=>({accountKey:'m',environment:'mock'});assert.throws(()=>costs.addIncome({symbol:'005930',category:'dividend',payDate:'2026-04-17',currency:'KRW',country:'KR',net:1}),/KIS_NOT_CONNECTED/,'mock accounts keep no income records');
  assert.throws(()=>income.validate({symbol:'005930',category:'gift',payDate:'2026-04-17',currency:'KRW',country:'KR',net:1}),/INVALID_INCOME_EVENT/);db.close();
});
// PR 4: decision estimates for reviews.
test('reviews get whole-holding quotes, and one scenario for selling every U.S. holding shares the deduction once',()=>{
  const {db,costs}=ledgerDb();costs.save({...DEFAULT_COSTS,annualRealizedKRW:0,usdKRW:1400});
  // Two holdings with KRW 2m gains each: separately each fits under the deduction; together KRW 1.5m is taxable.
  costs.importTrades('a',[{...row('Buy',10,100,'2026-03-02','2026-03-03'),ticker:'AAA'},{...row('Buy',10,100,'2026-03-02','2026-03-03'),ticker:'BBB'}]);
  costs.holdings=()=>[{symbol:'NASD:AAA',quantity:10},{symbol:'NASD:BBB',quantity:10}];
  const price=(2000000+1200000)/1400/10+0.03;// proceeds net of the 0.25% commission and levy, close to KRW 3.2m each
  const ctx=costs.context('US',[{symbol:'NASD:AAA',price},{symbol:'NASD:BBB',price}],{'NASD:AAA':{quantity:10,costTotal:1000},'NASD:BBB':{quantity:10,costTotal:1000}});
  assert.equal(ctx.heldSale.length,2);assert.equal(ctx.heldSale[0].quantity,10,'the whole holding, not one share');
  for(const q of ctx.heldSale){assert.ok(Math.abs(q.taxableGainKRW-2000000)<10000,`${q.symbol} gain ${q.taxableGainKRW}`);assert.equal(q.annualTaxChangeKRW,0,'alone, under the deduction');}
  const all=ctx.allUSHoldingsSale;assert.equal(all.status,'estimated');assert.equal(all.separateQuotesSumKRW,0);
  assert.equal(all.annualTaxChangeKRW,rules.overseasGainsTax(all.taxableGainKRW,new Date().getFullYear()).totalKRW,'together the deduction is used once');assert.ok(all.annualTaxChangeKRW>300000);db.close();
});
test('review instructions: use the app tax figures and their status; no flat 22%, no refund, no tax-free ETF assumption',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','ai-client.cjs'),'utf8');
  for(const re of [/never apply 22% to proceeds or to a gain yourself/,/never treat a loss as a guaranteed refund/,/never assume a Korean ETF is tax-free/,/it is not a reason to Hold and never a reason to drop a protective exit/,/one KRW 2\.5m deduction is shared by every sale this year/])assert.match(src,re);
});
test('without a saved indicative rate, a quote uses the current market rate and says so',()=>{
  const {db,costs}=ledgerDb();costs.save({...DEFAULT_COSTS,annualRealizedKRW:0});costs.importTrades('a',[row('Buy',1,100,'2026-03-02','2026-03-03')]);costs.holdings=()=>[{symbol:'NASD:TEST',quantity:1}];
  const sell=()=>estimateCosts({market:'US',side:'Sell',quantity:1,price:120,symbol:'NASD:TEST',settings:costs.get(),classification:classify('NASD:TEST',{market:'NASD',type:'stock'})});
  assert.deepEqual(sell().incomeTax.missingInputs,['USD/KRW exchange rate']);costs.marketRate=()=>1400;
  const q=sell();assert.equal(q.incomeTax.status,'estimated');assert.equal(q.taxableGainKRW,Math.round(q.netCash*1400-120000));assert.ok(q.incomeTax.assumptions.includes('exchange rate: the current market rate, not the settlement-date reference rate'));db.close();
});
test('a mock account has no tax reconciliation: its trades are never taxed',()=>{
  const {db,costs}=ledgerDb();costs.holdings=()=>[{symbol:'NASD:TEST',quantity:2}];assert.equal(costs.reconciliation(costs.ledger()).length,1);
  costs.currentAccount=()=>({accountKey:'m',environment:'mock'});assert.equal(costs.reconciliation(costs.ledger()),null);db.close();
});
// Code review of the tax model (2026-10-25), findings 1-7 and 10.
test('review fix: reference rates are requested for imported trades too, by the ledger calendar, never for future days',()=>{
  const {db,costs}=ledgerDb();db.exec('DELETE FROM fx_rates');const RealDate=Date;
  costs.importTrades('a',[row('Buy',1,100,'2025-03-04','2025-03-05'),row('Sell',1,110,'2026-02-03','2026-02-04'),row('Buy',1,100,'2099-01-02','2099-01-05')]);
  assert.deepEqual(costs.missingRateDays(),['2026-02-04','2025-03-05'],'broker rows carry a rate, but it is evidence only; 2099 is not published yet');
  costs.saveRates([{date:'2026-02-04',value:1450}],'test');assert.deepEqual(costs.missingRateDays(),['2025-03-05']);
  db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('h','a:US',JSON.stringify({id:'h',accountKey:'a:US',environment:'live',market:'US',side:'Buy',symbol:'NASD:HOL',filled:1,fillPrice:10,day:'2026-10-02',createdAt:1}));
  costs.krClosed=()=>new Set(['2026-10-05']);assert.ok(costs.missingRateDays().includes('2026-10-06'),'the settlement moved past a Korean holiday');assert.ok(!costs.missingRateDays().includes('2026-10-05'));db.close();
});
test('review fix: ISA, pension and corporate accounts stay out of the ordinary aggregate; a linked RIA makes it unsupported',()=>{
  const {db,costs}=ledgerDb();costs.importTrades('isa',[row('Buy',1,100,'2026-03-02','2026-03-03'),row('Sell',1,200,'2026-10-15','2026-10-16')]);costs.importTrades('a',[row('Buy',1,100,'2026-03-02','2026-03-03')]);
  costs.save({...DEFAULT_COSTS,annualRealizedKRW:0});costs.profile.save({accounts:{isa:{type:'isa',linked:true}}});
  let s=costs.taxSummary();assert.deepEqual(s.ledger.accounts,['a'],'the ISA sale is not ordinary overseas gain');assert.equal(s.year.result.status,'estimated');assert.ok(s.year.result.assumptions.some(x=>/ISA account isa excluded: taxed separately/.test(x)));
  costs.profile.save({accounts:{isa:{type:'ria',linked:true}}});s=costs.taxSummary();assert.equal(s.year.result.status,'unsupported');assert.equal(s.year.estimatedTaxKRW,null);assert.match(s.year.result.missingInputs.join(),/linked RIA account/);
  costs.profile.save({accounts:{isa:{type:'isa',linked:true}}});costs.currentAccount=()=>({accountKey:'isa',environment:'live'});assert.deepEqual(costs.ledger().accounts,[],'connected to the ISA itself: nothing ordinary to add');db.close();
});
test('review fix: a tax year without rules is unsupported, never a crash, and cannot be saved',()=>{
  const {db,costs}=ledgerDb();db.prepare('INSERT INTO trading_cost_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify({settings:{...DEFAULT_COSTS,taxYear:2022,annualRealizedKRW:0}}));
  assert.doesNotThrow(()=>costs.get());const y=costs.taxSummary().year;assert.equal(y.result.status,'unsupported');assert.match(y.result.missingInputs.join(),/tax rules for 2022 are not implemented/);
  assert.equal(marginalTax({year:2022,totalKRW:0},1000000),null);assert.throws(()=>costs.save({...DEFAULT_COSTS,taxYear:2022}),/INVALID_COST_SETTINGS/);db.close();
});
test('review fix: an entered per-share basis for shares beyond the records is kept, so the quote equals the booked sale',()=>{
  const {db,costs}=ledgerDb();costs.save({...DEFAULT_COSTS,annualRealizedKRW:0,usdKRW:1400,taxBasisKRW:{'NASD:TEST':100000}});
  costs.importTrades('a',[row('Buy',10,125,'2026-03-02','2026-03-03')]);costs.holdings=()=>[{symbol:'NASD:TEST',quantity:20}];
  const settings=costs.get();assert.equal(settings.taxBasisKRW['NASD:TEST'],100000,'not replaced by the ledger average of 150,000');
  const q=estimateCosts({market:'US',side:'Sell',quantity:20,price:200,symbol:'NASD:TEST',settings,classification:classify('NASD:TEST',{market:'NASD',type:'stock'})});
  const booked=buildLedger({fills:[f('b','Buy',10,125,'2026-03-02'),f('s','Sell',20,q.netCash/20,'2026-10-15')],rateOn:d=>({rate:d==='2026-10-16'?1400:1200,source:'t'}),userBasis:{'NASD:TEST':100000}}).sales[0];
  assert.equal(q.taxableGainKRW,booked.gainKRW);assert.equal(q.taxableGainKRW,Math.round(q.netCash*1400-1500000-1000000));db.close();
});
test('review fix: re-importing a window replaces rows KIS corrected instead of keeping both',()=>{
  const {db,costs}=ledgerDb();const w={start:'2026-10-01',end:'2026-10-31'};
  costs.importTrades('a',[row('Buy',5,100,'2026-10-20','2026-10-21')],0,w);costs.importTrades('a',[row('Buy',10,101,'2026-10-20','2026-10-21'),row('Buy',2,90,'2026-09-30','2026-10-01')],0,w);
  assert.deepEqual(costs.fills().map(x=>x.quantity).sort((a,b)=>a-b),[2,10],'the 5-share partial row is gone; a row outside the window is untouched');
  costs.importTrades('a',[],0,{start:'2026-09-30',end:'2026-09-30'});assert.deepEqual(costs.fills().map(x=>x.quantity),[10]);db.close();
});
test('review fix 2: trades replay in execution order; a same-day order that is not known makes the result unknown, not assumed',()=>{
  const r=()=>({rate:1000,source:'t'});
  // Reproduced: one share at 100,000, sold at 150,000, then another bought at 200,000 the same day.
  const timed=buildLedger({fills:[{...f('b0','Buy',1,100,'2026-10-01'),timestamp:1},{...f('s','Sell',1,150,'2026-10-20'),timestamp:2},{...f('b1','Buy',1,200,'2026-10-20'),timestamp:3}],rateOn:r});
  assert.equal(timed.sales[0].gainKRW,50000,'not averaged with the later purchase');assert.equal(timed.positions['NASD:TEST'].costKRW,200000);
  const untimed=buildLedger({fills:[{...f('b0','Buy',1,100,'2026-10-01'),timestamp:1},{...f('s','Sell',1,150,'2026-10-20'),timestamp:0},{...f('b1','Buy',1,200,'2026-10-20'),timestamp:0},{...f('s2','Sell',1,300,'2026-11-02'),timestamp:0}],rateOn:r});
  assert.equal(untimed.sales[0].gainKRW,null);assert.deepEqual(untimed.sales[0].missing,['order of same-day buys and sales on 2026-10-20']);
  assert.equal(untimed.sales[1].gainKRW,null,'a later sale from the same pool depends on that order too');assert.deepEqual(untimed.sales[1].missing,['order of same-day buys and sales on 2026-10-20']);
  const y=annualTax(untimed,2026,0);assert.equal(y.complete,false);assert.deepEqual(y.result.missingInputs,['order of same-day buys and sales on 2026-10-20']);
  const oneSide=buildLedger({fills:[{...f('b0','Buy',1,100,'2026-10-20'),timestamp:0},{...f('b1','Buy',1,200,'2026-10-20'),timestamp:0},{...f('s','Sell',2,150,'2026-10-21'),timestamp:0}],rateOn:r});assert.equal(oneSide.sales[0].gainKRW,0,'purchases alone on a day need no order');
});
test('review fix 1: broker rows and app fills match one to one by U.S. trade date, quantity and price; a mismatch is reported',()=>{
  const {db,costs}=ledgerDb();const app=(id,side,qty,price,at)=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(id,'a:US',JSON.stringify({id,accountKey:'a:US',environment:'live',market:'US',side,symbol:'NASD:TEST',filled:qty,fillPrice:price,day:new Date(Date.parse(at)+9*3600000).toISOString().slice(0,10),createdAt:Date.parse(at),resultCosts:{commission:0.25,transactionTax:0}}));
  // Reproduced: a manual broker buy on Oct 20 and a different app buy on Oct 21 (00:30 KST on Oct 22).
  app('app21','Buy',1,110,'2026-10-21T15:30:00Z');costs.importTrades('a',[row('Buy',1,100,'2026-10-20','2026-10-21')]);
  assert.deepEqual(costs.fills().map(x=>[x.source,x.tradeDate,x.price]).sort(),[['App order','2026-10-21',110],['KIS trade history','2026-10-20',100]],'both purchases kept');
  costs.importTrades('a',[row('Buy',1,110,'2026-10-21','2026-10-22')]);let m=costs.matchedFills();
  assert.deepEqual(m.fills.map(x=>[x.source,x.tradeDate,x.price]).sort(),[['KIS trade history','2026-10-20',100],['KIS trade history','2026-10-21',110]],'once listed, the broker row replaces the app fill');
  const matched=m.fills.find(x=>x.price===110);assert.equal(matched.timeKnown,true);assert.equal(matched.appOrderId,'app21');assert.deepEqual(m.issues,[]);
  // One order filled in two executions matches the rows that make it up.
  app('split','Sell',3,120,'2026-10-22T15:00:00Z');costs.importTrades('a',[row('Sell',1,119,'2026-10-22','2026-10-23'),row('Sell',2,120.5,'2026-10-22','2026-10-23')]);
  m=costs.matchedFills();assert.deepEqual(m.issues,[]);assert.equal(m.fills.filter(x=>x.side==='Sell').length,2);assert.ok(m.fills.filter(x=>x.side==='Sell').every(x=>x.appOrderId==='split'));
  // Rows that do not add up to the app's fill are not guessed at.
  app('odd','Buy',5,130,'2026-10-23T15:00:00Z');costs.importTrades('a',[row('Buy',4,130,'2026-10-23','2026-10-26')]);
  m=costs.matchedFills();assert.deepEqual(m.issues,['broker and app records of NASD:TEST buy on 2026-10-23 do not match']);assert.ok(!m.fills.some(x=>x.id==='odd'),'not counted twice');
  costs.save({...DEFAULT_COSTS,annualRealizedKRW:0});assert.ok(costs.taxSummary().year.result.missingInputs.includes('broker and app records of NASD:TEST buy on 2026-10-23 do not match'));db.close();
});
test('review fix 3: unknown fees make the result incomplete; zero fees are valid; estimated fees are named',()=>{
  const r=()=>({rate:1000,source:'t'});
  const unknown=buildLedger({fills:[f('b','Buy',1,100,'2026-03-02'),f('s','Sell',1,500,'2026-10-15',{feesUSD:null})],rateOn:r});
  assert.equal(unknown.sales[0].gainKRW,null);assert.deepEqual(unknown.sales[0].missing,['sale fees of 2026-10-15']);const y=annualTax(unknown,2026,0);assert.equal(y.complete,false);assert.equal(y.estimatedTaxKRW,null);assert.deepEqual(y.result.missingInputs,['sale fees of 2026-10-15']);
  const buyFees=buildLedger({fills:[f('b','Buy',1,100,'2026-03-02',{feesUSD:null}),f('s','Sell',1,500,'2026-10-15')],rateOn:r});assert.equal(buyFees.sales[0].gainKRW,null);assert.deepEqual(buyFees.sales[0].missing,['purchase fees of 2026-03-02']);
  const zero=buildLedger({fills:[f('b','Buy',1,100,'2026-03-02',{feesSource:'Broker'}),f('s','Sell',1,500,'2026-10-15',{feesSource:'Broker'})],rateOn:r});assert.equal(zero.sales[0].gainKRW,400000,'explicit zero fees');assert.ok(!annualTax(zero,2026,0).result.assumptions.some(a=>/fees estimated/.test(a)));
  const est=buildLedger({fills:[f('b','Buy',1,100,'2026-03-02',{feesUSD:0.25,feesSource:'Estimated'}),f('s','Sell',1,500,'2026-10-15',{feesUSD:1.25,feesSource:'Broker'})],rateOn:r});assert.ok(annualTax(est,2026,0).result.assumptions.includes('fees estimated from the fee plan where the broker has not reported them'),'an estimated purchase fee is named');
});
test('live check fix: KIS trade history is parsed in USD, zero placeholders are unknown, and a mismatched row is refused',async()=>{
  const {OverseasClient}=require('../electron/kis-overseas.cjs');
  // Shape and values of the 2026-10-25 read-only response for the Oct 23 Alphabet buy (account fields omitted).
  const googl={trad_dt:'20261023',sttl_dt:'20261026',sll_buy_dvsn_cd:'02',pdno:'GOOGL',ccld_qty:'1',ft_ccld_unpr2:'323.64000000',ovrs_stck_ccld_unpr:'428693.54400000',tr_frcr_amt2:'323.640000',tr_amt:'428693',frcr_excc_amt_1:'324.440000',wcrc_excc_amt:'429752',dmst_frcr_fee1:'0.80000',frcr_fee1:'',crcy_cd:'USD',erlm_exrt:'1324.60000000'};
  const early={...googl,pdno:'NVDA',ft_ccld_unpr2:'212.73000000',ovrs_stck_ccld_unpr:'0',tr_frcr_amt2:'212.730000',frcr_excc_amt_1:'212.730000',wcrc_excc_amt:'0',dmst_frcr_fee1:'0',erlm_exrt:'0'};
  const client=new OverseasClient({overseasIdentity:()=>({environment:'live'}),overseasRequest:async()=>({body:{output1:[googl,early]},continuation:''})});
  const [g,n]=await client.trades('2026-10-01','2026-10-25');
  assert.equal(g.price,323.64,'the USD unit price, not the KRW one');assert.equal(g.feesUSD,0.8);assert.equal(g.exchangeRate,1324.6);assert.equal(g.settlementKRW,429752);
  assert.equal(n.price,212.73);assert.equal(n.exchangeRate,null,'zero before KIS finalizes means unknown');assert.equal(n.settlementKRW,null);
  const {db,costs}=ledgerDb();assert.throws(()=>costs.importTrades('a',[{...row('Buy',1,428693.54,'2026-10-23','2026-10-26'),grossUSD:323.64}]),/INVALID_TRADE_HISTORY/,'a KRW price in a USD field is refused');
  costs.importTrades('a',[{...g},{...n}].map(r=>({...r,ticker:r.ticker})));costs.holdings=()=>[{symbol:'NASD:GOOGL',quantity:1},{symbol:'NASD:NVDA',quantity:1}];
  const lots=costs.get().taxLots;assert.ok(Math.abs(lots['NASD:GOOGL'].lots[0].costUSD-324.44)<1e-9);db.close();
});
test('live check fix: trade rows imported by the old parser are dropped at start and imported again',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE tax_events(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO tax_events VALUES(?,?,?)').run('old','a',JSON.stringify({id:'old',account:'a',symbol:'NASD:GOOGL',side:'Buy',quantity:1,price:428693.544,tradeDate:'2026-10-23'}));
  const costs=new TradingCosts(db);assert.equal(db.prepare('SELECT count(*) n FROM tax_events').get().n,0);
  costs.importTrades('a',[row('Buy',1,100,'2026-10-23','2026-10-26')]);new TradingCosts(db);assert.equal(db.prepare('SELECT count(*) n FROM tax_events').get().n,1,'current rows survive a restart');db.close();
});
test('reviews read compact tax figures, and an oversized first request is condensed instead of failing (2026-10-26 outage)',()=>{
  const {db,costs}=ledgerDb();costs.save({...DEFAULT_COSTS,annualRealizedKRW:0,usdKRW:1400});costs.importTrades('a',[{...row('Buy',2,100,'2026-03-02','2026-03-03'),ticker:'AAA'}]);costs.holdings=()=>[{symbol:'NASD:AAA',quantity:2}];
  const u=[{symbol:'NASD:AAA',price:120},{symbol:'NASD:BBB',price:50}],pos={'NASD:AAA':{quantity:2,costTotal:200}};
  const full=costs.fullContext('US',u,pos),c=costs.context('US',u,pos);const size=x=>Buffer.byteLength(JSON.stringify(x));
  assert.ok(size(c)<size(full)*0.75,`compact ${size(c)} vs full ${size(full)}`);assert.equal(c.settings.taxLots,undefined,'no internal lots');assert.equal(JSON.stringify(c).includes('sourceIds'),false);
  assert.deepEqual(c.oneShare[0].sell.incomeTax,{status:full.oneShare[0].sell.incomeTax.status,...(full.oneShare[0].sell.incomeTax.missingInputs.length?{missingInputs:full.oneShare[0].sell.incomeTax.missingInputs}:{})});
  assert.equal(c.oneShare[0].sell.capitalGainsTaxKRW,full.oneShare[0].sell.capitalGainsTaxKRW,'same figures');assert.ok(c.tax.assumptions.length>0,'assumptions listed once');db.close();
  const fit=require('../electron/context-fit.cjs');const wire=x=>Buffer.byteLength(JSON.stringify([{role:'user',content:JSON.stringify(x)}]));
  const ctx={positions:{'005930':{quantity:1}},quotes:[{symbol:'005930',price:1}],marketNarrative:{drivers:Array.from({length:400},(_,i)=>({name:'driver '+i,signals:['a long signal description '+i]}))},similarEpisodes:Array.from({length:200},(_,i)=>({id:i,text:'episode '+i}))};
  const r=fit.fitInitial(ctx,20000);assert.ok(wire(r.context)<=19000);assert.deepEqual(r.context.positions,ctx.positions,'decision data untouched');assert.deepEqual(r.context.quotes,ctx.quotes);assert.ok(r.steps.length>=1);
  assert.equal(fit.fitInitial({positions:{}},20000).steps.length,0,'a request that fits is unchanged');
});
