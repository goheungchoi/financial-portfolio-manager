'use strict';
// Prices for armed conditional orders (orders while stopped, B-1; artifacts/reviews/2026-11-24-orders-while-stopped).
// The 5-second watch checks armed orders against quotes. An armed order whose own stock or whose conditions' stocks were
// outside the app's polls had no price and could never fire, running or not (found while writing the build note). Now:
// - the watch (and the trailing stops) read their own view: per stock the newer of the polled quote and the copy read for
//   the watch, and nothing older than 2 minutes (watchQuotes). Every other reader of prices (reviews, compute, triggers,
//   the scout, the order tracker, plan trails) sees the polled quotes only, as before;
// - a reader keeps those copies current: one stock a step, at most one read every SPACING_MS per market, always the
//   stock whose usable copy is oldest (none counts as oldest; ties in the order armed), so all degrade evenly when there
//   are more than it can keep fresh; a step only reads while that market is open, no order is being sent, KIS's queue is
//   idle and none of the app's own jobs falls due within 2 s, and it never starts another job;
// - when an order fires, every stock its conditions read comes from a read made for that check (the engine's fresh read,
//   or one read now) and at most FIRE_FRESH_MS old by its own time; otherwise no order, never a stored copy.
// Nothing is read while no conditional order is watched.
const MAX_AGE_MS=120000,PERSIST_MS=30000,GRACE_MS={KR:45000,US:90000},REFRESH_MS={KR:45000,US:90000};
const SPACING_MS=3000,FIRE_READS=8,FIRE_FRESH_MS=60000;
const marketOf=s=>String(s).includes(':')?'US':'KR';
const RE={KR:/^\d{6}$/,US:/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/};
// Every stock an armed order reads: its own and those its conditions name (parsed as the watch parses them).
function orderSymbols(order){const out=new Set();if(typeof order?.symbol==='string')out.add(order.symbol);
  for(const c of Array.isArray(order?.conditions)?order.conditions:[]){try{for(const s of require('./formula.cjs').parse(c.expr).symbols??[])out.add(s);}catch{}}
  return [...out];}
function symbolsOf(orders,market){const re=RE[market];return [...new Set((Array.isArray(orders)?orders:[]).flatMap(orderSymbols).filter(s=>re.test(s)))];}
// A quote's time: the stream's arrival, else the REST read time, else its own timestamp.
const quoteTime=q=>{for(const t of [q?.receivedAt,q?.retrievedAt,q?.timestamp])if(Number.isFinite(t))return t;return NaN;};
// The watch's view of the watched stocks: per stock the newer of `polled` and `armed` by time, dropped when older than
// MAX_AGE_MS (then the stock has no price for the watch, and Home says so). Stocks not watched are left as polled.
function watchQuotes(polled,armed,watched,now=Date.now()){const W=new Set(watched??[]);const out=new Map();
  // An entry dated more than 5 s ahead of the clock is left out before the newer is chosen, so it never hides a fresh one.
  const ahead=q=>quoteTime(q)>now+5000;
  for(const q of Array.isArray(polled)?polled:[]){if(!q?.symbol)continue;if(!W.has(q.symbol)){out.set(q.symbol,q);continue;}if(ahead(q))continue;const p=out.get(q.symbol);if(!p||!(quoteTime(p)>=quoteTime(q)))out.set(q.symbol,q);}
  for(const q of armed instanceof Map?armed.values():Array.isArray(armed)?armed:[]){if(!q?.symbol||!W.has(q.symbol)||ahead(q))continue;const p=out.get(q.symbol);if(!p||quoteTime(q)>quoteTime(p))out.set(q.symbol,q);}
  for(const s of W){const q=out.get(s);if(q&&(!(q.price>0)||!Number.isFinite(quoteTime(q))||now-quoteTime(q)>MAX_AGE_MS||quoteTime(q)>now+5000))out.delete(s);}
  return [...out.values()];}
// The watched stocks the reader should read (no usable watch quote, or one older than its market's refresh age), the
// stalest first by the time of the latest copy known, even one too old to use (`lastRead`: symbol → time), so that past
// capacity every stock still comes round in turn; never read first; ties in the order armed (`watched`'s order).
function needs(watched,view,now=Date.now(),lastRead=new Map()){const by=new Map((view??[]).map(q=>[q.symbol,q]));
  const list=(watched??[]).map((s,i)=>{const q=by.get(s);const t=q?quoteTime(q):-Infinity;const known=Number(lastRead.get?.(s));return {s,i,t,k:Number.isFinite(known)?Math.max(known,t):t};});
  return list.filter(x=>!(x.t>-Infinity)||now-x.t>REFRESH_MS[marketOf(x.s)]).sort((a,b)=>a.k-b.k||a.i-b.i).map(x=>x.s);}
