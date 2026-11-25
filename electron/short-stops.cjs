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
// Stage 2c: capOf(lot), when given, is the most an app cover of that lot may take (with the switch off, the app's own
// shares left there); a stop is reduced or raised to min(lot, cap).
function lotChanges({shorts=[],deskOrders=[],balanceKnown=true,capOf=null}={}){const reduce=[],close=[],raise=[];if(!balanceKnown)return {reduce,close,raise};
  for(const o of deskOrders.filter(o=>isCover(o)&&o.status==='armed')){const lot=shorts.find(l=>sameLot(o,l));if(!lot||!(Number(lot.quantity)>0)){close.push({order:o,why:'covered'});continue;}
    const cap=typeof capOf==='function'?capOf(lot):null,target=Number.isFinite(cap)?Math.min(Number(lot.quantity),Math.max(0,cap)):Number(lot.quantity);
    // Stage 2d: at 0 with the lot still there, the app's shares are already taken by its open covers (switch off).
    if(target<1)close.push({order:o,why:'capped'});else if(o.quantity>target)reduce.push({order:o,quantity:target});else if(isCoverStop(o)&&o.quantity<target)raise.push({order:o,quantity:target});}
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
// Shorts on, stage 2c: the app's own short lots, from a tie recorded once on each short's order record (the planner's
// design, review-stage2.md), never re-derived from dates on every read.
// - tieShorts (each Korean balance reading, LiveEngine.observeBalance): an app short with shares filled and no tie yet,
//   once a balance read after its fill is in hand, is tied to a lot of its stock when the tie is unambiguous:
//   - its own dates: KIS's date on its order row (lotLoanDate), the date sent (loanDateSent, else the plan's first);
//   - candidate lots: lots of the stock not held by an open tie of a short with other own dates (shorts with the same
//     own date share one lot at KIS);
//   - one candidate with an own date (exact); else none exact and one with a counterpart date, two Korean business days
//     before or after (counterpart); else the one candidate that newly appeared or grew by at least the filled
//     quantity since the stock's lots recorded on the order at its send (shortLotsAtSend) (grew);
//   - otherwise the tie is ambiguous: recorded with its candidates (lotTieAmbiguous) and not guessed; their lots are
//     listed unprotected until a reading settles it.
//   A tie is closed on the record when its lot leaves the balance: 'covered' when the app's covers of that lot filled
//   the short's shares, otherwise 'gone' (bought back in KIS's app, or by KIS). A closed tie never ties again.
// - appLots reads the ties: per tied lot, the app's shares there (its tied shorts' fills less the app's covers of that lot
//   filled since the first tied short was sent; the cover's lot is its credit.loanDate, a balance date) at most the lot's
//   quantity, and the unfilled shares of the app's open covers of the lot (exclude: the order being sent).
// Stage 2d: how long a tied lot must stay absent, over two complete readings, before its tie is closed 'gone'.
const ABSENT_MS=10*60000;
const OPEN_COVER=['Ready','Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
const isAppShort=o=>o?.side==='Sell'&&o.credit?.kind==='short'&&Number(o.filled)>0;
const isCoverOf=(o,symbol,loanDate)=>o?.side==='Buy'&&o.credit?.kind==='cover'&&o.symbol===symbol&&o.credit.loanDate===loanDate;
const seenOf=o=>Number.isFinite(o?.filledObservedAt)?o.filledObservedAt:Number(o?.reconciledAt)||0;
const ownDates=o=>{const LD=require('./short-loan-date.cjs');return [...new Set([o.lotLoanDate,o.loanDateSent?.date,o.loanDateSent?null:o.credit?.send?.first?.date].filter(LD.realDate))];};
// The app's covers of a lot filled since `since` (ms).
const coveredSince=(orders,symbol,loanDate,since)=>orders.filter(c=>isCoverOf(c,symbol,loanDate)&&Number(c.filled)>0&&(Number(c.createdAt)||0)>=since).reduce((n,c)=>n+Number(c.filled),0);
// The record changes a balance reading makes: [{id, set:{...}}], deterministic for any order of orders and lots.
function tieShorts({orders=[],balance=null,isOpen=null}={}){const LD=require('./short-loan-date.cjs');const out=[];if(!Array.isArray(balance?.shorts))return out;const at=Date.parse(balance.timestamp??'');if(!Number.isFinite(at))return out;
  const list=(Array.isArray(orders)?orders:[]).slice().sort((a,b)=>(Number(a.createdAt)||0)-(Number(b.createdAt)||0)||String(a.id).localeCompare(String(b.id)));
  const lots=balance.shorts.filter(s=>Number(s.quantity)>0&&LD.realDate(s.loanDate));const key=(s,d)=>s+'|'+d;
  const open=new Map();for(const o of list.filter(o=>isAppShort(o)&&o.lotTie&&!o.lotTie.closed))open.set(o.id,o);
  // Stage 2d: closing and reopening, only on a reading newer than the tie and than the short's last fill (an older or
  // stale reading changes nothing). The balance's short rows are an array here, read without error (complete).
  // - The tied lot absent and the app's covers of it filled the shorts' shares: closed 'covered' at once.
  // - Absent otherwise: the first such reading records absentSince; the tie is closed 'gone' only when the lot is still
  //   absent in a reading at least ABSENT_MS (10 minutes) later. The lot seen again clears absentSince.
  // - A tie closed 'gone' reopens when its lot is seen again with the same loan date in a reading newer than the close.
  const newer=o=>at>(Number(o.lotTie?.at)||0)&&at>seenOf(o);const present=o=>lots.some(s=>s.symbol===o.symbol&&s.loanDate===o.lotTie.loanDate);
  for(const o of list.filter(o=>isAppShort(o)&&o.lotTie?.closed?.reason==='gone'&&present(o)&&at>(Number(o.lotTie.closed.at)||0))){const {closed:_,absentSince:__,...rest}=o.lotTie;
    const t={...rest,reopenedAt:at};out.push({id:o.id,set:{lotTie:t}});open.set(o.id,{...o,lotTie:t});}
  for(const o of [...open.values()]){if(!newer(o))continue;const L=o.lotTie.loanDate;
    if(present(o)){if(o.lotTie.absentSince!=null){const {absentSince:_,...rest}=o.lotTie;out.push({id:o.id,set:{lotTie:rest}});open.set(o.id,{...o,lotTie:rest});}continue;}
    const sameLot=[...open.values()].filter(x=>x.symbol===o.symbol&&x.lotTie.loanDate===L);const since=Math.min(...sameLot.map(x=>Number(x.createdAt)||0));
    const covered=coveredSince(list,o.symbol,L,since)>=sameLot.reduce((n,x)=>n+Number(x.filled),0);
    if(covered){out.push({id:o.id,set:{lotTie:{...o.lotTie,closed:{at,reason:'covered'}}}});open.delete(o.id);continue;}
    const since0=Number(o.lotTie.absentSince);
    if(!Number.isFinite(since0)){out.push({id:o.id,set:{lotTie:{...o.lotTie,absentSince:at}}});continue;}if(at<=since0)continue;// an older reading: nothing
    if(at-since0>=ABSENT_MS){out.push({id:o.id,set:{lotTie:{...o.lotTie,closed:{at,reason:'gone',absentSince:since0}}}});open.delete(o.id);}}
  // New ties, in two passes so an exact date always wins over a counterpart, whatever order the shorts come in: first
  // every short with exactly one candidate at an own date; then the rest (one counterpart, else the one lot that grew by
  // the fill since the send, else ambiguous). Shorts are taken oldest first (createdAt, then id).
  const untied=list.filter(o=>isAppShort(o)&&!o.lotTie&&seenOf(o)>0&&at>seenOf(o)&&ownDates(o).length);const done=new Set();
  const candsOf=o=>{const own=ownDates(o);const held=new Set([...open.values()].filter(x=>x.symbol===o.symbol&&!ownDates(x).some(d=>own.includes(d))).map(x=>x.lotTie.loanDate));
    // Stage 2d: a lot the stock already had at this short's send that did not grow by its fill is not its lot.
    const before=o.shortLotsAtSend&&typeof o.shortLotsAtSend==='object'?o.shortLotsAtSend:null;const grewBy=s=>!before||before[s.loanDate]==null||Number(s.quantity)-Number(before[s.loanDate])>=Number(o.filled);
    const cands=lots.filter(s=>s.symbol===o.symbol&&!held.has(s.loanDate)&&grewBy(s)).sort((p,q)=>p.loanDate<q.loanDate?-1:p.loanDate>q.loanDate?1:0);const near=new Set(own.flatMap(d=>LD.counterparts(d,isOpen)));
    return {exact:cands.filter(s=>own.includes(s.loanDate)),counter:cands.filter(s=>!own.includes(s.loanDate)&&near.has(s.loanDate))};};
  const tie=(o,lot,how)=>{const t={loanDate:lot.loanDate,at,how};out.push({id:o.id,set:{lotTie:t,lotTieAmbiguous:null}});open.set(o.id,{...o,lotTie:t});done.add(o.id);};
  for(const o of untied){const {exact}=candsOf(o);if(exact.length===1)tie(o,exact[0],'exact');}
  for(const o of untied.filter(o=>!done.has(o.id))){const {exact,counter}=candsOf(o);
    if(!exact.length&&counter.length===1){tie(o,counter[0],'counterpart');continue;}
    const pool=exact.length?exact:counter;const before=o.shortLotsAtSend&&typeof o.shortLotsAtSend==='object'?o.shortLotsAtSend:null;
    const grew=before?pool.filter(s=>Number(s.quantity)-(Number(before[s.loanDate])||0)>=Number(o.filled)):[];if(grew.length===1){tie(o,grew[0],'grew');continue;}
    const names=[...exact,...counter].map(s=>s.loanDate);
    if(names.length>1){const prev=o.lotTieAmbiguous?.candidates;if(!Array.isArray(prev)||prev.join()!==names.join())out.push({id:o.id,set:{lotTieAmbiguous:{candidates:names,at}}});}}
  return out;}
// The app's own short lots in a balance, from the recorded ties. Returns {lots: Map 'symbol|loanDate' -> {quantity (the
// app's shares left there, at most the lot's), open (unfilled shares of the app's open covers of that lot, the order
// `exclude` not counted), fillPrice}, unmatched: [{symbol, orderId}] (no tie and no candidate in a balance read after its
// fill), ambiguous: [{symbol, orderId, candidates}], leftovers: [{symbol, loanDate}] (the lots listed for those)}.
function appLots({orders=[],balance=null,now=Date.now(),exclude=null}={}){const LD=require('./short-loan-date.cjs');const lots=new Map(),unmatched=[],ambiguous=[],leftovers=[];
  const list=Array.isArray(orders)?orders:[];const shorts=Array.isArray(balance?.shorts)?balance.shorts.filter(s=>Number(s.quantity)>0&&LD.realDate(s.loanDate)):[];
  const groups=new Map();for(const o of list.filter(o=>isAppShort(o)&&o.lotTie&&!o.lotTie.closed)){const k=o.symbol+'|'+o.lotTie.loanDate;const g=groups.get(k)??{filled:0,since:Infinity,fillPrice:null};
    g.filled+=Number(o.filled);g.since=Math.min(g.since,Number(o.createdAt)||0);g.fillPrice??=Number(o.fillPrice)>0?Number(o.fillPrice):null;groups.set(k,g);}
  for(const [k,g] of groups){const [symbol,loanDate]=k.split('|');const lot=shorts.find(s=>s.symbol===symbol&&s.loanDate===loanDate);if(!lot)continue;
    const left=Math.min(Number(lot.quantity),Math.max(0,g.filled-coveredSince(list,symbol,loanDate,g.since)));
    const open=list.filter(c=>c.id!==exclude&&isCoverOf(c,symbol,loanDate)&&(Number(c.createdAt)||0)>=g.since&&OPEN_COVER.includes(c.status)&&!(c.status==='Ready'&&Number(c.expiresAt)<now)).reduce((n,c)=>n+Math.max(0,(Number(c.quantity)||0)-(Number(c.filled)||0)),0);
    if(left>0)lots.set(k,{quantity:left,open,fillPrice:g.fillPrice});}
  const at=Date.parse(balance?.timestamp??'');const tiedKeys=new Set(groups.keys());
  for(const o of list.filter(o=>isAppShort(o)&&!o.lotTie)){
    if(Array.isArray(o.lotTieAmbiguous?.candidates)&&o.lotTieAmbiguous.candidates.length){const c=o.lotTieAmbiguous.candidates.filter(d=>shorts.some(s=>s.symbol===o.symbol&&s.loanDate===d));ambiguous.push({symbol:o.symbol,orderId:o.id,candidates:c});
      for(const d of c)if(!leftovers.some(x=>x.symbol===o.symbol&&x.loanDate===d))leftovers.push({symbol:o.symbol,loanDate:d});continue;}
    if(Array.isArray(balance?.shorts)&&Number.isFinite(at)&&seenOf(o)>0&&at>seenOf(o)){unmatched.push({symbol:o.symbol,orderId:o.id});
      for(const s of shorts.filter(s=>s.symbol===o.symbol&&!tiedKeys.has(s.symbol+'|'+s.loanDate)))if(!leftovers.some(x=>x.symbol===s.symbol&&x.loanDate===s.loanDate))leftovers.push({symbol:s.symbol,loanDate:s.loanDate});}}
  return {lots,unmatched,ambiguous,leftovers};}
// Stage 2d: the app's shorts whose tie was closed 'gone' (the lot left KIS's balance with no app cover filling it) and
// not yet acknowledged: Home says so once each.
function goneShorts(orders=[]){return (Array.isArray(orders)?orders:[]).filter(o=>isAppShort(o)&&o.lotTie?.closed?.reason==='gone'&&!o.lotTie.closed.acknowledgedAt).map(o=>({orderId:o.id,symbol:o.symbol,loanDate:o.lotTie.loanDate,quantity:Number(o.filled)}));}
module.exports={ABSENT_MS,goneShorts,appLots,tieShorts,loanEnd,businessDaysTo,trailStep,coverStopLevel,lotChanges,unprotectedShorts,isCover,isCoverStop,lotDecision};
