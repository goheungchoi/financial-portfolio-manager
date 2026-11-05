// Completeness of the KIS U.S. trade history (stage 2a). OverseasClient.trades() reads one date range and says whether
// it reached the last page; it never returns a partial range as if it were whole (it used to stop silently after 10
// pages). A range with more pages than one read allows is read again in halves, down to single days. Any range that still
// could not be read whole (a repeated page or continuation key, a missing key, a single day over the page limit) is kept
// as a gap per account, across restarts, until a later read of those dates is complete; tax reports name every gap.
const DAY=86400000;
const addDay=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const REASONS={PAGE_LIMIT:'more pages than one read allows',DUPLICATE_PAGE:'KIS returned a page twice',MISSING_CURSOR:'KIS gave no continuation key for the next page'};
// One read's result, checked: rows, and complete only when KIS reported the last page.
function result(r,start,end){if(!r||typeof r!=='object'||!Array.isArray(r.rows)||typeof r.complete!=='boolean')throw new Error('INVALID_RESPONSE');return {start,end,complete:r.complete,reason:r.complete?null:REASONS[r.reason]?r.reason:'INCOMPLETE',rows:r.rows,pages:Number.isInteger(r.pages)?r.pages:null};}
// Reads start..end through fetch(start,end) (one trades() call), halving a range that hit the page limit. Returns the
// ranges read, each {start,end,complete,reason,rows,pages}, in date order. A trade's rows share a trade date, so the
// halves never split the rows one import counts together.
async function readTradeHistory(fetch,start,end){
  const r=result(await fetch(start,end),start,end);if(r.complete||r.reason!=='PAGE_LIMIT'||start>=end)return [r];
  const mid=addDay(start,Math.floor((Date.parse(end)-Date.parse(start))/DAY/2));
  return [...await readTradeHistory(fetch,start,mid),...await readTradeHistory(fetch,addDay(mid,1),end)];
}
// Date ranges of an account whose history could not be read whole, kept until a complete read covers them.
class HistoryGaps{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trade_history_gaps(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  list(account){const r=this.db.prepare('SELECT payload FROM trade_history_gaps WHERE account=?').get(account);return r?JSON.parse(r.payload):[];}
  all(){return this.db.prepare('SELECT account,payload FROM trade_history_gaps').all().flatMap(r=>JSON.parse(r.payload).map(g=>({...g,account:r.account})));}
  // A read of start..end: complete, it removes those dates from the gaps (a gap partly covered keeps its other dates);
  // incomplete, the range becomes a gap, keeping the time the dates were first found incomplete.
  record(account,{start,end,complete,reason},now=Date.now()){
    const before=this.list(account),overlap=before.filter(g=>g.start<=end&&g.end>=start),kept=[];
    for(const g of before){if(g.end<start||g.start>end){kept.push(g);continue;}if(g.start<start)kept.push({...g,end:addDay(start,-1)});if(g.end>end)kept.push({...g,start:addDay(end,1)});}
    if(!complete)kept.push({start,end,reason,since:Math.min(now,...overlap.map(g=>g.since)),checkedAt:now});
    kept.sort((a,b)=>a.start.localeCompare(b.start));
    if(kept.length)this.db.prepare('INSERT INTO trade_history_gaps VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(kept));
    else this.db.prepare('DELETE FROM trade_history_gaps WHERE account=?').run(account);
    return kept;
  }
}
const describe=g=>`U.S. trade history ${g.start} to ${g.end} could not be read completely (${REASONS[g.reason]??'incomplete'}); trades of those dates may be missing`;
module.exports={readTradeHistory,HistoryGaps,describe,addDay,REASONS};
