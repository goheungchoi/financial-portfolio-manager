// Several orders open at once stays off in the app (planner's condition 2 for 1.5.64): only the engine and the broker
// files may mention severalOpen. If electron/main.cjs, or any other app file, ever mentions it, the switch could be
// turned on in a real run. This test is removed only at activation, on the user's own words.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const ALLOWED=new Set(['electron/live-engine.cjs','electron/kis-client.cjs','electron/kis-overseas.cjs','electron/kis-worker.cjs','electron/broker-open-orders.cjs']);
function files(dir){const out=[];for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const rel=dir+'/'+e.name;if(e.isDirectory()){if(e.name!=='node_modules')out.push(...files(rel));}else if(/\.(c|m)?[jt]sx?$/.test(e.name))out.push(rel);}return out;}
test('severalOpen is mentioned only in the engine and broker files; never in main.cjs or anything else of the app',()=>{
  const found=[...files('electron'),...files('src')].filter(f=>fs.readFileSync(path.join(root,f),'utf8').includes('severalOpen'));
  assert.deepEqual(found.filter(f=>!ALLOWED.has(f)),[],'only the allowed files');
  assert.equal(fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8').includes('severalOpen'),false,'main.cjs builds both engines without it');
  assert.ok(found.includes('electron/live-engine.cjs'),'the scan sees the engine (it reads the right files)');
});
