// The scout's research focus follows the hour (electron/scout.cjs researchFocus): Korean hours, U.S. hours, both
// markets in the evening's extended sessions, none at night or at weekends. A fixture that passes at one hour can fail
// at another (2026-11-18: a scout fixture holding a U.S. stock with only a Korean target failed after the Korean close).
// This runs every test file of the npm test list that starts a scout at each of those hours. Part of the pre-release
// check: npm run test:hours.
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const list=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts.test.split(/\s+/).filter(f=>/^tests\/.+\.test\.(c|m)?js$/.test(f));
const files=list.filter(f=>/\.scout\(|runScout\(|scoutTick\(/.test(fs.readFileSync(path.join(root,f),'utf8')));
const HOURS=[['Korean regular hours (Wed 10:30 KST)','2026-11-18T01:30:00Z'],['both markets, evening extended sessions (Wed 18:30 KST)','2026-11-18T09:30:00Z'],
  ['U.S. regular hours (Thu 00:00 KST)','2026-11-18T15:00:00Z'],['no market open (Thu 07:30 KST)','2026-11-18T22:30:00Z'],['weekend (Sun 12:00 KST)','2026-11-22T03:00:00Z'],
  // A Korean day with other hours (kr-hours.cjs): 09:30 on 2026-11-19, before the shifted 10:00 open.
  ['Korean late open, before the open (Thu 2026-11-19 09:30 KST)','2026-11-19T00:30:00Z']];
let failed=0;console.log(`${files.length} test files start a scout.`);
for(const [label,at] of HOURS){const r=spawnSync(process.execPath,['--require',path.join(__dirname,'helpers','shift-clock.cjs'),'--test',...files],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,PORTFOLIO_FAKE_NOW:at}});
  const out=(r.stdout??'')+(r.stderr??'');const pass=/ℹ pass (\d+)/.exec(out)?.[1],fail=/ℹ fail (\d+)/.exec(out)?.[1];
  console.log(`${r.status===0?'ok  ':'FAIL'} ${label}: ${pass??'?'} passed, ${fail??'?'} failed`);
  if(r.status!==0){failed++;for(const line of new Set(out.split(/\r?\n/).filter(l=>/^✖ /.test(l)&&!/^✖ failing tests/.test(l))))console.log('     '+line);}}
process.exit(failed?1:0);
