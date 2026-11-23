'use strict';
// The order history after a start (found in live use, 1.5.73; the orders-while-stopped review folder,
// answers-history-not-ready.md): at launch the first history read is asked for before the account is known and answered
// after the connection, so historyKey was never set and, with the markets closed, both readiness rules (main.cjs's for
// Korean cash changes, buyback.cjs's for "App buys wait") stayed false. The key is now taken again when KIS answers, and a
// read not recorded for the known account is due again. Made-up accounts and orders; the fake broker; the clock is moved
// to a business-day evening (20:40 KST, both markets closed) inside each test.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const B=require('../electron/buyback.cjs');const {seoulDate}=require('../electron/kis-activity.cjs');
const nyDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t));
// The clock moved to `iso` for the duration of fn (whatever clock the run uses), then restored.
async function at(iso,fn){const Real=globalThis.Date,delta=Real.parse(iso)-Real.now();
  class Shifted extends Real{constructor(...a){super(...(a.length?a:[Real.now()+delta]));}static now(){return Real.now()+delta;}}
  globalThis.Date=Shifted;try{return await fn();}finally{globalThis.Date=Real;}}
const EVENING='2026-10-05T20:40:00+09:00';// a made-up business day
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
// The app as main.cjs wires it for this: both engines on the fake broker, the back-fill latch from the flow detector's
// last reading (5 minutes before the start), and both readiness rules.
function app(){const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'990010':70000,'NASD:AAA':10}});const h=appHarness({mock:m}).enable();
  const acct=h.state.kr.accountKey;h.db.prepare('INSERT OR REPLACE INTO flow_watch(account,payload) VALUES(?,?)').run(acct,JSON.stringify({at:Date.now()-300000}));
  const a=h.automation({scope:'both',orderTracking:true});for(const e of [h.kr,h.us])e.missedSpacing=0;
  const latch=B.startLatch(x=>h.fd.lastAt(x));const from=d=>latch.from(h.state.kr?.accountKey,d);h.kr.backfillFrom=()=>from(t=>seoulDate(t));h.us.backfillFrom=()=>from(nyDay);
  const mainReady=()=>Boolean(acct&&h.kr.missedRead&&h.kr.historyKey===acct&&Number.isFinite(h.kr.historyReadAt));
  const buyReady=mk=>B.historyReady(mk==='US'?h.us:h.kr,mk,{now:Date.now(),sessionOpen:(x,t)=>a.sessionOpen(x,t),lastOpenAt:a.lastOpenAt?.[mk]??0});
  const rows=key=>h.db.prepare('SELECT COUNT(*) AS n FROM broker_orders WHERE accountKey=?').get(key).n;
  return {m,h,a,acct,mainReady,buyReady,rows};}
// An engine whose account is unknown until `known()` says so, and whose KIS request waits for it (the queue at launch).
function queued(e){const conn=e.getConnection,req=e.broker.request.bind(e.broker);let known=false;e.getConnection=()=>known?conn():({snapshot:null});
  e.broker={...e.broker,request:async(op,p)=>{while(!known)await new Promise(r=>setTimeout(r,5));return req(op,p);}};return ()=>{known=true;};}

test('main.cjs\'s readiness rule is the one these tests use',()=>{const src=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/const historyReady=\(\)=>\{const a=kisState\.snapshot\?\.accountKey;return Boolean\(a&&live\.missedRead&&live\.historyKey===a&&Number\.isFinite\(live\.historyReadAt\)\);\};/);});

test('a queued start (asked before the account is known, answered after): each market is read for its account and both readiness rules turn true',()=>at(EVENING,async()=>{
  const {h,a,acct,mainReady,buyReady,rows}=app();h.mock.userOrder?.('KR',{symbol:'990010',side:'Sell',quantity:1,price:70000});
  const open={KR:queued(h.kr),US:queued(h.us)};const tick=a.syncHistories(Date.now());await new Promise(r=>setTimeout(r,20));open.KR();open.US();await tick;await settle();
  for(const [mk,e,key] of [['KR',h.kr,acct],['US',h.us,acct+':US']]){assert.equal(e.historyKey,key,mk+': historyKey set');assert.equal(e.missedRead,true,mk);assert.ok(Number.isFinite(e.historyReadAt),mk);assert.equal(buyReady(mk),true,mk+': App buys no longer wait');}
  assert.equal(mainReady(),true,'Korean cash changes are explained again');assert.ok(rows(acct)>=0);
}));

test('a U.S. balance known only later: nothing recorded as read until then, and the next due read makes the U.S. ready; Korea is not held',()=>at(EVENING,async()=>{
  const {h,a,buyReady,mainReady}=app();const real=h.us.getConnection;h.us.getConnection=()=>({snapshot:null});
  const t0=Date.now();await a.syncHistories(t0);await settle();
  assert.equal(h.us.historyKey,undefined);assert.equal(h.us.historyReadAt,undefined,'a read with no known account is not counted as read');assert.equal(buyReady('US'),false);
  assert.equal(mainReady(),true);assert.equal(buyReady('KR'),true,'Korea read for its account at once');
  h.us.getConnection=real;await a.syncHistories(t0+61000);await settle();
  assert.equal(h.us.historyKey,h.state.kr.accountKey+':US');assert.equal(buyReady('US'),true,'ready at the next read, a minute later');
}));

