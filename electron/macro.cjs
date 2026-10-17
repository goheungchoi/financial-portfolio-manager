// Macro inputs from official free sources: Bank of Korea ECOS and St. Louis Fed FRED.
// Fetching runs in the provider worker (which holds optional keys); storage and summaries run in the main process.
const ECOS_SAMPLE='sample';// ECOS public sample access: at most 10 rows per request.
const SERIES=[
  {id:'KR_BASE_RATE',market:'KR',source:'ECOS',name:'BoK base rate',unit:'%',stat:'722Y001',cycle:'M',item:'0101000'},
  {id:'KR_USDKRW',market:'KR',source:'ECOS',name:'USD/KRW',unit:'KRW',stat:'731Y001',cycle:'D',item:'0000001'},
  {id:'KR_KTB3Y',market:'KR',source:'ECOS',name:'KTB 3-year yield',unit:'%',stat:'817Y002',cycle:'D',item:'010200000'},
  {id:'KR_KTB10Y',market:'KR',source:'ECOS',name:'KTB 10-year yield',unit:'%',stat:'817Y002',cycle:'D',item:'010210000'},
  {id:'KR_CPI',market:'KR',source:'ECOS',name:'Korea CPI inflation',unit:'% y/y',stat:'901Y009',cycle:'M',item:'0',yoy:true},
  {id:'US_FEDFUNDS',market:'US',source:'FRED',name:'Effective fed funds rate',unit:'%',series:'DFF'},
  {id:'US_2Y',market:'US',source:'FRED',name:'U.S. 2-year Treasury',unit:'%',series:'DGS2'},
  {id:'US_10Y',market:'US',source:'FRED',name:'U.S. 10-year Treasury',unit:'%',series:'DGS10'},
  {id:'US_CPI',market:'US',source:'FRED',name:'U.S. CPI inflation',unit:'% y/y',series:'CPIAUCSL',yoy:true,monthly:true},
  {id:'US_UNRATE',market:'US',source:'FRED',name:'U.S. unemployment rate',unit:'%',series:'UNRATE',monthly:true},
  {id:'US_VIX',market:'US',source:'FRED',name:'VIX volatility index',unit:'',series:'VIXCLS'},
  {id:'US_WTI',market:'US',source:'FRED',name:'WTI crude oil',unit:'USD/bbl',series:'DCOILWTICO'},
  {id:'US_BRENT',market:'US',source:'FRED',name:'Brent crude oil',unit:'USD/bbl',series:'DCOILBRENTEU'},
  {id:'US_DOLLAR',market:'US',source:'FRED',name:'Broad dollar index',unit:'',series:'DTWEXBGS'},
  {id:'US_HY_SPREAD',market:'US',source:'FRED',name:'High-yield credit spread',unit:'%',series:'BAMLH0A0HYM2'}
];
// FRED release names kept in the calendar (matched case-insensitively against release_name).
const RELEASES=[['Consumer Price Index','U.S. CPI'],['Employment Situation','U.S. jobs report'],['Gross Domestic Product','U.S. GDP'],['FOMC Press Release','FOMC decision'],['Producer Price Index','U.S. PPI'],['Personal Income and Outlays','U.S. PCE inflation'],['Advance Monthly Sales for Retail','U.S. retail sales'],['Job Openings and Labor Turnover','U.S. job openings (JOLTS)']];
const iso=date=>date.toISOString().slice(0,10);
const shiftDays=(date,days)=>new Date(date.getTime()+days*86400000);
const isDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v);
// FRED CSV: header "observation_date,SERIES"; missing values are blank or ".".
function parseFredCsv(text){
  const lines=String(text).trim().split(/\r?\n/);if(lines.length<1||!/^observation_date,|^DATE,/i.test(lines[0]))throw new Error('INVALID_RESPONSE');
  return lines.slice(1).map(line=>{const [date,raw]=line.split(',');const value=raw==null||raw.trim()===''||raw.trim()==='.'?null:Number(raw);return {date,value};}).filter(row=>isDay(row.date)&&Number.isFinite(row.value));
}
// ECOS TIME is YYYYMMDD (daily), YYYYMM (monthly) or YYYY (annual); dates become the period start.
function ecosDate(time){const t=String(time);const date=t.length===8?`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`:t.length===6?`${t.slice(0,4)}-${t.slice(4,6)}-01`:null;return date&&isDay(date)&&new Date(date+'T00:00:00Z').toISOString().startsWith(date)?date:null;}
function parseEcos(body){
  if(body?.RESULT){if(body.RESULT.CODE==='INFO-200')return {total:0,rows:[]};throw new Error('ECOS_'+String(body.RESULT.CODE??'ERROR').replace(/[^A-Z0-9-]/gi,''));}
  const search=body?.StatisticSearch;if(!search||!Array.isArray(search.row))throw new Error('INVALID_RESPONSE');
  return {total:Number(search.list_total_count)||search.row.length,rows:search.row.map(row=>({date:ecosDate(row.TIME),value:Number(row.DATA_VALUE)})).filter(row=>row.date&&Number.isFinite(row.value))};
}
const ecosPeriod=(date,cycle)=>cycle==='D'?iso(date).replaceAll('-',''):iso(date).slice(0,7).replace('-','');
// Latest value, previous value and change; for y/y series the value is the year-over-year percent change.
function summarize(spec,observations){
  const rows=[...new Map(observations.map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(spec.yoy){
    const yoy=rows.map(row=>{const prior=rows.find(r=>r.date===String(Number(row.date.slice(0,4))-1)+row.date.slice(4));return prior?{date:row.date,value:(row.value/prior.value-1)*100}:null;}).filter(Boolean);
    const last=yoy.at(-1),prev=yoy.at(-2);return {...meta(spec),date:last?.date??null,value:last?round(last.value):null,previous:prev?round(prev.value):null,change:last&&prev?round(last.value-prev.value):null,history:yoy.slice(-12).map(r=>({date:r.date,value:round(r.value)}))};
  }
  const last=rows.at(-1),prev=rows.at(-2);
  return {...meta(spec),date:last?.date??null,value:last?.value??null,previous:prev?.value??null,change:last&&prev?round(last.value-prev.value):null,history:rows.slice(-30)};
}
const round=v=>Math.round(v*1000)/1000;
const meta=spec=>({id:spec.id,market:spec.market,source:spec.source,name:spec.name,unit:spec.unit,frequency:spec.cycle==='M'||spec.monthly?'monthly':'daily'});
// One ECOS window; with the sample key only the last 10 rows are requested (after reading the row count).
async function ecosWindow(fetch,key,spec,start,end){
  const url=(a,b)=>`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/${a}/${b}/${spec.stat}/${spec.cycle}/${ecosPeriod(start,spec.cycle)}/${ecosPeriod(end,spec.cycle)}/${spec.item}`;
  const get=async(a,b)=>{const response=await fetch(url(a,b),{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('REQUEST_FAILED');return parseEcos(await response.json());};
  const limit=key===ECOS_SAMPLE?10:100;const first=await get(1,limit);
  if(first.total<=first.rows.length||first.total<=limit)return first.rows;
  return (await get(first.total-limit+1,first.total)).rows;
}
async function fetchEcos(fetch,key,spec,now){
  const end=new Date(now);const daily=spec.cycle==='D';
  const rows=await ecosWindow(fetch,key,spec,shiftDays(end,daily?-20:-300),end);
  if(!spec.yoy||!rows.length)return rows;
  // Year-earlier months for the y/y change.
  const latest=rows.at(-1).date,yearAgo=new Date(Date.parse(latest+'T00:00:00Z'));yearAgo.setUTCFullYear(yearAgo.getUTCFullYear()-1);
  return [...await ecosWindow(fetch,key,spec,shiftDays(yearAgo,-62),yearAgo),...rows];
}
// FRED's CSV download stalls requests that carry no identifying User-Agent, as Electron's utility process sends them.
const FRED_HEADERS={'user-agent':'FinancialPortfolioManager (+https://github.com/goheungchoi/financial-portfolio-manager)'};
// FRED API JSON: observations [{date,value}]; missing values are ".".
function parseFredJson(body){
  if(!Array.isArray(body?.observations))throw new Error('INVALID_RESPONSE');
  return body.observations.map(row=>({date:row.date,value:row.value==='.'||row.value==null||row.value===''?null:Number(row.value)})).filter(row=>isDay(row.date)&&Number.isFinite(row.value));
}
async function fetchFredOnce(fetch,spec,start,key){
  // With a key, the documented API; without one, the public CSV download.
  if(key){
    const params=new URLSearchParams({series_id:spec.series,api_key:key,file_type:'json',observation_start:start});
    const response=await fetch('https://api.stlouisfed.org/fred/series/observations?'+params,{redirect:'error',headers:FRED_HEADERS,signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(response.status===400||response.status===403?'FRED_KEY_REJECTED':'REQUEST_FAILED');return parseFredJson(await response.json());
  }
  const response=await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${spec.series}&cosd=${start}`,{redirect:'error',headers:FRED_HEADERS,signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('REQUEST_FAILED');return parseFredCsv(await response.text());
}
async function fetchFred(fetch,spec,now,key=null){
  const start=iso(shiftDays(new Date(now),spec.yoy?-800:spec.monthly?-400:-60));
  // One retry covers a dropped connection; a rejected key is not retried.
  try{return await fetchFredOnce(fetch,spec,start,key);}catch(error){if(error.message==='FRED_KEY_REJECTED'||error.message==='INVALID_RESPONSE')throw error;return fetchFredOnce(fetch,spec,start,key);}
}
async function fetchCalendar(fetch,key,now){
  const start=new Date(now);const params=new URLSearchParams({api_key:key,file_type:'json',realtime_start:iso(start),realtime_end:iso(shiftDays(start,45)),include_release_dates_with_no_data:'true',sort_order:'asc',limit:'1000'});
  const response=await fetch('https://api.stlouisfed.org/fred/releases/dates?'+params,{redirect:'error',headers:FRED_HEADERS,signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(response.status===400||response.status===403?'FRED_KEY_REJECTED':'REQUEST_FAILED');
  return calendarRows((await response.json()).release_dates,iso(start));
}
function calendarRows(rows,today){
  if(!Array.isArray(rows))throw new Error('INVALID_RESPONSE');const seen=new Set();
  return rows.flatMap(row=>{const match=RELEASES.find(([name])=>String(row.release_name??'').toLowerCase().includes(name.toLowerCase()));if(!match||!isDay(row.date)||row.date<today)return [];const key=match[1]+row.date;if(seen.has(key))return [];seen.add(key);return [{date:row.date,market:'US',event:match[1],source:'FRED release calendar'}];}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,30);
}
// Fetches every series independently so one failing source does not hide the others.
async function fetchMacro(fetch,{ecosKey=null,fredKey=null,now=Date.now()}={}){
  const errors=[];const series=[];
  // FRED downloads run in parallel; ECOS requests run one at a time to stay within its limits.
  let chain=Promise.resolve();const ecos=spec=>{const run=chain.then(()=>fetchEcos(fetch,ecosKey||ECOS_SAMPLE,spec,now));chain=run.catch(()=>{});return run;};
  const settled=await Promise.allSettled(SERIES.map(spec=>spec.source==='ECOS'?ecos(spec):fetchFred(fetch,spec,now,fredKey)));
  settled.forEach((result,i)=>{const spec=SERIES[i];if(result.status==='fulfilled')series.push(summarize(spec,result.value));else errors.push({id:spec.id,source:spec.source,code:/^[A-Z0-9_-]{3,40}$/.test(result.reason?.message??'')?result.reason.message:'REQUEST_FAILED'});});
  let calendar=null;if(fredKey){try{calendar=await fetchCalendar(fetch,fredKey,now);}catch(error){errors.push({id:'CALENDAR',source:'FRED',code:/^[A-Z0-9_-]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED'});}}
  return {fetchedAt:now,ecosAccess:ecosKey?'key':'sample',calendarAccess:fredKey?'key':'none',series,calendar,errors};
}
// USD/KRW reference rates (ECOS 매매기준율) for the week up to each requested day, for settlement-date tax conversion.
async function fetchUsdKrw(fetch,key,days){
  const spec=SERIES.find(s=>s.id==='KR_USDKRW'),rows=[];
  for(const day of days.slice(0,20)){if(!isDay(day))continue;const end=new Date(day+'T00:00:00Z');rows.push(...await ecosWindow(fetch,key||ECOS_SAMPLE,spec,shiftDays(end,-7),end));}
  return [...new Map(rows.map(r=>[r.date,r])).values()];
}
class MacroStore {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS macro_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');}
  // Keeps the last good value of a series when a later refresh fails for it.
  save(result){
    const previous=this.get();const keep=(previous?.series??[]).filter(old=>!result.series.some(s=>s.id===old.id)&&result.errors.some(e=>e.id===old.id)).map(old=>({...old,stale:true}));
    const calendar=result.calendar??(result.errors.some(e=>e.id==='CALENDAR')?previous?.calendar??null:null);
    const value={...result,series:SERIES.map(spec=>[...result.series,...keep].find(s=>s.id===spec.id)).filter(Boolean),calendar};
    this.db.prepare('INSERT INTO macro_snapshot VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value));return value;
  }
  get(){const row=this.db.prepare('SELECT payload FROM macro_snapshot WHERE id=1').get();return row?JSON.parse(row.payload):null;}
  // Compact AI context: latest values and the next two weeks of releases.
  context(){
    const snap=this.get();if(!snap)return null;const today=iso(new Date(this.clock())),until=iso(shiftDays(new Date(this.clock()),14));
    return {asOf:iso(new Date(snap.fetchedAt)),indicators:snap.series.map(s=>({name:s.name,market:s.market,value:s.value,unit:s.unit,date:s.date,change:s.change,...(s.stale?{stale:true}:{})})),upcoming:(snap.calendar??[]).filter(e=>e.date>=today&&e.date<=until).map(({date,event})=>({date,event})),note:snap.calendar?'Change is versus the previous observation. Release dates come from the FRED calendar.':'Change is versus the previous observation. No release calendar is connected.'};
  }
}
module.exports={SERIES,RELEASES,parseFredCsv,parseFredJson,parseEcos,summarize,fetchMacro,fetchUsdKrw,calendarRows,MacroStore};
