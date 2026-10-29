// Live ticks into chart bars. A tick: {symbol, price, timestamp, volume?, dayVolume?, session?, source}. volume is this
// trade's shares (stream), dayVolume the day's total so far. Bars are {timestamp, open, high, low, close, volume}, oldest first.
/** @typedef {{symbol:string,price:number,timestamp:number,volume?:number,dayVolume?:number,session?:string|null,source?:string}} Tick */
const dayKey=(t,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone}).format(new Date(t));
// Where a new daily bar starts for each market, as the app's daily bars are stamped (KIS Korea: 00:00 KST; U.S.: 12:00 UTC).
export const dayStart=(day,market)=>market==='US'?Date.parse(day+'T12:00:00Z'):Date.parse(day+'T00:00:00+09:00');
/**
 * @param {any[]} candles
 * @param {Tick} tick
 * @param {{period:number|'day'|'last',market?:'KR'|'US'}} options period: bar length in ms, 'day', or 'last' (only the
 *   latest bar changes, for weekly and monthly bars).
 */
export function applyTick(candles,tick,{period,market='KR'}){
  // KIS daytime-session prices come from another venue than the bars (they can differ by several percent), so they
  // move no bars; the Charts header still shows them, labelled.
  const price=tick?.price;if(!(price>0)||!Number.isFinite(tick.timestamp)||tick.session==='us-daytime')return candles;
  const last=candles?.at(-1);const list=candles??[];
  const merge=bar=>({...bar,high:Math.max(bar.high,price),low:Math.min(bar.low,price),close:price,
    volume:period==='day'&&tick.dayVolume!=null?Math.max(bar.volume??0,tick.dayVolume):(bar.volume??0)+(period==='day'||period==='last'?0:tick.volume??0)});
  const fresh=t=>({timestamp:t,open:price,high:price,low:price,close:price,volume:period==='day'?(tick.dayVolume??0):(tick.volume??0)});
  if(period==='last'){if(!last||tick.timestamp<last.timestamp)return list;return [...list.slice(0,-1),merge(last)];}
  if(period==='day'){
    const zone=market==='US'?'America/New_York':'Asia/Seoul',day=dayKey(tick.timestamp,zone);
    if(last){const lastDay=dayKey(last.timestamp,zone);if(lastDay===day)return [...list.slice(0,-1),merge(last)];if(lastDay>day)return list;}
    return [...list,fresh(dayStart(day,market))];}
  // Bars on the clock: a tick belongs to the bar whose period contains it.
  const start=Math.floor(tick.timestamp/period)*period;
  if(last){const lastStart=Math.floor(last.timestamp/period)*period;if(start<lastStart)return list;if(start===lastStart)return [...list.slice(0,-1),merge(last)];}
  return [...list,fresh(start)];
}
