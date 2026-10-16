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
async function secCompany(fetcher,contact,symbol,today,state){
  const m=/^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.-]{0,14})$/.exec(symbol);if(!m)throw new Error('INVALID_INSTRUMENT');
  const headers={'user-agent':`FinancialPortfolioManager ${contact}`,accept:'application/json'};
  const get=async url=>{const response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});if(response.status===403||response.status===429)throw new Error('SEC_RATE_LIMITED');if(!response.ok)throw new Error('SEC_UNAVAILABLE');const text=await response.text();if(text.length>40*1024*1024)throw new Error('SEC_UNAVAILABLE');return JSON.parse(text);};
  if(!state.tickers||Date.now()-state.tickersAt>86400000){state.tickers=parseTickers(await get('https://www.sec.gov/files/company_tickers.json'));state.tickersAt=Date.now();}
  const company=state.tickers.get(m[2]);if(!company)return {status:'unavailable',reason:'NOT_IN_SEC'};
  const cik=String(company.cik).padStart(10,'0');
  const facts=await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);const subs=await get(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const list=filings(subs,company.cik);const annual=annualFacts(facts);
  return {cik:company.cik,name:company.title,fiscalYearEndMonthDay:subs.fiscalYearEnd??null,annual,filings:list,earnings:earningsTiming(list,today),
    dividends:{years:annual.filter(r=>r.dividendsPerShare!=null).map(r=>({year:r.fiscalYearEnd.slice(0,4),fiscalYearEnd:r.fiscalYearEnd,perShare:r.dividendsPerShare,payoutRatioPct:r.payoutRatioPct}))}};
}
module.exports={parseTickers,annualFacts,filings,earningsTiming,secCompany};
