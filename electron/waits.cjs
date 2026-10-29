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
// Waits that hold research on their symbol: what is waited for cannot arrive sooner by reading again. A market that
// is closed holds until it opens; a publication until its time; data that exists but the tools cannot read until
// the wait lapses (decide under the uncertainty or use another source). Inconclusive data and entry conditions do not.
const holds=w=>w.reason==='market_closed'||w.reason==='publication_pending'||w.reason==='missing_data'&&w.cause==='not-retrievable';
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
  record(scope,decision,{reviewId=null,context={}}={}){const now=this.clock(),active=this.active(scope),roles=new Map((context.scoutPlan?.targets??[]).map(t=>[t.symbol,t.role]));
    for(const v of decision?.planVerdicts??[]){const mine=active.filter(w=>w.symbol===v.symbol);
      if(v.verdict!=='waiting'){for(const w of mine)this.save({...w,status:'resolved',closedAt:now,closedBy:`${v.verdict} in review ${reviewId??''}`.trim()});continue;}
      const reason=reasonOf(v);if(!reason)continue;const c=v.condition??{},cause=v.dataGap?.cause??null,role=roles.get(v.symbol)??null;
      let prev=mine.find(w=>w.reason===reason);if(prev&&context.scoutPlan&&prev.role!==role){this.save({...prev,status:'invalidated',closedAt:now,closedBy:'scout role changed'});prev=null;}
      const t=Date.parse(c.earliestCheck??''),given=Number.isFinite(t)&&t>now&&t<=now+MAX_MS?t:null;
      const earliest=cause==='not-retrievable'&&reason==='missing_data'?null:prev?(prev.earliestCheckAt!=null&&given!=null?Math.min(prev.earliestCheckAt,given):prev.earliestCheckAt??given):given;
      const expiresAt=prev?.expiresAt??Math.min(now+MAX_MS,earliest!=null?earliest+DAY:now+2*DAY);
      this.save({id:prev?.id??'W-'+randomUUID().slice(0,8),scope,symbol:v.symbol,status:'active',reason,cause,question:String(c.unresolved??'').slice(0,240),resolvesOn:String(c.recheck??'').slice(0,160),
        evidence:String(c.evidence??'').slice(0,240),sources:[...new Set([...(prev?.sources??[]),...[v.dataGap?.otherSource,v.dataGap?.document].filter(Boolean)])].slice(0,6),
        earliestCheckAt:earliest,expiresAt,overrides:'A filing, important news, a price move past the review gate’s limit, a holding or order change, a lost stop loss or a risk limit for this symbol; your own request; an emergency.',
        role,thesisVersion:prev?.thesisVersion??context.scoutPlan?.asOf??null,createdAt:prev?.createdAt??now,reviewId:prev?.reviewId??reviewId,lastReviewId:reviewId,reviews:(prev?.reviews??0)+1});}}
  // Research a wait holds back, or null. overridden: symbols something changed about (review gate reasons); isOpen:
  // whether a market's session is open now.
  guard(scope,symbol,{overridden=new Set(),isOpen=()=>true}={}){if(!symbol||overridden.has(symbol))return null;const now=this.clock();
    const w=this.active(scope).find(x=>x.symbol===symbol&&holds(x)&&(x.reason==='market_closed'?!isOpen(marketOf(symbol)):x.earliestCheckAt==null||now<x.earliestCheckAt));if(!w)return null;
    const until=w.reason==='market_closed'?'when its market opens':new Date(w.earliestCheckAt??w.expiresAt).toISOString();
    return {status:'waiting',symbol,reason:w.reason,question:w.question,until,since:new Date(w.createdAt).toISOString(),reviews:w.reviews,
      note:w.reason==='missing_data'?'The tools could not read this before; reading again will not change that. Decide under the uncertainty, use another source in context, or say what the user could provide.':`Nothing about ${symbol} changed since this wait began, and what it waits for cannot arrive sooner. Keep the verdict waiting, or decide on what is in context.`};}
  // What the trading review sees. enforced: whether research is actually held (the review gate is on).
  context(scope,{enforced=false}={}){return this.active(scope).map(w=>({symbol:w.symbol,reason:w.reason,...(w.cause?{cause:w.cause}:{}),question:w.question,resolvesOn:w.resolvesOn,earliestCheck:w.earliestCheckAt==null?null:new Date(w.earliestCheckAt).toISOString(),expires:new Date(w.expiresAt).toISOString(),since:new Date(w.createdAt).toISOString(),reviews:w.reviews,holdsResearch:enforced&&holds(w)}));}
}
module.exports={Waits,reasonOf,holds,REASONS};
