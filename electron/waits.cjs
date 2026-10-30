// Waiting conditions the scheduler can act on, from the trading reviews' waiting verdicts: what a symbol waits for, the
// earliest time looking again could change the answer, and when the wait lapses. A wait belongs to one symbol and
// reason: it never holds back another symbol, protective monitoring or portfolio risk, and anything the review gate
// sees change about its symbol (a filing, a price move, a holding change) overrides it.
// 2026-10-29: reviews waited all day on Samsung E&A's disclosure, Kia's earnings and the U.S. open, researching again
// every few minutes although nothing could arrive sooner.
const {randomUUID}=require('node:crypto');
const REASONS=['market_closed','publication_pending','entry_condition','missing_data'];
const DAY=86400000,MAX_MS=7*DAY;
const marketOf=symbol=>/:/.test(symbol)?'US':'KR';
// Research a wait holds back. A closed market holds research on its symbol until it opens. A publication or missing
// data holds only what the research tools confirmed unavailable for that symbol: the sections (each read from its
// sources) that came back absent, until the wait's check or expiry; every other section, other tools and other sources
// are read. A wait whose missing sections could not be identified holds nothing. Entry conditions hold nothing.
// Review of 8ef1be1, P2: a wait on unavailable project margins answered an unrelated valuation request.
const blocks=w=>(w.reason==='missing_data'||w.reason==='publication_pending')&&w.blocked?.length>0;
const holds=w=>w.reason==='market_closed'||blocks(w);
// Reasons a research section gives that confirm the information is absent for that symbol (it does not exist, or not
// yet). Only these block a repeated request. Rate limits, timeouts, connection and configuration failures are temporary:
// they never block, and the research service tries a failed source again after ten minutes (FAILURE_TTL), so repeated
// requests in between are answered from that record without calling the source.
const CONFIRMED=new Set(['NO_EARNINGS_RELEASE','NO_ANNUAL_REPORT','NOT_IN_SEC','NOT_IN_DART','KOREAN_LISTINGS_ONLY','UNKNOWN_SECTION','NO_PEERS','INSUFFICIENT_HISTORY','DOCUMENT_NOT_FOUND','NO_RELEASE_EXHIBIT','NO_EARNINGS_FIGURES_IN_RECENT_FILINGS','NO_BUSINESS_SECTION','NO_BUSINESS_OVERVIEW','NOT_FOR_FUNDS','NOT_ENOUGH_INPUTS','NOT_AN_ETF','FUNDS_ONLY']);
const TRACE=Symbol.for('fpm.research-trace');
// What a research reply showed, per section it answered: read, or unavailable with its reason, its sources, whether the
// absence is confirmed, and how long its sources keep that answer (ttl(source): reading again sooner returns the same
// answer, so a block lasts at most that long before one re-read is allowed; RECHECK_MS when unknown). A reply without
// sections (an unknown symbol, a failure) shows nothing.
const RECHECK_MS=3600000;
function outcomes(args,result,{ttl=()=>null}={}){if(!result||typeof result!=='object'||!result.provenance)return [];const symbol=String(result.symbol??args?.symbol??'').trim().toUpperCase();if(!symbol)return [];
  const reads=result[TRACE]?.reads??{};return Object.keys(result.provenance).map(section=>{const u=result[section]?.unavailable;
    const sources=[...new Set((reads[section]??[]).map(r=>r.origin).filter(Boolean))].join(' + ')||result.provenance[section]?.from||null;
    const lives=(reads[section]??[]).map(r=>ttl(r.source)).filter(Number.isFinite),recheckMs=lives.length?Math.min(...lives):RECHECK_MS;
    return u?{symbol,section,reason:String(u),sources,confirmed:CONFIRMED.has(u),recheckMs}:{symbol,section,read:true};});}
// The reason of a waiting verdict: the one the review gave, else from its condition kind and data-gap cause.
function reasonOf(v){const c=v.condition??{};if(REASONS.includes(c.waitReason))return c.waitReason;
  if(c.kind==='event')return 'publication_pending';if(c.kind==='data')return v.dataGap?.cause==='not-yet-published'?'publication_pending':'missing_data';if(c.kind==='market')return 'entry_condition';return null;}
