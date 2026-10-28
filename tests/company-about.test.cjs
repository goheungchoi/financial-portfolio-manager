const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const sec=require('../electron/sec.cjs');const dart=require('../electron/dart.cjs');
// What a company does, for the Charts screen and the agents: the opening of the business section of its latest annual
// report. The 10-K layout follows Pentair's FY2025 report (table of contents first, then ITEM 1. BUSINESS with a
// definitions paragraph); the DART layout follows the 사업보고서 XML (II. 사업의 내용 > 1. 사업의 개요). Synthetic text.
const tenK=`<html><body><p>TABLE OF CONTENTS</p><table><tr><td>ITEM 1.</td><td>Business</td><td>4</td></tr><tr><td>ITEM 1A.</td><td>Risk Factors</td><td>9</td></tr></table>
<p>ITEM 1. BUSINESS</p><p>Unless the context otherwise indicates, references herein to "Pentair," the "Company," and such words as "we," "us," and "our" include Pentair plc and its subsidiaries.</p>
<p>At Pentair, we help the world sustainably move, improve and enjoy water, life&#8217;s most essential resource, from residential pools to industrial water management.</p>
<p>We classify our operations into three reporting segments: Flow, Water Solutions and Pool, serving residential, commercial and industrial customers worldwide.</p>
${'<p>'+'Further detail about markets, competition, raw materials, seasonality and employees that runs on for pages. '.repeat(30)+'</p>'}
<p>ITEM 1A. RISK FACTORS</p><p>Risks.</p></body></html>`;
test('the 10-K business section: the table of contents and the definitions are skipped; the description is read as filed',()=>{
  const r=sec.businessSection(sec.htmlText(tenK),'10-K');
  assert.match(r.text,/^At Pentair, we help the world sustainably move, improve and enjoy water, life's most essential resource/);
  assert.ok(r.text.includes('three reporting segments: Flow, Water Solutions and Pool'));assert.ok(!/Unless the context/.test(r.text),'not the definitions');assert.ok(!/Risk Factors|Risks\./.test(r.text));
  const f20=sec.businessSection(sec.htmlText('<p>Item 4. Information on the Company</p><p>'+'We design and sell semiconductors used in phones, cars and data centers across Asia and Europe. '.repeat(30)+'</p><p>Item 4A. Unresolved Staff Comments</p>'),'20-F');
  assert.match(f20.text,/^We design and sell semiconductors/);
  assert.equal(sec.businessSection(sec.htmlText('<p>ITEM 1. Business 4</p><p>ITEM 1A. Risk Factors 9</p>'),'10-K'),null,'a table of contents alone is not a description');
});
test('secAbout reads the latest annual report with the SEC industry and links the filing',async()=>{
  const seen=[];const fetcher=async(url,options)=>{seen.push([url,options.headers['user-agent']]);const ok=body=>({ok:true,status:200,text:async()=>body});
    if(url.endsWith('company_tickers.json'))return ok(JSON.stringify({0:{cik_str:77360,ticker:'PNR',title:'Pentair plc'}}));
    if(url.includes('/submissions/'))return ok(JSON.stringify({sicDescription:'Pumps & Pumping Equipment',filings:{recent:{form:['8-K','10-Q','10-K'],filingDate:['2026-10-27','2026-10-24','2026-02-10'],accessionNumber:['0000077360-26-000055','0000077360-26-000050','0000077360-26-000007'],primaryDocument:['a.htm','q.htm','pnr-20251231.htm'],items:['2.02','','']}}}));
    if(url==='https://www.sec.gov/Archives/edgar/data/77360/000007736026000007/pnr-20251231.htm')return ok(tenK);return {ok:false,status:404,text:async()=>''};};
  const r=await sec.secAbout(fetcher,'me@example.com','NYSE:PNR','2026-10-28',{});
  assert.equal(r.industry,'Pumps & Pumping Equipment');assert.deepEqual(r.source,{kind:'SEC 10-K',form:'10-K',date:'2026-02-10',url:'https://www.sec.gov/Archives/edgar/data/77360/000007736026000007/pnr-20251231.htm',section:'Item 1. Business'});
  assert.match(r.overview,/^At Pentair/);assert.ok(seen.every(([url,ua])=>/^https:\/\/(www|data)\.sec\.gov\//.test(url)&&ua==='FinancialPortfolioManager me@example.com'));
});
const report=`<?xml version="1.0" encoding="utf-8"?><DOCUMENT><BODY><SECTION-1><TITLE ATOC="Y" AASSOCNOTE="D-0-1-0-0">I. 회사의 개요</TITLE><P>회사 연혁입니다. 1969년 설립되었습니다.</P></SECTION-1>
<SECTION-1><TITLE ATOC="Y" AASSOCNOTE="D-0-2-0-0">II. 사업의 내용</TITLE><SECTION-2><TITLE ATOC="Y" AASSOCNOTE="D-0-2-1-0">1. 사업의 개요</TITLE>
<P>당사는 본사를 거점으로 한국 및 CE, IM부문 산하 해외 9개 지역총괄과 DS부문 산하 해외 5개 지역총괄의 생산ㆍ판매법인 등 230개의 종속기업으로 구성된 글로벌 전자 기업입니다.</P>
<P>사업군별로 보면, DX 부문은 TV, 모니터, 냉장고, 세탁기, 에어컨, 스마트폰 등을 생산ㆍ판매하며, DS 부문은 DRAM, NAND Flash, 모바일AP 등의 제품을 생산ㆍ판매하고 있습니다.</P>
<TABLE><TR><TD>부문</TD><TD>주요 제품</TD></TR></TABLE><P>※ 상세 내용은 아래를 참조하시기 바랍니다.</P></SECTION-2>
<SECTION-2><TITLE ATOC="Y" AASSOCNOTE="D-0-2-2-0">2. 주요 제품 및 서비스</TITLE><P>제품별 매출 비중은 다음과 같습니다. 이 문단은 개요가 아닙니다.</P></SECTION-2></SECTION-1></BODY></DOCUMENT>`;
function zip(text){
  const data=Buffer.from(text,'utf8'),name=Buffer.from('doc.xml');
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50,0);cd.writeUInt32LE(data.length,20);cd.writeUInt32LE(data.length,24);cd.writeUInt16LE(name.length,28);cd.writeUInt32LE(0,42);
  const cdAt=30+name.length+data.length;const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+name.length,12);end.writeUInt32LE(cdAt,16);
  return Buffer.concat([local,name,data,cd,name,end]);
}
test('the DART annual report business overview (사업의 개요) is read from the latest 사업보고서',async()=>{
  const o=dart.businessOverview(report);assert.equal(o.section,'1. 사업의 개요');
  assert.match(o.text,/^당사는 본사를 거점으로 한국 및 CE, IM부문/);assert.ok(o.text.includes('DS 부문은 DRAM, NAND Flash'));assert.ok(!o.text.includes('이 문단은 개요가 아닙니다'),'stops at the next section');assert.ok(!o.text.includes('회사 연혁'));
  const calls=[];const fetcher=async url=>{const u=new URL(url);calls.push(u.pathname+' '+(u.searchParams.get('pblntf_detail_ty')??u.searchParams.get('rcept_no')??''));
    if(u.pathname.endsWith('list.json'))return {ok:true,json:async()=>({status:'000',list:[{rcept_no:'20260311001234',report_nm:'사업보고서 (2025.12)',rcept_dt:'20260311',flr_nm:'삼성전자'}]})};
    if(u.pathname.endsWith('document.xml'))return {ok:true,arrayBuffer:async()=>zip(report)};return {ok:false};};
  const r=await dart.companyAbout(fetcher,'k'.repeat(40),'005930','2026-10-28',{corps:new Map([['005930','00126380']]),corpsAt:Date.now()});
  assert.equal(r.language,'ko');assert.deepEqual(r.source,{kind:'DART annual report',date:'2026-03-11',title:'사업보고서 (2025.12)',rceptNo:'20260311001234',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260311001234',section:'1. 사업의 개요'});
  assert.match(r.overview,/^당사는/);assert.deepEqual(calls,['/api/list.json A001','/api/document.xml 20260311001234']);
  const none=await dart.companyAbout(async()=>({ok:true,json:async()=>({status:'013'})}),'k'.repeat(40),'005930','2026-10-28',{corps:new Map([['005930','00126380']]),corpsAt:Date.now()});assert.deepEqual(none,{status:'unavailable',reason:'NO_ANNUAL_REPORT'});
});
test('research serves the about section from DART or SEC, cached for a week, and shortens it for the agents',async()=>{
  const {ResearchService,digest}=require('../electron/research-service.cjs');const calls=[];
  const r=new ResearchService({db:new DatabaseSync(':memory:'),master:{get:()=>({type:'stock'})},kis:async()=>{throw new Error('no KIS');},provider:async(op,p)=>{calls.push([op,p.symbol]);return {language:op==='dart-about'?'ko':'en',overview:'x'.repeat(2000),source:{kind:op}};},dartReady:()=>true,secReady:()=>true});
  assert.equal((await r.section('005930','about')).status,'ok');assert.equal((await r.section('NYSE:PNR','about')).status,'ok');await r.section('005930','about');
  assert.deepEqual(calls,[['dart-about','005930'],['sec-about','NYSE:PNR']],'one fetch each, then the cache');
  const d=digest('about',(await r.section('NYSE:PNR','about')).data);assert.equal(d.overview.length,1200);assert.equal(d.truncated,true);
  assert.ok(require('../electron/scout.cjs').RESEARCH_SECTIONS.includes('about'));
  const fund=new ResearchService({db:new DatabaseSync(':memory:'),master:{get:()=>({type:'etf'})},kis:async()=>{},provider:async()=>{throw new Error('x');},dartReady:()=>true});assert.deepEqual(await fund.section('360750','about'),{status:'unavailable',reason:'NOT_FOR_FUNDS'});
});
