// Which company makes a model (provider-naming P2, artifacts/reviews/2026-11-24-provider-naming): one source, the main
// process's model table (ai-models.cjs MODELS), sent with the runtime state as modelCompanies and kept here. No screen
// guesses the company from a model id's prefix. An unknown model has no company (a screen then says "AI").
let companies={};
export function setModelCompanies(map){if(map&&typeof map==='object'&&!Array.isArray(map))companies={...map};}
// The same matching as the main process (ai-models.cjs rowKey): the id exactly, or a dated snapshot of an OpenAI model
// (model-20…). An id the table does not know falls back to its prefix, as before P2 (the planner's ruling): "claude-" is
// Anthropic and "gpt-" OpenAI, for the words and for every check that gates on Claude (the safer side); anything else has
// no company and reads "AI".
export function companyOfModel(model){const m=String(model??'');const key=Object.prototype.hasOwnProperty.call(companies,m)?m:Object.keys(companies).find(k=>companies[k]==='openai'&&m.startsWith(k+'-20'));const v=key?companies[key]:null;
  if(v==='openai'||v==='anthropic')return v;return m.startsWith('claude-')?'anthropic':m.startsWith('gpt-')?'openai':null;}
export const isClaudeModel=model=>companyOfModel(model)==='anthropic';
export const COMPANY_NAMES={anthropic:'Claude',openai:'OpenAI'};
// Who decides, as screens say it: the company of the trading model for an AI decision, "AI" when it is not known.
export function deciderName(config){const p=config?.provider;if(p==='openai')return COMPANY_NAMES[companyOfModel(config?.openaiModel)]??'AI';return p==='local'?'Local rules':p==='external'?'External agent':'—';}