// A quote at most FIRE_FRESH_MS old by its own time (a fire's test of fresh).
const freshEnough=(q,now=Date.now())=>{const t=quoteTime(q);return q?.price>0&&Number.isFinite(t)&&now-t<=FIRE_FRESH_MS&&t<=now+5000;};
// The watched stocks with no usable price while their market is open.
function staleArmed(armed,view,{now=Date.now(),open=()=>true}={}){const by=new Set((view??[]).map(q=>q?.symbol));
  return [...new Set(armed??[])].filter(s=>{let o=false;try{o=Boolean(open(marketOf(s),now));}catch{}return o&&!by.has(s);});}
// The Home line's list: a stock is named once it had no price on checks at least PERSIST_MS apart (one skipped poll never
// names it) and was watched for longer than its market's first read takes (GRACE_MS: nothing right after arming or Start).
class StaleTracker{constructor(){this.since=new Map();this.watched=new Map();}
  update(armed,stale,now=Date.now()){const live=new Set(armed);for(const s of [...this.watched.keys()])if(!live.has(s))this.watched.delete(s);for(const s of live)if(!this.watched.has(s))this.watched.set(s,now);
    const bad=new Set(stale);for(const s of [...this.since.keys()])if(!bad.has(s))this.since.delete(s);for(const s of bad)if(!this.since.has(s))this.since.set(s,now);return this.shown(now);}
  shown(now=Date.now()){return [...this.since.entries()].filter(([s,t])=>now-t>=PERSIST_MS&&now-(this.watched.get(s)??now)>=GRACE_MS[marketOf(s)]).map(([s])=>s);}
  added(armed){return (Array.isArray(armed)?armed:[]).filter(s=>!this.watched.has(s));}}
// One quote, its own request: Korea 'quotes' for one code, the U.S. 'us-quote' with the session switches. null on failure.
async function readOne(request,symbol,sessions){try{if(marketOf(symbol)==='KR'){const r=await request('quotes',{symbols:[symbol]});const q=Array.isArray(r)?r.find(x=>x?.symbol===symbol):null;return q?.price>0?q:null;}
  const q=await request('us-quote',{symbol,sessions});return q?.symbol===symbol&&q.price>0?q:null;}catch{return null;}}
// The reader, stepped by main.cjs's 1-second loop: each step reads at most one stock of that market, the stalest needed
// one, when allowed. deps: request; need(market, now) → the stocks to read, stalest first; allowed(market, now) → the
// market open, no order being sent, KIS's queue idle, no job of the app's due within 2 s; accept(quote); clock. It
// never calls anything but request.
function createReader({request,need,allowed=()=>true,accept,attempted=()=>{},sessions=()=>({}),clock=Date.now}){const st={KR:{at:-Infinity,busy:false},US:{at:-Infinity,busy:false}};
  return async(market,still=()=>true)=>{const s=st[market],now=clock();if(s.busy||now-s.at<SPACING_MS)return null;
    let want=[];try{want=need(market,now)??[];}catch{}if(!want.length)return null;let ok=false;try{ok=Boolean(allowed(market,now));}catch{}if(!ok)return null;
    const symbol=want[0];s.busy=true;s.at=now;try{const q=await readOne(request,symbol,sessions());if(!still())return symbol;if(q)accept(q);try{attempted(symbol,Boolean(q),now);}catch{}return symbol;}finally{s.busy=false;}};}
// A fire's reads for the stocks its engine read did not quote: at most FIRE_READS, one request each. Returns the quotes read
// that are fresh by their own time (a stock not read, or read old, is missing; the caller then sends nothing).
async function readFresh(request,symbols,sessions={},clock=Date.now){const out=[];for(const s of [...new Set(symbols??[])].slice(0,FIRE_READS)){const q=await readOne(request,s,sessions);if(q&&freshEnough(q,clock()))out.push(q);}return out;}
const RETRY_FAILED_MS=60000;
module.exports={RETRY_FAILED_MS,orderSymbols,symbolsOf,quoteTime,watchQuotes,needs,freshEnough,staleArmed,StaleTracker,readOne,createReader,readFresh,MAX_AGE_MS,PERSIST_MS,GRACE_MS,REFRESH_MS,SPACING_MS,FIRE_READS,FIRE_FRESH_MS,RE};