class Waits {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS waits(id TEXT PRIMARY KEY,scope TEXT NOT NULL,symbol TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');}
  save(w){this.db.prepare('INSERT INTO waits VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(w.id,w.scope,w.symbol,w.status,JSON.stringify(w));return w;}
  // Waits of a scope; active ones past their expiry are closed as expired first. Closed ones older than a week go.
  all(scope){const now=this.clock();const rows=this.db.prepare('SELECT payload FROM waits WHERE scope=? ORDER BY rowid').all(scope).map(r=>JSON.parse(r.payload));
    for(const w of rows)if(w.status==='active'&&w.expiresAt<=now){w.status='expired';w.closedAt=w.expiresAt;this.save(w);}
    this.db.prepare("DELETE FROM waits WHERE scope=? AND status!='active' AND json_extract(payload,'$.closedAt')<?").run(scope,now-MAX_MS);return rows;}
  active(scope){return this.all(scope).filter(w=>w.status==='active');}
  // After a successful decision: a waiting verdict opens or continues its symbol's wait for that reason. Saying it
  // again, in other words, keeps the wait as it was (its earliest check can only move earlier, its expiry stays); a
  // changed scout role for the symbol (a new thesis) replaces it; acting or passing on the symbol closes its waits.
  // research: what this review's research showed (outcomes()): sections confirmed absent are held by a publication or
  // missing-data wait; a section read since is no longer held (the evidence became available). A waiting verdict with
  // another reason supersedes the symbol's other waits; the new one keeps their start, review count and history, so a
  // change of wording or reason never restarts the week a wait may last.
  record(scope,decision,{reviewId=null,context={},research=[]}={}){const now=this.clock(),active=this.active(scope),roles=new Map((context.scoutPlan?.targets??[]).map(t=>[t.symbol,t.role]));
    for(const v of decision?.planVerdicts??[]){const mine=active.filter(w=>w.symbol===v.symbol);
      if(v.verdict!=='waiting'){for(const w of mine)this.save({...w,status:'resolved',closedAt:now,closedBy:`${v.verdict} in review ${reviewId??''}`.trim()});continue;}
      const reason=reasonOf(v);if(!reason)continue;const c=v.condition??{},cause=v.dataGap?.cause??null,role=roles.get(v.symbol)??null;
      let prev=mine.find(w=>w.reason===reason);if(prev&&context.scoutPlan&&prev.role!==role){this.save({...prev,status:'invalidated',closedAt:now,closedBy:'scout role changed'});prev=null;}
      const older=mine.filter(w=>w.reason!==reason),inherit=older.length?older.reduce((a,b)=>a.createdAt<=b.createdAt?a:b):null;
      for(const w of older)this.save({...w,status:'superseded',closedAt:now,closedBy:`superseded by ${reason}${reviewId?` in review ${reviewId}`:''}`});
      const history=prev?prev.history??[]:[...(inherit?.history??[]),...older.map(w=>({reason:w.reason,from:w.createdAt,to:now,reviews:w.reviews}))];
      const mineOut=research.filter(o=>o.symbol===v.symbol),read=new Set(mineOut.filter(o=>o.read).map(o=>o.section));
      // An absence confirmed again replaces the earlier entry (a new re-read time); one read since is dropped.
      const kept=reason==='missing_data'||reason==='publication_pending'?[...(prev?.blocked??inherit?.blocked??[]),...mineOut.filter(o=>o.confirmed).map(o=>({section:o.section,sources:o.sources,reason:o.reason,since:now,recheckAt:now+(o.recheckMs??RECHECK_MS)}))]:[];
      const blocked=kept.filter((b,i)=>!read.has(b.section)&&kept.findLastIndex(x=>x.section===b.section&&x.sources===b.sources)===i);
      const started=prev?.createdAt??inherit?.createdAt??now;
      const t=Date.parse(c.earliestCheck??''),given=Number.isFinite(t)&&t>now&&t<=now+MAX_MS?t:null;
      // A check still ahead can only move earlier; one that has passed (the review it called for ran) can be renewed,
      // and the expiry moves with it, within a week of the wait's start.
      const due=prev?.earliestCheckAt!=null&&prev.earliestCheckAt<=now;
      const earliest=cause==='not-retrievable'&&reason==='missing_data'?null:!prev?given:due?given??prev.earliestCheckAt:prev.earliestCheckAt!=null&&given!=null?Math.min(prev.earliestCheckAt,given):prev.earliestCheckAt??given;
      const expiresAt=!prev?Math.min(started+MAX_MS,now+MAX_MS,earliest!=null?earliest+DAY:now+2*DAY):due&&earliest!=null?Math.min(prev.createdAt+MAX_MS,Math.max(prev.expiresAt,earliest+DAY)):prev.expiresAt;
      this.save({id:prev?.id??'W-'+randomUUID().slice(0,8),scope,symbol:v.symbol,status:'active',reason,cause,question:String(c.unresolved??'').slice(0,240),resolvesOn:String(c.recheck??'').slice(0,160),
        evidence:String(c.evidence??'').slice(0,240),sources:[...new Set([...(prev?.sources??[]),...[v.dataGap?.otherSource,v.dataGap?.document].filter(Boolean)])].slice(0,6),
        earliestCheckAt:earliest,expiresAt,overrides:'A filing, important news, a price move past the review gate’s limit, a holding or order change, a lost stop loss or a risk limit for this symbol; your own request; an emergency.',
        role,thesisVersion:prev?.thesisVersion??context.scoutPlan?.asOf??null,createdAt:started,reviewId:prev?.reviewId??reviewId,lastReviewId:reviewId,reviews:(prev?.reviews??inherit?.reviews??0)+1,
        blocked,...(history.length?{history}:{}),...(!prev&&inherit?{supersedes:older.map(w=>w.id)}:{})});}}
  // Research a wait holds back for a request, or null. sections: the sections asked for (a request naming none cannot be
  // matched to what was unavailable, so only a closed market holds it). Returns {status:'waiting'} when everything asked
  // is held, {status:'partial', held, read} when some sections can be read. overridden: symbols something changed about
  // (review gate reasons); isOpen: whether a market's session is open now.
  guard(scope,symbol,{sections=[],overridden=new Set(),isOpen=()=>true}={}){if(!symbol||overridden.has(symbol))return null;const now=this.clock(),mine=this.active(scope).filter(x=>x.symbol===symbol);
    const closed=mine.find(x=>x.reason==='market_closed'&&!isOpen(marketOf(symbol)));
    if(closed)return {status:'waiting',symbol,reason:'market_closed',question:closed.question,until:'when its market opens',since:new Date(closed.createdAt).toISOString(),reviews:closed.reviews,
      note:`Nothing about ${symbol} changed since this wait began, and its market is closed. Keep the verdict waiting, or decide on what is in context.`};
    const asked=[...new Set(Array.isArray(sections)?sections.map(String):[])],held=[];
    // Each block lasts until the wait's check, and at most until its sources' answer can have changed (recheckAt).
    for(const w of mine.filter(x=>blocks(x)&&(x.earliestCheckAt==null||now<x.earliestCheckAt)))for(const b of w.blocked){const end=Math.min(w.earliestCheckAt??w.expiresAt,b.recheckAt??Infinity);
      if(now<end&&asked.includes(b.section)&&!held.some(h=>h.section===b.section))held.push({section:b.section,unavailable:b.reason,sources:b.sources,reason:w.reason,until:new Date(end).toISOString(),since:new Date(b.since).toISOString()});}
    if(!held.length)return null;const read=asked.filter(s=>!held.some(h=>h.section===s));
    return {status:read.length?'partial':'waiting',symbol,reason:held[0].reason,held,read,until:held.map(h=>h.until).sort()[0],
      note:'These sections came back unavailable for this symbol before and reading them again will not change that before the time given: decide under the uncertainty, use another section, tool or source, or say what the user could provide.'};}
  // A section read successfully (outcomes(): read) is no longer held by any wait on its symbol, at once and whatever the
  // review decides: the evidence became available.
  available(scope,found){const read=(found??[]).filter(o=>o.read);if(!read.length)return;
    for(const w of this.active(scope).filter(x=>x.blocked?.length)){const rest=w.blocked.filter(b=>!read.some(o=>o.symbol===w.symbol&&o.section===b.section));
      if(rest.length<w.blocked.length)this.save({...w,blocked:rest,lastAvailableAt:this.clock()});}}
  // What the trading review sees. enforced: whether research is actually held (the review gate is on).
  context(scope,{enforced=false}={}){return this.active(scope).map(w=>({symbol:w.symbol,reason:w.reason,...(w.cause?{cause:w.cause}:{}),question:w.question,resolvesOn:w.resolvesOn,earliestCheck:w.earliestCheckAt==null?null:new Date(w.earliestCheckAt).toISOString(),expires:new Date(w.expiresAt).toISOString(),since:new Date(w.createdAt).toISOString(),reviews:w.reviews,holdsResearch:enforced&&holds(w)}));}
}
module.exports={Waits,reasonOf,holds,outcomes,CONFIRMED,REASONS};
