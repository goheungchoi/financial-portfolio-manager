// Start and Stop on a Claude trading model (artifacts/reviews/2026-11-18-claude-dry-run-start): the desktop case of the
// 1.5.67 check. A completed Claude dry run that offered several orders (the several-orders fingerprint, as the user's
// 11-17 and 11-18 records) is written into this run's own data folder before the app starts. With Claude Opus 5.5 and
// several orders on:
// - Start reaches running; Stop stops;
// - while running, the dry run stops counting (an older fingerprint): Stop still stops (refused since 1.5.65 before);
// - Start is then refused and says why in a sentence, not the code;
// - with the dry run counting again, Start and Stop work.
// Made-up data only; no credential file is read and no AI request is sent.
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/claude-start-stop-desktop');fs.mkdirSync(output,{recursive:true});
const RI=require('../electron/review-instructions.cjs');const ORDERS_FP=RI.fingerprint(undefined,{orders:true}),OLD_FP='d50342a570a47586';
const SENTENCE='Trading on Claude Opus 5.5 needs a dry run on this version first: Dashboard → Dry run → Claude Opus 5.5.';
const ACCOUNT='claude-start-fixture';const dbFile=path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite');
const {DatabaseSync}=require('node:sqlite');
const dryRun=fingerprint=>{const at=Date.now()-3600000;return JSON.stringify({id:'fixture-dry-run',timestamp:at,mode:'review',summary:{account:{key:ACCOUNT}},
  review:{model:'claude-opus-5-5',decision:{action:'Hold'},calls:2,costUSD:0.33,appVersion:'1.5.66',instructions:{version:RI.ORDERS_VERSION,fingerprint},answerForm:'enforced',measurement:{requests:[{answerForm:'enforced'}],totals:{costUSD:0.33}}}});};
const setDryRun=fingerprint=>{const db=new DatabaseSync(dbFile);try{db.prepare('UPDATE dry_runs SET payload=? WHERE id=?').run(dryRun(fingerprint),'fixture-dry-run');}finally{db.close();}};
{const db=new DatabaseSync(dbFile);db.exec('CREATE TABLE IF NOT EXISTS dry_runs(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run('fixture-dry-run',Date.now()-3600000,dryRun(ORDERS_FP));
  db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('fixture-dry-run-call',new Date().toISOString().slice(0,10),JSON.stringify({reviewId:'fixture-dry-run',model:'claude-opus-5-5',status:'completed',usage:{inputTokens:1000,outputTokens:100},accountedMicro:330000}));db.close();}
const domestic={accountKey:ACCOUNT,environment:'mock',source:'kis',cash:10000000,reportedTotal:10000000,holdings:[]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fake-file-never-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='import')return this.workerScript==='provider-worker.cjs'?{aiConnected:true,openaiConnected:true,anthropicConnected:true,dartConnected:false,pushConnected:false}:{...domestic,timestamp:new Date().toISOString()};
  if(operation==='refresh'||operation==='balance')return {...domestic,timestamp:new Date().toISOString()};
  if(operation==='live-context')return {balance:{...domestic,timestamp:new Date().toISOString()},quotes:[],marketSession:{open:false,status:'closed'}};
  if(operation==='orders'||operation==='us-orders')return {orders:[]};
  if(operation==='quotes')return (payload?.symbols??[]).map(symbol=>({symbol,price:1000,retrievedAt:Date.now()}));
  if(['decision','scout','narrative','reflection','compact','test'].includes(operation))throw new Error('No AI request in this fixture: '+operation);
  return {...domestic,timestamp:new Date().toISOString()};};
