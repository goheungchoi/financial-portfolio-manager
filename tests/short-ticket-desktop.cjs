// Short selling B3f-4: the Korea tab's Orders card with seeded records: your own buy prepared while a short was open
// (KIS's orderable cash shown), a cover with its buy-back cost, and a cash buy as before. Both themes are captured.
// Made-up data only; no credential file is read.
const {app,dialog}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/short-ticket-desktop');fs.mkdirSync(output,{recursive:true});
const ACCOUNT='short-ticket-fixture';const now=Date.now();
const cost=(netCash,extra={})=>({currency:'KRW',basis:'estimate',gross:Math.abs(netCash)-15,commission:15,transactionTax:0,netCash,gainAfterFees:null,...extra});
{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,payload TEXT NOT NULL)');
  const put=o=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(o.id,ACCOUNT,JSON.stringify({accountKey:ACCOUNT,market:'KR',environment:'live',createdAt:now-60000,filled:0,...o}));
  put({id:'fixture-ticket-buy',symbol:'990030',name:'Fixture holding C',side:'Buy',quantity:2,limitPrice:5000,status:'Rejected',reason:'INSUFFICIENT_CAPACITY',madeBy:'ticket',shortOrderableCash:7200,shortCashFact:"a short is open; KIS's orderable cash is 7,200",costEstimate:cost(-10015)});
  put({id:'fixture-ticket-buy-unread',symbol:'990030',name:'Fixture holding C',side:'Buy',quantity:1,limitPrice:5000,status:'Rejected',reason:'INSUFFICIENT_CAPACITY',madeBy:'ticket',shortOrderableCash:null,shortCashFact:"a short is open; KIS's orderable cash could not be read",costEstimate:cost(-5008)});
  put({id:'fixture-cover',symbol:'990010',name:'Fixture short A',side:'Buy',quantity:10,limitPrice:1200,status:'Ready',madeBy:'ticket',credit:{kind:'cover',type:'26',loanDate:'2026-11-17'},costEstimate:cost(-12015)});
  put({id:'fixture-cash-buy',symbol:'990030',name:'Fixture holding C',side:'Buy',quantity:1,limitPrice:5000,status:'Ready',madeBy:'ticket',costEstimate:cost(-5008)});db.close();}
const {KisService}=require('../electron/kis-service.cjs');
const snapshot={source:'kis',environment:'live',accountKey:ACCOUNT,timestamp:new Date().toISOString(),cash:200000,reportedTotal:300000,holdings:[{symbol:'990030',name:'Fixture holding C',quantity:20,cost:5000,price:5000,marketValue:100000,unrealized:0}],shorts:[{symbol:'990010',name:'Fixture short A',quantity:10,price:1200,entryPrice:1000,proceeds:10000,loanAmount:12000,loanDate:'2026-11-17'}]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
KisService.prototype.request=async function(operation){
  if(operation==='quotes')return [{symbol:'990030',price:5000,retrievedAt:Date.now()},{symbol:'990010',price:1200,retrievedAt:Date.now()}];
  if(operation==='orders')return {source:'kis',environment:'live',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),orders:[]};
  if(operation==='profit')return {source:'kis',environment:'live',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),records:[],summary:{realized:0,fee:0,tax:0,returnPct:0}};
  if(['history','company-chart','chart-bars','chart-stream'].includes(operation))throw new Error('not in this fixture');
  return snapshot;};
const timer=setTimeout(()=>{console.error('Short ticket desktop timed out');app.exit(1);},90000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'navigation to '+tab);};
  await run('window.portfolio.importKis()');await navigate('KIS trading');
  await until(`document.querySelectorAll('[aria-label="Orders"] .order-row').length===4`,'four orders');
  const lines=await run(`Array.from(document.querySelectorAll('[aria-label="KIS orderable cash"]')).map(e=>e.textContent)`);
  assert.deepEqual(lines.sort(),["A short is open: KIS's orderable cash could not be read","A short is open: KIS's orderable cash ₩7,200"],'only your buys prepared while a short was open');
  const sums=await run(`Array.from(document.querySelectorAll('[aria-label="Orders"] .order-row')).map(r=>r.querySelector('summary')?.textContent??'')`);
  assert.ok(sums.some(s=>/^Buy-back cost with charges · ₩12,015 · Estimated$/.test(s)),'the cover: '+sums.join(' | '));assert.ok(sums.some(s=>/^Total purchase cost · ₩5,008 · Estimated$/.test(s)),'a cash buy: as before');
  for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run(`document.querySelector('[aria-label="Dark mode"]').click()`);await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'the theme switch');}
    await run(`document.querySelector('[aria-label="Orders"]').scrollIntoView({block:'start'})`);await capture(`ticket-orders-${theme}`);}
  console.log('Short ticket desktop passed');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
