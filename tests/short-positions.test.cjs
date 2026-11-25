// Short selling B3f-2 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 2): the "Short positions" section
// below the holdings, on the Holdings tab and Home's holdings card. A short is not a holding (not in the rows, their
// share or the Allocation chart); one row per lot; a short opened in the KIS app is marked so and claims no stop; with no
// short the section is absent and both screens are as before. Made-up codes, prices and figures.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const ts=require('typescript');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const {Automation}=require('../electron/automation.cjs');
const LOT=(symbol,loanDate,extra={})=>({symbol,name:`Fixture ${symbol}`,quantity:10,price:1200,entryPrice:1000,proceeds:10000,loanAmount:12000,loanDate,...extra});
function automation({shorts,orders=[],unprotected=[],stops={}}){return Object.assign(Object.create(Automation.prototype),{watchScope:()=>'s',shortBalance:()=>({shorts,known:true}),
  live:{orders:()=>orders,identity:()=>'acct',exposure:{policy:()=>({short:{maxDays:90}})}},unprotectedNow:()=>unprotected,desk:{recentRows:()=>{reads.n++;return Object.entries(stops).flatMap(([k,list])=>list.map(o=>({side:'Buy',purpose:'stop_loss',symbol:k.split('|')[0],credit:{kind:'cover',loanDate:k.split('|')[1]},...o})));}},closedDays:[],officialClosedDays:()=>[]});}
