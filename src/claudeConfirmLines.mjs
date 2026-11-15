// Trading on Claude Opus 5.5, step D-3 (artifacts/reviews/2026-11-15-claude-trading: d0/note.md section 8, review.md B and
// the shared-wait ruling): the confirmation's lines, from the user's own dry run and settings. Plain JavaScript so the
// tests can import it (as src/agentDraft.mjs). Facts only; no advice on whether or how to trade.
const HELPERS=[['scoutModel','Scout'],['narrativeModel','Market narrative'],['reflectionModel','Reflection']];
const MODEL_NAMES={'gpt-6-luna':'GPT-6 Luna','gpt-6-sol':'GPT-6 Sol','gpt-6-astra':'GPT-6 Astra','claude-opus-5-5':'Claude Opus 5.5','claude-haiku-5-5':'Claude Haiku 5.5'};
// Regular-session minutes a day the app trades (Korea 09:00 to 15:20, U.S. 09:30 to 16:00).
const OPEN_MINUTES={kis:380,us:390,both:770,paper:0};

export function claudeConfirmLines(config,state){
  const dry=state?.claudeDryRun,interval=Math.max(1,Number(config.intervalMinutes)||30),perDay=Math.ceil((OPEN_MINUTES[config.scope]??0)/interval);
  const cost=dry?.costUSD!=null?`Your last dry run cost $${dry.costUSD.toFixed(2)} for ${dry.calls} request${dry.calls===1?'':'s'}. ${config.autoReviewInterval?`At your base interval (every ${interval} minutes; the AI may change it)`:`At your interval (every ${interval} minutes)`} that is about $${(dry.costUSD*perDay).toFixed(2)} a day for ${perDay} scheduled reviews; triggered reviews add to it.`:'There is no measured cost yet.';
  const limits=config.anthropicUnlimitedBudget&&config.anthropicUnlimitedCalls?'Your Claude limits: unlimited.':`Your Claude limits: ${config.anthropicUnlimitedBudget?'no dollar limit':`$${config.anthropicUSDPerDay}`} and ${config.anthropicUnlimitedCalls?'no request limit':`${config.anthropicCallsPerDay} requests`} a day.`;
  const moving=HELPERS.filter(([k])=>config[k]==='same').map(([,n])=>n);const routine=String(config.routineModel??'');
  return ['Every review sends your account data (holdings, cash, orders and prices) to Anthropic.',
    'No fallback: when Claude cannot answer, reviews wait and you are alerted. Armed stops keep running.',
    "A wait started by any Claude call, the helpers' included, holds automatic reviews until it ends.",
    cost,limits,
    ...(moving.length?[`${moving.join(', ')} move${moving.length===1?'s':''} to Claude too. ${moving.length===1?'It has':'They have'} not yet run on Claude with real requests.`]:[]),
    // Haiku compacting H-1: compacting on Claude is named too.
    routine.startsWith('claude-')?`Context compacting uses ${MODEL_NAMES[routine]??routine}.`:`Context compacting still uses OpenAI (${MODEL_NAMES[routine]??routine}).`,
    'The first review waits for you: run it from Home. Automatic reviews start after it completes.'];
}
