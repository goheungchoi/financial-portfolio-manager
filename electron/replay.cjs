// Replay: re-run saved review contexts with a change (extra instructions, or without the narrative or episodes) next to an
// unchanged baseline, then compare both decisions with what prices did afterwards. The change is the only difference.
const {randomUUID}=require('node:crypto');
const LIMITS={reviews:12,instructions:1500,keepContexts:300};
const HORIZON=5;
class ReplayStore {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS routing_eval(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,account TEXT,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS review_contexts(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS replay_runs(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,payload TEXT NOT NULL)');}
  saveContext(id,context){try{this.db.prepare('INSERT INTO review_contexts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,this.clock(),JSON.stringify(context));// Contexts behind the stored shadow-evaluation pairs are kept: shadow evaluation was removed in step A1 (2026-11-12) and
    // its records stay until they are archived to a file; until then these contexts are their frozen inputs.
    this.db.prepare('DELETE FROM review_contexts WHERE id NOT IN (SELECT id FROM review_contexts ORDER BY timestamp DESC LIMIT ?) AND id NOT IN (SELECT id FROM routing_eval)').run(LIMITS.keepContexts);}catch{}}
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

// C1, replay on Claude (artifacts/reviews/2026-11-13-c1-replay/review.md, R1 to R6). Estimates, not measurements: from
// one measured Claude run (the user's dry run of 2026-11-13 00:21 KST, 1.5.56): about 2.6 bytes per token; a replay
// request (research off, no tools) carries the instructions and the shape, about 15,000 tokens, cached after the run's
// first request, and the saved context, uncached; the measured decision wrote about 2,500 tokens. The OpenAI baseline
// is estimated the same way (about 12,000 tokens of instructions, about 1,500 written), with no cache.
const EST=Object.freeze({basis:'Estimate from one measured Claude run (2026-11-13)',bytesPerToken:2.6,claudeSystemTokens:15000,claudeOutputTokens:2500,openaiSystemTokens:12000,openaiOutputTokens:1500});
function estimateMicro(model,contextBytes,{first=false}={}){
  const rate=require('./ai-models.cjs').MODELS[model];if(!rate)return null;const ctx=Math.ceil(contextBytes/EST.bytesPerToken);
  if(rate.vendor==='anthropic')return Math.round(ctx*rate.input+(first?EST.claudeSystemTokens*rate.write:EST.claudeSystemTokens*rate.cached)+EST.claudeOutputTokens*rate.output);
  return Math.round((ctx+EST.openaiSystemTokens)*rate.input+EST.openaiOutputTokens*rate.output);
}
const usd=m=>m==null?null:Math.round(m)/1e6;
// Markdown markers in an explanation (R8: counted, not a failure).
const markdown=t=>typeof t==='string'&&(/\*\*[^*]+\*\*/.test(t)||/^\s*[-*] \S/m.test(t)||/^\s*#{1,6} \S/m.test(t));
// The Claude run's counts (R1, R2): answers received, accepted, not accepted by rule, refused, uncertain; measured cost
// and time beside the estimate. Counts only, never a percentage alone; no ranking of the models from a handful of rows.
// byRule holds the app's rule texts (local only: the run is stored, the log line gets counts without it).
function claudeSummary(rows,{estimate=null,stopped=null,capMicro=null}={}){
  const sides=rows.map(r=>r.variant);const failure=k=>sides.filter(s=>s.failure?.kind===k);
  const accepted=sides.filter(s=>s.decision&&!s.failure).length,notAccepted=failure('not-accepted'),received=accepted+notAccepted.length;
  const byRule={};for(const s of notAccepted){const k=s.failure.rule??s.failure.code;byRule[k]=(byRule[k]??0)+1;}
  const sum=(list,f)=>list.reduce((n,x)=>n+(Number.isFinite(f(x))?f(x):0),0);
  const claudeMicro=sum(sides,s=>s.usage?.costMicro),openaiMicro=sum(rows.map(r=>r.baseline),s=>s.usage?.costMicro);
  const ms=sides.map(s=>s.usage?.ms).filter(Number.isFinite);
  // The enforced decision form (E1, E3): how many answers came in it, how many fell back to text, and dropped text parts.
  const answered=sides.filter(s=>s.usage&&(s.decision||s.failure?.kind==='not-accepted'));const dropped={};for(const s of sides)for(const k of s.usage?.textPartsDropped??[])dropped[k]=(dropped[k]??0)+1;
  return {answers:{received,accepted,notAccepted:notAccepted.length,byRule,refused:failure('refused').length,uncertain:failure('uncertain').length,limit:failure('limit').length,stopped:failure('stopped').length},
    basis:`From ${received} replayed answer${received===1?'':'s'}, without research rounds`,formatFailures:`${notAccepted.length} of ${received}`,
    markdown:`${sides.filter(s=>s.decision&&markdown(s.explanation)).length} of ${accepted}`,
    form:{enforced:`${answered.filter(s=>s.usage.answerForm==='enforced').length} of ${answered.length}`,fellBack:sides.filter(s=>s.usage?.formFallback).length,textPartsDropped:dropped},
    comparison:'Too few to compare',
    measured:{claudeUSD:usd(claudeMicro),openaiUSD:usd(openaiMicro),totalUSD:usd(claudeMicro+openaiMicro),claudeSecondsAvg:ms.length?Math.round(ms.reduce((a,b)=>a+b,0)/ms.length/100)/10:null},
    ...(estimate?{estimate:{claudeUSD:estimate.claudeUSD,openaiUSD:estimate.openaiUSD,totalUSD:estimate.totalUSD,basis:estimate.basis}}:{}),
    ...(capMicro!=null?{capUSD:usd(capMicro)}:{}),...(stopped?{stopped}:{})};
}
// Each row records the text of each side (instruction rewrite design 6): the set's version and the parts its context was
// given, and which context fields the replay filled, so a run is never read as a comparison of something it was not.
function textOf(pick,variant){const RI=require('./review-instructions.cjs');const side=(context,set)=>({version:RI.setOf(set).version,parts:RI.partsFor(context)});
  return {instructions:{baseline:side(pick.context),variant:side(applyVariant(pick.context,variant),variant.proposedText?'proposed':undefined)},...(pick.filled?{filled:pick.filled}:{})};}
module.exports={ReplayStore,applyVariant,textOf,outcome,candidates,summarize,brief,LIMITS,HORIZON,EST,estimateMicro,claudeSummary,markdown,newId:()=>'R-'+randomUUID().slice(0,6)};
