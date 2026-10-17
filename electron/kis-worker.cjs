const fs=require('node:fs/promises');
const {KisReadOnlyClient}=require('./kis-client.cjs');
const {KisQuoteStream,aggregateFiveMinutes}=require('./kis-stream.cjs');
let client; let stream; let busy=false; let symbols=new Set();const prepared=new Map();
process.parentPort.on('message',async ({data})=>{
  const {id,operation}=data;
  if(busy) {process.parentPort.postMessage({id,ok:false,code:'BUSY'});return;}
  busy=true;
  try {
    if(operation==='import') {
      const handle=await fs.open(data.path,'r');
      let text;
      try {
        const stat=await handle.stat();
        if(!stat.isFile() || stat.size>65536) throw new Error();
        text=await handle.readFile('utf8');
        if(text.length>65536) throw new Error();
      } finally {await handle.close();}
      const {parseCredentials}=require('./kis-client.cjs');
      stream?.stop();
      client=new KisReadOnlyClient(parseCredentials(text));text=null;
      stream=new KisQuoteStream(client,quote=>process.parentPort.postMessage({type:'quote',quote}),state=>process.parentPort.postMessage({type:'stream',state}));
    } else if(!client) throw new Error('KIS_NOT_CONNECTED');
    if(operation==='company-chart'){const snapshot=await require('./kis-evidence.cjs').fetchEvidence(client,data.request,true);process.parentPort.postMessage({id,ok:true,snapshot});return;}
    if(operation==='market-evidence'){const snapshot=await require('./kis-evidence.cjs').fetchEvidence(client,data.request);process.parentPort.postMessage({id,ok:true,snapshot});return;}
    if(operation.startsWith('us-')) {
      const us=new (require('./kis-overseas.cjs').OverseasClient)(client);let snapshot;
      if(operation==='us-context')snapshot=await us.context(data.symbols??[]);
      else if(operation==='us-orders')snapshot=await us.orders(data.startDate);
      else if(operation==='us-charges')snapshot=await us.trades(data.start,data.end);
      else if(operation==='us-prepare-order'){const check=await us.prepare(data.command);const ticket=require('node:crypto').randomUUID();prepared.set(ticket,{command:data.command,market:'US',expiresAt:Date.now()+15000});snapshot={...check,ticket};}
      else if(operation==='us-place-order'){const entry=prepared.get(data.ticket);prepared.delete(data.ticket);if(!entry||entry.market!=='US'||entry.expiresAt<Date.now())throw new Error();snapshot=await us.place(entry.command);}
      else throw new Error();
      process.parentPort.postMessage({id,ok:true,snapshot});return;
    }
    if(data.operation==='live-context') {
      if(!Array.isArray(data.symbols)||data.symbols.length>20||data.symbols.some(symbol=>typeof symbol!=='string'||!/^\d{6}$/.test(symbol)))throw 0;
      const extra=data.extra??[];if(!Array.isArray(extra)||extra.length>20||extra.some(symbol=>typeof symbol!=='string'||!/^\d{6}$/.test(symbol)))throw 0;
      let marketSession;try{const session=await client.checkSession();marketSession={open:true,status:'open',...(session?.basis?{basis:session.basis}:{})};}catch(error){marketSession={open:false,status:error.code==='SESSION_CLOSED'?'closed':'unverified'};}
      const balance=await client.getBalance();const quotes=[];
      for(const symbol of [...new Set([...(data.symbols.length?data.symbols:balance.holdings.map(row=>row.symbol).filter(symbol=>/^\d{6}$/.test(symbol))),...extra])].slice(0,20))quotes.push(await client.getQuote(symbol));
      process.parentPort.postMessage({id,ok:true,snapshot:{balance,quotes,marketSession}});return;
    }
    if(data.operation==='prepare-order') {
      for(const [key,entry] of prepared)if(entry.expiresAt<Date.now())prepared.delete(key);
      const check=await client.prepareOrder(data.command);const ticket=require('node:crypto').randomUUID();prepared.set(ticket,{command:data.command,expiresAt:Date.now()+15000});
      process.parentPort.postMessage({id,ok:true,snapshot:{...check,ticket}});return;
    }
    if(data.operation==='place-order') {
      const entry=prepared.get(data.ticket);prepared.delete(data.ticket);
      if(!entry||entry.market||Date.now()>entry.expiresAt)throw new Error();
      process.parentPort.postMessage({id,ok:true,snapshot:await client.placeOrder(entry.command)});return;
    }
    if(operation==='charges') {
      process.parentPort.postMessage({id,ok:true,snapshot:await client.getOrderCharges(data.day,data.orderId)});return;
    }
    if(['orders','profit'].includes(operation)) {
      process.parentPort.postMessage({id,ok:true,snapshot:await client.getActivity(operation,data.startDate,data.endDate)});return;
    }
    if(operation==='index-history') {
      process.parentPort.postMessage({id,ok:true,snapshot:await require('./kis-index.cjs').indexHistory(client,data.request)});return;
    }
    if(operation==='news') {
      const body=await client.quotation('news-title','FHKST01011800',{FID_NEWS_OFER_ENTP_CODE:'',FID_COND_MRKT_CLS_CODE:'',FID_INPUT_ISCD:typeof data.symbol==='string'&&/^\d{6}$/.test(data.symbol)?data.symbol:'',FID_TITL_CNTT:'',FID_INPUT_DATE_1:'',FID_INPUT_HOUR_1:'',FID_RANK_SORT_CLS_CODE:'',FID_INPUT_SRNO:''});
      process.parentPort.postMessage({id,ok:true,snapshot:require('./news.cjs').kisNews(body.output)});return;
    }
    if(operation==='research-section') {
      if(typeof data.symbol!=='string'||typeof data.section!=='string')throw 0;
      process.parentPort.postMessage({id,ok:true,snapshot:await require('./kis-insights.cjs').fetchSection(client,data.symbol,data.section,require('./kis-activity.cjs').seoulDate(),data.context??{})});return;
    }
    if(operation==='screen') {
      process.parentPort.postMessage({id,ok:true,snapshot:await require('./kis-rankings.cjs').rankings(client,data.request)});return;
    }
    if(operation==='quotes') {
      const quotes=[];
      const requested=data.symbols??[...symbols];if(!Array.isArray(requested)||requested.length>20||requested.some(symbol=>!/^\d{6}$/.test(symbol)))throw new Error('INVALID_REQUEST');
      for(const symbol of requested) quotes.push(await client.getQuote(symbol));
      process.parentPort.postMessage({id,ok:true,snapshot:quotes});return;
    }
    if(operation==='history') {
      if(!symbols.has(data.symbol))throw new Error();
      if(!['1d','1m','5m'].includes(data.interval))throw new Error();
      const candles=data.interval==='1d'?await client.getDailyHistory(data.symbol):await client.getMinuteHistory(data.symbol);
      process.parentPort.postMessage({id,ok:true,snapshot:data.interval==='5m'?aggregateFiveMinutes(candles):candles});return;
    }
    if(!['import','refresh'].includes(operation))throw new Error();
    const snapshot=await client.getBalance();
    symbols=new Set(snapshot.holdings.map(row=>row.symbol));
    stream.setSymbols(symbols);
    process.parentPort.postMessage({id,ok:true,snapshot});
  } catch(error) {
    const allowed=['INVALID_CREDENTIAL_FILE','CREDIT_ACCOUNT_REQUIRED','INVALID_RESPONSE','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','INCOMPLETE_BALANCE','INCOMPLETE_HISTORY','INVALID_DATE_RANGE','FEATURE_UNAVAILABLE','INVALID_ORDER','SESSION_CLOSED','PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','ORDER_UNCERTAIN'];
    const code=error.code??error.message;process.parentPort.postMessage({id,ok:false,retryAt:Number.isFinite(error.retryAt)?error.retryAt:null,httpStatus:Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?error.httpStatus:null,brokerCode:/^[A-Z0-9_-]{1,24}$/.test(error.brokerCode??'')?error.brokerCode:null,code:operation.startsWith('us-')?require('./us-errors.cjs').publicUSCode(code):allowed.includes(code)?code:'REQUEST_FAILED'});
  } finally {busy=false;}
});
