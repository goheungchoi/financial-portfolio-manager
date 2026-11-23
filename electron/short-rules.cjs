'use strict';
// Short selling by the app, B3b (artifacts/reviews/2026-11-24-short-selling; design note-3-b3.md): the rules a short sale
// must pass before it is sent. Pure: no I/O, no clock of its own. Nothing here sends anything, and every credit path stays
// not executable until B4 (credit-paths.cjs). Every rule fails closed: a figure, time or input it cannot read refuses.
// - Instrument: KOSPI and KOSDAQ stocks. ETF short sales are refused until KRX's ETF tick table is confirmed from its own
//   rules and written here with its source.
// - Borrowable: KIS's per-stock lending list (CTSC2702R) for the stock's market, read just before the order, at most a
//   minute old; the read must be for this stock and this market; sendable only when lending is open (psbl_yn Y) and the
//   tradable quantity covers the order.
// - Cap: all shorts together, open and waiting plus this one, at most maxPct (20%) of the account value (the low bound
//   when the value is a range). No per-stock cap (the user's answer). A short or waiting order whose amount cannot be
//   read refuses the new one.
// - Price: the uptick rule, always as the smallest valid price above the last trade (allowed whether or not the last
//   trade rose); in the opening auction, the smallest valid price above the previous close. Never a market order. Every
//   price sent or revised is at or above the floor read then; no repricing on a stale last trade or during the auction.
// - Venue and session: KRX only; the regular session or the opening auction (08:30-09:00) only. No short in the closing
//   auction (15:20-15:30), pre- or after-market, on NXT or through SOR: no price is given there.
// - Freshness: a time more than 5 s ahead of the clock, or no readable clock, is not fresh.
// - Words for a refusal: KIS gives no reason, so they list what the app checked and what it cannot check.
const {krTick}=require('./agent-desk.cjs');

const MAX_BORROW_AGE_MS=60000,LAST_TRADE_FRESH_MS=60000,FUTURE_SKEW_MS=5000,DEFAULT_MAX_PCT=20;
const VENUE='KRX';
// CTSC2702R's EXCG_DVSN_CD by the stock's market: KOSPI 02, KOSDAQ 03 (the user's answer: both).
const LEND_EXCHANGE={KOSPI:'02',KOSDAQ:'03'};
function lendExchange(market){const code=LEND_EXCHANGE[String(market??'').toUpperCase()];if(!code)throw new Error('SHORT_MARKET_UNSUPPORTED');return code;}
// Whether this kind of instrument may be shorted: stocks; ETFs not yet (their tick table is not confirmed).
function instrumentAllowed({market,type}){if(!LEND_EXCHANGE[String(market??'').toUpperCase()])return {ok:false,code:'SHORT_MARKET_UNSUPPORTED',words:'Short sales are for KOSPI and KOSDAQ stocks only.'};
  if(type==='etf')return {ok:false,code:'SHORT_ETF_NOT_ENABLED',words:'ETF short sales are not yet enabled.'};
  if(type!=='stock')return {ok:false,code:'SHORT_INSTRUMENT_UNKNOWN',words:'Whether this is a stock or an ETF is not known, so it is not shorted.'};return {ok:true};}

// A number, or null: null, undefined, '' and anything not numeric are not read as 0.
const num=v=>{if(v==null||v==='')return null;const n=typeof v==='number'?v:Number(String(v).replace(/,/g,''));return Number.isFinite(n)?n:null;};
const positive=v=>{const n=num(v);return n!=null&&n>0?n:null;};
const wholePositive=v=>Number.isSafeInteger(v)&&v>0;
// Whether a time is fresh against now: within maxAge, not more than 5 s ahead, and now readable.
function fresh(at,now,maxAge){return Number.isFinite(now)&&Number.isFinite(at)&&at<=now+FUTURE_SKEW_MS&&now-at<=maxAge;}

