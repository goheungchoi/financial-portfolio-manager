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
  if(!Number.isInteger(next.taxYear)||next.taxYear<2023||next.taxYear>2100||!next.taxBasisKRW||typeof next.taxBasisKRW!=='object'||Array.isArray(next.taxBasisKRW)||Object.keys(next.taxBasisKRW).length>100)throw new Error('INVALID_COST_SETTINGS');
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
  if(side!=='Sell')return {...costs,gainAfterFees:null,taxableGainKRW:null,capitalGainsTaxKRW:null,gainAfterEstimatedTax:null};
  const assumptions=[...(costs.saleTax?.assumptions??[]),...(cls.assumption?[cls.assumption]:[])];const missing=[];let taxableGainKRW=null,capitalGainsTaxKRW=null,status,rate=null;
  // U.S. shares with recorded lots: the basis of exactly these shares by the ledger's own disposal rule (tax-lots.cjs);
  // the economic gain uses their recorded USD cost including fees rather than re-estimating the commission.
  const held=us?settings.taxLots?.[symbol]:null;const quote=held?require('./tax-lots.cjs').dispose(held.lots,quantity,held.method):null;
  let gain=null;if(quote&&!quote.outside&&quote.knownUSD&&!held.invalid)gain=round(costs.netCash-quote.costUSD,2);
  else if(costPerShare!=null){gain=round(costs.netCash-quantity*costPerShare*(1+(us?settings.usCommissionPct:settings.krCommissionPct)/100),us?2:0);assumptions.push('acquisition commission estimated from the current fee plan');}
  if(!us){
    const profile=settings.krTaxStatus;
    if(profile?.status==='unsupported'){status='unsupported';missing.push(...profile.reasons);}
    else if(cls.incomeTax==='minority-listed-exempt'){capitalGainsTaxKRW=0;status='estimated';assumptions.push('exchange sale by a minority shareholder: no income tax',...(profile?.assumptions??[]));}
    else if(cls.incomeTax==='domestic-equity-fund-exempt'){capitalGainsTaxKRW=0;status='estimated';assumptions.push('domestic-equity ETF: no tax on sale gains');}
    else if(cls.incomeTax==='taxable-fund-dividend'){status='incomplete';missing.push('taxable NAV (과표기준가격) at purchase and sale');}
    else{status='incomplete';missing.push(cls.instrument==='kr-etf'?'ETF income-tax classification and taxable NAV':cls.instrument==='kr-etn'?'ETN income-tax rules':'income-tax classification');}
  }else if(cls.incomeTax!=='overseas-capital-gains'){status='unsupported';missing.push('income-tax classification');}
  else{
    rate=costs.exchangeRate??settings.usdKRW??settings.marketUsdKRW??null;const perShare=settings.taxBasisKRW?.[symbol];
    // KRW basis: the lots' cost for the shares they hold, the entered per-share basis for any beyond them.
    const basis=held?.invalid?null:quote?(quote.known&&(!quote.outside||perShare!=null)?quote.costKRW+quote.outside*(perShare??0):null):perShare!=null?quantity*perShare:null;
    if(held?.invalid)missing.push(held.invalid);
    else if(basis==null)missing.push(quote&&!quote.known?'KRW acquisition basis of recorded lots':'KRW acquisition basis');
    if(rate==null)missing.push('USD/KRW exchange rate');else if(!costs.exchangeRate)assumptions.push(settings.usdKRW!=null?'exchange rate: your indicative rate, not the settlement-date reference rate':'exchange rate: the current market rate, not the settlement-date reference rate');if(settings.annualRealizedKRW==null)missing.push(...(settings.taxStatus?.missingInputs?.length?settings.taxStatus.missingInputs:['gains realized this year']));
    if(settings.taxYear!==new Date().getFullYear())missing.push(`tax inputs for ${new Date().getFullYear()} (saved for ${settings.taxYear})`);
    if(rate!=null&&basis!=null)taxableGainKRW=round(costs.netCash*rate-basis,0);
    if(!missing.length){capitalGainsTaxKRW=marginalTax({year:settings.taxYear,totalKRW:settings.annualRealizedKRW},taxableGainKRW);assumptions.push(...(settings.taxStatus?.assumptions??[]));}
    status=missing.length?'incomplete':settings.taxStatus?.status==='unsupported'?'unsupported':'estimated';
  }
  const incomeTax=rules.taxResult({status,value:capitalGainsTaxKRW,missingInputs:missing,assumptions,taxYear:us?settings.taxYear:null,sourceIds:us?['nts-stock-tax','kis-tax-guide']:[]});
  if(incomeTax.value==null)capitalGainsTaxKRW=null;
  return {...costs,gainAfterFees:gain,taxableGainKRW,capitalGainsTaxKRW,gainAfterEstimatedTax:gain==null||capitalGainsTaxKRW==null?null:!us?gain:round(gain-capitalGainsTaxKRW/rate,2),incomeTax};
}
class TradingCosts{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trading_cost_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS fx_rates(day TEXT PRIMARY KEY,rate REAL NOT NULL,source TEXT NOT NULL);CREATE TABLE IF NOT EXISTS tax_events(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS tax_opening_lots(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS fund_tax_class(symbol TEXT PRIMARY KEY,payload TEXT NOT NULL)');this.income=new (require('./income-events.cjs').IncomeEvents)(db);
    // Rows imported by 1.5.35 took the KRW unit price as USD; they are dropped and imported again (parser 2).
    db.prepare("DELETE FROM tax_events WHERE json_extract(payload,'$.parser') IS NOT 2").run();this.profile=new (require('./tax-profile.cjs').TaxProfile)(db);
    // Injected by the app: the connected account, Korean non-trading days and the broker's U.S. holdings.
    this.currentAccount=()=>null;this.krClosed=()=>new Set();this.holdings=()=>null;this.marketRate=()=>null;}
  table(name){return Boolean(this.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(name));}
  saved(){const row=this.db.prepare('SELECT payload FROM trading_cost_settings WHERE id=1').get();const saved=row?JSON.parse(row.payload):{};return {...DEFAULT_COSTS,...migrate(saved.settings??saved)};}
  // Whether the ordinary rules apply to the connected account's market; without a connected account nothing is decided.
  applicability(market){const current=this.currentAccount();if(!current)return {status:'estimated',reasons:[],assumptions:['no live account connected']};return require('./tax-profile.cjs').applicability(this.profile.get(),current,market);}
  // annualRealizedKRW is entered as gains realized at other brokers; KIS sales come from the ledger. The year's total is
  // passed on only when complete; otherwise estimates that need it are incomplete (taxStatus says what is missing).
  // Estimates use the ledger's KRW cost per share where the app holds purchase records.
  get(){
    const settings=this.saved();let ledger;try{ledger=this.ledger(settings);}catch{return settings;}const year=annualTax(ledger,settings.taxYear,settings.annualRealizedKRW,{applicability:this.applicability('US'),issues:ledger.issues??[]});
    // The entered per-share basis (shares beyond the records) is kept as entered; the ledger average fills only the rest.
    const basis={...settings.taxBasisKRW};for(const [symbol,p] of Object.entries(ledger.positions))if(p.perShareKRW!=null&&settings.taxBasisKRW[symbol]==null)basis[symbol]=p.perShareKRW;
    // The connected account's lots, so a quote for any quantity uses the ledger's own disposal rule; a symbol whose share
    // count differs from the broker's is marked, and its basis is not used.
    // Shares held beyond the records are covered by an entered per-share basis; more recorded than held never is.
    const differs=new Map((this.reconciliation(ledger)??[]).filter(d=>d.ledgerQuantity>d.brokerQuantity||settings.taxBasisKRW[d.symbol]==null).map(d=>[d.symbol.split(':').pop(),d]));const taxLots=Object.fromEntries(Object.entries(ledger.positions).map(([symbol,p])=>{const d=differs.get(symbol.split(':').pop());
      return [symbol,{method:settings.taxMethod,lots:p.lots,...(d?{invalid:`share count differs from the broker (${d.ledgerQuantity} recorded, ${d.brokerQuantity} held): a missing record, opening lot or corporate action`}:{})}];}));
    for(const [t,d] of differs)if(d.brokerQuantity>0&&!Object.keys(taxLots).some(s=>s.split(':').pop()===t)){taxLots[d.symbol]={method:settings.taxMethod,lots:[],invalid:`${d.brokerQuantity} shares held with no acquisition record or opening lot`};}
    return {...settings,taxBasisKRW:basis,taxLots,annualRealizedKRW:year.totalKRW,taxStatus:{status:year.result.status,missingInputs:year.result.missingInputs,assumptions:year.result.assumptions,ruleVersion:year.result.ruleVersion},krTaxStatus:this.applicability('KR'),marketUsdKRW:Number(this.marketRate())>0?Number(this.marketRate()):null};
  }
  save(value){const next=validateCosts(value);this.db.prepare('INSERT INTO trading_cost_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify({settings:next}));return this.saved();}
  // How a symbol is taxed, from the security master (security-tax-classification.cjs).
  classify(symbol){const row=this.table('securities')?this.db.prepare('SELECT market,type FROM securities WHERE symbol=?').get(symbol)??null:null;return classify(symbol,row,this.fundClass(symbol));}
  // A Korean ETF's income-tax class as the user set it from the issuer's documents; the security master cannot tell.
  fundClass(symbol){const r=this.db.prepare('SELECT payload FROM fund_tax_class WHERE symbol=?').get(String(symbol));return r?JSON.parse(r.payload):null;}
  setFundClass(symbol,value){if(!/^[0-9][0-9A-Z]{5}$/.test(symbol??''))throw new Error('INVALID_FUND_CLASS');if(value==null){this.db.prepare('DELETE FROM fund_tax_class WHERE symbol=?').run(symbol);return null;}
    if(!['domestic-equity','taxable'].includes(value))throw new Error('INVALID_FUND_CLASS');const row={class:value,source:'entered by you',setAt:new Date().toISOString()};this.db.prepare('INSERT INTO fund_tax_class VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload').run(symbol,JSON.stringify(row));return row;}
  fundClasses(){return Object.fromEntries(this.db.prepare('SELECT symbol,payload FROM fund_tax_class').all().map(r=>[r.symbol,JSON.parse(r.payload)]));}
  // Dividends, distributions and interest of this taxpayer's live accounts (income-events.cjs).
  incomeSummary(year=this.saved().taxYear){const {taxpayerAccounts}=require('./tax-profile.cjs');const accounts=taxpayerAccounts(this.profile.get(),this.currentAccount());return {...this.income.summary(year,accounts,day=>this.rateOn(day)),events:this.income.list(accounts).filter(e=>e.payDate.startsWith(String(year)))};}
  addIncome(value){const {ownerAccount}=require('./tax-profile.cjs');const c=this.currentAccount();if(c?.environment!=='live')throw new Error('KIS_NOT_CONNECTED');return this.income.add(ownerAccount(c.accountKey),value);}
  // Domestic ETFs and ETNs pay no securities transaction tax on sale.
  exempt(symbol){return /^\d{6}$/.test(symbol??'')&&this.classify(symbol).transactionTax==='exempt';}
  saveRates(rows,source){const insert=this.db.prepare('INSERT INTO fx_rates VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET rate=excluded.rate,source=excluded.source');for(const row of rows??[])if(/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(row.value)&&row.value>0)insert.run(row.date,row.value,source);}
  // Reference rate on the day. Only on a day without publication (a weekend or Korean holiday) does the latest earlier
  // rate within a week stand in; a missing rate on a normal publication day is missing, not substituted.
  rateOn(day){const exact=this.db.prepare('SELECT day,rate,source FROM fx_rates WHERE day=?').get(day);if(exact)return {rate:exact.rate,day,source:exact.source};
    const closed=[0,6].includes(new Date(day+'T00:00:00Z').getUTCDay())||this.krClosed().has(day);if(!closed)return null;
    const row=this.db.prepare('SELECT day,rate,source FROM fx_rates WHERE day<? ORDER BY day DESC LIMIT 1').get(day);if(!row||Date.parse(day)-Date.parse(row.day)>7*86400000)return null;return {rate:row.rate,day:row.day,source:`${row.source} (${row.day}, no publication on ${day})`};}
  orders(){return this.table('live_intents')?this.db.prepare('SELECT payload FROM live_intents').all().map(r=>JSON.parse(r.payload)):[];}
  // Taxable fills: live accounts of this taxpayer only (the connected live account and accounts linked to it); mock and
  // paper orders never enter the tax ledger.
  // The broker's trade history is the record (manual trades included). Each of the app's fills is matched to it one to
  // one: the same account, ticker, side, U.S. trade date, quantity and price (or the rows of one order filled in
  // several executions); a matched row takes the app's order time. An app fill with no broker row that day is kept (the
  // history has not listed it yet). An app fill whose day has broker rows that do not match is ambiguous: the broker
  // rows are used, and the mismatch is reported as a missing input instead of guessing.
  fills(){return this.matchedFills().fills;}
  matchedFills(){
    const {taxpayerAccounts,ownerAccount}=require('./tax-profile.cjs');const accounts=taxpayerAccounts(this.profile.get(),this.currentAccount());
    const nyDate=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
    // The order time gives the U.S. trade date; an order day far from it (old or test records) is used as it is.
    const tradeDate=o=>{if(Number.isFinite(o.createdAt)&&o.createdAt>0){const d=nyDate(o.createdAt);if(Math.abs(Date.parse(d)-Date.parse(o.day))<=2*86400000)return d;}return o.day;};
    const app=this.orders().filter(o=>o.environment==='live'&&accounts.has(ownerAccount(o.accountKey))&&o.market==='US'&&o.filled>0&&o.fillPrice>0&&['Buy','Sell'].includes(o.side)&&/^\d{4}-\d{2}-\d{2}$/.test(o.day??'')&&/^(NASD|NYSE|AMEX):/.test(o.symbol??'')).map(o=>{const r=o.reportedCosts?.status==='reported'?o.reportedCosts:null;
      return {id:o.id,account:ownerAccount(o.accountKey),symbol:o.symbol,side:o.side,quantity:o.filled,price:o.fillPrice,feesUSD:r?r.feesUSD:o.resultCosts?(o.resultCosts.commission+o.resultCosts.transactionTax):null,tradeDate:tradeDate(o),timestamp:o.createdAt,timeKnown:Number.isFinite(o.createdAt)&&o.createdAt>0,settlementDate:r?.settlementDate??null,settlementKRW:r?.settlementKRW??null,exchangeRate:r?.exchangeRate??null,feesSource:r?'Broker':'Estimated',source:'App order'};});
    const broker=this.db.prepare('SELECT payload FROM tax_events').all().map(r=>({...JSON.parse(r.payload),timeKnown:false})).filter(e=>accounts.has(e.account));
    const ticker=s=>String(s).split(':').pop();const sameDay=(x,f)=>x.account===f.account&&ticker(x.symbol)===ticker(f.symbol)&&x.side===f.side&&x.tradeDate===f.tradeDate;
    const used=new Map(),appOnly=[],issues=[];
    for(const f of [...app].sort((a,b)=>(a.timestamp??0)-(b.timestamp??0))){
      const open=broker.filter(b=>!used.has(b.id)&&sameDay(b,f));
      const exact=open.find(b=>b.quantity===f.quantity&&Math.abs(b.price-f.price)<=0.005);
      const parts=exact?[exact]:open.length>1&&open.reduce((n,b)=>n+b.quantity,0)===f.quantity&&Math.abs(open.reduce((n,b)=>n+b.quantity*b.price,0)/f.quantity-f.price)<=0.005?open:null;
      if(parts){for(const b of parts)used.set(b.id,f);continue;}
      if(open.length){issues.push(`broker and app records of ${f.symbol} ${f.side.toLowerCase()} on ${f.tradeDate} do not match`);continue;}
      appOnly.push(f);
    }
    const symbolOf=new Map([...app,...broker,...(this.holdings()??[])].filter(x=>/^(NASD|NYSE|AMEX):/.test(x.symbol)).map(x=>[ticker(x.symbol),x.symbol]));
    const fills=[...broker.map(b=>used.has(b.id)?{...b,timestamp:used.get(b.id).timestamp,timeKnown:used.get(b.id).timeKnown,appOrderId:used.get(b.id).id}:b),...appOnly].map(x=>({...x,symbol:symbolOf.get(ticker(x.symbol))??x.symbol}));
    return {fills,issues:[...new Set(issues)]};
  }
  // Imports the broker's U.S. trade history rows (kis-overseas.cjs trades()) for an account. A row's identity is its
  // trade and settlement dates, ticker, side, quantity, price and occurrence: re-imports and corrected fees replace the
  // stored row instead of adding a second trade.
  // window {start,end}: the trade dates the rows cover; stored rows of those dates that KIS no longer returns (a corrected
  // quantity, price or settlement date) are replaced, not kept beside the new ones.
  importTrades(account,rows,now=Date.now(),window=null){
    const {ownerAccount}=require('./tax-profile.cjs');const owner=ownerAccount(account);const seen=new Map();let added=0;const kept=new Set();
    const known=ticker=>{const o=this.orders().find(x=>/^(NASD|NYSE|AMEX):/.test(x.symbol??'')&&x.symbol.split(':').pop()===ticker);if(o)return o.symbol;const h=(this.holdings()??[]).find(x=>String(x.symbol).split(':').pop()===ticker);if(h)return h.symbol;
      const m=this.table('securities')?this.db.prepare('SELECT symbol FROM securities WHERE symbol IN (?,?,?)').get('NASD:'+ticker,'NYSE:'+ticker,'AMEX:'+ticker):null;return m?.symbol??'US:'+ticker;};
    const put=this.db.prepare('INSERT INTO tax_events VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    for(const r of rows??[]){if(!r?.tradeDate||!(r.quantity>0)||!(r.price>0)||!/^[A-Z][A-Z0-9./-]{0,14}$/.test(r.ticker??'')||!['Buy','Sell'].includes(r.side))continue;
      if(r.grossUSD>0&&Math.abs(r.price*r.quantity/r.grossUSD-1)>0.01)throw new Error('INVALID_TRADE_HISTORY');
      const key=[owner,r.tradeDate,r.settlementDate,r.ticker,r.side,r.quantity,r.price].join('|');const n=(seen.get(key)??0)+1;seen.set(key,n);const id=require('node:crypto').createHash('sha256').update(key+'|'+n).digest('hex').slice(0,24);
      kept.add(id);if(!this.db.prepare('SELECT id FROM tax_events WHERE id=?').get(id))added++;
      put.run(id,owner,JSON.stringify({id,parser:2,account:owner,source:'KIS trade history',symbol:known(r.ticker),side:r.side,quantity:r.quantity,price:r.price,feesUSD:r.feesUSD??null,tradeDate:r.tradeDate,timestamp:0,settlementDate:r.settlementDate,settlementKRW:r.settlementKRW??null,exchangeRate:r.exchangeRate??null,feesSource:'Broker',importedAt:now}));}
    if(window)for(const r of this.db.prepare('SELECT id,payload FROM tax_events WHERE account=?').all(owner)){const d=JSON.parse(r.payload).tradeDate;if(d>=window.start&&d<=window.end&&!kept.has(r.id))this.db.prepare('DELETE FROM tax_events WHERE id=?').run(r.id);}
    return added;
  }
  // Shares acquired before the records, entered by the user: quantity, acquisition date and KRW cost.
  openingLots(account=null){return this.db.prepare('SELECT payload FROM tax_opening_lots').all().map(r=>JSON.parse(r.payload)).filter(l=>account==null||l.account===account);}
  addOpeningLot(value){
    const {ownerAccount}=require('./tax-profile.cjs');const account=ownerAccount(this.currentAccount()?.accountKey);if(!account)throw new Error('KIS_NOT_CONNECTED');const v=value??{};
    if(!/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(v.symbol??'')||!Number.isInteger(v.quantity)||v.quantity<1||v.quantity>1e7||!/^\d{4}-\d{2}-\d{2}$/.test(v.acquiredOn??'')||v.acquiredOn>today()||!Number.isFinite(v.costKRW)||v.costKRW<0||v.costKRW>1e13||typeof v.expensesIncluded!=='boolean')throw new Error('INVALID_OPENING_LOT');
    const lot={id:require('node:crypto').randomUUID(),account,symbol:v.symbol,quantity:v.quantity,acquiredOn:v.acquiredOn,costKRW:Math.round(v.costKRW),expensesIncluded:v.expensesIncluded,source:'Entered by you'};
    this.db.prepare('INSERT INTO tax_opening_lots VALUES(?,?,?)').run(lot.id,account,JSON.stringify(lot));return lot;
  }
  removeOpeningLot(id){this.db.prepare('DELETE FROM tax_opening_lots WHERE id=?').run(String(id));}
  // Shares the broker holds against shares the ledger holds, per symbol of the connected account. A difference means a
  // missing record or opening lot, or a corporate action (split, merger) not reconciled: that symbol's basis is unknown.
  reconciliation(ledger){
    const held=this.holdings();if(!held||this.currentAccount()?.environment!=='live')return null;const ticker=s=>String(s).split(':').pop();const out=[];
    for(const h of held){const own=Object.entries(ledger.positions).find(([s])=>ticker(s)===ticker(h.symbol));const q=own?.[1].quantity??0;if(Math.abs(q-h.quantity)>1e-9)out.push({symbol:h.symbol,brokerQuantity:h.quantity,ledgerQuantity:q});}
    for(const [s,p] of Object.entries(ledger.positions))if(!held.some(h=>ticker(h.symbol)===ticker(s)))out.push({symbol:s,brokerQuantity:0,ledgerQuantity:p.quantity});
    return out;
  }

  // Cost pools are kept per account; realized gains are combined for the taxpayer afterwards. Positions are the connected
  // account's (entered basis applies to it only).
  ledger(settings=this.saved()){
    const {fills,issues}=this.matchedFills(),current=require('./tax-profile.cjs').ownerAccount(this.currentAccount()?.accountKey);const accounts=[...new Set(fills.map(f=>f.account))];
    const lots=this.openingLots();const all=[...new Set([...accounts,...lots.map(l=>l.account)])].filter(a=>a===current||accounts.includes(a));
    const pools=Object.fromEntries(all.map(a=>[a,buildLedger({fills:fills.filter(f=>f.account===a),openingLots:lots.filter(l=>l.account===a),rateOn:day=>this.rateOn(day),userBasis:a===current?settings.taxBasisKRW:{},method:settings.taxMethod,today:today(),krClosed:this.krClosed()})]));
    const own=pools[current]??buildLedger({fills:[],rateOn:()=>null,method:settings.taxMethod});
    return {method:settings.taxMethod,sales:all.flatMap(a=>pools[a].sales.map(s=>({...s,account:a}))).sort((x,y)=>x.settlementDate.localeCompare(y.settlementDate)),purchases:all.flatMap(a=>pools[a].purchases.map(p=>({...p,account:a}))),positions:own.positions,accounts:all,issues};
  }
  // Settlement days whose reference rate is still missing, for the provider worker to fetch.
  // Every settlement day of a recorded trade needs the reference rate, whatever the broker reported (its rate is only
  // evidence); dates come from the ledger's calendar, future days are not yet published, newest first.
  missingRateDays(){const {estimatedSettlement}=require('./tax-ledger.cjs');const krClosed=this.krClosed(),now=today();
    return [...new Set(this.fills().map(f=>f.settlementDate??estimatedSettlement(f.tradeDate,{krClosed})))].filter(day=>day<=now&&!this.rateOn(day)).sort().reverse().slice(0,20);}
  taxSummary(){
    const settings=this.saved(),ledger=this.ledger(settings);
    const orders=this.orders().filter(o=>o.filled>0&&o.resultCosts).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)).slice(0,30).map(o=>({id:o.id,market:o.market,symbol:o.symbol,side:o.side,quantity:o.filled,day:o.day,currency:o.resultCosts.currency??(o.market==='US'?'USD':'KRW'),basis:o.resultCosts.basis,commission:o.resultCosts.commission,transactionTax:o.resultCosts.transactionTax,netCash:o.resultCosts.netCash,estimate:o.costEstimate?{commission:o.costEstimate.commission,transactionTax:o.costEstimate.transactionTax}:null,reportStatus:o.reportedCosts?.status??'pending'}));
    return {settings,year:annualTax(ledger,settings.taxYear,settings.annualRealizedKRW,{applicability:this.applicability('US'),issues:ledger.issues??[]}),ledger,orders,openingLots:this.openingLots(require('./tax-profile.cjs').ownerAccount(this.currentAccount()?.accountKey)),income:this.incomeSummary(settings.taxYear),fundClasses:this.fundClasses(),reconciliation:this.reconciliation(ledger),profile:this.profile.get(),applicability:{KR:this.applicability('KR'),US:this.applicability('US')},ruleVersion:rules.RULE_VERSION};
  }
  // The statutory sale-tax rate of a Korean sale today: the override, or the higher of the KOSPI and KOSDAQ rates.
  krSaleTaxPct(settings=this.saved()){return settings.krSellTaxOverridePct??Math.max(...['KOSPI','KOSDAQ'].map(m=>rules.krSaleTax(m,1e6,today())?.ratePct??0));}
  // What reviews read: figures and their status, without internal fields (lots, per-estimate rule versions and sources,
  // repeated assumptions), so the tax model does not crowd the review out of its size limit (2026-10-26: reviews failed
  // with CONTEXT_TOO_LARGE once the full estimates were included).
  context(market,universe,positions){
    const full=this.fullContext(market,universe,positions);const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
    const status=t=>t?{status:t.status,...(t.missingInputs?.length?{missingInputs:t.missingInputs}:{})}:undefined;
    const sell=e=>({...pick(e,['gross','commission','transactionTax','netCash','gainAfterFees','taxableGainKRW','capitalGainsTaxKRW','gainAfterEstimatedTax']),incomeTax:status(e.incomeTax)});
    const t=full.tax;const assumptions=[...new Set([...(t.applicability?.assumptions??[]),...(t.annual?.assumptions??[]),...full.oneShare.flatMap(r=>r.sell.incomeTax?.assumptions??[])])];
    return {market,currency:market==='US'?'USD':'KRW',settings:pick(full.settings,['krCommissionPct','usCommissionPct','usSellFeePct','usSellFeeMinimum','krSellTaxOverridePct','usdKRW','annualRealizedKRW','taxYear','taxMethod','taxBasisKRW']),krSaleTaxPct:full.krSaleTaxPct,
      acquisitionFeeAssumption:'Broker average prices exclude acquisition commissions; where no recorded lot cost exists, the commission is estimated from the fee plan.',
      tax:{ruleVersion:t.ruleVersion,applicability:{status:t.applicability.status,...(t.applicability.reasons?.length?{reasons:t.applicability.reasons}:{})},...(t.annual?{annual:status(t.annual)}:{}),assumptions,classification:t.classification},
      taxModel:full.taxModel,heldSale:full.heldSale,...(full.allUSHoldingsSale!==undefined?{allUSHoldingsSale:full.allUSHoldingsSale}:{}),
      oneShare:full.oneShare.map(r=>({symbol:r.symbol,buy:pick(r.buy,['gross','commission','netCash']),sell:sell(r.sell)}))};
  }
  fullContext(market,universe,positions){
    const settings=this.get();const relevant={...settings,taxBasisKRW:Object.fromEntries(Object.entries(settings.taxBasisKRW).filter(([symbol])=>universe.some(row=>row.symbol===symbol)))};const applicable=this.applicability(market);
    return {market,settings:relevant,krSaleTaxPct:this.krSaleTaxPct(settings),acquisitionFeeAssumption:'Broker average acquisition prices treated as excluding acquisition commissions; these are estimated using the saved commission plan. Executed orders use broker-reported fees where available.',
      tax:{ruleVersion:rules.RULE_VERSION,applicability:applicable,annual:market==='US'?settings.taxStatus??null:null,classification:Object.fromEntries(universe.map(row=>{const c=this.classify(row.symbol);return [row.symbol,{instrument:c.instrument,transactionTax:c.transactionTax,incomeTax:c.incomeTax}];}))},
      taxModel:`Taxes come from the app (rules ${rules.RULE_VERSION}); use its figures and status, never a flat rate. incomeTax.status: estimated (complete inputs, tax.assumptions apply), incomplete (an input in missingInputs is missing: the tax is unknown (not zero)), unsupported (outside the implemented rules). Korean listed shares: sale tax by market (0.20% in 2026), no income tax for a minority shareholder. Korean ETFs and ETNs: no sale tax, income tax depends on the fund. U.S. shares: the change in the year's overseas-gains tax (22% above the shared KRW 2.5m deduction), paid the next May.`,
      // Quotes for selling each whole holding (one share is not enough for lots, ETFs or the annual deduction), and for
      // selling every U.S. holding together, where the shared deduction is used once.
      heldSale:universe.filter(row=>positions[row.symbol]?.quantity>0).map(row=>{const p=positions[row.symbol];const e=estimateCosts({market,side:'Sell',quantity:p.quantity,price:row.price,costPerShare:p.costTotal/p.quantity,symbol:row.symbol,settings,classification:this.classify(row.symbol)});
        return {symbol:row.symbol,quantity:p.quantity,netCash:e.netCash,taxableGainKRW:e.taxableGainKRW,annualTaxChangeKRW:e.capitalGainsTaxKRW,gainAfterEstimatedTax:e.gainAfterEstimatedTax,incomeTax:{status:e.incomeTax.status,missingInputs:e.incomeTax.missingInputs}};}),
      ...(market==='US'?{allUSHoldingsSale:(()=>{const rows=universe.filter(row=>positions[row.symbol]?.quantity>0).map(row=>estimateCosts({market,side:'Sell',quantity:positions[row.symbol].quantity,price:row.price,symbol:row.symbol,settings,classification:this.classify(row.symbol)}));
        if(!rows.length)return null;const missing=[...new Set(rows.flatMap(e=>e.incomeTax.missingInputs))];if(missing.length||rows.some(e=>e.taxableGainKRW==null))return {status:'incomplete',missingInputs:missing,annualTaxChangeKRW:null};
        const gain=rows.reduce((n,e)=>n+e.taxableGainKRW,0);return {status:'estimated',taxableGainKRW:gain,annualTaxChangeKRW:require('./tax-ledger.cjs').marginalTax({year:settings.taxYear,totalKRW:settings.annualRealizedKRW},gain),separateQuotesSumKRW:rows.reduce((n,e)=>n+e.capitalGainsTaxKRW,0)};})()}:{}),
      oneShare:universe.map(row=>{const classification=this.classify(row.symbol);return {symbol:row.symbol,buy:estimateCosts({market,side:'Buy',quantity:1,price:row.price,symbol:row.symbol,settings,classification}),sell:estimateCosts({market,side:'Sell',quantity:1,price:row.price,costPerShare:positions[row.symbol]?.quantity?positions[row.symbol].costTotal/positions[row.symbol].quantity:null,symbol:row.symbol,settings,classification})};})};
  }
}
module.exports={TradingCosts,DEFAULT_COSTS,validateCosts,estimateCosts,brokerCosts,migrate};
