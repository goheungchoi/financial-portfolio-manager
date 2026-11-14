// Versioned corrections to recorded account values (audit 2026-11-04, Stage 2). A recorded day's value is never
// rewritten: a correction is an adjustment kept beside it, with its reason, its evidence and who approved it, and the
// performance series is computed with the adjustments in force (electron/performance.cjs series). Corrections are
// previewed first (preview: returns, drawdown and the day-by-day values with and without them, nothing written) and
// applied only with the user's approval (apply), each as a new version that supersedes the earlier one for its days.
// A correction is never computed from today's prices: its amount comes from the record it corrects.
// C1a (settlement clean-up, c1/design.md):
// - band: an adjustment may also give the day's right open, high and low (absolute values in its market's currency), in
//   place of the recorded ones; amount may then be 0. estimated: true marks a band the readings do not determine, set to
//   the known limit (the user's D4): the day is shown as "partly estimated". A COMBINED adjustment carries only a band for the combined series
//   (its value already follows from the Korean and U.S. adjustments): amount 0. Each band must contain the day's value
//   with the version applied, checked against the recorded day when the version is applied.
// - supersedes: a version may name settlement pieces whose effect on the recorded value its adjustments replace (the
//   pieces opened before tracking on 2026-11-09 and closed by age on 11-11). Their accounting corrections are then left
//   out of the series (electron/performance-corrections.cjs). Only closed pieces whose days all carry an adjustment of the
//   version may be named. No settlement event is written or changed.
const {randomUUID}=require('node:crypto');
const isDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v);
const MARKETS={KR:'KRW',US:'USD',COMBINED:'COMBINED'};
const BAND_KEYS=['open','high','low'];
// Korean amounts in won; U.S. amounts and combined bands (values converted at a rate) in hundredths.
const money=(market,v)=>market==='KR'?Math.round(v):Math.round(v*100)/100;
function validate(list){
  if(!Array.isArray(list)||!list.length||list.length>60)throw new Error('INVALID_CORRECTION');
  const seen=new Set();
  return list.map(a=>{if(!a||!isDay(a.day)||!Object.hasOwn(MARKETS,a.market)||!Number.isFinite(a.amount)||Math.abs(a.amount)>1e10||typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>500||typeof a.evidence!=='string'||!a.evidence.trim()||a.evidence.length>1000)throw new Error('INVALID_CORRECTION');
    let band=null;
    if(a.band!=null){if(typeof a.band!=='object'||Array.isArray(a.band))throw new Error('INVALID_CORRECTION');const keys=Object.keys(a.band).filter(k=>k!=='estimated');if(!keys.length||keys.some(k=>!BAND_KEYS.includes(k)||!Number.isFinite(a.band[k])||Math.abs(a.band[k])>1e11)||'estimated' in a.band&&a.band.estimated!==true)throw new Error('INVALID_CORRECTION');
      band=Object.fromEntries(BAND_KEYS.filter(k=>k in a.band).map(k=>[k,money(a.market,a.band[k])]));if(a.band.estimated)band.estimated=true;if(band.low!=null&&band.high!=null&&band.low>band.high)throw new Error('INVALID_CORRECTION');}
    // An amount of 0 with no band withdraws the day's adjustment of that market (C1a review, F1).
    if(a.market==='COMBINED'&&a.amount!==0)throw new Error('INVALID_CORRECTION');
    const key=a.day+'|'+a.market;if(seen.has(key))throw new Error('INVALID_CORRECTION');seen.add(key);
    return {day:a.day,market:a.market,currency:MARKETS[a.market],amount:money(a.market,a.amount),...(band?{band}:{}),reason:a.reason.trim(),evidence:a.evidence.trim()};});
}
function validSupersede(s){
  if(s==null)return null;
  if(typeof s!=='object'||!Array.isArray(s.pieceIds)||s.pieceIds.length>20||s.pieceIds.some(p=>typeof p!=='string'||!p||p.length>120)||new Set(s.pieceIds).size!==s.pieceIds.length||typeof s.reason!=='string'||!s.reason.trim()||s.reason.length>500)throw new Error('INVALID_CORRECTION');
  return {pieceIds:[...s.pieceIds],reason:s.reason.trim()};
}
const SEOUL=t=>new Date(t+9*3600000).toISOString().slice(0,10);
class ValuationCorrections {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS valuation_adjustments(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL)');}
  versions(account){return this.db.prepare('SELECT payload FROM valuation_adjustments WHERE account=?').all(account).map(r=>JSON.parse(r.payload)).sort((a,b)=>a.version-b.version);}
  // The adjustments in force: for each day and market, the latest version's (an amount of 0 with no band withdraws one).
  inForce(account){return ValuationCorrections.merge(this.versions(account));}
  static merge(versions){const out=new Map();for(const v of versions)for(const a of v.adjustments)out.set(a.day+'|'+a.market,{...a,version:v.version});return [...out.values()].filter(a=>a.amount!==0||a.band);}
  // The settlement pieces the latest version that names any supersedes (C1a); a version with an empty list ends it.
  superseded(account){return new Set(ValuationCorrections.supersedeOf(this.versions(account))?.pieceIds??[]);}
  static supersedeOf(versions){return versions.filter(x=>x.supersedes).at(-1)?.supersedes??null;}
  // performance: the PerformanceHistory. Returns the series summaries and the day-by-day values with the adjustments
  // in force and with them plus the proposed ones; nothing is written.
  preview(account,performance,proposed,{kind='COMBINED',benchmark=null}={}){
    const add=validate(proposed),current=this.inForce(account),keys=new Set(add.map(a=>a.day+'|'+a.market));const next=[...current.filter(a=>!keys.has(a.day+'|'+a.market)),...add];
    const before=performance.summary(account,kind,benchmark,{adjustments:current}),after=performance.summary(account,kind,benchmark,{adjustments:next});
    const pick=s=>({periods:s.periods.map(({label,twr,gain})=>({label,twr,gain})),maxDrawdownPct:s.analytics?.All?.maxDrawdownPct??null,end:s.points.at(-1)?.value??null});
    const days=after.points.map(p=>({day:p.day,before:before.points.find(q=>q.day===p.day)?.value??null,after:p.value}));
    return {kind,proposed:add,before:pick(before),after:pick(after),days:days.filter(d=>d.before!==d.after),written:false};
  }
  // Each band of the adjustments in force after this version against its recorded day: the band must contain the day's
  // value with the adjustments applied (the combined value: the recorded one plus the Korean amount and the U.S. amount at
  // the day's rate). A band on a day with no record is refused.
  checkBands(account,next){
    const rows=new Map(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nav_history'").get()?this.db.prepare('SELECT day,payload FROM nav_history WHERE account=?').all(account).map(r=>{let p=null;try{p=JSON.parse(r.payload);}catch{}return [r.day,p];}):[]);
    const amount=(day,market)=>next.find(a=>a.day===day&&a.market===market)?.amount??0;
    for(const a of next){if(!a.band)continue;const row=rows.get(a.day);if(!row)throw new Error('BAND_WITHOUT_RECORD');
      let value,high,low;
      if(a.market==='COMBINED'){value=row.equityKRW+amount(a.day,'KR')+amount(a.day,'US')*(row.fx??NaN);high=row.equityKRWHigh??row.equityKRW;low=row.equityKRWLow??row.equityKRW;}
      else{const m=a.market==='US'?row.USD:row.KRW;value=(m?.equity??NaN)+a.amount;high=m?.high??m?.equity;low=m?.low??m?.equity;}
      const hi=a.band.high??high,lo=a.band.low??low;if(!Number.isFinite(value)||!(lo<=value+0.005&&value<=hi+0.005))throw Object.assign(new Error('BAND_OUTSIDE_VALUE'),{detail:{day:a.day,market:a.market,value,low:lo,high:hi}});}
  }
  // A supersede may name only pieces that are closed, and every recorded day from the one holding a piece's opening to
  // the one holding its close must carry a U.S. adjustment in force (C1 review: no superseded piece changes a day nobody
  // corrected). Checked at every version against what is in force after it (C1a review, F1): a later version cannot
  // withdraw a covered day while the supersede stays; it ends the supersede with an empty list in the same version. A day holds an event when it is the first recorded day whose last reading is at or after it.
  checkSupersede(account,supersedes,adjustments){
    if(!supersedes)return;
    const events=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settlement_events'").get()?this.db.prepare('SELECT at,kind,payload FROM settlement_events WHERE account=? ORDER BY id').all(account).map(e=>({at:e.at,kind:e.kind,...JSON.parse(e.payload)})):[];
    const days=this.db.prepare('SELECT day,payload FROM nav_history WHERE account=? ORDER BY day').all(account).map(r=>{let p=null;try{p=JSON.parse(r.payload);}catch{}return {day:r.day,at:p?.at};}).filter(r=>Number.isFinite(r.at));
    const dayOf=t=>days.find(d=>d.at>=t)?.day??SEOUL(t);
    const covered=new Set(adjustments.filter(a=>a.market==='US').map(a=>a.day));
    for(const pid of supersedes.pieceIds){const mine=events.filter(e=>e.pieceId===pid);const open=mine.find(e=>e.kind==='piece-opened'),close=mine.find(e=>e.kind==='piece-closed');
      if(!open||!close)throw new Error('SUPERSEDE_UNCOVERED');const from=dayOf(open.at),to=dayOf(close.at);
      for(const d of days)if(d.day>=from&&d.day<=to&&!covered.has(d.day))throw new Error('SUPERSEDE_UNCOVERED');}
  }
  // Applies corrections as a new version. approval: {by, note}: the user's explicit approval, recorded with it.
  apply(account,proposed,approval,{supersedes=null}={}){
    if(typeof account!=='string'||!account||!approval||typeof approval.by!=='string'||!approval.by.trim())throw new Error('APPROVAL_REQUIRED');
    const adjustments=validate(proposed),sup=validSupersede(supersedes);const versions=this.versions(account),version=(versions.at(-1)?.version??0)+1;
    const record={id:randomUUID(),account,version,adjustments,...(sup?{supersedes:sup}:{}),approvedBy:approval.by.trim().slice(0,100),note:String(approval.note??'').slice(0,500),appliedAt:this.clock()};
    const all=[...versions,record],next=ValuationCorrections.merge(all);this.checkBands(account,next);const live=ValuationCorrections.supersedeOf(all);if(live?.pieceIds?.length)this.checkSupersede(account,live,next);
    this.db.prepare('INSERT INTO valuation_adjustments VALUES(?,?,?)').run(record.id,account,JSON.stringify(record));return record;
  }
}
module.exports={ValuationCorrections,validate,SettlementRestatements:require('./settlement-restatements.cjs').SettlementRestatements};
