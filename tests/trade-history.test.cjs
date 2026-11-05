// Stage 2a: the U.S. trade history is never cut short silently. Pagination past the old 10-page stop, ranges read in
// halves, repeated pages, gaps kept across restarts, and incomplete history carried into settlement and tax reports.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {OverseasClient}=require('../electron/kis-overseas.cjs');const {readTradeHistory,HistoryGaps}=require('../electron/trade-history.cjs');
const {TradingCosts,DEFAULT_COSTS}=require('../electron/trading-costs.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');

// A KIS row as CTOS4001R returns it (fields of the 2026-10-25 read-only response).
const raw=(day,ticker,qty=1,price=100)=>({trad_dt:day.replaceAll('-',''),sttl_dt:day.replaceAll('-',''),sll_buy_dvsn_cd:'02',pdno:ticker,ccld_qty:String(qty),ft_ccld_unpr2:String(price),tr_frcr_amt2:String(qty*price),frcr_excc_amt_1:String(qty*price),wcrc_excc_amt:String(qty*price*1400),dmst_frcr_fee1:'0',frcr_fee1:'',crcy_cd:'USD',erlm_exrt:'1400'});
// A fake KIS serving the rows of the requested trade dates, size rows a page. tamper(page,response) alters a reply.
function kis(all,{size=1,tamper=(page,r)=>r}={}){
  const calls=[];
  const client=new OverseasClient({overseasIdentity:()=>({environment:'live'}),overseasRequest:async(path,trId,params,options)=>{
    calls.push({start:params.ERLM_STRT_DT,end:params.ERLM_END_DT,nk:params.CTX_AREA_NK100,continuation:options.continuation});
    const d=v=>`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`;const rows=all.filter(r=>{const t=d(r.trad_dt);return t>=d(params.ERLM_STRT_DT)&&t<=d(params.ERLM_END_DT);});
    const page=params.CTX_AREA_NK100?Number(params.CTX_AREA_NK100.slice(1)):0,more=(page+1)*size<rows.length;
    return tamper(page,{body:{output1:rows.slice(page*size,(page+1)*size),ctx_area_fk100:more?'f':'',ctx_area_nk100:more?'p'+(page+1):''},continuation:more?'M':''});}});
  return {client,calls};
}
const days=(from,n,per=1)=>Array.from({length:n},(_,i)=>new Date(Date.parse(from+'T00:00:00Z')+i*86400000).toISOString().slice(0,10)).flatMap(day=>Array.from({length:per},(_,k)=>raw(day,'T'+String.fromCharCode(65+k))));
function costsDb(db=new DatabaseSync(':memory:')){db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});costs.save({...DEFAULT_COSTS,taxYear:2026,annualRealizedKRW:0});return {db,costs};}
const stored=costs=>costs.db.prepare('SELECT payload FROM tax_events').all().map(r=>JSON.parse(r.payload)).sort((x,y)=>x.tradeDate.localeCompare(y.tradeDate)||x.symbol.localeCompare(y.symbol));

