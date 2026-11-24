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

// B3e: the share of the account value all shorts use now and what is left under the cap, by capCheck's own rule (open
// shorts, waiting short orders); null when any amount, the base or the cap cannot be read.
function capUse({value,shorts=[],waiting=[],maxPct=DEFAULT_MAX_PCT}){const r=capCheck({value,shorts,waiting,notional:Number.MIN_VALUE,maxPct});
  if(!Number.isFinite(r.usedPct))return null;const round=v=>Math.round(v*10)/10;return {capUsedPct:round(r.usedPct),capLeftPct:round(Math.max(0,r.maxPct-r.usedPct))};}
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

// B3c. The loan date a new short (CRDT_TYPE 22) sends: B4 decides which one KIS's API accepts, from the order row it
// reads back. 'trade-day' (what the code sent before B3c) or 'settlement' (T+2 Korean business days, what KIS's own app
// recorded in the hand test). One constant, so B4 can try one and, on a refusal, the other.
const SHORT_LOAN_DATE_RULE='trade-day';
const nextDay=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
// today: the Seoul trade day (YYYY-MM-DD); isOpen(day): true or false when known (the KIS calendar), else weekdays.
function shortLoanDate(today,rule=SHORT_LOAN_DATE_RULE,isOpen=null){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(today??'')))throw new Error('INVALID_DATE');if(rule==='trade-day')return today;
  if(rule!=='settlement')throw new Error('INVALID_RULE');const {isBusinessDay}=require('./business-days.cjs');let d=today,n=0;while(n<2){d=nextDay(d);if(isBusinessDay('KR',d,{krOpen:isOpen}))n++;}return d;}
// After a credit fill the balance shows it 1-3 minutes later. A fill counts until a balance read after it was seen shows
// it: a filled cover keeps its quantity reserved until the lot reads lower by it (or gone), and a filled short counts
// toward the cap until the stock's short rows read higher by it. Time never releases it; an unknown time or an unknown
// lot at sending keeps it (fail closed). lotAtSend: the lot's (a cover) or the stock's short (a short) quantity in the
// balance read at sending.
const BALANCE_WAIT_WORDS_MS=600000;
const seenAt=o=>Number.isFinite(o?.filledObservedAt)?o.filledObservedAt:o?.reconciledAt;
// others: the other fills on the same lot (a cover) or the same stock's shorts (a short). The balance must account for
// this fill and every other sent on the same or a later reading (lotAtSendAt; unknown counts), so fills sent on one
// reading are released together, only once the balance shows all of them (B3c review 2).
function balanceShows(order,balance,quantityNow,others=[]){const filled=Number(order?.filled)||0;if(filled<=0)return true;const at=Date.parse(balance?.timestamp??''),seen=seenAt(order);
  if(!(Number.isFinite(at)&&Number.isFinite(seen)&&at>seen&&Number.isFinite(order.lotAtSend)&&Number.isFinite(quantityNow)))return false;
  const all=groupFilled(order,others);return order.side==='Buy'?quantityNow<=order.lotAtSend-all:quantityNow>=order.lotAtSend+all;}
// This fill and every other sent on the same or a later reading (an unknown reading time counts).
function groupFilled(order,others){const since=order.lotAtSendAt;return (Number(order?.filled)||0)+(Array.isArray(others)?others:[]).filter(o=>o&&o!==order&&o.id!==order.id&&Number(o.filled)>0&&!(Number.isFinite(since)&&Number.isFinite(o.lotAtSendAt)&&o.lotAtSendAt<since)).reduce((n,o)=>n+(Number(o.filled)||0),0);}
// How much of the fills the balance still has to show, as this order's reading sees it: the balance's quantity less what
// the lot should read after this fill and every later one (a cover), or the reverse (a short). With an unknown time or
// lot, every fill of the group (fail closed).
function unshownQuantity(order,balance,quantityNow,others=[]){const all=groupFilled(order,others);const at=Date.parse(balance?.timestamp??''),seen=seenAt(order);
  if(!(Number.isFinite(at)&&Number.isFinite(seen)&&at>seen&&Number.isFinite(order.lotAtSend)&&Number.isFinite(quantityNow)))return all;
  return Math.max(0,order.side==='Buy'?quantityNow-(order.lotAtSend-all):(order.lotAtSend+all)-quantityNow);}
