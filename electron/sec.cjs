// U.S. company research from SEC EDGAR (no key). SEC requires a User-Agent naming the app and a contact email,
// so requests are sent only when the providers file includes secContactEmail. Read-only public data.
const CONCEPTS={
  revenueUSD:{tags:['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','SalesRevenueNet','RevenuesNetOfInterestExpense'],duration:true},
  operatingIncomeUSD:{tags:['OperatingIncomeLoss'],duration:true},netIncomeUSD:{tags:['NetIncomeLoss','ProfitLoss'],duration:true},
  epsDiluted:{tags:['EarningsPerShareDiluted','EarningsPerShareBasicAndDiluted'],duration:true,unit:'USD/shares'},
  operatingCashFlowUSD:{tags:['NetCashProvidedByUsedInOperatingActivities'],duration:true},capexUSD:{tags:['PaymentsToAcquirePropertyPlantAndEquipment'],duration:true},
  dividendsPerShare:{tags:['CommonStockDividendsPerShareDeclared','CommonStockDividendsPerShareCashPaid'],duration:true,unit:'USD/shares'},
  assetsUSD:{tags:['Assets']},liabilitiesUSD:{tags:['Liabilities']},equityUSD:{tags:['StockholdersEquity','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']},
  cashUSD:{tags:['CashAndCashEquivalentsAtCarryingValue']},longTermDebtUSD:{tags:['LongTermDebtNoncurrent','LongTermDebt']},
  dilutedShares:{tags:['WeightedAverageNumberOfDilutedSharesOutstanding'],duration:true,unit:'shares'}};
