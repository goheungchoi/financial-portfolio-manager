const fs=require('node:fs/promises');const {AiClient}=require('./ai-client.cjs');const R=require('./ai-router.cjs');
// router: which client serves each AI call, chosen by the call's model id (ai-router.cjs). Built at import.
let router=R.createRouter();let dartKey;let pushURL;let ecosKey=null;let fredKey=null;const dartState={};let secContact=null;const secState={};const EMAIL=/^[^\s@<>()"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
process.parentPort.on('message',async({data})=>{
  try {
    let result;
    if(data.operation==='import') {
      const handle=await fs.open(data.path,'r');let text;
      try{if((await handle.stat()).size>65536)throw 0;text=await handle.readFile('utf8');}finally{await handle.close();}
      // The whole file is checked first (ai-router.cjs parseProviderFile): any problem rejects it and nothing is applied.
      // SEC EDGAR asks every client to identify itself with a contact email; it is sent only to sec.gov.
      const value=R.parseProviderFile(text);ecosKey=value.ecosApiKey;fredKey=value.fredApiKey;secContact=value.secContactEmail;dartKey=value.dartApiKey;pushURL=value.pushURL;
      router=R.createRouter({openai:value.openaiApiKey?new AiClient(value.openaiApiKey):null,anthropic:value.anthropicApiKey?R.claudeClient(value.anthropicApiKey):null});
      result={...router.flags(),dartConnected:Boolean(dartKey),pushConnected:Boolean(pushURL),ecosConnected:Boolean(ecosKey),fredConnected:Boolean(fredKey),secConnected:Boolean(secContact)};
    } else if(data.operation==='test-key') {result=await router.testKey(data.vendor);
    } else if(data.operation==='decision') {result=await router.clientFor(data.options?.openaiModel).decide(data.context,data.options);}
    else if(data.operation==='reflection') {result=await router.clientFor(data.options?.openaiModel).reflect(data.context,data.options);}
    else if(data.operation==='scout') {result=await router.clientFor(data.options?.openaiModel).scout(data.context,data.options);}
    else if(data.operation==='narrative') {result=await router.clientFor(data.options?.openaiModel).narrative(data.context,data.options);}
    else if(data.operation==='compact') {result=await router.clientFor(data.options?.openaiModel).compact(data.payload,data.options);}
    else if(data.operation==='push') {
      if(!pushURL)throw 0;
      const {body,headers}=require('./phone-snapshot.cjs').pushRequest(pushURL,data);
      const response=await fetch(pushURL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),...(headers?{headers}:{}),body});
      if(!response.ok)throw 0;result={delivered:true};
    } else if(data.operation==='macro') {
      // Works without keys (FRED downloads, ECOS sample access); keys add full ECOS access and the FRED release calendar.
      result=await require('./macro.cjs').fetchMacro(fetch,{ecosKey,fredKey});
    } else if(data.operation==='fx-rates') {
      if(!Array.isArray(data.days))throw 0;result=await require('./macro.cjs').fetchUsdKrw(fetch,ecosKey,data.days.filter(day=>typeof day==='string'));
    } else if(['sec-company','sec-filings','sec-earnings','sec-about'].includes(data.operation)) {
      // The contact saved in the app wins over the providers file; either way it is sent only to sec.gov.
      const contact=typeof data.contact==='string'&&EMAIL.test(data.contact)?data.contact:secContact;
      if(!contact)throw 0;result=await require('./sec.cjs')[({'sec-company':'secCompany','sec-filings':'secFilings','sec-earnings':'secEarningsRelease','sec-about':'secAbout'})[data.operation]](fetch,contact,String(data.symbol??''),new Date(Date.now()+9*3600000).toISOString().slice(0,10),secState);
    } else if(data.operation==='dart-company'||data.operation==='dart-about') {
      if(!dartKey)throw 0;result=await require('./dart.cjs')[data.operation==='dart-about'?'companyAbout':'companyFilings'](fetch,dartKey,String(data.symbol??''),new Date(Date.now()+9*3600000).toISOString().slice(0,10),dartState);
    } else if(data.operation==='disclosures') {
      if(!dartKey)throw 0;
      const date=new Date(Date.now()+9*3600000).toISOString().slice(0,10).replaceAll('-','');
      const seen=new Set(Array.isArray(data.seen)?data.seen.filter(receipt=>typeof receipt==='string'&&/^\d{14}$/.test(receipt)).slice(0,1000):[]);const rows=[];
      // Page through today's list until a page contains an already-stored receipt (at most 5 pages of 100). Receipt numbers are not chronological across filers.
      for(let page=1;page<=5;page++){const response=await fetch('https://opendart.fss.or.kr/api/list.json?'+new URLSearchParams({crtfc_key:dartKey,bgn_de:date,end_de:date,page_no:String(page),page_count:'100'}),{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw 0;
        const body=await response.json();if(body.status!=='000'&&body.status!=='013')throw 0;const list=Array.isArray(body.list)?body.list:[];rows.push(...list);if(!list.length||page>=Number(body.total_page??1)||list.some(row=>seen.has(String(row.rcept_no))))break;}
      result=rows.slice(0,500).filter(row=>/^\d{14}$/.test(row.rcept_no)).map(row=>({title:(String(row.corp_name??'').trim()+' · '+String(row.report_nm??'').trim()).slice(0,500),symbol:row.stock_code??'',url:'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='+row.rcept_no,published:row.rcept_dt,source:'DART'}));
    } else throw 0;
    process.parentPort.postMessage({id:data.id,ok:true,snapshot:result});
  }catch(error){process.parentPort.postMessage({id:data.id,...require('./provider-error-reply.cjs').errorReply(data.operation,error)});}
});
