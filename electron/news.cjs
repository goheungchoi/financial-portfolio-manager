// Named and numeric character references are decoded after tags are removed; &amp; last so it cannot create new references.
const NAMED={lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',mdash:'—',ndash:'–',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',middot:'·'};
function decode(text){return text.replace(/&#x([0-9a-f]{1,6});/gi,(m,h)=>{const c=parseInt(h,16);return c>0&&c<0x110000?String.fromCodePoint(c):'';}).replace(/&#(\d{1,7});/g,(m,d)=>{const c=Number(d);return c>0&&c<0x110000?String.fromCodePoint(c):'';}).replace(/&([a-z]+);/gi,(m,n)=>NAMED[n.toLowerCase()]??m).replace(/&amp;/g,'&');}
function clean(text){return decode(String(text??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'')).replace(/\s+/g,' ').trim().slice(0,500);}
function parseFeed(xml,source) {
  if(typeof xml!=='string'||xml.length>500000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('INVALID_FEED');
  const items=[];const tag=(body,name)=>body.match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)</'+name+'>','i'))?.[1]??'';
  for(const match of xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    const body=match[1],title=clean(tag(body,'title'));const raw=clean(tag(body,'link'))||body.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    let url;try{url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password)continue;}catch{continue;}
    if(!title)continue;const published=clean(tag(body,'pubDate')||tag(body,'published')||tag(body,'updated'));
    items.push({title,url:url.href,published,source});if(items.length>=50)break;
  }
  return items;
}
async function fetchFeed(url) {
  const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(target.hostname))throw new Error('INVALID_FEED_URL');
  const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('FEED_FAILED');
  return parseFeed(await response.text(),target.hostname);
}
// KIS market news headlines (Korean outlets, including overseas market briefs). They carry stock codes but no link.
function kisNews(rows){
  return (Array.isArray(rows)?rows:[]).map(r=>{const d=String(r.data_dt??''),t=String(r.data_tm??'').padStart(6,'0');const title=clean(r.hts_pbnt_titl_cntt);const id=String(r.cntt_usiq_srno??'').replace(/[^0-9A-Za-z]/g,'');
    if(!title||!id||!/^\d{8}$/.test(d))return null;
    const symbols=Array.from({length:10},(_,i)=>String(r['iscd'+(i+1)]??'').trim()).filter(s=>/^\d{6}$/.test(s));
    return {title,url:'kis-news:'+id,published:`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}+09:00`,source:String(r.dorg??'').trim()||'KIS news',symbols};}).filter(Boolean).slice(0,60);
}
// Suggested public feeds for global markets, technology and Korean business news.
const SUGGESTED_FEEDS=[
  {label:'CNBC Markets',url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664'},
  {label:'CNBC Technology',url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910'},
  {label:'MarketWatch top stories',url:'https://feeds.content.dowjones.io/public/rss/mw_topstories'},
  {label:'Yonhap economy',url:'https://www.yna.co.kr/rss/economy.xml'},
  {label:'Hankyung finance',url:'https://www.hankyung.com/feed/finance'},
  {label:'Maeil Business stocks',url:'https://www.mk.co.kr/rss/50200011/'}];
// Per-ticker headlines for U.S. holdings and watchlist names.
const yahooFeed=symbol=>{const m=/^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.-]{0,14})$/.exec(symbol);return m?`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(m[2].replace('.','-'))}&region=US&lang=en-US`:null;};
module.exports={parseFeed,fetchFeed,kisNews,SUGGESTED_FEEDS,yahooFeed,decode};
