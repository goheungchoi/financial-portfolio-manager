function exchangeTimestamp(date,time) {
  if(typeof date!=='string' || !/^\d{8}$/.test(date) || typeof time!=='string' || !/^\d{6}$/.test(time))throw new Error('INVALID_STREAM_DATA');
  const timestamp=Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)}+09:00`);
  if(!Number.isFinite(timestamp))throw new Error('INVALID_STREAM_DATA');
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp));
  const value=type=>parts.find(part=>part.type===type)?.value;
  if(!Number.isFinite(timestamp) || `${value('year')}${value('month')}${value('day')}`!==date || `${value('hour')}${value('minute')}${value('second')}`!==time)throw new Error('INVALID_STREAM_DATA');
  return timestamp;
}
function parseTradeFrame(raw,symbols,now=Date.now()) {
  if(typeof raw!=='string' || raw.length>500000)return [];
  const parts=raw.split('|');
  if(parts.length!==4 || parts[0]!=='0' || parts[1]!=='H0STCNT0')return [];
  const count=Number(parts[2]); const fields=parts[3].split('^');const width=fields.length/count;
  if(!Number.isInteger(count) || count<1 || count>100 || !Number.isInteger(width) || width<34 || width>60)return [];
  const quotes=[];
  for(let i=0;i<count;i++) {
    const row=fields.slice(i*width,(i+1)*width);
    try {
      if(!symbols.has(row[0]) || !/^[A-Z0-9]{6}$/.test(row[0]) || !/^\d+$/.test(row[2]) || !/^\d+$/.test(row[12]) || !/^\d+$/.test(row[13]))continue;
      const timestamp=exchangeTimestamp(row[33],row[1]);
      const price=Number(row[2]),volume=Number(row[12]),cumulativeVolume=Number(row[13]);
      if(timestamp>now+2000 || !Number.isSafeInteger(price) || price<=0 || !Number.isSafeInteger(volume) || !Number.isSafeInteger(cumulativeVolume) || cumulativeVolume<volume)continue;
      quotes.push({symbol:row[0],price,timestamp,volume,cumulativeVolume,receivedAt:now,source:'stream'});
    } catch {}
  }
  return quotes;
}
class TradeDeduplicator {
  constructor(){this.last=new Map();}
  accept(quote) {
    const previous=this.last.get(quote.symbol);
    if(previous && (quote.timestamp<previous.timestamp || (Math.floor((quote.timestamp+32400000)/86400000)===Math.floor((previous.timestamp+32400000)/86400000) && quote.cumulativeVolume<=previous.cumulativeVolume)))return false;
    this.last.set(quote.symbol,quote);return true;
  }
  clear(){this.last.clear();}
}
class KisQuoteStream {
  constructor(client,onQuote,onStatus,Socket=WebSocket) {
    this.client=client;this.onQuote=onQuote;this.onStatus=onStatus;this.Socket=Socket;this.generation=0;this.attempt=0;this.symbols=[];this.dedupe=new TradeDeduplicator();
  }
  setSymbols(symbols) {
    const selected=[...symbols].sort().slice(0,20);
    if(JSON.stringify(selected)===JSON.stringify(this.symbols))return;
    this.stop();this.symbols=selected;this.dedupe.clear();
    if(selected.length) {this.active=true;this.attempt=0;void this.connect(this.generation);}
    else this.onStatus({status:'idle',subscribed:0});
  }
  stop() {
    this.active=false;this.generation++;clearTimeout(this.retry);clearTimeout(this.connectTimer);clearInterval(this.watchdog);
    for(const timer of this.subscriptionTimers??[])clearTimeout(timer);
    try{this.socket?.close();}catch{}this.socket=null;
  }
  async connect(generation) {
    if(!this.active || generation!==this.generation)return;
    this.onStatus({status:'connecting',subscribed:0});
    try {
      const config=await this.client.getStreamConfig();
      if(!this.active || generation!==this.generation)return;
      const socket=new this.Socket(config.url);this.socket=socket;this.lastMessage=Date.now();const acknowledged=new Set();
      const current=()=>this.active && generation===this.generation && this.socket===socket;
      const fail=()=>{if(!current())return;this.socket=null;try{socket.close();}catch{}this.scheduleRetry(generation);};
      this.connectTimer=setTimeout(fail,15000);
      socket.addEventListener('open',()=>{
        if(!current())return;
        this.onStatus({status:'subscribing',subscribed:0});
        this.subscriptionTimers=this.symbols.map((symbol,index)=>setTimeout(()=>{
          if(current() && socket.readyState===1)socket.send(JSON.stringify({header:{approval_key:config.approvalKey,custtype:'P',tr_type:'1','content-type':'utf-8'},body:{input:{tr_id:'H0STCNT0',tr_key:symbol}}}));
        },index*250));
        this.watchdog=setInterval(()=>{if(current() && Date.now()-this.lastMessage>120000)fail();},5000);
      });
      socket.addEventListener('message',event=>{
        if(!current() || typeof event.data!=='string' || event.data.length>500000)return;
        this.lastMessage=Date.now();
        if(event.data.startsWith('{')) {
          try {
            const message=JSON.parse(event.data);
            if(message.header?.tr_id==='PINGPONG'){socket.send(event.data);return;}
            if(message.header?.tr_id==='H0STCNT0') {
              if(message.body?.rt_cd!=='0'){this.client.invalidateStreamApproval?.();this.attempt=Math.max(this.attempt,4);fail();return;}
              if(this.symbols.includes(message.header?.tr_key))acknowledged.add(message.header.tr_key);
              if(acknowledged.size===this.symbols.length){clearTimeout(this.connectTimer);this.attempt=0;this.onStatus({status:'streaming',subscribed:acknowledged.size});}
            }
          } catch {}
          return;
        }
        for(const quote of parseTradeFrame(event.data,new Set(this.symbols)))if(this.dedupe.accept(quote))this.onQuote(quote);
      });
      socket.addEventListener('error',fail);socket.addEventListener('close',fail);
    } catch {if(this.active && generation===this.generation)this.scheduleRetry(generation);}
  }
  scheduleRetry(generation) {
    clearTimeout(this.connectTimer);clearInterval(this.watchdog);
    for(const timer of this.subscriptionTimers??[])clearTimeout(timer);
    const delay=Math.min(60000,1000*2**Math.min(this.attempt++,6));
    this.onStatus({status:'reconnecting',subscribed:0,retryInMs:delay});
    this.retry=setTimeout(()=>void this.connect(generation),delay);
  }
}
function aggregateFiveMinutes(candles) {
  const result=[];
  for(const candle of candles) {
    const timestamp=Math.floor(candle.timestamp/300000)*300000;
    const last=result.at(-1);
    if(last?.timestamp===timestamp) {last.high=Math.max(last.high,candle.high);last.low=Math.min(last.low,candle.low);last.close=candle.close;last.volume+=candle.volume;}
    else result.push({...candle,timestamp});
  }
  return result;
}
module.exports={exchangeTimestamp,parseTradeFrame,TradeDeduplicator,KisQuoteStream,aggregateFiveMinutes};
