// Normalizers for KIS analyst opinions, consensus estimates and annual financial ratios (used by kis-insights.cjs).
const num=value=>{if(value===null||value===undefined||String(value).trim()==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;};
const median=values=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const round=(value,digits=1)=>value==null?null:Math.round(value*10**digits)/10**digits;
// Brokers write ratings in English or Korean with varying case; map them to Buy, Hold or Sell.
function normalizeOpinion(text){
  const t=String(text??'').trim().toLowerCase().replace(/\s+/g,' ');if(!t)return null;
  if(/sell|매도|underperform|reduce|비중축소/.test(t))return 'Sell';
  if(/hold|neutral|중립|보유|market ?perform|marketperform/.test(t))return 'Hold';
  if(/buy|매수|outperform|overweight|비중확대|accumulate|add/.test(t))return 'Buy';
  return null;
}
const isoDay=yyyymmdd=>/^\d{8}$/.test(String(yyyymmdd))?`${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`:null;
// Latest opinion per brokerage within the window; consensus statistics over those.
function analystSummary(rows,price,today,days=180){
  const cutoff=new Date(Date.parse(today+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
  const valid=(Array.isArray(rows)?rows:[]).map(r=>({date:isoDay(r.stck_bsop_date),firm:String(r.mbcr_name??'').trim().slice(0,40),opinion:normalizeOpinion(r.invt_opnn),raw:String(r.invt_opnn??'').trim().slice(0,30),target:num(r.hts_goal_prc)})).filter(r=>r.date&&r.firm&&r.date>=cutoff).sort((a,b)=>b.date.localeCompare(a.date));
  const latest=new Map();for(const r of valid)if(!latest.has(r.firm))latest.set(r.firm,r);
  const firms=[...latest.values()];const targets=firms.map(r=>r.target).filter(t=>t!=null&&t>0);const med=median(targets);
  return {windowDays:days,brokerages:firms.length,buy:firms.filter(r=>r.opinion==='Buy').length,hold:firms.filter(r=>r.opinion==='Hold').length,sell:firms.filter(r=>r.opinion==='Sell').length,
    medianTarget:med,highTarget:targets.length?Math.max(...targets):null,lowTarget:targets.length?Math.min(...targets):null,upsideToMedianPct:med&&price?round((med/price-1)*100):null,
    latest:firms.slice(0,6).map(({date,firm,opinion,raw,target})=>({date,firm,opinion:opinion??raw,target}))};
}
// estimate-perform rows are unlabeled; their order was matched against reported statements (amounts in 100 million KRW, rates and multiples scaled by 10, EPS by 10).
const O2=[['revenue',1],['revenueGrowthPct',.1],['operatingProfit',1],['operatingProfitGrowthPct',.1],['netIncome',1],['netIncomeGrowthPct',.1]];
const O3=[['ebitda',1],['eps',.1],['epsGrowthPct',.1],['per',.1],['evToEbitda',.1],['roePct',.1],['debtRatioPct',.1],['interestCoverage',.1]];
function estimates(body){
  const years=(Array.isArray(body?.output4)?body.output4:[]).map(r=>String(r.dt??''));if(!years.length)return null;
  const read=(rows,map)=>Object.fromEntries(map.flatMap(([key,scale],i)=>{const row=Array.isArray(rows)?rows[i]:null;if(!row)return [];return [[key,years.map((_,j)=>{const v=num(row['data'+(j+1)]);return v==null?null:round(v*scale,2);})]];}));
  const header=Array.isArray(body.output1)?body.output1[0]:body.output1;
  return {years:years.map(y=>y.replace('.','-')),forecastYears:years.filter(y=>/E$/.test(y)).map(y=>y.replace('.','-')),units:'revenue, operatingProfit, netIncome and ebitda in 100 million KRW; growth and ratios in %',
    ...read(body.output2,O2),...read(body.output3,O3),...(header?.rcmd_name?{reportOpinion:String(header.rcmd_name).slice(0,20),reportDate:isoDay(header.estdate)}:{})};
}
function ratios(rows){
  return (Array.isArray(rows)?rows:[]).slice(0,4).map(r=>({period:/^\d{6}$/.test(r.stac_yymm)?`${r.stac_yymm.slice(0,4)}-${r.stac_yymm.slice(4)}`:null,revenueGrowthPct:round(num(r.grs),1),operatingProfitGrowthPct:round(num(r.bsop_prfi_inrt),1),roePct:round(num(r.roe_val),1),eps:num(r.eps),bps:num(r.bps),debtRatioPct:round(num(r.lblt_rate),1)})).filter(r=>r.period);
}
module.exports={normalizeOpinion,analystSummary,estimates,ratios};
