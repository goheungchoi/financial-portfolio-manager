// Screening history (note 6, S2), with the planner's first review of it (items 1-9 and the small ones): the store
// (overlap and split checks, no row after the readable day, the listing's start from an empty page, pruning, the request
// list), the read window with the real session tables, the order rule, the allowed() wiring, the refresher (tried once
// a night, failures against the stock, connection pauses, a write that throws, a rate limit that stops the window, the
// cost of an idle tick), the as-of day, historyPage parsing, the nightly set, universes, the data a script sees, the
// U.S. size order and the two settings. Made-up symbols and prices.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const H=require('../electron/history-store.cjs');const U=require('../electron/screen-universe.cjs');const W=require('../electron/screen-wiring.cjs');
const {UsSizeOrder,parseRows}=require('../electron/us-size.cjs');const MS=require('../electron/market-sessions.cjs');const {lateWindow}=require('../electron/outside-fills.cjs');
const {run}=require('../electron/formula-script.cjs');const {SecurityMaster}=require('../electron/security-master.cjs');
const day=(start,i)=>new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
const page=(start,n,base=100)=>Array.from({length:n},(_,i)=>({date:day(start,i),close:base+i,high:base+i+1,low:base+i-1,volume:1000,value:1e6}));
// Closes that agree across pages: one value per date.
const cons=(start,n)=>Array.from({length:n},(_,i)=>{const d=day(start,i);const c=1000+(Date.parse(d)-Date.parse('2020-01-01'))/86400000;return {date:d,close:c,high:c+1,low:c-1,volume:1,value:c};});
const seoul=(d,hm)=>Date.parse(`${d}T${hm}:00+09:00`);const ny=(d,hm)=>MS.zoned(d,hm,'America/New_York');
test('the store: overlap checked, a different basis or no overlap discards the old rows, nothing after the readable day',()=>{
  const s=new H.HistoryStore(new DatabaseSync(':memory:'));
  s.put('111110',page('2025-01-01',100,100),{day:'2025-04-10'});let p=s.progress('111110');assert.deepEqual([p.depth,p.complete,p.oldest,p.newest,p.triedNewest],[100,0,'2025-01-01','2025-04-10','2025-04-10']);
  assert.equal(s.put('111110',page('2025-04-05',10,194)).reset,false,'the same closes on the overlap');assert.equal(s.progress('111110').depth,104);
  const split=page('2025-04-05',12,52);const r=s.put('111110',split);assert.equal(r.reset,true,'a split: the overlap differs by more than 0.5%');p=s.progress('111110');
  assert.deepEqual([p.depth,p.complete,p.oldest],[12,0,'2025-04-05'],'only the new basis is kept, and the stock deepens again');assert.equal(p.resets,1);
  assert.equal(s.put('111110',page('2025-06-01',5,60)).reset,true,'no overlap: the basis cannot be checked');
  s.put('222220',[...page('2025-01-01',3),{date:'2025-01-04',close:9,high:9,low:9,volume:1,value:1}],{day:'2025-01-03'});assert.equal(s.progress('222220').newest,'2025-01-03','a row after the readable day is refused');
  s.put('333330',[{date:'bad',close:1},{date:'2025-01-01',close:-1},{date:'2025-01-02',close:5},{date:'2025-01-02',close:6}]);assert.deepEqual(s.closes('333330').map(x=>x.close),[5],'bad rows are dropped');
  const t=new DatabaseSync(':memory:');const k=new H.HistoryStore(t);k.put('444440',cons('2024-06-01',100));
  for(let i=0;i<3;i++){const o=k.progress('444440').oldest;assert.equal(k.put('444440',cons(day(o,-100),101),{kind:'deeper'}).reset,false);}assert.equal(k.progress('444440').depth,H.KEEP);assert.equal(k.closes('444440').at(-1).date,'2024-09-08','the newest are kept');
});
test('the store: the listing\'s start only from a page holding the overlap and nothing older; an empty or overlap-less page is a failure; a deeper basis change re-reads',()=>{
  const s=new H.HistoryStore(new DatabaseSync(':memory:'));s.put('111110',cons('2025-03-01',40));assert.equal(s.progress('111110').complete,0,'a short first page is not the start');
  const halted=cons(day('2025-03-01',-100),101).filter((_,i)=>i<20||i>50);const h=s.put('111110',halted,{kind:'deeper'});assert.equal(h.reset,false);assert.ok(h.older>0);assert.equal(s.progress('111110').complete,0,'a short deeper page (a halt) is not the start');
  assert.equal(s.put('111110',[],{kind:'deeper'}).failed,'NO_OVERLAP','an empty page is a failure');assert.equal(s.put('111110',cons('1999-01-01',3),{kind:'deeper'}).failed,'NO_OVERLAP','a page without the overlap is a failure');
  assert.equal(s.progress('111110').complete,0);const o=s.progress('111110').oldest;
  const r=s.put('111110',cons(o,5),{kind:'deeper'});assert.equal(r.older,0);assert.equal(s.progress('111110').complete,1,'the overlap and nothing older: the listing starts here');
  s.put('222220',cons('2025-03-01',40),{day:'2025-04-09'});const moved=s.put('222220',[{...cons('2025-03-01',1)[0],close:50},...cons('2024-12-01',5)],{kind:'deeper',day:'2025-04-09'});
  assert.equal(moved.reset,true);const p=s.progress('222220');assert.deepEqual([p.depth,p.newest,p.triedNewest,p.triedDeeper,p.resetNights],[0,null,null,'2025-04-09',1],'re-read from the newest page, not deepened again tonight');
});
test('the store: requests capped at 100 and kept 7 days; pruning drops stocks out of the set unread for 14 days',()=>{
  const s=new H.HistoryStore(new DatabaseSync(':memory:'));const t=Date.parse('2026-12-01T00:00:00Z');
  s.request(Array.from({length:120},(_,i)=>String(100000+i)),t);assert.equal(s.requested(t).length,100);assert.equal(s.requested(t+8*86400000).length,0,'expired after 7 days');
  s.put('111110',page('2025-01-01',5),{now:t-15*86400000});s.put('222220',page('2025-01-01',5),{now:t-15*86400000});s.put('333330',page('2025-01-01',5),{now:t});
  assert.equal(s.prune(['222220'],t),1);assert.equal(s.progress('111110'),null);assert.ok(s.progress('222220'));assert.ok(s.progress('333330'));
});
test('the as-of day per market: Korea from about 22:00 KST, the U.S. two hours after its close; the readable day 15 minutes after the close',()=>{
  assert.equal(H.asOfDay('KR',seoul('2026-12-01','21:59')),'2026-11-30');assert.equal(H.asOfDay('KR',seoul('2026-12-01','22:00')),'2026-12-01');
  assert.equal(H.asOfDay('KR',seoul('2026-12-05','12:00')),'2026-12-04','Saturday: Friday');assert.equal(H.asOfDay('KR',seoul('2026-12-02','09:30'),new Set(['2026-12-01'])),'2026-11-30','a closed day is skipped');
  assert.equal(H.asOfDay('US',ny('2026-12-01','17:59')),'2026-11-30');assert.equal(H.asOfDay('US',ny('2026-12-01','18:00')),'2026-12-01');
  assert.equal(H.readableDay('KR',seoul('2026-12-01','15:44')),'2026-11-30');assert.equal(H.readableDay('KR',seoul('2026-12-01','15:45')),'2026-12-01');
  assert.equal(H.readableDay('US',ny('2026-11-27','13:14')),'2026-11-25','a half day: 13:00 close; Thanksgiving closed');assert.equal(H.readableDay('US',ny('2026-11-27','13:15')),'2026-11-27');
});
test('the read window with the real session tables: 15 minutes each side of each session, half days, both DST settings, a shifted Korean day, each extended switch',()=>{
  const at=(t,environment='mock',enabled={})=>H.windowOpen(t,{sessionsOf:(m,d)=>MS.sessionsOn(m,d,{environment,enabled}),lateWindow});
  for(const [hm,open] of [['15:50',false],['16:00',false],['16:10',false],['16:14',false],['16:16',true]])assert.equal(at(ny('2026-12-02',hm)),open,`winter ${hm} ET`);
  assert.equal(at(ny('2026-07-15','16:14')),false,'summer');assert.equal(at(ny('2026-07-15','16:16')),true,'summer');
  assert.equal(at(ny('2026-11-27','13:14')),false,'a half day');assert.equal(at(ny('2026-11-27','13:16')),true,'a half day');
  assert.equal(at(ny('2026-12-02','09:16')),false,'15 minutes before the U.S. open');assert.equal(at(ny('2026-12-02','09:14')),true,'16 minutes before');
  assert.equal(at(seoul('2026-11-19','09:44')),true,'the exam day: the Korean session opens at 10:00');assert.equal(at(seoul('2026-11-19','09:46')),false);assert.equal(at(seoul('2026-11-20','09:44')),false,'an ordinary day');
  assert.equal(at(seoul('2026-12-01','20:24')),false,'the late window ends 20:10, with 15 minutes');assert.equal(at(seoul('2026-12-01','20:26')),true);
  assert.equal(at(seoul('2026-12-01','20:26'),'live',{usPre:true}),false,'U.S. pre-market switched on');assert.equal(at(ny('2026-12-02','16:16'),'live',{usAfter:true}),false,'after-market switched on');
  assert.equal(at(ny('2026-12-04','20:16'),'live',{usAfter:true}),true);assert.equal(at(ny('2026-12-04','20:14'),'live',{usAfter:true}),false);
  assert.equal(at(seoul('2026-12-05','12:00'),'live',{usDaytime:true}),true,'Saturday');assert.equal(at(seoul('2026-12-01','12:00'),'live',{usDaytime:true}),false);
  assert.equal(at(ny('2026-12-02','16:16'),'mock',{usAfter:true}),true,'a mock account trades no extended session');
});
test('the order rule: today\'s active statuses, a resting day order after its last fill time, an earlier day, a busy engine, an error',()=>{
  const now=seoul('2026-12-01','21:00');const active=(orders,{busy=false,extra=[]}={})=>W.makeOrdersActive({engines:()=>[{busy,orders:()=>orders},...extra],today:m=>m==='US'?'2026-12-01':'2026-12-01'})(now);
  for(const status of ['Submitting','Uncertain','Cancellation uncertain'])assert.equal(active([{status,day:'2026-12-01',market:'KR'}]),true,status);
  for(const status of ['Accepted','Partially filled'])assert.equal(active([{status,day:'2026-12-01',market:'KR'}]),false,`${status} after 20:00 KST no longer counts`);
  assert.equal(active([{status:'Accepted',day:'2026-12-01',market:'US'}]),true,'a U.S. day order still in its day');
  assert.equal(active([{status:'Uncertain',day:'2026-11-30',market:'KR'}]),false,'an earlier day');assert.equal(active([{status:'Filled',day:'2026-12-01'}]),false);
  assert.equal(active([],{busy:true}),true,'an engine sending');assert.equal(active([],{extra:[{busy:false,orders:()=>{throw new Error('x');}}]}),true,'an error counts as active');
  assert.equal(active([{status:'Accepted',market:'KR'}]),true,'no day: active');
});
test('allowed(): the checks in order, the window worked out once a minute, the order test only when all else allows',()=>{
  let windows=0,orders=0;const state={closing:false,scout:true,connected:true,busy:false,cool:0};
  const allowed=W.makeAllowed({closing:()=>state.closing,scoutOn:()=>state.scout,connected:()=>state.connected,sessionsOf:()=>{windows++;return [];},lateWindow:()=>false,queueBusy:()=>state.busy,cooldownUntil:()=>state.cool,ordersActive:()=>{orders++;return false;}});
  const t=Date.parse('2030-01-05T03:00:00Z');assert.deepEqual(allowed(t),{ok:true});const once=windows;allowed(t+30000);assert.equal(windows,once,'cached within the minute');allowed(t+61000);assert.ok(windows>once);
  state.busy=true;orders=0;assert.equal(allowed(t).why,'the KIS queue is in use');assert.equal(orders,0);state.busy=false;state.cool=t+1;assert.equal(allowed(t).why,'the KIS queue is in use');state.cool=0;
  state.scout=false;assert.equal(allowed(t).why,'the scout is off');state.scout=true;state.connected=false;assert.equal(allowed(t).why,'not connected');
  const outside=W.makeAllowed({closing:()=>false,scoutOn:()=>true,connected:()=>true,sessionsOf:()=>[],lateWindow:()=>true,queueBusy:()=>false,cooldownUntil:()=>0,ordersActive:()=>false});assert.deepEqual(outside(t),{ok:false,outside:true,why:'outside the read window'});
});
const harness=(opts={})=>{const store=opts.store??new H.HistoryStore(new DatabaseSync(':memory:'));let t=Date.parse('2026-12-02T12:00:00Z');const calls=[];let allowed={ok:true};const pending=[];let asked=0;
  const request=opts.request??((symbol,end)=>{calls.push({symbol,end});return new Promise((resolve,reject)=>pending.push({resolve,reject}));});
  const r=new H.HistoryRefresher({store,set:()=>opts.set??['111110','222220','NASD:AAA'],request,allowed:()=>{asked++;return allowed;},clock:()=>t,closedDays:()=>new Set()});
  const flush=async()=>{for(let i=0;i<4;i++)await new Promise(res=>setImmediate(res));};
  return {store,r,calls,answer:async rows=>{pending.shift().resolve(rows);await flush();},fail:async code=>{pending.shift().reject(Object.assign(new Error(code),{code}));await flush();},
    tick:(ms=0)=>{t+=ms;r.tick(t);},set allowed(v){allowed=v;},get asked(){return asked;},get now(){return t;}};};
