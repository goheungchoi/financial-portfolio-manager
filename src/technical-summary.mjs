// Technical summary for one timeframe of OHLC bars (oldest first: {timestamp, open, high, low, close, volume}):
// moving averages, indicators and pivot points, each read by a fixed rule, and a rating from the counts.
// Display only; the trading AI does not receive these readings. RSI, ATR and ADX use Wilder smoothing like
// electron/indicators.cjs (the tests check both give the same values).
export const TIMEFRAMES=[{id:'5m',label:'5 min',minutes:5},{id:'15m',label:'15 min',minutes:15},{id:'30m',label:'30 min',minutes:30},{id:'1h',label:'Hourly',minutes:60},{id:'1d',label:'Daily'},{id:'1w',label:'Weekly'},{id:'1M',label:'Monthly'}];
export const MA_PERIODS=[5,10,20,50,100,200];
export const RATINGS={'strong-buy':'Strong buy',buy:'Buy',neutral:'Neutral',sell:'Sell','strong-sell':'Strong sell'};
export const SIGNALS={buy:'Buy',sell:'Sell',neutral:'Neutral',overbought:'Overbought',oversold:'Oversold','high-volatility':'High volatility','low-volatility':'Low volatility'};
const sum=a=>a.reduce((x,y)=>x+y,0);
const round=(v,d=4)=>v==null||!Number.isFinite(v)?null:Math.round(v*10**d)/10**d;
// Exponential average seeded with the simple average of the first n values; one value per bar from bar n.
function ema(values,n){if(values.length<n)return [];const k=2/(n+1);let e=sum(values.slice(0,n))/n;const out=[e];for(const v of values.slice(n)){e=v*k+e*(1-k);out.push(e);}return out;}
function wilder(values,n){if(values.length<n)return [];let s=sum(values.slice(0,n))/n;const out=[s];for(const v of values.slice(n)){s=(s*(n-1)+v)/n;out.push(s);}return out;}
const sma=(values,n)=>values.length<n?null:sum(values.slice(-n))/n;
function rsiSeries(closes,n=14){if(closes.length<=n)return [];const ch=closes.slice(1).map((c,i)=>c-closes[i]);const up=wilder(ch.map(x=>Math.max(0,x)),n),down=wilder(ch.map(x=>Math.max(0,-x)),n);
  return up.map((u,i)=>{const d=down[i];return u===0&&d===0?50:d===0?100:100-100/(1+u/d);});}
const trueRanges=c=>c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i].close),Math.abs(x.low-c[i].close)));
const highest=(c,n)=>Math.max(...c.slice(-n).map(x=>x.high)),lowest=(c,n)=>Math.min(...c.slice(-n).map(x=>x.low));

