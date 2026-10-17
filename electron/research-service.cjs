// Company research shared by the agents and the Company page: sections fetched on demand, cached in SQLite,
// composed from KIS (quotes, analysts, estimates, ratios, KSD dividends and meetings), OpenDART (filings, annual dividend table)
// and, for U.S. stocks, SEC EDGAR (annual financials, dividends, filings).
const {seoulDate}=require('./kis-activity.cjs');
const HOUR=3600000;
const SECTIONS=['overview','analysts','estimates','financials','dividends','events','flows','risk','valuation','peers','fund','holdings','factors','fairvalue'];
const FUND_TYPES=new Set(['etf','etn']),STOCK_ONLY=new Set(['analysts','estimates','financials','events','valuation','peers','factors','fairvalue']),FUND_DEFAULT=['overview','fund','holdings','risk'];
const AGENT_DEFAULT=['overview','analysts','estimates','dividends'];
const US_SECTIONS=['overview','risk','financials','dividends','events'],US_DEFAULT=['overview','financials','risk'];
const US=/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/;
// Raw sources and how long each stays fresh.
const SOURCES={overview:{ttl:HOUR/4,from:'kis'},analysts:{ttl:6*HOUR,from:'kis'},estimates:{ttl:12*HOUR,from:'kis'},financials:{ttl:24*HOUR,from:'kis'},
  dividends:{ttl:24*HOUR,from:'kis'},meetings:{ttl:24*HOUR,from:'kis'},dart:{ttl:12*HOUR,from:'dart'},flows:{ttl:2*HOUR,from:'kis'},valuation:{ttl:24*HOUR,from:'kis'},daily:{ttl:6*HOUR,from:'kis'},'index-daily':{ttl:6*HOUR,from:'kis'},fund:{ttl:HOUR/2,from:'kis'},holdings:{ttl:24*HOUR,from:'kis'},sec:{ttl:24*HOUR,from:'sec'},market:{ttl:10*60000,from:'kis'}};
