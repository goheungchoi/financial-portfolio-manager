'use strict';
// The code a broker-worker failure carries back to the app (kis-worker.cjs). Kept apart so tests can check the codes
// as the app receives them, after this relabelling (2026-11-19 order-rule audit, item 3: U.S. order refusals were
// relabelled US_REQUEST_FAILED here, and a test that read the throw sites alone could not see it).
const KR_ALLOWED=['TOKEN_EXPIRED','INVALID_CREDENTIAL_FILE','CREDIT_ACCOUNT_REQUIRED','INVALID_RESPONSE','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','BROKER_REJECTED','INCOMPLETE_BALANCE','INCOMPLETE_HISTORY','INVALID_DATE_RANGE','FEATURE_UNAVAILABLE','INVALID_ORDER','SESSION_CLOSED','PRICE_MOVED','INSUFFICIENT_CAPACITY','OPEN_BROKER_ORDERS','ORDER_UNCERTAIN','ORDER_NOT_SENT','TICKET_EXPIRED',
  // Item 3, both markets: the credit-path backstop in placeCreditOrder (before any request) keeps its code, so the
  // engine records the order as not placed (live-engine send) instead of Uncertain from REQUEST_FAILED.
  'CREDIT_PATH_UNVERIFIED',
  // Short selling B3c: the borrowable check at preparation (short-rules.cjs).
  'SHORT_NOT_LENDABLE','SHORT_BORROW_SHORT','SHORT_BORROW_STALE','SHORT_BORROW_UNKNOWN','SHORT_BORROW_OTHER_STOCK','SHORT_BORROW_OTHER_MARKET','SHORT_MARKET_UNSUPPORTED',
  // B3d-1.
  'SHORT_BELOW_UPTICK','SHORT_OPEN_CASH_UNKNOWN'];
const SENDS=['place-order','us-place-order','revise-order','us-revise-order'];
// M-1a: an order request refused before it left the app (the request-limit window, including the sign-in that may
// precede it) is not at KIS. An expired or missing ticket (M-1c) keeps its own code: also not sent, for another reason
// than the request limit. M-1.5a: revisions and cancellations too (a sign-in refused before the request included).
function relayCode(operation,error){
  const code=SENDS.includes(operation)&&error?.notSent===true&&!['TICKET_EXPIRED','TOKEN_EXPIRED'].includes(error.code)?'ORDER_NOT_SENT':error?.code??error?.message;
  if(String(operation).startsWith('us-')){const U=require('./us-errors.cjs');return U.publicUSCode(code,{order:U.ORDER_OPERATIONS.includes(operation)});}
  return KR_ALLOWED.includes(code)?code:'REQUEST_FAILED';}
module.exports={relayCode,KR_ALLOWED};