test('pagination: more than the old 10 pages are all read, and the read is complete',async()=>{
  const {client,calls}=kis(days('2026-03-02',13));const r=await client.trades('2026-03-01','2026-03-31');
  assert.equal(r.complete,true);assert.equal(r.reason,null);assert.equal(r.pages,13);assert.equal(r.rows.length,13,'the old code stopped at 10 rows here and called it the whole month');
  assert.deepEqual(calls.slice(0,2).map(c=>[c.nk,c.continuation]),[['',''],['p1','N']],'continuation keys and header follow KIS');
});
test('pagination: a range over the page limit is marked incomplete, then read in halves down to single days',async()=>{
  const {client}=kis(days('2026-03-02',6,2));const fetch=(a,b)=>client.trades(a,b,{maxPages:3});
  const one=await fetch('2026-03-02','2026-03-07');assert.equal(one.complete,false);assert.equal(one.reason,'PAGE_LIMIT');assert.equal(one.rows.length,3,'what was read is returned, not as the whole range');
  const ranges=await readTradeHistory(fetch,'2026-03-02','2026-03-07');
  assert.ok(ranges.every(r=>r.complete),'every half fits');assert.equal(ranges.flatMap(r=>r.rows).length,12,'all twelve trades');
  assert.equal(ranges[0].start,'2026-03-02');assert.equal(ranges.at(-1).end,'2026-03-07');for(let i=1;i<ranges.length;i++)assert.equal(Date.parse(ranges[i].start)-Date.parse(ranges[i-1].end),86400000,'contiguous, no day skipped or read twice');
  const {costs}=costsDb();assert.deepEqual(costs.importHistory('a',ranges,1),{added:12,incomplete:[]});assert.deepEqual(costs.historyGaps(),[]);
});
test('pagination: a single day over the page limit stays incomplete and imports nothing for that day',async()=>{
  const {client}=kis([...days('2026-03-02',1),...days('2026-03-03',1,4),...days('2026-03-04',1)]);const ranges=await readTradeHistory((a,b)=>client.trades(a,b,{maxPages:3}),'2026-03-02','2026-03-04');
  const bad=ranges.filter(r=>!r.complete);assert.deepEqual(bad.map(r=>[r.start,r.end,r.reason]),[['2026-03-03','2026-03-03','PAGE_LIMIT']]);
  const {costs}=costsDb();const out=costs.importHistory('a',ranges,1);assert.equal(out.added,2,'the two complete days');assert.deepEqual(out.incomplete,[{start:'2026-03-03',end:'2026-03-03',reason:'PAGE_LIMIT'}]);
  assert.deepEqual(stored(costs).map(e=>e.tradeDate),['2026-03-02','2026-03-04']);
});
test('duplicate pages: a repeated continuation key or a repeated page is not taken as more rows',async()=>{
  const key=kis(days('2026-03-02',5),{tamper:(page,r)=>page>=1?{...r,body:{...r.body,ctx_area_nk100:'p2'}}:r});const a=await key.client.trades('2026-03-01','2026-03-31');
  assert.equal(a.complete,false);assert.equal(a.reason,'DUPLICATE_PAGE');assert.equal(a.rows.length,3,'pages 1-3 once each; the loop stops at the repeated key');
  const same=kis(days('2026-03-02',5),{tamper:(page,r)=>page===2?{...r,body:{...r.body,output1:[raw('2026-03-03','TA')]}}:r});const b=await same.client.trades('2026-03-01','2026-03-31');
  assert.equal(b.complete,false);assert.equal(b.reason,'DUPLICATE_PAGE');assert.deepEqual(b.rows.map(r=>r.tradeDate),['2026-03-02','2026-03-03'],'the repeated page is not added');
  const empty=kis(days('2026-03-02',3),{tamper:(page,r)=>page===0?{...r,body:{...r.body,ctx_area_fk100:'',ctx_area_nk100:''}}:r});const c=await empty.client.trades('2026-03-01','2026-03-31');
  assert.equal(c.complete,false);assert.equal(c.reason,'MISSING_CURSOR');
  // An incomplete read imports nothing and removes nothing: rows stored by an earlier complete read stay.
  const {costs}=costsDb();costs.importHistory('a',[{start:'2026-03-01',end:'2026-03-31',complete:true,rows:(await kis(days('2026-03-02',5)).client.trades('2026-03-01','2026-03-31')).rows}],1);
  const out=costs.importHistory('a',(await readTradeHistory((x,y)=>same.client.trades(x,y),'2026-03-01','2026-03-31')),2);
  assert.equal(out.added,0);assert.equal(stored(costs).length,5,'no duplicate added, no stored trade dropped');
});
test('a range of the old shape (an array) or without completeness is a failed read, not a complete one',async()=>{
  for(const bad of [[{ticker:'X'}],{rows:[]}]){const [r]=await readTradeHistory(async()=>bad,'2026-03-01','2026-03-02');assert.deepEqual([r.complete,r.reason,r.code],[false,'READ_FAILED','INVALID_RESPONSE']);}
});
test('restart: gaps survive a restart, partial re-reads clear only their dates, the first time found is kept',()=>{
  const db=new DatabaseSync(':memory:');let {costs}=costsDb(db);
  costs.importHistory('a',[{start:'2026-03-01',end:'2026-03-31',complete:false,reason:'DUPLICATE_PAGE',rows:[]}],1000);
  ({costs}=costsDb(db));assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.end,g.since]),[['2026-03-01','2026-03-31',1000]],'kept across a restart');
  costs.importHistory('a',[{start:'2026-03-10',end:'2026-03-20',complete:true,rows:[]}],2000);
  assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.end]),[['2026-03-01','2026-03-09'],['2026-03-21','2026-03-31']],'only the re-read dates are cleared');
  costs.importHistory('a',[{start:'2026-03-01',end:'2026-03-15',complete:false,reason:'PAGE_LIMIT',rows:[]}],3000);
  const g=costs.historyGaps();assert.deepEqual(g.map(x=>[x.start,x.end,x.reason,x.since]),[['2026-03-01','2026-03-15','PAGE_LIMIT',1000],['2026-03-21','2026-03-31','DUPLICATE_PAGE',1000]],'incomplete since first found');
  ({costs}=costsDb(db));costs.importHistory('a',[{start:'2026-01-01',end:'2026-03-31',complete:true,rows:[]}],4000);assert.deepEqual(costs.historyGaps(),[]);
  assert.equal(db.prepare('SELECT count(*) n FROM trade_history_gaps').get().n,0);
  // Another taxpayer's gaps are not this one's.
  new HistoryGaps(db).record('someone-else',{start:'2026-03-01',end:'2026-03-02',complete:false,reason:'PAGE_LIMIT'},1);assert.deepEqual(costs.historyGaps(),[]);
});
test('tax: an incomplete history range up to the end of the tax year leaves the year incomplete, and says which dates',()=>{
  const {costs}=costsDb();costs.saveRates([{date:'2026-03-02',value:1400},{date:'2026-10-15',value:1400}],'test');
  costs.importHistory('a',[{start:'2026-03-01',end:'2026-03-31',complete:true,rows:[{ticker:'TEST',side:'Buy',quantity:1,price:100,tradeDate:'2026-03-02',settlementDate:'2026-03-02',feesUSD:0,exchangeRate:1400}]},{start:'2026-10-01',end:'2026-10-31',complete:false,reason:'DUPLICATE_PAGE',rows:[]}],1);
  const s=costs.taxSummary();assert.equal(s.year.result.status,'incomplete');assert.ok(s.year.result.missingInputs.some(m=>/2026-10-01 to 2026-10-31 could not be read completely \(KIS returned a page twice\)/.test(m)));
  assert.deepEqual(s.historyGaps.map(g=>[g.start,g.end]),[['2026-10-01','2026-10-31']]);assert.ok(costs.get().taxStatus.missingInputs.some(m=>/2026-10-01 to 2026-10-31/.test(m)),'the cost settings say so too');
  costs.save({...costs.saved(),taxYear:2025});assert.ok(!costs.taxSummary().year.result.missingInputs.some(m=>/trade history/.test(m)),'a gap after the tax year does not touch it');
  costs.save({...costs.saved(),taxYear:2026});costs.importHistory('a',[{start:'2026-10-01',end:'2026-10-31',complete:true,rows:[]}],2);assert.ok(!costs.taxSummary().year.result.missingInputs.some(m=>/trade history/.test(m)),'cleared by a complete read');
});

