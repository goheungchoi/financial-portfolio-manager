import test from 'node:test';import assert from 'node:assert/strict';
import {applyTick,dayStart} from '../src/live-bars.mjs';
const kst=iso=>Date.parse(iso+'+09:00');const bar=(timestamp,close,volume=10)=>({timestamp,open:close,high:close,low:close,close,volume});

test('a tick updates the current minute bar or starts the next one',()=>{
  const bars=[bar(kst('2026-10-29T10:00:00'),100),bar(kst('2026-10-29T10:01:00'),101)];
  const same=applyTick(bars,{symbol:'005930',price:103,timestamp:kst('2026-10-29T10:01:40'),volume:5},{period:60000});
  assert.equal(same.length,2);assert.deepEqual(same[1],{timestamp:kst('2026-10-29T10:01:00'),open:101,high:103,low:101,close:103,volume:15});
  const lower=applyTick(same,{price:99,timestamp:kst('2026-10-29T10:01:50'),volume:1},{period:60000});assert.equal(lower[1].low,99);assert.equal(lower[1].high,103,'the high is kept');
  const next=applyTick(lower,{price:98,timestamp:kst('2026-10-29T10:02:05'),volume:2},{period:60000});
  assert.equal(next.length,3);assert.deepEqual(next[2],{timestamp:kst('2026-10-29T10:02:00'),open:98,high:98,low:98,close:98,volume:2});
  assert.equal(applyTick(next,{price:1,timestamp:kst('2026-10-29T09:59:00')},{period:60000}),next,'an older tick changes nothing');
  assert.equal(applyTick(next,{price:0,timestamp:kst('2026-10-29T10:03:00')},{period:60000}),next,'nor does a bad price');
  assert.equal(applyTick(bars,{price:104,timestamp:kst('2026-10-29T10:14:00')},{period:900000}).length,2,'10:14 is in the 10:00 15-minute bar');
  const quarter=applyTick(bars,{price:104,timestamp:kst('2026-10-29T10:16:00')},{period:900000});assert.equal(quarter.length,3);assert.equal(quarter[2].timestamp,kst('2026-10-29T10:15:00'));
  assert.deepEqual(applyTick([],{price:5,timestamp:kst('2026-10-29T10:00:30')},{period:60000}),[{timestamp:kst('2026-10-29T10:00:00'),open:5,high:5,low:5,close:5,volume:0}]);
});

test('daily bars follow the exchange date; the day volume replaces the total',()=>{
  const kr=[bar(dayStart('2026-10-28','KR'),200,900),bar(dayStart('2026-10-29','KR'),205,1000)];
  const today=applyTick(kr,{price:210,timestamp:kst('2026-10-29T13:00:00'),dayVolume:1500,volume:3},{period:'day'});
  assert.equal(today.length,2);assert.equal(today[1].close,210);assert.equal(today[1].high,210);assert.equal(today[1].volume,1500);
  const tomorrow=applyTick(kr,{price:211,timestamp:kst('2026-10-30T09:00:05'),dayVolume:20},{period:'day'});assert.equal(tomorrow.length,3);assert.equal(tomorrow[2].timestamp,dayStart('2026-10-30','KR'));assert.equal(tomorrow[2].volume,20);
  // U.S.: the New York date, with bars stamped at noon UTC.
  const us=[bar(dayStart('2026-10-28','US'),295)];const ny=Date.parse('2026-10-28T15:00:00-04:00');
  assert.equal(applyTick(us,{price:296,timestamp:ny},{period:'day',market:'US'}).length,1);
  const nextDay=applyTick(us,{price:297,timestamp:Date.parse('2026-10-29T10:00:00-04:00')},{period:'day',market:'US'});assert.equal(nextDay[1].timestamp,Date.parse('2026-10-29T12:00:00Z'));
  assert.equal(applyTick(us,{price:330,timestamp:Date.parse('2026-10-28T20:15:00-04:00'),session:'us-daytime'},{period:'day',market:'US'}),us,'daytime-session prices stay off daily bars');
  assert.equal(applyTick(us,{price:330,timestamp:Date.parse('2026-10-29T10:15:00-04:00'),session:'us-daytime'},{period:60000,market:'US'}),us,'and off intraday bars');
});

test('weekly and monthly bars: the latest bar takes the price',()=>{
  const weeks=[bar(kst('2026-10-19T00:00:00'),190),bar(kst('2026-10-26T00:00:00'),200)];
  const up=applyTick(weeks,{price:215,timestamp:kst('2026-10-29T11:00:00'),volume:4},{period:'last'});assert.equal(up.length,2);assert.equal(up[1].close,215);assert.equal(up[1].high,215);assert.equal(up[1].volume,10,'volume of long bars is left as reported');
  assert.equal(applyTick(weeks,{price:215,timestamp:kst('2026-10-20T11:00:00')},{period:'last'}),weeks);assert.deepEqual(applyTick([],{price:1,timestamp:1},{period:'last'}),[]);
});
