// Routing simulation over shadow-evaluation records (docs/ROUTING-EVALUATION.md section 7). Replays a proposed router
// in time order with its own hypothetical history: the last review the main model would have decided (the baseline
// for change), the run of consecutive cheaper-model reviews, and the previous decision the router would have used
// (the cheaper model's own when it was routed there). Live records came from a main-model-only history, so this is
// the closest available estimate; it still cannot show how the cheaper model's decisions would have changed holdings.
const {assess}=require('./complexity.cjs');
const DAY=86400000,HOUR=3600000;
// Mandatory escalations, shared with live routing so the simulation and the live router apply the same rules.
function hardRule({trigger,now,lastMainAt,streak,markets=['KR','US'],closedDays=new Set(),maxRuns=4,maxMinutes=120,consequence=null,mainModel='the main model'}){
  if(trigger==='Auto trading started')return 'first review after starting';
  if(consequence?.gate)return `consequence: ${consequence.reasons[0]}`;
  if(lastMainAt==null||now-lastMainAt>12*HOUR)return `no review on ${mainModel} in the last 12 hours`;
  const S=require('./market-sessions.cjs');
  for(const m of markets){const tz=m==='KR'?'Asia/Seoul':'America/New_York';
    const opens=[-1,0].flatMap(i=>S.sessionsOn(m,S.localDay(now+i*DAY,tz),{closedDays:m==='KR'?closedDays:new Set()})).filter(x=>x.regular&&x.startAt<=now&&now<x.endAt).map(x=>x.startAt);
    if(opens.some(at=>at>lastMainAt))return `first review of the ${m==='KR'?'Korean':'U.S.'} regular session`;}
  if(streak>=maxRuns)return `${streak} reviews in a row on the cheaper model`;
  if(streak&&now-lastMainAt>=maxMinutes*60000)return `${Math.round((now-lastMainAt)/60000)} minutes since the last review on ${mainModel}`;
  return null;
}
const verdictMap=d=>new Map((d?.planVerdicts??[]).map(v=>[v.symbol,v.verdict]));
// A situation ends when something material changes: a price, news or regime change against the previous review, a
// new scout plan, or a gap of more than four hours (docs/ROUTING-EVALUATION.md section 7).
function newSituation(ctx,prevCtx,prevAt,now){
  if(!prevCtx||now-prevAt>4*HOUR)return true;if((ctx.scoutPlan?.asOf??null)!==(prevCtx.scoutPlan?.asOf??null))return true;
  return assess(ctx,{baseline:prevCtx,now}).features.some(f=>f.source==='baseline'&&(f.group==='price'||f.group==='news'||f.detail.startsWith('regime changed')));
}
function strata(a,ctx){const held=Object.values(ctx.positions??{}).some(p=>(p?.quantity??0)>0);const g=a.groups;
  return {held,stress:g.price>0||g.market>0,event:g.events>0,quiet:!Object.values(g).some(v=>v>0)};}
function simulate(records,{contextOf,threshold=40,maxRuns=4,maxMinutes=120,spotCheckPct=25,gatePct=20,markets=['KR','US'],closedDays=new Set()}={}){
  const rows=[...records].filter(r=>!r.shadow?.error&&r.shadow?.decision).sort((a,b)=>a.timestamp-b.timestamp);
  const state=new Map();const out=[];
  for(const r of rows){
    const ctx=contextOf(r.reviewId);if(!ctx)continue;const key=r.account??'default';
    const s=state.get(key)??{mainCtx:null,mainAt:null,streak:0,prevDecision:null,prevModel:null,prevCtx:null,prevAt:null,situation:0};
    const a=assess(ctx,{baseline:s.mainCtx,previousReview:s.prevDecision?{decision:s.prevDecision,routing:{model:s.prevModel}}:null,now:r.timestamp,gatePct});
    const hard=hardRule({trigger:r.trigger,now:r.timestamp,lastMainAt:s.mainAt,streak:s.streak,markets,closedDays,maxRuns,maxMinutes,consequence:a.consequence});
    let route=hard||a.score>=threshold?'main':'cheaper',reason=hard??`score ${a.score} ${route==='main'?'≥':'<'} ${threshold}`,escalated=null;
    const live=r.live.usage?.micro??0,cheap=r.shadow.usage?.micro??0;let cost=route==='main'?live:cheap+live*spotCheckPct/100;
    // Live rules on a cheaper-model decision: a trade or a changed scout-target verdict goes to the main model.
    if(route==='cheaper'){const d=r.shadow.decision;const before=verdictMap(s.prevDecision);const changed=(d.planVerdicts??[]).some(v=>before.has(v.symbol)&&before.get(v.symbol)!==v.verdict);
      if(d.action!=='Hold'||changed){escalated=d.action!=='Hold'?'trade confirmation':'verdict change';cost=cheap+live;}}
    if(newSituation(ctx,s.prevCtx,s.prevAt,r.timestamp))s.situation++;
    const decided=route==='main'||escalated?'main':'cheaper';
    out.push({reviewId:r.reviewId,timestamp:r.timestamp,account:key,situation:`${key}#${s.situation}`,route,reason,escalated,decided,score:a.score,gate:a.consequence.gate,triage:r.triage,strata:strata(a,ctx),costMicro:cost,mainOnlyMicro:live});
    if(decided==='main'){s.mainCtx=ctx;s.mainAt=r.timestamp;s.streak=0;}else s.streak++;
    s.prevDecision=decided==='main'?r.live.decision:r.shadow.decision;s.prevModel=decided==='main'?r.live.model:r.shadow.model;s.prevCtx=ctx;s.prevAt=r.timestamp;state.set(key,s);
  }
  const sum=k=>out.reduce((x,o)=>x+o[k],0);const cheaperRows=out.filter(o=>o.decided==='cheaper');const by={};for(const o of cheaperRows)by[o.triage]=(by[o.triage]??0)+1;
  const situations=new Map();for(const o of out){const x=situations.get(o.situation)??{held:false,stress:false,event:false,quiet:false,cheaper:false};for(const k of ['held','stress','event','quiet'])x[k]||=o.strata[k];x.cheaper||=o.decided==='cheaper';situations.set(o.situation,x);}
  const sit=[...situations.values()];const coverage=Object.fromEntries(['held','stress','event','quiet'].map(k=>[k,sit.filter(x=>x[k]).length]));
  return {rows:out,summary:{reviews:out.length,main:out.filter(o=>o.decided==='main').length,cheaper:cheaperRows.length,escalated:out.filter(o=>o.escalated).length,gate:out.filter(o=>o.gate).length,
    costMicro:Math.round(sum('costMicro')),mainOnlyMicro:Math.round(sum('mainOnlyMicro')),savingsPct:sum('mainOnlyMicro')?Math.round((1-sum('costMicro')/sum('mainOnlyMicro'))*1000)/10:null,
    cheaperTriage:by,situations:sit.length,cheaperSituations:sit.filter(x=>x.cheaper).length,coverage}};
}
module.exports={hardRule,simulate,newSituation};
