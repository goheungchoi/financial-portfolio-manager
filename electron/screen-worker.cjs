'use strict';
// The screening engine's own process (S3 review, item 3): a model's script never runs on the Electron main process.
// Each message runs one pass of one script (screen-run planStep or finalStep) against a read-only connection to the
// app's database (WAL, so the main process writes on while this reads), with the lists, settings, calendar and time the
// main process sends. Started by main.cjs through utilityProcess (like kis-worker.cjs); tests start it as a worker
// thread. Replies carry the result or a code, never a message or a stack.
const port=process.parentPort??require('node:worker_threads').parentPort;
const {DatabaseSync}=require('node:sqlite');
let db=null,dbPath=null;
const open=path=>{if(!db||dbPath!==path){try{db?.close();}catch{}db=new DatabaseSync(path,{readOnly:true,timeout:3000});dbPath=path;}return db;};
function handle(msg){
  const {HistoryStore}=require('./history-store.cjs');const {UsSizeOrder}=require('./us-size.cjs');const U=require('./screen-universe.cjs');const R=require('./screen-run.cjs');
  const env=msg.env??{};const d=open(env.dbPath);const now=Number.isFinite(env.now)?env.now:Date.now();
  const deps={db:d,store:new HistoryStore(d,{readOnly:true}),usSize:new UsSizeOrder(d,()=>now,{readOnly:true}),own:k=>Array.isArray(env.own?.[k])?env.own[k]:[],
    settings:()=>env.settings??{perExchange:300,etfs:true},closedDays:()=>new Set(Array.isArray(env.closedDays)?env.closedDays:[]),clock:()=>now};
  const c=U.screenContext(deps);
  if(msg.kind==='plan')return R.planStep(msg.text,c.ctx);
  return {...R.finalStep(msg.text,c.ctx,{quotes:msg.quotes,why:msg.why}),asOf:c.asOf,missing:c.missingList()};}
port.on('message',event=>{const msg=event&&typeof event==='object'&&'data' in event&&event.data&&typeof event.data==='object'&&'id' in event.data?event.data:event;
  let reply;try{reply={id:msg.id,ok:true,value:handle(msg)};}catch(error){reply={id:msg?.id??null,ok:false,code:/^[A-Z_]{3,40}$/.test(String(error?.code??''))?error.code:'SCREEN_ENGINE_FAILED'};}
  port.postMessage(reply);});
