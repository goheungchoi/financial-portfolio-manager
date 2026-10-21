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
// Evidence only one model looked at. Different tool choices alone are normal and not errors. A pair is flagged for
// inspection when the one-sided evidence bears on a decision: one model waits on missing data or an event for a stock
// (or trades it) while the other read that stock's events, financials, estimates or analysts; or only one model read the
// market overview while Korea was open. Adjudication decides whether the omission was material and the data available.
const KEY_SECTIONS=['events','financials','estimates','analysts'];
const DATA_WORDS=/earnings|results|figures|filing|data|실적|잠정/i;
function evidenceGap(live,shadow,{liveDecision=null,shadowDecision=null,koreaOpen=false}={}){
  const key=t=>{const a=t.args??{};return [t.tool,a.symbol??'',Array.isArray(a.sections)?[...a.sections].sort().join('+'):a.dataset??a.market??''].join(' ');};
  const reads=list=>(list??[]).filter(t=>!t.write&&!t.error);const L=reads(live),S=reads(shadow);const LK=new Set(L.map(key)),SK=new Set(S.map(key));
  const sections=list=>{const out=new Map();for(const t of list){const sym=t.args?.symbol;if(!sym)continue;const x=out.get(sym)??new Set();for(const sec of t.args?.sections??[])if(KEY_SECTIONS.includes(sec))x.add(sec);out.set(sym,x);}return out;};
  const LS=sections(L),SS=sections(S);const reasons=[];
  const overview=list=>list.some(t=>t.tool==='get_market_overview');if(koreaOpen&&overview(L)!==overview(S))reasons.push(`only the ${overview(L)?'main':'cheaper'} model read the market overview while Korea was open`);
  // A verdict that depends on information: waiting on data or an event, or acting.
  const needs=d=>new Set((d?.planVerdicts??[]).filter(v=>v.verdict==='acted'||['data','event'].includes(v.condition?.kind)||(!v.condition&&v.verdict==='waiting'&&DATA_WORDS.test(v.reason??''))).map(v=>v.symbol).concat(d&&d.action!=='Hold'&&d.symbol?[d.symbol]:[]));
  const check=(who,needSet,mine,theirs)=>{for(const sym of needSet){const got=mine.get(sym)??new Set(),other=theirs.get(sym)??new Set();const missed=[...other].filter(x=>!got.has(x));if(missed.length)reasons.push(`the ${who} model's ${sym} verdict depends on information, and only the other model read ${missed.join(', ')}`);}};
  check('main',needs(liveDecision),LS,SS);check('cheaper',needs(shadowDecision),SS,LS);
  return {liveOnly:[...LK].filter(k=>!SK.has(k)),shadowOnly:[...SK].filter(k=>!LK.has(k)),inspect:reasons.length>0,reasons};
}
module.exports={createAnchor,evidenceGap,READ_TOOLS};
