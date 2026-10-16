const {exchangeTimestamp}=require('./kis-stream.cjs');
function seoulDate(now=Date.now()) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const value=type=>parts.find(part=>part.type===type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function validateRange(start,end,now=Date.now()) {
  const parse=value=>{
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('INVALID_DATE_RANGE');
    const timestamp=Date.parse(value+'T00:00:00+09:00');
    if(!Number.isFinite(timestamp) || seoulDate(timestamp)!==value)throw new Error('INVALID_DATE_RANGE');
    return timestamp;
  };
  const a=parse(start),b=parse(end),today=parse(seoulDate(now));
  if(a>b || b>today || a<today-60*86400000)throw new Error('INVALID_DATE_RANGE');
  return {start:start.replaceAll('-',''),end:end.replaceAll('-','')};
}
function number(value) {
  if(!['string','number'].includes(typeof value) || !/^-?\d+(\.\d+)?$/.test(String(value)))throw new Error('INVALID_RESPONSE');
  const result=Number(value);if(!Number.isFinite(result) || Math.abs(result)>Number.MAX_SAFE_INTEGER)throw new Error('INVALID_RESPONSE');return result;
}
function optionalNumber(value){return value===undefined || value===null || value===''?null:number(value);}
function normalizeOrders(rows,start,end) {
  const records=new Map();
  for(const row of rows) {
    if(!/^[A-Z0-9]{6}$/.test(row.pdno) || typeof row.prdt_name!=='string' || typeof row.odno!=='string' || !/^\d{1,20}$/.test(row.odno) || !['01','02'].includes(row.sll_buy_dvsn_cd) || !['Y','N'].includes(row.cncl_yn))throw new Error('INVALID_RESPONSE');
    let timestamp;try{timestamp=exchangeTimestamp(row.ord_dt,row.ord_tmd);}catch{throw new Error('INVALID_RESPONSE');}
    if(row.ord_dt<start || row.ord_dt>end)throw new Error('INVALID_RESPONSE');
    const quantity=number(row.ord_qty),filled=number(row.tot_ccld_qty),remaining=number(row.rmn_qty),rejected=number(row.rjct_qty),executionAmount=number(row.tot_ccld_amt),averagePrice=number(row.avg_prvs),orderPrice=number(row.ord_unpr);
    if([quantity,filled,remaining,rejected].some(n=>!Number.isSafeInteger(n)||n<0) || filled>quantity || remaining>quantity || rejected>quantity || [executionAmount,averagePrice,orderPrice].some(n=>n<0) || filled===0 && executionAmount!==0)throw new Error('INVALID_RESPONSE');
    const originalOrderId=row.orgn_odno===undefined || /^0*$/.test(row.orgn_odno)?null:row.orgn_odno;
    if(originalOrderId!==null && !/^\d{1,20}$/.test(originalOrderId))throw new Error('INVALID_RESPONSE');
    const status=row.cncl_yn==='Y'?(filled?'Partially filled / canceled':'Canceled'):rejected?(filled?'Partially filled / rejected':'Rejected'):filled===quantity && quantity>0?'Filled':filled?'Partially filled':remaining?'Pending':'Unfilled';
    const branch=row.ord_gno_brno??'';
    if(typeof branch!=='string' || !/^[A-Z0-9]{0,10}$/.test(branch))throw new Error('INVALID_RESPONSE');
    const record={id:`${row.ord_dt}:${branch}:${row.odno}`,orderId:row.odno,originalOrderId,symbol:row.pdno,name:row.prdt_name.slice(0,120),timestamp,side:row.sll_buy_dvsn_cd==='01'?'Sell':'Buy',quantity,filled,remaining,rejected,executionAmount,averagePrice,orderPrice,status};
    const previous=records.get(record.id);
    if(previous && JSON.stringify(previous)!==JSON.stringify(record))throw new Error('INCOMPLETE_HISTORY');
    records.set(record.id,record);
  }
  return [...records.values()].sort((a,b)=>b.timestamp-a.timestamp || b.orderId.localeCompare(a.orderId));
}
function normalizeProfit(rows,summary,start,end) {
  if(!summary)throw new Error('INVALID_RESPONSE');
  const records=rows.map(row=>{
    let timestamp;try{timestamp=exchangeTimestamp(row.trad_dt,'000000');}catch{throw new Error('INVALID_RESPONSE');}
    if(row.trad_dt<start || row.trad_dt>end || !/^[A-Z0-9]{6}$/.test(row.pdno) || typeof row.prdt_name!=='string')throw new Error('INVALID_RESPONSE');
    return {timestamp,symbol:row.pdno,name:row.prdt_name.slice(0,120),realized:number(row.rlzt_pfls),fee:optionalNumber(row.fee),tax:optionalNumber(row.tl_tax)};
  });
  return {records,summary:{realized:number(summary.tot_rlzt_pfls),fee:optionalNumber(summary.tot_fee),tax:optionalNumber(summary.tot_tltx),returnPct:optionalNumber(summary.tot_pftrt)}};
}
module.exports={seoulDate,validateRange,normalizeOrders,normalizeProfit};
