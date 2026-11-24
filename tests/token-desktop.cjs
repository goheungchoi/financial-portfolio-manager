// The token fix (artifacts/reviews/2026-11-24-kis-token): the desktop cases, one mode per run (--mode=…), each in its own
// data folder with made-up data written before the app starts. KIS is a stand-in (KisService.prototype.request, as
// b4-desktop.cjs); nothing reaches a real service.
//   kis-down          every KIS request fails with KIS's ended-sign-in code for over 3 minutes while a stop is armed:
//                     Home's "KIS is not answering since … (its sign-in expired)" line
//   not-taken-halted  an order whose state at KIS is unknown, sent by an armed stop, the setting to watch while stopped
//                     off: Home's "Korean orders are held" item; on KIS trading, "KIS never took it" shows what KIS
//                     listed and "sends nothing until you press Start"; after Yes, the reply and Home's "Stop for …
//                     armed again: nothing is sent until you press Start"
//   not-taken-watched the same with the setting on: the before-line "may be sent right away" and the reply saying it is
//                     watched; the app never checked KIS for this order ("The app has not checked KIS …")
//   not-taken-running trading on: no before-line; KIS showed no order like it
//   connections-wait  a connect that waits for KIS's one-sign-in-a-minute: Connections' "connecting in N s"
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const mode=(process.argv.find(a=>a.startsWith('--mode='))??'--mode=kis-down').slice(7);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/token-desktop');fs.mkdirSync(output,{recursive:true});
const DB=path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite');const ACCOUNT='fixture-acct';
const seoulDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);const NOT_TAKEN=mode.startsWith('not-taken');

// ---- The data written before the app starts.
{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(DB);const D=require('../electron/agent-desk.cjs');const desk=new D.AgentDesk(db,Date.now);
  const cfg={config:{...D.COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5},universe:['990010','990020']};
  const stop=desk.setOrder('kis:'+ACCOUNT,{action:'add',id:'',symbol:'990010',side:'Sell',quantity:2,limitPrice:null,conditions:[{expr:'price("990010")',op:'<=',value:90}],combine:'all',purpose:'stop_loss',expiresInHours:48,reason:'Fixture stop.',replaces:null},cfg);
  assert.ok(['armed','saved'].includes(stop.status),'seeded stop: '+JSON.stringify(stop));
  const {LiveEngine}=require('../electron/live-engine.cjs');const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'disconnected',snapshot:null}));
  e.writePolicy(ACCOUNT,{symbols:[],anyStock:true,day:seoulDay(Date.now()),lossLimit:{mode:'off',value:0},maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null});
  if(NOT_TAKEN){const t=Date.now()-20*60000;
    // The stop fired and its order got an unclear reply: the order Uncertain, the stop submitted with that order.
    const candidates=mode==='not-taken-halted'?[{orderId:'0000900',symbol:'990010',side:'Sell',quantity:2,status:'Filled',timestamp:t+60000}]:mode==='not-taken-running'?[]:undefined;
    e.save({id:'U-1',accountKey:ACCOUNT,source:'kis',environment:'mock',market:'KR',currency:'KRW',symbol:'990010',side:'Sell',quantity:2,limitPrice:130,status:'Uncertain',reason:'ORDER_UNCERTAIN',day:seoulDay(t),createdAt:t,expiresAt:t+120000,madeBy:'conditional',brokerOrderId:null,filled:0,...(candidates?{kisCandidates:candidates}:{})});
    const armed=desk.orders('kis:'+ACCOUNT).find(o=>o.id===stop.id);desk.update(armed,{status:'submitted',proposalId:'U-1',orderId:'U-1',outcome:'Sent at 130 for 2 shares, but the broker\'s reply was unclear (ORDER_UNCERTAIN).',closedAt:t});}
  if(mode==='not-taken-watched'){const W=require('../electron/watch-while-stopped.cjs');new W.WatchWhileStopped(db).turnOn({account:ACCOUNT,environment:'mock',record:{autoSubmit:true,conditionalAutoSubmit:true,scope:'kis',markets:{KR:true,US:false},at:Date.now()-3600000}});}
  db.close();}

// ---- KIS stand-in. Prices sit above the stop, so nothing fires.
const stand={failing:false};
{const {KisService}=require('../electron/kis-service.cjs');
  const snapshot={source:'kis',environment:'mock',accountKey:ACCOUNT,timestamp:new Date().toISOString(),cash:500000,reportedTotal:800000,holdings:[{symbol:'990010',name:'Fixture 990010',quantity:2,cost:100,price:140,marketValue:280,unrealized:0}]};
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
  KisService.prototype.request=async function(operation,payload){
    if(stand.failing)throw Object.assign(new Error('BROKER_UNAVAILABLE'),{code:'BROKER_UNAVAILABLE',brokerCode:'EGW00123',brokerMessage:'token expired'});
    if(operation==='import'&&mode==='connections-wait'){this.onSignInWait?.(45000);await new Promise(r=>setTimeout(r,12000));}
    if(operation==='quotes')return [{symbol:'990010',price:140,retrievedAt:Date.now()}];
    if(operation==='orders')return {source:'kis',environment:'mock',startDate:payload?.startDate,endDate:payload?.endDate,retrievedAt:new Date().toISOString(),orders:[]};
    if(operation==='profit')return {source:'kis',environment:'mock',records:[],summary:{}};
    return snapshot;};}

