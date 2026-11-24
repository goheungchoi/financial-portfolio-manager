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
const KIS_APP="; buy it back in KIS's own app";
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
// purpose: stop_loss (the cover stop) or exit (the loan-end cover, B3d-3); the same answers for both.
function lotDecision(rows,{brokerStatus=()=>null,brokerFilled=()=>0,brokerExpired=()=>false,purpose='stop_loss'}={}){const stops=(Array.isArray(rows)?rows:[]).filter(o=>isCover(o)&&o.purpose===purpose);
  if(stops.some(o=>LIVE.has(o.status)))return {covered:'armed'};const last=stops[0];if(!last)return {arm:'first'};
  const s=brokerStatus(last);
  if(last.status==='expired')return {arm:'expired'};
  // A proposal waiting for your click is not protection: named as held until you approve it; once past its time, armed again.
  if(last.status==='proposed')return s==='Ready'&&!brokerExpired(last)?{list:{cause:'approval',held:true,words:'its stop was hit and waits for your approval'}}:{arm:'its proposal ended unapproved'};
  if(last.status==='submitted'){if(OPEN_AT_KIS.has(s))return {covered:'its cover is at KIS'};if(Number(brokerFilled(last))>0)return {arm:'its cover filled with shares left'};
    return {list:{cause:'lapsed',words:`its cover order ended at KIS with nothing filled${KIS_APP}`}};}
  const name=purpose==='exit'?'its loan-end cover':'its cover stop';
  // Stage 1b: every listed cause (refused, lapsed, cancelled) says what to do; a held one waits for your approval.
  // Shorts on (2026-11-25): a refused cover is never retried by the app beyond its one alternate loan date; the short is
  // listed with what to do.
  if(last.status==='rejected')return {list:{cause:'rejected',words:`${last.outcome?String(last.outcome).slice(0,200).replace(/[.\s]+$/,''):`${name} was refused`}${KIS_APP}`}};
  if(last.status==='cancelled'){if(last.closedBy==='app')return {arm:'the lot is back'};return {list:{cause:'cancelled',words:(last.closedBy==='user'?`you cancelled ${name}`:`${name} was cancelled`)+KIS_APP}};}
  return {list:{cause:'other',words:`${name.replace('its ','its last ')} is ${String(last.status)}`}};}
// The short's trail (B3d-2 trail step; short.trailingStop, off by default): the lowest fresh price since the fill, and the
// cover stop's level at that low plus the short's own stop distance; the level only moves down. null: no move.
function trailStep({low,price,level,pct}){const p=Number(price),l=Number.isFinite(Number(low))&&Number(low)>0?Math.min(Number(low),p):p;if(!(p>0))return null;
  const next=coverStopLevel(l,pct);if(next==null)return null;return {low:l,level:Number.isFinite(level)&&next>=level?level:next,moved:Number.isFinite(level)&&next<level};}
// B3d-3: the loan's end. The end is the loan date plus maxDays calendar days. Until KIS's own figure is seen (B4), the
// last day a cover can be made is taken as the last business day strictly before the end. isOpen(day): the app's calendar
// (false closed, null unknown: weekdays).
function loanEnd(loanDate,maxDays,isOpen=()=>null){const BD=require('./business-days.cjs');const end=new Date(Date.parse(loanDate+'T00:00:00Z')+maxDays*86400000).toISOString().slice(0,10);
  let d=end;do{d=new Date(Date.parse(d+'T00:00:00Z')-86400000).toISOString().slice(0,10);}while(!BD.isBusinessDay('KR',d,{krOpen:isOpen}));return {end,lastDay:d};}
// Business days from today to lastDay (0 on it; negative once past it).
function businessDaysTo(today,lastDay,isOpen=()=>null){const BD=require('./business-days.cjs');return today<=lastDay?BD.businessDaysBetween('KR',today,lastDay,{krOpen:isOpen}):-BD.businessDaysBetween('KR',lastDay,today,{krOpen:isOpen});}
// Shorts on, stage 1c: the app's own short lots in a balance. An app short with shares filled is tied to a balance lot of
// the same stock whose loan date is any of: KIS's date on its order row (lotLoanDate), the date the app sent
// (loanDateSent, or the plan's first date before the reply was read), or either one's counterpart in the other form (two
// Korean business days before or after). Exact dates are tried before counterparts. False-match risk: a short of the same
// stock opened in KIS's app whose loan date is one of those dates (the same day, or two business days apart) is taken for
// the app's lot, wholly. Returns {lots: Map 'symbol|loanDate' -> {quantity (the app's shares sold there less its covers
// filled on that lot), fillPrice}, unmatched: [{symbol, orderId}]: an app short filled before a balance read that shows
// no lot it ties to}. isOpen(day): the app's calendar.
function appLots({orders=[],balance=null,isOpen=null}={}){const LD=require('./short-loan-date.cjs');const lots=new Map(),unmatched=[];
  const shorts=Array.isArray(balance?.shorts)?balance.shorts.filter(s=>Number(s.quantity)>0&&LD.realDate(s.loanDate)):[];const list=Array.isArray(orders)?orders:[];
  for(const o of list.filter(o=>o?.side==='Sell'&&o.credit?.kind==='short'&&Number(o.filled)>0)){const exact=[...new Set([o.lotLoanDate,o.loanDateSent?.date,o.loanDateSent?null:o.credit?.send?.first?.date].filter(LD.realDate))];
    const near=[...new Set(exact.flatMap(d=>LD.counterparts(d,isOpen)))];const mine=shorts.filter(s=>s.symbol===o.symbol);
    const lot=mine.find(s=>exact.includes(s.loanDate))??mine.find(s=>near.includes(s.loanDate));
    if(!lot){const at=Date.parse(balance?.timestamp??''),seen=Number.isFinite(o.filledObservedAt)?o.filledObservedAt:o.reconciledAt;if(Array.isArray(balance?.shorts)&&Number.isFinite(at)&&Number.isFinite(seen)&&at>seen)unmatched.push({symbol:o.symbol,orderId:o.id});continue;}
    const key=`${lot.symbol}|${lot.loanDate}`,e=lots.get(key)??{quantity:0,fillPrice:null};e.quantity+=Number(o.filled);e.fillPrice??=Number(o.fillPrice)>0?Number(o.fillPrice):null;lots.set(key,e);}
  for(const o of list.filter(o=>o?.side==='Buy'&&o.credit?.kind==='cover'&&Number(o.filled)>0)){const e=lots.get(`${o.symbol}|${o.credit.loanDate}`);if(e)e.quantity=Math.max(0,e.quantity-Number(o.filled));}
  return {lots,unmatched};}
module.exports={appLots,loanEnd,businessDaysTo,trailStep,coverStopLevel,lotChanges,unprotectedShorts,isCover,isCoverStop,lotDecision};
