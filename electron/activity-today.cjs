// The Activity tab's Today strip (artifacts/reviews/2026-11-18-activity-tab, step 3): today's orders by what happened
// to them, and the latest five, from the app's own records only (live_intents of both markets, its reviews and its
// conditional orders), so it shows before KIS answers and costs no KIS request. Orders made outside the app are not
// in these records; they appear in the period list once KIS is read.
const {originOf}=require('./order-origin.cjs');
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];
// Why an order did not reach KIS, in words.
const NOT_SENT={'ticket-expired':'the check with KIS expired before it was sent','rate-limit':'the KIS request limit was reached',SESSION_CLOSED:'the market was closed',
  CREDIT_PATH_UNVERIFIED:'its credit path is not verified',INTEGRATED_MARGIN_AUTOMATION_BLOCKED:'automatic U.S. purchases were off then (integrated margin not verified)',APPROVAL_REQUIRED:'it needed your approval',SUPERSEDED:'a newer order replaced it',EXPIRED:'it expired unapproved',
  // A(b) 1, 2026-11-19: the order codes a refused send can carry (order-outcomes.cjs ORDER), in words.
  PRODUCT_APPROVAL_REQUIRED:'this product needs your approval',EXTENDED_APPROVAL_REQUIRED:'an extended-session order needs your approval',EXTENDED_SIZE_LIMIT:'it is above the extended-session size limit',
  BROKER_ORDER_MISMATCH:'KIS reported a different order',BROKER_REJECTED:'KIS rejected it',CONCENTRATION_LIMIT:'it would go over the per-company limit',DAILY_TURNOVER_LIMIT:'the day\'s turnover limit is reached',
  DAILY_LOSS_RESTRICTED:'the daily loss limit restricts new purchases',EXCEEDS_LOT:'it is more than the shares free in its lot',NO_SUCH_LOT:'its lot was not found',FEATURE_UNAVAILABLE:'this account does not offer it',
  INSTRUMENT_NOT_ALLOWED:'this stock is not allowed for automatic orders',INSUFFICIENT_CAPACITY:'there was not enough buying power',INVALID_INSTRUMENT:'the stock code was not valid',INVALID_ORDER:'the order was not valid',
  KIS_ORDER_BUSY:'another order was being sent',LEVERAGED_EXPOSURE_LIMIT:'it would go over the leveraged-product limit',LEVERAGED_NOT_ENABLED:'leveraged and inverse products are off',LIMIT_CHANGED:'its limits changed while it was being sent',
  MARGIN_LIMIT:'it would go over the margin limit',MARGIN_NOT_ENABLED:'margin trading is off',SHORT_LIMIT:'it would go over the short-selling limit',SHORT_NOT_ENABLED:'short selling is off',
  OPEN_BROKER_ORDERS:'another order for it is open at KIS',ORDER_NOT_SENT:'it could not be sent',TICKET_EXPIRED:'the check with KIS expired before it was sent',RATE_LIMITED:'the KIS request limit was reached',
  ORDER_SIZE_LIMIT:'it is above the order size limit',ORDER_UNCERTAIN:'KIS\'s reply was unclear, so it is not confirmed',PRICE_MOVED:'the price moved past its limit',RECONCILIATION_REQUIRED:'open orders must be confirmed with KIS first',
  FX_STALE:'the exchange rate was too old',FUNDING_BALANCE_STALE:'the cash reading was too old to check its funding',
  // Order-rule audit item 13, 2026-11-19: the STOP codes (order-outcomes.cjs STOP), in words. They stop the rest of a
  // batch; these say why for the Console, Home, Activity and the review failure line.
  STALE_DECISION:'the account or saved settings changed during the review',AUTO_TRADING_STOPPED:'automatic trading was stopped',
  SEVERAL_OPEN_OFF:'several open orders was turned off',BATCH_LIMIT:'the batch limit (5 minutes from the decision) passed',
  ACCOUNT_CHANGED:'another KIS account was connected',ACTIVATION_REQUIRED:'trading for this market is not switched on',AUTH_FAILED:'KIS sign-in failed',
  AUTO_KIS_DISABLED:'automatic orders are off for this market',BROKER_UNAVAILABLE:'the KIS connection stopped',
  DAILY_SESSION_SETUP_REQUIRED:'today\'s trading session is not set up yet (switch the market\'s trading on again)',
  DISABLED_OR_EXPIRED:'trading was switched off or the order expired (2 minutes after it was made)',
  FUNDING_OVERCOMMITTED:'KIS reported more shares filled than the app held funds for, so new buys stop until that is reviewed',
  INCOMPLETE_BALANCE:'KIS returned an incomplete balance',US_BALANCE_INVALID_RESPONSE:'KIS returned a U.S. balance the app cannot read',
  INVALID_RESPONSE:'KIS returned a reply the app cannot read',REQUEST_FAILED:'a KIS request failed',INVALID_CREDENTIAL_FILE:'the KIS key file could not be read',
  INVALID_LIMITS:'the saved limits are not valid',INVALID_SETTINGS:'the saved settings are not valid',KIS_NOT_CONNECTED:'KIS is not connected',
  KIS_TRADING_DISABLED:'trading for this market is switched off',NO_FUNDED_BALANCE:'the account has no cash or holdings',
  RISK_DATA_UNAVAILABLE:'the risk data could not be read',INCOMPLETE_HISTORY:'KIS returned an incomplete order history',
  INVALID_DATE_RANGE:'the date range is not valid',INVALID_RELEASE:'a funding release was not valid',INVALID_REQUEST:'the request was not valid',
  ORDER_NOT_OPEN:'the order is no longer open',ORDER_TAKEN_OVER:'the order was changed outside the app',TRACKING_STOPPED:'its tracking was stopped',
  UNKNOWN_ORDER:'the order was not found',UNKNOWN_PROPOSAL:'the proposal was not found'};
