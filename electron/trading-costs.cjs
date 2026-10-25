const {buildLedger,annualTax,marginalTax}=require('./tax-ledger.cjs');const rules=require('./tax-rules.cjs');const {classify}=require('./security-tax-classification.cjs');
// Commission plans and the user's tax inputs. Statutory sale taxes come from the dated rules in tax-rules.cjs (KOSPI
// 0.05% securities transaction tax + 0.15% rural special tax, KOSDAQ 0.20% in 2026); krSellTaxOverridePct replaces them
// only when the user sets it, and is reported as an override. U.S. sale levy: SEC Section 31 fee, USD 20.60 per million.
const DEFAULT_COSTS={krCommissionPct:0.015,krSellTaxOverridePct:null,usCommissionPct:0.25,usSellFeePct:0.00206,usSellFeeMinimum:0.01,usdKRW:null,annualRealizedKRW:null,taxYear:new Date().getFullYear(),taxBasisKRW:{},taxMethod:'moving-average'};
const round=(n,d=2)=>Math.round((n+Number.EPSILON)*10**d)/10**d;
const today=()=>require('./kis-activity.cjs').seoulDate();
function validateCosts(value){
  if(!value||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_COSTS,key)))throw new Error('INVALID_COST_SETTINGS');
  const next={...DEFAULT_COSTS,...value};
  for(const key of ['krCommissionPct','usCommissionPct','usSellFeePct','usSellFeeMinimum'])if(!Number.isFinite(next[key])||next[key]<0||next[key]>100)throw new Error('INVALID_COST_SETTINGS');
  if(next.krSellTaxOverridePct!==null&&(!Number.isFinite(next.krSellTaxOverridePct)||next.krSellTaxOverridePct<0||next.krSellTaxOverridePct>100))throw new Error('INVALID_COST_SETTINGS');
  for(const key of ['usdKRW','annualRealizedKRW'])if(next[key]!==null&&(!Number.isFinite(next[key])||Math.abs(next[key])>1e13||key==='usdKRW'&&next[key]<=0))throw new Error('INVALID_COST_SETTINGS');
  if(!Number.isInteger(next.taxYear)||next.taxYear<2020||next.taxYear>2100||!next.taxBasisKRW||typeof next.taxBasisKRW!=='object'||Array.isArray(next.taxBasisKRW)||Object.keys(next.taxBasisKRW).length>100)throw new Error('INVALID_COST_SETTINGS');
  for(const [key,value] of Object.entries(next.taxBasisKRW))if(!/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(key)||!Number.isFinite(value)||value<0||value>1e13)throw new Error('INVALID_COST_SETTINGS');
  if(!['moving-average','fifo'].includes(next.taxMethod))throw new Error('INVALID_COST_SETTINGS');
  return next;
}
// Settings saved before the sale tax became a dated rule kept one editable rate; the old default (0.20%) is the
// statutory rate and is dropped, any other value is kept as an explicit override.
function migrate(saved){const {krSellTaxPct,...rest}=saved;return krSellTaxPct==null||krSellTaxPct===0.2||'krSellTaxOverridePct' in rest?rest:{...rest,krSellTaxOverridePct:krSellTaxPct};}
// Without a classification (callers that only know the ETF/ETN exemption), a Korean symbol's market is unknown.
const fallbackClass=(us,exempt)=>us?classify('NASD:X',null):exempt?{instrument:'kr-etp',market:null,transactionTax:'exempt',incomeTax:'unknown'}:{instrument:'unknown',market:null,transactionTax:'unknown',incomeTax:'unknown'};
// The Korean sale taxes on a sale value: exempt, the user's override, or the statutory rule for the market on the day.
// An unknown market uses the higher of the KOSPI and KOSDAQ rates, labeled as an assumption.
function krSaleTaxes(gross,cls,settings,day){
  if(cls.transactionTax==='exempt')return {total:0,basis:'exempt',assumptions:[]};
  if(settings.krSellTaxOverridePct!=null)return {total:Math.floor(gross*settings.krSellTaxOverridePct/100),basis:'override',ratePct:settings.krSellTaxOverridePct,assumptions:['your saved sale-tax override']};
  if(cls.market){const t=rules.krSaleTax(cls.market,gross,day);if(t)return {...t,basis:'statutory',assumptions:[]};}
  const options=['KOSPI','KOSDAQ'].map(m=>rules.krSaleTax(m,gross,day)).filter(Boolean).sort((a,b)=>b.total-a.total);
  return options[0]?{...options[0],market:null,basis:'statutory',assumptions:['market not known: the higher of the KOSPI and KOSDAQ rates']}:{total:0,basis:'unknown',assumptions:['no sale-tax rule for this date']};
}
function estimateCosts({market='KR',side,quantity,price,costPerShare=null,symbol='',settings=DEFAULT_COSTS,exempt=false,classification=null,day=today()}){
  if(!['KR','US'].includes(market)||!['Buy','Sell'].includes(side)||!Number.isInteger(quantity)||quantity<1||!Number.isFinite(price)||price<=0)throw new Error('INVALID_ORDER');
  const us=market==='US',digits=us?2:0,gross=round(quantity*price,digits),commission=round(gross*(us?settings.usCommissionPct:settings.krCommissionPct)/100,digits);const cls=classification??fallbackClass(us,exempt);
  const saleTax=side==='Sell'&&!us?krSaleTaxes(gross,cls,settings,day):null;
  const transactionTax=side!=='Sell'?0:us?round(Math.max(settings.usSellFeeMinimum,gross*settings.usSellFeePct/100),2):saleTax.total;
  const netCash=round(side==='Sell'?gross-commission-transactionTax:-(gross+commission),digits);
  return withGain({basis:'estimate',currency:us?'USD':'KRW',gross,commission,transactionTax,...(saleTax?{saleTax}:{}),netCash},{us,side,quantity,costPerShare,symbol,settings,cls});
}
// Costs from broker-reported figures. KR: the broker's combined fee-and-tax amount for the order, with the statutory sale tax
// shown separately and the remainder as commission. U.S.: the broker's fees and settlement amount for the matched trades.
function brokerCosts({market,side,quantity,price,costPerShare=null,symbol='',settings=DEFAULT_COSTS,exempt=false,classification=null,day=today(),reported}){
  const us=market==='US',digits=us?2:0,gross=round(quantity*price,digits);const cls=classification??fallbackClass(us,exempt);
  if(us){
    const fees=round(reported.feesUSD??0,2),netCash=round(reported.settlementUSD!=null?(side==='Sell'?reported.settlementUSD:-reported.settlementUSD):side==='Sell'?gross-fees:-(gross+fees),2);
    return withGain({basis:'broker',currency:'USD',gross,commission:fees,transactionTax:0,netCash,settlementDate:reported.settlementDate??null,exchangeRate:reported.exchangeRate??null,settlementKRW:reported.settlementKRW??null},{us,side,quantity,costPerShare,symbol,settings,cls});
  }
  const charges=round(reported.charges,0),saleTax=side==='Sell'?krSaleTaxes(gross,cls,settings,day):null,tax=saleTax?Math.min(charges,saleTax.total):0;
  return withGain({basis:'broker',currency:'KRW',gross,commission:charges-tax,transactionTax:tax,...(saleTax?{saleTax}:{}),netCash:side==='Sell'?gross-charges:-(gross+charges)},{us,side,quantity,costPerShare,symbol,settings,cls});
}
// The economic gain after fees and the income tax on it, each with its certainty (incomeTax). A Korean listed share sold
// by a minority shareholder on the exchange owes no income tax; a Korean ETF's or ETN's income tax is unknown, never zero.
// U.S. shares: the change in the year's estimated overseas-gains tax, known only with the year's complete total, the
// KRW basis for the shares and an exchange rate.
function withGain(costs,{us,side,quantity,costPerShare,symbol,settings,cls}){
  const gain=side==='Sell'&&costPerShare!=null?round(costs.netCash-quantity*costPerShare*(1+(us?settings.usCommissionPct:settings.krCommissionPct)/100),us?2:0):null;
  if(side!=='Sell')return {...costs,gainAfterFees:null,taxableGainKRW:null,capitalGainsTaxKRW:null,gainAfterEstimatedTax:null};
  const assumptions=[...(costs.saleTax?.assumptions??[]),...(cls.assumption?[cls.assumption]:[])];const missing=[];let taxableGainKRW=null,capitalGainsTaxKRW=null,status;
  if(!us){
    const profile=settings.krTaxStatus;
    if(profile?.status==='unsupported'){status='unsupported';missing.push(...profile.reasons);}
    else if(cls.incomeTax==='minority-listed-exempt'){capitalGainsTaxKRW=0;status='estimated';assumptions.push('exchange sale by a minority shareholder: no income tax',...(profile?.assumptions??[]));}
    else{status='incomplete';missing.push(cls.instrument==='kr-etf'?'ETF income-tax classification and taxable NAV':cls.instrument==='kr-etn'?'ETN income-tax rules':'income-tax classification');}
  }else if(cls.incomeTax!=='overseas-capital-gains'){status='unsupported';missing.push('income-tax classification');}
  else{
    const rate=costs.exchangeRate??settings.usdKRW,basis=settings.taxBasisKRW?.[symbol];
    if(rate==null)missing.push('USD/KRW exchange rate');if(basis==null)missing.push('KRW acquisition basis');if(settings.annualRealizedKRW==null)missing.push(...(settings.taxStatus?.missingInputs?.length?settings.taxStatus.missingInputs:['gains realized this year']));
    if(settings.taxYear!==new Date().getFullYear())missing.push(`tax inputs for ${new Date().getFullYear()} (saved for ${settings.taxYear})`);
    if(rate!=null&&basis!=null)taxableGainKRW=round(costs.netCash*rate-quantity*basis,0);
    if(!missing.length){capitalGainsTaxKRW=marginalTax({year:settings.taxYear,totalKRW:settings.annualRealizedKRW},taxableGainKRW);assumptions.push(...(settings.taxStatus?.assumptions??[]));}
    status=missing.length?'incomplete':settings.taxStatus?.status==='unsupported'?'unsupported':'estimated';
  }
  const incomeTax=rules.taxResult({status,value:capitalGainsTaxKRW,missingInputs:missing,assumptions,taxYear:us?settings.taxYear:null,sourceIds:us?['nts-stock-tax','kis-tax-guide']:[]});
  if(incomeTax.value==null)capitalGainsTaxKRW=null;
  return {...costs,gainAfterFees:gain,taxableGainKRW,capitalGainsTaxKRW,gainAfterEstimatedTax:gain==null||capitalGainsTaxKRW==null?null:!us?gain:round(gain-capitalGainsTaxKRW/(costs.exchangeRate??settings.usdKRW),2),incomeTax};
}
class TradingCosts{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trading_cost_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS fx_rates(day TEXT PRIMARY KEY,rate REAL NOT NULL,source TEXT NOT NULL)');this.profile=new (require('./tax-profile.cjs').TaxProfile)(db);this.currentAccount=()=>null;}
  table(name){return Boolean(this.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(name));}
  saved(){const row=this.db.prepare('SELECT payload FROM trading_cost_settings WHERE id=1').get();const saved=row?JSON.parse(row.payload):{};return {...DEFAULT_COSTS,...migrate(saved.settings??saved)};}
  // Whether the ordinary rules apply to the connected account's market; without a connected account nothing is decided.
  applicability(market){const current=this.currentAccount();if(!current)return {status:'estimated',reasons:[],assumptions:['no live account connected']};return require('./tax-profile.cjs').applicability(this.profile.get(),current,market);}
  // annualRealizedKRW is entered as gains realized outside this app; app sales come from the ledger. The year's total is
  // passed on only when complete; otherwise estimates that need it are incomplete (taxStatus says what is missing).
  // Estimates use the ledger's KRW cost per share where the app holds purchase records.
  get(){
    const settings=this.saved();let ledger;try{ledger=this.ledger(settings);}catch{return settings;}const year=annualTax(ledger,settings.taxYear,settings.annualRealizedKRW,{applicability:this.applicability('US')});
    const basis={...settings.taxBasisKRW};for(const [symbol,p] of Object.entries(ledger.positions))if(p.perShareKRW!=null)basis[symbol]=p.perShareKRW;
    return {...settings,taxBasisKRW:basis,annualRealizedKRW:year.totalKRW,taxStatus:{status:year.result.status,missingInputs:year.result.missingInputs,assumptions:year.result.assumptions,ruleVersion:year.result.ruleVersion},krTaxStatus:this.applicability('KR')};
  }
  save(value){const next=validateCosts(value);this.db.prepare('INSERT INTO trading_cost_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify({settings:next}));return this.saved();}
  // How a symbol is taxed, from the security master (security-tax-classification.cjs).
  classify(symbol){const row=this.table('securities')?this.db.prepare('SELECT market,type FROM securities WHERE symbol=?').get(symbol)??null:null;return classify(symbol,row);}
  // Domestic ETFs and ETNs pay no securities transaction tax on sale.
  exempt(symbol){return /^\d{6}$/.test(symbol??'')&&this.classify(symbol).transactionTax==='exempt';}
  saveRates(rows,source){const insert=this.db.prepare('INSERT INTO fx_rates VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET rate=excluded.rate,source=excluded.source');for(const row of rows??[])if(/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(row.value)&&row.value>0)insert.run(row.date,row.value,source);}
  // Reference rate on the day, or the latest earlier one within a week (weekends and holidays).
  rateOn(day){const row=this.db.prepare('SELECT day,rate,source FROM fx_rates WHERE day<=? ORDER BY day DESC LIMIT 1').get(day);if(!row||Date.parse(day)-Date.parse(row.day)>7*86400000)return null;return {rate:row.rate,day:row.day,source:row.day===day?row.source:`${row.source} (${row.day})`};}
  orders(){return this.table('live_intents')?this.db.prepare('SELECT payload FROM live_intents').all().map(r=>JSON.parse(r.payload)):[];}
  // Taxable fills: live accounts of this taxpayer only (the connected live account and accounts linked to it); mock and
  // paper orders never enter the tax ledger.
  fills(){
    const {taxpayerAccounts,ownerAccount}=require('./tax-profile.cjs');const accounts=taxpayerAccounts(this.profile.get(),this.currentAccount());
    return this.orders().filter(o=>o.environment==='live'&&accounts.has(ownerAccount(o.accountKey))&&o.market==='US'&&o.filled>0&&o.fillPrice>0&&['Buy','Sell'].includes(o.side)&&/^\d{4}-\d{2}-\d{2}$/.test(o.day??'')&&/^(NASD|NYSE|AMEX):/.test(o.symbol??'')).map(o=>{const r=o.reportedCosts?.status==='reported'?o.reportedCosts:null;
      return {id:o.id,account:ownerAccount(o.accountKey),symbol:o.symbol,side:o.side,quantity:o.filled,price:o.fillPrice,feesUSD:r?r.feesUSD:o.resultCosts?(o.resultCosts.commission+o.resultCosts.transactionTax):null,tradeDate:o.day,timestamp:o.createdAt,settlementDate:r?.settlementDate??null,settlementKRW:r?.settlementKRW??null,exchangeRate:r?.exchangeRate??null,feesSource:r?'Broker':'Estimated'};});
  }
  // Cost pools are kept per account; realized gains are combined for the taxpayer afterwards. Positions are the connected
  // account's (entered basis applies to it only).
  ledger(settings=this.saved()){
    const fills=this.fills(),current=require('./tax-profile.cjs').ownerAccount(this.currentAccount()?.accountKey);const accounts=[...new Set(fills.map(f=>f.account))];
    const pools=Object.fromEntries(accounts.map(a=>[a,buildLedger({fills:fills.filter(f=>f.account===a),rateOn:day=>this.rateOn(day),userBasis:a===current?settings.taxBasisKRW:{},method:settings.taxMethod})]));
    const own=pools[current]??buildLedger({fills:[],rateOn:()=>null,method:settings.taxMethod});
    return {method:settings.taxMethod,sales:accounts.flatMap(a=>pools[a].sales.map(s=>({...s,account:a}))).sort((x,y)=>x.settlementDate.localeCompare(y.settlementDate)),purchases:accounts.flatMap(a=>pools[a].purchases.map(p=>({...p,account:a}))),positions:own.positions,accounts};
  }
  // Settlement days whose reference rate is still missing, for the provider worker to fetch.
  missingRateDays(){const {estimatedSettlement}=require('./tax-ledger.cjs');return [...new Set(this.fills().filter(f=>f.settlementKRW==null&&!f.exchangeRate).map(f=>f.settlementDate??estimatedSettlement(f.tradeDate)))].filter(day=>!this.db.prepare('SELECT day FROM fx_rates WHERE day=?').get(day)).slice(0,20);}
  taxSummary(){
    const settings=this.saved(),ledger=this.ledger(settings);
    const orders=this.orders().filter(o=>o.filled>0&&o.resultCosts).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)).slice(0,30).map(o=>({id:o.id,market:o.market,symbol:o.symbol,side:o.side,quantity:o.filled,day:o.day,currency:o.resultCosts.currency??(o.market==='US'?'USD':'KRW'),basis:o.resultCosts.basis,commission:o.resultCosts.commission,transactionTax:o.resultCosts.transactionTax,netCash:o.resultCosts.netCash,estimate:o.costEstimate?{commission:o.costEstimate.commission,transactionTax:o.costEstimate.transactionTax}:null,reportStatus:o.reportedCosts?.status??'pending'}));
    return {settings,year:annualTax(ledger,settings.taxYear,settings.annualRealizedKRW,{applicability:this.applicability('US')}),ledger,orders,profile:this.profile.get(),applicability:{KR:this.applicability('KR'),US:this.applicability('US')},ruleVersion:rules.RULE_VERSION};
  }
  // The statutory sale-tax rate of a Korean sale today: the override, or the higher of the KOSPI and KOSDAQ rates.
  krSaleTaxPct(settings=this.saved()){return settings.krSellTaxOverridePct??Math.max(...['KOSPI','KOSDAQ'].map(m=>rules.krSaleTax(m,1e6,today())?.ratePct??0));}
  context(market,universe,positions){
    const settings=this.get();const relevant={...settings,taxBasisKRW:Object.fromEntries(Object.entries(settings.taxBasisKRW).filter(([symbol])=>universe.some(row=>row.symbol===symbol)))};const applicable=this.applicability(market);
    return {market,settings:relevant,krSaleTaxPct:this.krSaleTaxPct(settings),acquisitionFeeAssumption:'Broker average acquisition prices treated as excluding acquisition commissions; these are estimated using the saved commission plan. Executed orders use broker-reported fees where available.',
      tax:{ruleVersion:rules.RULE_VERSION,applicability:applicable,annual:market==='US'?settings.taxStatus??null:null,classification:Object.fromEntries(universe.map(row=>{const c=this.classify(row.symbol);return [row.symbol,{instrument:c.instrument,transactionTax:c.transactionTax,incomeTax:c.incomeTax}];}))},
      taxModel:`Korean taxes are calculated by the app (rules ${rules.RULE_VERSION}); use its figures and their status, never apply a flat rate yourself. Each sell estimate has incomeTax {status, value, missingInputs, assumptions}: estimated means complete inputs with the stated assumptions; incomplete means a required input is missing and the tax is unknown (not zero); unsupported means the account or instrument is outside the implemented rules. Korean exchange-listed shares: sale taxes by market (KOSPI 0.05% + 0.15% rural special tax, KOSDAQ 0.20% in 2026), no income tax for a minority shareholder. Korean-listed ETFs and ETNs: no sale tax, but income tax on gains depends on the fund and is unknown here. U.S. shares: the change in the year's overseas-gains tax (20% + 2% local above the shared KRW 2,500,000 deduction), known only when the year's realized total is complete. Annual tax is payable in May of the next year, not deducted from proceeds; a loss can reduce the year's tax but is not a refund and does not carry forward.`,
      oneShare:universe.map(row=>{const classification=this.classify(row.symbol);return {symbol:row.symbol,buy:estimateCosts({market,side:'Buy',quantity:1,price:row.price,symbol:row.symbol,settings,classification}),sell:estimateCosts({market,side:'Sell',quantity:1,price:row.price,costPerShare:positions[row.symbol]?.quantity?positions[row.symbol].costTotal/positions[row.symbol].quantity:null,symbol:row.symbol,settings,classification})};})};
  }
}
module.exports={TradingCosts,DEFAULT_COSTS,validateCosts,estimateCosts,brokerCosts,migrate};
