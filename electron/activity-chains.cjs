// The Activity totals' guard (artifacts/reviews/2026-11-18-activity-tab, step 1). KIS gives a revised or cancelled
// order its own row with its own fills, so the totals sum every row (src/activity.mjs). Where the app knows an order's
// chain (its own order, every revision it or anyone else made, linked by the original-order number), the rows' filled
// quantities summed over the chain must not exceed the order's quantity. If they do, the report cannot be read as one
// fill per share, and that chain's rows are marked so the totals leave them out and say so, never guessing.
// rows: the Activity report's orders ({orderId, originalOrderId, filled, market}); intents: the app's order records
// ({id, market, quantity, brokerOrderId, brokerOrderIds}). Returns the rows, a chain past its quantity marked
// {chainOverfill:true, chainId}.
const {norm}=require('./order-chain.cjs');
function markChains(rows,intents){
  if(!Array.isArray(rows)||!rows.length||!Array.isArray(intents))return rows;
  const marks=new Map();
  for(const intent of intents){
    const root=norm(intent?.brokerOrderId);if(!root||!(intent.quantity>0))continue;const market=intent.market??'KR';
    const mine=rows.filter(r=>(r.market??'KR')===market);const byId=new Map(mine.map(r=>[norm(r.orderId),r]));
    const ids=[...new Set([root,...(intent.brokerOrderIds??[]).map(norm).filter(Boolean)])].filter(id=>byId.has(id));if(!ids.length)continue;
    for(let i=0;i<ids.length;i++)for(const r of mine){const id=norm(r.orderId);if(norm(r.originalOrderId)===ids[i]&&!ids.includes(id))ids.push(id);}
    const chain=ids.map(id=>byId.get(id));const filled=chain.reduce((n,r)=>n+(Number(r.filled)||0),0);
    if(filled>intent.quantity)for(const r of chain)marks.set(r,String(intent.id));}
  return marks.size?rows.map(r=>marks.has(r)?{...r,chainOverfill:true,chainId:marks.get(r)}:r):rows;}
module.exports={markChains};
