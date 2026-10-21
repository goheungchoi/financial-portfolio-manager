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
