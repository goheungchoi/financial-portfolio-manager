'use strict';
// Facts for the review context about orders made outside the app (found in live use: after a sale in KIS's own app the
// review still saw the app's entry thesis and stop for shares that were gone, a plan gap that read as "below target", and
// a protective level that had become an entry level). Facts only, in self-describing fields: no instruction about what to
// do with them (the user's buy-back block is enforced by the app, not asked of the model). The app's own records are
// never changed: position memory, which the reversal check reads, keeps the app's entries and exits; outside trades go
// in fields of their own.
// data: {trades: [{market, symbol, side, filled, at, orderId}] (cash orders made outside the app, the last 30 days),
// blocks: buyback.cjs blocks, openOrders: [{market, symbol, side, quantity, remaining, price, at, orderId}]}.
const LIMIT=20,MEMORY_LIMIT=10;
const iso=t=>Number.isFinite(t)?new Date(t).toISOString():null;
function apply(context,data){if(!context||!data)return context;const trades=(data.trades??[]).filter(t=>Number.isFinite(t?.at)).sort((a,b)=>a.at-b.at);
  const by=symbol=>trades.filter(t=>t.symbol===symbol);
  if(trades.length)context.ordersMadeOutsideApp={note:"Cash orders the user made outside the app (in KIS) in the last 30 days, from KIS's order history; the app did not decide or send them.",
    trades:trades.slice(-LIMIT).map(t=>({symbol:t.symbol,side:t.side,shares:t.filled,at:iso(t.at),kisOrder:t.orderId}))};
  if((data.buysWait??[]).length)context.appBuysWait={markets:data.buysWait.slice(0,2),note:"The app's own buys wait in these markets: KIS's order history for orders made outside the app is not read yet, so the app cannot tell which stocks the user sold there."};
  const blocks=(data.blocks??[]).filter(b=>b&&b.symbol);
  if(blocks.length)context.buybackBlocked={rule:"The user's rule: after a sale made outside the app, the app's buys of the stock are refused for 30 days or until the user removes it.",
    stocks:blocks.slice(0,LIMIT).map(b=>({symbol:b.symbol,soldOn:b.soldOn,blockedUntil:b.blockedUntil}))};
  const open=(data.openOrders??[]).filter(o=>o&&o.symbol);
  if(open.length)context.openOrdersOutsideApp=open.slice(0,LIMIT).map(o=>({symbol:o.symbol,side:o.side,quantity:o.quantity,remaining:o.remaining,price:o.price??null,...(iso(o.at)?{orderedAt:iso(o.at)}:{}),kisOrder:o.orderId}));
  // Position memory: the app's entries and exits stay as they are; the latest outside sale and purchase after the app's
  // last fill on a stock are added beside them; a stock traded only outside the app gets a row while the memory has room.
  const view=t=>({at:iso(t.at),shares:t.filled,kisOrder:t.orderId,rationale:'none: made by the user outside the app'});
  const appLast=m=>Math.max(Date.parse(m.lastEntry?.filledAt??'')||0,Date.parse(m.lastExit?.filledAt??'')||0);
  const memory=Array.isArray(context.positionMemory)?context.positionMemory:[];
  const out=memory.map(m=>{const after=by(m.symbol).filter(t=>t.at>appLast(m));if(!after.length)return m;const sale=after.filter(t=>t.side==='Sell').at(-1),buy=after.filter(t=>t.side==='Buy').at(-1);
    return {...m,...(sale?{lastOutsideExit:view(sale)}:{}),...(buy?{lastOutsideEntry:view(buy)}:{})};});
  for(const symbol of [...new Set(trades.map(t=>t.symbol))]){if(out.length>=MEMORY_LIMIT)break;if(out.some(m=>m.symbol===symbol))continue;const mine=by(symbol),sale=mine.filter(t=>t.side==='Sell').at(-1),buy=mine.filter(t=>t.side==='Buy').at(-1);
    out.push({symbol,holding:context.positions?.[symbol]?.quantity??0,...(sale?{lastOutsideExit:view(sale)}:{}),...(buy?{lastOutsideEntry:view(buy)}:{})});}
  if(out.length)context.positionMemory=out;
  // The plan and the review watches: marked only for a stock whose buy-back block stands (the same rule: not lifted by a
  // later outside buy or a Remove) and with no app fill after the sale.
  const blockOf=symbol=>{const b=blocks.find(x=>x.symbol===symbol);if(!b)return null;const m=memory.find(x=>x.symbol===symbol);return m&&appLast(m)>b.soldAt?null:b;};
  for(const t of context.planGap?.targets??[]){const b=blockOf(t.symbol);if(b){const sale=by(t.symbol).filter(x=>x.side==='Sell').at(-1);t.soldByYouOutsideApp={on:b.soldOn,...(sale?{shares:sale.filled}:{})};}}
  for(const w of context.reviewWatches??[]){const b=blockOf(w.symbol);if(b&&Number.isFinite(w.updatedAt)&&w.updatedAt<b.soldAt)w.setWhileHeld=true;}
  return context;}
module.exports={apply,LIMIT,MEMORY_LIMIT};
