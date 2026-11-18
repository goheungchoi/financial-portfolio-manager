// Where an app order came from (artifacts/reviews/2026-11-18-activity-tab, steps 3 and 4). Only a positive mark names an
// origin; an order with none is "The app", with no further claim (a wrong "You" on an automatic order is worse than no
// label). Marks, in order:
// - madeBy on the order record, written where the order is created (2026-11-19): 'review' (automation.placeOrder: every
//   review's order, a batch's further orders, emergency and re-reviews alike), 'conditional' (automation.fireConditional:
//   stops, take profits, trailing and plan stops), 'ticket' (the live:propose and us:propose order tickets, the user's);
// - for older orders without madeBy: the review whose record holds the order (review-orders.cjs reviewOfOrder, as the
//   outcome ledger matches), else the conditional order whose proposal or order it is.
// Orders KIS reports that match no app record are "Outside the app" (step 4, the Activity rows).
const {reviewOfOrder}=require('./review-orders.cjs');
const PURPOSE={stop_loss:'Stop',take_profit:'Take profit'};
// intent: a live_intents row; reviews: review records (or their id rows, reviewIdRows); conditionals: {id, purpose,
// proposalId, orderId}. Returns {origin, label, ref?}.
function originOf(intent,{reviews=[],conditionals=[]}={}){
  const id=String(intent?.id??'');if(!id)return {origin:'app',label:'The app'};
  const byConditional=c=>({origin:'conditional',label:PURPOSE[c?.purpose]??'Conditional order',...(c?.id?{ref:c.id}:{})});
  const mine=()=>conditionals.find(o=>String(o.proposalId??'')===id||String(o.orderId??'')===id);
  if(intent.madeBy==='ticket')return {origin:'you',label:'You, in the app'};
  // sentBy (live-engine send, from 2026-11-19): how a review's order went out; older orders make no claim.
  if(intent.madeBy==='review')return {origin:'review',label:'AI review'+(intent.sentBy==='auto'?' · sent automatically':intent.sentBy==='you'?' · approved by you':''),...(intent.reviewId?{ref:intent.reviewId}:{})};
  if(intent.madeBy==='conditional')return byConditional(conditionals.find(o=>o.id===intent.conditionalId)??mine());
  const match=reviewOfOrder(reviews,{orderId:id,proposalId:id});if(match?.review)return {origin:'review',label:'AI review',ref:match.review.id};
  const c=mine();if(c)return byConditional(c);
  return {origin:'app',label:'The app'};}
// What reviewOfOrder reads of a review, and only that: its id, its first order's ids, and each further order's item,
// action and ids. Read in SQL (json_extract), never the whole payload, and kept while the reviews since `since` have
// not changed (their count and last row).
// One entry per window (the Today strip's two days, an Activity period), at most four.
const cache=new Map();
function reviewIdRows(db,since){
  // The change check reads no payload: the table's row count and last row (reviews are only added), and the window by
  // the minute.
  try{const k=db.prepare('SELECT count(*) n,max(rowid) m FROM reviews').get();const key=`${Math.floor(since/60000)}:${k.n}:${k.m}`;
    if(cache.has(key))return cache.get(key);
    const rows=db.prepare(`SELECT id,json_extract(payload,'$.orderId') orderId,json_extract(payload,'$.proposalId') proposalId,json_extract(payload,'$.decision.action') action,
      (SELECT json_group_array(json_object('item',json_extract(e.value,'$.item'),'action',json_extract(e.value,'$.action'),'orderId',json_extract(e.value,'$.orderId'),'proposalId',json_extract(e.value,'$.proposalId'))) FROM json_each(payload,'$.orders') e) orders
      FROM reviews WHERE json_extract(payload,'$.timestamp')>=?`).all(since).map(r=>({id:r.id,orderId:r.orderId??null,proposalId:r.proposalId??null,decision:{action:r.action??null},orders:r.orders?JSON.parse(r.orders):[]}));
    cache.set(key,rows);if(cache.size>4)cache.delete(cache.keys().next().value);return rows;}catch{return [];}}
// The conditional orders that placed an order (a proposal or order id), with only the fields originOf reads.
function conditionalRows(db){try{return db.prepare("SELECT json_extract(payload,'$.id') id,json_extract(payload,'$.purpose') purpose,json_extract(payload,'$.proposalId') proposalId,json_extract(payload,'$.orderId') orderId FROM conditional_orders WHERE json_extract(payload,'$.proposalId') IS NOT NULL OR json_extract(payload,'$.orderId') IS NOT NULL").all();}catch{return [];}}
module.exports={originOf,reviewIdRows,conditionalRows};
