// Korean capital-gains ledger for overseas shares, per account. Gains are in KRW: acquisition cost = (price x quantity +
// fees) and proceeds = (price x quantity - fees), each at the reference rate (first published USD/KRW base rate) on the
// settlement date, as KIS describes for the tax. The broker's KRW settlement amount and registered rate are cash
// settlement evidence, kept beside the tax figures but never used as them: KIS fixes them before the settlement-date
// rate is published. Until that rate exists (a future settlement), the broker rate stands in, flagged provisional.
// Realization follows the settlement date (the tax year of a late-December sale can be the next year).
const DEDUCTION_KRW=2500000,RATE=0.22;// 20% national + 2% local income tax
const round=n=>Math.round(n);const {dispose}=require('./tax-lots.cjs');
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const usBusinessDay=day=>require('./kis-overseas.cjs').usSession(new Date(day+'T16:00:00Z')).open;
// U.S. trades settle T+1 U.S. business days (T+2 before 2024-05-28); the KRW settlement then falls on that date or the
// next Korean business day. An estimate: the broker's settlement date replaces it once reported.
function estimatedSettlement(tradeDate,{krClosed=new Set()}={}){
  let d=tradeDate,n=tradeDate>='2024-05-28'?1:2;while(n>0){d=addDays(d,1);if(usBusinessDay(d))n--;}
  while([0,6].includes(new Date(d+'T00:00:00Z').getUTCDay())||krClosed.has(d))d=addDays(d,1);return d;
}
// fills: [{id,symbol,side,quantity,price,feesUSD,tradeDate,settlementDate?,settlementKRW?,exchangeRate?,feesSource,source?}]
// rateOn(day) -> {rate,day,source}|null: the reference rate for the day (or the last one before a non-publication day).
// openingLots: [{id,symbol,quantity,acquiredOn,costKRW,costUSD?,expensesIncluded,source}] for shares acquired before
// the records (entered by the user); they join the pool in date order. userBasis: {symbol: KRW per share}, the older
// per-share fallback for shares sold beyond the pool. today: dates on or after it may use the provisional broker rate.
function buildLedger({fills,rateOn,userBasis={},method='moving-average',openingLots=[],today=null,krClosed=new Set()}){
  if(!['moving-average','fifo'].includes(method))throw new Error('INVALID_METHOD');
  const pools=new Map(),sales=[],purchases=[];const pool=symbol=>{if(!pools.has(symbol))pools.set(symbol,{lots:[]});return pools.get(symbol);};
  // Within a day: opening lots, then buys, then sales (broker rows carry no time of day), then time where known.
  const rank=e=>e.kind==='opening'?0:e.fill.side==='Buy'?1:2;
  const entries=[...openingLots.map(l=>({kind:'opening',day:l.acquiredOn,order:-1,lot:l})),...fills.map(f=>({kind:'fill',day:f.tradeDate,order:f.timestamp??0,fill:f}))].sort((a,b)=>a.day.localeCompare(b.day)||rank(a)-rank(b)||a.order-b.order);
  for(const entry of entries){
    if(entry.kind==='opening'){const l=entry.lot;pool(l.symbol).lots.push({quantity:l.quantity,costKRW:l.costKRW,costUSD:l.costUSD??null,date:l.acquiredOn,source:'Opening lot',expensesIncluded:l.expensesIncluded!==false});continue;}
    const fill=entry.fill;const settlementDate=fill.settlementDate??estimatedSettlement(fill.tradeDate,{krClosed});const gross=fill.quantity*fill.price,fees=fill.feesUSD??0;
    let fx=rateOn(settlementDate);if(!fx&&fill.exchangeRate&&(!today||settlementDate>=today))fx={rate:fill.exchangeRate,source:'Broker registered rate (provisional)',provisional:true};
    const usd=fill.side==='Buy'?gross+fees:gross-fees,amountKRW=fx?.rate?round(usd*fx.rate):null;
    const evidence={brokerKRW:fill.settlementKRW!=null?Math.abs(fill.settlementKRW):null,brokerRate:fill.exchangeRate??null};
    const flags={settlementEstimated:!fill.settlementDate,rateProvisional:Boolean(fx?.provisional),fxSource:fx?.source??'Rate unavailable',taxRate:fx?.rate??null,...evidence};
    if(fill.side==='Buy'){
      pool(fill.symbol).lots.push({quantity:fill.quantity,costKRW:amountKRW,costUSD:fill.feesUSD==null?null:usd,date:fill.tradeDate,source:fill.source??'Trade',expensesIncluded:fill.feesUSD!=null});
      purchases.push({id:fill.id,symbol:fill.symbol,settlementDate,quantity:fill.quantity,costKRW:amountKRW,...flags});continue;
    }
    // Shares sold beyond the pool use the user-entered per-share basis, otherwise the gain is unknown.
    const p=pool(fill.symbol),d=dispose(p.lots,fill.quantity,method);p.lots=d.lots;let costKRW=d.costKRW??0,known=d.known;
    let basisSource=d.taken?(d.used.some(l=>l.source==='Opening lot')?'Records + opening lots':'Records'):'Entered basis';
    if(d.outside>0){if(userBasis[fill.symbol]!=null){costKRW+=userBasis[fill.symbol]*d.outside;basisSource=d.taken?'Records + entered basis':'Entered basis';}else{known=false;basisSource='Unknown basis';}}
    const gainKRW=known&&amountKRW!=null?round(amountKRW-costKRW):null;
    sales.push({id:fill.id,symbol:fill.symbol,tradeDate:fill.tradeDate,settlementDate,year:Number(settlementDate.slice(0,4)),quantity:fill.quantity,proceedsKRW:amountKRW,costKRW:known?round(costKRW):null,gainKRW,basisSource,feesSource:fill.feesSource??'Estimated',expensesExcluded:d.used.some(l=>l.expensesIncluded===false),...flags});
  }
  const positions=Object.fromEntries([...pools].map(([symbol,p])=>{const qty=p.lots.reduce((n,l)=>n+l.quantity,0);if(!qty)return null;const known=p.lots.every(l=>l.costKRW!=null),cost=p.lots.reduce((n,l)=>n+(l.costKRW??0),0);
    return [symbol,{quantity:qty,costKRW:known?round(cost):null,perShareKRW:known?Math.round(cost/qty*100)/100:null,lots:p.lots.map(l=>({...l}))}];}).filter(Boolean));
  return {method,sales,purchases,positions};
}
// The basis of a hypothetical sale from a position's lots, by the same disposal rule as the ledger (the ledger is not
// changed). Null position: no lots recorded.
function quoteDisposal(position,quantity,method){return dispose(position?.lots??[],quantity,method);}
// The year's overseas capital-gains tax for the taxpayer. The full liability needs every sale's basis and the gains
// realized outside this app; when one is missing the liability is null (incomplete), and the known-record figures are
// a labeled subtotal, not a bound (a missing sale may be a loss). The basic deduction is capped: losses beyond it are
// reported separately as offset capacity for further gains in the same year, never as a refund or a carryforward.
// applicability: from tax-profile.cjs, for the accounts in the ledger.
function annualTax(ledger,year,outsideKRW=null,{applicability=null,asOf=Date.now()}={}){
  const {overseasGainsTax,taxResult,ROUNDING}=require('./tax-rules.cjs');
  const yearSales=ledger.sales.filter(s=>s.year===year),known=yearSales.filter(s=>s.gainKRW!=null),appKRW=known.reduce((n,s)=>n+s.gainKRW,0);
  const knownTotal=appKRW+(outsideKRW??0);const missing=[];if(outsideKRW==null)missing.push('gains realized outside this app this year');if(known.length<yearSales.length)missing.push(`acquisition basis or exchange rate for ${yearSales.length-known.length} sale(s)`);
  const noRule=!overseasGainsTax(0,year);const unsupported=applicability?.status==='unsupported'||noRule;const complete=!missing.length&&!unsupported;
  const assumptions=[...(applicability?.assumptions??[]),ROUNDING,...(yearSales.some(s=>s.settlementEstimated)?['settlement dates estimated where the broker has not reported them']:[])];
  const tax=overseasGainsTax(complete?knownTotal:0,year),knownTax=overseasGainsTax(knownTotal,year);
  const result=taxResult({status:unsupported?'unsupported':complete?'estimated':'incomplete',value:tax?.totalKRW??null,knownSubtotal:knownTax?.totalKRW??null,missingInputs:[...missing,...(applicability?.reasons??[]),...(noRule?[`tax rules for ${year} are not implemented`]:[])],assumptions,taxYear:year,asOf,sourceIds:tax?.sources??[]});
  return {year,appRealizedKRW:appKRW,outsideKRW,knownTotalKRW:knownTotal,totalKRW:complete?knownTotal:null,deductionKRW:DEDUCTION_KRW,deductionRemainingKRW:complete?Math.max(0,DEDUCTION_KRW-Math.max(0,knownTotal)):null,lossOffsetKRW:complete?Math.max(0,-knownTotal):null,
    taxableKRW:complete?tax.taxableKRW:null,nationalTaxKRW:complete?tax.nationalKRW:null,localTaxKRW:complete?tax.localKRW:null,estimatedTaxKRW:complete?tax.totalKRW:null,knownRecordsTaxKRW:knownTax?.totalKRW??null,rate:RATE,sales:yearSales.length,unknownSales:yearSales.length-known.length,complete,result};
}
// The change in the year's liability if a further gain (negative: a loss) is realized in the same year; null when the
// year is incomplete. A negative change is a possible reduction of the annual liability, not cash from the broker.
function marginalTax(annual,gainKRW){
  if(annual?.totalKRW==null||!Number.isFinite(gainKRW))return null;const {overseasGainsTax}=require('./tax-rules.cjs');
  const after=overseasGainsTax(annual.totalKRW+gainKRW,annual.year),before=overseasGainsTax(annual.totalKRW,annual.year);return after&&before?after.totalKRW-before.totalKRW:null;
}
module.exports={buildLedger,annualTax,marginalTax,quoteDisposal,estimatedSettlement,usBusinessDay,DEDUCTION_KRW,RATE};