const round=(v,d=1)=>v==null||!Number.isFinite(v)?null:Math.round(v*10**d)/10**d;
const days=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
// SEC writes class shares with a dash (BRK-B); the app uses a dot (BRK.B).
function parseTickers(json){const map=new Map();for(const row of Object.values(json??{}))if(row&&typeof row.ticker==='string'&&Number.isInteger(row.cik_str))map.set(row.ticker.toUpperCase().replaceAll('-','.'),{cik:row.cik_str,title:String(row.title??'').slice(0,80)});return map;}
// Annual values from 10-K filings: full-year durations for flows, fiscal-year-end balances for stocks; the latest filing wins.
function annualFacts(facts){
  const gaap=facts?.facts?.['us-gaap']??{};const years=new Map();
  for(const [field,spec] of Object.entries(CONCEPTS)){
    for(const tag of spec.tags){const units=gaap[tag]?.units?.[spec.unit??'USD'];if(!Array.isArray(units))continue;let found=false;
      for(const f of units){if(!/^10-K/.test(f.form??'')||f.fp!=='FY'||!/^\d{4}-\d{2}-\d{2}$/.test(f.end??'')||!Number.isFinite(f.val))continue;if(spec.duration&&!(f.start&&days(f.start,f.end)>340&&days(f.start,f.end)<380))continue;
        const row=years.get(f.end)??{fiscalYearEnd:f.end,filed:{}};if(row[field]==null||String(f.filed)>String(row.filed[field])){row[field]=f.val;row.filed[field]=f.filed;found=true;}years.set(f.end,row);}
      if(found)break;}
  }
  const rows=[...years.values()].filter(r=>r.revenueUSD!=null||r.netIncomeUSD!=null).sort((a,b)=>b.fiscalYearEnd.localeCompare(a.fiscalYearEnd)).slice(0,5);
  return rows.map((r,i)=>{const prev=rows[i+1];const fcf=r.operatingCashFlowUSD!=null&&r.capexUSD!=null?r.operatingCashFlowUSD-r.capexUSD:null;
    const {filed,...v}=r;return {...v,freeCashFlowUSD:fcf,operatingMarginPct:r.revenueUSD&&r.operatingIncomeUSD!=null?round(r.operatingIncomeUSD/r.revenueUSD*100):null,netMarginPct:r.revenueUSD&&r.netIncomeUSD!=null?round(r.netIncomeUSD/r.revenueUSD*100):null,
      roePct:r.equityUSD>0&&r.netIncomeUSD!=null?round(r.netIncomeUSD/r.equityUSD*100):null,debtToEquity:r.equityUSD>0&&r.longTermDebtUSD!=null?round(r.longTermDebtUSD/r.equityUSD,2):null,
      payoutRatioPct:r.dividendsPerShare!=null&&r.epsDiluted>0?round(r.dividendsPerShare/r.epsDiluted*100):null,revenueGrowthPct:prev?.revenueUSD&&r.revenueUSD!=null?round((r.revenueUSD/prev.revenueUSD-1)*100):null,
      epsGrowthPct:prev?.epsDiluted>0&&r.epsDiluted!=null?round((r.epsDiluted/prev.epsDiluted-1)*100):null};});
}
const KIND_8K=[['2.02','earnings'],['5.07','meeting'],['1.01','contract'],['2.01','corporate'],['5.02','corporate'],['3.02','capital'],['1.03','legal'],['4.02','legal']];
function filings(subs,cik){
  const f=subs?.filings?.recent;if(!f||!Array.isArray(f.form))return [];const out=[];
  for(let i=0;i<f.form.length&&out.length<40;i++){
    const form=String(f.form[i]);const date=String(f.filingDate?.[i]??'');const items=String(f.items?.[i]??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))continue;
    let kind=null;if(/^10-[KQ]/.test(form))kind='periodic';else if(form==='8-K'||form==='8-K/A'){kind=KIND_8K.find(([code])=>items.split(',').includes(code))?.[1]??'material';}else if(/^DEF 14A/.test(form))kind='meeting';else if(/^(S-1|S-3|424B)/.test(form))kind='capital';else if(/^SC 13[DG]/.test(form))kind='ownership';
    if(!kind)continue;const accession=String(f.accessionNumber?.[i]??'').replaceAll('-','');const doc=String(f.primaryDocument?.[i]??'');
    out.push({date,form,kind,title:form+(items?` · items ${items}`:'')+(f.primaryDocDescription?.[i]?` · ${String(f.primaryDocDescription[i]).slice(0,80)}`:''),url:/^\d{18}$/.test(accession)&&/^[A-Za-z0-9._-]+$/.test(doc)?`https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${doc}`:null});
  }
  return out;
}
// Next earnings, estimated from the last earnings 8-K plus a quarter.
function earningsTiming(items,today){
  const last=items.filter(i=>i.kind==='earnings').map(i=>i.date).sort().at(-1);if(!last)return null;let next=last;
  while(next<today)next=new Date(Date.parse(next+'T00:00:00Z')+91*86400000).toISOString().slice(0,10);
  return {lastRelease:last,nextExpected:next,basis:'Estimated as one quarter after the last earnings release (8-K item 2.02); not an announced date.'};
}
// Resolves a symbol to its SEC company and returns a JSON getter that names the app and contact, as SEC asks.
async function secLookup(fetcher,contact,symbol,state){
  const m=/^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.-]{0,14})$/.exec(symbol);if(!m)throw new Error('INVALID_INSTRUMENT');
  const headers={'user-agent':`FinancialPortfolioManager ${contact}`,accept:'application/json'};
  const get=async url=>{const response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});if(response.status===403||response.status===429)throw new Error('SEC_RATE_LIMITED');if(!response.ok)throw new Error('SEC_UNAVAILABLE');const text=await response.text();if(text.length>40*1024*1024)throw new Error('SEC_UNAVAILABLE');return JSON.parse(text);};
  if(!state.tickers||Date.now()-state.tickersAt>86400000){state.tickers=parseTickers(await get('https://www.sec.gov/files/company_tickers.json'));state.tickersAt=Date.now();}
  const company=state.tickers.get(m[2]);return {company,get,cik:company?String(company.cik).padStart(10,'0'):null};
}
// Filings only (the submissions file, much smaller than company facts): recent filings and the estimated next earnings.
async function secFilings(fetcher,contact,symbol,today,state){
  const {company,get,cik}=await secLookup(fetcher,contact,symbol,state);if(!company)return {status:'unavailable',reason:'NOT_IN_SEC'};
  const subs=await get(`https://data.sec.gov/submissions/CIK${cik}.json`);const list=filings(subs,company.cik);
  return {cik:company.cik,name:company.title,fiscalYearEndMonthDay:subs.fiscalYearEnd??null,filings:list,earnings:earningsTiming(list,today)};
}
async function secCompany(fetcher,contact,symbol,today,state){
  const {company,get,cik}=await secLookup(fetcher,contact,symbol,state);if(!company)return {status:'unavailable',reason:'NOT_IN_SEC'};
  const facts=await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);const subs=await get(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const list=filings(subs,company.cik);const annual=annualFacts(facts);
  return {cik:company.cik,name:company.title,fiscalYearEndMonthDay:subs.fiscalYearEnd??null,annual,filings:list,earnings:earningsTiming(list,today),
    dividends:{years:annual.filter(r=>r.dividendsPerShare!=null).map(r=>({year:r.fiscalYearEnd.slice(0,4),fiscalYearEnd:r.fiscalYearEnd,perShare:r.dividendsPerShare,payoutRatioPct:r.payoutRatioPct}))}};
}
// An EDGAR document as text, naming the app and contact as SEC asks.
async function secText(fetcher,contact,url,max=8*1024*1024){
  const response=await fetcher(url,{headers:{'user-agent':`FinancialPortfolioManager ${contact}`,accept:'text/html'},redirect:'error',signal:AbortSignal.timeout(45000)});
  if(response.status===403||response.status===429)throw new Error('SEC_RATE_LIMITED');if(!response.ok)throw new Error('SEC_UNAVAILABLE');const body=await response.text();if(body.length>max)throw new Error('SEC_UNAVAILABLE');return body;
}
// Plain text of an HTML filing document: blocks become lines, tags go, common entities are decoded.
function htmlText(html){
  const named={nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",rsquo:"'",lsquo:"'",rdquo:'"',ldquo:'"',ndash:'-',mdash:'-',hellip:'...'};
  return String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ').replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li|table)>/gi,'\n').replace(/<\/t[dh]>/gi,' ').replace(/<[^>]+>/g,'')
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(Number(d))).replace(/&([a-z]+);/gi,(m,n)=>named[n.toLowerCase()]??m)
    .replace(/[   ]/g,' ').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-')
    .split('\n').map(line=>line.replace(/[ \t]+/g,' ').trim()).filter(Boolean).join('\n');
}
// The press-release exhibit (EX-99.1, else another EX-99) listed on a filing's index page.
function releaseExhibit(indexHtml){
  const rows=String(indexHtml).match(/<tr[\s\S]*?<\/tr>/gi)??[];let other=null;
  for(const row of rows){const cells=(row.match(/<td[^>]*>[\s\S]*?<\/td>/gi)??[]).map(c=>htmlText(c));const href=/href="([^"]+)"/i.exec(row)?.[1]?.replace(/^\/ix\?doc=/,'');
    if(!href||!/^\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9._-]+\.(htm|html|txt)$/i.test(href))continue;const type=cells.find(c=>/^EX-99/i.test(c));if(!type)continue;
    if(/^EX-99\.0?1$/i.test(type))return {type:type.toUpperCase(),path:href};other??={type:type.toUpperCase(),path:href};}
  return other;
}
const BOILERPLATE=/forward-looking|safe harbor|risks and uncertainties|undue reliance|Securities Litigation Reform/i;
// The results and outlook stated in a release, as the company's own sentences.
function releaseFacts(text){
  const sentences=text.split('\n').flatMap(line=>line.split(/(?<=[.!?])\s+(?=[A-Z("$])/)).map(s=>s.replace(/^[•·▪◦*-]\s*/,'').trim()).filter(s=>s.length>=30&&s.length<=450&&/\d/.test(s)&&!BOILERPLATE.test(s));
  const guidance=sentences.filter(s=>/\b(guidance|outlook|expects?|expected|anticipates?|reaffirm\w*|raises?|raised|narrow\w*|lowers?|lowered|full[- ]year|fiscal (year )?20\d\d|fourth[- ]quarter|next quarter)\b/i.test(s));
  const results=sentences.filter(s=>!guidance.includes(s)&&/\b(sales|revenues?|EPS|earnings per share|operating income|segment income|margins?|free cash flow|net income|orders|backlog)\b/i.test(s)&&/[$%]|\d\.\d/.test(s));
  return {results:results.slice(0,10),guidance:guidance.slice(0,8)};
}
// The latest earnings release (8-K item 2.02): its exhibit text, the results and guidance sentences, and where it came from.
async function secEarningsRelease(fetcher,contact,symbol,today,state){
  const {company,get,cik}=await secLookup(fetcher,contact,symbol,state);if(!company)return {status:'unavailable',reason:'NOT_IN_SEC'};
  const f=(await get(`https://data.sec.gov/submissions/CIK${cik}.json`))?.filings?.recent;if(!f||!Array.isArray(f.form))return {status:'unavailable',reason:'NO_EARNINGS_RELEASE'};
  const i=f.form.findIndex((form,k)=>/^8-K/.test(String(form))&&String(f.items?.[k]??'').split(',').includes('2.02'));if(i<0)return {status:'unavailable',reason:'NO_EARNINGS_RELEASE'};
  const accession=String(f.accessionNumber?.[i]??'');if(!/^\d{10}-\d{2}-\d{6}$/.test(accession))return {status:'unavailable',reason:'NO_EARNINGS_RELEASE'};const plain=accession.replaceAll('-','');
  const text=url=>secText(fetcher,contact,url);
  const indexUrl=`https://www.sec.gov/Archives/edgar/data/${company.cik}/${plain}/${accession}-index.htm`;const exhibit=releaseExhibit(await text(indexUrl));
  if(!exhibit)return {status:'unavailable',reason:'NO_RELEASE_EXHIBIT',filing:{filed:String(f.filingDate?.[i]??''),url:indexUrl}};
  const url='https://www.sec.gov'+exhibit.path;const body=htmlText(await text(url));const facts=releaseFacts(body);const LIMIT=12000;
  return {cik:company.cik,name:company.title,source:`SEC EDGAR ${String(f.form[i])} filed ${String(f.filingDate?.[i]??'')}, ${exhibit.type}`,filed:String(f.filingDate?.[i]??''),reportDate:String(f.reportDate?.[i]??'')||null,form:String(f.form[i]),accession,exhibit:exhibit.type,url,
    // The release opens after EDGAR's document label (for example "EX-99.1 2 q32026pressrelease.htm") and short header lines.
    headline:body.split('\n').filter(line=>line.length>=25&&!/^(ex(hibit)?[- ]?99|\S+\.html?$)|\.html?$/i.test(line)).slice(0,3).join(' ').slice(0,700),results:facts.results,guidance:facts.guidance,
    ...(facts.guidance.length?{}:{guidanceNote:'No outlook or guidance sentence was found in the release text.'}),textChars:body.length,text:body.slice(0,LIMIT),...(body.length>LIMIT?{textTruncated:true}:{})};
}
// The opening paragraphs of the business description in an annual report: 10-K Item 1 (Business), or 20-F Item 4
// (Information on the Company). The table-of-contents entry is skipped: the real section runs on for pages.
function businessSection(text,form){
  const lines=String(text).split('\n');const foreign=/^20-F/.test(form);
  const start=foreign?/^item\s*4\.?\s*[-:.]?\s*information on the company\b/i:/^item\s*1\.?\s*[-:.]?\s*business\b/i,stop=foreign?/^item\s*(4a|5)\b/i:/^item\s*(1a|1b|2)\b/i;
  for(let i=0;i<lines.length;i++){
    if(!start.test(lines[i]))continue;const body=[];let size=0;for(let j=i+1;j<lines.length&&!stop.test(lines[j]);j++){body.push(lines[j]);size+=lines[j].length;}
    if(size<2000)continue;
    // Definitions of "we", "us" and the company name are not a description.
    const paragraphs=body.filter(line=>line.length>=80&&!/^table of contents/i.test(line)&&!/unless the context|as used (herein|in this)|references (herein|in this)|the terms "?(we|us|our)\b/i.test(line));const out=[];let n=0;
    for(const p of paragraphs){if(n>=900)break;out.push(p.length>1200?p.slice(0,1199)+'…':p);n+=p.length;}
    return out.length?{text:out.join('\n\n'),truncated:out.length<paragraphs.length}:null;
  }
  return null;
}
// What the company does, from its latest annual report on EDGAR, with its SEC industry classification.
async function secAbout(fetcher,contact,symbol,today,state){
  const {company,get,cik}=await secLookup(fetcher,contact,symbol,state);if(!company)return {status:'unavailable',reason:'NOT_IN_SEC'};
  const subs=await get(`https://data.sec.gov/submissions/CIK${cik}.json`);const f=subs?.filings?.recent;const industry=typeof subs?.sicDescription==='string'&&subs.sicDescription.trim()?subs.sicDescription.trim():null;
  const i=Array.isArray(f?.form)?f.form.findIndex(form=>/^(10-K|20-F)$/.test(String(form))):-1;if(i<0)return {status:'unavailable',reason:'NO_ANNUAL_REPORT',industry};
  const accession=String(f.accessionNumber?.[i]??'').replaceAll('-',''),doc=String(f.primaryDocument?.[i]??''),form=String(f.form[i]),filed=String(f.filingDate?.[i]??'');
  if(!/^\d{18}$/.test(accession)||!/^[A-Za-z0-9._-]+\.html?$/i.test(doc))return {status:'unavailable',reason:'NO_ANNUAL_REPORT',industry};
  const url=`https://www.sec.gov/Archives/edgar/data/${company.cik}/${accession}/${doc}`;const section=businessSection(htmlText(await secText(fetcher,contact,url,25*1024*1024)),form);
  return {name:company.title,language:'en',industry,source:{kind:`SEC ${form}`,form,date:filed,url,section:/^20-F/.test(form)?'Item 4. Information on the Company':'Item 1. Business'},
    ...(section?{overview:section.text,...(section.truncated?{truncated:true}:{})}:{overviewUnavailable:'NO_BUSINESS_SECTION'})};
}
module.exports={parseTickers,annualFacts,filings,earningsTiming,secCompany,secFilings,secEarningsRelease,secAbout,businessSection,htmlText,releaseExhibit,releaseFacts};
