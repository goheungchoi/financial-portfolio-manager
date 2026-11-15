'use strict';
// The accounting-correction component of the recorded daily values (stage 3.1; design v3.1 §5, v3.3 §3; rules C1-C8 in
// artifacts/reviews/2026-11-05-accounting/stage3-spec.md). The recorded value is the valuation's low bound, which U.S.
// buys the settlement tracker holds open lower. When the tracker changes that basis with no cash or market move (a
// pre-tracking fill opened, a conflict, a close by age), the value changes and
// it is not investment P/L. Each recorded day's correction is derived from the settlement ledger when the series is read;
// nothing recorded is rewritten.
// - C1 A day's interval is (the previous recorded day's last reading, this day's last reading]; an event belongs to the
//   first recorded day whose last reading is at or after it.
// - C2 Cash-free changes of the buy-side basis in the interval: InFlight.explained bounded to the interval and to buys
//   (the same classification the flow detector uses). Sales move only the high bound: no correction in the low series.
// (S4b-1: C3, reconciliations by their payment's timing, and C4, flows reclassified as a reconciliation's payment, are gone
// with the timing entries; S4b-2 removes the reconciliations.)
const round=v=>Math.round(v*100)/100;
class SettlementCorrections{
  // inFlight: the U.S. settlement tracker (its ledger, explained and openCorrections).
  constructor(db,{inFlight}={}){if(!inFlight)throw new Error('CORRECTIONS_NEED_TRACKER');this.db=db;this.inFlight=inFlight;}
  // rows: the recorded days in order ({day, at}). Returns Map day -> {usd, items}: usd the correction (U.S. dollars, the
  // low series), items what makes it.
  // C1a: superseded(account), set by main: the settlement pieces an approved valuation correction supersedes; their
  // events make no correction, no open base and no estimate tag on any day.
  byDay(account,rows){const out=new Map(),days=rows.filter(r=>Number.isFinite(r.at));const excludePieces=this.supersededOf(account);
    const add=(day,usd,item)=>{const d=out.get(day)??{usd:0,items:[]};d.usd=round(d.usd+usd);d.items.push({...item,usd:round(usd)});out.set(day,d);};
    for(let i=1;i<days.length;i++){const prev=days[i-1].at,at=days[i].at,day=days[i].day;
      const x=this.inFlight.explained(account,{since:prev,from:prev,until:at,sides:['Buy'],excludePieces});
      if(Math.abs(x.usd)>=0.005)add(day,x.usd,{kind:'basis change',note:'settlement ledger change with no cash in the day: pre-tracking fill, conflict or a close by age'});}
    // S2b: what of the corrections is still open at each day's last reading (InFlight.openCorrections), on every day.
    if(typeof this.inFlight.openCorrections==='function')for(const r of days){const v=this.inFlight.openCorrections(account,{until:r.at,excludePieces});if(Math.abs(v)>=0.005){const d=out.get(r.day)??{usd:0,items:[]};d.openUSD=v;out.set(r.day,d);}}
    // S2 estimates and U4 (SettlementUncertainty). S4a: historical restatements (approved overlays) are gone.
    if(this.uncertainty)for(const [day,u] of this.uncertainty.byDay(account,rows,excludePieces)){const d=out.get(day)??{usd:0,items:[]};if(u.unavailable.length)d.unavailable=u.unavailable;if(u.pending)d.pending=u.pending;out.set(day,d);}
    return out;}
  supersededOf(account){let s=null;try{s=this.superseded?.(account)??null;}catch{throw new Error('SUPERSEDED_UNREADABLE');}return s instanceof Set&&s.size?s:null;}
}
// Settlement simplification S2 (design section 3, D3), the default: no day is unavailable for a settlement reason. A day
// whose interval had a U.S. buy in flight (open at the previous day's last reading, seen during the day, opened, flagged
// or overdue in between, or coverage under review) shows its return with the estimate tag (pending) while any of those
// pieces is still open, and plainly once they closed (by evidence or by age, at most 3 business days). There are no
// misstatement windows and no bounded ranges: a closed piece's change is a correction (C2). S4a removed the stage 3.2
// rules (U1-U3) and the historical restatements with them. U4 stays: a day the tracker's state was not recorded for, or
// could not be read, has no return.
class SettlementUncertainty{
  constructor(db,{inFlight}={}){if(!inFlight)throw new Error('UNCERTAINTY_NEEDS_TRACKER');this.db=db;this.inFlight=inFlight;}
  // rows: the recorded days in order (with their settlement snapshots). Returns Map day -> {unavailable, pending}.
  byDay(account,rows,excludePieces=null){return this.estimates(account,rows,excludePieces);}
  // S2: Map day -> {unavailable (U4 only), pending (the estimate tag, while a piece of the day is open)}.
  estimates(account,rows,excludePieces=null){const out=new Map(),days=rows.filter(r=>Number.isFinite(r.at)),started=this.inFlight.state(account).startedAt;if(!Number.isFinite(started))return out;const kept=pid=>!(excludePieces?.has(pid));
    const at=day=>{const d=out.get(day)??{unavailable:[]};out.set(day,d);return d;},mark=(day,why)=>{const d=at(day);if(!d.unavailable.includes(why))d.unavailable.push(why);};
    const now=this.inFlight.current(account),openNow=new Set((now.open??[]).filter(p=>p.side==='Buy'&&kept(p.pid)).map(p=>p.pid)),reviewNow=(now.review?.buysUSD??0)>0.005;
    const events=this.inFlight.evidence.events(account).filter(e=>kept(e.pieceId)),side=new Map(),opened=new Map();for(const e of events)if(e.kind==='piece-opened'){side.set(e.pieceId,e.side);if(!opened.has(e.pieceId))opened.set(e.pieceId,e.at);}
    const buys=list=>(list??[]).filter(p=>p.side==='Buy'&&kept(p.pid));
    for(let i=1;i<days.length;i++){const prev=days[i-1],cur=days[i],day=cur.day;if(cur.at<started)continue;const s=cur.settlement,p=prev.settlement;
      if(!s){mark(day,'the settlement tracker\'s uncertainty was not recorded for this day');continue;}
      if(s.error||!s.last){mark(day,`the settlement tracker could not be read when this day was recorded (${s.error??'no reading'})`);continue;}
      if(prev.at>=started&&(!p||p.error||!p.last)){mark(day,'the settlement tracker\'s uncertainty was not recorded at the previous day\'s last reading');continue;}
      const before=prev.at>=started?buys(p.last.pieces):[];
      const pids=new Set([...before,...buys(s.seen),...buys(s.last.pieces)].map(x=>x.pid).filter(Boolean));for(const pid of [...(prev.at>=started?p.last.open?.pids??[]:[]),...(s.openPids??[]),...(s.last.open?.pids??[])])if(kept(pid))pids.add(pid);let review=[...before,...buys(s.seen)].some(x=>x.review);
      for(const e of events){if(!(e.at>prev.at&&e.at<=cur.at))continue;if(e.kind==='piece-opened'&&e.side==='Buy')pids.add(e.pieceId);else if(e.kind==='flag')for(const pid of e.pieces??[]){if(side.get(pid)==='Buy')pids.add(pid);}
        else if(e.kind==='overdue'&&side.get(e.pieceId)==='Buy')pids.add(e.pieceId);else if(e.kind==='review-changed'&&[...(e.before??[]),...(e.after??[])].some(x=>x.side==='Buy'))review=true;}
      // Not known which buys were open (a day recorded before the snapshot named them, with buys open by amount, or one
      // without the open totals): an estimate while any buy opened by then is still open.
      const named=Array.isArray(s.last.open?.pids)&&(prev.at<started||Array.isArray(p.last.open?.pids)),openByAmount=(s.openBuysMaxUSD??0)>0.005||prev.at>=started&&(p.last.open?.buysUSD??0)>0.005;
      const unknownOpen=Boolean(s.openUnknown||!s.last.open||prev.at>=started&&!p.last.open||!named&&openByAmount);
      const still=[...pids].filter(pid=>openNow.has(pid)),open=still.length>0||review&&reviewNow||unknownOpen&&[...openNow].some(pid=>(opened.get(pid)??Infinity)<=cur.at);
      if(open){const usd=(now.open??[]).filter(x=>x.side==='Buy'&&(still.includes(x.pid)||unknownOpen&&(opened.get(x.pid)??Infinity)<=cur.at)).reduce((n,x)=>n+(x.usd??0),0);at(day).pending={usd:Math.round(usd*100)/100,estimate:true,...(unknownOpen?{unknown:true}:{})};}}
    return out;}
}
// The performance correction hook as the app wires it: the 3.1 correction component with the S2 estimates.
function performanceCorrections(db,{inFlight}={}){const c=new SettlementCorrections(db,{inFlight});c.uncertainty=new SettlementUncertainty(db,{inFlight});return c;}
module.exports={SettlementCorrections,SettlementUncertainty,performanceCorrections};
