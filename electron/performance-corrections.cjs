'use strict';
// The accounting-correction component of the recorded daily values (stage 3.1; design v3.1 §5, v3.3 §3; rules C1-C8 in
// artifacts/reviews/2026-11-05-accounting/stage3-spec.md). The recorded value is the valuation's low bound, which U.S.
// buys the settlement tracker holds open lower. When the tracker changes that basis with no cash or market move (a
// pre-tracking fill opened, a conflict, a reconciliation of an earlier or no payment, a reversal), the value changes and
// it is not investment P/L. Each recorded day's correction is derived from the settlement ledger when the series is read;
// nothing recorded is rewritten.
// - C1 A day's interval is (the previous recorded day's last reading, this day's last reading]; an event belongs to the
//   first recorded day whose last reading is at or after it.
// - C2 Cash-free changes of the buy-side basis in the interval: InFlight.explained bounded to the interval and to buys
//   (the same classification the flow detector uses). Sales move only the high bound: no correction in the low series.
// - C3 The other reconciliations (candidates) by their payment's timing: inside the interval (its U.S. settlement date
//   wholly inside, or resolved "paid in this interval" for a reading interval inside it): 0, the payment and the
//   resolution net out; before the day: +X, only with evidence that places the payment before the day's start
//   ("paid earlier" means before that reading interval began, so it proves this only when the reading interval began
//   at or before the previous day's last reading: stage 3.1 review, P1); otherwise unknown: the day's correction
//   cannot be told, and its return is unavailable.
// - C4 A detected flow reclassified as a reconciliation's payment: its settlement part is a correction on the flow's
//   day (neither P/L nor a flow), while the reconciliation is in force.
const DAY=86400000;
const nyDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
const round=v=>Math.round(v*100)/100;
class SettlementCorrections{
  // inFlight: the U.S. settlement tracker (its ledger and explained); reconciliation: the audited records (reclassified
  // flows); timing(account): the flow detector's resolved timing (flow_watch timingResolved).
  constructor(db,{inFlight,reconciliation=null,timing=null}={}){if(!inFlight)throw new Error('CORRECTIONS_NEED_TRACKER');this.db=db;this.inFlight=inFlight;this.reconciliation=reconciliation;this.timing=timing;}
  // Resolved timing; none before the flow detector has stored anything. A read that fails is an error, never "none".
  resolved(account){if(this.timing)return this.timing(account)??[];
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='flow_watch'").get())return [];
    const r=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);return r?JSON.parse(r.payload).timingResolved??[]:[];}
  // rows: the recorded days in order ({day, at}). Returns Map day -> {usd, items, unknown}: usd the known correction
  // (U.S. dollars, the low series), items what makes it, unknown the reasons it cannot be told (empty when known).
  byDay(account,rows){const out=new Map(),resolved=this.resolved(account),days=rows.filter(r=>Number.isFinite(r.at));
    const add=(day,usd,item)=>{const d=out.get(day)??{usd:0,items:[],unknown:[]};d.usd=round(d.usd+usd);d.items.push({...item,usd:round(usd)});out.set(day,d);};
    const unknown=(day,reason,item)=>{const d=out.get(day)??{usd:0,items:[],unknown:[]};d.unknown.push(reason);d.items.push({...item,usd:null});out.set(day,d);};
    for(let i=1;i<days.length;i++){const prev=days[i-1].at,at=days[i].at,day=days[i].day;
      const x=this.inFlight.explained(account,{since:prev,from:prev,until:at,sides:['Buy']});
      if(Math.abs(x.usd)>=0.005)add(day,x.usd,{kind:'basis change',note:'settlement ledger change with no cash in the day: pre-tracking fill, conflict, reconciliation of an earlier or no payment, or reversal'});
      for(const c of x.candidates.items){const res=resolved.filter(r=>r.candidate===c.id).at(-1)??null,win=res?.entry;
        const inside=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&a>=prev&&b<=at;
        if(res&&res.paidHere&&inside(win?.after,win?.by)){add(day,0,{kind:'reconciliation paid that day',reconciliationId:c.id});continue;}
        if(res&&!res.paidHere&&Number.isFinite(win?.after)&&win.after<=prev){add(day,c.usd,{kind:'reconciliation paid before the day',reconciliationId:c.id});continue;}
        if(!res&&typeof c.settledOn==='string'&&nyDay(prev)<c.settledOn&&nyDay(at)>c.settledOn){add(day,0,{kind:'reconciliation paid that day',reconciliationId:c.id,settledOn:c.settledOn});continue;}
        unknown(day,`whether reconciliation ${String(c.id).slice(0,10)} was paid on this day or earlier is not known`,{kind:'reconciliation of unknown payment timing',reconciliationId:c.id,possibleUSD:round(c.usd)});}}
    // C4: reclassified settlement cash on the flow's day (the first recorded day on or after it), records in force only.
    for(const r of this.reconciliation?.active(account)??[]){const fl=r.effects?.flows;if(!fl?.original||r.side!=='Buy')continue;
      const row=days.find(d=>d.day>=fl.original.day);if(row&&days.indexOf(row)>0)add(row.day,fl.settlementCents/100,{kind:'payment reclassified from a detected flow',reconciliationId:r.id,flowId:fl.original.id});}
    // Stage 3.2: days whose return is unavailable unless bounded (SettlementUncertainty below), merged into the same map.
    if(this.uncertainty)for(const [day,u] of this.uncertainty.byDay(account,rows,out)){const d=out.get(day)??{usd:0,items:[],unknown:[]};if(u.unavailable.length)d.unavailable=u.unavailable;if(u.bounded)d.bounded=u.bounded;out.set(day,d);}
    return out;}
}
// Stage 3.2: performance is unavailable unless bounded (design v3.3 §3; rules U1-U6 in stage3-spec.md). The recorded value
// is the U.S. low bound; an uncertain U.S. buy obligation (a piece marked unresolved, or coverage under review) makes the
// true value anything from that low bound to X above it, so the day's return depends on a state nobody knows.
// - U1 A day is affected when an uncertain buy piece was open at the previous day's last reading, at any reading of the
//   day (recorded with each day: performance record, InFlight.snapshot), or was made uncertain by a ledger change in
//   between (opened unresolved, flagged, overdue). Affected days have no return and no P/L, with the reason. Resolution
//   does not restore them: what past returns display changes only through stage 3.3's approval.
// - U2 A misstatement window: a reconciliation whose payment is not known to fall on its own day may have been counted
//   while its obligation was still open, from the earliest day the payment can have been made (its U.S. settlement date,
//   the reclassified flow's day, or else the piece's opening) to the reconciliation's day. Every day of it is unavailable.
// - U3 The one bounded case: one fixed obligation (a single uncertain buy piece, open with the same amount at both
//   readings and in every reading between, no ledger change to it, no other correction that day), a known existence
//   window (its fill time known, and the day ends before its earliest possible U.S. settlement, so no payment can have
//   fallen in the day), no partial payment and no route change. Its return is a range: the piece real (the recorded
//   value) or not real (X more at both ends). Only in the U.S. series: in the combined series the funding route and FX
//   exposure are not bounded.
// - U4 A day the tracker's uncertainty was not recorded for, or could not be read, after tracking started: unavailable.
const seoulMidnight=day=>Date.parse(day+'T00:00:00+09:00');
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
// The earliest moment a fill's U.S. settlement can be paid: the start (Seoul time, the earlier clock) of the first weekday
// after its New York trade date. Holidays only delay settlement, so this is never later than the real one.
function earliestPayment(filledAt){let d=nyDay(filledAt);do d=addDays(d,1);while([0,6].includes(new Date(d+'T00:00:00Z').getUTCDay()));return seoulMidnight(d);}
const money=v=>`$${Number(v).toFixed(2)}`;
class SettlementUncertainty{
  constructor(db,{inFlight,reconciliation=null}={}){if(!inFlight)throw new Error('UNCERTAINTY_NEEDS_TRACKER');this.db=db;this.inFlight=inFlight;this.reconciliation=reconciliation;}
  // rows: the recorded days in order (with their settlement snapshots); corrections: SettlementCorrections' map for the
  // same rows (which reconciliations were paid on their own day). Returns Map day -> {unavailable: reasons, bounded}.
  byDay(account,rows,corrections=new Map()){const out=new Map(),days=rows.filter(r=>Number.isFinite(r.at)),started=this.inFlight.state(account).startedAt;
    const at=day=>{const d=out.get(day)??{unavailable:[],bounded:null};out.set(day,d);return d;},mark=(day,why)=>{const d=at(day);if(!d.unavailable.includes(why))d.unavailable.push(why);};
    if(!Number.isFinite(started))return out;
    const events=this.inFlight.evidence.events(account),side=new Map(),opened=new Map(),amount=new Map();
    for(const e of events)if(e.kind==='piece-opened'){side.set(e.pieceId,e.side);amount.set(e.pieceId,e.usd);if(!opened.has(e.pieceId))opened.set(e.pieceId,e.at);}
    const buys=list=>(list??[]).filter(p=>p.side==='Buy'),describe=p=>`${p.usd==null?'an amount not known':money(p.usd)} (${p.review?'coverage under review':p.why??'unresolved'})`;
    for(let i=1;i<days.length;i++){const prev=days[i-1],cur=days[i],day=cur.day;if(cur.at<started)continue;
      const s=cur.settlement,p=prev.settlement;
      if(!s){mark(day,'the settlement tracker\'s uncertainty was not recorded for this day');continue;}
      if(s.error||!s.last){mark(day,`the settlement tracker could not be read when this day was recorded (${s.error??'no reading'})`);continue;}
      let before=[];if(prev.at>=started){if(!p||p.error||!p.last){mark(day,'the settlement tracker\'s uncertainty was not recorded at the previous day\'s last reading');continue;}before=buys(p.last.pieces);}
      // U1: every uncertain buy piece of the interval, with each amount it had.
      const affected=new Map(),add=x=>{const l=affected.get(x.pid)??[];l.push(x);affected.set(x.pid,l);};for(const x of [...before,...buys(s.seen)])add(x);
      const evs=events.filter(e=>e.at>prev.at&&e.at<=cur.at);
      for(const e of evs){if(e.kind==='piece-opened'&&e.side==='Buy'&&(e.why||e.pretracking))add({pid:e.pieceId,side:'Buy',usd:e.usd,why:e.why??'awaiting verification'});
        else if(e.kind==='flag')for(const pid of e.pieces??[]){if(side.get(pid)==='Buy')add({pid,side:'Buy',usd:amount.get(pid)??null,why:e.why});}
        else if(e.kind==='overdue'&&side.get(e.pieceId)==='Buy')add({pid:e.pieceId,side:'Buy',usd:e.usd,why:'overdue'});}
      if(!affected.size)continue;
      // U3: the one bounded case.
      if(affected.size===1){const [[pid,list]]=affected,a=before.filter(x=>x.pid===pid),b=buys(s.last.pieces).filter(x=>x.pid===pid),amounts=new Set(list.map(x=>x.usd));
        const touched=evs.some(e=>e.pieceId===pid||(e.pieces??[]).includes(pid));const one=a[0];
        if(one&&!one.review&&a.length===1&&b.length===1&&amounts.size===1&&b[0].usd===one.usd&&!touched&&Number.isFinite(one.filledAt)&&cur.at<earliestPayment(one.filledAt)){at(day).bounded={pieceId:pid,usd:one.usd,why:one.why};continue;}}
      const list=[...affected.values()].map(l=>l.find(x=>x.usd!=null)??l[0]);
      mark(day,`uncertain U.S. buy obligations this day: ${list.slice(0,3).map(describe).join(', ')}${list.length>3?` and ${list.length-3} more`:''}; the return depends on whether they were real, so it is unavailable (it stays so after they are resolved, until a historical correction is approved)`);}
    // U2: misstatement windows.
    const reversed=new Set(events.filter(e=>e.kind==='reconciliation-reversed').map(e=>e.target)),records=new Map((this.reconciliation?.active(account)??[]).map(r=>[r.id,r]));
    for(const e of events){if(e.kind!=='reconciliation'||side.get(e.pieceId)!=='Buy'||reversed.has(e.id)||e.explanation==='rounding')continue;
      const r=days.findIndex(d=>d.at>=e.at);if(r<1)continue;
      if((corrections.get(days[r].day)?.items??[]).some(x=>x.kind==='reconciliation paid that day'&&x.reconciliationId===e.id))continue;
      const flowDay=e.reclassified?records.get(e.id)?.effects?.flows?.original?.day:null;
      const start=typeof e.settledOn==='string'?seoulMidnight(e.settledOn):typeof flowDay==='string'?seoulMidnight(flowDay):opened.get(e.pieceId)??-Infinity;
      let d0=days.findIndex(d=>d.at>=start);d0=d0<0?r:Math.max(1,Math.min(d0,r));
      for(let k=d0;k<=r;k++)mark(days[k].day,`a payment of ${money(e.cents/100)} (reconciliation ${String(e.id).slice(0,10)}) may have been counted while its obligation was still open, between ${days[d0].day} and ${days[r].day} (a misstatement window): the return is unavailable until a historical correction is approved`);}
    // U3 needs the day to have nothing else: any other reason, or any correction, leaves it unavailable.
    for(const [day,d] of out)if(d.bounded&&(d.unavailable.length||(corrections.get(day)?.items??[]).length)){mark(day,`an uncertain U.S. buy obligation of ${money(d.bounded.usd)} (${d.bounded.why??'unresolved'}) with other changes the same day: the return is unavailable`);d.bounded=null;}
    return out;}
}
// The performance correction hook as the app wires it: the 3.1 correction component with the 3.2 uncertainty rules.
function performanceCorrections(db,{inFlight,reconciliation=null,timing=null}={}){const c=new SettlementCorrections(db,{inFlight,reconciliation,timing});c.uncertainty=new SettlementUncertainty(db,{inFlight,reconciliation});return c;}
module.exports={SettlementCorrections,SettlementUncertainty,performanceCorrections,earliestPayment};
