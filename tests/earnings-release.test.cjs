const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const sec=require('../electron/sec.cjs');
// Review of Oct 28: the Pentair Buy relied on a headline about maintained $4.70 EPS guidance while the release itself was
// unavailable; the agent could only see the 8-K title. These fixtures follow the shape of EDGAR's submissions file, a
// filing index page and an earnings-release exhibit (synthetic figures).
const submissions={filings:{recent:{form:['4','8-K','10-Q','8-K'],filingDate:['2026-10-28','2026-10-27','2026-10-24','2026-07-22'],reportDate:['','2026-10-27','2026-09-30','2026-07-22'],
  items:['','2.02,9.01','','2.02,9.01'],accessionNumber:['0000077360-26-000050','0000077360-26-000045','0000077360-26-000040','0000077360-26-000030'],primaryDocument:['x.xml','pnr-20261027.htm','pnr-10q.htm','old.htm'],primaryDocDescription:['','8-K','10-Q','8-K']}}};
const index=`<table class="tableFile" summary="Document Format Files"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td scope="row">1</td><td scope="row">8-K</td><td scope="row"><a href="/ix?doc=/Archives/edgar/data/77360/000007736026000045/pnr-20261027.htm">pnr-20261027.htm</a></td><td scope="row">8-K</td><td>40000</td></tr>
<tr><td scope="row">2</td><td scope="row">SUPPLEMENTAL SLIDES</td><td scope="row"><a href="/Archives/edgar/data/77360/000007736026000045/pnr-ex992.htm">pnr-ex992.htm</a></td><td scope="row">EX-99.2</td><td>9000</td></tr>
<tr><td scope="row">3</td><td scope="row">PRESS RELEASE</td><td scope="row"><a href="/Archives/edgar/data/77360/000007736026000045/pnr-ex991.htm">pnr-ex991.htm</a></td><td scope="row">EX-99.1</td><td>90000</td></tr></table>`;
const release=`<html><body><p style="text-align:center">Exhibit 99.1</p><p><b>Pentair Reports Third Quarter 2026 Results and Maintains Full-Year Adjusted EPS Guidance</b></p>
<p>Third quarter sales of $1.05 billion increased 3&#160;percent; core sales increased 2&#160;percent.</p><p>Diluted EPS was $1.12; adjusted EPS of $1.21 increased 9&#160;percent.</p>
<table><tr><td>Return on sales</td><td>26.4%</td></tr></table><p>Free cash flow of $612 million year to date increased 4&#8239;percent.</p>
<p>Pentair maintains its full-year 2026 adjusted EPS guidance of approximately $4.70 and now expects sales to be up approximately 1&nbsp;percent.</p>
<p>For the fourth quarter of 2026, Pentair expects adjusted EPS of approximately $1.07.</p>
<p>Forward-Looking Statements: This release contains forward-looking statements; the company expects 2026 results may differ and undue reliance should not be placed on them.</p><script>var x=1;</script></body></html>`;
function fetcher(seen){return async(url,options)=>{seen.push({url,headers:options.headers});const ok=body=>({ok:true,status:200,text:async()=>body});
  if(url==='https://www.sec.gov/files/company_tickers.json')return ok(JSON.stringify({0:{cik_str:77360,ticker:'PNR',title:'Pentair plc'}}));
  if(url==='https://data.sec.gov/submissions/CIK0000077360.json')return ok(JSON.stringify(submissions));
  if(url==='https://www.sec.gov/Archives/edgar/data/77360/000007736026000045/0000077360-26-000045-index.htm')return ok(index);
  if(url==='https://www.sec.gov/Archives/edgar/data/77360/000007736026000045/pnr-ex991.htm')return ok(release);
  return {ok:false,status:404,text:async()=>''};};}
