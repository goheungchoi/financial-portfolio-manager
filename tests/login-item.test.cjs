// "Start with Windows" (restart part 1, step 3; fixed 2026-11-17, artifacts/reviews/2026-11-17-start-with-windows): the
// state comes from Windows each time; only the installed app sets it; a development run never calls Windows; test runs
// use an in-memory fake; a failing call is reported, never thrown. No test touches the real login items: Windows is a fake
// that parses paths as Electron 44 does (CommandLineToArgvW: unquoted, the program ends at the first space).
const test=require('node:test');const assert=require('node:assert/strict');const {createLoginItem,stateOf,quoted}=require('../electron/login-item.cjs');
const SPACED='C:\\Users\\u\\AppData\\Local\\Programs\\Financial Portfolio Manager\\Financial Portfolio Manager.exe',PLAIN='C:\\Apps\\fpm\\fpm.exe';
const NAME='electron.app.Financial Portfolio Manager';
const program=cmd=>{const s=String(cmd).trim();if(s.startsWith('"')){const end=s.indexOf('"',1);return end<0?s.slice(1):s.slice(1,end);}const sp=s.indexOf(' ');return sp<0?s:s.slice(0,sp);};
// Windows' Run keys for this test: user and machine values {name: {cmd, enabled}}; the exe the process runs from.
function fakeWindows({exe=SPACED,user={},machine={}}={}){const calls=[];const keys={user:{...user},machine:{...machine}};
  const items=lookup=>['user','machine'].flatMap(scope=>Object.entries(keys[scope]).filter(([,v])=>program(v.cmd).toLowerCase()===lookup.toLowerCase()).map(([name,v])=>({name,path:program(v.cmd),args:[],scope,enabled:v.enabled!==false})));
  return {calls,keys,
    getLoginItemSettings(options={}){calls.push(['get',options]);const lookup=program(options.path||exe);const launchItems=items(lookup);
      return {openAtLogin:keys.user[NAME]?.cmd===quoted(exe),executableWillLaunchAtLogin:launchItems.some(i=>i.enabled),launchItems,wasOpenedAtLogin:false};},
    setLoginItemSettings(s){calls.push(['set',s]);const name=s.name||NAME;if(s.openAtLogin)keys.user[name]={cmd:quoted(exe),enabled:s.enabled!==false};else delete keys.user[name];}};}
const ours=(enabled=true)=>({cmd:quoted(SPACED),enabled});
test('the cause: Electron\'s own read (no path) of a spaced install path finds nothing; ours, quoted, finds the entry',()=>{
  const win=fakeWindows({user:{[NAME]:ours()}});
  assert.equal(win.getLoginItemSettings().executableWillLaunchAtLogin,false,'the 1.5.65 read: cut at "Financial"');
  assert.equal(win.getLoginItemSettings().openAtLogin,true,'openAtLogin compares the quoted string and says yes');
  assert.deepEqual(createLoginItem({app:win,packaged:true,execPath:SPACED}).get(),{available:true,on:true});
  assert.deepEqual(win.calls.at(-1),['get',{path:quoted(SPACED)}],'the read passes the path quoted');});
test('the read never depends on the path\'s shape: with and without spaces, both passed quoted',()=>{
  for(const exe of [SPACED,PLAIN]){const win=fakeWindows({exe,user:{[NAME]:{cmd:quoted(exe)}}});const li=createLoginItem({app:win,packaged:true,execPath:exe});
    assert.deepEqual(li.get(),{available:true,on:true},exe);assert.equal(win.calls.at(-1)[1].path,'"'+exe+'"');}
  assert.equal(quoted('"'+PLAIN+'"'),'"'+PLAIN+'"','an already quoted path is not quoted twice');});
test('stateOf over the shapes getLoginItemSettings returns',()=>{
  const item=(o={})=>({name:NAME,path:SPACED,args:[],scope:'user',enabled:true,...o});
  assert.deepEqual(stateOf({executableWillLaunchAtLogin:true,launchItems:[item()]}),{available:true,on:true},'present and approved');
  assert.deepEqual(stateOf({executableWillLaunchAtLogin:false,launchItems:[item({enabled:false})]}),{available:true,on:false,note:'Turned off in Windows Startup apps.'},'present, switched off in Startup apps');
  assert.deepEqual(stateOf({executableWillLaunchAtLogin:false,launchItems:[]}),{available:true,on:false},'absent (or present for another path: not listed)');
  assert.deepEqual(stateOf({executableWillLaunchAtLogin:true,launchItems:[item({name:'Financial Portfolio Manager'})]}),{available:true,on:true},'an old-name value only');
  assert.deepEqual(stateOf({executableWillLaunchAtLogin:true,launchItems:[item({scope:'machine'})]}),{available:true,on:true,note:'Set for all users of this PC; turn it off in Windows Startup apps.'},'a machine value');
  for(const bad of [null,undefined,{},{executableWillLaunchAtLogin:'yes'}])assert.deepEqual(stateOf(bad),{available:false,on:false,reason:'Windows did not answer. Try again later.'},JSON.stringify(bad));});
