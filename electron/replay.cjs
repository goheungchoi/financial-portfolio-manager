// Replay: re-run saved review contexts with a change (extra instructions, or without the narrative or episodes) next to an
// unchanged baseline, then compare both decisions with what prices did afterwards. The change is the only difference.
const {randomUUID}=require('node:crypto');
const LIMITS={reviews:12,instructions:1500,keepContexts:300};
const HORIZON=5;
class ReplayStore {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS review_contexts(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS replay_runs(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL)');}
  saveContext(id,context){try{this.db.prepare('INSERT INTO review_contexts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,this.clock(),JSON.stringify(context));this.db.prepare('DELETE FROM review_contexts WHERE id NOT IN (SELECT id FROM review_contexts ORDER BY timestamp DESC LIMIT ?)').run(LIMITS.keepContexts);}catch{}}
  context(id){const row=this.db.prepare('SELECT payload FROM review_contexts WHERE id=?').get(id);return row?JSON.parse(row.payload):null;}
  saveRun(run){this.db.prepare('INSERT INTO replay_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.id,run.timestamp,JSON.stringify(run));this.db.prepare('DELETE FROM replay_runs WHERE id NOT IN (SELECT id FROM replay_runs ORDER BY timestamp DESC LIMIT 20)').run();return run;}
  runs(){return this.db.prepare('SELECT payload FROM replay_runs ORDER BY timestamp DESC').all().map(r=>JSON.parse(r.payload));}
}
// The variant: extra instructions appended to the guidelines, and optionally sections removed.
function applyVariant(context,variant){
  const c=structuredClone(context);
  if(variant.instructions)c.userGuidelines=`${c.userGuidelines??''}\n\nReplay variant instructions: ${variant.instructions}`.trim();
  if(variant.withoutNarrative){delete c.marketNarrative;delete c.similarEpisodes;}
  if(variant.withoutEpisodes)delete c.similarEpisodes;
  if(variant.withoutRegime){delete c.marketRegime;delete c.positionSizing;}
  return c;
}
// Signed excess return over the next trading days: a Buy gains with the stock against the benchmark, a Sell with its fall; Hold is zero.
function outcome(decision,day,closes,benchmark){
  if(!decision||decision.action==='Hold'||!decision.symbol)return {excessPct:0,basis:'hold'};
  const c=(closes??[]).filter(r=>r.close>0),b=(benchmark??[]).filter(r=>r.close>0);const i=c.findIndex(r=>r.date>=day);if(i<0||!c[i+HORIZON])return {excessPct:null,basis:'waiting'};
  const stock=c[i+HORIZON].close/c[i].close-1;const from=b.filter(r=>r.date<=c[i].date).at(-1),to=b.filter(r=>r.date<=c[i+HORIZON].date).at(-1);
  const market=from&&to?to.close/from.close-1:0;const sign=decision.action==='Buy'?1:-1;return {excessPct:Math.round(sign*(stock-market)*10000)/100,basis:`${HORIZON} trading days`};
}
const brief=d=>d?{action:d.action,symbol:d.symbol||null,quantity:d.quantity||0}:null;
// Picks recent reviews with a saved context; logged contexts from before saving began are used when they parse, marked approximate.
function candidates({reviews,store,events,from,to,limit}){
  const out=[];for(const r of reviews){const day=new Date(r.timestamp+9*3600000).toISOString().slice(0,10);if(from&&day<from||to&&day>to)continue;if(r.provider!=='openai')continue;
    let context=store.context(r.id),approximate=false;if(!context){const logged=events.find(e=>e.runId===r.id&&e.title==='Supplied context');try{context=logged?JSON.parse(logged.body):null;approximate=Boolean(context);}catch{context=null;}}
    if(context&&Array.isArray(context.universe))out.push({review:r,day,context,approximate});if(out.length>=limit)break;}
  return out;
}
function summarize(rows){
  const scored=rows.filter(r=>r.baseline.outcome.excessPct!=null&&r.variant.outcome.excessPct!=null);const sum=k=>Math.round(scored.reduce((s,r)=>s+r[k].outcome.excessPct,0)*100)/100;
  return {reviews:rows.length,changed:rows.filter(r=>r.changed).length,scored:scored.length,baselineExcessPct:sum('baseline'),variantExcessPct:sum('variant'),originalDiffers:rows.filter(r=>JSON.stringify(r.original)!==JSON.stringify(r.baseline.decision)).length,
    note:`Excess returns are summed over decisions with ${HORIZON} trading days of prices after them. With few reviews the difference is mostly noise.`};
}
module.exports={ReplayStore,applyVariant,outcome,candidates,summarize,brief,LIMITS,HORIZON,newId:()=>'R-'+randomUUID().slice(0,6)};
