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
test('the whole release is kept: a qualification near the end stays in the text, the statements and the original the agents can read',async()=>{
  const filler='<p>'+'Segment commentary without figures continues across the quarter in this paragraph. '.repeat(40)+'</p>';
  const outlook=Array.from({length:9},(_,i)=>`<p>Pentair expects segment ${i+1} sales growth of approximately ${i+1} percent in 2026.</p>`).join('');
  const caveat='Pentair expects the pending acquisition to reduce 2026 adjusted EPS by up to $0.40, which the guidance above excludes.';
  const long=release.replace('<script>',filler.repeat(5)+outlook+`<p>${caveat}</p><script>`);const base=fetcher([]);
  const r=await sec.secEarningsRelease(async(url,o)=>url.endsWith('pnr-ex991.htm')?{ok:true,status:200,text:async()=>long}:base(url,o),'me@example.com','NYSE:PNR','2026-10-28',{});
  assert.equal(r.version,2);assert.ok(r.textChars>15000,'a long release: '+r.textChars);assert.equal(r.text.length,r.textChars,'every character kept');assert.equal(r.textTruncated,undefined);
  assert.ok(r.text.endsWith(caveat)||r.text.includes(caveat));assert.ok(r.guidance.includes(caveat),'the closing qualification is among the guidance statements ('+r.guidance.length+')');
  // The agents get the first 4,000 characters and read the rest from the original, continuing from next.from.
  const {ResearchService,TRACE}=require('../electron/research-service.cjs'),rc=require('../electron/review-context.cjs');
  const db=new DatabaseSync(':memory:');const calls=[];const svc=new ResearchService({db,master:null,kis:async()=>{throw new Error('no KIS');},provider:async op=>{calls.push(op);return r;},secReady:()=>true});
  const reply=await svc.agent({symbol:'NYSE:PNR',sections:['release']});
  assert.equal(reply.release.text.length,4000);assert.match(reply.release.textNote,/whole text is at provenance\.release\.original/);assert.equal(reply.provenance.release.original,'originalSections/release');
  const store=rc.resultStore();store.keep('c1',reply,16000);let text='',from=0;
  for(;;){const part=store.read({section:'result-1',part:'originalSections/release/text',from},3000);text+=part.text;if(!part.next)break;from=part.next.from;}
  assert.equal(text,r.text,'the original read back exactly, qualification included');assert.ok(reply[TRACE].originals.release.guidance.includes(caveat));
  // A release cached in the earlier, shortened format is fetched again in full.
  db.prepare('UPDATE research_cache SET payload=? WHERE source=?').run(JSON.stringify({...r,version:undefined,text:r.text.slice(0,12000),textTruncated:true}),'sec-earnings');
  const again=await svc.section('NYSE:PNR','release');assert.equal(calls.length,2,'refetched');assert.equal(again.data.text.length,r.textChars);
});
test('research offers the release section for U.S. stocks through SEC and keeps the agent copy within one tool response',async()=>{
  const {ResearchService,digest}=require('../electron/research-service.cjs');const calls=[];
  const r=new ResearchService({db:new DatabaseSync(':memory:'),master:null,kis:async()=>{throw new Error('no KIS');},provider:async(op,payload)=>{calls.push([op,payload.symbol]);return {version:2,source:'SEC EDGAR 8-K filed 2026-10-27, EX-99.1',guidance:['g'],results:['r'],text:'t'.repeat(9000),textChars:9000};},secReady:()=>true});
  const s=await r.section('NYSE:PNR','release');assert.equal(s.status,'ok');assert.deepEqual(calls,[['sec-earnings','NYSE:PNR']]);await r.section('NYSE:PNR','release');assert.equal(calls.length,1,'cached');
  const d=digest('release',s.data);assert.equal(d.text.length,4000);assert.equal(d.textTruncated,true);assert.deepEqual(d.guidance,['g']);
  assert.ok(require('../electron/scout.cjs').RESEARCH_SECTIONS.includes('release'));assert.match(require('../electron/scout.cjs').RESEARCH_TOOL.description,/release: the latest earnings release as the company filed it/);
  const off=new ResearchService({db:new DatabaseSync(':memory:'),master:null,kis:async()=>{},provider:async()=>{throw new Error('x');},secReady:()=>false});assert.deepEqual(await off.section('NYSE:PNR','release'),{status:'unavailable',reason:'SEC_CONTACT_MISSING'});
});
// The evidence standard for a Buy, as the review asked: sourced facts, a valuation basis for a target price, and an
// explicit split between uncertainty acceptable at this size and what must be verified before adding more.
const {validateDecision}=require('../electron/ai-client.cjs');
const impact={weightBeforePct:0,weightAfterPct:5.4,related:[],relatedBeforePct:0,relatedAfterPct:5.4,equityReliable:true,why:'A small industrial starter outside the AI concentration.'};
const buy=plan=>validateDecision({action:'Buy',symbol:'NYSE:PNR',quantity:1,explanation:'Starter.',credit:'none',loanDate:'',plan:{strategy:'long-term',thesis:'Water-industrial cash generation',invalidation:'Guidance cut',stopPrice:58.1,targetPrice:null,horizonDays:365,confidence:'medium',portfolioImpact:impact,evidence:[],valuation:null,uncertainty:null,...plan}},['NYSE:PNR'],{requirePlan:true});
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
// The user found the agents' strategies too monotonous: every review now names the best idea of each strategy type it
// considered, and a Buy names its strategy; leveraged-tactical trades follow their own evidence and size rules.
test('strategy variety: a Buy names its strategy and each review records the ideas it considered by type',()=>{
  assert.equal(buy({evidence:[read],strategy:'none'}).withheld?.reason,'no strategy (long-term, swing, short-term or leveraged-tactical)');
  const d=validateDecision({action:'Hold',symbol:'',quantity:0,explanation:'x',credit:'none',loanDate:'',plan:{strategy:'none',thesis:'',invalidation:'i',stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low',portfolioImpact:null,evidence:[],valuation:null,uncertainty:null},
    strategyCheck:[{strategy:'long-term',idea:'Pentair add',verdict:'watching',reason:'After the guidance is verified.'},{strategy:'leveraged-tactical',idea:'KODEX 반도체레버리지 on a +4% SOX night',verdict:'rejected',reason:'No confirmation at the open.'},{strategy:'scalping',idea:'x',verdict:'acted',reason:'unknown type'}]},['NYSE:PNR'],{requirePlan:true});
  assert.deepEqual(d.strategyCheck.map(c=>[c.strategy,c.verdict]),[['long-term','watching'],['leveraged-tactical','rejected']]);
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','ai-client.cjs'),'utf8');
  assert.match(src,/Compare relevant permitted strategies\. Strategy variety is not a goal\. Report when no suitable candidate exists; do not manufacture a candidate to fill a category\./);assert.match(src,/neither variety nor diversification is required for its own sake/);assert.doesNotMatch(src,/Vary your strategies/);assert.match(src,/a likely move is a claim to support, not a feeling/);assert.match(src,/horizonDays within maxHoldingDays/);assert.match(src,/stage a tactical setup ahead/);
  const scoutRules=require('../electron/scout.cjs').INSTRUCTIONS;assert.match(scoutRules,/include a tactical candidate for it when one meets your standards/);
  // The scout and the trading reviews say the same: no variety or diversification for its own sake.
  assert.match(scoutRules,/Compare relevant permitted strategies\. Strategy variety is not a goal\. Report when no suitable candidate exists; do not manufacture a candidate to fill a category\./);assert.match(scoutRules,/neither variety nor diversification is required for its own sake/);assert.doesNotMatch(scoutRules,/Keep a mix of long-term|Prefer candidates that diversify/);assert.match(scoutRules,/An affordable ETF is a different investment, not a cheaper share/);
});
// Review of 40d7666..c276de6 (agent behaviour).
test('review: a fourth-quarter release keeps its results as results and its outlook as guidance; U.S. and entities read right',()=>{
  const html=`<p>Acme Reports Fourth-Quarter and Full-Year 2025 Results; Introduces 2026 Outlook</p><p>&bull; Fourth-quarter sales of $1.02 billion increased 4% compared to the prior year.</p>
<p>&bull; Full-year 2025 sales of $4.10 billion increased 2%; full-year adjusted EPS was $4.52, up 8%.</p><p>Fourth-quarter diluted EPS on a U.S. GAAP basis was $1.05, up 6% from a year ago.</p>
<p>Fourth-quarter operating income was $210 million, and segment margin expanded 120 basis points to 21.4%.</p><p>The board raised its quarterly dividend 5% to $0.25 per share.</p>
<p>2026 Outlook</p><p>For 2026, the company expects sales to grow 3% to 5% and adjusted EPS of $4.80 to $5.00.</p><p>Capital expenditures of about $120 million are planned for 2026.</p>
<p>Conference Call</p><p>The call on February 3, 2026 starts at 9:00 a.m. ET.</p>`;
  const f=sec.releaseFacts(sec.htmlText(html));
  assert.deepEqual(f.guidance,['For 2026, the company expects sales to grow 3% to 5% and adjusted EPS of $4.80 to $5.00.','Capital expenditures of about $120 million are planned for 2026.'],'the outlook section and forward wording; not the period labels, the dividend or the title');
  assert.ok(f.results.includes('Fourth-quarter sales of $1.02 billion increased 4% compared to the prior year.'),'bullets decoded and removed: '+JSON.stringify(f.results));
  assert.ok(f.results.includes('Fourth-quarter diluted EPS on a U.S. GAAP basis was $1.05, up 6% from a year ago.'),'not split at U.S.');
  assert.ok(!f.results.some(s=>/conference|call on/i.test(s)));assert.equal(sec.htmlText('<p>Acme&reg; &trade; &frac12;</p>'),'Acme® ™ ½');
});
test('review: a release larger than the round budget arrives shortened, not dropped',()=>{
  const rc=require('../electron/review-context.cjs');
  const reply={symbol:'NYSE:PNR',name:'Pentair',market:'NYSE',asOf:'2026-10-28',release:{source:'SEC EDGAR 8-K filed 2026-10-27, EX-99.1',guidance:Array.from({length:8},(_,i)=>'The Company expects fourth quarter sales to be up approximately 7 percent to 9 percent, item '+i+'.'),results:Array.from({length:10},(_,i)=>'Third quarter 2026 sales of $976 million decreased 3 percent, item '+i+'.'),text:'"'.repeat(1500)+'x'.repeat(2500)}};
  for(const limit of [8000,4000]){const b=rc.bound(reply,limit);assert.ok(rc.outBytes(b)<=limit,'within '+limit);assert.ok(b.release,'kept at '+limit);assert.deepEqual(b.shortenedParts,['release']);assert.equal(b.release.source,reply.release.source);assert.ok(b.release.guidance.length>=1);}
  assert.equal(rc.bound(reply,16000).release.text,reply.release.text,'untouched when it fits');
});
test('review: sector leads alone do not force a paid review; a short cover keeps the basic plan rules only',()=>{
  const saver=require('../electron/token-saver.cjs');const base={positions:{},cash:{KRW:1},quotes:[],marketSession:{open:true}};
  const a=saver.fingerprint({...base,sectorLeads:{us:{asOf:'2026-10-28T20:05:00Z',sectors:[{sector:'Technology',changePct:2.4}]}}}),b=saver.fingerprint({...base,sectorLeads:{us:{asOf:'2026-10-28T23:05:00Z',sectors:[{sector:'Technology',changePct:2.4}]}}});
  assert.equal(a.exact,b.exact);
  const cover=validateDecision({action:'Buy',symbol:'005930',quantity:1,explanation:'Cover the short.',credit:'cover',loanDate:'2026-10-20',plan:{strategy:'none',thesis:'Close the short',invalidation:'n/a',stopPrice:230000,targetPrice:null,horizonDays:1,confidence:'medium',portfolioImpact:{weightBeforePct:-14,weightAfterPct:0,related:[],relatedBeforePct:-14,relatedAfterPct:0,equityReliable:true,why:'Removes the short.'},evidence:[],valuation:null,uncertainty:null}},['005930'],{requirePlan:true});
  assert.equal(cover.action,'Buy','a cover is not held back for missing evidence');
  assert.equal(buy({evidence:[]}).withheld?.reason,'no evidence with sources','an opening Buy still is');
});
// Review of 7dc8395, P2: shortening halved the release text and dropped trailing guidance, and the cut content could not
// be read back: company research takes only section names, and the detail tool did not hold tool results.
test('review P2: a shortened research result keeps every guidance statement whole and can be read in full by path and page',async()=>{
  const rc=require('../electron/review-context.cjs'),{researchReview}=require('../electron/research-review.cjs');
  const guidance=Array.from({length:8},(_,i)=>`For the fourth quarter, the Company expects adjusted EPS of $1.${10+i} to $1.${20+i}, excluding restructuring costs and assuming no further tariff changes, statement ${i}; this outlook does not include acquisitions.`);
  const text=Array.from({length:120},(_,i)=>`Line ${i} of the release text, with figures ${i*7}.${i}%. `).join('');
  const reply={symbol:'NYSE:PNR',release:{source:'SEC EDGAR 8-K filed 2026-10-27, EX-99.1',guidance,results:Array.from({length:10},(_,i)=>'Third quarter 2026 sales of $976 million decreased 3 percent, item '+i+'.'),text}};
  const b=rc.bound(reply,4000,{ref:'result-1'});assert.ok(rc.outBytes(b)<=4000);
  assert.deepEqual(b.release.guidance,guidance,'no guidance statement is cut or dropped while other content can give way');
  assert.ok(b.cuts.some(c=>c.path==='release/text'&&c.chars===text.length&&c.keptChars<text.length),'the text cut is named by path: '+JSON.stringify(b.cuts));
  assert.equal(b.fullResult.section,'result-1');
  // Through a review: the agent reads the cut path back, page by page, from the stored result.
  const longText=text.repeat(8),longReply={...reply,release:{...reply.release,text:longText}};
  const outputs=[];let round=0;const call=(name,args,id)=>({name,args,callId:id});
  const request=async({continuation})=>{round++;if(continuation)outputs.push(...continuation.filter(o=>o.type==='function_call_output'));
    if(round===1)return {toolCalls:[call('get_company_research',{symbol:'NYSE:PNR',sections:['release']},'r1'),call('get_market_evidence',{symbol:'x'},'e1'),call('get_market_evidence',{symbol:'y'},'e2'),call('get_market_evidence',{symbol:'z'},'e3')],continuation:[]};
    const last=outputs.at(-1)&&JSON.parse(outputs.at(-1).output);
    if(round===2){const first=JSON.parse(outputs.find(o=>o.call_id==='r1').output);return {toolCalls:[call('get_context_detail',{section:first.fullResult?.section??'none',part:'release/text',from:0},'d1')],continuation:[]};}
    if(round===3)return {toolCalls:[call('get_context_detail',{section:'result-1',part:'release/text',from:last.next.from},'d2')],continuation:[]};
    return {decision:{action:'Hold'},pages:last};};
  const big=JSON.stringify({rows:'z'.repeat(14000)});
  const result=await researchReview({context:{universe:[]},evidence:{get:async()=>JSON.parse(big)},request,log:()=>{},discovery:{get_company_research:async()=>longReply},detail:null});
  assert.equal(result.decision.action,'Hold');
  const pages=outputs.filter(o=>o.call_id.startsWith('d')).map(o=>JSON.parse(o.output));const cut=JSON.parse(outputs.find(o=>o.call_id==='r1').output);
  assert.equal(cut.fullResult.section,'result-1','the shortened reply names where the full result is');assert.ok(cut.cuts.some(c=>c.path==='release/text'));
  assert.deepEqual(pages.map(p=>[p.section,p.part,p.from]),[['result-1','release/text',0],['result-1','release/text',pages[0].to]]);assert.ok(pages[1].next,'more text follows');
  assert.ok(longText.startsWith(pages[0].text+pages[1].text),'reads continue the text exactly');
  let all='',from=0;for(;;){const r=rc.detailPart({'result-1':longReply},{section:'result-1',part:'release/text',from});all+=r.text;if(!r.next)break;from=r.next.from;}assert.equal(all,longText,'every read together is the whole text');
});
test('a long-term horizon of up to 10 years is accepted; one outside 1 to 3,650 days is held back with that reason',()=>{
  // 2026-10-30: every review's three-year MediaAlpha Buy (1,095 days) was dropped by a 1,000-day limit and held back as
  // "no horizon", so the agent could not tell what to fix.
  const sourced={evidence:[read]};for(const days of [1095,3650,1])assert.equal(buy({...sourced,horizonDays:days}).action,'Buy',`${days} days`);
  assert.equal(buy({...sourced,horizonDays:1095}).plan.horizonDays,1095);
  for(const [days,why] of [[3651,/horizonDays 3651 is outside 1 to 3,650 days/],[0,/horizonDays 0 is outside/],[2.5,/horizonDays 2.5 is outside/],[null,/no horizon/]]){const d=buy({...sourced,horizonDays:days});assert.equal(d.action,'Hold',String(days));assert.match(d.withheld.reason,why);}
});
