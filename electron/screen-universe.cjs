'use strict';
// Universes and the data a screening script sees (note 6, S2). Public market data only.
// - Universes: by market (KOSPI, KOSDAQ, NASD, NYSE, AMEX, KR, US), type (stock, etf, any) and size (top_cap: the
//   largest by market value; Korea from the security master, the U.S. from the Nasdaq size order), or the app's own
//   lists (own = holdings, watchlist, plan, allowlist). At most 400 stocks. U.S. ETFs have no size order, so a U.S.
//   universe of ETFs is refused with words, and a U.S. universe of any type holds stocks only, with a note.
// - The data contract (formula-script.cjs header): every screen is as of the last completed close per market (Q4).
//   For each stock, price is that day's close and the history the closes before it; a newer close already read is not
//   used, and a stock whose newest close is older than that day is stale. price() in a screen is not a live quote.
// - The nightly set: your holdings, plan targets, watchlist and allowlists, then symbols scripts asked for, then the
//   largest N stocks of each exchange (N the setting), taken in turn by rank so a part-filled night covers every
//   exchange, and the largest N Korean ETFs when the ETF switch is on.
const {asOfDay,marketOf,KEEP}=require('./history-store.cjs');
const SYMBOL=/^(\d{6}|(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14})$/;
const KR_MARKETS=['KOSPI','KOSDAQ'],US_EXCHANGES=['NASD','NYSE','AMEX'];
const OWN=['holdings','watchlist','plan','allowlist'];
const MAX=400,SIZE_OLD_DAYS=7;
const valid=list=>[...new Set((list??[]).filter(s=>typeof s==='string'&&SYMBOL.test(s)))];
// deps: {db (the security master's), store (HistoryStore), usSize (UsSizeOrder), own(kind) → symbols, settings() →
// {perExchange, etfs}, closedDays(), clock}.
function krTop(db,markets,types,n){if(!n)return [];return db.prepare(`SELECT symbol FROM securities WHERE market IN (${markets.map(()=>'?').join(',')}) AND type IN (${types.map(()=>'?').join(',')}) AND marketCap IS NOT NULL ORDER BY marketCap DESC,symbol LIMIT ?`)
  .all(...markets,...types,n).map(r=>r.symbol);}
function nightlySet(deps){const {perExchange,etfs}=deps.settings();const n=Math.min(MAX,perExchange);
  const own=OWN.flatMap(kind=>{try{return deps.own(kind)??[];}catch{return [];}});
  const lists=[...KR_MARKETS.map(m=>krTop(deps.db,[m],['stock'],n)),...US_EXCHANGES.map(e=>deps.usSize.top(e,n)?.symbols??[]),...(etfs?[krTop(deps.db,KR_MARKETS,['etf'],n)]:[])];
  const turns=[];for(let i=0;i<n;i++)for(const l of lists)if(i<l.length)turns.push(l[i]);
  return valid([...own,...deps.store.requested(deps.clock()),...turns]);}
// One run's context for formula-script.run, the as-of day per market, the store's depth, and finish() that records the
// symbols a script named with no history (the next night reads them, at most 100).
function screenContext(deps){const now=deps.clock();const closed=deps.closedDays?.()??new Set();
  const asOf={KR:asOfDay('KR',now,closed),US:asOfDay('US',now,closed)};const missing=new Set();const rowsOf=new Map();
  const rows=s=>{if(rowsOf.has(s))return rowsOf.get(s);const day=asOf[marketOf(s)];const r=day?deps.store.closes(s).filter(x=>x.date<=day):[];if(!r.length)missing.add(s);rowsOf.set(s,r);return r;};
  const data={price:s=>rows(s).at(-1)?.close??null,closes:s=>{const r=rows(s);return r.length>1?r.slice(0,-1):null;},previousClose:s=>rows(s).at(-2)?.close??null};
  const isStale=s=>{const r=rows(s);return Boolean(r.length&&r.at(-1).date<asOf[marketOf(s)]);};
  const names=s=>{try{return deps.db.prepare('SELECT name FROM securities WHERE symbol=?').get(s)?.name??null;}catch{return null;}};
  const universe=spec=>universeFor(deps,spec,now);
  // Only codes the security master lists are asked for, so an unknown code never reaches the nightly reads.
  const finish=()=>{const outside=new Set(nightlySet(deps));const ask=[...missing].filter(s=>!outside.has(s)&&listed(deps.db,s)).slice(0,100);if(ask.length)deps.store.request(ask,now);return ask.length;};
  return {ctx:{data,isStale,names,universe},asOf,depth:symbols=>deps.store.depth(symbols),finish,keep:KEEP};}
function universeFor(deps,spec,now){const n=Math.min(MAX,spec.top_cap??deps.settings().perExchange);const type=spec.type??'stock';
  if(!['stock','etf','any'].includes(type))return {refused:'UNKNOWN_UNIVERSE'};
  // Your own lists, optionally by market and type; cut to top_cap (default the setting) with a note saying so.
  if(spec.own!=null){if(!OWN.includes(spec.own))return {refused:'UNKNOWN_UNIVERSE'};const m=spec.market;
    if(m!=null&&!['KR','US',...KR_MARKETS,...US_EXCHANGES].includes(m))return {refused:'UNKNOWN_UNIVERSE'};let list=[];try{list=valid(deps.own(spec.own));}catch{}
    if(m)list=list.filter(s=>m==='KR'?marketOf(s)==='KR':m==='US'?marketOf(s)==='US':US_EXCHANGES.includes(m)?s.startsWith(m+':'):marketOf(s)==='KR'&&krMarket(deps.db,s)===m);
    if(spec.type&&type!=='any')list=list.filter(s=>typeOf(deps.db,s)===type);
    return {name:spec.own,symbols:list.slice(0,n),...(list.length>n?{note:`${n} of the ${list.length} in ${spec.own} (top_cap)`}:{})};}
  const m=spec.market;if(!m)return {refused:'UNKNOWN_UNIVERSE'};
  const typeName=type==='any'?'stocks and ETFs':type==='etf'?'ETFs':'stocks';
  if(m==='KR'||KR_MARKETS.includes(m)){const types=type==='any'?['stock','etf']:[type];return {name:`${m} top ${n} ${typeName}`,symbols:valid(krTop(deps.db,m==='KR'?KR_MARKETS:[m],types,n))};}
  if(m==='US'||US_EXCHANGES.includes(m)){if(type==='etf')return {refused:'SIZE_ORDER_UNAVAILABLE'};const top=deps.usSize.top(m,n);if(!top)return {refused:'SIZE_ORDER_UNAVAILABLE'};
    const days=Math.floor((now-top.at)/86400000);const notes=[];if(type==='any')notes.push('U.S. ETFs are not included: they have no size order');if(days>SIZE_OLD_DAYS)notes.push(`the U.S. size order is ${days} days old`);
    return {name:`${m} top ${n} stocks`,symbols:valid(top.symbols),...(notes.length?{note:notes.join('; ')}:{})};}
  return {refused:'UNKNOWN_UNIVERSE'};}
function krMarket(db,s){try{return db.prepare('SELECT market FROM securities WHERE symbol=?').get(s)?.market??null;}catch{return null;}}
function typeOf(db,s){try{return db.prepare('SELECT type FROM securities WHERE symbol=?').get(s)?.type??null;}catch{return null;}}
const listed=(db,s)=>{try{return Boolean(db.prepare('SELECT 1 FROM securities WHERE symbol=?').get(s));}catch{return false;}};
module.exports={nightlySet,screenContext,universeFor,krTop,OWN};
