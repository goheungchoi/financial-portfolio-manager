function clean(text){return String(text??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim().slice(0,500);}
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
module.exports={parseFeed,fetchFeed};
