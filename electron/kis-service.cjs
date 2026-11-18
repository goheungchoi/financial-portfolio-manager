const {utilityProcess}=require('electron');
const path=require('node:path');
class KisService {
  constructor(workerScript='kis-worker.cjs') {this.workerScript=workerScript;this.pending=new Map();this.counter=0;this.queue=Promise.resolve();this.generation=0;this.line=[];this.holding=null;this.als=new (require('node:async_hooks').AsyncLocalStorage)();}
  ensureWorker() {
    if(this.worker)return;
    const worker=utilityProcess.fork(path.join(__dirname,this.workerScript),[],{stdio:'pipe',serviceName:({'kis-worker.cjs':'KIS broker','calendar-worker.cjs':'KIS market calendar'})[this.workerScript]??'Private provider broker'});
    this.worker=worker;
    // Discard worker stdout/stderr; raw broker data/errors never enter console logs.
    worker.stdout?.resume();worker.stderr?.resume();
    worker.on('message',message=>{
      if(this.worker!==worker)return;
      if(message.type==='quote'){this.onQuote?.(message.quote);return;}
      if(message.type==='stream'){this.onStatus?.(message.state);return;}
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      if(message.ok)pending.resolve(message.snapshot);else {const error=new Error(message.code);if(this.workerScript==='provider-worker.cjs'){error.usage=message.usage??null;error.model=message.model??null;if(Number.isInteger(message.responseChars))error.responseChars=message.responseChars;if(message.detail)error.detail=message.detail;
        // A refused request's local record, its measured request sizes and stop reason (Claude refused-request design), checked again.
        {const P=require('./provider-error-reply.cjs').providerError(message.providerError);if(P)error.providerError=P;}if(message.requestSizes&&typeof message.requestSizes==='object')error.requestSizes=message.requestSizes;if(typeof message.stopReason==='string')error.stopReason=message.stopReason.slice(0,30);if(message.formFallback===true)error.formFallback=true;if(['enforced','text'].includes(message.answerForm))error.answerForm=message.answerForm;}if(Number.isFinite(message.retryAt)){this.cooldownUntil=message.retryAt;error.retryAt=message.retryAt;}if(Number.isFinite(message.ticketAgeMs))error.ticketAgeMs=message.ticketAgeMs;if(Number.isInteger(message.httpStatus)&&message.httpStatus>=100&&message.httpStatus<=599)error.httpStatus=message.httpStatus;if(/^[A-Z0-9_-]{1,24}$/.test(message.brokerCode??''))error.brokerCode=message.brokerCode;pending.reject(error);}
    });
    worker.on('exit',()=>{if(this.worker===worker){this.worker=null;this.rejectPending();this.onStatus?.({status:'unavailable',subscribed:0});}});
  }
  rejectPending() {for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('BROKER_UNAVAILABLE'));}this.pending.clear();}
  // B(1), 2026-11-19 overnight failures: every failed request leaves a record (operation, the app's code, KIS's own code,
  // how long it waited in line and ran, whether a disconnect or the rate-limit cooldown refused it before sending). No
  // payload and no account data. The last 200 are kept here; onFailure (main) stores them.
  noteFailure(operation,error,{enqueuedAt,startedAt,generation}){try{const now=Date.now();const code=/^[A-Z][A-Z0-9_]{2,63}$/.test(error?.message??'')?error.message:'UNKNOWN';
      const record={at:now,operation:String(operation).slice(0,40),code,...(/^[A-Z0-9_-]{1,24}$/.test(error?.brokerCode??'')?{brokerCode:error.brokerCode}:{}),
        waitedMs:Number.isFinite(startedAt)?startedAt-enqueuedAt:now-enqueuedAt,ranMs:Number.isFinite(startedAt)?now-startedAt:null,
        notSent:startedAt==null||error?.notSent===true,...(generation!==this.generation?{disconnected:true}:{}),...(code==='RATE_LIMITED'&&error?.notSent===true?{cooldown:true}:{})};
      (this.failures??=[]).push(record);if(this.failures.length>200)this.failures.splice(0,this.failures.length-200);this.onFailure?.(record);}catch{}}
  request(operation,payload) {
    this.queued=(this.queued??0)+1;
    const generation=this.generation;const entry={operation:String(operation)};const times={enqueuedAt:Date.now(),startedAt:null,generation};
    const result=this.enqueue(operation,payload,generation,entry,times);result.catch(error=>this.noteFailure(operation,error,times));return result;}
  enqueue(operation,payload,generation,entry,times){
    const run=()=>{if(generation!==this.generation)throw new Error('BROKER_UNAVAILABLE');if(Date.now()<(this.cooldownUntil??0)){const error=new Error('RATE_LIMITED');error.retryAt=this.cooldownUntil;error.notSent=true;throw error;}times.startedAt=Date.now();return this.send(operation,payload);};
    // F3: a request made by the order that holds the queue goes straight to the worker; every other request waits in line.
    if(this.ownsHold()){const result=Promise.resolve().then(run);return result.finally(()=>{this.queued--;});}
    this.line.push(entry);
    const result=this.queue.then(run);
    this.queue=result.catch(()=>{});return result.finally(()=>{this.queued--;const i=this.line.indexOf(entry);if(i>=0)this.line.splice(i,1);});
  }
  get isBusy(){return (this.queued??0)>0;}
  // F6 (2026-11-18 order not sent): what a request made now would wait behind: the requests in line, by operation name only
  // (the one running first). Inside the order's own hold nothing is ahead of its requests.
  ahead(){if(this.ownsHold())return {length:0,operations:[]};const operations=[...this.line.map(e=>e.operation),...(this.holding?['hold: '+this.holding.label]:[])];return {length:operations.length,operations:operations.slice(0,20)};}
  ownsHold(){const lease=this.als.getStore();return Boolean(lease&&!lease.done&&this.holding===lease);}
  // F3 (2026-11-18 order not sent): an order send holds the queue from its broker check to its placement, so nothing queued
  // meanwhile runs between the two. The hold is taken in turn, after the requests already in line; requests made inside fn
  // (the order's own) go straight to the worker; every other request waits until fn ends. After limitMs the hold is
  // released anyway (onHoldLimit is told), so nothing waits on it for longer; the order's later requests then wait in line.
  hold(fn,{label='order',limitMs=30000}={}){
    let release;const released=new Promise(resolve=>{release=resolve;});
    const turn=this.queue;this.queue=turn.then(()=>released);this.queued=(this.queued??0)+1;
    const lease={label:String(label).slice(0,80),done:false,asked:Date.now()};this.line.push({operation:'hold: '+lease.label,lease});
    const end=byLimit=>{if(lease.done)return;lease.done=true;lease.releasedByLimit=byLimit;if(this.holding===lease)this.holding=null;this.queued--;release();if(byLimit)try{this.onHoldLimit?.({label:lease.label,heldMs:Date.now()-lease.startedAt,limitMs});}catch{}};
    return turn.then(async()=>{const i=this.line.findIndex(e=>e.lease===lease);if(i>=0)this.line.splice(i,1);lease.startedAt=Date.now();this.holding=lease;
      const timer=setTimeout(()=>end(true),limitMs);timer.unref?.();
      try{return await this.als.run(lease,()=>fn({waitedMs:lease.startedAt-lease.asked,released:()=>lease.releasedByLimit===true}));}finally{clearTimeout(timer);end(false);}});
  }
  send(operation,payload) {
    this.ensureWorker();
    return new Promise((resolve,reject)=>{
      const id=++this.counter;
      const timer=setTimeout(()=>{this.disconnect();reject(new Error('REQUEST_FAILED'));},this.workerScript==='provider-worker.cjs'?require('./ai-router.cjs').workerCapMs(operation,payload):90000);
      this.pending.set(id,{resolve,reject,timer});
      this.worker.postMessage({id,operation,...(typeof payload==='string'?{path:payload}:payload??{})});
    });
  }
  disconnect() {this.generation++;this.queue=Promise.resolve();this.line=[];this.worker?.kill();this.worker=null;this.rejectPending();}
}
module.exports={KisService};
