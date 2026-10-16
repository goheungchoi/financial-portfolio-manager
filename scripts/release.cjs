// Publishes a Windows release to GitHub: draft first (electron-builder's parallel uploads otherwise race to create the
// release), upload, verify latest.yml against the installer, then publish the draft. Requires `gh auth login`.
const {spawnSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');const pkg=require('../package.json');const {owner,repo}=pkg.build.publish[0];const tag='v'+pkg.version;const slug=`${owner}/${repo}`;
const run=(command,args,options={})=>{const result=spawnSync(command,args,{cwd:root,encoding:'utf8',...options});if(result.status!==0){process.stderr.write((result.stdout??'')+(result.stderr??''));throw new Error(`${command} ${args[0]} failed`);}return (result.stdout??'').trim();};
try{
  const existing=spawnSync('gh',['release','view',tag,'-R',slug,'--json','isDraft','--jq','.isDraft'],{cwd:root,encoding:'utf8'});
  if(existing.status===0&&existing.stdout.trim()==='false')throw new Error(`${tag} is already published; raise the version in package.json first.`);
  if(existing.status!==0)run('gh',['release','create',tag,'-R',slug,'--draft','--target','main','--title',pkg.version,'--notes',`Financial Portfolio Manager ${pkg.version}`]);
  const token=run('gh',['auth','token']);
  run(process.platform==='win32'?'npx.cmd':'npx',['electron-builder','--win','--publish','always'],{env:{...process.env,GH_TOKEN:token},stdio:['ignore','inherit','inherit'],shell:process.platform==='win32'});
  const dir=path.join(root,pkg.build.directories.output),yml=fs.readFileSync(path.join(dir,'latest.yml'),'utf8');const file=/^path: (.+)$/m.exec(yml)[1];
  const actual=crypto.createHash('sha512').update(fs.readFileSync(path.join(dir,file))).digest('base64');
  if(!yml.includes(`version: ${pkg.version}`)||/^sha512: (.+)$/m.exec(yml)[1]!==actual)throw new Error('latest.yml does not match the built installer; the draft was left unpublished.');
  run('gh',['release','edit',tag,'-R',slug,'--draft=false','--latest']);
  console.log(`Published ${tag}: https://github.com/${slug}/releases/tag/${tag}`);
}catch(error){console.error(error.message);process.exit(1);}
