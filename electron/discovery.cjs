// Market discovery: KIS ranking screener joined with the local security master, and a per-account watchlist
// whose symbols join the review universe. Read-only; orders still go through the normal allowlist and caps.
const {KINDS}=require('./kis-rankings.cjs');
const AI_LIMIT=10,TOTAL_LIMIT=30,CACHE_MS=60000;
const krSymbol=symbol=>/^\d{6}$/.test(symbol),usSymbol=symbol=>/^(NASD|NYSE|AMEX):[A-Z][A-Z0-9.-]{0,14}$/.test(symbol);
const TYPES=['stock','etf','any'];
class Watchlist {
  constructor(db,master){this.db=db;this.master=master;db.exec('CREATE TABLE IF NOT EXISTS watchlist(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol))');}
  list(scope){return this.db.prepare('SELECT payload FROM watchlist WHERE scope=? ORDER BY rowid').all(scope).map(row=>JSON.parse(row.payload));}
  symbols(scope,market){return this.list(scope).map(row=>row.symbol).filter(market==='KR'?krSymbol:usSymbol);}
  save(scope,row){this.db.prepare('INSERT INTO watchlist VALUES(?,?,?) ON CONFLICT(scope,symbol) DO UPDATE SET payload=excluded.payload').run(scope,row.symbol,JSON.stringify(row));}
  // AI additions are capped; the oldest unpinned AI entry makes room. User entries are never evicted.
  add(scope,symbol,{source,reason=''},now=Date.now()){
    if(typeof scope!=='string'||!scope||!['user','ai'].includes(source)||typeof symbol!=='string'||!(krSymbol(symbol)||usSymbol(symbol))||typeof reason!=='string'||reason.length>300)throw new Error('INVALID_WATCHLIST');
    const known=this.master.get(symbol);if(this.master.status().total>0&&!known)throw new Error('UNKNOWN_SYMBOL');
    const rows=this.list(scope),existing=rows.find(row=>row.symbol===symbol);let evicted=null;
    if(existing){const next={...existing,reason:reason||existing.reason,source:existing.source==='user'?'user':source,pinned:existing.pinned||source==='user'};this.save(scope,next);return {entry:next,evicted};}
    if(source==='ai'){const ai=rows.filter(row=>row.source==='ai'&&!row.pinned);if(ai.length>=AI_LIMIT){evicted=ai[0].symbol;this.remove(scope,evicted);}}
    if(this.list(scope).length>=TOTAL_LIMIT)throw new Error('WATCHLIST_FULL');
    const entry={symbol,name:known?.name??symbol,market:known?.market??(krSymbol(symbol)?'KR':symbol.split(':')[0]),type:known?.type??'unknown',source,reason,pinned:source==='user',addedAt:now};this.save(scope,entry);return {entry,evicted};
  }
  remove(scope,symbol){this.db.prepare('DELETE FROM watchlist WHERE scope=? AND symbol=?').run(scope,symbol);}
  pin(scope,symbol,pinned){const row=this.list(scope).find(item=>item.symbol===symbol);if(!row)throw new Error('INVALID_WATCHLIST');this.save(scope,{...row,pinned:Boolean(pinned)});}
}
class Screener {
  constructor(request,master,clock=Date.now){this.request=request;this.master=master;this.clock=clock;this.cache=new Map();}
  static valid(q){return q&&['KR','US'].includes(q.market)&&KINDS.includes(q.kind)&&(q.market==='KR'||['NASD','NYSE','AMEX'].includes(q.exchange))&&TYPES.includes(q.type??'stock');}
  async screen(query){
    if(!Screener.valid(query))throw new Error('INVALID_REQUEST');const type=query.type??'stock',limit=Math.min(30,Math.max(1,Number.isInteger(query.limit)?query.limit:15));
    const key=JSON.stringify([query.market,query.kind,query.exchange??null]);let hit=this.cache.get(key);
    if(!hit||this.clock()-hit.retrievedAt>CACHE_MS){hit={retrievedAt:this.clock(),rows:await this.request({market:query.market,kind:query.kind,exchange:query.market==='US'?query.exchange:undefined})};this.cache.set(key,hit);}
    const rows=hit.rows.filter(row=>query.market==='KR'?krSymbol(row.symbol):usSymbol(row.symbol)).map(row=>{const known=this.master.get(row.symbol);return {...row,name:known?.name||row.name,market:known?.market??(query.market==='KR'?'KR':query.exchange),type:known?.type??'unknown'};})
      .filter(row=>type==='any'?row.type!=='warrant':row.type===type);
    return {status:'ok',source:'KIS ranking',market:query.market,exchange:query.exchange??null,kind:query.kind,type,retrievedAt:hit.retrievedAt,note:'Broker ranking snapshot; may be delayed. Symbols must be added to the watchlist before they can be traded in a later review.',rows:rows.slice(0,limit)};
  }
}
const TOOLS=[
  {type:'function',name:'screen_market',description:'List ranked candidates outside the current review universe from a KIS ranking (volume, gainers, losers, market-cap). Read-only. Add promising symbols to the watchlist to review and trade them later.',strict:true,parameters:{type:'object',properties:{market:{type:'string',enum:['KR','US']},ranking:{type:'string',enum:KINDS},exchange:{type:['string','null'],enum:['NASD','NYSE','AMEX',null]},security_type:{type:'string',enum:TYPES}},required:['market','ranking','exchange','security_type'],additionalProperties:false}},
  {type:'function',name:'search_securities',description:'Search the local KOSPI/KOSDAQ/NASDAQ/NYSE/AMEX symbol list by code, ticker or company name. Read-only.',strict:true,parameters:{type:'object',properties:{query:{type:'string'},market:{type:['string','null'],enum:['KR','US',null]}},required:['query','market'],additionalProperties:false}},
  {type:'function',name:'update_watchlist',description:'Add up to 3 symbols to, or remove AI-added symbols from, the account watchlist in one call. Watchlist symbols are quoted and included in the next review universe. This does not place orders or change limits. At most 10 AI entries; adding beyond that replaces the oldest unpinned AI entry. Give a short evidence-based reason for each.',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['add','remove']},entries:{type:'array',items:{type:'object',properties:{symbol:{type:'string'},reason:{type:'string'}},required:['symbol','reason'],additionalProperties:false}}},required:['action','entries'],additionalProperties:false}}];
