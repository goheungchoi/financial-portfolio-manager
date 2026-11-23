// S5 (artifacts/reviews/2026-11-23-after-b2): the desktop cases for the screening scripts and the after-B2 fixes, one mode
// per run (--mode=…), each in its own data folder with made-up data written before the app starts:
//   screens        the Scout panel's Screens section: a partly read history and a failed run's scripts
//   screens-empty  the same section with nothing stored yet and no run
//   journal        the Journal: More → "Scripts (n)" of a review that ran scripts
//   stops          the Home line about armed orders not watched, and the words Stop returns
//   buyback        Activity's Buy-back blocked list and the order ticket's line, for a sale made outside the app
//   buyback-wait   Home's "App buys wait" line while KIS's order history cannot be read (about 2.5 minutes)
// KIS is a stand-in (KisService.prototype.request, as kis-desktop.cjs); nothing reaches a real service.
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const mode=(process.argv.find(a=>a.startsWith('--mode='))??'--mode=screens').slice(7);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/s5-desktop');fs.mkdirSync(output,{recursive:true});
const DB=path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite');const ACCOUNT='fixture-acct';
const seoulDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);const back=(d,i)=>new Date(Date.parse(d+'T00:00:00Z')-i*86400000).toISOString().slice(0,10);
const record=(script,status,extra={})=>({at:Date.now()-60000,script,status,lines:[],coverage:[],live:null,...extra});

// ---- The data written before the app starts.
{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(DB);
  if(mode==='screens'||mode==='screens-empty'){new (require('../electron/security-master.cjs').SecurityMaster)(db,async()=>({ok:false}));
    const put=db.prepare("INSERT OR REPLACE INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES(?,?,'',?,'stock','',NULL,NULL,?)");
    for(const [i,s] of ['990010','990020','990030','990040'].entries())put.run(s,'Fixture '+s,'KOSPI',9e12-i*1e12);
    if(mode==='screens'){const H=require('../electron/history-store.cjs');const store=new H.HistoryStore(db);const day=H.asOfDay('KR',Date.now(),new Set());
      for(const s of ['990010','990020'])store.put(s,Array.from({length:40},(_,i)=>({date:back(day,39-i),close:100+i,high:101+i,low:99+i,volume:10,value:1e6})));
      const S=require('../electron/scout.cjs');new S.ScoutStore(db).saveScreens('paper',{runId:'fixture-run',failed:true,screens:[
        record('# leaders by 20-day return\nu = universe(market="KOSPI", top_cap=4)\nprint(top(u, ret(S,20), 3))','ok',{lines:['1. 990020 Fixture 990020 39.39 (close 139, as of the last close)'],coverage:[{line:3,universe:'KOSPI top 4 stocks',size:4,evaluated:2,noHistory:2,stale:0,errors:0,noLive:0}]}),
        record('print(1 +','stopped',{stopped:{line:1,words:'line 1: this line cannot be read (the line ends early)'}}),
        record('# slow\nprint(1)','error',{words:'the script could not be run: the screening engine took too long'})]});}}
  if(mode==='journal'){db.exec('CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    const scripts=[record('# rank the review\'s stocks\nu = universe(own="review")\nprint(top(u, rsi(S,14), 2))','ok',{lines:['1. 990010 Fixture 990010 61.2 (close 139, 2026-11-20)','2. 990020 Fixture 990020 48.7 (close 98, 2026-11-20)'],coverage:[{line:3,universe:'review',size:2,evaluated:2,noHistory:0,stale:0,errors:0,noLive:0}]}),
      record('print(close("999980",0))','stopped',{stopped:{line:1,words:"line 1: not one of this review's stocks (999980 is not one of this review's stocks)"}}),
      record('print(2)','error',{words:'the script was not run: no tools in this round: give your answer now'})];
    const r={id:'s5-journal',account:{key:'paper',label:'Paper'},timestamp:Date.now()-60000,trigger:'User request',provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'Fixture review: hold.'},formulaUse:{version:1,computeCalls:0,formulas:0,functions:{},errors:{},items:[],screenCalls:5,scripts}};
    db.prepare('INSERT OR REPLACE INTO reviews VALUES(?,?)').run(r.id,JSON.stringify(r));}
  if(mode==='stops'){const D=require('../electron/agent-desk.cjs');const desk=new D.AgentDesk(db,Date.now);
    for(const [sym,level] of [['990010',90],['990020',180]]){const r=desk.setOrder('kis:'+ACCOUNT,{action:'add',id:'',symbol:sym,side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:`price("${sym}")`,op:'<=',value:level}],combine:'all',purpose:'stop_loss',expiresInHours:48,reason:'Fixture stop.',replaces:null},{config:{...D.COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5},universe:['990010','990020']});
      assert.ok(['armed','saved'].includes(r.status),'seeded stop: '+JSON.stringify(r));}}
  if(mode==='buyback'){db.exec('CREATE TABLE IF NOT EXISTS broker_orders(id TEXT PRIMARY KEY,accountKey TEXT NOT NULL,day TEXT NOT NULL,seenAt INTEGER NOT NULL,payload TEXT NOT NULL)');
    const at=Date.now()-26*3600000,day=seoulDay(at);
    db.prepare('INSERT OR REPLACE INTO broker_orders VALUES(?,?,?,?,?)').run(`${ACCOUNT}|${day}|900001`,ACCOUNT,day,Date.now(),JSON.stringify({id:'s5',orderId:'900001',originalOrderId:null,symbol:'990010',name:'Fixture 990010',timestamp:at,side:'Sell',quantity:2,filled:2,remaining:0,rejected:0,executionAmount:280,averagePrice:140,orderPrice:140,status:'Filled',creditName:'현금',market:'KR'}));}
  db.close();}

