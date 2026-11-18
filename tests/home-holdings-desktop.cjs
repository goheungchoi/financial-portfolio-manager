// The Home Holdings card lists every holding (artifacts/reviews/2026-11-18-home-all-holdings): a stubbed KIS account
// with --count made-up holdings (7: no scroll; 15: the list scrolls inside the card). Every row is on the card, the
// Allocation panel beside it is not pushed down past the list's limit, a name reached by Tab is scrolled into view, and
// both themes are captured. Made-up data only; no credential file is read.
const {app,dialog}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const count=Number(process.argv[process.argv.indexOf('--count')+1]);if(!(count>0))throw new Error('--count N required');
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/home-holdings-desktop');fs.mkdirSync(output,{recursive:true});
const {KisService}=require('../electron/kis-service.cjs');
const holdings=Array.from({length:count},(_,i)=>{const quantity=count-i,price=10000+i*500;return {symbol:String(100100+i*10),name:`Fixture holding ${String.fromCharCode(65+i)}`,quantity,cost:Math.round(price*(i%3===0?.9:i%3===1?1.1:1)),price,marketValue:quantity*price,unrealized:0};});
const snapshot={source:'kis',environment:'mock',timestamp:new Date().toISOString(),cash:200000,reportedTotal:200000+holdings.reduce((s,h)=>s+h.marketValue,0),holdings};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
KisService.prototype.request=async function(operation){
  if(operation==='quotes')return holdings.map(h=>({symbol:h.symbol,price:h.price,retrievedAt:Date.now()}));
  if(operation==='orders')return {source:'kis',environment:'mock',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),orders:[]};
  if(operation==='profit')return {source:'kis',environment:'mock',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),records:[],summary:{realized:0,fee:0,tax:0,returnPct:0}};
  if(['history','company-chart','chart-bars','chart-stream'].includes(operation))throw new Error('not in this fixture');
  return snapshot;};
const timer=setTimeout(()=>{console.error('Home holdings desktop timed out');app.exit(1);},90000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  await run('window.portfolio.importKis()');
  await until(`document.querySelectorAll('[aria-label="Holdings"] .home-holdings-list>li').length===${count}`,`${count} rows on the Home card`);
  const names=await run(`Array.from(document.querySelectorAll('[aria-label="Holdings"] .company-link')).map(b=>b.textContent)`);
  assert.deepEqual(names,holdings.map(h=>h.name),'every holding, largest value first');
  assert.ok((await run(`document.querySelector('[aria-label="Holdings"] .section-head').innerText`)).includes(`All ${count} →`));
  const list=`document.querySelector('[aria-label="Holdings"] .home-holdings-list')`;
  const m=await run(`(()=>{const l=${list};return {client:l.clientHeight,scroll:l.scrollHeight,overflow:getComputedStyle(l).overflowY};})()`);
  assert.equal(m.overflow,'auto');assert.ok(m.client<=362,`list height ${m.client}`);
  if(count>10)assert.ok(m.scroll>m.client+20,`15 rows scroll inside the card (${m.scroll} > ${m.client})`);else assert.ok(m.scroll<=m.client+1,`7 rows fit without a scroll (${m.scroll} vs ${m.client})`);
  for(const theme of ['dark','light']){
    if(await run('document.documentElement.dataset.theme')!==theme){await run(`document.querySelector('[aria-label="Dark mode"]').click()`);await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'the theme switch');}
    await run(`${list}.scrollTop=0;{const s=document.querySelector('[aria-label="Holdings"]');s.style.scrollMarginTop='70px';s.scrollIntoView({block:'start'});}`);await capture(`home-holdings-${count}-${theme}`);
    if(count>10){// Focus the last name: the list scrolls it into view and its focus ring shows inside the list.
      await run(`document.querySelector('[aria-label="Holdings"] .home-holdings-list>li:last-child .company-link');document.activeElement?.blur();document.querySelector('[aria-label="Holdings"] .home-holdings-list>li:last-child .company-link').focus({focusVisible:true})`);
      await until(`(()=>{const l=${list},b=l.lastElementChild.getBoundingClientRect(),r=l.getBoundingClientRect();return l.scrollTop>0&&b.bottom<=r.bottom+1;})()`,'the focused last row scrolled into view');
      await capture(`home-holdings-${count}-${theme}-last-focused`);}}
  console.log(`Home holdings desktop passed: ${count} rows, list ${m.client}px of ${m.scroll}px`);clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
