// News and disclosure events matched to portfolio-relevant symbols. Text is data for the agent, never instructions.
const RETAIN_MS=14*86400000,TRIGGER_WINDOW_MS=6*3600000;
// DART report types that usually move a stock: capital changes, earnings, large contracts, control changes, trading status, legal events.
const HIGH_IMPORTANCE=['주요사항보고서','유상증자','무상증자','감자','합병','분할','영업(잠정)실적','잠정실적','매출액또는손익구조','단일판매','공급계약','최대주주','거래정지','상장폐지','관리종목','횡령','배임','소송','자기주식','전환사채','신주인수권부사채','교환사채','회생','부도','투자판단','조회공시','불성실공시'];
const MODES=['off','disclosures','all'];
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const SUFFIX=/\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|PLC|HOLDINGS?|GROUP|SA|NV|AG|SE|ADR|ADS|SPON|SPONSORED|ORD|SHS|CL(ASS)?\s+[A-Z]|THE)\b/g;
function englishTerm(name){const cleaned=String(name??'').toUpperCase().replace(/-CL\s*[A-Z]\b/g,' ').replace(/[^A-Z0-9&.\- ]/g,' ').replace(SUFFIX,' ').replace(/\s+/g,' ').trim();return cleaned.length>=4?cleaned:'';}
function importance(item){return item.source==='DART'&&HIGH_IMPORTANCE.some(word=>item.title.includes(word))?'high':'normal';}
// securities: [{symbol,name,englishName}] for holdings, watchlist, allowlist and watched symbols.
function matcher(securities){
  const rules=securities.filter(s=>s?.symbol).map(s=>{
    const tests=[],name=String(s.name??'').trim(),hangul=/[가-힣]/.test(name);
    if(/^\d{6}$/.test(s.symbol))tests.push(text=>new RegExp('(^|\\D)'+s.symbol+'(\\D|$)').test(text));
    // Two-letter Korean names need a word boundary; longer names may be followed by particles (삼성전자가).
    if(hangul&&name.length>=3)tests.push(text=>text.includes(name));
    else if(hangul&&name.length===2)tests.push(text=>new RegExp('(^|[^가-힣])'+escape(name)+'([^가-힣]|$)').test(text));
    const ticker=s.symbol.includes(':')?s.symbol.split(':')[1]:null;
    if(ticker)tests.push((_text,upper)=>new RegExp('(\\$|\\(|(NASDAQ|NYSE|AMEX)\\s*:\\s*)'+escape(ticker)+'\\b').test(upper));
    const english=englishTerm(s.englishName||(hangul?'':name));
    if(english)tests.push((_text,upper)=>new RegExp('(^|[^A-Z0-9])'+escape(english)+'([^A-Z0-9]|$)').test(upper));
    return {symbol:s.symbol,tests};
  });
  const known=new Set(rules.map(rule=>rule.symbol));
  return item=>{
    if(item.source==='DART')return item.symbol&&known.has(item.symbol)?[item.symbol]:[];
    const text=String(item.title??''),upper=text.toUpperCase();const tagged=(item.symbols??[]).filter(s=>known.has(s));
    return [...new Set([...tagged,...rules.filter(rule=>rule.tests.some(test=>test(text,upper))).map(rule=>rule.symbol)])];
  };
}
const receiptOf=url=>/rcpNo=(\d{14})/.exec(url??'')?.[1]??null;
class NewsEvents {
  constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS news_events(id TEXT PRIMARY KEY,firstSeenAt INTEGER NOT NULL,payload TEXT NOT NULL)');}
  save(event){this.db.prepare('INSERT INTO news_events VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(event.id,event.firstSeenAt,JSON.stringify(event));}
  // Stores unseen items once; returns the newly stored events.
  ingest(items,securities,now=Date.now()){
    // The same story often appears in several feeds under different URLs; keep the first copy.
    const match=matcher(securities),created=[],titles=new Set(this.list(300).map(event=>event.title));
    for(const item of items){
      if(!item?.url||titles.has(item.title)||this.db.prepare('SELECT 1 FROM news_events WHERE id=?').get(item.url))continue;titles.add(item.title);
      const event={id:item.url,source:item.source,kind:item.source==='DART'?'disclosure':'headline',title:item.title,url:item.url,published:item.published,receipt:item.source==='DART'?receiptOf(item.url):null,symbols:match(item),importance:importance(item),firstSeenAt:now,triggeredAt:null};
      this.save(event);created.push(event);
    }
    this.db.prepare('DELETE FROM news_events WHERE firstSeenAt<?').run(now-RETAIN_MS);
    return created;
  }
  list(limit=100){return this.db.prepare('SELECT payload FROM news_events ORDER BY firstSeenAt DESC,rowid DESC LIMIT ?').all(limit).map(row=>JSON.parse(row.payload));}
  relevant(limit=8){return this.list(300).filter(event=>event.symbols.length).slice(0,limit);}
  // Today's stored DART receipts, so polling can stop at the first page it has already seen.
  receipts(limit=1000){return this.list(limit).map(event=>event.receipt).filter(Boolean);}
  // Recent relevant events that have not triggered a review. 'disclosures' only counts high-importance DART filings.
  pending(mode,now=Date.now()){
    if(mode==='off')return [];
    return this.list(300).filter(event=>!event.triggeredAt&&event.symbols.length&&now-event.firstSeenAt<=TRIGGER_WINDOW_MS&&(mode==='all'||event.kind==='disclosure'&&event.importance==='high'));
  }
  markTriggered(ids,now=Date.now()){for(const event of this.list(300).filter(row=>ids.includes(row.id)))this.save({...event,triggeredAt:now});}
}
module.exports={NewsEvents,matcher,importance,englishTerm,MODES};
