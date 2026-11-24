// Orders while stopped, B-4 (artifacts/reviews/2026-11-24-orders-while-stopped): the desktop cases, one mode per run
// (--mode=…), each in its own data folder with made-up data written before the app starts:
//   watch-on   the setting on and auto trading stopped after a restart (no Start): Home's watched line, the Stop
//              everything button and its reply, then "Everything stopped"; Engine settings' row
//   watch-off  the setting off: Home's 1.5.73 line, no Stop everything; turning the setting on through its confirmation,
//              then Home's watched line and Stop's reply
//   notice     found in live use on 1.5.74: a start after a closed run with the setting off, then the setting turned on.
//              Home's start notice follows the watch state: not watched, then watched, Dismiss, then not watched again
//              when the setting goes off (a changed statement shows again), the dismissed watched one stays hidden, and
//              Stop everything says not watched
// KIS is a stand-in (KisService.prototype.request, as s5-desktop.cjs); nothing reaches a real service.
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const mode=(process.argv.find(a=>a.startsWith('--mode='))??'--mode=watch-on').slice(7);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/b4-desktop');fs.mkdirSync(output,{recursive:true});
const DB=path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite');const ACCOUNT='fixture-acct';
const seoulDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);

// ---- The data written before the app starts: two armed stops, the day's limits saved for the account (auto trading
// was started on it before), and in watch-on the setting with the switches of that last run.
{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(DB);const D=require('../electron/agent-desk.cjs');const desk=new D.AgentDesk(db,Date.now);
  for(const [sym,level] of [['990010',90],['990020',180]]){const r=desk.setOrder('kis:'+ACCOUNT,{action:'add',id:'',symbol:sym,side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:`price("${sym}")`,op:'<=',value:level}],combine:'all',purpose:'stop_loss',expiresInHours:48,reason:'Fixture stop.',replaces:null},{config:{...D.COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5},universe:['990010','990020']});
    assert.ok(['armed','saved'].includes(r.status),'seeded stop: '+JSON.stringify(r));}
  const {LiveEngine}=require('../electron/live-engine.cjs');const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'disconnected',snapshot:null}));
  e.writePolicy(ACCOUNT,{symbols:[],anyStock:true,day:seoulDay(Date.now()),lossLimit:{mode:'off',value:0},maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null});
  // A previous run of this app that the user closed an hour ago, watching this account (the start notice's launch facts).
  if(mode==='notice'){const t=Date.now();db.exec('CREATE TABLE IF NOT EXISTS app_exit(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');db.prepare('INSERT INTO app_exit VALUES(1,?)').run(JSON.stringify({startedAt:t-3*3600000,heartbeatAt:t-3600000,stop:{kind:'clean',at:t-3600000},scope:'kis:'+ACCOUNT}));}
  if(mode==='watch-on'){const W=require('../electron/watch-while-stopped.cjs');new W.WatchWhileStopped(db).turnOn({account:ACCOUNT,environment:'mock',record:{autoSubmit:true,conditionalAutoSubmit:true,scope:'kis',markets:{KR:true,US:false},at:Date.now()-3600000}});}
  db.close();}

// ---- KIS stand-in. Prices sit above both stops, so nothing fires.
{const {KisService}=require('../electron/kis-service.cjs');
  const snapshot={source:'kis',environment:'mock',accountKey:ACCOUNT,timestamp:new Date().toISOString(),cash:500000,reportedTotal:800000,holdings:[{symbol:'990010',name:'Fixture 990010',quantity:2,cost:100,price:140,marketValue:280,unrealized:0},{symbol:'990020',name:'Fixture 990020',quantity:3,cost:100000,price:100000,marketValue:300000,unrealized:0}]};
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
  KisService.prototype.request=async function(operation,payload){
    if(operation==='quotes')return [{symbol:'990010',price:140,retrievedAt:Date.now()},{symbol:'990020',price:100000,retrievedAt:Date.now()}];
    if(operation==='orders')return {source:'kis',environment:'mock',startDate:payload?.startDate,endDate:payload?.endDate,retrievedAt:new Date().toISOString(),orders:[]};
    if(operation==='profit')return {source:'kis',environment:'mock',records:[],summary:{}};
    return snapshot;};}

