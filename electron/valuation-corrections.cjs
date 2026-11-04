// Versioned corrections to recorded account values (audit 2026-11-04, Stage 2). A recorded day's value is never
// rewritten: a correction is an adjustment kept beside it, with its reason, its evidence and who approved it, and the
// performance series is computed with the adjustments in force (electron/performance.cjs series). Corrections are
// previewed first (preview: returns, drawdown and the day-by-day values with and without them, nothing written) and
// applied only with the user's approval (apply), each as a new version that supersedes the earlier one for its days.
// A correction is never computed from today's prices: its amount comes from the record it corrects.
const {randomUUID}=require('node:crypto');
const isDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v);
function validate(list){
  if(!Array.isArray(list)||!list.length||list.length>60)throw new Error('INVALID_CORRECTION');
  return list.map(a=>{if(!a||!isDay(a.day)||!['KR','US'].includes(a.market)||!Number.isFinite(a.amount)||a.amount===0||Math.abs(a.amount)>1e10||typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>500||typeof a.evidence!=='string'||!a.evidence.trim()||a.evidence.length>1000)throw new Error('INVALID_CORRECTION');
    return {day:a.day,market:a.market,currency:a.market==='US'?'USD':'KRW',amount:a.market==='US'?Math.round(a.amount*100)/100:Math.round(a.amount),reason:a.reason.trim(),evidence:a.evidence.trim()};});
}
class ValuationCorrections {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS valuation_adjustments(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL)');}
  versions(account){return this.db.prepare('SELECT payload FROM valuation_adjustments WHERE account=?').all(account).map(r=>JSON.parse(r.payload)).sort((a,b)=>a.version-b.version);}
  // The adjustments in force: for each day and market, the latest version's.
  inForce(account){const out=new Map();for(const v of this.versions(account))for(const a of v.adjustments)out.set(a.day+'|'+a.market,{...a,version:v.version});return [...out.values()].filter(a=>a.amount!==0);}
  // performance: the PerformanceHistory. Returns the series summaries and the day-by-day values with the adjustments
  // in force and with them plus the proposed ones; nothing is written.
  preview(account,performance,proposed,{kind='COMBINED',benchmark=null}={}){
    const add=validate(proposed),current=this.inForce(account),keys=new Set(add.map(a=>a.day+'|'+a.market));const next=[...current.filter(a=>!keys.has(a.day+'|'+a.market)),...add];
    const before=performance.summary(account,kind,benchmark,{adjustments:current}),after=performance.summary(account,kind,benchmark,{adjustments:next});
    const pick=s=>({periods:s.periods.map(({label,twr,gain})=>({label,twr,gain})),maxDrawdownPct:s.analytics?.All?.maxDrawdownPct??null,end:s.points.at(-1)?.value??null});
    const days=after.points.map(p=>({day:p.day,before:before.points.find(q=>q.day===p.day)?.value??null,after:p.value}));
    return {kind,proposed:add,before:pick(before),after:pick(after),days:days.filter(d=>d.before!==d.after),written:false};
  }
  // Applies corrections as a new version. approval: {by, note}: the user's explicit approval, recorded with it.
  apply(account,proposed,approval){
    if(typeof account!=='string'||!account||!approval||typeof approval.by!=='string'||!approval.by.trim())throw new Error('APPROVAL_REQUIRED');
    const adjustments=validate(proposed);const version=(this.versions(account).at(-1)?.version??0)+1;
    const record={id:randomUUID(),account,version,adjustments,approvedBy:approval.by.trim().slice(0,100),note:String(approval.note??'').slice(0,500),appliedAt:this.clock()};
    this.db.prepare('INSERT INTO valuation_adjustments VALUES(?,?,?)').run(record.id,account,JSON.stringify(record));return record;
  }
}
module.exports={ValuationCorrections,validate};
