'use strict';
// The U.S. settlement panel and its Home summary (stage 2b.5; design v1 §6.1, §9, v2 §9, v3 §7; rules P1-P7 in
// artifacts/reviews/2026-11-05-accounting/stage2b-spec.md). Read-only views of the tracker (electron/valuation.cjs
// InFlight), the evidence ledger, the audited reconciliations (electron/settlement-reconciliation.cjs) and the flow
// detector's settlement timing (electron/flow-detector.cjs), plus Check again. Nothing here changes an obligation:
// confirming, reversing and resolving timing go through the reconciliation and the flow detector, which bind and record
// them. No AI is started by anything here.
// - P1 Each open piece: the order (symbol, side, shares, order number, fill time), the amount and its basis, signed as
//   the cash it moves (a buy's payment negative, a sale's proceeds positive), why it is unresolved and since when,
//   overdue, the evidence (KIS settled record: none, uncertain with the reason, or linked as supporting only; evidence
//   allocated; standby; a trade-history gap on its date), and what remains unknown, in words.
// - P2 Each reconciliation, identified by its id: the piece and order, the signed amount, the explanation, funding route,
//   KIS reference, settlement date, note, who confirmed it and when, any flow reclassified, whether it was reversed (by
//   which record), and the settlement timing still open for it.
// - P3 Each open timing entry: the interval, its observed change (every open candidate paid in it), each candidate by its
//   reconciliation id with its signed payment and the reading if it was paid earlier, and the entry's range.
// - P4 Home summary: shown only when unresolved amounts affect equity or buying capacity (buys lower both; sales only
//   leave proceeds out of the high bound), or settlement timing is open; hidden otherwise.
// - P5 Check again: one bounded trade-history job for the order's dates (its U.S. trade date ±1 day, to today), through
//   TradingCosts.syncHistory (stage 2a): its own job key, so it resumes from its stored queue after a stop or a restart
//   and backs off after a failed read; at most CHECK_PAGES pages and CHECK_MS per run; one at a time per order. Live only
//   (KIS settled records are imported for live accounts). What it reads is imported as any history read: K rows stay
//   supporting evidence (A1 off).
// - P6 Overdue: noted once by the tracker; one app notification per piece (overdueNotice), through the notifier's own
//   preferences.
const {usTradeDate}=require('./settlement-evidence.cjs');const {addDay,REASONS}=require('./trade-history.cjs');const {MAX_DAYS}=require('./valuation.cjs');
const {ownerAccount}=require('./tax-profile.cjs');
// Check again's budget per run: two reads of 50 pages, one minute.
const CHECK_PAGES=100,CHECK_MS=60000;
const cents=v=>Math.round(Number(v)*100);const usd=c=>Math.round(c)/100;const money=v=>`$${Math.abs(v).toFixed(2)}`;
const signedMoney=v=>`${v<0?'−':v>0?'+':''}${money(v)}`;
const fail=code=>Object.assign(new Error(code),{code});
// The cash a piece moves when it settles: a buy pays (negative), a sale receives (positive).
const signed=(side,v)=>side==='Buy'?-v:v;
const WHY={
  'awaiting verification':'Filled before tracking started; whether KIS figures already include it is unknown.',
  'reported before seen':'KIS reported an unsettled total that may include it; which fills that total covers is unknown.',
  'reported total moved by an unmatched amount':'KIS\'s reported total moved by an amount no single set of fills matches; which fills it covers is unknown.',
  'evidence short':'Evidence covered part of it; the rest has no settlement evidence yet.',
  conflict:'KIS\'s settled record differs from what was allocated; which is right is unknown.',
  'under review':'The KIS record a reconciliation relied on changed; this amount counts as unresolved again.',
  overdue:`No settlement evidence after ${MAX_DAYS} days.`,
};
class SettlementPanel{
  // inFlight: the tracker; reconciliation: the audited reconciliation (records); flowDetector: timing entries; costs:
  // TradingCosts (syncHistory, jobs, gaps) for Check again.
  constructor({inFlight,reconciliation=null,flowDetector=null,costs=null,clock=Date.now}={}){
    if(!inFlight)throw new Error('PANEL_NEEDS_TRACKER');this.inFlight=inFlight;this.ledger=inFlight.evidence;this.reconciliation=reconciliation;this.flowDetector=flowDetector;this.costs=costs;this.clock=clock;
    this.running=new Map();this.last=new Map();this.notified=new Set();}
  static checkKey(account,orderId){return `${ownerAccount(account)}#settlement-check:${orderId}`;}
  // The order's dates a check reads: its U.S. trade date ±1 day (a K row is keyed by trade date; the app's date can be a
  // day off), never after today.
  static window(order,today){const d=usTradeDate(order);if(!/^\d{4}-\d{2}-\d{2}$/.test(d??''))return null;const end=[addDay(d,1),today].sort()[0];return {start:addDay(d,-1),end};}
  check(account,orderId){const key=SettlementPanel.checkKey(account,orderId),job=this.costs?.jobs?.get(key)??null,last=this.last.get(key)??null;
    return {running:this.running.has(key),job:job?{state:job.state,stopped:job.stopped??null,code:job.code??null,nextAt:job.nextAt||null,unread:(job.queue??[]).map(({start,end})=>({start,end}))}:null,last};}
  // P1-P4. orders: the U.S. engine's (symbol, shares, order number); environment: the account's.
  view(account,{orders=[],environment=null}={}){
    const t=this.inFlight.current(account),ledger=this.ledger,byId=new Map(orders.map(o=>[String(o.id),o]));
    const links=ledger.links(account,orders),gaps=this.costs?.gaps?.list(ownerAccount(account))??[];
    const records=this.reconciliation?this.reconciliation.records(account):[],reversals=new Map(records.filter(r=>r.kind==='reversal').map(r=>[r.target,r]));
    const timing=this.flowDetector?this.flowDetector.timing(account):[];
    const pieces=t.open.map(p=>{const o=byId.get(String(p.id))??null,review=String(p.pid??'').startsWith('review:'),why=p.unresolved?.why??null;
      const k=links.get(String(p.id))??{state:o?'none':'unknown'},date=o?usTradeDate(o):null,gap=date?gaps.find(g=>g.start<=addDay(date,1)&&g.end>=addDay(date,-1))??null:null;
      const own=records.filter(r=>r.kind==='reconciliation'&&r.pieceId===p.pid);
      const unknown=[];if(why)unknown.push(WHY[why]??'No KIS settlement evidence matched it yet.');if(review&&p.unresolved?.reason)unknown.push(`Why: ${p.unresolved.reason}.`);
      if(p.overdueAt&&why!=='overdue')unknown.push(WHY.overdue);
      if(k.state==='none')unknown.push('No KIS settled record found for it yet.');else if(k.state==='uncertain')unknown.push(`A KIS settled record may be it, but not with certainty: ${k.reason}.`);
      if(gap)unknown.push(`KIS trade history around ${date} could not be read completely (${REASONS[gap.reason]??'incomplete'}).`);
      if(p.side==='Buy'&&why)unknown.push('Whether it was paid in USD or KRW is unknown.');
      return {pieceId:p.pid,orderId:String(p.id),side:p.side,symbol:o?.symbol??null,shares:o?.filled??null,orderNumber:o?.brokerOrderId??null,filledAt:p.filledAt??null,
        usd:p.usd,signedUSD:signed(p.side,p.usd),basis:p.basis??null,state:review?'under review':why?'unresolved':'in flight',why,since:p.unresolved?.at??p.at??null,overdue:Boolean(p.overdueAt),overdueAt:p.overdueAt??null,
        pretracking:Boolean(p.pretracking),conflict:Boolean(p.conflict),
        evidence:{k:k.state==='linked'?{state:'linked',groupId:k.groupId,version:k.version,settlementDate:k.fields?.settlementDate??null,settlementUSD:k.fields?.settlementUSD??k.fields?.grossUSD??null,supportingOnly:true}:k.state==='uncertain'?{state:'uncertain',groupId:k.groupId,reason:k.reason}:{state:k.state},
          allocatedUSD:review?null:usd(ledger.allocatedToPiece(p.pid)),standby:review?[]:ledger.standbyFor(p.pid).map(s=>({id:s.id,evidenceId:s.evidenceId,usd:usd(s.cents),promotedUSD:usd(s.promotedCents)})),
          reconciledUSD:usd(own.filter(r=>!reversals.has(r.id)).reduce((n,r)=>n+r.cents,0)),historyGap:gap?{start:gap.start,end:gap.end,reason:gap.reason}:null},
        unknown,reconcilable:!review,check:this.check(account,String(p.id))};});
    const timingOf=id=>timing.filter(e=>e.candidates.some(c=>c.id===id)).map(e=>{const c=e.candidates.find(x=>x.id===id);return {entryId:e.id,ifPaidEarlierUSD:Math.round((e.observed-c.usd)*100)/100,ifPaidHereUSD:e.observed,low:e.low,high:e.high};});
    const sideOf=new Map(records.filter(r=>r.kind==='reconciliation').map(r=>[r.id,r]));
    const reconciliations=records.filter(r=>r.kind==='reconciliation').map(r=>{const o=byId.get(String(r.orderId))??null,v=reversals.get(r.id)??null;
      return {id:r.id,pieceId:r.pieceId,orderId:String(r.orderId),side:r.side,symbol:o?.symbol??null,usd:usd(r.cents),signedUSD:signed(r.side,usd(r.cents)),explanation:r.explanation,route:r.route??null,kisReference:r.kisReference,
        settledOn:r.settledOn??null,note:r.note,confirmedAt:r.confirmedAt,confirmedBy:r.confirmedBy??null,flowId:r.flowId??null,
        reversed:v?{id:v.id,at:v.confirmedAt,note:v.note}:null,timing:v?[]:timingOf(r.id)};}).reverse();
    const entries=timing.map(e=>({id:e.id,after:e.after??null,by:e.by??null,observedUSD:e.observed,low:e.low,high:e.high,
      candidates:e.candidates.map(c=>{const r=sideOf.get(c.id);return {reconciliationId:c.id,side:r?.side??null,symbol:r?byId.get(String(r.orderId))?.symbol??null:null,paymentUSD:r?signed(r.side,usd(r.cents)):null,ifPaidEarlierUSD:Math.round((e.observed-c.usd)*100)/100};})}));
    const range={low:Math.round(timing.reduce((n,e)=>n+Math.min(0,e.low),0)*100)/100,high:Math.round(timing.reduce((n,e)=>n+Math.max(0,e.high),0)*100)/100};
    const summary={unresolved:t.unresolved,overdue:t.overdue,review:t.review,pretracking:t.pretracking.count,inFlight:{buysUSD:t.buysUSD,sellsUSD:t.sellsUSD},timingOpen:timing.length,timingRange:range};
    // Detected U.S. flows a reconciliation may name as its payment (R8).
    const detectedFlows=(this.reconciliation?.performance?.flows(account)??[]).filter(f=>f.market==='US'&&f.detected&&!f.transfer).map(f=>({id:f.id,day:f.day,amountUSD:f.amount}));
    return {account,environment,pieces,reconciliations,timing:entries,detectedFlows,summary,home:SettlementPanel.home(summary)};}
  // P4: the Home row, or null. Buys unresolved lower equity's low bound and buying capacity; sales unresolved leave
  // their proceeds out of the high bound only.
  static home(s){const buys=s.unresolved.buysUSD,sells=s.unresolved.sellsUSD,over=s.overdue.buysUSD+s.overdue.sellsUSD;const parts=[];
    if(buys>0.005)parts.push(`${money(buys)} lowers equity and buying capacity`);if(sells>0.005)parts.push(`${money(sells)} of sale proceeds not counted`);
    if(s.timingOpen)parts.push(`${s.timingOpen} payment timing${s.timingOpen===1?'':'s'} to confirm (${signedMoney(s.timingRange.low)} to ${signedMoney(s.timingRange.high)})`);
    if(!parts.length)return null;return {title:'U.S. settlements to reconcile',detail:parts.join(' · ')+(over>0.005?` · ${money(over)} overdue`:''),tone:over>0.005||buys>0.005?'warning':'info'};}
  // P5: Check again for the order of a piece. fetch(start,end,{maxPages}) is one KIS trade-history read (live,
  // read-only). Returns the job's outcome and the check's state; {busy:true} while a run for that order is under way.
  async checkAgain(account,pieceId,{orders=[],fetch,environment,today}){
    if(environment!=='live')throw fail('CHECK_LIVE_ONLY');if(!this.costs||typeof fetch!=='function')throw fail('CHECK_UNAVAILABLE');
    const p=this.inFlight.current(account).open.find(x=>x.pid===pieceId);if(!p)throw fail('PIECE_NOT_OPEN');
    const order=orders.find(o=>String(o.id)===String(p.id));if(!order)throw fail('ORDER_UNKNOWN');
    const key=SettlementPanel.checkKey(account,p.id);if(this.running.has(key))return {busy:true,check:this.check(account,String(p.id))};
    const range=SettlementPanel.window(order,today);if(!range)throw fail('ORDER_DATE_UNKNOWN');
    const run=this.costs.syncHistory(account,fetch,{plan:()=>[range],key,exact:true,pages:CHECK_PAGES,ms:CHECK_MS,clock:this.clock});this.running.set(key,run);
    try{const r=await run;const out=r.skipped?{at:this.clock(),skipped:r.skipped,nextAt:r.nextAt}:{at:this.clock(),done:r.done,stopped:r.stopped,code:r.code,read:(r.results??[]).map(({start,end,complete,reason})=>({start,end,complete,reason})),unread:r.remaining.map(({start,end})=>({start,end}))};
      this.last.set(key,out);return {...out,check:this.check(account,String(p.id))};}
    finally{this.running.delete(key);}}
  // P6: the one notification for pieces that became overdue in a reading (the tracker returns them once).
  overdueNotice(account,overdue,notify){for(const p of overdue??[]){const id=`settlement-overdue:${account}:${p.pieceId}`;if(this.notified.has(id))continue;this.notified.add(id);
    try{notify(id,`U.S. settlement overdue: ${p.side} ${p.orderId} (${money(p.usd)}) has no settlement evidence after ${MAX_DAYS} days. Reconcile it with KIS in U.S. stocks › Settlements.`);}catch{}}}
}
module.exports={SettlementPanel,CHECK_PAGES,CHECK_MS};
