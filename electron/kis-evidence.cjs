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
    const data=orderBook(body,Boolean(us));return data?{...meta,data}:{...meta,status:'unavailable',reason:'NO_TWO_SIDED_BOOK'};
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
  return {...meta,status:data.bars?'available':'unavailable',data,...(includeCandles?{candles:candles.filter(c=>['timestamp','open','high','low','close','volume'].every(k=>Number.isFinite(c[k]))&&c.low>0).sort((a,b)=>a.timestamp-b.timestamp).slice(daily?-100*pages:-120)}:{})};
}
module.exports={fetchEvidence};
