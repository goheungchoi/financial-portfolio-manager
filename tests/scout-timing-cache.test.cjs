'use strict';
// Next version, step 1 (the 1.5.53 gate G7 finding): the scout's due slot and next-run list read the session calendar
// once per day and settings instead of on every tick and every state read. The results must be exactly what an
// uncached read gives, for every switch, offset, market set and closed-day list, and must follow a change of any of them.
const test=require('node:test');const assert=require('node:assert/strict');
const T=require('../electron/scout-timing.cjs');const S=require('../electron/market-sessions.cjs');
const at=iso=>Date.parse(iso);const day0='2026-10-26';
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const configs=[];for(let bits=0;bits<16;bits++)for(const off of [10,60,240])configs.push({...T.TIMING_DEFAULTS,scoutBeforeKrOpen:Boolean(bits&1),scoutAfterKrOpen:Boolean(bits&2),scoutKrMidday:Boolean(bits&4),scoutBeforeUsOpen:Boolean(bits&8),scoutAfterOpenMinutes:off});
const marketSets=[['KR'],['US'],['KR','US'],['US','KR']];const closedSets=[new Set(),new Set(['2026-11-03']),new Set(['2026-11-03','2026-12-25'])];

test('cached slots equal an uncached calendar read for every switch, offset, market set, closed-day list and day (U.S. DST end included)',()=>{
  T.clearCache();let n=0;
  for(let i=0;i<14;i++){const day=addDays(day0,i);for(const c of configs)for(const m of marketSets)for(const closed of closedSets){
    const opts={closedDays:closed};const first=T.slotsOn(c,day,m,opts),again=T.slotsOn(c,day,m,opts),fresh=T.readSlots(c,day,m,opts);
    assert.deepEqual(first,fresh);assert.deepEqual(again,fresh);n++;}}
  assert.ok(n>8000,String(n));
});

test('one calendar read per day and settings: a thousand ticks and state reads on one day read it once',()=>{
  T.clearCache();const c={...T.TIMING_DEFAULTS,scoutBeforeUsOpen:true};const opts={closedDays:new Set()};const r0=T.calendarReads();
  const now=at('2026-11-13T01:05:00Z');for(let i=0;i<1000;i++){T.dueSlot(c,['KR','US'],now+i*1000,opts);T.nextTimes(c,['KR','US'],now+i*1000,opts);}
  // Friday 2026-11-13 10:05: the next U.S. run is tonight and the next Korean one Monday, so the list reads Friday to
  // Monday once each (4 days), however many calls follow.
  assert.equal(T.calendarReads()-r0,4,'Friday, Saturday, Sunday, Monday, once each');
});

test('a change of any input is followed at once',()=>{
  T.clearCache();const now=at('2026-11-13T00:30:00Z');const base={...T.TIMING_DEFAULTS};const times=(c,m=['KR','US'],closed=new Set())=>T.nextTimes(c,m,now,{closedDays:closed}).map(x=>x.text);
  assert.deepEqual(times(base),['After Korea opens 10:00','Korea midday 13:00']);
  assert.deepEqual(times({...base,scoutBeforeUsOpen:true}),['After Korea opens 10:00','Korea midday 13:00','Before the U.S. opens 23:00'],'a switch');
  assert.deepEqual(times({...base,scoutAfterOpenMinutes:45}),['After Korea opens 09:45','Korea midday 13:00'],'the offset');
  assert.deepEqual(times({...base,scoutBeforeUsOpen:true},['KR']),['After Korea opens 10:00','Korea midday 13:00'],'the markets');
  const closed=times(base,['KR','US'],new Set(['2026-11-13']));assert.deepEqual(closed,['After Korea opens 10:00','Korea midday 13:00']);
  assert.notEqual(T.nextTimes(base,['KR','US'],now,{closedDays:new Set(['2026-11-13'])})[0].at,T.nextTimes(base,['KR','US'],now,{closedDays:new Set()})[0].at,'a closed day moves the next run to Monday');
  assert.equal(T.dueSlot(base,['KR'],at('2026-11-13T01:05:00Z'),{closedDays:new Set(['2026-11-13'])}),null,'and no slot is due on it');
});

test('callers get copies: changing a returned slot does not change the kept one',()=>{
  T.clearCache();const c={...T.TIMING_DEFAULTS};const a=T.slotsOn(c,'2026-11-13',['KR'],{});a[0].at=0;a[0].label='changed';a.pop();
  assert.deepEqual(T.slotsOn(c,'2026-11-13',['KR'],{}),T.readSlots(c,'2026-11-13',['KR'],{}));
});

test('the cache is bounded',()=>{
  T.clearCache();const c={...T.TIMING_DEFAULTS};for(let i=0;i<200;i++)T.slotsOn(c,addDays(day0,i),['KR'],{});assert.ok(T.cacheSize()<=32,String(T.cacheSize()));
});

test('the Seoul date by UTC+9 equals the time-zone database across midnight and the year',()=>{
  for(const iso of ['2026-11-12T14:59:59.999Z','2026-11-12T15:00:00.000Z','2026-12-31T14:59:59Z','2026-12-31T15:00:00Z','2027-03-14T06:59:00Z','2027-03-14T07:00:00Z','2026-11-01T05:30:00Z'])
    assert.equal(T.seoulDay(at(iso)),S.localDay(at(iso),'Asia/Seoul'),iso);
  for(let t=at('2026-01-01T00:00:00Z');t<at('2027-01-01T00:00:00Z');t+=3600000*7)assert.equal(T.seoulDay(t),S.localDay(t,'Asia/Seoul'));
});
