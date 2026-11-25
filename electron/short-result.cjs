// A covered short's realized result (B3d-3 part 2), from the app's own orders only:
//   realized = proceeds - buy-back - sale fees and tax - cover fees - borrow interest.
// The cover is matched to the app's short sales of its own lot (account, stock, KIS's loan date), never by stock and
// time alone. The proceeds and the short sale's charges are the lot's, pro rata to the shares this cover buys back,
// after the lot's earlier covers. A lot the app did not wholly sell short (its covers exceed the app's short shares),
// or a short sale or cover without its charges, gives gaps and no result, never a guess.
// Borrow interest: KIS's figure once the cover carries it (borrowInterest {amount, source}); until then an estimate at
// the fee rate recorded on the short sale when it was made (borrowFeePct), proceeds x rate x days / 365, days the
// calendar days from the short's trade day to the cover's, at least 1. Inferred from B2 (a same-day cover was charged
// about one day); B4 checks it. A rate outside the setting's range (0.1-30 %), a negative KIS figure, or a cover dated
// before its short sale gives a gap, never a number.
// The parts of a lot are cut by cumulative rounding (each cover takes round(whole x covered-so-far) less what the
// earlier covers took), so the covers of a lot always sum to the whole: the last takes the remainder.
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const FEE_RANGE=[0.1,30];
const DAY=86400000;
const calendarDays=(a,b)=>Math.round((Date.parse(String(b)+'T00:00:00Z')-Date.parse(String(a)+'T00:00:00Z'))/DAY);
const charges=o=>{const c=o?.resultCosts;return c&&finite(c.commission)&&finite(c.transactionTax)?c.commission+c.transactionTax:null;};
const isShort=o=>o?.credit?.kind==='short'&&o.side==='Sell';
const isCover=o=>o?.credit?.kind==='cover'&&o.side==='Buy';
function interestDays(fromDay,toDay){const d=calendarDays(fromDay,toDay);return Number.isFinite(d)?Math.max(1,d):null;}
function shortResult(cover,orders){
  const gaps=[];
  if(!isCover(cover)||!(cover.filled>0))return null;
  const loanDate=cover.credit.loanDate??null;if(!loanDate)return {gaps:['Credit lot identity unknown']};
  const sameLot=o=>o.accountKey===cover.accountKey&&o.symbol===cover.symbol&&o.filled>0;
  const shorts=orders.filter(o=>isShort(o)&&sameLot(o)&&(o.lotTie?.loanDate??o.lotLoanDate)===loanDate);// stage 2d: the recorded tie first
  if(!shorts.length)return {gaps:['Short-sale proceeds of the covered lot unavailable']};
  const covers=orders.filter(o=>isCover(o)&&sameLot(o)&&o.credit.loanDate===loanDate).sort((a,b)=>(a.createdAt??0)-(b.createdAt??0)||String(a.id).localeCompare(String(b.id)));
  const before=covers.slice(0,Math.max(0,covers.findIndex(o=>o.id===cover.id))).reduce((n,o)=>n+o.filled,0);
  const sold=shorts.reduce((n,o)=>n+o.filled,0),qty=cover.filled;
  if(before+qty>sold)return {gaps:['The covered lot holds shares the app did not sell short']};
  if(!shorts.every(o=>finite(o.fillPrice)))return {gaps:['Short-sale execution price unavailable']};
  const part=whole=>Math.round(whole*(before+qty)/sold)-Math.round(whole*before/sold),gross=shorts.reduce((n,o)=>n+o.filled*o.fillPrice,0);
  const shortProceeds=part(gross);
  const saleAll=shorts.map(charges);const saleCharges=saleAll.every(finite)?part(saleAll.reduce((n,c)=>n+c,0)):null;if(saleCharges==null)gaps.push('Short-sale charges unavailable');
  const coverCharges=charges(cover);if(coverCharges==null)gaps.push('Cover charges unavailable');
  const buyBack=finite(cover.fillPrice)?Math.round(qty*cover.fillPrice):null;if(buyBack==null)gaps.push('Execution price unavailable');
  const first=shorts.map(o=>o.day).filter(Boolean).sort()[0];if(first&&cover.day&&String(cover.day)<first)gaps.push('Cover dated before its short sale');
  // The interest: KIS's figure when the cover carries it, else the estimate.
  let interest=null;const reported=cover.borrowInterest;
  if(reported&&reported.amount!=null&&!(finite(reported.amount)&&reported.amount>=0))gaps.push('KIS borrow interest figure is negative or unreadable');
  else if(reported&&finite(reported.amount))interest={amount:Math.round(reported.amount),basis:'broker',source:String(reported.source??'KIS').slice(0,80)};
  else{const pct=shorts.map(o=>o.borrowFeePct);const days=first&&cover.day?interestDays(first,cover.day):null;
    if(!pct.every(finite)||new Set(pct).size!==1)gaps.push('Borrow fee rate unavailable');else if(pct[0]<FEE_RANGE[0]||pct[0]>FEE_RANGE[1])gaps.push("Borrow fee rate outside the setting's range");
    else if(days==null)gaps.push('Borrow period unavailable');
    else interest={amount:Math.round(shortProceeds*pct[0]/100*days/365),basis:'estimate',pct:pct[0],days};}
  // A cover dated before its short sale: no estimate is made from a negative period (the gap is named above).
  if(interest?.basis==='estimate'&&gaps.includes('Cover dated before its short sale'))interest=null;
  const realized=gaps.length?null:shortProceeds-buyBack-saleCharges-coverCharges-interest.amount;
  const beforeCharges=buyBack==null?null:shortProceeds-buyBack;
  const brokerFees=shorts.every(o=>o.resultCosts?.basis==='broker')&&cover.resultCosts?.basis==='broker';
  return {loanDate,quantity:qty,shortProceeds,entryPrice:Math.round(gross/sold*100)/100,buyBack,saleCharges,coverCharges,interest,beforeCharges,realized,
    costBasis:brokerFees&&interest?.basis==='broker'?'broker':'estimated',shortOrderIds:shorts.map(o=>o.id),gaps};
}
module.exports={shortResult,interestDays,calendarDays,FEE_RANGE};
