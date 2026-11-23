// The Home line while armed conditional orders are not watched (found in live use: they were taken to stay at KIS). Only
// when conditional orders are on, the account is not the paper one, and they are not watched (auto trading stopped or
// not started); the word follows what they are: "stops" only when every one is a stop loss.
export function unwatchedLine(state){const desk=state?.desk,config=state?.config;if(!desk||desk.monitoringActive!==false||!config?.conditionalOrders||config.scope==='paper')return null;
  const orders=Array.isArray(desk.orders)?desk.orders:[];const n=orders.length;if(!n)return null;const stops=orders.every(o=>o.purpose==='stop_loss');
  const what=stops?(n===1?'stop is':'stops are'):(n===1?'armed conditional order is':'armed conditional orders are');
  return `${n} ${what} not watched until auto trading is started.`;}
// Orders while stopped, B-1: armed orders watched, but their quote older than 2 minutes while their session is open
// (electron/armed-quotes.cjs staleArmed); never nothing.
// Each stock by its own cause (desk.staleWhy): KIS's request limit (with its time), no price from KIS for it, more stocks
// than can be priced (named by the orders left unwatched), or no fresh prices. One sentence per cause present.
const some=(list,n=4)=>`${list.slice(0,n).join(', ')}${list.length>n?` and ${list.length-n} more`:''}`;
export function stalePricesLine(state){const s=state?.desk?.stalePrices;if(!Array.isArray(s)||!s.length)return null;const why=state.desk.staleWhy??{gap:s};const out=[];
  if(why.limit?.stocks?.length){const at=Number.isFinite(why.limit.until)?new Date(why.limit.until).toLocaleTimeString('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'}):null;out.push(`Orders not watched: prices wait for KIS's request limit${at?` until ${at} KST`:''} (${some(why.limit.stocks)}).`);}
  if(why.failed?.length)out.push(`No price from KIS for ${some(why.failed)}: orders that need it are not watched.`);
  if(why.capacity?.orders?.length)out.push(`Too many stocks to price (${why.capacity.watched}): these orders are not watched: ${some(why.capacity.orders)}.`);
  if(why.gap?.length)out.push(`Orders not watched: no fresh prices (${some(why.gap)}).`);
  return out.length?out.join(' '):null;}
