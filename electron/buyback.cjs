'use strict';
// The buy-back block (the user's rule): after a stock is sold outside the app (in KIS's own app or elsewhere; a
// cash sale of all or part of the shares, found in KIS's order history as orders that match no app order), the app's own
// buys of it are refused for BLOCK_DAYS from that sale. A buy of the stock made outside the app after the sale lifts it, and
// so does your Remove (it covers sales up to its time: a later sale outside the app blocks again). The list is derived from
// the recorded KIS order history at each use; only Removes are stored. Sales, stops, covers and repayments are never
// blocked, nor your own order ticket (your own act); a short sale made outside the app blocks nothing (not a sale of a
// holding). Korea and the U.S. alike.
const {appOrderIds,kindOf}=require('./outside-fills.cjs');
const BLOCK_DAYS=30,DAY=86400000;
// A row's time: KIS's order time; a U.S. row without one (older records) counts from the end of its New York day (EST,
// so never early), and a lift or Remove is then compared with that time.
const timeOf=(r,market)=>Number.isFinite(r.timestamp)?r.timestamp:market==='US'&&/^\d{4}-\d{2}-\d{2}$/.test(r.day??'')?Date.parse(r.day+'T23:59:59-05:00'):NaN;
// A row that an app order whose KIS reply was lost (no order number yet) could be: same stock, side and day. It is not
// taken as an order made outside the app until that order is resolved.
// Bounded: the row's quantity must be the order's, and its time within 10 minutes of when the order was made.
const uncertainCould=(r,intents,market)=>(Array.isArray(intents)?intents:[]).some(i=>(i?.market??'KR')===market&&!i.brokerOrderId&&['Submitting','Uncertain'].includes(i.status)&&i.symbol===r.symbol&&i.side===r.side&&i.day===r.day
  &&Number(r.quantity)===Number(i.quantity)&&(!Number.isFinite(r.timestamp)||!Number.isFinite(i.createdAt)||Math.abs(r.timestamp-i.createdAt)<=600000));
const seoulDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);
// The cash orders made outside the app in these rows, as {symbol, side, filled, at, orderId}. Korean rows by KIS's kind
// name (cash orders only); U.S. rows are all cash orders.
function outsideCashTrades(rows,intents,market){const list=(Array.isArray(rows)?rows:[]).filter(r=>r&&(r.market??'KR')===market&&Number(r.filled)>0);const mine=appOrderIds(list,intents,market);
  const {keyOf}=require('./outside-fills.cjs'),{norm}=require('./order-chain.cjs');
  return list.filter(r=>!mine.has(keyOf(r.day,r.orderId))&&(market!=='KR'||kindOf(r)==='cash'))
    .filter(r=>!uncertainCould(r,intents,market)).map(r=>({market,symbol:r.symbol,side:r.side,filled:Number(r.filled),at:timeOf(r,market),orderId:norm(r.orderId),day:r.day})).filter(t=>Number.isFinite(t.at));}
// The blocks now: per symbol, the latest outside sale within BLOCK_DAYS not lifted by a later outside buy or by a Remove
// made at or after it. Each {market, symbol, soldOn, soldAt, blockedUntil, orderId}.
function blocksFrom(trades,removals,now=Date.now()){const out=[];
  for(const symbol of [...new Set(trades.map(t=>t.symbol))]){const mine=trades.filter(t=>t.symbol===symbol).sort((a,b)=>a.at-b.at);const sale=mine.filter(t=>t.side==='Sell').at(-1);
    if(!sale||now-sale.at>=BLOCK_DAYS*DAY)continue;if(mine.some(t=>t.side==='Buy'&&t.at>sale.at))continue;const removed=removals[`${sale.market}|${symbol}`];if(Number.isFinite(removed)&&removed>=sale.at)continue;
    out.push({market:sale.market,symbol,soldOn:seoulDay(sale.at),soldAt:sale.at,blockedUntil:seoulDay(sale.at+BLOCK_DAYS*DAY),orderId:sale.orderId});}
  return out.sort((a,b)=>b.soldAt-a.soldAt);}
const refusal=b=>`Not sent: you sold ${b.symbol} outside the app on ${b.soldOn}; app buys of it are blocked until ${b.blockedUntil}, or until you remove it in Activity.`;
// The user's rule when the list cannot be known: the app's own buys wait. A market whose history is not ready (not read
// since the start, its missed days not read) or whose list could not be built gives {unknown}; one market never holds the
// other. Otherwise the stock's block, or null.
function blockFor({ready,errors=[],list=[],market,symbol}){if(!ready)return {unknown:true,market,why:'not read yet'};if((errors??[]).some(e=>e.market===market))return {unknown:true,market,why:'could not be read'};
  return (list??[]).find(b=>b.market===market&&b.symbol===symbol)??null;}
const waitWords=b=>`Not sent: the app ${b.why==='could not be read'?'could not read':'has not yet read'} the orders you made outside the app in the ${b.market==='US'?'U.S.':'Korean'} account (KIS's order history), so it cannot tell whether you sold this stock there; its own buys wait until it can.`;
// Whether a market's history is ready (the user's rule: buys wait until it is): its missed days read for the engine's
// account, and the history complete up to a recent time: Korea by historyThrough, no older than 6 minutes; the U.S. read
// in the last 4 minutes while its session is open, or after its session closed (lastOpenAt).
function historyReady(engine,market,{now=Date.now(),sessionOpen=()=>false,lastOpenAt=0}={}){try{if(engine?.missedRead!==true||engine.historyKey!==engine.identity())return false;}catch{return false;}
  const r=engine.historyReadAt;if(!Number.isFinite(r))return false;
  // A few missed reads: 6 minutes while open (a read a minute), 11 in the 5-minute windows before the open and
  // after the session.
  if(market==='KR'){const F=require('./outside-fills.cjs'),t=F.historyThrough({readAt:r,ready:true,now});return t!=null&&now-t<=(F.lateWindow(now)?11:6)*60000;}
  return sessionOpen(market,now)?now-r<=4*60000:r>=(lastOpenAt??0);}