const reads={n:0};
const sold=(symbol,loanDate)=>({side:'Sell',credit:{kind:'short'},filled:10,symbol,lotLoanDate:loanDate,lotTie:{loanDate,at:1,how:'exact'}});
test('the rows: one per open lot, result so far = proceeds less buying back now, KIS\'s end and the days to it, and the stop by its state',()=>{
  const now=Date.parse('2026-11-24T03:00:00Z');
  const a=automation({shorts:[LOT('990010','2026-11-03'),LOT('990020','2026-11-04',{price:900}),LOT('990030','2026-11-05'),LOT('990040','2026-11-06'),LOT('990050','2026-11-07'),LOT('990060','2026-11-07',{quantity:0})],
    orders:['990010|2026-11-03','990020|2026-11-04','990030|2026-11-05','990040|2026-11-06'].map(k=>sold(...k.split('|'))),
    unprotected:[{symbol:'990030',short:true,loanDate:'2026-11-05',outcome:'its cover stop was rejected'},{symbol:'990040',short:true,loanDate:'2026-11-06',held:true,waiting:'the open order of 990040'}],
    stops:{'990010|2026-11-03':[{status:'armed',conditions:[{value:1150}]}]}});
  reads.n=0;const rows=a.shortPositionsView('s',now);assert.equal(rows.length,5,'a closed lot (quantity 0) is not shown');assert.equal(reads.n,1,'the cover stops are read once per call');
  assert.equal(a.shortPositionsView('s',now+4000),rows,'within 5 seconds: the same rows, no read');assert.equal(reads.n,1);assert.notEqual(a.shortPositionsView('s',now+5000),rows,'after 5 seconds: read again');assert.equal(reads.n,2);
  const r=s=>rows.find(x=>x.symbol===s);
  assert.deepEqual(r('990010'),{symbol:'990010',name:'Fixture 990010',quantity:10,entryPrice:1000,price:1200,result:-2000,loanDate:'2026-11-03',lastDay:'2027-01-29',businessDaysLeft:48,pastLastDay:false,byHand:false,stop:{state:'armed',level:1150}},'the loan-end rule: its own last day and business days');
  assert.equal(r('990020').result,1000,'the price fell: a gain so far');assert.deepEqual(r('990020').stop,{state:'none',cause:'no cover stop is armed'});
  assert.deepEqual(r('990030').stop,{state:'none',cause:'its cover stop was rejected'});assert.deepEqual(r('990040').stop,{state:'waiting',why:'the open order of 990040'});
  assert.equal(r('990050').byHand,true,'not sold by the app: opened in the KIS app');assert.equal(r('990050').stop,null,'no stop claimed');
  // A hand short with a cover stop armed (the AI's or yours): shown, as not the app's own. A price of 0 is unreadable.
  const h=automation({shorts:[LOT('990070','2026-11-07',{price:0})],stops:{'990070|2026-11-07':[{status:'armed',conditions:[{value:1300}]}]}}).shortPositionsView('s',now)[0];
  assert.deepEqual(h.stop,{state:'armed',level:1300,notApps:true});assert.equal(h.price,null,'price 0: unreadable');assert.equal(h.result,null,'and so the result');
  // Past the last day: in words, never a negative count.
  const past=automation({shorts:[LOT('990080','2026-08-01')],orders:[sold('990080','2026-08-01')]}).shortPositionsView('s',now)[0];assert.equal(past.pastLastDay,true);assert.equal(past.businessDaysLeft,null);
  assert.deepEqual(automation({shorts:[]}).shortPositionsView('s',now),[]);assert.deepEqual(automation({shorts:[LOT('990010','2026-11-03',{quantity:0})]}).shortPositionsView('s',now),[]);
  // An unreadable figure is shown as unknown, not guessed.
  const u=automation({shorts:[LOT('990010','2026-11-03',{proceeds:null})]}).shortPositionsView('s',now)[0];assert.equal(u.result,null);
});
test('the stop\'s words; a short opened in the KIS app claims none',async()=>{
  const {shortStopText,shortResultClass,shortLoanText}=await import('../src/short-positions.mjs');const won=v=>'₩'+v;
  assert.equal(shortStopText({byHand:true,stop:{state:'armed',level:1300,notApps:true}},won),"Stop at ₩1300 (not the app's own)");assert.equal(shortStopText({byHand:true,stop:null},won),'No stop set','said, not a dash');
  assert.equal(shortLoanText({lastDay:'2027-01-29',businessDaysLeft:48}),'2027-01-29 (48 business days left)');assert.equal(shortLoanText({lastDay:'2027-01-29',businessDaysLeft:1}),'2027-01-29 (1 business day left)');
  assert.equal(shortLoanText({lastDay:'2026-10-29',pastLastDay:true,businessDaysLeft:null}),'2026-10-29, past its last day');assert.equal(shortLoanText({lastDay:null}),'—');
  assert.equal(shortStopText({stop:{state:'armed',level:1150}},won),'Stop at ₩1150');assert.equal(shortStopText({stop:{state:'waiting',why:'held'}},won),'Stop waiting: held');
  assert.equal(shortStopText({stop:{state:'none',cause:'its cover stop was rejected'}},won),'No working stop: its cover stop was rejected');
  assert.equal(shortResultClass(-1),'negative');assert.equal(shortResultClass(1),'positive');assert.equal(shortResultClass(0),'muted');assert.equal(shortResultClass(null),'muted');
});
// The screens, rendered: the section with shorts, and Home's card byte for byte as before without them.
async function load(file,stubs){const src=fs.readFileSync(path.join(__dirname,'../src',file),'utf8');const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const local=name=>stubs[name]??new Proxy({},{get:(_,k)=>k==='__esModule'?true:()=>null});const mod={exports:{}};new Function('require','module','exports',js)(n=>n.startsWith('.')?local(n):require(n),mod,mod.exports);return mod.exports;}
test('Home: the section below the holdings with a row per lot; with no short the card is exactly as without the section',async()=>{
  const words=await import('../src/short-positions.mjs');const {ShortPositions}=await load('ShortPositions.tsx',{'./short-positions.mjs':words});
  const base={'./pending':{pendingKRW:()=>0},'./useDraftState':{useDraftState:(k,v)=>React.useState(v)},'./AllocationChart':{AllocationChart:()=>null}};
  const withSection=(await load('Home.tsx',{...base,'./ShortPositions':{ShortPositions}})).HomeHoldings,without=(await load('Home.tsx',{...base,'./ShortPositions':{ShortPositions:()=>null}})).HomeHoldings;
  const holding={symbol:'990010',name:'Fixture 990010',market:'KR',currency:'KRW',quantity:3,price:1200,cost:1000,valueKRW:3600,sector:'X',region:'Korea',color:'#888'};
  const render=(H,state)=>renderToStaticMarkup(React.createElement(H,{state:{rows:[holding],cash:{KRW:0,USD:0},fx:{usdKRW:1400},...state},onCompany(){},onAll(){},onRefresh(){},busy:false}));
  for(const shorts of [undefined,[]])assert.equal(render(withSection,{shorts}),render(without,{}),'no short: as before');
  const rows=[{symbol:'990010',name:'Fixture 990010',quantity:10,entryPrice:1000,price:1200,result:-2000,loanDate:'2026-11-03',lastDay:'2027-01-29',businessDaysLeft:48,pastLastDay:false,byHand:false,stop:{state:'armed',level:1150}},
    {symbol:'990050',name:'Fixture 990050',quantity:5,entryPrice:1000,price:900,result:500,loanDate:'2026-11-07',lastDay:'2027-02-04',businessDaysLeft:51,pastLastDay:false,byHand:true,stop:null}];
  const html=render(withSection,{shorts:rows});assert.match(html,/aria-label="Short positions"/);assert.match(html,/Fixture 990010.*10 at ₩1,000.*-₩2,000.*Stop at ₩1,150/s);assert.match(html,/Fixture 990050<small class="muted"> · opened in the KIS app<\/small>/);
  assert.ok(html.indexOf('aria-label="Short positions"')>html.indexOf('home-holdings-list'),'below the holdings');
  // Part of the holdings card: a subheading inside the Holdings section, no section of its own; two lines per short.
  const card=html.slice(html.indexOf('aria-label="Holdings"'),html.indexOf('aria-label="Allocation"'));assert.match(card,/<div class="home-shorts" role="group" aria-label="Short positions"><h3 class="home-shorts-title">Short positions<\/h3>/);
  assert.match(html,/<div class="short-line">.*Fixture 990010.*<\/div><small class="muted short-detail">Stop at ₩1,150 · last buy-back day 2027-01-29 \(48 business days left\), the app&#x27;s count<\/small>/);
  assert.match(html,/<small class="muted short-detail">No stop set · last buy-back day 2027-02-04/);
  // A stock held both ways: once in the holdings list and once in the short section.
  assert.equal((html.match(/Fixture 990010/g)??[]).length,2);
});
test('the Holdings tab: the full section below the holdings; a short joins no holding row, share or allocation',async()=>{
  const words=await import('../src/short-positions.mjs');const {ShortPositions}=await load('ShortPositions.tsx',{'./short-positions.mjs':words});
  const html=renderToStaticMarkup(React.createElement(ShortPositions,{rows:[{symbol:'990010',name:'Fixture 990010',quantity:10,entryPrice:1000,price:1200,result:-2000,loanDate:'2026-11-03',lastDay:'2027-01-29',businessDaysLeft:48,pastLastDay:false,byHand:false,stop:{state:'none',cause:'its cover stop was rejected'}}]}));
  for(const h of ['Stock','Quantity','Sale price','Price now','Result so far','Loan date','Last buy-back day','Stop'])assert.match(html,new RegExp('<th[^>]*>'+h+'</th>'));assert.match(html,/No working stop: its cover stop was rejected/);
  assert.equal(renderToStaticMarkup(React.createElement(ShortPositions,{rows:[]})),'');assert.equal(renderToStaticMarkup(React.createElement(ShortPositions,{})),'');
  const src=fs.readFileSync(path.join(__dirname,'../src/UnifiedPortfolio.tsx'),'utf8');assert.match(src,/<\/details><\/section>\{mode==='holdings'&&<ShortPositions rows=\{state\.shorts\}\/>\}\{mode==='holdings'&&<SectionBoundary label="Movement"/);
  // The portfolio rows (holdings, their share, the Allocation chart) come from holdings only.
  const {combinePortfolio}=require('../electron/portfolio-view.cjs');const kr={source:'kis',environment:'live',timestamp:new Date().toISOString(),cash:1000,settledCash:1000,holdings:[],shorts:[{symbol:'990010',quantity:10,price:1200,proceeds:10000,loanAmount:12000,loanDate:'2026-11-03'}]};
  assert.deepEqual(combinePortfolio(kr,null,null,{}).rows,[]);
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.match(main,/\.\.\.\(\(\)=>\{try\{const s=automation\.shortPositionsView\(\);return s\.length\?\{shorts:s\}:\{\};\}catch\{return \{\};\}\}\)\(\)/,'absent with no short');
});
test('the Allocation chart while a short is open: its total is "Holdings and cash" and a line says shorts are not in it; with none, as before',async()=>{
  const {AllocationChart}=await load('AllocationChart.tsx',{'./useDraftState':{useDraftState:(k,v)=>React.useState(v)}});
  const buckets=[{label:'Fixture holding C',value:104000,percent:0,color:'#888'},{label:'Cash',value:200000,percent:0,color:'#7e858c'}];
  const draw=props=>renderToStaticMarkup(React.createElement(AllocationChart,{buckets,equity:304000,...props}));
  assert.equal(draw({}),draw({shortsOpen:false}),'no short: as before');assert.match(draw({}),/<small>Total equity<\/small>/);assert.doesNotMatch(draw({}),/Short positions are not in this chart/);
  const open=draw({shortsOpen:true});assert.match(open,/<small>Holdings and cash<\/small>/);assert.match(open,/Short positions are not in this chart\./);assert.doesNotMatch(open,/Total equity/);
  for(const f of ['Home.tsx','UnifiedPortfolio.tsx'])assert.match(fs.readFileSync(path.join(__dirname,'../src',f),'utf8'),/equity=\{equity\} shortsOpen=\{Boolean\(state\.shorts\?\.length\)\}\/>/,f);
});
