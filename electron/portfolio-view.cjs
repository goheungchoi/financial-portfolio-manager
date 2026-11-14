const COLORS=['#66d9c0','#b8a4ed','#efb76b','#e18da9','#94bf7c','#7bb8d6'];
// inFlight: U.S. fills KIS may not reflect yet (electron/valuation.cjs InFlight). Totals are the valuation's low bound
// (electron/valuation.cjs); state.valuation carries both bounds, every component, the scope and the reasons.
function combinePortfolio(korea,us,fx,metadata={},{inFlight=null,funding=null,now=Date.now()}={}){
  const rate=fx?.usdKRW>0&&Number.isFinite(fx.usdKRW)?fx.usdKRW:null;const rows=[];
  for(const [market,snapshot,currency] of [['KR',korea,'KRW'],['US',us,'USD']])for(const row of snapshot?.holdings??[]){const info=metadata[row.symbol]??{},factor=market==='KR'?1:rate;rows.push({...row,market,currency,sector:info.sector||'Unclassified',region:info.region||(market==='KR'?'South Korea (listing)':'United States (listing)'),color:COLORS[rows.length%COLORS.length],nativeValue:row.quantity*row.price,valueKRW:factor==null?null:row.quantity*row.price*factor,costKRW:factor==null?null:row.quantity*row.cost*factor});}
  // Korean equity uses settled (D+2) cash so unsettled purchases are not counted as both cash and shares, less the KRW
  // committed to unsettled U.S. buys through integrated margin, which the U.S. shares already count (all of it, the
  // conservative figure; the part that may have been USD-funded is reported as uncertain).
  // C1d-2: with the funding-transfer recorder, Korea is net of the KRW KIS has shown for U.S. buys (fundingSplit).
  const base=require('./integrated-settlement.cjs').settlement(us),split=funding&&base.unsettledKRW>0?require('./valuation.cjs').fundingSplit(funding,base.unsettledKRW,base.confirmedKRW):null;
  const committed=split?split.krLow:base.unsettledKRW,uncertainKRW=split?split.krLow-split.krHigh:base.uncertainKRW;
  const krCash=korea?(Number.isFinite(korea.settledCash)?korea.settledCash:korea.cash)-committed:null;
  const krEquity=korea?krCash+rows.filter(row=>row.market==='KR').reduce((sum,row)=>sum+row.nativeValue,0):null;
  // U.S. sale proceeds KIS has not settled yet count in U.S. equity (not in cash): electron/kis-overseas.cjs readBalance.
  const pendingUSD=us?.pendingSaleProceeds>0?us.pendingSaleProceeds:0;const usEquity=us?us.cash+pendingUSD+rows.filter(row=>row.market==='US').reduce((sum,row)=>sum+row.nativeValue,0):null;
  const valuation=require('./valuation.cjs').value({korea,us,fx,inFlight,funding,now});const V=valuation.markets,C=valuation.combined;
  const complete=krEquity!=null&&usEquity!=null;const equityKRW=C.scope.length===2&&C.low!=null?C.low:null;
  return {valuation,rows,depositCash:{KRW:korea?.cash??null},...(committed?{committedKRW:committed}:{}),...(uncertainKRW?{settlementUncertainKRW:uncertainKRW}:{}),cash:{KRW:krCash,USD:us?.cash??null},...(pendingUSD?{pendingSettlement:{USD:pendingUSD}}:{}),...(split&&split.usLowKRW>0?{fundingRoute:{open:funding.usOrders||1,usd:funding.usUSD??null}}:{}),totals:{KRW:V.KR.available?V.KR.equity.low:krEquity,USD:V.US.available?V.US.equity.low:usEquity,equityKRW},fx:rate?fx:null,complete,timestamps:{KR:korea?.timestamp??null,US:us?.timestamp??null}};
}
class PortfolioView{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS instrument_metadata(symbol TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  metadata(){return Object.fromEntries(this.db.prepare('SELECT symbol,payload FROM instrument_metadata').all().map(row=>[row.symbol,JSON.parse(row.payload)]));}
  save(symbol,value){if(typeof symbol!=='string'||!(/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/).test(symbol)||!value||Object.keys(value).sort().join(',')!=='region,sector'||Object.values(value).some(text=>typeof text!=='string'||text.length>100||/[\x00-\x1f]/.test(text)))throw new Error('INVALID_METADATA');const data={sector:value.sector.trim(),region:value.region.trim()};this.db.prepare('INSERT INTO instrument_metadata VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload').run(symbol,JSON.stringify(data));return data;}
}
module.exports={combinePortfolio,PortfolioView};
