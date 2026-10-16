// Company research from KIS, one section at a time: each section is a few read-only quotation calls, normalized
// for the agents and the Company page. Sections fail independently; missing values stay null, never zero.
const {normalizeOpinion,analystSummary,estimates,ratios}=require('./kis-research.cjs');
const num=value=>{if(value===null||value===undefined||String(value).trim()==='')return null;const n=Number(String(value).replaceAll(',',''));return Number.isFinite(n)?n:null;};
const positive=value=>{const n=num(value);return n!=null&&n>0?n:null;};
const round=(value,digits=1)=>value==null||!Number.isFinite(value)?null:Math.round(value*10**digits)/10**digits;
const isoDay=text=>{const t=String(text??'').replace(/[^0-9]/g,'');return /^\d{8}$/.test(t)?`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`:null;};
const compact=day=>day.replaceAll('-','');
const shift=(today,days)=>new Date(Date.parse(today+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
const D='/uapi/domestic-stock/v1/';

// Overview: price, valuation, size and 52-week range from the current quote.
function overview(output={}){
  const q=output??{};
  return {price:positive(q.stck_prpr),changePct:num(q.prdy_ctrt),per:positive(q.per),pbr:positive(q.pbr),eps:num(q.eps),bps:num(q.bps),
    marketCapKRW:positive(q.hts_avls)!=null?q.hts_avls*1e8:null,listedShares:positive(q.lstn_stcn),high52Week:positive(q.w52_hgpr),low52Week:positive(q.w52_lwpr),
    foreignOwnershipPct:num(q.hts_frgn_ehrt),volume:num(q.acml_vol),turnoverPct:num(q.vol_tnrt),marginRatePct:num(q.marg_rate),
    sectorName:String(q.bstp_kor_isnm??'').trim()||null,status:String(q.iscd_stat_cls_code??'').trim()||null};
}

// Dividends from the Korea Securities Depository schedule: one row per record date; amounts of 0 are not yet set.
function dividends(rows,symbol,price,today){
  const all=(Array.isArray(rows)?rows:[]).filter(r=>!r.sht_cd||String(r.sht_cd).trim()===symbol).map(r=>{const recordDate=isoDay(r.record_date);const amount=positive(r.per_sto_divi_amt);
    return {recordDate,kind:String(r.divi_kind??'').trim()||null,perShare:amount,payDate:isoDay(r.divi_pay_dt),stockDividendPct:positive(r.stk_divi_rate),pending:amount==null};}).filter(r=>r.recordDate);
  const seen=new Set();const payments=all.sort((a,b)=>b.recordDate.localeCompare(a.recordDate)).filter(r=>{const key=r.recordDate+r.kind;if(seen.has(key))return false;seen.add(key);return true;});
  const yearAgo=shift(today,365);const paid=payments.filter(p=>p.perShare!=null);
  const trailing=paid.filter(p=>p.recordDate>yearAgo&&p.recordDate<=today);const trailing12m=trailing.reduce((s,p)=>s+p.perShare,0);
  const byYear={};for(const p of paid){const y=p.recordDate.slice(0,4);byYear[y]=(byYear[y]??0)+p.perShare;}
  const years=Object.keys(byYear).sort().reverse().slice(0,5).map(year=>({year,perShare:round(byYear[year],0),payments:paid.filter(p=>p.recordDate.startsWith(year)).length}));
  // Frequency counts record dates, including ones whose amount is not set yet.
  const count=trailing.length,dates=payments.filter(p=>p.recordDate>yearAgo&&p.recordDate<=today&&(p.perShare!=null||p.pending)).length;
  return {payments:payments.slice(0,12),trailing12mPerShare:count?round(trailing12m,0):null,trailingYieldPct:count&&price?round(trailing12m/price*100,2):null,
    frequency:dates>=4?'quarterly':dates>=2?'semiannual':dates===1?'annual':paid.length?'irregular':'none',annualTotals:years,
    upcoming:payments.filter(p=>p.recordDate>=today||p.pending).slice(0,3),
    note:'Per-share cash dividends by record date (KSD schedule). Pending means the amount is not set yet. Calendar-year totals mix fiscal periods.'};
}

// Shareholder meetings: one row per agenda item; grouped by meeting date.
function meetings(rows){
  const groups=new Map();
  for(const r of Array.isArray(rows)?rows:[]){const date=isoDay(r.gen_meet_dt);if(!date)continue;const g=groups.get(date)??{date,type:String(r.gen_meet_type??'').trim()||null,recordDate:isoDay(r.record_date),agenda:[]};const a=String(r.agenda??'').trim();if(a&&!g.agenda.includes(a)&&g.agenda.length<8)g.agenda.push(a);groups.set(date,g);}
  return [...groups.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,4);
}

// One section of research for one Korean listing. `client` is the read-only KIS client.
async function fetchSection(client,symbol,section,today){
  if(!/^\d{6}$/.test(symbol))throw new Error('INVALID_INSTRUMENT');
  const q=(endpoint,tr,params)=>client.quotation(endpoint,tr,params);
  const quote=async()=>(await q('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol})).output;
  if(section==='overview')return overview(await quote());
  if(section==='analysts'){
    const price=positive((await quote())?.stck_prpr);
    const body=await q('invest-opinion','FHKST663300C0',{FID_COND_MRKT_DIV_CODE:'J',FID_COND_SCR_DIV_CODE:'16633',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(shift(today,180)),FID_INPUT_DATE_2:compact(today)});
    return {price,...analystSummary(body.output,price,today),...(revisions(body.output,today)??{})};
  }
  if(section==='estimates')return estimates(await q('estimate-perform','HHKST668300C0',{SHT_CD:symbol}));
  if(section==='financials')return financials(client,symbol);
  if(section==='dividends'){
    const price=positive((await quote())?.stck_prpr);
    const body=await q(D+'ksdinfo/dividend','HHKDB669102C0',{CTS:'',GB1:'0',F_DT:compact(shift(today,1500)),T_DT:compact(shift(today,-180)),SHT_CD:symbol,HIGH_GB:''});
    return dividends(body.output1,symbol,price,today);
  }
  if(section==='meetings'){const body=await q(D+'ksdinfo/sharehld-meet','HHKDB669111C0',{CTS:'',F_DT:compact(shift(today,500)),T_DT:compact(shift(today,-180)),SHT_CD:symbol});return {meetings:meetings(body.output1)};}
  throw new Error('UNKNOWN_SECTION');
}
// Analyst target revisions: for firms with two or more notes in the window, did the latest note raise or cut the target?
function revisions(rows,today,days=90){
  const cutoff=shift(today,days);const byFirm=new Map();
  for(const r of Array.isArray(rows)?rows:[]){const date=isoDay(r.stck_bsop_date),firm=String(r.mbcr_name??'').trim(),target=positive(r.hts_goal_prc);if(!date||!firm||target==null)continue;(byFirm.get(firm)??byFirm.set(firm,[]).get(firm)).push({date,target,opinion:normalizeOpinion(r.invt_opnn)});}
  let raised=0,cut=0,unchanged=0;const changes=[];
  for(const [firm,notes] of byFirm){notes.sort((a,b)=>b.date.localeCompare(a.date));const [latest,previous]=notes;if(!previous||latest.date<cutoff)continue;const pct=(latest.target/previous.target-1)*100;
    if(Math.abs(pct)<0.5)unchanged++;else if(pct>0)raised++;else cut++;changes.push({firm,date:latest.date,from:previous.target,to:latest.target,changePct:round(pct)});}
  if(!changes.length)return null;
  return {targetRevisions:{windowDays:days,raised,cut,unchanged,recent:changes.sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6)}};
}
async function financials(client,symbol){
  const body=await client.quotation(D+'finance/financial-ratio','FHKST66430300',{FID_DIV_CLS_CODE:'0',fid_cond_mrkt_div_code:'J',fid_input_iscd:symbol});
  return {annualRatios:ratios(body.output)};
}
module.exports={overview,dividends,meetings,revisions,fetchSection,num,round,isoDay,shift};
