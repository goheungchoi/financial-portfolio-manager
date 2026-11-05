'use strict';
// Isolated provider test: prepares a test folder. Makes no network request and starts no app component.
//   node scripts/provider-test/prepare.cjs --out <new empty folder> [--dry-run 4c76aa03] [--keep-source]
// 1. Refuses while the app runs, and refuses a folder inside (or containing) the live profile, by real path.
// 2. Copies the live database with SQLite's online backup through a read-only connection (a consistent copy that
//    includes the write-ahead log), into <out>/.source. Nothing else is copied: no settings file, remembered file or
//    credential. The copy itself may hold settings and references to credential files, so it is used only here, read
//    only, and deleted when the fixture is composed unless --keep-source.
// 3. Composes the fixture (fixture.cjs) into <out>/fixture.json and records the live database's logical state.
const fs=require('node:fs'),path=require('node:path');
const RECORDED_BUILD={claimed:'1.5.48-stage1.1 (commit 49b6b37)',evidence:'artifacts/reviews/2026-11-04-stage1.md: the paused dry run of 2026-11-04 was run on that test build; the dry-run record does not store its build'};
function appRunning(){const r=require('node:child_process').spawnSync('tasklist',['/FI','IMAGENAME eq Financial Portfolio Manager.exe','/NH'],{encoding:'utf8',windowsHide:true});
  if(r.status!==0)throw Object.assign(new Error('PREPARE_REFUSED'),{detail:'could not check whether the app is running'});return /Financial Portfolio Manager\.exe/i.test(r.stdout);}
async function prepare({out,dryRun='4c76aa03',live,keepSource=false,running=appRunning}){
  const P=require('./paths.cjs'),S=require('./state.cjs'),F=require('./fixture.cjs');
  const where=P.separate(out,live?{live}:{});if(running())throw Object.assign(new Error('PREPARE_REFUSED'),{detail:'the app is running; close it first'});
  if(fs.existsSync(where.dir)&&fs.readdirSync(where.dir).length)throw Object.assign(new Error('PREPARE_REFUSED'),{detail:'the folder is not empty'});
  const liveDb=path.join(where.live,'portfolio.sqlite');if(!fs.existsSync(liveDb))throw Object.assign(new Error('PREPARE_REFUSED'),{detail:'no live profile database'});
  fs.mkdirSync(path.join(where.dir,'.source'),{recursive:true});const copy=path.join(where.dir,'.source','source.sqlite');
  const liveBefore=S.snapshot(liveDb);
  const {DatabaseSync,backup}=require('node:sqlite');const src=new DatabaseSync(liveDb,{readOnly:true});try{await backup(src,copy);}finally{src.close();}
  fs.chmodSync(copy,0o444);
  const copyState=S.logical(copy);if(copyState.sha256!==liveBefore.logical.sha256)throw Object.assign(new Error('PREPARE_REFUSED'),{detail:'the copy does not match the live database logically'});
  const fixture=F.compose({source:copy,dryRun,recordedBuild:RECORDED_BUILD});fs.writeFileSync(path.join(where.dir,'fixture.json'),JSON.stringify(fixture,null,1));
  const liveAfter=S.snapshot(liveDb);
  const record={preparedAt:new Date().toISOString(),dir:where.dir,live:{before:liveBefore,after:liveAfter,...S.compare(liveBefore,liveAfter)},copy:{logical:copyState.sha256,kept:keepSource},fixture:{digest:fixture.digest,kind:fixture.meta.kind}};
  if(!keepSource){fs.chmodSync(copy,0o666);fs.rmSync(path.join(where.dir,'.source'),{recursive:true,force:true});}
  fs.writeFileSync(path.join(where.dir,'prepare.json'),JSON.stringify(record,null,1));return {record,fixture};
}
if(require.main===module){const argv=process.argv.slice(2),arg=n=>{const i=argv.indexOf(n);return i>=0?argv[i+1]:null;};
  prepare({out:arg('--out'),dryRun:arg('--dry-run')??undefined,keepSource:argv.includes('--keep-source')}).then(({record,fixture})=>{
    process.stdout.write(`Prepared ${record.dir}: ${fixture.meta.kind}, dry run ${fixture.meta.dryRun}, cutoff ${fixture.meta.cutoff}, fixture ${fixture.digest.slice(0,16)}; live database logically ${record.live.unchanged?'unchanged':'CHANGED'}.\n`);})
    .catch(e=>{process.stderr.write(`Prepare stopped: ${e.message}${e.detail?` (${typeof e.detail==='string'?e.detail:JSON.stringify(e.detail)})`:''}\n`);process.exit(1);});}
module.exports={prepare,RECORDED_BUILD};
