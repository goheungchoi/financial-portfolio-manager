// U.S. buys paid through integrated margin are funded in KRW at settlement. Until then KIS keeps the KRW in the Korean
// deposit and settled cash while the shares already count in the U.S. balance, so adding the two counts that money
// twice. KIS reports the amount still to be settled (ustl_buy_amt_smtl, in KRW) in the U.S. present balance, but not
// how it is funded: USD cash may have paid for some or all of it. Two figures are kept apart:
// - confirmedKRW: the part known to be KRW-funded (FundingTracker below), a real obligation of Korean cash. Only this
//   part may be used to explain cash movements, so deposits, withdrawals and transfers are never inferred from a guess.
// - uncertainKRW: the rest, until settlement reconciles it. Valuation still subtracts the full unsettled amount (the
//   lower, conservative figure) and reports that equity may be understated by up to the uncertain part.
function settlement(us){
  const u=us?.unsettled;if(!u)return {unsettledKRW:0,confirmedKRW:0,uncertainKRW:0};
  const total=Math.max(0,(Number(u.buyKRW)||0)-(Number(u.sellKRW)||0));const known=Math.min(total,Math.max(0,Number(u.krwFundedKRW)||0));
  return {unsettledKRW:total,confirmedKRW:known,uncertainKRW:total-known};
}
const confirmedKRW=us=>settlement(us).confirmedKRW;
// Readings further apart than this cannot show what USD cash was just before a purchase.
const FRESH_MS=15*60000;
// The part of the unsettled amount known to be KRW-funded, from consecutive U.S. balance readings. A new unsettled
// amount is KRW-funded only beyond the USD cash held just before it (a fresh previous reading, with no USD arriving in
// between): USD cash remaining after a purchase does not bound how much USD paid for it. Without a fresh previous
// reading the funding is unknown. As purchases settle, the uncertain part is assumed to remain until it is gone.
function fundingStep(prev,reading,fx){
  const {at,usCash,unsettledKRW:total}=reading;const out=krw=>({at,usCash,unsettledKRW:total,krwFundedKRW:Math.max(0,Math.min(total,Math.floor(krw)))});
  if(!(total>0))return out(0);if(!prev||!Number.isFinite(prev.unsettledKRW))return out(0);
  const prevKnown=prev.krwFundedKRW??0;
  if(total<=prev.unsettledKRW)return out(total-(prev.unsettledKRW-prevKnown));
  const added=total-prev.unsettledKRW;const fresh=at-prev.at<=FRESH_MS&&Number.isFinite(prev.usCash)&&Number.isFinite(usCash);
  if(!fresh||usCash>prev.usCash+0.01)return out(prevKnown);
  // Up to the USD held before (with 2% for the exchange rate) may have paid; without a rate, any USD makes it unknown.
  const usdKRW=prev.usCash>0?(fx>0?prev.usCash*fx*1.02:Infinity):0;
  return out(prevKnown+Math.max(0,added-usdKRW));
}
class FundingTracker {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS settlement_funding(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  // Adds unsettled.krwFundedKRW to a U.S. balance read from KIS, in place, and returns it.
  annotate(balance,fx){
    if(typeof balance?.accountKey!=='string'||!balance.unsettled)return balance;
    const total=Math.max(0,(Number(balance.unsettled.buyKRW)||0)-(Number(balance.unsettled.sellKRW)||0));
    const row=this.db.prepare('SELECT payload FROM settlement_funding WHERE account=?').get(balance.accountKey);
    const next=fundingStep(row?JSON.parse(row.payload):null,{at:this.clock(),usCash:Number.isFinite(balance.cash)?balance.cash:null,unsettledKRW:total},fx);
    this.db.prepare('INSERT INTO settlement_funding VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(balance.accountKey,JSON.stringify(next));
    balance.unsettled={...balance.unsettled,krwFundedKRW:next.krwFundedKRW};return balance;
  }
}
module.exports={settlement,confirmedKRW,fundingStep,FundingTracker,FRESH_MS};
