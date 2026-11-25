// Shorts on, the 1.5.75 pre-release desktop cases (artifacts/reviews/2026-11-25-shorts-on/review-stage2d-3b.md), one mode
// per run (--mode=…), each in its own data folder with made-up data written before the app starts:
//   flow              a fake short through the opened paths on the stand-in KIS (tests/helpers/mock-kis.cjs, a live
//                     mock): proposed from the ticket, sent, filled, tied to its lot, the cover stop armed; Short positions
//                     on Home; the stop hit while kept working (proposed, as no Start was pressed), approved, sent, filled;
//                     the lot gone and no stop left
//   unprotected       the listings: conditional orders off; a lot the app cannot tie; a tie gone (the lot missing over two
//                     readings 11 minutes apart by KIS's clock), with its dismissal
//   saved-switch      a store saved by earlier code with short selling on (live): the Home notice after the first balance
//                     reading, one Activity line, dismissed
//   saved-restart     the same data folder after a restart: no notice
//   saved-mock        the same store on a mock account: no notice
//   settings-sent     kept working while stopped with a switches record that sends (as after a Start): Short & leverage
//                     says a hit stop or buy-back is sent by itself
//   claude            Start on Claude with short selling on: refused until a dry run under the on fingerprints counts,
//                     then Start works
// The app's clock is shifted to a weekday 10:00 KST (tests/helpers/shift-clock.cjs) so the short session is open; the
// cases still run outside Korean market hours on the real clock. Nothing reaches a real service; no credential is read.
process.env.PORTFOLIO_FAKE_NOW=process.env.PORTFOLIO_FAKE_NOW??'2026-11-26T01:00:00.000Z';require('./helpers/shift-clock.cjs');
const {app,dialog}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const mode=(process.argv.find(a=>a.startsWith('--mode='))??'--mode=flow').slice(7);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/shorts-desktop');fs.mkdirSync(output,{recursive:true});
const DB=path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite');const ACCOUNT='shorts-fixture';const S='990010';
const live=mode!=='saved-mock';const {DatabaseSync}=require('node:sqlite');
// ---- Written before the app starts: the stock in the security master (a KOSPI stock), and short selling saved on for
// the account (as an earlier version saved it).
if(mode!=='saved-restart'){const db=new DatabaseSync(DB);
  db.exec('CREATE TABLE IF NOT EXISTS securities(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,englishName TEXT NOT NULL,market TEXT NOT NULL,type TEXT NOT NULL,isin TEXT NOT NULL,industry TEXT)');
  db.prepare('INSERT OR IGNORE INTO securities(symbol,name,englishName,market,type,isin) VALUES(?,?,?,?,?,?)').run(S,'Fixture short A','Fixture short A','KOSPI','stock','');
  const {Exposure}=require('../electron/exposure.cjs');new Exposure(db).savePolicy(ACCOUNT,{short:{enabled:true,auto:false}});
  if(mode==='claude'){const RI=require('../electron/review-instructions.cjs');db.exec('CREATE TABLE IF NOT EXISTS dry_runs(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL)');
    db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run('fixture-dry-run',Date.now()-3600000,dryRun(RI.fingerprint(undefined,{orders:true,short:true})));
    db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('fixture-dry-run-call',new Date().toISOString().slice(0,10),JSON.stringify({reviewId:'fixture-dry-run',model:'claude-opus-5-5',status:'completed',usage:{inputTokens:1000,outputTokens:100},accountedMicro:330000}));}
  if(mode==='settings-sent'){const W=require('../electron/watch-while-stopped.cjs');new W.WatchWhileStopped(db).turnOn({account:ACCOUNT,environment:'live',record:{autoSubmit:true,conditionalAutoSubmit:true,scope:'kis',markets:{KR:true,US:false},at:Date.now()-3600000}});}
  db.close();}