// Readings: each returns {value, signal} or null when there are too few bars.
const band=(v,{over,under,buy,sell})=>v>=over?'overbought':v<=under?'oversold':v>=buy?'buy':v<=sell?'sell':'neutral';
/** @type {[string,(c:any[])=>({value:number,signal:string,counted?:boolean}|null)][]} */
const INDICATORS=[
  ['RSI(14)',c=>{const r=rsiSeries(c.map(x=>x.close)).at(-1);return r==null?null:{value:r,signal:band(r,{over:70,under:30,buy:55,sell:45})};}],
  // Slow stochastic: %K over 9 bars, averaged over 6.
  ['STOCH(9,6)',c=>{if(c.length<14)return null;const k=[];for(let i=c.length-6;i<c.length;i++){const w=c.slice(i-8,i+1),hi=highest(w,9),lo=lowest(w,9);k.push(hi>lo?100*(c[i].close-lo)/(hi-lo):50);}const v=sum(k)/6;return {value:v,signal:band(v,{over:80,under:20,buy:55,sell:45})};}],
  ['STOCHRSI(14)',c=>{const r=rsiSeries(c.map(x=>x.close)).slice(-14);if(r.length<14)return null;const hi=Math.max(...r),lo=Math.min(...r),v=hi===lo?50:100*(r.at(-1)-lo)/(hi-lo);return {value:v,signal:band(v,{over:80,under:20,buy:55,sell:45})};}],
  // MACD(12,26) against its 9-bar signal line.
  ['MACD(12,26)',c=>{const closes=c.map(x=>x.close);if(closes.length<34)return null;const f=ema(closes,12).slice(14),s=ema(closes,26);const line=s.map((v,i)=>f[i]-v),sig=ema(line,9);const m=line.at(-1),g=sig.at(-1);return {value:m,signal:m>g?'buy':m<g?'sell':'neutral'};}],
  // ADX(14): a trend of 25 or more reads in the direction of +DI against −DI; under 25 the trend is too weak to read.
  ['ADX(14)',c=>{if(c.length<29)return null;const plus=[],minus=[];for(let i=1;i<c.length;i++){const up=c[i].high-c[i-1].high,down=c[i-1].low-c[i].low;plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);}
    const tr=wilder(trueRanges(c),14),p=wilder(plus,14),m=wilder(minus,14),pdi=p.map((v,i)=>tr[i]?100*v/tr[i]:0),mdi=m.map((v,i)=>tr[i]?100*v/tr[i]:0);
    const a=wilder(pdi.map((v,i)=>v+mdi[i]?100*Math.abs(v-mdi[i])/(v+mdi[i]):0),14).at(-1);return {value:a,signal:a<25?'neutral':pdi.at(-1)>mdi.at(-1)?'buy':pdi.at(-1)<mdi.at(-1)?'sell':'neutral'};}],
  ['Williams %R',c=>{if(c.length<14)return null;const hi=highest(c,14),lo=lowest(c,14),v=hi>lo?-100*(hi-c.at(-1).close)/(hi-lo):-50;return {value:v,signal:band(v,{over:-20,under:-80,buy:-45,sell:-55})};}],
  ['CCI(14)',c=>{if(c.length<14)return null;const tp=c.slice(-14).map(x=>(x.high+x.low+x.close)/3),m=sum(tp)/14,md=sum(tp.map(x=>Math.abs(x-m)))/14,v=md?(tp.at(-1)-m)/(0.015*md):0;return {value:v,signal:band(v,{over:200,under:-200,buy:100,sell:-100})};}],
  // ATR(14) against its own average of the previous 14 bars: volatility, not direction, so it is not counted.
  ['ATR(14)',c=>{if(c.length<29)return null;const a=wilder(trueRanges(c),14),v=a.at(-1),before=a.slice(-15,-1);return {value:v,signal:v>sum(before)/before.length?'high-volatility':'low-volatility',counted:false};}],
  // Highs/Lows(14): how far the latest high is under the 14-bar high plus how far its low is over the 14-bar low.
  ['Highs/Lows(14)',c=>{if(c.length<14)return null;const x=c.at(-1),v=((x.high-highest(c,14))+(x.low-lowest(c,14)))/2,tiny=x.close*0.0005;return {value:v,signal:v>tiny?'buy':v<-tiny?'sell':'neutral'};}],
  ['Ultimate Oscillator',c=>{if(c.length<29)return null;const bp=[],tr=[];for(let i=1;i<c.length;i++){const lo=Math.min(c[i].low,c[i-1].close),hi=Math.max(c[i].high,c[i-1].close);bp.push(c[i].close-lo);tr.push(hi-lo);}
    const avg=n=>{const t=sum(tr.slice(-n));return t?sum(bp.slice(-n))/t:0;};const v=100*(4*avg(7)+2*avg(14)+avg(28))/7;return {value:v,signal:band(v,{over:70,under:30,buy:52,sell:48})};}],
  ['ROC(12)',c=>{if(c.length<13)return null;const v=(c.at(-1).close/c.at(-13).close-1)*100;return {value:v,signal:v>0?'buy':v<0?'sell':'neutral'};}],
  // Bull/Bear Power(13): the latest high and low against their 13-bar exponential average.
  ['Bull/Bear Power(13)',c=>{const e=ema(c.map(x=>x.close),13).at(-1);if(e==null)return null;const x=c.at(-1),v=(x.high-e)+(x.low-e);return {value:v,signal:v>0?'buy':v<0?'sell':'neutral'};}],
];
// A rating from counts: (buy − sell) over the readings counted; neutral, overbought and oversold count as neutral.
export function rating({buy=0,sell=0,neutral=0}){const n=buy+sell+neutral;if(!n)return null;const s=(buy-sell)/n;return s>=0.6?'strong-buy':s>=0.2?'buy':s>-0.2?'neutral':s>-0.6?'sell':'strong-sell';}
const tally=signals=>{const t={buy:0,sell:0,neutral:0};for(const s of signals)t[s==='buy'||s==='sell'?s:'neutral']++;return t;};
// Pivot points from the bar before the latest one (the latest is usually still forming).
export function pivots(bar){if(!bar||!(bar.high>=bar.low)||!(bar.low>0))return null;const {high:h,low:l,close:c}=bar,p=(h+l+c)/3,r=h-l;
  return {from:{timestamp:bar.timestamp,high:h,low:l,close:c},classic:{s3:l-2*(h-p),s2:p-r,s1:2*p-h,p,r1:2*p-l,r2:p+r,r3:h+2*(p-l)},fibonacci:{s3:p-r,s2:p-0.618*r,s1:p-0.382*r,p,r1:p+0.382*r,r2:p+0.618*r,r3:p+r}};}
