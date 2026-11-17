// The price-review rows (artifacts/reviews/2026-11-17-price-review-rows, cleared; item 11 before it): Engine settings ->
// Schedule and triggers shows "Holdings: price move trigger" and "Stocks you don't hold". Starting from the user's saved
// state of 2026-11-17 (Never, watchlist alerts on, 50%), the walk chooses each option in the window, saves it, and checks
// the saved keys; then Observe and the trial row in More. Made-up data only, in this run's own data folder; nothing
// reaches a real service.
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/not-held-desktop');fs.mkdirSync(output,{recursive:true});
const timer=setTimeout(()=>{console.error('Price-review rows desktop timed out');app.exit(1);},150000);
const ROW='Stocks you don’t hold',OBSERVE='Observe watchlist alerts',WIDER='Wider move for stocks you don’t hold',TRIAL='Watchlist alert trial';
const OPTIONS=['Same as holdings','Entry levels and wider moves','Entry levels only','Never'];
const LINES={same:'Any stock moving by the holdings percent, or reaching a level the AI set',wider:'A level the AI set, when crossed, or a move of the percent below',levels:'Only a price level the AI set, when crossed',never:'Holdings, schedule and news still start reviews'};
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const el=label=>`document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
  const rowText=label=>run(`(${el(label)}?.closest('.setting-row')?.innerText??'')`);
  const saved=async()=>(await run('window.portfolio.getRuntime()')).config;
  const save=async()=>{await until(`Boolean(document.querySelector('.settings-draft-bar'))`,'the save bar');await run(`Array.from(document.querySelectorAll('.settings-draft-bar button')).find(b=>b.textContent.trim()==='Save changes').click()`);await until(`!document.querySelector('.settings-draft-bar')`,'saved');};
  const choose=async value=>{await run(`(()=>{const e=${el(ROW)};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await save();await until(`${el(ROW)}.value===${JSON.stringify(value)}`,'the row shows '+value);};
  const keys=c=>({notHeldPriceReviews:c.notHeldPriceReviews,watchlistAlerts:c.watchlistAlerts,watchlistMovePct:c.watchlistMovePct,alertTrial:c.alertTrial});
  // The user's saved state (2026-11-17): Never, watchlist alerts on, 50%, no trial.
  await run(`window.portfolio.configureRuntime({notHeldPriceReviews:'never',watchlistAlerts:'on',watchlistMovePct:50,alertTrial:'off',eventTolerancePct:3})`);
  await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='Engine settings').click()`);await until(`document.querySelector('h1')?.textContent==='Engine settings'`,'Engine settings');
  await run(`Array.from(document.querySelectorAll('[aria-label="Engine sections"] [role=tab]')).find(b=>b.textContent==='Schedule and triggers').click()`);
  await until(`${el(ROW)}?.value==='never'`,'the row shows Never');
  assert.deepEqual(await run(`Array.from(${el(ROW)}.options).map(o=>o.textContent)`),OPTIONS);
  assert.ok((await rowText('Holdings price move trigger')).includes('Holdings: price move trigger'));
  assert.ok((await rowText(ROW)).includes(LINES.never));
  // R1: Observe is not offered under Never over a saved 'on' (it would replace it); the wider move is not shown.
  assert.deepEqual(await run(`[Boolean(${el(OBSERVE)}),Boolean(${el(WIDER)}),Boolean(${el(TRIAL)})]`),[false,false,false]);
  await run(`${el(ROW)}.closest('.setting-row').scrollIntoView({block:'center'})`);await capture('price-rows-start-never');
  // Each option from the window, saved; the keys after each (the patch table of the design note).
  await choose('same');assert.deepEqual(keys(await saved()),{notHeldPriceReviews:'default',watchlistAlerts:'off',watchlistMovePct:50,alertTrial:'off'});
  assert.ok((await rowText(ROW)).includes(LINES.same));assert.equal(await run(`Boolean(${el(OBSERVE)})`),true,'Observe offered under Same as holdings');await capture('price-rows-same');
  await choose('wider');assert.deepEqual(keys(await saved()),{notHeldPriceReviews:'default',watchlistAlerts:'on',watchlistMovePct:50,alertTrial:'off'});
  assert.ok((await rowText(ROW)).includes(LINES.wider));assert.equal(await run(`${el(WIDER)}?.value`),'50','the wider move in the row');assert.equal(await run(`Boolean(${el(OBSERVE)})`),false);await capture('price-rows-wider');
  await choose('levels');assert.deepEqual(keys(await saved()),{notHeldPriceReviews:'levels',watchlistAlerts:'on',watchlistMovePct:50,alertTrial:'off'},'levels keeps the watchlist mode');
  assert.ok((await rowText(ROW)).includes(LINES.levels));assert.deepEqual(await run(`[Boolean(${el(OBSERVE)}),Boolean(${el(WIDER)})]`),[false,false]);await capture('price-rows-levels');
  // R3: Never from here keeps watchlistAlerts 'on' and the 50%.
  await choose('never');assert.deepEqual(keys(await saved()),{notHeldPriceReviews:'never',watchlistAlerts:'on',watchlistMovePct:50,alertTrial:'off'},'Never keeps on and 50');
  assert.ok((await rowText(ROW)).includes(LINES.never));await capture('price-rows-never');
  // R1: with 'observe' already saved under Never, Observe shows (on) so it can be turned off; the trial row is locked.
  await run(`window.portfolio.configureRuntime({watchlistAlerts:'observe'})`);await until(`Boolean(${el(OBSERVE)})&&${el(OBSERVE)}.checked`,'Observe on under Never');
  await run(`${el(OBSERVE)}.closest('details').open=true`);// More, opened as a user would (innerText reads only what is shown)
  assert.equal(await run(`${el(TRIAL)}.disabled`),true,'the trial is locked off Same as holdings');assert.ok((await rowText(TRIAL)).includes('Needs “Stocks you don’t hold” set to Same as holdings'));
  await run(`${el(OBSERVE)}.click()`);await save();assert.deepEqual(keys(await saved()),{notHeldPriceReviews:'never',watchlistAlerts:'off',watchlistMovePct:50,alertTrial:'off'},'Observe off writes off');
  await until(`!${el(OBSERVE)}`,'Observe gone again under Never');
  // Under Same as holdings, Observe on shows the wider move and the trial row in More.
  await choose('same');await run(`${el(OBSERVE)}.click()`);await save();assert.deepEqual(keys(await saved()),{notHeldPriceReviews:'default',watchlistAlerts:'observe',watchlistMovePct:50,alertTrial:'off'});
  assert.equal(await run(`${el(ROW)}.value`),'same','Observe keeps Same as holdings');assert.equal(await run(`${el(WIDER)}?.value`),'50','the wider move in More');assert.equal(await run(`${el(TRIAL)}.disabled`),false,'the trial is available');
  await run(`(()=>{const d=${el(OBSERVE)}.closest('details');d.open=true;d.scrollIntoView({block:'center'});})()`);await capture('price-rows-same-observe-more');
  console.log('Price-review rows desktop passed: the four options from the user\'s state, each saved with its keys; Observe and the trial row in More.');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
