// M-6 part 3 (multi-order, artifacts/reviews/2026-11-16-multi-order/m6-plan.md section 4): every order of a review
// record, for the readers (Journal, Home, digest, phone snapshot, outcome ledger, scoreboard, replay, review gate,
// schedule observer, previous review, scout feedback). One rule: the first order (item 0, from the record's own fields)
// plus each further order (the record's orders rows, with that order's own decision fields from decision.moreOrders).
// A single-order record gives exactly what its readers read today: one row for a Buy or a Sell, none for a Hold.
// Each row: {item, action, symbol, quantity, proposalId, orderId, executionNote, orderOutcome, decision}, where decision
// is the order's own fields (credit, plan, execution, reversal) and orderOutcome the engine's status and reason.
const trade=a=>a==='Buy'||a==='Sell';
function ordersOfReview(r){if(!r||typeof r!=='object')return [];const d=r.decision??{},out=[];
  if(trade(d.action))out.push({item:0,action:d.action,symbol:d.symbol,quantity:d.quantity,proposalId:r.proposalId??null,orderId:r.orderId??null,executionNote:r.executionNote??null,orderOutcome:r.orderOutcome??null,decision:d});
  const own=new Map((Array.isArray(d.moreOrders)?d.moreOrders:[]).map(o=>[o.item,o]));
  for(const o of Array.isArray(r.orders)?r.orders:[])if(o&&trade(o.action))out.push({item:o.item,action:o.action,symbol:o.symbol,quantity:o.quantity,proposalId:o.proposalId??null,orderId:o.orderId??null,executionNote:o.executionNote??null,orderOutcome:o.orderOutcome??null,decision:{...(own.get(o.item)??{}),action:o.action,symbol:o.symbol,quantity:o.quantity}});
  return out;}
// The order of a review that a broker order or proposal id belongs to, or null.
function orderOfReview(r,{orderId=null,proposalId=null}={}){return ordersOfReview(r).find(o=>orderId&&o.orderId===orderId||proposalId&&o.proposalId===proposalId)??null;}
// Whether a review placed (or proposed) any order: the first or a further one.
const placedAny=r=>ordersOfReview(r).some(o=>o.orderId||o.proposalId);
// The review a broker order belongs to, among reviews, and which of its orders: first today's match on the review's own
// ids (the first order, exactly as the outcome ledger and the phone snapshot matched it), then a further order.
// {review, order} where order is null for the first order's match; null when none.
function reviewOfOrder(reviews,{orderId=null,proposalId=null}={}){
  const first=reviews.find(r=>orderId!=null&&r.orderId===orderId||proposalId!=null&&r.proposalId===proposalId);if(first)return {review:first,order:null};
  for(const r of reviews){if(!Array.isArray(r.orders))continue;const o=orderOfReview(r,{orderId,proposalId});if(o&&o.item>0)return {review:r,order:o};}
  return null;}
// What a further order's outcome keeps of its review: that order's own decision (with the review's explanation) and the
// review's evidence without the first order's quote, which is another stock's.
function furtherEvidence(review,order){return {decision:{...order.decision,explanation:review.decision?.explanation??''},
  evidence:{...(review.contextEvidence??{}),quote:review.contextEvidence?.quote?.symbol===order.symbol?review.contextEvidence.quote:null}};}
// The review behind a broker or paper order, for the phone's trade snapshot (main.cjs onFill): the 300 latest reviews,
// matched as before (broker order ids are proposal ids; paper orders carry proposalId). M-6 part 3: an order a review
// placed as a further order gets that review with the order's own decision, so the snapshot shows its own plan.
function reviewForOrder(db,order){for(const row of db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 300').all()){const r=JSON.parse(row.payload);
    if(r.orderId===order.id||r.proposalId===order.id||order.proposalId&&r.proposalId===order.proposalId)return r;
    if(Array.isArray(r.orders)){const o=orderOfReview(r,{orderId:order.id,proposalId:order.proposalId??order.id});if(o&&o.item>0)return {...r,decision:furtherEvidence(r,o).decision};}}
  return null;}
module.exports={ordersOfReview,orderOfReview,placedAny,reviewOfOrder,furtherEvidence,reviewForOrder};
