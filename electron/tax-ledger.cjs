// Korean capital-gains ledger for overseas shares bought and sold through this app.
// Gains are computed in KRW: acquisition cost = (price x quantity + fees) at the purchase settlement-date rate,
// proceeds = (price x quantity - fees) at the sale settlement-date rate. Broker KRW settlement amounts are used when reported.
// Realization follows the settlement date (the tax year of a late-December sale can be the next year).
const DEDUCTION_KRW=2500000,RATE=0.22;// 20% national + 2% local income tax
const round=n=>Math.round(n);
// Next weekday after a U.S. trade date (T+1); exchange holidays are not modeled, so this is an estimate.
function estimatedSettlement(tradeDate){const d=new Date(Date.parse(tradeDate+'T00:00:00Z')+86400000);while([0,6].includes(d.getUTCDay()))d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
// fills: [{id,symbol,side,quantity,price,feesUSD,tradeDate,settlementDate?,settlementKRW?,exchangeRate?,feesSource}]
// rateOn(day) -> {rate,day,source}|null for the KRW reference rate on or before a day.
// userBasis: {symbol: KRW per share} for shares acquired before the app's records (user-entered).
function buildLedger({fills,rateOn,userBasis={},method='moving-average'}){
  if(!['moving-average','fifo'].includes(method))throw new Error('INVALID_METHOD');
  const positions=new Map(),sales=[],purchases=[];
  const ordered=[...fills].sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate)||(a.timestamp??0)-(b.timestamp??0));
  for(const fill of ordered){
    const settlementDate=fill.settlementDate??estimatedSettlement(fill.tradeDate);const gross=fill.quantity*fill.price,fees=fill.feesUSD??0;
    const fx=fill.settlementKRW!=null?{rate:null,source:'Broker KRW settlement'}:fill.exchangeRate?{rate:fill.exchangeRate,source:'Broker registered rate'}:rateOn(settlementDate);
    const amountKRW=fill.settlementKRW!=null?Math.abs(fill.settlementKRW):fx?.rate?round((fill.side==='Buy'?gross+fees:gross-fees)*fx.rate):null;
    const position=positions.get(fill.symbol)??{quantity:0,costKRW:0,lots:[],unknown:false};positions.set(fill.symbol,position);
    if(fill.side==='Buy'){
      if(amountKRW==null)position.unknown=true;position.quantity+=fill.quantity;position.costKRW+=amountKRW??0;position.lots.push({quantity:fill.quantity,costKRW:amountKRW});
      purchases.push({id:fill.id,symbol:fill.symbol,settlementDate,quantity:fill.quantity,costKRW:amountKRW,fxSource:fx?.source??'Rate unavailable',settlementEstimated:!fill.settlementDate});continue;
    }
    // Shares sold beyond the app's own purchases use the user-entered basis, otherwise the gain is unknown.
    const fromLots=Math.min(fill.quantity,position.quantity),outside=fill.quantity-fromLots;let costKRW=0,known=!position.unknown||fromLots===0;
    if(fromLots>0){
      if(method==='moving-average'){const share=position.costKRW/position.quantity;costKRW+=share*fromLots;position.costKRW-=share*fromLots;position.quantity-=fromLots;let left=fromLots;for(const lot of position.lots){const take=Math.min(left,lot.quantity);lot.quantity-=take;left-=take;if(!left)break;}}
      else{let left=fromLots;for(const lot of position.lots){if(!left)break;const take=Math.min(left,lot.quantity);if(take&&lot.costKRW==null)known=false;const part=take&&lot.costKRW!=null?lot.costKRW*take/lot.quantity:0;costKRW+=part;lot.costKRW=lot.costKRW==null?null:lot.costKRW-part;lot.quantity-=take;left-=take;position.costKRW-=part;}position.quantity-=fromLots;}
      position.lots=position.lots.filter(lot=>lot.quantity>0);if(!position.quantity){position.costKRW=0;position.unknown=false;}
    }
    let basisSource=fromLots?'App purchases':'Entered basis';
    if(outside>0){if(userBasis[fill.symbol]!=null){costKRW+=userBasis[fill.symbol]*outside;basisSource=fromLots?'App purchases + entered basis':'Entered basis';}else{known=false;basisSource='Unknown basis';}}
    const gainKRW=known&&amountKRW!=null?round(amountKRW-costKRW):null;
    sales.push({id:fill.id,symbol:fill.symbol,tradeDate:fill.tradeDate,settlementDate,year:Number(settlementDate.slice(0,4)),quantity:fill.quantity,proceedsKRW:amountKRW,costKRW:known?round(costKRW):null,gainKRW,basisSource,fxSource:fx?.source??'Rate unavailable',feesSource:fill.feesSource??'Estimated',settlementEstimated:!fill.settlementDate});
  }
  return {method,sales,purchases,positions:Object.fromEntries([...positions].filter(([,p])=>p.quantity>0).map(([symbol,p])=>[symbol,{quantity:p.quantity,costKRW:p.unknown?null:round(p.costKRW),perShareKRW:p.unknown?null:Math.round(p.costKRW/p.quantity*100)/100}]))};
}
// The year's overseas capital-gains tax for the taxpayer. The full liability needs every sale's basis and the gains
// realized outside this app; when one is missing the liability is null (incomplete), and the known-record figures are
// a labeled subtotal, not a bound (a missing sale may be a loss). The basic deduction is capped: losses beyond it are
// reported separately as offset capacity for further gains in the same year, never as a refund or a carryforward.
// applicability: from tax-profile.cjs, for the accounts in the ledger.
function annualTax(ledger,year,outsideKRW=null,{applicability=null,asOf=Date.now()}={}){
  const {overseasGainsTax,taxResult,ROUNDING}=require('./tax-rules.cjs');
  const yearSales=ledger.sales.filter(s=>s.year===year),known=yearSales.filter(s=>s.gainKRW!=null),appKRW=known.reduce((n,s)=>n+s.gainKRW,0);
  const knownTotal=appKRW+(outsideKRW??0);const missing=[];if(outsideKRW==null)missing.push('gains realized outside this app this year');if(known.length<yearSales.length)missing.push(`acquisition basis or exchange rate for ${yearSales.length-known.length} sale(s)`);
  const unsupported=applicability?.status==='unsupported';const complete=!missing.length&&!unsupported;
  const assumptions=[...(applicability?.assumptions??[]),ROUNDING,...(yearSales.some(s=>s.settlementEstimated)?['settlement dates estimated where the broker has not reported them']:[])];
  const tax=overseasGainsTax(complete?knownTotal:0,year),knownTax=overseasGainsTax(knownTotal,year);
  const result=taxResult({status:unsupported?'unsupported':complete?'estimated':'incomplete',value:tax?.totalKRW??null,knownSubtotal:knownTax?.totalKRW??null,missingInputs:[...missing,...(applicability?.reasons??[])],assumptions,taxYear:year,asOf,sourceIds:tax?.sources??[]});
  return {year,appRealizedKRW:appKRW,outsideKRW,knownTotalKRW:knownTotal,totalKRW:complete?knownTotal:null,deductionKRW:DEDUCTION_KRW,deductionRemainingKRW:complete?Math.max(0,DEDUCTION_KRW-Math.max(0,knownTotal)):null,lossOffsetKRW:complete?Math.max(0,-knownTotal):null,
    taxableKRW:complete?tax.taxableKRW:null,nationalTaxKRW:complete?tax.nationalKRW:null,localTaxKRW:complete?tax.localKRW:null,estimatedTaxKRW:complete?tax.totalKRW:null,knownRecordsTaxKRW:knownTax?.totalKRW??null,rate:RATE,sales:yearSales.length,unknownSales:yearSales.length-known.length,complete,result};
}
// The change in the year's liability if a further gain (negative: a loss) is realized in the same year; null when the
// year is incomplete. A negative change is a possible reduction of the annual liability, not cash from the broker.
function marginalTax(annual,gainKRW){
  if(annual?.totalKRW==null||!Number.isFinite(gainKRW))return null;const {overseasGainsTax}=require('./tax-rules.cjs');
  return overseasGainsTax(annual.totalKRW+gainKRW,annual.year).totalKRW-overseasGainsTax(annual.totalKRW,annual.year).totalKRW;
}
module.exports={buildLedger,annualTax,marginalTax,estimatedSettlement,DEDUCTION_KRW,RATE};
