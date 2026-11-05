const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
// Verifies a packaged build: the path given, or the latest portable build, on a fresh profile; with --profile <dir>, on
// that copied profile instead (its saved preferences kept; the runtime pause is asserted, electron/main.cjs).
const args=process.argv.slice(2),at=args.indexOf('--profile'),profile=at>=0?path.resolve(args.splice(at,2)[1]):null;
const build=args[0]?{executable:path.resolve(args[0])}:JSON.parse(fs.readFileSync(path.join(__dirname,'../release/latest.json'),'utf8'));fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});const directory=profile??fs.mkdtempSync(path.join(__dirname,'../artifacts/package-verify-'));
const result=spawnSync(build.executable,['--verify-build',...(profile?['--verify-profile']:[])],{windowsHide:true,encoding:'utf8',timeout:20000,env:{...process.env,PORTFOLIO_VERIFY_DIR:directory}});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.status!==0||!result.stdout?.includes('Portable build verified:')||profile&&!result.stdout.includes('Copied profile verified:'))process.exit(1);
