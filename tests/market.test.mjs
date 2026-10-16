import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketCache,updateCandle,SyntheticMarketProvider} from '../src/market.mjs';
test('cache rejects malformed, unknown, duplicate and out-of-order quotes; timestamps govern freshness',()=>{
  const cache=new MarketCache(['005930'],5000);
  const q={symbol:'005930',price:100,sequence:1,timestamp:10000,volume:10};
  assert.equal(cache.snapshot(10000)[0].stale,true);
  assert.equal(cache.accept(q,10000),true);
  assert.equal(cache.accept(q,10000),false);
  assert.equal(cache.accept({...q,sequence:2,timestamp:9000},10000),false);
  assert.equal(cache.accept({...q,symbol:'unknown'},10000),false);
  assert.equal(cache.accept({...q,price:NaN},10000),false);
  assert.equal(cache.accept({...q,timestamp:20000},10000),false);
  assert.equal(cache.snapshot(11000)[0].stale,false);
  assert.equal(cache.snapshot(16000)[0].stale,true);
});
test('OHLC aggregation keeps open, updates range/close and sums trade volume',()=>{
  let series=[];
  for(const [timestamp,price,volume] of [[60000,100,5],[61000,110,7],[62000,90,3]]) series=updateCandle(series,{timestamp,price,volume},60000);
  assert.deepEqual(series,[{timestamp:60000,open:100,high:110,low:90,close:90,volume:15}]);
  series=updateCandle(series,{timestamp:120000,price:95,volume:2},60000);
  assert.equal(series.length,2);
  assert.equal(updateCandle(series,{timestamp:0,price:1,volume:1},60000),series);
});
test('provider history is isolated and restart keeps quote sequences increasing',()=>{
  const provider=new SyntheticMarketProvider([{symbol:'005930',price:10000}],120000);
  provider.emit(120000);
  const history=provider.getHistory('005930','1m');
  history[0].close=0;
  assert.notEqual(provider.getHistory('005930','1m')[0].close,0);
  assert.throws(()=>provider.getHistory('005930','invalid'));
  let sequence=0;
  provider.start(q=>sequence=q.sequence);provider.stop();
  const previous=sequence;
  provider.start(q=>sequence=q.sequence);provider.stop();
  assert.ok(sequence>previous);
});
