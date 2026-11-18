const BASE=['REQUEST_FAILED','NETWORK_UNAVAILABLE','REQUEST_TIMEOUT','SERVER_ERROR','AUTH_FAILED','RATE_LIMITED','BROKER_REJECTED','INVALID_RESPONSE','INCOMPLETE_BALANCE','KIS_NOT_CONNECTED','FEATURE_UNAVAILABLE','SESSION_CLOSED','ORDER_NOT_SENT','TICKET_EXPIRED'];
// 2026-11-19 order-rule audit, item 3: the refusals of a U.S. order request (the order check, the placement and a
// revision) keep their own code, as Korea's do, so a refused order reads "Not sent" with its reason instead of failing
// the review as US_REQUEST_FAILED. Only for those requests (order: true); the balance and quote reads are unchanged.
const ORDER_CODES=['PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','INVALID_ORDER','ORDER_UNCERTAIN'];
const ORDER_OPERATIONS=['us-prepare-order','us-place-order','us-revise-order'];
function publicUSCode(code,{order=false}={}){return BASE.includes(code)||order&&ORDER_CODES.includes(code)||/^US_(BALANCE|CASH|QUOTES)_(REQUEST_FAILED|NETWORK_UNAVAILABLE|REQUEST_TIMEOUT|SERVER_ERROR|AUTH_FAILED|RATE_LIMITED|BROKER_REJECTED|INVALID_RESPONSE|INCOMPLETE_BALANCE)$/.test(code)?code:'US_REQUEST_FAILED';}
async function stage(name,fn){try{return await fn();}catch(error){if(/^US_(BALANCE|CASH|QUOTES)_/.test(error.message)&&publicUSCode(error.message)!=='US_REQUEST_FAILED')throw error;const base=BASE.includes(error.code??error.message)?error.code??error.message:'REQUEST_FAILED';const wrapped=new Error('US_'+name+'_'+base);wrapped.retryAt=error.retryAt;wrapped.brokerCode=error.brokerCode;wrapped.httpStatus=error.httpStatus;throw wrapped;}}
function records(value){if(value==null||value==='')return [];if(Array.isArray(value))return value;if(typeof value==='object')return Object.keys(value).length?[value]:[];throw new Error('INVALID_RESPONSE');}
module.exports={publicUSCode,stage,records,ORDER_CODES,ORDER_OPERATIONS};
