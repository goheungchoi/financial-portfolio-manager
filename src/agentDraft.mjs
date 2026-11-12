// Agent model and effort in the Engine settings draft (step A3, review F1). The engine (electron/agent-models.cjs)
// refuses a save when any agent's resolved model and effort do not go together; the only such pair among the models
// that can be chosen is GPT-6 Astra with effort None. Changing the trading model or effort can create that pair for an
// agent that follows it, so every draft change runs through correctAgents, which raises such an agent's own effort to
// Low. The scout and the market narrative never need it: the engine raises their None to Low itself.

/** @type {Record<'scout'|'narrative'|'compacting'|'reflection',[string,string]>} */
export const AGENT_KEYS={scout:['scoutModel','scoutEffort'],narrative:['narrativeModel','narrativeEffort'],compacting:['routineModel','routineEffort'],reflection:['reflectionModel','reflectionEffort']};
const RAISED=new Set(['scout','narrative']);
const follows=v=>v==null||v==='same';

/** The model and effort an agent resolves to in a draft, before the engine's raise for the scout and the narrative. */
export function resolved(config,agent){const [mk,ek]=AGENT_KEYS[agent];return {model:follows(config[mk])?config.openaiModel:config[mk],effort:follows(config[ek])?config.reasoningEffort:config[ek]};}

/** The draft keys to change so that no agent resolves to an invalid pair: {} when nothing needs correcting. */
export function correctAgents(config){
  /** @type {Record<string,string>} */
  const fix={};
  for(const agent of Object.keys(AGENT_KEYS)){if(RAISED.has(agent))continue;const r=resolved(config,agent);if(r.model==='gpt-6-astra'&&r.effort==='none')fix[AGENT_KEYS[agent][1]]='low';}
  return fix;
}

/** The effort values an agent's Effort list offers: 'same' first; 'none' only where the engine accepts it. */
export function effortOptions(config,agent){
  const noNone=RAISED.has(agent)||resolved(config,agent).model==='gpt-6-astra';
  return ['same',...(noNone?[]:['none']),'low','medium','high'];
}
