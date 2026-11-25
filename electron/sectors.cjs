// Sectors for holdings (1.5.76, stage S1; artifacts/reviews/2026-11-25-sectors). One common sector list for both markets,
// and one resolver every screen reads, in this order:
//   1. user: the label you typed (Holdings → Edit classification), any text;
//   2. kis:  KIS's own Korean category name mapped by the fixed table below, only where the mapping is unambiguous;
//   3. ai:   an assignment the app stored (stage S2);
//   4. none: Unclassified.
// An ETF, ETN or fund never takes its sector from KIS's category (that is a product type, not a sector).
const SECTORS=Object.freeze(['Information Technology','Communication Services','Consumer Discretionary','Consumer Staples','Health Care','Financials','Industrials','Materials','Energy','Utilities','Real Estate']);
const FUND_SECTORS=Object.freeze(['Broad index','Bonds','Commodities','Currency','Multi-asset']);
const ALL=Object.freeze([...SECTORS,...FUND_SECTORS]);const UNCLASSIFIED='Unclassified';
const FUND_TYPES=new Set(['etf','etn','fund']);
const marketOf=symbol=>String(symbol??'').includes(':')?'US':'KR';
// The fixed table: KIS's category name (as KIS returns it, trimmed) → sector and a short detail, per market. A name not
// here is unmapped (stage S2 assigns it), never guessed. A name spanning several sectors stays out on purpose; the
// reviewed list of what is in and out, with its sources, is in the S1 note.
const e=(sector,detail=null)=>Object.freeze({sector,detail});
const KIS_TABLE=Object.freeze({
  KR:Object.freeze({
    '음식료·담배':e('Consumer Staples','Food, beverages and tobacco'),
    '섬유·의류':e('Consumer Discretionary','Textiles and apparel'),
    '종이·목재':e('Materials','Paper and wood'),
    '제약':e('Health Care','Pharmaceuticals'),
    '비금속':e('Materials','Non-metallic minerals'),
    '금속':e('Materials','Metals'),
    '전기·가스':e('Utilities','Electricity and gas'),
    '건설':e('Industrials','Construction'),
    '운송·창고':e('Industrials','Transportation'),
    '통신':e('Communication Services','Telecommunications'),
    '증권':e('Financials','Securities'),
    '보험':e('Financials','Insurance'),
    '부동산':e('Real Estate'),
    '출판·매체복제':e('Communication Services','Publishing and media'),
  }),
  US:Object.freeze({
    '에너지 및 관련 서비스':e('Energy'),
    '화학':e('Materials','Chemicals'),
    '건축자재':e('Materials','Construction materials'),
    '금속&채광':e('Materials','Metals and mining'),
    '소재산업':e('Materials'),
    '우주항공 및 국방':e('Industrials','Aerospace and defense'),
    '건설 및 건축제품':e('Industrials','Construction and building products'),
    '기계 및 전기장비':e('Industrials','Machinery and electrical equipment'),
    '복합기업':e('Industrials','Conglomerates'),
    '무역회사':e('Industrials','Trading companies'),
    '상업 및 전문서비스':e('Industrials','Commercial and professional services'),
    '항공사 및 항공운송':e('Industrials','Airlines and air freight'),
    '해운':e('Industrials','Shipping'),
    '운송인프라':e('Industrials','Transportation infrastructure'),
    '자동차':e('Consumer Discretionary','Automobiles'),
    '자동차관련부품':e('Consumer Discretionary','Auto parts'),
    '섬유의복 및 호화제품':e('Consumer Discretionary','Textiles, apparel and luxury goods'),
    '가정용 내구재':e('Consumer Discretionary','Household durables'),
    '여행서비스 및 제품':e('Consumer Discretionary','Travel and leisure'),
    '소비자 서비스':e('Consumer Discretionary','Consumer services'),
    '미디어':e('Communication Services','Media'),
    '음식료 및 담배생산':e('Consumer Staples','Food, beverages and tobacco'),
    '가정 및 개인용품':e('Consumer Staples','Household and personal products'),
    '음식료 도매':e('Consumer Staples','Food distribution'),
    '건강관리장비 및 서비스':e('Health Care','Health care equipment and services'),
    '제약':e('Health Care','Pharmaceuticals'),
    '바이오':e('Health Care','Biotechnology'),
    '상업은행':e('Financials','Banks'),
    '보험':e('Financials','Insurance'),
    "REIT's 및 부동산관리개발":e('Real Estate'),
    '금융서비스':e('Financials','Financial services'),
    '반도체 및 반도체장비':e('Information Technology','Semiconductors'),
    '컴퓨터전자장비/기기':e('Information Technology','Technology hardware'),
    '통신장비':e('Information Technology','Communications equipment'),
    '유선 및 기타 통신':e('Communication Services','Telecommunications'),
    '무선통신':e('Communication Services','Wireless telecommunications'),
    '전기':e('Utilities','Electric utilities'),
    '가스':e('Utilities','Gas utilities'),
    '공익사업':e('Utilities'),
  }),
});
// Names seen and deliberately not mapped (they span sectors): stage S2 decides them per stock.
const UNMAPPED=Object.freeze({KR:Object.freeze(['금융','화학','기계·장비','전기·전자','의료·정밀기기','운송장비·부품','유통','일반서비스','제조','IT 서비스','오락·문화','기타제조']),US:Object.freeze(['도/소매','인터넷소프트웨어 및 IT서비스'])});
// KIS's U.S. industry codes (the master's 3-digit industry column) and their names, as KIS's industry-code query
// (HHDFS76370100) returned them on 2026-11-25, the same 42 for NASDAQ, NYSE and AMEX. 000 (전체, all) means no industry.
const US_INDUSTRY_NAMES=Object.freeze({'010':'에너지 및 관련 서비스','110':'화학','120':'건축자재','130':'금속&채광','140':'소재산업','210':'우주항공 및 국방','220':'건설 및 건축제품','230':'기계 및 전기장비','240':'복합기업','250':'무역회사','260':'상업 및 전문서비스','270':'항공사 및 항공운송','280':'해운','290':'운송인프라','310':'자동차','320':'자동차관련부품','330':'섬유의복 및 호화제품','340':'가정용 내구재','350':'여행서비스 및 제품','360':'소비자 서비스','370':'미디어','380':'도/소매','410':'음식료 및 담배생산','420':'가정 및 개인용품','430':'음식료 도매','510':'건강관리장비 및 서비스','520':'제약','530':'바이오','610':'상업은행','620':'보험','630':"REIT's 및 부동산관리개발",'640':'금융서비스','710':'반도체 및 반도체장비','720':'인터넷소프트웨어 및 IT서비스','730':'컴퓨터전자장비/기기','740':'통신장비','810':'유선 및 기타 통신','820':'무선통신','910':'전기','920':'가스','930':'공익사업'});
const usIndustryName=code=>US_INDUSTRY_NAMES[String(code??'').trim()]??null;
const clean=v=>typeof v==='string'?v.trim():'';
function kisSector(market,name){const t=KIS_TABLE[market]?.[clean(name)];return t?{sector:t.sector,detail:t.detail}:null;}
// symbol; user: the typed label; type: the master's instrument type; kisNames: KIS's category names for it, best first
// (the index-sector name from the master's code, then the research overview's name); stored: the app's stored
// assignment {sector, detail, model, at}.
function resolve({symbol,user=null,type=null,kisNames=[],stored=null}={}){
  const label=clean(user);if(label)return {sector:label,detail:null,source:'user'};
  const market=marketOf(symbol),fund=FUND_TYPES.has(type);const names=fund?[]:kisNames.map(clean).filter(Boolean);
  for(const name of names){const m=kisSector(market,name);if(m)return {...m,source:'kis',category:name};}
  // The AI could not tell (S2 review, change 2): stored like any answer, shown as Unclassified with where it came from.
  if(stored?.sector===UNCLASSIFIED)return {sector:UNCLASSIFIED,detail:null,source:'ai',untold:true,model:typeof stored.model==='string'?stored.model:null,at:Number.isFinite(stored.at)?stored.at:null};
  if(stored&&ALL.includes(stored.sector))return {sector:stored.sector,detail:clean(stored.detail).slice(0,40)||null,source:'ai',model:typeof stored.model==='string'?stored.model:null,at:Number.isFinite(stored.at)?stored.at:null};
  return {sector:UNCLASSIFIED,detail:null,source:'none',category:names[0]??null};
}
// The app's own assignments (stage S2 writes them); the user's labels stay in instrument_metadata, never written here.
// onWrite(symbol): called after every write or removal (main clears the resolver's cache for the symbol).
class SectorStore{
  constructor(db,{onWrite=null}={}){this.db=db;this.onWrite=onWrite;db.exec('CREATE TABLE IF NOT EXISTS sector_assignments(symbol TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS sector_runs(day TEXT PRIMARY KEY,payload TEXT NOT NULL)');}
  get(symbol){try{const row=this.db.prepare('SELECT payload FROM sector_assignments WHERE symbol=?').get(symbol);return row?JSON.parse(row.payload):null;}catch{return null;}}
  write(symbol,{sector,detail=null,model=null,at,category=null}){if(!ALL.includes(sector)&&sector!==UNCLASSIFIED)throw new Error('INVALID_SECTOR');
    this.db.prepare('INSERT INTO sector_assignments VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload').run(symbol,JSON.stringify({sector,detail:clean(detail).slice(0,40)||null,model,at,category:clean(category)||null}));try{this.onWrite?.(symbol);}catch{}}
  // "Assign again" in the editor: the stored assignment is removed, so the next run asks for it.
  forget(symbol){const n=this.db.prepare('DELETE FROM sector_assignments WHERE symbol=?').run(symbol).changes;try{this.onWrite?.(symbol);}catch{}return n>0;}
  // The day's count of instruments asked (the cap of 60) and whether a call failed today (tried again the next day).
  day(day){try{const row=this.db.prepare('SELECT payload FROM sector_runs WHERE day=?').get(day);return row?JSON.parse(row.payload):{asked:0,failedAt:null};}catch{return {asked:0,failedAt:null};}}
  noteDay(day,patch){const next={...this.day(day),...patch};this.db.prepare('INSERT INTO sector_runs VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').run(day,JSON.stringify(next));return next;}
}
// Stage S2, the AI assignment: one call for several instruments, on the helper model set for condensing. It is sent only
// what describes the instrument (no quantity, value, weight, cost, cash or anything else of the account), and answers one
// sector of the list per symbol (a strict enum) and an optional short detail. Classification only; nothing about trading.
const CLASSIFY_LIMIT=20,CLASSIFY_DAILY=60;
const CLASSIFY_INSTRUCTIONS=['Classify each listed instrument into one sector from the list, for grouping holdings by sector.',
  'Use what is given (the name, the English name, the listing, the instrument type, the exchange\'s own category and, for a fund, its index and its largest holdings) and what you reliably know about the instrument.',
  'A company: the sector of its main business. A fund: the sector most of its holdings are in; a broad equity index fund: Broad index; bonds: Bonds; commodities or precious metals: Commodities; currencies: Currency; several asset classes: Multi-asset.',
  'detail: a short label of at most 40 characters, such as "Semiconductors", "Gold" or "S&P 500"; an empty string when none fits.',
  'If neither tells you the sector, answer Unclassified; do not guess.',
  'Answer once for every symbol given, and for no other.'].join('\n');