export function summarize(candles){
  const c=(candles??[]).filter(x=>[x?.open,x?.high,x?.low,x?.close].every(Number.isFinite)&&x.low>0&&x.high>=x.low);if(c.length<2)return null;
  const closes=c.map(x=>x.close),price=closes.at(-1),side=v=>v==null?null:price>v?'buy':price<v?'sell':'neutral';
  const averages=MA_PERIODS.map(period=>{const s=sma(closes,period),e=ema(closes,period).at(-1)??null;return {period,simple:s==null?null:{value:round(s),signal:side(s)},exponential:e==null?null:{value:round(e),signal:side(e)}};});
  const maSignals=averages.flatMap(a=>[a.simple?.signal,a.exponential?.signal]).filter(Boolean),maCounts=tally(maSignals);
  const indicators=INDICATORS.map(([name,read])=>{const r=read(c);return {name,value:r?round(r.value):null,signal:r?.signal??null,counted:r?r.counted!==false:false};});
  const indSignals=indicators.filter(r=>r.counted&&r.signal).map(r=>r.signal),indCounts=tally(indSignals);
  const all={buy:maCounts.buy+indCounts.buy,sell:maCounts.sell+indCounts.sell,neutral:maCounts.neutral+indCounts.neutral};
  return {bars:c.length,price,asOf:c.at(-1).timestamp,rating:rating(all),counts:all,
    movingAverages:{rows:averages,counts:maCounts,rating:rating(maCounts)},indicators:{rows:indicators,counts:indCounts,rating:rating(indCounts)},pivots:pivots(c.at(-2))};
}
// One-minute bars into n-minute bars, aligned to the clock (09:00 KST and whole hours fall on bar starts).
export function aggregate(candles,minutes){const out=new Map();for(const x of [...(candles??[])].sort((a,b)=>a.timestamp-b.timestamp)){const t=Math.floor(x.timestamp/(minutes*60000))*minutes*60000,o=out.get(t);
  out.set(t,o?{...o,high:Math.max(o.high,x.high),low:Math.min(o.low,x.low),close:x.close,volume:(o.volume??0)+(x.volume??0)}:{...x,timestamp:t});}return [...out.values()];}
