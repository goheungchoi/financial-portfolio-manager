// OpenDART company research: recent material filings by kind and the dividend table of the annual report.
// Runs in the provider worker, which holds the DART key. Read-only API calls.
const zlib=require('node:zlib');
const MAX_ZIP=20*1024*1024,MAX_XML=80*1024*1024;
// First entry of a ZIP archive, read through the central directory (DART's archive sets the data-descriptor flag).
function unzipFirst(buffer){
  let eocd=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)throw new Error('DART_FORMAT');const cd=buffer.readUInt32LE(eocd+16);if(cd+46>buffer.length||buffer.readUInt32LE(cd)!==0x02014b50)throw new Error('DART_FORMAT');
  const method=buffer.readUInt16LE(cd+10),size=buffer.readUInt32LE(cd+20),local=buffer.readUInt32LE(cd+42);
  if(local+30>buffer.length||buffer.readUInt32LE(local)!==0x04034b50)throw new Error('DART_FORMAT');
  const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);if(start+size>buffer.length||![0,8].includes(method))throw new Error('DART_FORMAT');
  const data=buffer.subarray(start,start+size);return method===8?zlib.inflateRawSync(data,{maxOutputLength:MAX_XML}):data;
}
// Listed companies only: stock code → DART corp code.
function parseCorpCodes(xml){
  const map=new Map();const re=/<corp_code>(\d{8})<\/corp_code>[\s\S]*?<stock_code>\s*(\d{6})?\s*<\/stock_code>/g;let m;
  while((m=re.exec(xml)))if(m[2])map.set(m[2],m[1]);return map;
}
// Filing kinds worth knowing for an investment view; routine insider holding reports are left out.
const KINDS=[['earnings',/영업\(잠정\)실적|매출액또는손익구조|실적발표|결산실적/],['ir',/기업설명회/],['dividend',/배당/],['buyback',/자기주식|자사주|주식소각/],
  ['capital',/유상증자|무상증자|감자|전환사채|신주인수권|교환사채|주식분할|주식병합/],['periodic',/사업보고서|반기보고서|분기보고서|감사보고서/],
  ['corporate',/합병|분할|영업양수|영업양도|자산양수|자산양도|타법인주식|최대주주변경|공개매수|상장폐지|거래정지|관리종목/],['contract',/단일판매|공급계약|수주/],
  ['legal',/소송|횡령|배임|불성실공시|제재/],['ownership',/주식등의대량보유|최대주주등소유주식변동/],['material',/투자판단관련주요경영사항|주요사항보고서|기타경영사항|풍문|조회공시/]];
