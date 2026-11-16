// The broker-side open-order guard of an order's preparation (G2 Korea, G3 U.S.; artifacts/reviews/2026-11-16-multi-order).
// orders: the day's KIS order history (any channel: the app's and yours in KIS), rows {orderId, symbol, side, remaining,
// orderPrice, status}. An order is open while it has unfilled shares and is pending or partly filled.
// - severalOpen off (the app): any open order refuses the preparation (OPEN_BROKER_ORDERS), as before. Returns {}.
// - severalOpen on (M-1.3): only an open order of the same stock refuses it (its lot and price at KIS would interleave
//   with the new one; your own orders included, the user's D3 "block same stock"). The other open orders are returned,
//   for the engine to tell the app's from yours and count yours in its sums.
const OPEN=o=>o.remaining>0&&['Pending','Partially filled'].includes(o.status);
// One stock, whatever exchange code KIS files it under: a U.S. symbol is compared by its ticker after the colon (an order
// listed as NYSE:XYZ or under a daytime code is still XYZ); a Korean code is compared as it is.
const tickerOf=s=>{const t=String(s??'');const i=t.indexOf(':');return i>=0?t.slice(i+1):t;};
const sameStock=(a,b)=>tickerOf(a)===tickerOf(b)&&String(a??'').includes(':')===String(b??'').includes(':');
function openGuard(orders,command,{severalOpen=false,fail}){const open=(orders??[]).filter(OPEN);
  if(severalOpen!==true){if(open.length)throw fail();return {};}
  if(open.some(o=>sameStock(o.symbol,command.symbol)))throw fail();
  return {openOrders:open.map(o=>({orderId:String(o.orderId),symbol:o.symbol,side:o.side,quantity:o.quantity??null,remaining:o.remaining,price:o.orderPrice??null}))};}
module.exports={openGuard,sameStock};
