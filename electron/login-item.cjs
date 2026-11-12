'use strict';
// "Start with Windows" (restart part 1, step 3; artifacts/reviews/2026-11-12-restart). The state is read from Windows
// every time (getLoginItemSettings().executableWillLaunchAtLogin: the Run entry exists and is not switched off in Startup
// apps), never from a saved copy, so it cannot disagree with Windows. Only the installed app may set it: a development
// run would register the bare Electron program. Test runs (PORTFOLIO_SMOKE_DATA) use an in-memory fake, so no test ever
// changes the machine's real login items. The app never changes Windows' update, sign-in or active-hours settings.

/**
 * @param {{app:{getLoginItemSettings:Function,setLoginItemSettings:Function},packaged:boolean,fake?:{on:boolean}|null}} input
 */
function createLoginItem({app,packaged,fake=null}){
  const get=()=>{
    if(fake)return {available:true,on:Boolean(fake.on),test:true};
    if(!packaged)return {available:false,on:false,reason:'Available in the installed app.'};
    try{const s=app.getLoginItemSettings();return {available:true,on:Boolean(s?.executableWillLaunchAtLogin)};}
    catch{return {available:false,on:false,reason:'Windows did not answer. Try again later.'};}
  };
  const set=on=>{
    if(typeof on!=='boolean')throw new Error('INVALID_REQUEST');
    if(fake){fake.on=on;return get();}
    if(!packaged)return get();
    // openAtLogin writes or removes the HKCU Run entry for this executable; enabled (default) also marks it approved in
    // Startup apps, so turning it on here turns it on there too.
    try{app.setLoginItemSettings({openAtLogin:on});}catch{return {...get(),error:'Windows did not accept the change.'};}
    return get();
  };
  return {get,set};
}
module.exports={createLoginItem};
