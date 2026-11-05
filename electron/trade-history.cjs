// Completeness of the KIS U.S. trade history (stage 2a). OverseasClient.trades() reads one date range and says whether
// it reached the last page; it never returns a partial range as if it were whole (it used to stop silently after 10
// pages). A range with more pages than one read allows is read again in halves, down to single days.
// Every range read gives a result, a failed read included (stage 2a review, P1): nothing already learned is lost when a
// later read fails. A range that could not be read whole (a repeated page or key, a missing key, an invalid response, a
// single day over the page limit, a failed read) is kept as a gap per account, across restarts, until a later complete
// read of those dates; gaps are retried with backoff. Reads run as a job with a page and time budget; a job that stops
// (budget, time or a failed read) keeps its unread ranges and resumes from them, not from the start (review, P2).
const DAY=86400000;
const addDay=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const REASONS={PAGE_LIMIT:'more pages than one read allows',DUPLICATE_PAGE:'KIS returned a page twice',MISSING_CURSOR:'KIS gave no continuation key for the next page',INVALID_RESPONSE:'KIS returned a response that could not be read',READ_FAILED:'the read failed',NOT_READ:'not read yet; the read stopped and resumes at the next check'};
// Pages one read may take (OverseasClient TRADE_PAGES), and what one job may take: pages and elapsed time.
const READ_PAGES=50,JOB_PAGES=150,JOB_MS=3*60000;
// Retry spacing after a failed job or an incomplete range: 15 minutes, doubling, at most 6 hours.
const backoff=attempts=>Math.min(6*3600000,15*60000*2**Math.max(0,attempts-1));
// Consecutive ranges of at most `days` days covering from..to.
function windows(from,to,days=90){const out=[];for(let start=from;start<=to;){const end=[addDay(start,days-1),to].sort()[0];out.push({start,end});start=addDay(end,1);}return out;}
// ranges less the dates of cut, each range kept with its other fields.
function subtract(ranges,cut){const out=[];for(const g of ranges){if(g.end<cut.start||g.start>cut.end){out.push(g);continue;}if(g.start<cut.start)out.push({...g,end:addDay(cut.start,-1)});if(g.end>cut.end)out.push({...g,start:addDay(cut.end,1)});}return out;}
// One read's result, checked: rows, and complete only when KIS reported the last page.
function result(r,start,end){if(!r||typeof r!=='object'||!Array.isArray(r.rows)||typeof r.complete!=='boolean')throw new Error('INVALID_RESPONSE');return {start,end,complete:r.complete,reason:r.complete?null:REASONS[r.reason]?r.reason:'INVALID_RESPONSE',rows:r.complete?r.rows:[],pages:Number.isInteger(r.pages)?r.pages:null};}
// Reads the queue of ranges front to back through fetch(start,end,{maxPages}) (one trades() call). A range over the
// page limit is replaced in the queue by its halves; a read that throws, or returns something that is not a result, is a
// READ_FAILED result and stops the job with that range still queued. The job also stops before a read the page budget
// cannot cover in full, or once its time is up. step({result,queue}) runs after every read (result null after a split),
// so the caller can store the result and the queue together. A trade's rows share a trade date, so halves never split
// the rows one import counts together.
async function readRanges(fetch,queue,{pages=JOB_PAGES,ms=JOB_MS,perRead=READ_PAGES,clock=Date.now,step=()=>{}}={}){
  queue=queue.map(({start,end})=>({start,end}));const results=[],began=clock();let used=0,stopped=null,code=null;
  while(queue.length){
    if(pages-used<perRead){stopped='BUDGET';break;}if(clock()-began>=ms){stopped='TIME';break;}
    const {start,end}=queue[0];let r;
    try{r=result(await fetch(start,end,{maxPages:perRead}),start,end);used+=r.pages??perRead;}
    catch(error){code=/^[A-Z_]{3,40}$/.test(error?.message??'')?error.message:'READ_FAILED';used+=1;r={start,end,complete:false,reason:'READ_FAILED',code,rows:[],pages:null};results.push(r);await step({result:r,queue:[...queue]});stopped='FAILED';break;}
    if(!r.complete&&r.reason==='PAGE_LIMIT'&&start<end){const mid=addDay(start,Math.floor((Date.parse(end)-Date.parse(start))/DAY/2));queue.splice(0,1,{start,end:mid},{start:addDay(mid,1),end});await step({result:null,queue:[...queue]});continue;}
    queue.shift();results.push(r);await step({result:r,queue:[...queue]});
  }
  return {results,remaining:queue,stopped,code};
}
// A single range read within the budget, without storage (settlement checks): every date is in a result, the dates not
// reached as NOT_READ, in date order. Never throws for a read: a failure is a READ_FAILED result with its code.
async function readTradeHistory(fetch,start,end,limits={}){
  const {results,remaining}=await readRanges(fetch,[{start,end}],limits);
  return [...results,...remaining.filter(r=>!results.some(x=>x.start===r.start&&x.end===r.end)).map(r=>({...r,complete:false,reason:'NOT_READ',rows:[],pages:0}))].sort((a,b)=>a.start.localeCompare(b.start));
}
// Date ranges of an account whose history could not be read whole, kept until a complete read covers them.
class HistoryGaps{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trade_history_gaps(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  list(account){const r=this.db.prepare('SELECT payload FROM trade_history_gaps WHERE account=?').get(account);return r?JSON.parse(r.payload):[];}
  all(){return this.db.prepare('SELECT account,payload FROM trade_history_gaps').all().flatMap(r=>JSON.parse(r.payload).map(g=>({...g,account:r.account})));}
  // Gaps due for another read.
  due(account,now=Date.now()){return this.list(account).filter(g=>!(g.nextAt>now));}
  // A read of start..end: complete, it removes those dates from the gaps (a gap partly covered keeps its other dates);
  // incomplete, the range becomes a gap, keeping the time the dates were first found incomplete and counting attempts.
  record(account,{start,end,complete,reason,code=null},now=Date.now()){
    const before=this.list(account),overlap=before.filter(g=>g.start<=end&&g.end>=start),kept=subtract(before,{start,end});
    if(!complete){const attempts=Math.max(0,...overlap.map(g=>g.attempts??0))+1;kept.push({start,end,reason,...(code?{code}:{}),since:Math.min(now,...overlap.map(g=>g.since)),checkedAt:now,attempts,nextAt:now+backoff(attempts)});}
    kept.sort((a,b)=>a.start.localeCompare(b.start));
    if(kept.length)this.db.prepare('INSERT INTO trade_history_gaps VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(kept));
    else this.db.prepare('DELETE FROM trade_history_gaps WHERE account=?').run(account);
    return kept;
  }
}
// The unfinished read job of each account: its queue of ranges still to read, stored after every read.
class HistoryJobs{
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS trade_history_jobs(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    // A job still running when the app stopped was interrupted: it is resumed from its stored queue.
    db.prepare("UPDATE trade_history_jobs SET payload=json_set(payload,'$.state','paused','$.stopped','INTERRUPTED') WHERE json_extract(payload,'$.state')='running'").run();}
  get(account){const r=this.db.prepare('SELECT payload FROM trade_history_jobs WHERE account=?').get(account);return r?JSON.parse(r.payload):null;}
  all(){return this.db.prepare('SELECT account,payload FROM trade_history_jobs').all().map(r=>({...JSON.parse(r.payload),account:r.account}));}
  put(account,job){this.db.prepare('INSERT INTO trade_history_jobs VALUES(?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload').run(account,JSON.stringify(job));}
  clear(account){this.db.prepare('DELETE FROM trade_history_jobs WHERE account=?').run(account);}
}
const describe=g=>`U.S. trade history ${g.start} to ${g.end} could not be read completely (${REASONS[g.reason]??'incomplete'}${g.code&&g.code!==g.reason?': '+g.code:''}); trades of those dates may be missing`;
module.exports={readRanges,readTradeHistory,HistoryGaps,HistoryJobs,describe,addDay,windows,subtract,backoff,REASONS,READ_PAGES,JOB_PAGES,JOB_MS};
