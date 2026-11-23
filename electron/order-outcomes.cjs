// M-5 (d) (multi-order, artifacts/reviews/2026-11-16-multi-order/m5-plan.md section 5; the user's "Place the others"):
// what one order's failure means for the rest of a review's batch. Every code the order path can produce is named in
// one class; tests/order-outcomes.test.cjs collects the codes the engines, the broker clients and the ledgers can throw
// and fails on a code in neither class, so a new code is a choice.
// - ORDER: this order only; the rest of the batch goes on. Refusals of this order (limits, capacity, its price, its
//   lot, approval), the broker's refusal or an unclear reply (rule U: counted in full in every sum), the request limit
//   before it was sent, its market's session closed, the daily-loss restriction for an opening.
// - STOP: the rest are not sent (the orders before stand). The account, the settings or the engine changed or stopped,
//   the broker is not connected or not answering, the day's session is not set up, the batch limit, or a code that
//   should never come from a send (the app's own state is in question).
// A code in neither (an error the app does not know) also stops the rest, and the review is recorded as failed.
const ORDER=new Set(['APPROVAL_REQUIRED','PRODUCT_APPROVAL_REQUIRED','EXTENDED_APPROVAL_REQUIRED','EXTENDED_SIZE_LIMIT','BROKER_ORDER_MISMATCH','BROKER_REJECTED',
  'CONCENTRATION_LIMIT','CREDIT_PATH_UNVERIFIED','DAILY_TURNOVER_LIMIT','DAILY_LOSS_RESTRICTED','EXCEEDS_LOT','NO_SUCH_LOT','FEATURE_UNAVAILABLE','INSTRUMENT_NOT_ALLOWED',
  'INSUFFICIENT_CAPACITY','INTEGRATED_MARGIN_AUTOMATION_BLOCKED','INVALID_INSTRUMENT','INVALID_ORDER','KIS_ORDER_BUSY','LEVERAGED_EXPOSURE_LIMIT','LEVERAGED_NOT_ENABLED','SINGLE_STOCK_LEVERAGED',
  'BUYBACK_BLOCKED','BUYBACK_UNKNOWN','LIMIT_CHANGED','MARGIN_LIMIT','MARGIN_NOT_ENABLED','SHORT_LIMIT','SHORT_NOT_ENABLED','OPEN_BROKER_ORDERS','ORDER_NOT_SENT','TICKET_EXPIRED','RATE_LIMITED','ORDER_SIZE_LIMIT',
  'ORDER_UNCERTAIN','PRICE_MOVED','RECONCILIATION_REQUIRED','SESSION_CLOSED','FX_STALE','FUNDING_BALANCE_STALE']);
const STOP=new Set(['STALE_DECISION','AUTO_TRADING_STOPPED','SEVERAL_OPEN_OFF','BATCH_LIMIT','ACCOUNT_CHANGED','ACTIVATION_REQUIRED','AUTH_FAILED','AUTO_KIS_DISABLED','BROKER_UNAVAILABLE',
  'DAILY_SESSION_SETUP_REQUIRED','DISABLED_OR_EXPIRED','FUNDING_OVERCOMMITTED','INCOMPLETE_BALANCE','US_BALANCE_INVALID_RESPONSE','INVALID_RESPONSE','REQUEST_FAILED',
  'INVALID_CREDENTIAL_FILE','INVALID_LIMITS','INVALID_SETTINGS','KIS_NOT_CONNECTED','KIS_TRADING_DISABLED','NO_FUNDED_BALANCE','RISK_DATA_UNAVAILABLE',
  // Not expected from a send at all: their appearance means the app's own state is in question.
  'INCOMPLETE_HISTORY','INVALID_DATE_RANGE','INVALID_RELEASE','INVALID_REQUEST','ORDER_NOT_OPEN','ORDER_TAKEN_OVER','TRACKING_STOPPED','UNKNOWN_ORDER','UNKNOWN_PROPOSAL']);
// 'order', 'stop' or 'unknown' for an error's code.
function classOf(code){return ORDER.has(code)?'order':STOP.has(code)?'stop':'unknown';}
const codeOf=error=>typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)?error.message:null;
module.exports={ORDER,STOP,classOf,codeOf};