const CLASSIFY_SCHEMA=Object.freeze({type:'object',properties:{items:{type:'array',items:{type:'object',properties:{symbol:{type:'string'},sector:{type:'string',enum:[...ALL,UNCLASSIFIED]},detail:{type:'string'}},required:['symbol','sector','detail'],additionalProperties:false}}},required:['items'],additionalProperties:false});
// One instrument as sent: only these fields, each checked here (a caller passing more sends nothing more).
const text=(v,n)=>{const t=clean(v);return t?t.slice(0,n):null;};
function classifyItem(i){const fund=i.fund&&typeof i.fund==='object'?{...(text(i.fund.index,80)?{index:text(i.fund.index,80)}:{}),...(text(i.fund.structure,60)?{structure:text(i.fund.structure,60)}:{}),
    ...(Array.isArray(i.fund.holdings)&&i.fund.holdings.length?{largestHoldings:i.fund.holdings.slice(0,10).map(h=>({name:text(h.name,60),weightPct:Number.isFinite(h.weightPct)?Math.round(h.weightPct*10)/10:null})).filter(h=>h.name)}:{})}:null;
  return {symbol:String(i.symbol),name:text(i.name,80),englishName:text(i.englishName,80),listing:text(i.listing,20),type:text(i.type,20),exchangeCategory:text(i.category,60),...(fund&&Object.keys(fund).length?{fund}:{})};}
