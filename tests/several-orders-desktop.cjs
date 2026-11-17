// M-7 (d) (multi-order, m7-plan.md section 1): the desktop hook. Worked scenarios (tests/fixtures/m7) run as injected
// reviews on the mock KIS (tests/helpers/scenario.cjs); their review records are written into this run's own data folder
// before the app starts, and the real window shows them: the Journal (titles by counts, the Orders block with each order's
// pill), Home (the decision feed's counts) and Engine settings (the two rows and the switch's confirmation, cancelled).
// Made-up accounts and stocks only; nothing reaches a real service; the user's data folder is never used.
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/several-orders-desktop');fs.mkdirSync(output,{recursive:true});
const timer=setTimeout(()=>{console.error('Several-orders desktop timed out');app.exit(1);},120000);
const SCENARIOS=['TEMPLATE','order-class','unclear','claude-unparsed'];
async function seed(){const {runScenario}=require('./helpers/scenario.cjs');const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));db.exec('CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const now=Date.now();const seeded=[];
  for(const [i,name] of SCENARIOS.entries()){const s=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures','m7',name+'.json'),'utf8'));const run=await runScenario(s);
    const row=run.h.db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get();assert.ok(row,`${name}: a review was recorded`);
    // Reviews of the account the window runs on (Paper, no KIS connection), oldest first: Home and the Journal list the
    // current account's reviews.
    const r={...JSON.parse(row.payload),id:`m7-${name}`,account:{key:'paper',label:'Paper'},timestamp:now-(SCENARIOS.length-i)*60000};db.prepare('INSERT OR REPLACE INTO reviews VALUES(?,?)').run(r.id,JSON.stringify(r));seeded.push(r);}
  db.close();return seeded;}
(async()=>{let seeded;try{seeded=await seed();}catch(error){console.error(error);clearTimeout(timer);app.exit(1);return;}
  app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
    const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
    const until=async(code,what,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out waiting for '+what);};
    const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'navigation to '+tab);};
    const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
    const text=selector=>run(`(document.querySelector(${JSON.stringify(selector)})?.innerText??'')`);
    // The Journal: each seeded review's title, then the latest one's Orders block (newest first in the list).
    await navigate('Journal');await until(`document.querySelectorAll('.run-item').length>=${SCENARIOS.length}`,'the seeded reviews in the Journal');
    const titles=await run(`Array.from(document.querySelectorAll('.run-item')).map(b=>b.innerText)`);
    assert.ok(titles.some(t=>/^2 buys, 1 sale\n/.test(t)),'a mixed batch reads by counts: '+JSON.stringify(titles));assert.ok(titles.some(t=>/^3 buys\n/.test(t)),'an all-buy batch: '+JSON.stringify(titles));
    assert.ok(!titles.some(t=>/Buy · \d+ orders/.test(t)),'no first-order action on a batch: '+JSON.stringify(titles));
    const select=async id=>{await run(`document.querySelector('.run-item[data-id=${JSON.stringify(id)}]').click()`);await until(`document.querySelector('[aria-label="Decision detail"]')?.dataset.id===${JSON.stringify(id)}`,'the detail of '+id);};
    await select('m7-TEMPLATE');let orders=await text('[aria-label="Orders of this review"]');
    assert.match(orders,/Buy 005930 ×1/);assert.match(orders,/Buy 035720 ×2/);assert.match(orders,/Sell 000660 ×1/);assert.equal((orders.match(/Order sent/g)??[]).length,3,'the first order and both further ones sent: '+JSON.stringify(orders));
    assert.match(await text('[aria-label="Decision facts"]'),/2 of 2 sent|3 of 3 sent/);assert.equal(await run(`Boolean(document.querySelector('[aria-label="Decision detail"] h3 .decision-tag'))`),false,'no single-action tag beside a batch title');
    assert.match(await text('[aria-label="Decision detail"] h3'),/2 buys, 1 sale/);await capture('journal-three-orders');
    await select('m7-order-class');orders=await text('[aria-label="Orders of this review"]');assert.match(orders,/Buy 035720 ×2\nNot sent\nNot sent: Buy 2 035720: INSUFFICIENT_CAPACITY/,'the refused order reads Not sent: '+JSON.stringify(orders));assert.doesNotMatch(orders,/Proposal created/);assert.match(orders,/Buy 990060 ×1\nOrder sent/,'the order after the refused one is sent: '+JSON.stringify(orders));
    await select('m7-unclear');orders=await text('[aria-label="Orders of this review"]');assert.match(orders,/Unclear: check KIS/,'the lost reply reads unclear: '+orders);await capture('journal-unclear');
    // Home: the decision feed notes the further orders.
    await navigate('Home');await until(`/3 buys/.test(document.querySelector('.decision-feed')?.innerText??'')`,'the feed counts');const feed=await text('.decision-feed');assert.match(feed,/Buy\n3 buys/);assert.doesNotMatch(feed,/more/);await capture('home-feed');
    // Engine settings: the switch (off), "Orders per review" needing it, and the confirmation (cancelled: nothing changes).
    await navigate('Engine settings');await until(`Array.from(document.querySelectorAll('[role=switch],input[type=checkbox]')).some(e=>(e.getAttribute('aria-label')??'')==='Several open orders')`,'the switch');
    const card=await run(`document.querySelector('#eng-execution')?.innerText??document.body.innerText`);
    assert.match(card,/Several open orders/);assert.match(card,/One open order at a time\. Off by default\./);assert.match(card,/Orders per review/);assert.match(card,/Needs several open orders turned on\./);
    await run(`Array.from(document.querySelectorAll('[role=switch],input[type=checkbox]')).find(e=>e.getAttribute('aria-label')==='Several open orders').click()`);
    await until(`Boolean(document.querySelector('[role=dialog][aria-label="Turn on several open orders?"]'))`,'the confirmation');
    assert.match(await text('[role=dialog][aria-label="Turn on several open orders?"]'),/You can turn it off again at any time\./);
    await run(`document.querySelector('[role=dialog][aria-label="Turn on several open orders?"]').scrollIntoView({block:'center'})`);await capture('settings-confirmation');
    await run(`Array.from(document.querySelectorAll('[role=dialog][aria-label="Turn on several open orders?"] button')).find(b=>b.textContent==='Cancel').click()`);
    await until(`!document.querySelector('[role=dialog][aria-label="Turn on several open orders?"]')`,'the confirmation closed');
    const saved=await run('window.portfolio.getRuntime()');assert.equal(saved.config.severalOpenOrders,false,'cancelled: still off');assert.equal(saved.config.ordersPerReview,1);
    console.log(`Several-orders desktop passed: ${seeded.length} scenario reviews in the Journal, Home and Engine settings.`);clearTimeout(timer);app.exit(0);
  }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
  require('../electron/main.cjs');})();