// The day to read missed history back from, latched once per account before any reading of this start is saved (the
// caller latches at its first reading): the reading before the start, or, with none, BLOCK_DAYS + 1 days back.
function startLatch(lastAt){const seen=new Map();
  return {latch(account){if(!account||seen.has(account))return;const t=lastAt(account);seen.set(account,Number.isFinite(t)?t:null);},
    from(account,dayOf,now=Date.now()){if(!account)return undefined;this.latch(account);const t=seen.get(account);return dayOf(Number.isFinite(t)?t:now-(BLOCK_DAYS+1)*DAY);}};}
// The markets that count: in scope and connected (no U.S. account: nothing to wait for there).
function marketsInScope({scope,kr=false,us=false}){if(scope==='paper')return [];return [...(kr&&['kis','both'].includes(scope)?['KR']:[]),...(us&&['us','both'].includes(scope)?['US']:[])];}
// Today's open orders at KIS that are not the app's, by the market's own day (the U.S. by its New York day).
// Order numbers are compared through the one helper (order-chain norm, outside-fills keyOf).
function openOutsideOrders(source,today){const {appOrderIds,keyOf}=require('./outside-fills.cjs'),{norm}=require('./order-chain.cjs');const mine=appOrderIds(source.rows??[],source.intents??[],source.market);
  return (source.rows??[]).filter(r=>r.day===today&&Number(r.remaining)>0&&!/cancel|reject/i.test(r.status??'')&&!mine.has(keyOf(r.day,r.orderId)))
    .map(r=>({market:source.market,symbol:r.symbol,side:r.side,quantity:r.quantity,remaining:r.remaining,price:r.orderPrice??null,at:r.timestamp,orderId:norm(r.orderId),...(r.creditName?{creditName:r.creditName}:{})}));}
// What an order handler returns for a refused order: the code, and the dated words of the block's refusals.
const refusalReply=(error,allowed)=>({error:allowed(error?.message)||['BUYBACK_BLOCKED','BUYBACK_UNKNOWN'].includes(error?.message)?error.message:null,...(['BUYBACK_BLOCKED','BUYBACK_UNKNOWN'].includes(error?.message)&&typeof error.detail==='string'?{detail:error.detail}:{})});
// Which orders the block applies to: an app buy, a margin buy included; never a sale, a cover or your own ticket.
const appliesTo=({side,credit=null,ticket=false})=>side==='Buy'&&credit!=='cover'&&!ticket;
// A block check that throws counts as unknown (fail closed).
function check(engine,symbol,market){try{return engine.buybackBlock?.(symbol)??null;}catch(error){engine.buybackFailure={at:Date.now(),error:String(error?.message??error).slice(0,60)};return {unknown:true,market,why:'could not be read'};}}
// The refusal for an app buy, or null: BUYBACK_UNKNOWN while the list cannot be known, BUYBACK_BLOCKED for a blocked stock.
function refusalFor(engine,symbol,market){const b=check(engine,symbol,market);if(!b)return null;return b.unknown?Object.assign(new Error('BUYBACK_UNKNOWN'),{detail:waitWords(b),block:b}):Object.assign(new Error('BUYBACK_BLOCKED'),{detail:refusal(b),block:b});}
const ticketLine=b=>`You sold this outside the app on ${b.soldOn}; the app's own buys of it are blocked until ${b.blockedUntil}.`;
class BuybackBlocks{
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS buyback_removals(account TEXT NOT NULL,market TEXT NOT NULL,symbol TEXT NOT NULL,removedAt INTEGER NOT NULL,PRIMARY KEY(account,market,symbol))');}
  removals(account){return Object.fromEntries(this.db.prepare('SELECT market,symbol,removedAt FROM buyback_removals WHERE account=?').all(account).map(r=>[`${r.market}|${r.symbol}`,r.removedAt]));}
  // sources: [{market, rows, intents}] (each engine's recorded history of the last BLOCK_DAYS and its app orders).
  // Each market on its own: one that cannot be read (errors collects it) does not take the other's blocks with it.
  list(account,sources,now=this.clock(),errors=null){if(typeof account!=='string'||!account)return [];const removals=this.removals(account);
    return (sources??[]).flatMap(s=>{try{return blocksFrom(outsideCashTrades(s.rows,s.intents,s.market),removals,now);}catch(error){errors?.push?.({market:s.market,error:String(error?.message??error).slice(0,60)});return [];}}).sort((a,b)=>b.soldAt-a.soldAt);}
  // Any symbol the engines accept (letters, digits and . - / after an exchange prefix).
  remove(account,market,symbol){if(typeof account!=='string'||!account||!['KR','US'].includes(market)||typeof symbol!=='string'||!/^[A-Z0-9:./-]{1,24}$/.test(symbol))throw new Error('INVALID_REQUEST');
    this.db.prepare('INSERT INTO buyback_removals VALUES(?,?,?,?) ON CONFLICT(account,market,symbol) DO UPDATE SET removedAt=excluded.removedAt').run(account,market,symbol,this.clock());}
}
module.exports={BuybackBlocks,blocksFrom,outsideCashTrades,refusal,ticketLine,blockFor,waitWords,check,refusalFor,appliesTo,historyReady,startLatch,marketsInScope,openOutsideOrders,refusalReply,BLOCK_DAYS};
