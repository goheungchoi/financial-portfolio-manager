// A stand-in for screen-worker.cjs in tests: it spends its time computing (busy, on its own thread) before it answers,
// or never answers when told so, so the main side's responsiveness and its timeout can be measured. Made-up replies.
const {parentPort}=require('node:worker_threads');
parentPort.on('message',msg=>{if(msg.text==='never')return;const end=Date.now()+(Number(msg.env?.busyMs)||0);while(Date.now()<end){}
  parentPort.postMessage({id:msg.id,ok:true,value:msg.kind==='plan'?{uses:false,asked:[],assumed:false,planStop:null}:{lines:['done'],coverage:[],asOf:null,missing:[]}});});
