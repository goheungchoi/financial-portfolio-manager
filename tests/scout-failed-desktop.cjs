// The nearly empty scout plan (artifacts/reviews/2026-11-18-empty-scout-plan): the desktop hook. A scout plan and a later
// failed run (SCOUT_EMPTY_PLAN) are written into this run's own data folder before the app starts; Discover's scout card
// says "Last run gave no plan; the plan from MM-DD hh:mm is kept." and still shows that plan. Made-up data only.
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
if(!process.env.PORTFOLIO_SMOKE_DATA)throw new Error('Isolated UI data directory required');
app.setPath('userData',process.env.PORTFOLIO_SMOKE_DATA);
const output=process.env.PORTFOLIO_REPORT_DIR??path.resolve('artifacts/scout-failed-desktop');fs.mkdirSync(output,{recursive:true});
const planAt=Date.now()-10*3600000,failedAt=Date.now()-3600000;
{const {DatabaseSync}=require('node:sqlite');const S=require('../electron/scout.cjs');const db=new DatabaseSync(path.join(process.env.PORTFOLIO_SMOKE_DATA,'portfolio.sqlite'));const store=new S.ScoutStore(db);
  const plan=S.validatePlan({summary:'Chips lead; keep the leaders and wait for a pullback before adding.',cashTargetPct:30,focus:'Memory prices and the U.S. open.',targets:[{symbol:'005930',name:'Samsung Electronics',role:'hold',targetWeightPct:10,thesis:'Fixture plan from the evening run.',risks:''}],briefAnswers:[],retrospective:''});
  const saved=store.save('paper',plan,{runId:'fixture',trigger:'Scheduled',focus:['US'],model:'claude-opus-5-5'});db.prepare('UPDATE scout_plans SET timestamp=?,payload=? WHERE id=?').run(planAt,JSON.stringify({...saved,timestamp:planAt}),saved.id);
  store.noteFailure('paper',{at:failedAt,reason:'SCOUT_EMPTY_PLAN',trigger:'Scheduled'});db.close();}
const timer=setTimeout(()=>{console.error('Scout-failed desktop timed out');app.exit(1);},90000);
app.once('browser-window-created',(_event,win)=>{win.webContents.setBackgroundThrottling(false);win.hide();win.webContents.once('did-finish-load',async()=>{try{
  const run=code=>win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message} (in: ${code.slice(0,200)})`);});
  const until=async(code,what,ms=20000)=>{const t=Date.now();while(Date.now()-t<ms){if(await run(code))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out waiting for '+what);};
  const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await new Promise(r=>setTimeout(r,300));
    for(let attempt=0;attempt<3;attempt++){try{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250));}}};
  await run(`Array.from(document.querySelectorAll('.nav')).find(b=>b.dataset.tab==='Discover').click()`);await until(`Boolean(document.querySelector('[aria-label="AI scout"]'))`,'the scout card');
  const k=new Date(planAt+9*3600000).toISOString(),want=`Last run gave no plan; the plan from ${k.slice(5,10)} ${k.slice(11,16)} is kept.`;
  await until(`document.querySelector('[aria-label="Last scout run"]')?.textContent===${JSON.stringify(want)}`,'the line: '+want);
  assert.ok((await run(`document.querySelector('[aria-label="AI scout"]').innerText`)).includes('Chips lead; keep the leaders'),'the kept plan still shows');
  await run(`document.querySelector('[aria-label="AI scout"]').scrollIntoView({block:'start'})`);await capture('scout-failed-card');
  console.log('Scout-failed desktop passed: '+want);clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});});
require('../electron/main.cjs');