const timer=setTimeout(()=>{console.error(`Token desktop (${mode}) timed out`);app.exit(1);},170000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=30000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,250));}throw new Error('Timed out waiting for '+what+'. Page: '+String(await run('document.body.innerText')).slice(0,900));};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,`token-${mode}-${name}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'the '+tab+' page');};
  const has=text=>`document.body.innerText.includes(${JSON.stringify(text)})`;
  const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)})`;

  if(mode==='connections-wait'){await until(`Boolean(document.querySelector('.nav'))`,'the app\'s navigation');await navigate('Connections');void run('window.portfolio.importKis()');
    await until(`/KIS allows one sign-in a minute; connecting in [0-9]+ s/.test(document.body.innerText)`,'the sign-in wait line',10000);await capture('connections-wait');
    await until(`window.portfolio.getMarket().then(s=>s.source==='kis')`,'the connection after the wait',30000);await until(`!document.body.innerText.includes('KIS allows one sign-in a minute')`,'the line gone once connected');
    clearTimeout(timer);app.exit(0);return;}

  await run('window.portfolio.importKis()');await until(`window.portfolio.getMarket().then(s=>s.source==='kis')`,'the KIS connection');
  await run(`window.portfolio.configureRuntime({scope:'kis',shareKisWithOpenAI:true,conditionalOrders:true,conditionalAutoSubmit:true})`);
  await until(`window.portfolio.getRuntime().then(s=>s.config.scope==='kis'&&s.config.conditionalOrders===true)`,'the KIS scope with conditional orders');

  if(mode==='kis-down'){
    // Every request fails from 4 minutes ago (the main process's clock set back while the failures begin, then restored).
    const real=Date.now;Date.now=()=>real()-240000;stand.failing=true;
    try{await until(`window.portfolio.getRuntime().then(s=>s.kisFeed?.status==='error')`,'the failing KIS feed',40000);}finally{Date.now=real;}
    await navigate('Home');const LINE=/KIS is not answering since [0-9]{2}:[0-9]{2} \(its sign-in expired\): armed orders and stops are not watched until it answers\./;
    await until(`${LINE}.test(document.body.innerText)`,'Home\'s KIS-down line',30000);await capture('home-kis-down');
    clearTimeout(timer);app.exit(0);return;}

  // The not-taken modes.
  if(mode==='not-taken-running')await run(`window.portfolio.liveAction('configure',{symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK')`);
  await navigate('Home');
  await until(has('Korean orders are held: an order\'s state at KIS is unknown'),'Home\'s held item');await capture('home-held');
  await navigate('KIS trading');await until(`Boolean(${button('KIS never took it')})`,'the KIS never took it button');
  await run(`${button('KIS never took it')}.click()`);await until(has('Only if you checked in KIS that it has no such order. The app then counts it as not sent and may send it again.'),'the confirmation');
  const HALTED='Korean auto trading is stopped: a stop armed again sends nothing until you press Start.',WATCHED='Korean auto trading is stopped, but orders are watched while stopped: a stop armed again may be sent right away.';
  if(mode==='not-taken-halted'){await until(`/KIS shows: Sell 2 990010, filled, [0-9]{2}:[0-9]{2}/.test(document.body.innerText)`,'what KIS listed');await until(has(HALTED),'the halted line');assert.equal(await run(has(WATCHED)),false);}
  if(mode==='not-taken-watched'){await until(has('The app has not checked KIS for this order. Look in KIS before you confirm.'),'the not-checked line');await until(has(WATCHED),'the watched line');assert.equal(await run(has(HALTED)),false);}
  if(mode==='not-taken-running'){await until(has('KIS showed no order like it.'),'no order like it');assert.equal(await run(has(HALTED)||has(WATCHED)),false,'no before-line while trading runs');}
  // One sentence a paragraph (the first run showed them run together inline).
  const paragraphs=await run(`Array.from(document.querySelectorAll('[role="alertdialog"][aria-label="KIS never took it"] p')).map(p=>p.textContent)`);
  assert.equal(paragraphs.length,mode==='not-taken-running'?2:3,'paragraphs: '+JSON.stringify(paragraphs));assert.equal(paragraphs.at(-1),'Only if you checked in KIS that it has no such order. The app then counts it as not sent and may send it again.');
  await run(`document.querySelector('[role="alertdialog"][aria-label="KIS never took it"]').scrollIntoView({block:'center'})`);await capture('confirmation');
  await run(`${button('Yes, KIS never took it')}.click()`);
  if(mode==='not-taken-halted'){await until(has('Counted as not sent; the stop for 990010 armed again. Nothing is sent until you press Start: Korean auto trading is stopped.'),'the reply');await capture('reply');
    await navigate('Home');await until(has('Stop for 990010 armed again: nothing is sent until you press Start'),'Home\'s armed-again item');assert.equal(await run(has('Korean orders are held')),false,'the held item gone');await capture('home-armed-again');}
  if(mode==='not-taken-watched'){await until(has('Counted as not sent; the stop for 990010 armed again. It is watched while auto trading is stopped, so it may be sent before you press Start.'),'the reply');await capture('reply');
    await navigate('Home');await until(`!document.body.innerText.includes('Korean orders are held')`,'the held item gone');assert.equal(await run(has('armed again: nothing is sent until you press Start')),false,'no halted item');await capture('home-after');}
  if(mode==='not-taken-running'){await until(has('Counted as not sent; the stop for 990010 armed again.'),'the reply');await capture('reply');}
  const state=await run('window.portfolio.getRuntime()');assert.ok(state.desk.orders.some(o=>o.symbol==='990010'&&o.notTakenAt),'the stop is armed again');
  clearTimeout(timer);app.exit(0);}catch(error){console.error(error.stack??error.message);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