const NOISE=/임원ㆍ주요주주특정증권등(소유상황|거래계획)보고서|대규모기업집단현황/;
function classify(title){for(const [kind,re] of KINDS)if(re.test(title))return kind;return 'other';}
function disclosures(rows){
  const seen=new Set();const out=[];
  for(const r of Array.isArray(rows)?rows:[]){const no=String(r.rcept_no??'');const title=String(r.report_nm??'').replace(/\s+/g,' ').trim();if(!/^\d{14}$/.test(no)||!title||seen.has(no)||NOISE.test(title))continue;seen.add(no);
    const d=String(r.rcept_dt??'');out.push({date:/^\d{8}$/.test(d)?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`:null,title:title.slice(0,160),kind:classify(title),filer:String(r.flr_nm??'').trim().slice(0,40)||null,amended:/정정/.test(title),url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='+no});}
  return out.sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,40);
}
const amount=text=>{const t=String(text??'').replaceAll(',','').trim();if(!t||t==='-')return null;const n=Number(t);return Number.isFinite(n)?n:null;};
// The annual report's dividend table: this year, last year and two years ago.
function dividendTable(rows){
  const list=Array.isArray(rows)?rows:[];if(!list.length)return null;const end=String(list[0].stlm_dt??'').slice(0,4);if(!/^\d{4}$/.test(end))return null;
  const pick=(label,kind)=>list.find(r=>String(r.se??'').replace(/\s+/g,'')===label.replace(/\s+/g,'')&&(!kind||String(r.stock_knd??'')===kind));
  const series=(row,scale=1)=>row?[amount(row.thstrm),amount(row.frmtrm),amount(row.lwfr)].map(v=>v==null?null:v*scale):[null,null,null];
  const perShare=series(pick('주당 현금배당금(원)','보통주')),payout=series(pick('(연결)현금배당성향(%)')??pick('현금배당성향(%)')),yieldPct=series(pick('현금배당수익률(%)','보통주')),total=series(pick('현금배당금총액(백만원)'),1e6),eps=series(pick('(연결)주당순이익(원)')??pick('주당순이익(원)'));
  const years=[0,1,2].map(i=>String(Number(end)-i));
  return {source:'DART annual report',fiscalYearEnd:String(list[0].stlm_dt),years:years.map((year,i)=>({year,perShare:perShare[i],payoutRatioPct:payout[i],yieldPct:yieldPct[i],totalKRW:total[i],eps:eps[i]})).filter(y=>y.perShare!=null||y.payoutRatioPct!=null)};
}
// Next earnings release, estimated from the lag after quarter end of the latest preliminary-earnings filing.
// Filings proven to hold earnings figures (confirmed) or titled as financial-statement results (재무제표기준) anchor the
// estimate when present, so monthly unit-sales reports filed under the same title do not.
function earningsTiming(items,today,{confirmed=[]}={}){
  const quarterEnd=day=>{const [y,m]=day.split('-').map(Number);const q=Math.floor((m-1)/3);const endMonth=q*3;return endMonth===0?`${y-1}-12-31`:new Date(Date.UTC(y,endMonth,0)).toISOString().slice(0,10);};
  const lagOf=day=>Math.round((Date.parse(day)-Date.parse(quarterEnd(day)))/86400000);
  // Quarterly results come 5 to 60 days after quarter end; filings right after it are usually monthly sales reports.
  const all=items.filter(i=>i.kind==='earnings'&&i.date),strong=all.filter(i=>/재무제표기준/.test(i.title??'')||confirmed.includes(i.date));
  const releases=(strong.length?strong:all).map(i=>i.date).sort().reverse();if(!releases.length)return null;
  const last=releases.find(d=>lagOf(d)>=5&&lagOf(d)<=60);if(!last)return {lastRelease:releases[0]};const lag=lagOf(last);
  let end=quarterEnd(last);let next;do{const [y,m]=end.split('-').map(Number);end=new Date(Date.UTC(y,m+3,0)).toISOString().slice(0,10);next=new Date(Date.parse(end)+lag*86400000).toISOString().slice(0,10);}while(next<today);
  return {lastRelease:last,daysAfterQuarterEnd:lag,nextExpected:next,basis:'Estimated from the timing of the last preliminary-earnings filing; not an announced date.'};
}
// Calls with the worker's DART key; the corp-code map is cached in state for a week.
const dartClient=(fetcher,key)=>async(path,params)=>{const response=await fetcher('https://opendart.fss.or.kr/api/'+path+'?'+new URLSearchParams({crtfc_key:key,...params}),{redirect:'error',signal:AbortSignal.timeout(path==='corpCode.xml'?60000:path==='document.xml'?45000:15000)});if(!response.ok)throw new Error('DART_UNAVAILABLE');return response;};
async function corpOf(call,state,stockCode){
  if(!state.corps||Date.now()-state.corpsAt>7*86400000){const buffer=Buffer.from(await (await call('corpCode.xml',{})).arrayBuffer());if(buffer.length>MAX_ZIP)throw new Error('DART_FORMAT');state.corps=parseCorpCodes(unzipFirst(buffer).toString('utf8'));state.corpsAt=Date.now();}
  return state.corps.get(stockCode)??null;
}
const dayOffset=(today,offset)=>new Date(Date.parse(today+'T00:00:00Z')-offset*86400000).toISOString().slice(0,10).replaceAll('-','');
// Fetches with the worker's DART key. corpMap is cached by the caller for the worker's lifetime.
async function companyFilings(fetcher,key,stockCode,today,state){
  if(!/^\d{6}$/.test(stockCode))throw new Error('INVALID_INSTRUMENT');
  const call=dartClient(fetcher,key);const corp=await corpOf(call,state,stockCode);if(!corp)return {status:'unavailable',reason:'NOT_IN_DART'};
  const day=offset=>dayOffset(today,offset);
  const rows=[];
  // Periodic reports, material-event reports and exchange filings (earnings, IR, dividends, contracts); one page each.
  for(const type of ['A','B','I']){const body=await (await call('list.json',{corp_code:corp,bgn_de:day(365),end_de:day(0),pblntf_ty:type,page_count:'100'})).json();if(body.status==='000')rows.push(...(body.list??[]));else if(body.status!=='013')throw new Error(body.status==='020'?'DART_RATE_LIMITED':'DART_UNAVAILABLE');}
  const filings=disclosures(rows);let dividendsTable=null;
  for(const year of [Number(today.slice(0,4))-1,Number(today.slice(0,4))-2]){const body=await (await call('alotMatter.json',{corp_code:corp,bsns_year:String(year),reprt_code:'11011'})).json();if(body.status==='000'){dividendsTable=dividendTable(body.list);if(dividendsTable)break;}}
  const preliminary=await preliminaryFigures(call,filings);const announced=await announcedResults(call,filings,today);
  const timing=earningsTiming(filings,today,{confirmed:preliminary&&!preliminary.unavailable?[preliminary.source.date]:[]});
  return {version:2,corpCode:corp,filings,earnings:timing||announced?{...(timing??{}),...(announced?{announced}:{})}:null,dividends:dividendsTable,preliminary};
}
// A filing's original document (document.xml, a ZIP) as text; throws a short error code.
async function fetchDocument(call,rceptNo){
  const response=await call('document.xml',{rcept_no:rceptNo});const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>MAX_ZIP)throw new Error('DART_FORMAT');
  if(buffer.subarray(0,2).toString('latin1')!=='PK'){const status=/<status>(\d+)<\/status>/.exec(buffer.toString('utf8'))?.[1];throw new Error(status==='020'?'DART_RATE_LIMITED':status==='014'?'DOCUMENT_NOT_FOUND':'DART_UNAVAILABLE');}
  return require('./dart-preliminary.cjs').decodeDocument(unzipFirst(buffer));
}
const receiptOf=filing=>/rcpNo=(\d{14})/.exec(filing.url)[1];
const errorCode=error=>/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DART_UNAVAILABLE';
// The announced date of the next results presentation, from the newest IR notices of the last 45 days (at most three
// documents read). Null when none announces results on or after today; a failure here is never an error.
async function announcedResults(call,filings,today){
  const P=require('./dart-preliminary.cjs');const since=new Date(Date.parse(today+'T00:00:00Z')-45*86400000).toISOString().slice(0,10);
  const notices=filings.filter(f=>f.kind==='ir'&&f.date>=since&&/rcpNo=\d{14}/.test(f.url??'')).slice(0,3);
  for(const f of notices){try{const ir=P.parseIrNotice(await fetchDocument(call,receiptOf(f)));if(ir?.results&&ir.date>=today)return {date:ir.date,time:ir.time,purpose:ir.purpose,method:ir.method,source:{date:f.date,title:f.title,rceptNo:receiptOf(f),url:f.url},basis:'Announced in an IR notice filed with DART.'};}catch{return null;}}
  return null;
}
// The figures of the newest preliminary-earnings filing, read from the document itself. Filings under that title holding
// monthly unit sales instead are kept as monthlySales and the scan moves to older filings (at most five documents). A
// failure here never fails the filing list; it is reported as unavailable with a reason.
async function preliminaryFigures(call,filings){
  const P=require('./dart-preliminary.cjs');const list=P.preliminaryFilings(filings).slice(0,5);if(!list.length)return null;
  const sourceOf=f=>({date:f.date,title:f.title,rceptNo:receiptOf(f),url:f.url});let monthlySales=null;const skipped=[];
  for(const filing of list){
    const source=sourceOf(filing);let doc;
    try{doc=await fetchDocument(call,source.rceptNo);}catch(error){return {source,unavailable:errorCode(error),...(monthlySales?{monthlySales}:{}),...(skipped.length?{skipped}:{})};}
    const parsed=P.parsePreliminary(doc,{title:filing.title});
    if(parsed)return {source,...parsed,...(monthlySales?{monthlySales}:{}),...(skipped.length?{skipped}:{})};
    const sales=P.parseMonthlySales(doc);if(sales&&!monthlySales)monthlySales={source,...sales};
    skipped.push({date:filing.date,rceptNo:source.rceptNo,reason:sales?'monthly unit sales, no earnings figures':'no earnings figures in the document'});
  }
  return {source:sourceOf(list[0]),unavailable:'NO_EARNINGS_FIGURES_IN_RECENT_FILINGS',note:'The recent filings under the preliminary-results title hold no revenue or profit figures.',...(monthlySales?{monthlySales}:{}),skipped};
}
// What the company does: the business overview (사업의 개요) of an annual report (사업보고서), its first paragraphs as filed.
function businessOverview(doc){
  const xml=String(doc);const strip=s=>String(s).replace(/<[^>]+>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/\s+/g,' ').trim();
  const titles=[...xml.matchAll(/<TITLE[^>]*>([\s\S]*?)<\/TITLE>/gi)].map(m=>({at:m.index,end:m.index+m[0].length,text:strip(m[1])}));
  const i=titles.findIndex(t=>/사업의\s*개요/.test(t.text));if(i<0)return null;
  const paragraphs=[...xml.slice(titles[i].end,titles[i+1]?.at??xml.length).matchAll(/<P[^>]*>([\s\S]*?)<\/P>/gi)].map(m=>strip(m[1])).filter(p=>p.length>=30);if(!paragraphs.length)return null;
  const out=[];let n=0;for(const p of paragraphs){if(n>=900)break;out.push(p.length>1200?p.slice(0,1199)+'…':p);n+=p.length;}
  return {section:titles[i].text,text:out.join('\n\n'),truncated:out.length<paragraphs.length};
}
// The latest annual report filed in the last 18 months and its business overview.
async function companyAbout(fetcher,key,stockCode,today,state){
  if(!/^\d{6}$/.test(stockCode))throw new Error('INVALID_INSTRUMENT');const call=dartClient(fetcher,key);const corp=await corpOf(call,state,stockCode);if(!corp)return {status:'unavailable',reason:'NOT_IN_DART'};
  const body=await (await call('list.json',{corp_code:corp,bgn_de:dayOffset(today,550),end_de:dayOffset(today,0),pblntf_detail_ty:'A001',page_count:'10'})).json();
  if(body.status==='013')return {status:'unavailable',reason:'NO_ANNUAL_REPORT'};if(body.status!=='000')throw new Error(body.status==='020'?'DART_RATE_LIMITED':'DART_UNAVAILABLE');
  const report=disclosures(body.list).find(f=>/사업보고서/.test(f.title));if(!report)return {status:'unavailable',reason:'NO_ANNUAL_REPORT'};
  const rceptNo=receiptOf(report);const source={kind:'DART annual report',date:report.date,title:report.title,rceptNo,url:report.url};
  const parsed=businessOverview(await fetchDocument(call,rceptNo));
  return {language:'ko',source:{...source,section:parsed?.section??'사업의 개요'},...(parsed?{overview:parsed.text,...(parsed.truncated?{truncated:true}:{})}:{overviewUnavailable:'NO_BUSINESS_OVERVIEW'})};
}
module.exports={unzipFirst,parseCorpCodes,classify,disclosures,dividendTable,earningsTiming,companyFilings,companyAbout,businessOverview,preliminaryFigures,announcedResults};
