// Preliminary earnings (영업(잠정)실적 공정공시) read from the disclosure document itself. OpenDART's structured financial
// APIs cover periodic reports only (its guide lists reprt_code 11011-11014), so the figures are parsed from the
// filing's table, fetched with the original-document API (document.xml, a ZIP). Missing figures stay null ("-" in the
// filing means not disclosed), never zero. Each result keeps its source filing, periods, unit, basis and status.
const UNITS={'조원':1e12,'억원':1e8,'백만원':1e6,'천원':1e3,'원':1};
const METRICS=[['revenue',/^매출액$/],['operatingIncome',/^영업이익$/],['pretaxIncome',/^법인세비용차감전계속사업이익$/],['netIncome',/^당기순이익$/],['netIncomeOwners',/^지배기업\s*소유주지분\s*순이익$/]];
const PERIODS={'당기실적':'quarter','전기실적':'priorQuarter','전년동기실적':'yearAgoQuarter','당기누계실적':'yearToDate','전년동기누적실적':'yearAgoYearToDate','전년동기누계실적':'yearAgoYearToDate'};
const decode=s=>s.replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
const text=html=>decode(String(html).replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();
// Rows of cells from an HTML viewer page or DART XML (TD, TH, TE and TU cells).
function rows(doc){return [...String(doc).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<(td|th|te|tu)[^>]*>([\s\S]*?)<\/\1>/gi)].map(c=>text(c[2])));}
// "1,234.5" → 1234.5; "△1.2" or "-1.2" → -1.2; "-", "" or anything else → null.
function num(cell){const t=String(cell??'').replace(/,/g,'').trim();if(!t||t==='-')return null;const neg=/^[△▲-]/.test(t)&&t.length>1;const n=Number(t.replace(/^[△▲+-]/,''));return Number.isFinite(n)?(neg?-n:n):null;}
function parsePreliminary(doc,{title=''}={}){
  const all=rows(doc);const flat=all.map(r=>r.join(' ')).join('\n');
  const unitMatch=/단위\s*[:：]\s*(조원|억원|백만원|천원|원)/.exec(flat);const unit=unitMatch?unitMatch[1]:null;
  const basis=/연결/.test(title)||/연결실적내용/.test(flat)?'consolidated':/개별|별도/.test(title)||/개별실적내용|별도실적내용/.test(flat)?'standalone':'unknown';
  const periods={};for(const r of all){const key=PERIODS[r[0]];const dates=r.filter(c=>/^\d{4}-\d{2}-\d{2}$/.test(c));if(key&&dates.length>=2)periods[key]={from:dates[0],to:dates[1]};}
  const metrics={};let current=null;
  for(const r of all){
    let i=0;const m=METRICS.find(([,re])=>re.test(r[0]??''));if(m){current=m[0];i=1;}
    if(!current)continue;const kind=r[i];if(kind!=='당해실적'&&kind!=='누계실적'){if(!m)current=null;continue;}
    const v=r.slice(i+1);const entry=metrics[current]??={};
    if(kind==='당해실적')entry.quarter={current:num(v[0]),priorQuarter:num(v[1]),changeFromPriorQuarterPct:num(v[2]),yearAgo:num(v[4]),changeFromYearAgoPct:num(v[5])};
    else entry.yearToDate={current:num(v[0]),yearAgo:num(v[4]),changeFromYearAgoPct:num(v[5])};
  }
  const disclosed=Object.entries(metrics).filter(([,e])=>e.quarter?.current!=null||e.yearToDate?.current!=null).map(([k])=>k);
  if(!disclosed.length)return null;
  return {status:/기재정정|정정/.test(title)?'preliminary (corrected filing)':'preliminary',basis,unit,unitInKRW:unit?UNITS[unit]:null,periods,metrics,disclosed,
    notDisclosed:METRICS.map(([k])=>k).filter(k=>!disclosed.includes(k)),note:'Preliminary figures in the stated unit; changes are percentages. Undisclosed figures are null, not zero. Final figures may differ.'};
}
// Some companies (carmakers, for example) file monthly unit sales under the same 영업(잠정)실적 title, with every
// earnings row left "-" and a table in units (단위:대). Read as unit sales, never as earnings.
const SALES_ROWS=[['domestic',/내수/],['overseas',/해외|수출/],['special',/특수/],['total',/^(계|합계|총계)$/]];
function salesColumn(header){
  if(/전년동기.*(대비|증감)/.test(header))return 'changeFromYearAgoPct';if(/전기대비|전월대비/.test(header))return 'changeFromPriorMonthPct';
  if(/전년동기/.test(header))return 'yearAgo';if(/전기|전월/.test(header))return 'priorMonth';if(/당기|당월/.test(header))return 'current';return null;
}
function parseMonthlySales(doc){
  const all=rows(doc);const blocks=[];let block=null;
  for(const r of all){
    if(/단위\s*[:：]\s*대/.test(r[0]??'')){const m=/'(\d{2})\.(\d{1,2})월/.exec(r[1]??'');block={kind:/누적|누계/.test(r[1]??'')?'yearToDate':'month',through:m?`20${m[1]}-${m[2].padStart(2,'0')}`:null,columns:r.map(salesColumn),figures:{}};blocks.push(block);continue;}
    if(!block)continue;const key=SALES_ROWS.find(([,re])=>re.test(r[0]??''))?.[0];if(!key){block=null;continue;}
    const entry={};r.forEach((cell,i)=>{const c=block.columns[i];if(i&&c&&num(cell)!=null&&!(c in entry))entry[c]=num(cell);});block.figures[key]=entry;
  }
  const month=blocks.find(b=>b.kind==='month'&&Object.keys(b.figures).length),ytd=blocks.find(b=>b.kind==='yearToDate'&&Object.keys(b.figures).length);
  if(!month&&!ytd)return null;
  return {kind:'monthly unit sales',unit:'units sold',...(month?{month:month.through,figures:month.figures}:{}),...(ytd?{yearToDate:{through:ytd.through,figures:ytd.figures}}:{}),
    note:'Unit sales filed under the preliminary-results title; this filing has no revenue or profit figures.'};
}
// An IR event notice (기업설명회(IR)개최): its date, time, purpose and method. A results announcement has 실적 in its purpose.
function parseIrNotice(doc){
  const all=rows(doc);let date=null,time=null,purpose=null,method=null;
  for(const r of all){
    const label=r.slice(0,2).join(' ');
    if(!date&&/일시/.test(label)){const d=r.find(c=>/^\d{4}-\d{2}-\d{2}$/.test(c));if(d){date=d;time=r.find(c=>/^\d{1,2}:\d{2}$/.test(c))??null;}}
    if(/개최목적/.test(r[0]??''))purpose=r[1]??null;if(/개최방법/.test(r[0]??''))method=r[1]??null;
    if(!time&&/기타/.test(r[0]??'')){const m=/(\d{1,2})시\s*(\d{1,2})?\s*분?/.exec(r.slice(1).join(' '));if(m)time=`${m[1].padStart(2,'0')}:${(m[2]??'00').padStart(2,'0')}`;}
  }
  return date&&purpose?{date,time,purpose:purpose.slice(0,120),method:method?.slice(0,40)??null,results:/실적/.test(purpose)}:null;
}
// Preliminary-earnings filings, newest first (a correction filed the same day comes first).
const preliminaryFilings=filings=>(filings??[]).filter(f=>/영업\(잠정\)실적/.test(f.title)&&/rcpNo=\d{14}/.test(f.url??'')).sort((a,b)=>String(b.date).localeCompare(String(a.date))||(/정정/.test(b.title)?1:0)-(/정정/.test(a.title)?1:0));
const latestFiling=filings=>preliminaryFilings(filings)[0]??null;
// Decodes a document from the ZIP using its XML declaration (UTF-8 unless it says EUC-KR).
function decodeDocument(buffer){const head=buffer.subarray(0,200).toString('latin1');const enc=/encoding=["']?(euc-kr|ks_c_5601-1987|cp949)/i.test(head)?'euc-kr':'utf-8';return new TextDecoder(enc).decode(buffer);}
module.exports={parsePreliminary,parseMonthlySales,parseIrNotice,preliminaryFilings,latestFiling,decodeDocument,rows,num,UNITS};
