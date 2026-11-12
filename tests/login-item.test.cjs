// "Start with Windows" (restart part 1, step 3): the state comes from Windows each time (executableWillLaunchAtLogin, so a
// switch-off in Startup apps reads as off); only the installed app sets it; a development run never calls Windows; test
// runs use an in-memory fake; a failing call is reported, never thrown. No test touches the real login items.
const test=require('node:test');const assert=require('node:assert/strict');const {createLoginItem}=require('../electron/login-item.cjs');
function fakeApp(state={openAtLogin:false,executableWillLaunchAtLogin:false}){const calls=[];return {calls,state,
  getLoginItemSettings(){calls.push(['get']);return {...state};},setLoginItemSettings(s){calls.push(['set',s]);state.openAtLogin=s.openAtLogin;state.executableWillLaunchAtLogin=s.openAtLogin;}};}

test('installed app: reads executableWillLaunchAtLogin, not openAtLogin; setting writes openAtLogin and reads Windows back',()=>{
  const app=fakeApp({openAtLogin:true,executableWillLaunchAtLogin:false});const li=createLoginItem({app,packaged:true});
  assert.deepEqual(li.get(),{available:true,on:false},'switched off in Startup apps: off');
  assert.deepEqual(li.set(true),{available:true,on:true});assert.deepEqual(app.calls.find(c=>c[0]==='set'),['set',{openAtLogin:true}]);
  assert.deepEqual(li.set(false),{available:true,on:false});assert.deepEqual(app.calls.filter(c=>c[0]==='set').at(-1),['set',{openAtLogin:false}]);
});
test('a development run (not packaged): not available, and Windows is never called',()=>{
  const app=fakeApp();const li=createLoginItem({app,packaged:false});
  assert.deepEqual(li.get(),{available:false,on:false,reason:'Available in the installed app.'});assert.deepEqual(li.set(true),{available:false,on:false,reason:'Available in the installed app.'});
  assert.deepEqual(app.calls,[],'no call reached the login-item API');
});
test('test runs use the in-memory fake: the real API is never called',()=>{
  const app=fakeApp();const li=createLoginItem({app,packaged:true,fake:{on:false}});
  assert.deepEqual(li.get(),{available:true,on:false,test:true});assert.deepEqual(li.set(true),{available:true,on:true,test:true});assert.deepEqual(app.calls,[]);
});
test('Windows failing: reported, never thrown; a non-boolean request is refused',()=>{
  const broken={getLoginItemSettings(){throw new Error('E');},setLoginItemSettings(){throw new Error('E');}};const li=createLoginItem({app:broken,packaged:true});
  assert.deepEqual(li.get(),{available:false,on:false,reason:'Windows did not answer. Try again later.'});
  assert.deepEqual(li.set(true),{available:false,on:false,reason:'Windows did not answer. Try again later.',error:'Windows did not accept the change.'});
  assert.throws(()=>createLoginItem({app:fakeApp(),packaged:true}).set('yes'),/INVALID_REQUEST/);
});
test('main.cjs: the fake whenever PORTFOLIO_SMOKE_DATA is set (desktop suite and harness), packaged flag from Electron',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/createLoginItem\(\{app,packaged:app\.isPackaged,fake:process\.env\.PORTFOLIO_SMOKE_DATA\?\{on:false\}:null\}\)/);
  assert.ok(!/setLoginItemSettings/.test(src),'main never calls the API directly');
});
