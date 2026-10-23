// Routing evaluation report (docs/ROUTING-EVALUATION.md). Reads the app database read-only and the adjudication file,
// replays the frozen router in time order and applies the approved criteria.
//   node scripts/routing-report.cjs --freeze     record the router binding and start a new, untouched evaluation period
//   node scripts/routing-report.cjs              report on the evaluation period since the freeze
//   options: --db path --adjudications path --freeze-file path
// Only prospective records from live accounts, made after the freeze under the frozen binding, count toward the
// criteria. Paper-portfolio records are reported separately as supplementary and never count.
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {simulate,binding}=require('../electron/routing-sim.cjs');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0&&process.argv[i+1]&&!process.argv[i+1].startsWith('--')?process.argv[i+1]:fallback;};
const MATERIAL=['action','symbol','size','verdict','withheld'];
// One-sided 95% Clopper-Pearson upper bound on a binomial proportion (x events in n trials).
function upperBound(x,n,alpha=0.05){if(!n)return null;if(x>=n)return 1;let lo=x/n,hi=1;
  const cdf=p=>{let term=Math.pow(1-p,n),sum=term;for(let k=1;k<=x;k++){term*=(n-k+1)/k*p/(1-p);sum+=term;}return sum;};
  for(let i=0;i<80;i++){const mid=(lo+hi)/2;if(cdf(mid)>alpha)lo=mid;else hi=mid;}return hi;}
