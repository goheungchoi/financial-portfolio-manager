export function executionSummary(orders) {
  const ambiguous=orders.some(order=>order.originalOrderId);
  const executed=orders.filter(order=>order.filled>0);
  const buy=executed.filter(order=>order.side==='Buy').reduce((sum,order)=>sum+order.executionAmount,0);
  const sell=executed.filter(order=>order.side==='Sell').reduce((sum,order)=>sum+order.executionAmount,0);
  return {orderCount:orders.length,executedOrders:executed.length,ambiguous,buy:ambiguous?null:buy,sell:ambiguous?null:sell,grossFlow:ambiguous?null:sell-buy};
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