// A code in words: the sentence above, else the code in lower case (as before).
function reasonText(code){return NOT_SENT[code]??String(code??'not sent').toLowerCase().replace(/_/g,' ');}
const seoulDay=t=>Number.isFinite(t)?new Date(t+9*3600000).toISOString().slice(0,10):null;
// What happened to one order: {kind, label, reason?}. kind: filled | partly | open | notSent | rejected | waiting | canceled.
function stateOf(o,now=Date.now()){
  const filled=Number(o.filled)||0,qty=Number(o.quantity)||0;
  if(o.status==='Filled'||qty>0&&filled>=qty)return {kind:'filled',label:'Filled'};
  if(o.status==='Rejected'){if(o.reason==='BROKER_REJECTED')return {kind:'rejected',label:'Rejected by KIS'};
    const why=o.reason==='ORDER_NOT_SENT'?NOT_SENT[o.notSentCause]??'it could not be sent':NOT_SENT[o.reason]??String(o.reason??'not sent').toLowerCase().replace(/_/g,' ');return {kind:'notSent',label:'Not sent',reason:why};}
  if(filled>0&&!OPEN.includes(o.status))return {kind:'partly',label:`Partly filled (${filled} of ${qty})`};
  if(OPEN.includes(o.status))return filled>0?{kind:'partly',label:`Partly filled (${filled} of ${qty}), open`}:{kind:'open',label:o.status==='Accepted'?'Open':o.status};
  if(o.status==='Ready'){const expired=Number.isFinite(o.expiresAt)&&o.expiresAt<=now;return expired?{kind:'notSent',label:'Not sent',reason:NOT_SENT[o.reason]??NOT_SENT.EXPIRED}:{kind:'waiting',label:'Waiting for your approval'};}
  if(o.status==='Canceled')return {kind:'canceled',label:'Canceled'};
  return {kind:'open',label:String(o.status??'Unknown')};}
// intents: both markets' live_intents rows; reviews, conditionals: payloads. Returns {day, counts, latest}.
function today({intents=[],reviews=[],conditionals=[],now=Date.now()}={}){
  const day=seoulDay(now);const mine=intents.filter(o=>seoulDay(o.createdAt)===day).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
  const counts={orders:mine.length,sent:0,filled:0,partly:0,open:0,notSent:0,rejected:0,waiting:0,canceled:0};
  const rows=mine.map(o=>{const s=stateOf(o,now);counts[s.kind]++;if(o.brokerOrderId)counts.sent++;return {o,s};});
  const latest=rows.slice(0,5).map(({o,s})=>({id:o.id,at:o.createdAt??null,market:o.market??'KR',symbol:o.symbol,side:o.side,quantity:o.quantity,filled:Number(o.filled)||0,
    state:s.kind,label:s.label,...(s.reason?{reason:s.reason}:{}),origin:originOf(o,{reviews,conditionals}).label}));
  return {day,counts,latest};}
module.exports={today,stateOf,NOT_SENT,seoulDay,reasonText};
