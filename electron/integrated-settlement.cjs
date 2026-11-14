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
// C1c (settlement clean-up, W5): the Korean value nets the KRW KIS holds for unsettled U.S. buys, and that amount comes
// only from the U.S. reading. While the U.S. balance is not loaded (a failed refresh), may such a buy be awaiting
// settlement? Yes when any of these holds, and then the day's record waits (a gap, never a wrong record):
// (a) the last stored U.S. reading of the account reported a U.S. buy amount awaiting settlement (ustl_buy_amt_smtl);
// (b) the settlement tracker holds a U.S. buy in flight;
// (c) a U.S. buy of the account filled after that reading, or within the last SETTLE_DAYS U.S. business days, or at a
//     time not known;
// (d) no U.S. reading is stored while the account has U.S. orders.
// lastUS: {at, raw} (electron/broker-raw.cjs list); openBuysUSD: the tracker's buys in flight; orders: the account's
// U.S. order records. Returns {open, reasons}.
function usFundingMayBeOpen({lastUS=null,openBuysUSD=0,orders=[],now=Date.now()}={}){
  const B=require('./business-days.cjs');const reasons=[];
  if(lastUS&&Number(lastUS.raw?.summary?.ustl_buy_amt_smtl)>0)reasons.push('the last U.S. reading reported a U.S. buy awaiting settlement');
  if(Number(openBuysUSD)>0.005)reasons.push('the settlement tracker holds a U.S. buy in flight');
  const filledAt=o=>Number.isFinite(o.filledObservedAt)?o.filledObservedAt:Number.isFinite(o.createdAt)?o.createdAt:null;
  if(orders.some(o=>o?.side==='Buy'&&o.filled>0&&(t=>t==null||lastUS&&t>lastUS.at||!B.agedOut('US',{fillAt:t,now,n:B.SETTLE_DAYS}).aged)(filledAt(o))))reasons.push('a U.S. buy filled since the last U.S. reading or within 3 U.S. business days');
  if(!lastUS&&orders.length)reasons.push('no U.S. reading is stored while the account has U.S. orders');
  return {open:reasons.length>0,reasons};
}
module.exports={settlement,confirmedKRW,fundingStep,FundingTracker,FRESH_MS,usFundingMayBeOpen};
