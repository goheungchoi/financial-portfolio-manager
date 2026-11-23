'use strict';
// The screening history store (note 6, S2): daily closes for the stocks screens may use, read from KIS once a night,
// read-only, outside every session that matters. Public market data only: no account figure is read or kept here.
// - Kept per stock: at most KEEP completed closes (the script module's 311: the 250-day window, the 60-day offset and
//   one more), newest first to fill, then deeper while time is left; progress per stock survives a restart.
// - Closes are adjusted for splits as KIS gives them. Each nightly page overlaps the stored rows: a close that differs
//   on the overlap by more than 0.5% (a split or a correction) or a page with no overlap discards the stored rows, so
//   the stock is short of history (counted as no history for longer windows) until it deepens again; no seam is kept.
// - A row dated after its market's readable day (the last day whose session and closing print are over) is refused.
// - The start of a listing is an older page with no rows, never a short page (a Korean halt shortens a page).
// - Each stock is tried at most once a night for its newest page and once for deeper pages after a failure.
// - The refresher reads one page at a time, only inside the window (no regular session of either market, no extended
//   session you switched on, not the Korean late window, 15 minutes' margin each side of each), only while the KIS
//   queue and both order engines are idle and no app order is active (main.cjs, screen-wiring.cjs), at most 30 pages a
//   minute, and it stops at once when any of these changes; a read already sent finishes.
// - A rate-limit reply stops the refresh for the rest of that window. A failure counts against the stock that failed
//   and the plan moves on; a connection or sign-in failure pauses 5 minutes and blames no stock; three failures in a
//   row, or a store write that fails, pause 30 minutes; a stock that fails twice waits 12 hours.
const KEEP=311,PAGE_GAP_MS=2000,MARGIN_MS=15*60000,STOCK_TRIES=2,TOLERANCE=0.005,PLAN_MS=5*60000;
const {zoned,localDay,krTradingDay,usTradingDay,usEarlyClose}=require('./market-sessions.cjs');
const {krWindow}=require('./kr-hours.cjs');
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const marketOf=symbol=>/:/.test(symbol)?'US':'KR';
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const finite=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const CONNECTION=['NOT_CONNECTED','KIS_NOT_CONNECTED','BROKER_UNAVAILABLE','AUTH_FAILED','TOKEN_FAILED','NOT_SIGNED_IN'];
// The close of a session day in epoch ms: Korea 15:30 (moved with a shifted day), the U.S. 16:00 or 13:00 New York.
function closeAt(market,day){if(market==='KR'){const shift=krWindow(day).open-540;const m=930+shift;return zoned(day,`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`,'Asia/Seoul');}
  return zoned(day,usEarlyClose(day)?'13:00':'16:00','America/New_York');}
const tradingDay=(market,day,closedDays)=>market==='KR'?krTradingDay(day,closedDays):usTradingDay(day);
// The latest session day of a market whose close is at least `afterMs` old at `now`.
function closedDay(market,now,afterMs,closedDays=new Set()){let day=localDay(now,market==='KR'?'Asia/Seoul':'America/New_York');
  for(let i=0;i<15;i++,day=addDays(day,-1))if(tradingDay(market,day,closedDays)&&closeAt(market,day)+afterMs<=now)return day;return null;}
// The day a screen is as of, per market: the last session whose close the night's reads have had time to fetch
// (Korea: 6.5 hours after its close, about 22:00 KST; the U.S.: 2 hours after its close). A stock whose newest close is
// older is stale; a newer close (read early) is not used, so every stock of a market is as of the same day.
const AS_OF_AFTER={KR:390*60000,US:120*60000};
const asOfDay=(market,now,closedDays)=>closedDay(market,now,AS_OF_AFTER[market],closedDays);
// The newest close a read may store: the last day whose session and closing print are over (15 minutes after the close).
const readableDay=(market,now,closedDays)=>closedDay(market,now,MARGIN_MS,closedDays);
// The read window. sessionsOf(market, day) lists that day's sessions with their real start and end (market-sessions
// sessionsOn: regular sessions, and extended ones with tradable 'app' when you switched them on); lateWindow(t) is
// outside-fills' Korean late window. Closed within 15 minutes before a session starts until 15 minutes after it ends.
function windowOpen(now,{sessionsOf,lateWindow}){
  for(const t of [now-MARGIN_MS,now,now+MARGIN_MS])if(lateWindow(t))return false;
  for(const [market,tz] of [['KR','Asia/Seoul'],['US','America/New_York']]){const today=localDay(now,tz);
    for(const day of [addDays(today,-1),today,addDays(today,1)])for(const s of sessionsOf(market,day)??[]){
      if(!s.regular&&s.tradable!=='app')continue;if(s.startAt-MARGIN_MS<=now&&now<s.endAt+MARGIN_MS)return false;}}
  return true;}
