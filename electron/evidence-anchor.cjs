// Shared evidence for a live review and its shadow run (docs/ROUTING-EVALUATION.md). Both models run at the same time;
// a read request either one makes is fetched once and both get the same result, so a difference between their
// decisions comes from reasoning, not from newer data. Requests only one model makes are fetched when it asks, with the
// time recorded. Every tool call is kept in a per-model transcript: read calls point at the stored result, write calls
// keep their arguments and outcome.
const RESULT_LIMIT=64*1024;
const READ_TOOLS=['get_company_research','get_market_overview','screen_market','search_securities','compute'];
const keep=value=>{const text=JSON.stringify(value??null);return text.length>RESULT_LIMIT?text.slice(0,RESULT_LIMIT)+'…':text;};
const code=error=>/^[A-Z_]{3,40}$/.test(error?.message??'')?error.message:'REQUEST_FAILED';
function createAnchor(clock=Date.now){
  const results=new Map();const transcripts={live:[],shadow:[]};
  const shared=async(role,tool,args,fn)=>{
    const key=`${tool} ${JSON.stringify(args??null)}`;let entry=results.get(key);const reused=Boolean(entry);
    if(!entry){entry={tool,args,at:clock(),fetchedBy:role,promise:Promise.resolve().then(fn)};results.set(key,entry);}
    try{const value=await entry.promise;entry.value=value;transcripts[role].push({tool,args,key,at:entry.at,fetchedBy:entry.fetchedBy,reused});return value;}
    catch(error){entry.error=code(error);transcripts[role].push({tool,args,key,at:entry.at,fetchedBy:entry.fetchedBy,reused,error:entry.error});throw error;}
  };
  const write=(role,tool,fn)=>async(...args)=>{let result,error=null;try{result=await fn(...args);return result;}catch(e){error=code(e);throw e;}finally{transcripts[role].push({tool,args:args[0]??null,write:true,at:clock(),...(error?{error}:{result:JSON.parse(keep(result))})});}};
  return {
    // One hook for every tool call of a research run: reads are shared, anything else is recorded as a write.
    wrapper:role=>(name,fn)=>[...READ_TOOLS,'get_market_evidence'].includes(name)?args=>shared(role,name,args,()=>fn(args)):write(role,name,fn),
    export:()=>({evidence:Object.fromEntries([...results].map(([key,e])=>[key,{tool:e.tool,args:e.args,at:e.at,fetchedBy:e.fetchedBy,...(e.error?{error:e.error}:{value:keep(e.value)})}])),live:transcripts.live,shadow:transcripts.shadow})
  };
}
module.exports={createAnchor,READ_TOOLS};
