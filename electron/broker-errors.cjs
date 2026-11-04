const PUBLIC=['REQUEST_FAILED','NETWORK_UNAVAILABLE','REQUEST_TIMEOUT','SERVER_ERROR','RATE_LIMITED','AUTH_FAILED','INVALID_RESPONSE'];
function responseError(status,body){const code=body?.msg_cd;const safeCode=typeof code==='string'&&/^[A-Z0-9_-]{1,24}$/.test(code)?code:null;const reason=code==='EGW00201'||status===429?'RATE_LIMITED':status===401||status===403?'AUTH_FAILED':status>=500?'SERVER_ERROR':'REQUEST_FAILED';return {reason,brokerCode:safeCode,httpStatus:status};}
// What stopped an order, so a log never calls a fault in the app a broker refusal (audit 2026-11-04: a ReferenceError in
// a conditional Buy was reported as "the broker or a risk check refused it"):
// - internal: the app's own code failed (no error code, or a Node ERR_ code); where names the file and line.
// - broker: KIS refused the order.
// - temporary: a passing condition before anything reached KIS (busy, rate limit, timeout, network, server, a closed
//   session); retrying can work.
// - uncertain: the order may be at KIS; it must be reconciled before anything is retried.
// - check: one of the app's own order checks refused it (limits, exposure, approval, account change).
const TEMPORARY=['KIS_ORDER_BUSY','RATE_LIMITED','REQUEST_TIMEOUT','NETWORK_UNAVAILABLE','SERVER_ERROR','SESSION_CLOSED'];
const BROKER=['BROKER_REJECTED','CREDIT_ACCOUNT_REQUIRED'];
function classify(error){
  const raw=error?.code??error?.message;const code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{2,39}$/.test(raw)&&!raw.startsWith('ERR_')?raw:null;
  if(!code){const where=String(error?.stack??'').match(/([A-Za-z0-9_.-]+\.cjs):(\d+)/);return {kind:'internal',code:'INTERNAL_ERROR',type:error instanceof Error?error.name:typeof error,...(where?{where:`${where[1]}:${where[2]}`}:{})};}
  return {kind:BROKER.includes(code)?'broker':TEMPORARY.includes(code)?'temporary':code==='ORDER_UNCERTAIN'?'uncertain':'check',code,...(typeof error?.brokerCode==='string'?{brokerCode:error.brokerCode}:{})};
}
module.exports={PUBLIC,responseError,classify,TEMPORARY};