// One CTSC2702R row for one stock, as read: the market code it was read with, lending open, tradable quantity now, the
// pool's limit and use, and when read.
function parseBorrowable(row,at,exchange){if(!row||typeof row!=='object')return null;
  return {symbol:String(row.pdno??row.symbol??''),exchange:exchange??null,open:String(row.psbl_yn??'').toUpperCase()==='Y',tradable:num(row.trad_psbl_qty2),limit:num(row.lmt_qty1),used:num(row.use_qty1),at:Number.isFinite(at)?at:null};}
// Whether this quantity of this stock may be shorted on this read: {ok} or {ok:false, code, stale}. A read over a minute
// old, ahead of the clock, or for another stock or market is not used (the caller reads again).
function borrowable(read,quantity,now,{symbol,market}={}){
  if(!wholePositive(quantity))return {ok:false,code:'INVALID_ORDER'};
  if(!read||!Number.isFinite(read.at))return {ok:false,code:'SHORT_BORROW_UNKNOWN'};
  if(typeof symbol!=='string'||read.symbol!==symbol)return {ok:false,code:'SHORT_BORROW_OTHER_STOCK'};
  let code=null;try{code=lendExchange(market);}catch{return {ok:false,code:'SHORT_MARKET_UNSUPPORTED'};}if(read.exchange!==code)return {ok:false,code:'SHORT_BORROW_OTHER_MARKET'};
  if(!fresh(read.at,now,MAX_BORROW_AGE_MS))return {ok:false,code:'SHORT_BORROW_STALE',stale:true};
  if(!read.open)return {ok:false,code:'SHORT_NOT_LENDABLE'};
  if(!(Number.isFinite(read.tradable)&&read.tradable>=quantity))return {ok:false,code:'SHORT_BORROW_SHORT',tradable:read.tradable};
  return {ok:true,tradable:read.tradable};}

// The account value the cap is measured against: the exact value, else the low bound of a range; never KIS's total.
function capBase(value){const exact=positive(value?.exact);if(exact!=null)return exact;return positive(value?.low);}
// The cap on all shorts together: open shorts (their obligation at market, loanAmount), waiting short orders (notional)
// and this one. {ok, usedPct, afterPct, maxPct} or a refusal. Any amount that cannot be read refuses.
function capCheck({value,shorts=[],waiting=[],notional,maxPct=DEFAULT_MAX_PCT}){
  const max=positive(maxPct);if(max==null||max>100)return {ok:false,code:'SHORT_CAP_UNKNOWN',maxPct:null};
  const base=capBase(value);if(base==null)return {ok:false,code:'SHORT_CAP_UNKNOWN',maxPct:max};
  const order=positive(notional);if(order==null)return {ok:false,code:'INVALID_ORDER',maxPct:max};
  if(!Array.isArray(shorts)||!Array.isArray(waiting))return {ok:false,code:'SHORT_CAP_UNKNOWN',maxPct:max};
  const open=shorts.map(s=>positive(s?.loanAmount)),pending=waiting.map(o=>positive(o?.notional));
  if(open.includes(null)||pending.includes(null))return {ok:false,code:'SHORT_CAP_UNKNOWN',maxPct:max};
  const used=[...open,...pending].reduce((n,v)=>n+v,0),usedPct=used/base*100,afterPct=(used+order)/base*100;
  return afterPct<=max+1e-9?{ok:true,usedPct,afterPct,maxPct:max}:{ok:false,code:'SHORT_CAP_REACHED',usedPct,afterPct,maxPct:max};}

// The next price on the Korean tick grid at or above p.
function upToTick(p){let t=krTick(p);let v=Math.ceil(p/t)*t;t=krTick(v);return Math.ceil(v/t)*t;}
// The uptick floor: the smallest valid price above the last trade (an off-grid last trade too: 2001 gives 2005).
function floorPrice(last){const l=positive(last);if(l==null)return null;return upToTick(Math.floor(l)+1);}
// In the opening auction: the smallest valid price above the previous close.
function auctionFloor(previousClose){return floorPrice(previousClose);}
// Venue and session: KRX, the regular session or the opening auction only.
const SESSIONS=new Set(['regular','auction']);
function sessionAllowed(session){return SESSIONS.has(session);}
// The floor that applies now, or null when no short may be priced: outside the allowed sessions, no readable clock, or no
// fresh last trade in the regular session.
function floorNow({session,last,lastAt,previousClose,now}){
  if(!sessionAllowed(session)||!Number.isFinite(now))return null;
  if(session==='auction')return auctionFloor(previousClose);
  if(!fresh(lastAt,now,LAST_TRADE_FRESH_MS))return null;return floorPrice(last);}
