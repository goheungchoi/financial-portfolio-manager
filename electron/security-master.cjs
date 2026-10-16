const zlib=require('node:zlib');
// Local symbol list built from KIS's public master files. Public market data only; no account access.
const BASE='https://new.real.download.dws.co.kr/common/master/';
const SOURCES=[
  {file:'kospi_code.mst.zip',market:'KOSPI',kind:'kr',tail:227},
  {file:'kosdaq_code.mst.zip',market:'KOSDAQ',kind:'kr',tail:221},
  {file:'nasmst.cod.zip',market:'NASD',kind:'us'},
  {file:'nysmst.cod.zip',market:'NYSE',kind:'us'},
  {file:'amsmst.cod.zip',market:'AMEX',kind:'us'}];
const REFRESH_MS=20*3600000,MAX_ZIP=10*1024*1024,MAX_FILE=60*1024*1024;
const KR_TYPES={ST:'stock',FS:'stock',EF:'etf',EN:'etn',RT:'reit',MF:'fund',BC:'fund',IF:'fund',DR:'stock'};
// Single-entry ZIP archives as published by KIS.
function unzipSingle(buffer){
  if(buffer.length<30||buffer.readUInt32LE(0)!==0x04034b50)throw new Error('MASTER_FORMAT');
  const flags=buffer.readUInt16LE(6),method=buffer.readUInt16LE(8),size=buffer.readUInt32LE(18),nameLength=buffer.readUInt16LE(26),extraLength=buffer.readUInt16LE(28),start=30+nameLength+extraLength;
  if(flags&8||start+size>buffer.length||![0,8].includes(method))throw new Error('MASTER_FORMAT');
  const data=buffer.subarray(start,start+size);const out=method===8?zlib.inflateRawSync(data,{maxOutputLength:MAX_FILE}):data;return out;
}
function lines(buffer){const rows=[];let start=0;for(let i=0;i<=buffer.length;i++){if(i===buffer.length||buffer[i]===10){let end=i;if(end>start&&buffer[end-1]===13)end--;if(end>start)rows.push(buffer.subarray(start,end));start=i+1;}}return rows;}
// Domestic rows are fixed-width EUC-KR: code(9) ISIN(12) name(40), then a fixed tail: group(2), size(1), index sector large/mid/small (4 each), ...,
// ending with base month(8), market cap in 100 million KRW(9), group-company code(3) and three flags.
function parseDomestic(buffer,market,tail){
  const decoder=new TextDecoder('euc-kr'),rows=[];
  for(const row of lines(buffer)){
    if(row.length<=tail+21)continue;const head=row.subarray(0,row.length-tail),rest=row.subarray(row.length-tail);
    const symbol=head.toString('latin1',0,9).trim();if(!/^\d{6}$/.test(symbol))continue;
    const group=rest.toString('latin1',0,2).trim();
    const large=rest.toString('latin1',3,7).trim(),mid=rest.toString('latin1',7,11).trim();const cap=Number(rest.toString('latin1',tail-15,tail-6));
    rows.push({symbol,name:decoder.decode(head.subarray(21)).trim(),englishName:'',market,type:KR_TYPES[group]??'other',isin:head.toString('latin1',9,21).trim(),industry:large||null,sector:/^\d{4}$/.test(mid)&&mid!=='0000'?mid:/^\d{4}$/.test(large)&&large!=='0000'?large:null,marketCap:Number.isFinite(cap)&&cap>0?cap*1e8:null});
  }
  return rows;
}
// U.S. rows are tab-separated: ..., exchange code, exchange name, symbol, realtime symbol, Korean name, English name, security type, ...
function parseOverseas(buffer,market){
  const decoder=new TextDecoder('euc-kr'),rows=[];
  for(const line of decoder.decode(buffer).split(/\r?\n/)){
    const f=line.split('\t');if(f.length<9)continue;const ticker=f[4].trim();if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker))continue;
    const securityType=f[8].trim(),etp=(f[22]??'').trim();
    rows.push({symbol:market+':'+ticker,name:f[6].trim(),englishName:f[7].trim(),market,type:securityType==='2'?'stock':securityType==='3'?(etp==='002'?'etn':'etf'):securityType==='4'?'warrant':'other',isin:'',industry:(f[19]??'').trim()||null,sector:null,marketCap:null});
  }
  return rows;
}
class SecurityMaster {
  constructor(db,fetcher=globalThis.fetch,clock=Date.now){
    this.db=db;this.fetcher=fetcher;this.clock=clock;this.refreshing=null;this.error=null;
    db.exec('CREATE TABLE IF NOT EXISTS securities(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,englishName TEXT NOT NULL,market TEXT NOT NULL,type TEXT NOT NULL,isin TEXT NOT NULL,industry TEXT);CREATE INDEX IF NOT EXISTS securities_market ON securities(market);CREATE TABLE IF NOT EXISTS security_master_meta(market TEXT PRIMARY KEY,count INTEGER NOT NULL,updatedAt INTEGER NOT NULL)');
    // Sector and market cap arrived later; older lists are refreshed once to fill them.
    const columns=db.prepare('PRAGMA table_info(securities)').all().map(c=>c.name);if(!columns.includes('sector')){db.exec('ALTER TABLE securities ADD COLUMN sector TEXT;ALTER TABLE securities ADD COLUMN marketCap REAL;DELETE FROM security_master_meta');}
  }
  status(){const markets=this.db.prepare('SELECT market,count,updatedAt FROM security_master_meta ORDER BY market').all();return {markets,total:markets.reduce((sum,row)=>sum+row.count,0),updatedAt:markets.length?Math.min(...markets.map(row=>row.updatedAt)):null,refreshing:Boolean(this.refreshing),error:this.error};}
  stale(){const status=this.status();return status.markets.length<SOURCES.length||this.clock()-status.updatedAt>REFRESH_MS;}
  async download(source){
    const response=await this.fetcher(BASE+source.file,{redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error('MASTER_DOWNLOAD_FAILED');const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>MAX_ZIP)throw new Error('MASTER_FORMAT');
    const data=unzipSingle(buffer);return source.kind==='kr'?parseDomestic(data,source.market,source.tail):parseOverseas(data,source.market);
  }
  // Each market is replaced atomically; a failed market keeps its previous rows.
  refresh(force=false){
    if(this.refreshing)return this.refreshing;if(!force&&!this.stale())return Promise.resolve(this.status());
    this.refreshing=(async()=>{const failures=[];
      for(const source of SOURCES){try{const rows=await this.download(source);if(rows.length<10)throw new Error('MASTER_FORMAT');this.replace(source.market,rows);}catch(error){failures.push(source.market+': '+(error.message==='MASTER_FORMAT'?'unexpected file format':'download failed'));}}
      this.error=failures.length?failures.join('; '):null;return this.status();
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  replace(market,rows){
    const insert=this.db.prepare('INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,englishName=excluded.englishName,market=excluded.market,type=excluded.type,isin=excluded.isin,industry=excluded.industry,sector=excluded.sector,marketCap=excluded.marketCap');
    this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('DELETE FROM securities WHERE market=?').run(market);for(const r of rows)insert.run(r.symbol,r.name,r.englishName,r.market,r.type,r.isin,r.industry,r.sector??null,r.marketCap??null);this.db.prepare('INSERT INTO security_master_meta VALUES(?,?,?) ON CONFLICT(market) DO UPDATE SET count=excluded.count,updatedAt=excluded.updatedAt').run(market,rows.length,this.clock());this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  // Largest listed stocks in the same index sector, for peer comparison; the company's own preferred shares share its first five digits.
  peers(symbol,limit=5){const row=this.get(symbol);if(!row?.sector)return [];return this.db.prepare("SELECT symbol,name,marketCap FROM securities WHERE sector=? AND market=? AND type='stock' AND substr(symbol,1,5)<>? AND marketCap IS NOT NULL ORDER BY marketCap DESC LIMIT ?").all(row.sector,row.market,symbol.slice(0,5),limit).map(r=>({...r}));}
  get(symbol){const row=this.db.prepare('SELECT * FROM securities WHERE symbol=?').get(symbol);return row?{...row}:null;}
  // Exact code/ticker first, then name prefix, then name substring.
  search(query,{market=null,type=null,limit=20}={}){
    const text=typeof query==='string'?query.trim():'';if(!text||text.length>40)return [];
    const markets=market==='KR'?['KOSPI','KOSDAQ']:market==='US'?['NASD','NYSE','AMEX']:null;const like=text.replace(/[\\%_]/g,c=>'\\'+c);const upper=text.toUpperCase();
    const where=[`(symbol=? OR symbol LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR upper(englishName) LIKE ? ESCAPE '\\')`],params=[upper,'%:'+like.toUpperCase(),'%'+like+'%','%'+like.toUpperCase()+'%'];
    if(markets){where.push(`market IN (${markets.map(()=>'?').join(',')})`);params.push(...markets);}
    if(type){where.push('type=?');params.push(type);}
    const rows=this.db.prepare(`SELECT * FROM securities WHERE ${where.join(' AND ')} LIMIT 400`).all(...params);
    const rank=row=>row.symbol===upper||row.symbol.endsWith(':'+upper)?0:row.name.startsWith(text)||row.englishName.toUpperCase().startsWith(upper)?1:2;
    return rows.map(row=>({...row})).sort((a,b)=>rank(a)-rank(b)||(a.type==='stock'?0:1)-(b.type==='stock'?0:1)||a.name.length-b.name.length).slice(0,Math.min(50,Math.max(1,limit)));
  }
}
module.exports={SecurityMaster,parseDomestic,parseOverseas,unzipSingle,SOURCES};