// Settlement (refreshCharges): an order whose dates could not be read whole waits; it is not settled-absent or ambiguous.
function engine(db,handler){const snapshot={accountKey:'acct',environment:'live',holdings:[]};const calls=[];
  const live=new LiveEngine(db,{request:async(op,payload)=>{calls.push([op,payload]);return handler(payload);}},()=>({status:'connected',snapshot}),{market:'US'});
  const put=o=>live.save({accountKey:live.identity(),market:'US',currency:'USD',costSettings:DEFAULT_COSTS,status:'Filled',brokerOrderId:'1',createdAt:Date.now(),...o});return {live,put,calls};}
const trade=(day,ticker,quantity)=>({tradeDate:day,settlementDate:day,ticker,side:'Buy',quantity,price:100,settlementUSD:quantity*100,settlementKRW:quantity*140000,feesUSD:0,exchangeRate:1400});
test('settlement: dates read incompletely leave orders pending HISTORY_INCOMPLETE, not NOT_SETTLED or ambiguous; a complete read settles them',async()=>{
  const db=new DatabaseSync(':memory:');let whole=false;
  const rows=[trade('2026-10-15','AAA',2),trade('2026-10-21','CCC',5)];
  // The range holding Oct 20 needs more pages than one read; Oct 20 alone repeats a page, until whole is set.
  const handler=({start,end})=>{const has=start<='2026-10-20'&&end>='2026-10-20';const mine=rows.filter(r=>r.tradeDate>=start&&r.tradeDate<=end);
    if(!whole&&has&&start<end)return {rows:mine.slice(0,1),complete:false,reason:'PAGE_LIMIT',pages:3};if(!whole&&has)return {rows:[],complete:false,reason:'DUPLICATE_PAGE',pages:2};return {rows:mine,complete:true,reason:null,pages:1};};
  const {live,put,calls}=engine(db,handler);
  put({id:'a',symbol:'NASD:AAA',side:'Buy',quantity:2,filled:2,fillPrice:100,day:'2026-10-15'});put({id:'b',symbol:'NASD:BBB',side:'Buy',quantity:1,filled:1,fillPrice:100,day:'2026-10-20'});put({id:'c',symbol:'NASD:CCC',side:'Buy',quantity:4,filled:4,fillPrice:100,day:'2026-10-21'});
  const now=Date.now();assert.equal(await live.refreshCharges(now),1);const by=id=>live.orders().find(o=>o.id===id).reportedCosts;
  assert.equal(by('a').status,'reported','a date read whole settles normally');
  assert.deepEqual([by('b').status,by('b').code],['pending','HISTORY_INCOMPLETE'],'absent on an unread date: not "not settled"');
  assert.deepEqual([by('c').status,by('c').code],['pending','HISTORY_INCOMPLETE'],'5 vs 4 shares next to an unread date: not the terminal ambiguous');
  assert.ok(calls.length>1&&calls.every(([op])=>op==='charges'),'the range was read in halves');
  // Restart: the pending state is stored; a later complete read decides.
  whole=true;const again=engine(db,handler).live;assert.equal(again.orders().find(o=>o.id==='b').reportedCosts.code,'HISTORY_INCOMPLETE');
  await again.refreshCharges(now+16*60000);const after=id=>again.orders().find(o=>o.id===id).reportedCosts;
  assert.deepEqual([after('b').status,after('b').code],['pending','NOT_SETTLED']);assert.equal(after('c').status,'ambiguous','with the whole history, the difference is real');
});