// Whether an instrument needs an assignment, and the KIS category it would be made from: not when you labelled it, not
// when the table gives its sector, not when a stored assignment was made from the category KIS gives now (a fund has none).
function needsAssignment({symbol,label=null,type=null,kisNames=[],stored=null}){if(clean(label))return {need:false,why:'label'};
  const fund=FUND_TYPES.has(type);if(resolve({symbol,type,kisNames}).source==='kis')return {need:false,why:'table'};
  const category=fund?null:kisNames.map(clean).find(Boolean)??null;if(stored&&(ALL.includes(stored.sector)||stored.sector===UNCLASSIFIED)&&(stored.category??null)===category)return {need:false,why:'stored',category};
  return {need:true,category};}
function classifyPayload(items){return {sectors:[...ALL],instruments:items.slice(0,CLASSIFY_LIMIT).map(classifyItem)};}
// The answer: only symbols asked, a sector of the list, a detail of at most 40 characters; anything else is dropped.
function parseClassification(answer,asked){const want=new Set(asked),out=new Map();
  for(const r of Array.isArray(answer?.items)?answer.items:[]){const s=String(r?.symbol??'');if(!want.has(s)||out.has(s)||!(ALL.includes(r?.sector)||r?.sector===UNCLASSIFIED))continue;out.set(s,{sector:r.sector,detail:clean(r.detail).slice(0,40)||null});}
  return out;}
