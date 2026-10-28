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
  await assert.rejects(insights.fetchSection(client,'AAPL','overview','2026-10-17'),/INVALID_INSTRUMENT/);await assert.rejects(insights.fetchSection(client,'005930','nope','2026-10-17'),/UNKNOWN_SECTION/);
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
    provider:provider??(async()=>{calls.push('dart');return {version:2,preliminary:null,filings:[{date:'2026-10-08',kind:'earnings',title:'잠정실적'},{date:'2026-10-01',kind:'ownership',title:'대량보유'}],earnings:{lastRelease:'2026-10-08',nextExpected:'2027-01-08'},dividends:{years:[{year:'2025',perShare:1668,payoutRatioPct:25.1}]}};}),
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
  assert.equal((await s.section('NASD:AAPL','flows')).reason,'KOREAN_LISTINGS_ONLY','U.S. stocks have no Korean flow data');
});
test('without a DART key, dividends still load from KIS and filings say what is missing',async()=>{
  const {s,calls}=service({dartReady:false});
  const div=await s.section('005930','dividends');assert.equal(div.status,'ok');assert.equal(div.data.annualReportUnavailable,'DART_KEY_MISSING');
  const ev=await s.section('005930','events');assert.equal(ev.data.filingsUnavailable,'DART_KEY_MISSING');assert.equal(ev.data.upcoming.length,2);assert.ok(!calls.includes('dart'));
});
test('the agent view reads default sections, drops empty values and shortens lists',async()=>{
  const {s,calls}=service();
  const v=await s.agent({symbol:'005930',sections:[]});assert.deepEqual(Object.keys(v).filter(k=>!['symbol','name','market','asOf','note','instrument','provenance'].includes(k)).sort(),['analysts','dividends','estimates','overview']);
  assert.equal(v.overview.pbr,undefined,'nulls are dropped');assert.equal(v.analysts.latest.length,4);assert.equal(v.name,'삼성전자');assert.equal(v.dividends.annualReport[0].year,'2025');
  const e=await s.agent({symbol:'005930',sections:['events','bogus']});assert.ok(e.events.filings.every(f=>f.kind!=='ownership'),'ownership reports are left out for the agents');assert.equal(e.overview,undefined);
  assert.equal((await s.agent({symbol:'000000',sections:[]})).reason,'UNKNOWN_SYMBOL');assert.equal((await s.agent({symbol:'NASD:AAPL',sections:[]})).reason,'UNKNOWN_SYMBOL','symbols must be in the symbol list');
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
test('financial statements merge by period, scale amounts to KRW and treat 99.99 as missing',()=>{
  const rows=insights.statements({income:[{stac_yymm:'202606',sale_account:'3053729.00',sale_totl_prfi:'2012139',bsop_prti:'1467252.00',thtr_ntin:'1188497.00',depr_cost:'99.99'},{stac_yymm:'202512',sale_account:'3336059.00',bsop_prti:'436011.00',thtr_ntin:'452068.00'}],
    balance:[{stac_yymm:'202512',total_aset:'5669421.00',total_lblt:'1306218.00',total_cptl:'4363203.00',cfp_surp:'99.99'}],ratio:[{stac_yymm:'202512',grs:'10.88',roe_val:'10.85',eps:'6564.00',bps:'63997.00',lblt_rate:'29.94'}],
    other:[{stac_yymm:'202512',payout_rate:'0.00',ebitda:'905276.00',ev_ebitda:'7.67'}],stability:[{stac_yymm:'202512',crnt_rate:'232.76',quck_rate:'0.00'}]});
  assert.deepEqual(rows.map(r=>r.period),['2026 to Jun','FY2025']);assert.equal(rows[1].revenueKRW,3336059e8);assert.equal(rows[1].operatingMarginPct,13.1);
  assert.equal(rows[1].payoutRatioPct,undefined,'a zero payout is a placeholder');assert.equal(rows[1].quickRatioPct,undefined);assert.equal(rows[1].evToEbitda,7.67);assert.equal(rows[0].yearEnd,false);assert.ok(!('cfp' in rows[1]));
});
test('valuation history pairs December closes with that year EPS and BPS',()=>{
  const v=insights.valuationHistory([{stck_bsop_date:'20261016',stck_clpr:'217000'},{stck_bsop_date:'20251230',stck_clpr:'120000'},{stck_bsop_date:'20241230',stck_clpr:'53000'},{stck_bsop_date:'20231228',stck_clpr:'78500'},...Array.from({length:30},(_,i)=>({stck_bsop_date:`2022${String(1+(i%12)).padStart(2,'0')}28`,stck_clpr:'60000'}))],
    [{stac_yymm:'202606',eps:'17687',bps:'86052'},{stac_yymm:'202512',eps:'6564',bps:'63997'},{stac_yymm:'202412',eps:'4950',bps:'57951'},{stac_yymm:'202312',eps:'2131',bps:'52002'},{stac_yymm:'202112',eps:'5777',bps:'43611'}]);
  assert.deepEqual(v.years.map(y=>[y.year,y.per]),[['2025',18.3],['2024',10.7],['2023',36.8]],'years without a December close are skipped');
  assert.deepEqual(v.perRange,{min:10.7,median:18.3,max:36.8,years:3});assert.equal(v.years[0].pbr,1.88);
});
test('valuation compares current multiples with history; peers compare with the largest same-sector stocks',async()=>{
  const db=new DatabaseSync(':memory:');const overview={'005930':{price:217000,per:33,pbr:3.4,marketCapKRW:1268e12,sectorName:'전기·전자'},'000660':{per:20,pbr:5,marketCapKRW:900e12},'066570':{per:10,pbr:1,marketCapKRW:15e12},'009150':{per:null,pbr:2}};
  const s=new ResearchService({db,master:{get:symbol=>({name:symbol,market:'KOSPI',type:'stock',sector:'0013',marketCap:1}),status:()=>({total:1}),peers:()=>[{symbol:'000660',name:'SK하이닉스',marketCap:9e14},{symbol:'066570',name:'LG전자',marketCap:1e13},{symbol:'009150',name:'삼성전기',marketCap:1e13}]},
    kis:async(op,{symbol,section})=>section==='overview'?overview[symbol]:section==='valuation'?{years:[],perRange:{min:10,median:20,max:40},pbrRange:{min:1,median:2,max:4}}:null,provider:async()=>null});
  const v=await s.section('005930','valuation');assert.equal(v.data.perVsMedianPct,65);assert.equal(v.data.pbrVsMedianPct,70);assert.equal(v.data.current.price,217000);
  const p=await s.section('005930','peers');assert.equal(p.data.rows.length,4);assert.equal(p.data.rows[0].self,true);assert.equal(p.data.peerMedianPer,10,'median of peers with a PER');assert.equal(p.data.peerMedianPbr,2);assert.equal(p.data.perVsPeersPct,230);assert.equal(p.data.sectorName,'전기·전자');
  const agent=await s.agent({symbol:'005930',sections:['peers','valuation']});assert.equal(agent.peers.rows[1].changePct,undefined);assert.equal(agent.valuation.monthly,undefined);
  const lonely=new ResearchService({db:new DatabaseSync(':memory:'),master:{get:()=>({name:'x'}),status:()=>({total:1}),peers:()=>[]},kis:async()=>({}),provider:async()=>null});assert.equal((await lonely.section('005930','peers')).reason,'NO_PEERS');
});
test('daily consensus snapshots turn into one- and three-month revision trends',async()=>{
  let now=Date.parse('2026-06-01T01:00:00Z');let target=100000,eps=5000;const db=new DatabaseSync(':memory:');
  const s=new ResearchService({db,master:{get:()=>({name:'x'}),status:()=>({total:1})},kis:async(op,{section})=>section==='analysts'?{medianTarget:target,brokerages:10}:{years:['2025','2026E'],forecastYears:['2026E'],eps:[4000,eps],operatingProfit:[1,2]},provider:async()=>null,clock:()=>now});
  await s.section('005930','analysts',true);assert.equal((await s.section('005930','estimates',true)).data.consensusTrend,undefined,'one day is no trend');
  now+=86400000;await s.section('005930','analysts',true);assert.equal((await s.section('005930','analysts')).data.consensusTrend.buildingSince,'2026-06-01');
  for(let day=0;day<95;day++){now+=86400000;target+=500;eps+=10;await s.section('005930','analysts',true);await s.section('005930','estimates',true);}
  const t=(await s.section('005930','analysts')).data.consensusTrend;assert.ok(t['1m'].medianTargetChangePct>0);assert.ok(t['3m'].medianTargetChangePct>t['1m'].medianTargetChangePct);assert.ok(t['1m'].epsChangePct>0);assert.equal(t['1m'].estimateYear,'2026E');
});
test('the financials section reads all statements and still answers when some fail',async()=>{
  const asked=[];const client={quotation:async(endpoint,tr)=>{asked.push(tr);if(tr==='FHKST66430100')throw new Error('BROKER_REJECTED');if(tr==='FHKST66430300')return {output:[{stac_yymm:'202512',roe_val:'10',eps:'1'}]};return {output:[]};}};
  const f=await insights.fetchSection(client,'005930','financials','2026-10-17');assert.equal(asked.length,7);assert.equal(f.periods[0].period,'FY2025');assert.equal(f.annualRatios[0].roePct,10);
  await assert.rejects(insights.fetchSection({quotation:async()=>{throw new Error('x');}},'005930','financials','2026-10-17'),/DATA_SOURCE_UNAVAILABLE/);
});
const sec=require('../electron/sec.cjs');
test('SEC tickers map class shares to app symbols; annual facts keep full-year 10-K values and derive margins',()=>{
  const t=sec.parseTickers({0:{cik_str:320193,ticker:'AAPL',title:'Apple Inc.'},1:{cik_str:1067983,ticker:'BRK-B',title:'Berkshire'},2:{ticker:'BAD'}});assert.equal(t.get('BRK.B').cik,1067983);assert.equal(t.size,2);
  const fact=(start,end,val,form='10-K',filed='2025-11-01',fp='FY')=>({start,end,val,form,filed,fp});
  const facts={facts:{'us-gaap':{
    RevenueFromContractWithCustomerExcludingAssessedTax:{units:{USD:[fact('2023-10-01','2024-09-28',391e9),fact('2024-09-29','2025-09-27',416e9),fact('2025-06-29','2025-09-27',102e9,'10-K'),fact('2024-09-29','2025-09-27',1,'10-Q','2025-08-01','Q3')]}},
    OperatingIncomeLoss:{units:{USD:[fact('2024-09-29','2025-09-27',133e9)]}},NetIncomeLoss:{units:{USD:[fact('2024-09-29','2025-09-27',112e9),fact('2024-09-29','2025-09-27',111e9,'10-K','2024-12-01')]}},
    EarningsPerShareDiluted:{units:{'USD/shares':[fact('2023-10-01','2024-09-28',6.08),fact('2024-09-29','2025-09-27',7.46)]}},
    CommonStockDividendsPerShareDeclared:{units:{'USD/shares':[fact('2024-09-29','2025-09-27',1.02)]}},
    StockholdersEquity:{units:{USD:[{end:'2025-09-27',val:74e9,form:'10-K',fp:'FY',filed:'2025-11-01'}]}},LongTermDebtNoncurrent:{units:{USD:[{end:'2025-09-27',val:78e9,form:'10-K',fp:'FY',filed:'2025-11-01'}]}},
    NetCashProvidedByUsedInOperatingActivities:{units:{USD:[fact('2024-09-29','2025-09-27',111e9)]}},PaymentsToAcquirePropertyPlantAndEquipment:{units:{USD:[fact('2024-09-29','2025-09-27',12e9)]}}}}};
  const [y,prev]=sec.annualFacts(facts);
  assert.equal(y.fiscalYearEnd,'2025-09-27');assert.equal(y.revenueUSD,416e9,'quarter durations and 10-Q facts are ignored');assert.equal(y.netIncomeUSD,112e9,'the latest filing wins');
  assert.equal(y.operatingMarginPct,32);assert.equal(y.freeCashFlowUSD,99e9);assert.equal(y.payoutRatioPct,13.7);assert.equal(y.debtToEquity,1.05);assert.equal(y.revenueGrowthPct,6.4);assert.equal(y.epsGrowthPct,22.7);assert.equal(prev.fiscalYearEnd,'2024-09-28');
  assert.equal(y.filed,undefined);assert.deepEqual(sec.annualFacts({}),[]);
});
test('SEC filings are classified with archive links and the next earnings date is estimated a quarter on',()=>{
  const subs={filings:{recent:{form:['8-K','4','10-Q','8-K','DEF 14A','SC 13G','8-K'],filingDate:['2026-07-31','2026-07-30','2026-08-01','2026-05-01','2026-01-10','2026-02-01','2026-03-01'],items:['2.02,9.01','','','2.02','','','5.07'],accessionNumber:['0000320193-26-000071','x','0000320193-26-000072','0000320193-26-000050','0000320193-26-000001','0000320193-26-000010','0000320193-26-000020'],primaryDocument:['aapl-20260731.htm','','aapl-10q.htm','x.htm','proxy.htm','s.htm','v.htm'],primaryDocDescription:['8-K','','10-Q','8-K','DEF 14A','','8-K']}}};
  const list=sec.filings(subs,320193);assert.deepEqual(list.map(f=>f.kind),['earnings','periodic','earnings','meeting','ownership','meeting'],'insider Form 4 is skipped');
  assert.equal(list[0].url,'https://www.sec.gov/Archives/edgar/data/320193/000032019326000071/aapl-20260731.htm');
  const t=sec.earningsTiming(list,'2026-10-17');assert.equal(t.lastRelease,'2026-07-31');assert.equal(t.nextExpected,'2026-10-30');
});
test('market overview: breadth, sector moves without size indices, and top foreign and institutional buying',async()=>{
  const asked=[];const client={quotation:async(endpoint,tr,params)=>{asked.push(tr+(params.FID_ETC_CLS_CODE??''));
    if(tr==='FHPUP02140000')return {output1:{bstp_nmix_prpr:'5668.05',bstp_nmix_prdy_ctrt:'2.05',ascn_issu_cnt:'759',down_issu_cnt:'135',stnr_issu_cnt:'22',uplm_issu_cnt:'2',lslm_issu_cnt:'0',acml_tr_pbmn:'20945426'},output2:[{bstp_cls_code:'0001',hts_kor_isnm:'종합',bstp_nmix_prdy_ctrt:'2.05'},{bstp_cls_code:'0002',hts_kor_isnm:'대형주',bstp_nmix_prdy_ctrt:'2.12'},{bstp_cls_code:'0013',hts_kor_isnm:'전기·전자',bstp_nmix_prdy_ctrt:'1.75',acml_vol_rlim:'28.5'},{bstp_cls_code:'0021',hts_kor_isnm:'금융',bstp_nmix_prdy_ctrt:'3.1'}]};
    if(tr==='FHPUP02100000')return {output:{bstp_nmix_prpr:'794.78',bstp_nmix_prdy_ctrt:'4.46',ascn_issu_cnt:'1471',down_issu_cnt:'222'}};
    if(tr==='FHPTJ04400000')return {output:[{mksc_shrn_iscd:'005930',hts_kor_isnm:'삼성전자',frgn_ntby_tr_pbmn:'198944',orgn_ntby_tr_pbmn:'-5',prdy_ctrt:'3.3'},{mksc_shrn_iscd:'ABC',hts_kor_isnm:'x',frgn_ntby_tr_pbmn:'1'}]};throw new Error('unexpected');}};
  const m=await insights.fetchSection(client,'MARKET','market','2026-10-17');
  assert.deepEqual(m.breadth.map(b=>[b.index,b.advancers,b.advanceRatioPct]),[['KOSPI',759,84.9],['KOSDAQ',1471,86.9]]);assert.equal(m.breadth[0].tradedValueKRW,20945426e6);
  assert.deepEqual(m.kospiSectors.map(s=>s.code),['0021','0013'],'size indices are left out; strongest first');assert.equal(m.foreignTopBuys[0].netBuyKRW,198944e6);assert.equal(m.foreignTopBuys.length,1);
  assert.deepEqual(asked.filter(a=>a.startsWith('FHPTJ')),['FHPTJ044000001','FHPTJ044000002']);
});
test('U.S. stocks: KIS quote overview and S&P 500 risk; SEC financials, dividends and filings when a contact is set',async()=>{
  const usClient={overseasRequest:async(path,tr,params)=>({body:{output:{last:'345.79',base:'342.00',perx:'39.64',pbrx:'46.98',epsx:'8.72',tomv:'5046528418000',h52p:'348.15',l52p:'242.76',e_icod:'컴퓨터전자장비/기기',params}}}),quotation:async()=>{throw new Error('no');}};
  const o=await insights.fetchSection(usClient,'NASD:AAPL','overview','2026-10-17');assert.equal(o.currency,'USD');assert.equal(o.changePct,1.11);assert.equal(o.marketCapUSD,5046528418000);
  await assert.rejects(insights.fetchSection(usClient,'NASD:AAPL','flows','2026-10-17'),/KOREAN_LISTINGS_ONLY/);
  const dates=Array.from({length:40},(_,i)=>new Date(Date.parse('2026-08-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));const asked=[];let secReady=false;
  const secData={annual:[{fiscalYearEnd:'2025-09-27',revenueUSD:416e9,dividendsPerShare:1.02,payoutRatioPct:13.7}],filings:[{date:'2026-07-31',kind:'earnings',title:'8-K',url:'u'}],earnings:{lastRelease:'2026-07-31',nextExpected:'2026-10-30'},dividends:{years:[{year:'2025',perShare:1.02,payoutRatioPct:13.7}]}};
  const s=new ResearchService({db:new DatabaseSync(':memory:'),master:{get:()=>({name:'APPLE INC',market:'NASD',type:'stock'}),status:()=>({total:1})},clock:()=>Date.parse('2026-10-17T01:00:00Z'),
    kis:async(op,{symbol,section})=>{asked.push(section+':'+symbol);if(section==='overview')return {price:340,currency:'USD'};return {closes:dates.map((date,i)=>({date,close:100+i+(i%2)}))};},provider:async(op)=>{asked.push(op);return secData;},secReady:()=>secReady});
  const risk=await s.section('NASD:AAPL','risk');assert.equal(risk.data.marketIndex,'S&P 500');assert.ok(asked.includes('index-daily:SPX'));
  assert.equal((await s.section('NASD:AAPL','financials')).reason,'SEC_CONTACT_MISSING');assert.equal((await s.section('NASD:AAPL','analysts')).reason,'KOREAN_LISTINGS_ONLY');
  secReady=true;const f=await s.section('NASD:AAPL','financials',true);assert.equal(f.data.periods[0].period,'FY2025 (to 2025-09)');assert.equal(f.data.currency,'USD');
  const d=await s.section('NASD:AAPL','dividends');assert.equal(d.data.trailingYieldPct,0.3);assert.equal(d.data.annualReport.years[0].perShare,1.02);
  const e=await s.section('NASD:AAPL','events');assert.equal(e.data.upcoming[0].date,'2026-10-30');assert.equal(asked.filter(a=>a==='sec-company').length,1,'one SEC fetch serves all three sections');
  const agent=await s.agent({symbol:'NASD:AAPL',sections:[]});assert.deepEqual(Object.keys(agent).filter(k=>['overview','financials','risk'].includes(k)).sort(),['financials','overview','risk']);
  assert.equal((await s.agent({symbol:'AAPL',sections:[]})).reason,'INVALID_SYMBOL');
});
test('live-run fixes: stale blank dividends, monthly sales filings, own preferred shares and zero EPS',()=>{
  const d=insights.dividends([{record_date:'20251231',sht_cd:'105560',divi_kind:'결산',per_sto_divi_amt:'0'},{record_date:'20260930',sht_cd:'105560',divi_kind:'분기',per_sto_divi_amt:'0'},{record_date:'20260630',sht_cd:'105560',divi_kind:'분기',per_sto_divi_amt:'1605'}],'105560',160300,'2026-10-17');
  assert.deepEqual(d.upcoming.map(p=>p.recordDate),['2026-09-30'],'a blank amount ten months on is not upcoming');
  const t=dart.earningsTiming([{kind:'earnings',date:'2026-10-01'},{kind:'earnings',date:'2026-07-24'}],'2026-10-17');assert.equal(t.lastRelease,'2026-07-24');assert.equal(t.nextExpected,'2026-10-24');
  assert.equal(insights.overview({stck_prpr:'169000',eps:'0',bps:'0'}).eps,null);
  const {SecurityMaster}=require('../electron/security-master.cjs');const master=new SecurityMaster(new DatabaseSync(':memory:'),async()=>({ok:false}));
  master.replace('KOSPI',[['005930',1e15],['005935',1e14],['000660',9e14]].map(([symbol,marketCap])=>({symbol,name:symbol,englishName:'',market:'KOSPI',type:'stock',isin:'',industry:'0027',sector:'0013',marketCap})));
  assert.deepEqual(master.peers('005930').map(p=>p.symbol),['000660']);
});
test('ETF facts: leverage factor and kind, NAV premium history, net assets; holdings with weights and concentration',()=>{
  const f=insights.etfFund({stck_prpr:'70415',nav:'70396.16',dprt:'0.03',trc_errt:'7.48',etf_ntas_ttam:'40669',etf_trc_ert_mltp:'2.00',mbcr_name:'삼성자산운용(ETF)',etf_rprs_bstp_kor_isnm:'KOSPI200',etf_cnfg_issu_cnt:'209',etf_dvdn_cycl:'12',stck_lstn_date:'20100222',mtrt_date:'0'},
    [{stck_bsop_date:'20261016',stck_clpr:'70415',nav:'70396.16',dprt:'0.03'},{stck_bsop_date:'20261015',stck_clpr:'67785',nav:'67501.61',dprt:'-0.42'}]);
  assert.deepEqual([f.kind,f.leverageFactor,f.issuer,f.underlyingIndex,f.netAssetsKRW,f.listedOn,f.maturity],['leveraged',2,'삼성자산운용','KOSPI200',40669e8,'2010-02-22',null]);
  assert.equal(f.avgAbsPremium20dPct,0.22);assert.equal(f.maxAbsPremium20dPct,0.42);assert.equal(insights.etfFund({etf_trc_ert_mltp:'-2.00'}).kind,'inverse');
  const h=insights.etfHoldings({etf_cnfg_issu_cnt:'202'},[{stck_shrn_iscd:'000660',hts_kor_isnm:'SK하이닉스',etf_cnfg_issu_rlim:'24.17'},{stck_shrn_iscd:'005930',hts_kor_isnm:'삼성전자',etf_cnfg_issu_rlim:'34.03'},{stck_shrn_iscd:'',hts_kor_isnm:'원화현금',etf_cnfg_issu_rlim:'0.5'}]);
  assert.deepEqual(h.holdings.map(x=>x.name),['삼성전자','SK하이닉스','원화현금']);assert.equal(h.top5WeightPct,58.7);assert.equal(h.constituents,202);
  assert.match(insights.etfHoldings({etf_cnfg_issu_cnt:'504'},[]).note,/no constituents/);
});
test('funds get fund facts, holdings with sector mix and leverage drag; stock-only sections are refused',async()=>{
  const dates=Array.from({length:60},(_,i)=>new Date(Date.parse('2026-08-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
  const db=new DatabaseSync(':memory:');const types={'122630':'etf','005930':'stock'};
  const s=new ResearchService({db,master:{get:symbol=>({name:symbol,market:'KOSPI',type:types[symbol]??'stock',sector:{'005930':'0013','000660':'0013'}[symbol]??null}),status:()=>({total:1})},provider:async()=>null,
    kis:async(op,{section})=>section==='fund'?{leverageFactor:2,kind:'leveraged',nav:1}:section==='daily'?{closes:dates.map((date,i)=>({date,close:100*(1+(i%2?0.02:-0.02))}))}:section==='holdings'?{holdings:[{symbol:'005930',name:'삼성전자',weightPct:34},{symbol:'000660',name:'SK하이닉스',weightPct:24},{symbol:'',name:'현금',weightPct:1}]}:section==='overview'?{price:70415}:{closes:dates.map((date,i)=>({date,close:5000+i}))}});
  db.prepare('INSERT INTO research_cache VALUES(?,?,?,?)').run('MARKET','market',Date.now(),JSON.stringify({kospiSectors:[{code:'0013',name:'전기·전자'}]}));
  const fund=await s.section('122630','fund');assert.equal(fund.data.leverage.factor,2);assert.ok(fund.data.leverage.estimatedAnnualDragPct>0);
  const hold=await s.section('122630','holdings');assert.deepEqual(hold.data.sectors,[{code:'0013',name:'전기·전자',weightPct:58},{code:null,name:'Other or unlisted',weightPct:1}]);
  assert.equal((await s.section('122630','analysts')).reason,'NOT_FOR_FUNDS');assert.equal((await s.section('005930','fund')).reason,'FUNDS_ONLY');
  const agent=await s.agent({symbol:'122630',sections:[]});assert.ok(agent.fund&&agent.holdings&&agent.risk&&agent.overview,'funds default to fund sections');
});
test('scout context names the buyable markets and per-account product permissions',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  live.exposure={policy:()=>({leveragedEtps:{enabled:true,maxPctOfEquity:20,maxHoldingDays:10},margin:{enabled:false},short:{enabled:false}}),context:()=>({products:[],warnings:[],leveragedEtps:{allowed:true}}),creditRisk:()=>null};
  let context;const automation=new Automation(db,paper,{request:async(op,payload)=>{context=payload.context;return {plan:{summary:'s',cashTargetPct:null,focus:'',targets:[],briefAnswers:[],retrospective:''},usage:{inputTokens:1,outputTokens:1}};}},()=>{});
  automation.live=live;automation.usLive={identity:()=>'acct:US',context:async()=>({market:'US',currency:'USD',equity:500,cash:0,positions:{}}),getState:()=>({})};automation.refreshUS=async()=>({});automation.providerStatus.aiConnected=true;automation.discovery={list:()=>[],symbols:()=>[]};
  automation.configure({scope:'both',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
  await automation.scout();
  assert.deepEqual(context.opportunitySet.tradableMarkets,['KR','US']);assert.equal(context.opportunitySet.usStocksBuyable,false,'no USD cash');assert.match(context.opportunitySet.note,/Korean-listed ETFs/);
  assert.equal(context.accounts[0].products.leveragedOrInverseEtps.allowed,true);assert.match(context.accounts[1].note,/No U.S. buying power/);
});
test('scout and trading reviews are offered the market overview tool',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const bodies=[];
  const reply=text=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text}]}]}));
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{const body=JSON.parse(options.body);bodies.push(body);return reply(body.text.format.name==='portfolio_plan'?JSON.stringify({summary:'s',cashTargetPct:null,focus:'',targets:[],briefAnswers:[],retrospective:''}):JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok'}));});
  await client.scout({},{openaiModel:'gpt-6-sol',reasoningEffort:'low'});await client.decide({universe:[],discovery:{enabled:true}},{research:true});
  assert.ok(bodies.every(b=>b.tools.some(t=>t.name==='get_market_overview')));
});
test('OpenDART results saved in an older format are refetched once',async()=>{
  const {ResearchService}=require('../electron/research-service.cjs');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE research_cache(symbol TEXT,source TEXT,at INTEGER,payload TEXT,PRIMARY KEY(symbol,source))');
  db.prepare('INSERT INTO research_cache VALUES(?,?,?,?)').run('005930','dart',Date.now(),JSON.stringify({filings:[]}));let calls=0;
  const s=new ResearchService({db,master:{get:()=>null},kis:async()=>({}),provider:async()=>{calls++;return {version:2,filings:[],preliminary:null};},dartReady:()=>true});
  await s.source('005930','dart');assert.equal(calls,1,'old shape refetched');await s.source('005930','dart');assert.equal(calls,1,'new shape cached');
});
test('an announced results date replaces the estimated one in company events',async()=>{
  const {s}=service({provider:async()=>({version:2,preliminary:null,filings:[],earnings:{lastRelease:'2026-07-24',nextExpected:'2026-10-24',announced:{date:'2026-10-30',time:'14:10',purpose:'2026년 3분기 경영실적 발표'}},dividends:null})});
  const e=(await s.section('005930','events')).data.upcoming.filter(x=>x.kind==='earnings');
  assert.deepEqual(e.map(x=>[x.date,x.title,x.announced]),[['2026-10-30','Results announcement (IR notice): 2026년 3분기 경영실적 발표 at 14:10 KST',true]]);
});
test('U.S. market today: index and sector ETFs from KIS quotes, ranked; missing quotes are skipped',async()=>{
  const {usMarketOverview,US_SECTOR_ETFS}=require('../electron/kis-insights.cjs');
  // 2026-10-25 read-only response values for SPY, QQQ and XLK.
  const quotes={SPY:{base:'763.9600',last:'759.9700',rate:'-0.52',tamt:'25830568715'},QQQ:{base:'704.4700',last:'704.4000',rate:'-0.01'},XLK:{base:'182.3400',last:'183.2300',rate:'+0.49'},XLE:{base:'90',last:'88.2',rate:'-2.00'}};
  const calls=[];const client={overseasRequest:async(path,tr,p)=>{calls.push([tr,p.EXCD,p.SYMB]);if(!quotes[p.SYMB])throw new Error('RATE_LIMITED');return {body:{output:quotes[p.SYMB]}};}};
  const r=await usMarketOverview(client);assert.ok(calls.every(c=>c[0]==='HHDFS00000300'));assert.deepEqual(calls.find(c=>c[2]==='SPY').slice(1),['AMS','SPY']);assert.deepEqual(calls.find(c=>c[2]==='QQQ').slice(1),['NAS','QQQ']);
  assert.deepEqual(r.indices.map(i=>[i.label,i.changePct]),[['S&P 500',-0.52],['Nasdaq-100',-0.01]]);assert.equal(r.indices[0].tradedValueUSD,25830568715);
  assert.deepEqual(r.sectors.map(s=>s.label),['Technology','Energy'],'ranked strongest first');assert.equal(US_SECTOR_ETFS.length,11);
  await assert.rejects(usMarketOverview({overseasRequest:async()=>{throw new Error('x');}}),/DATA_SOURCE_UNAVAILABLE/);
});
// Review of 844904c: the agent view kept only the first 15 holdings, so a stock further down an ETF could not be
// checked, and a U.S. fund read gave no sign its fund details and holdings do not exist here.
test('review: holdings beyond the first 15 are kept compactly, and a U.S. fund read says its fund data cannot be read',async()=>{
  const {digest,ResearchService}=require('../electron/research-service.cjs');
  const rows=Array.from({length:40},(_,i)=>({symbol:String(100000+i),name:'Name '+i,weightPct:Math.round((40-i)*0.12*100)/100,changePct:1}));
  const d=digest('holdings',{constituents:52,listed:40,holdings:rows,note:'KIS lists the largest 40 of 52 holdings.'});
  assert.equal(d.holdings.length,15);assert.equal(d.moreHoldings.length,25);assert.deepEqual(d.moreHoldings[9],['100024',rows[24].weightPct],'the 25th holding and its weight');assert.match(d.moreHoldingsNote,/16 to 40/);
  assert.equal(digest('holdings',{holdings:rows.slice(0,10)}).moreHoldings,undefined,'short lists unchanged');
  const s=Object.create(ResearchService.prototype);s.master=null;s.clock=Date.now;s.identity=()=>({type:'etf',name:'Semis 3x'});s.section=async()=>({status:'unavailable',reason:'KOREAN_LISTINGS_ONLY'});
  const us=await s.agent({symbol:'AMEX:SOXL',sections:['fund','holdings']});assert.match(us.fundData,/Korean-listed funds only.*unverified/);
  const kr=await s.agent({symbol:'233740',sections:['fund']});assert.equal(kr.fundData,undefined);
  const {INSTRUCTIONS}=require('../electron/scout.cjs');assert.match(INSTRUCTIONS,/fund details and holdings exist for Korean-listed funds only/);
});