const TOOL_NAMES=TOOLS.map(tool=>tool.name);
// Applies an agent update_watchlist call. The agent may add up to 3 entries and remove only its own unpinned entries.
function applyAiUpdate(watchlist,scope,args){
  if(!args||!['add','remove'].includes(args.action)||!Array.isArray(args.entries))throw new Error('INVALID_WATCHLIST');
  const results=args.entries.slice(0,3).map(item=>{const symbol=String(item?.symbol??'');
    try{if(args.action==='remove'){const row=watchlist.list(scope).find(entry=>entry.symbol===symbol);if(!row)return {symbol,status:'not-found'};if(row.source!=='ai'||row.pinned)return {symbol,status:'refused',reason:'Only unpinned AI-added entries can be removed by the agent.'};watchlist.remove(scope,symbol);return {symbol,status:'removed'};}
      const result=watchlist.add(scope,symbol,{source:'ai',reason:String(item?.reason??'').slice(0,300)});return {symbol,status:'added',name:result.entry.name,evicted:result.evicted};}
    catch(error){return {symbol,status:'rejected',reason:error.message};}});
  return {status:'ok',results,ignored:Math.max(0,args.entries.length-3)};
}
// With no allowlist, watchlist or Korean holdings, the largest listed Korean companies seed the review universe.
// With no allowlist, watchlist or holdings in a market, its largest listed companies give the AI something to review.
// Korea uses the KIS market-cap ranking; the U.S. merges the NASDAQ and NYSE rankings by market value.
class StarterCandidates {
  constructor(screener,clock=Date.now,market='KR'){this.screener=screener;this.clock=clock;this.market=market;this.state={scope:null,at:0,symbols:[]};this.active=[];}
  async rank(){
    if(this.market==='KR'){const result=await this.screener.screen({market:'KR',kind:'market-cap',type:'any',limit:20});return result.rows.filter(row=>krSymbol(row.symbol)&&row.type!=='etf').map(row=>row.symbol).slice(0,10);}
    const lists=await Promise.allSettled(['NASD','NYSE'].map(exchange=>this.screener.screen({market:'US',kind:'market-cap',exchange,type:'any',limit:20})));
    const rows=lists.filter(r=>r.status==='fulfilled').flatMap(r=>r.value.rows).filter(row=>usSymbol(row.symbol)&&row.type!=='etf');
    if(!rows.length&&lists.every(r=>r.status==='rejected'))throw lists[0].reason;
    return [...new Set(rows.sort((a,b)=>(b.marketCap??0)-(a.marketCap??0)).map(row=>row.symbol))].slice(0,10);
  }
  async symbols({scope,watched=[],allowed=[],holdings=[]}){
    this.active=[];const own=this.market==='KR'?krSymbol:usSymbol;
    if(!scope||watched.length||allowed.length||holdings.some(own))return watched;
    const age=this.clock()-this.state.at;
    if(this.state.scope!==scope||age>(this.state.symbols.length?6*3600000:15*60000)){
      let symbols=[];try{symbols=await this.rank();}catch{}
      this.state={scope,at:this.clock(),symbols};
    }
    this.active=this.state.symbols;return this.active;
  }
  current(scope){return this.state.scope===scope?this.active:[];}
}
module.exports={Watchlist,Screener,StarterCandidates,TOOLS,TOOL_NAMES,AI_LIMIT,applyAiUpdate};
