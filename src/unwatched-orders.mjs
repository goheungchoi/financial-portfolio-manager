// The Home line while armed conditional orders are not watched (found in live use: they were taken to stay at KIS). Only
// when conditional orders are on, the account is not the paper one, and they are not watched (auto trading stopped or
// not started); the word follows what they are: "stops" only when every one is a stop loss.
// With "Keep them working while auto trading is stopped" on, whileStoppedLines says it instead, unless another account is
// connected (the setting is then void for it).
export function unwatchedLine(state){const desk=state?.desk,config=state?.config;if(!desk||desk.monitoringActive!==false||!config?.conditionalOrders||config.scope==='paper'||desk.whileStopped?.on&&!(desk.whileStopped.connected&&desk.whileStopped.matches===false))return null;
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
// Orders while stopped, B-4: Home's lines with the setting on. block: what holds orders back (the red status line);
// info: what is watched while auto trading is stopped, sent by themselves or only proposed.
export function whileStoppedLines(state){const w=state?.desk?.whileStopped,config=state?.config;if(!w?.on||!config?.conditionalOrders||config.scope==='paper')return {block:null,info:null};
  const armed=Array.isArray(state.desk.orders)?state.desk.orders.length:0;
  if(w.everythingStopped)return {block:'Everything stopped: no order is watched.',info:null};
  if(!w.connected)return {block:(w.orders??armed)?'Orders not watched: KIS is not connected.':null,info:null};
  if(!w.watching||w.running)return {block:null,info:null};
  const later=w.takesEffectAtStart?' "Submit them automatically" takes effect at the next Start.':'';
  if(w.lossLimit)return {block:`Daily loss limit reached: auto trading stopped. ${w.lossLimit.closing} closing ${w.lossLimit.closing===1?'order is':'orders are'} still watched; ${w.lossLimit.buysWait} ${w.lossLimit.buysWait===1?'buy waits':'buys wait'}.`,info:null};
  if(!w.orders)return {block:null,info:'Auto trading is stopped. Armed orders will be watched while it is stopped.'};
  return {block:null,info:`Auto trading is stopped. ${w.said??''}${later}`.trim()};}
// B-1's capacity, carried: more armed stocks outside the app's own price lists than about 10 per market.
export function capacityLine(state){const d=state?.desk,o=d?.outsidePolls;if(!d||d.monitoringActive!==true||!o)return null;
  const over=[['Korea',o.KR],['U.S.',o.US]].filter(([,n])=>Number(n)>10);if(!over.length)return null;
  return over.map(([m,n])=>`${m}: ${n} armed stocks are outside the app's price lists; about 10 can be kept current, so their prices may age.`).join(' ');}
// A stop that was hit and is held by the one-open rule (B-4 review): the holding has no working stop until that order is
// done. Running or stopped.
export function heldStopsLine(state){const u=(state?.desk?.unprotected??[]).filter(x=>x?.held);if(!u.length)return null;
  return u.map(x=>`${x.symbol} has no working stop loss: its stop was hit and is waiting (${x.waiting}).`).join(' ');}
// Short selling B3d-1: a conditional buy waits because a short is open and KIS's orderable cash could not be read.
export function shortCashWaitLine(state){const n=(state?.desk?.orders??[]).filter(o=>typeof o?.waiting==='string'&&o.waiting.startsWith('a short is open')).length;return n?`Buys wait: a short is open and KIS's orderable cash could not be read (${n} ${n===1?'order':'orders'}).`:null;}
