// Phone control (1.6.0), stage P2: the main process's side of the phone worker (artifacts/reviews/2026-11-25-phone-control).
// It starts the worker, restarts it after a crash with growing waits, checks every message the worker sends (its type,
// its size, its fields) before using any of it, at most 30 a minute, and passes interactions to the command core
// (phone-core.cjs). The PIN in a form submit goes to the core and nowhere else. No bot token or interaction token ever
// arrives here: the worker refers to an interaction by a local ref. The commands themselves are carried out by the
// executor, wired to the desktop's own functions in stages P3 to P5; until then every command answers that it is not
// active yet.
const {KEYS}=require('./phone-worker.cjs');
const MSG_MAX=8192,MSG_PER_MIN=30,STATE_PER_MIN=60,RESTART_FIRST=5000,RESTART_MAX=300000,STABLE_MS=600000;
const STATES=new Set(['keys-ok','bad-gateway-url','not-set-up','connecting','ready','waiting','refused','stopped','commands-registered','commands-refused','reply-refused']);
const NOT_YET='Phone control is being built: this command is not active yet.';
const REF=/^[a-f0-9]{24}$/;
const COMMAND_NAMES=require('./phone-core.cjs').COMMANDS;
const ALERTS=Object.freeze({link:'A lost order reply was linked to its KIS order from the phone.',nottaken:'A lost order was counted as not sent from the phone.',start:'Auto trading started from the phone.',stop:'Auto trading stopped from the phone.',stopall:'Everything stopped from the phone.'});
class PhoneService{
  // spawn() returns the worker: {postMessage(m), on('message', fn), on('exit', fn), kill()}. executor: {summary(), run(act)}.
  // core: the command core, or makeCore(allow) to build it from the ids the worker read (P3: the app builds it so).
  // log(title, body): one Activity line per command (P3): the command and its outcome in fixed words or the desktop
  // function's own sentence; refusals that get no answer at most once a minute. Never a PIN, a token, an id or anything
  // typed.
  // inactive: commands that answer "not active yet" at once (no PIN form, no PIN counted) until their stage. notify(text):
  // one alert, through the app's own alert path, for a command that changed the app's state (Stop, Stop everything).
  constructor({core=null,makeCore=null,spawn,executor=null,log=()=>{},notify=()=>{},onPinChange=()=>{},inactive=new Set(),onState=()=>{},clock=Date.now,setTimeout:st=setTimeout,clearTimeout:ct=clearTimeout}){
    Object.assign(this,{core,makeCore,spawn,log,notify,onPinChange,inactive,onState,clock,st,ct});this.silentLoggedAt=0;this.executor=executor??{summary:async()=>({ok:false,text:NOT_YET}),run:async()=>NOT_YET};
    this.worker=null;this.stopping=false;this.wait=RESTART_FIRST;this.recent=[];this.recentStates=[];this.restartTimer=null;this.status={state:'stopped',lastCommandAt:null,dropped:0};}
  start(providerPath,statePath){this.stopping=false;this.paths={providerPath,statePath};this.launch();}
  stop(){this.stopping=true;this.ct(this.restartTimer);const w=this.worker;this.worker=null;try{w?.postMessage({op:'stop'});w?.kill();}catch{}this.setStatus({state:'stopped'});}
  launch(){if(this.stopping)return;let w;try{w=this.spawn();}catch{this.restartLater();return;}this.worker=w;this.startedAt=this.clock();
    // Electron's utilityProcess child 'message' event gives the message itself (kis-service.cjs relies on the same).
    // Each launch starts with no core: a command before this launch's keys-ok is ignored, and a launch that never reports
    // its keys accepts nothing (P3 follow-up D).
    if(this.makeCore)this.core=null;this.keysAccepted=false;this.otherIdsSaid=false;w.on('message',m=>{if(this.worker===w)void this.handle(m);});
    w.on('exit',()=>{if(this.worker!==w)return;this.worker=null;if(this.stopping)return;if(this.clock()-this.startedAt>=STABLE_MS)this.wait=RESTART_FIRST;this.setStatus({state:'worker-restarting',waitMs:this.wait});this.restartLater();});
    w.postMessage({op:'start',providerPath:this.paths.providerPath,statePath:this.paths.statePath});}
  // A worker that keeps failing is restarted after 5 s, doubling to 5 minutes; a run of 10 minutes resets the wait.
  restartLater(){const wait=this.wait;this.wait=Math.min(RESTART_MAX,this.wait*2);this.ct(this.restartTimer);this.restartTimer=this.st(()=>this.launch(),wait);}
  setStatus(patch){this.status={...this.status,...patch};try{this.onState({...this.status});}catch{}}
  send(m){try{this.worker?.postMessage({op:'reply',...m});}catch{}}
  // Every message from the worker is checked before anything in it is used.
  // Interactions and state messages are counted apart (P2 review, change 3), so a chatty worker cannot starve commands; an
  // interaction over its limit is answered with the core's busy sentence, not left as Discord's "thinking".
  async handle(m){const now=this.clock();
    let size=0;try{size=JSON.stringify(m)?.length??0;}catch{return;}if(!m||typeof m!=='object'||Array.isArray(m)||size>MSG_MAX)return;
    if(m.type==='state'){this.recentStates=this.recentStates.filter(t=>now-t<60000);if(this.recentStates.length>=STATE_PER_MIN){this.status.dropped++;return;}this.recentStates.push(now);if(!STATES.has(m.state))return;const names=v=>Array.isArray(v)?v.filter(k=>KEYS.includes(k)):[];
      if(m.state==='keys-ok'){const a=m.allow,ok=v=>typeof v==='string'&&/^\d{17,20}$/.test(v);if(!a||!['user','server','channel','application'].every(k=>ok(a[k])))return;
        const ids={user:a.user,server:a.server,channel:a.channel,application:a.application};
        // Who may command is set once per worker launch: a later report, whatever its ids, changes nothing (P3 review, 2).
        if(this.keysAccepted){if(JSON.stringify(ids)!==JSON.stringify(this.acceptedIds)&&!this.otherIdsSaid){this.otherIdsSaid=true;try{this.log('Phone control','Phone control: the worker reported other ids; ignored.');}catch{}}return;}
        this.keysAccepted=true;this.acceptedIds=ids;if(this.makeCore)this.core=this.makeCore(ids);this.setStatus({state:'keys-ok',code:null});return;}
      this.setStatus({state:m.state,...(Number.isInteger(m.code)?{code:m.code}:{code:null}),...(Number.isFinite(m.waitMs)?{waitMs:m.waitMs}:{}),...(Number.isInteger(m.status)?{httpStatus:m.status}:{}),
        ...(m.state==='not-set-up'?{missing:names(m.missing),invalid:names(m.invalid)}:{})});return;}
    if(m.type!=='interaction'||typeof m.ref!=='string'||!REF.test(m.ref)||!m.interaction||typeof m.interaction!=='object'||Array.isArray(m.interaction))return;
    if(!this.core)return;const ref=m.ref,data=m.interaction;this.recent=this.recent.filter(t=>now-t<60000);
    if(this.recent.length>=MSG_PER_MIN){data.pin=undefined;this.status.dropped++;this.send({ref,kind:'message',text:require('./phone-core.cjs').SENTENCES.busy});return;}this.recent.push(now);let r;try{r=this.core.accept(data);}catch{r={reply:'The app could not handle this command.'};}finally{data.pin=undefined;}
    // A PIN form was checked (a wrong entry counted, a lock, or a right one resetting the count): the desktop's view of the
    // PIN is read again at once (P6 review A).
    if(data.type===5)try{this.onPinChange();}catch{}
    const name=data.type===2&&COMMAND_NAMES.includes(data.command)?data.command:data.type===3?'confirm':data.type===5?'pin':'unknown';
    const line=(title,body)=>{try{this.log(title,body);}catch{}};
    try{if(r.silent){this.send({ref,kind:'drop'});if(now-this.silentLoggedAt>=60000){this.silentLoggedAt=now;line('Phone command refused',`A command was not answered (${r.why}). Refusals like this are noted at most once a minute.`);}return;}
      // A command not active yet says so even with no PIN set or the PIN locked (P3 follow-up D).
      if(r.reply&&data.type===2&&this.inactive.has(name)&&(r.why==='noPin'||r.why==='locked')){this.send({ref,kind:'message',text:NOT_YET});line('Phone command · '+name,NOT_YET);return;}
      if(r.reply){this.send({ref,kind:'message',text:r.reply});line('Phone command · '+name,r.reply);return;}
      const act=r.act;this.setStatus({lastCommandAt:now});
      if(this.inactive.has(act.command)){if(act.nonce)this.core.takePending?.(act.nonce);this.send({ref,kind:'message',text:NOT_YET});line('Phone command · '+act.command,NOT_YET);return;}
      if(act.step==='ask-pin'){this.send({ref,kind:'modal',nonce:act.nonce});line('Phone command · '+act.command,'Asked for the PIN.');return;}
      // Every PIN command shows what it would do first (P5 review, 1): Start what it would start, /link and /nottaken the
      // order and what KIS showed; a mistyped or no longer lost order is said here and asks no PIN.
      if(act.step==='summary'){const s=await this.executor.summary(act);if(s?.ok&&s.held){this.core.attach(act.nonce,s.held);this.send({ref,kind:'summary',text:String(s.text??''),nonce:act.nonce});line('Phone command · '+act.command,act.command==='start'?'Showed what Start would start.':'Showed the order to confirm.');}
        else{this.core.takePending?.(act.nonce);const t=String(s?.text??NOT_YET);this.send({ref,kind:'message',text:t});line('Phone command · '+act.command,t);}return;}
      // run() gives a sentence, or {text, changed}: changed only when the desktop function carried the command out.
      const out=await this.executor.run(act);const text=String((out&&typeof out==='object'?out.text:out)??NOT_YET);this.send({ref,kind:'message',text});line('Phone command · '+act.command,act.command==='status'?'Status sent.':act.command==='orders'?'Lost orders listed.':text);
      // The alert only for a command that did change the app's state, never after "Not stopped: …" (P3 follow-up C).
      const alert=ALERTS[act.command];if(alert&&out?.changed===true)try{this.notify(alert,act.command);}catch{}}
    catch{this.send({ref,kind:'message',text:'The app could not carry out this command.'});}}
}
module.exports={ALERTS,STATE_PER_MIN,PhoneService,MSG_MAX,MSG_PER_MIN,RESTART_FIRST,RESTART_MAX,STABLE_MS,NOT_YET};