const MARKET_INDEX={KOSPI:['0001','KOSPI'],KOSDAQ:['1001','KOSDAQ']};
const NEEDS={overview:['overview'],analysts:['analysts'],estimates:['estimates'],financials:['financials'],dividends:['dividends','dart'],events:['meetings','dart','dividends'],flows:['flows'],risk:['daily'],valuation:['valuation','overview'],peers:['overview'],fund:['fund','daily'],holdings:['holdings'],factors:['overview'],fairvalue:['overview','analysts','estimates','valuation']};
const FAILURE_TTL=10*60000;
const code=error=>/^[A-Z_]{3,40}$/.test(error?.code??error?.message??'')?(error.code??error.message):'DATA_SOURCE_UNAVAILABLE';
// Null, empty and "not applicable" values are dropped so the agents only read what exists.
function prune(value){
  if(Array.isArray(value)){const out=value.map(prune).filter(v=>v!==undefined);return out.length?out:undefined;}
  if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value)){const p=prune(v);if(p!==undefined)out[k]=p;}return Object.keys(out).length?out:undefined;}
  return value===null||value===''?undefined:value;
}
class ResearchService {
  constructor({db,master,kis,provider,kisReady=()=>true,dartReady=()=>false,secReady=()=>false,clock=Date.now}){
    this.db=db;this.master=master;this.kis=kis;this.provider=provider;this.kisReady=kisReady;this.dartReady=dartReady;this.secReady=secReady;this.clock=clock;this.inflight=new Map();this.failures=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS research_cache(symbol TEXT NOT NULL,source TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(symbol,source));CREATE TABLE IF NOT EXISTS research_snapshots(symbol TEXT NOT NULL,day TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(symbol,day))');
  }
  cached(symbol,source){const row=this.db.prepare('SELECT at,payload FROM research_cache WHERE symbol=? AND source=?').get(symbol,source);return row?{at:row.at,value:JSON.parse(row.payload)}:null;}
  // One raw source: fresh cache, a recent failure, or a new fetch (shared by concurrent callers).
  async source(symbol,source,refresh=false){
    const spec=SOURCES[source];const hit=this.cached(symbol,source);
    if(hit&&!refresh&&this.clock()-hit.at<spec.ttl)return {status:'ok',retrievedAt:hit.at,data:hit.value};
    const failed=this.failures.get(symbol+source);if(failed&&!refresh&&this.clock()-failed.at<FAILURE_TTL)return hit?{status:'ok',retrievedAt:hit.at,data:hit.value,stale:true}:{status:'unavailable',reason:failed.reason};
    const key=symbol+'|'+source;if(this.inflight.has(key))return this.inflight.get(key);
    const task=(async()=>{
      try{
        let value;
        if(spec.from==='dart'){if(!this.dartReady())return {status:'unavailable',reason:'DART_KEY_MISSING'};value=await this.provider('dart-company',{symbol});if(value?.status==='unavailable')return {status:'unavailable',reason:value.reason};}
        else if(spec.from==='sec'){if(!this.secReady())return {status:'unavailable',reason:'SEC_CONTACT_MISSING'};value=await this.provider('sec-company',{symbol});if(value?.status==='unavailable')return {status:'unavailable',reason:value.reason};}
        else{if(!this.kisReady())throw new Error('KIS_NOT_CONNECTED');value=await this.kis('research-section',{symbol,section:source});}
        const at=this.clock();this.db.prepare('INSERT INTO research_cache VALUES(?,?,?,?) ON CONFLICT(symbol,source) DO UPDATE SET at=excluded.at,payload=excluded.payload').run(symbol,source,at,JSON.stringify(value));this.failures.delete(symbol+source);this.snapshot(symbol,source,value);
        return {status:'ok',retrievedAt:at,data:value};
      }catch(error){const reason=code(error);this.failures.set(symbol+source,{at:this.clock(),reason});return hit?{status:'ok',retrievedAt:hit.at,data:hit.value,stale:true}:{status:'unavailable',reason};}
    })();
    // Registered before it settles and removed after, even when the task finished without waiting.
    this.inflight.set(key,task);void task.finally(()=>{if(this.inflight.get(key)===task)this.inflight.delete(key);});return task;
  }
  // A public section built from its sources; sources are fetched one after another (KIS calls are paced anyway).
  async section(symbol,name,refresh=false){
    if(!SECTIONS.includes(name))return {status:'unavailable',reason:'UNKNOWN_SECTION'};
    if(US.test(symbol))return this.usSection(symbol,name,refresh);
    if(!/^\d{6}$/.test(symbol))return {status:'unavailable',reason:'KOREAN_LISTINGS_ONLY'};
    // Funds have no analysts, statements or filings of their own; fund facts and holdings exist only for ETFs and ETNs.
    const fund=FUND_TYPES.has(this.identity(symbol).type);if(fund&&STOCK_ONLY.has(name))return {status:'unavailable',reason:'NOT_FOR_FUNDS'};if(!fund&&['fund','holdings'].includes(name))return {status:'unavailable',reason:'FUNDS_ONLY'};
    const parts={};for(const source of NEEDS[name])parts[source]=await this.source(symbol,source,refresh);
    const ok=s=>parts[s]?.status==='ok'?parts[s].data:null;const at=Math.min(...Object.values(parts).filter(p=>p.status==='ok').map(p=>p.retrievedAt));
    const main=parts[NEEDS[name][0]];
    if(name==='dividends'){if(main.status!=='ok')return main;return {status:'ok',retrievedAt:at,data:{...main.data,annualReport:ok('dart')?.dividends??null,...(parts.dart.status!=='ok'?{annualReportUnavailable:parts.dart.reason}:{})}};}
    if(name==='events'){
      const dart=ok('dart'),meetings=ok('meetings')?.meetings??[],dividends=ok('dividends');if(!dart&&!ok('meetings'))return {status:'unavailable',reason:parts.dart.reason??parts.meetings.reason};
      const today=seoulDate(this.clock());
      const upcoming=[...meetings.filter(m=>m.date>=today).map(m=>({date:m.date,kind:'meeting',title:(m.type??'Shareholder meeting')+(m.agenda.length?': '+m.agenda.slice(0,3).join(', '):'')})),
        ...(dividends?.upcoming??[]).filter(p=>p.recordDate>=today).map(p=>({date:p.recordDate,kind:'dividend',title:`Dividend record date (${({'결산':'year-end','분기':'quarterly','중간':'interim'})[p.kind]??p.kind??'cash'})${p.perShare?` · ${p.perShare.toLocaleString()} KRW`:' · amount not set'}`})),
        ...(dart?.earnings?.nextExpected?[{date:dart.earnings.nextExpected,kind:'earnings',title:'Preliminary earnings (estimated date)',estimated:true}]:[])].sort((a,b)=>a.date.localeCompare(b.date));
      return {status:'ok',retrievedAt:Number.isFinite(at)?at:this.clock(),data:{upcoming,earnings:dart?.earnings??null,filings:dart?.filings??[],meetings,...(parts.dart.status!=='ok'?{filingsUnavailable:parts.dart.reason}:{})}};
    }
    if(name==='fund'){
      if(main.status!=='ok')return main;const d=main.data;const closes=ok('daily')?.closes??[];let leverage=null;
      // Daily-reset products lose value in choppy markets: annual drag ≈ (L²−L)/2 × σ² of the underlying, with σ estimated from the fund's own volatility.
      if(d.leverageFactor!=null&&d.leverageFactor!==1&&closes.length>=21){const r=closes.slice(1).map((c,i)=>Math.log(c.close/closes[i].close));const m=r.reduce((a,b)=>a+b,0)/r.length;const sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(r.length-1))*Math.sqrt(252);const L=d.leverageFactor,under=sd/Math.abs(L);
        leverage={factor:L,dailyReset:true,fundVolatilityPct:Math.round(sd*1000)/10,underlyingVolatilityPct:Math.round(under*1000)/10,estimatedAnnualDragPct:Math.round((L*L-L)/2*under*under*1000)/10,note:'Returns compound daily, so over weeks they drift from the multiple of the index; the drag grows with volatility. Suited to short holding periods.'};}
      return {status:'ok',retrievedAt:main.retrievedAt,data:{...d,...(leverage?{leverage}:{})}};
    }
    if(name==='holdings'&&main.status==='ok'){
      // Sector names come from the market overview (KOSPI sector indices); load it once if it is not cached yet.
      if(!this.cached('MARKET','market'))await this.market();
      const names=new Map((this.cached('MARKET','market')?.value?.kospiSectors??[]).map(r=>[r.code,r.name]));const mix=new Map();
      for(const h of main.data.holdings??[]){const sector=this.master?.get?.(h.symbol)?.sector??null;const key=sector??'other';mix.set(key,(mix.get(key)??0)+h.weightPct);}
      const sectors=[...mix.entries()].map(([code,weightPct])=>({code:code==='other'?null:code,name:code==='other'?'Other or unlisted':names.get(code)??`Sector ${code}`,weightPct:Math.round(weightPct*10)/10})).sort((a,b)=>b.weightPct-a.weightPct);
      return {status:'ok',retrievedAt:main.retrievedAt,data:{...main.data,sectors:main.data.holdings?.length?sectors:[]}};
    }
    if(name==='risk'){
      if(main.status!=='ok')return main;const id=this.identity(symbol);const [code,label]=MARKET_INDEX[id.market]??MARKET_INDEX.KOSPI;
      const market=await this.source(code,'index-daily',refresh);const sector=id.sector&&id.sector!==code?await this.source(id.sector,'index-daily',refresh):null;
      const metrics=require('./kis-insights.cjs').riskMetrics(main.data.closes,market.status==='ok'?market.data.closes:[],sector?.status==='ok'?sector.data.closes:[]);
      if(!metrics)return {status:'unavailable',reason:'INSUFFICIENT_HISTORY'};
      return {status:'ok',retrievedAt:main.retrievedAt,data:{...metrics,marketIndex:label,sectorIndex:sector?.status==='ok'?id.sector:null,technicals:require('./indicators.cjs').technicals(main.data.closes),closes:main.data.closes.slice(-120).map(({date,close})=>({date,close}))}};
    }
    if(name==='valuation'){
      if(main.status!=='ok')return main;const o=ok('overview');const current={price:o?.price??null,per:o?.per??null,pbr:o?.pbr??null};
      const vs=(value,range)=>value&&range?.median?Math.round((value/range.median-1)*1000)/10:null;
      return {status:'ok',retrievedAt:main.retrievedAt,data:{...main.data,current,perVsMedianPct:vs(current.per,main.data.perRange),pbrVsMedianPct:vs(current.pbr,main.data.pbrRange)}};
    }
    if(name==='peers'){
      const id=this.identity(symbol);const list=this.master?.peers?.(symbol,5)??[];if(!list.length)return {status:'unavailable',reason:'NO_PEERS'};
      const rows=[];for(const peer of [{symbol,name:id.name,marketCap:id.marketCapKRW},...list]){const o=peer.symbol===symbol?main:await this.source(peer.symbol,'overview',refresh);const d=o.status==='ok'?o.data:{};
        rows.push({symbol:peer.symbol,name:peer.name,self:peer.symbol===symbol,marketCapKRW:d.marketCapKRW??peer.marketCap??null,per:d.per??null,pbr:d.pbr??null,changePct:d.changePct??null});}
      const median=key=>{const v=rows.filter(r=>!r.self&&r[key]!=null).map(r=>r[key]).sort((a,b)=>a-b);return v.length?v[Math.floor((v.length-1)/2)]:null;};const self=rows[0];
      const prem=(key,m)=>self[key]!=null&&m?Math.round((self[key]/m-1)*1000)/10:null;const perMedian=median('per'),pbrMedian=median('pbr');
      return {status:'ok',retrievedAt:main.status==='ok'?main.retrievedAt:this.clock(),data:{sector:id.sector,sectorName:main.status==='ok'?main.data.sectorName:null,rows,peerMedianPer:perMedian,peerMedianPbr:pbrMedian,perVsPeersPct:prem('per',perMedian),pbrVsPeersPct:prem('pbr',pbrMedian),note:'Peers are the largest listed stocks in the same KRX index sector.'}};
    }
    if(name==='factors')return this.factors(symbol,refresh);
    if(name==='fairvalue')return this.fairValue(symbol,parts,refresh);
    if((name==='analysts'||name==='estimates')&&main.status==='ok'){const trend=this.consensusTrend(symbol);return {status:'ok',retrievedAt:main.retrievedAt,data:{...main.data,...(trend?{consensusTrend:trend}:{})},...(main.stale?{stale:true}:{})};}
    return main.status==='ok'?{status:'ok',retrievedAt:main.retrievedAt,data:main.data,...(main.stale?{stale:true}:{})}:main;
  }
  // U.S. stocks: KIS quote and price history, SEC annual facts and filings.
  async usSection(symbol,name,refresh){
    if(!US_SECTIONS.includes(name))return {status:'unavailable',reason:'KOREAN_LISTINGS_ONLY'};
    if(name==='overview')return this.source(symbol,'overview',refresh);
    if(name==='risk'){
      const daily=await this.source(symbol,'daily',refresh);if(daily.status!=='ok')return daily;const market=await this.source('SPX','index-daily',refresh);
      const metrics=require('./kis-insights.cjs').riskMetrics(daily.data.closes,market.status==='ok'?market.data.closes:[],[]);if(!metrics)return {status:'unavailable',reason:'INSUFFICIENT_HISTORY'};
      return {status:'ok',retrievedAt:daily.retrievedAt,data:{...metrics,marketIndex:'S&P 500',sectorIndex:null,currency:'USD',technicals:require('./indicators.cjs').technicals(daily.data.closes),closes:daily.data.closes.slice(-120).map(({date,close})=>({date,close}))}};
    }
    const sec=await this.source(symbol,'sec',refresh);if(sec.status!=='ok')return sec;const d=sec.data;
    if(name==='financials')return {status:'ok',retrievedAt:sec.retrievedAt,data:{currency:'USD',source:'SEC 10-K filings',periods:d.annual.map(r=>({...r,period:'FY'+r.fiscalYearEnd.slice(0,4)+(r.fiscalYearEnd.slice(5,7)!=='12'?` (to ${r.fiscalYearEnd.slice(0,7)})`:'')}))}};
    if(name==='dividends'){
      const overview=await this.source(symbol,'overview');const price=overview.status==='ok'?overview.data.price:null;const latest=d.dividends.years[0];
      return {status:'ok',retrievedAt:sec.retrievedAt,data:{currency:'USD',payments:[],frequency:d.dividends.years.length?'reported':'none',trailing12mPerShare:null,trailingYieldPct:latest&&price?Math.round(latest.perShare/price*10000)/100:null,yieldBasis:latest?'Last fiscal year dividends per share over the current price':null,annualReport:{source:'SEC 10-K',years:d.dividends.years}}};
    }
    const today=seoulDate(this.clock());
    return {status:'ok',retrievedAt:sec.retrievedAt,data:{upcoming:d.earnings?.nextExpected&&d.earnings.nextExpected>=today?[{date:d.earnings.nextExpected,kind:'earnings',title:'Quarterly earnings (estimated date)',estimated:true}]:[],earnings:d.earnings,filings:d.filings,meetings:[]}};
  }
  // Korean market overview: breadth, sector moves and the day's largest foreign and institutional buying.
  async market(refresh=false){return this.source('MARKET','market',refresh);}
  // Factor ranks within the largest same-sector stocks: value, momentum, quality, growth and low volatility, as percentiles.
  async factors(symbol,refresh){
    const id=this.identity(symbol);const peers=this.master?.peers?.(symbol,8)??[];if(!peers.length)return {status:'unavailable',reason:'NO_PEERS'};
    const group=[];
    for(const p of [{symbol,name:id.name},...peers]){
      const [o,d,e]=[await this.source(p.symbol,'overview',refresh),await this.source(p.symbol,'daily',refresh),await this.source(p.symbol,'estimates',refresh)];
      const ov=o.status==='ok'?o.data:{},closes=d.status==='ok'?d.data.closes??[]:[],est=e.status==='ok'?e.data:{};
      const ret=k=>closes.length>k?(closes.at(-1).close/closes.at(-1-k).close-1)*100:null;
      const lr=closes.slice(1).map((c,i)=>Math.log(c.close/closes[i].close));const mean=lr.reduce((a,b)=>a+b,0)/(lr.length||1);const vol=lr.length>20?Math.sqrt(lr.reduce((a,b)=>a+(b-mean)**2,0)/(lr.length-1))*Math.sqrt(252)*100:null;
      const years=est.years??[],actual=years.map((y,i)=>[y,i]).filter(([y])=>!/E$/.test(y)).map(([,i])=>i).at(-1),next=years.findIndex(y=>/E$/.test(y));
      const at=(k,i)=>i!=null&&i>=0?est[k]?.[i]??null:null;
      group.push({symbol:p.symbol,name:p.name,self:p.symbol===symbol,metrics:{earningsYieldPct:ov.per>0?100/ov.per:null,bookYieldPct:ov.pbr>0?100/ov.pbr:null,return3mPct:ret(63),return1mPct:ret(21),roePct:at('roePct',actual),operatingMarginPct:at('revenue',actual)?at('operatingProfit',actual)/at('revenue',actual)*100:null,epsGrowthNextPct:at('epsGrowthPct',next),revenueGrowthNextPct:at('revenueGrowthPct',next),volatilityPct:vol}});
    }
    // Percentile of each metric among stocks that have it (higher is better; volatility is inverted), averaged per factor.
    const FACTORS={value:['earningsYieldPct','bookYieldPct'],momentum:['return3mPct','return1mPct'],quality:['roePct','operatingMarginPct'],growth:['epsGrowthNextPct','revenueGrowthNextPct'],lowVolatility:['volatilityPct']};
    const pctile=(key,row)=>{const v=row.metrics[key];const others=group.filter(g=>g!==row&&g.metrics[key]!=null);if(v==null||!others.length)return null;const better=key==='volatilityPct'?others.filter(g=>g.metrics[key]>v).length:others.filter(g=>g.metrics[key]<v).length;const ties=others.filter(g=>g.metrics[key]===v).length;return (better+ties/2)/others.length*100;};
    const score=row=>Object.fromEntries(Object.entries(FACTORS).map(([f,keys])=>{const v=keys.map(k=>pctile(k,row)).filter(x=>x!=null);return [f,v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):null];}));
    const round=v=>v==null?null:Math.round(v*10)/10;
    const rows=group.map(g=>({symbol:g.symbol,name:g.name,self:g.self||undefined,scores:score(g),metrics:Object.fromEntries(Object.entries(g.metrics).map(([k,v])=>[k,round(v)]))}));
    return {status:'ok',retrievedAt:this.clock(),data:{sector:id.sector,peers:rows.length-1,self:rows[0].scores,rows,note:'Scores are percentiles (0–100, higher is better) against the largest stocks in the same KRX sector: value from earnings and book yield, momentum from 1- and 3-month returns, quality from ROE and operating margin, growth from next-year EPS and revenue growth estimates, low volatility from daily price swings.'}};
  }
  // Fair value range from several simple methods; their spread is the uncertainty.
  async fairValue(symbol,parts,refresh){
    const ok=s=>parts[s]?.status==='ok'?parts[s].data:null;const o=ok('overview'),a=ok('analysts'),e=ok('estimates'),v=ok('valuation');if(!o?.price)return {status:'unavailable',reason:parts.overview?.reason??'NO_PRICE'};
    const next=e?.years?.findIndex(y=>/E$/.test(y))??-1;const eps=next>=0?e.eps?.[next]:null;const bps=o.bps>0?o.bps:null;
    const peers=await this.section(symbol,'peers',refresh);const pm=peers.status==='ok'?peers.data:{};
    const methods=[['Analyst median target',a?.medianTarget,a?`${a.brokerages} brokerages`:null],['Peer median PER × next-year EPS',pm.peerMedianPer&&eps>0?pm.peerMedianPer*eps:null,pm.peerMedianPer?`PER ${pm.peerMedianPer} × EPS ${eps}`:null],
      ['Own median PER × next-year EPS',v?.perRange?.median&&eps>0?v.perRange.median*eps:null,v?.perRange?`PER ${v.perRange.median} over ${v.perRange.years} years`:null],['Peer median PBR × book value',pm.peerMedianPbr&&bps?pm.peerMedianPbr*bps:null,pm.peerMedianPbr?`PBR ${pm.peerMedianPbr}`:null],
      ['Own median PBR × book value',v?.pbrRange?.median&&bps?v.pbrRange.median*bps:null,v?.pbrRange?`PBR ${v.pbrRange.median} over ${v.pbrRange.years} years`:null]]
      .filter(([,val])=>Number.isFinite(val)&&val>0).map(([method,val,basis])=>({method,value:Math.round(val),upsidePct:Math.round((val/o.price-1)*1000)/10,basis}));
    if(methods.length<2)return {status:'unavailable',reason:'NOT_ENOUGH_INPUTS'};
    const vals=methods.map(m=>m.value).sort((x,y)=>x-y);const mid=vals.length%2?vals[(vals.length-1)/2]:(vals[vals.length/2-1]+vals[vals.length/2])/2;const spread=(vals.at(-1)-vals[0])/mid;
    return {status:'ok',retrievedAt:this.clock(),data:{price:o.price,fairValue:Math.round(mid),upsidePct:Math.round((mid/o.price-1)*1000)/10,low:vals[0],high:vals.at(-1),uncertainty:spread<0.3?'low':spread<0.6?'medium':'high',spreadPct:Math.round(spread*1000)/10,methods,
      note:'The middle of simple valuation methods, not a forecast. A wide spread between methods means high uncertainty; analyst targets tend to run optimistic.'}};
  }
  // Daily consensus snapshots, so target and estimate revisions can be measured over weeks.
  snapshot(symbol,source,value){
    let fields=null;
    if(source==='analysts'&&value?.medianTarget)fields={medianTarget:value.medianTarget,brokerages:value.brokerages};
    if(source==='estimates'&&value?.forecastYears?.length){const i=value.years.indexOf(value.forecastYears[0]);if(i>=0)fields={estimateYear:value.forecastYears[0],eps:value.eps?.[i]??null,operatingProfit:value.operatingProfit?.[i]??null};}
    if(!fields)return;const day=seoulDate(this.clock());const old=this.db.prepare('SELECT payload FROM research_snapshots WHERE symbol=? AND day=?').get(symbol,day);
    this.db.prepare('INSERT INTO research_snapshots VALUES(?,?,?) ON CONFLICT(symbol,day) DO UPDATE SET payload=excluded.payload').run(symbol,day,JSON.stringify({...(old?JSON.parse(old.payload):{}),...fields}));
  }
  consensusTrend(symbol){
    const rows=this.db.prepare('SELECT day,payload FROM research_snapshots WHERE symbol=? ORDER BY day').all(symbol).map(r=>({day:r.day,...JSON.parse(r.payload)}));if(rows.length<2)return null;
    const today=rows.at(-1);const at=days=>{const target=new Date(Date.parse(today.day+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);return rows.filter(r=>r.day<=target).at(-1)??null;};
    const change=(from,key)=>from&&from[key]&&today[key]!=null&&(key!=='eps'&&key!=='operatingProfit'||from.estimateYear===today.estimateYear)?Math.round((today[key]/from[key]-1)*1000)/10:null;
    const out={};for(const [label,days] of [['1m',28],['3m',85]]){const from=at(days);if(!from||from.day===today.day)continue;out[label]={since:from.day,medianTargetChangePct:change(from,'medianTarget'),epsChangePct:change(from,'eps'),operatingProfitChangePct:change(from,'operatingProfit'),...(today.estimateYear?{estimateYear:today.estimateYear}:{})};}
    return Object.keys(out).length?out:{buildingSince:rows[0].day,note:'Revisions are measured from daily snapshots; a month of history is needed.'};
  }
  identity(symbol){const row=this.master?.get?.(symbol);return row?{name:row.name,market:row.market,type:row.type,sector:row.sector??null,marketCapKRW:row.marketCap??null}:{name:null};}
  async profile(symbol,{sections=SECTIONS,refresh=false}={}){
    const out={symbol,...this.identity(symbol),asOf:seoulDate(this.clock()),sections:{}};
    for(const name of sections.filter(s=>SECTIONS.includes(s)))out.sections[name]=await this.section(symbol,name,refresh);
    return out;
  }
  // Compact research for the agents: requested sections only, nulls removed, long lists shortened.
  async agent(args){
    const symbol=String(args?.symbol??'').trim().toUpperCase();
    const us=US.test(symbol);if(!us&&!/^\d{6}$/.test(symbol))return {status:'unavailable',reason:'INVALID_SYMBOL'};
    if(this.master?.status?.().total&&!this.master.get(symbol))return {status:'unavailable',reason:'UNKNOWN_SYMBOL'};
    const asked=Array.isArray(args?.sections)?args.sections.filter(s=>SECTIONS.includes(s)):[];const sections=asked.length?[...new Set(asked)]:us?US_DEFAULT:FUND_TYPES.has(this.identity(symbol).type)?FUND_DEFAULT:AGENT_DEFAULT;
    const profile=await this.profile(symbol,{sections});const out={symbol,name:profile.name,market:profile.market,asOf:profile.asOf};
    for(const [name,section] of Object.entries(profile.sections))out[name]=section.status==='ok'?digest(name,section.data):{unavailable:section.reason};
    out.note='Third-party and broker data; check dates. Analyst targets and estimates are opinions. Null fields were left out.';
    return prune(out);
  }
}
// Per-section shortening for the agents.
function digest(name,d){
  if(name==='analysts')return {...d,latest:d.latest?.slice(0,4),targetRevisions:d.targetRevisions?{...d.targetRevisions,recent:d.targetRevisions.recent.slice(0,3)}:undefined};
  if(name==='dividends')return {trailing12mPerShare:d.trailing12mPerShare,trailingYieldPct:d.trailingYieldPct,frequency:d.frequency,annualTotals:d.annualTotals?.slice(0,4),upcoming:d.upcoming,annualReport:d.annualReport?.years,annualReportUnavailable:d.annualReportUnavailable};
  if(name==='events')return {upcoming:d.upcoming?.slice(0,6),earnings:d.earnings,filings:d.filings?.filter(f=>!['ownership','periodic'].includes(f.kind)).slice(0,10).map(({date,kind,title})=>({date,kind,title})),filingsUnavailable:d.filingsUnavailable};
  if(name==='financials'&&d.currency==='USD')return {periods:(d.periods??[]).slice(0,4).map(({filed,...r})=>r),source:d.source};
  if(name==='financials')return {periods:(d.periods??[]).slice(0,4).map(({period,revenueKRW,operatingProfitKRW,netIncomeKRW,operatingMarginPct,netMarginPct,roePct,roaPct,debtRatioPct,currentRatioPct,revenueGrowthPct,operatingProfitGrowthPct,eps,bps,evToEbitda})=>({period,revenueKRW,operatingProfitKRW,netIncomeKRW,operatingMarginPct,netMarginPct,roePct,roaPct,debtRatioPct,currentRatioPct,revenueGrowthPct,operatingProfitGrowthPct,eps,bps,evToEbitda})),annualRatios:d.periods?.length?undefined:d.annualRatios,note:'Periods not ending in December are year to date.'};
  if(name==='valuation')return {...d,monthly:undefined};
  if(name==='peers')return {...d,rows:d.rows?.map(({symbol,name,self,marketCapKRW,per,pbr})=>({symbol,name,self:self||undefined,marketCapKRW,per,pbr}))};
  if(name==='flows')return {...d,investors:d.investors?{...d.investors,daily:undefined}:undefined,note:'Net buying in KRW; positive streak days mean consecutive net buying, negative mean selling. Short share is the percent of daily volume sold short; margin rate is loans outstanding as a percent of listed shares.'};
  if(name==='risk')return {...d,closes:undefined,technicals:d.technicals?{...d.technicals,note:undefined}:undefined};
  if(name==='factors')return {self:d.self,peers:d.peers,rows:d.rows?.map(({symbol,name,self,scores})=>({symbol,name,self,scores})),note:d.note};
  if(name==='fund')return {...d,premiumHistory:undefined};
  if(name==='holdings')return {...d,holdings:d.holdings?.slice(0,15).map(({symbol,name,weightPct})=>({symbol,name,weightPct}))};
  return d;
}
module.exports={ResearchService,SECTIONS,AGENT_DEFAULT,US_SECTIONS,prune,digest};
