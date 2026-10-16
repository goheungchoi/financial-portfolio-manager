const fs=require('node:fs/promises');const {AiClient}=require('./ai-client.cjs');let ai;let dartKey;let pushURL;
process.parentPort.on('message',async({data})=>{
  try {
    let result;
    if(data.operation==='import') {
      const handle=await fs.open(data.path,'r');let text;
      try{if((await handle.stat()).size>65536)throw 0;text=await handle.readFile('utf8');}finally{await handle.close();}
      const value=JSON.parse(text);if(!value || Object.keys(value).some(key=>!['openaiApiKey','dartApiKey','pushWebhookURL'].includes(key)))throw 0;
      ai=value.openaiApiKey?new AiClient(value.openaiApiKey):null;
      if(value.dartApiKey && !/^[A-Za-z0-9]{20,100}$/.test(value.dartApiKey))throw 0;dartKey=value.dartApiKey??null;
      if(value.pushWebhookURL){const url=new URL(value.pushWebhookURL);if(url.protocol!=='https:'||url.username||url.password)throw 0;pushURL=url.href;}else pushURL=null;
      result={aiConnected:Boolean(ai),dartConnected:Boolean(dartKey),pushConnected:Boolean(pushURL)};
    } else if(data.operation==='decision') {if(!ai)throw 0;result=await ai.decide(data.context,data.options);}
    else if(data.operation==='reflection') {if(!ai)throw 0;result=await ai.reflect(data.context,data.options);}
    else if(data.operation==='push') {
      if(!pushURL)throw 0;
      const response=await fetch(pushURL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({content:data.message.slice(0,1500),text:data.message.slice(0,1500)})});
      if(!response.ok)throw 0;result={delivered:true};
    } else if(data.operation==='disclosures') {
      if(!dartKey)throw 0;
      const date=new Date(Date.now()+9*3600000).toISOString().slice(0,10).replaceAll('-','');
      const response=await fetch('https://opendart.fss.or.kr/api/list.json?'+new URLSearchParams({crtfc_key:dartKey,bgn_de:date,end_de:date,page_count:'100'}),{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw 0;
      const body=await response.json();if(body.status!=='000'&&body.status!=='013')throw 0;
      result=(body.list??[]).slice(0,100).filter(row=>/^\d{14}$/.test(row.rcept_no)).map(row=>({title:String(row.corp_name+' · '+row.report_nm).slice(0,500),symbol:row.stock_code??'',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='+row.rcept_no,published:row.rcept_dt,source:'DART'}));
    } else throw 0;
    process.parentPort.postMessage({id:data.id,ok:true,snapshot:result});
  }catch(error){process.parentPort.postMessage({id:data.id,ok:false,usage:['decision','reflection'].includes(data.operation)?error.usage??null:null,model:['decision','reflection'].includes(data.operation)?error.model??null:null,code:data.operation==='decision'?(require('./ai-errors.cjs').publicCode(error)??'PROVIDER_REQUEST_FAILED'):'PROVIDER_REQUEST_FAILED'});}
});