test('a read asked before the account was known and still answered without one records nothing; the due rule reads again for the known account',()=>at(EVENING,async()=>{
  const {h,a,acct,mainReady,rows}=app();const before=rows(acct);const real=h.kr.getConnection;h.kr.getConnection=()=>({snapshot:null});
  await h.kr.syncHistory();assert.equal(h.kr.historyKey,undefined);assert.equal(h.kr.historyReadAt,undefined);assert.equal(rows(acct),before,'no rows written');
  h.kr.getConnection=real;h.kr.historyReadAt=Date.now();// as 1.5.73 left it: read, but for no account
  await a.syncHistories(Date.now());await settle();assert.equal(h.kr.historyKey,acct,'the unkeyed read is due again at once');assert.equal(mainReady(),true);
}));

test('an account switch during a read writes nothing under the new account\'s key',()=>at(EVENING,async()=>{
  const {h,acct,rows}=app();await h.kr.syncHistory();const read=h.kr.historyReadAt;
  const req=h.kr.broker.request.bind(h.kr.broker);const other={...h.state.kr,accountKey:'acct-two'};
  h.kr.broker={...h.kr.broker,request:async(op,p)=>{const r=await req(op,p);h.kr.getConnection=()=>({status:'connected',snapshot:other});return {...r,orders:[{orderId:'777',symbol:'990010',side:'Sell',quantity:1,filled:1,status:'Filled',timestamp:Date.now(),creditName:'현금'}]};}};
  await h.kr.syncHistory();assert.equal(rows('acct-two'),0,'nothing under the new key');assert.equal(h.kr.historyKey,acct,'still the old account\'s');assert.equal(h.kr.historyReadAt,read,'not counted as read');
}));

test('the working cases are unchanged: the account known at the read; the missed days; a new day',()=>at(EVENING,async()=>{
  const {h,a,acct,mainReady,buyReady,m}=app();await a.syncHistories(Date.now());await settle();
  assert.equal(h.kr.historyKey,acct);assert.equal(mainReady(),true);assert.equal(buyReady('KR'),true);assert.equal(buyReady('US'),true);
  const reads=m.log.filter(x=>x.operation==='orders').length;await a.syncHistories(Date.now()+5000);assert.equal(m.log.filter(x=>x.operation==='orders').length,reads,'nothing due: no extra read');
  // Missed days from a reading four days back (two business days): read, then ready.
  const b=app();b.h.db.prepare('UPDATE flow_watch SET payload=? WHERE account=?').run(JSON.stringify({at:Date.now()-4*86400000}),b.acct);
  const latch=B.startLatch(x=>b.h.fd.lastAt(x));b.h.kr.backfillFrom=()=>latch.from(b.acct,t=>seoulDate(t));b.h.us.backfillFrom=()=>latch.from(b.acct,nyDay);
  await b.a.syncHistories(Date.now());for(let i=0;i<50&&!(b.h.kr.missedRead&&b.h.us.missedRead);i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(b.m.log.filter(x=>x.operation==='orders'&&x.market==='KR').length>1,'past days read');assert.equal(b.mainReady(),true);
  // A new day: yesterday and today read again, the missed days again (missedRead false until done).
  b.a.historyState.KR.day='2026-10-04';await b.a.syncHistories(Date.now()+120000);await settle();assert.equal(b.a.historyState.KR.day,'2026-10-05');
}));

test('a start during an open session: a read without the account is redone at the next read, as before (at most one read, a minute)',()=>at('2026-10-05T10:00:00+09:00',async()=>{
  const {h,a,acct,mainReady}=app();a.sessionOpen=()=>true;const real=h.kr.getConnection;h.kr.getConnection=()=>({snapshot:null});
  const t0=Date.now();await a.syncHistories(t0);await settle();assert.equal(mainReady(),false);
  h.kr.getConnection=real;await a.syncHistories(t0+61000);await settle();assert.equal(h.kr.historyKey,acct);assert.equal(mainReady(),true);
}));

test('the missed days: an account switch on the second of four days stops the loop; that day and the whole are not counted, nothing is written under the new key',()=>at(EVENING,async()=>{
  const {h,acct,rows}=app();const e=h.kr;e.backfillFrom=()=>'2026-09-29';// four business days before the made-up day: 29, 30 Sep, 1, 2 Oct
  await e.syncHistory();const req=e.broker.request.bind(e.broker);let n=0;const other={...h.state.kr,accountKey:'acct-two'};
  e.broker={...e.broker,request:async(op,p)=>{const r=await req(op,p);if(op==='orders'&&p.startDate!==e.day()&&++n===2)e.getConnection=()=>({status:'connected',snapshot:other});return {...r,orders:[{orderId:'9'+n,symbol:'990010',side:'Sell',quantity:1,filled:1,status:'Filled',timestamp:Date.now(),creditName:'현금'}]};}};
  await e.syncMissed(Date.now());
  assert.notEqual(e.missedRead,true,'not counted as read');assert.deepEqual([...e.missedDone],['2026-09-29'],'only the day recorded for the first account');
  assert.equal(rows('acct-two'),0,'nothing written under the new key');assert.equal(n,2,'stopped after the second day');
  // The new account's next read resets and starts its own days.
  await e.syncHistory();assert.equal(e.historyKey,'acct-two');assert.equal(e.missedRead,false);assert.equal(e.missedDone.size,0);
}));
