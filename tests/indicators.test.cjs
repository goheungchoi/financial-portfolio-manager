const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const ind=require('../electron/indicators.cjs');const {ResearchService}=require('../electron/research-service.cjs');
const candles=(n,f,range=2)=>Array.from({length:n},(_,i)=>{const close=f(i);return {date:new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10),open:close,high:close+range/2,low:close-range/2,close,volume:1000,value:1e9};});
test('indicators behave as defined on simple series',()=>{
  const up=candles(80,i=>100+i),flat=candles(80,()=>100),down=candles(80,i=>200-i);
  assert.equal(ind.rsi(up.map(c=>c.close)),100);assert.equal(ind.rsi(flat.map(c=>c.close)),50);assert.equal(ind.rsi(down.map(c=>c.close)),0);
  assert.ok(ind.macd(up.map(c=>c.close)).macd>0);assert.ok(ind.macd(down.map(c=>c.close)).macd<0);
  assert.ok(Math.abs(ind.atr(flat,14)-2)<1e-9,'constant high-low range of 2');assert.ok(Math.abs(ind.atr(up,14)-2)<1e-9,'gaps of 1 inside a range of 2');
  const a=ind.adx(up);assert.ok(a.adx>25&&a.plusDI>a.minusDI,'a steady rise is a strong up trend');const b=ind.adx(down);assert.ok(b.minusDI>b.plusDI);
  assert.ok(ind.cci(up)>0);assert.equal(ind.ultimate(up),50,'closes mid-range');assert.equal(ind.ultimate(up.map(c=>({...c,high:c.close,low:c.close-2}))),100,'closes at the high');assert.equal(ind.stochRsi(flat.map(c=>c.close)),50);
  const t=ind.technicals(up);assert.equal(t.atrPct,Math.round(2/179*10000)/100);assert.equal(t.range20.positionPct,100);
  assert.equal(ind.technicals(up.slice(0,10)),null,'too short');assert.equal(ind.atr(up.map(c=>({...c,high:null})),14),null,'needs highs and lows');
});
test('formulas can use ATR, ADX and the MACD histogram',()=>{
  const f=require('../electron/formula.cjs');const c=candles(80,i=>100+i);const data={price:()=>180,closes:()=>c,previousClose:()=>null};
  assert.ok(Math.abs(f.evaluate(f.parse('atr("005930")').ast,data)-2)<1e-9);assert.ok(f.evaluate(f.parse('adx("005930",14)').ast,data)>25);assert.ok(Number.isFinite(f.evaluate(f.parse('macd("005930")').ast,data)));
  assert.throws(()=>f.evaluate(f.parse('atr("005930")').ast,{price:()=>1,closes:()=>c.slice(0,5)}),/NOT_ENOUGH_HISTORY/);
});
function service(){
  const symbols={'005930':{per:33,pbr:3.4,price:217000,bps:63997,trend:i=>200000+i*100,eps:[6564,9000],roe:10,growth:37},'000660':{per:21,pbr:7.4,price:1265000,bps:171751,trend:i=>1200000+i*2000,eps:[58955,70000],roe:30,growth:19},'066570':{per:10,pbr:1,price:90000,bps:90000,trend:i=>90000-i*50,eps:[9000,9500],roe:8,growth:5}};
  const db=new DatabaseSync(':memory:');
  return new ResearchService({db,master:{get:s=>({name:s,market:'KOSPI',type:'stock',sector:'0013'}),status:()=>({total:3}),peers:s=>Object.keys(symbols).filter(x=>x!==s).map(x=>({symbol:x,name:x,marketCap:1}))},provider:async()=>null,
    kis:async(op,{symbol,section})=>{const d=symbols[symbol];if(section==='overview')return {price:d.price,per:d.per,pbr:d.pbr,bps:d.bps,marketCapKRW:1};if(section==='daily')return {closes:candles(100,d.trend)};
      if(section==='estimates')return {years:['2025','2026E'],forecastYears:['2026E'],eps:d.eps,roePct:[d.roe,d.roe+1],revenue:[100,120],operatingProfit:[20,30],epsGrowthPct:[10,d.growth],revenueGrowthPct:[5,10]};
      if(section==='analysts')return {medianTarget:300000,brokerages:22};if(section==='valuation')return {perRange:{median:13.6,years:6},pbrRange:{median:1.5,years:6}};return {};}});
}
test('factor scores are percentiles against same-sector peers, with low volatility inverted',async()=>{
  const s=service();const f=await s.section('005930','factors');assert.equal(f.status,'ok');assert.equal(f.data.peers,2);
  const self=f.data.self;assert.equal(self.growth,75,'highest EPS growth, revenue growth tied');assert.equal(self.quality,50,'ROE in the middle, margins tied');assert.equal(f.data.rows.length,3);
  const lg=(await s.section('066570','factors')).data.self;assert.equal(lg.momentum,0,'falling stock');assert.equal(lg.value,100,'cheapest on earnings and book');
  const risk=await s.section('005930','risk');assert.ok(risk.data.technicals.rsi14!=null);
});
test('fair value takes the middle of several methods and reports their spread as uncertainty',async()=>{
  const s=service();const v=await s.section('005930','fairvalue');assert.equal(v.status,'ok');
  assert.deepEqual(v.data.methods.map(m=>m.method),['Analyst median target','Peer median PER × next-year EPS','Own median PER × next-year EPS','Peer median PBR × book value','Own median PBR × book value']);
  assert.equal(v.data.methods[1].value,Math.round(10*9000),'peer median PER of 10 and 21 is 10 here (lower middle)');assert.equal(v.data.uncertainty,'high');assert.ok(v.data.low<=v.data.fairValue&&v.data.fairValue<=v.data.high);
  const agent=await s.agent({symbol:'005930',sections:['factors','fairvalue']});assert.ok(agent.factors.self&&agent.fairvalue.fairValue);assert.equal(agent.factors.rows[0].metrics,undefined,'agents get scores, not raw metrics');
});
