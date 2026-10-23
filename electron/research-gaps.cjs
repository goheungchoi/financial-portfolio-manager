// Material data gaps that persist across reviews. A scout target waiting on missing data (condition kind "data") opens or
// continues a gap for that question; each review adds the research it ran for the symbol. A gap is one question: a
// paraphrase of the same missing evidence continues it, while a wait on different evidence for the same symbol starts a
// new count and replaces the old question. After RETRY_LIMIT reviews the gap has reached its retry limit, and reviews
// are told to stop repeating the same wait: try a source not yet tried, or say the tools cannot supply the data and
// decide under that uncertainty, or research another candidate. A verdict that no longer waits on data closes the gap.
const RETRY_LIMIT=3;
const STOP=new Set(['about','after','before','whether','which','their','there','these','those','that','this','with','from','into','than','then','what','when','where','while','will','would','could','should','does','have','has','been','being','more','most','much','many','such','them','they','only','also','enough','whose','other','latest','current','recent','data','figures','information','evidence','support','supports','supported','remains','remain','still','available','verified','verify','unverified','reported','report','results']);
// The content words of a question, for telling a paraphrase from a different question.
// Common financial synonyms map to one word, so "capital expenditure" and "capital spending" are the same evidence.
const SYNONYM={expenditure:'spending',capex:'spending',outlay:'spending',generation:'flow',generated:'flow',generate:'flow',earning:'profit',income:'profit',margin:'profit',ask:'quote',bid:'quote',book:'quote',live:'executable',tradable:'executable',revised:'guidance',corrected:'guidance',repurchase:'buyback'};
const SHORT_STOP=new Set(['the','and','for','but','not','are','was','its','has','had','any','can','how','why','who','one','two','new','now','own','per','via','yet']);
function words(text){return new Set(String(text??'').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,' ').split(/\s+/).map(w=>w.replace(/(ies)$/,'y').replace(/(?<=\w{3})s$/,'')).map(w=>SYNONYM[w]??w).filter(w=>w.length>=3&&!STOP.has(w)&&!SHORT_STOP.has(w)));}
// The same question when most of the shorter question's content words appear in the other.
function sameQuestion(a,b){const x=words(a),y=words(b);if(!x.size||!y.size)return false;let common=0;for(const w of x)if(y.has(w))common++;return common/Math.min(x.size,y.size)>=0.4;}
class ResearchGaps {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS research_gaps(scope TEXT NOT NULL,symbol TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,symbol))');}
  // verdicts: the review's planVerdicts; research: [{symbol, source}] the review requested (tool and sections).
  record(scope,verdicts,research=[]){
    const now=this.clock();const get=symbol=>{const r=this.db.prepare('SELECT payload FROM research_gaps WHERE scope=? AND symbol=?').get(scope,symbol);return r?JSON.parse(r.payload):null;};
    for(const v of verdicts??[]){if(typeof v?.symbol!=='string')continue;const open=get(v.symbol);
      if(v.verdict==='waiting'&&v.condition?.kind==='data'){
        const question=String(v.condition.unresolved??'').slice(0,240);// A paraphrase of the first wording or of the latest one continues the gap, so gradual rewording does not reset it.
        const same=Boolean(open)&&(sameQuestion(open.question??open.unresolved,question)||sameQuestion(open.unresolved,question));const prior=same?open:null;
        const tried=[...new Set([...(prior?.sourcesTried??[]),...research.filter(r=>r.symbol===v.symbol).map(r=>r.source)])].slice(-12);
        // The first wording is kept as the question's identity, so slow drift in later paraphrases is still compared to it.
        const gap={symbol:v.symbol,question:prior?.question??prior?.unresolved??question,firstSeen:prior?.firstSeen??now,lastSeen:now,reviews:(prior?.reviews??0)+1,unresolved:question,sourcesTried:tried,...(open&&!same?{replaced:{question:open.question??open.unresolved,reviews:open.reviews}}:{})};
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
module.exports={ResearchGaps,researchFromEvents,sameQuestion,RETRY_LIMIT};
