const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const zlib=require('node:zlib');
const insights=require('../electron/kis-insights.cjs');const dart=require('../electron/dart.cjs');const {ResearchService,prune}=require('../electron/research-service.cjs');

test('KSD dividend rows become payments, a trailing yield and calendar-year totals; unset amounts stay pending',()=>{
  const row=(date,amount,kind='분기',pay='')=>({record_date:date,sht_cd:'005930',divi_kind:kind,per_sto_divi_amt:String(amount),divi_pay_dt:pay,stk_divi_rate:'0.00'});
  const d=insights.dividends([row('20260930',0),row('20260630',374,'분기','2026/08/28'),row('20260331',374),row('20251231',546,'결산'),row('20250930',361),row('20250930',361),{...row('20250630',361),sht_cd:'005935'}],'005930',217000,'2026-10-17');
  assert.equal(d.payments[0].pending,true,'the 30 Sept amount is not set yet');assert.equal(d.payments[0].perShare,null);
  assert.equal(d.trailing12mPerShare,374+374+546,'paid record dates in the last 365 days');assert.equal(d.trailingYieldPct,Math.round(1294/217000*10000)/100);
  assert.equal(d.frequency,'quarterly','a pending record date still counts');assert.equal(d.payments.filter(p=>p.recordDate==='2025-09-30').length,1,'duplicates removed');assert.ok(!d.payments.some(p=>p.recordDate==='2025-06-30'),'other share classes are excluded');
  assert.deepEqual(d.annualTotals.map(y=>[y.year,y.perShare]),[['2026',748],['2025',907]]);assert.equal(d.payments[1].payDate,'2026-08-28');
  assert.equal(insights.dividends([],'005930',100,'2026-10-17').frequency,'none');
});
test('shareholder meetings group agenda items by date; target revisions count raises and cuts per brokerage',()=>{
  const m=insights.meetings([{gen_meet_dt:'2026/03/18',gen_meet_type:'정기총회',agenda:'정관변경',record_date:'20251231'},{gen_meet_dt:'2026/03/18',gen_meet_type:'정기총회',agenda:'이사선임'},{gen_meet_dt:'2026/03/18',agenda:'정관변경'},{gen_meet_dt:'2025/03/19',agenda:'재무제표승인'}]);
  assert.equal(m.length,2);assert.deepEqual(m[0].agenda,['정관변경','이사선임']);assert.equal(m[0].recordDate,'2025-12-31');
  const note=(date,firm,target)=>({stck_bsop_date:date,mbcr_name:firm,hts_goal_prc:String(target),invt_opnn:'BUY'});
  const r=insights.revisions([note('20261010','A',300000),note('20260801','A',250000),note('20261001','B',200000),note('20260901','B',220000),note('20261002','C',100000),note('20260101','D',90000),note('20250101','D',80000)],'2026-10-17').targetRevisions;
  assert.equal(r.raised,1);assert.equal(r.cut,1);assert.equal(r.recent[0].firm,'A');assert.equal(r.recent[0].changePct,20);assert.ok(!r.recent.some(x=>x.firm==='D'),'notes outside the window are left out');
  assert.equal(insights.revisions([note('20261010','A',1)],'2026-10-17'),null,'a single note is no revision');
});
test('sections call the documented read-only KIS endpoints with the right parameters',async()=>{
  const calls=[];const client={quotation:async(endpoint,tr,params)=>{calls.push({endpoint,tr,params});
    if(tr==='FHKST01010100')return {output:{stck_prpr:'217000',per:'33.06',pbr:'3.39',hts_avls:'12686425',w52_hgpr:'374500',w52_lwpr:'94500',hts_frgn_ehrt:'49.1',bstp_kor_isnm:'전기·전자'}};
    if(tr==='HHKDB669102C0')return {output1:[{record_date:'20260630',sht_cd:'005930',divi_kind:'분기',per_sto_divi_amt:'374'}]};
    if(tr==='HHKDB669111C0')return {output1:[{gen_meet_dt:'2027/03/18',agenda:'정관변경'}]};throw new Error('unexpected');}};
  const o=await insights.fetchSection(client,'005930','overview','2026-10-17');assert.equal(o.marketCapKRW,12686425e8);assert.equal(o.sectorName,'전기·전자');
  const d=await insights.fetchSection(client,'005930','dividends','2026-10-17');assert.equal(d.trailingYieldPct,0.17);
  const div=calls.find(c=>c.tr==='HHKDB669102C0');assert.equal(div.endpoint,'/uapi/domestic-stock/v1/ksdinfo/dividend');assert.equal(div.params.SHT_CD,'005930');assert.equal(div.params.T_DT,'20270415','includes announced future record dates');
  assert.equal((await insights.fetchSection(client,'005930','meetings','2026-10-17')).meetings[0].date,'2027-03-18');
  await assert.rejects(insights.fetchSection(client,'NASD:AAPL','overview','2026-10-17'),/INVALID_INSTRUMENT/);await assert.rejects(insights.fetchSection(client,'005930','nope','2026-10-17'),/UNKNOWN_SECTION/);
});
// A ZIP written the way DART writes it: sizes only in the data descriptor and the central directory.
function zipWithDescriptor(name,content){
  const data=zlib.deflateRawSync(Buffer.from(content));const nameBuf=Buffer.from(name);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,6);local.writeUInt16LE(8,8);local.writeUInt16LE(nameBuf.length,26);
  const desc=Buffer.alloc(16);desc.writeUInt32LE(0x08074b50,0);desc.writeUInt32LE(data.length,8);desc.writeUInt32LE(content.length,12);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,8);central.writeUInt16LE(8,10);central.writeUInt32LE(data.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(nameBuf.length,28);central.writeUInt32LE(0,42);
  const cdOffset=30+nameBuf.length+data.length+16;const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+nameBuf.length,12);end.writeUInt32LE(cdOffset,16);
  return Buffer.concat([local,nameBuf,data,desc,central,nameBuf,end]);
}
test('the DART corp-code archive is read through its central directory and maps listed stock codes',()=>{
  const xml='<result><list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SAMSUNG</corp_eng_name><stock_code>005930</stock_code><modify_date>20260101</modify_date></list><list><corp_code>00999999</corp_code><corp_name>비상장</corp_name><stock_code> </stock_code></list></result>';
  const map=dart.parseCorpCodes(dart.unzipFirst(zipWithDescriptor('CORPCODE.xml',xml)).toString('utf8'));
  assert.equal(map.get('005930'),'00126380');assert.equal(map.size,1,'unlisted companies are skipped');assert.throws(()=>dart.unzipFirst(Buffer.from('not a zip')),/DART_FORMAT/);
});
test('DART filings are classified, insider noise is dropped and the next earnings date is estimated from the last release',()=>{
  const row=(no,date,title)=>({rcept_no:no,rcept_dt:date,report_nm:title,flr_nm:'삼성전자'});
  const list=dart.disclosures([row('20261008000001','20261008','연결재무제표기준영업(잠정)실적(공정공시)'),row('20261008000002','20261008','기업설명회(IR)개최(안내공시)'),row('20261016000003','20261016','임원ㆍ주요주주특정증권등소유상황보고서'),row('20261012000004','20261012','자기주식취득결과보고서'),row('20260814000005','20260814','반기보고서 (2026.06)'),row('20260814000005','20260814','반기보고서 (2026.06)'),row('20260301000006','20260301','[기재정정]단일판매ㆍ공급계약체결'),row('20260201000007','20260201','현금ㆍ현물배당결정')]);
  assert.deepEqual(list.map(f=>f.kind),['buyback','earnings','ir','periodic','contract','dividend']);assert.equal(list.find(f=>f.kind==='contract').amended,true);assert.ok(list[0].url.endsWith('20261012000004'));
  const timing=dart.earningsTiming(list,'2026-10-17');assert.equal(timing.daysAfterQuarterEnd,8);assert.equal(timing.nextExpected,'2027-01-08');
  assert.equal(dart.earningsTiming([],'2026-10-17'),null);
});
test('the annual report dividend table gives per-share dividends, payout and yield for three years',()=>{
  const r=(se,kind,a,b,c)=>({se,stock_knd:kind,thstrm:a,frmtrm:b,lwfr:c,stlm_dt:'2025-12-31'});
  const t=dart.dividendTable([r('주당액면가액(원)','-','100','100','100'),r('(연결)현금배당성향(%)','-','25.10','29.20','67.80'),r('현금배당수익률(%)','보통주','1.50','2.70','1.90'),r('현금배당수익률(%)','우선주','1.90','3.30','2.40'),r('주당 현금배당금(원)','보통주','1,668','1,446','1,444'),r('현금배당금총액(백만원)','-','11,107,906','9,810,767','-')]);
  assert.deepEqual(t.years[0],{year:'2025',perShare:1668,payoutRatioPct:25.1,yieldPct:1.5,totalKRW:11107906e6,eps:null});assert.equal(t.years[2].year,'2023');assert.equal(t.years[2].totalKRW,null);
  assert.equal(dart.dividendTable([]),null);
});
function service({kis,provider,dartReady=true,clock}={}){
  const db=new DatabaseSync(':memory:');const calls=[];let now=clock??Date.parse('2026-10-17T01:00:00Z');
  const s=new ResearchService({db,master:{get:symbol=>symbol==='005930'?{name:'삼성전자',market:'KOSPI',type:'stock'}:null,status:()=>({total:1})},
    kis:kis??(async(op,{section})=>{calls.push(section);if(section==='overview')return {price:217000,per:33,pbr:null};if(section==='dividends')return {trailingYieldPct:0.6,frequency:'quarterly',upcoming:[{recordDate:'2026-12-31',kind:'결산',perShare:null,pending:true}],payments:[]};if(section==='meetings')return {meetings:[{date:'2027-03-18',type:'정기총회',agenda:['정관변경']}]};if(section==='analysts')return {brokerages:3,latest:[1,2,3,4,5,6]};if(section==='estimates')return {years:['2025']};throw Object.assign(new Error('x'),{code:'RATE_LIMITED'});}),
    provider:provider??(async()=>{calls.push('dart');return {filings:[{date:'2026-10-08',kind:'earnings',title:'잠정실적'},{date:'2026-10-01',kind:'ownership',title:'대량보유'}],earnings:{lastRelease:'2026-10-08',nextExpected:'2027-01-08'},dividends:{years:[{year:'2025',perShare:1668,payoutRatioPct:25.1}]}};}),
    kisReady:()=>true,dartReady:()=>dartReady,clock:()=>now});
  return {s,calls,advance:ms=>{now+=ms;}};
}
test('research sections are cached per source, fall back to saved data on failure and compose events from KIS and DART',async()=>{
  const {s,calls,advance}=service();
  const first=await s.section('005930','overview');assert.equal(first.data.price,217000);await s.section('005930','overview');assert.deepEqual(calls,['overview'],'served from cache');
  advance(20*60000);await s.section('005930','overview');assert.equal(calls.length,2,'overview refreshes after 15 minutes');
  const events=await s.section('005930','events');assert.deepEqual(events.data.upcoming.map(e=>e.kind),['dividend','earnings','meeting']);assert.ok(events.data.upcoming[1].estimated);assert.equal(events.data.filings.length,2);
  const div=await s.section('005930','dividends');assert.equal(div.data.annualReport.years[0].payoutRatioPct,25.1,'the DART table joins the KSD schedule');assert.equal(calls.filter(c=>c==='dart').length,1,'DART fetched once for both sections');
  assert.equal((await s.section('005930','financials')).reason,'RATE_LIMITED');
  const flaky=service({kis:async()=>{throw Object.assign(new Error('x'),{code:'RATE_LIMITED'});}});flaky.s.db.prepare('INSERT INTO research_cache VALUES(?,?,?,?)').run('005930','overview',0,JSON.stringify({price:1}));
  const stale=await flaky.s.section('005930','overview');assert.equal(stale.stale,true);assert.equal(stale.data.price,1,'saved data is shown when a refresh fails');
  assert.equal((await s.section('NASD:AAPL','overview')).reason,'KOREAN_LISTINGS_ONLY');
});
test('without a DART key, dividends still load from KIS and filings say what is missing',async()=>{
  const {s,calls}=service({dartReady:false});
  const div=await s.section('005930','dividends');assert.equal(div.status,'ok');assert.equal(div.data.annualReportUnavailable,'DART_KEY_MISSING');
  const ev=await s.section('005930','events');assert.equal(ev.data.filingsUnavailable,'DART_KEY_MISSING');assert.equal(ev.data.upcoming.length,2);assert.ok(!calls.includes('dart'));
});
test('the agent view reads default sections, drops empty values and shortens lists',async()=>{
  const {s,calls}=service();
  const v=await s.agent({symbol:'005930',sections:[]});assert.deepEqual(Object.keys(v).filter(k=>!['symbol','name','market','asOf','note'].includes(k)).sort(),['analysts','dividends','estimates','overview']);
  assert.equal(v.overview.pbr,undefined,'nulls are dropped');assert.equal(v.analysts.latest.length,4);assert.equal(v.name,'삼성전자');assert.equal(v.dividends.annualReport[0].year,'2025');
  const e=await s.agent({symbol:'005930',sections:['events','bogus']});assert.ok(e.events.filings.every(f=>f.kind!=='ownership'),'ownership reports are left out for the agents');assert.equal(e.overview,undefined);
  assert.equal((await s.agent({symbol:'000000',sections:[]})).reason,'UNKNOWN_SYMBOL');assert.equal((await s.agent({symbol:'NASD:AAPL',sections:[]})).reason,'KOREAN_LISTINGS_ONLY');
  assert.deepEqual(prune({a:null,b:[],c:{d:''},e:0}),{e:0});
});
test('trading reviews with discovery can read company research; the scout tool takes sections',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const {RESEARCH_TOOL,RESEARCH_SECTIONS}=require('../electron/scout.cjs');const bodies=[];
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok'})}]}]}));});
  await client.decide({universe:[],discovery:{enabled:true}},{research:true});assert.ok(bodies[0].tools.some(t=>t.name==='get_company_research'));
  assert.deepEqual(RESEARCH_TOOL.parameters.required,['symbol','sections']);assert.deepEqual(RESEARCH_TOOL.parameters.properties.sections.items.enum,RESEARCH_SECTIONS);
});
test('investor flows, short selling, margin and program trading summarize the latest days',()=>{
  const day=i=>new Date(Date.parse('2026-10-16T00:00:00Z')-i*86400000).toISOString().slice(0,10).replaceAll('-','');
  const inv=insights.investorFlows(Array.from({length:25},(_,i)=>({stck_bsop_date:day(i),stck_clpr:'1000',frgn_ntby_tr_pbmn:i<3?'100':'-50',orgn_ntby_tr_pbmn:'-10',prsn_ntby_tr_pbmn:'5'})).reverse());
  assert.equal(inv.asOf,'2026-10-16');assert.equal(inv.net5d.foreignKRW,(300-100)*1e6);assert.equal(inv.net20d.institutionKRW,-200*1e6);assert.equal(inv.foreignStreakDays,3);assert.equal(inv.institutionStreakDays,-25);assert.equal(inv.daily.length,10);
  const sh=insights.shortSelling([{stck_bsop_date:'20261016',ssts_vol_rlim:'4.65',ssts_tr_pbmn:'190925494500'},{stck_bsop_date:'20261015',ssts_vol_rlim:'0.46'}]);assert.equal(sh.latestSharePct,4.65);assert.equal(sh.avg5dSharePct,2.56);
  const cr=insights.creditBalance([{deal_date:'20261013',whol_loan_rmnd_rate:'0.35',whol_loan_rmnd_stcn:'21400267'},{deal_date:'20261012',whol_loan_rmnd_rate:'0.36',whol_loan_rmnd_stcn:'20000000'}]);assert.equal(cr.balanceRatePct,0.35);assert.equal(cr.changeSharesPct,7);assert.equal(cr.changeSince,'2026-10-12');
  const pg=insights.programTrading([{stck_bsop_date:'20261016',whol_smtn_ntby_tr_pbmn:'213464686750'},{stck_bsop_date:'20261015',whol_smtn_ntby_tr_pbmn:'2587463000'}]);assert.equal(pg.net5dKRW,213464686750+2587463000);
  assert.equal(insights.investorFlows([]),null);assert.equal(insights.shortSelling(undefined),null);
});
test('risk metrics: volatility, beta to the market, relative returns and drawdown from daily closes',()=>{
  const dates=Array.from({length:80},(_,i)=>new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
  const marketMoves=dates.map((_,i)=>Math.sin(i)*0.01);let m=1000,s=100;const market=[],stock=[],sector=[];
  dates.forEach((date,i)=>{m*=Math.exp(marketMoves[i]);s*=Math.exp(2*marketMoves[i]+0.002);market.push({date,close:m});stock.push({date,close:s,value:1e9});sector.push({date,close:m});});
  const r=insights.riskMetrics(stock,market,sector);
  assert.equal(r.market.beta,2,'stock moves twice the market');assert.equal(r.market.correlation,1);assert.ok(r.annualizedVolatilityPct>0);assert.ok(r.vsMarket1mPct>0,'the drift beats the market');
  assert.ok(r.maxDrawdownPct<=0);assert.equal(r.avgDailyValue20dKRW,1e9);assert.equal(insights.riskMetrics(stock.slice(0,10)),null,'too little history');
  const solo=insights.riskMetrics(stock,[],[]);assert.equal(solo.market,null);assert.equal(solo.vsSector1mPct,null);
});
test('the flows section survives a failing source; index history is read in two windows',async()=>{
  const calls=[];const client={quotation:async(endpoint,tr,params)=>{calls.push({tr,params});if(tr==='FHPST04830000')throw new Error('BROKER_REJECTED');
    if(tr==='FHKST01010900')return {output:[{stck_bsop_date:'20261016',frgn_ntby_tr_pbmn:'1',orgn_ntby_tr_pbmn:'1',prsn_ntby_tr_pbmn:'1'}]};if(tr==='FHPST04760000'||tr==='FHPPG04650201')return {output:[]};
    if(tr==='FHKUP03500100')return {output2:[{stck_bsop_date:params.FID_INPUT_DATE_2,bstp_nmix_prpr:'5000'}]};throw new Error('unexpected');}};
  const f=await insights.fetchSection(client,'005930','flows','2026-10-17');assert.ok(f.investors);assert.equal(f.shortSelling,null);
  const idx=await insights.fetchSection(client,'0013','index-daily','2026-10-17');assert.equal(idx.closes.length,2);assert.deepEqual(calls.filter(c=>c.tr==='FHKUP03500100').map(c=>c.params.FID_INPUT_ISCD),['0013','0013']);
  await assert.rejects(insights.fetchSection({quotation:async()=>{throw new Error('x');}},'005930','flows','2026-10-17'),/DATA_SOURCE_UNAVAILABLE/);
});
test('the risk section joins the stock with its market and sector indices',async()=>{
  const dates=Array.from({length:40},(_,i)=>new Date(Date.parse('2026-08-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));const series=k=>dates.map((date,i)=>({date,close:100+i*k+(i%3)}));const asked=[];
  const db=new DatabaseSync(':memory:');const s=new ResearchService({db,master:{get:()=>({name:'기아',market:'KOSPI',type:'stock',sector:'0015'}),status:()=>({total:1})},kis:async(op,{symbol,section})=>{asked.push(section+':'+symbol);return section==='daily'?{closes:series(2)}:{closes:series(1)};},provider:async()=>null});
  const r=await s.section('000270','risk');assert.equal(r.status,'ok');assert.equal(r.data.marketIndex,'KOSPI');assert.equal(r.data.sectorIndex,'0015');assert.ok(r.data.market.beta>0);assert.equal(r.data.closes.length,40);
  assert.deepEqual(asked,['daily:000270','index-daily:0001','index-daily:0015']);
  await s.section('005380','risk');assert.equal(asked.filter(a=>a==='index-daily:0001').length,1,'index history is shared across stocks');
  const v=await s.agent({symbol:'000270',sections:['risk']});assert.equal(v.risk.closes,undefined,'the price series stays out of the agent view');
});
test('the symbol master keeps each Korean stock sector and market cap and finds the largest peers',()=>{
  const {parseDomestic,SecurityMaster}=require('../electron/security-master.cjs');
  const row=(code,large,mid,cap,tail=227)=>{const head=Buffer.concat([Buffer.from(code.padEnd(9)),Buffer.from(('KR7'+code+'000').padEnd(12)),Buffer.from('X'.padEnd(40))]);const end='20260630'+String(cap).padStart(9,'0')+'511NNY';const body=('ST1'+large+mid+'0000').padEnd(tail-end.length)+end;return Buffer.concat([head,Buffer.from(body,'latin1'),Buffer.from('\n')]);};
  const rows=parseDomestic(Buffer.concat([row('005930','0027','0013',12277185),row('000660','0027','0013',9000000),row('066570','0027','0013',150000),row('105560','0021','0000',555795),row('069500','0000','0000',0)]),'KOSPI',227);
  assert.deepEqual(rows.map(r=>[r.symbol,r.sector,r.marketCap]),[['005930','0013',12277185e8],['000660','0013',9000000e8],['066570','0013',150000e8],['105560','0021',555795e8],['069500',null,null]]);
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,englishName TEXT NOT NULL,market TEXT NOT NULL,type TEXT NOT NULL,isin TEXT NOT NULL,industry TEXT);CREATE TABLE security_master_meta(market TEXT PRIMARY KEY,count INTEGER NOT NULL,updatedAt INTEGER NOT NULL);INSERT INTO security_master_meta VALUES('KOSPI',1,"+Date.now()+")");
  const master=new SecurityMaster(db,async()=>({ok:false}));assert.equal(master.status().markets.length,0,'an older list is refreshed to fill the new columns');
  master.replace('KOSPI',rows.map(r=>({...r,type:r.symbol==='069500'?'etf':'stock'})));assert.deepEqual(master.peers('005930').map(p=>p.symbol),['000660','066570']);assert.deepEqual(master.peers('069500'),[]);
});
