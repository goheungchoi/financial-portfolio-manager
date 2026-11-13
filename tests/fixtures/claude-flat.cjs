'use strict';
// The enforced Claude decision form (artifacts/reviews/2026-11-13-enforced-form): a fake Anthropic transport answers in the
// form the request asks for. A test writes its decision in the app's nested form; when the request carries the flat
// schema as output_config.format, `adapt` turns that decision into the flat answer Claude gives, with the "none" markers.
// What a test means to check is kept: unknown keys pass through, a missing core key stays missing, values (wrong types
// included) are copied as they are, and text that is not a JSON object (prose) is left alone.
const CORE=['action','symbol','quantity','credit','loanDate','explanation'];
function flat(d,schema){
  const keys=Object.keys(schema.properties);const p=d.plan&&typeof d.plan==='object'?d.plan:{};const pi=p.portfolioImpact,va=p.valuation,un=p.uncertainty,ex=d.execution,rv=d.reversal;
  const out={};for(const k of CORE)if(k in d)out[k]=d[k];
  // A fixture with only action, symbol, quantity and explanation is a cash order, as checkDecision reads it; the flat form
  // always carries credit and loanDate, so they are filled the same way.
  if(!('credit' in d)&&!('loanDate' in d)&&['action','symbol','quantity','explanation'].every(k=>k in d)){out.credit='none';out.loanDate='';}
  // A plan may name its horizon as strategy (an older key normalizePlan still reads); the flat form has plan_horizon only.
  Object.assign(out,{plan_horizon:p.horizon??(['long-term','swing','short-term'].includes(p.strategy)?p.strategy:'none'),plan_thesis:p.thesis??'',plan_invalidation:p.invalidation??'',plan_stopPrice:p.stopPrice??0,plan_targetPrice:p.targetPrice??0,plan_horizonDays:p.horizonDays??0,plan_confidence:p.confidence??'low',
    plan_portfolioImpact_weightBeforePct:pi?.weightBeforePct??0,plan_portfolioImpact_weightAfterPct:pi?.weightAfterPct??0,plan_portfolioImpact_related:pi?.related??[],plan_portfolioImpact_relatedBeforePct:pi?.relatedBeforePct??0,plan_portfolioImpact_relatedAfterPct:pi?.relatedAfterPct??0,plan_portfolioImpact_equityReliable:pi?.equityReliable??true,plan_portfolioImpact_why:pi?.why??'',
    plan_evidence:p.evidence??[],plan_valuation_method:va?.method??'',plan_valuation_inputs:va?.inputs??'',plan_valuation_justification:va?.justification??'',plan_uncertainty_acceptableAtThisSize:un?.acceptableAtThisSize??'',plan_uncertainty_beforeAddingMore:un?.beforeAddingMore??'',
    complexity_score:d.complexity?.score??0,complexity_reason:d.complexity?.reason??'',strategyCheck:Array.isArray(d.strategyCheck)&&d.strategyCheck.length?JSON.stringify(d.strategyCheck):typeof d.strategyCheck==='string'?d.strategyCheck:'',
    execution_bound:ex?.bound??0,execution_cancelAfter:ex?.cancelAfter??'',execution_cancelIf:ex?.cancelIf??[],
    reversal_priorDecisionId:rv?.priorDecisionId??'',reversal_basis:rv?.basis??'none',reversal_whatChanged:rv?.whatChanged??'',reversal_priorRequirement:rv?.priorRequirement??'',reversal_newEvidence:rv?.newEvidence??[],reversal_afterCost:rv?.afterCost??''});
  if(keys.includes('scoutBrief'))out.scoutBrief=d.scoutBrief?typeof d.scoutBrief==='string'?d.scoutBrief:JSON.stringify(d.scoutBrief):'';
  if(keys.includes('planVerdicts'))out.planVerdicts=Array.isArray(d.planVerdicts)&&d.planVerdicts.length?JSON.stringify(d.planVerdicts):typeof d.planVerdicts==='string'?d.planVerdicts:'';
  // Unknown top-level keys of the nested answer pass through, so the rebuild refuses them as before.
  const known=new Set([...CORE,'plan','complexity','strategyCheck','execution','reversal','scoutBrief','planVerdicts']);for(const [k,v] of Object.entries(d))if(!known.has(k))out[k]=v;
  return out;
}
// The reply, with each text block that holds a nested decision object turned into the flat answer, when the request asked
// for the enforced form. Anything else is returned unchanged.
function adapt(reply,body){
  const schema=body?.output_config?.format?.schema;if(!schema||!schema.properties?.plan_horizon||!reply||!Array.isArray(reply.content))return reply;
  // The answer may be split across text blocks (they are joined by the client): read them together.
  const texts=reply.content.filter(b=>b?.type==='text');if(!texts.length)return reply;let v;try{v=JSON.parse(texts.map(b=>String(b.text??'')).join(''));}catch{return reply;}
  if(!v||typeof v!=='object'||Array.isArray(v)||'plan_horizon' in v)return reply;
  const first=reply.content.indexOf(texts[0]);const content=reply.content.filter(b=>b?.type!=='text');content.splice(first,0,{type:'text',text:JSON.stringify(flat(v,schema))});
  return {...reply,content};
}
module.exports={flat,adapt};