// Stage 2a review fixes. P1: a malformed response is never a complete read. P1: a failed read loses nothing already
// learned. P2: a job has a page and time budget, keeps its unread ranges and resumes from them with backoff.
const window={start:'2026-03-01',end:'2026-03-31'};
const client=reply=>new OverseasClient({overseasIdentity:()=>({environment:'live'}),overseasRequest:async(...a)=>reply(...a)});
test('review P1: a response without output1, or with an unreadable trade row, is incomplete; stored trades stay and a gap is kept',async()=>{
  for(const [label,body] of [['no output1',{rt_cd:'0'}],['output1 not a list',{output1:'x'}],['output1 null',{output1:null}],['output1 an empty object',{output1:{}}],['output1 an empty string',{output1:''}],['output1 a single row object',{output1:raw('2026-03-02','AAA')}],['output1 with a row that is not an object',{output1:[null]}],['a row without a trade date',{output1:[{...raw('2026-03-02','AAA'),trad_dt:''}]}],['a row with a quantity that is no number',{output1:[{...raw('2026-03-02','AAA'),ccld_qty:'n/a'}]}],['a filled row without a price',{output1:[{...raw('2026-03-02','AAA'),ft_ccld_unpr2:'0',tr_frcr_amt2:'0'}]}]]){
    const {costs}=costsDb();costs.importHistory('a',[{...window,complete:true,rows:[trade('2026-03-02','AAA',1)]}],1);
    const r=await client(async()=>({body,continuation:''})).trades(window.start,window.end);assert.deepEqual([r.complete,r.reason],[false,'INVALID_RESPONSE'],label);
    const out=await costs.syncHistory('a',(s,e,o)=>client(async()=>({body,continuation:''})).trades(s,e,o),{plan:()=>[window],clock:()=>2});
    assert.equal(out.done,true);assert.equal(stored(costs).length,1,label+': the stored trade stays');assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.end,g.reason]),[[window.start,window.end,'INVALID_RESPONSE']],label+': a gap');
  }
  // An empty history is an empty output1: complete, and it does replace the window's stored rows (KIS no longer lists them).
  const {costs}=costsDb();costs.importHistory('a',[{...window,complete:true,rows:[trade('2026-03-02','AAA',1)]}],1);
  const e=await client(async()=>({body:{output1:[]},continuation:''})).trades(window.start,window.end);assert.deepEqual([e.complete,e.rows],[true,[]]);
  costs.importHistory('a',[{...window,...e}],2);assert.equal(stored(costs).length,0);assert.deepEqual(costs.historyGaps(),[]);
});
test('review P1: a failed read midway through splitting keeps what was learned; resumed after backoff and a restart',async()=>{
  const db=new DatabaseSync(':memory:');let {costs}=costsDb(db);costs.importHistory('a',[{start:'2026-03-01',end:'2026-03-04',complete:true,rows:[trade('2026-03-03','KEEP',1)]}],1);
  let n=0,t=1000;const fetch=async(s,e)=>{n++;if(n===1)return {rows:[],complete:false,reason:'PAGE_LIMIT',pages:3};if(n===2)return {rows:[],complete:false,reason:'DUPLICATE_PAGE',pages:2};throw new Error('REQUEST_TIMEOUT');};
  const out=await costs.syncHistory('a',fetch,{plan:()=>[{start:'2026-03-01',end:'2026-03-04'}],clock:()=>t});
  assert.deepEqual([out.done,out.stopped,out.code],[false,'FAILED','REQUEST_TIMEOUT']);
  assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.end,g.reason]),[['2026-03-01','2026-03-02','DUPLICATE_PAGE'],['2026-03-03','2026-03-04','READ_FAILED']],'the known incomplete half and the failed half are both kept');
  assert.equal(stored(costs).length,1,'no stored trade lost');assert.ok(costs.taxSummary().year.result.missingInputs.some(m=>/2026-03-03 to 2026-03-04 could not be read completely \(the read failed: REQUEST_TIMEOUT\)/.test(m)));
  // Restart: the job and its queue survive; before the backoff nothing is read, after it only the queued range is.
  ({costs}=costsDb(db));const calls=[];const ok=async(s,e)=>{calls.push([s,e]);return {rows:s<='2026-03-03'&&e>='2026-03-03'?[trade('2026-03-03','KEEP',1)]:[],complete:true,reason:null,pages:1};};
  assert.equal((await costs.syncHistory('a',ok,{plan:()=>{throw new Error('not planned again');},clock:()=>t+60000})).skipped,'BACKOFF');assert.equal(calls.length,0);
  t+=16*60000;const again=await costs.syncHistory('a',ok,{plan:()=>{throw new Error('not planned again');},clock:()=>t});
  assert.equal(again.done,true);assert.deepEqual(calls,[['2026-03-03','2026-03-04']],'resumed from the queue, not from the whole range');
  assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.end,g.reason]),[['2026-03-01','2026-03-02','DUPLICATE_PAGE']],'the failed range cleared only by its complete read');assert.equal(stored(costs).length,1);
});
test('review P1: a read failing midway through pagination is a failed range; stored trades stay',async()=>{
  const {costs}=costsDb();costs.importHistory('a',[{...window,complete:true,rows:[trade('2026-03-02','TA',1)]}],1);
  const k=kis(days('2026-03-02',5),{tamper:(page,r)=>{if(page===2)throw new Error('RATE_LIMITED');return r;}});
  const out=await costs.syncHistory('a',(s,e,o)=>k.client.trades(s,e,o),{plan:()=>[window],clock:()=>5});
  assert.deepEqual([out.stopped,out.code],['FAILED','RATE_LIMITED']);assert.equal(stored(costs).length,1);assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.end,g.reason,g.code]),[[window.start,window.end,'READ_FAILED','RATE_LIMITED']]);
});
test('review P2: a job stops at its page budget, keeps the unread ranges, and the next run resumes them',async()=>{
  // The reviewer's case: every read of a 90-day range hits the page limit. Before: 179 reads, up to 8,950 pages.
  let calls=0;const always=async()=>{calls++;return {rows:[],complete:false,reason:'PAGE_LIMIT',pages:50};};
  const cover=await readTradeHistory(always,'2026-01-01','2026-03-31');assert.equal(calls,3,'150 pages a job, 50 a read');
  assert.equal(cover[0].start,'2026-01-01');assert.equal(cover.at(-1).end,'2026-03-31');for(let i=1;i<cover.length;i++)assert.equal(cover[i].start,require('../electron/trade-history.cjs').addDay(cover[i-1].end,1),'every date is accounted for');
  assert.ok(cover.every(r=>!r.complete),'nothing claimed complete');
  // Through the stored job: paused at the budget, reported as not read, resumed from the queue at the next run.
  const db=new DatabaseSync(':memory:');let {costs}=costsDb(db);const seen=[];const pages=[];
  const fetch=async(s,e,o)=>{seen.push([s,e]);pages.push(o.maxPages);return Date.parse(e)-Date.parse(s)>=10*86400000?{rows:[],complete:false,reason:'PAGE_LIMIT',pages:o.maxPages}:{rows:[],complete:true,reason:null,pages:1};};
  const first=await costs.syncHistory('a',fetch,{plan:()=>[{start:'2026-01-01',end:'2026-03-31'}],clock:()=>1});
  assert.deepEqual([first.done,first.stopped],[false,'BUDGET']);assert.equal(seen.length,3);assert.ok(pages.every(p=>p===50));
  assert.ok(costs.historyGaps().length&&costs.historyGaps().every(g=>g.reason==='NOT_READ'),'unread ranges are reported, not taken as read');
  const queued=costs.jobs.get('a').queue[0];({costs}=costsDb(db));seen.length=0;
  let done=null;for(let run=0;run<10&&!done?.done;run++)done=await costs.syncHistory('a',fetch,{plan:()=>{throw new Error('not planned again');},clock:()=>2});
  assert.deepEqual(seen[0],[queued.start,queued.end],'resumed where it stopped, not from the whole tree');assert.equal(done.done,true);assert.deepEqual(costs.historyGaps(),[]);assert.equal(costs.jobs.get('a'),null);
});
test('review P2: a job stops when its time is up; a job interrupted by a restart resumes',async()=>{
  const db=new DatabaseSync(':memory:');let {costs}=costsDb(db);let t=0;const fetch=async()=>{t+=70000;return {rows:[],complete:true,reason:null,pages:1};};
  const r=await costs.syncHistory('a',fetch,{plan:()=>[{start:'2026-01-01',end:'2026-01-31'},{start:'2026-02-01',end:'2026-02-28'},{start:'2026-03-01',end:'2026-03-31'},{start:'2026-04-01',end:'2026-04-30'}],clock:()=>t});
  assert.deepEqual([r.stopped,r.remaining.length],['TIME',1],'three minutes: three reads of 70 s');
  // A crash while running: the stored job says running; at the next start it is paused and resumed.
  costs.jobs.put('a',{...costs.jobs.get('a'),state:'running'});({costs}=costsDb(db));const j=costs.jobs.get('a');assert.deepEqual([j.state,j.stopped],['paused','INTERRUPTED']);
  assert.deepEqual(costs.historyGaps().map(g=>[g.start,g.reason]),[['2026-04-01','NOT_READ']]);
  assert.equal((await costs.syncHistory('a',fetch,{plan:()=>[],clock:()=>t})).done,true);assert.deepEqual(costs.historyGaps(),[]);
});
test('review P2: a gap is retried with backoff; a new job skips its dates until due',async()=>{
  const {costs}=costsDb();costs.importHistory('a',[{start:'2026-03-10',end:'2026-03-12',complete:false,reason:'DUPLICATE_PAGE',rows:[]}],0);
  assert.equal(costs.gaps.list('a')[0].nextAt,15*60000);const seen=[];const fetch=async(s,e)=>{seen.push([s,e]);return {rows:[],complete:false,reason:'DUPLICATE_PAGE',pages:1};};
  await costs.syncHistory('a',async(s,e)=>{seen.push([s,e]);return {rows:[],complete:true,reason:null,pages:1};},{plan:()=>[window],clock:()=>60000});
  assert.deepEqual(seen,[['2026-03-01','2026-03-09'],['2026-03-13','2026-03-31']],'the gap dates are not re-read before their time');
  seen.length=0;await costs.syncHistory('a',fetch,{plan:()=>[],clock:()=>16*60000});assert.deepEqual(seen,[['2026-03-10','2026-03-12']],'due: retried');
  const g=costs.gaps.list('a')[0];assert.equal(g.attempts,2);assert.equal(g.nextAt-16*60000,30*60000,'backoff doubles');assert.equal(g.since,0);
});
test('review P1: settlement with a failed read: orders on read dates settle, the rest wait; nothing read means the failure code',async()=>{
  const db=new DatabaseSync(':memory:');const rows=[trade('2026-10-15','AAA',2)];
  const {live,put}=engine(db,({start,end})=>{if(start<='2026-10-20'&&end>='2026-10-20'){if(start<end)return {rows:[],complete:false,reason:'PAGE_LIMIT',pages:3};throw new Error('REQUEST_TIMEOUT');}return {rows:rows.filter(r=>r.tradeDate>=start&&r.tradeDate<=end),complete:true,reason:null,pages:1};});
  put({id:'a',symbol:'NASD:AAA',side:'Buy',quantity:2,filled:2,fillPrice:100,day:'2026-10-15'});put({id:'b',symbol:'NASD:BBB',side:'Buy',quantity:1,filled:1,fillPrice:100,day:'2026-10-20'});
  await live.refreshCharges(Date.now());const by=id=>live.orders().find(o=>o.id===id).reportedCosts;
  assert.equal(by('a').status,'reported');assert.deepEqual([by('b').status,by('b').code],['pending','HISTORY_INCOMPLETE']);
  const none=engine(new DatabaseSync(':memory:'),()=>{throw new Error('RATE_LIMITED');});none.put({id:'x',symbol:'NASD:AAA',side:'Buy',quantity:2,filled:2,fillPrice:100,day:'2026-10-15'});
  await none.live.refreshCharges(Date.now());assert.deepEqual([none.live.orders()[0].reportedCosts.status,none.live.orders()[0].reportedCosts.code],['pending','RATE_LIMITED']);
});