test('through Windows: another path\'s value does not count; Startup apps\' switch-off reads off with the note',()=>{
  assert.deepEqual(createLoginItem({app:fakeWindows({user:{[NAME]:{cmd:quoted('C:\\Other app\\app.exe')}}}),packaged:true,execPath:SPACED}).get(),{available:true,on:false});
  assert.deepEqual(createLoginItem({app:fakeWindows({user:{[NAME]:ours(false)}}),packaged:true,execPath:SPACED}).get(),{available:true,on:false,note:'Turned off in Windows Startup apps.'});});
test('turning off removes the app\'s value and every old-name value of this user; a machine value is left',()=>{
  const win=fakeWindows({user:{[NAME]:ours(),'Financial Portfolio Manager':ours(),'Other':{cmd:quoted('C:\\x\\y.exe')}},machine:{FPM:ours()}});
  const r=createLoginItem({app:win,packaged:true,execPath:SPACED}).set(false);
  assert.deepEqual(Object.keys(win.keys.user),['Other'],'only another app\'s value is left');assert.deepEqual(Object.keys(win.keys.machine),['FPM']);
  assert.deepEqual(r,{available:true,on:true,note:'Set for all users of this PC; turn it off in Windows Startup apps.'},'still on through the machine value, and says so');
  const plain=fakeWindows({user:{[NAME]:ours()}});assert.deepEqual(createLoginItem({app:plain,packaged:true,execPath:SPACED}).set(false),{available:true,on:false});assert.deepEqual(plain.keys.user,{});});
test('turning on leaves exactly one value, under the app\'s name, approved: old names and a switch-off are cleared',()=>{
  const win=fakeWindows({user:{'Financial Portfolio Manager':ours(false)}});const r=createLoginItem({app:win,packaged:true,execPath:SPACED}).set(true);
  assert.deepEqual(win.keys.user,{[NAME]:{cmd:quoted(SPACED),enabled:true}});assert.deepEqual(r,{available:true,on:true});
  assert.deepEqual(win.calls.filter(c=>c[0]==='set').map(c=>c[1]),[{openAtLogin:false,name:'Financial Portfolio Manager'},{openAtLogin:true}]);
  const again=fakeWindows({user:{[NAME]:ours()}});createLoginItem({app:again,packaged:true,execPath:SPACED}).set(true);assert.deepEqual(Object.keys(again.keys.user),[NAME],'no second value');});
test('a development run (not packaged): not available, and Windows is never called',()=>{
  const app=fakeWindows();const li=createLoginItem({app,packaged:false});
  assert.deepEqual(li.get(),{available:false,on:false,reason:'Available in the installed app.'});assert.deepEqual(li.set(true),{available:false,on:false,reason:'Available in the installed app.'});
  assert.deepEqual(app.calls,[],'no call reached the login-item API');});
test('test runs use the in-memory fake: the real API is never called',()=>{
  const app=fakeWindows();const li=createLoginItem({app,packaged:true,fake:{on:false}});
  assert.deepEqual(li.get(),{available:true,on:false,test:true});assert.deepEqual(li.set(true),{available:true,on:true,test:true});assert.deepEqual(app.calls,[]);});
test('Windows failing: reported, never thrown (and not shown as off); a non-boolean request is refused',()=>{
  const broken={getLoginItemSettings(){throw new Error('E');},setLoginItemSettings(){throw new Error('E');}};const li=createLoginItem({app:broken,packaged:true});
  assert.deepEqual(li.get(),{available:false,on:false,reason:'Windows did not answer. Try again later.'});
  assert.deepEqual(li.set(true),{available:false,on:false,reason:'Windows did not answer. Try again later.',error:'Windows did not accept the change.'});
  assert.throws(()=>createLoginItem({app:fakeWindows(),packaged:true}).set('yes'),/INVALID_REQUEST/);});
test('main.cjs: the fake whenever PORTFOLIO_SMOKE_DATA is set (desktop suite and harness), packaged flag from Electron',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/createLoginItem\(\{app,packaged:app\.isPackaged,fake:process\.env\.PORTFOLIO_SMOKE_DATA\?\{on:false\}:null\}\)/);
  assert.ok(!/setLoginItemSettings/.test(src),'main never calls the API directly');});
