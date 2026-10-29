// An app order as KIS records it: the order the app placed plus every revision or cancellation linked to it through
// the original-order number (orgn_odno), whoever made them. A revision at KIS gets its own order number, so following
// only the first number misses its fills; a cancellation is its own row too.
// 2026-10-29: the GOOGL sell (0030715248) was revised in the KIS app and filled at $280 under a new number; the app
// kept the original open, which blocked every later U.S. order.
// Order numbers are compared without leading zeros: KIS returns 0000040476 when an order is placed and lists it as
// 40476 in its history and in revision links (mock account, 2026-10-30).
// order: {brokerOrderId (first number), brokerOrderIds (every number the app itself created), quantity}. rows: the
// day's KIS order history, each {orderId, originalOrderId, filled, averagePrice|fillPrice, status, remaining, kind}.
const cancelled=row=>row.kind==='cancel'||/cancel/i.test(row.status??'');
const rejected=row=>/reject/i.test(row.status??'');
const norm=id=>id==null||id===''?null:String(id).replace(/^0+(?=\d)/,'');
// A number from history in the zero-padded form KIS gives the app (the length of a number it gave before).
const padLike=(id,ref)=>String(id).padStart(String(ref??'').length,'0');
function resolve(order,rows){
  const root=norm(order.brokerOrderId);if(!root)return null;const byId=new Map(rows.map(r=>[norm(r.orderId),r]));if(!byId.has(root))return null;
  const ids=[root];for(let i=0;i<ids.length;i++)for(const r of rows){const id=norm(r.orderId);if(norm(r.originalOrderId)===ids[i]&&!ids.includes(id))ids.push(id);}
  const chain=ids.map(id=>byId.get(id));
  // The app's own numbers in the form it was given them, which is the form it sends back to KIS.
  const mine=new Map([order.brokerOrderId,...(order.brokerOrderIds??[])].filter(Boolean).map(id=>[norm(id),String(id)]));
  const asSent=id=>mine.get(id)??padLike(byId.get(id).orderId,order.brokerOrderId);
  // The latest link: the one nothing else revises or cancels (the last added when several qualify).
  const tail=[...chain].reverse().find(r=>!chain.some(x=>norm(x.originalOrderId)===norm(r.orderId)))??chain[chain.length-1];
  // Fills count on every link: an order partly filled and then cancelled keeps its fills (a separate cancel row has none).
  const filled=chain.reduce((n,r)=>n+(r.filled??0),0);
  const amount=chain.reduce((n,r)=>{if(!(r.filled>0))return n;const p=r.fillPrice??(r.averagePrice>0?r.averagePrice:null);return p?n+p*r.filled:n;},0);
  const fillPrice=filled>0&&amount>0?Math.round(amount/filled*10000)/10000:null;
  // Nothing left open on the latest link without every share filled: the order ended unfilled (expired at the session's
  // end, or closed by the exchange), so it is closed rather than left open to block later orders.
  const expired=!cancelled(tail)&&!rejected(tail)&&tail.remaining===0&&filled<order.quantity;
  const status=filled>=order.quantity?'Filled':cancelled(tail)||expired?'Canceled':rejected(tail)?'Rejected':filled>0?'Partially filled':'Accepted';
  // Links the app did not create: someone revised or cancelled the order outside the app.
  const outside=chain.filter(r=>!mine.has(norm(r.orderId))).map(r=>({orderId:asSent(norm(r.orderId)),from:r.originalOrderId==null?null:asSent(norm(r.originalOrderId)),kind:cancelled(r)?'cancel':'revision',price:r.orderPrice??null}));
  return {status,...(expired?{closedReason:'expired unfilled'}:{}),filled,fillPrice,current:asSent(norm(tail.orderId)),currentPrice:tail.orderPrice??null,remaining:Math.max(0,order.quantity-filled),chain:ids.map(asSent),outside};
}
module.exports={resolve,norm,padLike};
