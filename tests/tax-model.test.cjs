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
  assert.equal(y.knownTotalKRW,5000000);assert.equal(y.knownRecordsTaxKRW,550000);assert.equal(y.result.knownSubtotal,550000);assert.deepEqual(y.result.missingInputs,['acquisition basis or exchange rate for 1 sale(s)']);
  assert.equal(marginalTax(y,1000000),null,'no marginal estimate from a partial year');
  assert.equal(annualTax({sales:[]},2026,null).result.missingInputs[0],'gains realized outside this app this year');
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
