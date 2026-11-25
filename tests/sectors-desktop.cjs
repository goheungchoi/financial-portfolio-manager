// Sectors S1 and S2 on screen (artifacts/reviews/2026-11-25-sectors): a stubbed KIS account with four made-up holdings and
// a seeded stock list. Holdings shows each row's sector and detail (from KIS's category by the table, from a stored AI
// assignment, Unclassified for a category that spans sectors and for a fund); the allocation by Sector groups them;
// Edit classification holds only your label, with the app's sector as its placeholder and where it came from; a typed
// label wins and clearing it returns; Assign again removes an AI assignment. Made-up data only; no AI call, no credential.
const {app,dialog}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/sectors-desktop');fs.mkdirSync(output,{recursive:true});
const {KisService}=require('../electron/kis-service.cjs');
const rows=[['990001','Fixture Pharma','0009',30000,10],['990002','Fixture Chips','0013',50000,6],['990003','Fixture Parts','0013',20000,5],['990004','Fixture Index Fund','',10000,8]];
const holdings=rows.map(([symbol,name,,price,quantity])=>({symbol,name,quantity,cost:price,price,marketValue:price*quantity,unrealized:0}));
const snapshot={source:'kis',environment:'mock',timestamp:new Date().toISOString(),cash:100000,reportedTotal:100000+holdings.reduce((s,h)=>s+h.marketValue,0),holdings};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(process.env.PORTFOLIO_SMOKE_DATA,'fixture-only-no-file-read.json')]});
KisService.prototype.request=async function(operation){
  if(this.workerScript==='provider-worker.cjs')throw new Error('No AI request in this fixture: '+operation);
  if(operation==='quotes')return holdings.map(h=>({symbol:h.symbol,price:h.price,retrievedAt:Date.now()}));
  if(operation==='orders')return {source:'kis',environment:'mock',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),orders:[]};
  if(operation==='profit')return {source:'kis',environment:'mock',startDate:'',endDate:'',retrievedAt:new Date().toISOString(),records:[],summary:{realized:0,fee:0,tax:0,returnPct:0}};
  if(['history','company-chart','chart-bars','chart-stream','market-evidence'].includes(operation))throw new Error('not in this fixture');
  return snapshot;};
// The stock list, KIS's index-sector names and one stored AI assignment, written to the app's own database before the
// account is read (the tables are the app's; the rows are made up).
function seed(){const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));
  try{const at=Date.now();
    for(const [symbol,name,sector] of rows)db.prepare('INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET type=excluded.type,sector=excluded.sector').run(symbol,name,'','KOSPI',symbol==='990004'?'etf':'stock','KR'+symbol,'0027',sector||null,null);
    for(const [code,name] of [['0009','제약'],['0013','전기·전자']])db.prepare('INSERT INTO index_codes VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name').run(code,'0',name,at);
    db.prepare('INSERT INTO sector_assignments VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload').run('990002',JSON.stringify({sector:'Information Technology',detail:'Semiconductors',model:'claude-haiku-5-5',at:Date.parse('2026-11-25T12:00:00Z'),category:'전기·전자'}));
  }finally{db.close();}}
