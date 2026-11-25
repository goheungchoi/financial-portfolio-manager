// Phone control (1.6.0), stage P2: the main process's side of the phone worker (artifacts/reviews/2026-11-25-phone-control).
// It starts the worker, restarts it after a crash with growing waits, checks every message the worker sends (its type,
// its size, its fields) before using any of it, at most 30 a minute, and passes interactions to the command core
// (phone-core.cjs). The PIN in a form submit goes to the core and nowhere else. No bot token or interaction token ever
// arrives here: the worker refers to an interaction by a local ref. The commands themselves are carried out by the
// executor, wired to the desktop's own functions in stages P3 to P5; until then every command answers that it is not
// active yet.
const {KEYS}=require('./phone-worker.cjs');
const MSG_MAX=8192,MSG_PER_MIN=30,STATE_PER_MIN=60,RESTART_FIRST=5000,RESTART_MAX=300000,STABLE_MS=600000;
const STATES=new Set(['bad-gateway-url','not-set-up','connecting','ready','waiting','refused','stopped','commands-registered','commands-refused','reply-refused']);
const NOT_YET='Phone control is being built: this command is not active yet.';
const REF=/^[a-f0-9]{24}$/;
class PhoneService{
  // spawn() returns the worker: {postMessage(m), on('message', fn), on('exit', fn), kill()}. executor: {summary(), run(act)}.
  constructor({core,spawn,executor=null,onState=()=>{},clock=Date.now,setTimeout:st=setTimeout,clearTimeout:ct=clearTimeout}){
    Object.assign(this,{core,spawn,onState,clock,st,ct});this.executor=executor??{summary:async()=>({ok:false,text:NOT_YET}),run:async()=>NOT_YET};
    this.worker=null;this.stopping=false;this.wait=RESTART_FIRST;this.recent=[];this.recentStates=[];this.restartTimer=null;this.status={state:'stopped',lastCommandAt:null,dropped:0};}
  start(providerPath,statePath){this.stopping=false;this.paths={providerPath,statePath};this.launch();}
  stop(){this.stopping=true;this.ct(this.restartTimer);const w=this.worker;this.worker=null;try{w?.postMessage({op:'stop'});w?.kill();}catch{}this.setStatus({state:'stopped'});}
  launch(){if(this.stopping)return;let w;try{w=this.spawn();}catch{this.restartLater();return;}this.worker=w;this.startedAt=this.clock();
    w.on('message',m=>{if(this.worker===w)void this.handle(m?.data??m);});
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
      this.setStatus({state:m.state,...(Number.isInteger(m.code)?{code:m.code}:{code:null}),...(Number.isFinite(m.waitMs)?{waitMs:m.waitMs}:{}),...(Number.isInteger(m.status)?{httpStatus:m.status}:{}),
        ...(m.state==='not-set-up'?{missing:names(m.missing),invalid:names(m.invalid)}:{})});return;}
    if(m.type!=='interaction'||typeof m.ref!=='string'||!REF.test(m.ref)||!m.data||typeof m.data!=='object'||Array.isArray(m.data))return;
    const ref=m.ref,data=m.data;this.recent=this.recent.filter(t=>now-t<60000);
    if(this.recent.length>=MSG_PER_MIN){data.pin=undefined;this.status.dropped++;this.send({ref,kind:'message',text:require('./phone-core.cjs').SENTENCES.busy});return;}this.recent.push(now);let r;try{r=this.core.accept(data);}catch{r={reply:'The app could not handle this command.'};}finally{data.pin=undefined;}
    try{if(r.silent){this.send({ref,kind:'drop'});return;}
      if(r.reply){this.send({ref,kind:'message',text:r.reply});return;}
      const act=r.act;this.setStatus({lastCommandAt:now});
      if(act.step==='ask-pin'){this.send({ref,kind:'modal',nonce:act.nonce});return;}
      if(act.step==='summary'){const s=await this.executor.summary(act);if(s?.ok&&s.held){this.core.attach(act.nonce,s.held);this.send({ref,kind:'summary',text:String(s.text??''),nonce:act.nonce});}else this.send({ref,kind:'message',text:String(s?.text??NOT_YET)});return;}
      this.send({ref,kind:'message',text:String(await this.executor.run(act)??NOT_YET)});}
    catch{this.send({ref,kind:'message',text:'The app could not carry out this command.'});}}
}
module.exports={STATE_PER_MIN,PhoneService,MSG_MAX,MSG_PER_MIN,RESTART_FIRST,RESTART_MAX,STABLE_MS,NOT_YET};
