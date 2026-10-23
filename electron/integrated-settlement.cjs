// U.S. buys paid through integrated margin are funded in KRW at settlement. Until then KIS keeps the KRW in the Korean
// deposit and settled cash while the shares already count in the U.S. balance, so adding the two counts that money
// twice. KIS reports the amount still to be settled (ustl_buy_amt_smtl, in KRW) in the U.S. present balance; it is the
// KRW committed to those buys. Unsettled sales are the reverse. Applied only when the U.S. account holds no USD cash,
// since a buy paid from USD cash may already be out of that cash.
function committedKRW(us){
  const u=us?.unsettled;if(!u)return 0;if(Number(us.cash)>0)return 0;
  return Math.max(0,(Number(u.buyKRW)||0)-(Number(u.sellKRW)||0));
}
module.exports={committedKRW};
