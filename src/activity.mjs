// Totals of one currency's orders (2026-11-18, artifacts/reviews/2026-11-18-activity-tab step 1). KIS gives a revised or
// cancelled order its own row with its own fills, so every row's executed amount is summed; a corrected order no longer
// hides the totals. Left out, and counted: a chain the app knows whose rows fill more than its order (chainOverfill,
// electron/activity-chains.cjs). A side with an executed row whose amount KIS did not report has no total (null), with
// the count, never a zero or a guess.
export function executionSummary(orders) {
  // Corrected rows counted in the totals only: a chain left out is said once, as not included.
  const corrected=orders.filter(order=>order.originalOrderId&&!order.chainOverfill).length;
  const excluded=new Set(orders.filter(order=>order.chainOverfill).map(order=>order.chainId??order.orderId)).size;
  const executed=orders.filter(order=>!order.chainOverfill&&order.filled>0);
  const side=name=>{const rows=executed.filter(order=>order.side===name),missing=rows.filter(order=>!Number.isFinite(order.executionAmount)).length;
    return {total:missing?null:rows.reduce((sum,order)=>sum+order.executionAmount,0),missing};};
  const b=side('Buy'),s=side('Sell');
  return {orderCount:orders.length,executedOrders:executed.length,corrected,excluded,buy:b.total,sell:s.total,grossFlow:b.total==null||s.total==null?null:s.total-b.total,missing:{buy:b.missing,sell:s.missing}};
}
export function dailyRealized(records) {
  const days=new Map();
  for(const row of records)days.set(row.timestamp,(days.get(row.timestamp)??0)+row.realized);
  let cumulative=0;
  return [...days].sort((a,b)=>a[0]-b[0]).map(([timestamp,realized])=>({timestamp,realized,cumulative:cumulative+=realized}));
}
export function seoulDate(now=Date.now()) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const value=type=>parts.find(part=>part.type===type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
// The side as Activity shows it: a short sale and its cover by KIS's kind name (creditName, found in live use: they read
// as a plain sale and purchase), otherwise Buy or Sell.
// The Side filter (B3f-1): Short and Cover by the same names; Buy and Sell are every other order.
export function sideKind(order){const l=sideLabel(order);return l==='공매도'?'Short':l==='공매도 상환'?'Cover':order?.side??'';}
export function sideLabel(order){const n=String(order?.creditName??'');if(n.includes('유대신규')||n.includes('대주매도')||n.includes('유대매도'))return '공매도';if(n.includes('유대상환')||n.includes('대주상환'))return '공매도 상환';return order?.side??'';}
