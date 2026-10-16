const {buildLedger,annualTax}=require('./tax-ledger.cjs');
// Korean sale tax 2026: KOSPI 0.05% securities transaction tax + 0.15% rural special tax; KOSDAQ 0.20%. Domestic ETFs/ETNs are exempt.
// U.S. sale levy: SEC Section 31 fee, USD 20.60 per million from 2026-04-04.
const DEFAULT_COSTS={krCommissionPct:0.015,krSellTaxPct:0.2,usCommissionPct:0.25,usSellFeePct:0.00206,usSellFeeMinimum:0.01,usdKRW:null,annualRealizedKRW:null,taxYear:new Date().getFullYear(),taxBasisKRW:{},taxMethod:'moving-average'};
const round=(n,d=2)=>Math.round((n+Number.EPSILON)*10**d)/10**d;
function validateCosts(value){
  if(!value||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_COSTS,key)))throw new Error('INVALID_COST_SETTINGS');
  const next={...DEFAULT_COSTS,...value};
  for(const key of ['krCommissionPct','krSellTaxPct','usCommissionPct','usSellFeePct','usSellFeeMinimum'])if(!Number.isFinite(next[key])||next[key]<0||next[key]>100)throw new Error('INVALID_COST_SETTINGS');
  for(const key of ['usdKRW','annualRealizedKRW'])if(next[key]!==null&&(!Number.isFinite(next[key])||Math.abs(next[key])>1e13||key==='usdKRW'&&next[key]<=0))throw new Error('INVALID_COST_SETTINGS');
  if(!Number.isInteger(next.taxYear)||next.taxYear<2020||next.taxYear>2100||!next.taxBasisKRW||typeof next.taxBasisKRW!=='object'||Array.isArray(next.taxBasisKRW)||Object.keys(next.taxBasisKRW).length>100)throw new Error('INVALID_COST_SETTINGS');
  for(const [key,value] of Object.entries(next.taxBasisKRW))if(!/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(key)||!Number.isFinite(value)||value<0||value>1e13)throw new Error('INVALID_COST_SETTINGS');
  if(!['moving-average','fifo'].includes(next.taxMethod))throw new Error('INVALID_COST_SETTINGS');
  return next;
}
function estimateCosts({market='KR',side,quantity,price,costPerShare=null,symbol='',settings=DEFAULT_COSTS,exempt=false}){
  if(!['KR','US'].includes(market)||!['Buy','Sell'].includes(side)||!Number.isInteger(quantity)||quantity<1||!Number.isFinite(price)||price<=0)throw new Error('INVALID_ORDER');
  const us=market==='US',digits=us?2:0,gross=round(quantity*price,digits),commission=round(gross*(us?settings.usCommissionPct:settings.krCommissionPct)/100,digits);
  const transactionTax=side==='Sell'&&!(exempt&&!us)?round(us?Math.max(settings.usSellFeeMinimum,gross*settings.usSellFeePct/100):gross*settings.krSellTaxPct/100,digits):0;
  const netCash=round(side==='Sell'?gross-commission-transactionTax:-(gross+commission),digits);
  return withGain({basis:'estimate',currency:us?'USD':'KRW',gross,commission,transactionTax,netCash},{us,side,quantity,costPerShare,symbol,settings});
}
// Costs from broker-reported figures. KR: the broker's combined fee-and-tax amount for the order, with the statutory sale tax
// shown separately and the remainder as commission. U.S.: the broker's fees and settlement amount for the matched trades.
function brokerCosts({market,side,quantity,price,costPerShare=null,symbol='',settings=DEFAULT_COSTS,exempt=false,reported}){
  const us=market==='US',digits=us?2:0,gross=round(quantity*price,digits);
  if(us){
    const fees=round(reported.feesUSD??0,2),netCash=round(reported.settlementUSD!=null?(side==='Sell'?reported.settlementUSD:-reported.settlementUSD):side==='Sell'?gross-fees:-(gross+fees),2);
    return withGain({basis:'broker',currency:'USD',gross,commission:fees,transactionTax:0,netCash,settlementDate:reported.settlementDate??null,exchangeRate:reported.exchangeRate??null,settlementKRW:reported.settlementKRW??null},{us,side,quantity,costPerShare,symbol,settings});
  }
  const charges=round(reported.charges,0),tax=side==='Sell'&&!exempt?Math.min(charges,round(gross*settings.krSellTaxPct/100,0)):0;
  return withGain({basis:'broker',currency:'KRW',gross,commission:charges-tax,transactionTax:tax,netCash:side==='Sell'?gross-charges:-(gross+charges)},{us,side,quantity,costPerShare,symbol,settings});
}
function withGain(costs,{us,side,quantity,costPerShare,symbol,settings}){
  const gain=side==='Sell'&&costPerShare!=null?round(costs.netCash-quantity*costPerShare*(1+(us?settings.usCommissionPct:settings.krCommissionPct)/100),us?2:0):null;
  let taxableGainKRW=null,capitalGainsTaxKRW=null;
  if(us&&side==='Sell'&&settings.usdKRW!=null&&settings.annualRealizedKRW!=null&&settings.taxYear===new Date().getFullYear()&&settings.taxBasisKRW[symbol]!=null){
    taxableGainKRW=round(costs.netCash*(costs.exchangeRate??settings.usdKRW)-quantity*settings.taxBasisKRW[symbol],0);
    const tax=gain=>Math.round(Math.max(0,gain-2500000)*.22);
    capitalGainsTaxKRW=tax(settings.annualRealizedKRW+taxableGainKRW)-tax(settings.annualRealizedKRW);
  }
  return {...costs,gainAfterFees:gain,taxableGainKRW,capitalGainsTaxKRW,gainAfterEstimatedTax:gain==null?null:!us?gain:capitalGainsTaxKRW==null?null:round(gain-capitalGainsTaxKRW/(costs.exchangeRate??settings.usdKRW),2)};
}
class TradingCosts{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trading_cost_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS fx_rates(day TEXT PRIMARY KEY,rate REAL NOT NULL,source TEXT NOT NULL)');}
  table(name){return Boolean(this.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(name));}
  saved(){const row=this.db.prepare('SELECT payload FROM trading_cost_settings WHERE id=1').get();const saved=row?JSON.parse(row.payload):{};return {...DEFAULT_COSTS,...(saved.settings??saved)};}
  // annualRealizedKRW is entered as gains realized outside this app; app sales come from the ledger.
  // Estimates use the ledger's KRW cost per share where the app holds purchase records.
  get(){
    const settings=this.saved();let ledger;try{ledger=this.ledger(settings);}catch{return settings;}const year=annualTax(ledger,settings.taxYear,settings.annualRealizedKRW);
    const basis={...settings.taxBasisKRW};for(const [symbol,p] of Object.entries(ledger.positions))if(p.perShareKRW!=null)basis[symbol]=p.perShareKRW;
    return {...settings,taxBasisKRW:basis,annualRealizedKRW:settings.annualRealizedKRW==null?null:year.totalKRW};
  }
  save(value){const next=validateCosts(value);this.db.prepare('INSERT INTO trading_cost_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify({settings:next}));return this.saved();}
  // Domestic ETFs and ETNs pay no securities transaction tax on sale (security master type).
  exempt(symbol){if(!/^\d{6}$/.test(symbol??'')||!this.table('securities'))return false;const row=this.db.prepare('SELECT type FROM securities WHERE symbol=?').get(symbol);return ['etf','etn'].includes(row?.type);}
  saveRates(rows,source){const insert=this.db.prepare('INSERT INTO fx_rates VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET rate=excluded.rate,source=excluded.source');for(const row of rows??[])if(/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(row.value)&&row.value>0)insert.run(row.date,row.value,source);}
  // Reference rate on the day, or the latest earlier one within a week (weekends and holidays).
  rateOn(day){const row=this.db.prepare('SELECT day,rate,source FROM fx_rates WHERE day<=? ORDER BY day DESC LIMIT 1').get(day);if(!row||Date.parse(day)-Date.parse(row.day)>7*86400000)return null;return {rate:row.rate,day:row.day,source:row.day===day?row.source:`${row.source} (${row.day})`};}
  orders(){return this.table('live_intents')?this.db.prepare('SELECT payload FROM live_intents').all().map(r=>JSON.parse(r.payload)):[];}
  fills(){
    return this.orders().filter(o=>o.market==='US'&&o.filled>0&&o.fillPrice>0&&['Buy','Sell'].includes(o.side)&&/^\d{4}-\d{2}-\d{2}$/.test(o.day??'')&&/^(NASD|NYSE|AMEX):/.test(o.symbol??'')).map(o=>{const r=o.reportedCosts?.status==='reported'?o.reportedCosts:null;
      return {id:o.id,symbol:o.symbol,side:o.side,quantity:o.filled,price:o.fillPrice,feesUSD:r?r.feesUSD:o.resultCosts?(o.resultCosts.commission+o.resultCosts.transactionTax):null,tradeDate:o.day,timestamp:o.createdAt,settlementDate:r?.settlementDate??null,settlementKRW:r?.settlementKRW??null,exchangeRate:r?.exchangeRate??null,feesSource:r?'Broker':'Estimated'};});
  }
  ledger(settings=this.saved()){return buildLedger({fills:this.fills(),rateOn:day=>this.rateOn(day),userBasis:settings.taxBasisKRW,method:settings.taxMethod});}
  // Settlement days whose reference rate is still missing, for the provider worker to fetch.
  missingRateDays(){const {estimatedSettlement}=require('./tax-ledger.cjs');return [...new Set(this.fills().filter(f=>f.settlementKRW==null&&!f.exchangeRate).map(f=>f.settlementDate??estimatedSettlement(f.tradeDate)))].filter(day=>!this.db.prepare('SELECT day FROM fx_rates WHERE day=?').get(day)).slice(0,20);}
  taxSummary(){
    const settings=this.saved(),ledger=this.ledger(settings);
    const orders=this.orders().filter(o=>o.filled>0&&o.resultCosts).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)).slice(0,30).map(o=>({id:o.id,market:o.market,symbol:o.symbol,side:o.side,quantity:o.filled,day:o.day,currency:o.resultCosts.currency??(o.market==='US'?'USD':'KRW'),basis:o.resultCosts.basis,commission:o.resultCosts.commission,transactionTax:o.resultCosts.transactionTax,netCash:o.resultCosts.netCash,estimate:o.costEstimate?{commission:o.costEstimate.commission,transactionTax:o.costEstimate.transactionTax}:null,reportStatus:o.reportedCosts?.status??'pending'}));
    return {settings,year:annualTax(ledger,settings.taxYear,settings.annualRealizedKRW),ledger,orders};
  }
  context(market,universe,positions){const settings=this.get();const relevant={...settings,taxBasisKRW:Object.fromEntries(Object.entries(settings.taxBasisKRW).filter(([symbol])=>universe.some(row=>row.symbol===symbol)))};return {market,settings:relevant,acquisitionFeeAssumption:'Broker average acquisition prices treated as excluding acquisition commissions; these are estimated using the saved commission plan. Executed orders use broker-reported fees where available.',taxProfile:'South Korean resident individual; ordinary foreign-company shares',taxModel:`Annual capital gains on overseas shares: 22% above the shared KRW 2,500,000 deduction. annualRealizedKRW = gains realized outside this app (user-entered) plus app sales from a KRW ledger (${settings.taxMethod==='fifo'?'first-in first-out':'moving-average'} cost, settlement-date exchange rates, broker figures where reported). taxBasisKRW is the KRW cost per share from that ledger, or user-entered for older holdings. Missing tax inputs mean unknown, never zero. Estimates are not amounts withheld from proceeds. Domestic sale tax 0.20% (none for ETFs/ETNs); major-shareholder rules excluded.`,oneShare:universe.map(row=>({symbol:row.symbol,buy:estimateCosts({market,side:'Buy',quantity:1,price:row.price,symbol:row.symbol,settings}),sell:estimateCosts({market,side:'Sell',quantity:1,price:row.price,costPerShare:positions[row.symbol]?.quantity?positions[row.symbol].costTotal/positions[row.symbol].quantity:null,symbol:row.symbol,settings,exempt:this.exempt(row.symbol)})}))};}
}
module.exports={TradingCosts,DEFAULT_COSTS,validateCosts,estimateCosts,brokerCosts};