function dryRun(fingerprint){const RI=require('../electron/review-instructions.cjs');return JSON.stringify({id:'fixture-dry-run',timestamp:Date.now()-3600000,mode:'review',summary:{account:{key:ACCOUNT}},
  review:{model:'claude-opus-5-5',decision:{action:'Hold'},calls:2,costUSD:0.33,appVersion:'1.5.75',instructions:{version:RI.ORDERS_SHORT_VERSION,fingerprint},answerForm:'enforced',measurement:{requests:[{answerForm:'enforced'}],totals:{costUSD:0.33}}}});}
const setDryRun=fingerprint=>{const db=new DatabaseSync(DB);try{db.prepare('UPDATE dry_runs SET payload=? WHERE id=?').run(dryRun(fingerprint),'fixture-dry-run');}finally{db.close();}};
// ---- KIS stand-in: the mock's live Korean account. KIS's clock can be moved ahead (shift) for the gone case.
const {MockKis}=require('./helpers/mock-kis.cjs');let shift=0;
const m=new MockKis({clock:()=>Date.now()+shift,environment:live?'live':'mock',accountKey:ACCOUNT,kr:{cash:4000000,holdings:[]},prices:{[S]:10000}});
const ENGINE_OPS=['live-context','prepare-order','place-order','revise-order','orders','charges'];
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
require('../electron/kis-service.cjs').KisService.prototype.request=async function(operation,payload){
  if(this.workerScript==='provider-worker.cjs'){if(operation==='import')return {aiConnected:true,openaiConnected:true,anthropicConnected:true,dartConnected:false,pushConnected:false};throw new Error('No AI request in this fixture: '+operation);}
  if(['import','refresh','balance'].includes(operation))return m.balance('KR');
  if(operation==='quotes')return (payload?.symbols?.length?payload.symbols:[S]).filter(s=>m.prices[s]>0).map(symbol=>({symbol,price:m.prices[symbol],retrievedAt:Date.now()}));
  if(ENGINE_OPS.includes(operation))return m.request('KR',operation,payload);
  // A two-sided book one tick around the price (a cover is sent at the ask), read now.
  if(operation==='market-evidence'&&payload?.request?.dataset==='order_book'){const p=m.prices[payload.request.symbol];if(!(p>0))return {status:'unavailable'};const t=require('../electron/agent-desk.cjs').krTick(p);return {status:'available',currency:'KRW',retrievedAt:Date.now(),data:{bid:p-t,ask:p+t}};}
  if(operation==='profit')return {source:'kis',environment:m.environment,records:[],summary:{}};
  throw new Error('not in this fixture: '+operation);};