const timer=setTimeout(()=>{console.error('Claude start/stop desktop timed out');app.exit(1);},150000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const header='Array.from(document.querySelectorAll(`button`)).find(b=>/^(Start auto trading|Stop auto trading)$/.test(b.textContent))';
  const note=`Array.from(document.querySelectorAll('p[role=status]')).map(p=>p.textContent).find(t=>/^Auto trading (started|stopped)|Trading on Claude|CLAUDE_|Could not/.test(t))??null`;
  const runtime=()=>run('window.portfolio.getRuntime().then(s=>({running:Boolean(s?.launch?.running),enabled:s?.config?.enabled,autoSubmit:s?.config?.autoSubmit,model:s?.config?.openaiModel,ready:s?.claudeTrading?.dryRunReady}))');
  const idle=`(async()=>{const s=await window.portfolio.getRuntime();return Boolean(s?.launch)&&!s.launch.starting&&!s.busy;})()`;
  // The screen reads the runtime (and its launch token) on its own feed; a save made here reaches it within about 2 s
  // (as G4 in ui-regression-desktop waits). A click before that sends the old token and is refused as changed settings.
  const click=async label=>{await until(idle,'idle before '+label);await new Promise(r=>setTimeout(r,2500));await until(`${header}?.textContent===${JSON.stringify(label)}`,'the button '+label);await run(`${header}.click()`);};
  const results={};
  await run('window.portfolio.importKis()');await run('window.portfolio.importProviders()');
  await until(`window.portfolio.getRuntime().then(s=>s.providerStatus.anthropicConnected===true&&s.connections.kis.status==='connected')`,'KIS and the providers connected');
  // The KIS scope first, as the user's saved settings: the dry run's account is read from the saved scope.
  assert.equal((await run(`window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true})`)).ok,true);
  const saved=await run(`window.portfolio.configureRuntime({openaiModel:'claude-opus-5-5',reasoningEffort:'medium',claudeTradingConfirmed:true,severalOpenOrders:true,ordersPerReview:3,anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true,enabled:false,autoSubmit:false,closedMarketReviews:'keep'})`);
  assert.equal(saved.ok,true,'the switch to Claude saves with the several-orders dry run: '+JSON.stringify(saved.error));
  assert.equal((await runtime()).ready,true,'the several-orders dry run counts');
  await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='Home')?.click()`);await new Promise(r=>setTimeout(r,1500));
  // 1. Start and Stop with the several-orders dry run.
  await click('Start auto trading');await until(`window.portfolio.getRuntime().then(s=>s.launch.running)`,'running');await until(`(${note})?.startsWith('Auto trading started')`,'the start note');
  results.start=await run(note);await capture('claude-start-running');
  await click('Stop auto trading');await until(`window.portfolio.getRuntime().then(s=>!s.launch.running&&s.config.enabled===false)`,'stopped');results.stop=await run(note);
  assert.match(results.stop,/^Auto trading stopped/);
  // 2. Running, then the dry run stops counting: Stop still stops.
  await click('Start auto trading');await until(`window.portfolio.getRuntime().then(s=>s.launch.running)`,'running again');
  setDryRun(OLD_FP);await new Promise(r=>setTimeout(r,500));
  await click('Stop auto trading');await until(`window.portfolio.getRuntime().then(s=>!s.launch.running&&s.config.enabled===false&&s.config.autoSubmit===false)`,'stopped with a dry run that no longer counts');
  results.stopStale=await run(note);assert.match(results.stopStale,/^Auto trading stopped/,'Stop is not refused');await capture('claude-stop-stale-dry-run');
  // 3. Start is refused and says why in a sentence.
  await click('Start auto trading');await until(`(${note})===${JSON.stringify(SENTENCE)}`,'the refusal sentence');results.refused=await run(note);
  const after=await runtime();assert.equal(after.running,false);assert.equal(after.enabled,false);await capture('claude-start-refused-sentence');
  // 4. The dry run counts again: Start and Stop.
  setDryRun(ORDERS_FP);await new Promise(r=>setTimeout(r,500));
  await click('Start auto trading');await until(`window.portfolio.getRuntime().then(s=>s.launch.running)`,'running after the dry run counts again');
  await click('Stop auto trading');await until(`window.portfolio.getRuntime().then(s=>!s.launch.running&&s.config.enabled===false)`,'stopped at the end');
  assert.equal((await runtime()).model,'claude-opus-5-5','the trading model never changed');
  console.log('Claude start/stop desktop passed '+JSON.stringify(results));clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);try{console.error('Notes: '+JSON.stringify(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('p[role=status]')).map(p=>p.textContent)`)));
  console.error('Launch: '+JSON.stringify(await win.webContents.executeJavaScript('window.portfolio.getRuntime().then(s=>({launch:s.launch,busy:s.busy,enabled:s.config.enabled,lastError:s.lastError??null}))')));}catch{}
  clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
