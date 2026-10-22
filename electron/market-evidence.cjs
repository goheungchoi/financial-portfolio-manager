const DATASETS=['company','daily_technicals','minute_technicals','range_10m','order_book'];
const TOOL={type:'function',name:'get_market_evidence',description:'Read company valuation/day/52-week ranges or computed SMA5/10/20 and fast stochastic (14,3) from daily or minute candles; range_10m is the last ten completed clock minutes; order_book is the live bid/ask book (best five levels with sizes, spread as a percentage of the midpoint, quote time). Only review-universe symbols. Missing metrics remain unavailable. No trading or credentials.',strict:true,parameters:{type:'object',properties:{symbol:{type:'string'},dataset:{type:'string',enum:DATASETS}},required:['symbol','dataset'],additionalProperties:false}};
function validRequest(value,symbols){return value&&Object.keys(value).sort().join(',')==='dataset,symbol'&&DATASETS.includes(value.dataset)&&symbols.includes(value.symbol);}
const number=value=>value===null||value===undefined||String(value).trim()===''||!Number.isFinite(Number(value))?null:Number(value);
function company(output={},us=false){
  const fields=us?{price:'last',dayOpen:'open',dayHigh:'high',dayLow:'low',high52Week:'h52p',low52Week:'l52p',PER:'perx',PBR:'pbrx',EPS:'epsx',BPS:'bpsx'}:{price:'stck_prpr',dayOpen:'stck_oprc',dayHigh:'stck_hgpr',dayLow:'stck_lwpr',high52Week:'w52_hgpr',low52Week:'w52_lwpr',PER:'per',PBR:'pbr',EPS:'eps',BPS:'bps'};
  const metrics=Object.fromEntries(Object.entries(fields).map(([key,field])=>{const n=number(output[field]);return [key,n===0||(/price|High|Low|Open|Week/.test(key)&&n<0)?null:n];}));
  return {...metrics,ROE:null,consensusTarget:null,unavailable:['ROE: no financial-statement adapter connected','consensusTarget: no analyst-consensus source connected'],periodBasis:'Broker supplied; valuation reporting period and quote exchange timestamp not supplied. Zero placeholder fields treated as unavailable.'};
}
function technicals(candles,interval,dataset,now=Date.now(),market='KR'){
  const duration=interval==='1m'?60000:86400000;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:market==='US'?'America/New_York':'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const seen=new Set();
  const rows=candles.filter(c=>{
    if(!['timestamp','open','high','low','close','volume'].every(k=>Number.isFinite(c[k]))||c.low<=0||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||c.volume<0||seen.has(c.timestamp))return false;
    seen.add(c.timestamp);return interval==='1m'?c.timestamp+duration<=now:(c.date??new Date(c.timestamp+9*3600000).toISOString().slice(0,10))<today;
  }).sort((a,b)=>a.timestamp-b.timestamp);
  const last=rows.at(-1);const base={interval,bars:rows.length,asOf:last?.timestamp??null,formingBarExcluded:true,adjustment:'Daily broker-adjusted prices; minute bars as supplied',stale:!last?true:interval==='1m'?now-last.timestamp>180000:null};
  if(dataset==='range_10m'){
    const end=Math.floor(now/60000)*60000,start=end-600000;const window=rows.filter(c=>c.timestamp>=start&&c.timestamp<end);
    const complete=window.length===10&&window.every((c,i)=>c.timestamp===start+i*60000);
    return {...base,start,end,coverage:complete?'complete':'partial',bars:window.length,high:window.length?Math.max(...window.map(c=>c.high)):null,low:window.length?Math.min(...window.map(c=>c.low)):null,note:'Extrema of available completed one-minute bars; partial coverage is not the full ten-minute range.'};
  }
  const sma=n=>rows.length<n?null:rows.slice(-n).reduce((sum,c)=>sum+c.close,0)/n;
  const kAt=end=>{if(end<14)return null;const w=rows.slice(end-14,end),high=Math.max(...w.map(c=>c.high)),low=Math.min(...w.map(c=>c.low));return high===low?null:100*(w.at(-1).close-low)/(high-low);};
  const ks=[0,1,2].map(offset=>kAt(rows.length-offset));
  return {...base,SMA5:sma(5),SMA10:sma(10),SMA20:sma(20),stochastic:{variant:'Fast stochastic: K=14 bars, D=SMA3(K)',K:ks[0],D:ks.every(v=>v!=null)?ks.reduce((a,b)=>a+b,0)/3:null},note:'Null means insufficient bars or zero range. Daily latest bar date must be checked for session/holiday gaps. Indicators are evidence, not buy/sell instructions.'};
}
// Best bid/ask levels from the KIS asking-price quotation (Korea: output1 askp/bidp, U.S.: output2 pask/pbid). Zero or
// missing prices are absent levels, never prices; with no bid or no ask the book is unavailable.
function orderBook(body,us=false,now=Date.now()){
  const book=us?body?.output2:body?.output1;if(!book||typeof book!=='object')return null;
  const level=i=>{const bid=number(book[us?'pbid'+i:'bidp'+i]),ask=number(book[us?'pask'+i:'askp'+i]);
    return {bid:bid>0?bid:null,bidSize:bid>0?number(book[us?'vbid'+i:'bidp_rsqn'+i]):null,ask:ask>0?ask:null,askSize:ask>0?number(book[us?'vask'+i:'askp_rsqn'+i]):null};};
  const levels=[1,2,3,4,5].map(level).filter(l=>l.bid!=null||l.ask!=null);const best=levels[0];
  if(!best||best.bid==null||best.ask==null||best.ask<best.bid)return null;
  const mid=(best.bid+best.ask)/2;const o1=body.output1??{};
  // Korean book time is HHMMSS in Seoul (today's, or yesterday's when that would be in the future); the U.S. book
  // carries the Seoul date and time of the quote (dymd/dhms). Unparseable times leave quoteAt null: age unknown.
  const hms=String(us?o1.dhms??'':book.aspr_acpt_hour??'');let ymd=us?String(o1.dymd??''):new Date(now+9*3600000).toISOString().slice(0,10).replaceAll('-','');
  const at=d=>Date.parse(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}T${hms.slice(0,2)}:${hms.slice(2,4)}:${hms.slice(4)}+09:00`);
  let quoteAt=/^\d{6}$/.test(hms)&&/^\d{8}$/.test(ymd)?at(ymd):NaN;
  if(!us&&quoteAt>now+60000){ymd=new Date(now+9*3600000-86400000).toISOString().slice(0,10).replaceAll('-','');quoteAt=at(ymd);}
  quoteAt=Number.isFinite(quoteAt)?quoteAt:null;
  const quoteTime=quoteAt?`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6)} ${hms.slice(0,2)}:${hms.slice(2,4)}:${hms.slice(4)} KST`:null;
  const total=k=>us?null:number(book[k]);
  return {bid:best.bid,ask:best.ask,bidSize:best.bidSize,askSize:best.askSize,spread:Math.round((best.ask-best.bid)*1e4)/1e4,spreadPct:Math.round((best.ask-best.bid)/mid*1e4)/100,mid:Math.round(mid*1e4)/1e4,levels,
    ...(us?{}:{totalBidSize:total('total_bidp_rsqn'),totalAskSize:total('total_askp_rsqn')}),quoteTime,quoteAt,ageSeconds:quoteAt?Math.max(0,Math.round((now-quoteAt)/1000)):null,
    note:'Resting limit orders at the time of the quote; sizes are shares. A buy fills near the ask and a sale near the bid, so the spread is a round-trip cost on top of commissions.'};
}
class MarketEvidence {
  constructor(fetchData){this.fetchData=fetchData;}
  async get(args,context){
    if(!validRequest(args,context.universe.map(r=>r.symbol)))return {status:'unavailable',reason:'INVALID_OR_OUT_OF_SCOPE_REQUEST'};
    try{const value=await this.fetchData(args,context);return {symbol:args.symbol,dataset:args.dataset,...value};}
    catch{return {symbol:args.symbol,dataset:args.dataset,status:'unavailable',reason:'DATA_SOURCE_UNAVAILABLE'};}
  }
}
module.exports={TOOL,DATASETS,validRequest,company,technicals,orderBook,MarketEvidence};
