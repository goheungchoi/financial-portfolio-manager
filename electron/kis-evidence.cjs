const {company,technicals,orderBook,DATASETS}=require('./market-evidence.cjs');
const {exchangeTimestamp}=require('./kis-stream.cjs');
async function fetchEvidence(client,{symbol,dataset},includeCandles=false){
  const us=/^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.-]{0,14})$/.exec(symbol);
  if((!us&&!/^\d{6}$/.test(symbol))||!DATASETS.includes(dataset))throw new Error('INVALID_REQUEST');
  const params=us?{AUTH:'',EXCD:{NASD:'NAS',NYSE:'NYS',AMEX:'AMS'}[us[1]],SYMB:us[2]}:null;
  const retrievedAt=Date.now(),market=us?'US':'KR';
  const meta={status:'available',source:'KIS',market,currency:us?'USD':'KRW',retrievedAt,delay:'Broker entitlement dependent; retrieval time does not establish real-time exchange data'};
  if(dataset==='company'){
    const body=us?(await client.overseasRequest('/uapi/overseas-price/v1/quotations/price-detail','HHDFS76200200',params)).body:await client.quotation('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol});
    if(!body.output||typeof body.output!=='object')throw new Error('INVALID_RESPONSE');
    return {...meta,metrics:company(body.output,Boolean(us))};
  }
  if(dataset==='order_book'){
    const body=us?(await client.overseasRequest('/uapi/overseas-price/v1/quotations/inquire-asking-price','HHDFS76200100',params,{includeAccount:false})).body:await client.quotation('inquire-asking-price-exp-ccn','FHKST01010200',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol});
    const data=orderBook(body,Boolean(us),retrievedAt);return data?{...meta,data}:{...meta,status:'unavailable',reason:'NO_TWO_SIDED_BOOK'};
  }
  const daily=dataset==='daily_technicals';let candles;
  // Charts get two pages of daily bars (about 200); AI evidence keeps one.
  const pages=daily&&includeCandles?2:1;
  if(!us)candles=await (daily?client.getDailyHistory(symbol,pages):client.getMinuteHistory(symbol));
  else {
    const rows=[];let bymd='';
    for(let page=0;page<pages;page++){
      const {body}=await client.overseasRequest('/uapi/overseas-price/v1/quotations/'+(daily?'dailyprice':'inquire-time-itemchartprice'),daily?'HHDFS76240000':'HHDFS76950200',{...params,...(daily?{GUBN:'0',BYMD:bymd,MODP:'1'}:{NMIN:'1',PINC:'0',NEXT:'',NREC:'120',FILL:'',KEYB:''})});
      if(!Array.isArray(body.output2))throw new Error('INVALID_RESPONSE');
      const batch=body.output2.slice(0,120);rows.push(...batch);
      // Daily rows are newest first; continue from the day before the oldest one.
      const oldest=batch.map(row=>row.xymd).filter(d=>/^\d{8}$/.test(d??'')).sort()[0];
      if(!daily||batch.length<90||!oldest)break;const before=new Date(Date.parse(oldest.slice(0,4)+'-'+oldest.slice(4,6)+'-'+oldest.slice(6,8)+'T00:00:00Z')-86400000);bymd=before.toISOString().slice(0,10).replaceAll('-','');
    }
    const seen=new Set();
    candles=rows.filter(row=>{const key=daily?row.xymd:row.kymd+row.khms;if(seen.has(key))return false;seen.add(key);return true;}).map(row=>{
      const date=daily?row.xymd:row.kymd;
      // Daily rows carry the U.S. trading date; noon UTC is that same date in New York and Seoul.
      // Minute rows carry Korean date and time (kymd/khms).
      const timestamp=daily?Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T12:00:00Z`):exchangeTimestamp(date,row.khms);
      const numeric=value=>value==null||String(value).trim()===''?NaN:Number(value);
      return {timestamp,...(daily?{date:`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`} :{}),open:numeric(row.open),high:numeric(row.high),low:numeric(row.low),close:numeric(daily?row.clos:row.last),volume:numeric(daily?row.tvol:row.evol)};
    });
  }
  const data=technicals(candles,daily?'1d':'1m',dataset,Date.now(),market);
  return {...meta,status:data.bars?'available':'unavailable',data,...(includeCandles?{candles:clean(candles).slice(daily?-100*pages:-120)}:{})};
}
const clean=candles=>candles.filter(c=>['timestamp','open','high','low','close','volume'].every(k=>Number.isFinite(c[k]))&&c.low>0).sort((a,b)=>a.timestamp-b.timestamp);
// Bars for the Charts technical summary, besides the daily bars the chart already has. Korea: today's one-minute bars
// (the app combines them into 5-, 15-, 30- and 60-minute bars), 200 weekly and 100 monthly bars. U.S.: 120 bars of each
// intraday interval, including earlier days, and the same weekly and monthly bars. A timeframe that fails is reported on
// its own; the others still arrive.
async function fetchBars(client,{symbol}){
  const us=/^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.-]{0,14})$/.exec(symbol);if(!us&&!/^\d{6}$/.test(symbol))throw new Error('INVALID_REQUEST');
  const params=us?{AUTH:'',EXCD:{NASD:'NAS',NYSE:'NYS',AMEX:'AMS'}[us[1]],SYMB:us[2]}:null;const out={symbol,market:us?'US':'KR',retrievedAt:Date.now(),frames:{},errors:{}};
  const numeric=value=>value==null||String(value).trim()===''?NaN:Number(value);const day=d=>`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  // U.S. weekly (GUBN 1) and monthly (GUBN 2) rows, newest first; a second page continues before the oldest row.
  const usPeriod=async(gubn,pages)=>{const rows=[];let bymd='';for(let page=0;page<pages;page++){const {body}=await client.overseasRequest('/uapi/overseas-price/v1/quotations/dailyprice','HHDFS76240000',{...params,GUBN:gubn,BYMD:bymd,MODP:'1'});
      if(!Array.isArray(body.output2))throw new Error('INVALID_RESPONSE');const batch=body.output2.filter(r=>/^\d{8}$/.test(r?.xymd??''));rows.push(...batch);const oldest=batch.map(r=>r.xymd).sort()[0];if(batch.length<90||!oldest)break;
      bymd=new Date(Date.parse(day(oldest)+'T00:00:00Z')-86400000).toISOString().slice(0,10).replaceAll('-','');}
    const seen=new Set();return clean(rows.filter(r=>!seen.has(r.xymd)&&seen.add(r.xymd)).map(r=>({timestamp:Date.parse(day(r.xymd)+'T12:00:00Z'),open:numeric(r.open),high:numeric(r.high),low:numeric(r.low),close:numeric(r.clos),volume:numeric(r.tvol)})));};
  const usMinutes=async n=>{const {body}=await client.overseasRequest('/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice','HHDFS76950200',{...params,NMIN:String(n),PINC:'1',NEXT:'',NREC:'120',FILL:'',KEYB:''});
    if(!Array.isArray(body.output2))throw new Error('INVALID_RESPONSE');const seen=new Set();
    return clean(body.output2.filter(r=>/^\d{8}$/.test(r?.kymd??'')&&/^\d{6}$/.test(r?.khms??'')&&!seen.has(r.kymd+r.khms)&&seen.add(r.kymd+r.khms)).map(r=>({timestamp:exchangeTimestamp(r.kymd,r.khms),open:numeric(r.open),high:numeric(r.high),low:numeric(r.low),close:numeric(r.last),volume:numeric(r.evol)})));};
  const jobs=us?[['5m',()=>usMinutes(5)],['15m',()=>usMinutes(15)],['30m',()=>usMinutes(30)],['1h',()=>usMinutes(60)],['1w',()=>usPeriod('1',2)],['1M',()=>usPeriod('2',1)]]
    :[['1m',()=>client.getMinuteDay(symbol)],['1w',()=>client.getDailyHistory(symbol,2,'W')],['1M',()=>client.getDailyHistory(symbol,1,'M')]];
  for(const [id,job] of jobs){try{out.frames[id]=clean(await job());}catch(error){out.errors[id]=/^[A-Z_]{3,40}$/.test(error?.code??error?.message??'')?(error.code??error.message):'REQUEST_FAILED';}}
  return out;
}
module.exports={fetchEvidence,fetchBars};
