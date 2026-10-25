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
// Trades replay in execution order: by trade date, opening lots first, then by time where it is known (timeKnown:
// the app's own orders, and broker rows matched to them). When a day holds both buys and sales of a symbol and their
// order is not known, the result depends on that order: those sales, and the pool's cost from then on, are unknown
// rather than computed under an assumed order. Fees: null means unknown (the amounts are then unknown); an estimated
// fee (feesSource other than Broker) is used and reported as an assumption.
function buildLedger({fills,rateOn,userBasis={},method='moving-average',openingLots=[],today=null,krClosed=new Set()}){
  if(!['moving-average','fifo'].includes(method))throw new Error('INVALID_METHOD');
  const pools=new Map(),sales=[],purchases=[];const pool=symbol=>{if(!pools.has(symbol))pools.set(symbol,{lots:[]});return pools.get(symbol);};
  const timeKnown=f=>f.timeKnown??(Number.isFinite(f.timestamp)&&f.timestamp>0);
  const unordered=new Set();const byDay=new Map();for(const f of fills){const k=f.symbol+'|'+f.tradeDate;if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(f);}
  for(const [k,rows] of byDay)if(rows.some(r=>r.side==='Buy')&&rows.some(r=>r.side==='Sell')&&rows.some(r=>!timeKnown(r)))unordered.add(k);
  const entries=[...openingLots.map(l=>({kind:'opening',day:l.acquiredOn,rank:0,order:0,lot:l})),...fills.map((f,n)=>({kind:'fill',day:f.tradeDate,rank:1,order:timeKnown(f)?f.timestamp:0,n,fill:f}))]
    .sort((a,b)=>a.day.localeCompare(b.day)||a.rank-b.rank||a.order-b.order||(a.n??0)-(b.n??0));
  const lastOf=new Map();entries.forEach((e,n)=>{if(e.fill)lastOf.set(e.fill.symbol+'|'+e.fill.tradeDate,n);});
  for(const [index,entry] of entries.entries()){
    if(entry.kind==='opening'){const l=entry.lot;pool(l.symbol).lots.push({quantity:l.quantity,costKRW:l.costKRW,costUSD:l.costUSD??null,date:l.acquiredOn,source:'Opening lot',expensesIncluded:l.expensesIncluded!==false});continue;}
    const fill=entry.fill;const settlementDate=fill.settlementDate??estimatedSettlement(fill.tradeDate,{krClosed});const gross=fill.quantity*fill.price,fees=fill.feesUSD;
    let fx=rateOn(settlementDate);if(!fx&&fill.exchangeRate&&(!today||settlementDate>=today))fx={rate:fill.exchangeRate,source:'Broker registered rate (provisional)',provisional:true};
    const usd=fees==null?null:fill.side==='Buy'?gross+fees:gross-fees,amountKRW=fx?.rate&&usd!=null?round(usd*fx.rate):null;
    const missing=[...(fees==null?[`${fill.side==='Buy'?'purchase':'sale'} fees of ${fill.tradeDate}`]:[]),...(!fx?.rate?[`exchange rate for settlement on ${settlementDate}`]:[])];
    const evidence={brokerKRW:fill.settlementKRW!=null?Math.abs(fill.settlementKRW):null,brokerRate:fill.exchangeRate??null};
    const flags={settlementEstimated:!fill.settlementDate,rateProvisional:Boolean(fx?.provisional),fxSource:fx?.source??'Rate unavailable',taxRate:fx?.rate??null,feesEstimated:fees!=null&&fill.feesSource!=='Broker',...evidence};
    const key=fill.symbol+'|'+fill.tradeDate,p=pool(fill.symbol);
    if(fill.side==='Buy'){
      p.lots.push({quantity:fill.quantity,costKRW:amountKRW,costUSD:usd,date:fill.tradeDate,source:fill.source??'Trade',expensesIncluded:fees!=null,feesEstimated:flags.feesEstimated,...(missing.length?{unknownReason:missing.join(', ')}:{})});
      purchases.push({id:fill.id,symbol:fill.symbol,settlementDate,quantity:fill.quantity,costKRW:amountKRW,missing,...flags});
    }else{
      // Shares sold beyond the pool use the user-entered per-share basis, otherwise the gain is unknown.
      const d=dispose(p.lots,fill.quantity,method);p.lots=d.lots;let costKRW=d.costKRW??0,known=d.known;
      let basisSource=d.taken?(d.used.some(l=>l.source==='Opening lot')?'Records + opening lots':'Records'):'Entered basis';
      if(d.outside>0){if(userBasis[fill.symbol]!=null){costKRW+=userBasis[fill.symbol]*d.outside;basisSource=d.taken?'Records + entered basis':'Entered basis';}else{known=false;basisSource='Unknown basis';missing.push(`acquisition basis for ${d.outside} share(s)`);}}
      if(!d.known)missing.push(...new Set(d.used.filter(l=>l.costKRW==null).map(l=>l.unknownReason??'acquisition cost of an earlier purchase')));
      if(unordered.has(key)){known=false;missing.push(`order of same-day buys and sales on ${fill.tradeDate}`);}
      const gainKRW=known&&amountKRW!=null?round(amountKRW-costKRW):null;
      sales.push({id:fill.id,symbol:fill.symbol,tradeDate:fill.tradeDate,settlementDate,year:Number(settlementDate.slice(0,4)),quantity:fill.quantity,proceedsKRW:amountKRW,costKRW:known?round(costKRW):null,gainKRW,basisSource,feesSource:fill.feesSource??'Estimated',expensesExcluded:d.used.some(l=>l.expensesIncluded===false),missing:[...new Set(missing)],...flags,feesEstimated:flags.feesEstimated||d.used.some(l=>l.feesEstimated)});
    }
    // After a day whose order is unknown, the pool's remaining cost depends on that order.
    if(unordered.has(key)&&lastOf.get(key)===index)p.lots=p.lots.map(l=>({...l,costKRW:null,costUSD:null,unknownReason:`order of same-day buys and sales on ${fill.tradeDate}`}));
  }
  const positions=Object.fromEntries([...pools].map(([symbol,p])=>{const qty=p.lots.reduce((n,l)=>n+l.quantity,0);if(!qty)return null;const known=p.lots.every(l=>l.costKRW!=null),cost=p.lots.reduce((n,l)=>n+(l.costKRW??0),0);
    return [symbol,{quantity:qty,costKRW:known?round(cost):null,perShareKRW:known?Math.round(cost/qty*100)/100:null,lots:p.lots.map(l=>({...l}))}];}).filter(Boolean));
  return {method,sales,purchases,positions};
}
// The basis of a hypothetical sale from a position's lots, by the same disposal rule as the ledger (the ledger is not
// changed). Null position: no lots recorded.
function quoteDisposal(position,quantity,method){return dispose(position?.lots??[],quantity,method);}
// The year's overseas capital-gains tax for the taxpayer. The full liability needs every sale's basis and the gains
// realized at other brokers; when one is missing the liability is null (incomplete), and the known-record figures are
// a labeled subtotal, not a bound (a missing sale may be a loss). The basic deduction is capped: losses beyond it are
// reported separately as offset capacity for further gains in the same year, never as a refund or a carryforward.
// applicability: from tax-profile.cjs, for the accounts in the ledger.
// issues: record problems found before the ledger (broker and app records that do not match), each a missing input.
function annualTax(ledger,year,outsideKRW=null,{applicability=null,asOf=Date.now(),issues=[]}={}){
  const {overseasGainsTax,taxResult,ROUNDING}=require('./tax-rules.cjs');
  const yearSales=ledger.sales.filter(s=>s.year===year),known=yearSales.filter(s=>s.gainKRW!=null),appKRW=known.reduce((n,s)=>n+s.gainKRW,0);
  const knownTotal=appKRW+(outsideKRW??0);const missing=[];if(outsideKRW==null)missing.push('gains realized at other brokers this year (enter 0 if none)');if(known.length<yearSales.length)missing.push(...new Set(yearSales.filter(s=>s.gainKRW==null).flatMap(s=>s.missing?.length?s.missing:['acquisition basis or exchange rate'])));missing.push(...issues);
  const noRule=!overseasGainsTax(0,year);const unsupported=applicability?.status==='unsupported'||noRule;const complete=!missing.length&&!unsupported;
  const assumptions=[...(applicability?.assumptions??[]),ROUNDING,...(yearSales.some(s=>s.settlementEstimated)?['settlement dates estimated where the broker has not reported them']:[]),...(yearSales.some(s=>s.feesEstimated)?['fees estimated from the fee plan where the broker has not reported them']:[])];
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
