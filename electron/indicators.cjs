// Technical indicators from daily candles (oldest first: {date, open, high, low, close, volume}). Values only, no buy/sell labels.
const r2=v=>v==null||!Number.isFinite(v)?null:Math.round(v*100)/100;
function ema(values,n){if(values.length<n)return [];const k=2/(n+1);let e=values.slice(0,n).reduce((a,b)=>a+b,0)/n;const out=[e];for(const v of values.slice(n)){e=v*k+e*(1-k);out.push(e);}return out;}
// Wilder smoothing: first value is the simple average, then prior × (n−1)/n + current / n.
function wilder(values,n){if(values.length<n)return [];let s=values.slice(0,n).reduce((a,b)=>a+b,0)/n;const out=[s];for(const v of values.slice(n)){s=(s*(n-1)+v)/n;out.push(s);}return out;}
const hasRange=c=>c.length&&c.every(x=>Number.isFinite(x.high)&&Number.isFinite(x.low)&&x.high>=x.low&&x.high>0);
function rsi(closes,n=14){if(closes.length<=n)return null;const ch=closes.slice(1).map((c,i)=>c-closes[i]);const up=wilder(ch.map(x=>Math.max(0,x)),n),down=wilder(ch.map(x=>Math.max(0,-x)),n);const u=up.at(-1),d=down.at(-1);if(u===0&&d===0)return 50;return d===0?100:100-100/(1+u/d);}
function macd(closes,fast=12,slow=26,signal=9){if(closes.length<slow+signal)return null;const f=ema(closes,fast).slice(slow-fast),s=ema(closes,slow);const line=s.map((v,i)=>f[i]-v);const sig=ema(line,signal);const m=line.at(-1),g=sig.at(-1);return {macd:m,signal:g,histogram:m-g,previousHistogram:line.length>1&&sig.length>1?line.at(-2)-sig.at(-2):null};}
function trueRanges(c){return c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i].close),Math.abs(x.low-c[i].close)));}
function atr(c,n=14){if(!hasRange(c)||c.length<=n)return null;return wilder(trueRanges(c),n).at(-1);}
function adx(c,n=14){
  if(!hasRange(c)||c.length<2*n+1)return null;
  const plus=[],minus=[];for(let i=1;i<c.length;i++){const up=c[i].high-c[i-1].high,down=c[i-1].low-c[i].low;plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);}
  const tr=wilder(trueRanges(c),n),p=wilder(plus,n),m=wilder(minus,n);const pdi=p.map((v,i)=>tr[i]?100*v/tr[i]:0),mdi=m.map((v,i)=>tr[i]?100*v/tr[i]:0);
  const dx=pdi.map((v,i)=>v+mdi[i]?100*Math.abs(v-mdi[i])/(v+mdi[i]):0);const a=wilder(dx,n);return {adx:a.at(-1),plusDI:pdi.at(-1),minusDI:mdi.at(-1)};
}
function cci(c,n=14){if(!hasRange(c)||c.length<n)return null;const tp=c.map(x=>(x.high+x.low+x.close)/3).slice(-n);const m=tp.reduce((a,b)=>a+b,0)/n;const md=tp.reduce((a,b)=>a+Math.abs(b-m),0)/n;return md?(tp.at(-1)-m)/(0.015*md):0;}
function stochRsi(closes,n=14){if(closes.length<2*n+1)return null;const series=[];for(let i=closes.length-n;i<=closes.length;i++)series.push(rsi(closes.slice(0,i),n));const v=series.filter(x=>x!=null);if(v.length<2)return null;const lo=Math.min(...v),hi=Math.max(...v);return hi===lo?50:100*(v.at(-1)-lo)/(hi-lo);}
function ultimate(c,a=7,b=14,d=28){if(!hasRange(c)||c.length<=d)return null;const bp=[],tr=[];for(let i=1;i<c.length;i++){const low=Math.min(c[i].low,c[i-1].close),high=Math.max(c[i].high,c[i-1].close);bp.push(c[i].close-low);tr.push(high-low);}
  const avg=n=>{const s=tr.slice(-n).reduce((x,y)=>x+y,0);return s?bp.slice(-n).reduce((x,y)=>x+y,0)/s:0;};return 100*(4*avg(a)+2*avg(b)+avg(d))/7;}
// Everything at once, rounded; null where the history is too short or highs and lows are missing.
function technicals(candles){
  const c=(candles??[]).filter(x=>Number.isFinite(x.close)&&x.close>0);if(c.length<15)return null;const closes=c.map(x=>x.close);const last=closes.at(-1);
  const m=macd(closes),a=atr(c),d=adx(c),hi=Math.max(...closes.slice(-20)),lo=Math.min(...closes.slice(-20));
  return {asOf:c.at(-1).date,rsi14:r2(rsi(closes)),stochRsi14:r2(stochRsi(closes)),macd:m?{line:r2(m.macd),signal:r2(m.signal),histogram:r2(m.histogram),histogramRising:m.previousHistogram==null?null:m.histogram>m.previousHistogram}:null,
    atr14:r2(a),atrPct:a?r2(a/last*100):null,adx14:d?r2(d.adx):null,plusDI:d?r2(d.plusDI):null,minusDI:d?r2(d.minusDI):null,cci14:r2(cci(c)),ultimate:r2(ultimate(c)),
    range20:{high:r2(hi),low:r2(lo),positionPct:hi>lo?r2((last-lo)/(hi-lo)*100):null},
    note:'Daily candles. RSI, ATR and ADX use Wilder smoothing; ADX above about 25 means a strong trend, +DI vs −DI its direction. ATR is the typical daily range; useful for stop distances. Values are context, not signals.'};
}
module.exports={ema,wilder,rsi,macd,atr,adx,cci,stochRsi,ultimate,technicals};
