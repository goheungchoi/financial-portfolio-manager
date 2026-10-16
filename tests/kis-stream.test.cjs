const test=require('node:test');
const assert=require('node:assert/strict');
const {exchangeTimestamp,parseTradeFrame,TradeDeduplicator,KisQuoteStream,aggregateFiveMinutes}=require('../electron/kis-stream.cjs');
const now=Date.parse('2026-10-15T09:01:00+09:00');
function trade({symbol='005930',hour='090100',volume='10',cumulative='100',price='150'}={}) {
  const fields=Array(47).fill('0');fields[0]=symbol;fields[1]=hour;fields[2]=price;fields[12]=volume;fields[13]=cumulative;fields[33]='20261015';return fields.join('^');
}
test('stream parser validates subscriptions, field counts and Seoul exchange timestamps',()=>{
  const symbols=new Set(['005930']);
  const quotes=parseTradeFrame('0|H0STCNT0|002|'+trade()+'^'+trade({hour:'090101',cumulative:'110'}),symbols,now+1000);
  assert.equal(quotes.length,2);assert.equal(quotes[0].timestamp,now);assert.equal(quotes[0].volume,10);
  assert.equal(parseTradeFrame('1|H0STCNT0|001|'+trade(),symbols,now).length,0);
  assert.equal(parseTradeFrame('0|H0STCNT0|001|'+trade({symbol:'000660'}),symbols,now).length,0);
  assert.equal(parseTradeFrame('0|H0STCNT0|001|'+trade({price:'NaN'}),symbols,now).length,0);
  assert.throws(()=>exchangeTimestamp('20260230','090000'));
  assert.throws(()=>exchangeTimestamp('20261015','250000'));
});
test('duplicate and older trades are rejected across reconnections; next day resets volume',()=>{
  const dedupe=new TradeDeduplicator();const quote={symbol:'005930',timestamp:now,cumulativeVolume:100};
  assert.equal(dedupe.accept(quote),true);assert.equal(dedupe.accept(quote),false);
  assert.equal(dedupe.accept({...quote,timestamp:now-1000,cumulativeVolume:110}),false);
  assert.equal(dedupe.accept({...quote,timestamp:now+86400000,cumulativeVolume:1}),true);
});
test('five-minute aggregation preserves OHLC and volume with partial edge buckets',()=>{
  const candles=[{timestamp:now,open:100,high:120,low:90,close:110,volume:10},{timestamp:now+60000,open:110,high:130,low:100,close:125,volume:20}];
  assert.deepEqual(aggregateFiveMinutes(candles),[{timestamp:Math.floor(now/300000)*300000,open:100,high:130,low:90,close:125,volume:30}]);
  assert.equal(candles[0].volume,10);
});
test('socket subscribes, acknowledges, echoes heartbeat, reconnects, and stops cleanly',async()=>{
  const sockets=[];const statuses=[];const quotes=[];
  class FakeSocket extends EventTarget {
    constructor(url){super();this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
    open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
    message(data){const event=new Event('message');Object.defineProperty(event,'data',{value:data});this.dispatchEvent(event);}
    send(value){this.sent.push(value);}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const stream=new KisQuoteStream({getStreamConfig:async()=>({url:'ws://fixture',approvalKey:'fixture-only'})},q=>quotes.push(q),state=>statuses.push(state),FakeSocket);
  try {
    stream.setSymbols(new Set(['005930']));await new Promise(resolve=>setTimeout(resolve,5));
    const socket=sockets[0];socket.open();await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(JSON.parse(socket.sent[0]).body.input.tr_key,'005930');
    socket.message(JSON.stringify({header:{tr_id:'H0STCNT0',tr_key:'005930'},body:{rt_cd:'0'}}));
    assert.equal(statuses.at(-1).status,'streaming');
    const ping=JSON.stringify({header:{tr_id:'PINGPONG'}});socket.message(ping);assert.equal(socket.sent.at(-1),ping);
    // Use a real current exchange date/time so parser clock checks remain meaningful.
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const value=type=>parts.find(p=>p.type===type).value;
    const frame=trade({hour:value('hour')+value('minute')+value('second')}).split('^');frame[33]=value('year')+value('month')+value('day');
    socket.message('0|H0STCNT0|001|'+frame.join('^'));socket.message('0|H0STCNT0|001|'+frame.join('^'));
    assert.equal(quotes.length,1);
    socket.close();assert.equal(statuses.at(-1).status,'reconnecting');
    await new Promise(resolve=>setTimeout(resolve,1050));assert.equal(sockets.length,2);
    stream.stop();assert.equal(sockets[1].readyState,3);
    assert.ok(statuses.every(state=>!JSON.stringify(state).includes('fixture-only')));
  } finally {stream.stop();}
});
