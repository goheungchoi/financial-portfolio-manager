// Where an order is placed and kept: at the best bid for a sale and the best ask for a purchase, so it fills as the
// agent decided, never past the agent's bound (the lowest price a sale may take, the highest a purchase may pay).
// 2026-10-29: the GOOGL sell went in at $287.64 from a pre-open quote while the book's best bid was $285.32; it never
// filled and the price kept falling.
const {krTick}=require('./agent-desk.cjs');
const MAX_BOOK_AGE_MS=10000,REVISE_PCT=0.2;
// A usable book from a market-evidence order_book reply: read within the last 10 seconds (by the app; a quiet stock's
// book can stay unchanged for minutes) and two-sided.
function usableBook(reply,now=Date.now()){const d=reply?.data;if(reply?.status!=='available'||!d)return null;const at=Number(reply.retrievedAt);
  if(!Number.isFinite(at)||now-at>MAX_BOOK_AGE_MS||at>now+1000||!(d.bid>0)||!(d.ask>0)||d.ask<d.bid)return null;return {bid:d.bid,ask:d.ask,retrievedAt:at,quoteAt:d.quoteAt??null};}
// A price on the market's grid, rounded up (dir 1) or down (dir -1): cents in the U.S., the exchange tick in Korea.
// Float noise is removed first (279.5*100 is 27950.000000000004).
function onGrid(price,dir,market){const round=dir>0?Math.ceil:Math.floor;
  if(market==='US')return round(Math.round(price*1e6)/1e4)/100;const t=krTick(price);return round(Math.round(price/t*1e6)/1e6)*t;}
// The limit for a side: the best bid (Sell) or ask (Buy), held at the bound when the market is beyond it. The best
// price is already on the grid; a bound is rounded so it is never crossed (a sale's up, a purchase's down).
function target({side,book,bound=null,market}){const sell=side==='Sell',best=sell?book.bid:book.ask;
  const limit=bound>0?onGrid(bound,sell?1:-1,market):null;const atBound=limit!=null&&(sell?best<limit:best>limit);
  return {price:atBound?limit:onGrid(best,sell?-1:1,market),best,atBound};}
// Whether an order at `current` should move to `next`: a change of at least 0.2% of the order's price.
const shouldRevise=(current,next)=>current>0&&next>0&&Math.abs(next-current)/current*100>=REVISE_PCT-1e-9;
module.exports={usableBook,target,onGrid,shouldRevise,MAX_BOOK_AGE_MS,REVISE_PCT};
