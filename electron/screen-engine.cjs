'use strict';
// The main process's side of the screening engine (S3 review, item 3). It sends one pass at a time to the engine's own
// process (screen-worker.cjs) and awaits the reply, so the main process only posts and receives messages. A pass that
// does not answer within its time is ended: the process is closed and started again for the next pass, and the
// script's answer is a code with the app's own words. spawn() returns {postMessage, on('message'|'exit'), kill()}.
const TIMEOUT_MS=10000;
class ScreenEngine{
  constructor({spawn,timeoutMs=TIMEOUT_MS}){this.spawn=spawn;this.timeoutMs=timeoutMs;this.child=null;this.pending=new Map();this.next=1;this.queue=Promise.resolve();}
  start(){if(this.child)return this.child;const child=this.spawn();this.child=child;
    child.on('message',m=>{const p=this.pending.get(m?.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);if(m.ok)p.resolve(m.value);else p.reject(Object.assign(new Error(m.code??'SCREEN_ENGINE_FAILED'),{code:m.code??'SCREEN_ENGINE_FAILED'}));});
    // A process that ends fails only its own passes, never those sent to the one that replaced it.
    child.on('exit',()=>{if(this.child===child)this.child=null;for(const [id,p] of this.pending){if(p.child!==child)continue;clearTimeout(p.timer);p.reject(Object.assign(new Error('SCREEN_ENGINE_FAILED'),{code:'SCREEN_ENGINE_FAILED'}));this.pending.delete(id);}});
    return child;}
  // One pass at a time, in order.
  exec(kind,payload,env){const job=this.queue.then(()=>this.send(kind,payload,env));this.queue=job.catch(()=>{});return job;}
  send(kind,payload,env){return new Promise((resolve,reject)=>{let child;try{child=this.start();}catch{reject(Object.assign(new Error('SCREEN_ENGINE_FAILED'),{code:'SCREEN_ENGINE_FAILED'}));return;}
    const id=this.next++;const timer=setTimeout(()=>{this.pending.delete(id);try{child.kill();}catch{}if(this.child===child)this.child=null;reject(Object.assign(new Error('SCREEN_ENGINE_TIMEOUT'),{code:'SCREEN_ENGINE_TIMEOUT'}));},this.timeoutMs);
    timer.unref?.();this.pending.set(id,{resolve,reject,timer,child});try{child.postMessage({id,kind,...payload,env});}catch{clearTimeout(timer);this.pending.delete(id);reject(Object.assign(new Error('SCREEN_ENGINE_FAILED'),{code:'SCREEN_ENGINE_FAILED'}));}});}
  close(){try{this.child?.kill();}catch{}this.child=null;}
}
// A worker thread standing in for the utility process (tests; the same messages and replies).
function threadSpawn(file=require('node:path').join(__dirname,'screen-worker.cjs')){return ()=>{const {Worker}=require('node:worker_threads');const w=new Worker(file);
  return {postMessage:m=>w.postMessage(m),on:(event,fn)=>w.on(event,fn),kill:()=>{void w.terminate();}};};}
module.exports={ScreenEngine,threadSpawn,TIMEOUT_MS};
