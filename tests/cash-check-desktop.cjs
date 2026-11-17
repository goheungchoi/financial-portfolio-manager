// Item 9: the desktop hook for the Home line. A made-up KIS account (fixture replies only; nothing reaches a real service)
// has a ₩3,000,000 Korean cash change the flow detector holds, written into this run's own data folder before the app
// starts. Home's "Needs you" shows it ("seen hh:mm · checking; not a return yet"); [Record it] opens Performance with
// the deposit form filled; recording it explains the held change, and the line goes away.
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/cash-check-desktop');fs.mkdirSync(output,{recursive:true});
const A='cash-check-fixture',CASH=10000000,HELD=3000000,since=Date.now()-5*60000;
const domestic={accountKey:A,environment:'mock',source:'kis',cash:CASH,reportedTotal:CASH,holdings:[]};
// The held change, as the detector saves it: the last reading had today's cash (so no new change), and the rise is held.
{const {DatabaseSync}=require('node:sqlite');const {BASIS}=require('../electron/flow-detector.cjs');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS flow_watch(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const held={amount:HELD,since,after:since-120000,parts:[{id:'seed-part',amount:HELD,after:since-120000,by:since}]};
  db.prepare('INSERT OR REPLACE INTO flow_watch VALUES(?,?)').run(A,JSON.stringify({at:since,krCash:CASH,usCash:null,basis:BASIS,provisionalKRW:0,provOut:0,unsettledKRW:0,fills:{},pending:{KR:held},settled:[]}));
  // A detected ₩2,000,000 deposit from an hour ago, not yet confirmed: recording it yourself replaces it (the form says so).
  db.exec('CREATE TABLE IF NOT EXISTS cash_flows(id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL)');const hourAgo=Date.now()-3600000,day=new Date(hourAgo+9*3600000).toISOString().slice(0,10);
  db.prepare('INSERT OR REPLACE INTO cash_flows VALUES(?,?,?)').run('seed-detected',A,JSON.stringify({id:'seed-detected',day,market:'KR',currency:'KRW',amount:2000000,note:'Detected: Korean cash rose with no matching trade. Confirm or remove.',createdAt:hourAgo,detected:true,pendingIds:['seed-old-part'],occurredAfter:hourAgo-120000,occurredBy:hourAgo}));db.close();}
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fake-cash-check-file-never-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='import')return this.workerScript==='provider-worker.cjs'?{aiConnected:false,dartConnected:false,pushConnected:false}:{...domestic,timestamp:new Date().toISOString()};
  if(operation==='refresh')return {...domestic,timestamp:new Date().toISOString()};
  if(operation==='live-context')return {balance:{...domestic,timestamp:new Date().toISOString()},quotes:[],marketSession:{open:false,status:'closed'}};
  if(operation==='us-context')throw new Error('FEATURE_UNAVAILABLE');
  if(operation==='orders'||operation==='us-orders')return {orders:[]};if(operation==='quotes')return [];if(operation==='news')return [];
  throw new Error('FEATURE_UNAVAILABLE');};
const timer=setTimeout(()=>{console.error('Cash-check desktop timed out');app.exit(1);},120000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  await run('window.portfolio.importKis()');await run('window.portfolio.refreshPortfolio()');
  const seenAt=new Date(since).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});const want=`Korean cash up ₩3,000,000, seen ${seenAt} · checking; not a return yet`;
  await until(`Array.from(document.querySelectorAll('.attention-item')).some(li=>li.textContent.includes(${JSON.stringify(want)}))`,'the Home line');await capture('home-cash-check');
  await run(`Array.from(document.querySelectorAll('.attention-item')).find(li=>li.textContent.includes(${JSON.stringify(want)})).querySelector('button').click()`);
  await until(`document.querySelector('h1')?.textContent==='Performance'`,'Performance');await until(`document.querySelector('[aria-label="Flow amount"]')?.value==='3,000,000'`,'the form filled');
  assert.equal(await run(`document.querySelector('[aria-label="Flow type"]').value`),'deposit');assert.equal(await run(`document.querySelector('[aria-label="Flow account"]').value`),'KR');
  await run(`document.querySelector('[aria-label="Flow amount"]').scrollIntoView({block:'center'})`);await capture('performance-record-it');
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Record deposit').click()`);
  await until(`window.portfolio.getPerformance().then(r=>r.state.flows.some(f=>f.amount===${HELD}&&!f.detected))`,'the recorded deposit');
  // The next reading explains the held change by your record (M-1c), and the line goes away.
  await run('window.portfolio.refreshPortfolio()');await until(`window.portfolio.getAttention().then(a=>!a.items.some(i=>i.id==='cash-check-KR'))`,'the line gone');
  // Recording the detected ₩2,000,000 yourself replaces it, and the form says so.
  await run(`(()=>{const e=document.querySelector('[aria-label="Flow amount"]');e.focus();e.select();document.execCommand('insertText',false,'2000000');})()`);
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Record deposit').click()`);
  await until(`Array.from(document.querySelectorAll('[role=status]')).some(s=>/Recorded\\. It replaces the detected change of ₩2,000,000, so the money is counted once\\./.test(s.textContent))`,'the replaced note');await capture('performance-replaced');
  const flows=await run('window.portfolio.getPerformance().then(r=>r.state.flows.map(f=>({amount:f.amount,detected:Boolean(f.detected)})).sort((a,b)=>a.amount-b.amount))');
  assert.deepEqual(flows,[{amount:2000000,detected:false},{amount:HELD,detected:false}],'each counted once, as your deposits');
  console.log('Cash-check desktop passed: the Home line, [Record it] fills the form, recording explains the held change and the line goes away.');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