const timer=setTimeout(()=>{console.error('Sectors desktop timed out');app.exit(1);},120000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.setSize(1280,900);win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what+'. Page: '+String(await run('document.body.innerText')).slice(0,600));};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  const navigate=async tab=>{await run(`(name=>(name==='Home'?document.querySelector('.brand'):Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab===name)))(${JSON.stringify(tab)}).click()`);await until(`document.querySelector('h1')?.textContent===${JSON.stringify(tab)}`,'the '+tab+' page');};
  const rowText=symbol=>`Array.from(document.querySelectorAll('[aria-label="Holdings table"] tbody tr')).map(r=>r.innerText).find(t=>t.includes(${JSON.stringify(symbol)}))??''`;
  const editor=`document.querySelector('.metadata-editor')`;
  const openEditor=async name=>{await run(`document.querySelector('[aria-label="Edit classification for ${name}"]').click()`);await until(`Boolean(${editor})`,'the editor');};
  const save=async()=>{await run(`Array.from(document.querySelectorAll('.metadata-editor button')).find(b=>b.textContent==='Save classification').click()`);await until(`!${editor}`,'the editor closed');};
  const setSector=async value=>run(`(()=>{const i=document.querySelector('.metadata-editor input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  seed();await run('window.portfolio.importKis()');
  await navigate('Holdings');await until(`${rowText('990004')}!==''`,'the four holdings');
  assert.match(await run(rowText('990001')),/990001 · Health Care · Pharmaceuticals/,'from KIS\'s category by the table');
  assert.match(await run(rowText('990002')),/990002 · Information Technology · Semiconductors/,'from the stored AI assignment');
  assert.match(await run(rowText('990003')),/990003 · Unclassified/,'a category that spans sectors, not yet assigned');
  assert.match(await run(rowText('990004')),/990004 · Unclassified/,'a fund never takes KIS\'s product type');
  // The allocation by sector (Home's Allocation card).
  await navigate('Home');await until(`Boolean(document.querySelector('[aria-label="Allocation grouping"]'))`,'Home\'s allocation');
  await run(`(()=>{const s=document.querySelector('[aria-label="Allocation grouping"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'Sector');s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await until(`document.body.innerText.includes('Health Care')&&document.body.innerText.includes('Information Technology')`,'the sector groups');await capture('sectors-allocation');
  await navigate('Holdings');await until(`${rowText('990004')}!==''`,'the holdings again');
  // The editor: only your label in the box; the app's sector as the placeholder and where it came from.
  await openEditor('Fixture Pharma');
  assert.equal(await run(`${editor}.querySelector('input').value`),'','the box holds only your label (none yet)');
  assert.equal(await run(`${editor}.querySelector('input').placeholder`),'Health Care');
  assert.equal(await run(`${editor}.querySelector('[aria-label="Sector source"]').textContent`),"From KIS's category (제약)");await run(editor+'.scrollIntoView({block:"center"})');await capture('sectors-editor-kis');
  await setSector('My robots');await until(`${editor}.querySelector('[aria-label="Sector source"]').textContent==='Your label'`,'the line for your label');await save();
  await until(`${rowText('990001')}.includes('990001 · My robots')`,'your label wins');
  await openEditor('Fixture Pharma');assert.equal(await run(`${editor}.querySelector('input').value`),'My robots');assert.equal(await run(`${editor}.querySelector('input').placeholder`),'Health Care','the app\'s sector without your label');
  await setSector('');await until(`${editor}.querySelector('[aria-label="Sector source"]').textContent==="From KIS's category (제약)"`,'the line without a label');await save();
  await until(`${rowText('990001')}.includes('990001 · Health Care')`,'clearing your label returns to the app\'s sector');
  // An AI assignment: its line and Assign again.
  await openEditor('Fixture Chips');
  assert.equal(await run(`${editor}.querySelector('[aria-label="Sector source"]').textContent`),'Assigned by AI (claude-haiku-5-5, 2026-11-25)');await run(editor+'.scrollIntoView({block:"center"})');await capture('sectors-editor-ai');
  await run(`Array.from(document.querySelectorAll('.metadata-editor button')).find(b=>b.textContent==='Assign again').click()`);
  await until(`${rowText('990002')}.includes('990002 · Unclassified')`,'Assign again removes the assignment');
  await run(`Array.from(document.querySelectorAll('.metadata-editor button')).find(b=>b.textContent==='Cancel')?.click()`);
  // Not classified yet.
  await openEditor('Fixture Parts');assert.equal(await run(`${editor}.querySelector('[aria-label="Sector source"]').textContent`),'Not classified yet');
  clearTimeout(timer);console.log('Sectors desktop passed: rows, allocation by sector, the editor\'s source lines, your label wins and clears, Assign again');app.exit(0);
}catch(error){console.error('Sectors desktop:',error);app.exit(1);}});});
require('../electron/main.cjs');
