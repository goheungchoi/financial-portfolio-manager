// The Activity tab revision (artifacts/reviews/2026-11-18-activity-tab, step 6): the desktop case. Made-up data only, in
// this run's own data folder; no credential file is read and no AI request is sent. Checks:
// - Activity opens with rows without a click; the three totals are shown for a period with a corrected order,
//   with "Includes 1 corrected order";
// - the Today strip lists a not-sent order with its reason, and the period list shows it greyed, outside the totals;
// - the From column names the app's order and an order outside the app;
// - a failed refresh keeps the rows and says why;
// - Performance opens loaded;
// - both themes are captured.
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/activity-desktop');fs.mkdirSync(output,{recursive:true});
const ACCOUNT='activity-fixture';const now=Date.now();
// Today's orders are made today in Seoul, also in the first hour after midnight (the 1.5.69 suite ran at 00:0x KST).
const seoulMidnight=Date.parse(new Date(now+9*3600000).toISOString().slice(0,10)+'T00:00:00+09:00');
const madeAt=Math.max(now-3600000,seoulMidnight+60000),notSentAt=Math.max(now-1800000,madeAt+30000);
// The app's records: a review's buy that KIS filled after one price revision, and a buy the app decided but did not send.
{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,payload TEXT NOT NULL)');
  const put=o=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(o.id,ACCOUNT,JSON.stringify({accountKey:ACCOUNT,market:'KR',environment:'mock',...o}));
  put({id:'fixture-review-buy',symbol:'005380',name:'Fixture company',side:'Buy',quantity:5,filled:5,status:'Filled',createdAt:madeAt,brokerOrderId:'0000001001',brokerOrderIds:['0000001001','0000001002'],madeBy:'review',reviewId:'fixture-review',sentBy:'auto',limitPrice:100});
  put({id:'fixture-not-sent',symbol:'990010',name:'Fixture not sent',side:'Buy',quantity:2,filled:0,status:'Rejected',reason:'ORDER_NOT_SENT',notSentCause:'ticket-expired',createdAt:notSentAt,madeBy:'review',reviewId:'fixture-review-2'});db.close();}
const snapshot={source:'kis',environment:'mock',accountKey:ACCOUNT,timestamp:new Date().toISOString(),cash:500000,reportedTotal:1000000,holdings:[{symbol:'005380',name:'Fixture company',quantity:5,cost:100,price:110,marketValue:550,unrealized:50}]};
let failOrders=false;
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(operation==='quotes')return [{symbol:'005380',price:110,retrievedAt:Date.now()}];
  if(operation==='orders'){if(failOrders)throw new Error('RATE_LIMITED');const t=madeAt+60000;
    return {source:'kis',environment:'mock',startDate:payload.startDate,endDate:payload.endDate,retrievedAt:new Date().toISOString(),orders:[
      // The app's buy of 5: 2 filled at 100 on the original, then revised by the app; 3 filled at 101 on the revision.
      {id:'a',orderId:'0000001001',originalOrderId:null,symbol:'005380',name:'Fixture company',timestamp:t,side:'Buy',quantity:5,filled:2,remaining:0,rejected:0,executionAmount:200,averagePrice:100,orderPrice:100,status:'Partially filled / canceled'},
      {id:'b',orderId:'0000001002',originalOrderId:'0000001001',symbol:'005380',name:'Fixture company',timestamp:t+60000,side:'Buy',quantity:3,filled:3,remaining:0,rejected:0,executionAmount:303,averagePrice:101,orderPrice:101,status:'Filled'},
      // An order placed outside the app.
      {id:'c',orderId:'0000002001',originalOrderId:null,symbol:'990060',name:'Fixture outside',timestamp:t+120000,side:'Sell',quantity:1,filled:1,remaining:0,rejected:0,executionAmount:90000,averagePrice:90000,orderPrice:90000,status:'Filled'}]};}
  if(operation==='us-order-history')return [];
  if(operation==='profit')return {source:'kis',environment:'mock',startDate:payload.startDate,endDate:payload.endDate,retrievedAt:new Date().toISOString(),records:[{timestamp:Date.now(),symbol:'005380',name:'Fixture company',realized:125,fee:5,tax:2}],summary:{realized:125,fee:5,tax:2,returnPct:2.5}};
  if(['history','company-chart','chart-bars','chart-stream'].includes(operation))throw new Error('not in this fixture');
  return snapshot;};
