// Material data gaps that persist across reviews. A scout target waiting on missing data (condition kind "data") opens or
// continues a gap; each review adds the research it ran for the symbol. A gap's identity is structured: the symbol and
// the missing evidence named in the verdict's dataGap (metric, reporting period, document), as a persistent gap id. The
// wording of the question is kept for reading but never decides identity, so "operating income" and "net income" are
// two gaps however similar the sentences. Without structured fields the exact normalized wording is the identity. A
// different gap for the same symbol starts a new count and replaces the old one. After RETRY_LIMIT reviews the gap has
// reached its retry limit, and reviews are told to stop repeating the same wait: try a source not yet tried, or say the
// tools cannot supply the data and decide under that uncertainty, or research another candidate. A verdict that no
// longer waits on data closes the gap.
const {createHash}=require('node:crypto');
const RETRY_LIMIT=3;
// Lowercase words without punctuation or a plural s; only exact abbreviations are expanded.
const ABBREVIATION={capex:'capital expenditure',fcf:'free cash flow',eps:'earnings per share'};
const norm=text=>String(text??'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,'').split(/\s+/).filter(Boolean).map(w=>ABBREVIATION[w]??w).join(' ').split(' ').map(w=>w.length>3?w.replace(/s$/,''):w).join(' ');
// A period's words in any order: "Q3 2026" and "2026 Q3" are the same period.
const period=text=>norm(text).split(' ').filter(Boolean).sort().join(' ');
// The gap's identity for a symbol's data wait: {id, metric, period, document}.
function gapIdentity(symbol,verdict){
  const g=verdict?.dataGap??{};const metric=norm(g.metric),when=period(g.period),document=norm(g.document);
  const key=metric?`${symbol}|${metric}|${when}|${document}`:`${symbol}|text|${norm(verdict?.condition?.unresolved)}`;
  return {id:createHash('sha256').update(key).digest('hex').slice(0,16),metric,period:when,document};
}
class ResearchGaps {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS research_gaps(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol))');}
  // verdicts: the review's planVerdicts; research: [{symbol, source}] the review requested (tool and sections).
  record(scope,verdicts,research=[]){
    const now=this.clock();const get=symbol=>{const r=this.db.prepare('SELECT payload FROM research_gaps WHERE scope=? AND symbol=?').get(scope,symbol);return r?JSON.parse(r.payload):null;};
    for(const v of verdicts??[]){if(typeof v?.symbol!=='string')continue;const open=get(v.symbol);
      if(v.verdict==='waiting'&&v.condition?.kind==='data'){
        const identity=gapIdentity(v.symbol,v);const prior=open?.id===identity.id?open:null;
        const tried=[...new Set([...(prior?.sourcesTried??[]),...research.filter(r=>r.symbol===v.symbol).map(r=>r.source)])].slice(-12);
        const gap={...identity,symbol:v.symbol,firstSeen:prior?.firstSeen??now,lastSeen:now,reviews:(prior?.reviews??0)+1,unresolved:String(v.condition.unresolved??'').slice(0,240),sourcesTried:tried,...(open&&!prior?{replaced:{id:open.id??null,metric:open.metric??null,unresolved:open.unresolved,reviews:open.reviews}}:{})};
        this.db.prepare('INSERT INTO research_gaps VALUES(?,?,?) ON CONFLICT(scope,symbol) DO UPDATE SET payload=excluded.payload').run(scope,v.symbol,JSON.stringify(gap));}
      else if(open)this.db.prepare('DELETE FROM research_gaps WHERE scope=? AND symbol=?').run(scope,v.symbol);}
  }
  context(scope){return this.db.prepare('SELECT payload FROM research_gaps WHERE scope=?').all(scope).map(r=>JSON.parse(r.payload)).sort((a,b)=>b.reviews-a.reviews).slice(0,10)
    .map(g=>({id:g.id??null,symbol:g.symbol,...(g.metric?{metric:g.metric,period:g.period,document:g.document}:{}),reviews:g.reviews,since:new Date(g.firstSeen).toISOString(),unresolved:g.unresolved,sourcesTried:g.sourcesTried,status:g.reviews>=RETRY_LIMIT?'retry limit reached':'retrying'}));}
}
// The research a review asked for, from its logged requests: {symbol, source} such as "get_company_research:financials+risk".
function researchFromEvents(events){
  return events.flatMap(e=>{if(!['Discovery request','Market data request'].includes(e.title))return [];let a;try{a=JSON.parse(e.body);}catch{return [];}
    if(typeof a?.symbol!=='string')return [];const what=Array.isArray(a.sections)?a.sections.slice().sort().join('+'):a.dataset??'';
    return [{symbol:a.symbol,source:`${e.title==='Market data request'?'get_market_evidence':'get_company_research'}:${what}`}];});
}
module.exports={ResearchGaps,researchFromEvents,gapIdentity,RETRY_LIMIT};
