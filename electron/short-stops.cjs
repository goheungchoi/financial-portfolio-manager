'use strict';
// Short selling B3d-2 (artifacts/reviews/2026-11-24-short-selling): the cover stop of a short and the unprotected-short
// rule. Pure: the app (automation.cjs) reads the balance and the desk and calls these.
// - A cover stop is an armed conditional Buy of kind cover for one short lot (its loan date), purpose stop_loss, fired by a
//   rise: price >= entry x (1 + stopLossPct), on the Korean tick grid. It is armed when the app's short has filled and
//   its lot shows in the balance, for the lot's quantity; reduced with the lot, closed when the lot is gone.
// - A short lot is unprotected when its armed cover stops cover less than its quantity and its last cover stop was
//   rejected or lapsed (as a long's sale stop), or when its cover stop was hit and is held (B-4's held rule).
const {upToTick}=require('./short-rules.cjs');
const LIVE=new Set(['armed','firing']);
const isCover=o=>o?.side==='Buy'&&o.credit?.kind==='cover';
const isCoverStop=o=>isCover(o)&&o.purpose==='stop_loss';
const sameLot=(o,lot)=>o.symbol===lot.symbol&&o.credit?.loanDate===lot.loanDate;
// The level a cover stop fires at: the entry raised by stopLossPct, up to the grid. null when it cannot be read.
function coverStopLevel(entry,pct){const e=Number(entry),p=Number(pct);if(!(e>0)||!(p>0&&p<=100))return null;return upToTick(e*(1+p/100));}
// Armed cover orders whose lot shrank (reduce to the lot) or is gone (close), and cover stops whose lot grew (raise to
// the lot): [{order, quantity}], [{order}], [{order, quantity}]. Any armed cover is reduced or closed (none covers more than
// its lot); only a stop is raised.
function lotChanges({shorts=[],deskOrders=[],balanceKnown=true}){const reduce=[],close=[],raise=[];if(!balanceKnown)return {reduce,close,raise};
  for(const o of deskOrders.filter(o=>isCover(o)&&o.status==='armed')){const lot=shorts.find(l=>sameLot(o,l));if(!lot||!(Number(lot.quantity)>0))close.push({order:o});else if(o.quantity>lot.quantity)reduce.push({order:o,quantity:lot.quantity});else if(isCoverStop(o)&&o.quantity<lot.quantity)raise.push({order:o,quantity:lot.quantity});}
  return {reduce,close,raise};}
// Unprotected shorts by the rejected or lapsed rule: lots whose live cover stops cover less than the lot and whose last
// closed cover stop was rejected or lapsed (unacknowledged). rows: every cover-stop row of the scope, newest first.
function unprotectedShorts({shorts=[],rows=[],lapsed=()=>false}){const out=[];
  for(const lot of shorts.filter(l=>Number(l.quantity)>0)){const stops=rows.filter(o=>isCover(o)&&o.purpose==='stop_loss'&&sameLot(o,lot));const covered=stops.filter(o=>LIVE.has(o.status)).reduce((n,o)=>n+o.quantity,0);
    const last=stops.find(o=>!LIVE.has(o.status));if(!last||last.acknowledgedAt)continue;const how=last.status==='rejected'?'rejected':last.status==='submitted'&&lapsed(last)?'lapsed':null;if(!how||covered>=lot.quantity)continue;
    out.push({symbol:lot.symbol,short:true,loanDate:lot.loanDate,orderId:last.id,quantity:lot.quantity-covered,heldQuantity:lot.quantity,coveredQuantity:covered,...(covered>0?{partial:true}:{}),rejectedAt:new Date(last.closedAt??Date.now()).toISOString(),outcome:last.outcome??null});}
  return out;}
// B3d-2 review 2: what an app short lot with shares left and no live stop-loss cover gets, from the lot's own record (its
// stop-loss cover rows, newest first): always one of arm, list or covered, never none.
// - covered: a live stop (armed or firing), or the last one sent and still open at KIS (brokerStatus open).
// - arm: no stop yet; the last one expired; it was sent and its order ended with shares left (filled in part or in
//   full, the lot back or not yet shown); or the app closed it as not needed and the lot is back.
// - list: the last one was rejected, its sent order lapsed with nothing filled, or you or the AI cancelled it: not
//   re-armed; listed as unprotected with the cause (until you dismiss it). Also while its proposal waits for your
//   approval (held: named until approved; armed again once it expires).
const OPEN_AT_KIS=new Set(['Ready','Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain']);
// brokerExpired: whether the order's proposal is past its time (an expired proposal can no longer be approved).
function lotDecision(rows,{brokerStatus=()=>null,brokerFilled=()=>0,brokerExpired=()=>false}={}){const stops=(Array.isArray(rows)?rows:[]).filter(isCoverStop);
  if(stops.some(o=>LIVE.has(o.status)))return {covered:'armed'};const last=stops[0];if(!last)return {arm:'first'};
  const s=brokerStatus(last);
  if(last.status==='expired')return {arm:'expired'};
  // A proposal waiting for your click is not protection: named as held until you approve it; once past its time, armed again.
  if(last.status==='proposed')return s==='Ready'&&!brokerExpired(last)?{list:{cause:'approval',held:true,words:'its stop was hit and waits for your approval'}}:{arm:'its proposal ended unapproved'};
  if(last.status==='submitted'){if(OPEN_AT_KIS.has(s))return {covered:'its cover is at KIS'};if(Number(brokerFilled(last))>0)return {arm:'its cover filled with shares left'};
    return {list:{cause:'lapsed',words:'its cover order ended at KIS with nothing filled'}};}
  if(last.status==='rejected')return {list:{cause:'rejected',words:last.outcome?String(last.outcome).slice(0,200):'its cover stop was refused'}};
  if(last.status==='cancelled'){if(last.closedBy==='app')return {arm:'the lot is back'};return {list:{cause:'cancelled',words:last.closedBy==='user'?'you cancelled its cover stop':'its cover stop was cancelled'}};}
  return {list:{cause:'other',words:`its last cover stop is ${String(last.status)}`}};}
// The short's trail (B3d-2 trail step; short.trailingStop, off by default): the lowest fresh price since the fill, and the
// cover stop's level at that low plus the short's own stop distance; the level only moves down. null: no move.
function trailStep({low,price,level,pct}){const p=Number(price),l=Number.isFinite(Number(low))&&Number(low)>0?Math.min(Number(low),p):p;if(!(p>0))return null;
  const next=coverStopLevel(l,pct);if(next==null)return null;return {low:l,level:Number.isFinite(level)&&next>=level?level:next,moved:Number.isFinite(level)&&next<level};}
module.exports={trailStep,coverStopLevel,lotChanges,unprotectedShorts,isCover,isCoverStop,lotDecision};
