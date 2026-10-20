// Routing evaluation report (docs/ROUTING-EVALUATION.md). Reads the app database read-only and the adjudication file,
// replays the frozen router in time order and applies the approved criteria.
//   node scripts/routing-report.cjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--threshold N] [--db path] [--adjudications path]
// Prospective records only; historical replays or paper portfolios must be reported separately.
const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {simulate}=require('../electron/routing-sim.cjs');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:fallback;};
// One-sided 95% Clopper-Pearson upper bound on a binomial proportion (x events in n trials).
function upperBound(x,n,alpha=0.05){if(!n)return null;if(x>=n)return 1;let lo=x/n,hi=1;
  const cdf=p=>{let term=Math.pow(1-p,n),sum=term;for(let k=1;k<=x;k++){term*=(n-k+1)/k*p/(1-p);sum+=term;}return sum;};
  for(let i=0;i<80;i++){const mid=(lo+hi)/2;if(cdf(mid)>alpha)lo=mid;else hi=mid;}return hi;}
const {createHash}=require('node:crypto');const MATERIAL=['action','symbol','size','verdict'];
// Random audit of same/wording pairs, fixed in advance: a pair is audited when the first byte of SHA-256(review id) is
// below 26 (about 10%). Nobody chooses which pairs, and the choice cannot depend on their content.
const audited=id=>createHash('sha256').update(String(id)).digest()[0]<26;
function report({records,contextOf,adjudications=[],config={},from=null,to=null}){
  const day=t=>new Date(t+9*3600000).toISOString().slice(0,10);const inRange=r=>(!from||day(r.timestamp)>=from)&&(!to||day(r.timestamp)<=to);
  const sim=simulate(records.filter(inRange),{contextOf,threshold:config.complexityThreshold??40,maxRuns:config.lunaMaxRuns??4,maxMinutes:config.lunaMaxMinutes??120,spotCheckPct:config.spotCheckPct??25});
  const adj=new Map(adjudications.map(a=>[a.reviewId,a]));
  // A routing miss: on a review the router would have left to the cheaper model, the cheaper decision was materially worse.
  const cheaper=sim.rows.filter(r=>r.decided==='cheaper');const cheaperSituations=new Set(cheaper.map(r=>r.situation));
  const misses=cheaper.map(r=>({...r,a:adj.get(r.reviewId)})).filter(r=>r.a&&(r.a.outcome==='sol-better'||(r.a.outcome==='both-wrong'&&r.a.lunaWorse)));
  const missSituations=sev=>new Set(misses.filter(m=>m.a.severity===sev).map(m=>m.situation)).size;
  const n=cheaperSituations.size,high=missSituations('high'),medium=missSituations('medium');
  // The adjudication queue: every material difference, and the predefined random audit of same/wording pairs.
  const queue=sim.rows.filter(r=>MATERIAL.includes(r.triage)||(['same','wording'].includes(r.triage)&&audited(r.reviewId)));
  const pending=queue.filter(r=>!adj.has(r.reviewId)).length;const auditSample=queue.filter(r=>['same','wording'].includes(r.triage)).length;
  const highUpper=upperBound(high,n),mediumUpper=upperBound(medium,n);const cov=sim.summary.coverage;
  const checks={
    adjudicationComplete:{pass:pending===0&&auditSample>=20,detail:`${pending} of ${queue.length} queued pairs not yet adjudicated (${auditSample} from the same/wording audit; at least 20 required)`},
    highSeverity:{pass:high===0,detail:`${high} observed in ${n} cheaper-routed situations (95% upper bound ${highUpper==null?'n/a':(highUpper*100).toFixed(2)+'%'})`},
    mediumSeverity:{pass:mediumUpper!=null&&mediumUpper<=0.02,detail:`${medium} observed in ${n} situations; one-sided 95% Clopper-Pearson upper bound ${mediumUpper==null?'n/a':(mediumUpper*100).toFixed(2)+'%'} (must be at most 2%)`},
    coverage:{pass:['held','quiet','stress','event'].every(k=>cov[k]>=10),detail:JSON.stringify(cov)},
    savings:{pass:sim.summary.savingsPct!=null&&sim.summary.savingsPct>=30,detail:`${sim.summary.savingsPct}% of main-model-only cost`}};
  const missedActions=misses.filter(m=>m.a.category==='missed-action').length,bothWrong=adjudications.filter(a=>a.outcome==='both-wrong').length;
  const shadowMicro=records.filter(inRange).reduce((x,r)=>x+(r.shadow?.usage?.micro??0),0);
  // fail: a high-severity miss, an observed medium rate above 2%, or savings below 30%. inconclusive: otherwise not
  // passing because adjudication, coverage or the sample size (upper bound above 2%) is not yet sufficient.
  const failed=high>0||(n>0&&medium/n>0.02)||(sim.summary.savingsPct!=null&&sim.summary.savingsPct<30);
  const verdict=failed?'fail':Object.values(checks).every(c=>c.pass)?'pass':'inconclusive';
  return {verdict,queue:queue.map(r=>({reviewId:r.reviewId,triage:r.triage,decided:r.decided,adjudicated:adj.has(r.reviewId)})),checks,missedActions,bothWrong,simulation:sim.summary,shadowEvaluationCostUSD:Math.round(shadowMicro/1e4)/100};
}
if(require.main===module){
  const db=new DatabaseSync(arg('db',path.join(process.env.APPDATA,'Financial Portfolio Manager','portfolio.sqlite')),{readOnly:true});
  const has=t=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const records=has('routing_eval')?db.prepare('SELECT payload FROM routing_eval').all().map(r=>JSON.parse(r.payload)):[];
  const contexts=new Map(db.prepare('SELECT id,payload FROM review_contexts').all().map(r=>[r.id,r.payload]));
  const config={...JSON.parse(db.prepare('SELECT payload FROM automation_settings').get()?.payload??'{}'),...(arg('threshold')?{complexityThreshold:Number(arg('threshold'))}:{})};
  const file=arg('adjudications',path.join(__dirname,'..','artifacts','routing-eval','adjudications.jsonl'));
  const adjudications=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  console.log(JSON.stringify(report({records,contextOf:id=>contexts.has(id)?JSON.parse(contexts.get(id)):null,adjudications,config,from:arg('from'),to:arg('to')}),null,2));
}
module.exports={report,upperBound,audited};
