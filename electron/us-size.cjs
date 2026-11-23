'use strict';
// The U.S. size order for screens (note 6, S2, Q1): the largest stocks per exchange by market value, from Nasdaq's
// public stock screener (the same public data us-calendar reads; no key, no account, nothing of the user's is sent).
// One request per exchange, at most 400 rows, sorted by market value. Each exchange keeps its last good copy: a reply
// of the wrong shape, out of size order, larger than 8 MB (cut while reading) or with too few rows is not stored. An
// exchange is read again 20 hours after its last good copy, and an exchange that failed is retried after an hour
// without re-reading the others. If no copy exists, U.S. universes by size are not available; an order is never
// guessed. U.S. ETFs: Nasdaq's ETF screener lists no size, exchange or volume, so they have none.
const HEADERS={'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)','accept':'application/json, text/plain, */*'};
const EXCHANGES={NASD:'nasdaq',NYSE:'nyse',AMEX:'amex'};
const ROWS=400,MIN_ROWS=20,REFRESH_MS=20*3600000,RETRY_MS=3600000,MAX_BYTES=8*1024*1024;
const usd=v=>{const n=Number(String(v??'').replace(/[$,\s]/g,''));return Number.isFinite(n)&&n>0?n:null;};
const TICKER=/^[A-Z][A-Z0-9./-]{0,14}$/;
// A reply's rows, or null when its shape is not the screener's.
function parseRows(json){const rows=json?.data?.table?.rows;if(!Array.isArray(rows)||!Number.isFinite(Number(json?.data?.totalrecords)))return null;
  return rows.map(r=>({ticker:String(r?.symbol??'').trim().toUpperCase().replace('/','.'),marketCapUSD:usd(r?.marketCap)})).filter(r=>TICKER.test(r.ticker)&&r.marketCapUSD);}
// The body as text, stopping as soon as it passes MAX_BYTES.
async function readCapped(response){const reader=response.body?.getReader?.();if(!reader){const text=await response.text();if(text.length>MAX_BYTES)throw new Error('NASDAQ_UNAVAILABLE');return text;}
  const chunks=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){try{await reader.cancel();}catch{}throw new Error('NASDAQ_UNAVAILABLE');}chunks.push(value);}
  return Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8');}
async function getJSON(fetcher,url){const response=await fetcher(url,{headers:HEADERS,redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('NASDAQ_UNAVAILABLE');return JSON.parse(await readCapped(response));}
class UsSizeOrder{
  constructor(db,clock=Date.now,{readOnly=false}={}){this.db=db;this.clock=clock;this.failedAt={};if(readOnly)return;
    db.exec('CREATE TABLE IF NOT EXISTS us_size(exchange TEXT NOT NULL,rank INTEGER NOT NULL,symbol TEXT NOT NULL,marketCapUSD REAL NOT NULL,PRIMARY KEY(exchange,rank));CREATE TABLE IF NOT EXISTS us_size_meta(exchange TEXT PRIMARY KEY,at INTEGER NOT NULL,count INTEGER NOT NULL)');}
  // The largest n stocks of an exchange (or all three, by market value), with the copy's age; null when there is none.
  top(exchange,n){const list=exchange==='US'?Object.keys(EXCHANGES):[exchange];const metas=list.map(e=>this.db.prepare('SELECT at FROM us_size_meta WHERE exchange=?').get(e));
    if(metas.some(m=>!m))return null;
    const rows=this.db.prepare(`SELECT symbol FROM us_size WHERE exchange IN (${list.map(()=>'?').join(',')}) ORDER BY marketCapUSD DESC,symbol LIMIT ?`).all(...list,n).map(r=>r.symbol);
    return {symbols:rows,at:Math.min(...metas.map(m=>m.at))};}
  // The exchanges to read now.
  due(){const now=this.clock();return Object.keys(EXCHANGES).filter(e=>{const m=this.db.prepare('SELECT at FROM us_size_meta WHERE exchange=?').get(e);return (!m||now-m.at>REFRESH_MS)&&!(now-(this.failedAt[e]??0)<RETRY_MS);});}
  // known(symbol): whether the security master lists it (as a stock), so only symbols the tools accept are kept.
  async refresh({fetcher,known,pause=()=>new Promise(r=>setTimeout(r,800))}){const result={};
    for(const exchange of this.due()){const name=EXCHANGES[exchange];
      try{const rows=parseRows(await getJSON(fetcher,`https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=${ROWS}&offset=0&sortcolumn=marketCap&sortorder=desc&exchange=${name}&download=false`));
        const sorted=Boolean(rows)&&rows.every((r,i)=>i===0||r.marketCapUSD<=rows[i-1].marketCapUSD);
        const kept=(rows??[]).map(r=>({symbol:`${exchange}:${r.ticker}`,cap:r.marketCapUSD})).filter(r=>known(r.symbol));
        if(!rows||!sorted||kept.length<MIN_ROWS)throw new Error('NASDAQ_UNAVAILABLE');
        this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM us_size WHERE exchange=?').run(exchange);const put=this.db.prepare('INSERT INTO us_size VALUES(?,?,?,?)');kept.forEach((r,i)=>put.run(exchange,i+1,r.symbol,r.cap));
          this.db.prepare('INSERT INTO us_size_meta VALUES(?,?,?) ON CONFLICT(exchange) DO UPDATE SET at=excluded.at,count=excluded.count').run(exchange,this.clock(),kept.length);this.db.exec('COMMIT');}
        catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
        delete this.failedAt[exchange];result[exchange]=kept.length;}
      catch{this.failedAt[exchange]=this.clock();result[exchange]='kept the last copy';}
      await pause();}
    return result;}
}
module.exports={UsSizeOrder,parseRows,readCapped,EXCHANGES,MAX_BYTES};