const KR_DAY='2026-12-02',US_DAY='2026-12-01';// readable at 2026-12-02 12:00Z (21:00 KST, 07:00 ET)
test('the refresher: one read at a time, 2 s apart, the rules before each read, newest pages to the readable day, then deeper ones',async()=>{
  const h=harness();h.tick();assert.deepEqual(h.calls[0],{symbol:'111110',end:KR_DAY});await h.answer(page('2026-08-25',100));h.tick(1000);assert.equal(h.calls.length,1,'2 seconds between reads');
  h.tick(1000);assert.equal(h.calls.length,2);h.tick(5000);assert.equal(h.calls.length,2,'never two at once');await h.answer(page('2026-08-25',100));
  h.allowed={ok:false,why:'an order of the app is open'};h.tick(5000);assert.equal(h.calls.length,2,'an order stops the next read at once');assert.equal(h.r.status.why,'an order of the app is open');
  h.allowed={ok:true};h.tick(2000);assert.deepEqual(h.calls.at(-1),{symbol:'NASD:AAA',end:US_DAY});await h.answer(page('2026-08-24',100));
  h.tick(2000);assert.deepEqual(h.calls.at(-1),{symbol:'111110',end:'2026-08-29'},'then deeper pages, ending on the fifth-oldest stored day (five rows of overlap)');
});
test('the refresher: a stock that cannot get the readable day is tried once a night; a plan without progress waits; an idle tick does no work',async()=>{
  const h=harness({set:['111110']});h.tick();await h.answer([]);h.tick(2000);assert.equal(h.calls.length,1,'not again tonight');assert.equal(h.store.progress('111110').triedNewest,KR_DAY);
  const asked=h.asked;for(let i=0;i<120;i++)h.tick(1000);assert.equal(h.calls.length,1);assert.equal(h.asked,asked,'with nothing to read, no window or order test for 5 minutes');
  h.tick(200000);assert.equal(h.calls.length,1,'the rebuilt plan still has nothing');
  const g=harness({set:['111110']});g.tick();await g.answer(page('2026-08-15',100));g.tick(2000);assert.deepEqual(g.calls[1],{symbol:'111110',end:'2026-08-19'},'newest short of the readable day (a halted stock): not asked again; deeper pages go on');
  await g.answer([]);for(let i=0;i<30;i++)g.tick(2000);assert.equal(g.calls.length,2,'an empty deeper page: a failure, not tried again tonight');assert.equal(g.store.progress('111110').complete,0);assert.equal(g.store.progress('111110').failures,1);
});
test('the refresher: a failure counts against the stock and moves on; a connection failure pauses and blames none; three in a row pause; a rate limit stops the window',async()=>{
  const h=harness();h.tick();await h.fail('REQUEST_FAILED');h.tick(2000);assert.equal(h.calls.at(-1).symbol,'222220','the plan moves on');assert.equal(h.store.progress('111110').failures,1);
  await h.fail('AUTH_FAILED');assert.equal(h.store.progress('222220'),null,'a sign-in failure blames no stock');h.tick(4*60000);assert.equal(h.calls.length,2,'paused 5 minutes');h.tick(61000);assert.equal(h.calls.at(-1).symbol,'222220');
  await h.fail('INVALID_RESPONSE');h.tick(2000);await h.fail('INVALID_RESPONSE');h.tick(2000);assert.equal(h.r.status.state,'paused','three in a row: 30 minutes');
  const r=harness();r.tick();await r.answer(page('2026-08-25',100));r.tick(2000);await r.fail('RATE_LIMITED');for(let i=0;i<10;i++)r.tick(600000);assert.equal(r.calls.length,2,'stopped for the rest of the window');assert.equal(r.r.status.state,'stopped');
  assert.equal(r.store.progress('111110').depth,100,'progress kept');r.allowed={ok:false,outside:true,why:'outside the read window'};r.tick(2000);r.allowed={ok:true};r.tick(2000);assert.equal(r.calls.length,3,'the next window reads again');
});
test('the refresher: a store write that throws pauses with no unhandled rejection; a restart resumes from the stored progress',async()=>{
  let unhandled=0;const on=()=>unhandled++;process.on('unhandledRejection',on);
  const store=new H.HistoryStore(new DatabaseSync(':memory:'));const broken=Object.create(store);broken.put=()=>{throw new Error('database is locked');};
  const h=harness({store:broken});h.tick();await h.answer(page('2026-08-25',100));h.tick(2000);assert.equal(h.calls.length,1);assert.equal(h.r.status.state,'paused');assert.equal(h.r.status.why,'the store could not be written');
  await new Promise(r=>setTimeout(r,10));process.off('unhandledRejection',on);assert.equal(unhandled,0);
  store.put('111110',page('2026-08-25',100),{day:KR_DAY});const again=new H.HistoryRefresher({store,set:()=>['111110'],request:async()=>[],allowed:()=>({ok:true}),clock:()=>h.now,closedDays:()=>new Set()});
  assert.deepEqual(again.buildPlan(h.now),[{symbol:'111110',kind:'deeper',day:KR_DAY}]);
});
test('historyPage: both markets parsed, the Korean window 135 days, rows up to the end only, a current-day row refused by the store',async()=>{
  const {historyPage}=require('../electron/kis-insights.cjs');let sent;
  const kr={quotation:async(e,tr,p)=>{sent={tr,p};return {output2:[{stck_bsop_date:'20261202',stck_clpr:'105',stck_hgpr:'106',stck_lwpr:'104',acml_vol:'10',acml_tr_pbmn:'1050'},{stck_bsop_date:'20261201',stck_clpr:'100',stck_hgpr:'101',stck_lwpr:'99',acml_vol:'9',acml_tr_pbmn:'900'}]};}};
  const rows=await historyPage(kr,'111110','2026-12-02','2026-12-02');assert.deepEqual(rows.map(r=>[r.date,r.close,r.value]),[['2026-12-01',100,900],['2026-12-02',105,1050]]);
  assert.equal(sent.tr,'FHKST03010100');assert.equal(sent.p.FID_INPUT_DATE_1,'20260720');assert.equal(sent.p.FID_INPUT_DATE_2,'20261202');
  const us={overseasRequest:async(path,tr,p)=>{sent={tr,p};return {body:{output2:[{xymd:'20261202',clos:'11',high:'12',low:'10',tvol:'5'},{xymd:'20261201',clos:'10',high:'11',low:'9',tvol:'4'}]}};}};
  assert.deepEqual((await historyPage(us,'NASD:AAA','2026-12-01')).map(r=>[r.date,r.close,r.value]),[['2026-12-01',10,40]]);assert.deepEqual([sent.tr,sent.p.EXCD,sent.p.SYMB,sent.p.BYMD],['HHDFS76240000','NAS','AAA','20261201']);
  await assert.rejects(historyPage(us,'NASD:AAA','12/01'),/INVALID_REQUEST/);
  const s=new H.HistoryStore(new DatabaseSync(':memory:'));s.put('111110',rows,{day:'2026-12-01'});assert.equal(s.progress('111110').newest,'2026-12-01','a current-day bar is never stored');
});
const master=()=>{const db=new DatabaseSync(':memory:');new SecurityMaster(db,async()=>({ok:false}));const put=db.prepare("INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES(?,?,'',?,?,'',NULL,NULL,?)");
  [['111110','A','KOSPI','stock',9e12],['111120','B','KOSPI','stock',8e12],['111130','C','KOSPI','stock',null],['222220','D','KOSDAQ','stock',5e12],['222230','E','KOSDAQ','stock',4e12],['333330','F','KOSPI','etf',3e12],['333340','G','KOSPI','etf',2e12],['999980','H','KOSPI','stock',1e9],['NASD:HELD','I','NASD','stock',null]].forEach(r=>put.run(...r));return db;};
