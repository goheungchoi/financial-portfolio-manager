const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const {writeReport}=require('./desktop-report.cjs');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'artifacts/ui-tests');fs.mkdirSync(artifacts,{recursive:true});
const directory=fs.mkdtempSync(path.join(artifacts,'run-'));const data=group=>{const dir=path.join(directory,'data-'+group);fs.mkdirSync(dir,{recursive:true});return dir;};
const groups={smoke:data('smoke'),connections:data('connections'),overseas:data('overseas'),regression:data('regression')};
const cases=[
  ['Application and market smoke','electron-smoke.cjs',[],groups.smoke],['Restart persistence','electron-smoke.cjs',['--restore'],groups.smoke],
  ['Korean portfolio and charts','kis-desktop.cjs',[],groups.smoke],['Paper, engine settings and broker approvals','runtime-desktop.cjs',[],groups.smoke],
  ['U.S. and combined portfolios','overseas-desktop.cjs',[],groups.overseas],
  ['Remembered file import','reconnect-desktop.cjs',[],groups.connections],['Remembered file restore','reconnect-desktop.cjs',['--restore-files'],groups.connections],['Remembered file forget','reconnect-desktop.cjs',['--forgotten'],groups.connections],
  ['Layout, themes, navigation and read-only review regressions','ui-regression-desktop.cjs',[],groups.regression],
  ['Several orders per review: scenario reviews in the Journal, Home and Engine settings','several-orders-desktop.cjs',[],data('several-orders')],
  ['Price-review rows: the four options from the user\'s state, Observe and the trial row','not-held-desktop.cjs',[],data('not-held')],
  ['Amounts of money: grouping, read-back, paste and the saved number','money-desktop.cjs',[],data('money')],
  ['A cash change being checked: the Home line and Record it','cash-check-desktop.cjs',[],data('cash-check')],
  ['A scout run that gave no plan: the card keeps the plan and says so','scout-failed-desktop.cjs',[],data('scout-failed')],
  ['Home Holdings card: every holding, 7 rows fit','home-holdings-desktop.cjs',['--count','7'],data('home-holdings-7')],
  ['Home Holdings card: every holding, 15 rows scroll inside the card','home-holdings-desktop.cjs',['--count','15'],data('home-holdings-15')],
  ['Short positions: the section below the holdings on Home and the Holdings tab, an app short and one opened in the KIS app, both themes','short-positions-desktop.cjs',[],data('short-positions')],
  ['Claude trading with several orders: Start, Stop with a dry run that no longer counts, and the refusal sentence','claude-start-stop-desktop.cjs',[],data('claude-start-stop')],
  ['Activity: opens with rows, totals with a corrected order, Today and not-sent, From, a failed refresh keeps rows, both themes','activity-desktop.cjs',[],data('activity')],
  ["Scripts: the Scout panel's Screens section with a partly read history and a failed run's scripts",'s5-desktop.cjs',['--mode=screens'],data('s5-screens')],
  ["Scripts: the Screens section with nothing stored yet",'s5-desktop.cjs',['--mode=screens-empty'],data('s5-screens-empty')],
  ["Scripts: the Journal's Scripts section of a review",'s5-desktop.cjs',['--mode=journal'],data('s5-journal')],
  ["Stops not watched: the Home line and the words Stop returns",'s5-desktop.cjs',['--mode=stops'],data('s5-stops')],
  ["Buy-back blocked: the Activity list, the ticket line and Remove",'s5-desktop.cjs',['--mode=buyback'],data('s5-buyback')],
  ["Buy-back: Home's App buys wait line while the order history cannot be read",'s5-desktop.cjs',['--mode=buyback-wait'],data('s5-buyback-wait')],
  ["Orders while stopped: the setting on after a restart, Home's watched line, Stop everything and its reply",'b4-desktop.cjs',['--mode=watch-on'],data('b4-watch-on')],
  ["Orders while stopped: the setting off, its confirmation in Engine settings, then Home's watched line",'b4-desktop.cjs',['--mode=watch-off'],data('b4-watch-off')],
  ['In-app updates against a local release server','update-desktop.cjs',[],data('updates')]
];
const report={startedAt:new Date().toISOString(),status:'passed',cases:[],fixtureOnly:true};
for(let index=0;index<cases.length;index++){
  const [name,file,args,userData]=cases[index],started=Date.now();const result=spawnSync(require('electron'),[path.join(__dirname,file),...args],{windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,PORTFOLIO_SMOKE_DATA:userData,PORTFOLIO_REPORT_DIR:directory}});
  const log=`case-${index+1}.log`;const output=(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:'');fs.writeFileSync(path.join(directory,log),output);process.stdout.write(output);
  const status=result.status===0&&!result.error?'passed':'failed';report.cases.push({name,file,status,durationMs:Date.now()-started,log,exitCode:result.status});if(status==='failed'){report.status='failed';break;}
}
report.finishedAt=new Date().toISOString();writeReport(directory,report);fs.writeFileSync(path.join(artifacts,'latest.json'),JSON.stringify({directory,status:report.status,report:path.join(directory,'report.html')},null,2));console.log(`UI report: ${path.join(directory,'report.html')}`);process.exit(report.status==='passed'?0:1);
