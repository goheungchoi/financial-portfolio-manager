const DEFAULT_COSTS={krCommissionPct:0.015,krSellTaxPct:0.2,usCommissionPct:0.25,usSellFeePct:0.00206,usSellFeeMinimum:0.01,usdKRW:null,annualRealizedKRW:null,taxYear:new Date().getFullYear(),taxBasisKRW:{}};
const round=(n,d=2)=>Math.round((n+Number.EPSILON)*10**d)/10**d;
function validateCosts(value){
  if(!value||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_COSTS,key)))throw new Error('INVALID_COST_SETTINGS');
  const next={...DEFAULT_COSTS,...value};
  for(const key of ['krCommissionPct','krSellTaxPct','usCommissionPct','usSellFeePct','usSellFeeMinimum'])if(!Number.isFinite(next[key])||next[key]<0||next[key]>100)throw new Error('INVALID_COST_SETTINGS');
  for(const key of ['usdKRW','annualRealizedKRW'])if(next[key]!==null&&(!Number.isFinite(next[key])||Math.abs(next[key])>1e13||key==='usdKRW'&&next[key]<=0))throw new Error('INVALID_COST_SETTINGS');
  if(!Number.isInteger(next.taxYear)||next.taxYear<2020||next.taxYear>2100||!next.taxBasisKRW||typeof next.taxBasisKRW!=='object'||Array.isArray(next.taxBasisKRW)||Object.keys(next.taxBasisKRW).length>100)throw new Error('INVALID_COST_SETTINGS');
  for(const [key,value] of Object.entries(next.taxBasisKRW))if(!/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(key)||!Number.isFinite(value)||value<0||value>1e13)throw new Error('INVALID_COST_SETTINGS');
  return next;
}
function estimateCosts({market='KR',side,quantity,price,costPerShare=null,symbol='',settings=DEFAULT_COSTS}){
  if(!['KR','US'].includes(market)||!['Buy','Sell'].includes(side)||!Number.isInteger(quantity)||quantity<1||!Number.isFinite(price)||price<=0)throw new Error('INVALID_ORDER');
  const us=market==='US',digits=us?2:0,gross=round(quantity*price,digits),commission=round(gross*(us?settings.usCommissionPct:settings.krCommissionPct)/100,digits);
  const transactionTax=side==='Sell'?round(us?Math.max(settings.usSellFeeMinimum,gross*settings.usSellFeePct/100):gross*settings.krSellTaxPct/100,digits):0;
  const netCash=round(side==='Sell'?gross-commission-transactionTax:-(gross+commission),digits);
  const gain=side==='Sell'&&costPerShare!=null?round(netCash-quantity*costPerShare*(1+(us?settings.usCommissionPct:settings.krCommissionPct)/100),digits):null;
  let taxableGainKRW=null,capitalGainsTaxKRW=null;
  if(us&&side==='Sell'&&settings.usdKRW!=null&&settings.annualRealizedKRW!=null&&settings.taxYear===new Date().getFullYear()&&settings.taxBasisKRW[symbol]!=null){
    taxableGainKRW=round(netCash*settings.usdKRW-quantity*settings.taxBasisKRW[symbol],0);
    const tax=gain=>Math.round(Math.max(0,gain-2500000)*.22);
    capitalGainsTaxKRW=tax(settings.annualRealizedKRW+taxableGainKRW)-tax(settings.annualRealizedKRW);
  }
  return {basis:'estimate',currency:us?'USD':'KRW',gross,commission,transactionTax,netCash,gainAfterFees:gain,taxableGainKRW,capitalGainsTaxKRW,gainAfterEstimatedTax:gain==null?null:!us?gain:capitalGainsTaxKRW==null?null:round(gain-capitalGainsTaxKRW/settings.usdKRW,2)};
}
class TradingCosts{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trading_cost_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');}
  realized(year){if(!this.db.prepare("SELECT name FROM sqlite_master WHERE name='live_intents'").get())return {};return Object.fromEntries(this.db.prepare('SELECT payload FROM live_intents').all().map(row=>JSON.parse(row.payload)).filter(order=>order.market==='US'&&order.side==='Sell'&&order.day?.startsWith(String(year))&&order.resultCosts?.taxableGainKRW!=null).map(order=>[order.id,order.resultCosts.taxableGainKRW]));}
  get(){const row=this.db.prepare('SELECT payload FROM trading_cost_settings WHERE id=1').get();const saved=row?JSON.parse(row.payload):{};const settings={...DEFAULT_COSTS,...(saved.settings??saved)};if(settings.annualRealizedKRW!=null){const realized=this.realized(settings.taxYear);settings.annualRealizedKRW+=Object.entries(realized).reduce((sum,[id,gain])=>sum+gain-(saved.anchor?.[id]??0),0);}return settings;}
  save(value){const next=validateCosts(value);this.db.prepare('INSERT INTO trading_cost_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify({settings:next,anchor:this.realized(next.taxYear)}));return next;}
  context(market,universe,positions){const settings=this.get();const relevant={...settings,taxBasisKRW:Object.fromEntries(Object.entries(settings.taxBasisKRW).filter(([symbol])=>universe.some(row=>row.symbol===symbol)))};return {market,settings:relevant,acquisitionFeeAssumption:'Broker average acquisition prices treated as excluding acquisition commissions; these are estimated using the saved commission plan. Historical account rates may differ.',taxProfile:'South Korean resident individual; ordinary foreign-company shares',taxModel:'Incremental annual capital gains estimate: 22% after shared KRW 2,500,000 deduction. annualRealizedKRW includes the user-entered all-broker baseline plus subsequent app fills with known KRW tax inputs. External trades and missing-basis fills require user updates. KRW acquisition cost per share includes acquisition expenses at historical settlement FX. usdKRW is an indicative sale-settlement FX. Missing tax inputs mean unknown, never zero. Estimates are not amounts withheld from proceeds. Broker settlement overrides estimates. Domestic model assumes ordinary minority listed shares; major-shareholder rules excluded.',oneShare:universe.map(row=>({symbol:row.symbol,buy:estimateCosts({market,side:'Buy',quantity:1,price:row.price,symbol:row.symbol,settings}),sell:estimateCosts({market,side:'Sell',quantity:1,price:row.price,costPerShare:positions[row.symbol]?.quantity?positions[row.symbol].costTotal/positions[row.symbol].quantity:null,symbol:row.symbol,settings})}))};}
}
module.exports={TradingCosts,DEFAULT_COSTS,validateCosts,estimateCosts};
