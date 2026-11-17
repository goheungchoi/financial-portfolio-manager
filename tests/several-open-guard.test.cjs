// Several open orders is the user's own saved switch (M-6; the user's "A switch in settings"): default off, and nothing
// but that saved value turns it on. Until M-6 this test kept the switch out of the app entirely (planner's condition 2
// for 1.5.64); it now pins the wiring:
// - the saved setting severalOpenOrders defaults to false;
// - main.cjs gives both engines exactly a function of that saved setting, and nothing else;
// - no app file passes severalOpen:true to an engine or sets severalOpenOrders to true;
// - only the engine and broker files, main.cjs, automation.cjs and the settings screen name it.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const ALLOWED=new Set(['electron/live-engine.cjs','electron/kis-client.cjs','electron/kis-overseas.cjs','electron/kis-worker.cjs','electron/broker-open-orders.cjs',
  'electron/main.cjs','electron/automation.cjs','src/EngineSettings.tsx','src/RuntimeSettings.tsx']);
function files(dir){const out=[];for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const rel=dir+'/'+e.name;if(e.isDirectory()){if(e.name!=='node_modules')out.push(...files(rel));}else if(/\.(c|m)?[jt]sx?$/.test(e.name))out.push(rel);}return out;}
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('severalOpen is named only in the engine and broker files, main.cjs, automation.cjs and the settings screen',()=>{
  const found=[...files('electron'),...files('src')].filter(f=>read(f).includes('severalOpen'));
  assert.deepEqual(found.filter(f=>!ALLOWED.has(f)),[],'only the allowed files');
  assert.ok(found.includes('electron/live-engine.cjs'),'the scan sees the engine (it reads the right files)');
});
test('the saved switch defaults to off, and only the user\'s saved value turns it on',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'A'}],()=>[]),{request:async()=>({})},()=>{});
  assert.equal(a.config.severalOpenOrders,false,'default off');assert.equal(a.config.ordersPerReview,1,'default 1');
  // No app file turns it on by itself (code only: comments describing the tests' constructor option are not code).
  const code=s=>s.split(/\r?\n/).map(l=>l.replace(/(^|[^:'"`\\])\/\/.*$/,'$1')).join('\n');
  // The one allowed form: the engine passing the flag on to the broker's preparation when it is already on.
  for(const f of [...files('electron'),...files('src')]){const s=code(read(f)).split('this.severalOpen?{severalOpen:true}').join('');
    assert.doesNotMatch(s,/severalOpen\s*:\s*true/,`${f} passes severalOpen:true`);assert.doesNotMatch(s,/severalOpenOrders\s*[:=]\s*true/,`${f} sets severalOpenOrders to true`);}
});
test('main.cjs gives both engines exactly a function of the saved setting',()=>{
  const main=read('electron/main.cjs');
  assert.match(main,/live\.severalOpenSetting=usLive\.severalOpenSetting=\(\)=>automation\.config\.severalOpenOrders===true;/);
  assert.equal(main.split('severalOpen').length-1,3,'named only in that line (two engines and the setting)');
  // Both engines are still built without the fixed option.
  assert.doesNotMatch(main,/new LiveEngine\([^)]*severalOpen/);
});
test('the engine reads it at every use: off by default, on and off again with the saved value',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const e=new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>({})},()=>({status:'disconnected',snapshot:null}));
  assert.equal(e.severalOpen,false,'nothing given: off');let saved=false;e.severalOpenSetting=()=>saved===true;
  assert.equal(e.allowsSeveralOpen(),false);saved=true;assert.equal(e.allowsSeveralOpen(),true);saved=false;assert.equal(e.severalOpen,false,'off again at once');
  e.severalOpenSetting=()=>{throw new Error('boom');};assert.equal(e.severalOpen,false,'an unreadable setting is off');
});
