// The AI provider cards' texts (release B, gate 1.5.54 review): what each provider is used for now, from the agents'
// resolved models, and the Anthropic card's note. Pure, so the unit tests pin them.

/** @type {Record<string,string>} */
const AGENT_NAMES={trading:'Reviews',scout:'scout',narrative:'narrative',compacting:'compacting',reflection:'reflection'};

/** The note on the Anthropic card. */
export const ANTHROPIC_NOTE='Claude needs this key, this sharing switch and room in these limits. The dry run can use it now. Scout, narrative, compacting and reflection can after one completed Claude dry run on this account. Trading reviews stay on OpenAI.';

/**
 * The card's subtitle: the agents whose resolved model is this provider's, in the engine's order, as one phrase.
 * OpenAI with none: "Nothing now"; Anthropic with none: "Dry run" (the dry run can use Claude whatever the agents use).
 * Without the agents' models (an engine that does not report them): "AI reviews" and "Dry run".
 * @param {'openai'|'anthropic'} vendor
 * @param {Record<string,{openaiModel:string}>|null|undefined} agentModels
 */
export function providerUses(vendor,agentModels){
  const claude=vendor==='anthropic';
  if(!agentModels)return claude?'Dry run':'AI reviews';
  const list=Object.entries(agentModels).filter(([,m])=>String(m?.openaiModel??'').startsWith('claude-')===claude).map(([a])=>AGENT_NAMES[a]??a);
  return list.length?list.join(', ').replace(/^./,c=>c.toUpperCase()):claude?'Dry run':'Nothing now';
}
