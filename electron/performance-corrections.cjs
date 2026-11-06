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
//   resolution net out; earlier (resolved "paid earlier" for a reading interval starting at or after the day's start):
//   +X; otherwise unknown: the day's correction cannot be told, and its return is unavailable.
// - C4 A detected flow reclassified as a reconciliation's payment: its settlement part is a correction on the flow's
//   day (neither P/L nor a flow), while the reconciliation is in force.
const DAY=86400000;
const nyDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
const round=v=>Math.round(v*100)/100;
class SettlementCorrections{
  // inFlight: the U.S. settlement tracker (its ledger and explained); reconciliation: the audited records (reclassified
  // flows); timing(account): the flow detector's resolved timing (flow_watch timingResolved).
  constructor(db,{inFlight,reconciliation=null,timing=null}={}){if(!inFlight)throw new Error('CORRECTIONS_NEED_TRACKER');this.db=db;this.inFlight=inFlight;this.reconciliation=reconciliation;this.timing=timing;}
  resolved(account){if(this.timing)return this.timing(account)??[];
    try{const r=this.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get(account);return r?JSON.parse(r.payload).timingResolved??[]:[];}catch{return [];}}
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
        if(res&&!res.paidHere&&Number.isFinite(win?.after)&&win.after>=prev){add(day,c.usd,{kind:'reconciliation paid earlier',reconciliationId:c.id});continue;}
        if(!res&&typeof c.settledOn==='string'&&nyDay(prev)<c.settledOn&&nyDay(at)>c.settledOn){add(day,0,{kind:'reconciliation paid that day',reconciliationId:c.id,settledOn:c.settledOn});continue;}
        unknown(day,`whether reconciliation ${String(c.id).slice(0,10)} was paid on this day or earlier is not known`,{kind:'reconciliation of unknown payment timing',reconciliationId:c.id,possibleUSD:round(c.usd)});}}
    // C4: reclassified settlement cash on the flow's day (the first recorded day on or after it), records in force only.
    for(const r of this.reconciliation?.active(account)??[]){const fl=r.effects?.flows;if(!fl?.original||r.side!=='Buy')continue;
      const row=days.find(d=>d.day>=fl.original.day);if(row&&days.indexOf(row)>0)add(row.day,fl.settlementCents/100,{kind:'payment reclassified from a detected flow',reconciliationId:r.id,flowId:fl.original.id});}
    return out;}
}
module.exports={SettlementCorrections};
