// Short selling B3f-3 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 3): the Short & leverage card's short
// section on a stubbed KIS account: the trailing-stop switch, "buy back before the last day", the cover stop's label, and
// the confirmation when short selling is switched on (with the line that the app cannot send a short yet); Cancel saves
// nothing. Both themes are captured. Made-up data only; no credential file is read.
const {app,dialog}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/short-settings-desktop');fs.mkdirSync(output,{recursive:true});
const {KisService}=require('../electron/kis-service.cjs');
const snapshot={source:'kis',environment:'live',accountKey:'short-settings-fixture',timestamp:new Date().toISOString(),cash:200000,reportedTotal:300000,holdings:[{symbol:'990030',name:'Fixture holding C',quantity:20,cost:5000,price:5000,marketValue:100000,unrealized:0}]};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
KisService.prototype.request=async function(operation){
  if(operation==='quotes')return snapshot.holdings.map(h=>({symbol:h.symbol,price:h.price,retrievedAt:Date.now()}));
  if(operation==='orders')return {source:'kis',environment:'live',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),orders:[]};
  if(operation==='profit')return {source:'kis',environment:'live',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),records:[],summary:{realized:0,fee:0,tax:0,returnPct:0}};
  if(['history','company-chart','chart-bars','chart-stream'].includes(operation))throw new Error('not in this fixture');
  return snapshot;};
const timer=setTimeout(()=>{console.error('Short settings desktop timed out');app.exit(1);},90000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'navigation to '+tab);};
  await run('window.portfolio.importKis()');await until(`window.portfolio.getExposure().then(r=>r.state?.markets?.KR?.account===true)`,'the Korean account connected');
  await navigate('Short & leverage');await until(`Boolean(document.querySelector('[aria-label="Korea Short selling (대주매도)"]'))`,'the short section');
  const sec=`document.querySelector('[aria-label="Korea Short selling (대주매도)"]')`;
  await run(`document.querySelector('[aria-label="Korea allow short selling"]').click()`);
  await until(`Boolean(document.querySelector('[aria-label="Korea trail the cover stop"]'))`,'the short section opened');
  const text=await run(`${sec}.innerText`);
  assert.match(text,/Cover stop above the sale price/);assert.doesNotMatch(text,/Stop warning at adverse move/);assert.match(text,/Buy back before the last day/);assert.match(text,/Trail the cover stop/);
  assert.equal(await run(`document.querySelector('[aria-label="Korea trail the cover stop"]').getAttribute('aria-checked')??String(document.querySelector('[aria-label="Korea trail the cover stop"]').checked)`),'false','off by default');
  assert.equal(await run(`document.querySelector('[aria-label="Korea Buy back before the last day (business days)"]')?.value`),'5','5 business days by default');
  assert.match(text,/Opening a short: not available yet\. The app cannot send a short until one real test on your account has confirmed how KIS handles it\./);assert.match(text,/Buying a short back: not available yet for the same reason; until then a cover the app proposes waits for your approval\./);
  assert.doesNotMatch(text,/U1|U3|U5|LOAN_DT|CRDT_TYPE|lendable_by_company/,'no internal shorthand on screen');
  // A fraction in "buy back before": its own words inline, and Save asks no confirmation (the engine refuses it, as before).
  const typeInto=v=>run(`(()=>{const i=document.querySelector('[aria-label="Korea Buy back before the last day (business days)"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await typeInto('2.5');await until(`${sec}.innerText.includes('Whole business days, 1–20')`,'the field error');await run(`document.querySelector('[aria-label="Korea Buy back before the last day (business days)"]').scrollIntoView({block:'center'})`);await capture('short-field-error');
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Save Korea settings').click()`);await new Promise(r=>setTimeout(r,600));
  assert.equal(await run(`Boolean(document.querySelector('[role="dialog"][aria-label="Turn on short selling"]'))`),false,'no confirmation for an invalid form');
  assert.equal(await run(`window.portfolio.getExposure().then(r=>r.state.markets.KR.policy.short.enabled)`),false,'and nothing saved');
  await typeInto('5');await until(`!${sec}.innerText.includes('Whole business days, 1–20')`,'the field valid again');
  // Save: the confirmation, not a save.
  await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Save Korea settings').click()`);
  await until(`Boolean(document.querySelector('[role="dialog"][aria-label="Turn on short selling"]'))`,'the confirmation');
  const dlg=await run(`document.querySelector('[role="dialog"][aria-label="Turn on short selling"]').innerText`);
  for(const w of [/Turn on short selling\? The app may then sell borrowed shares and buy them back later\. A short loses when the price rises, and its loss has no limit\./,/All shorts together stay within 20% of the account value\. Each gets a stop 15% above its sale price, and is bought back before its 90-day loan ends\./,/only KIS's own forced buy-back protects it/,/The app cannot send a short yet\. That is switched on by a later update, after one real test on your account\./])assert.match(dlg,w);
  for(const theme of ['dark','light']){if(await run('document.documentElement.dataset.theme')!==theme){await run(`document.querySelector('[aria-label="Dark mode"]').click()`);await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'the theme switch');}
    await run(`document.querySelector('[role="dialog"][aria-label="Turn on short selling"]').scrollIntoView({block:'center'})`);await capture(`short-confirm-${theme}`);}
  await run(`Array.from(document.querySelectorAll('[role="dialog"][aria-label="Turn on short selling"] button')).find(b=>b.textContent==='Cancel').click()`);
  await until(`!document.querySelector('[role="dialog"][aria-label="Turn on short selling"]')`,'the confirmation closed');
  assert.equal(await run(`window.portfolio.getExposure().then(r=>r.state.markets.KR.policy.short.enabled)`),false,'Cancel saves nothing');
  await run(`${sec}.scrollIntoView({block:'start'})`);await capture('short-settings-section');
  console.log('Short settings desktop passed');clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
