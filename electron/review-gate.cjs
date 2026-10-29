// Review gate: whether a scheduled review has anything decision-relevant to look at, compared with the state at the last
// successful decision (not the last poll or skipped review). Setting reviewGate: 'off' keeps the token-saver skip alone,
// 'observe' keeps it deciding and logs what this gate would do, 'on' lets this gate decide.
// 2026-10-29: 56 scheduled reviews cost $7.50 (72% of the day) while skipping was on; quote volumes and small changePct
// moves changed the old fingerprint on almost every check.
const {createHash}=require('node:crypto');
const GATE_DEFAULTS={cashPctOfEquity:2,exposurePts:5};
const num=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const hash=v=>createHash('sha256').update(JSON.stringify(v??null)).digest('hex').slice(0,16);
const metAt=(w,price)=>w.direction==='above'?price>=w.price:price<=w.price;
const watchKey=w=>`${w.symbol}|${w.direction}|${w.price}`;
const marketOf=symbol=>/:/.test(symbol)?'US':'KR';
// One key per piece of news: a DART filing by its receipt number (the same filing from another feed or URL is not new),
// anything else by its normalized title (rewording counts as new only through the news feed's own dedup).
function newsKey(e){return e.receipt?'dart:'+e.receipt:'title:'+String(e.title??'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
// The parts of a review context that can change a decision, without timestamps, volumes, derived percentages, summaries
// or cache metadata. Quotes keep only the price and whether it is usable.
function decisionState(context){
  const quotes={};for(const q of context.quotes??[]){const price=num(q.price);quotes[q.symbol]={price:price>0?price:null,stale:Boolean(q.stale)||!(price>0)};}
  const positions={};for(const [s,p] of Object.entries(context.positions??{}))if(p?.quantity>0)positions[s]=p.quantity;
  const markets={};for(const m of context.markets??[])markets[m.market]={open:Boolean(m.marketSession?.open),execution:m.executionEnabled!==false,automatic:Boolean(m.automaticExecutionEnabled)};
  if(!Object.keys(markets).length&&context.marketSession)markets[context.market==='US'?'US':'KR']={open:Boolean(context.marketSession.open),execution:true,automatic:false};
  const cash=typeof context.cash==='number'?{[context.currency??'KRW']:context.cash}:{...(context.cash??{})};
  // Pending orders by symbol, side and quantity, numbered when several match, so each keeps its own entry.
  const orders={};for(const o of context.orderFollowUp?.orders??context.orders??[]){const k=`${o.symbol}|${o.side}|${o.quantity}`;let n=0;while(`${k}|${n}` in orders)n++;orders[`${k}|${n}`]=`${o.status}|${o.filled??0}`;}
  const desk=context.agentDesk?.conditionalOrders??{};
  const lossLimits=Object.fromEntries(Object.entries(context.risk?.markets??{}).map(([m,r])=>[m,hash(r?.lossLimit)]));
  const candidates=[...new Set([...(context.scoutPlan?.targets??[]).filter(t=>t.role==='candidate'||t.role==='add').map(t=>t.symbol),...(context.reviewWatches??[]).map(w=>w.symbol)])].filter(s=>!(s in positions));
  return {quotes,positions,markets,cash,usdKRW:num(context.fx?.usdKRW),equity:num(context.equity),orders,
    unprotected:(desk.unprotected??[]).map(u=>u.symbol),closedOrders:(desk.recent??[]).filter(o=>o.status!=='firing').map(o=>({id:o.id,symbol:o.symbol,purpose:o.purpose,status:o.status,at:Date.parse(o.at)})).filter(o=>Number.isFinite(o.at)),
    risk:{emergency:Boolean(context.emergency?.active),breached:Boolean(context.emergency?.loss?.breached),lossLimits},
    exposure:{investedPct:num(context.portfolioExposure?.investedPct),largestPct:num(context.portfolioExposure?.largest?.weightPct)},
    watches:(context.reviewWatches??[]).filter(w=>w.price!=null&&!w.priceFired).map(({symbol,price,direction})=>({symbol,price,direction})),
    candidates,instructions:hash([context.userGuidelines??null,context.reviewedLessons??null,context.objective??null]),
    reliable:context.equityReliability?.reliable!==false};
}
// Cash in KRW so markets can be compared; null when a USD balance has no rate.
function cashKRW(state){let total=0;for(const [cur,v] of Object.entries(state.cash??{})){if(!(num(v)!=null))continue;if(cur==='KRW')total+=v;else if(cur==='USD'){if(!state.usdKRW)return null;total+=v*state.usdKRW;}}return total;}
// Whether one share at price is affordable from a state's cash, by market: Korean shares from KRW, U.S. shares from USD
// plus KRW at the rate (integrated margin), as the order checks do.
function affordable(state,symbol,price){if(!(price>0))return null;const c=state.cash??{};
  if(marketOf(symbol)==='KR')return (c.KRW??0)>=price;const usd=(c.USD??0)+(state.usdKRW?(c.KRW??0)/state.usdKRW:0);return usd>=price;}
// base: the saved state at the last successful decision, with at (when it completed), contextAt (when its context was
// read), decision {action,symbol,orderId}
// and seen (news keys known then). next: decisionState of the current context. events: stored news events. waits:
// the scope's waits (electron/waits.cjs). pending: its pending decisions (electron/pending-decisions.cjs).
// Returns {needsReview, reasons:[{kind,detail,symbols}], changedSymbols, requiredEvidence, degraded, nextBackstopAt}.
function compare(base,next,{trigger='Scheduled review',now=Date.now(),config={},events=[],waits=[],pending=[]}={}){
  const reasons=[],degraded=[],add=(kind,detail,symbols=[],evidence=[])=>reasons.push({kind,detail,symbols,evidence});
  const tolerance=config.eventTolerancePct??3,maxSkip=(config.maxSkipMinutes??120)*60000,opts={...GATE_DEFAULTS,...(config.reviewGateThresholds??{})};
  const nextBackstopAt=base?base.at+maxSkip:now;
  if(trigger!=='Scheduled review')add('trigger',trigger);
  if(!base)add('baseline','No successful decision to compare with yet');
  else{
    if(now>=nextBackstopAt)add('backstop',`No full review for ${Math.round((now-base.at)/60000)} minutes`);
    if(base.instructions!==next.instructions)add('instructions','Guidelines, objective or approved lessons changed');
    // Holdings, orders, cash and execution: any material change.
    for(const s of new Set([...Object.keys(base.positions),...Object.keys(next.positions)]))if((base.positions[s]??0)!==(next.positions[s]??0))add('holdings',`${s}: ${base.positions[s]??0} → ${next.positions[s]??0} shares`,[s],['account:positions']);
    for(const [k,v] of Object.entries(base.orders))if(next.orders[k]!==v){const [s,side]=k.split('|');add('order',`${side} ${s}: ${v.split('|')[0]} → ${next.orders[k]?.split('|')[0]??'closed'}`,[s],['orders:'+s]);}
    // A new order counts unless it is the one the decision itself placed.
    const placed=base.decision?.orderId?`${base.decision.symbol}|${base.decision.action}|`:null;
    for(const k of Object.keys(next.orders))if(!(k in base.orders)&&!(placed&&k.startsWith(placed))){const [s,side]=k.split('|');add('order',`New ${side} order for ${s}: ${next.orders[k].split('|')[0]}`,[s],['orders:'+s]);}
    const before=cashKRW(base),after=cashKRW(next),equity=next.equity??base.equity;
    if(before!=null&&after!=null&&equity>0&&Math.abs(after-before)/equity*100>=opts.cashPctOfEquity)add('cash',`Cash moved ${Math.round((after-before)/equity*1000)/10}% of equity`,[],['account:cash']);
    // Affordability at the decision's price, so only a cash change moves it (price moves have their own reason).
    const at=s=>base.quotes[s]?.price,flips=[...new Set([...Object.keys(next.positions),...next.candidates])].map(s=>({s,a:affordable(base,s,at(s)),b:affordable(next,s,at(s))})).filter(x=>x.a!=null&&x.b!=null&&x.a!==x.b);
    for(const yes of [true,false]){const list=flips.filter(x=>x.b===yes).map(x=>x.s);if(list.length)add('cash',`One share of ${list.join(', ')} ${yes?'is now':'is no longer'} affordable`,list,['account:cash']);}
    // A market missing from one state (its data unavailable) is not a session or execution change.
    for(const m of Object.keys(next.markets)){if(!(m in base.markets))continue;const a=base.markets[m],b=next.markets[m];
      if(a.open!==b.open)add('session',`${m} market ${b.open?'opened':'closed'}`,[],['session:'+m]);
      if(a.execution!==b.execution||a.automatic!==b.automatic)add('execution',`${m} order execution ${b.execution?b.automatic?'automatic':'manual':'off'}`,[],['execution:'+m]);}
    // A decision the closed market could not carry out (electron/pending-decisions.cjs) is reassessed when it opens.
    for(const p of pending){const m=marketOf(p.symbol);if(base.markets[m]&&!base.markets[m].open&&next.markets[m]?.open)add('pending-decision',`${p.action} ${p.symbol}, decided while ${m} was closed, can be reassessed now`,[p.symbol],['quote:'+p.symbol,'account:positions','orders:'+p.symbol,'account:risk']);}
    // Risk and protection.
    if(base.risk.emergency!==next.risk.emergency||base.risk.breached!==next.risk.breached)add('risk',next.risk.emergency||next.risk.breached?'Daily loss limit reached':'Daily loss limit cleared',[],['account:risk']);
    for(const m of new Set([...Object.keys(base.risk.lossLimits??{}),...Object.keys(next.risk.lossLimits??{})]))if(base.risk.lossLimits?.[m]!==next.risk.lossLimits?.[m])add('risk',`${m} loss limit settings changed`,[],['account:risk']);
    const unprotected=next.unprotected.filter(s=>!base.unprotected.includes(s));if(unprotected.length)add('protection',`${unprotected.join(', ')} lost its stop loss`,unprotected,unprotected.map(s=>'orders:'+s));
    // Conditional orders closed after the decision, or while the review ran (after its context was read) without being
    // cancelled, such as a stop that expired or fired meanwhile; cancellations during the review are the review's own.
    const read=base.contextAt??base.at,closed=(next.closedOrders??[]).filter(o=>o.at>base.at||o.at>read&&o.status!=='cancelled');if(closed.length)add('protection',closed.map(o=>`${o.purpose} ${o.symbol} ${o.status}`).join('; '),[...new Set(closed.map(o=>o.symbol))],closed.map(o=>'orders:'+o.symbol));
    for(const k of ['investedPct','largestPct']){const a=base.exposure[k],b=next.exposure[k];if(a!=null&&b!=null&&Math.abs(b-a)>=opts.exposurePts)add('exposure',`${k==='investedPct'?'Invested share':'Largest position'} ${a}% → ${b}%`,[],['account:exposure']);}
    // Prices: cumulative since the decision, half the price-move trigger for holdings and the full trigger for
    // candidates; other quoted symbols are left to the price alerts. A quote that became unusable is degraded evidence,
    // not a reason on its own (the review would see the same gap); one that came back is a reason, since the last
    // decision was made without it.
    for(const s of [...Object.keys(next.positions),...next.candidates]){const a=base.quotes[s],b=next.quotes[s],held=s in next.positions;
      if(b?.stale||!b){if(a&&!a.stale)degraded.push(s);continue;}
      if(!a||a.stale){if(held)add('quote',`${s} price available again`,[s],['quote:'+s]);continue;}
      const pct=(b.price/a.price-1)*100,limit=held?Math.max(.1,tolerance/2):tolerance;if(Math.abs(pct)>=limit)add('price',`${s} ${pct>0?'+':''}${Math.round(pct*100)/100}% since the decision (limit ${limit}%)`,[s],['quote:'+s]);}
    if(base.reliable&&!next.reliable)degraded.push('equity');
    // Entry and invalidation levels the decision already knew, crossed since.
    for(const w of next.watches){if(!base.watches.some(x=>watchKey(x)===watchKey(w)))continue;const a=base.quotes[w.symbol]?.price,b=next.quotes[w.symbol];
      if(a>0&&b&&!b.stale&&!metAt(w,a)&&metAt(w,b.price))add('level',`${w.symbol} crossed ${w.direction} ${w.price}`,[w.symbol],['quote:'+w.symbol]);}
    // News: filings about holdings, and important items about holdings or candidates, not known at the decision.
    const relevant=new Set([...Object.keys(next.positions),...next.candidates]),seen=new Set(base.seen??[]),fresh=new Map();
    for(const e of events){const syms=(e.symbols??[]).filter(s=>relevant.has(s));if(!syms.length)continue;
      if(!(e.importance==='high'||e.kind==='disclosure'&&syms.some(s=>s in next.positions)))continue;const key=newsKey(e);if(!seen.has(key)&&!fresh.has(key))fresh.set(key,{...e,syms});}
    // Waits (electron/waits.cjs) whose check time came, or that lapsed, since the decision.
    for(const w of waits){const label=`${w.symbol}: waiting (${w.reason.replace('_',' ')})`;
      if(w.status==='active'&&w.earliestCheckAt!=null&&w.earliestCheckAt>base.at&&w.earliestCheckAt<=now)add('wait-due',`${label} reached its check time`,[w.symbol],['wait:'+w.symbol]);
      if((w.status==='active'||w.status==='expired')&&w.expiresAt>base.at&&w.expiresAt<=now)add('wait-expired',`${label} lapsed; reassess it`,[w.symbol],['wait:'+w.symbol]);}
    for(const e of fresh.values())add('news',`${e.kind==='disclosure'?'Filing':'News'}: ${String(e.title).slice(0,80)}`,e.syms,[e.receipt?'filing:'+e.receipt:'news:'+e.id]);
  }
  const changedSymbols=[...new Set(reasons.flatMap(r=>r.symbols))],requiredEvidence=[...new Set(reasons.flatMap(r=>r.evidence))];
  return {needsReview:reasons.length>0,reasons:reasons.map(({evidence,...r})=>r),changedSymbols,requiredEvidence,degraded:[...new Set(degraded)],nextBackstopAt};
}
// What kind of review this is, for the trading review (setting routineReviews 'focused'): broad when it starts trading,
// is the pre-open review, your request or an emergency, or when the gate has nothing to compare with, reached its
// backstop or saw guidelines change; routine otherwise, with what changed since the last successful decision.
const BROAD_TRIGGERS=['Auto trading started','Pre-open review','User request','Emergency loss response'];
function reviewScope(gate,trigger,base){
  const broad=BROAD_TRIGGERS.includes(trigger)?trigger:(gate.reasons.find(r=>['baseline','backstop','instructions'].includes(r.kind))?.detail??null);
  if(broad||!base)return {kind:'broad',why:broad??'No earlier decision'};
  return {kind:'routine',since:new Date(base.at).toISOString(),changes:gate.reasons.filter(r=>r.kind!=='trigger').map(r=>r.detail).slice(0,12),changedSymbols:gate.changedSymbols,...(gate.degraded.length?{degraded:gate.degraded}:{})};}
// Baselines (one per account scope, kept across restarts) and a log of every check.
class ReviewGate {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS review_gate(scope TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS review_gate_log(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,payload TEXT NOT NULL)');}
  baseline(scope){const row=this.db.prepare('SELECT payload FROM review_gate WHERE scope=?').get(scope);return row?JSON.parse(row.payload):null;}
  // After a successful decision only: a skipped or failed review leaves the baseline where it was.
  // contextAt: when the review read its context, so what happened while it ran is not taken as known.
  settle(scope,state,{at=Date.now(),contextAt=at,decision=null,events=[]}={}){
    const value={...state,at,contextAt,decision:decision?{action:decision.action??null,symbol:decision.symbol??null,orderId:decision.orderId??null}:null,seen:[...new Set(events.map(newsKey))]};
    this.db.prepare('INSERT INTO review_gate VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload').run(scope,JSON.stringify(value));return value;}
  log(at,entry){this.db.prepare('INSERT INTO review_gate_log(at,payload) VALUES(?,?)').run(at,JSON.stringify(entry));this.db.prepare('DELETE FROM review_gate_log WHERE at<?').run(at-30*86400000);}
  // Since a time: scheduled checks, what the token-saver skip and this gate did or would do, the reviews this gate
  // would add to the skips, their recorded AI cost (every call of those reviews: trading, shadow, compression, research),
  // and how often the backstop or a risk reason forced a review.
  summary(since){const rows=this.db.prepare('SELECT at,payload FROM review_gate_log WHERE at>=? ORDER BY at').all(since).map(r=>({at:r.at,...JSON.parse(r.payload)}));
    const scheduled=rows.filter(r=>r.trigger==='Scheduled review'),kinds=r=>new Set((r.gate?.reasons??[]).map(x=>x.kind));
    const extra=scheduled.filter(r=>!r.oldSkip&&r.ran&&!r.gate?.needsReview);let micro=0;
    if(extra.length){const ids=new Set(extra.map(r=>r.reviewId).filter(Boolean));for(const row of this.db.prepare('SELECT payload FROM ai_calls WHERE json_extract(payload,\'$.timestamp\')>=?').all(since)){const c=JSON.parse(row.payload);if(ids.has(c.reviewId))micro+=c.cost?.micro??0;}}
    return {since:new Date(since).toISOString(),checks:rows.length,scheduled:scheduled.length,ran:scheduled.filter(r=>r.ran).length,oldSkips:scheduled.filter(r=>r.oldSkip).length,
      gateSkips:scheduled.filter(r=>!r.gate?.needsReview).length,wouldAvoid:extra.length,estimatedUSD:Math.round(micro/1e4)/100,
      backstops:scheduled.filter(r=>kinds(r).has('backstop')).length,riskReasons:scheduled.filter(r=>kinds(r).has('risk')||kinds(r).has('protection')).length,
      degraded:scheduled.filter(r=>r.gate?.degraded?.length).length};}
}
module.exports={ReviewGate,decisionState,compare,reviewScope,newsKey,GATE_DEFAULTS,BROAD_TRIGGERS};
