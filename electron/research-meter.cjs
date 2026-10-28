// Research counters for one run (a trading review or a scout run), saved with the run as the baseline for comparing
// context designs: tool requests, answers from the run's own cache, get_context_detail reads, results shortened to fit
// and the bytes sent, and where company research came from: the app's research cache (reused), a first fetch, a
// refresh of expired data, or stale data kept because the source failed (research-service.cjs notes every read).
// Coverage: which watched symbols this run researched. format names the reply and context format the counts were
// measured with; counts from another format are not comparable.
const FORMAT='research-v2';
const TRACE=Symbol.for('fpm.research-trace');
const SYMBOL_TOOLS=new Set(['get_company_research','get_market_evidence']);
const COUNTS=['toolCalls','runCacheHits','detailReads','shortened','resultBytes','detailBytes','researchReads','sections','sourceReads','reused','fetched','refreshed','stale','unavailable'];
function createMeter(){
  const c=Object.fromEntries(COUNTS.map(k=>[k,0])),symbols=new Set();
  return {
    // One answered tool request: its name and arguments, the full value and the reply as sent. runCache: answered from
    // the run's own cache of identical requests (no source was read again).
    call(name,args,value,sent,{runCache=false}={}){
      c.toolCalls++;const bytes=Buffer.byteLength(typeof sent==='string'?sent:JSON.stringify(sent??null));
      if(name==='get_context_detail'){c.detailReads++;c.detailBytes+=bytes;return;}
      c.resultBytes+=bytes;if(sent&&typeof sent==='object'&&(sent.cuts||sent.omittedParts||sent.shortenedParts||sent.status==='too_large'))c.shortened++;
      const symbol=typeof args?.symbol==='string'?args.symbol.trim().toUpperCase():'';if(symbol&&SYMBOL_TOOLS.has(name))symbols.add(symbol);
      if(runCache){c.runCacheHits++;return;}
      const trace=name==='get_company_research'?value?.[TRACE]:null;if(!trace)return;c.researchReads++;
      for(const reads of Object.values(trace.reads??{})){c.sections++;for(const r of reads){c.sourceReads++;const k=r.cache==='hit'||r.cache==='shared'?'reused':r.cache;if(Object.hasOwn(c,k))c[k]++;}}
    },
    // watched: the symbols on the watchlist this run could research.
    summary(watched=[]){const list=[...new Set(watched)],missed=list.filter(s=>!symbols.has(s));
      return {format:FORMAT,...c,researchedSymbols:[...symbols],coverage:{watched:list.length,researched:list.length-missed.length,notResearched:missed.slice(0,40)}};},
  };
}
// Two runs of one review (a cheaper model's run and its confirmation): counts add up, coverage is of both.
function merge(a,b){
  if(!a||!b)return a??b??null;const out={...b};for(const k of COUNTS)out[k]=(a[k]??0)+(b[k]??0);
  out.researchedSymbols=[...new Set([...(a.researchedSymbols??[]),...(b.researchedSymbols??[])])];
  const missed=[...new Set([...(a.coverage?.notResearched??[]),...(b.coverage?.notResearched??[])])].filter(s=>!out.researchedSymbols.includes(s));
  out.coverage={watched:Math.max(a.coverage?.watched??0,b.coverage?.watched??0),researched:Math.max(a.coverage?.watched??0,b.coverage?.watched??0)-missed.length,notResearched:missed};
  return out;
}
module.exports={createMeter,merge,FORMAT,COUNTS};
