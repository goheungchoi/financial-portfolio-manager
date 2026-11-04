const finite=v=>typeof v==='number'&&Number.isFinite(v);
const terminal=new Set(['Filled','Canceled','Cancelled','Risk stopped','Rejected']);
// An outcome's position effect (electron/credit-paths.cjs): 'unknown' for a credit repayment without its lot, so it is
// never matched by symbol alone or guessed. Outcomes recorded before credit identity was kept are cash trades unless
// they carry credit.
function effectOf({side,credit=null}){if(credit&&['margin-sell','cover'].includes(credit.kind)&&!credit.loanDate)return 'unknown';try{return require('./credit-paths.cjs').effectOf({side,credit}).effect;}catch{return 'unknown';}}
function evaluate(outcome){
  const effect=outcome.effect??effectOf(outcome);
  // An exit realizes a result: a long sold (cash or a margin repayment) or a short covered. Opening a short is a sale
  // that realizes nothing; a cover realizes against its own short lot, which the record must carry (shortProceeds).
  if(effect==='unknown'||effect==='OPEN_SHORT'||effect==='CLOSE_SHORT'){const gaps=effect==='unknown'?['Credit lot identity unknown']:effect==='CLOSE_SHORT'&&!finite(outcome.shortProceeds)?['Short-sale proceeds of the covered lot unavailable']:[];
    const category=outcome.status==='Retracted'?'retracted':effect==='OPEN_SHORT'?'entry':'data-gap';
    return {version:2,effect,category,complete:terminal.has(outcome.status)&&outcome.quantity>0,eligible:false,exit:effect==='CLOSE_SHORT',currency:outcome.currency,basis:null,gaps,
      recommendation:category==='entry'?'A short sale opens a position: wait for its cover before evaluating a result.':category==='retracted'?'The source no longer reports this fill. Previous lessons must not be used.':'Resolve the credit lot and its proceeds before drawing a conclusion.'};}
  const sale=effect==='CLOSE_LONG';const complete=terminal.has(outcome.status)&&outcome.quantity>0;
  const basis=sale&&finite(outcome.netCash)&&finite(outcome.gainAfterFees)?outcome.netCash-outcome.gainAfterFees:null;
  const beforeExitCharges=sale&&finite(outcome.gainAfterFees)&&finite(outcome.fees)?outcome.gainAfterFees+outcome.fees:null;
  const gaps=[];
  if(!outcome.reviewId)gaps.push('No linked decision');
  if(!finite(outcome.averagePrice))gaps.push('Execution price unavailable');
  if(!finite(outcome.fees))gaps.push('Exit charges unavailable');
  if(sale&&!(basis>0))gaps.push('Acquisition basis unavailable');
  if(sale&&!finite(outcome.gainAfterEstimatedTax))gaps.push('After-tax result unavailable');
  if(!complete)gaps.push('Execution not final');
  const category=outcome.status==='Retracted'?'retracted':!sale?'entry':!complete?'pending':!finite(outcome.gainAfterFees)||!(basis>0)?'data-gap':beforeExitCharges>0&&outcome.gainAfterFees<=0?'cost-drag':outcome.gainAfterFees<0?'loss':outcome.gainAfterFees>0?'gain':'break-even';
  const recommendations={entry:'Wait for an exit before evaluating realized performance.',pending:'Wait for the remaining execution or cancellation to reconcile.',retracted:'The source no longer reports this fill. Previous lessons must not be used.','data-gap':'Resolve missing execution or acquisition-cost evidence before drawing a conclusion.','cost-drag':'Compare expected benefit against acquisition costs and exit charges before a similar trade.',loss:'Revisit the original thesis and conditions; an adverse outcome alone does not establish a mistake.',gain:'Check whether the thesis was supported before treating this outcome as repeatable.','break-even':'Check whether the exposure change justified the transaction costs.'};
  return {version:outcome.credit?2:1,effect,exit:sale,category,complete,eligible:sale&&complete&&outcome.status!=='Retracted',currency:outcome.currency,basis,basisMethod:outcome.source==='paper'?'Simulator weighted-average basis, including acquisition fees':outcome.costBasis==='broker'?'Implied from broker-reported net proceeds minus gain (acquisition fee estimated); not tax-lot accounting':'Implied from captured estimated net proceeds minus estimated gain; not tax-lot accounting',beforeExitCharges,netReturnPct:basis>0&&finite(outcome.gainAfterFees)?outcome.gainAfterFees/basis*100:null,exitCostDragPct:basis>0&&finite(outcome.fees)?outcome.fees/basis*100:null,confidence:outcome.costBasis==='simulated'?'Simulator accounting':outcome.costBasis==='broker'?'Broker-reported costs':outcome.costBasis==='estimated'?'Estimated costs':'Insufficient evidence',gaps,recommendation:recommendations[category],causalConclusion:'Unassessed',benchmark:null,holdingPeriod:null,validation:'Not replay-validated'};
}
module.exports={evaluate,effectOf};
