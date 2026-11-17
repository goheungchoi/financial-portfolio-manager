'use strict';
// "Start with Windows" (restart part 1, step 3; artifacts/reviews/2026-11-12-restart). The state is read from Windows
// every time, never from a saved copy, so it cannot disagree with Windows. Only the installed app may set it: a
// development run would register the bare Electron program. Test runs (PORTFOLIO_SMOKE_DATA) use an in-memory fake, so
// no test ever changes the machine's real login items. The app never changes Windows' update, sign-in or active-hours
// settings.
//
// 2026-11-17 (artifacts/reviews/2026-11-17-start-with-windows/cause-note.md): Electron 44's getLoginItemSettings() with no
// path parses this exe's own path unquoted (browser_win.cc, GetLoginItemSettingsHelper -> CommandLine::FromString ->
// CommandLineToArgvW), so an install path with a space is cut at the first space and no Run value ever matches:
// executableWillLaunchAtLogin was always false for the installed app. The path is now passed quoted, which parses whole
// whatever its shape; Electron then lists this exe's Run values (launchItems) and checks each one's StartupApproved entry.
const UNAVAILABLE='Windows did not answer. Try again later.';
const quoted=path=>'"'+String(path).replace(/^"+|"+$/g,'')+'"';
// The row's state from one getLoginItemSettings answer. On exactly when Windows will launch this exe at sign-in (some
// Run value for it, for this user or the machine, is not switched off in Startup apps).
function stateOf(settings){
  if(!settings||typeof settings.executableWillLaunchAtLogin!=='boolean')return {available:false,on:false,reason:UNAVAILABLE};
  const items=Array.isArray(settings.launchItems)?settings.launchItems:[],on=settings.executableWillLaunchAtLogin;
  if(on&&items.some(i=>i?.scope==='machine'&&i.enabled!==false))return {available:true,on,note:'Set for all users of this PC; turn it off in Windows Startup apps.'};
  if(!on&&items.some(i=>i?.enabled===false))return {available:true,on,note:'Turned off in Windows Startup apps.'};
  return {available:true,on};
}
/**
 * @param {{app:{getLoginItemSettings:Function,setLoginItemSettings:Function},packaged:boolean,fake?:{on:boolean}|null,execPath?:string}} input
 */
function createLoginItem({app,packaged,fake=null,execPath=process.execPath}){
  const read=()=>app.getLoginItemSettings({path:quoted(execPath)});
  const get=()=>{
    if(fake)return {available:true,on:Boolean(fake.on),test:true};
    if(!packaged)return {available:false,on:false,reason:'Available in the installed app.'};
    try{return stateOf(read());}catch{return {available:false,on:false,reason:UNAVAILABLE};}
  };
  // Every Run value for this exe in this user's key, whatever its name (an earlier version may have used another);
  // machine values need admin rights and are left alone.
  const userItems=()=>{const s=read();return (Array.isArray(s?.launchItems)?s.launchItems:[]).filter(i=>i?.scope==='user'&&typeof i.name==='string'&&i.name);};
  const set=on=>{
    if(typeof on!=='boolean')throw new Error('INVALID_REQUEST');
    if(fake){fake.on=on;return get();}
    if(!packaged)return get();
    try{
      // Off: the value under the app's own name (Electron's default), then any left under another name. On: every
      // existing value first, so exactly one is left, then the app's own, approved in Startup apps (enabled defaults to
      // true, which clears a switch-off there).
      if(!on)app.setLoginItemSettings({openAtLogin:false});
      for(const item of userItems())app.setLoginItemSettings({openAtLogin:false,name:item.name});
      if(on)app.setLoginItemSettings({openAtLogin:true});
    }catch{return {...get(),error:'Windows did not accept the change.'};}
    return get();
  };
  return {get,set};
}
module.exports={createLoginItem,stateOf,quoted};