// The price a new short is sent at: the placement price raised to the floor, on the grid. null: not sendable now.
function shortPrice(placement,floor){const f=positive(floor);if(f==null)return null;const p=positive(placement);return Math.max(p!=null?upToTick(p):f,f);}
// The tracker for an open short sale. target: the usual best-bid target; current: the order's price. Returns the new
// price, or null with why it stays. An order whose price still meets the floor is not moved because the floor rose.
function reviseShort({current,target,session,last,lastAt,previousClose,now}){
  if(!sessionAllowed(session))return {price:null,why:'no short outside the regular session and the opening auction'};
  if(session==='auction')return {price:null,why:'no repricing during the opening auction'};
  const floor=floorNow({session,last,lastAt,previousClose,now});if(floor==null)return {price:null,why:'no fresh last trade, kept at its price'};
  const cur=positive(current);if(cur==null)return {price:null,why:'its price cannot be read'};
  if(cur<floor)return {price:floor,why:'raised to the uptick floor'};
  const t=positive(target),next=t!=null?Math.max(upToTick(t),floor):null;if(next==null||next===cur)return {price:null,why:null};
  return {price:next,why:next===floor&&upToTick(t)<floor?'held at the uptick floor':null};}

// The signed exposure of a position, with exposure.cjs's factor convention: the daily multiple of the index, negative for
// inverse products (-1 inverse, -2 2x inverse). A short flips the sign, so a short of an inverse product is long.
function signedExposure({value,factor=1,short=false}){const v=num(value),f=num(factor);if(v==null||f==null||f===0)throw new Error('INVALID_EXPOSURE');return Math.abs(v)*f*(short?-1:1);}

// The Activity words for a short KIS refused (it gives no reason): what the app checked, and what it cannot check. Only
// validated values are printed. checked: {borrowable, floorOk, capAfterPct, capMaxPct}. Made-up figures in tests only.
function refusalWords({symbol,name=null,quantity,price,checked={}}){const fmt=n=>Number(n).toLocaleString('en-US');const pct=n=>`${Math.round(n*10)/10}%`;
  const what=typeof name==='string'&&/^[\p{L}\p{N} .&()'-]{1,40}$/u.test(name)?name:/^\d{6}$/.test(String(symbol??''))?symbol:'the stock';
  const qty=wholePositive(quantity)?`${fmt(quantity)} `:'',at=positive(price)!=null?` at ${fmt(price)}`:'';
  const done=[...(wholePositive(checked.borrowable)&&wholePositive(quantity)?[`borrowable ${fmt(checked.borrowable)} ≥ ${fmt(quantity)}`]:[]),...(checked.floorOk===true?['price above the last trade']:[]),VENUE,...(num(checked.capAfterPct)!=null&&num(checked.capAfterPct)>=0?[`cap ${pct(num(checked.capAfterPct))} of ${pct(positive(checked.capMaxPct)??DEFAULT_MAX_PCT)}`]:[])];
  return `Short of ${qty}${what}${at} refused by KIS (no reason given). The app checked: ${done.join(', ')}. Not checkable here: the exchange's short-sale ban list for today, and your KIS stock-loan limit.`;}

module.exports={MAX_BORROW_AGE_MS,LAST_TRADE_FRESH_MS,FUTURE_SKEW_MS,DEFAULT_MAX_PCT,VENUE,lendExchange,instrumentAllowed,parseBorrowable,borrowable,capBase,capCheck,upToTick,floorPrice,auctionFloor,floorNow,shortPrice,reviseShort,sessionAllowed,signedExposure,refusalWords,fresh};
