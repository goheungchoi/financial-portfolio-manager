// Market calendar worker: holds a live KIS key for one read-only purpose, the official KRX holiday calendar
// (국내휴장일조회, CTCA0903R). It exposes no balances, quotes or orders. Mock keys are refused: KIS offers no calendar
// on mock accounts.
const fs=require('node:fs/promises');
const {KisReadOnlyClient,parseCredentials}=require('./kis-client.cjs');
let client=null;let busy=false;
process.parentPort.on('message',async({data})=>{
  const {id,operation}=data;
  if(busy){process.parentPort.postMessage({id,ok:false,code:'BUSY'});return;}busy=true;
  try{
    let result;
    if(operation==='import'){
      const handle=await fs.open(data.path,'r');let text;
      try{const stat=await handle.stat();if(!stat.isFile()||stat.size>65536)throw new Error();text=await handle.readFile('utf8');}finally{await handle.close();}
      const next=new KisReadOnlyClient(parseCredentials(text));text=null;
      if(next.overseasIdentity().environment!=='live')throw Object.assign(new Error(),{code:'CALENDAR_NEEDS_LIVE_KEY'});
      client=next;result={environment:'live'};
    }else if(operation==='kr-calendar'){
      if(!client)throw Object.assign(new Error(),{code:'CALENDAR_NOT_CONNECTED'});
      if(!/^\d{8}$/.test(String(data.day??'')))throw Object.assign(new Error(),{code:'INVALID_REQUEST'});
      const body=await client.quotation('chk-holiday','CTCA0903R',{BASS_DT:data.day,CTX_AREA_FK:'',CTX_AREA_NK:''});
      const rows=Array.isArray(body.output)?body.output:[body.output];
      result=rows.filter(r=>/^\d{8}$/.test(r?.bass_dt??'')).slice(0,40).map(r=>({day:`${r.bass_dt.slice(0,4)}-${r.bass_dt.slice(4,6)}-${r.bass_dt.slice(6,8)}`,open:r.opnd_yn==='Y',business:r.bzdy_yn==='Y'}));
    }else if(operation==='disconnect'){client=null;result={ok:true};}
    else throw Object.assign(new Error(),{code:'UNKNOWN_OPERATION'});
    process.parentPort.postMessage({id,ok:true,snapshot:result});
  }catch(error){process.parentPort.postMessage({id,ok:false,code:/^[A-Z_]{3,40}$/.test(error?.code??'')?error.code:'CALENDAR_FAILED'});}
  finally{busy=false;}
});
