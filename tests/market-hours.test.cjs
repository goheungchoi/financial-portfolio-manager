const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {marketHours,PRE_OPEN_MS}=require('../electron/market-hours.cjs');
const kst=s=>Date.parse(s+'+09:00');
test('Korea is open on weekdays 09:00–15:20 Seoul; the next open and pre-open window are found',()=>{
  assert.equal(marketHours('kis',kst('2026-10-19T10:00')).open,true);
  const night=marketHours('kis',kst('2026-10-19T01:00'));assert.equal(night.open,false);assert.equal(night.next.at,kst('2026-10-19T09:00'));assert.equal(night.preOpen,null);
  const early=marketHours('kis',kst('2026-10-19T08:52'));assert.equal(early.preOpen.at,kst('2026-10-19T09:00')-PRE_OPEN_MS);assert.equal(early.preOpen.market,'KR');
  assert.equal(marketHours('kis',kst('2026-10-19T15:25')).open,false,'after the 15:20 order cutoff');
  assert.equal(marketHours('kis',kst('2026-10-24T11:00')).next.at,kst('2026-10-26T09:00'),'Saturday waits for Monday');
  assert.equal(marketHours('kis',kst('2026-10-19T10:00'),new Set(['2026-10-19'])).open,false,'a holiday learned from KIS');
});
test('U.S. hours follow New York, and either market being open keeps both-market scope open; paper is never paused',()=>{
  assert.equal(marketHours('us',kst('2026-10-19T23:00')).open,true,'09:00 ET is before the open, 10:00 ET open');
  assert.equal(marketHours('us',kst('2026-10-19T22:00')).open,false);
  assert.equal(marketHours('both',kst('2026-10-19T23:00')).open,true);assert.equal(marketHours('both',kst('2026-10-19T16:00')).next.market,'US');
  assert.equal(marketHours('paper',kst('2026-10-19T01:00')).open,true);
});
test('while markets are closed, scheduled reviews wait and one pre-open review runs',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>{throw new Error('no AI');}},()=>{});
  a.configure({scope:'kis',enabled:true});a.sessionArmed=true;a.lastRun=0;a.schedulerStatus=()=>({label:'Monitoring'});const runs=[];a.review=async t=>{runs.push(t);};
  let now=kst('2026-10-19T01:00');a.marketHours=()=>marketHours('kis',now);a.tick();assert.deepEqual(runs,[],'closed: nothing runs');
  now=kst('2026-10-19T08:51');a.tick();a.tick();assert.deepEqual(runs,['Pre-open review'],'once per open');
  a.configure({closedMarketReviews:'off'});a.preOpenKey=null;a.tick();assert.equal(runs.length,1,'off: no pre-open review');
  a.configure({closedMarketReviews:'keep'});a.tick();assert.equal(runs.at(-1),'Scheduled review','keep: the interval applies');
  assert.throws(()=>a.configure({closedMarketReviews:'sometimes'}),/INVALID_SETTINGS/);
});