test('the latest earnings release is read from its 8-K exhibit 99.1: results and guidance in the company\'s words, with the source',async()=>{
  const seen=[];const r=await sec.secEarningsRelease(fetcher(seen),'me@example.com','NYSE:PNR','2026-10-28',{});
  assert.equal(r.filed,'2026-10-27','the latest 8-K with item 2.02, not the newer Form 4');assert.equal(r.exhibit,'EX-99.1','the press release, not the slides');
  assert.equal(r.url,'https://www.sec.gov/Archives/edgar/data/77360/000007736026000045/pnr-ex991.htm');assert.equal(r.source,'SEC EDGAR 8-K filed 2026-10-27, EX-99.1');
  assert.match(r.headline,/Third Quarter 2026 Results and Maintains Full-Year Adjusted EPS Guidance/);
  assert.ok(r.guidance.some(s=>/full-year 2026 adjusted EPS guidance of approximately \$4\.70/.test(s)),'the guidance sentence: '+JSON.stringify(r.guidance));
  assert.ok(r.guidance.some(s=>/fourth quarter of 2026, Pentair expects adjusted EPS of approximately \$1\.07/.test(s)));
  assert.ok(r.results.some(s=>/adjusted EPS of \$1\.21 increased 9 percent/.test(s)),'entities decoded: '+JSON.stringify(r.results));assert.ok(r.results.some(s=>/Free cash flow of \$612 million/.test(s)));
  assert.ok(![...r.guidance,...r.results].some(s=>/forward-looking|undue reliance/i.test(s)),'safe-harbor text is not guidance');assert.ok(!r.text.includes('var x'),'scripts removed');
  assert.ok(seen.every(c=>/^https:\/\/(www|data)\.sec\.gov\//.test(c.url)&&c.headers['user-agent']==='FinancialPortfolioManager me@example.com'),'only sec.gov, with the app and contact as SEC asks');
});
test('an earnings release that cannot be read says why instead of inventing one',async()=>{
  const noRelease=async url=>url.includes('company_tickers')?{ok:true,status:200,text:async()=>JSON.stringify({0:{cik_str:1,ticker:'ABC',title:'ABC'}})}:{ok:true,status:200,text:async()=>JSON.stringify({filings:{recent:{form:['10-Q'],filingDate:['2026-10-01'],items:[''],accessionNumber:['0000000001-26-000001']}}})};
  assert.deepEqual(await sec.secEarningsRelease(noRelease,'me@example.com','NYSE:ABC','2026-10-28',{}),{status:'unavailable',reason:'NO_EARNINGS_RELEASE'});
  assert.equal(sec.releaseExhibit('<tr><td>1</td><td><a href="/Archives/edgar/data/1/000000000126000001/a.htm">a</a></td><td>8-K</td></tr>'),null,'no EX-99 exhibit');
  const facts=sec.releaseFacts('The company expects nothing.\nNo figures here at all in this sentence.');assert.deepEqual(facts,{results:[],guidance:[]},'sentences without figures are not guidance');
});
test('research offers the release section for U.S. stocks through SEC and keeps the agent copy within one tool response',async()=>{
  const {ResearchService,digest}=require('../electron/research-service.cjs');const calls=[];
  const r=new ResearchService({db:new DatabaseSync(':memory:'),master:null,kis:async()=>{throw new Error('no KIS');},provider:async(op,payload)=>{calls.push([op,payload.symbol]);return {source:'SEC EDGAR 8-K filed 2026-10-27, EX-99.1',guidance:['g'],results:['r'],text:'t'.repeat(9000),textChars:9000};},secReady:()=>true});
  const s=await r.section('NYSE:PNR','release');assert.equal(s.status,'ok');assert.deepEqual(calls,[['sec-earnings','NYSE:PNR']]);await r.section('NYSE:PNR','release');assert.equal(calls.length,1,'cached');
  const d=digest('release',s.data);assert.equal(d.text.length,4000);assert.equal(d.textTruncated,true);assert.deepEqual(d.guidance,['g']);
  assert.ok(require('../electron/scout.cjs').RESEARCH_SECTIONS.includes('release'));assert.match(require('../electron/scout.cjs').RESEARCH_TOOL.description,/release: the latest earnings release as the company filed it/);
  const off=new ResearchService({db:new DatabaseSync(':memory:'),master:null,kis:async()=>{},provider:async()=>{throw new Error('x');},secReady:()=>false});assert.deepEqual(await off.section('NYSE:PNR','release'),{status:'unavailable',reason:'SEC_CONTACT_MISSING'});
});
// The evidence standard for a Buy, as the review asked: sourced facts, a valuation basis for a target price, and an
// explicit split between uncertainty acceptable at this size and what must be verified before adding more.
const {validateDecision}=require('../electron/ai-client.cjs');
const impact={weightBeforePct:0,weightAfterPct:5.4,related:[],relatedBeforePct:0,relatedAfterPct:5.4,equityReliable:true,why:'A small industrial starter outside the AI concentration.'};
const buy=plan=>validateDecision({action:'Buy',symbol:'NYSE:PNR',quantity:1,explanation:'Starter.',credit:'none',loanDate:'',plan:{thesis:'Water-industrial cash generation',invalidation:'Guidance cut',stopPrice:58.1,targetPrice:null,horizonDays:365,confidence:'medium',portfolioImpact:impact,evidence:[],valuation:null,uncertainty:null,...plan}},['NYSE:PNR'],{requirePlan:true});
const headline={claim:'Full-year adjusted EPS guidance maintained at about $4.70',source:'News headline, Oct 27',verified:false};
const read={claim:'Full-year adjusted EPS guidance maintained at about $4.70',source:'SEC 8-K Oct 27, EX-99.1 (release section)',verified:true};
test('a Buy needs sourced evidence; a target price needs its valuation basis; unverified facts need the size and next-step split',()=>{
  assert.equal(buy({}).withheld?.reason,'no evidence with sources');
  assert.equal(buy({evidence:[{...read,source:''}]}).withheld?.reason,'evidence without a source');
  assert.equal(buy({evidence:[headline]}).withheld?.reason,'unverified evidence without saying why it is acceptable at this size and what must be verified before adding more','the Oct 28 Pentair case');
  const starter=buy({evidence:[headline],uncertainty:{acceptableAtThisSize:'One share is 5.4% of equity with a stop at $58.10, so an unconfirmed guidance figure risks about 0.3% of equity.',beforeAddingMore:'Read the Oct 27 release to confirm the $4.70 guidance and Q3 figures.'}});
  assert.equal(starter.action,'Buy','acceptable for a starter when it says why and what comes next');assert.deepEqual(starter.plan.uncertainty.beforeAddingMore,'Read the Oct 27 release to confirm the $4.70 guidance and Q3 figures.');
  assert.match(buy({evidence:[read],targetPrice:77.5}).withheld?.reason??'',/target price without its valuation basis/,'$77.50 with no reason for the multiple');
  const valued=buy({evidence:[read],targetPrice:77.5,valuation:{method:'P/E on guided EPS',inputs:'$4.70 FY2026 guidance (8-K Oct 27 EX-99.1) x 16.5',justification:'16.5x is below the 5-year median of about 19x, allowing for slower core growth'}});
  assert.equal(valued.action,'Buy');assert.equal(valued.plan.valuation.method,'P/E on guided EPS');
  assert.equal(validateDecision({action:'Hold',symbol:'',quantity:0,explanation:'x',credit:'none',loanDate:'',plan:{thesis:'',invalidation:'i',stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low',portfolioImpact:null,evidence:[],valuation:null,uncertainty:null}},['NYSE:PNR'],{requirePlan:true}).action,'Hold','a Hold needs none of it');
});
test('the decision schema stays valid for strict structured outputs with the new plan fields',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','ai-client.cjs'),'utf8');
  const strict=schema=>{if(Array.isArray(schema))return schema.forEach(strict);if(!schema||typeof schema!=='object')return;
    if(schema.type==='object'&&schema.properties){assert.deepEqual([...schema.required].sort(),Object.keys(schema.properties).sort(),'every property required');assert.equal(schema.additionalProperties,false);}
    for(const v of Object.values(schema))strict(v);};
  const m=require('../electron/ai-client.cjs');const schema=m.decisionSchema?m.decisionSchema(true,true):null;
  if(schema)strict(schema);else{const plan=/const PLAN_SCHEMA=(\{[\s\S]*?\});\n/.exec(src);assert.ok(plan,'plan schema present');assert.match(plan[1],/required:\['thesis','invalidation','stopPrice','targetPrice','horizonDays','confidence','portfolioImpact','evidence','valuation','uncertainty'\]/);}
  assert.match(src,/read an earnings release with get_company_research section release before relying on its figures or guidance/);
});
test('real EDGAR documents: the document label is not the headline and bullets are not part of a sentence',async()=>{
  // Shapes seen in Pentair's Oct 27 release: EDGAR's document label first, and bulleted highlights.
  const seen=[];const fetch=fetcher(seen);const labelled=async(url,o)=>url.endsWith('pnr-ex991.htm')?{ok:true,status:200,text:async()=>'<p>EX-99.1 2 q32026pressrelease.htm</p><p>Pentair Reports Third Quarter 2026 Results</p><p>&#8226;GAAP EPS was $0.91 and adjusted EPS was $1.18</p><p>The Company reaffirms its previous full year adjusted EPS midpoint of approximately $4.70.</p>'}:fetch(url,o);
  const r=await sec.secEarningsRelease(labelled,'me@example.com','NYSE:PNR','2026-10-28',{});
  assert.match(r.headline,/^Pentair Reports Third Quarter 2026 Results/);assert.ok(r.results.includes('GAAP EPS was $0.91 and adjusted EPS was $1.18'));
  assert.ok(r.guidance.includes('The Company reaffirms its previous full year adjusted EPS midpoint of approximately $4.70.'));
});