const sizes={NASD:['NASD:AAA','NASD:AAB'],NYSE:['NYSE:BBB'],AMEX:[]};
const fakeSize=(at=Date.parse('2026-12-01T00:00:00Z'))=>({top:(e,n)=>e==='US'?{symbols:[...sizes.NASD,...sizes.NYSE].slice(0,n),at}:sizes[e]?{symbols:sizes[e].slice(0,n),at}:null});
const deps=(extra={})=>{const db=master();const store=new H.HistoryStore(db);return {db,store,usSize:fakeSize(),own:k=>({holdings:['555550','NASD:HELD'],plan:['111120'],watchlist:['bad code','111110','111120','333330'],allowlist:[]})[k],settings:()=>({perExchange:2,etfs:true}),closedDays:()=>new Set(),clock:()=>seoul('2026-12-02','10:00'),...extra};};
test('the nightly set: your own lists first, then requests, then the largest of each exchange in turn, ETFs by switch',()=>{
  const d=deps();d.store.request(['999990'],d.clock());
  assert.deepEqual(U.nightlySet(d),['555550','NASD:HELD','111110','111120','333330','999990','222220','NASD:AAA','NYSE:BBB','222230','NASD:AAB','333340']);
  assert.ok(!U.nightlySet({...d,settings:()=>({perExchange:2,etfs:false})}).includes('333340'));
});
test('universes: by market, type and size; your lists with market, type and a note when cut; refusals; the size order\'s age',()=>{
  const d=deps();const u=s=>U.universeFor(d,s,d.clock());
  assert.deepEqual(u({market:'KOSPI',top_cap:5}),{name:'KOSPI top 5 stocks',symbols:['111110','111120','999980']},'no size: not listed');
  assert.deepEqual(u({market:'KR',type:'any',top_cap:3}).symbols,['111110','111120','222220']);assert.deepEqual(u({market:'KR',type:'etf'}).symbols,['333330','333340']);
  assert.deepEqual(u({own:'holdings',market:'US'}),{name:'holdings',symbols:['NASD:HELD']});assert.deepEqual(u({own:'watchlist',type:'etf'}).symbols,['333330']);
  assert.deepEqual(u({own:'watchlist',top_cap:1}),{name:'watchlist',symbols:['111110'],note:'1 of the 3 in watchlist (top_cap)'});assert.deepEqual(u({own:'watchlist',market:'MOON'}),{refused:'UNKNOWN_UNIVERSE'});
  assert.deepEqual(u({market:'US',type:'etf'}),{refused:'SIZE_ORDER_UNAVAILABLE'});assert.equal(u({market:'US',type:'any'}).note,'U.S. ETFs are not included: they have no size order');
  assert.deepEqual(U.universeFor({...d,usSize:{top:()=>null}},{market:'NASD'},d.clock()),{refused:'SIZE_ORDER_UNAVAILABLE'},'no size copy: never a guessed order');
  assert.match(U.universeFor({...d,usSize:fakeSize(d.clock()-9*86400000)},{market:'NASD'},d.clock()).note,/9 days old/);assert.deepEqual(u({market:'MOON'}),{refused:'UNKNOWN_UNIVERSE'});
});
test('the data a script sees: as of the last completed close per market; newer closes unused; stale counted; only listed codes requested',()=>{
  const d=deps();d.store.put('111110',page('2026-08-01',124,100));d.store.put('111120',page('2026-08-01',120,100));d.store.put('NASD:AAA',page('2026-08-01',123,10));
  const c=U.screenContext(d);assert.deepEqual(c.asOf,{KR:'2026-12-01',US:'2026-12-01'});
  assert.equal(c.ctx.data.price('111110'),100+122,'the 2026-12-01 close; the store also has 12-02, unused');assert.equal(c.ctx.data.closes('111110').at(-1).date,'2026-11-30');
  assert.equal(c.ctx.isStale('111120'),true);assert.equal(c.ctx.isStale('111110'),false);
  const r=run('u = universe(market="KOSPI")\nprint(top(u, ret(S,20), 5))\nv = universe(market="US", type="any")\nprint(count(v, price(S) > 0))',c.ctx);
  assert.equal(r.stopped,undefined);assert.match(r.lines[0],/^1\. 111110 A /);assert.equal(r.coverage[0].stale,1);assert.equal(r.lines[1],'1 (U.S. ETFs are not included: they have no size order)');
  const c2=U.screenContext(d);run('print(top(list("999980","999970"), ret(S,5), 1))',c2.ctx);assert.equal(c2.finish(),1,'999970 is not listed: never requested');assert.deepEqual(d.store.requested(d.clock()),['999980']);
  const refused=run('print(count(universe(market="US", type="etf")))',c.ctx);assert.match(refused.stopped.words,/no size order is available/);assert.equal(c.depth(['111110','NASD:AAA']).US.median,123);assert.match(require('../electron/formula-script.cjs').HELP,/Closes are adjusted for splits as KIS gives them/);
});
test('the U.S. size order: shape, size order, a cap while reading, a timeout and HTML kept out; a failed exchange retried alone after an hour',async()=>{
  assert.equal(parseRows({data:{rows:[]}}),null);assert.deepEqual(parseRows({data:{totalrecords:2,table:{rows:[{symbol:'BRK/B',marketCap:'1,000'},{symbol:'X',marketCap:''}]}}}),[{ticker:'BRK.B',marketCapUSD:1000}]);
  let t=1e12;const s=new UsSizeOrder(new DatabaseSync(':memory:'),()=>t);const rows=(n,asc=false)=>({data:{totalrecords:n,table:{rows:Array.from({length:n},(_,i)=>({symbol:`T${String.fromCharCode(65+i%26)}${i}`,marketCap:String(asc?1e6+i:1e9-i)}))}}});
  let reply=()=>JSON.stringify(rows(30));const urls=[];const fetcher=async(url,o)=>{urls.push({url,o});const body=reply(url);if(body instanceof Error)throw body;return {ok:true,text:async()=>body};};const go=()=>s.refresh({fetcher,known:()=>true,pause:async()=>{}});
  await go();assert.equal(s.top('US',100).symbols.length,90);assert.deepEqual(s.due(),[]);assert.ok(urls.every(x=>!/claude|anthropic|@/i.test(JSON.stringify(x.o.headers))),'a generic client, nothing of the user\'s');
  t+=21*3600000;urls.length=0;reply=url=>/nyse/.test(url)?'<html>not json</html>':/amex/.test(url)?JSON.stringify(rows(30,true)):new Error('timeout');await go();
  assert.equal(s.top('NASD',100).symbols.length,30,'kept the last good copies');assert.equal(urls.length,3);assert.deepEqual(s.due(),[],'failed exchanges wait an hour');
  t+=3601000;reply=url=>/nasdaq/.test(url)?JSON.stringify(rows(25)):'<html>';await go();assert.equal(s.top('NASD',100).symbols.length,25);assert.deepEqual(s.due(),['NYSE','AMEX'].filter(()=>false));
  const {readCapped,MAX_BYTES}=require('../electron/us-size.cjs');let chunks=0;const big={body:{getReader:()=>({read:async()=>{chunks++;return chunks>20?{done:true}:{done:false,value:new Uint8Array(MAX_BYTES/10)};},cancel:async()=>{}})}};
  await assert.rejects(readCapped(big),/NASDAQ_UNAVAILABLE/);assert.ok(chunks<=11,'stopped while reading');assert.equal(new UsSizeOrder(new DatabaseSync(':memory:')).top('NASD',5),null);
});
test('the two settings: defaults, and the validator refuses what is out of range',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'A'}],()=>[]),{request:async()=>({})},()=>{});
  assert.equal(a.config.screenStocksPerExchange,300);assert.equal(a.config.screenEtfs,true);
  for(const bad of [{screenStocksPerExchange:49},{screenStocksPerExchange:401},{screenStocksPerExchange:120.5},{screenStocksPerExchange:'300'},{screenEtfs:'yes'}])assert.throws(()=>a.configure(bad),/INVALID_SETTINGS/,JSON.stringify(bad));
  a.configure({screenStocksPerExchange:150,screenEtfs:false});assert.equal(a.config.screenStocksPerExchange,150);
});
test('N1: a stock whose closes keep changing is reset at most once a night, then stops deepening after three nights, with a reason',async()=>{
  const store=new H.HistoryStore(new DatabaseSync(':memory:'));let t=Date.parse('2026-12-02T12:00:00Z');const calls=[];let night=0;
  const request=(symbol,end)=>{calls.push(end);const n=cons(day(end,-99),100);return Promise.resolve(end===H.readableDay('KR',t)?n:n.map(r=>({...r,close:r.close*(1.1+night/10)})));};
  const r=new H.HistoryRefresher({store,set:()=>['111110'],request,allowed:()=>({ok:true}),clock:()=>t,closedDays:()=>new Set()});const flush=async()=>{for(let i=0;i<4;i++)await new Promise(res=>setImmediate(res));};
  const nightOf=async()=>{const before=calls.length;for(let i=0;i<600;i++){t+=2000;r.tick(t);await flush();}return calls.length-before;};
  assert.equal(await nightOf(),3,'newest, deeper (reset), newest again; then nothing that night');assert.equal(store.progress('111110').resets,1);
  for(const n of [1,2]){night=n;t=Date.parse(day('2026-12-02',n)+'T12:00:00Z');await nightOf();}
  const p=store.progress('111110');assert.equal(p.resetNights,3);assert.equal(p.stopped,'the closes KIS gives keep changing between reads');assert.equal(store.depth(['111110']).KR.stopped,1);
  night=3;t=Date.parse('2026-12-07T12:00:00Z');assert.equal(await nightOf(),1,'only the newest page once it stopped deepening');
});
test('N2: a throw while working out the window is "not allowed" and is not remembered for the minute',()=>{
  let fail=true;const allowed=W.makeAllowed({closing:()=>false,scoutOn:()=>true,connected:()=>true,sessionsOf:()=>{if(fail)throw new Error('x');return [];},lateWindow:()=>false,queueBusy:()=>false,cooldownUntil:()=>0,ordersActive:()=>false});
  const t=Date.parse('2030-01-05T03:00:00Z');assert.deepEqual(allowed(t),{ok:false,why:'the read window could not be worked out'});fail=false;assert.deepEqual(allowed(t+1000),{ok:true},'worked out again in the same minute');
});
test('N4: a rate-limit reply stops the reads for 3 hours at most, even in a weekend-long window',async()=>{
  const store=new H.HistoryStore(new DatabaseSync(':memory:'));let t=Date.parse('2026-12-05T03:00:00Z');const calls=[];let limited=true;
  const r=new H.HistoryRefresher({store,set:()=>['111110','222220'],request:s=>{calls.push(s);if(limited){limited=false;return Promise.reject(Object.assign(new Error('RATE_LIMITED'),{code:'RATE_LIMITED'}));}return Promise.resolve([]);},allowed:()=>({ok:true}),clock:()=>t,closedDays:()=>new Set()});
  r.tick(t);for(let i=0;i<4;i++)await new Promise(res=>setImmediate(res));t+=2.9*3600000;r.tick(t);assert.equal(calls.length,1);assert.equal(r.status.state,'stopped');t+=0.2*3600000;r.tick(t);assert.equal(calls.length,2,'after 3 hours');
});
test('N5: a database from an earlier build gets the new columns; the worker refuses a missing end',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE screen_progress(symbol TEXT PRIMARY KEY,newest TEXT,oldest TEXT,depth INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,readAt INTEGER,failures INTEGER NOT NULL DEFAULT 0,failedAt INTEGER)');
  db.prepare("INSERT INTO screen_progress(symbol,newest,oldest,depth) VALUES('111110','2025-01-02','2025-01-01',2)").run();
  const s=new H.HistoryStore(db);assert.doesNotThrow(()=>s.put('111110',cons('2025-01-01',5),{day:'2025-01-05'}));assert.equal(s.progress('111110').triedNewest,'2025-01-05');
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','kis-worker.cjs'),'utf8');assert.match(src,/typeof data\.end!=='string'/);assert.doesNotMatch(src,/data\.end\?\?null/);
});
test('the order rule: a missing engine is active; a U.S. order made in the KIS daytime session counts until the next session day\'s after-market ends',()=>{
  const at=W.makeOrdersActive({engines:()=>[{busy:false,orders:()=>[]},null]});assert.equal(at(Date.now()),true);assert.equal(W.makeOrdersActive({engines:()=>[]})(Date.now()),true);
  const made=ny('2026-12-01','21:30');const o={status:'Accepted',market:'US',day:'2026-12-01',createdAt:made};const one=now=>W.makeOrdersActive({engines:()=>[{busy:false,orders:()=>[o]},{busy:false,orders:()=>[]}]})(now);
  assert.equal(W.activeUntil(o),ny('2026-12-02','20:00'));assert.equal(one(ny('2026-12-02','09:00')),true,'still active in the next regular session');assert.equal(one(ny('2026-12-02','20:01')),false);
  const fri={...o,day:'2026-12-04',createdAt:ny('2026-12-04','21:00')};assert.equal(W.activeUntil(fri),ny('2026-12-07','20:00'),'Friday night: until Monday');
  assert.equal(W.activeUntil({status:'Accepted',market:'US',day:'2026-12-01',createdAt:ny('2026-12-01','10:00')}),ny('2026-12-01','20:00'));
});
