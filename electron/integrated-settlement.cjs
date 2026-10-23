// U.S. buys paid through integrated margin are funded in KRW at settlement. Until then KIS keeps the KRW in the Korean
// deposit and settled cash while the shares already count in the U.S. balance, so adding the two counts that money
// twice. KIS reports the amount still to be settled (ustl_buy_amt_smtl, in KRW) in the U.S. present balance; net of
// unsettled sales it is subtracted from Korean cash. When the U.S. account also holds USD cash, KIS does not say how much
// of the purchase that cash paid for: the full amount is still subtracted (the lower, conservative valuation) and the
// part that USD cash could have covered is reported as uncertain rather than assumed away.
function settlement(us){
  const u=us?.unsettled;if(!u)return {committedKRW:0,uncertainKRW:0};
  const committed=Math.max(0,(Number(u.buyKRW)||0)-(Number(u.sellKRW)||0));const usd=Number(us.cash)>0?Number(us.cash):0;
  const fx=Number(us.fx?.usdKRW)>0?Number(us.fx.usdKRW):null;
  // With USD cash on hand the funding split is unknown: up to the USD cash value (or all of it without a rate) may not be KRW.
  const uncertain=committed&&usd?Math.round(Math.min(committed,fx?usd*fx:committed)):0;
  return {committedKRW:committed,uncertainKRW:uncertain};
}
const committedKRW=us=>settlement(us).committedKRW;
module.exports={committedKRW,settlement};
