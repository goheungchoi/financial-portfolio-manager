const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const {writeReport}=require('./desktop-report.cjs');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'artifacts/ui-tests');fs.mkdirSync(artifacts,{recursive:true});
const directory=fs.mkdtempSync(path.join(artifacts,'run-'));const data=group=>{const dir=path.join(directory,'data-'+group);fs.mkdirSync(dir,{recursive:true});return dir;};
const groups={smoke:data('smoke'),connections:data('connections'),overseas:data('overseas'),regression:data('regression')};
const cases=[
  ['Application and market smoke','electron-smoke.cjs',[],groups.smoke],['Restart persistence','electron-smoke.cjs',['--restore'],groups.smoke],
  ['Korean portfolio and charts','kis-desktop.cjs',[],groups.smoke],['Paper, engine settings and broker approvals','runtime-desktop.cjs',[],groups.smoke],
  ['U.S. and combined portfolios','overseas-desktop.cjs',[],groups.overseas],
  ['Remembered file import','reconnect-desktop.cjs',[],groups.connections],['Remembered file restore','reconnect-desktop.cjs',['--restore-files'],groups.connections],['Remembered file forget','reconnect-desktop.cjs',['--forgotten'],groups.connections],
  ['Layout, themes, navigation and read-only review regressions','ui-regression-desktop.cjs',[],groups.regression]
];
const report={startedAt:new Date().toISOString(),status:'passed',cases:[],fixtureOnly:true};
for(let index=0;index<cases.length;index++){
  const [name,file,args,userData]=cases[index],started=Date.now();const result=spawnSync(require('electron'),[path.join(__dirname,file),...args],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,PORTFOLIO_SMOKE_DATA:userData,PORTFOLIO_REPORT_DIR:directory}});
  const log=`case-${index+1}.log`;const output=(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:'');fs.writeFileSync(path.join(directory,log),output);process.stdout.write(output);
  const status=result.status===0&&!result.error?'passed':'failed';report.cases.push({name,file,status,durationMs:Date.now()-started,log,exitCode:result.status});if(status==='failed'){report.status='failed';break;}
}
report.finishedAt=new Date().toISOString();writeReport(directory,report);fs.writeFileSync(path.join(artifacts,'latest.json'),JSON.stringify({directory,status:report.status,report:path.join(directory,'report.html')},null,2));console.log(`UI report: ${path.join(directory,'report.html')}`);process.exit(report.status==='passed'?0:1);