const timer=setTimeout(()=>{console.error('Activity desktop timed out');app.exit(1);},120000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const text=sel=>`(document.querySelector(${JSON.stringify(sel)})?.textContent??'')`;
  await run('window.portfolio.importKis()');await until(`window.portfolio.getRuntime().then(s=>s.connections.kis.status==='connected')`,'KIS connected');
  await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='Activity'||b.textContent==='Activity').click()`);
  // 1. Rows without a click, totals with a corrected order.
  await until(`document.querySelectorAll('tbody tr').length===4`,'3 KIS rows and 1 not-sent row, with no click');
  assert.equal(await run(text('.metrics section strong')),'₩503','purchases: 200 + 303, the corrected order summed');
  assert.match(await run(text('[aria-label="Corrected orders"]')),/^Includes 1 corrected order\./);assert.doesNotMatch(await run('document.querySelector(".metrics").textContent'),/Unavailable/);
  // 2. Today and the not-sent row.
  await until(`${text('[aria-label="Today counts"]')}.includes('not sent')`,'the Today strip');
  assert.match(await run(text('[aria-label="Latest orders"]')),/Not sent · the check with KIS expired before it was sent/);
  const notSent=await run(`(()=>{const r=Array.from(document.querySelectorAll('tbody tr')).find(tr=>tr.textContent.includes('Fixture not sent'));return r?{cls:r.className,text:r.textContent}:null;})()`);
  assert.ok(notSent&&/not-sent/.test(notSent.cls),'the not-sent row is greyed');assert.match(notSent.text,/Not sent/);
  // 3. From.
  const from=await run(`Array.from(document.querySelectorAll('tbody tr')).map(tr=>tr.children[3]?.textContent??'')`);
  assert.ok(from.some(t=>t.startsWith('AI review · sent automatically')),JSON.stringify(from));assert.ok(from.some(t=>t.startsWith('Outside the app')),JSON.stringify(from));
  for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run(`document.querySelector('[aria-label="Dark mode"]').click()`);await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'theme');}
    await run('window.scrollTo(0,0)');await capture(`activity-open-${theme}`);await run(`document.querySelector('table')?.scrollIntoView({block:'center'})`);await capture(`activity-rows-${theme}`);}
  // 3b. At 760 px the orders table scrolls inside its card; the page itself does not scroll sideways.
  win.setSize(760,900);await new Promise(r=>setTimeout(r,400));await run(`document.querySelector('table')?.scrollIntoView({block:'center'})`);
  assert.ok(await run('document.querySelector("main").scrollWidth-document.querySelector("main").clientWidth<=2'),'no page overflow at 760 px');
  assert.ok(await run('(()=>{const s=document.querySelector(".table-scroll");return s.scrollWidth>s.clientWidth;})()'),'the table scrolls in its card');
  await capture('activity-rows-760');win.setSize(1280,900);await new Promise(r=>setTimeout(r,300));
  // 4. A failed refresh keeps the rows and says why.
  failOrders=true;await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh').click()`);
  await until(`${text('[aria-label="Refresh status"]')}.startsWith('Not refreshed:')`,'the not-refreshed line');
  assert.equal(await run(`document.querySelectorAll('tbody tr').length`),4,'rows kept');await run('window.scrollTo(0,0)');await capture('activity-refresh-failed');failOrders=false;
  // 5. Performance opens loaded.
  await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='Performance'||b.textContent==='Performance').click()`);
  await until(`${text('.metrics strong')}==='₩125'`,'Performance loaded without a click');await capture('performance-open');
  console.log('Activity desktop passed');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