const timer=setTimeout(()=>{console.error(`B-4 desktop (${mode}) timed out`);app.exit(1);},150000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=30000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,250));}throw new Error('Timed out waiting for '+what+'. Page: '+String(await run('document.body.innerText')).slice(0,600));};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,`b4-${mode}-${name}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'the '+tab+' page');};
  const has=text=>`document.body.innerText.includes(${JSON.stringify(text)})`;
  const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
  await run('window.portfolio.importKis()');await until(`window.portfolio.getMarket().then(s=>s.source==='kis')`,'the KIS connection');
  await run(`window.portfolio.configureRuntime({scope:'kis',shareKisWithOpenAI:true,conditionalOrders:true,conditionalAutoSubmit:true})`);
  await until(`window.portfolio.getRuntime().then(s=>s.config.scope==='kis'&&s.config.conditionalOrders===true)`,'the KIS scope with conditional orders');
  const WATCHED='Auto trading is stopped. Your 2 armed orders are still watched and are sent by themselves if their conditions are met.';

  if(mode==='watch-on'){await navigate('Home');await until(has(WATCHED),'Home\'s watched line');await until(`Boolean(${button('Stop everything')})`,'the Stop everything button');
    assert.equal(await run(has('not watched until auto trading is started')),false,'not the 1.5.73 line');
    await until(`!document.body.innerText.includes('Connect your KIS account')`,'Needs you after the connection',15000);await capture('home-watched');
    await run(`${button('Stop everything')}.click()`);await until(has('Everything stopped. No order will be sent by the app; orders already at KIS stay.'),'Stop everything\'s reply');
    await until(has('Everything stopped: no order is watched.'),'Home after Stop everything');assert.equal(await run(`Boolean(${button('Stop everything')})`),false,'the button goes');await capture('home-everything-stopped');
    const state=await run('window.portfolio.getRuntime()');assert.equal(state.desk.whileStopped.everythingStopped,true);assert.equal(state.desk.monitoringActive,false);}

  if(mode==='watch-off'){await navigate('Home');await until(has('2 stops are not watched until auto trading is started.'),'Home\'s 1.5.73 line');
    assert.equal(await run(`Boolean(${button('Stop everything')})`),false,'no Stop everything with the setting off');await capture('home-off');
    await navigate('Engine settings');await until(`Boolean(document.querySelector('[aria-label="Keep conditional orders working while auto trading is stopped"]'))`,'the setting\'s row');
    await run(`document.querySelector('[aria-label="Keep conditional orders working while auto trading is stopped"]').click()`);
    await until(`Boolean(document.querySelector('[role="dialog"][aria-label="Keep conditional orders working while auto trading is stopped"]'))`,'the confirmation');
    const words=await run(`document.querySelector('[role="dialog"][aria-label="Keep conditional orders working while auto trading is stopped"]').innerText`);
    assert.match(words,/Keep conditional orders working on the mock account\?/);assert.match(words,/Stop everything halts all of them, and so does closing the app\. After the app restarts, they are watched again as soon as KIS connects, without pressing Start\./);assert.match(words,/only be proposed and wait for your approval/,'never started here: proposed until Start');await run(`document.querySelector('[role="dialog"][aria-label="Keep conditional orders working while auto trading is stopped"]').scrollIntoView({block:'center'})`);await capture('settings-confirm');
    await run(`${button('Turn on')}.click()`);await until(has('On for the mock account.'),'the row on');await run(`document.querySelector('[aria-label="Keep conditional orders working while auto trading is stopped"]').scrollIntoView({block:'center'})`);await capture('settings-on');
    await navigate('Home');await until(has('Auto trading is stopped. Your 2 armed orders are still watched: if their conditions are met they are only proposed for your approval.'),'Home\'s watched line, proposed only (no record)');
    await until(`Boolean(${button('Stop everything')})`,'the Stop everything button');await capture('home-on');}

  if(mode==='notice'){const NOT='Paused: 2 stop orders not watched',WATCHED='Paused: 2 stop orders watched, proposed only';const item=t=>`Array.from(document.querySelectorAll('.attention-list li')).some(li=>li.innerText.includes(${JSON.stringify(t)}))`;
    const gone=t=>`!${item(t)}`;
    await navigate('Home');await until(item(NOT),'the start notice, not watched (setting off)');assert.equal(await run(item(WATCHED)),false);await capture('notice-not-watched');
    // On, through its confirmation: the item says watched, without a restart or a Dismiss.
    await navigate('Engine settings');await until(`Boolean(document.querySelector('[aria-label="Keep conditional orders working while auto trading is stopped"]'))`,'the setting\'s row');
    await run(`document.querySelector('[aria-label="Keep conditional orders working while auto trading is stopped"]').click()`);await until(`Boolean(document.querySelector('[role="dialog"][aria-label="Keep conditional orders working while auto trading is stopped"]'))`,'the confirmation');
    await run(`${button('Turn on')}.click()`);await until(has('On for the mock account.'),'the row on');
    await navigate('Home');await until(item(WATCHED),'the start notice, watched');await until(gone(NOT),'no not-watched item');
    assert.ok(await run(has('Your 2 armed orders are still watched')),'agrees with AI activity');await capture('notice-watched');
    // Dismiss it; off: the statement changed, so it shows again; on: the dismissed statement stays hidden.
    await run(`document.querySelector('[aria-label="Dismiss: ${WATCHED}"]').click()`);await until(gone(WATCHED),'dismissed');
    await run('window.portfolio.setWatchWhileStopped(false)');await until(item(NOT),'not watched again after the setting goes off');
    await run("window.portfolio.setWatchWhileStopped(true,'WATCH WHILE STOPPED MOCK')");await until(gone(NOT),'the not-watched item gone');await new Promise(r=>setTimeout(r,3000));assert.equal(await run(item(WATCHED)),false,'the dismissed statement stays hidden');
    // Stop everything: not watched.
    await run('window.portfolio.stopEverything()');await until(item(NOT),'not watched after Stop everything');await capture('notice-stop-everything');}
  console.log(`B-4 desktop (${mode}): passed`);clearTimeout(timer);app.exit(0);
}catch(error){console.error(`B-4 desktop (${mode}):`,error);try{fs.writeFileSync(path.join(output,`b4-${mode}-failure.txt`),String(error?.stack??error));}catch{}clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
