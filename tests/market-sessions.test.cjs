const test=require('node:test');const assert=require('node:assert/strict');
const {marketStatus,sessionsOn,zoned}=require('../electron/market-sessions.cjs');
const kst=s=>Date.parse(s+'+09:00');const at=t=>new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
test('Korean evening: the NXT after-market is open, not tradable on mock, and the next session is tomorrow morning',()=>{
  const s=marketStatus('KR',kst('2026-10-19T19:45'),{environment:'mock'});
  assert.deepEqual(s.open,['nxt-after']);assert.equal(s.appTrading,false);assert.equal(s.next.id,'nxt-pre');assert.equal(at(s.next.at),'08:00');
  assert.equal(s.sessions.find(x=>x.id==='krx-regular').tradable,'app');assert.equal(s.sessions.find(x=>x.id==='nxt-after').tradable,'Not offered on mock accounts');
  assert.equal(marketStatus('KR',kst('2026-10-19T19:45'),{environment:'live'}).sessions.find(x=>x.id==='nxt-after').tradable,'Not supported by the app yet');
});
test('the app trades the Korean regular session until its 15:20 cutoff; official holidays move to the next day',()=>{
  assert.equal(marketStatus('KR',kst('2026-10-20T15:10')).appTrading,true);assert.equal(marketStatus('KR',kst('2026-10-20T15:25')).appTrading,false);
  const holiday=marketStatus('KR',kst('2026-10-20T10:00'),{closedDays:new Set(['2026-10-20'])});assert.equal(holiday.day,'2026-10-21');assert.deepEqual(holiday.open,[]);
  assert.equal(sessionsOn('KR','2026-10-24').length,0,'Saturday');
});
test('U.S. sessions follow New York time, including the KIS daytime session the evening before and early closes',()=>{
  const s=marketStatus('US',kst('2026-10-19T19:45'));assert.deepEqual(s.open,['us-pre']);assert.equal(at(s.regular.startAt),'22:30');
  const early=sessionsOn('US','2026-11-27');assert.equal(at(early.find(x=>x.id==='us-regular').endAt),'03:00','1:00 p.m. ET early close');assert.equal(early.find(x=>x.id==='us-regular').earlyClose,true);
  assert.equal(sessionsOn('US','2026-11-26').length,0,'Thanksgiving');assert.equal(at(sessionsOn('US','2026-10-20').find(x=>x.id==='us-daytime').startAt),'09:00');
  assert.equal(zoned('2026-12-01','09:30','America/New_York'),Date.parse('2026-12-01T14:30:00Z'),'standard time after DST ends');
});
