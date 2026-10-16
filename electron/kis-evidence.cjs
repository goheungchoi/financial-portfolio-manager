const {company,technicals,DATASETS}=require('./market-evidence.cjs');
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
  const daily=dataset==='daily_technicals';let candles;
  if(!us)candles=await (daily?client.getDailyHistory(symbol):client.getMinuteHistory(symbol));
  else {
    const {body}=await client.overseasRequest('/uapi/overseas-price/v1/quotations/'+(daily?'dailyprice':'inquire-time-itemchartprice'),daily?'HHDFS76240000':'HHDFS76950200',{...params,...(daily?{GUBN:'0',BYMD:'',MODP:'1'}:{NMIN:'1',PINC:'0',NEXT:'',NREC:'120',FILL:'',KEYB:''})});
    if(!Array.isArray(body.output2))throw new Error('INVALID_RESPONSE');
    candles=body.output2.slice(0,120).map(row=>{
      const date=daily?row.xymd:row.kymd;
      const timestamp=exchangeTimestamp(date,daily?'000000':row.khms);
      const numeric=value=>value==null||String(value).trim()===''?NaN:Number(value);
      return {timestamp,...(daily?{date:`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`} :{}),open:numeric(row.open),high:numeric(row.high),low:numeric(row.low),close:numeric(daily?row.clos:row.last),volume:numeric(daily?row.tvol:row.evol)};
    });
  }
  const data=technicals(candles,daily?'1d':'1m',dataset,Date.now(),market);
  return {...meta,status:data.bars?'available':'unavailable',data,...(includeCandles?{candles:candles.filter(c=>['timestamp','open','high','low','close','volume'].every(k=>Number.isFinite(c[k]))&&c.low>0).sort((a,b)=>a.timestamp-b.timestamp).slice(-120)}:{})};
}
module.exports={fetchEvidence};
