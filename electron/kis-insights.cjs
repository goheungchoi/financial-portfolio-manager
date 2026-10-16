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

// Investor flows: net buying by foreigners, institutions and individuals (amounts reported in million KRW).
const sum=(rows,key,n,scale=1)=>{const part=rows.slice(0,n).map(r=>num(r[key])).filter(v=>v!=null);return part.length?part.reduce((a,b)=>a+b,0)*scale:null;};
function investorFlows(rows){
  const days=(Array.isArray(rows)?rows:[]).filter(r=>isoDay(r.stck_bsop_date)&&num(r.frgn_ntby_tr_pbmn)!=null).sort((a,b)=>String(b.stck_bsop_date).localeCompare(String(a.stck_bsop_date)));
  if(!days.length)return null;
  const streak=key=>{const sign=Math.sign(num(days[0][key])??0);if(!sign)return 0;let n=0;for(const r of days){if(Math.sign(num(r[key])??0)!==sign)break;n++;}return sign*n;};
  const net=n=>({foreignKRW:sum(days,'frgn_ntby_tr_pbmn',n,1e6),institutionKRW:sum(days,'orgn_ntby_tr_pbmn',n,1e6),individualKRW:sum(days,'prsn_ntby_tr_pbmn',n,1e6)});
  return {asOf:isoDay(days[0].stck_bsop_date),net5d:net(5),net20d:net(20),foreignStreakDays:streak('frgn_ntby_tr_pbmn'),institutionStreakDays:streak('orgn_ntby_tr_pbmn'),
    daily:days.slice(0,10).map(r=>({date:isoDay(r.stck_bsop_date),close:num(r.stck_clpr),foreignKRW:num(r.frgn_ntby_tr_pbmn)*1e6,institutionKRW:num(r.orgn_ntby_tr_pbmn)*1e6,individualKRW:num(r.prsn_ntby_tr_pbmn)*1e6}))};
}
// Short selling: share of daily volume sold short.
function shortSelling(rows){
  const days=(Array.isArray(rows)?rows:[]).filter(r=>isoDay(r.stck_bsop_date)&&num(r.ssts_vol_rlim)!=null).sort((a,b)=>String(b.stck_bsop_date).localeCompare(String(a.stck_bsop_date)));if(!days.length)return null;
  const avg=n=>{const v=days.slice(0,n).map(r=>num(r.ssts_vol_rlim));return round(v.reduce((a,b)=>a+b,0)/v.length,2);};
  return {asOf:isoDay(days[0].stck_bsop_date),latestSharePct:num(days[0].ssts_vol_rlim),avg5dSharePct:avg(5),avg20dSharePct:avg(20),latestValueKRW:num(days[0].ssts_tr_pbmn)};
}
// Margin (credit) loans outstanding as a share of listed shares.
function creditBalance(rows){
  const days=(Array.isArray(rows)?rows:[]).filter(r=>isoDay(r.deal_date)&&num(r.whol_loan_rmnd_rate)!=null).sort((a,b)=>String(b.deal_date).localeCompare(String(a.deal_date)));if(!days.length)return null;
  const then=days[Math.min(days.length-1,19)];const now=num(days[0].whol_loan_rmnd_stcn),before=num(then.whol_loan_rmnd_stcn);
  return {asOf:isoDay(days[0].deal_date),balanceRatePct:num(days[0].whol_loan_rmnd_rate),balanceShares:now,changeSharesPct:now!=null&&before?round((now/before-1)*100):null,changeSince:isoDay(then.deal_date)};
}
// Program trading (index arbitrage and baskets): net buying in KRW.
function programTrading(rows){
  const days=(Array.isArray(rows)?rows:[]).filter(r=>isoDay(r.stck_bsop_date)&&num(r.whol_smtn_ntby_tr_pbmn)!=null).sort((a,b)=>String(b.stck_bsop_date).localeCompare(String(a.stck_bsop_date)));if(!days.length)return null;
  return {asOf:isoDay(days[0].stck_bsop_date),net1dKRW:num(days[0].whol_smtn_ntby_tr_pbmn),net5dKRW:sum(days,'whol_smtn_ntby_tr_pbmn',5),net20dKRW:sum(days,'whol_smtn_ntby_tr_pbmn',20)};
}
// Daily closes, oldest first.
function closes(rows,key='stck_clpr',value='acml_tr_pbmn'){
  const seen=new Set();return (Array.isArray(rows)?rows:[]).map(r=>({date:isoDay(r.stck_bsop_date),close:positive(r[key]),value:num(r[value])})).filter(r=>r.date&&r.close&&!seen.has(r.date)&&seen.add(r.date)).sort((a,b)=>a.date.localeCompare(b.date));
}
const logReturns=series=>series.slice(1).map((r,i)=>({date:r.date,ret:Math.log(r.close/series[i].close)}));
const stdev=v=>{if(v.length<2)return null;const m=v.reduce((a,b)=>a+b,0)/v.length;return Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));};
const change=(series,days)=>series.length>days?round((series.at(-1).close/series.at(-1-days).close-1)*100):null;
// Risk and relative strength from daily closes against the market and sector indices.
function riskMetrics(stock,market=[],sector=[]){
  if(stock.length<21)return null;const r=logReturns(stock);const vol=stdev(r.map(x=>x.ret));
  const beta=index=>{const map=new Map(logReturns(index).map(x=>[x.date,x.ret]));const pairs=r.filter(x=>map.has(x.date)).map(x=>[x.ret,map.get(x.date)]);if(pairs.length<20)return null;
    const ma=pairs.reduce((a,p)=>a+p[1],0)/pairs.length,ms=pairs.reduce((a,p)=>a+p[0],0)/pairs.length;let cov=0,varM=0,varS=0;for(const [s,m] of pairs){cov+=(s-ms)*(m-ma);varM+=(m-ma)**2;varS+=(s-ms)**2;}
    return {beta:round(cov/varM,2),correlation:round(cov/Math.sqrt(varM*varS),2),days:pairs.length};};
  let peak=0,maxDd=0;for(const p of stock){peak=Math.max(peak,p.close);maxDd=Math.min(maxDd,p.close/peak-1);}
  const high=Math.max(...stock.map(p=>p.close)),last=stock.at(-1);const sma=n=>stock.length>=n?stock.slice(-n).reduce((a,p)=>a+p.close,0)/n:null;
  const rel=(index,days)=>{const a=change(stock,days),b=change(index,days);return a!=null&&b!=null?round(a-b):null;};
  const traded=stock.slice(-20).map(p=>p.value).filter(v=>v!=null);
  return {asOf:last.date,days:stock.length,annualizedVolatilityPct:vol!=null?round(vol*Math.sqrt(252)*100):null,market:beta(market),
    return1mPct:change(stock,21),return3mPct:change(stock,63),vsMarket1mPct:rel(market,21),vsMarket3mPct:market.length>63?rel(market,63):null,vsSector1mPct:rel(sector,21),
    maxDrawdownPct:round(maxDd*100),fromHighPct:round((last.close/high-1)*100),priceVsSma20Pct:sma(20)?round((last.close/sma(20)-1)*100):null,priceVsSma60Pct:sma(60)?round((last.close/sma(60)-1)*100):null,
    avgDailyValue20dKRW:traded.length?Math.round(traded.reduce((a,b)=>a+b,0)/traded.length):null,
    note:`Computed from ${stock.length} daily closes; drawdown and high cover that window only. Beta and correlation use overlapping days with the market index.`};
}
// Financial statements: KIS reports amounts in 100 million KRW and uses 99.99 for "not available".
const stmt=value=>{const n=num(value);return n==null||n===99.99?null:n;};
const periodLabel=yymm=>/^\d{6}$/.test(yymm)?(yymm.endsWith('12')?`FY${yymm.slice(0,4)}`:`${yymm.slice(0,4)} to ${['Mar','Jun','Sep'][Number(yymm.slice(4))/3-1]??yymm.slice(4)}`):null;
function statements(parts){
  const periods=new Map();const put=(rows,map)=>{for(const r of (Array.isArray(rows)?rows:[]).slice(0,6)){const key=String(r.stac_yymm??'');if(!periodLabel(key))continue;const row=periods.get(key)??{period:periodLabel(key),yearEnd:key.endsWith('12')};for(const [field,[name,scale]] of Object.entries(map)){const v=stmt(r[field]);if(v!=null)row[name]=round(v*scale,scale===1?2:0);}periods.set(key,row);}};
  put(parts.income,{sale_account:['revenueKRW',1e8],sale_totl_prfi:['grossProfitKRW',1e8],bsop_prti:['operatingProfitKRW',1e8],thtr_ntin:['netIncomeKRW',1e8]});
  put(parts.balance,{total_aset:['totalAssetsKRW',1e8],total_lblt:['totalLiabilitiesKRW',1e8],total_cptl:['equityKRW',1e8],cras:['currentAssetsKRW',1e8],flow_lblt:['currentLiabilitiesKRW',1e8]});
  put(parts.ratio,{grs:['revenueGrowthPct',1],bsop_prfi_inrt:['operatingProfitGrowthPct',1],ntin_inrt:['netIncomeGrowthPct',1],roe_val:['roePct',1],eps:['eps',1],sps:['sps',1],bps:['bps',1],lblt_rate:['debtRatioPct',1]});
  put(parts.profit,{cptl_ntin_rate:['roaPct',1],sale_ntin_rate:['netMarginPct',1],sale_totl_rate:['grossMarginPct',1]});
  put(parts.stability,{crnt_rate:['currentRatioPct',1],quck_rate:['quickRatioPct',1]});
  put(parts.growth,{equt_inrt:['equityGrowthPct',1],totl_aset_inrt:['assetGrowthPct',1]});
  put(parts.other,{ebitda:['ebitdaKRW',1e8],ev_ebitda:['evToEbitda',1],payout_rate:['payoutRatioPct',1]});
  const rows=[...periods.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([,v])=>v);
  // Operating margin is derived; a zero payout ratio is KIS's placeholder when DART says otherwise, so it is left out at zero.
  for(const r of rows){if(r.revenueKRW&&r.operatingProfitKRW!=null)r.operatingMarginPct=round(r.operatingProfitKRW/r.revenueKRW*100);if(r.payoutRatioPct===0)delete r.payoutRatioPct;if(r.quickRatioPct===0)delete r.quickRatioPct;}
  return rows;
}
// Valuation history: year-end PER and PBR from December monthly closes and that year's EPS and BPS.
function valuationHistory(monthly,ratioRows){
  const closes=new Map((Array.isArray(monthly)?monthly:[]).map(r=>[String(r.stck_bsop_date??'').slice(0,6),positive(r.stck_clpr)]).filter(([k,v])=>/^\d{6}$/.test(k)&&v));
  const years=(Array.isArray(ratioRows)?ratioRows:[]).filter(r=>/^\d{4}12$/.test(String(r.stac_yymm))).slice(0,6).map(r=>{const y=String(r.stac_yymm).slice(0,4);const close=closes.get(y+'12');const eps=num(r.eps),bps=num(r.bps);
    return {year:y,close:close??null,eps,bps,per:close&&eps>0?round(close/eps,1):null,pbr:close&&bps>0?round(close/bps,2):null};}).filter(y=>y.close);
  const range=key=>{const v=years.map(y=>y[key]).filter(x=>x!=null).sort((a,b)=>a-b);return v.length?{min:v[0],median:v[Math.floor((v.length-1)/2)],max:v.at(-1),years:v.length}:null;};
  const series=[...closes.entries()].sort((a,b)=>a[0].localeCompare(b[0]));const ret=months=>series.length>months?round((series.at(-1)[1]/series.at(-1-months)[1]-1)*100):null;
  return {years,perRange:range('per'),pbrRange:range('pbr'),return1yPct:ret(12),return3yPct:ret(36),return5yPct:ret(60),monthly:series.slice(-60).map(([m,close])=>({month:`${m.slice(0,4)}-${m.slice(4)}`,close}))};
}
// One section of research for one Korean listing. `client` is the read-only KIS client.
async function fetchSection(client,symbol,section,today){
  const q=(endpoint,tr,params)=>client.quotation(endpoint,tr,params);
  // Index history in two windows (KIS returns at most 50 days per call), keyed by a 4-digit index code.
  if(section==='index-daily'){if(!/^\d{4}$/.test(symbol))throw new Error('INVALID_INSTRUMENT');const rows=[];
    for(const [from,to] of [[150,72],[72,0]]){const body=await q('inquire-daily-indexchartprice','FHKUP03500100',{FID_COND_MRKT_DIV_CODE:'U',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(shift(today,from)),FID_INPUT_DATE_2:compact(shift(today,to)),FID_PERIOD_DIV_CODE:'D'});rows.push(...(body.output2??[]));}
    return {closes:closes(rows,'bstp_nmix_prpr').map(({date,close})=>({date,close}))};}
  if(!/^\d{6}$/.test(symbol))throw new Error('INVALID_INSTRUMENT');
  if(section==='daily'){const body=await q('inquire-daily-itemchartprice','FHKST03010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(shift(today,160)),FID_INPUT_DATE_2:compact(today),FID_PERIOD_DIV_CODE:'D',FID_ORG_ADJ_PRC:'0'});return {closes:closes(body.output2)};}
  if(section==='flows'){
    const attempt=async task=>{try{return await task();}catch{return null;}};
    const investor=await attempt(async()=>investorFlows((await q('inquire-investor','FHKST01010900',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol})).output));
    const short=await attempt(async()=>shortSelling((await q('daily-short-sale','FHPST04830000',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(shift(today,45)),FID_INPUT_DATE_2:compact(today)})).output2));
    const credit=await attempt(async()=>creditBalance((await q('daily-credit-balance','FHPST04760000',{fid_cond_mrkt_div_code:'J',fid_cond_scr_div_code:'20476',fid_input_iscd:symbol,fid_input_date_1:compact(today)})).output));
    const program=await attempt(async()=>programTrading((await q('program-trade-by-stock-daily','FHPPG04650201',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(today)})).output));
    if(!investor&&!short&&!credit&&!program)throw new Error('DATA_SOURCE_UNAVAILABLE');
    return {investors:investor,shortSelling:short,margin:credit,program};
  }
  const quote=async()=>(await q('inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol})).output;
  if(section==='overview')return overview(await quote());
  if(section==='analysts'){
    const price=positive((await quote())?.stck_prpr);
    const body=await q('invest-opinion','FHKST663300C0',{FID_COND_MRKT_DIV_CODE:'J',FID_COND_SCR_DIV_CODE:'16633',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(shift(today,180)),FID_INPUT_DATE_2:compact(today)});
    return {price,...analystSummary(body.output,price,today),...(revisions(body.output,today)??{})};
  }
  if(section==='estimates')return estimates(await q('estimate-perform','HHKST668300C0',{SHT_CD:symbol}));
  if(section==='financials')return financials(client,symbol);
  if(section==='valuation'){
    const monthly=await q('inquire-daily-itemchartprice','FHKST03010100',{FID_COND_MRKT_DIV_CODE:'J',FID_INPUT_ISCD:symbol,FID_INPUT_DATE_1:compact(shift(today,2200)),FID_INPUT_DATE_2:compact(today),FID_PERIOD_DIV_CODE:'M',FID_ORG_ADJ_PRC:'0'});
    const ratio=await q(D+'finance/financial-ratio','FHKST66430300',{FID_DIV_CLS_CODE:'0',fid_cond_mrkt_div_code:'J',fid_input_iscd:symbol});
    return valuationHistory(monthly.output2,ratio.output);
  }
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
  const read=async(path,tr)=>{try{return (await client.quotation(D+'finance/'+path,tr,{FID_DIV_CLS_CODE:'0',fid_cond_mrkt_div_code:'J',fid_input_iscd:symbol})).output;}catch{return null;}};
  const parts={ratio:await read('financial-ratio','FHKST66430300'),income:await read('income-statement','FHKST66430200'),balance:await read('balance-sheet','FHKST66430100'),profit:await read('profit-ratio','FHKST66430400'),stability:await read('stability-ratio','FHKST66430600'),growth:await read('growth-ratio','FHKST66430800'),other:await read('other-major-ratios','FHKST66430500')};
  if(Object.values(parts).every(v=>!v))throw new Error('DATA_SOURCE_UNAVAILABLE');
  return {periods:statements(parts),annualRatios:ratios(parts.ratio),units:'KRW amounts; ratios in %. Periods not ending in December are year to date.'};
}
module.exports={overview,dividends,meetings,revisions,investorFlows,shortSelling,creditBalance,programTrading,closes,riskMetrics,statements,valuationHistory,fetchSection,num,round,isoDay,shift};
