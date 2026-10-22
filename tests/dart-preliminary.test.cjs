const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const P=require('../electron/dart-preliminary.cjs');
const doc=fs.readFileSync(path.join(__dirname,'fixtures','dart-preliminary-005930-20261008.html'),'utf8');
test('a real consolidated preliminary-earnings filing parses with periods, unit, basis and undisclosed figures left null',()=>{
  const r=P.parsePreliminary(doc,{title:'연결재무제표기준영업(잠정)실적(공정공시)'});
  assert.equal(r.status,'preliminary');assert.equal(r.basis,'consolidated');assert.equal(r.unit,'조원');assert.equal(r.unitInKRW,1e12);
  assert.deepEqual(r.periods.quarter,{from:'2026-07-01',to:'2026-09-30'});assert.deepEqual(r.periods.yearAgoYearToDate,{from:'2025-01-01',to:'2025-09-30'});
  assert.deepEqual(r.metrics.revenue.quarter,{current:195,priorQuarter:171.5,changeFromPriorQuarterPct:13.7,yearAgo:86.06,changeFromYearAgoPct:126.59});
  assert.deepEqual(r.metrics.operatingIncome.yearToDate,{current:254.13,yearAgo:23.53,changeFromYearAgoPct:980.03});
  assert.deepEqual(r.disclosed,['revenue','operatingIncome']);assert.deepEqual(r.notDisclosed,['pretaxIncome','netIncome','netIncomeOwners']);
  assert.equal(r.metrics.netIncome.quarter.current,null,'not disclosed is null, never zero');
});
test('DART XML cells, negative marks, corrections and the newest filing',()=>{
  const xml='<TABLE><TR><TD>단위 : 억원, %</TD></TR><TR><TD>매출액</TD><TD>당해실적</TD><TE>1,234</TE><TE>1,000</TE><TE>23.4</TE><TE>-</TE><TE>900</TE><TE>37.1</TE><TE>-</TE></TR><TR><TD>영업이익</TD><TD>당해실적</TD><TE>△12</TE><TE>5</TE><TE>-</TE><TE>적자전환</TE><TE>-</TE><TE>-</TE><TE>-</TE></TR></TABLE>';
  const r=P.parsePreliminary(xml,{title:'[기재정정]영업(잠정)실적(공정공시)'});assert.equal(r.status,'preliminary (corrected filing)');assert.equal(r.unitInKRW,1e8);assert.equal(r.basis,'unknown');
  assert.equal(r.metrics.revenue.quarter.current,1234);assert.equal(r.metrics.operatingIncome.quarter.current,-12);assert.equal(r.metrics.operatingIncome.quarter.yearAgo,null);
  assert.equal(P.parsePreliminary('<table><tr><td>nothing</td></tr></table>'),null,'no figures: null, not an empty result');
  const f=(date,title,no)=>({date,title,url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='+no});
  assert.equal(P.latestFiling([f('2026-07-30','연결재무제표기준영업(잠정)실적(공정공시)','20260730800077'),f('2026-07-30','[기재정정]연결재무제표기준영업(잠정)실적(공정공시)','20260730800103'),f('2026-07-07','연결재무제표기준영업(잠정)실적(공정공시)','20260707800004'),f('2026-08-01','기업설명회(IR)개최','20260801000001')]).url.slice(-14),'20260730800103');
  assert.equal(new TextDecoder('euc-kr').decode(Buffer.from([0xb8,0xc5])),P.decodeDocument(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="euc-kr"?>'),Buffer.from([0xb8,0xc5])])).slice(-1));
});
test('the document fetch never fails the filing list',async()=>{
  const {preliminaryFigures}=require('../electron/dart.cjs');const filings=[{date:'2026-10-08',title:'연결재무제표기준영업(잠정)실적(공정공시)',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261008800004'}];
  const notZip=await preliminaryFigures(async()=>({arrayBuffer:async()=>Buffer.from('<result><status>014</status></result>')}),filings);assert.equal(notZip.unavailable,'DOCUMENT_NOT_FOUND');assert.equal(notZip.source.rceptNo,'20261008800004');
  const thrown=await preliminaryFigures(async()=>{throw new Error('DART_UNAVAILABLE');},filings);assert.equal(thrown.unavailable,'DART_UNAVAILABLE');
  assert.equal(await preliminaryFigures(async()=>{throw new Error('x');},[]),null);
});
// A one-entry stored ZIP, as DART's document.xml returns.
function zip(text){
  const data=Buffer.from(text,'utf8'),name=Buffer.from('doc.xml');
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50,0);cd.writeUInt32LE(data.length,20);cd.writeUInt32LE(data.length,24);cd.writeUInt16LE(name.length,28);cd.writeUInt32LE(0,42);
  const cdAt=30+name.length+data.length;const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+name.length,12);end.writeUInt32LE(cdAt,16);
  return Buffer.concat([local,name,data,cd,name,end]);
}
const kiaSales=fs.readFileSync(path.join(__dirname,'fixtures','dart-monthly-sales-000270-20261001.html'),'utf8');
const kiaIr=fs.readFileSync(path.join(__dirname,'fixtures','dart-ir-000270-20261014.html'),'utf8');
test('a monthly unit-sales report filed under the preliminary-results title is read as unit sales, not earnings',()=>{
  assert.equal(P.parsePreliminary(kiaSales,{title:'영업(잠정)실적(공정공시)'}),null,'every earnings row is "-"');
  const s=P.parseMonthlySales(kiaSales);assert.equal(s.kind,'monthly unit sales');assert.equal(s.month,'2026-09');
  assert.deepEqual(s.figures.total,{current:281984,priorMonth:266712,changeFromPriorMonthPct:5.7,yearAgo:268387,changeFromYearAgoPct:5.1});
  assert.deepEqual(s.yearToDate,{through:'2026-09',figures:{domestic:{current:436301,yearAgo:413942,changeFromYearAgoPct:5.4},overseas:{current:2036359,yearAgo:1955134,changeFromYearAgoPct:4.2},special:{current:5484,yearAgo:3597,changeFromYearAgoPct:52.5},total:{current:2478144,yearAgo:2372673,changeFromYearAgoPct:4.4}}});
  assert.equal(P.parseMonthlySales(doc),null,'an earnings filing has no unit-sales table');
});
test('an IR notice gives the announced results date and time',()=>{
  assert.deepEqual(P.parseIrNotice(kiaIr),{date:'2026-10-30',time:'14:10',purpose:'2026년 3분기 경영실적 발표',method:'컨퍼런스 콜',results:true});
  assert.equal(P.parseIrNotice('<table><tr><td>1. 일시 및 장소</td><td>일시</td><td>2026-11-12</td><td>10:00</td></tr><tr><td>3. 개최목적</td><td>국내 투자자 컨퍼런스 참가</td></tr></table>').results,false);
});
test('unit-sales filings are skipped to the newest real earnings filing, and the IR notice dates the next results',async()=>{
  const {companyFilings}=require('../electron/dart.cjs');
  const f=(date,title,no)=>({rcept_dt:date.replaceAll('-',''),report_nm:title,rcept_no:no,flr_nm:'기아'});
  const list=[f('2026-10-14','기업설명회(IR)개최(안내공시)','20261014800271'),f('2026-10-01','영업(잠정)실적(공정공시)','20261001800325'),f('2026-09-01','영업(잠정)실적(공정공시)','20260901800418'),f('2026-08-03','영업(잠정)실적(공정공시)','20260803800582'),f('2026-07-24','연결재무제표기준영업(잠정)실적(공정공시)','20260724800340')];
  const earnings='<table><tr><td>단위 : 억원, %</td></tr><tr><td>매출액</td><td>당해실적</td><td>293,496</td><td>281,000</td><td>4.4</td><td>-</td><td>274,000</td><td>7.1</td><td>-</td></tr></table>';
  const docs={'20261014800271':kiaIr,'20261001800325':kiaSales,'20260901800418':kiaSales,'20260803800582':kiaSales,'20260724800340':earnings};const fetched=[];
  const fetcher=async url=>{const u=new URL(url);const p=u.pathname.split('/').pop();
    if(p==='list.json')return {ok:true,json:async()=>u.searchParams.get('pblntf_ty')==='I'?{status:'000',list}:{status:'013'}};
    if(p==='alotMatter.json')return {ok:true,json:async()=>({status:'013'})};
    if(p==='document.xml'){const no=u.searchParams.get('rcept_no');fetched.push(no);return {ok:true,arrayBuffer:async()=>zip(docs[no])};}
    throw new Error('unexpected '+p);};
  const r=await companyFilings(fetcher,'k'.repeat(40),'000270','2026-10-22',{corps:new Map([['000270','00106641']]),corpsAt:Date.now()});
  assert.equal(r.version,2);
  assert.equal(r.preliminary.source.rceptNo,'20260724800340','the newest filing with earnings figures');assert.equal(r.preliminary.metrics.revenue.quarter.current,293496);
  assert.equal(r.preliminary.monthlySales.month,'2026-09');assert.equal(r.preliminary.monthlySales.source.rceptNo,'20261001800325');
  assert.deepEqual(r.preliminary.skipped.map(s=>s.reason),Array(3).fill('monthly unit sales, no earnings figures'));
  assert.equal(r.earnings.lastRelease,'2026-07-24','monthly sales reports do not anchor the estimate');
  assert.deepEqual({date:r.earnings.announced.date,time:r.earnings.announced.time},{date:'2026-10-30',time:'14:10'});
  // Only unit-sales filings in range: reported as such, never as an unreadable earnings filing.
  docs['20260724800340']=kiaSales;const none=await companyFilings(fetcher,'k'.repeat(40),'000270','2026-10-22',{corps:new Map([['000270','00106641']]),corpsAt:Date.now()});
  assert.equal(none.preliminary.unavailable,'NO_EARNINGS_FIGURES_IN_RECENT_FILINGS');assert.equal(none.preliminary.monthlySales.figures.total.current,281984);
  // A past results date is not announced as upcoming.
  const later=await companyFilings(fetcher,'k'.repeat(40),'000270','2026-10-31',{corps:new Map([['000270','00106641']]),corpsAt:Date.now()});assert.equal(later.earnings.announced,undefined);
});