const timer=setTimeout(()=>{console.error(`Shorts desktop (${mode}) timed out`);app.exit(1);},170000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=30000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,250));}throw new Error('Timed out waiting for '+what+'. Page: '+String(await run('document.body.innerText')).slice(0,700));};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,`shorts-${mode}-${name}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'the '+tab+' page');};
  const has=text=>`document.body.innerText.includes(${JSON.stringify(text)})`;
  const item=t=>`Array.from(document.querySelectorAll('.attention-list li')).some(li=>li.innerText.includes(${JSON.stringify(t)}))`;
  const action=(name,...args)=>run(`window.portfolio.liveAction(${[name,...args].map(a=>JSON.stringify(a)).join(',')})`);
  const orders=()=>action('get').then(r=>r.state.orders);const desk=()=>run('window.portfolio.getRuntime().then(s=>s.desk)');
  const reading=async()=>{await run('window.portfolio.refreshPortfolio()');await new Promise(r=>setTimeout(r,300));};
  await run('window.portfolio.importKis()');await until(`window.portfolio.getMarket().then(s=>s.source==='kis')`,'the KIS connection');
  const events=async title=>(await run('window.portfolio.getEvents()')).filter(e=>e.title===title).length;
  // A short through the opened paths: proposed from the ticket, sent, filled, tied. Returns the order.
  const shortThrough=async()=>{
    assert.equal((await action('configure',{symbols:[S],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE LIVE')).ok,true,'live trading on for the session');
    const p=await action('propose',{symbol:S,side:'Sell',quantity:10,limitPrice:10010,credit:{kind:'short',market:'KOSPI'}});assert.equal(p.ok,true,'proposed: '+JSON.stringify(p.error??p));assert.equal(p.data.credit.kind,'short');
    const sent=await action('submit',p.data.id,'PLACE LIVE ORDER');assert.equal(sent.ok,true,'sent: '+JSON.stringify(sent.error??sent));assert.equal(sent.data.status,'Accepted');assert.equal(m.book.KR.length,1,'one order at KIS');
    m.fill('KR',sent.data.brokerOrderId);await action('reconcile');await reading();
    await until(`window.portfolio.liveAction('get').then(r=>r.state.orders.find(o=>o.id===${JSON.stringify(p.data.id)})?.lotTie?.loanDate)`,'the short tied to its lot');
    return (await orders()).find(o=>o.id===p.data.id);};

  if(mode==='flow'){
    assert.equal((await run(`window.portfolio.configureRuntime({scope:'kis',shareKisWithOpenAI:true,conditionalOrders:true,conditionalAutoSubmit:true})`)).ok,true);
    const o=await shortThrough();assert.equal(o.lotTie.how,'exact');assert.equal(o.loanDateSent?.form,'trade-day');
    await until(`window.portfolio.getRuntime().then(s=>s.desk.orders.some(o=>o.credit?.kind==='cover'&&o.purpose==='stop_loss'&&o.status==='armed'))`,'the cover stop armed');
    const stop=(await desk()).orders.find(x=>x.credit?.kind==='cover');assert.equal(stop.quantity,10);const level=stop.conditions[0].value;assert.ok(level>=11511.5&&level<=11520,'15% above 10,010 (11,511.5), at most the next 10-won tick: '+level);
    await navigate('Home');await until(`document.querySelectorAll('[aria-label="Short positions"] li').length===1`,'the short on Home');
    assert.match(await run(`document.querySelector('[aria-label="Short positions"]').innerText`),/Stop at/);await capture('home-short-stopped');
    // The stop hit while auto trading is stopped and kept working (no Start was pressed: proposed for approval).
    await run("window.portfolio.setWatchWhileStopped(true,'WATCH WHILE STOPPED LIVE')");m.price(S,level+10);
    await until(`window.portfolio.liveAction('get').then(r=>r.state.orders.some(o=>o.credit?.kind==='cover'&&o.status==='Ready'))`,'the hit stop proposed',45000);
    const cover=(await orders()).find(x=>x.credit?.kind==='cover');const ok=await action('submit',cover.id,'PLACE LIVE ORDER');assert.equal(ok.data.status,'Accepted','approved and sent');
    assert.deepEqual([ok.data.loanDateSent?.form,ok.data.loanDateSent?.alternate],['balance',false],'the lot\'s own date, first');
    m.fill('KR',ok.data.brokerOrderId);await action('reconcile');await reading();assert.equal(m.balance('KR').shorts.length,0,'bought back');
    await until(`window.portfolio.getRuntime().then(s=>!s.desk.orders.some(o=>o.credit?.kind==='cover'&&o.status==='armed'))`,'no stop left armed');
    await until(`!document.querySelector('[aria-label="Short positions"]')`,'the short gone from Home');await capture('home-after-cover');}

  if(mode==='unprotected'){
    assert.equal((await run(`window.portfolio.configureRuntime({scope:'kis',shareKisWithOpenAI:true,conditionalOrders:false})`)).ok,true);
    await shortThrough();await navigate('Home');
    await until(has("conditional orders are off, so it has no cover stop and no loan-end buy-back"),'listed: conditional orders off');await capture('conditional-off');
    // The lot leaves KIS's balance: one reading, then another 11 minutes later by KIS's clock: gone, said once on Home.
    m.accounts.KR.shorts=[];await reading();await new Promise(r=>setTimeout(r,500));assert.equal(await run(item("is no longer in KIS's balance")),false,'one reading: not yet');
    shift=11*60000;await reading();await until(item("The app's short of 990010 is no longer in KIS's balance"),'the gone notice');
    assert.equal(await events('Short no longer in the balance'),1,'one Activity line');await capture('gone');
    await run(`document.querySelector('[aria-label="Dismiss: The app\\'s short of 990010 is no longer in KIS\\'s balance"]').click()`);await until(`!${item("is no longer in KIS's balance")}`,'dismissed');
    // A second short whose lot KIS dates far from any of its dates: it cannot be tied, and the lot is listed.
    m.lotDateOf=d=>'2026-12-31';shift=12*60000;
    const p=await action('propose',{symbol:S,side:'Sell',quantity:3,limitPrice:10010,credit:{kind:'short',market:'KOSPI'}});const sent=await action('submit',p.data.id,'PLACE LIVE ORDER');
    m.fill('KR',sent.data.brokerOrderId);await action('reconcile');shift=13*60000;await reading();await reading();
    await until(has("cannot tie it to this lot's loan date, so it has no cover stop; buy it back in KIS's own app"),'the untied lot listed');await capture('untied');}

  if(mode==='saved-switch'||mode==='saved-mock'||mode==='saved-restart'){await navigate('Home');
    // The notice is recorded at a balance reading (every 2 minutes, or Refresh): one reading, as the app's timer would.
    await reading();await new Promise(r=>setTimeout(r,2500));
    const shown=await run(item('Short selling can now be sent'));
    if(mode==='saved-switch'){await until(item('Short selling can now be sent'),'the saved-switch notice');assert.equal(await events('Short selling can now be sent'),1,'one Activity line');
      const text=await run(`Array.from(document.querySelectorAll('.attention-list li')).find(li=>li.innerText.includes('Short selling can now be sent')).title`);
      assert.match(text,/without a new confirmation/);assert.match(text,/A short the AI decides is proposed and waits for your approval\./);assert.match(text,/No real short has been sent by this app yet/);assert.match(text,/turn short selling off in Short & leverage/);await capture('notice');
      await reading();await reading();assert.equal(await events('Short selling can now be sent'),1,'still one line after more readings');
      await run(`document.querySelector('[aria-label="Dismiss: Short selling can now be sent"]').click()`);await until(`!${item('Short selling can now be sent')}`,'dismissed');await capture('dismissed');}
    else{assert.equal(shown,false,mode==='saved-mock'?'a mock account: no notice':'after a restart: no notice');assert.equal(await events('Short selling can now be sent'),mode==='saved-restart'?1:0);await capture('none');}}

  if(mode==='settings-sent'){assert.equal((await run(`window.portfolio.configureRuntime({scope:'kis',shareKisWithOpenAI:true,conditionalOrders:true,conditionalAutoSubmit:true})`)).ok,true);
    await until(`window.portfolio.getExposure().then(r=>r.state.markets.KR.coverStops?.whenHit==='sent')`,'a hit stop sent by itself');
    await navigate('Short & leverage');await until(has("Buying a short back: the app's cover stops and loan-end buy-backs are conditional orders. Conditional orders are on now, and a stop or buy-back that is hit is sent by itself."),'the sent line');
    await run(`document.querySelector('[aria-label="Korea Short selling (대주매도)"]').scrollIntoView({block:'start'})`);await capture('settings-sent');}

  if(mode==='claude'){const RI=require('../electron/review-instructions.cjs');const ON=RI.fingerprint(undefined,{orders:true,short:true}),OFF=RI.fingerprint(undefined,{orders:true});
    const SENTENCE='Trading on Claude Opus 5.5 needs a dry run on this version first: Dashboard → Dry run → Claude Opus 5.5.';
    const header='Array.from(document.querySelectorAll(`button`)).find(b=>/^(Start auto trading|Stop auto trading)$/.test(b.textContent))';
    const note=`Array.from(document.querySelectorAll('p[role=status]')).map(p=>p.textContent).find(t=>/^Auto trading (started|stopped)|Trading on Claude|CLAUDE_|Could not/.test(t))??null`;
    const idle=`(async()=>{const s=await window.portfolio.getRuntime();return Boolean(s?.launch)&&!s.launch.starting&&!s.busy;})()`;
    const click=async label=>{await until(idle,'idle before '+label);await new Promise(r=>setTimeout(r,2500));await until(`${header}?.textContent===${JSON.stringify(label)}`,'the button '+label);await run(`${header}.click()`);};
    await run('window.portfolio.importProviders()');await until(`window.portfolio.getRuntime().then(s=>s.providerStatus.anthropicConnected===true)`,'the providers');
    assert.equal((await run(`window.portfolio.configureRuntime({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true})`)).ok,true);
    const saved=await run(`window.portfolio.configureRuntime({openaiModel:'claude-opus-5-5',reasoningEffort:'medium',claudeTradingConfirmed:true,severalOpenOrders:true,ordersPerReview:3,anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true,enabled:false,autoSubmit:false,closedMarketReviews:'keep'})`);
    assert.equal(saved.ok,true,'Claude saved with the dry run under the on fingerprints: '+JSON.stringify(saved.error));
    await navigate('Home');
    // A dry run made without shorts (the 1.5.74 one) does not count with short selling on: Start says why.
    setDryRun(OFF);await new Promise(r=>setTimeout(r,500));await click('Start auto trading');await until(`(${note})===${JSON.stringify(SENTENCE)}`,'the refusal sentence');
    assert.equal(await run('window.portfolio.getRuntime().then(s=>Boolean(s.launch.running))'),false);await capture('claude-refused');
    // One dry run under the on fingerprints: Start works.
    setDryRun(ON);await new Promise(r=>setTimeout(r,500));await click('Start auto trading');await until(`window.portfolio.getRuntime().then(s=>s.launch.running)`,'running');await capture('claude-running');
    // While running on Claude, short selling cannot be turned on (it is on here; turning it off is allowed and then on is refused).
    const off=await run(`window.portfolio.saveExposurePolicy('KR',{short:{enabled:false}})`);assert.equal(off.ok,true,'turning it off is never refused');
    const on=await run(`window.portfolio.saveExposurePolicy('KR',{short:{enabled:true}})`);assert.deepEqual([on.ok,on.error],[false,'CLAUDE_SHORTS_RUNNING']);
    // On screen: the switch on, Save, the confirmation, Turn on: the words, and nothing saved.
    await navigate('Short & leverage');await until(`Boolean(document.querySelector('[aria-label="Korea allow short selling"]'))`,'the short section');await run(`document.querySelector('[aria-label="Korea allow short selling"]').click()`);
    await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Save Korea settings').click()`);await until(`Boolean(document.querySelector('[role="dialog"][aria-label="Turn on short selling"]'))`,'the confirmation');
    await run(`Array.from(document.querySelectorAll('[role="dialog"][aria-label="Turn on short selling"] button')).find(b=>b.textContent==='Turn on short selling').click()`);
    await until(has('Nothing was saved. Stop auto trading first: turning short selling on changes what Claude is sent, so Start asks one new dry run.'),'the refusal on screen');
    assert.equal(await run(`window.portfolio.getExposure().then(r=>r.state.markets.KR.policy.short.enabled)`),false,'nothing saved');await capture('claude-shorts-running');await navigate('Home');
    await click('Stop auto trading');await until(`window.portfolio.getRuntime().then(s=>!s.launch.running)`,'stopped');}
  console.log(`Shorts desktop (${mode}): passed`);clearTimeout(timer);app.exit(0);
}catch(error){console.error(`Shorts desktop (${mode}):`,error);try{fs.writeFileSync(path.join(output,`shorts-${mode}-failure.txt`),String(error?.stack??error));}catch{}clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
