const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const {writeReport}=require('./desktop-report.cjs');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'artifacts/ui-tests');fs.mkdirSync(artifacts,{recursive:true});
const directory=fs.mkdtempSync(path.join(artifacts,'run-'));const data=group=>{const dir=path.join(directory,'data-'+group);fs.mkdirSync(dir,{recursive:true});return dir;};
const groups={smoke:data('smoke'),connections:data('connections'),overseas:data('overseas'),regression:data('regression')};
const shortsSaved=data('shorts-saved');// the saved-switch case and its restart share one folder
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
  ['Short & leverage: the controls of the short section, and the confirmation when short selling is turned on (Cancel saves nothing), both themes','short-settings-desktop.cjs',[],data('short-settings')],
  ['The Korea tab Orders card: your buy prepared while a short was open shows KIS orderable cash, a cover its buy-back cost, both themes','short-ticket-desktop.cjs',[],data('short-ticket')],
  ['Shorts on: a fake short through the opened paths on the stand-in KIS: sent, tied, its cover stop armed, hit, approved, sent, filled; Short positions on Home','shorts-desktop.cjs',['--mode=flow'],data('shorts-flow')],
  ['Shorts on: the unprotected listings: conditional orders off, a tie gone (with its dismissal), a lot the app cannot tie','shorts-desktop.cjs',['--mode=unprotected'],data('shorts-unprotected')],
  ['Shorts on: a short-selling switch saved on by an earlier version: the Home notice after the first balance reading, one Activity line, dismissed','shorts-desktop.cjs',['--mode=saved-switch'],shortsSaved],
  ['Shorts on: the saved-switch notice after a restart: gone','shorts-desktop.cjs',['--mode=saved-restart'],shortsSaved],
  ['Shorts on: the saved-switch notice on a mock account: none','shorts-desktop.cjs',['--mode=saved-mock'],data('shorts-saved-mock')],
  ['Shorts on: Short & leverage when a hit stop is sent by itself (kept working with a switches record)','shorts-desktop.cjs',['--mode=settings-sent'],data('shorts-settings-sent')],
  ['Shorts on: Start on Claude with short selling on asks the dry run, then Start works; turning short selling on while running is refused on screen','shorts-desktop.cjs',['--mode=claude'],data('shorts-claude')],
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
  ["Orders while stopped: the start notice follows the watch state (not watched, watched, Dismiss, off, on, Stop everything)",'b4-desktop.cjs',['--mode=notice'],data('b4-notice')],
  ["The token fix: Home's KIS-not-answering line after KIS ended the sign-in",'token-desktop.cjs',['--mode=kis-down'],data('token-kis-down')],
  ["The token fix: an unknown order holds Korean orders; KIS never took it, the market stopped: nothing is sent until Start",'token-desktop.cjs',['--mode=not-taken-halted'],data('token-not-taken-halted')],
  ["The token fix: KIS never took it with orders watched while stopped: may be sent right away; the app never checked KIS",'token-desktop.cjs',['--mode=not-taken-watched'],data('token-not-taken-watched')],
  ["The token fix: KIS never took it while trading runs: no before-line; KIS showed no order like it",'token-desktop.cjs',['--mode=not-taken-running'],data('token-not-taken-running')],
  ["The token fix: Connections' one-sign-in-a-minute wait line",'token-desktop.cjs',['--mode=connections-wait'],data('token-connections-wait')],
  ['In-app updates against a local release server','update-desktop.cjs',[],data('updates')]
];
const report={startedAt:new Date().toISOString(),status:'passed',cases:[],fixtureOnly:true};
for(let index=0;index<cases.length;index++){
  const [name,file,args,userData]=cases[index],started=Date.now();const result=spawnSync(require('electron'),[path.join(__dirname,file),...args],{windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,PORTFOLIO_SMOKE_DATA:userData,PORTFOLIO_REPORT_DIR:directory}});
  const log=`case-${index+1}.log`;const output=(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:'');fs.writeFileSync(path.join(directory,log),output);process.stdout.write(output);
  const status=result.status===0&&!result.error?'passed':'failed';report.cases.push({name,file,status,durationMs:Date.now()-started,log,exitCode:result.status});if(status==='failed'){report.status='failed';break;}
}
report.finishedAt=new Date().toISOString();writeReport(directory,report);fs.writeFileSync(path.join(artifacts,'latest.json'),JSON.stringify({directory,status:report.status,report:path.join(directory,'report.html')},null,2));console.log(`UI report: ${path.join(directory,'report.html')}`);process.exit(report.status==='passed'?0:1);
