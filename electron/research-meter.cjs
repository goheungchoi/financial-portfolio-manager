// Research counters for one run (a trading review or a scout run), saved with the run as the baseline for comparing
// context designs: tool requests, answers from the run's own cache, get_context_detail reads, results shortened to fit
// and the bytes sent, and where company research came from: the app's research cache (reused), a first fetch, a
// refresh of expired data, or stale data kept because the source failed (research-service.cjs notes every read).
// Coverage: which watched symbols this run researched, counted only when usable evidence came back (fresh or cached):
// a request refused, skipped or answered with nothing usable is attempted, not researched; one with some sections
// unavailable is partial. format names the reply and context format the counts were measured with; counts from
// another format are not comparable.
const FORMAT='research-v3';
const TRACE=Symbol.for('fpm.research-trace');
const SYMBOL_TOOLS=new Set(['get_company_research','get_market_evidence']);
const COUNTS=['toolCalls','runCacheHits','detailReads','shortened','resultBytes','detailBytes','researchReads','sections','sourceReads','reused','fetched','refreshed','stale','unavailable'];
function createMeter(){
  const c=Object.fromEntries(COUNTS.map(k=>[k,0])),symbols=new Set(),attempted=new Set(),partial=new Set(),whole=new Set();
  return {
    // One answered tool request: its name and arguments, the full value and the reply as sent. runCache: answered from
    // the run's own cache of identical requests (no source was read again).
    call(name,args,value,sent,{runCache=false}={}){
      c.toolCalls++;const bytes=Buffer.byteLength(typeof sent==='string'?sent:JSON.stringify(sent??null));
      if(name==='get_context_detail'){c.detailReads++;c.detailBytes+=bytes;return;}
      c.resultBytes+=bytes;if(sent&&typeof sent==='object'&&(sent.cuts||sent.omittedParts||sent.shortenedParts||sent.status==='too_large'))c.shortened++;
      const symbol=typeof args?.symbol==='string'?args.symbol.trim().toUpperCase():'';
      // One full read makes a symbol fully researched for the run, whatever was read before or after it (as in merge).
      if(symbol&&SYMBOL_TOOLS.has(name)){attempted.add(symbol);const found=usable(name,value);if(found){symbols.add(symbol);if(found==='full'){whole.add(symbol);partial.delete(symbol);}else if(!whole.has(symbol))partial.add(symbol);}}
      if(runCache){c.runCacheHits++;return;}
      const trace=name==='get_company_research'?value?.[TRACE]:null;if(!trace)return;c.researchReads++;
      for(const reads of Object.values(trace.reads??{})){c.sections++;for(const r of reads){c.sourceReads++;const k=r.cache==='hit'||r.cache==='shared'?'reused':r.cache;if(Object.hasOwn(c,k))c[k]++;}}
    },
    // watched: the symbols on the watchlist this run could research.
    summary(watched=[]){const list=[...new Set(watched)],missed=list.filter(s=>!symbols.has(s));
      return {format:FORMAT,...c,researchedSymbols:[...symbols],partialSymbols:[...partial],unavailableSymbols:[...attempted].filter(s=>!symbols.has(s)),
        coverage:{watched:list.length,researched:list.length-missed.length,partial:list.filter(s=>partial.has(s)).length,partialSymbols:list.filter(s=>partial.has(s)).slice(0,40),notResearched:missed.slice(0,40),attemptedNotResearched:missed.filter(s=>attempted.has(s)).slice(0,40)}};},
  };
}
// Whether a reply holds usable evidence: 'full', 'partial' (some company research sections unavailable) or null for a
// refusal, a skip, an error or a reply with no section of data.
const REFUSED=new Set(['skipped','rejected','unavailable','too_large']);
function usable(name,value){
  if(!value||typeof value!=='object'||REFUSED.has(value.status))return null;
  if(name!=='get_company_research')return 'full';
  const sections=Object.entries(value.provenance??{});if(!sections.length)return null;
  const ok=sections.filter(([,p])=>p?.cache!=='unavailable').length;return ok===0?null:ok<sections.length?'partial':'full';
}
// Two runs of one review (a cheaper model's run and its confirmation): counts add up, coverage is of both.
function merge(a,b){
  if(!a||!b)return a??b??null;const out={...b};for(const k of COUNTS)out[k]=(a[k]??0)+(b[k]??0);
  out.researchedSymbols=[...new Set([...(a.researchedSymbols??[]),...(b.researchedSymbols??[])])];
  const missed=[...new Set([...(a.coverage?.notResearched??[]),...(b.coverage?.notResearched??[])])].filter(s=>!out.researchedSymbols.includes(s));
  // A symbol researched fully in either run is not partial; one with usable evidence in either run is not unavailable.
  const watched=Math.max(a.coverage?.watched??0,b.coverage?.watched??0),union=(x,y)=>[...new Set([...(x??[]),...(y??[])])];
  const full=r=>(r.researchedSymbols??[]).filter(s=>!(r.partialSymbols??[]).includes(s)),whole=union(full(a),full(b));
  out.partialSymbols=union(a.partialSymbols,b.partialSymbols).filter(s=>!whole.includes(s));out.unavailableSymbols=union(a.unavailableSymbols,b.unavailableSymbols).filter(s=>!out.researchedSymbols.includes(s));
  // Watched partial symbols: those partial in either run's watched list and full in neither.
  const attempted=union(a.coverage?.attemptedNotResearched,b.coverage?.attemptedNotResearched),watchedPartial=union(a.coverage?.partialSymbols,b.coverage?.partialSymbols).filter(s=>!whole.includes(s));
  out.coverage={watched,researched:watched-missed.length,partial:watchedPartial.length,partialSymbols:watchedPartial,notResearched:missed,attemptedNotResearched:missed.filter(s=>attempted.includes(s))};
  return out;
}
module.exports={createMeter,merge,FORMAT,COUNTS};