// ---- KIS, for the modes that need an account.
const kis=['stops','buyback','buyback-wait'].includes(mode);
if(kis){const {KisService}=require('../electron/kis-service.cjs');
  const snapshot={source:'kis',environment:'mock',accountKey:ACCOUNT,timestamp:new Date().toISOString(),cash:500000,reportedTotal:800000,holdings:[{symbol:'990020',name:'Fixture 990020',quantity:3,cost:100000,price:100000,marketValue:300000,unrealized:0}]};
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
  KisService.prototype.request=async function(operation,payload){
    if(operation==='quotes')return [{symbol:'990010',price:140,retrievedAt:Date.now()},{symbol:'990020',price:100000,retrievedAt:Date.now()}];
    if(operation==='orders'){if(mode==='buyback-wait')throw Object.assign(new Error('BROKER_UNAVAILABLE'),{code:'BROKER_UNAVAILABLE'});return {source:'kis',environment:'mock',startDate:payload?.startDate,endDate:payload?.endDate,retrievedAt:new Date().toISOString(),orders:[]};}
    if(operation==='profit')return {source:'kis',environment:'mock',records:[],summary:{}};
    return snapshot;};}

const timer=setTimeout(()=>{console.error(`S5 desktop (${mode}) timed out`);app.exit(1);},mode==="buyback-wait"?175000:120000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=30000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,250));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,`${mode}-${name}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'the '+tab+' page');};
  const body=()=>run('document.body.innerText');
  if(kis){await run('window.portfolio.importKis()');await until(`window.portfolio.getMarket().then(s=>s.source==='kis')`,'the KIS connection');
    const saved=await run(`window.portfolio.configureRuntime({scope:'kis',shareKisWithOpenAI:true,conditionalOrders:true}).then(r=>r?.config?.scope??r?.state?.config?.scope??'')`);
    await until(`window.portfolio.getRuntime().then(s=>s.config.scope==='kis'&&s.config.conditionalOrders===true)`,'the KIS scope with conditional orders ('+saved+')');}

  if(mode==='screens'||mode==='screens-empty'){await run(`window.portfolio.configureRuntime({scoutEnabled:true})`);await navigate('Discover');
    // The history status is kept for 60 s, so a section turned on by the switch can take that long to show.
    await until(`Array.from(document.querySelectorAll('summary')).some(s=>s.textContent.startsWith('Screens'))`,'the Screens section',80000);
    const summary=await run(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.startsWith('Screens')).textContent`);
    if(mode==='screens'){assert.equal(summary,'Screens · 3 in the latest run, which failed');}else assert.equal(summary,'Screens');
    await run(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.startsWith('Screens')).click()`);
    await until(`Boolean(document.querySelector('[aria-label="Screening history"]'))`,'the history lines');const lines=await run(`document.querySelector('[aria-label="Screening history"]').innerText`);
    if(mode==='screens'){assert.match(lines,/Korea as of \d{4}-\d{2}-\d{2}: 2 of \d+ stocks/,'partly read: '+lines);assert.match(lines,/not read yet/,lines);
      await until(`Boolean(document.querySelector('.scout-screen'))`,'the scripts');const list=await run(`Array.from(document.querySelectorAll('.scout-screen > summary')).map(s=>s.textContent)`);
      assert.deepEqual(list,['u = universe(market="KOSPI", top_cap=4)','Stopped: print(1 +','Not run: print(1)'],'each labelled by its first line that is not a comment: '+JSON.stringify(list));
      assert.match(await body(),/The latest run failed; these are the scripts it ran\./);await run(`document.querySelectorAll('.scout-screen')[0].open=true`);
      await until(`Boolean(document.querySelector('.scout-coverage'))`,'the coverage table');assert.match(await run(`document.querySelector('.scout-coverage').innerText`),/KOSPI top 4 stocks\t4\t2\t2/);}
    else assert.match(lines,/Korea: no history yet \(\d+ stocks to read\)\./,'empty store: '+lines);
    await run(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.startsWith('Screens')).scrollIntoView({block:'start'})`);await capture('screens');}

  if(mode==='journal'){await navigate('Journal');await until(`Boolean(document.querySelector('.run-item[data-id="s5-journal"]'))`,'the fixture review');
    await run(`document.querySelector('.run-item[data-id="s5-journal"]').click()`);await until(`document.querySelector('[aria-label="Decision detail"]')?.dataset.id==='s5-journal'`,'its detail');
    await run(`document.querySelector('[aria-label="More about this decision"]').open=true`);await until(`Boolean(document.querySelector('[aria-label="Scripts of this review"]'))`,'the Scripts section');
    const s=await run(`document.querySelector('[aria-label="Scripts of this review"] > summary').textContent`);assert.equal(s,'Scripts (5)');
    await run(`document.querySelector('[aria-label="Scripts of this review"]').open=true`);const text=await run(`document.querySelector('[aria-label="Scripts of this review"]').innerText`);
    assert.match(text,/The first 3 are kept\./);assert.match(text,/Stopped: print\(close\("999980",0\)\)/);assert.match(text,/Not run: print\(2\)/);await capture('journal-scripts');}

  if(mode==='stops'){await navigate('Home');await until(`document.body.innerText.includes('2 stops are not watched until auto trading is started.')`,'the Home line about unwatched stops');await capture('home-line');
    const reply=await run('window.portfolio.stopAutoTrading()');assert.equal(reply.ok,true);
    assert.match(reply.message,/^Auto trading stopped\. Orders already at KIS stay\. Your 2 armed stops \(990010, 990020\) are not watched until you start it again\.$/,reply.message);
    await until(`document.body.innerText.includes('2 stops are not watched until auto trading is started.')`,'the Home line after Stop');}

  if(mode==='buyback'){await navigate('Activity');await until(`Boolean(document.querySelector('[aria-label="Buy-back blocked"]'))`,'the Buy-back blocked list',60000);
    const list=await run(`document.querySelector('[aria-label="Buy-back blocked"]').innerText`);assert.match(list,/990010\s*sold \d{4}-\d{2}-\d{2} · blocked until \d{4}-\d{2}-\d{2}/,list);await capture('activity-list');
    await navigate('KIS trading');await until(`Boolean(document.querySelector('[aria-label="KIS order symbol"]'))`,'the order ticket');
    await run(`(()=>{const i=document.querySelector('[aria-label="KIS order symbol"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'990010');i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await until(`Boolean(document.querySelector('[aria-label="Buy-back block"]'))`,'the ticket line');assert.match(await run(`document.querySelector('[aria-label="Buy-back block"]').innerText`),/^You sold this outside the app on \d{4}-\d{2}-\d{2}; the app's own buys of it are blocked until \d{4}-\d{2}-\d{2}\.$/);
    await capture('ticket-line');await navigate('Activity');await run(`document.querySelector('[aria-label="Remove the buy-back block for 990010"]').click()`);
    await until(`!document.querySelector('[aria-label="Buy-back blocked"]')`,'the list after Remove');}

  if(mode==='buyback-wait'){await navigate('Home');await until(`document.body.innerText.includes('App buys wait (Korean')`,'the Home line while the order history cannot be read',165000);
    assert.match(await body(),/App buys wait \(Korean[^)]*\) · orders made outside the app not read yet/);await capture('home-wait');}
  console.log(`S5 desktop (${mode}): passed`);clearTimeout(timer);app.exit(0);
}catch(error){console.error(`S5 desktop (${mode}):`,error);try{fs.writeFileSync(path.join(output,`${mode}-failure.txt`),String(error?.stack??error));}catch{}clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
