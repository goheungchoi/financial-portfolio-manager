// The provider worker's reply for a failed operation (moved out of provider-worker.cjs so it can be tested). AI operations
// keep their public error code, usage, model and response size; everything else is reduced to a generic code. Details are
// bounded summaries: rules, counts, tool names and sizes, never arguments, keys or portfolio data.
// compact joined the AI operations after the 2026-11-10 incident, where a failed condensing step showed only
// PROVIDER_REQUEST_FAILED and was charged at its full reservation.
const AI_USAGE=['decision','reflection','scout','narrative','compact'],AI_CODES=['decision','scout','narrative','compact'];
function decisionDetail(error){
  if(!error.detail||typeof error.detail!=='object')return null;
  if(typeof error.detail.rule==='string')return {rule:error.detail.rule.slice(0,120),...(Number.isInteger(error.detail.toolCount)?{toolCount:error.detail.toolCount}:{}),...(Array.isArray(error.detail.tools)?{tools:error.detail.tools.slice(0,8).map(x=>String(x).slice(0,40))}:{}),...(Number.isInteger(error.detail.round)?{round:error.detail.round}:{}),...(error.detail.status?{status:String(error.detail.status).slice(0,30)}:{}),...(error.detail.decision&&typeof error.detail.decision==='object'?{decision:Object.fromEntries(['action','symbol','quantity','credit'].map(k=>[k,typeof error.detail.decision[k]==='number'?error.detail.decision[k]:String(error.detail.decision[k]??'').slice(0,24)]))}:{})};
  return {limit:String(error.detail.limit??'').slice(0,40),wireBytes:Number(error.detail.wireBytes)||null,limitBytes:typeof error.detail.limitBytes==='number'?error.detail.limitBytes:String(error.detail.limitBytes??'').slice(0,20),largest:(Array.isArray(error.detail.largest)?error.detail.largest:[]).slice(0,6).map(x=>String(x).slice(0,60))};
}
function errorReply(operation,error){
  const ai=AI_USAGE.includes(operation);
  return {ok:false,usage:ai?error?.usage??null:null,model:ai?error?.model??null:null,
    responseChars:ai&&Number.isInteger(error?.responseChars)&&error.responseChars>=0?error.responseChars:null,
    detail:operation==='scout'&&typeof error?.detail==='string'?error.detail.slice(0,200):operation==='decision'&&error?decisionDetail(error):null,
    code:AI_CODES.includes(operation)?(require('./ai-errors.cjs').publicCode(error)??'PROVIDER_REQUEST_FAILED'):['dart-company','sec-company','sec-filings'].includes(operation)&&/^(DART|SEC)_[A-Z_]{3,30}$/.test(error?.message??'')?error.message:'PROVIDER_REQUEST_FAILED'};
}
module.exports={errorReply,AI_USAGE,AI_CODES};
