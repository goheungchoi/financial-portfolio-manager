// Material data gaps that persist across reviews. A scout target waiting on missing data (condition kind "data") opens or
// continues a gap; each review adds the research it ran for that symbol. After RETRY_LIMIT reviews the gap is marked as
// having reached its retry limit, and reviews are told to stop repeating the same wait: try a source not yet tried, or
// say the tools cannot supply the data and decide under that uncertainty, or research another candidate. A review whose
// verdict for the symbol no longer waits on data closes the gap.
const RETRY_LIMIT=3;
class ResearchGaps {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS research_gaps(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol))');}
  // verdicts: the review's planVerdicts; research: [{symbol, source}] the review requested (tool and sections).
  record(scope,verdicts,research=[]){
    const now=this.clock();const get=symbol=>{const r=this.db.prepare('SELECT payload FROM research_gaps WHERE scope=? AND symbol=?').get(scope,symbol);return r?JSON.parse(r.payload):null;};
    for(const v of verdicts??[]){if(typeof v?.symbol!=='string')continue;const open=get(v.symbol);
      if(v.verdict==='waiting'&&v.condition?.kind==='data'){
        const tried=[...new Set([...(open?.sourcesTried??[]),...research.filter(r=>r.symbol===v.symbol).map(r=>r.source)])].slice(-12);
        const gap={symbol:v.symbol,firstSeen:open?.firstSeen??now,lastSeen:now,reviews:(open?.reviews??0)+1,unresolved:String(v.condition.unresolved??'').slice(0,240),sourcesTried:tried};
        this.db.prepare('INSERT INTO research_gaps VALUES(?,?,?) ON CONFLICT(scope,symbol) DO UPDATE SET payload=excluded.payload').run(scope,v.symbol,JSON.stringify(gap));}
      else if(open)this.db.prepare('DELETE FROM research_gaps WHERE scope=? AND symbol=?').run(scope,v.symbol);}
  }
  context(scope){return this.db.prepare('SELECT payload FROM research_gaps WHERE scope=?').all(scope).map(r=>JSON.parse(r.payload)).sort((a,b)=>b.reviews-a.reviews).slice(0,10)
    .map(g=>({symbol:g.symbol,reviews:g.reviews,since:new Date(g.firstSeen).toISOString(),unresolved:g.unresolved,sourcesTried:g.sourcesTried,status:g.reviews>=RETRY_LIMIT?'retry limit reached':'retrying'}));}
}
// The research a review asked for, from its logged requests: {symbol, source} such as "get_company_research:financials+risk".
function researchFromEvents(events){
  return events.flatMap(e=>{if(!['Discovery request','Market data request'].includes(e.title))return [];let a;try{a=JSON.parse(e.body);}catch{return [];}
    if(typeof a?.symbol!=='string')return [];const what=Array.isArray(a.sections)?a.sections.slice().sort().join('+'):a.dataset??'';
    return [{symbol:a.symbol,source:`${e.title==='Market data request'?'get_market_evidence':'get_company_research'}:${what}`}];});
}
module.exports={ResearchGaps,researchFromEvents,RETRY_LIMIT};
