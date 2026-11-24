// Korean days with other hours (artifacts/reviews/2026-11-18-kr-late-open): the college entrance exam day 2026-11-19
// runs one hour later (KRX 10:00–16:30, the app's window 10:00–16:20; Nextrade pre-market not held). The order window,
// the next open, the pre-open review, the sessions shown and given to the model, scout timing and the KIS order guard
// all read one table (electron/kr-hours.cjs). The instruction text and its fingerprints do not change.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const H=require('../electron/market-hours.cjs'),S=require('../electron/market-sessions.cjs'),K=require('../electron/kr-hours.cjs'),RI=require('../electron/review-instructions.cjs');
const at=s=>Date.parse(s+'+09:00');const kst=t=>new Date(t+9*3600000).toISOString().slice(0,16).replace('T',' ');

test('the order window on 2026-11-19: closed 09:00–09:59, open 10:00–16:19, closed from 16:20; 11-20 as usual',()=>{
  const open=s=>H.krOpen(at(s),new Set());
  for(const s of ['2026-11-19T08:59','2026-11-19T09:00','2026-11-19T09:30','2026-11-19T09:59','2026-11-19T16:20','2026-11-19T16:30'])assert.equal(open(s),false,s);
  for(const s of ['2026-11-19T10:00','2026-11-19T15:20','2026-11-19T16:19'])assert.equal(open(s),true,s);
  for(const s of ['2026-11-20T09:00','2026-11-20T15:19'])assert.equal(open(s),true,s);assert.equal(open('2026-11-20T15:20'),false);
  assert.equal(open('2026-11-18T09:00'),true,'the day before is usual');
  assert.equal(H.regularOpen('KR',at('2026-11-19T09:30')),false);assert.equal(H.regularOpen('KR',at('2026-11-19T16:00')),true);
  assert.equal(H.krOpen(at('2026-11-19T10:30'),new Set(['2026-11-19'])),false,'a closed day stays closed');});

test('the next open from the evening before is 10:00; the pre-open review is at 09:50, not 08:50',()=>{
  const eve=H.marketHours('kis',at('2026-11-18T22:00'));assert.equal(kst(eve.next.at),'2026-11-19 10:00');
  assert.equal(kst(H.nextOpen('KR',at('2026-11-19T09:15'),new Set())),'2026-11-19 10:00');
  assert.equal(H.marketHours('kis',at('2026-11-19T08:50')).preOpen,null,'no pre-open review at the usual time');
  const pre=H.marketHours('kis',at('2026-11-19T09:50'));assert.equal(kst(pre.preOpen.at),'2026-11-19 09:50');
  assert.equal(kst(H.marketHours('kis',at('2026-11-19T16:30')).next.at),'2026-11-20 09:00','the day after opens at 09:00');});

test('the sessions of 2026-11-19 as shown, offered and given to the model; 11-20 unchanged',()=>{
  const rows=S.sessionsOn('KR','2026-11-19',{environment:'live',enabled:{krNxt:true}}).map(x=>[x.id,kst(x.startAt).slice(11),kst(x.endAt).slice(11),x.appEndAt?kst(x.appEndAt).slice(11):null]);
  assert.deepEqual(rows,[['krx-pre','09:30','09:40',null],['krx-regular','10:00','16:30','16:20'],['krx-post','16:40','17:00',null],['nxt-after','16:40','20:00',null]],'no Nextrade pre-market');
  assert.deepEqual(S.sessionsOn('KR','2026-11-20',{}).map(x=>[x.id,kst(x.startAt).slice(11),kst(x.endAt).slice(11)]),
    [['nxt-pre','08:00','08:50'],['krx-pre','08:30','08:40'],['krx-regular','09:00','15:30'],['krx-post','15:40','16:00'],['nxt-after','15:30','20:00']]);
  const eve=S.marketStatus('KR',at('2026-11-18T22:00'),{});assert.equal(eve.day,'2026-11-19');assert.equal(kst(eve.nextRegular.at),'2026-11-19 10:00','Markets card: opens Thu 10:00');
  const morning=S.marketStatus('KR',at('2026-11-19T09:30'),{});assert.equal(morning.appTrading,false);assert.equal(kst(morning.regular.startAt),'2026-11-19 10:00');assert.equal(kst(morning.regular.appEndAt),'2026-11-19 16:20');
  assert.equal(S.marketStatus('KR',at('2026-11-19T16:10'),{}).appTrading,true,'the shifted last hour is traded');
  assert.equal(S.marketStatus('KR',at('2026-11-19T16:25'),{}).appTrading,false);});

test('scout timing follows the shifted open: before 09:40, after 11:00, midday 14:00 (11-20: 08:40, 10:00, 13:00)',()=>{
  const T=require('../electron/scout-timing.cjs');T.clearCache();const c={...T.TIMING_DEFAULTS,scoutBeforeKrOpen:true,scoutAfterKrOpen:true,scoutKrMidday:true,scoutAfterOpenMinutes:60};
  const times=day=>T.slotsOn(c,day,['KR'],{}).map(s=>kst(s.at).slice(11));
  assert.deepEqual(times('2026-11-19'),['09:40','11:00','14:00']);assert.deepEqual(times('2026-11-20'),['08:40','10:00','13:00']);
  assert.equal(T.isOpen('KR',at('2026-11-19T09:30'),{}),false);assert.equal(T.isOpen('KR',at('2026-11-19T16:25'),{}),true,'the regular session runs to 16:30');});

test('the KIS order guard reads the same window; the table is dated, sourced and in the facts doc',()=>{
  assert.deepEqual(K.krWindow('2026-11-19'),{open:600,appEnd:980});assert.deepEqual(K.krWindow('2026-11-20'),{open:540,appEnd:920});
  const src=fs.readFileSync(path.join(__dirname,'../electron/kis-client.cjs'),'utf8');
  assert.match(src,/const w=require\('\.\/kr-hours\.cjs'\)\.krWindow\(today\);\s*if\(!\(session&&!session\.regular\)&&\(minutes<w\.open \|\| minutes>=w\.appEnd\)\)throw new KisError\('SESSION_CLOSED'\)/);
  assert.doesNotMatch(src,/minutes<9\*60/,'no fixed 09:00 left in the guard');
  for(const [day,d] of Object.entries(K.SHIFTED_DAYS)){assert.match(day,/^\d{4}-\d{2}-\d{2}$/);assert.ok(d.source);assert.ok(fs.readFileSync(path.join(__dirname,'../docs/EXTERNAL-FACTS.md'),'utf8').includes('`'+d.source+'`'),d.source);}});

test('the review instructions and their fingerprints are unchanged',()=>{
  assert.equal(RI.fingerprint(),'2e155a5b9452c226');assert.equal(RI.fingerprint(undefined,{orders:true}),'36913349434ce621');});
