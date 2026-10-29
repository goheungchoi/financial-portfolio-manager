import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {summarize,pivots,rating,aggregate,TIMEFRAMES} from '../src/technical-summary.mjs';
const indicators=createRequire(import.meta.url)('../electron/indicators.cjs');
// A deterministic wandering series with real highs and lows.
const bars=(n,start=10000,drift=0)=>{let p=start,seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  return Array.from({length:n},(_,i)=>{const o=p;p=Math.max(1,p*(1+drift+(rnd()-0.5)*0.03));const hi=Math.max(o,p)*(1+rnd()*0.01),lo=Math.min(o,p)*(1-rnd()*0.01);return {timestamp:i*60000,open:o,high:hi,low:lo,close:p,volume:100};});};
const row=(s,name)=>s.indicators.rows.find(r=>r.name===name);

test('pivot points match the classic and Fibonacci levels of a known bar',()=>{
  // The levels shown for Q580082 on 2026-10-29 come from high 15,950, low 15,650, close 15,650.
  const p=pivots({timestamp:0,high:15950,low:15650,close:15650});
  assert.deepEqual(Object.fromEntries(Object.entries(p.classic).map(([k,v])=>[k,Math.round(v)])),{s3:15250,s2:15450,s1:15550,p:15750,r1:15850,r2:16050,r3:16150});
  assert.deepEqual(Object.fromEntries(Object.entries(p.fibonacci).map(([k,v])=>[k,Math.round(v)])),{s3:15450,s2:15565,s1:15635,p:15750,r1:15865,r2:15935,r3:16050});
  assert.equal(pivots({high:1,low:2,close:1}),null);
});

test('ratings follow the balance of buy and sell readings',()=>{
  assert.equal(rating({buy:4,sell:8}),'sell','moving averages 4 buy, 8 sell');assert.equal(rating({buy:4,neutral:3,sell:4}),'neutral');
  assert.equal(rating({buy:8,neutral:3,sell:12}),'neutral','both groups together');assert.equal(rating({buy:12}),'strong-buy');assert.equal(rating({sell:10,buy:1}),'strong-sell');assert.equal(rating({}),null);
});

test('indicator values agree with the indicators the reviews use',()=>{
  const c=bars(220);const s=summarize(c);
  const near=(a,b,msg)=>assert.ok(Math.abs(a-b)<=Math.max(1e-6,Math.abs(b)*1e-6)+1e-4,`${msg}: ${a} vs ${b}`);
  near(row(s,'RSI(14)').value,indicators.rsi(c.map(x=>x.close)),'RSI');near(row(s,'MACD(12,26)').value,indicators.macd(c.map(x=>x.close)).macd,'MACD');
  near(row(s,'ADX(14)').value,indicators.adx(c).adx,'ADX');near(row(s,'CCI(14)').value,indicators.cci(c),'CCI');near(row(s,'ATR(14)').value,indicators.atr(c),'ATR');near(row(s,'Ultimate Oscillator').value,indicators.ultimate(c),'UO');
  const closes=c.map(x=>x.close);near(s.movingAverages.rows.find(r=>r.period===20).simple.value,closes.slice(-20).reduce((a,b)=>a+b)/20,'SMA20');near(s.movingAverages.rows.find(r=>r.period===10).exponential.value,indicators.ema(closes,10).at(-1),'EMA10');
});

test('readings: averages against the price, overbought and oversold, and volatility not counted',()=>{
  const up=summarize(bars(220,10000,0.01));assert.equal(up.movingAverages.rating,'strong-buy','a steady climb is above every average');assert.equal(row(up,'RSI(14)').signal,'overbought');
  assert.equal(row(up,'ROC(12)').signal,'buy');assert.equal(row(up,'Bull/Bear Power(13)').signal,'buy');
  const down=summarize(bars(220,10000,-0.01));assert.equal(down.movingAverages.rating,'strong-sell');assert.equal(row(down,'RSI(14)').signal,'oversold');assert.equal(row(down,'Williams %R').signal,'oversold');
  const atr=row(up,'ATR(14)');assert.equal(atr.counted,false);assert.ok(['high-volatility','low-volatility'].includes(atr.signal));
  const counted=up.indicators.rows.filter(r=>r.counted).length;const {buy,sell,neutral}=up.indicators.counts;assert.equal(buy+sell+neutral,counted);
});

test('a short history reads what it can and says what it cannot',()=>{
  const s=summarize(bars(30));assert.equal(s.bars,30);
  assert.equal(s.movingAverages.rows.find(r=>r.period===50).simple,null);assert.ok(s.movingAverages.rows.find(r=>r.period===20).simple);
  assert.equal(row(s,'MACD(12,26)').signal,null,'MACD needs 34 bars');assert.equal(row(s,'MACD(12,26)').counted,false);assert.ok(row(s,'RSI(14)').signal);
  assert.equal(summarize(bars(1)),null);assert.equal(summarize([]),null);
  assert.equal(summarize([{timestamp:0,open:1,high:1,low:1,close:1},{timestamp:1,open:NaN,high:1,low:1,close:1},{timestamp:2,open:1,high:2,low:1,close:2}]).bars,2,'broken bars are left out');
});

test('minute bars combine into clock-aligned bars; the timeframes are listed in order',()=>{
  const base=Date.UTC(2026,9,29,0,0);const m=[0,1,2,3,4,5,6].map(i=>({timestamp:base+i*60000,open:10+i,high:11+i,low:9+i,close:10.5+i,volume:1}));
  const five=aggregate(m,5);assert.equal(five.length,2);assert.deepEqual(five[0],{timestamp:base,open:10,high:15,low:9,close:14.5,volume:5});assert.equal(five[1].open,15);assert.equal(five[1].close,16.5);
  assert.deepEqual(TIMEFRAMES.map(t=>t.id),['5m','15m','30m','1h','1d','1w','1M']);
});
