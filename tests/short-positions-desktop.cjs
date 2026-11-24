// Short selling B3f-2 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 2): the "Short positions" section
// below the holdings on Home's card and the Holdings tab, from a stubbed KIS balance with two open shorts: one the app
// sold (a seeded record), one opened in the KIS app. The stock 990010 is held both ways: once in the holdings, once in
// the section. Both themes are captured. Made-up data only; no credential file is read.
const {app,dialog}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/short-positions-desktop');fs.mkdirSync(output,{recursive:true});
const ACCOUNT='short-fixture';const now=Date.now();
{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('fixture-short',ACCOUNT,JSON.stringify({id:'fixture-short',accountKey:ACCOUNT,market:'KR',environment:'mock',symbol:'990010',name:'Fixture short A',side:'Sell',quantity:10,filled:10,status:'Filled',createdAt:now-5*86400000,credit:{kind:'short',type:'22',loanDate:'2026-11-17'},lotLoanDate:'2026-11-17',madeBy:'review',reviewId:'fixture-review',limitPrice:1000}));db.close();}
const {KisService}=require('../electron/kis-service.cjs');
const holdings=[{symbol:'990010',name:'Fixture short A',quantity:3,cost:900,price:1200,marketValue:3600,unrealized:900},{symbol:'990030',name:'Fixture holding C',quantity:20,cost:5000,price:5200,marketValue:104000,unrealized:4000}];
const shorts=[{symbol:'990010',name:'Fixture short A',quantity:10,price:1200,entryPrice:1000,proceeds:10000,loanAmount:12000,loanDate:'2026-11-17',source:'distribution'},
  {symbol:'990020',name:'Fixture short B',quantity:5,price:900,entryPrice:1000,proceeds:5000,loanAmount:4500,loanDate:'2026-11-19',source:'distribution'}];
const snapshot={source:'kis',environment:'mock',accountKey:ACCOUNT,timestamp:new Date().toISOString(),cash:200000,reportedTotal:300000,holdings,shorts};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
KisService.prototype.request=async function(operation){
  if(operation==='quotes')return [...holdings,...shorts].map(h=>({symbol:h.symbol,price:h.price,retrievedAt:Date.now()}));
  if(operation==='orders')return {source:'kis',environment:'mock',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),orders:[]};
  if(operation==='profit')return {source:'kis',environment:'mock',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),records:[],summary:{realized:0,fee:0,tax:0,returnPct:0}};
  if(['history','company-chart','chart-bars','chart-stream'].includes(operation))throw new Error('not in this fixture');
  return snapshot;};
const timer=setTimeout(()=>{console.error('Short positions desktop timed out');app.exit(1);},90000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'navigation to '+tab);};
  await run('window.portfolio.importKis()');
  // Home: the section below the holdings list, one row per lot; the hand-opened short is marked and claims no stop.
  await until(`document.querySelectorAll('[aria-label="Short positions"] li').length===2`,'two short rows on Home');
  const home=await run(`Array.from(document.querySelectorAll('[aria-label="Short positions"] li')).map(li=>li.innerText.replace(/\\s+/g,' '))`);
  assert.match(home[0],/Fixture short A.*10 at ₩1,000.*-₩2,000.*No working stop: no cover stop is armed/);assert.match(home[1],/Fixture short B · opened in the KIS app.*5 at ₩1,000.*\+₩500.*No stop set/);
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('[aria-label="Holdings"] .home-holdings-list>li .company-link')).map(b=>b.textContent)`),['Fixture holding C','Fixture short A'],'the holdings list: holdings only');
  assert.ok(await run(`(()=>{const h=document.querySelector('[aria-label="Holdings"] .home-holdings-list'),s=document.querySelector('[aria-label="Short positions"]');return h.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING;})()`),'below the holdings');
  const allocation=await run(`document.querySelector('[aria-label="Allocation"]')?.innerText??''`);assert.doesNotMatch(allocation,/Fixture short B/,'a short joins no allocation');assert.match(allocation,/Holdings and cash/);assert.match(allocation,/Short positions are not in this chart\./);
  // Each short on two lines inside the holdings card: its first line never wraps.
  const lines=await run(`Array.from(document.querySelectorAll('[aria-label="Holdings"] .home-shorts-list .short-line')).map(l=>l.getBoundingClientRect().height)`);assert.equal(lines.length,2,'inside the Holdings card');assert.ok(lines.every(h=>h<26),'one line each: '+lines.join(','));
  for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run(`document.querySelector('[aria-label="Dark mode"]').click()`);await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'the theme switch');}
    await run(`document.querySelector('[aria-label="Short positions"]').scrollIntoView({block:'center'})`);await capture(`home-shorts-${theme}`);}
  // The Holdings tab: the full table below the holdings.
  await navigate('Holdings');await until(`document.querySelectorAll('[aria-label="Short positions"] tbody tr').length===2`,'two short rows on the Holdings tab');
  const heads=await run(`Array.from(document.querySelectorAll('[aria-label="Short positions"] th')).map(t=>t.textContent)`);assert.deepEqual(heads,['Stock','Quantity','Sale price','Price now','Result so far','Loan date','Last buy-back day','Stop']);
  const tab=await run(`Array.from(document.querySelectorAll('[aria-label="Short positions"] tbody tr')).map(tr=>Array.from(tr.cells).map(c=>c.innerText.trim()))`);
  assert.ok(tab.every(r=>/^\d{4}-\d{2}-\d{2} \(\d+ business days? left\)$/.test(r[6])),"the last buy-back day and the app's business-day count: "+tab.map(r=>r[6]).join(' | '));assert.deepEqual(tab.map(r=>[r[1],r[2],r[3],r[4],r[5],r[7]]),[['10','₩1,000','₩1,200','-₩2,000','2026-11-17','No working stop: no cover stop is armed'],['5','₩1,000','₩900','+₩500','2026-11-19','No stop set']]);
  for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run(`document.querySelector('[aria-label="Dark mode"]').click()`);await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'the theme switch');}
    await run(`document.querySelector('[aria-label="Short positions"]').scrollIntoView({block:'center'})`);await capture(`holdings-shorts-${theme}`);}
  console.log('Short positions desktop passed');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