// Random audit of same/wording pairs on reviews the main model would have decided, fixed in advance: audited when the
// first byte of SHA-256(review id) is below 26 (about 10%).
const audited=id=>createHash('sha256').update(String(id)).digest()[0]<26;
// Only records from a verified live broker account count; paper, mock and unknown provenance are supplementary.
const isLive=r=>r.provenance?.broker==='live'&&r.provenance?.connection==='live'&&r.account!=='paper';
// An adjudication counts only when complete; anything else stays pending.
const OUTCOMES=['sol-better','luna-better','both-defensible','both-wrong','immaterial'],CATEGORIES=['missed-action','wrong-action','sizing','constraint','factual','evidence-ignored','incomplete-plan'],SEVERITIES=['low','medium','high'];
function validAdjudication(a){
  if(!a||typeof a.reviewId!=='string'||!OUTCOMES.includes(a.outcome)||typeof a.reason!=='string'||a.reason.trim().length<20||!Number.isFinite(Date.parse(a.judgedAt))||a.missedActionChecked!==true)return false;
  if(['sol-better','luna-better','both-wrong'].includes(a.outcome)&&(!CATEGORIES.includes(a.category)||!SEVERITIES.includes(a.severity)))return false;
  if(a.outcome==='both-wrong'&&typeof a.lunaWorse!=='boolean')return false;
  if(a.severity==='high'&&a.confirmedByUser!==true)return false;
  if(a.category==='constraint'&&a.severity==='low')return false;
  return true;
}
function report({records,contextOf,adjudications=[],freeze=null,currentBinding=null}){
  if(!freeze?.evaluationStart||!freeze?.binding)return {verdict:'inconclusive',reason:'no frozen evaluation period: run with --freeze first',prospective:false};
  const start=Date.parse(freeze.evaluationStart);
  const inPeriod=records.filter(r=>r.timestamp>=start);const supplementary=inPeriod.filter(r=>!isLive(r));
  const offBinding=inPeriod.filter(r=>isLive(r)&&JSON.stringify(r.binding)!==JSON.stringify(freeze.binding));
  const eligible=inPeriod.filter(r=>isLive(r)&&JSON.stringify(r.binding)===JSON.stringify(freeze.binding));
  const b=freeze.binding;
  const sim=simulate(eligible,{contextOf,threshold:b.threshold,maxRuns:b.maxRuns,maxMinutes:b.maxMinutes,spotCheckPct:b.spotCheckPct,gatePct:b.gatePct});
  const invalidAdjudications=adjudications.filter(a=>!validAdjudication(a)).length;const adj=new Map(adjudications.filter(validAdjudication).map(a=>[a.reviewId,a]));
  // Every review the cheaper model would have decided is adjudicated; a situation enters the bound only when all of its
  // cheaper-decided reviews are. Material differences and the random audit cover the main-model side.
  const cheaper=sim.rows.filter(r=>r.decided==='cheaper');
  // Pairs where only one model read evidence bearing on the decision are queued for inspection too.
  const inspect=new Set(eligible.filter(r=>r.evidenceGap?.inspect).map(r=>r.reviewId));
  const queue=[...new Map([...cheaper,...sim.rows.filter(r=>MATERIAL.includes(r.triage)||inspect.has(r.reviewId)||(['same','wording'].includes(r.triage)&&audited(r.reviewId)))].map(r=>[r.reviewId,r])).values()];
  const pending=queue.filter(r=>!adj.has(r.reviewId));
  const situations=new Map();for(const r of cheaper){const x=situations.get(r.situation)??[];x.push(r);situations.set(r.situation,x);}
  const judged=[...situations].filter(([,rows])=>rows.every(r=>adj.has(r.reviewId)));
  const miss=a=>a&&(a.outcome==='sol-better'||(a.outcome==='both-wrong'&&a.lunaWorse));
  const severityIn=(rows,sev)=>rows.some(r=>miss(adj.get(r.reviewId))&&adj.get(r.reviewId).severity===sev);
  const n=judged.length,high=judged.filter(([,rows])=>severityIn(rows,'high')).length,medium=judged.filter(([,rows])=>severityIn(rows,'medium')).length;
  const highUpper=upperBound(high,n),mediumUpper=upperBound(medium,n);const cov=sim.summary.coverage;
  const auditCount=queue.filter(r=>['same','wording'].includes(r.triage)&&r.decided==='main').length;
  const checks={
    bindingCurrent:{pass:JSON.stringify(currentBinding)===JSON.stringify(freeze.binding),detail:'the app runs the frozen models, settings, protocol and code'},
    evidenceComplete:{pass:sim.summary.missingContexts===0,detail:`${sim.summary.missingContexts} records without their saved context; ${offBinding.length} records made under another binding excluded`},
    adjudicationComplete:{pass:pending.length===0&&auditCount>=20,detail:`${pending.length} of ${queue.length} queued reviews not yet validly adjudicated (${invalidAdjudications} incomplete records ignored); ${auditCount} audited same/wording pairs (at least 20)`},
    highSeverity:{pass:high===0&&n>0,detail:`${high} observed in ${n} fully adjudicated cheaper-routed situations (95% upper bound ${highUpper==null?'n/a':(highUpper*100).toFixed(2)+'%'})`},
    mediumSeverity:{pass:mediumUpper!=null&&mediumUpper<=0.02,detail:`${medium} observed in ${n} situations; one-sided 95% Clopper-Pearson upper bound ${mediumUpper==null?'n/a':(mediumUpper*100).toFixed(2)+'%'} (at most 2%)`},
    coverage:{pass:['held','quiet','stress','event'].every(k=>cov[k]>=10),detail:JSON.stringify(cov)},
    savings:{pass:sim.summary.savingsPct!=null&&sim.summary.savingsPct>=30,detail:`${sim.summary.savingsPct}% of main-model-only cost, complete policy`}};
  // fail: a high-severity miss, an observed medium rate above 2%, or savings below 30%; otherwise inconclusive until every check passes.
  const failed=high>0||(n>0&&medium/n>0.02)||(sim.summary.savingsPct!=null&&sim.summary.savingsPct<30);
  const verdict=failed?'fail':Object.values(checks).every(c=>c.pass)?'pass':'inconclusive';
  const misses=[...adj.values()].filter(a=>miss(a));const by=k=>misses.filter(a=>a.category===k).length;
  return {verdict,prospective:true,freeze,binding:freeze.binding,checks,
    errors:{missedActions:by('missed-action'),wrongActions:by('wrong-action'),sizing:by('sizing'),constraint:by('constraint'),factual:by('factual'),evidenceIgnored:by('evidence-ignored'),bothWrong:[...adj.values()].filter(a=>a.outcome==='both-wrong').length},
    queue:queue.map(r=>({reviewId:r.reviewId,triage:r.triage,decided:r.decided,evidenceGap:inspect.has(r.reviewId),adjudicated:adj.has(r.reviewId)})),simulation:sim.summary,
    shadowEvaluationCostUSD:Math.round(inPeriod.reduce((x,r)=>x+(r.shadow?.usage?.micro??0),0)/1e4)/100,
    supplementary:{records:supplementary.length,byProvenance:supplementary.reduce((x,r)=>{const k=r.provenance?.broker??'unknown';x[k]=(x[k]??0)+1;return x;},{}),note:'Paper, mock and unknown-provenance records, and replay results, are reported separately and never count toward the criteria.'}};
}
if(require.main===module){
  const db=new DatabaseSync(arg('db',path.join(process.env.APPDATA,'Financial Portfolio Manager','portfolio.sqlite')),{readOnly:true});
  const has=t=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const config=JSON.parse(db.prepare('SELECT payload FROM automation_settings').get()?.payload??'{}');const current=binding({...require('../electron/automation.cjs').DEFAULTS,...config});
  const freezeFile=arg('freeze-file',path.join(__dirname,'..','artifacts','routing-eval','freeze.json'));
  if(process.argv.includes('--freeze')){fs.mkdirSync(path.dirname(freezeFile),{recursive:true});const freeze={frozenAt:new Date().toISOString(),evaluationStart:new Date().toISOString(),binding:current};fs.writeFileSync(freezeFile,JSON.stringify(freeze,null,2));console.log(JSON.stringify(freeze,null,2));process.exit(0);}
  const records=has('routing_eval')?db.prepare('SELECT payload FROM routing_eval').all().map(r=>JSON.parse(r.payload)):[];
  const contexts=new Map(db.prepare('SELECT id,payload FROM review_contexts').all().map(r=>[r.id,r.payload]));
  const file=arg('adjudications',path.join(__dirname,'..','artifacts','routing-eval','adjudications.jsonl'));
  const adjudications=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  const freeze=fs.existsSync(freezeFile)?JSON.parse(fs.readFileSync(freezeFile,'utf8')):null;
  console.log(JSON.stringify(report({records,contextOf:id=>contexts.has(id)?JSON.parse(contexts.get(id)):null,adjudications,freeze,currentBinding:current}),null,2));
}
module.exports={report,upperBound,audited,validAdjudication};