// Stage 2a review round 2, P1: a job's unread dates are reported while it runs, not only once it stops. They leave the
// report only when a result and the queue without them are stored together.
const tick=()=>new Promise(r=>setImmediate(r));
const unread=costs=>costs.historyGaps().map(g=>[g.start,g.end,g.reason]);
test('review round 2: unread dates are reported before the first response, between responses, during backoff and after a restart',async()=>{
  const db=new DatabaseSync(':memory:');let {costs}=costsDb(db);let t=1000;const answers=[];const fetch=()=>new Promise((ok,fail)=>answers.push({ok,fail}));
  const halves=[{start:'2026-01-01',end:'2026-06-30'},{start:'2026-07-01',end:'2026-12-31'}];
  const run=costs.syncHistory('a',fetch,{plan:()=>halves,clock:()=>t});await tick();
  assert.equal(costs.jobs.get('a').state,'running');
  assert.deepEqual(unread(costs),[['2026-01-01','2026-06-30','NOT_READ'],['2026-07-01','2026-12-31','NOT_READ']],'before the first response');
  assert.equal(costs.historyIssues(2026).length,2);assert.equal(costs.taxSummary().year.result.status,'incomplete');assert.ok(costs.get().taxStatus.missingInputs.some(m=>/2026-01-01 to 2026-06-30 could not be read completely \(not read yet/.test(m)));
  answers[0].ok({rows:[],complete:true,reason:null,pages:1});await tick();
  assert.deepEqual(unread(costs),[['2026-07-01','2026-12-31','NOT_READ']],'between responses: only the stored result is cleared');
  // A restart while the second read is outstanding: the stored queue is reported by the new instance.
  const restarted=costsDb(db).costs;assert.deepEqual(unread(restarted),[['2026-07-01','2026-12-31','NOT_READ']],'after a restart mid-run');assert.equal(restarted.historyIssues(2026).length,1);
  answers[1].fail(new Error('REQUEST_TIMEOUT'));const out=await run;assert.deepEqual([out.stopped,out.code],['FAILED','REQUEST_TIMEOUT']);
  assert.deepEqual(unread(costs),[['2026-07-01','2026-12-31','READ_FAILED']],'the failed range: a gap, not also a second unread entry');
  t+=60000;assert.equal((await costs.syncHistory('a',fetch,{plan:()=>halves,clock:()=>t})).skipped,'BACKOFF');assert.deepEqual(unread(costs),[['2026-07-01','2026-12-31','READ_FAILED']],'during backoff');
  ({costs}=costsDb(db));assert.deepEqual(unread(costs),[['2026-07-01','2026-12-31','READ_FAILED']],'after a restart during backoff');assert.equal(costs.historyIssues(2026).length,1);
  t+=16*60000;const resumed=costs.syncHistory('a',fetch,{plan:()=>halves,clock:()=>t});await tick();
  assert.deepEqual(unread(costs),[['2026-07-01','2026-12-31','READ_FAILED']],'resumed and waiting: still reported');
  answers[2].ok({rows:[],complete:true,reason:null,pages:1});assert.equal((await resumed).done,true);assert.deepEqual(unread(costs),[]);assert.deepEqual(costs.historyIssues(2026),[]);
});
test('review round 2: a result whose import fails is rolled back with its queue update; its dates stay unread',async()=>{
  const {costs}=costsDb();costs.importHistory('a',[{...window,complete:true,rows:[trade('2026-03-02','AAA',1)]}],1);
  // A KRW price in a USD field: importTrades refuses it (INVALID_TRADE_HISTORY) inside the savepoint.
  const bad={...trade('2026-03-02','AAA',1),price:140000,grossUSD:100};
  await assert.rejects(costs.syncHistory('a',async()=>({rows:[trade('2026-03-05','NEW',1),bad],complete:true,reason:null,pages:1}),{plan:()=>[window],clock:()=>2}),/INVALID_TRADE_HISTORY/);
  assert.deepEqual(unread(costs),[[window.start,window.end,'NOT_READ']],'still unread');assert.deepEqual(stored(costs).map(e=>[e.symbol,e.price]),[['US:AAA',100]],'the stored trade stays and the row written before the refusal is rolled back');
});
