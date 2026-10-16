const {utilityProcess}=require('electron');
const path=require('node:path');
class KisService {
  constructor(workerScript='kis-worker.cjs') {this.workerScript=workerScript;this.pending=new Map();this.counter=0;this.queue=Promise.resolve();this.generation=0;}
  ensureWorker() {
    if(this.worker)return;
    const worker=utilityProcess.fork(path.join(__dirname,this.workerScript),[],{stdio:'pipe',serviceName:this.workerScript==='kis-worker.cjs'?'KIS broker':'Private provider broker'});
    this.worker=worker;
    // Discard worker stdout/stderr; raw broker data/errors never enter console logs.
    worker.stdout?.resume();worker.stderr?.resume();
    worker.on('message',message=>{
      if(this.worker!==worker)return;
      if(message.type==='quote'){this.onQuote?.(message.quote);return;}
      if(message.type==='stream'){this.onStatus?.(message.state);return;}
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      if(message.ok)pending.resolve(message.snapshot);else {const error=new Error(message.code);if(this.workerScript==='provider-worker.cjs'){error.usage=message.usage??null;error.model=message.model??null;}if(Number.isFinite(message.retryAt)){this.cooldownUntil=message.retryAt;error.retryAt=message.retryAt;}if(Number.isInteger(message.httpStatus)&&message.httpStatus>=100&&message.httpStatus<=599)error.httpStatus=message.httpStatus;if(/^[A-Z0-9_-]{1,24}$/.test(message.brokerCode??''))error.brokerCode=message.brokerCode;pending.reject(error);}
    });
    worker.on('exit',()=>{if(this.worker===worker){this.worker=null;this.rejectPending();this.onStatus?.({status:'unavailable',subscribed:0});}});
  }
  rejectPending() {for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('BROKER_UNAVAILABLE'));}this.pending.clear();}
  request(operation,payload) {
    this.queued=(this.queued??0)+1;
    const generation=this.generation;
    const result=this.queue.then(()=>{if(generation!==this.generation)throw new Error('BROKER_UNAVAILABLE');if(Date.now()<(this.cooldownUntil??0)){const error=new Error('RATE_LIMITED');error.retryAt=this.cooldownUntil;throw error;}return this.send(operation,payload);});
    this.queue=result.catch(()=>{});return result.finally(()=>{this.queued--;});
  }
  get isBusy(){return (this.queued??0)>0;}
  send(operation,payload) {
    this.ensureWorker();
    return new Promise((resolve,reject)=>{
      const id=++this.counter;
      const timer=setTimeout(()=>{this.disconnect();reject(new Error('REQUEST_FAILED'));},90000);
      this.pending.set(id,{resolve,reject,timer});
      this.worker.postMessage({id,operation,...(typeof payload==='string'?{path:payload}:payload??{})});
    });
  }
  disconnect() {this.generation++;this.queue=Promise.resolve();this.worker?.kill();this.worker=null;this.rejectPending();}
}
module.exports={KisService};
