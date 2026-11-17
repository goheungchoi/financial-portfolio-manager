// Item 11: the desktop hook. Engine settings -> Schedule and triggers shows "Price reviews for stocks you don't hold" in
// each of its three choices with its hint, the watchlist alert trial row disabled off the default, and a choice made in
// the window saves. Made-up data only, in this run's own data folder; nothing reaches a real service.
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/not-held-desktop');fs.mkdirSync(output,{recursive:true});
const timer=setTimeout(()=>{console.error('Not-held desktop timed out');app.exit(1);},120000);
const LABEL='Price reviews for stocks you don’t hold',TRIAL='Watchlist alert trial';
const HINTS={default:'Follows the trigger settings above',levels:'Only a price level the AI set, when crossed',never:'Holdings, schedule and news still start reviews'};
const OPTIONS=['As set above','Entry levels only','Never'];
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const sel=label=>`document.querySelector('select[aria-label=${JSON.stringify(label)}]')`;
  const row=label=>run(`(${sel(label)}?.closest('.setting-row')?.innerText??'')`);
  // Engine settings, the Schedule and triggers tab, with Watchlist alerts on Observe so the trial row shows.
  await run(`window.portfolio.configureRuntime({watchlistAlerts:'observe'})`);
  await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='Engine settings').click()`);await until(`document.querySelector('h1')?.textContent==='Engine settings'`,'Engine settings');
  await run(`Array.from(document.querySelectorAll('[aria-label="Engine sections"] [role=tab]')).find(b=>b.textContent==='Schedule and triggers').click()`);
  await until(`Boolean(${sel(LABEL)})&&Boolean(${sel(TRIAL)})`,'the new row and the trial row');
  assert.deepEqual(await run(`Array.from(${sel(LABEL)}.options).map(o=>o.textContent)`),OPTIONS);
  // The new row sits after the watchlist move trigger and before the trial row.
  assert.deepEqual(await run(`(()=>{const order=Array.from(document.querySelectorAll('[role=tabpanel] select, [role=tabpanel] input')).map(e=>e.getAttribute('aria-label'));return [order.indexOf('Watchlist move trigger')<order.indexOf(${JSON.stringify(LABEL)}),order.indexOf(${JSON.stringify(LABEL)})<order.indexOf(${JSON.stringify(TRIAL)})];})()`),[true,true]);
  for(const choice of ['default','levels','never']){
    await run(`window.portfolio.configureRuntime({notHeldPriceReviews:${JSON.stringify(choice)}})`);await until(`${sel(LABEL)}.value===${JSON.stringify(choice)}`,'the choice '+choice);
    const text=await row(LABEL);assert.match(text,new RegExp(LABEL),choice);assert.ok(text.includes(HINTS[choice]),`${choice} hint: ${JSON.stringify(text)}`);assert.equal(await run(`${sel(LABEL)}.disabled`),false);
    const trial=await row(TRIAL);
    if(choice==='default'){assert.equal(await run(`${sel(TRIAL)}.disabled`),false,'the trial row is available at the default');assert.doesNotMatch(trial,/Needs/);}
    else{assert.equal(await run(`${sel(TRIAL)}.disabled`),true,'the trial row is disabled off the default');assert.ok(trial.includes('Needs “Price reviews for stocks you don’t hold” set to As set above'),trial);}
    await run(`${sel(LABEL)}.closest('.setting-row').scrollIntoView({block:'center'})`);await capture('not-held-'+choice);}
  // A choice made in the window is saved through the save bar.
  await run(`window.portfolio.configureRuntime({notHeldPriceReviews:'default'})`);await until(`${sel(LABEL)}.value==='default'`,'back to the default');
  await run(`(()=>{const e=${sel(LABEL)};Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'levels');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`Boolean(document.querySelector('.settings-draft-bar'))`,'the save bar');await run(`Array.from(document.querySelectorAll('.settings-draft-bar button')).find(b=>b.textContent.trim()==='Save changes').click()`);
  await until(`!document.querySelector('.settings-draft-bar')`,'saved');assert.equal((await run('window.portfolio.getRuntime()')).config.notHeldPriceReviews,'levels','saved from the window');
  console.log('Not-held desktop passed: the row in its three choices, the trial row disabled off the default, and a saved choice.');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