const shortQuantity=(balance,symbol)=>(balance?.shorts??[]).filter(s=>s.symbol===symbol).reduce((n,s)=>n+(Number(s.quantity)||0),0);
// The app's filled shorts the balance does not show yet, as waiting notionals for capCheck.
// Per stock: the short quantity the balance still has to show (the most any order's reading finds), at the highest price.
function laggingShorts(orders,balance){const shorts=(Array.isArray(orders)?orders:[]).filter(o=>o?.side==='Sell'&&o.credit?.kind==='short'&&Number(o.filled)>0);const out=[];
  for(const symbol of new Set(shorts.map(o=>o.symbol))){const group=shorts.filter(o=>o.symbol===symbol),q=shortQuantity(balance,symbol);const missing=Math.max(0,...group.map(o=>unshownQuantity(o,balance,q,group)));
    if(missing>0)out.push({notional:missing*Math.max(...group.map(o=>Number(o.fillPrice??o.limitPrice)||0))});}return out;}
// Words for a fill the balance has not shown for over 10 minutes (or since an unknown time), so the user sees why no
// further cover goes out.
function balanceWaitWords(order,now){const seen=seenAt(order);return !Number.isFinite(seen)||!Number.isFinite(now)||now-seen>BALANCE_WAIT_WORDS_MS?'waiting for KIS\'s balance to show the cover':null;}
// B3c reconcile: KIS's order rows for the app's short or cover say what KIS did; a name or loan date that does not match
// the app's record is reported in words (null when it matches or there is nothing to compare).
function creditRowCheck(order,rows){const kind=order?.credit?.kind;if(!['short','cover'].includes(kind))return null;const list=(Array.isArray(rows)?rows:[]).filter(r=>r&&typeof r.creditName==='string');if(!list.length)return null;
  // Only KIS's known names are printed; anything else is "an unknown kind".
  const KNOWN=new Set(['현금매수','현금매도','유대신규','유대상환','유대매도','유대매도거부','자대신규','자대상환','유통융자신규','유통융자상환','자기융자신규','자기융자상환']);
  const names=[...new Set(list.map(r=>KNOWN.has(r.creditName)?r.creditName:'an unknown kind'))],words=[];
  if(kind==='short'&&!names.some(n=>/대/.test(n)&&/(신규|매도)/.test(n)))words.push(`KIS recorded it as ${names.join(', ')}, not a new short sale`);
  if(kind==='cover'&&!names.some(n=>/대/.test(n)&&/상환/.test(n)))words.push(`KIS recorded it as ${names.join(', ')}, not a cover`);
  if(kind==='cover'&&order.credit.loanDate){const dates=[...new Set(list.map(r=>r.loanDate).filter(Boolean))];if(dates.length&&!dates.includes(order.credit.loanDate))words.push(`its loan date at KIS is ${dates.join(', ')}, the app sent ${order.credit.loanDate}`);}
  return words.length?words.join('; ')+'.':null;}

// The shortfall of open shorts (the user's answer, 2026-11-24: "Yes hold it back"): what buying each open short back
// costs now beyond the proceeds KIS holds for it, max(0, quantity x price - proceeds), from the balance's own rows, for
// every open short (the app's or one opened by hand). The sum is held back from the cash the app's own buys may use.
// A short with no price or no proceeds figure makes the whole unknown (known false): the app's buys then wait.
// No short open: amount 0, known, nothing held (as before).
function shortfall(balance){const open=(balance?.shorts??[]).filter(s=>Number(s.quantity)>0);const rows=[],missing=[];
  for(const s of open){const q=Number(s.quantity),p=Number(s.price),proceeds=s.proceeds;
    if(!(p>0)||!(typeof proceeds==='number'&&Number.isFinite(proceeds)&&proceeds>=0)){missing.push(s.symbol);continue;}
    const amount=Math.max(0,Math.round(q*p-proceeds));if(amount>0)rows.push({symbol:s.symbol,loanDate:s.loanDate??null,amount});}
  return {open:open.length,known:missing.length===0,amount:rows.reduce((n,r)=>n+r.amount,0),rows,missing};}
const SHORTFALL_UNKNOWN_WORDS='a short is open and what buying it back costs beyond its proceeds could not be read';
module.exports={capUse,shortfall,SHORTFALL_UNKNOWN_WORDS,MAX_BORROW_AGE_MS,LAST_TRADE_FRESH_MS,FUTURE_SKEW_MS,DEFAULT_MAX_PCT,VENUE,lendExchange,instrumentAllowed,parseBorrowable,borrowable,capBase,capCheck,upToTick,floorPrice,auctionFloor,floorNow,shortPrice,reviseShort,sessionAllowed,signedExposure,refusalWords,fresh,SHORT_LOAN_DATE_RULE,shortLoanDate,BALANCE_WAIT_WORDS_MS,balanceShows,unshownQuantity,shortQuantity,laggingShorts,balanceWaitWords,creditRowCheck};