// The resolver as the screens use it (review of S1, change 2): one result per symbol kept in memory for a short time, so
// building the portfolio state (asked for often) does not read the database per holding each time. read(symbol) gives
// resolve()'s input without the label, label(symbol) the typed label. clear(symbol) after a label is saved or an assignment
// written; clear() at a master refresh.
class SectorResolver{
  constructor({read,label,clock=Date.now,ttlMs=30000}){this.read=read;this.label=label;this.clock=clock;this.ttlMs=ttlMs;this.cache=new Map();}
  of(symbol){const now=this.clock(),hit=this.cache.get(symbol);if(hit&&now-hit.at>=0&&now-hit.at<this.ttlMs)return hit.value;
    const input={symbol,...this.read(symbol)};const r=resolve({...input,user:this.label(symbol)});const value=r.source==='user'?{...r,app:resolve(input)}:r;
    this.cache.set(symbol,{at:now,value});return value;}
  clear(symbol){if(symbol==null)this.cache.clear();else this.cache.delete(symbol);}
}
module.exports={needsAssignment,CLASSIFY_LIMIT,CLASSIFY_DAILY,CLASSIFY_INSTRUCTIONS,CLASSIFY_SCHEMA,classifyPayload,parseClassification,SectorResolver,US_INDUSTRY_NAMES,usIndustryName,SECTORS,FUND_SECTORS,ALL,UNCLASSIFIED,KIS_TABLE,UNMAPPED,kisSector,resolve,SectorStore,marketOf};
