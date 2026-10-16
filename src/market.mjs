// Provider contract: start(onQuote), stop(), getHistory(symbol, interval).
// Quotes carry exchange time and a per-symbol monotonically increasing sequence.
export const intervals = { '1m': 60000, '5m': 300000, '1d': 86400000 };
export class MarketCache {
  constructor(symbols, staleAfterMs = 5000) {
    this.symbols = new Set(symbols);
    this.quotes = new Map();
    this.staleAfterMs = staleAfterMs;
  }
  accept(quote, receivedAt = Date.now()) {
    if (!this.symbols.has(quote.symbol) || !Number.isSafeInteger(quote.sequence) || quote.sequence < 1 || !Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(quote.timestamp) || quote.timestamp > receivedAt + 1000 || !Number.isSafeInteger(quote.volume) || quote.volume < 0) return false;
    const previous = this.quotes.get(quote.symbol);
    if (previous && (quote.sequence <= previous.sequence || quote.timestamp < previous.timestamp)) return false;
    this.quotes.set(quote.symbol, {symbol:quote.symbol,price:quote.price,sequence:quote.sequence,timestamp:quote.timestamp,volume:quote.volume,receivedAt});
    return true;
  }
  snapshot(now = Date.now()) {
    return [...this.symbols].map(symbol => {
      const quote = this.quotes.get(symbol);
      return {symbol, ...quote, stale: !quote || now - quote.timestamp > this.staleAfterMs || now - quote.receivedAt > this.staleAfterMs};
    });
  }
}
export function updateCandle(series, quote, duration) {
  const bucket = Math.floor(quote.timestamp / duration) * duration;
  const last = series.at(-1);
  if (last && bucket < last.timestamp) return series;
  if (last && bucket === last.timestamp) return [...series.slice(0,-1), {...last, high:Math.max(last.high,quote.price),low:Math.min(last.low,quote.price),close:quote.price,volume:last.volume+quote.volume}];
  return [...series,{timestamp:bucket,open:quote.price,high:quote.price,low:quote.price,close:quote.price,volume:quote.volume}].slice(-100);
}
export class SyntheticMarketProvider {
  constructor(holdings, now = Date.now()) {
    this.rows = holdings.map(h => ({...h, sequence:0}));
    this.history = new Map();
    for (const row of this.rows) for (const [interval,duration] of Object.entries(intervals)) {
      const bucket = Math.floor(now/duration)*duration;
      const candles = Array.from({length:60},(_,i) => {
        const close = Math.round(row.price*(1+0.015*Math.sin(i*.5))/10)*10;
        const open = Math.round(row.price*(1+0.015*Math.sin((i-1)*.5))/10)*10;
        return {timestamp:bucket-(60-i)*duration,open,close,high:Math.max(open,close)+100,low:Math.max(10,Math.min(open,close)-100),volume:1000+i*30};
      });
      this.history.set(`${row.symbol}:${interval}`,candles);
    }
  }
  emit(now = Date.now()) {
    for (const row of this.rows) {
      row.sequence++;
      const price = Math.max(10,Math.round(row.price*(1+.0015*Math.sin(row.sequence*.7+Number(row.symbol)))/10)*10);
      const quote = {symbol:row.symbol,sequence:row.sequence,price,timestamp:now,volume:10+row.sequence%20};
      for (const [interval,duration] of Object.entries(intervals)) {
        const key = `${row.symbol}:${interval}`;
        this.history.set(key,updateCandle(this.history.get(key),quote,duration));
      }
      this.onQuote?.(quote);
    }
  }
  start(onQuote) {
    this.stop(); this.onQuote = onQuote; this.emit();
    this.timer = setInterval(()=>this.emit(),1000);
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
  getHistory(symbol, interval) {
    if (!this.rows.some(row=>row.symbol===symbol) || !Object.hasOwn(intervals,interval)) throw new Error('Unsupported instrument or interval');
    return this.history.get(`${symbol}:${interval}`).map(c=>({...c}));
  }
}
