// Daily index closes from KIS: KOSPI, KOSDAQ and KOSPI 200, and the S&P 500, Nasdaq, Nasdaq 100, Dow, Philadelphia semiconductor index and VIX. Read-only; runs in the broker worker.
const DOMESTIC={KOSPI:'0001',KOSDAQ:'1001',KOSPI200:'2001'},OVERSEAS={SPX:'SPX',COMP:'COMP',NDX:'NDX',DJI:'.DJI',SOX:'SOX',VIX:'VIX'};
const compact=day=>day.replaceAll('-',''),dashed=day=>day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8);
const before=day=>new Date(Date.parse(dashed(day)+'T00:00:00Z')-86400000).toISOString().slice(0,10).replaceAll('-','');
async function page(client,index,start,end){
  if(DOMESTIC[index]){const body=await client.quotation('inquire-daily-indexchartprice','FHKUP03500100',{FID_COND_MRKT_DIV_CODE:'U',FID_INPUT_ISCD:DOMESTIC[index],FID_INPUT_DATE_1:start,FID_INPUT_DATE_2:end,FID_PERIOD_DIV_CODE:'D'});return (body.output2??[]).map(r=>({day:r.stck_bsop_date,close:Number(r.bstp_nmix_prpr)}));}
  const {body}=await client.overseasRequest('/uapi/overseas-price/v1/quotations/inquire-daily-chartprice','FHKST03030100',{FID_COND_MRKT_DIV_CODE:'N',FID_INPUT_ISCD:OVERSEAS[index],FID_INPUT_DATE_1:start,FID_INPUT_DATE_2:end,FID_PERIOD_DIV_CODE:'D'});
  return (body.output2??[]).map(r=>({day:r.stck_bsop_date,close:Number(r.ovrs_nmix_prpr)}));
}
// KIS returns a limited number of rows per request, newest first; page backwards until the start date.
async function indexHistory(client,request){
  if(!request||!(DOMESTIC[request.index]||OVERSEAS[request.index])||!/^\d{4}-\d{2}-\d{2}$/.test(request.start)||!/^\d{4}-\d{2}-\d{2}$/.test(request.end)||request.start>request.end)throw new Error('INVALID_REQUEST');
  const start=compact(request.start),rows=new Map();let end=compact(request.end);
  for(let i=0;i<8;i++){
    const batch=(await page(client,request.index,start,end)).filter(r=>/^\d{8}$/.test(r.day)&&Number.isFinite(r.close)&&r.close>0&&r.day>=start&&r.day<=end);
    for(const r of batch)rows.set(r.day,r.close);if(!batch.length)break;
    const earliest=batch.map(r=>r.day).sort()[0];if(earliest<=start)break;end=before(earliest);
  }
  return [...rows].map(([day,close])=>({day:dashed(day),close})).sort((a,b)=>a.day.localeCompare(b.day));
}
module.exports={indexHistory,DOMESTIC,OVERSEAS};