class HistoryStore{
  // readOnly: the screening engine's own connection (screen-worker.cjs) creates and alters nothing.
  constructor(db,{readOnly=false}={}){this.db=db;if(readOnly)return;
    db.exec('CREATE TABLE IF NOT EXISTS screen_closes(symbol TEXT NOT NULL,date TEXT NOT NULL,close REAL NOT NULL,high REAL,low REAL,volume REAL,value REAL,PRIMARY KEY(symbol,date)) WITHOUT ROWID;'
      +'CREATE TABLE IF NOT EXISTS screen_progress(symbol TEXT PRIMARY KEY,newest TEXT,oldest TEXT,depth INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,readAt INTEGER,failures INTEGER NOT NULL DEFAULT 0,failedAt INTEGER);'
      +'CREATE TABLE IF NOT EXISTS screen_requests(symbol TEXT PRIMARY KEY,at INTEGER NOT NULL);');
    // Columns added after the first staging: a database that ran an earlier build gets them here.
    const have=new Set(db.prepare('PRAGMA table_info(screen_progress)').all().map(c=>c.name));
    for(const [name,type] of [['triedNewest','TEXT'],['triedDeeper','TEXT'],['resets','INTEGER NOT NULL DEFAULT 0'],['resetDay','TEXT'],['resetNights','INTEGER NOT NULL DEFAULT 0'],['stopped','TEXT']])
      if(!have.has(name))db.exec(`ALTER TABLE screen_progress ADD COLUMN ${name} ${type}`);}
  progress(symbol){return this.db.prepare('SELECT * FROM screen_progress WHERE symbol=?').get(symbol)??null;}
  // A stock that stopped deepening tries again 30 days after its last reset.
  retryStopped(now=Date.now()){const day=new Date(now-30*86400000).toISOString().slice(0,10);return this.db.prepare('UPDATE screen_progress SET stopped=NULL,resetNights=0 WHERE stopped IS NOT NULL AND (resetDay IS NULL OR resetDay<?)').run(day).changes;}
  stoppedCount(){const rows=this.db.prepare('SELECT stopped,COUNT(*) AS n FROM screen_progress WHERE stopped IS NOT NULL GROUP BY stopped').all();return {count:rows.reduce((a,r)=>a+r.n,0),reasons:rows.map(r=>r.stopped)};}
  progressAll(){const out=new Map();for(const r of this.db.prepare('SELECT * FROM screen_progress').all())out.set(r.symbol,r);return out;}
  closes(symbol){return this.db.prepare('SELECT date,close,high,low,volume,value FROM screen_closes WHERE symbol=? ORDER BY date').all(symbol).map(r=>({...r}));}
  // Where a deeper page ends: the fifth-oldest stored day, so the page overlaps up to five stored rows.
  deeperEnd(symbol){return this.db.prepare('SELECT date FROM screen_closes WHERE symbol=? ORDER BY date LIMIT 1 OFFSET 4').get(symbol)?.date??this.progress(symbol)?.newest??null;}
  // A page merged in. kind 'newest' (ending on the readable day) or 'deeper' (ending on deeperEnd); day is the readable
  // day of the night (rows after it are refused). Returns {reset, older, failed}:
  // - a deeper page with no stored row in it (empty, or the overlap missing) changes nothing and is a failure;
  // - a deeper page holding the overlap and nothing older is the listing's start;
  // - a close differing on the overlap by more than 0.5%, or a newest page with no overlap, resets the stock: its rows are
  //   discarded, the newest page is kept (read again after a deeper reset), and it is not deepened again that night.
  //   After resets on 3 nights within 4 days of each other it stops deepening, with a reason the Scout panel shows.
  put(symbol,rows,{kind='newest',day=null,now=Date.now()}={}){
    const clean=[];const seen=new Set();for(const r of Array.isArray(rows)?rows:[]){const close=finite(r?.close);if(!DAY.test(r?.date??'')||!(close>0)||seen.has(r.date)||(day&&r.date>day))continue;seen.add(r.date);
      clean.push({date:r.date,close,high:finite(r.high),low:finite(r.low),volume:finite(r.volume),value:finite(r.value)});}
    clean.sort((a,b)=>a.date.localeCompare(b.date));const before=this.progress(symbol);
    const stored=before?.newest&&clean.length?new Map(this.db.prepare('SELECT date,close FROM screen_closes WHERE symbol=? AND date>=? AND date<=?').all(symbol,clean[0].date,clean.at(-1).date).map(r=>[r.date,r.close])):new Map();
    const overlap=clean.filter(r=>stored.has(r.date));const differs=overlap.some(r=>Math.abs(r.close-stored.get(r.date))>TOLERANCE*stored.get(r.date));
    const older=kind==='deeper'&&before?.oldest?clean.filter(r=>r.date<before.oldest).length:0;
    if(kind==='deeper'&&!overlap.length)return {reset:false,older,failed:'NO_OVERLAP'};
    const reset=Boolean(before?.newest&&clean.length&&(differs||(kind==='newest'&&!overlap.length)));
    this.db.exec('BEGIN IMMEDIATE');
    try{if(reset)this.db.prepare('DELETE FROM screen_closes WHERE symbol=?').run(symbol);
      if(!(kind==='deeper'&&reset)){const put=this.db.prepare('INSERT INTO screen_closes VALUES(?,?,?,?,?,?,?) ON CONFLICT(symbol,date) DO UPDATE SET close=excluded.close,high=excluded.high,low=excluded.low,volume=excluded.volume,value=excluded.value');
        for(const r of clean)put.run(symbol,r.date,r.close,r.high,r.low,r.volume,r.value);}
      const count=this.db.prepare('SELECT COUNT(*) AS n FROM screen_closes WHERE symbol=?').get(symbol).n;
      if(count>KEEP)this.db.prepare('DELETE FROM screen_closes WHERE symbol=? AND date<(SELECT date FROM screen_closes WHERE symbol=? ORDER BY date DESC LIMIT 1 OFFSET ?)').run(symbol,symbol,KEEP-1);
      const span=this.db.prepare('SELECT MIN(date) AS oldest,MAX(date) AS newest,COUNT(*) AS n FROM screen_closes WHERE symbol=?').get(symbol);
      const nights=reset?(before?.resetDay&&day&&(Date.parse(day)-Date.parse(before.resetDay))/86400000<=4&&before.resetDay!==day?(before.resetNights??0)+1:before?.resetDay===day?(before.resetNights??1):1):(before?.resetNights??0);
      const p={newest:span.newest,oldest:span.oldest,depth:span.n,complete:span.n>=KEEP||(kind==='deeper'&&!reset&&older===0)?1:reset?0:(before?.complete??0),readAt:now,
        triedNewest:kind==='deeper'&&reset?null:kind==='newest'?day:(before?.triedNewest??null),triedDeeper:reset?day:(before?.triedDeeper??null),resets:(before?.resets??0)+(reset?1:0),
        resetDay:reset?day:(before?.resetDay??null),resetNights:nights,stopped:reset&&nights>=3?'the closes KIS gives keep changing between reads':(before?.stopped??null)};
      this.db.prepare('INSERT INTO screen_progress(symbol,newest,oldest,depth,complete,readAt,failures,failedAt,triedNewest,triedDeeper,resets,resetDay,resetNights,stopped) VALUES(?,?,?,?,?,?,0,NULL,?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET newest=excluded.newest,oldest=excluded.oldest,depth=excluded.depth,complete=excluded.complete,readAt=excluded.readAt,failures=0,failedAt=NULL,triedNewest=excluded.triedNewest,triedDeeper=excluded.triedDeeper,resets=excluded.resets,resetDay=excluded.resetDay,resetNights=excluded.resetNights,stopped=excluded.stopped')
        .run(symbol,p.newest,p.oldest,p.depth,p.complete,p.readAt,p.triedNewest,p.triedDeeper,p.resets,p.resetDay,p.resetNights,p.stopped);
      this.db.exec('COMMIT');}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return {reset,older,progress:this.progress(symbol)};}
  // A failed read counts against the stock and marks the page kind as tried for that readable day.
  fail(symbol,{kind='newest',day=null,now=Date.now()}={}){const col=kind==='deeper'?'triedDeeper':'triedNewest';
    this.db.prepare(`INSERT INTO screen_progress(symbol,failures,failedAt,${col}) VALUES(?,1,?,?) ON CONFLICT(symbol) DO UPDATE SET failures=failures+1,failedAt=excluded.failedAt,${col}=excluded.${col}`).run(symbol,now,day);}
  // Symbols a script named outside the nightly set: at most 100, kept 7 days, read with the next night's set.
  request(symbols,now=Date.now()){const put=this.db.prepare('INSERT INTO screen_requests VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET at=excluded.at');
    for(const s of symbols)put.run(s,now);this.db.prepare('DELETE FROM screen_requests WHERE at<?').run(now-7*86400000);
    this.db.prepare('DELETE FROM screen_requests WHERE symbol NOT IN (SELECT symbol FROM screen_requests ORDER BY at DESC,symbol LIMIT 100)').run();}
  requested(now=Date.now()){return this.db.prepare('SELECT symbol FROM screen_requests WHERE at>=? ORDER BY at DESC,symbol LIMIT 100').all(now-7*86400000).map(r=>r.symbol);}
  // Stocks no longer in the set and not requested are dropped after 14 days unread, to bound the table.
  prune(keep,now=Date.now()){const keepSet=new Set(keep);const old=this.db.prepare('SELECT symbol FROM screen_progress WHERE COALESCE(readAt,failedAt,0)<?').all(now-14*86400000).map(r=>r.symbol).filter(s=>!keepSet.has(s));
    for(const s of old){this.db.prepare('DELETE FROM screen_closes WHERE symbol=?').run(s);this.db.prepare('DELETE FROM screen_progress WHERE symbol=?').run(s);}return old.length;}
  // How deep the store is per market, for the coverage and the Scout panel.
  depth(symbols){const out={};for(const s of symbols){const m=marketOf(s);const p=this.progress(s);const o=out[m]??={stocks:0,read:0,full:0,stopped:0,depths:[]};o.stocks++;if(p?.stopped)o.stopped++;if(p?.depth){o.read++;o.depths.push(p.depth);if(p.depth>=KEEP||p.complete)o.full++;}}
    for(const o of Object.values(out)){o.depths.sort((a,b)=>a-b);o.median=o.depths.length?o.depths[Math.floor(o.depths.length/2)]:0;o.least=o.depths[0]??0;delete o.depths;}return out;}
}
// The nightly refresher. deps: {store, set(): ordered symbols, request(symbol, end): Promise of rows, allowed(now):
// {ok, why, outside}, closedDays(), clock}. tick() is called every second; it starts at most one read and never two
// at once, and with nothing to read it does no work until the plan is due again.
class HistoryRefresher{
  constructor(deps){this.deps=deps;this.reading=null;this.lastStart=0;this.pauseUntil=0;this.inRow=0;this.plan=null;this.planAt=0;this.progressed=false;this.rateStopUntil=0;this.status={state:'idle',read:0,failed:0,resets:0,why:null};}
  clock(){return (this.deps.clock??Date.now)();}
  // The work list: each stock's newest page when it lacks the readable day and was not tried for it, then deeper pages.
  buildPlan(now){const {store,set}=this.deps;try{store.retryStopped?.(now);}catch{}const closed=this.deps.closedDays?.()??new Set();const want={KR:readableDay('KR',now,closed),US:readableDay('US',now,closed)};const all=store.progressAll();
    const newest=[],deeper=[];for(const s of set()){const p=all.get(s);if(p&&p.failures>=STOCK_TRIES&&p.failedAt>now-12*3600000)continue;const day=want[marketOf(s)];if(!day)continue;
      if((!p?.newest||p.newest<day)&&p?.triedNewest!==day)newest.push({symbol:s,kind:'newest',end:day,day});
      else if(p?.newest&&!p.complete&&!p.stopped&&p.depth<KEEP&&p.triedDeeper!==day)deeper.push({symbol:s,kind:'deeper',day});}
    return [...newest,...deeper];}
  tick(now=this.clock()){
    if(this.reading)return;
    if(now<this.pauseUntil){this.status.state='paused';return;}
    if(now-this.lastStart<PAGE_GAP_MS)return;
    // Nothing to read: no work (no window test, no order test) until the plan is due again.
    if(this.plan&&!this.plan.length&&!this.progressed&&now-this.planAt<PLAN_MS){this.status.state='done';return;}
    // Checked just before each read, so a session, an order or any other KIS request stops the refresh at once.
    const allowed=this.deps.allowed(now);
    // After a rate-limit reply: stopped for the rest of the window or 3 hours, whichever is shorter; the window itself keeps
    // every read 15 minutes from any session.
    if(now<this.rateStopUntil){if(allowed.outside)this.rateStopUntil=0;else{this.status.state='stopped';this.status.why='a rate-limit reply: stopped for this window';return;}}
    if(!allowed.ok){this.status.state='waiting';this.status.why=allowed.why;return;}
    if(!this.plan||now-this.planAt>PLAN_MS){this.plan=this.buildPlan(now);this.planAt=now;this.progressed=false;}
    // A plan that made progress and ran out is rebuilt at once (deeper pages come next); one that made none waits.
    let task=this.plan.shift();if(!task&&this.progressed){this.plan=this.buildPlan(now);this.planAt=now;this.progressed=false;task=this.plan.shift();}
    if(!task){this.status.state='done';this.status.why=null;return;}
    if(task.kind==='deeper')task.end=this.deps.store.deeperEnd(task.symbol);
    this.lastStart=now;this.status.state='reading';this.status.why=null;
    let sent;try{sent=Promise.resolve(this.deps.request(task.symbol,task.end));}catch(error){sent=Promise.reject(error);}
    this.reading=sent.then(rows=>{const t=this.clock();
        let r;try{r=this.deps.store.put(task.symbol,rows,{kind:task.kind,day:task.day,now:t});}
        catch{this.inRow=0;this.pauseUntil=t+30*60000;this.plan=null;this.status.failed++;this.status.why='the store could not be written';return;}
        // A deeper page with no stored row in it (empty, or the overlap missing) is that stock's failure.
        if(r.failed){try{this.deps.store.fail(task.symbol,{kind:task.kind,day:task.day,now:t});}catch{}this.status.failed++;if(++this.inRow>=3){this.inRow=0;this.pauseUntil=t+30*60000;this.plan=null;}return;}
        this.inRow=0;this.progressed=true;this.status.read++;if(r.reset)this.status.resets++;},
      error=>{const code=error?.code??error?.message;const t=this.clock();
        if(code==='RATE_LIMITED'){this.rateStopUntil=t+3*3600000;this.plan=null;return;}
        if(CONNECTION.includes(code)){this.pauseUntil=t+5*60000;this.plan=null;return;}
        try{this.deps.store.fail(task.symbol,{kind:task.kind,day:task.day,now:t});}catch{}this.status.failed++;
        if(++this.inRow>=3){this.inRow=0;this.pauseUntil=t+30*60000;this.plan=null;}})
      .finally(()=>{this.reading=null;});}
}
module.exports={HistoryStore,HistoryRefresher,windowOpen,asOfDay,readableDay,closeAt,closedDay,marketOf,KEEP,PAGE_GAP_MS,MARGIN_MS,TOLERANCE};
