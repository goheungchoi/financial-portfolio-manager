// Agent notes are free text kept for weeks; order status belongs to the order system. A note's claims about orders are
// superseded when an order linked to it has resolved, or when it claims a pending order and an order for that symbol that
// existed when it was written has since been confirmed resolved, with none open now. Superseded claims are stated explicitly to the model
// with the current account state; the note's thesis may still apply. Nothing is superseded while order status is
// unconfirmed: the note is marked unverified instead.
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
const RESOLVED=['Filled','Canceled','Rejected'];
// A claim that an order is still open or not yet filled.
const ORDER_CLAIM=/\b(accepted|pending|unfilled|0 filled|not (yet )?filled|open (buy |sell )?order|awaiting (a )?fill|order (is |remains )?(open|outstanding))\b/i;
// orders: the engine's order records (open and resolved); positions: {symbol:{quantity}}; reconciliation: the engine's
// orderReconciliation ({status,lastConfirmedAt}) or null when nothing was open at the last check; confirmedAt: the time
// of the latest successful order check (ms), null when unknown.
function annotate(notes,{orders=[],positions={},reconciliation=null,confirmedAt=null}={}){
  const iso=t=>Number.isFinite(t)?new Date(t).toISOString():null;
  return notes.map(n=>{
    if(!n.symbol)return {...n};
    const mine=orders.filter(o=>o.symbol===n.symbol),open=mine.filter(o=>OPEN.includes(o.status));
    // Stated explicitly even when empty: the context pruner drops empty lists, and "none" is the point.
    const state={held:positions[n.symbol]?.quantity??0,openOrders:open.length?open.map(o=>({side:o.side,quantity:o.quantity,filled:o.filled??0,status:o.status})):'none',lastConfirmedAt:iso(confirmedAt)};
    if(reconciliation?.status==='unconfirmed'&&ORDER_CLAIM.test(n.note??''))return {...n,orderClaimUnverified:{note:'Order status could not be confirmed with KIS, so this note’s order claim can be neither confirmed nor ruled out. Report the uncertainty.'}};
    const linked=(n.orderIds??[]).map(id=>mine.find(o=>o.id===id)).filter(o=>o&&RESOLVED.includes(o.status));
    // Without a link: the note makes an order claim, an order for the symbol existed when it was written, and that order's
    // resolution was confirmed after it. A note written after the resolution (a correction saying no order is open) is
    // not flagged, however recent the latest routine check.
    const resolvedSince=mine.filter(o=>RESOLVED.includes(o.status)&&(o.createdAt??0)<=(n.updatedAt??0)&&(o.reconciledAt??0)>(n.updatedAt??0));
    const textual=ORDER_CLAIM.test(n.note??'')&&!open.length&&resolvedSince.length>0;
    if(!linked.length&&!textual)return {...n};
    return {...n,accountStateConflict:{superseded:'order and holding claims',resolvedOrders:[...new Set([...linked,...(textual?resolvedSince:[])])].map(o=>({side:o.side,quantity:o.quantity,filled:o.filled??0,status:o.status,fillPrice:o.fillPrice??null})),current:state,
      note:'This note was written before the current confirmed account state and its order or holding claims no longer hold: use positions, orders and orderReconciliation in this context. Its investment thesis may still apply.'}};
  });
}
module.exports={annotate,ORDER_CLAIM,OPEN,RESOLVED};
