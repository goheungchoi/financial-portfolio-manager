'use strict';
// Per-agent model and effort (step A2, artifacts/reviews/2026-11-12-engine-settings/plan.md). One resolver for every
// agent that calls a model: the trading review, the scout, the market narrative, context compacting and post-trade
// reflection. Each agent other than the trading review has a model and an effort setting; 'same' follows the trading
// agent. The defaults reproduce what each agent ran on before this step, so an upgraded profile changes nothing:
// - scout, narrative, reflection: 'same' (they followed the trading model and effort);
// - context compacting: routineModel and routineEffort, the keys it already had (GPT-6 Luna, no reasoning by default);
// - the scout and the market narrative run with at least 'low' effort: they always raised 'none' to 'low', so an
//   effort that follows the trading agent is raised the same way, and 'none' cannot be chosen for them directly.
// Until release B only OpenAI models can be chosen (ai-models.cjs assertTradingModel).
const AGENTS=['trading','scout','narrative','compacting','reflection'];
const KEYS={scout:['scoutModel','scoutEffort'],narrative:['narrativeModel','narrativeEffort'],compacting:['routineModel','routineEffort'],reflection:['reflectionModel','reflectionEffort']};
const AGENT_DEFAULTS={scoutModel:'same',scoutEffort:'same',narrativeModel:'same',narrativeEffort:'same',reflectionModel:'same',reflectionEffort:'same'};
const RAISED=new Set(['scout','narrative']);
const EFFORTS=['none','low','medium','high'];
const follows=v=>v==null||v==='same';

/** @returns {{openaiModel:string,reasoningEffort:string}} */
function agentModel(config,agent){
  if(agent==='trading')return {openaiModel:config.openaiModel,reasoningEffort:config.reasoningEffort};
  const keys=KEYS[agent];if(!keys)throw new Error('UNKNOWN_AGENT');
  const model=config[keys[0]],effort=config[keys[1]];
  const resolved={openaiModel:follows(model)?config.openaiModel:model,reasoningEffort:follows(effort)?config.reasoningEffort:effort};
  if(RAISED.has(agent)&&resolved.reasoningEffort==='none')resolved.reasoningEffort='low';
  return resolved;
}
function agentModels(config){return Object.fromEntries(AGENTS.map(a=>[a,agentModel(config,a)]));}
// Throws INVALID_SETTINGS for a malformed value, INVALID_MODEL_SETTINGS (ai-models.cjs) for a model and effort that do
// not go together, and CLAUDE_NOT_ENABLED_FOR_TRADING for a model not yet allowed. Checked on the resolved values, so a
// change of the trading model is refused when an agent that follows it would end up with an invalid pair.
function validate(config,{claudeAllowed=false}={}){
  const models=require('./ai-models.cjs');
  for(const [agent,[mk,ek]] of Object.entries(KEYS)){
    const m=config[mk],e=config[ek];
    if(typeof m!=='string'||!m||m.length>60)throw new Error('INVALID_SETTINGS');
    if(typeof e!=='string'||!(e==='same'||EFFORTS.includes(e)))throw new Error('INVALID_SETTINGS');
    if(RAISED.has(agent)&&e==='none')throw new Error('INVALID_SETTINGS');
    const r=agentModel(config,agent);models.settings(r);
    // B3: a Claude model for these agents only after a completed Claude dry run on this account (automation's
    // completedClaudeDryRun). The refusal names the first such agent (CLAUDE_DRY_RUN_REQUIRED:<agent>), so the settings
    // window can say which agent to change. The trading model keeps assertTradingModel until C2.
    if(models.vendorOf(r.openaiModel)==='anthropic'){if(!claudeAllowed)throw new Error(`CLAUDE_DRY_RUN_REQUIRED:${agent}`);}else models.assertTradingModel(r.openaiModel);
  }
}
module.exports={AGENTS,KEYS,AGENT_DEFAULTS,agentModel,agentModels,validate};
