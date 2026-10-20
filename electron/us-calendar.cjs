// U.S. earnings calendar and the largest U.S. companies, from Nasdaq's public market data (the data behind nasdaq.com's
// earnings calendar and stock screener). No key; read-only. Dates are the company-scheduled report dates Nasdaq lists.
const HEADERS={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FinancialPortfolioManager','accept':'application/json, text/plain, */*'};
const TIMES={'time-after-hours':'after-close','time-pre-market':'before-open'};
const usd=v=>{const n=Number(String(v??'').replace(/[$,\s]/g,''));return Number.isFinite(n)&&n>0?n:null;};
// Nasdaq shows a negative EPS in parentheses, for example ($0.12).
const eps=v=>{const t=String(v??'');const n=usd(t.replace(/[()]/g,''));return n==null?null:t.includes('(')?-n:n;};
const tickerOk=t=>/^[A-Z][A-Z0-9.\/-]{0,14}$/.test(t);
async function getJSON(fetcher,url){const response=await fetcher(url,{headers:HEADERS,redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('NASDAQ_UNAVAILABLE');const text=await response.text();if(text.length>8*1024*1024)throw new Error('NASDAQ_UNAVAILABLE');return JSON.parse(text);}
function parseEarnings(json,date){
  const rows=json?.data?.rows;if(!Array.isArray(rows))return [];
  return rows.map(r=>({ticker:String(r?.symbol??'').trim().toUpperCase(),name:String(r?.name??'').trim().slice(0,80),date,time:TIMES[r?.time]??null,fiscalQuarter:String(r?.fiscalQuarterEnding??'').slice(0,12)||null,epsForecast:eps(r?.epsForecast),estimates:Number.isInteger(Number(r?.noOfEsts))?Number(r.noOfEsts):null,marketCapUSD:usd(r?.marketCap)})).filter(r=>tickerOk(r.ticker));
}
function parseScreener(json){const rows=json?.data?.table?.rows??json?.data?.rows;if(!Array.isArray(rows))return [];return rows.map(r=>({ticker:String(r?.symbol??'').trim().toUpperCase(),marketCapUSD:usd(r?.marketCap)})).filter(r=>tickerOk(r.ticker)&&r.marketCapUSD);}
// Nasdaq writes class shares as BRK/B or BRK.B; the app uses NASD:/NYSE:/AMEX: prefixes and a dot.
const appSymbol=(ticker,known)=>{const t=ticker.replace('/','.');for(const ex of ['NASD','NYSE','AMEX'])if(known(`${ex}:${t}`))return `${ex}:${t}`;return null;};
const weekdays=(today,days)=>{const out=[];for(let i=0;i<=days;i++){const d=new Date(Date.parse(today+'T00:00:00Z')+i*86400000);if(![0,6].includes(d.getUTCDay()))out.push(d.toISOString().slice(0,10));}return out;};
class UsCalendar {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS us_earnings(symbol TEXT PRIMARY KEY,date TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS us_largest(symbol TEXT PRIMARY KEY,rank INTEGER NOT NULL,marketCapUSD REAL);CREATE TABLE IF NOT EXISTS us_calendar_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');}
  meta(key){return this.db.prepare('SELECT value FROM us_calendar_meta WHERE key=?').get(key)?.value??null;}
  setMeta(key,value){this.db.prepare('INSERT INTO us_calendar_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
  // The listed report date for one symbol, if it is today or later.
  next(symbol,today){const row=this.db.prepare('SELECT payload FROM us_earnings WHERE symbol=? AND date>=?').get(symbol,today);return row?JSON.parse(row.payload):null;}
  largest(limit=200){return this.db.prepare('SELECT symbol FROM us_largest ORDER BY rank LIMIT ?').all(limit).map(r=>r.symbol);}
  status(){return {refreshedAt:Number(this.meta('refreshedAt'))||null,days:Number(this.meta('days'))||0,companies:this.db.prepare('SELECT COUNT(*) AS n FROM us_earnings').get().n,error:this.meta('error')||null};}
  // Re-reads every weekday in the window; a symbol takes the date of the day that lists it, and past dates are dropped.
  async refresh({fetcher,known,today,days=21,pause=()=>new Promise(r=>setTimeout(r,800))}){
    let read=0,failed=0;const dates=weekdays(today,days);
    for(const date of dates){
      try{const rows=parseEarnings(await getJSON(fetcher,`https://api.nasdaq.com/api/calendar/earnings?date=${date}`),date);read++;
        this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM us_earnings WHERE date=?').run(date);const put=this.db.prepare('INSERT INTO us_earnings VALUES(?,?,?) ON CONFLICT(symbol) DO UPDATE SET date=excluded.date,payload=excluded.payload');
          for(const r of rows){const symbol=appSymbol(r.ticker,known);if(symbol)put.run(symbol,date,JSON.stringify({...r,symbol,source:'Nasdaq earnings calendar'}));}this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
      catch{failed++;}
      await pause();
    }
    this.db.prepare('DELETE FROM us_earnings WHERE date<?').run(today);
    try{const rows=parseScreener(await getJSON(fetcher,'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=200&offset=0&sortcolumn=marketCap&sortorder=desc&download=false'));
      if(rows.length){this.db.exec('BEGIN IMMEDIATE');try{this.db.exec('DELETE FROM us_largest');const put=this.db.prepare('INSERT OR IGNORE INTO us_largest VALUES(?,?,?)');rows.forEach((r,i)=>{const symbol=appSymbol(r.ticker,known);if(symbol)put.run(symbol,i+1,r.marketCapUSD);});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}}
    catch{failed++;}
    this.setMeta('refreshedAt',this.clock());this.setMeta('days',read);this.setMeta('error',failed?`${failed} of ${dates.length+1} requests failed`:'');
    return {read,failed};
  }
}
module.exports={UsCalendar,parseEarnings,parseScreener,appSymbol,weekdays};
