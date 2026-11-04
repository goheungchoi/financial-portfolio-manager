// Waiting conditions the scheduler can act on, from the trading reviews' waiting verdicts: what a symbol waits for, the
// earliest time looking again could change the answer, and when the wait lapses. A wait belongs to one symbol and
// reason: it never holds back another symbol, protective monitoring or portfolio risk, and anything the review gate
// sees change about its symbol (a filing, a price move, a holding change) overrides it.
// 2026-10-29: reviews waited all day on Samsung E&A's disclosure, Kia's earnings and the U.S. open, researching again
// every few minutes although nothing could arrive sooner.
// Audit 2026-11-04, Stage 4: a wait's check time is always a dated reason (its market's open, a calendar event for the
// symbol, a source's refresh time), otherwise one reassessment per trading day; a check rolled forward by 30 minutes
// created no evidence. A block on unavailable information lasts until its source can answer differently, whatever the
// wait's check time, and a wait that expires hands its history and blocks to the next wait on the same symbol.
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
// What releases a block, as the tool reply says it.
const RELEASED_BY='A new filing or news about this symbol, a successful read of that section, the source’s refresh time (until), or the user’s own review request.';
const holds=w=>w.reason==='market_closed'||blocks(w);
// Reasons a research section gives that confirm the information is absent for that symbol (it does not exist, or not
// yet). Only these block a repeated request. Rate limits, timeouts, connection and configuration failures are temporary:
// they never block, and the research service tries a failed source again after ten minutes (FAILURE_TTL), so repeated
// requests in between are answered from that record without calling the source.
const CONFIRMED=new Set(['NO_EARNINGS_RELEASE','NO_ANNUAL_REPORT','NOT_IN_SEC','NOT_IN_DART','KOREAN_LISTINGS_ONLY','UNKNOWN_SECTION','NO_PEERS','INSUFFICIENT_HISTORY','DOCUMENT_NOT_FOUND','NO_RELEASE_EXHIBIT','NO_EARNINGS_FIGURES_IN_RECENT_FILINGS','NO_BUSINESS_SECTION','NO_BUSINESS_OVERVIEW','NOT_FOR_FUNDS','NOT_ENOUGH_INPUTS','NOT_AN_ETF','FUNDS_ONLY']);
// A source the app is not configured for (a missing key or contact) answers the same until the settings change: it is
// held like a confirmed absence, for an hour at a time. Anything else (timeouts, rate limits, a dropped connection, tool
// failures) is temporary: never held, and retried by the research service after ten minutes (FAILURE_TTL).
const CONFIGURATION=new Set(['DART_KEY_MISSING','SEC_CONTACT_MISSING']);
const kindOf=reason=>CONFIRMED.has(reason)?'not-published':CONFIGURATION.has(reason)?'configuration':'temporary';
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
    const period=result[section]?.period??result[section]?.fiscalPeriod??null,kind=u?kindOf(String(u)):null;
    return u?{symbol,section,reason:String(u),sources,...(period?{period:String(period).slice(0,20)}:{}),kind,confirmed:kind!=='temporary',recheckMs:kind==='configuration'?RECHECK_MS:recheckMs}:{symbol,section,read:true};});}
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
  // sessionAfter(market, t): the first session open of that market after the one in progress at t (the daily
  // reassessment), a day later when not given; nextOpen(market, t): its next open at or after t, unknown when not given.
  record(scope,decision,{reviewId=null,context={},research=[],sessionAfter=(m,t)=>t+DAY,nextOpen=()=>null}={}){const now=this.clock(),active=this.active(scope),roles=new Map((context.scoutPlan?.targets??[]).map(t=>[t.symbol,t.role]));
    const expired=this.all(scope).filter(w=>w.status==='expired'&&w.closedAt>now-MAX_MS);
    for(const v of decision?.planVerdicts??[]){const mine=active.filter(w=>w.symbol===v.symbol);
      if(v.verdict!=='waiting'){for(const w of mine)this.save({...w,status:'resolved',closedAt:now,closedBy:`${v.verdict} in review ${reviewId??''}`.trim()});continue;}
      const reason=reasonOf(v);if(!reason)continue;const c=v.condition??{},cause=v.dataGap?.cause??null,role=roles.get(v.symbol)??null;
      let prev=mine.find(w=>w.reason===reason);if(prev&&context.scoutPlan&&prev.role!==role){this.save({...prev,status:'invalidated',closedAt:now,closedBy:'scout role changed'});prev=null;}
      const older=mine.filter(w=>w.reason!==reason),inherit=older.length?older.reduce((a,b)=>a.createdAt<=b.createdAt?a:b):null;
      // A wait on this symbol that expired within the last week: its history and still-valid blocks carry over, and the
      // review is told it already waited a week (afterExpiry), so expiry never restarts the loop.
      const lapsed=!prev&&!inherit?expired.filter(w=>w.symbol===v.symbol).sort((a,b)=>b.closedAt-a.closedAt)[0]??null:null;
      for(const w of older)this.save({...w,status:'superseded',closedAt:now,closedBy:`superseded by ${reason}${reviewId?` in review ${reviewId}`:''}`});
      const history=prev?prev.history??[]:lapsed?[...(lapsed.history??[]),{reason:lapsed.reason,from:lapsed.createdAt,to:lapsed.closedAt,reviews:lapsed.reviews,expired:true}]:[...(inherit?.history??[]),...older.map(w=>({reason:w.reason,from:w.createdAt,to:now,reviews:w.reviews}))];
      const mineOut=research.filter(o=>o.symbol===v.symbol),read=new Set(mineOut.filter(o=>o.read).map(o=>o.section));
      // An absence confirmed again replaces the earlier entry (a new re-read time); one read since is dropped.
      const carried=(prev?.blocked??inherit?.blocked??lapsed?.blocked??[]).filter(b=>!(b.recheckAt<=now));
      const kept=reason==='missing_data'||reason==='publication_pending'?[...carried,...mineOut.filter(o=>o.confirmed).map(o=>({section:o.section,sources:o.sources,...(o.period?{period:o.period}:{}),reason:o.reason,kind:o.kind,since:now,recheckAt:now+(o.recheckMs??RECHECK_MS)}))]:[];
      const same=(a,b)=>a.section===b.section&&a.sources===b.sources&&(a.period??null)===(b.period??null);
      const blocked=kept.filter((b,i)=>!read.has(b.section)&&kept.findLastIndex(x=>same(x,b))===i);
      const started=prev?.createdAt??inherit?.createdAt??now;
      const t=Date.parse(c.earliestCheck??''),given=Number.isFinite(t)&&t>now&&t<=now+MAX_MS?t:null;
      // The check time needs a dated reason: a closed market's next open; the time the review gave when it falls on a
      // calendar event of the symbol that day, or within an hour of its market's open or a block's source refresh.
      // Otherwise it is the daily reassessment (the next trading day's open), so it cannot roll forward by minutes.
      const market=marketOf(v.symbol),HOUR=3600000,within=d=>Number.isFinite(d?.at)&&d.at>now&&d.at<=now+MAX_MS?d:null;
      const day=e=>Date.parse(`${e.date}T00:00:00${market==='KR'?'+09:00':'-05:00'}`);
      const event=given==null?null:(context.eventCalendar??[]).filter(e=>e.symbol===v.symbol&&/^\d{4}-\d{2}-\d{2}$/.test(String(e.date??''))).find(e=>given>=day(e)&&given<day(e)+DAY+HOUR);
      const near=given==null?null:[{at:nextOpen(market,given-HOUR),why:'market open'},...blocked.map(b=>({at:b.recheckAt,why:`source refresh: ${b.section}`}))].find(d=>Number.isFinite(d.at)&&Math.abs(d.at-given)<=HOUR);
      const pick=reason==='market_closed'?within({at:nextOpen(market,now),why:'market open'}):within(event?{at:given,why:`calendar: ${String(event.title??event.kind??'event').slice(0,60)}`}:near)??within({at:sessionAfter(market,now),why:'daily reassessment'});
      // A check still ahead can only move earlier; one that has passed (the review it called for ran) can be renewed to
      // the next dated reason, and the expiry moves with it, within a week of the wait's start.
      const due=prev?.earliestCheckAt!=null&&prev.earliestCheckAt<=now;
      const fresh=cause==='not-retrievable'&&reason==='missing_data'?null:pick;
      const earliest=fresh==null?null:!prev||due||prev.earliestCheckAt==null?fresh.at:Math.min(prev.earliestCheckAt,fresh.at);
      const checkReason=earliest==null?null:earliest===fresh?.at?fresh.why:prev?.checkReason??null;
      const expiresAt=!prev?Math.min(started+MAX_MS,now+MAX_MS,earliest!=null?earliest+DAY:now+2*DAY):due&&earliest!=null?Math.min(prev.createdAt+MAX_MS,Math.max(prev.expiresAt,earliest+DAY)):prev.expiresAt;
      this.save({id:prev?.id??'W-'+randomUUID().slice(0,8),scope,symbol:v.symbol,status:'active',reason,cause,question:String(c.unresolved??'').slice(0,240),resolvesOn:String(c.recheck??'').slice(0,160),
        evidence:String(c.evidence??'').slice(0,240),sources:[...new Set([...(prev?.sources??[]),...[v.dataGap?.otherSource,v.dataGap?.document].filter(Boolean)])].slice(0,6),
        earliestCheckAt:earliest,...(checkReason?{checkReason}:{}),expiresAt,overrides:'A filing, important news, a price move past the review gate’s limit, a holding or order change, a lost stop loss or a risk limit for this symbol; your own request; an emergency.',
        role,thesisVersion:prev?.thesisVersion??context.scoutPlan?.asOf??null,createdAt:started,reviewId:prev?.reviewId??reviewId,lastReviewId:reviewId,reviews:(prev?.reviews??inherit?.reviews??0)+1,
        blocked,...(history.length?{history}:{}),...(!prev&&inherit?{supersedes:older.map(w=>w.id)}:{}),...(lapsed?{afterExpiry:{expiredAt:lapsed.closedAt,reviews:lapsed.reviews,question:lapsed.question}}:prev?.afterExpiry?{afterExpiry:prev.afterExpiry}:{})});}}
  // Research a wait holds back for a request, or null. sections: the sections asked for (a request naming none cannot be
  // matched to what was unavailable, so only a closed market holds it). Returns {status:'waiting'} when everything asked
  // is held, {status:'partial', held, read} when some sections can be read. overridden: symbols something changed about
  // (review gate reasons); isOpen: whether a market's session is open now.
  // changedSince(symbol, t): whether a filing or news about the symbol arrived after t (it releases blocks made before).
  guard(scope,symbol,{sections=[],overridden=new Set(),isOpen=()=>true,changedSince=()=>false}={}){if(!symbol||overridden.has(symbol))return null;const now=this.clock(),mine=this.active(scope).filter(x=>x.symbol===symbol);
    const closed=mine.find(x=>x.reason==='market_closed'&&!isOpen(marketOf(symbol)));
    if(closed)return {status:'waiting',symbol,reason:'market_closed',question:closed.question,until:'when its market opens',since:new Date(closed.createdAt).toISOString(),reviews:closed.reviews,
      note:`Nothing about ${symbol} changed since this wait began, and its market is closed. Keep the verdict waiting, or decide on what is in context.`};
    const asked=[...new Set(Array.isArray(sections)?sections.map(String):[])],held=[];
    // Each block lasts until its sources' answer can have changed (recheckAt), at most until the wait expires, or until a
    // check dated by the symbol's calendar (the expected publication). A daily reassessment does not lift it; news or a
    // filing since it began does.
    for(const w of mine.filter(blocks))for(const b of w.blocked){const end=Math.min(w.expiresAt,b.recheckAt??Infinity,/^calendar:/.test(w.checkReason??'')&&w.earliestCheckAt>b.since?w.earliestCheckAt:Infinity);
      if(now<end&&asked.includes(b.section)&&!changedSince(symbol,b.since)&&!held.some(h=>h.section===b.section))held.push({section:b.section,unavailable:b.reason,kind:b.kind??'not-published',sources:b.sources,...(b.period?{period:b.period}:{}),reason:w.reason,until:new Date(end).toISOString(),since:new Date(b.since).toISOString()});}
    if(!held.length)return null;const read=asked.filter(s=>!held.some(h=>h.section===s));
    return {status:read.length?'partial':'waiting',symbol,reason:held[0].reason,held,read,until:held.map(h=>h.until).sort()[0],
      note:'These sections came back unavailable for this symbol before and reading them again will not change that before the time given: decide under the uncertainty, use another section, tool or source, or say what the user could provide.',releasedBy:RELEASED_BY};}
  // A section read successfully (outcomes(): read) is no longer held by any wait on its symbol, at once and whatever the
  // review decides: the evidence became available.
  available(scope,found){const read=(found??[]).filter(o=>o.read);if(!read.length)return;
    for(const w of this.active(scope).filter(x=>x.blocked?.length)){const rest=w.blocked.filter(b=>!read.some(o=>o.symbol===w.symbol&&o.section===b.section));
      if(rest.length<w.blocked.length)this.save({...w,blocked:rest,lastAvailableAt:this.clock()});}}
  // What the trading review sees. enforced: whether research is actually held (the review gate is on).
  context(scope,{enforced=false}={}){return this.active(scope).map(w=>({symbol:w.symbol,reason:w.reason,...(w.cause?{cause:w.cause}:{}),question:w.question,resolvesOn:w.resolvesOn,earliestCheck:w.earliestCheckAt==null?null:new Date(w.earliestCheckAt).toISOString(),...(w.checkReason?{checkReason:w.checkReason}:{}),...(w.afterExpiry?{afterExpiry:{expired:new Date(w.afterExpiry.expiredAt).toISOString(),reviews:w.afterExpiry.reviews}}:{}),expires:new Date(w.expiresAt).toISOString(),since:new Date(w.createdAt).toISOString(),reviews:w.reviews,holdsResearch:enforced&&holds(w)}));}
}
module.exports={Waits,reasonOf,holds,outcomes,kindOf,CONFIRMED,CONFIGURATION,REASONS,RELEASED_BY};
